import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DomainError, RequestState, createBudgetRequest } from '../src/domain.js';
import { SqliteStore } from '../src/store.js';

function request(id = 'store-request-1', overrides = {}) {
  return createBudgetRequest({
    id,
    agencyId: 'agency-1',
    clientId: 'client-1',
    adAccountId: 'advertiser-1',
    campaignId: 'campaign-1',
    authorizedLineUserIds: ['U-approver'],
    currentBudgetMinor: 1_000_000,
    maxBudgetMinor: 2_000_000,
    maxIncreaseMinor: 600_000,
    createdAt: '2026-07-18T10:00:00.000Z',
    expiresAt: '2026-07-18T10:15:00.000Z',
    ...overrides,
  });
}

function assertCode(code) {
  return (error) => error instanceof DomainError && error.code === code;
}

function pairingHash(code) {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

test('LINE pairing consumes once, authorizes per client, and never exposes pairing secrets', () => {
  const store = new SqliteStore();
  const code = 'WB-PAIR-482913';
  const codeHash = pairingHash(code);
  try {
    const created = store.createLinePairing({
      clientId: 'punpan_020',
      codeHash,
      createdAt: '2026-07-19T08:00:00.000Z',
      expiresAt: '2026-07-19T08:10:00.000Z',
    });
    assert.equal(created.created, true);
    assert.equal(created.clientId, 'punpan_020');
    assert.equal(created.invalidatedCount, 0);
    assert.equal('code' in created, false);
    assert.equal('codeHash' in created, false);
    assert.equal(store.isLineApprover({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
    }), false);

    const consumed = store.consumeLinePairing({
      clientId: 'punpan_020',
      codeHash,
      lineUserId: 'U-owner',
      consumedAt: '2026-07-19T08:01:00.000Z',
    });
    assert.equal(consumed.consumed, true);
    assert.equal(consumed.pairingId, created.pairingId);
    assert.deepEqual(consumed.approver, {
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      active: true,
      pairedAt: '2026-07-19T08:01:00.000Z',
      updatedAt: '2026-07-19T08:01:00.000Z',
    });
    assert(Object.isFrozen(consumed.approver));
    assert.deepEqual(store.listLineApprovers({ clientId: 'punpan_020' }), [consumed.approver]);
    assert.equal(store.isLineApprover({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
    }), true);
    assert.throws(() => store.consumeLinePairing({
      clientId: 'punpan_020',
      codeHash,
      lineUserId: 'U-attacker',
      consumedAt: '2026-07-19T08:02:00.000Z',
    }), assertCode('LINE_PAIRING_ALREADY_CONSUMED'));

    const audits = store.listAuditEvents().filter((event) => event.eventType.startsWith('LINE_'));
    assert.deepEqual(audits.map((event) => event.eventType), [
      'LINE_PAIRING_CREATED',
      'LINE_APPROVER_PAIRED',
    ]);
    const serializedAudits = JSON.stringify(audits);
    assert.equal(serializedAudits.includes(code), false);
    assert.equal(serializedAudits.includes(codeHash), false);
  } finally {
    store.close();
  }
});

test('LINE pairing rejects a wrong code and expires exactly at expiresAt', () => {
  const store = new SqliteStore();
  const correctHash = pairingHash('WB-PAIR-CORRECT');
  try {
    store.createLinePairing({
      clientId: 'punpan_020',
      codeHash: correctHash,
      createdAt: '2026-07-19T08:00:00.000Z',
      expiresAt: '2026-07-19T08:10:00.000Z',
    });
    assert.throws(() => store.consumeLinePairing({
      clientId: 'punpan_020',
      codeHash: pairingHash('WB-PAIR-WRONG'),
      lineUserId: 'U-owner',
      consumedAt: '2026-07-19T08:01:00.000Z',
    }), assertCode('LINE_PAIRING_NOT_FOUND'));
    assert.throws(() => store.consumeLinePairing({
      clientId: 'punpan_020',
      codeHash: correctHash,
      lineUserId: 'U-owner',
      consumedAt: '2026-07-19T08:10:00.000Z',
    }), assertCode('LINE_PAIRING_EXPIRED'));
    assert.equal(store.listLineApprovers({ clientId: 'punpan_020' }).length, 0);
  } finally {
    store.close();
  }
});

test('a newer LINE pairing invalidates the prior unused code', () => {
  const store = new SqliteStore();
  const oldHash = pairingHash('WB-PAIR-OLD');
  const newHash = pairingHash('WB-PAIR-NEW');
  try {
    store.createLinePairing({
      clientId: 'punpan_020',
      codeHash: oldHash,
      createdAt: '2026-07-19T08:00:00.000Z',
      expiresAt: '2026-07-19T08:10:00.000Z',
    });
    const replacement = store.createLinePairing({
      clientId: 'punpan_020',
      codeHash: newHash,
      createdAt: '2026-07-19T08:02:00.000Z',
      expiresAt: '2026-07-19T08:12:00.000Z',
    });
    assert.equal(replacement.invalidatedCount, 1);
    assert.throws(() => store.consumeLinePairing({
      clientId: 'punpan_020',
      codeHash: oldHash,
      lineUserId: 'U-owner',
      consumedAt: '2026-07-19T08:03:00.000Z',
    }), assertCode('LINE_PAIRING_INVALIDATED'));
    assert.equal(store.consumeLinePairing({
      clientId: 'punpan_020',
      codeHash: newHash,
      lineUserId: 'U-owner',
      consumedAt: '2026-07-19T08:03:00.000Z',
    }).consumed, true);
  } finally {
    store.close();
  }
});

test('LINE approver grants persist and the same user can approve multiple clients', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gmv-max-line-pairing-'));
  const filename = join(directory, 'pairing.sqlite');
  const first = new SqliteStore(filename);
  try {
    for (const [clientId, code, minute] of [
      ['punpan_020', 'WB-PAIR-CLIENT-1', '00'],
      ['another-client', 'WB-PAIR-CLIENT-2', '01'],
    ]) {
      const codeHash = pairingHash(code);
      first.createLinePairing({
        clientId,
        codeHash,
        createdAt: `2026-07-19T08:${minute}:00.000Z`,
        expiresAt: '2026-07-19T08:10:00.000Z',
      });
      first.consumeLinePairing({
        clientId,
        codeHash,
        lineUserId: 'U-shared-owner',
        consumedAt: `2026-07-19T08:${minute}:30.000Z`,
      });
    }
  } finally {
    first.close();
  }

  const reopened = new SqliteStore(filename);
  try {
    assert.equal(reopened.isLineApprover({
      clientId: 'punpan_020',
      lineUserId: 'U-shared-owner',
    }), true);
    assert.equal(reopened.isLineApprover({
      clientId: 'another-client',
      lineUserId: 'U-shared-owner',
    }), true);
    assert.equal(reopened.listLineApprovers({ clientId: 'punpan_020' }).length, 1);

    const raw = new DatabaseSync(filename, { readOnly: true });
    try {
      const tokenColumns = raw.prepare('PRAGMA table_info(line_pairing_tokens)').all()
        .map((column) => column.name);
      assert.equal(tokenColumns.includes('code'), false);
      assert.equal(tokenColumns.includes('code_hash'), true);
      assert.equal(raw.prepare(`
        SELECT COUNT(*) AS count
        FROM line_pairing_tokens
        WHERE code_hash IN (?, ?)
      `).get(
        pairingHash('WB-PAIR-CLIENT-1'),
        pairingHash('WB-PAIR-CLIENT-2'),
      ).count, 2);
    } finally {
      raw.close();
    }
  } finally {
    reopened.close();
  }
});

