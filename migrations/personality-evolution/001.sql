-- 仅设计稿。执行前必须满足正文前置条件；本轮未执行。
-- PRAGMA为将来新版连接的属性，不代表本轮改动生产连接。
PRAGMA foreign_keys = ON;
PRAGMA recursive_triggers = ON;
PRAGMA busy_timeout = 10;
-- WAL及synchronous=FULL由已批准的连接初始化流程校验/配置。

BEGIN IMMEDIATE;

CREATE TABLE pe_schema (
  version INTEGER NOT NULL PRIMARY KEY,
  migration_hash TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE pe_settings (
  id INTEGER NOT NULL PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision>0),
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  updated_at INTEGER NOT NULL,
  principal TEXT NOT NULL
);
CREATE TABLE pe_settings_history (
  id TEXT NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE CHECK(revision>0),
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  principal TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE pe_counters (
  key TEXT NOT NULL PRIMARY KEY,
  value INTEGER NOT NULL CHECK(value>=0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE pe_scopes (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('global','group','object')),
  scope_key TEXT NOT NULL,
  parent_id TEXT REFERENCES pe_scopes(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind,scope_key),
  CHECK((kind IN ('global','group') AND parent_id IS NULL)
     OR (kind='object' AND parent_id IS NOT NULL))
);
CREATE INDEX pe_scopes_parent ON pe_scopes(parent_id);

CREATE TABLE pe_observations (
  id TEXT NOT NULL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  legacy_row_id INTEGER,
  legacy_locator_hash TEXT UNIQUE,
  scope_id TEXT NOT NULL REFERENCES pe_scopes(id),
  subject_id TEXT REFERENCES pe_scopes(id),
  interaction_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  format TEXT NOT NULL CHECK(format IN
    ('legacy_features','features_only','redacted_text')),
  context_quality TEXT NOT NULL CHECK(context_quality IN
    ('missing','partial','linked')),
  features_json TEXT NOT NULL CHECK(json_valid(features_json)),
  attribution_json TEXT NOT NULL CHECK(json_valid(attribution_json)),
  injected_json TEXT NOT NULL CHECK(json_valid(injected_json)),
  version_id INTEGER REFERENCES personality_versions(id),
  consent_revision INTEGER NOT NULL,
  redaction_version TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pe_obs_scope_time ON pe_observations(scope_id,occurred_at,id);
CREATE INDEX pe_obs_subject_time ON pe_observations(subject_id,occurred_at,id);
CREATE INDEX pe_obs_interaction ON pe_observations(interaction_id);
CREATE INDEX pe_obs_version_time ON pe_observations(version_id,occurred_at);

CREATE TABLE pe_text_payloads (
  observation_id TEXT NOT NULL PRIMARY KEY REFERENCES pe_observations(id),
  ciphertext BLOB NOT NULL,
  key_id TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(expires_at>captured_at AND expires_at<=captured_at+1209600000)
);
CREATE INDEX pe_text_expiry ON pe_text_payloads(expires_at);

CREATE TABLE pe_feedback (
  id TEXT NOT NULL PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES pe_observations(id),
  principal TEXT NOT NULL,
  dimension TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score IN (-1,0,1)),
  note TEXT NOT NULL DEFAULT '',
  redaction_version TEXT NOT NULL,
  supersedes_id TEXT REFERENCES pe_feedback(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX pe_feedback_obs ON pe_feedback(observation_id,created_at);

CREATE TABLE pe_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN
    ('local','reflection','evaluation','trend')),
  scope_id TEXT NOT NULL REFERENCES pe_scopes(id),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  target_version INTEGER REFERENCES personality_versions(id),
  analyzer_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('queued','running','waiting_retry','succeeded','failed',
     'skipped','cancelled','unknown')),
  retry_of TEXT REFERENCES pe_jobs(id),
  lease_owner TEXT,
  lease_until INTEGER,
  next_run_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  error_code TEXT,
  error_summary TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK(window_end>window_start)
);
CREATE INDEX pe_jobs_ready ON pe_jobs(state,next_run_at);
CREATE INDEX pe_jobs_scope_time ON pe_jobs(scope_id,created_at);
CREATE INDEX pe_jobs_leases ON pe_jobs(lease_until) WHERE state='running';

CREATE TABLE pe_job_samples (
  job_id TEXT NOT NULL REFERENCES pe_jobs(id),
  observation_id TEXT NOT NULL REFERENCES pe_observations(id),
  role TEXT NOT NULL CHECK(role IN ('analysis','holdout','baseline')),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  feature_snapshot_json TEXT NOT NULL CHECK(json_valid(feature_snapshot_json)),
  content_fingerprint TEXT NOT NULL,
  PRIMARY KEY(job_id,observation_id,role),
  UNIQUE(job_id,role,ordinal)
);

CREATE TABLE pe_model_calls (
  id TEXT NOT NULL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pe_jobs(id),
  attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
  budget_day TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('prepared','dispatching','responded','succeeded','failed',
     'timed_out','cancelled','unknown')),
  outcome TEXT NOT NULL CHECK(outcome IN
    ('not_dispatched','response_received','uncertain')),
  provider_id TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  actual_model TEXT,
  config_fingerprint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reserved_input_tokens INTEGER NOT NULL CHECK(reserved_input_tokens>=0),
  reserved_output_tokens INTEGER NOT NULL CHECK(reserved_output_tokens>=0),
  reserved_cost_micros INTEGER CHECK(reserved_cost_micros>=0),
  input_tokens INTEGER CHECK(input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens>=0),
  cached_tokens INTEGER CHECK(cached_tokens>=0),
  cost_micros INTEGER CHECK(cost_micros>=0),
  currency TEXT,
  price_json TEXT CHECK(price_json IS NULL OR json_valid(price_json)),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  prepared_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  responded_at INTEGER,
  finished_at INTEGER,
  http_status INTEGER,
  provider_request_id TEXT,
  error_code TEXT,
  error_summary TEXT,
  UNIQUE(job_id,attempt_no)
);
CREATE INDEX pe_calls_budget ON pe_model_calls(budget_day,state);
CREATE INDEX pe_calls_dispatch ON pe_model_calls(dispatched_at);

