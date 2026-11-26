# System context for reviewing TiDB Cloud control-plane PRs

This is review-oriented system knowledge, not an oncall playbook: it says where a diff sits in the
architecture, what it talks to, how it is deployed, and which failure modes the design invites. It is
distilled from the team's architecture documentation under `tidb-x-tools` (source paths in §6); go there
for detail. Anything the source material does not settle is marked `[unverified]`. Cite findings against
code, and use this document only to judge whether code fits the system it lives in.

## 1. Tiers and where their control planes live

| Tier | Global service | Regional control plane | Operator | Infra provisioning | State |
|---|---|---|---|---|---|
| Starter / Essential (Serverless) | `serverless-global-service` | `serverless-regional-service` (same repo, `serverless/main` branch; workload `new-serverless-regional-service`) + `serverless-service` | `tidb-operator-cse` | Pulumi, pre-provisioned (`aws-shared-cd`) | DynamoDB `infra.Cluster` (regional) + MySQL (global) |
| Premium / NextGen / TiDB-X | `nextgen-global-service` | `cluster-service-ng` (`cluster-ng-server` + `executor`) + `dataplane-manager` | `tidb-operator` v2 (`core.pingcap.com`) | Crossplane, per-SharedPool | MySQL `cluster_ng` + etcd |
| Dedicated | `dedicated-global-service` | `infra-provider` (`cluster-controller`, `regional-server`, `clusterproxy`, …) | `tidb-operator` 1.x | one VPC per cluster (legacy) | MySQL |

- Premium == NextGen == TiDB-X. Tiers share Kong, account, billing, config-center, runbooks, app-delivery.
- Essential and Premium isolate tenants by **Keyspace** (TiKV key prefix) + **ResourceGroup** (RU quota):
  Essential activates a TiDB process from a warm shared pool, Premium runs its own `TiDBGroup` pods inside a
  SharedPool that owns a VPC and a K8s cluster.
- Names mislead: Essential is not one code path (legacy Essential uses `serverless-service`, while Essential V2,
  `servicePlan=Essential_V2`, is created through the NextGen chain, so `dataflow-service-ng` and
  `cluster-service-ng` also serve Essential traffic), and `dataflow-service` is one GitHub repo holding three
  independent Go modules with no cross-imports (root = Dedicated, `dataflow-service-ng` = Premium/Essential-V2,
  `dataflow-agent-ng` = per-pool dataplane agent), so a change in one module cannot rely on another's internals.

## 2. The four repositories under review

### 2.1 `tidbcloud/dataflow-service`

- Root module (`github.com/tidbcloud/dataflow-service`) is the Dedicated dataflow control plane:
  `app/{controllers,models,repo,workflow,worker}`, binaries `cmd/dataflow`/`cmd/agent`; owns Dedicated
  Backup/Restore, Import, DM and CDC records with their fastflow DAGs and gocron workers (console local-file
  import retired, `import_into` moved out of the root module).
- `dataflow-service-ng` is the Premium/Essential-V2 dataflow control plane in Global `{env}-ms`:
  `app/controllers/{console,import_into,premium_dm,inner,open}`,
  `app/models/{import_into,ticdc,biz_changefeed,premium_dm,data_pipeline,sink_endpoint}`, `app/worker`,
  `app/workflow`, `app/metrics`; it owns MySQL `dataflow_ng` (`biz_changefeeds`, `premium_dm_*`,
  `import_into_tasks`, `data_pipelines`) and does **not** own Premium Backup/Restore/Export.
- `dataflow-agent-ng` is one `dataflow-agent` Deployment per SharedPool `tidb-admin` namespace, the only
  component touching TiCDC/TiDB/TiKV/openapi and staging storage (`DMOpenAPIProxy`, `PrecheckDMJob`,
  `GetImportFiles`). Control plane → agent is the real layer boundary and progress advances by polling, not
  callbacks; its in-memory task manager loses in-flight work on restart, so new work there must be re-entrant.

### 2.2 `tidbcloud/serverless-service`

