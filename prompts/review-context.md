# System context for reviewing TiDB Cloud control-plane PRs

This is review-oriented system knowledge, not an oncall playbook: it says where a diff sits in the
architecture, what it talks to, how it is deployed, and which failure modes the design invites. It is
distilled from the team's architecture documentation in `tidb-x-tools` (paths cited per section); go there
for detail. Claims the source material does not settle are marked `[unverified]`. Cite findings against
code; use this document only to judge whether code fits the system it lives in.

## 1. Tiers and where their control planes live

| Tier | Global service | Regional control plane | Operator | Infra provisioning | State |
|---|---|---|---|---|---|
| Starter / Essential (Serverless) | `serverless-global-service` | `serverless-regional-service` (same repo, `serverless/main` branch; workload `new-serverless-regional-service`) + `serverless-service` | `tidb-operator-cse` | Pulumi, pre-provisioned (`aws-shared-cd`) | DynamoDB `infra.Cluster` (regional) + MySQL (global) |
| Premium / NextGen / TiDB-X | `nextgen-global-service` | `cluster-service-ng` (`cluster-ng-server` + `executor`) + `dataplane-manager` | `tidb-operator` v2 (`core.pingcap.com`) | Crossplane, per-SharedPool | MySQL `cluster_ng` + etcd |
| Dedicated | `dedicated-global-service` | `infra-provider` (`cluster-controller`, `regional-server`, `clusterproxy`, …) | `tidb-operator` 1.x | one VPC per cluster (legacy) | MySQL |

- Premium == NextGen == TiDB-X. Tiers share Kong, account, billing, config-center, runbooks, app-delivery.
- Essential and Premium isolate tenants by **Keyspace** (TiKV key prefix) + **ResourceGroup** (RU quota);
  Essential activates a TiDB process from a warm shared pool, Premium runs its own `TiDBGroup` pods in a
  SharedPool that owns a VPC and a K8s cluster.
- Essential is not one code path: legacy Essential uses `serverless-service`, while Essential V2
  (`servicePlan=Essential_V2`) is created through the NextGen chain, so `dataflow-service-ng` and
  `cluster-service-ng` also serve Essential traffic. Never infer the tier from a repo name alone.
- `dataflow-service` is one GitHub repo holding three independent Go modules (root = Dedicated,
  `dataflow-service-ng` = Premium/Essential-V2, `dataflow-agent-ng` = per-pool dataplane agent) with no
  cross-imports; a change in one module cannot rely on another's internals.
- Sources: `AGENTS.md` §2–§4, `AGENTS.essential.md` §1–§3, `AGENTS.premium.md` §2, `AGENTS.dedicated.md` §2,
  `docs/premium_architecture/01_three_layer_architecture.md`.

## 2. The four repositories under review

### 2.1 `tidbcloud/dataflow-service`

- Root module (`github.com/tidbcloud/dataflow-service`) — Dedicated dataflow control plane:
  `app/{controllers,models,repo,workflow,worker}`, binaries `cmd/dataflow`, `cmd/agent`; owns Dedicated
  Backup/Restore, Import, DM and CDC records plus their fastflow DAGs and gocron workers. Console
  local-file import is retired and `import_into` was moved out of the root module.
- `dataflow-service-ng` — Premium/Essential-V2 dataflow control plane in Global namespace `{env}-ms`:
  `app/controllers/{console,import_into,premium_dm,inner,open,interceptor}`,
  `app/models/{import_into,ticdc,biz_changefeed,premium_dm,data_pipeline,sink_endpoint,…}`, `app/worker`,
  `app/workflow`, `app/metrics`, `app/repo/entity`. Owns MySQL `dataflow_ng` (`biz_changefeeds`,
  `premium_dm_*`, `import_into_tasks`, `data_pipelines`); does **not** own Premium Backup/Restore/Export.
- `dataflow-agent-ng` — one Deployment `dataflow-agent` in each SharedPool's `tidb-admin` namespace, the
  only component touching TiCDC/TiDB/TiKV/openapi and staging object storage. RPCs include
  `DMOpenAPIProxy`, `PrecheckDMJob`, `ExecSQLOnDMSource`, `GetImportFiles`. Its async task manager keeps
  work in memory keyed by deterministic task ids, so restarts lose in-flight tasks: new work there must
  be re-entrant. Control plane → agent is the real layer boundary; progress advances by polling, not
  callbacks.
- Sources: `AGENTS.md` §4, `AGENTS.premium.md` §2.3, `alert-agents/premium/{cdc,dm,data-pipeline}.md`.

