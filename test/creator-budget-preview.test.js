import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCreatorBudgetPreview } from '../src/creator-budget-preview.js';
import { CREATOR_POLICY_DEFAULTS } from '../src/creator-policy.js';
import { CREATOR_BINDING } from '../src/creator-read.js';

const NOW = new Date('2025-03-15T07:07:00.000Z');
const IDENTITY = Object.freeze({
  clientId: 'punpan_020', advertiserId: CREATOR_BINDING.advertiserId, tiktokAccountId: CREATOR_BINDING.tiktokAccountId,
});
const POLICY = Object.freeze({
  ...CREATOR_POLICY_DEFAULTS, revision: 1, campaignCapMinor: 1_000_000, clientDailyCapMinor: 1_000_000,
});
const SNAPSHOT = Object.freeze({
  ...IDENTITY, source: 'tiktok-creator-api', readOnly: true, timezone: 'Asia/Bangkok',
  observedAt: '2025-03-15T07:06:45.000Z', reportingDate: '2025-03-15', unavailable: false, noActiveCampaign: false,
  campaignId: '1234567890123456', campaignName: 'Test LIVE', campaignStatus: 'ACTIVE', campaignOperationStatus: 'ENABLE',
  currency: 'THB', dailyBudgetMinor: 780000, costMinor: 655123, aggregateSpendMinor: 655198, aggregateSpendComplete: true,
  nativeAutoBudgetState: 'UNKNOWN',
});

function evaluate(snapshot = SNAPSHOT, policy = POLICY, identity = IDENTITY, now = NOW) {
  return evaluateCreatorBudgetPreview({ snapshot, policy, identity, now });
}
function assertBlocked(result, reason) {
  assert.equal(result.dryRun, true);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, reason);
  assert.equal(result.key, undefined);
}

test('projects a synthetic baseline, exact increase and other-campaign spend without a write', () => {
  const result = evaluate();
  assert.equal(result.dryRun, true);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'ELIGIBLE');
  assert.equal(result.currentBudgetMinor, 780000);
  assert.equal(result.thresholdMinor, 624000);
  assert.equal(result.spendMinor, 655123);
  assert.equal(result.aggregateSpendMinor, 655198);
  assert.equal(result.otherSpendMinor, 75);
  assert.equal(result.proposedBudgetMinor, 936000);
  assert.equal(result.projectedClientSpendMinor, 936075);
  assert.equal(result.campaignCapMinor, 1000000);
  assert.equal(result.clientDailyCapMinor, 1000000);
  assert.equal(result.campaignName, 'Test LIVE');
  assert.equal(result.observedAt, SNAPSHOT.observedAt);
  assert.equal(result.nativeAutoBudgetState, 'UNKNOWN');
  assert.match(result.key, /^cbp_[a-f0-9]{64}$/);
});

test('spend exactly at 80% qualifies; one satang below does not', () => {
  assert.equal(evaluate({ ...SNAPSHOT, costMinor: 624000, aggregateSpendMinor: 624075 }).eligible, true);
  const below = evaluate({ ...SNAPSHOT, costMinor: 623999 });
  assertBlocked(below, 'BELOW_THRESHOLD');
  assert.equal(below.thresholdMinor, 624000);
  assert.equal(below.proposedBudgetMinor, undefined);
  const cents = evaluate({ ...SNAPSHOT, dailyBudgetMinor: 780001, costMinor: 624000 });
  assertBlocked(cents, 'BELOW_THRESHOLD');
  assert.equal(cents.thresholdMinor, 624001);
});

test('campaign cap and aggregate cap are independent, with no silent clamping', () => {
  const campaignBlocked = evaluate(SNAPSHOT, { ...POLICY, campaignCapMinor: 935999 });
  assertBlocked(campaignBlocked, 'CAMPAIGN_CAP_EXCEEDED');
  assert.equal(campaignBlocked.proposedBudgetMinor, 936000);
  const aggregateBlocked = evaluate(SNAPSHOT, { ...POLICY, clientDailyCapMinor: 936074 });
  assertBlocked(aggregateBlocked, 'CLIENT_DAILY_CAP_EXCEEDED');
  assert.equal(aggregateBlocked.projectedClientSpendMinor, 936075);
  assert.equal(evaluate(SNAPSHOT, { ...POLICY, campaignCapMinor: 936000, clientDailyCapMinor: 936075 }).eligible, true);
  assertBlocked(evaluate({ ...SNAPSHOT, costMinor: 1000001, aggregateSpendMinor: 1000001 }), 'CLIENT_DAILY_CAP_EXCEEDED');
});

test('rejects unrepresentable fractional-satang and unsafe-integer proposals', () => {
  assertBlocked(evaluate({ ...SNAPSHOT, dailyBudgetMinor: 780001 }), 'PROPOSAL_UNREPRESENTABLE');
  const max = Number.MAX_SAFE_INTEGER;
  assertBlocked(evaluate({ ...SNAPSHOT, dailyBudgetMinor: max - 1, costMinor: max - 1, aggregateSpendMinor: max }), 'PROPOSAL_UNREPRESENTABLE');
  assertBlocked(evaluate({ ...SNAPSHOT, dailyBudgetMinor: 100, costMinor: 100, aggregateSpendMinor: max }), 'PROPOSAL_UNREPRESENTABLE');
});

