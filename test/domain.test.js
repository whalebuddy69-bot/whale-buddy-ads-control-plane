import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DomainError,
  RequestState,
  beginBudgetExecution,
  cancelBudgetRequest,
  createBudgetRequest,
  expireBudgetRequest,
  failBudgetRequest,
  isTerminalState,
  submitBudgetAmount,
  succeedBudgetRequest,
} from '../src/domain.js';

const CREATED_AT = '2026-07-18T10:00:00.000Z';
const EXPIRES_AT = '2026-07-18T10:15:00.000Z';

function request(overrides = {}) {
  return createBudgetRequest({
    id: 'request-1234',
    agencyId: 'agency-1',
    clientId: 'client-a',
    adAccountId: 'advertiser-100',
    campaignId: 'live-gmv-200',
    authorizedLineUserIds: ['U-approver-2', 'U-approver-1', 'U-approver-1'],
    currency: 'THB',
    currentBudgetMinor: 1_000_000,
    maxBudgetMinor: 2_000_000,
    maxIncreaseMinor: 600_000,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    metadata: { clientName: 'ร้าน A', nested: { source: 'monitor' } },
    ...overrides,
  });
}

function assertCode(code) {
  return (error) => error instanceof DomainError && error.code === code;
}

test('creates a deeply immutable, account-scoped PENDING_INPUT request', () => {
  const value = request();

  assert.equal(value.state, RequestState.PENDING_INPUT);
  assert.equal(value.adAccountId, 'advertiser-100');
  assert.equal(value.campaignId, 'live-gmv-200');
  assert.deepEqual(value.authorizedLineUserIds, ['U-approver-1', 'U-approver-2']);
  assert.equal(value.version, 0);
  assert(Object.isFrozen(value));
  assert(Object.isFrozen(value.guardrails));
  assert(Object.isFrozen(value.metadata.nested));
  assert.throws(() => { value.metadata.nested.source = 'tampered'; }, TypeError);
});

test('amount submission returns a new immutable version and keeps the source unchanged', () => {
  const original = request();
  const submitted = submitBudgetAmount(original, {
    actorLineUserId: 'U-approver-1',
    increaseMinor: 500_000,
    now: '2026-07-18T10:05:00.000Z',
  });

  assert.equal(original.state, RequestState.PENDING_INPUT);
  assert.equal(original.increaseMinor, null);
  assert.equal(submitted.state, RequestState.PENDING_APPROVAL);
  assert.equal(submitted.increaseMinor, 500_000);
  assert.equal(submitted.targetBudgetMinor, 1_500_000);
  assert.equal(submitted.version, 1);
  assert(Object.isFrozen(submitted.amountSubmission));
});

test('rejects unauthorized users, non-positive money, max delta, and account ceiling', () => {
  const base = request();
  const common = { now: '2026-07-18T10:05:00.000Z' };

  assert.throws(
    () => submitBudgetAmount(base, { ...common, actorLineUserId: 'U-stranger', increaseMinor: 1 }),
    assertCode('UNAUTHORIZED_USER'),
  );
  assert.throws(
    () => submitBudgetAmount(base, { ...common, actorLineUserId: 'U-approver-1', increaseMinor: 0 }),
    assertCode('INVALID_INCREASE'),
  );
  assert.throws(
    () => submitBudgetAmount(base, { ...common, actorLineUserId: 'U-approver-1', increaseMinor: 600_001 }),
    assertCode('MAX_DELTA_EXCEEDED'),
  );

  const lowerCeiling = request({ maxBudgetMinor: 1_300_000, maxIncreaseMinor: 600_000 });
  assert.throws(
    () => submitBudgetAmount(lowerCeiling, { ...common, actorLineUserId: 'U-approver-1', increaseMinor: 400_000 }),
    assertCode('BUDGET_CEILING_EXCEEDED'),
  );
});

test('approval re-checks expiry and the live current-budget snapshot', () => {
  const submitted = submitBudgetAmount(request(), {
    actorLineUserId: 'U-approver-1',
    increaseMinor: 500_000,
    now: '2026-07-18T10:05:00.000Z',
  });

  assert.throws(
    () => beginBudgetExecution(submitted, {
      actorLineUserId: 'U-approver-1',
      observedCurrentBudgetMinor: 1_100_000,
      now: '2026-07-18T10:06:00.000Z',
    }),
    assertCode('STALE_CURRENT_BUDGET'),
  );
  assert.throws(
    () => beginBudgetExecution(submitted, {
      actorLineUserId: 'U-approver-1',
      observedCurrentBudgetMinor: 1_000_000,
      now: EXPIRES_AT,
    }),
    assertCode('REQUEST_EXPIRED'),
  );
});

test('happy path is PENDING_APPROVAL -> EXECUTING -> SUCCEEDED and terminal', () => {
  const submitted = submitBudgetAmount(request(), {
    actorLineUserId: 'U-approver-1',
    increaseMinor: 500_000,
    now: '2026-07-18T10:05:00.000Z',
  });
  const executing = beginBudgetExecution(submitted, {
    actorLineUserId: 'U-approver-1',
    observedCurrentBudgetMinor: 1_000_000,
    executionId: 'execution-1',
    now: '2026-07-18T10:06:00.000Z',
  });
  const succeeded = succeedBudgetRequest(executing, {
    actualBudgetMinor: 1_500_000,
    platformReference: 'tiktok-change-99',
    now: '2026-07-18T10:07:00.000Z',
  });

  assert.equal(executing.execution.id, 'execution-1');
  assert.equal(succeeded.state, RequestState.SUCCEEDED);
  assert.equal(succeeded.version, 3);
  assert.equal(succeeded.result.actualBudgetMinor, 1_500_000);
  assert.equal(isTerminalState(succeeded.state), true);
  assert.throws(
    () => failBudgetRequest(succeeded, { code: 'LATE', message: 'too late' }),
    assertCode('INVALID_STATE'),
  );
});

test('execution failure, expiry, and cancellation have explicit terminal states', () => {
  const submitted = submitBudgetAmount(request(), {
    actorLineUserId: 'U-approver-1',
    increaseMinor: 100_000,
    now: '2026-07-18T10:01:00.000Z',
  });
  const executing = beginBudgetExecution(submitted, {
    actorLineUserId: 'U-approver-1',
    observedCurrentBudgetMinor: 1_000_000,
    now: '2026-07-18T10:02:00.000Z',
  });
  const failed = failBudgetRequest(executing, {
    code: 'TIKTOK_REJECTED',
    message: 'Platform rejected the change',
    retryable: false,
    now: '2026-07-18T10:03:00.000Z',
  });
  assert.equal(failed.state, RequestState.FAILED);
  assert.equal(failed.failure.code, 'TIKTOK_REJECTED');

  const expired = expireBudgetRequest(request({ id: 'request-expired' }), { now: EXPIRES_AT });
  assert.equal(expired.state, RequestState.EXPIRED);
  assert.throws(
    () => expireBudgetRequest(request({ id: 'request-early' }), { now: '2026-07-18T10:14:59.999Z' }),
    assertCode('REQUEST_NOT_EXPIRED'),
  );

  const cancelled = cancelBudgetRequest(request({ id: 'request-cancelled' }), {
    actorLineUserId: 'U-approver-2',
    reason: 'ไม่เพิ่มงบแล้ว',
    now: '2026-07-18T10:04:00.000Z',
  });
  assert.equal(cancelled.state, RequestState.CANCELLED);
  assert.equal(cancelled.cancellation.actorLineUserId, 'U-approver-2');
});