- Essential control plane in Global `{env}-ms`; one image, subcommands `grpc`/`http`/`worker`/`br-worker`. It
  owns Import/Export/Branch CRs (`cloud.pingcap.com`, via the `infra-api` virtual K8s cluster), the Essential
  TiCDC CR (new-arch TiCDC via `internal/domain/service/cdc_newarch.go`), DM task records, Backup/Restore
  records and TiDB pool scheduling policy; diffs usually land in `SyncTidbPoolService` (~1s) writing the
  `tidb-pool-selector` annotation onto `infra.Cluster` (DynamoDB → Kinesis → SQS → regional controller), the
  leader-elected `ExportReconciler`/`BranchReconciler`, the polling Import syncer (no controller), or the
  fixed-interval workers in `internal/controller/global_workers.go` (restore/restore-sync ~10s, backup schedule
  check 2h, backup clean 12h, DM task 5s, precheck 10s, endpoint 5s, CDC 10s/1m). DB writes are expected to be
  idempotent CAS updates ("update only where state=running") and cross-service state is pulled by a sync
  worker, not pushed. Essential BR skips `infra-api` CRDs, reaching the dataplane over ClusterProxy with push
  (`restoreWorker`) and pull (`restoreSyncWorker`) split.

### 2.3 `tidbcloud/cluster-service-ng`

- Premium regional control plane: one repo, two binaries (`cluster-ng-server`, `executor`) in namespace
  `cluster-ng-service`, plus `dataplane-manager` (`dataplane-server`/`dataplane-controller`) and Crossplane in
  `crossplane-system`. Dual storage: MySQL `cluster_ng` (SharedPool, TiDBCluster, TiDBGroup, DMCluster, Restore,
  locks, RU config, `manual_backups`, `lightweight_restores`, `exports`) and etcd (component state/TOML, DAG
  runs, distributed locks).
- Owns 37 DAG plans / 117 actions (`domain/workflow/dag`, `domain/workflow/action`) including all
  `action/br/`, Keyspace/ResourceGroup setup, component-group apply, HPA, NLB and node-instance groups;
  `domain/server/` holds the gRPC entry points and RU→spec calculation.
- Executor semantics bind every new action: an ordinary error re-queues **without backoff or retry cap**, while
  `actions.TerminalError` self-aborts the DAG and skips the rest. `dataplane-manager` reconciles infra CRs
  (DataPlane/APPBox/VPC/Bucket/LoadBalancer) to Crossplane managed resources; deletes require the
  confirm-deletion annotation and deliberately do not cascade.

### 2.4 `tidbcloud/infra-provider`

- Multi-module Go monorepo (no root `go.mod`, `go.work`) holding the **Dedicated regional control plane** and
  shared K8s controllers: `cluster-controller` (Cluster/Network/Provider/Backup/Restore/Import/DM/TiCDC/
  Dumpling/hibernation reconcilers), `regional-server` (called by `dedicated-global-service`), `cluster-server`,
  `cluster-agent`, `clusterproxy`, `tcidm-service`, `ticdc-service`, `infra-api` (legacy Gardener-based, CRD
  group `cloud.pingcap.com`), `infra-webhook`, `network-policy-controller`, `config-manager`, `infra-exporter`.
- `clusterproxy` also serves other tiers (Essential BR reaches the dataplane through it), so a proxy change
  outruns the Dedicated tier; `cluster-controller` provisions Dedicated VPC/EKS through the infra CR API, while
  `infra-exporter` only reads Crossplane provider-aws resources (e.g. `eks.aws.crossplane.io`) for metrics.
- Dynamic Crossplane provisioning for Premium SharedPools lives in `cluster-service-ng/internal/dataplane-manager`,
  **not** here: treat "infra-provider is the Crossplane provisioning repo" as `[unverified]` and check the
  module path before assuming which layer a change affects.

## 3. End-to-end flows a diff must line up with

### 3.1 Cluster creation (Premium; also Essential V2)