test('LINE pairing validates hashes and timestamps before writing', () => {
  const store = new SqliteStore();
  try {
    assert.throws(() => store.createLinePairing({
      clientId: 'punpan_020',
      codeHash: 'plaintext-code',
      createdAt: '2026-07-19T08:00:00.000Z',
      expiresAt: '2026-07-19T08:10:00.000Z',
    }), assertCode('INVALID_REQUEST'));
    assert.throws(() => store.createLinePairing({
      clientId: 'punpan_020',
      codeHash: pairingHash('WB-PAIR-TIME'),
      createdAt: 'not-a-date',
      expiresAt: '2026-07-19T08:10:00.000Z',
    }), assertCode('INVALID_REQUEST'));
    assert.throws(() => store.createLinePairing({
      clientId: 'punpan_020',
      codeHash: pairingHash('WB-PAIR-ORDER'),
      createdAt: '2026-07-19T08:10:00.000Z',
      expiresAt: '2026-07-19T08:10:00.000Z',
    }), assertCode('INVALID_REQUEST'));
    assert.equal(store.listAuditEvents().length, 0);
  } finally {
    store.close();
  }
});

test('persists immutable requests and their account routing identity', () => {
  const store = new SqliteStore();
  try {
    const created = store.createBudgetRequest(request());
    const loaded = store.getBudgetRequest(created.id);

    assert.deepEqual(loaded, created);
    assert(Object.isFrozen(loaded));
    assert.equal(store.listBudgetRequests({ adAccountId: 'advertiser-1' }).length, 1);
    assert.equal(store.listBudgetRequests({ adAccountId: 'another-account' }).length, 0);
    assert.throws(() => store.createBudgetRequest(request()), assertCode('DUPLICATE_REQUEST'));
  } finally {
    store.close();
  }
});