### 2.2 `tidbcloud/serverless-service`

- Essential control plane in Global `{env}-ms`; one image with subcommands `grpc`, `http`, `worker`,
  `br-worker` (plus a workflow binary).
- Owns Import/Export/Branch custom resources (`cloud.pingcap.com` through the `infra-api` virtual K8s
  cluster), the Essential TiCDC resource (new-arch TiCDC via `internal/domain/service/cdc_newarch.go`), DM
  task records, Backup/Restore records, and TiDB pool scheduling policy.
- Where a diff usually lands: `SyncTidbPoolService` (~1s) computing the target pool and writing the
  `tidb-pool-selector` annotation onto `infra.Cluster` (DynamoDB → Kinesis → SQS → regional controller);
  `ExportReconciler`/`BranchReconciler` under leader election; Import as a polling syncer (no
  controller); fixed-interval workers in `internal/controller/global_workers.go` (restore and restore-sync
  ~10s, backup schedule check 2h, backup clean 12h, DM task 5s, DM precheck 10s, DM endpoint 5s, CDC
  creating 10s, CDC state 1m). DB writes are expected to be idempotent CAS updates ("update only where
  state=running"); cross-service state is pulled by the sync worker, not pushed from the dataplane.
- Essential BR does not use `infra-api` CRDs; the control plane reaches the dataplane over ClusterProxy,
  and push/pull are split (`restoreWorker` advances, `restoreSyncWorker` writes status back).
- Sources: `docs/essential_architecture/agent.md` §8–§10, `alert-agents/essential/{cdc,dm,backup-restore}.md`.

### 2.3 `tidbcloud/cluster-service-ng`

- Premium regional control plane: one repo, two binaries (`cluster-ng-server`, `executor`) in namespace
  `cluster-ng-service`, plus `dataplane-manager` (`dataplane-server` + `dataplane-controller`) in its own
  namespace and Crossplane in `crossplane-system`.
- Dual storage: MySQL `cluster_ng` (SharedPool, TiDBCluster, TiDBGroup, DMCluster, Restore, locks, RU
  config, `manual_backups`, `lightweight_restores`, `exports`) and etcd (component state and TOML, DAG run
  state, distributed locks).
- Owns 37 DAG plans / 117 actions under `domain/workflow/dag` + `domain/workflow/action`, including all
  Backup/Restore actions (`action/br/`), Keyspace/ResourceGroup setup, component-group apply, HPA, NLB and
  node-instance groups; `domain/server/` holds gRPC entry points and RU→spec calculation.
- Executor semantics matter for every new action: an ordinary error is re-queued **without backoff or a
  retry cap**, while `actions.TerminalError` self-aborts the DAG and skips remaining actions.
- `dataplane-manager` is an operator over infrastructure CRs (DataPlane/APPBox/VPC/Bucket/LoadBalancer/…)
  reconciled to Crossplane managed resources; deletes require the confirm-deletion annotation and
  deliberately do not cascade.
- Sources: `docs/premium_architecture/03_regional_layer.md`, `08_backup_restore.md` §7.5, `AGENTS.premium.md` §9–§11.

### 2.4 `tidbcloud/infra-provider`

- Multi-module Go monorepo (no root `go.mod`, `go.work`) hosting the **Dedicated regional control plane**
  and shared K8s controllers: `cluster-controller` (Cluster/Network/Provider/Backup/Restore/Import/DM/
  TiCDC/Dumpling/hibernation reconcilers), `regional-server` (gRPC/REST called by
  `dedicated-global-service`), `cluster-server`, `cluster-agent`, `clusterproxy`, `tcidm-service`,
  `ticdc-service` (TiCDC CR controller), `infra-api` (legacy Gardener-based provider, CRD group
  `cloud.pingcap.com`), `infra-webhook`, `network-policy-controller`, `config-manager`, `infra-exporter`.
- `clusterproxy` is used outside Dedicated too (e.g. Essential BR reaches the dataplane through it), so a
  proxy change has wider blast radius than the Dedicated tier.
- Cloud-resource relation: `cluster-controller` provisions Dedicated network/compute (VPC, EKS) through
  the infra CR API, and `infra-exporter` reads Crossplane provider-aws resources (e.g.
  `eks.aws.crossplane.io` kinds) to export infra metrics. Dynamic Crossplane provisioning for Premium
  SharedPools lives in `cluster-service-ng/internal/dataplane-manager`, **not** here — treat
  "infra-provider is the Crossplane provisioning repo" as `[unverified]`/wrong and check the module path
  before assuming which layer a change affects.
- Sources: `AGENTS.dedicated.md` §2.2, `docs/REPOS-MANIFEST.md` repo table, `infra-provider/AGENTS.md`.

## 3. End-to-end flows a diff must line up with

### 3.1 Cluster creation (Premium; also Essential V2)

1. Kong → `tidb-mgmt-portal` → `tidb-mgmt-service` (validate, ValidateOnly call, write CREATING, submit the
   wrapper DAG) → `nextgen-global-service`. Boundary: HTTP/JSON to gRPC.
2. `nextgen-global-service.Create()`: RCU quota and MinRcu math, region selection, billing check,
   `GetOrCreateDefaultResourcePool()` (strategy table → matching pool → create pool), 4 encrypted
   passwords (root/cloud_admin/platform_admin/maintenance_admin), CMEK handling, then one MySQL
   transaction writing cluster + default TiDBGroup and submitting `create_cluster` plus
   `create_private_link_service`.
3. Global `create_cluster` (9 steps): PollUntilEncryptionKeyActive → CreateTidbCluster → poll AVAILABLE →
   CreateTidbGroup → poll AVAILABLE → ExecExtraSetUpSql (4 passwords over ClusterProxy, then the encrypted
   root password is deleted from the global DB) → FullClusterInfo → CreateBackupSetting → AVAILABLE.
4. Regional `create-tidbcluster` (10 steps): precheck → meta to etcd → **SetKeySpace** (PD API through
   clustergateway: Keyspace + ResourceGroup, `realMaxRcu = ceil(maxRcu × burstyRatio)`) → keyspace IAM role
   → shared-component resize → TiProxyGroup → HPA → export config → cluster cert → metering.
5. Regional `create-tidbgroup` (10 steps): precheck → o11y agent → VolumeAttributesClass → config from
   ConfigCenter → **TiDBGroup CR** (`spec.template.spec.keyspace = clusterId`) → HPA → cert → JWKS secret
   → keyspace confirmation → NLB.
6. The first cluster in a region triggers the 30-node `create-sharedpool` DAG in four phases (infra:
   DataPlane CR → VPC/EKS via Crossplane → bucket → wait ready; K8s base resources; component groups;
   BR/GC/metering wiring), typically 20–40 minutes.
- Sources: `docs/premium_architecture/05_cluster_creation_flow.md`, `02_global_layer.md`, `06_core_concepts.md`.

### 3.2 Dataflow objects

- **Changefeed (Premium)**: `dataflow-service-ng` model + worker drive creating → running → stopped/failed
  → deleting against a new-arch TiCDC in the pool; sink endpoints are separate objects with phases
  CREATING/PENDING_ACCEPTANCE/REJECTED/FAILED/DELETING and tenant + shared-pool exclusivity enforced by a
  transactional row lock. The kernel refuses a new changefeed while the upstream runs IMPORT INTO or a
  restore (it checks the PD etcd import lease), so creation failures may be upstream state, not this diff.
- **DM (Premium)**: `CreatePremiumMigration` only validates, encrypts and persists; `PremiumDMTaskWorker`
  advances `sourceCreating → sourceBounding → taskCreating → running|stopped|failed → deleting → deleted`
  (sources `creating → bounding → bounded → deleting → deleted`). Precheck is its own chain; config edits
  are tracked in `premium_dm_modifications` with `configuration_recovery_required` /
  `configuration_pending_action`; worker groups resize to the active task count. Regional calls are
  `POST /api/premium/v1/sharedPools/{id}/dmClusters` and `:scale`, applied as operator-v2 `DMGroup` /
  `DMWorkerGroup` in `tidb{sharedPoolId}`.
- **Import Into (Premium/Essential V2)**: worker polls (~4–5s) through the regional proxy to the pool's
  dataflow-agent; Preparing → ScalingUp → Canceling/Completed, each decomposed into agent tasks (file
  discovery, schema creation, batch submit) and DXF jobs on the SYSTEM-keyspace worker. Known gaps worth
  checking whenever a diff touches this path: no overall Preparing timeout, cancellation can wait forever,
  agent-side state is in memory.
- **Backup/Restore (Premium)**: the kernel (TiBR CR `tibr-default`, port 19500) backs up the whole pool per
  minute; the control plane only syncs records (`sync_backups` with a 5-minute lag, `sync_missing`,
  `expire_backups`) and orchestrates. Global has four restore adapters (pitr/snapshot, manual backup,
  dedicated_snapshot, classic_snapshot); regional has same-pool (6 actions) and cross-pool (9 actions
  including bucket grant/revoke) DAGs; regional progress maps to global percentages (PROVISIONING→PENDING,
  DATA_RESTORING→≤90%, POST_RESTORE_ACTION→95%, regional SUCCEED→99%). Backup data is deleted by **S3
  lifecycle rules**, not object deletes; GC state machine is `sp_creating → sp_running → sp_deleting →
  sp_deleted → auto_backup_expired`; the newest auto backup is delete-protected.
- **Lake data pipeline (Premium)**: one `data_pipelines` row whose `children` holds `export_id` (snapshot =
  Dumpling to staging S3/OSS), `changefeed_id` (incremental = TiCDC Canal-JSON to staging) and
  `lake_data_source_id`/`lake_task_name` (Lake MERGE). Status `creating|running|pausing|paused|editing|
  resuming|deleting|failed|completed`, with the displayed phase derived from
  `observation.lake_full_sync_completed` (INITIAL_LOADING vs STREAMING). Cluster deletion does **not**
  cascade to pipelines.
- Sources: `alert-agents/premium/{cdc,dm,import,data-pipeline}.md`, `docs/premium_architecture/08_backup_restore.md`,
  `alert-agents/essential/backup-restore.md`, `docs/essential_architecture/agent.md` §9.5.

## 4. Deployment shape and blast radius

- Global (`{env}-base-us-west-2`: ns `tidb-management-service`, `{env}-ms`); Regional (Premium
  `{env}-seed-{region}-ng` with `cluster-ng-service`, `dataplane-manager`, `crossplane-system`; Essential
  the region's first cluster `{env}-{region}-f01` with `tidb-management-service`, `tidb-admin`,
  `tidb-serverless`, `tidb-pool*`, `keyspace-pool`); Dataplane (one K8s cluster per SharedPool: `tidb-admin`
  for control-plane addons, `tidb{sharedPoolId}` for TiDB, DM and TiBR/TiBRGC; Dedicated uses one namespace
  per cluster).
- ArgoCD ApplicationSets from `app-delivery` (`nextgen-global-service`, `dataflow-service-ng`,
  `serverless-svc`, `serverless-regional-service`, `nextgen-regional-control-plane` as App-of-Apps) deploy
  the control planes. Dataplane workloads are **not** ArgoCD-managed: `cluster-service-ng` applies CRs over
  the K8s API, and `dataplane-manager` installs addons and renders `k8s-dp-templates.yaml` (which pins the
  dataflow-agent image and replica count).
- So a change goes live on a different schedule than the PR suggests: global per environment, regional per
  seed cluster, dataplane templates per pool on the next reconcile, and the dataplane K8s client is built on
  demand (`BuildKubeconfig`), affecting the next client registration only.
- Sources: `docs/premium_architecture/07_deployment_ops.md`, `01_three_layer_architecture.md`,
  `AGENTS.essential.md` §2/§7, `docs/premium_architecture/04_dataplane_layer.md`.

## 5. Review checklist: signals in a diff that deserve scrutiny

**Cross-layer contracts**
- A request/response field, enum value or error code added on one side only (global vs regional vs agent);
  rollout is not atomic, so old peers must keep working with the new payload and vice versa.
- A field now required, or an enum treated as exhaustive in a switch, in an IDL shared across repos — check
  the consumer's default and unknown-value handling.
- A new CRD field or annotation read by regional code: existing pools may run an older operator/CRD; check
  the absent-field path.
- A change to a dataplane template, `BuildKubeconfig` or addon list: it silently applies to every existing
  pool on the next reconcile.

**State machines and orchestration**
- A new state no reader maps to a terminal state, no cancellation path reaches, or only one of several
  writers can produce; check pollers, expiry jobs and delete paths.
- A terminal state that can be overwritten (a "succeeded" writer not guarding against cancelled/failed) or
  reached without persisting an error message.
- An ordinary `error` where the failure is permanent: in `cluster-service-ng` that is an infinite re-queue
  without backoff; BR paths are supposed to return `actions.TerminalError`.
- A step whose `CheckFinish`/poll can never return terminal, or that assumes the previous step ran in this
  process (executor restarts; agent restarts with in-memory tasks).
- Retry of a step whose side effect is not idempotent (provisioning, bucket creation, password rotation,
  NLB creation).

**Idempotency, concurrency and consistency**
- Create-or-update paths treating "already exists" as an error; helpers named `…IgnoreExists` exist for a
  reason.
- A new mutation of pool/cluster state outside the existing lock (etcd distributed lock, MySQL lock repo),
  or a read-modify-write without CAS.
- Dual storage (MySQL + etcd for Premium, DynamoDB + MySQL for Essential): which store is the source of
  truth, and whether the change keeps both in step or leans on a reconcile loop to converge.
- Leader-election assumptions: workers can run on several replicas (Premium global workers gate on pod-0);
  a new background task without a gate can double-write.
- Annotation/CR-driven loops: a write that does not change the observed spec hot-loops; one that does must
  converge, not oscillate.

**Compatibility, schema and rollback**
- GORM entity/migration changes: additive only for a rolling deploy, no destructive rename, backfill as a
  separate job; JSON columns (`children`, `observation`, `effective_config`, `sub_task_status`) are de-facto
  schemas and old rows lack new keys.
- A service writing tables it does not own (`dataflow_ng` vs `cluster_ng` vs global DBs) is a cross-service
  contract, not a local refactor.
- Older regional/global versions and older operator CRDs must still work; the diff should state what happens
  to objects created before it.

**Timeouts, retries, budgets**
- Polling without an overall deadline (import Preparing and cancellation are known offenders) or retries
  without backoff; per-request timeouts that do not bound the job.
- `context.WithoutCancel`/detached contexts, and 60s-class client read timeouts where the statement keeps
  running after the client gives up.
- Timing assumptions baked into code: 5-minute backup sync lag, 10-minute PiTR RPO, 10s/1m worker intervals,
  4-hour idle pool TTL.

**Errors, observability, operability**
- A failure path returning without setting state, `err_msg`, a metric or a log line (`premium_dm_tasks.err_msg`,
  `observation.*`, DAG step status) — silent failure is the common outcome.
- Metrics: label cardinality (per-cluster/per-pipeline labels), collectors reading the DB on every scrape and
  still emitting for deleted clusters.
- Alerts live in `runbooks` keyed by component/labels: renaming a metric, job or component unhooks alerting
  unless the matching rule ships in the same delivery.
- Log hygiene: no credentials, connection strings, tokens or PEM material; describe the location instead.

**Cloud resources and cost**
- Every created resource (VPC, EKS, nodegroup, LB, bucket, IAM role, KMS key, lifecycle rule, S3 prefix)
  needs a delete path in the same DAG family and a cleanup job; a failed create that leaves resources behind
  is a leak. Deletes are guarded by the confirm-deletion annotation and are deliberately non-cascading.
- Symmetry of grant/revoke (cross-pool restore bucket access), pack/copy cleanup, and manual-backup lifecycle
  rules that a cron must later recycle.
- RU→spec math, HPA thresholds and shared-component counts are pool-wide: a change there resizes running
  pools for every tenant in them.

**Secrets and identity**
- Password handling: envelope encryption, encrypted root password removed from the DB after setup, no
  plaintext in CRs, logs, events or error strings.
- Cloud identity: IRSA/ServiceAccount on operator CRs (a missing `serviceAccount` silently falls back to the
  node role and yields misleading access-denied errors), cross-account trust, kubeconfigs built on demand
  rather than persisted.
- Tenant scoping on shared objects: sink endpoints, PrivateLink usages and keyspace names must be checked
  against tenant and shared pool, and a delete in progress must reject new associations.

## 6. Sources

- Tier overview and repo map: `AGENTS.md`; per tier `AGENTS.essential.md`, `AGENTS.premium.md`,
  `AGENTS.dedicated.md`.
- Premium layering, flows, BR: `docs/premium_architecture/{00_index,01,02,03,04,05,06,07,08}.md`.
- Essential services, pools, workers: `docs/essential_architecture/agent.md`.
- Per-domain detail: `alert-agents/premium/{cdc,dm,import,export,data-pipeline,backup-restore}.md` and
  `alert-agents/essential/{cdc,dm,import,export,backup-restore}.md`.
- Repo and tooling inventory: `docs/REPOS-MANIFEST.md`, `docs/TIER-TOOL-REPO-GUIDE.md`.
- `[unverified]`: infra-provider's exact ownership of Crossplane-based provisioning (provisioning code is in
  `cluster-service-ng/internal/dataplane-manager`; infra-provider only depends on Crossplane provider types
  in `infra-exporter`); the Dedicated create-cluster DAG step list; whether backup-record generation for a
  cluster deleted near the hour boundary is intentional.