1. Kong → `tidb-mgmt-portal` → `tidb-mgmt-service` (validate, ValidateOnly, write CREATING, submit the wrapper
   DAG) → `nextgen-global-service`; the boundary is HTTP/JSON to gRPC. `Create()` then does RCU/MinRcu math,
   region selection, billing check, `GetOrCreateDefaultResourcePool()` (strategy table → matching pool → create
   pool), 4 encrypted passwords (root/cloud_admin/platform_admin/maintenance_admin), CMEK handling, and one MySQL
   transaction writing cluster + default TiDBGroup while submitting `create_cluster` and
   `create_private_link_service`.
2. Global `create_cluster` (9 steps): PollUntilEncryptionKeyActive → CreateTidbCluster → poll AVAILABLE →
   CreateTidbGroup → poll AVAILABLE → ExecExtraSetUpSql (4 passwords over ClusterProxy, then the encrypted root
   password is deleted from the global DB) → FullClusterInfo → CreateBackupSetting → AVAILABLE.
3. Regional `create-tidbcluster` (10 steps): precheck → meta to etcd → **SetKeySpace** (PD API through
   clustergateway: Keyspace + ResourceGroup, `realMaxRcu = ceil(maxRcu × burstyRatio)`) → keyspace IAM role →
   shared-component resize → TiProxyGroup → HPA → export config → cluster cert → metering.
4. Regional `create-tidbgroup` (10 steps): precheck → o11y agent → VolumeAttributesClass → ConfigCenter config →
   **TiDBGroup CR** (`spec.template.spec.keyspace = clusterId`) → HPA → cert → JWKS secret → keyspace
   confirmation → NLB. The first cluster in a region also triggers the 30-node `create-sharedpool` DAG (infra:
   DataPlane CR → VPC/EKS via Crossplane → bucket → wait ready; K8s base resources; component groups;
   BR/GC/metering wiring), typically 20–40 minutes.

### 3.2 Dataflow objects

- **Changefeed (Premium)**: `dataflow-service-ng` model + worker drive creating → running → stopped/failed →
  deleting against a new-arch TiCDC in the pool; sink endpoints are separate objects with phases
  CREATING/PENDING_ACCEPTANCE/REJECTED/FAILED/DELETING and tenant + shared-pool exclusivity enforced by a
  transactional row lock. The kernel refuses a new changefeed while the upstream runs IMPORT INTO or a restore
  (it checks the PD etcd import lease), so creation failures may be upstream state, not this diff.
- **DM (Premium)**: `CreatePremiumMigration` only validates, encrypts and persists; `PremiumDMTaskWorker`
  advances `sourceCreating → sourceBounding → taskCreating → running|stopped|failed → deleting → deleted`
  (sources `creating → bounding → bounded → deleting → deleted`). Precheck is its own chain; config edits are
  tracked in `premium_dm_modifications` (`configuration_recovery_required`,
  `configuration_pending_action`) and worker groups resize to the active task count. Regional calls are
  `POST /api/premium/v1/sharedPools/{id}/dmClusters` and `:scale`, applied as operator-v2 `DMGroup` /
  `DMWorkerGroup` in `tidb{sharedPoolId}`.
- **Import Into (Premium/Essential V2)**: worker polls (~4–5s) through the regional proxy to the pool's
  dataflow-agent; Preparing → ScalingUp → Canceling/Completed, decomposed into agent tasks (file discovery,
  schema creation, batch submit) and DXF jobs on the SYSTEM-keyspace worker. Gaps to check on any diff here: no
  overall Preparing timeout, cancellation can wait forever, agent state is in memory.
- **Backup/Restore (Premium)**: the kernel (TiBR CR `tibr-default`, port 19500) backs up the whole pool per
  minute; the control plane only syncs records (`sync_backups` with a 5-minute lag, `sync_missing`,
  `expire_backups`) and orchestrates. Global has four restore adapters (pitr/snapshot, manual, dedicated,
  classic); regional has same-pool (6 actions) and cross-pool (9 actions incl. bucket grant/revoke) DAGs, and
  maps regional progress to global percentages (PROVISIONING→PENDING, DATA_RESTORING→≤90%,
  POST_RESTORE_ACTION→95%, SUCCEED→99%). Backup data is deleted by **S3 lifecycle rules**, not object deletes;
  GC state is `sp_creating → sp_running → sp_deleting → sp_deleted → auto_backup_expired`; the newest auto
  backup is delete-protected.
