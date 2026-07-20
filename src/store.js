import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DomainError,
  beginBudgetExecution,
  cancelBudgetRequest as cancelDomainRequest,
  expireBudgetRequest as expireDomainRequest,
  failBudgetRequest as failDomainRequest,
  hydrateBudgetRequest,
  submitBudgetAmount as submitDomainAmount,
  succeedBudgetRequest as succeedDomainRequest,
} from './domain.js';

const WEBHOOK_STATUSES = new Set(['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED']);
const DEFAULT_WEBHOOK_LEASE_MS = 120_000;
const MAX_WEBHOOK_LEASE_MS = 15 * 60_000;

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('INVALID_REQUEST', `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function sha256Hash(value, field = 'codeHash') {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new DomainError(
      'INVALID_REQUEST',
      `${field} must be a 64-character hexadecimal SHA-256 hash`,
      { field },
    );
  }
  return value.toLowerCase();
}

function requiredIsoTime(value, field) {
  if (value === undefined || value === null) {
    throw new DomainError('INVALID_REQUEST', `${field} is required`, { field });
  }
  return isoTime(value, field);
}

function json(value, field) {
  try {
    const encoded = JSON.stringify(value ?? {});
    if (encoded === undefined) throw new TypeError('not JSON serializable');
    return encoded;
  } catch (error) {
    throw new DomainError('INVALID_REQUEST', `${field} must be JSON serializable`, {
      field,
      reason: error.message,
    });
  }
}

function isoTime(value, field = 'time') {
  const parsed = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError('INVALID_REQUEST', `${field} must be a valid date`, { field, value });
  }
  return parsed.toISOString();
}

function parseJson(value) {
  return value === null ? null : JSON.parse(value);
}

function leaseDuration(value) {
  const duration = value ?? DEFAULT_WEBHOOK_LEASE_MS;
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > MAX_WEBHOOK_LEASE_MS) {
    throw new DomainError(
      'INVALID_REQUEST',
      `leaseDurationMs must be an integer between 1000 and ${MAX_WEBHOOK_LEASE_MS}`,
      { field: 'leaseDurationMs', value },
    );
  }
  return duration;
}

function safeMinor(value, field, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new DomainError(
      'INVALID_REQUEST',
      `${field} must be a ${positive ? 'positive' : 'non-negative'} safe integer`,
      { field },
    );
  }
  return value;
}

/**
 * Synchronous SQLite repository. A BEGIN IMMEDIATE transaction plus a
 * state/version compare-and-set makes approval single-use, including when more
 * than one worker is connected to the same database file.
 */
export class SqliteStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budget_requests (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        version INTEGER NOT NULL,
        agency_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        ad_account_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS webhook_events (
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        request_id TEXT,
        error_code TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_attempt_at TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(provider, event_id),
        FOREIGN KEY(request_id) REFERENCES budget_requests(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS execution_jobs (
        request_id TEXT PRIMARY KEY,
        actor_line_user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSING', 'COMPLETED')),
        created_at TEXT NOT NULL,
        available_at TEXT NOT NULL,
        completed_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_attempt_at TEXT,
        error_json TEXT,
        FOREIGN KEY(request_id) REFERENCES budget_requests(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS line_approvers (
        client_id TEXT NOT NULL,
        line_user_id TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        paired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(client_id, line_user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS line_pairing_tokens (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        code_hash TEXT NOT NULL
          CHECK(length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_line_user_id TEXT,
        invalidated_at TEXT,
        UNIQUE(client_id, code_hash),
        CHECK(expires_at > created_at),
        CHECK(
          (consumed_at IS NULL AND consumed_by_line_user_id IS NULL)
          OR (consumed_at IS NOT NULL AND consumed_by_line_user_id IS NOT NULL)
        ),
        CHECK(consumed_at IS NULL OR invalidated_at IS NULL),
        CHECK(
          consumed_at IS NULL
          OR (consumed_at >= created_at AND consumed_at < expires_at)
        ),
        CHECK(invalidated_at IS NULL OR invalidated_at >= created_at)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telemetry_enrollments (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        code_hash TEXT NOT NULL
          CHECK(length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
        browser_profile TEXT NOT NULL,
        tab_group TEXT NOT NULL,
        business_center_id TEXT NOT NULL,
        seller_mode TEXT NOT NULL,
        page_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        invalidated_at TEXT,
        UNIQUE(client_id, code_hash),
        CHECK(expires_at > created_at),
        CHECK(consumed_at IS NULL OR invalidated_at IS NULL)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telemetry_credentials (
        credential_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        public_key_jwk TEXT NOT NULL,
        browser_profile TEXT NOT NULL,
        tab_group TEXT NOT NULL,
        business_center_id TEXT NOT NULL,
        seller_mode TEXT NOT NULL,
        page_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        enrollment_id TEXT NOT NULL,
        FOREIGN KEY(enrollment_id) REFERENCES telemetry_enrollments(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telemetry_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        advertiser_id TEXT NOT NULL,
        business_center_id TEXT NOT NULL,
        seller_mode TEXT NOT NULL,
        page_type TEXT NOT NULL,
        tiktok_account_id TEXT NOT NULL,
        campaign_id TEXT,
        campaign_ref TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        campaign_type TEXT NOT NULL CHECK(campaign_type = 'LIVE_GMV_MAX'),
        campaign_status TEXT NOT NULL CHECK(campaign_status = 'ACTIVE'),
        currency TEXT NOT NULL CHECK(currency = 'THB'),
        schema_version INTEGER NOT NULL CHECK(schema_version IN (1, 2)),
        ui_schema_fingerprint TEXT NOT NULL,
        daily_budget_minor INTEGER NOT NULL CHECK(daily_budget_minor > 0),
        total_budget_minor INTEGER NOT NULL CHECK(total_budget_minor > 0),
        cost_minor INTEGER NOT NULL CHECK(cost_minor >= 0),
        net_cost_minor INTEGER NOT NULL CHECK(net_cost_minor >= 0),
        gross_revenue_minor INTEGER CHECK(gross_revenue_minor IS NULL OR gross_revenue_minor >= 0),
        gross_roi_milli INTEGER CHECK(gross_roi_milli IS NULL OR gross_roi_milli >= 0),
        net_revenue_minor INTEGER CHECK(net_revenue_minor IS NULL OR net_revenue_minor >= 0),
        net_roi_milli INTEGER CHECK(net_roi_milli IS NULL OR net_roi_milli >= 0),
        gmv_minor INTEGER CHECK(gmv_minor IS NULL OR gmv_minor >= 0),
        policy_cap_minor INTEGER NOT NULL CHECK(policy_cap_minor > 0),
        over_policy_cap INTEGER NOT NULL CHECK(over_policy_cap IN (0, 1)),
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        source_browser_profile TEXT NOT NULL,
        source_tab_group TEXT NOT NULL,
        payload_hash TEXT NOT NULL
          CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
        FOREIGN KEY(credential_id) REFERENCES telemetry_credentials(credential_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telemetry_latest (
        client_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL UNIQUE,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        FOREIGN KEY(snapshot_id) REFERENCES telemetry_snapshots(snapshot_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telemetry_nonces (
        credential_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(credential_id, nonce),
        FOREIGN KEY(credential_id) REFERENCES telemetry_credentials(credential_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telemetry_alert_evaluations (
        snapshot_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_id TEXT,
        evaluated_at TEXT NOT NULL,
        details_json TEXT NOT NULL,
        FOREIGN KEY(snapshot_id) REFERENCES telemetry_snapshots(snapshot_id),
        FOREIGN KEY(request_id) REFERENCES budget_requests(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS campaign_shortcuts (
        client_id TEXT NOT NULL,
        shortcut_name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        campaign_name_template TEXT NOT NULL,
        daily_budget_minor INTEGER NOT NULL CHECK(daily_budget_minor > 0),
        target_roi_milli INTEGER NOT NULL CHECK(target_roi_milli > 0),
        top_up_threshold_bps INTEGER NOT NULL
          CHECK(top_up_threshold_bps > 0 AND top_up_threshold_bps < 10000),
        created_at TEXT NOT NULL,
        created_by_line_user_id TEXT NOT NULL,
        PRIMARY KEY(client_id, shortcut_name, revision)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS report_subscriptions (
        client_id TEXT NOT NULL,
        line_user_id TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL
          CHECK(interval_minutes BETWEEN 60 AND 1440),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        next_due_at TEXT NOT NULL,
        last_occurrence_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(client_id, line_user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS campaign_control_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        action TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'PENDING_CONFIRMATION', 'CONFIRMED_DRY_RUN', 'CONFIRMED',
          'CANCELLED', 'EXPIRED'
        )),
        version INTEGER NOT NULL CHECK(version > 0),
        requested_by_line_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS coupon_schedules (
        id TEXT PRIMARY KEY,
        control_request_id TEXT UNIQUE,
        client_id TEXT NOT NULL,
        line_user_id TEXT NOT NULL,
        event_at TEXT NOT NULL,
        notify_at TEXT NOT NULL,
        budget_minor INTEGER NOT NULL CHECK(budget_minor > 0),
        status TEXT NOT NULL CHECK(status IN (
          'PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        FOREIGN KEY(control_request_id) REFERENCES campaign_control_requests(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        occurred_at TEXT NOT NULL,
        details_json TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES budget_requests(id)
      ) STRICT;
    `);

    // SQLite cannot add several columns in one ALTER and existing MVP database
    // files predate leases/updated_at, so additions are deliberately idempotent.
    this.#ensureColumn('budget_requests', 'updated_at', 'TEXT');
    this.#ensureColumn('webhook_events', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
    this.#ensureColumn('webhook_events', 'lease_token', 'TEXT');
    this.#ensureColumn('webhook_events', 'lease_expires_at', 'TEXT');
    this.#ensureColumn('webhook_events', 'last_attempt_at', 'TEXT');
    // The first LINE-controls build created coupon_schedules without its
    // control-request link. Adding a nullable referenced column is safe for
    // those intermediate databases, while fresh databases receive the same
    // constraint in CREATE TABLE above.
    this.#ensureColumn(
      'coupon_schedules',
      'control_request_id',
      'TEXT REFERENCES campaign_control_requests(id)',
    );
    this.#migrateTelemetrySchemaV2();
    this.#backfillBudgetUpdatedAt();
    this.#assertNoActiveRequestDuplicates();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS budget_requests_state_idx
        ON budget_requests(state, expires_at);
      CREATE INDEX IF NOT EXISTS budget_requests_account_idx
        ON budget_requests(ad_account_id, state);
      CREATE INDEX IF NOT EXISTS budget_requests_latest_idx
        ON budget_requests(ad_account_id, campaign_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS budget_requests_one_active_idx
        ON budget_requests(ad_account_id, campaign_id)
        WHERE state IN ('PENDING_INPUT', 'PENDING_APPROVAL', 'EXECUTING');
      CREATE INDEX IF NOT EXISTS webhook_events_claim_idx
        ON webhook_events(status, lease_expires_at, received_at);
      CREATE INDEX IF NOT EXISTS execution_jobs_claim_idx
        ON execution_jobs(status, available_at, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS line_approvers_active_idx
        ON line_approvers(client_id, active, line_user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS line_pairing_tokens_one_open_idx
        ON line_pairing_tokens(client_id)
        WHERE consumed_at IS NULL AND invalidated_at IS NULL;
      CREATE INDEX IF NOT EXISTS line_pairing_tokens_lookup_idx
        ON line_pairing_tokens(client_id, code_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS telemetry_enrollments_one_open_idx
        ON telemetry_enrollments(client_id)
        WHERE consumed_at IS NULL AND invalidated_at IS NULL;
      DROP INDEX IF EXISTS telemetry_credentials_one_active_install_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS telemetry_credentials_one_active_client_idx
        ON telemetry_credentials(client_id)
        WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS telemetry_credentials_client_idx
        ON telemetry_credentials(client_id, revoked_at, created_at);
      CREATE INDEX IF NOT EXISTS telemetry_snapshots_client_time_idx
        ON telemetry_snapshots(client_id, observed_at DESC, received_at DESC);
      CREATE INDEX IF NOT EXISTS telemetry_nonces_received_idx
        ON telemetry_nonces(received_at);
      CREATE INDEX IF NOT EXISTS telemetry_alert_evaluations_time_idx
        ON telemetry_alert_evaluations(evaluated_at);
      CREATE INDEX IF NOT EXISTS campaign_shortcuts_latest_idx
        ON campaign_shortcuts(client_id, shortcut_name, revision DESC);
      CREATE INDEX IF NOT EXISTS report_subscriptions_due_idx
        ON report_subscriptions(enabled, next_due_at);
      CREATE INDEX IF NOT EXISTS campaign_control_requests_client_idx
        ON campaign_control_requests(client_id, state, expires_at);
      CREATE INDEX IF NOT EXISTS coupon_schedules_due_idx
        ON coupon_schedules(status, notify_at);
      CREATE UNIQUE INDEX IF NOT EXISTS coupon_schedules_control_request_idx
        ON coupon_schedules(control_request_id)
        WHERE control_request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS audit_events_request_idx
        ON audit_events(request_id, sequence);
    `);
  }

  #ensureColumn(table, column, declaration) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((candidate) => candidate.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  #migrateTelemetrySchemaV2() {
    const table = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_snapshots'
    `).get();
    if (!table?.sql || /schema_version\s+IN\s*\(1,\s*2\)/i.test(table.sql)) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE telemetry_snapshots_v2 (
          snapshot_id TEXT PRIMARY KEY,
          credential_id TEXT NOT NULL,
          client_id TEXT NOT NULL,
          advertiser_id TEXT NOT NULL,
          business_center_id TEXT NOT NULL,
          seller_mode TEXT NOT NULL,
          page_type TEXT NOT NULL,
          tiktok_account_id TEXT NOT NULL,
          campaign_id TEXT,
          campaign_ref TEXT NOT NULL,
          campaign_name TEXT NOT NULL,
          campaign_type TEXT NOT NULL CHECK(campaign_type = 'LIVE_GMV_MAX'),
          campaign_status TEXT NOT NULL CHECK(campaign_status = 'ACTIVE'),
          currency TEXT NOT NULL CHECK(currency = 'THB'),
          schema_version INTEGER NOT NULL CHECK(schema_version IN (1, 2)),
          ui_schema_fingerprint TEXT NOT NULL,
          daily_budget_minor INTEGER NOT NULL CHECK(daily_budget_minor > 0),
          total_budget_minor INTEGER NOT NULL CHECK(total_budget_minor > 0),
          cost_minor INTEGER NOT NULL CHECK(cost_minor >= 0),
          net_cost_minor INTEGER NOT NULL CHECK(net_cost_minor >= 0),
          gross_revenue_minor INTEGER CHECK(gross_revenue_minor IS NULL OR gross_revenue_minor >= 0),
          gross_roi_milli INTEGER CHECK(gross_roi_milli IS NULL OR gross_roi_milli >= 0),
          net_revenue_minor INTEGER CHECK(net_revenue_minor IS NULL OR net_revenue_minor >= 0),
          net_roi_milli INTEGER CHECK(net_roi_milli IS NULL OR net_roi_milli >= 0),
          gmv_minor INTEGER CHECK(gmv_minor IS NULL OR gmv_minor >= 0),
          policy_cap_minor INTEGER NOT NULL CHECK(policy_cap_minor > 0),
          over_policy_cap INTEGER NOT NULL CHECK(over_policy_cap IN (0, 1)),
          observed_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          source_browser_profile TEXT NOT NULL,
          source_tab_group TEXT NOT NULL,
          payload_hash TEXT NOT NULL
            CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
          FOREIGN KEY(credential_id) REFERENCES telemetry_credentials(credential_id)
        ) STRICT;
        INSERT INTO telemetry_snapshots_v2 (
          snapshot_id, credential_id, client_id, advertiser_id, business_center_id,
          seller_mode, page_type, tiktok_account_id, campaign_id, campaign_ref,
          campaign_name, campaign_type, campaign_status, currency, schema_version,
          ui_schema_fingerprint, daily_budget_minor, total_budget_minor, cost_minor,
          net_cost_minor, policy_cap_minor, over_policy_cap, observed_at, received_at,
          source_browser_profile, source_tab_group, payload_hash
        )
        SELECT snapshot_id, credential_id, client_id, advertiser_id, business_center_id,
          seller_mode, page_type, tiktok_account_id, campaign_id, campaign_ref,
          campaign_name, campaign_type, campaign_status, currency, schema_version,
          ui_schema_fingerprint, daily_budget_minor, total_budget_minor, cost_minor,
          net_cost_minor, policy_cap_minor, over_policy_cap, observed_at, received_at,
          source_browser_profile, source_tab_group, payload_hash
        FROM telemetry_snapshots;
        DROP TABLE telemetry_snapshots;
        ALTER TABLE telemetry_snapshots_v2 RENAME TO telemetry_snapshots;
        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    const violation = this.db.prepare('PRAGMA foreign_key_check').get();
    if (violation) throw new Error('Telemetry schema v2 migration failed foreign-key validation');
  }

  #backfillBudgetUpdatedAt() {
    const rows = this.db.prepare(`
      SELECT id, data_json FROM budget_requests WHERE updated_at IS NULL OR updated_at = ''
    `).all();
    const update = this.db.prepare('UPDATE budget_requests SET updated_at = ? WHERE id = ?');
    for (const row of rows) {
      const request = parseJson(row.data_json);
      update.run(isoTime(request.updatedAt ?? request.createdAt, 'budgetRequest.updatedAt'), row.id);
    }
  }

  #assertNoActiveRequestDuplicates() {
    const duplicate = this.db.prepare(`
      SELECT ad_account_id, campaign_id, COUNT(*) AS active_count
      FROM budget_requests
      WHERE state IN ('PENDING_INPUT', 'PENDING_APPROVAL', 'EXECUTING')
      GROUP BY ad_account_id, campaign_id
      HAVING COUNT(*) > 1
      LIMIT 1
    `).get();
    if (duplicate) {
      throw new DomainError(
        'ACTIVE_REQUEST_MIGRATION_CONFLICT',
        'Existing database contains more than one active request for an account/campaign',
        {
          adAccountId: duplicate.ad_account_id,
          campaignId: duplicate.campaign_id,
          activeCount: duplicate.active_count,
        },
      );
    }
  }

  close() {
    this.db.close();
  }

  #transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the domain/storage error that caused the rollback.
      }
      throw error;
    }
  }

  #insertAudit({ requestId = null, eventType, actorType, actorId = null, occurredAt, details = {} }) {
    const result = this.db.prepare(`
      INSERT INTO audit_events
        (request_id, event_type, actor_type, actor_id, occurred_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      requiredString(eventType, 'eventType'),
      requiredString(actorType, 'actorType'),
      actorId === null ? null : requiredString(actorId, 'actorId'),
      isoTime(occurredAt, 'occurredAt'),
      json(details, 'details'),
    );
    return Number(result.lastInsertRowid);
  }

  #insertRequest(request) {
    return this.db.prepare(`
      INSERT INTO budget_requests
        (id, state, version, agency_id, client_id, ad_account_id, campaign_id, expires_at, updated_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.id,
      request.state,
      request.version,
      request.agencyId,
      request.clientId,
      request.adAccountId,
      request.campaignId,
      request.expiresAt,
      request.updatedAt,
      json(request, 'budgetRequest'),
    );
  }

  createBudgetRequest(value, { actorType = 'SYSTEM', actorId = null } = {}) {
    const request = hydrateBudgetRequest(value);
    try {
      return this.#transaction(() => {
        this.#insertRequest(request);
        this.#insertAudit({
          requestId: request.id,
          eventType: 'BUDGET_REQUEST_CREATED',
          actorType,
          actorId,
          occurredAt: request.createdAt,
          details: {
            state: request.state,
            adAccountId: request.adAccountId,
            campaignId: request.campaignId,
            currentBudgetMinor: request.currentBudgetMinor,
          },
        });
        return request;
      });
    } catch (error) {
      if (
        String(error.message).includes('UNIQUE constraint failed: budget_requests.id') ||
        this.getBudgetRequest(request.id)
      ) {
        throw new DomainError('DUPLICATE_REQUEST', 'Budget request id already exists', { requestId: request.id });
      }
      if (String(error.message).includes(
        'UNIQUE constraint failed: budget_requests.ad_account_id, budget_requests.campaign_id',
      )) {
        throw new DomainError(
          'ACTIVE_REQUEST_EXISTS',
          'An active budget request already exists for this ad account and campaign',
          { adAccountId: request.adAccountId, campaignId: request.campaignId },
        );
      }
      throw error;
    }
  }

  getBudgetRequest(id) {
    const row = this.db.prepare('SELECT data_json FROM budget_requests WHERE id = ?').get(
      requiredString(id, 'id'),
    );
    return row ? hydrateBudgetRequest(parseJson(row.data_json)) : null;
  }

  requireBudgetRequest(id) {
    const request = this.getBudgetRequest(id);
    if (!request) throw new DomainError('REQUEST_NOT_FOUND', 'Budget request was not found', { requestId: id });
    return request;
  }

  listBudgetRequests({ state, adAccountId, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError('INVALID_REQUEST', 'limit must be an integer between 1 and 1000');
    }
    const clauses = [];
    const parameters = [];
    if (state !== undefined) {
      clauses.push('state = ?');
      parameters.push(requiredString(state, 'state'));
    }
    if (adAccountId !== undefined) {
      clauses.push('ad_account_id = ?');
      parameters.push(requiredString(adAccountId, 'adAccountId'));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT data_json FROM budget_requests
      ${where}
      ORDER BY expires_at ASC, id ASC
      LIMIT ?
    `).all(...parameters, limit).map((row) => hydrateBudgetRequest(parseJson(row.data_json)));
  }

  getLatestBudgetRequest({ adAccountId, campaignId } = {}) {
    const row = this.db.prepare(`
      SELECT data_json
      FROM budget_requests
      WHERE ad_account_id = ? AND campaign_id = ?
      ORDER BY updated_at DESC, version DESC, id DESC
      LIMIT 1
    `).get(
      requiredString(adAccountId, 'adAccountId'),
      requiredString(campaignId, 'campaignId'),
    );
    return row ? hydrateBudgetRequest(parseJson(row.data_json)) : null;
  }

  #mutateRequest(id, transition, audit) {
    return this.#transaction(() => {
      const current = this.requireBudgetRequest(id);
      const next = transition(current);
      const result = this.db.prepare(`
        UPDATE budget_requests
        SET state = ?, version = ?, expires_at = ?, updated_at = ?, data_json = ?
        WHERE id = ? AND state = ? AND version = ?
      `).run(
        next.state,
        next.version,
        next.expiresAt,
        next.updatedAt,
        json(next, 'budgetRequest'),
        current.id,
        current.state,
        current.version,
      );
      if (result.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Budget request changed concurrently', {
          requestId: current.id,
          expectedState: current.state,
          expectedVersion: current.version,
        });
      }
      this.#insertAudit({
        requestId: current.id,
        eventType: audit.eventType,
        actorType: audit.actorType,
        actorId: audit.actorId,
        occurredAt: next.updatedAt,
        details: {
          fromState: current.state,
          toState: next.state,
          version: next.version,
          ...(typeof audit.details === 'function' ? audit.details(current, next) : audit.details),
        },
      });
      return next;
    });
  }

  submitBudgetAmount(id, input) {
    return this.#mutateRequest(
      id,
      (request) => submitDomainAmount(request, input),
      {
        eventType: 'BUDGET_AMOUNT_SUBMITTED',
        actorType: 'LINE_USER',
        actorId: input?.actorLineUserId,
        details: { increaseMinor: input?.increaseMinor },
      },
    );
  }

  /** Atomic, single-use approval and execution claim. */
  claimBudgetRequestForExecution(id, input) {
    return this.#mutateRequest(
      id,
      (request) => beginBudgetExecution(request, input),
      {
        eventType: 'BUDGET_EXECUTION_CLAIMED',
        actorType: 'LINE_USER',
        actorId: input?.actorLineUserId,
        details: (_current, next) => ({
          executionId: next.execution.id,
          observedCurrentBudgetMinor: input?.observedCurrentBudgetMinor,
        }),
      },
    );
  }

  succeedBudgetRequest(id, input) {
    return this.#mutateRequest(
      id,
      (request) => succeedDomainRequest(request, input),
      {
        eventType: 'BUDGET_EXECUTION_SUCCEEDED',
        actorType: 'SYSTEM',
        actorId: null,
        details: { actualBudgetMinor: input?.actualBudgetMinor, platformReference: input?.platformReference ?? null },
      },
    );
  }

  failBudgetRequest(id, input) {
    return this.#mutateRequest(
      id,
      (request) => failDomainRequest(request, input),
      {
        eventType: 'BUDGET_EXECUTION_FAILED',
        actorType: 'SYSTEM',
        actorId: null,
        details: { code: input?.code, retryable: Boolean(input?.retryable) },
      },
    );
  }

  expireBudgetRequest(id, input = {}) {
    return this.#mutateRequest(
      id,
      (request) => expireDomainRequest(request, input),
      { eventType: 'BUDGET_REQUEST_EXPIRED', actorType: 'SYSTEM', actorId: null, details: {} },
    );
  }

  cancelBudgetRequest(id, input) {
    return this.#mutateRequest(
      id,
      (request) => cancelDomainRequest(request, input),
      {
        eventType: 'BUDGET_REQUEST_CANCELLED',
        actorType: 'LINE_USER',
        actorId: input?.actorLineUserId,
        details: { reason: input?.reason ?? 'Cancelled by operator' },
      },
    );
  }

  /**
   * Creates a one-time LINE pairing challenge. Callers must hash the displayed
   * code with SHA-256 before it crosses the repository boundary. Creating a
   * challenge revokes every older, still-unused challenge for the same client.
   */
  createLinePairing({ clientId, codeHash, createdAt, expiresAt } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedHash = sha256Hash(codeHash);
    const created = requiredIsoTime(createdAt, 'createdAt');
    const expires = requiredIsoTime(expiresAt, 'expiresAt');
    if (Date.parse(expires) <= Date.parse(created)) {
      throw new DomainError('INVALID_REQUEST', 'expiresAt must be later than createdAt', {
        field: 'expiresAt',
      });
    }

    return this.#transaction(() => {
      const newerOpenPairing = this.db.prepare(`
        SELECT id
        FROM line_pairing_tokens
        WHERE client_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
          AND created_at > ?
        LIMIT 1
      `).get(normalizedClientId, created);
      if (newerOpenPairing) {
        throw new DomainError(
          'INVALID_REQUEST',
          'createdAt cannot be earlier than the current unused pairing',
          { field: 'createdAt', clientId: normalizedClientId },
        );
      }

      const reused = this.db.prepare(`
        SELECT 1 AS present
        FROM line_pairing_tokens
        WHERE client_id = ? AND code_hash = ?
      `).get(normalizedClientId, normalizedHash);
      if (reused) {
        throw new DomainError(
          'LINE_PAIRING_CODE_REUSED',
          'A pairing code may not be registered more than once for a client',
          { clientId: normalizedClientId },
        );
      }

      const invalidated = this.db.prepare(`
        UPDATE line_pairing_tokens
        SET invalidated_at = ?
        WHERE client_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
          AND created_at <= ?
      `).run(created, normalizedClientId, created);
      const pairingId = randomUUID();
      this.db.prepare(`
        INSERT INTO line_pairing_tokens
          (id, client_id, code_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(pairingId, normalizedClientId, normalizedHash, created, expires);

      const invalidatedCount = Number(invalidated.changes);
      this.#insertAudit({
        eventType: 'LINE_PAIRING_CREATED',
        actorType: 'SYSTEM',
        occurredAt: created,
        details: {
          pairingId,
          clientId: normalizedClientId,
          expiresAt: expires,
          invalidatedCount,
        },
      });
      return Object.freeze({
        created: true,
        pairingId,
        clientId: normalizedClientId,
        createdAt: created,
        expiresAt: expires,
        invalidatedCount,
      });
    });
  }

  /**
   * Consumes a matching challenge and authorizes the LINE user in one write
   * transaction. Hashes are intentionally absent from results, errors, and
   * audit records.
   */
  consumeLinePairing({ clientId, codeHash, lineUserId, consumedAt } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedHash = sha256Hash(codeHash);
    const normalizedLineUserId = requiredString(lineUserId, 'lineUserId');
    const at = requiredIsoTime(consumedAt, 'consumedAt');

    return this.#transaction(() => {
      const pairing = this.db.prepare(`
        SELECT id, created_at, expires_at, consumed_at,
               consumed_by_line_user_id, invalidated_at
        FROM line_pairing_tokens
        WHERE client_id = ? AND code_hash = ?
      `).get(normalizedClientId, normalizedHash);
      if (!pairing) {
        throw new DomainError('LINE_PAIRING_NOT_FOUND', 'Pairing code is not valid for this client', {
          clientId: normalizedClientId,
        });
      }
      if (pairing.consumed_at !== null) {
        throw new DomainError('LINE_PAIRING_ALREADY_CONSUMED', 'Pairing code has already been used', {
          clientId: normalizedClientId,
          pairingId: pairing.id,
        });
      }
      if (pairing.invalidated_at !== null) {
        throw new DomainError('LINE_PAIRING_INVALIDATED', 'Pairing code was replaced by a newer code', {
          clientId: normalizedClientId,
          pairingId: pairing.id,
        });
      }
      if (Date.parse(at) < Date.parse(pairing.created_at)) {
        throw new DomainError('INVALID_REQUEST', 'consumedAt cannot be earlier than createdAt', {
          field: 'consumedAt',
        });
      }
      if (Date.parse(at) >= Date.parse(pairing.expires_at)) {
        throw new DomainError('LINE_PAIRING_EXPIRED', 'Pairing code has expired', {
          clientId: normalizedClientId,
          pairingId: pairing.id,
          expiresAt: pairing.expires_at,
        });
      }

      const consumed = this.db.prepare(`
        UPDATE line_pairing_tokens
        SET consumed_at = ?, consumed_by_line_user_id = ?
        WHERE id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
          AND created_at <= ? AND expires_at > ?
      `).run(at, normalizedLineUserId, pairing.id, at, at);
      if (consumed.changes !== 1) {
        throw new DomainError(
          'CONCURRENT_MODIFICATION',
          'Pairing code changed while it was being consumed',
          { clientId: normalizedClientId, pairingId: pairing.id },
        );
      }

      const existingApprover = this.db.prepare(`
        SELECT active
        FROM line_approvers
        WHERE client_id = ? AND line_user_id = ?
      `).get(normalizedClientId, normalizedLineUserId);
      this.db.prepare(`
        INSERT INTO line_approvers
          (client_id, line_user_id, active, paired_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(client_id, line_user_id) DO UPDATE SET
          active = 1,
          paired_at = excluded.paired_at,
          updated_at = excluded.updated_at
      `).run(normalizedClientId, normalizedLineUserId, at, at);

      this.#insertAudit({
        eventType: 'LINE_APPROVER_PAIRED',
        actorType: 'LINE_USER',
        actorId: normalizedLineUserId,
        occurredAt: at,
        details: {
          pairingId: pairing.id,
          clientId: normalizedClientId,
          alreadyActive: existingApprover?.active === 1,
        },
      });
      return Object.freeze({
        consumed: true,
        pairingId: pairing.id,
        clientId: normalizedClientId,
        lineUserId: normalizedLineUserId,
        consumedAt: at,
        approver: this.#getLineApprover(normalizedClientId, normalizedLineUserId),
      });
    });
  }

  #mapLineApprover(row) {
    return Object.freeze({
      clientId: row.client_id,
      lineUserId: row.line_user_id,
      active: row.active === 1,
      pairedAt: row.paired_at,
      updatedAt: row.updated_at,
    });
  }

  #getLineApprover(clientId, lineUserId) {
    const row = this.db.prepare(`
      SELECT client_id, line_user_id, active, paired_at, updated_at
      FROM line_approvers
      WHERE client_id = ? AND line_user_id = ?
    `).get(clientId, lineUserId);
    return row ? this.#mapLineApprover(row) : null;
  }

  listLineApprovers({ clientId } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    return this.db.prepare(`
      SELECT client_id, line_user_id, active, paired_at, updated_at
      FROM line_approvers
      WHERE client_id = ? AND active = 1
      ORDER BY line_user_id ASC
    `).all(normalizedClientId).map((row) => this.#mapLineApprover(row));
  }

  isLineApprover({ clientId, lineUserId } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedLineUserId = requiredString(lineUserId, 'lineUserId');
    const row = this.db.prepare(`
      SELECT 1 AS present
      FROM line_approvers
      WHERE client_id = ? AND line_user_id = ? AND active = 1
    `).get(normalizedClientId, normalizedLineUserId);
    return Boolean(row);
  }

  /**
   * Revokes one database-paired LINE approver and removes the durable work
   * that was still waiting on that user's authority. Configured approvers are
   * deliberately handled by the HTTP boundary because they cannot be revoked
   * by changing database state.
   */
  revokeLineApprover({ clientId, lineUserId, revokedAt } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedLineUserId = requiredString(lineUserId, 'lineUserId');
    const at = requiredIsoTime(revokedAt, 'revokedAt');

    return this.#transaction(() => {
      const existing = this.#getLineApprover(normalizedClientId, normalizedLineUserId);
      if (!existing) {
        throw new DomainError(
          'LINE_APPROVER_NOT_FOUND',
          'LINE approver is not paired for this client',
          { clientId: normalizedClientId },
        );
      }

      const approver = this.db.prepare(`
        UPDATE line_approvers
        SET active = 0, updated_at = ?
        WHERE client_id = ? AND line_user_id = ? AND active = 1
      `).run(at, normalizedClientId, normalizedLineUserId);
      const reports = this.db.prepare(`
        UPDATE report_subscriptions
        SET enabled = 0, updated_at = ?
        WHERE client_id = ? AND line_user_id = ? AND enabled = 1
      `).run(at, normalizedClientId, normalizedLineUserId);
      const coupons = this.db.prepare(`
        UPDATE coupon_schedules
        SET status = 'CANCELLED', updated_at = ?
        WHERE client_id = ? AND line_user_id = ? AND status = 'PENDING'
      `).run(at, normalizedClientId, normalizedLineUserId);
      const controls = this.db.prepare(`
        UPDATE campaign_control_requests
        SET state = 'CANCELLED', version = version + 1, updated_at = ?
        WHERE client_id = ?
          AND requested_by_line_user_id = ?
          AND state = 'PENDING_CONFIRMATION'
      `).run(at, normalizedClientId, normalizedLineUserId);

      const counts = Object.freeze({
        approversRevoked: Number(approver.changes),
        reportSubscriptionsDisabled: Number(reports.changes),
        couponSchedulesCancelled: Number(coupons.changes),
        campaignControlRequestsCancelled: Number(controls.changes),
      });
      this.#insertAudit({
        eventType: 'LINE_APPROVER_REVOKED',
        actorType: 'ADMIN',
        occurredAt: at,
        details: {
          clientId: normalizedClientId,
          lineUserId: normalizedLineUserId,
          ...counts,
        },
      });

      return Object.freeze({
        clientId: normalizedClientId,
        lineUserId: normalizedLineUserId,
        revokedAt: at,
        counts,
        approver: this.#getLineApprover(normalizedClientId, normalizedLineUserId),
      });
    });
  }

  /**
   * Creates a short-lived, single-use bootstrap code for one Chrome telemetry
   * client. Only the SHA-256 hash crosses the storage boundary. Creating a new
   * challenge invalidates any older unused challenge for the same client.
   */
  createTelemetryEnrollment({
    clientId,
    codeHash,
    browserProfile,
    tabGroup,
    businessCenterId,
    sellerMode,
    pageType,
    createdAt,
    expiresAt,
  } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedHash = sha256Hash(codeHash);
    const normalizedProfile = requiredString(browserProfile, 'browserProfile');
    const normalizedTabGroup = requiredString(tabGroup, 'tabGroup');
    const normalizedBusinessCenterId = requiredString(businessCenterId, 'businessCenterId');
    const normalizedSellerMode = requiredString(sellerMode, 'sellerMode');
    const normalizedPageType = requiredString(pageType, 'pageType');
    const created = requiredIsoTime(createdAt, 'createdAt');
    const expires = requiredIsoTime(expiresAt, 'expiresAt');
    if (Date.parse(expires) <= Date.parse(created)) {
      throw new DomainError('INVALID_REQUEST', 'expiresAt must be later than createdAt');
    }

    return this.#transaction(() => {
      const invalidated = this.db.prepare(`
        UPDATE telemetry_enrollments
        SET invalidated_at = ?
        WHERE client_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
      `).run(created, normalizedClientId);
      const enrollmentId = `te_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO telemetry_enrollments
          (id, client_id, code_hash, browser_profile, tab_group,
           business_center_id, seller_mode, page_type, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        enrollmentId,
        normalizedClientId,
        normalizedHash,
        normalizedProfile,
        normalizedTabGroup,
        normalizedBusinessCenterId,
        normalizedSellerMode,
        normalizedPageType,
        created,
        expires,
      );
      this.#insertAudit({
        eventType: 'TELEMETRY_ENROLLMENT_CREATED',
        actorType: 'ADMIN',
        occurredAt: created,
        details: {
          enrollmentId,
          clientId: normalizedClientId,
          expiresAt: expires,
          invalidatedCount: Number(invalidated.changes),
        },
      });
      return Object.freeze({
        enrollmentId,
        clientId: normalizedClientId,
        browserProfile: normalizedProfile,
        tabGroup: normalizedTabGroup,
        businessCenterId: normalizedBusinessCenterId,
        sellerMode: normalizedSellerMode,
        pageType: normalizedPageType,
        createdAt: created,
        expiresAt: expires,
        invalidatedCount: Number(invalidated.changes),
      });
    });
  }

  #mapTelemetryCredential(row) {
    return Object.freeze({
      credentialId: row.credential_id,
      clientId: row.client_id,
      installationId: row.installation_id,
      publicKeyJwk: Object.freeze(parseJson(row.public_key_jwk)),
      browserProfile: row.browser_profile,
      tabGroup: row.tab_group,
      businessCenterId: row.business_center_id,
      sellerMode: row.seller_mode,
      pageType: row.page_type,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    });
  }

  getTelemetryCredential(credentialId) {
    const row = this.db.prepare(`
      SELECT credential_id, client_id, installation_id, public_key_jwk,
             browser_profile, tab_group, business_center_id, seller_mode,
             page_type, created_at, revoked_at
      FROM telemetry_credentials
      WHERE credential_id = ?
    `).get(requiredString(credentialId, 'credentialId'));
    return row ? this.#mapTelemetryCredential(row) : null;
  }

  /**
   * Exchanges one bootstrap hash for a public-key credential. The extension's
   * private P-256 key never leaves Chrome. Re-enrolling a client revokes its
   * prior collector atomically, preventing competing latest snapshots.
   */
  consumeTelemetryEnrollment({
    clientId,
    codeHash,
    installationId,
    publicKeyJwk,
    consumedAt,
  } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedHash = sha256Hash(codeHash);
    const normalizedInstallationId = requiredString(installationId, 'installationId');
    const publicKeyJson = json(publicKeyJwk, 'publicKeyJwk');
    const at = requiredIsoTime(consumedAt, 'consumedAt');

    return this.#transaction(() => {
      const enrollment = this.db.prepare(`
        SELECT id, browser_profile, tab_group, business_center_id, seller_mode,
               page_type, created_at, expires_at,
               consumed_at, invalidated_at
        FROM telemetry_enrollments
        WHERE client_id = ? AND code_hash = ?
      `).get(normalizedClientId, normalizedHash);
      if (
        !enrollment ||
        enrollment.consumed_at !== null ||
        enrollment.invalidated_at !== null ||
        Date.parse(at) < Date.parse(enrollment.created_at) ||
        Date.parse(at) >= Date.parse(enrollment.expires_at)
      ) {
        throw new DomainError(
          'TELEMETRY_ENROLLMENT_INVALID',
          'Telemetry enrollment code is invalid or expired',
          { clientId: normalizedClientId },
        );
      }
      const consumed = this.db.prepare(`
        UPDATE telemetry_enrollments
        SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
          AND created_at <= ? AND expires_at > ?
      `).run(at, enrollment.id, at, at);
      if (consumed.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Telemetry enrollment changed concurrently');
      }

      const revoked = this.db.prepare(`
        UPDATE telemetry_credentials
        SET revoked_at = ?
        WHERE client_id = ? AND revoked_at IS NULL
      `).run(at, normalizedClientId);
      const credentialId = `tc_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO telemetry_credentials
          (credential_id, client_id, installation_id, public_key_jwk,
           browser_profile, tab_group, business_center_id, seller_mode,
           page_type, created_at, enrollment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        credentialId,
        normalizedClientId,
        normalizedInstallationId,
        publicKeyJson,
        enrollment.browser_profile,
        enrollment.tab_group,
        enrollment.business_center_id,
        enrollment.seller_mode,
        enrollment.page_type,
        at,
        enrollment.id,
      );
      this.#insertAudit({
        eventType: 'TELEMETRY_CREDENTIAL_ENROLLED',
        actorType: 'CHROME_EXTENSION',
        actorId: credentialId,
        occurredAt: at,
        details: {
          enrollmentId: enrollment.id,
          clientId: normalizedClientId,
          installationId: normalizedInstallationId,
          replacedCredentialCount: Number(revoked.changes),
        },
      });
      return this.getTelemetryCredential(credentialId);
    });
  }

  #mapTelemetrySnapshot(row) {
    return Object.freeze({
      snapshotId: row.snapshot_id,
      clientId: row.client_id,
      advertiserId: row.advertiser_id,
      businessCenterId: row.business_center_id,
      sellerMode: row.seller_mode,
      pageType: row.page_type,
      tiktokAccountId: row.tiktok_account_id,
      campaignId: row.campaign_id,
      campaignRef: row.campaign_ref,
      campaignName: row.campaign_name,
      campaignType: row.campaign_type,
      campaignStatus: row.campaign_status,
      currency: row.currency,
      schemaVersion: row.schema_version,
      uiSchemaFingerprint: row.ui_schema_fingerprint,
      dailyBudgetMinor: row.daily_budget_minor,
      totalBudgetMinor: row.total_budget_minor,
      costMinor: row.cost_minor,
      netCostMinor: row.net_cost_minor,
      grossRevenueMinor: row.gross_revenue_minor,
      grossRoiMilli: row.gross_roi_milli,
      netRevenueMinor: row.net_revenue_minor,
      netRoiMilli: row.net_roi_milli,
      gmvMinor: row.gmv_minor,
      observedAt: row.observed_at,
      receivedAt: row.received_at,
      source: Object.freeze({
        browserProfile: row.source_browser_profile,
        tabGroup: row.source_tab_group,
      }),
      policy: Object.freeze({
        maxDailyBudgetMinor: row.policy_cap_minor,
        overDailyBudgetCap: row.over_policy_cap === 1,
      }),
    });
  }

  #telemetrySnapshotSelect() {
    return `
      SELECT snapshot_id, client_id, advertiser_id, business_center_id,
             seller_mode, page_type, tiktok_account_id, campaign_id,
             campaign_ref, campaign_name, campaign_type, campaign_status,
             currency, schema_version, ui_schema_fingerprint,
             daily_budget_minor, total_budget_minor, cost_minor, net_cost_minor,
             gross_revenue_minor, gross_roi_milli, net_revenue_minor,
             net_roi_milli, gmv_minor,
             policy_cap_minor, over_policy_cap, observed_at, received_at,
             source_browser_profile, source_tab_group
      FROM telemetry_snapshots
    `;
  }

  getTelemetrySnapshot(snapshotId) {
    const row = this.db.prepare(`${this.#telemetrySnapshotSelect()} WHERE snapshot_id = ?`)
      .get(requiredString(snapshotId, 'snapshotId'));
    return row ? this.#mapTelemetrySnapshot(row) : null;
  }

  isTelemetrySnapshotCredentialActive(snapshotId) {
    const row = this.db.prepare(`
      SELECT c.revoked_at
      FROM telemetry_snapshots s
      JOIN telemetry_credentials c ON c.credential_id = s.credential_id
      WHERE s.snapshot_id = ?
    `).get(requiredString(snapshotId, 'snapshotId'));
    return row ? row.revoked_at === null : null;
  }

  getLatestTelemetry({ clientId } = {}) {
    const row = this.db.prepare(`
      ${this.#telemetrySnapshotSelect()}
      WHERE snapshot_id = (
        SELECT snapshot_id FROM telemetry_latest WHERE client_id = ?
      )
    `).get(requiredString(clientId, 'clientId'));
    return row ? this.#mapTelemetrySnapshot(row) : null;
  }

  listLatestTelemetry({ clientId, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError('INVALID_REQUEST', 'limit must be an integer between 1 and 1000');
    }
    const where = clientId === undefined ? '' : 'WHERE l.client_id = ?';
    const parameters = clientId === undefined ? [] : [requiredString(clientId, 'clientId')];
    return this.db.prepare(`
      SELECT s.snapshot_id, s.client_id, s.advertiser_id, s.business_center_id,
             s.seller_mode, s.page_type, s.tiktok_account_id, s.campaign_id,
             s.campaign_ref, s.campaign_name, s.campaign_type, s.campaign_status,
             s.currency, s.schema_version, s.ui_schema_fingerprint,
             s.daily_budget_minor, s.total_budget_minor, s.cost_minor, s.net_cost_minor,
             s.gross_revenue_minor, s.gross_roi_milli, s.net_revenue_minor,
             s.net_roi_milli, s.gmv_minor,
             s.policy_cap_minor, s.over_policy_cap, s.observed_at, s.received_at,
             s.source_browser_profile, s.source_tab_group
      FROM telemetry_latest l
      JOIN telemetry_snapshots s ON s.snapshot_id = l.snapshot_id
      ${where}
      ORDER BY s.observed_at DESC, s.client_id ASC
      LIMIT ?
    `).all(...parameters, limit).map((row) => this.#mapTelemetrySnapshot(row));
  }

  listTelemetrySnapshots({ clientId, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError('INVALID_REQUEST', 'limit must be an integer between 1 and 1000');
    }
    const where = clientId === undefined ? '' : 'WHERE client_id = ?';
    const parameters = clientId === undefined ? [] : [requiredString(clientId, 'clientId')];
    return this.db.prepare(`
      ${this.#telemetrySnapshotSelect()}
      ${where}
      ORDER BY observed_at DESC, received_at DESC, snapshot_id DESC
      LIMIT ?
    `).all(...parameters, limit).map((row) => this.#mapTelemetrySnapshot(row));
  }

  getTelemetryAlertEvaluation(snapshotId) {
    const row = this.db.prepare(`
      SELECT snapshot_id, status, request_id, evaluated_at, details_json
      FROM telemetry_alert_evaluations
      WHERE snapshot_id = ?
    `).get(requiredString(snapshotId, 'snapshotId'));
    if (!row) return null;
    return Object.freeze({
      snapshotId: row.snapshot_id,
      status: row.status,
      requestId: row.request_id,
      evaluatedAt: row.evaluated_at,
      details: parseJson(row.details_json),
    });
  }

  recordTelemetryAlertEvaluation({ snapshotId, status, requestId = null, evaluatedAt, details = {} } = {}) {
    const normalizedSnapshotId = requiredString(snapshotId, 'snapshotId');
    const normalizedStatus = requiredString(status, 'status');
    const at = requiredIsoTime(evaluatedAt, 'evaluatedAt');
    return this.#transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO telemetry_alert_evaluations
          (snapshot_id, status, request_id, evaluated_at, details_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        normalizedSnapshotId,
        normalizedStatus,
        requestId === null ? null : requiredString(requestId, 'requestId'),
        at,
        json(details, 'details'),
      );
      return this.getTelemetryAlertEvaluation(normalizedSnapshotId);
    });
  }

  /**
   * Records a verified snapshot and one request nonce atomically. The latest
   * pointer advances only by observation time; an older collector retry is
   * retained for audit but cannot roll monitoring state backwards.
   */
  recordTelemetrySnapshot({
    snapshot,
    credentialId,
    nonce,
    payloadHash,
    receivedAt,
    pruneNoncesBefore,
  } = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new DomainError('INVALID_REQUEST', 'snapshot must be an object');
    }
    const normalizedCredentialId = requiredString(credentialId, 'credentialId');
    const normalizedNonce = requiredString(nonce, 'nonce');
    const normalizedHash = sha256Hash(payloadHash, 'payloadHash');
    const received = requiredIsoTime(receivedAt, 'receivedAt');
    const pruneBefore = requiredIsoTime(pruneNoncesBefore, 'pruneNoncesBefore');

    return this.#transaction(() => {
      const credential = this.getTelemetryCredential(normalizedCredentialId);
      if (!credential || credential.revokedAt !== null || credential.clientId !== snapshot.clientId) {
        throw new DomainError('TELEMETRY_CREDENTIAL_REVOKED', 'Telemetry credential is not active');
      }
      this.db.prepare('DELETE FROM telemetry_nonces WHERE received_at < ?').run(pruneBefore);
      const nonceResult = this.db.prepare(`
        INSERT OR IGNORE INTO telemetry_nonces (credential_id, nonce, received_at)
        VALUES (?, ?, ?)
      `).run(normalizedCredentialId, normalizedNonce, received);
      if (nonceResult.changes !== 1) {
        throw new DomainError('TELEMETRY_REPLAY', 'Telemetry nonce has already been used');
      }

      const existing = this.db.prepare(`
        SELECT payload_hash FROM telemetry_snapshots WHERE snapshot_id = ?
      `).get(requiredString(snapshot.snapshotId, 'snapshot.snapshotId'));
      if (existing) {
        if (existing.payload_hash !== normalizedHash) {
          throw new DomainError(
            'TELEMETRY_SNAPSHOT_CONFLICT',
            'snapshotId was already used for a different payload',
          );
        }
        return Object.freeze({
          accepted: true,
          duplicate: true,
          latest: this.getLatestTelemetry({ clientId: snapshot.clientId })?.snapshotId === snapshot.snapshotId,
          snapshot: this.getTelemetrySnapshot(snapshot.snapshotId),
        });
      }

      this.db.prepare(`
        INSERT INTO telemetry_snapshots
          (snapshot_id, credential_id, client_id, advertiser_id, business_center_id,
           seller_mode, page_type, tiktok_account_id, campaign_id, campaign_ref,
           campaign_name, campaign_type, campaign_status, currency,
           schema_version, ui_schema_fingerprint, daily_budget_minor,
           total_budget_minor, cost_minor, net_cost_minor, gross_revenue_minor,
           gross_roi_milli, net_revenue_minor, net_roi_milli, gmv_minor,
           policy_cap_minor, over_policy_cap, observed_at, received_at,
           source_browser_profile, source_tab_group, payload_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.snapshotId,
        normalizedCredentialId,
        snapshot.clientId,
        snapshot.advertiserId,
        snapshot.businessCenterId,
        snapshot.sellerMode,
        snapshot.pageType,
        snapshot.tiktokAccountId,
        snapshot.campaignId,
        snapshot.campaignRef,
        snapshot.campaignName,
        snapshot.campaignType,
        snapshot.campaignStatus,
        snapshot.currency,
        snapshot.schemaVersion,
        snapshot.uiSchemaFingerprint,
        safeMinor(snapshot.dailyBudgetMinor, 'snapshot.dailyBudgetMinor', { positive: true }),
        safeMinor(snapshot.totalBudgetMinor, 'snapshot.totalBudgetMinor', { positive: true }),
        safeMinor(snapshot.costMinor, 'snapshot.costMinor'),
        safeMinor(snapshot.netCostMinor, 'snapshot.netCostMinor'),
        snapshot.grossRevenueMinor == null ? null : safeMinor(snapshot.grossRevenueMinor, 'snapshot.grossRevenueMinor'),
        snapshot.grossRoiMilli == null ? null : safeMinor(snapshot.grossRoiMilli, 'snapshot.grossRoiMilli'),
        snapshot.netRevenueMinor == null ? null : safeMinor(snapshot.netRevenueMinor, 'snapshot.netRevenueMinor'),
        snapshot.netRoiMilli == null ? null : safeMinor(snapshot.netRoiMilli, 'snapshot.netRoiMilli'),
        snapshot.gmvMinor == null ? null : safeMinor(snapshot.gmvMinor, 'snapshot.gmvMinor'),
        safeMinor(snapshot.policy?.maxDailyBudgetMinor, 'snapshot.policy.maxDailyBudgetMinor', { positive: true }),
        snapshot.policy?.overDailyBudgetCap === true ? 1 : 0,
        requiredIsoTime(snapshot.observedAt, 'snapshot.observedAt'),
        received,
        requiredString(snapshot.source?.browserProfile, 'snapshot.source.browserProfile'),
        requiredString(snapshot.source?.tabGroup, 'snapshot.source.tabGroup'),
        normalizedHash,
      );

      this.db.prepare(`
        INSERT INTO telemetry_latest (client_id, snapshot_id, observed_at, received_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          observed_at = excluded.observed_at,
          received_at = excluded.received_at
        WHERE excluded.observed_at > telemetry_latest.observed_at
           OR (
             excluded.observed_at = telemetry_latest.observed_at
             AND excluded.received_at > telemetry_latest.received_at
           )
      `).run(snapshot.clientId, snapshot.snapshotId, snapshot.observedAt, received);
      const isLatest = this.getLatestTelemetry({ clientId: snapshot.clientId })?.snapshotId === snapshot.snapshotId;
      this.#insertAudit({
        eventType: isLatest ? 'CHROME_TELEMETRY_ACCEPTED' : 'CHROME_TELEMETRY_OLDER_ACCEPTED',
        actorType: 'CHROME_EXTENSION',
        actorId: normalizedCredentialId,
        occurredAt: received,
        details: {
          snapshotId: snapshot.snapshotId,
          clientId: snapshot.clientId,
          advertiserId: snapshot.advertiserId,
          businessCenterId: snapshot.businessCenterId,
          campaignId: snapshot.campaignId,
          campaignRef: snapshot.campaignRef,
          dailyBudgetMinor: snapshot.dailyBudgetMinor,
          totalBudgetMinor: snapshot.totalBudgetMinor,
          costMinor: snapshot.costMinor,
          netCostMinor: snapshot.netCostMinor,
          grossRevenueMinor: snapshot.grossRevenueMinor ?? null,
          grossRoiMilli: snapshot.grossRoiMilli ?? null,
          netRevenueMinor: snapshot.netRevenueMinor ?? null,
          netRoiMilli: snapshot.netRoiMilli ?? null,
          gmvMinor: snapshot.gmvMinor ?? null,
          observedAt: snapshot.observedAt,
          latest: isLatest,
        },
      });
      return Object.freeze({
        accepted: true,
        duplicate: false,
        latest: isLatest,
        snapshot: this.getTelemetrySnapshot(snapshot.snapshotId),
      });
    });
  }

  #mapExecutionJob(row) {
    return Object.freeze({
      requestId: row.request_id,
      actorLineUserId: row.actor_line_user_id,
      status: row.status,
      createdAt: row.created_at,
      availableAt: row.available_at,
      completedAt: row.completed_at,
      attemptCount: row.attempt_count,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      lastAttemptAt: row.last_attempt_at,
      error: parseJson(row.error_json),
    });
  }

  getExecutionJob(requestId) {
    const row = this.db.prepare(`
      SELECT request_id, actor_line_user_id, status, created_at, available_at,
             completed_at, attempt_count, lease_token, lease_expires_at,
             last_attempt_at, error_json
      FROM execution_jobs
      WHERE request_id = ?
    `).get(requiredString(requestId, 'requestId'));
    return row ? this.#mapExecutionJob(row) : null;
  }

  /**
   * Add one durable execution job per budget request. Repeating the call is an
   * idempotent read of the first job and never changes its actor or schedule.
   */
  enqueueExecutionJob({ requestId, actorLineUserId, createdAt } = {}) {
    const normalizedRequestId = requiredString(requestId, 'requestId');
    const normalizedActor = requiredString(actorLineUserId, 'actorLineUserId');
    const at = isoTime(createdAt, 'createdAt');
    return this.#transaction(() => {
      const existing = this.getExecutionJob(normalizedRequestId);
      if (existing) return { enqueued: false, job: existing };

      const request = this.requireBudgetRequest(normalizedRequestId);
      if (
        request.metadata?.telemetryOnly === true
        || request.metadata?.executionMode === 'APPROVAL_ONLY'
      ) {
        throw new DomainError(
          'TELEMETRY_ONLY_REQUEST',
          'Telemetry approval-only requests cannot be queued for execution',
          { requestId: normalizedRequestId },
        );
      }
      if (!request.authorizedLineUserIds.includes(normalizedActor)) {
        throw new DomainError(
          'UNAUTHORIZED_APPROVER',
          'LINE user is not authorized for this budget request',
          { requestId: normalizedRequestId },
        );
      }
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO execution_jobs
          (request_id, actor_line_user_id, status, created_at, available_at)
        VALUES (?, ?, 'PENDING', ?, ?)
      `).run(normalizedRequestId, normalizedActor, at, at);
      if (result.changes !== 1) {
        // BEGIN IMMEDIATE serializes writers, but retaining this branch makes
        // the method safe if SQLite locking semantics are changed later.
        return { enqueued: false, job: this.getExecutionJob(normalizedRequestId) };
      }
      this.#insertAudit({
        requestId: normalizedRequestId,
        eventType: 'EXECUTION_JOB_ENQUEUED',
        actorType: 'LINE_USER',
        actorId: normalizedActor,
        occurredAt: at,
        details: { availableAt: at },
      });
      return { enqueued: true, job: this.getExecutionJob(normalizedRequestId) };
    });
  }

  #claimExecutionJobInTransaction(requestId, claimedAt, leaseDurationMs) {
    const current = this.getExecutionJob(requestId);
    if (!current) {
      throw new DomainError('EXECUTION_JOB_NOT_FOUND', 'Execution job was not found', { requestId });
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseDurationMs).toISOString();
    const result = this.db.prepare(`
      UPDATE execution_jobs
      SET status = 'PROCESSING',
          attempt_count = attempt_count + 1,
          lease_token = ?,
          lease_expires_at = ?,
          last_attempt_at = ?
      WHERE request_id = ?
        AND (
          (status = 'PENDING' AND available_at <= ?)
          OR (status = 'PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
    `).run(leaseToken, leaseExpiresAt, claimedAt, requestId, claimedAt, claimedAt);
    if (result.changes !== 1) {
      throw new DomainError('CONCURRENT_MODIFICATION', 'Execution job changed concurrently', {
        requestId,
      });
    }

    const job = this.getExecutionJob(requestId);
    this.#insertAudit({
      requestId,
      eventType: current.status === 'PROCESSING'
        ? 'EXECUTION_JOB_LEASE_RECLAIMED'
        : current.attemptCount > 0
          ? 'EXECUTION_JOB_RETRY_CLAIMED'
          : 'EXECUTION_JOB_CLAIMED',
      actorType: 'SYSTEM',
      occurredAt: claimedAt,
      details: {
        attemptCount: job.attemptCount,
        leaseExpiresAt,
        priorStatus: current.status,
        priorLeaseExpiresAt: current.leaseExpiresAt,
      },
    });
    return { claimed: true, job };
  }

  /**
   * Claim the oldest available job with a unique fencing token. An abandoned
   * PROCESSING job becomes eligible as soon as its lease expires.
   */
  claimNextExecutionJob({ claimedAt, leaseDurationMs } = {}) {
    const at = isoTime(claimedAt, 'claimedAt');
    const duration = leaseDuration(leaseDurationMs);
    return this.#transaction(() => {
      const row = this.db.prepare(`
        SELECT request_id
        FROM execution_jobs
        WHERE (status = 'PENDING' AND available_at <= ?)
           OR (status = 'PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        ORDER BY
          CASE WHEN status = 'PROCESSING' THEN lease_expires_at ELSE available_at END ASC,
          created_at ASC,
          request_id ASC
        LIMIT 1
      `).get(at, at);
      if (!row) return null;
      return this.#claimExecutionJobInTransaction(row.request_id, at, duration);
    });
  }

  #requireActiveExecutionLease({ requestId, leaseToken, at, action }) {
    const job = this.getExecutionJob(requestId);
    if (!job) {
      throw new DomainError('EXECUTION_JOB_NOT_FOUND', 'Execution job was not found', { requestId });
    }
    if (job.status === 'COMPLETED') {
      throw new DomainError('EXECUTION_JOB_ALREADY_COMPLETED', 'Execution job is already completed', {
        requestId,
      });
    }
    if (job.status !== 'PROCESSING') {
      throw new DomainError('EXECUTION_JOB_NOT_PROCESSING', `Execution job cannot be ${action}`, {
        requestId,
        status: job.status,
      });
    }
    if (job.leaseToken !== leaseToken) {
      throw new DomainError(
        'EXECUTION_JOB_LEASE_MISMATCH',
        'Execution job lease belongs to another worker',
        { requestId },
      );
    }
    if (job.leaseExpiresAt === null || Date.parse(job.leaseExpiresAt) <= Date.parse(at)) {
      throw new DomainError('EXECUTION_JOB_LEASE_EXPIRED', 'Execution job lease has expired', {
        requestId,
        leaseExpiresAt: job.leaseExpiresAt,
        at,
      });
    }
    return job;
  }

  /** Complete a job only while holding its current, unexpired fencing token. */
  completeExecutionJob({ requestId, leaseToken, completedAt } = {}) {
    const normalizedRequestId = requiredString(requestId, 'requestId');
    const normalizedLeaseToken = requiredString(leaseToken, 'leaseToken');
    const at = isoTime(completedAt, 'completedAt');
    return this.#transaction(() => {
      const current = this.#requireActiveExecutionLease({
        requestId: normalizedRequestId,
        leaseToken: normalizedLeaseToken,
        at,
        action: 'completed',
      });
      const result = this.db.prepare(`
        UPDATE execution_jobs
        SET status = 'COMPLETED', completed_at = ?, lease_token = NULL,
            lease_expires_at = NULL, error_json = NULL
        WHERE request_id = ? AND status = 'PROCESSING'
          AND lease_token = ? AND lease_expires_at > ?
      `).run(at, normalizedRequestId, normalizedLeaseToken, at);
      if (result.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Execution job changed concurrently', {
          requestId: normalizedRequestId,
        });
      }
      this.#insertAudit({
        requestId: normalizedRequestId,
        eventType: 'EXECUTION_JOB_COMPLETED',
        actorType: 'SYSTEM',
        occurredAt: at,
        details: { attemptCount: current.attemptCount },
      });
      return this.getExecutionJob(normalizedRequestId);
    });
  }

  /**
   * Release a failed attempt back to PENDING with an explicit retry time. The
   * current unexpired lease token is required, fencing stale workers out.
   */
  releaseExecutionJob({
    requestId,
    leaseToken,
    availableAt,
    error = null,
    releasedAt,
  } = {}) {
    const normalizedRequestId = requiredString(requestId, 'requestId');
    const normalizedLeaseToken = requiredString(leaseToken, 'leaseToken');
    const retryAt = isoTime(availableAt, 'availableAt');
    const at = isoTime(releasedAt, 'releasedAt');
    const errorJson = json(error, 'error');
    return this.#transaction(() => {
      const current = this.#requireActiveExecutionLease({
        requestId: normalizedRequestId,
        leaseToken: normalizedLeaseToken,
        at,
        action: 'released',
      });
      const result = this.db.prepare(`
        UPDATE execution_jobs
        SET status = 'PENDING', available_at = ?, lease_token = NULL,
            lease_expires_at = NULL, error_json = ?
        WHERE request_id = ? AND status = 'PROCESSING'
          AND lease_token = ? AND lease_expires_at > ?
      `).run(retryAt, errorJson, normalizedRequestId, normalizedLeaseToken, at);
      if (result.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Execution job changed concurrently', {
          requestId: normalizedRequestId,
        });
      }
      this.#insertAudit({
        requestId: normalizedRequestId,
        eventType: 'EXECUTION_JOB_RETRY_SCHEDULED',
        actorType: 'SYSTEM',
        occurredAt: at,
        details: { attemptCount: current.attemptCount, availableAt: retryAt, error },
      });
      return this.getExecutionJob(normalizedRequestId);
    });
  }

  /** Alias for callers that describe releasing a failed attempt as retrying. */
  retryExecutionJob(input) {
    return this.releaseExecutionJob(input);
  }

  /**
   * Durably records the first sanitized representation of an event. A replay
   * never overwrites that payload. Call claimWebhookEvent for both new events
   * and redeliveries; isNew alone is not a processing decision.
   */
  recordWebhookEvent({ provider, eventId, payload = {}, receivedAt } = {}) {
    const normalizedProvider = requiredString(provider, 'provider');
    const normalizedEventId = requiredString(eventId, 'eventId');
    const at = isoTime(receivedAt, 'receivedAt');
    const payloadJson = json(payload, 'payload');
    return this.#transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO webhook_events
          (provider, event_id, status, received_at, payload_json)
        VALUES (?, ?, 'RECEIVED', ?, ?)
      `).run(normalizedProvider, normalizedEventId, at, payloadJson);
      const isNew = result.changes === 1;
      this.#insertAudit({
        eventType: isNew ? 'WEBHOOK_RECEIVED' : 'WEBHOOK_REDELIVERY_RECEIVED',
        actorType: 'WEBHOOK',
        actorId: normalizedProvider,
        occurredAt: at,
        details: { provider: normalizedProvider, eventId: normalizedEventId },
      });
      return { isNew, event: this.getWebhookEvent(normalizedProvider, normalizedEventId) };
    });
  }

  hasWebhookEvent(provider, eventId) {
    const row = this.db.prepare(`
      SELECT 1 AS present FROM webhook_events WHERE provider = ? AND event_id = ?
    `).get(requiredString(provider, 'provider'), requiredString(eventId, 'eventId'));
    return Boolean(row);
  }

  getWebhookEvent(provider, eventId) {
    const row = this.db.prepare(`
      SELECT provider, event_id, status, received_at, processed_at, request_id, error_code,
             attempt_count, lease_token, lease_expires_at, last_attempt_at, payload_json
      FROM webhook_events WHERE provider = ? AND event_id = ?
    `).get(requiredString(provider, 'provider'), requiredString(eventId, 'eventId'));
    if (!row) return null;
    return Object.freeze({
      provider: row.provider,
      eventId: row.event_id,
      status: row.status,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      requestId: row.request_id,
      errorCode: row.error_code,
      attemptCount: row.attempt_count,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      lastAttemptAt: row.last_attempt_at,
      payload: parseJson(row.payload_json),
    });
  }

  #claimWebhookInTransaction(provider, eventId, claimedAt, leaseDurationMs) {
    const current = this.getWebhookEvent(provider, eventId);
    if (!current) {
      throw new DomainError('WEBHOOK_NOT_FOUND', 'Webhook event was not found', { provider, eventId });
    }
    if (current.status === 'PROCESSED') {
      return { claimed: false, reason: 'PROCESSED', event: current };
    }
    if (
      current.status === 'PROCESSING' &&
      current.leaseExpiresAt !== null &&
      Date.parse(current.leaseExpiresAt) > Date.parse(claimedAt)
    ) {
      return { claimed: false, reason: 'LEASE_ACTIVE', event: current };
    }
    const eligible = current.status === 'RECEIVED' ||
      current.status === 'FAILED' ||
      current.status === 'PROCESSING';
    if (!eligible) {
      throw new DomainError('INVALID_WEBHOOK_STATE', 'Webhook event cannot be claimed', {
        provider,
        eventId,
        status: current.status,
      });
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseDurationMs).toISOString();
    const result = this.db.prepare(`
      UPDATE webhook_events
      SET status = 'PROCESSING',
          attempt_count = attempt_count + 1,
          lease_token = ?,
          lease_expires_at = ?,
          last_attempt_at = ?,
          processed_at = NULL,
          error_code = NULL
      WHERE provider = ? AND event_id = ?
        AND (
          status IN ('RECEIVED', 'FAILED')
          OR (status = 'PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
    `).run(leaseToken, leaseExpiresAt, claimedAt, provider, eventId, claimedAt);
    if (result.changes !== 1) {
      throw new DomainError('CONCURRENT_MODIFICATION', 'Webhook event changed concurrently', {
        provider,
        eventId,
      });
    }

    const event = this.getWebhookEvent(provider, eventId);
    const eventType = current.status === 'FAILED'
      ? 'WEBHOOK_RETRY_CLAIMED'
      : current.status === 'PROCESSING'
        ? 'WEBHOOK_LEASE_RECLAIMED'
        : 'WEBHOOK_CLAIMED';
    this.#insertAudit({
      requestId: current.requestId,
      eventType,
      actorType: 'SYSTEM',
      occurredAt: claimedAt,
      details: {
        provider,
        eventId,
        attemptCount: event.attemptCount,
        leaseExpiresAt,
        priorStatus: current.status,
        priorLeaseExpiresAt: current.leaseExpiresAt,
      },
    });
    return {
      claimed: true,
      reason: null,
      event,
      priorStatus: current.status,
      priorErrorCode: current.errorCode,
    };
  }

  /**
   * Atomically acquires a fenced processing lease. FAILED events and abandoned
   * PROCESSING events become claimable again; PROCESSED and active leases do not.
   */
  claimWebhookEvent({ provider, eventId, claimedAt, leaseDurationMs } = {}) {
    const normalizedProvider = requiredString(provider, 'provider');
    const normalizedEventId = requiredString(eventId, 'eventId');
    const at = isoTime(claimedAt, 'claimedAt');
    const duration = leaseDuration(leaseDurationMs);
    return this.#transaction(() => this.#claimWebhookInTransaction(
      normalizedProvider,
      normalizedEventId,
      at,
      duration,
    ));
  }

  /** Claim the oldest recoverable event, useful for startup/background recovery. */
  claimNextWebhookEvent({ provider, claimedAt, leaseDurationMs, excludeEventIds = [] } = {}) {
    const normalizedProvider = provider === undefined ? null : requiredString(provider, 'provider');
    const at = isoTime(claimedAt, 'claimedAt');
    const duration = leaseDuration(leaseDurationMs);
    if (!Array.isArray(excludeEventIds) || excludeEventIds.length > 1000) {
      throw new DomainError('INVALID_REQUEST', 'excludeEventIds must be an array with at most 1000 entries');
    }
    const excluded = [...new Set(excludeEventIds.map((eventId) => requiredString(eventId, 'excludeEventIds')))].slice(0, 1000);
    const exclusionSql = excluded.length
      ? `AND event_id NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    return this.#transaction(() => {
      const row = this.db.prepare(`
        SELECT provider, event_id
        FROM webhook_events
        WHERE (? IS NULL OR provider = ?)
          AND (
            status IN ('RECEIVED', 'FAILED')
            OR (status = 'PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )
          ${exclusionSql}
        ORDER BY
          CASE WHEN status = 'RECEIVED' THEN 0 ELSE 1 END ASC,
          attempt_count ASC,
          COALESCE(last_attempt_at, received_at) ASC,
          received_at ASC,
          provider ASC,
          event_id ASC
        LIMIT 1
      `).get(normalizedProvider, normalizedProvider, at, ...excluded);
      if (!row) return null;
      return this.#claimWebhookInTransaction(row.provider, row.event_id, at, duration);
    });
  }

  /** Extend an active lease without changing its fencing token or attempt. */
  renewWebhookLease({ provider, eventId, leaseToken, renewedAt, leaseDurationMs } = {}) {
    const normalizedProvider = requiredString(provider, 'provider');
    const normalizedEventId = requiredString(eventId, 'eventId');
    const normalizedLeaseToken = requiredString(leaseToken, 'leaseToken');
    const at = isoTime(renewedAt, 'renewedAt');
    const duration = leaseDuration(leaseDurationMs);
    const leaseExpiresAt = new Date(Date.parse(at) + duration).toISOString();
    return this.#transaction(() => {
      const current = this.getWebhookEvent(normalizedProvider, normalizedEventId);
      if (!current) {
        throw new DomainError('WEBHOOK_NOT_FOUND', 'Webhook event was not found', {
          provider: normalizedProvider,
          eventId: normalizedEventId,
        });
      }
      if (current.status !== 'PROCESSING') {
        throw new DomainError('WEBHOOK_NOT_PROCESSING', 'Webhook event is not being processed', {
          status: current.status,
        });
      }
      if (current.leaseToken !== normalizedLeaseToken) {
        throw new DomainError('WEBHOOK_LEASE_MISMATCH', 'Webhook processing lease belongs to another worker');
      }
      if (current.leaseExpiresAt === null || Date.parse(current.leaseExpiresAt) <= Date.parse(at)) {
        throw new DomainError('WEBHOOK_LEASE_EXPIRED', 'Webhook processing lease has expired');
      }
      const result = this.db.prepare(`
        UPDATE webhook_events
        SET lease_expires_at = ?
        WHERE provider = ? AND event_id = ? AND status = 'PROCESSING'
          AND lease_token = ? AND lease_expires_at > ?
      `).run(
        leaseExpiresAt,
        normalizedProvider,
        normalizedEventId,
        normalizedLeaseToken,
        at,
      );
      if (result.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Webhook lease changed concurrently');
      }
      this.#insertAudit({
        requestId: current.requestId,
        eventType: 'WEBHOOK_LEASE_RENEWED',
        actorType: 'SYSTEM',
        occurredAt: at,
        details: {
          provider: normalizedProvider,
          eventId: normalizedEventId,
          attemptCount: current.attemptCount,
          leaseExpiresAt,
        },
      });
      return this.getWebhookEvent(normalizedProvider, normalizedEventId);
    });
  }

  /** A matching, unexpired PROCESSING lease is required to finish an attempt. */
  markWebhookEvent({
    provider,
    eventId,
    status,
    leaseToken,
    requestId = null,
    errorCode = null,
    processedAt,
  } = {}) {
    const normalizedStatus = requiredString(status, 'status');
    if (!WEBHOOK_STATUSES.has(normalizedStatus) || !['PROCESSED', 'FAILED'].includes(normalizedStatus)) {
      throw new DomainError('INVALID_REQUEST', 'status must be PROCESSED or FAILED');
    }
    const normalizedProvider = requiredString(provider, 'provider');
    const normalizedEventId = requiredString(eventId, 'eventId');
    const normalizedLeaseToken = requiredString(leaseToken, 'leaseToken');
    const at = isoTime(processedAt, 'processedAt');
    return this.#transaction(() => {
      const current = this.getWebhookEvent(normalizedProvider, normalizedEventId);
      if (!current) {
        throw new DomainError('WEBHOOK_NOT_FOUND', 'Webhook event was not found', {
          provider: normalizedProvider,
          eventId: normalizedEventId,
        });
      }
      if (current.status !== 'PROCESSING') {
        const code = current.status === 'PROCESSED' ? 'WEBHOOK_ALREADY_PROCESSED' : 'WEBHOOK_NOT_PROCESSING';
        throw new DomainError(code, 'Webhook event is not in PROCESSING state', {
          provider: normalizedProvider,
          eventId: normalizedEventId,
          status: current.status,
        });
      }
      if (current.leaseToken !== normalizedLeaseToken) {
        throw new DomainError('WEBHOOK_LEASE_MISMATCH', 'Webhook processing lease belongs to another worker');
      }
      if (current.leaseExpiresAt === null || Date.parse(current.leaseExpiresAt) <= Date.parse(at)) {
        throw new DomainError('WEBHOOK_LEASE_EXPIRED', 'Webhook processing lease has expired', {
          leaseExpiresAt: current.leaseExpiresAt,
          processedAt: at,
        });
      }
      const linkedRequestId = requestId ?? current.requestId;
      const result = this.db.prepare(`
        UPDATE webhook_events
        SET status = ?, processed_at = ?, request_id = ?, error_code = ?,
            lease_token = NULL, lease_expires_at = NULL
        WHERE provider = ? AND event_id = ? AND status = 'PROCESSING'
          AND lease_token = ? AND lease_expires_at > ?
      `).run(
        normalizedStatus,
        at,
        linkedRequestId,
        normalizedStatus === 'FAILED' ? errorCode : null,
        normalizedProvider,
        normalizedEventId,
        normalizedLeaseToken,
        at,
      );
      if (result.changes !== 1) throw new DomainError('CONCURRENT_MODIFICATION', 'Webhook changed concurrently');
      this.#insertAudit({
        requestId: linkedRequestId,
        eventType: normalizedStatus === 'PROCESSED' ? 'WEBHOOK_PROCESSED' : 'WEBHOOK_FAILED',
        actorType: 'SYSTEM',
        occurredAt: at,
        details: {
          provider: normalizedProvider,
          eventId: normalizedEventId,
          errorCode: normalizedStatus === 'FAILED' ? errorCode : null,
          attemptCount: current.attemptCount,
        },
      });
      return this.getWebhookEvent(normalizedProvider, normalizedEventId);
    });
  }

  #mapCampaignShortcut(row) {
    return Object.freeze({
      clientId: row.client_id,
      shortcutName: row.shortcut_name,
      revision: row.revision,
      campaignNameTemplate: row.campaign_name_template,
      dailyBudgetMinor: row.daily_budget_minor,
      targetRoiMilli: row.target_roi_milli,
      topUpThresholdBps: row.top_up_threshold_bps,
      createdAt: row.created_at,
      createdByLineUserId: row.created_by_line_user_id,
    });
  }

  saveCampaignShortcut({
    clientId,
    shortcutName,
    campaignNameTemplate,
    dailyBudgetMinor,
    targetRoiMilli,
    topUpThresholdBps,
    lineUserId,
    createdAt,
  } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedName = requiredString(shortcutName, 'shortcutName');
    const normalizedTemplate = requiredString(campaignNameTemplate, 'campaignNameTemplate');
    const normalizedUserId = requiredString(lineUserId, 'lineUserId');
    const at = requiredIsoTime(createdAt, 'createdAt');
    const budget = safeMinor(dailyBudgetMinor, 'dailyBudgetMinor', { positive: true });
    const roi = safeMinor(targetRoiMilli, 'targetRoiMilli', { positive: true });
    const threshold = safeMinor(topUpThresholdBps, 'topUpThresholdBps', { positive: true });
    if (threshold >= 10_000) {
      throw new DomainError('INVALID_REQUEST', 'topUpThresholdBps must be below 10000');
    }
    return this.#transaction(() => {
      const current = this.db.prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM campaign_shortcuts
        WHERE client_id = ? AND shortcut_name = ?
      `).get(normalizedClientId, normalizedName);
      const revision = Number(current.revision) + 1;
      this.db.prepare(`
        INSERT INTO campaign_shortcuts
          (client_id, shortcut_name, revision, campaign_name_template,
           daily_budget_minor, target_roi_milli, top_up_threshold_bps,
           created_at, created_by_line_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedClientId,
        normalizedName,
        revision,
        normalizedTemplate,
        budget,
        roi,
        threshold,
        at,
        normalizedUserId,
      );
      this.#insertAudit({
        eventType: 'CAMPAIGN_SHORTCUT_SAVED',
        actorType: 'LINE_USER',
        actorId: normalizedUserId,
        occurredAt: at,
        details: {
          clientId: normalizedClientId,
          shortcutName: normalizedName,
          revision,
          dailyBudgetMinor: budget,
          targetRoiMilli: roi,
          topUpThresholdBps: threshold,
        },
      });
      return this.getCampaignShortcut({ clientId: normalizedClientId, shortcutName: normalizedName });
    });
  }

  getCampaignShortcut({ clientId, shortcutName } = {}) {
    const row = this.db.prepare(`
      SELECT client_id, shortcut_name, revision, campaign_name_template,
             daily_budget_minor, target_roi_milli, top_up_threshold_bps,
             created_at, created_by_line_user_id
      FROM campaign_shortcuts
      WHERE client_id = ? AND shortcut_name = ?
      ORDER BY revision DESC
      LIMIT 1
    `).get(requiredString(clientId, 'clientId'), requiredString(shortcutName, 'shortcutName'));
    return row ? this.#mapCampaignShortcut(row) : null;
  }

  listCampaignShortcuts({ clientId } = {}) {
    return this.db.prepare(`
      SELECT c.client_id, c.shortcut_name, c.revision, c.campaign_name_template,
             c.daily_budget_minor, c.target_roi_milli, c.top_up_threshold_bps,
             c.created_at, c.created_by_line_user_id
      FROM campaign_shortcuts c
      WHERE c.client_id = ?
        AND c.revision = (
          SELECT MAX(latest.revision)
          FROM campaign_shortcuts latest
          WHERE latest.client_id = c.client_id
            AND latest.shortcut_name = c.shortcut_name
        )
      ORDER BY c.shortcut_name ASC
    `).all(requiredString(clientId, 'clientId')).map((row) => this.#mapCampaignShortcut(row));
  }

  #mapReportSubscription(row) {
    return Object.freeze({
      clientId: row.client_id,
      lineUserId: row.line_user_id,
      intervalMinutes: row.interval_minutes,
      enabled: row.enabled === 1,
      nextDueAt: row.next_due_at,
      lastOccurrenceAt: row.last_occurrence_at,
      updatedAt: row.updated_at,
    });
  }

  setReportSubscription({ clientId, lineUserId, intervalMinutes, enabled = true, now } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedUserId = requiredString(lineUserId, 'lineUserId');
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 1440) {
      throw new DomainError('INVALID_REQUEST', 'intervalMinutes must be between 60 and 1440');
    }
    const at = requiredIsoTime(now, 'now');
    const nextDueAt = new Date(Date.parse(at) + intervalMinutes * 60_000).toISOString();
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO report_subscriptions
          (client_id, line_user_id, interval_minutes, enabled, next_due_at,
           last_occurrence_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(client_id, line_user_id) DO UPDATE SET
          interval_minutes = excluded.interval_minutes,
          enabled = excluded.enabled,
          next_due_at = excluded.next_due_at,
          updated_at = excluded.updated_at
      `).run(
        normalizedClientId,
        normalizedUserId,
        intervalMinutes,
        enabled ? 1 : 0,
        nextDueAt,
        at,
      );
      this.#insertAudit({
        eventType: enabled ? 'REPORT_SUBSCRIPTION_ENABLED' : 'REPORT_SUBSCRIPTION_DISABLED',
        actorType: 'LINE_USER',
        actorId: normalizedUserId,
        occurredAt: at,
        details: { clientId: normalizedClientId, intervalMinutes, nextDueAt },
      });
    });
    return this.getReportSubscription({ clientId: normalizedClientId, lineUserId: normalizedUserId });
  }

  getReportSubscription({ clientId, lineUserId } = {}) {
    const row = this.db.prepare(`
      SELECT client_id, line_user_id, interval_minutes, enabled, next_due_at,
             last_occurrence_at, updated_at
      FROM report_subscriptions
      WHERE client_id = ? AND line_user_id = ?
    `).get(requiredString(clientId, 'clientId'), requiredString(lineUserId, 'lineUserId'));
    return row ? this.#mapReportSubscription(row) : null;
  }

  disableReportSubscription({ clientId, lineUserId, now } = {}) {
    const existing = this.getReportSubscription({ clientId, lineUserId });
    if (!existing) return null;
    return this.setReportSubscription({
      clientId,
      lineUserId,
      intervalMinutes: existing.intervalMinutes,
      enabled: false,
      now,
    });
  }

  claimDueReportSubscriptions({ now, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError('INVALID_REQUEST', 'limit must be between 1 and 1000');
    }
    const at = requiredIsoTime(now, 'now');
    return this.db.prepare(`
      SELECT client_id, line_user_id, interval_minutes, enabled, next_due_at,
             last_occurrence_at, updated_at
      FROM report_subscriptions
      WHERE enabled = 1 AND next_due_at <= ?
      ORDER BY next_due_at ASC, client_id ASC, line_user_id ASC
      LIMIT ?
    `).all(at, limit).map((row) => Object.freeze({
      ...this.#mapReportSubscription(row),
      occurrenceAt: row.next_due_at,
    }));
  }

  completeReportOccurrence({ clientId, lineUserId, occurrenceAt, now } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedUserId = requiredString(lineUserId, 'lineUserId');
    const occurrence = requiredIsoTime(occurrenceAt, 'occurrenceAt');
    const at = requiredIsoTime(now, 'now');
    return this.#transaction(() => {
      const current = this.getReportSubscription({
        clientId: normalizedClientId,
        lineUserId: normalizedUserId,
      });
      if (!current || !current.enabled || current.nextDueAt !== occurrence) return current;
      let nextDueMilliseconds = Date.parse(occurrence) + current.intervalMinutes * 60_000;
      while (nextDueMilliseconds <= Date.parse(at)) {
        nextDueMilliseconds += current.intervalMinutes * 60_000;
      }
      const nextDueAt = new Date(nextDueMilliseconds).toISOString();
      const result = this.db.prepare(`
        UPDATE report_subscriptions
        SET next_due_at = ?, last_occurrence_at = ?, updated_at = ?
        WHERE client_id = ? AND line_user_id = ? AND next_due_at = ? AND enabled = 1
      `).run(
        nextDueAt,
        occurrence,
        at,
        normalizedClientId,
        normalizedUserId,
        occurrence,
      );
      if (result.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Report occurrence changed concurrently');
      }
      return this.getReportSubscription({
        clientId: normalizedClientId,
        lineUserId: normalizedUserId,
      });
    });
  }

  #mapControlRequest(row) {
    return Object.freeze({
      id: row.id,
      clientId: row.client_id,
      action: row.action,
      state: row.state,
      version: row.version,
      requestedByLineUserId: row.requested_by_line_user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
      data: Object.freeze(parseJson(row.data_json)),
    });
  }

  createCampaignControlRequest({
    id,
    clientId,
    action,
    requestedByLineUserId,
    createdAt,
    expiresAt,
    data,
  } = {}) {
    const normalizedId = requiredString(id, 'id');
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedAction = requiredString(action, 'action');
    const normalizedUserId = requiredString(requestedByLineUserId, 'requestedByLineUserId');
    const created = requiredIsoTime(createdAt, 'createdAt');
    const expires = requiredIsoTime(expiresAt, 'expiresAt');
    if (Date.parse(expires) <= Date.parse(created)) {
      throw new DomainError('INVALID_REQUEST', 'expiresAt must be later than createdAt');
    }
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO campaign_control_requests
          (id, client_id, action, state, version, requested_by_line_user_id,
           created_at, expires_at, updated_at, data_json)
        VALUES (?, ?, ?, 'PENDING_CONFIRMATION', 1, ?, ?, ?, ?, ?)
      `).run(
        normalizedId,
        normalizedClientId,
        normalizedAction,
        normalizedUserId,
        created,
        expires,
        created,
        json(data, 'data'),
      );
      this.#insertAudit({
        eventType: 'CAMPAIGN_CONTROL_REQUEST_CREATED',
        actorType: 'LINE_USER',
        actorId: normalizedUserId,
        occurredAt: created,
        details: { controlRequestId: normalizedId, clientId: normalizedClientId, action: normalizedAction },
      });
    });
    return this.getCampaignControlRequest(normalizedId);
  }

  getCampaignControlRequest(id) {
    const row = this.db.prepare(`
      SELECT id, client_id, action, state, version, requested_by_line_user_id,
             created_at, expires_at, updated_at, data_json
      FROM campaign_control_requests WHERE id = ?
    `).get(requiredString(id, 'id'));
    return row ? this.#mapControlRequest(row) : null;
  }

  #couponResolutionMatchesReplay(controlRequestId, version, outcome) {
    const rows = this.db.prepare(`
      SELECT details_json
      FROM audit_events
      WHERE event_type = 'CAMPAIGN_CONTROL_REQUEST_EXPIRED'
      ORDER BY sequence DESC
    `).all();
    for (const row of rows) {
      const details = parseJson(row.details_json);
      if (details?.controlRequestId !== controlRequestId) continue;
      return details.fromVersion === version && details.outcome === outcome;
    }
    return false;
  }

  transitionCampaignControlRequest({ id, version, lineUserId, outcome, now } = {}) {
    const normalizedId = requiredString(id, 'id');
    const normalizedUserId = requiredString(lineUserId, 'lineUserId');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new DomainError('INVALID_REQUEST', 'version must be a positive integer');
    }
    const at = requiredIsoTime(now, 'now');
    const targetState = outcome === 'confirm'
      ? 'CONFIRMED_DRY_RUN'
      : outcome === 'confirm_live'
        ? 'CONFIRMED'
        : outcome === 'reject'
          ? 'CANCELLED'
          : null;
    if (!targetState) throw new DomainError('INVALID_REQUEST', 'outcome is invalid');
    return this.#transaction(() => {
      const current = this.getCampaignControlRequest(normalizedId);
      if (!current) throw new DomainError('REQUEST_NOT_FOUND', 'Campaign control request was not found');
      if (current.state !== 'PENDING_CONFIRMATION') {
        throw new DomainError('INVALID_STATE', `Campaign control request is ${current.state}`);
      }
      if (current.version !== version) throw new DomainError('CONCURRENT_MODIFICATION', 'Request version changed');
      const expired = Date.parse(at) >= Date.parse(current.expiresAt);
      const nextState = expired ? 'EXPIRED' : targetState;
      const result = this.db.prepare(`
        UPDATE campaign_control_requests
        SET state = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND state = 'PENDING_CONFIRMATION' AND version = ?
      `).run(nextState, at, normalizedId, version);
      if (result.changes !== 1) throw new DomainError('CONCURRENT_MODIFICATION', 'Request changed concurrently');
      this.#insertAudit({
        eventType: expired ? 'CAMPAIGN_CONTROL_REQUEST_EXPIRED' : `CAMPAIGN_CONTROL_REQUEST_${nextState}`,
        actorType: 'LINE_USER',
        actorId: normalizedUserId,
        occurredAt: at,
        details: { controlRequestId: normalizedId, clientId: current.clientId, action: current.action },
      });
      return this.getCampaignControlRequest(normalizedId);
    });
  }

  #mapCouponSchedule(row) {
    return Object.freeze({
      id: row.id,
      controlRequestId: row.control_request_id,
      clientId: row.client_id,
      lineUserId: row.line_user_id,
      eventAt: row.event_at,
      notifyAt: row.notify_at,
      budgetMinor: row.budget_minor,
      status: row.status,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    });
  }

  #insertCouponSchedule({ controlRequestId, clientId, lineUserId, eventAt, notifyAt, budgetMinor, now }) {
    const normalizedControlRequestId = controlRequestId === null
      ? null
      : requiredString(controlRequestId, 'controlRequestId');
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedUserId = requiredString(lineUserId, 'lineUserId');
    const event = requiredIsoTime(eventAt, 'eventAt');
    const notify = requiredIsoTime(notifyAt, 'notifyAt');
    const at = requiredIsoTime(now, 'now');
    const budget = safeMinor(budgetMinor, 'budgetMinor', { positive: true });

    if (normalizedControlRequestId !== null) {
      const controlRequest = this.getCampaignControlRequest(normalizedControlRequestId);
      if (!controlRequest) {
        throw new DomainError(
          'REQUEST_NOT_FOUND',
          'Coupon control request was not found',
          { controlRequestId: normalizedControlRequestId },
        );
      }
      if (controlRequest.action !== 'SCHEDULE_COUPON_BOOST') {
        throw new DomainError(
          'INVALID_REQUEST',
          'Campaign control request is not a coupon boost schedule',
          { controlRequestId: normalizedControlRequestId, action: controlRequest.action },
        );
      }
      const desired = controlRequest.data?.desired;
      const matchesControl = controlRequest.clientId === normalizedClientId
        && controlRequest.requestedByLineUserId === normalizedUserId
        && requiredIsoTime(desired?.eventAt, 'controlRequest.data.desired.eventAt') === event
        && requiredIsoTime(desired?.notifyAt, 'controlRequest.data.desired.notifyAt') === notify
        && desired?.dailyBudgetMinor === budget;
      if (!matchesControl) {
        throw new DomainError(
          'COUPON_SCHEDULE_CONFLICT',
          'Coupon schedule does not match its control request',
          { controlRequestId: normalizedControlRequestId },
        );
      }
      const existing = this.getCouponScheduleByControlRequestId(normalizedControlRequestId);
      if (existing) {
        const identical = existing.clientId === normalizedClientId
          && existing.lineUserId === normalizedUserId
          && existing.eventAt === event
          && existing.notifyAt === notify
          && existing.budgetMinor === budget;
        if (!identical) {
          throw new DomainError(
            'COUPON_SCHEDULE_CONFLICT',
            'Coupon control request is already linked to a different schedule',
            { controlRequestId: normalizedControlRequestId, scheduleId: existing.id },
          );
        }
        return existing;
      }
    }

    if (Date.parse(notify) >= Date.parse(event) || Date.parse(notify) <= Date.parse(at)) {
      throw new DomainError('INVALID_REQUEST', 'Coupon notifyAt must be in the future and before eventAt');
    }

    // A linked schedule derives its primary key from the immutable control id.
    // Together with the unique FK this gives retries one stable one-to-one map.
    const id = normalizedControlRequestId === null
      ? `cs_${randomUUID()}`
      : `cs_${normalizedControlRequestId}`;
    this.db.prepare(`
      INSERT INTO coupon_schedules
        (id, control_request_id, client_id, line_user_id, event_at, notify_at,
         budget_minor, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)
    `).run(
      id,
      normalizedControlRequestId,
      normalizedClientId,
      normalizedUserId,
      event,
      notify,
      budget,
      at,
      at,
    );
    this.#insertAudit({
      eventType: 'COUPON_SCHEDULE_CREATED',
      actorType: 'LINE_USER',
      actorId: normalizedUserId,
      occurredAt: at,
      details: {
        scheduleId: id,
        controlRequestId: normalizedControlRequestId,
        clientId: normalizedClientId,
        eventAt: event,
        notifyAt: notify,
        budgetMinor: budget,
      },
    });
    return this.getCouponSchedule(id);
  }

  createCouponSchedule({
    controlRequestId = null,
    clientId,
    lineUserId,
    eventAt,
    notifyAt,
    budgetMinor,
    now,
  } = {}) {
    return this.#transaction(() => this.#insertCouponSchedule({
      controlRequestId,
      clientId,
      lineUserId,
      eventAt,
      notifyAt,
      budgetMinor,
      now,
    }));
  }

  getCouponSchedule(id) {
    const row = this.db.prepare(`
      SELECT id, control_request_id, client_id, line_user_id, event_at, notify_at,
             budget_minor, status, attempt_count, created_at, updated_at, last_error
      FROM coupon_schedules WHERE id = ?
    `).get(requiredString(id, 'id'));
    return row ? this.#mapCouponSchedule(row) : null;
  }

  getCouponScheduleByControlRequestId(controlRequestId) {
    const row = this.db.prepare(`
      SELECT id, control_request_id, client_id, line_user_id, event_at, notify_at,
             budget_minor, status, attempt_count, created_at, updated_at, last_error
      FROM coupon_schedules WHERE control_request_id = ?
    `).get(requiredString(controlRequestId, 'controlRequestId'));
    return row ? this.#mapCouponSchedule(row) : null;
  }

  /**
   * Resolves a coupon confirmation and creates its durable reminder as one
   * transaction. A retry carrying the original version/outcome returns the
   * already-resolved request and its one linked schedule without another write.
   */
  transitionCouponBoostControlRequest({ id, version, lineUserId, outcome, now } = {}) {
    const normalizedId = requiredString(id, 'id');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new DomainError('INVALID_REQUEST', 'version must be a positive integer');
    }
    const at = requiredIsoTime(now, 'now');
    const targetState = outcome === 'confirm'
      ? 'CONFIRMED_DRY_RUN'
      : outcome === 'confirm_live'
        ? 'CONFIRMED'
        : outcome === 'reject'
          ? 'CANCELLED'
          : outcome === 'expire'
            ? 'EXPIRED'
            : null;
    if (!targetState) throw new DomainError('INVALID_REQUEST', 'outcome is invalid');
    const normalizedUserId = outcome === 'expire'
      ? null
      : requiredString(lineUserId, 'lineUserId');

    return this.#transaction(() => {
      let current = this.getCampaignControlRequest(normalizedId);
      if (!current) throw new DomainError('REQUEST_NOT_FOUND', 'Campaign control request was not found');
      if (current.action !== 'SCHEDULE_COUPON_BOOST') {
        throw new DomainError(
          'INVALID_REQUEST',
          'Campaign control request is not a coupon boost schedule',
          { controlRequestId: normalizedId, action: current.action },
        );
      }

      // Idempotent postback/webhook replay. EXPIRED is also terminal when a
      // confirm/reject first arrived after its deadline.
      const replayedTerminalState = current.version === version + 1
        && (current.state === 'EXPIRED'
          ? this.#couponResolutionMatchesReplay(normalizedId, version, outcome)
          : current.state === targetState);
      if (replayedTerminalState) {
        let schedule = this.getCouponScheduleByControlRequestId(normalizedId);
        if (
          schedule === null
          && (current.state === 'CONFIRMED_DRY_RUN' || current.state === 'CONFIRMED')
        ) {
          const desired = current.data?.desired;
          schedule = this.#insertCouponSchedule({
            controlRequestId: current.id,
            clientId: current.clientId,
            lineUserId: current.requestedByLineUserId,
            eventAt: desired?.eventAt,
            notifyAt: desired?.notifyAt,
            budgetMinor: desired?.dailyBudgetMinor,
            now: current.updatedAt,
          });
        }
        return Object.freeze({ request: current, schedule });
      }

      if (current.state !== 'PENDING_CONFIRMATION') {
        throw new DomainError('INVALID_STATE', `Campaign control request is ${current.state}`);
      }
      if (current.version !== version) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Request version changed');
      }
      if (outcome === 'expire' && Date.parse(at) < Date.parse(current.expiresAt)) {
        throw new DomainError('INVALID_STATE', 'Campaign control request has not expired');
      }

      const expired = Date.parse(at) >= Date.parse(current.expiresAt);
      const nextState = expired ? 'EXPIRED' : targetState;
      const result = this.db.prepare(`
        UPDATE campaign_control_requests
        SET state = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND state = 'PENDING_CONFIRMATION' AND version = ?
      `).run(nextState, at, normalizedId, version);
      if (result.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Request changed concurrently');
      }
      this.#insertAudit({
        eventType: expired || outcome === 'expire'
          ? 'CAMPAIGN_CONTROL_REQUEST_EXPIRED'
          : `CAMPAIGN_CONTROL_REQUEST_${nextState}`,
        actorType: outcome === 'expire' ? 'SYSTEM' : 'LINE_USER',
        actorId: outcome === 'expire' ? null : normalizedUserId,
        occurredAt: at,
        details: {
          controlRequestId: normalizedId,
          clientId: current.clientId,
          action: current.action,
          outcome,
          fromVersion: version,
        },
      });

      current = this.getCampaignControlRequest(normalizedId);
      let schedule = null;
      if (current.state === 'CONFIRMED_DRY_RUN' || current.state === 'CONFIRMED') {
        const desired = current.data?.desired;
        schedule = this.#insertCouponSchedule({
          controlRequestId: current.id,
          clientId: current.clientId,
          lineUserId: current.requestedByLineUserId,
          eventAt: desired?.eventAt,
          notifyAt: desired?.notifyAt,
          budgetMinor: desired?.dailyBudgetMinor,
          now: at,
        });
      }
      return Object.freeze({ request: current, schedule });
    });
  }

  cancelPendingCouponSchedules({ clientId, lineUserId, now } = {}) {
    const normalizedClientId = requiredString(clientId, 'clientId');
    const normalizedUserId = requiredString(lineUserId, 'lineUserId');
    const at = requiredIsoTime(now, 'now');
    return this.#transaction(() => {
      const pending = this.db.prepare(`
        SELECT id, control_request_id
        FROM coupon_schedules
        WHERE client_id = ? AND line_user_id = ? AND status = 'PENDING'
        ORDER BY id ASC
      `).all(normalizedClientId, normalizedUserId);
      const result = this.db.prepare(`
        UPDATE coupon_schedules
        SET status = 'CANCELLED', updated_at = ?
        WHERE client_id = ? AND line_user_id = ? AND status = 'PENDING'
      `).run(at, normalizedClientId, normalizedUserId);
      if (Number(result.changes) !== pending.length) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Coupon schedules changed concurrently');
      }
      for (const schedule of pending) {
        this.#insertAudit({
          eventType: 'COUPON_SCHEDULE_CANCELLED',
          actorType: 'LINE_USER',
          actorId: normalizedUserId,
          occurredAt: at,
          details: {
            scheduleId: schedule.id,
            controlRequestId: schedule.control_request_id,
            clientId: normalizedClientId,
          },
        });
      }
      return pending.length;
    });
  }

  claimDueCouponSchedules({ now, limit = 20 } = {}) {
    const at = requiredIsoTime(now, 'now');
    const staleProcessingBefore = new Date(Date.parse(at) - 120_000).toISOString();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError('INVALID_REQUEST', 'limit must be between 1 and 100');
    }
    return this.#transaction(() => {
      const rows = this.db.prepare(`
        SELECT id, control_request_id, client_id, line_user_id, event_at,
               notify_at, budget_minor, status, attempt_count, created_at,
               updated_at, last_error
        FROM coupon_schedules
        WHERE notify_at <= ?
          AND (
            status = 'PENDING'
            OR (status = 'PROCESSING' AND updated_at <= ?)
          )
        ORDER BY notify_at ASC, id ASC
        LIMIT ?
      `).all(at, staleProcessingBefore, limit);
      const claimed = [];
      for (const row of rows) {
        const result = this.db.prepare(`
          UPDATE coupon_schedules
          SET status = 'PROCESSING', attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ?
            AND (
              status = 'PENDING'
              OR (status = 'PROCESSING' AND updated_at <= ?)
            )
        `).run(at, row.id, staleProcessingBefore);
        if (result.changes === 1) {
          const schedule = this.getCouponSchedule(row.id);
          this.#insertAudit({
            eventType: 'COUPON_SCHEDULE_CLAIMED',
            actorType: 'SYSTEM',
            occurredAt: at,
            details: {
              scheduleId: schedule.id,
              controlRequestId: schedule.controlRequestId,
              clientId: schedule.clientId,
              attemptCount: schedule.attemptCount,
              reclaimed: row.status === 'PROCESSING',
            },
          });
          claimed.push(schedule);
        }
      }
      return claimed;
    });
  }

  finishCouponSchedule({ id, ok, now, error = null } = {}) {
    const at = requiredIsoTime(now, 'now');
    return this.#transaction(() => {
      const current = this.getCouponSchedule(id);
      if (!current || current.status !== 'PROCESSING') return current;
      const retry = !ok && current.attemptCount < 3;
      const status = ok ? 'SENT' : retry ? 'PENDING' : 'FAILED';
      const notifyAt = retry ? new Date(Date.parse(at) + 60_000).toISOString() : current.notifyAt;
      const normalizedError = error == null ? null : String(error).slice(0, 500);
      const result = this.db.prepare(`
        UPDATE coupon_schedules
        SET status = ?, notify_at = ?, updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'PROCESSING'
      `).run(status, notifyAt, at, normalizedError, current.id);
      if (result.changes !== 1) {
        throw new DomainError('CONCURRENT_MODIFICATION', 'Coupon schedule changed concurrently');
      }
      this.#insertAudit({
        eventType: 'COUPON_SCHEDULE_FINISHED',
        actorType: 'SYSTEM',
        occurredAt: at,
        details: {
          scheduleId: current.id,
          controlRequestId: current.controlRequestId,
          clientId: current.clientId,
          status,
          retry,
          attemptCount: current.attemptCount,
          error: normalizedError,
        },
      });
      return this.getCouponSchedule(current.id);
    });
  }

  appendAuditEvent(input) {
    const sequence = this.#insertAudit(input);
    return this.getAuditEvent(sequence);
  }

  getAuditEvent(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new DomainError('INVALID_REQUEST', 'sequence must be a positive integer');
    }
    const row = this.db.prepare(`
      SELECT sequence, request_id, event_type, actor_type, actor_id, occurred_at, details_json
      FROM audit_events WHERE sequence = ?
    `).get(sequence);
    return row ? this.#mapAudit(row) : null;
  }

  #mapAudit(row) {
    return Object.freeze({
      sequence: row.sequence,
      requestId: row.request_id,
      eventType: row.event_type,
      actorType: row.actor_type,
      actorId: row.actor_id,
      occurredAt: row.occurred_at,
      details: parseJson(row.details_json),
    });
  }

  listAuditEvents({ requestId, eventType, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DomainError('INVALID_REQUEST', 'limit must be an integer between 1 and 1000');
    }
    const clauses = [];
    const parameters = [];
    if (requestId !== undefined) {
      clauses.push('request_id = ?');
      parameters.push(requiredString(requestId, 'requestId'));
    }
    if (eventType !== undefined) {
      clauses.push('event_type = ?');
      parameters.push(requiredString(eventType, 'eventType'));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT sequence, request_id, event_type, actor_type, actor_id, occurred_at, details_json
      FROM audit_events
      ${where}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(...parameters, limit).map((row) => this.#mapAudit(row));
  }
}

export default SqliteStore;