test('approval-to-execution is atomic and single use across SQLite connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gmv-max-store-'));
  const filename = join(directory, 'core.sqlite');
  const first = new SqliteStore(filename);
  const second = new SqliteStore(filename);
  try {
    first.createBudgetRequest(request('single-use-request'));
    first.submitBudgetAmount('single-use-request', {
      actorLineUserId: 'U-approver',
      increaseMinor: 500_000,
      now: '2026-07-18T10:01:00.000Z',
    });

    const claimed = first.claimBudgetRequestForExecution('single-use-request', {
      actorLineUserId: 'U-approver',
      observedCurrentBudgetMinor: 1_000_000,
      executionId: 'worker-claim-1',
      now: '2026-07-18T10:02:00.000Z',
    });
    assert.equal(claimed.state, RequestState.EXECUTING);

    assert.throws(
      () => second.claimBudgetRequestForExecution('single-use-request', {
        actorLineUserId: 'U-approver',
        observedCurrentBudgetMinor: 1_000_000,
        executionId: 'worker-claim-2',
        now: '2026-07-18T10:02:00.000Z',
      }),
      assertCode('INVALID_STATE'),
    );
    assert.equal(second.requireBudgetRequest('single-use-request').execution.id, 'worker-claim-1');
  } finally {
    first.close();
    second.close();
  }
});

test('rejects stale live budgets without consuming the pending approval', () => {
  const store = new SqliteStore();
  try {
    store.createBudgetRequest(request('stale-request'));
    store.submitBudgetAmount('stale-request', {
      actorLineUserId: 'U-approver',
      increaseMinor: 100_000,
      now: '2026-07-18T10:01:00.000Z',
    });
    assert.throws(
      () => store.claimBudgetRequestForExecution('stale-request', {
        actorLineUserId: 'U-approver',
        observedCurrentBudgetMinor: 1_100_000,
        now: '2026-07-18T10:02:00.000Z',
      }),
      assertCode('STALE_CURRENT_BUDGET'),
    );
    assert.equal(store.requireBudgetRequest('stale-request').state, RequestState.PENDING_APPROVAL);
  } finally {
    store.close();
  }
});