- **Lake data pipeline (Premium)**: one `data_pipelines` row whose `children` holds `export_id` (snapshot =
  Dumpling to staging S3/OSS), `changefeed_id` (incremental = TiCDC Canal-JSON to staging) and
  `lake_data_source_id`/`lake_task_name` (Lake MERGE). Status `creating|running|pausing|paused|editing|
  resuming|deleting|failed|completed`, the displayed phase derived from `observation.lake_full_sync_completed`
  (INITIAL_LOADING vs STREAMING); cluster deletion does **not** cascade to pipelines.

## 4. Deployment shape and blast radius

- Global (`{env}-base-us-west-2`: ns `tidb-management-service`, `{env}-ms`); Regional (Premium
  `{env}-seed-{region}-ng` with `cluster-ng-service`, `dataplane-manager`, `crossplane-system`; Essential the
  region's first cluster `{env}-{region}-f01` with `tidb-management-service`, `tidb-admin`, `tidb-serverless`,
  `tidb-pool*`, `keyspace-pool`); Dataplane (one K8s cluster per SharedPool: `tidb-admin` for control-plane
  addons, `tidb{sharedPoolId}` for TiDB, DM and TiBR/TiBRGC; Dedicated uses one namespace per cluster). ArgoCD
  ApplicationSets from `app-delivery` (`nextgen-global-service`, `dataflow-service-ng`, `serverless-svc`,
  `serverless-regional-service`, `nextgen-regional-control-plane` as App-of-Apps) deploy control planes, while
  dataplane workloads are **not** ArgoCD-managed: `cluster-service-ng` applies CRs over the K8s API, and
  `dataplane-manager` installs addons and renders `k8s-dp-templates.yaml` (pinning the dataflow-agent image and
  replica count). A change therefore goes live on a different schedule than the PR suggests: global per
  environment, regional per seed cluster, dataplane templates per pool on the next reconcile, and the dataplane
  K8s client is built on demand (`BuildKubeconfig`), affecting only the next client registration.

## 5. Review checklist: signals in a diff that deserve scrutiny

**Cross-layer contracts**
- A request/response field, enum value or error code added on one side only (global vs regional vs agent); rollout is not atomic, so old peers must keep working with the new payload and vice versa.
- A field now required, or an enum treated as exhaustive in a switch, in an IDL shared across repos — check the consumer's default and unknown-value handling.
- A new CRD field or annotation read by regional code: existing pools may run an older operator/CRD; check the absent-field path.
- A change to a dataplane template, `BuildKubeconfig` or addon list: it silently applies to every existing pool on the next reconcile.

**State machines and orchestration**
- A new state that no reader maps to a terminal state, no cancellation path reaches, or only one of several writers can produce; check pollers, expiry jobs and delete paths.
- A terminal state that can be overwritten (a "succeeded" writer not guarding against cancelled/failed) or reached without persisting an error message.
- An ordinary `error` where the failure is permanent: in `cluster-service-ng` that is an infinite re-queue without backoff; BR paths are supposed to return `actions.TerminalError`.
- A step whose `CheckFinish`/poll can never return terminal, or that assumes the previous step ran in this process (executor restarts; agent restarts with in-memory tasks); retry of a step whose side effect is not idempotent (provisioning, bucket creation, password rotation, NLB creation).