CREATE TABLE pe_call_events (
  id TEXT NOT NULL PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES pe_model_calls(id),
  seq INTEGER NOT NULL CHECK(seq>=0),
  event TEXT NOT NULL CHECK(event IN
    ('prepared','dispatching','responded','usage','succeeded',
     'failed','timed_out','cancelled','unknown')),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  occurred_at INTEGER NOT NULL,
  UNIQUE(call_id,seq)
);
CREATE INDEX pe_call_events_time ON pe_call_events(occurred_at);

CREATE TABLE pe_reports (
  id TEXT NOT NULL PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES pe_jobs(id),
  schema_version INTEGER NOT NULL,
  redaction_version TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE personality_traits (
  id TEXT NOT NULL PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES pe_scopes(id),
  dimension TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(scope_id,dimension,semantic_key)
);
CREATE TABLE personality_trait_revisions (
  trait_id TEXT NOT NULL REFERENCES personality_traits(id),
  revision INTEGER NOT NULL CHECK(revision>0),
  conclusion TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  limitations_json TEXT NOT NULL CHECK(json_valid(limitations_json)),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  source_job_id TEXT REFERENCES pe_jobs(id),
  source_report_id TEXT REFERENCES pe_reports(id),
  supersedes_revision INTEGER,
  created_by TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(trait_id,revision),
  FOREIGN KEY(trait_id,supersedes_revision)
    REFERENCES personality_trait_revisions(trait_id,revision),
  CHECK(window_end>window_start)
);
CREATE INDEX pe_traits_time ON personality_trait_revisions(created_at);

CREATE TABLE pe_preferences (
  id TEXT NOT NULL PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES pe_scopes(id),
  semantic_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(scope_id,semantic_key)
);
CREATE TABLE pe_preference_revisions (
  preference_id TEXT NOT NULL REFERENCES pe_preferences(id),
  revision INTEGER NOT NULL CHECK(revision>0),
  name TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('preserve','improve','limit')),
  rule_text TEXT NOT NULL,
  rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),
  scenes_json TEXT NOT NULL CHECK(json_valid(scenes_json)),
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 100),
  risks_json TEXT NOT NULL CHECK(json_valid(risks_json)),
  evidence_summary_json TEXT NOT NULL CHECK(json_valid(evidence_summary_json)),
  first_seen_at INTEGER NOT NULL,
  source_job_id TEXT REFERENCES pe_jobs(id),
  source_report_id TEXT REFERENCES pe_reports(id),
  supersedes_revision INTEGER,
  created_by TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(preference_id,revision),
  FOREIGN KEY(preference_id,supersedes_revision)
    REFERENCES pe_preference_revisions(preference_id,revision)
);
CREATE INDEX pe_pref_revision_time ON pe_preference_revisions(created_at);