test('webhook payload is first-write-wins and processing requires an atomic lease', () => {
  const store = new SqliteStore();
  try {
    const first = store.recordWebhookEvent({
      provider: 'LINE',
      eventId: 'line-event-99',
      receivedAt: '2026-07-18T10:00:00.000Z',
      payload: { deliveryContext: { isRedelivery: false }, value: 1 },
    });
    const replay = store.recordWebhookEvent({
      provider: 'LINE',
      eventId: 'line-event-99',
      receivedAt: '2026-07-18T10:00:01.000Z',
      payload: { deliveryContext: { isRedelivery: true }, value: 2 },
    });

    assert.equal(first.isNew, true);
    assert.equal(replay.isNew, false);
    assert.equal(store.hasWebhookEvent('LINE', 'line-event-99'), true);
    assert.equal(replay.event.payload.value, 1, 'first event payload remains authoritative');
    assert.deepEqual(
      store.listAuditEvents().map((event) => event.eventType),
      ['WEBHOOK_RECEIVED', 'WEBHOOK_REDELIVERY_RECEIVED'],
    );

    assert.throws(
      () => store.markWebhookEvent({
        provider: 'LINE',
        eventId: 'line-event-99',
        status: 'PROCESSED',
        leaseToken: 'not-a-lease',
        processedAt: '2026-07-18T10:00:01.500Z',
      }),
      assertCode('WEBHOOK_NOT_PROCESSING'),
    );

    const claim = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'line-event-99',
      claimedAt: '2026-07-18T10:00:02.000Z',
      leaseDurationMs: 60_000,
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.event.status, 'PROCESSING');
    assert.equal(claim.event.attemptCount, 1);
    assert.match(claim.event.leaseToken, /^[0-9a-f-]{36}$/);

    const competingClaim = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'line-event-99',
      claimedAt: '2026-07-18T10:00:03.000Z',
      leaseDurationMs: 60_000,
    });
    assert.equal(competingClaim.claimed, false);
    assert.equal(competingClaim.reason, 'LEASE_ACTIVE');

    const processed = store.markWebhookEvent({
      provider: 'LINE',
      eventId: 'line-event-99',
      status: 'PROCESSED',
      leaseToken: claim.event.leaseToken,
      processedAt: '2026-07-18T10:00:04.000Z',
    });
    assert.equal(processed.status, 'PROCESSED');
    assert.equal(processed.leaseToken, null);

    const completedClaim = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'line-event-99',
      claimedAt: '2026-07-18T10:02:00.000Z',
    });
    assert.equal(completedClaim.claimed, false);
    assert.equal(completedClaim.reason, 'PROCESSED');
  } finally {
    store.close();
  }
});

test('FAILED and expired PROCESSING webhook attempts can be reclaimed with fencing', () => {
  const store = new SqliteStore();
  try {
    store.recordWebhookEvent({
      provider: 'LINE',
      eventId: 'retry-event',
      receivedAt: '2026-07-18T10:00:00.000Z',
      payload: { type: 'postback' },
    });
    const first = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'retry-event',
      claimedAt: '2026-07-18T10:00:00.000Z',
      leaseDurationMs: 1_000,
    });
    const failed = store.markWebhookEvent({
      provider: 'LINE',
      eventId: 'retry-event',
      leaseToken: first.event.leaseToken,
      status: 'FAILED',
      errorCode: 'TEMPORARY_ERROR',
      processedAt: '2026-07-18T10:00:00.500Z',
    });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attemptCount, 1);

    const retry = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'retry-event',
      claimedAt: '2026-07-18T10:00:01.000Z',
      leaseDurationMs: 1_000,
    });
    assert.equal(retry.claimed, true);
    assert.equal(retry.event.attemptCount, 2);
    assert.equal(retry.event.errorCode, null);
    assert.notEqual(retry.event.leaseToken, first.event.leaseToken);
    assert.throws(
      () => store.markWebhookEvent({
        provider: 'LINE',
        eventId: 'retry-event',
        leaseToken: first.event.leaseToken,
        status: 'PROCESSED',
        processedAt: '2026-07-18T10:00:01.500Z',
      }),
      assertCode('WEBHOOK_LEASE_MISMATCH'),
    );

    const beforeExpiry = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'retry-event',
      claimedAt: '2026-07-18T10:00:01.999Z',
      leaseDurationMs: 1_000,
    });
    assert.equal(beforeExpiry.claimed, false);
    const reclaimed = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'retry-event',
      claimedAt: '2026-07-18T10:00:02.000Z',
      leaseDurationMs: 1_000,
    });
    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.event.attemptCount, 3);
    assert.notEqual(reclaimed.event.leaseToken, retry.event.leaseToken);

    const processed = store.markWebhookEvent({
      provider: 'LINE',
      eventId: 'retry-event',
      leaseToken: reclaimed.event.leaseToken,
      status: 'PROCESSED',
      processedAt: '2026-07-18T10:00:02.500Z',
    });
    assert.equal(processed.status, 'PROCESSED');
    assert.deepEqual(
      store.listAuditEvents().map((event) => event.eventType),
      [
        'WEBHOOK_RECEIVED',
        'WEBHOOK_CLAIMED',
        'WEBHOOK_FAILED',
        'WEBHOOK_RETRY_CLAIMED',
        'WEBHOOK_LEASE_RECLAIMED',
        'WEBHOOK_PROCESSED',
      ],
    );
  } finally {
    store.close();
  }
});