test('freshness is bounded and checks Bangkok day on observation and report', () => {
  assertBlocked(evaluate({ ...SNAPSHOT, observedAt: '2025-03-15T07:03:59.999Z' }), 'STALE_SNAPSHOT');
  assertBlocked(evaluate({ ...SNAPSHOT, observedAt: '2025-03-15T07:07:30.001Z' }), 'STALE_SNAPSHOT');
  assertBlocked(evaluate({ ...SNAPSHOT, observedAt: null }), 'STALE_SNAPSHOT');
  assertBlocked(evaluate({ ...SNAPSHOT, reportingDate: '2025-03-14' }), 'REPORTING_DAY_MISMATCH');
  const bangkokMidnight = new Date('2025-03-15T17:00:00.000Z');
  assertBlocked(evaluate({ ...SNAPSHOT, observedAt: '2025-03-15T16:59:59.000Z', reportingDate: '2025-03-16' }, POLICY, IDENTITY, bangkokMidnight), 'REPORTING_DAY_MISMATCH');
  assert.equal(evaluate({ ...SNAPSHOT, observedAt: bangkokMidnight.toISOString(), reportingDate: '2025-03-16' }, POLICY, IDENTITY, bangkokMidnight.getTime()).eligible, true);
  assertBlocked(evaluate(SNAPSHOT, POLICY, IDENTITY, new Date('invalid')), 'CLOCK_INVALID');
});

test('rejects other identities, missing or ambiguous campaign state, currency and competing native budget', () => {
  assertBlocked(evaluate(null), 'SNAPSHOT_UNAVAILABLE');
  for (const patch of [
    { advertiserId: '999999' }, { tiktokAccountId: '999999' }, { clientId: 'other' },
    { source: 'chrome-ui' }, { readOnly: false }, { timezone: 'UTC' },
  ]) assertBlocked(evaluate({ ...SNAPSHOT, ...patch }), 'IDENTITY_MISMATCH');
  assertBlocked(evaluate(SNAPSHOT, POLICY, { ...IDENTITY, advertiserId: '999999' }), 'IDENTITY_MISMATCH');
  assertBlocked(evaluate(SNAPSHOT, POLICY, { ...IDENTITY, campaignId: '1234567890123457' }), 'IDENTITY_MISMATCH');
  assert.equal(evaluate(SNAPSHOT, POLICY, { ...IDENTITY, campaignId: SNAPSHOT.campaignId }).eligible, true);
  assertBlocked(evaluate({ ...SNAPSHOT, noActiveCampaign: true }), 'NO_ACTIVE_CAMPAIGN');
  for (const patch of [
    { campaignStatus: 'INACTIVE' }, { campaignOperationStatus: 'DISABLE' }, { currency: 'USD' }, { campaignId: 1234567890123456 },
  ]) assertBlocked(evaluate({ ...SNAPSHOT, ...patch }), 'CAMPAIGN_UNVERIFIED');
  for (const nativeAutoBudgetState of ['ENABLED', 'CONFLICT', null]) {
    assertBlocked(evaluate({ ...SNAPSHOT, nativeAutoBudgetState }), 'NATIVE_AUTO_BUDGET_CONFLICT');
  }
  assert.equal(evaluate({ ...SNAPSHOT, nativeAutoBudgetState: 'DISABLED' }).eligible, true);
});

test('requires verified integer spend and complete consistent aggregate; no fallback to default caps', () => {
  for (const patch of [{ costMinor: null }, { costMinor: 100.5 }, { dailyBudgetMinor: 0 }, { costMinor: -1 }]) {
    assertBlocked(evaluate({ ...SNAPSHOT, ...patch }), 'BUDGET_OR_SPEND_UNVERIFIED');
  }
  for (const patch of [{ aggregateSpendComplete: false }, { aggregateSpendMinor: null }, { aggregateSpendMinor: 655122 }]) {
    assertBlocked(evaluate({ ...SNAPSHOT, ...patch }), 'AGGREGATE_SPEND_UNVERIFIED');
  }
  assertBlocked(evaluate(SNAPSHOT, null), 'POLICY_UNAVAILABLE');
  assertBlocked(evaluate(SNAPSHOT, { ...POLICY, mode: 'PAUSED' }), 'POLICY_PAUSED');
  for (const patch of [{ executionEnabled: true }, { mode: 'AUTO' }, { thresholdBps: 9000 }, { increaseBps: 3000 },
    { campaignCapMinor: null }, { clientDailyCapMinor: 0 }, { revision: 0 }, { clientId: 'other' }]) {
    assertBlocked(evaluate(SNAPSHOT, { ...POLICY, ...patch }), 'POLICY_UNVERIFIED');
  }
});

test('dedupe key is stable across observations/spend/ceiling revisions but changes with campaign, day or actual baseline', () => {
  const key = evaluate().key;
  assert.equal(evaluate({ ...SNAPSHOT, costMinor: 655300, aggregateSpendMinor: 655400, observedAt: NOW.toISOString() },
    { ...POLICY, revision: 2, campaignCapMinor: 1100000 }).key, key);
  assert.notEqual(evaluate({ ...SNAPSHOT, dailyBudgetMinor: 800000 }).key, key);
  assert.notEqual(evaluate({ ...SNAPSHOT, campaignId: '1234567890123457' }).key, key);
  const tomorrow = new Date('2025-03-16T07:07:00.000Z');
  assert.notEqual(evaluate({ ...SNAPSHOT, reportingDate: '2025-03-16', observedAt: tomorrow.toISOString() }, POLICY, IDENTITY, tomorrow).key, key);
});