CREATE TABLE pe_preference_traits (
  preference_id TEXT NOT NULL,
  preference_revision INTEGER NOT NULL,
  trait_id TEXT NOT NULL,
  trait_revision INTEGER NOT NULL,
  PRIMARY KEY(preference_id,preference_revision,trait_id,trait_revision),
  FOREIGN KEY(preference_id,preference_revision)
    REFERENCES pe_preference_revisions(preference_id,revision),
  FOREIGN KEY(trait_id,trait_revision)
    REFERENCES personality_trait_revisions(trait_id,revision)
);

CREATE TABLE pe_evidence (
  id TEXT NOT NULL PRIMARY KEY,
  preference_id TEXT,
  preference_revision INTEGER,
  trait_id TEXT,
  trait_revision INTEGER,
  job_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  sample_role TEXT NOT NULL,
  segment TEXT NOT NULL CHECK(segment IN ('reply','context','silence','features')),
  polarity TEXT NOT NULL CHECK(polarity IN ('support','counter','neutral')),
  explanation TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  FOREIGN KEY(preference_id,preference_revision)
    REFERENCES pe_preference_revisions(preference_id,revision),
  FOREIGN KEY(trait_id,trait_revision)
    REFERENCES personality_trait_revisions(trait_id,revision),
  FOREIGN KEY(job_id,observation_id,sample_role)
    REFERENCES pe_job_samples(job_id,observation_id,role),
  CHECK(
    (preference_id IS NOT NULL AND preference_revision IS NOT NULL
     AND trait_id IS NULL AND trait_revision IS NULL)
    OR
    (preference_id IS NULL AND preference_revision IS NULL
     AND trait_id IS NOT NULL AND trait_revision IS NOT NULL)
  )
);
CREATE INDEX pe_evidence_pref ON pe_evidence(preference_id,preference_revision);
CREATE INDEX pe_evidence_trait ON pe_evidence(trait_id,trait_revision);
CREATE INDEX pe_evidence_obs ON pe_evidence(observation_id);

CREATE TABLE pe_review_history (
  id TEXT NOT NULL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  principal TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN
    ('publish','reject','edit','request_evidence')),
  operation TEXT CHECK(operation IN ('add','remove','replace','rollback')),
  base_version INTEGER REFERENCES personality_versions(id),
  result_version INTEGER UNIQUE REFERENCES personality_versions(id)
    DEFERRABLE INITIALLY DEFERRED,
  request_hash TEXT NOT NULL,
  final_snapshot_hash TEXT,
  reason TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  redaction_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK(
    (action='publish' AND operation IS NOT NULL AND base_version IS NOT NULL
      AND result_version IS NOT NULL AND final_snapshot_hash IS NOT NULL)
    OR
    (action<>'publish' AND operation IS NULL AND result_version IS NULL
      AND final_snapshot_hash IS NULL)
  )
);
CREATE INDEX pe_reviews_time ON pe_review_history(created_at);

CREATE TABLE pe_review_targets (
  id TEXT NOT NULL PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES pe_review_history(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('preference','trait')),
  preference_id TEXT,
  preference_revision INTEGER,
  trait_id TEXT,
  trait_revision INTEGER,
  disposition TEXT NOT NULL CHECK(disposition IN
    ('add','retain','remove','edit','reject','request_evidence')),
  content_hash TEXT NOT NULL,
  FOREIGN KEY(preference_id,preference_revision)
    REFERENCES pe_preference_revisions(preference_id,revision),
  FOREIGN KEY(trait_id,trait_revision)
    REFERENCES personality_trait_revisions(trait_id,revision),
  CHECK(
    (target_kind='preference' AND preference_id IS NOT NULL
      AND preference_revision IS NOT NULL AND trait_id IS NULL
      AND trait_revision IS NULL)
    OR
    (target_kind='trait' AND preference_id IS NULL
      AND preference_revision IS NULL AND trait_id IS NOT NULL
      AND trait_revision IS NOT NULL)
  )
);
CREATE UNIQUE INDEX pe_review_pref_target
  ON pe_review_targets(review_id,preference_id,preference_revision)
  WHERE target_kind='preference';
CREATE UNIQUE INDEX pe_review_trait_target
  ON pe_review_targets(review_id,trait_id,trait_revision)
  WHERE target_kind='trait';

CREATE TABLE pe_publications (
  version_id INTEGER NOT NULL PRIMARY KEY
    REFERENCES personality_versions(id) DEFERRABLE INITIALLY DEFERRED,
  review_id TEXT NOT NULL UNIQUE REFERENCES pe_review_history(id),
  format_version INTEGER NOT NULL CHECK(format_version=2),
  previous_version INTEGER NOT NULL REFERENCES personality_versions(id),
  rollback_target INTEGER REFERENCES personality_versions(id),
  snapshot_hash TEXT NOT NULL,
  core_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK(version_id>0 AND version_id>previous_version)
);