test('claimNextWebhookEvent recovers a durable RECEIVED event after a worker crash', () => {
  const store = new SqliteStore();
  try {
    store.recordWebhookEvent({
      provider: 'LINE',
      eventId: 'abandoned-after-record',
      receivedAt: '2026-07-18T10:00:00.000Z',
      payload: { type: 'message', messageType: 'text' },
    });
    const recovery = store.claimNextWebhookEvent({
      provider: 'LINE',
      claimedAt: '2026-07-18T10:05:00.000Z',
      leaseDurationMs: 10_000,
    });
    assert.equal(recovery.claimed, true);
    assert.equal(recovery.event.eventId, 'abandoned-after-record');
    assert.equal(recovery.event.payload.messageType, 'text');
    assert.equal(store.claimNextWebhookEvent({ provider: 'OTHER' }), null);
  } finally {
    store.close();
  }
});

test('execution jobs enqueue once per request and persist the first approval actor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gmv-max-execution-job-'));
  const filename = join(directory, 'jobs.sqlite');
  const first = new SqliteStore(filename);
  const second = new SqliteStore(filename);
  try {
    first.createBudgetRequest(request('outbox-request'));
    const enqueued = first.enqueueExecutionJob({
      requestId: 'outbox-request',
      actorLineUserId: 'U-approver',
      createdAt: '2026-07-18T10:01:00.000Z',
    });
    const duplicate = second.enqueueExecutionJob({
      requestId: 'outbox-request',
      actorLineUserId: 'U-approver',
      createdAt: '2026-07-18T10:02:00.000Z',
    });

    assert.equal(enqueued.enqueued, true);
    assert.equal(duplicate.enqueued, false);
    assert.deepEqual(duplicate.job, enqueued.job);
    assert.deepEqual(enqueued.job, {
      requestId: 'outbox-request',
      actorLineUserId: 'U-approver',
      status: 'PENDING',
      createdAt: '2026-07-18T10:01:00.000Z',
      availableAt: '2026-07-18T10:01:00.000Z',
      completedAt: null,
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      lastAttemptAt: null,
      error: null,
    });
    assert(Object.isFrozen(enqueued.job));
    assert.equal(first.listAuditEvents({ requestId: 'outbox-request' })
      .filter((event) => event.eventType === 'EXECUTION_JOB_ENQUEUED').length, 1);
  } finally {
    first.close();
    second.close();
  }
});