**Idempotency, concurrency and consistency**
- Create-or-update paths treating "already exists" as an error (helpers named `…IgnoreExists` exist for a reason), and new mutations of pool/cluster state outside the existing lock (etcd, MySQL lock repo) or read-modify-writes without CAS.
- Dual storage (MySQL + etcd for Premium, DynamoDB + MySQL for Essential): which store is the source of truth, and whether the change keeps both in step or leans on a reconcile loop to converge.
- Leader-election assumptions: workers can run on several replicas (Premium global workers gate on pod-0), so a new background task without a gate can double-write.
- Annotation/CR-driven loops: a write that does not change the observed spec hot-loops; one that does must converge, not oscillate.

**Compatibility, schema and rollback**
- GORM entity/migration changes: additive only for a rolling deploy, no destructive rename, backfill as a separate job; JSON columns (`children`, `observation`, `effective_config`, `sub_task_status`) are de-facto schemas whose old rows lack new keys; a service writing tables it does not own (`dataflow_ng` vs `cluster_ng` vs global DBs) is a cross-service contract; older regional/global versions and operator CRDs must still work, so the diff should state what happens to objects created before it.

**Timeouts, retries, budgets**
- Polling without an overall deadline (import Preparing and cancellation are known offenders) or retries without backoff; per-request timeouts that do not bound the job; `context.WithoutCancel`/detached contexts; 60s-class client read timeouts where the statement keeps running after the client gives up; timing assumptions baked into code (5-minute backup sync lag, 10-minute PiTR RPO, 10s/1m worker intervals, 4-hour idle pool TTL).

**Errors, observability, operability**
- A failure path returning without setting state, `err_msg`, a metric or a log line (`premium_dm_tasks.err_msg`, `observation.*`, DAG step status) — silent failure is the common outcome.
- Metrics: label cardinality (per-cluster/per-pipeline labels), collectors reading the DB on every scrape and still emitting for deleted clusters; alerts live in `runbooks` keyed by component/labels, so renaming a metric, job or component unhooks alerting unless the matching rule ships in the same delivery; log hygiene means no credentials, connection strings, tokens or PEM material, describe the location instead.

**Cloud resources and cost**
- Every created resource (VPC, EKS, nodegroup, LB, bucket, IAM role, KMS key, lifecycle rule, S3 prefix) needs a delete path in the same DAG family and a cleanup job; a failed create that leaves resources behind is a leak (deletes are guarded by the confirm-deletion annotation and deliberately non-cascading), and grant/revoke, pack/copy cleanup and manual-backup lifecycle rules must be symmetric and recycled by cron.
- RU→spec math, HPA thresholds and shared-component counts are pool-wide, so a change there resizes running pools for every tenant in them.

**Secrets and identity**
- Password handling: envelope encryption, the encrypted root password removed from the DB after setup, no plaintext in CRs, logs, events or error strings. Cloud identity: IRSA/ServiceAccount on operator CRs (a missing `serviceAccount` silently falls back to the node role and yields misleading access-denied errors), cross-account trust, kubeconfigs built on demand rather than persisted.
- Tenant scoping on shared objects: sink endpoints, PrivateLink usages and keyspace names must be checked against tenant and shared pool, and a delete in progress must reject new associations.

## 6. Sources (paths relative to the `tidb-x-tools` documentation root)

- Tier overview, repo map, per-tier detail: `AGENTS.md`, `AGENTS.{essential,premium,dedicated}.md`; Premium layering, flows and BR: `docs/premium_architecture/{00_index,01,02,03,04,05,06,07,08}.md`; Essential services, pools and workers: `docs/essential_architecture/agent.md`.
- Per-domain detail: `alert-agents/premium/{cdc,dm,import,export,data-pipeline,backup-restore}.md` and `alert-agents/essential/{cdc,dm,import,export,backup-restore}.md`.
- Repo inventory: `docs/REPOS-MANIFEST.md`, `docs/TIER-TOOL-REPO-GUIDE.md`.
- `[unverified]`: infra-provider's exact ownership of Crossplane-based provisioning (the provisioning code is in `cluster-service-ng/internal/dataplane-manager`; infra-provider only depends on Crossplane provider types in `infra-exporter`); the Dedicated create-cluster DAG step list; whether backup-record generation for a cluster deleted near the hour boundary is intentional.