CREATE TABLE pe_evaluations (
  id TEXT NOT NULL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pe_jobs(id),
  preference_id TEXT,
  preference_revision INTEGER,
  baseline_version INTEGER REFERENCES personality_versions(id),
  target_version INTEGER REFERENCES personality_versions(id),
  result TEXT NOT NULL CHECK(result IN
    ('insufficient_data','inconclusive','retain','revise','withdraw','conflict')),
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
  limitations_json TEXT NOT NULL CHECK(json_valid(limitations_json)),
  redaction_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(preference_id,preference_revision)
    REFERENCES pe_preference_revisions(preference_id,revision),
  CHECK((preference_id IS NULL AND preference_revision IS NULL)
     OR (preference_id IS NOT NULL AND preference_revision IS NOT NULL))
);
CREATE INDEX pe_eval_time ON pe_evaluations(created_at);

CREATE TABLE pe_daily_metrics (
  scope_id TEXT NOT NULL REFERENCES pe_scopes(id),
  day TEXT NOT NULL,
  scene TEXT NOT NULL,
  metric_version TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,day,scene,metric_version)
);

-- 约束scope层级；范围身份不可变，后面的不可变触发器禁止UPDATE。
CREATE TRIGGER pe_scope_parent_guard BEFORE INSERT ON pe_scopes
WHEN NEW.kind='object'
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM pe_scopes p WHERE p.id=NEW.parent_id AND p.kind='group'
  ) THEN RAISE(ABORT,'object requires group parent') END;
END;

CREATE TRIGGER pe_observation_scope_guard BEFORE INSERT ON pe_observations
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM pe_scopes g WHERE g.id=NEW.scope_id AND g.kind='group'
  ) THEN RAISE(ABORT,'observation requires group scope') END;
  SELECT CASE WHEN NEW.subject_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM pe_scopes s
    WHERE s.id=NEW.subject_id AND s.kind='object' AND s.parent_id=NEW.scope_id
  ) THEN RAISE(ABORT,'subject scope mismatch') END;
END;

-- 不允许延长材料期限；到期只DELETE对应短期材料，不动观察和证据。
CREATE TRIGGER pe_text_no_update BEFORE UPDATE ON pe_text_payloads
BEGIN SELECT RAISE(ABORT,'text payload immutable'); END;
CREATE TRIGGER pe_text_no_replace BEFORE INSERT ON pe_text_payloads
WHEN EXISTS(SELECT 1 FROM pe_text_payloads WHERE observation_id=NEW.observation_id)
BEGIN SELECT RAISE(ABORT,'text payload already exists'); END;

-- 材料时间绑定原观察，禁止删除后重插延长期限或为旧特征伪造原文。
CREATE TRIGGER pe_text_capture_guard BEFORE INSERT ON pe_text_payloads
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM pe_observations o WHERE o.id=NEW.observation_id
      AND o.format='redacted_text' AND NEW.captured_at=o.created_at
      AND NEW.expires_at<=o.created_at+1209600000
  ) THEN RAISE(ABORT,'text must match original capture window') END;
  SELECT CASE WHEN NEW.expires_at<=CAST(strftime('%s','now') AS INTEGER)*1000
    THEN RAISE(ABORT,'expired text cannot be reinserted') END;
END;

-- 管理员审核能力：只在经认证、摘要绑定、精确操作清单的事务内为真。
-- pe_guard由专用Writer连接注册；缺失函数或默认返回0均失败关闭。
CREATE TRIGGER pe_review_insert_guard BEFORE INSERT ON pe_review_history
BEGIN
  SELECT CASE WHEN pe_guard('review.insert',NEW.id,json_object(
    'idempotency_key',NEW.idempotency_key,'principal',NEW.principal,
    'action',NEW.action,'operation',NEW.operation,'base_version',NEW.base_version,
    'result_version',NEW.result_version,'request_hash',NEW.request_hash,
    'final_snapshot_hash',NEW.final_snapshot_hash,'reason',NEW.reason,
    'detail_json',NEW.detail_json,'redaction_version',NEW.redaction_version,
    'created_at',NEW.created_at
  )) IS NOT 1 THEN RAISE(ABORT,'administrator review required') END;
END;

CREATE TRIGGER pe_review_target_insert_guard BEFORE INSERT ON pe_review_targets
BEGIN
  SELECT CASE WHEN pe_guard('review.target.insert',NEW.id,json_object(
    'review_id',NEW.review_id,'target_kind',NEW.target_kind,
    'preference_id',NEW.preference_id,'preference_revision',NEW.preference_revision,
    'trait_id',NEW.trait_id,'trait_revision',NEW.trait_revision,
    'disposition',NEW.disposition,'content_hash',NEW.content_hash
  )) IS NOT 1 THEN RAISE(ABORT,'exact review target required') END;