test('execution job claims are leased, fenced, and completed exactly once', () => {
  const store = new SqliteStore();
  try {
    store.createBudgetRequest(request('complete-job'));
    store.enqueueExecutionJob({
      requestId: 'complete-job',
      actorLineUserId: 'U-approver',
      createdAt: '2026-07-18T10:01:00.000Z',
    });

    const first = store.claimNextExecutionJob({
      claimedAt: '2026-07-18T10:01:01.000Z',
      leaseDurationMs: 10_000,
    });
    assert.equal(first.claimed, true);
    assert.equal(first.job.status, 'PROCESSING');
    assert.equal(first.job.attemptCount, 1);
    assert.match(first.job.leaseToken, /^[0-9a-f-]{36}$/);
    assert.equal(store.claimNextExecutionJob({
      claimedAt: '2026-07-18T10:01:02.000Z',
    }), null, 'an active lease is not claimable');

    assert.throws(
      () => store.completeExecutionJob({
        requestId: 'complete-job',
        leaseToken: 'stale-worker-token',
        completedAt: '2026-07-18T10:01:03.000Z',
      }),
      assertCode('EXECUTION_JOB_LEASE_MISMATCH'),
    );
    const completed = store.completeExecutionJob({
      requestId: 'complete-job',
      leaseToken: first.job.leaseToken,
      completedAt: '2026-07-18T10:01:04.000Z',
    });
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.completedAt, '2026-07-18T10:01:04.000Z');
    assert.equal(completed.leaseToken, null);
    assert.equal(store.claimNextExecutionJob({
      claimedAt: '2026-07-18T10:10:00.000Z',
    }), null);
    assert.throws(
      () => store.completeExecutionJob({
        requestId: 'complete-job',
        leaseToken: first.job.leaseToken,
        completedAt: '2026-07-18T10:01:05.000Z',
      }),
      assertCode('EXECUTION_JOB_ALREADY_COMPLETED'),
    );
  } finally {
    store.close();
  }
});

test('execution retries honor availableAt and expired PROCESSING leases are reclaimable', () => {
  const store = new SqliteStore();
  try {
    store.createBudgetRequest(request('retry-job'));
    store.enqueueExecutionJob({
      requestId: 'retry-job',
      actorLineUserId: 'U-approver',
      createdAt: '2026-07-18T10:01:00.000Z',
    });
    const first = store.claimNextExecutionJob({
      claimedAt: '2026-07-18T10:01:00.000Z',
      leaseDurationMs: 10_000,
    });
    const released = store.retryExecutionJob({
      requestId: 'retry-job',
      leaseToken: first.job.leaseToken,
      releasedAt: '2026-07-18T10:01:01.000Z',
      availableAt: '2026-07-18T10:02:00.000Z',
      error: { code: 'TIKTOK_TIMEOUT', retryable: true },
    });
    assert.equal(released.status, 'PENDING');
    assert.equal(released.attemptCount, 1);
    assert.deepEqual(released.error, { code: 'TIKTOK_TIMEOUT', retryable: true });
    assert.equal(store.claimNextExecutionJob({
      claimedAt: '2026-07-18T10:01:59.999Z',
    }), null);

    const retry = store.claimNextExecutionJob({
      claimedAt: '2026-07-18T10:02:00.000Z',
      leaseDurationMs: 1_000,
    });
    assert.equal(retry.job.attemptCount, 2);
    assert.notEqual(retry.job.leaseToken, first.job.leaseToken);

    const reclaimed = store.claimNextExecutionJob({
      claimedAt: '2026-07-18T10:02:01.000Z',
      leaseDurationMs: 1_000,
    });
    assert.equal(reclaimed.job.attemptCount, 3);
    assert.notEqual(reclaimed.job.leaseToken, retry.job.leaseToken);
    assert.throws(
      () => store.releaseExecutionJob({
        requestId: 'retry-job',
        leaseToken: retry.job.leaseToken,
        releasedAt: '2026-07-18T10:02:01.100Z',
        availableAt: '2026-07-18T10:02:02.000Z',
        error: { code: 'STALE_WORKER' },
      }),
      assertCode('EXECUTION_JOB_LEASE_MISMATCH'),
    );
    assert.deepEqual(
      store.listAuditEvents({ requestId: 'retry-job' })
        .map((event) => event.eventType)
        .filter((type) => type.startsWith('EXECUTION_JOB_')),
      [
        'EXECUTION_JOB_ENQUEUED',
        'EXECUTION_JOB_CLAIMED',
        'EXECUTION_JOB_RETRY_SCHEDULED',
        'EXECUTION_JOB_RETRY_CLAIMED',
        'EXECUTION_JOB_LEASE_RECLAIMED',
      ],
    );
  } finally {
    store.close();
  }
});

