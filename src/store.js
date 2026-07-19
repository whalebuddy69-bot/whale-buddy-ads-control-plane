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
    return { claimed: true, reason: null, event };
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