END;

CREATE TRIGGER pe_publication_insert_guard BEFORE INSERT ON pe_publications
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM pe_review_history r WHERE r.id=NEW.review_id
      AND r.action='publish' AND r.result_version=NEW.version_id
      AND r.base_version=NEW.previous_version
      AND r.final_snapshot_hash=NEW.snapshot_hash
  ) THEN RAISE(ABORT,'publication requires matching publish review') END;
  SELECT CASE WHEN pe_guard('publication.insert',CAST(NEW.version_id AS TEXT),
    json_object('review_id',NEW.review_id,'format_version',NEW.format_version,
      'previous_version',NEW.previous_version,'rollback_target',NEW.rollback_target,
      'snapshot_hash',NEW.snapshot_hash,'core_fingerprint',NEW.core_fingerprint,
      'created_at',NEW.created_at)
  ) IS NOT 1 THEN RAISE(ABORT,'publication capability required') END;
END;

CREATE TRIGGER pe_version_insert_guard BEFORE INSERT ON personality_versions
BEGIN
  SELECT CASE WHEN NEW.id<=0 OR EXISTS(
    SELECT 1 FROM personality_versions WHERE id=NEW.id
  ) THEN RAISE(ABORT,'version insert or replacement forbidden') END;
  SELECT CASE WHEN NEW.id<>(
    SELECT COALESCE(MAX(id),0)+1 FROM personality_versions
  ) THEN RAISE(ABORT,'version must advance monotonically') END;
  SELECT CASE WHEN NOT json_valid(NEW.content)
    THEN RAISE(ABORT,'invalid snapshot json') END;
  SELECT CASE WHEN json_type(NEW.content)<>'array'
    THEN RAISE(ABORT,'snapshot must be array') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM pe_publications p
    JOIN pe_review_history r ON r.id=p.review_id
    JOIN personality_state s ON s.key='version'
    WHERE p.version_id=NEW.id AND r.action='publish'
      AND r.result_version=NEW.id AND r.principal=NEW.created_by
      AND p.previous_version=NEW.previous_version
      AND CAST(s.value AS INTEGER)=NEW.previous_version
  ) THEN RAISE(ABORT,'matching reviewed publication required') END;
  SELECT CASE WHEN pe_guard('version.insert',CAST(NEW.id AS TEXT),json_object(
    'content',NEW.content,'change_summary',NEW.change_summary,
    'source_habit_ids',NEW.source_habit_ids,'created_at',NEW.created_at,
    'created_by',NEW.created_by,'previous_version',NEW.previous_version
  )) IS NOT 1 THEN RAISE(ABORT,'snapshot content not approved') END;
END;

CREATE TRIGGER pe_version_no_update BEFORE UPDATE ON personality_versions
BEGIN SELECT RAISE(ABORT,'published versions immutable'); END;
CREATE TRIGGER pe_version_no_delete BEFORE DELETE ON personality_versions
BEGIN SELECT RAISE(ABORT,'published versions immutable'); END;

-- 只允许UPDATE现存版本指针；禁止INSERT OR REPLACE/删除/主键改名。
CREATE TRIGGER pe_pointer_no_insert BEFORE INSERT ON personality_state
WHEN NEW.key='version'
BEGIN SELECT RAISE(ABORT,'version pointer cannot be reinserted'); END;
CREATE TRIGGER pe_pointer_no_delete BEFORE DELETE ON personality_state
WHEN OLD.key='version'
BEGIN SELECT RAISE(ABORT,'version pointer cannot be deleted'); END;
CREATE TRIGGER pe_pointer_guard BEFORE UPDATE ON personality_state
WHEN OLD.key='version' OR NEW.key='version'
BEGIN
  SELECT CASE WHEN OLD.key IS NOT 'version' OR NEW.key IS NOT 'version'
    THEN RAISE(ABORT,'version pointer cannot be renamed') END;
  SELECT CASE WHEN NEW.value<>CAST(CAST(NEW.value AS INTEGER) AS TEXT)
    OR CAST(NEW.value AS INTEGER)<=CAST(OLD.value AS INTEGER)
    THEN RAISE(ABORT,'pointer must advance to new canonical version') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM pe_publications p
    JOIN personality_versions v ON v.id=p.version_id
    JOIN pe_review_history r ON r.id=p.review_id
    WHERE CAST(NEW.value AS INTEGER)=p.version_id
      AND CAST(OLD.value AS INTEGER)=p.previous_version
      AND r.action='publish' AND r.result_version=v.id
  ) THEN RAISE(ABORT,'pointer target not published') END;
  SELECT CASE WHEN pe_guard('pointer.update','version',
    json_object('previous',OLD.value,'next',NEW.value)) IS NOT 1
    THEN RAISE(ABORT,'pointer update not approved') END;