test('only one active request is allowed per ad account/campaign and latest supports cooldowns', () => {
  const store = new SqliteStore();
  try {
    store.createBudgetRequest(request('active-request-1'));
    assert.throws(
      () => store.createBudgetRequest(request('active-request-2', {
        createdAt: '2026-07-18T10:01:00.000Z',
        expiresAt: '2026-07-18T10:16:00.000Z',
      })),
      assertCode('ACTIVE_REQUEST_EXISTS'),
    );

    store.cancelBudgetRequest('active-request-1', {
      actorLineUserId: 'U-approver',
      reason: 'test terminal request',
      now: '2026-07-18T10:02:00.000Z',
    });
    store.createBudgetRequest(request('active-request-2', {
      createdAt: '2026-07-18T10:03:00.000Z',
      expiresAt: '2026-07-18T10:18:00.000Z',
    }));

    assert.equal(store.getLatestBudgetRequest({
      adAccountId: 'advertiser-1',
      campaignId: 'campaign-1',
    }).id, 'active-request-2');
    assert.equal(store.getLatestBudgetRequest({
      adAccountId: 'advertiser-1',
      campaignId: 'missing-campaign',
    }), null);
  } finally {
    store.close();
  }
});

test('migrates the pre-lease SQLite schema without losing request or sanitized webhook data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gmv-max-legacy-store-'));
  const filename = join(directory, 'legacy.sqlite');
  const legacyRequest = request('legacy-request');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE budget_requests (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      agency_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      ad_account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      data_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE webhook_events (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      request_id TEXT,
      error_code TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(provider, event_id),
      FOREIGN KEY(request_id) REFERENCES budget_requests(id)
    ) STRICT;
  `);
  legacy.prepare(`
    INSERT INTO budget_requests
      (id, state, version, agency_id, client_id, ad_account_id, campaign_id, expires_at, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    legacyRequest.id,
    legacyRequest.state,
    legacyRequest.version,
    legacyRequest.agencyId,
    legacyRequest.clientId,
    legacyRequest.adAccountId,
    legacyRequest.campaignId,
    legacyRequest.expiresAt,
    JSON.stringify(legacyRequest),
  );
  legacy.prepare(`
    INSERT INTO webhook_events
      (provider, event_id, status, received_at, payload_json)
    VALUES ('LINE', 'legacy-event', 'RECEIVED', ?, ?)
  `).run(
    '2026-07-18T10:00:00.000Z',
    JSON.stringify({ type: 'postback', sourceType: 'user' }),
  );
  legacy.close();

  const store = new SqliteStore(filename);
  try {
    assert.equal(store.getLatestBudgetRequest({
      adAccountId: 'advertiser-1',
      campaignId: 'campaign-1',
    }).id, 'legacy-request');
    const claimed = store.claimWebhookEvent({
      provider: 'LINE',
      eventId: 'legacy-event',
      claimedAt: '2026-07-18T10:01:00.000Z',
    });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.event.attemptCount, 1);
    assert.deepEqual(claimed.event.payload, { type: 'postback', sourceType: 'user' });
  } finally {
    store.close();
  }
});

test('the full lifecycle produces an append-only request audit trail', () => {
  const store = new SqliteStore();
  try {
    store.createBudgetRequest(request('audit-request'));
    store.submitBudgetAmount('audit-request', {
      actorLineUserId: 'U-approver',
      increaseMinor: 250_000,
      now: '2026-07-18T10:01:00.000Z',
    });
    store.claimBudgetRequestForExecution('audit-request', {
      actorLineUserId: 'U-approver',
      observedCurrentBudgetMinor: 1_000_000,
      executionId: 'audit-execution',
      now: '2026-07-18T10:02:00.000Z',
    });
    const finished = store.succeedBudgetRequest('audit-request', {
      actualBudgetMinor: 1_250_000,
      platformReference: 'platform-change-1',
      now: '2026-07-18T10:03:00.000Z',
    });

    assert.equal(finished.state, RequestState.SUCCEEDED);
    assert.deepEqual(
      store.listAuditEvents({ requestId: 'audit-request' }).map((event) => event.eventType),
      [
        'BUDGET_REQUEST_CREATED',
        'BUDGET_AMOUNT_SUBMITTED',
        'BUDGET_EXECUTION_CLAIMED',
        'BUDGET_EXECUTION_SUCCEEDED',
      ],
    );
  } finally {
    store.close();
  }
});