END;

-- 以下不可变表：禁止UPDATE/DELETE和以任何既有唯一键进行REPLACE。
CREATE TRIGGER pe_schema_no_update BEFORE UPDATE ON pe_schema
BEGIN SELECT RAISE(ABORT,'immutable pe_schema'); END;
CREATE TRIGGER pe_schema_no_delete BEFORE DELETE ON pe_schema
BEGIN SELECT RAISE(ABORT,'immutable pe_schema'); END;
CREATE TRIGGER pe_schema_no_replace BEFORE INSERT ON pe_schema
WHEN EXISTS(SELECT 1 FROM pe_schema WHERE (version=NEW.version))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_schema'); END;

CREATE TRIGGER pe_settings_history_no_update BEFORE UPDATE ON pe_settings_history
BEGIN SELECT RAISE(ABORT,'immutable pe_settings_history'); END;
CREATE TRIGGER pe_settings_history_no_delete BEFORE DELETE ON pe_settings_history
BEGIN SELECT RAISE(ABORT,'immutable pe_settings_history'); END;
CREATE TRIGGER pe_settings_history_no_replace BEFORE INSERT ON pe_settings_history
WHEN EXISTS(SELECT 1 FROM pe_settings_history WHERE (id=NEW.id) OR (revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_settings_history'); END;

CREATE TRIGGER pe_scopes_no_update BEFORE UPDATE ON pe_scopes
BEGIN SELECT RAISE(ABORT,'immutable pe_scopes'); END;
CREATE TRIGGER pe_scopes_no_delete BEFORE DELETE ON pe_scopes
BEGIN SELECT RAISE(ABORT,'immutable pe_scopes'); END;
CREATE TRIGGER pe_scopes_no_replace BEFORE INSERT ON pe_scopes
WHEN EXISTS(SELECT 1 FROM pe_scopes WHERE (id=NEW.id) OR (kind=NEW.kind AND scope_key=NEW.scope_key))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_scopes'); END;

CREATE TRIGGER pe_observations_no_update BEFORE UPDATE ON pe_observations
BEGIN SELECT RAISE(ABORT,'immutable pe_observations'); END;
CREATE TRIGGER pe_observations_no_delete BEFORE DELETE ON pe_observations
BEGIN SELECT RAISE(ABORT,'immutable pe_observations'); END;
CREATE TRIGGER pe_observations_no_replace BEFORE INSERT ON pe_observations
WHEN EXISTS(SELECT 1 FROM pe_observations WHERE (id=NEW.id) OR (event_key=NEW.event_key) OR (legacy_locator_hash=NEW.legacy_locator_hash))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_observations'); END;

CREATE TRIGGER pe_feedback_no_update BEFORE UPDATE ON pe_feedback
BEGIN SELECT RAISE(ABORT,'immutable pe_feedback'); END;
CREATE TRIGGER pe_feedback_no_delete BEFORE DELETE ON pe_feedback
BEGIN SELECT RAISE(ABORT,'immutable pe_feedback'); END;
CREATE TRIGGER pe_feedback_no_replace BEFORE INSERT ON pe_feedback
WHEN EXISTS(SELECT 1 FROM pe_feedback WHERE (id=NEW.id))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_feedback'); END;

CREATE TRIGGER pe_job_samples_no_update BEFORE UPDATE ON pe_job_samples
BEGIN SELECT RAISE(ABORT,'immutable pe_job_samples'); END;
CREATE TRIGGER pe_job_samples_no_delete BEFORE DELETE ON pe_job_samples
BEGIN SELECT RAISE(ABORT,'immutable pe_job_samples'); END;
CREATE TRIGGER pe_job_samples_no_replace BEFORE INSERT ON pe_job_samples
WHEN EXISTS(SELECT 1 FROM pe_job_samples WHERE (job_id=NEW.job_id AND observation_id=NEW.observation_id AND role=NEW.role) OR (job_id=NEW.job_id AND role=NEW.role AND ordinal=NEW.ordinal))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_job_samples'); END;

CREATE TRIGGER pe_call_events_no_update BEFORE UPDATE ON pe_call_events
BEGIN SELECT RAISE(ABORT,'immutable pe_call_events'); END;
CREATE TRIGGER pe_call_events_no_delete BEFORE DELETE ON pe_call_events
BEGIN SELECT RAISE(ABORT,'immutable pe_call_events'); END;
CREATE TRIGGER pe_call_events_no_replace BEFORE INSERT ON pe_call_events
WHEN EXISTS(SELECT 1 FROM pe_call_events WHERE (id=NEW.id) OR (call_id=NEW.call_id AND seq=NEW.seq))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_call_events'); END;

CREATE TRIGGER pe_reports_no_update BEFORE UPDATE ON pe_reports
BEGIN SELECT RAISE(ABORT,'immutable pe_reports'); END;
CREATE TRIGGER pe_reports_no_delete BEFORE DELETE ON pe_reports
BEGIN SELECT RAISE(ABORT,'immutable pe_reports'); END;
CREATE TRIGGER pe_reports_no_replace BEFORE INSERT ON pe_reports
WHEN EXISTS(SELECT 1 FROM pe_reports WHERE (id=NEW.id) OR (job_id=NEW.job_id))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_reports'); END;

CREATE TRIGGER personality_traits_no_update BEFORE UPDATE ON personality_traits
BEGIN SELECT RAISE(ABORT,'immutable personality_traits'); END;
CREATE TRIGGER personality_traits_no_delete BEFORE DELETE ON personality_traits
BEGIN SELECT RAISE(ABORT,'immutable personality_traits'); END;
CREATE TRIGGER personality_traits_no_replace BEFORE INSERT ON personality_traits
WHEN EXISTS(SELECT 1 FROM personality_traits WHERE (id=NEW.id) OR (scope_id=NEW.scope_id AND dimension=NEW.dimension AND semantic_key=NEW.semantic_key))
BEGIN SELECT RAISE(ABORT,'replacement forbidden personality_traits'); END;

CREATE TRIGGER personality_trait_revisions_no_update BEFORE UPDATE ON personality_trait_revisions
BEGIN SELECT RAISE(ABORT,'immutable personality_trait_revisions'); END;
CREATE TRIGGER personality_trait_revisions_no_delete BEFORE DELETE ON personality_trait_revisions
BEGIN SELECT RAISE(ABORT,'immutable personality_trait_revisions'); END;
CREATE TRIGGER personality_trait_revisions_no_replace BEFORE INSERT ON personality_trait_revisions
WHEN EXISTS(SELECT 1 FROM personality_trait_revisions WHERE (trait_id=NEW.trait_id AND revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'replacement forbidden personality_trait_revisions'); END;

CREATE TRIGGER pe_preferences_no_update BEFORE UPDATE ON pe_preferences
BEGIN SELECT RAISE(ABORT,'immutable pe_preferences'); END;
CREATE TRIGGER pe_preferences_no_delete BEFORE DELETE ON pe_preferences
BEGIN SELECT RAISE(ABORT,'immutable pe_preferences'); END;
CREATE TRIGGER pe_preferences_no_replace BEFORE INSERT ON pe_preferences
WHEN EXISTS(SELECT 1 FROM pe_preferences WHERE (id=NEW.id) OR (scope_id=NEW.scope_id AND semantic_key=NEW.semantic_key))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_preferences'); END;

CREATE TRIGGER pe_preference_revisions_no_update BEFORE UPDATE ON pe_preference_revisions
BEGIN SELECT RAISE(ABORT,'immutable pe_preference_revisions'); END;
CREATE TRIGGER pe_preference_revisions_no_delete BEFORE DELETE ON pe_preference_revisions
BEGIN SELECT RAISE(ABORT,'immutable pe_preference_revisions'); END;
CREATE TRIGGER pe_preference_revisions_no_replace BEFORE INSERT ON pe_preference_revisions
WHEN EXISTS(SELECT 1 FROM pe_preference_revisions WHERE (preference_id=NEW.preference_id AND revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_preference_revisions'); END;

CREATE TRIGGER pe_preference_traits_no_update BEFORE UPDATE ON pe_preference_traits
BEGIN SELECT RAISE(ABORT,'immutable pe_preference_traits'); END;
CREATE TRIGGER pe_preference_traits_no_delete BEFORE DELETE ON pe_preference_traits
BEGIN SELECT RAISE(ABORT,'immutable pe_preference_traits'); END;
CREATE TRIGGER pe_preference_traits_no_replace BEFORE INSERT ON pe_preference_traits
WHEN EXISTS(SELECT 1 FROM pe_preference_traits WHERE (preference_id=NEW.preference_id AND preference_revision=NEW.preference_revision AND trait_id=NEW.trait_id AND trait_revision=NEW.trait_revision))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_preference_traits'); END;

CREATE TRIGGER pe_evidence_no_update BEFORE UPDATE ON pe_evidence
BEGIN SELECT RAISE(ABORT,'immutable pe_evidence'); END;
CREATE TRIGGER pe_evidence_no_delete BEFORE DELETE ON pe_evidence
BEGIN SELECT RAISE(ABORT,'immutable pe_evidence'); END;
CREATE TRIGGER pe_evidence_no_replace BEFORE INSERT ON pe_evidence
WHEN EXISTS(SELECT 1 FROM pe_evidence WHERE (id=NEW.id))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_evidence'); END;

CREATE TRIGGER pe_review_history_no_update BEFORE UPDATE ON pe_review_history
BEGIN SELECT RAISE(ABORT,'immutable pe_review_history'); END;
CREATE TRIGGER pe_review_history_no_delete BEFORE DELETE ON pe_review_history
BEGIN SELECT RAISE(ABORT,'immutable pe_review_history'); END;
CREATE TRIGGER pe_review_history_no_replace BEFORE INSERT ON pe_review_history
WHEN EXISTS(SELECT 1 FROM pe_review_history WHERE (id=NEW.id) OR (idempotency_key=NEW.idempotency_key) OR (result_version=NEW.result_version))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_review_history'); END;

CREATE TRIGGER pe_review_targets_no_update BEFORE UPDATE ON pe_review_targets
BEGIN SELECT RAISE(ABORT,'immutable pe_review_targets'); END;
CREATE TRIGGER pe_review_targets_no_delete BEFORE DELETE ON pe_review_targets
BEGIN SELECT RAISE(ABORT,'immutable pe_review_targets'); END;
CREATE TRIGGER pe_review_targets_no_replace BEFORE INSERT ON pe_review_targets
WHEN EXISTS(SELECT 1 FROM pe_review_targets WHERE (id=NEW.id) OR (review_id=NEW.review_id AND target_kind='preference' AND preference_id=NEW.preference_id AND preference_revision=NEW.preference_revision) OR (review_id=NEW.review_id AND target_kind='trait' AND trait_id=NEW.trait_id AND trait_revision=NEW.trait_revision))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_review_targets'); END;

CREATE TRIGGER pe_publications_no_update BEFORE UPDATE ON pe_publications
BEGIN SELECT RAISE(ABORT,'immutable pe_publications'); END;
CREATE TRIGGER pe_publications_no_delete BEFORE DELETE ON pe_publications
BEGIN SELECT RAISE(ABORT,'immutable pe_publications'); END;
CREATE TRIGGER pe_publications_no_replace BEFORE INSERT ON pe_publications
WHEN EXISTS(SELECT 1 FROM pe_publications WHERE (version_id=NEW.version_id) OR (review_id=NEW.review_id))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_publications'); END;

CREATE TRIGGER pe_evaluations_no_update BEFORE UPDATE ON pe_evaluations
BEGIN SELECT RAISE(ABORT,'immutable pe_evaluations'); END;
CREATE TRIGGER pe_evaluations_no_delete BEFORE DELETE ON pe_evaluations
BEGIN SELECT RAISE(ABORT,'immutable pe_evaluations'); END;
CREATE TRIGGER pe_evaluations_no_replace BEFORE INSERT ON pe_evaluations
WHEN EXISTS(SELECT 1 FROM pe_evaluations WHERE (id=NEW.id))
BEGIN SELECT RAISE(ABORT,'replacement forbidden pe_evaluations'); END;

-- 原观察/习惯/反馈完全保留，切换后不再作为写入和发布来源。
CREATE TRIGGER pe_freeze_personality_observations_insert
BEFORE INSERT ON personality_observations
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_observations_update
BEFORE UPDATE ON personality_observations
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_observations_delete
BEFORE DELETE ON personality_observations
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_habits_insert
BEFORE INSERT ON personality_habits
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_habits_update
BEFORE UPDATE ON personality_habits
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_habits_delete
BEFORE DELETE ON personality_habits
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_feedback_insert
BEFORE INSERT ON personality_feedback
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_feedback_update
BEFORE UPDATE ON personality_feedback
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;
CREATE TRIGGER pe_freeze_personality_feedback_delete
BEFORE DELETE ON personality_feedback
BEGIN SELECT RAISE(ABORT,'legacy table read only'); END;

-- 真正的值由显式迁移工具绑定；SQL文件哈希与DDL一起提交。
INSERT INTO pe_schema(version,migration_hash,applied_at)
VALUES(1,:migration_hash,:applied_at);

COMMIT;
