import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../src/store.js';
import { CREATOR_BINDING } from '../src/creator-read.js';
import {
  CREATOR_BUDGET_TEST_URL, CreatorBudgetTestWorker, creatorBudgetTestFromEnvironment,
  validateCreatorBudgetTestPermit,
} from '../src/creator-budget-test.js';

const OWNER = 'U-test-owner';
const KEY = 'w'.repeat(64);
const READ_KEY = 'r'.repeat(64);
const AT = '2026-11-07T23:01:00.000Z'; // Nov 8, 06:01 Bangkok.
const PERMIT = {
  permitId: 'ppan-one-shot-test-20261108', clientId: 'punpan_020', binding: { ...CREATOR_BINDING },
  campaignId: '1881130110195874', expectedBudgetMinor: 300000, targetBudgetMinor: 360000,
  capMinor: 1000000, policyRevision: 1, localDate: '2026-11-08',
  notBefore: '2026-11-07T23:00:00.000Z', expiresAt: '2026-11-08T16:00:00.000Z',
  nativeAutoBudgetVerifiedOff: true, exclusiveWriterConfirmed: true,
};
const result = (status = 'SUCCEEDED', overrides = {}) => ({
  permitId: PERMIT.permitId, status, postCount: 1, providerAccepted: true,
  observedBudgetMinor: 360000, lockSafeToRelease: true, writeAttempted: true,
  ...overrides,
});
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function pair(store, user = OWNER) {
  const codeHash = createHash('sha256').update(user).digest('hex');
  store.createLinePairing({ clientId: PERMIT.clientId, codeHash, createdAt: AT, expiresAt: '2026-11-07T23:11:00.000Z' });
  store.consumeLinePairing({ clientId: PERMIT.clientId, codeHash, lineUserId: user, consumedAt: AT });
}
function harness(options = {}) {
  const store = options.store ?? new SqliteStore();
  if (!options.store) {
    pair(store);
    store.ensureCreatorPolicy({ clientId: PERMIT.clientId, now: AT });
  }
  let at = options.at ?? AT;
  const calls = [];
  const notifications = [];
  const snapshot = overrides => ({
    stale: false, snapshot: {
      source: 'tiktok-creator-api', readOnly: true, clientId: PERMIT.clientId,
      advertiserId: CREATOR_BINDING.advertiserId, tiktokAccountId: CREATOR_BINDING.tiktokAccountId,
      unavailable: false, noActiveCampaign: false, reportingDate: PERMIT.localDate, observedAt: at,
      campaignId: PERMIT.campaignId, campaignStatus: 'ACTIVE', dailyBudgetMinor: 300000, costMinor: 240000,
      nativeAutoBudgetState: 'UNKNOWN', gmvMinor: null, grossRoiMilli: null, liveViews: null,
      ...overrides,
    },
  });
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    return options.fetchImpl ? options.fetchImpl(url, init) : reply(result());
  };
  const worker = new CreatorBudgetTestWorker({
    enabled: options.enabled ?? true, permit: options.permit ?? PERMIT, key: KEY, readKey: READ_KEY,
    store, clock: () => new Date(at), snapshot: options.snapshot ?? (() => snapshot()), fetchImpl,
    notify: options.notify ?? (async notice => { notifications.push(notice); }),
  });
  return { store, worker, calls, notifications, snapshot, setTime: value => { at = value; } };
}

test('default and environment switches fail closed; false-like/truthy alternatives never arm', async () => {
  const disabled = new CreatorBudgetTestWorker();
  assert.equal((await disabled.tick()).enabled, false);
  for (const flag of [undefined, 'false', 'TRUE', '1', 'yes', true]) {
    assert.equal(creatorBudgetTestFromEnvironment({ CREATOR_BUDGET_TEST_ENABLED: flag }), null);
  }
  assert.throws(() => creatorBudgetTestFromEnvironment({ CREATOR_BUDGET_TEST_ENABLED: 'true' }), /PERMIT_REQUIRED/);
  const h = harness({ enabled: false });
  try { await h.worker.tick(); assert.equal(h.calls.length, 0); } finally { h.store.close(); }
});

test('permit has exact immutable identity, +20% amount, approval booleans, and explicit Bangkok date/window', () => {
  assert.equal(validateCreatorBudgetTestPermit(PERMIT).localDate, '2026-11-08');
  for (const patch of [
    { campaignId: '1881012999140370' }, { expectedBudgetMinor: 360000 }, { targetBudgetMinor: 432000 },
    { capMinor: 900000 }, { policyRevision: 2 }, { clientId: 'other' }, { binding: { ...CREATOR_BINDING, identityType: 'TT_USER' } },
    { nativeAutoBudgetVerifiedOff: false }, { exclusiveWriterConfirmed: false }, { notBefore: undefined },
    { expiresAt: undefined }, { localDate: '2026-11-07' }, { expiresAt: PERMIT.notBefore },
    { notBefore: '2026-11-08' }, { extra: true },
  ]) assert.throws(() => validateCreatorBudgetTestPermit({ ...PERMIT, ...patch }), /CREATOR_BUDGET_TEST_/);
});

test('dedicated secret cannot equal read secret, and no other host/path/scheme is accepted', () => {
  const store = new SqliteStore();
  try {
    const base = { enabled: true, store, permit: PERMIT, key: KEY, readKey: READ_KEY };
    assert.throws(() => new CreatorBudgetTestWorker({ ...base, readKey: KEY }), /DEDICATED_KEY/);
    assert.throws(() => new CreatorBudgetTestWorker({ ...base, readKey: undefined }), /DEDICATED_KEY/);
    for (const url of ['http://gmv-max-report-production-3251.up.railway.app/internal/creator/punpan_020/budget-test', `${CREATOR_BUDGET_TEST_URL}/`, `${CREATOR_BUDGET_TEST_URL}?x=1`, 'https://example.com']) {
      assert.throws(() => new CreatorBudgetTestWorker({ ...base, url }), /URL_NOT_ALLOWED/);
    }
  } finally { store.close(); }
});

test('before start and before the approved day there are zero bridge RPCs; expiry forbids dispatch', async () => {
  const h = harness({ at: '2026-11-07T12:00:00.000Z' });
  try {
    assert.equal((await h.worker.tick()).status, 'waiting-for-window');
    h.setTime('2026-11-07T22:59:59.999Z');
    assert.equal((await h.worker.tick()).status, 'waiting-for-window');
    assert.equal(h.calls.length, 0);
    h.setTime(PERMIT.expiresAt);
    assert.equal((await h.worker.tick()).status, 'expired');
    h.setTime('2026-11-08T17:00:00.000Z');
    assert.equal((await h.worker.tick()).status, 'expired');
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.getCreatorBudgetTest(PERMIT.permitId), null);
  } finally { h.store.close(); }
});

test('spend threshold uses integer money; stale, absent and wrong-campaign snapshots do not dispatch', async () => {
  let current;
  const h = harness({ snapshot: () => current });
  try {
    for (const patch of [{ costMinor: 239999 }, { costMinor: null }, { dailyBudgetMinor: 300001 },
      { campaignId: '1881012999140370' }, { nativeAutoBudgetState: 'ENABLED' }, { nativeAutoBudgetState: 'CONFLICT' },
      { observedAt: '2026-11-07T22:00:00.000Z' }, { advertiserId: 'other' }, { reportingDate: '2026-11-07' }]) {
      current = h.snapshot(patch);
      await h.worker.tick();
      assert.equal(h.calls.length, 0, JSON.stringify(patch));
    }
    current = { ...h.snapshot(), stale: true };
    await h.worker.tick();
    assert.equal(h.calls.length, 0);
    current = h.snapshot();
    await h.worker.tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.store.getCreatorBudgetTest(PERMIT.permitId).state, 'TERMINAL');
    assert.equal(current.snapshot.gmvMinor, null); // Missing sales metrics are never invented as zero.
  } finally { h.store.close(); }
});

test('one controlled success has exact body/key, no redirects, owner-only notification, no general Auto', async () => {
  const h = harness();
  try {
    await Promise.all(Array.from({ length: 5 }, () => h.worker.tick()));
    await h.worker.tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, CREATOR_BUDGET_TEST_URL);
    assert.equal(h.calls[0].redirect, 'error');
    assert.equal(h.calls[0].headers['X-Creator-Budget-Test-Key'], KEY);
    assert.equal(h.calls[0].headers['X-Creator-Read-Key'], undefined);
    assert.deepEqual(JSON.parse(h.calls[0].body), {
      permitId: PERMIT.permitId, policyRevision: 1, campaignId: PERMIT.campaignId,
      expectedBudgetMinor: 300000, targetBudgetMinor: 360000, capMinor: 1000000,
    });
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].ownerLineUserId, OWNER);
    assert.equal(h.notifications[0].clientId, PERMIT.clientId);
    assert.equal(h.notifications[0].status, 'SUCCEEDED');
    assert.match(h.notifications[0].message, /TikTok ยืนยัน/);
    assert.equal(h.worker.health().generalAutoOptimizationEnabled, false);
    assert.equal(h.store.getCreatorPolicy().executionEnabled, false);
    assert.equal(h.store.getCreatorPolicy().mode, 'AUTO_PENDING_TEST');
    assert.equal(h.store.getCreatorBudgetTestLock(), null);
    assert.equal(JSON.stringify(h.worker.health()).includes(KEY), false);
    assert.equal(JSON.stringify(h.store.getCreatorBudgetTest(PERMIT.permitId)).includes(KEY), false);
  } finally { h.store.close(); }
});

test('policy revision or cap lowered before dispatch requires new authorization, not stale 10000', async () => {
  const h = harness();
  try {
    const proposal = h.store.proposeCreatorCapChange({ clientId: PERMIT.clientId, ownerLineUserId: OWNER, capMinor: 900000, sourceEventId: 'lower-cap', now: AT });
    h.store.confirmCreatorCapChange({ nonce: proposal.change.nonce, ownerLineUserId: OWNER, now: AT });
    const health = await h.worker.tick();
    assert.equal(health.status, 'blocked');
    assert.equal(health.reason, 'CREATOR_BUDGET_TEST_POLICY_CHANGED');
    assert.equal(h.calls.length, 0);
  } finally { h.store.close(); }
});

test('PAUSED/AUTO or unverified multiple owners cannot be used for the controlled pending test', async () => {
  for (const mutate of [
    store => store.db.prepare("UPDATE creator_auto_policies SET mode = 'PAUSED'").run(),
    store => store.db.prepare("UPDATE creator_auto_policies SET mode = 'AUTO', execution_enabled = 1").run(),
    store => pair(store, 'U-second-owner'),
    store => store.db.prepare('UPDATE line_approvers SET active = 0').run(),
  ]) {
    const h = harness();
    try { mutate(h.store); assert.equal((await h.worker.tick()).status, 'blocked'); assert.equal(h.calls.length, 0); }
    finally { h.store.close(); }
  }
});

test('pending dispatch serializes cap confirmation; unknown/404 do not release the lock', async () => {
  let settle;
  const waiting = new Promise(resolve => { settle = resolve; });
  const h = harness({ fetchImpl: async (_url, init) => init.method === 'GET'
    ? reply(result('NOT_FOUND', { postCount: 0, providerAccepted: null, observedBudgetMinor: null, lockSafeToRelease: false, writeAttempted: false }))
    : waiting });
  try {
    const tick = h.worker.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.store.getCreatorBudgetTestLock().state, 'SENDING');
    const proposal = h.store.proposeCreatorCapChange({ clientId: PERMIT.clientId, ownerLineUserId: OWNER, capMinor: 900000, sourceEventId: 'blocked-during-test', now: AT });
    assert.throws(() => h.store.confirmCreatorCapChange({ nonce: proposal.change.nonce, ownerLineUserId: OWNER, now: AT }), error => error.code === 'CREATOR_BUDGET_TEST_IN_FLIGHT');
    assert.equal(h.store.getCreatorPolicy().capMinor, 1000000);
    settle(Promise.reject(new Error('timeout')));
    await tick;
    assert.equal(h.store.getCreatorBudgetTestLock().state, 'UNKNOWN');
    await h.worker.tick();
    assert.equal(h.calls.filter(call => call.url === CREATOR_BUDGET_TEST_URL && call.method === 'POST').length, 1);
    assert.equal(h.store.getCreatorBudgetTestLock().state, 'UNKNOWN');
    assert.throws(() => h.store.confirmCreatorCapChange({ nonce: proposal.change.nonce, ownerLineUserId: OWNER, now: AT }), error => error.code === 'CREATOR_BUDGET_TEST_IN_FLIGHT');
  } finally { h.store.close(); }
});

test('authoritative WAIT zero-attempt proof unlocks cap and permits fresh-policy retry', async () => {
  let first = true;
  const h = harness({ fetchImpl: async () => {
    if (first) { first = false; return reply(result('WAIT', { postCount: 0, providerAccepted: null, observedBudgetMinor: 300000, writeAttempted: false, reason: 'THRESHOLD_NOT_REACHED' })); }
    return reply(result());
  } });
  try {
    assert.equal((await h.worker.tick()).status, 'waiting-for-api-preflight');
    assert.equal(h.store.getCreatorBudgetTestLock(), null);
    assert.equal(h.notifications.length, 0);
    const change = h.store.proposeCreatorCapChange({ clientId: PERMIT.clientId, ownerLineUserId: OWNER, capMinor: 800000, sourceEventId: 'wait-new-cap', now: AT });
    h.store.confirmCreatorCapChange({ nonce: change.change.nonce, ownerLineUserId: OWNER, now: AT });
    assert.equal((await h.worker.tick()).status, 'blocked');
    assert.equal(h.calls.length, 1);
  } finally { h.store.close(); }
});

test('authoritative WAIT can retry once eligible, but a terminal result forbids another execute', async () => {
  let count = 0;
  const h = harness({ fetchImpl: async () => ++count === 1
    ? reply(result('WAIT', { postCount: 0, providerAccepted: null, observedBudgetMinor: 300000, writeAttempted: false }))
    : reply(result()) });
  try {
    await h.worker.tick(); await h.worker.tick(); await h.worker.tick();
    assert.equal(h.calls.length, 2);
    assert.equal(h.store.getCreatorBudgetTest(PERMIT.permitId).dispatchCount, 2);
    assert.equal(h.store.getCreatorBudgetTest(PERMIT.permitId).state, 'TERMINAL');
    assert.equal(h.notifications.length, 1);
  } finally { h.store.close(); }
});

test('snapshot delay crossing expiry cannot dispatch; Bangkok local-day guards are not UTC-day guards', async () => {
  let h;
  h = harness({ snapshot: () => {
    const value = h.snapshot();
    h.setTime(PERMIT.expiresAt);
    return value;
  } });
  try {
    await h.worker.tick();
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.getCreatorBudgetTest(PERMIT.permitId), null);
  } finally { h.store.close(); }
});

test('WAIT without explicit no-write and release proof is unknown, never eligible for resend', async () => {
  const h = harness({ fetchImpl: async () => reply(result('WAIT', { postCount: 0, providerAccepted: null, observedBudgetMinor: null, lockSafeToRelease: false, writeAttempted: false })) });
  try {
    await h.worker.tick(); await h.worker.tick();
    assert.equal(h.store.getCreatorBudgetTestLock().state, 'UNKNOWN');
    assert.equal(h.calls.filter(call => call.url === CREATOR_BUDGET_TEST_URL).length, 1);
  } finally { h.store.close(); }
});

test('process restart recovers timeout with GET/reconcile only; observed target never claims attributable success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ppan-budget-test-'));
  const file = join(directory, 'state.sqlite');
  let store = new SqliteStore(file);
  try {
    pair(store); store.ensureCreatorPolicy({ now: AT });
    const first = harness({ store, fetchImpl: async () => { throw new Error(`private ${KEY}`); } });
    await first.worker.tick();
    assert.equal(first.calls.length, 1);
    assert.equal(store.getCreatorBudgetTestLock().state, 'UNKNOWN');
    store.close();
    store = new SqliteStore(file);
    const second = harness({ store, fetchImpl: async (_url, init) => init.method === 'GET'
      ? reply(result('OUTCOME_UNKNOWN', { providerAccepted: null, observedBudgetMinor: null, lockSafeToRelease: false }))
      : reply(result('RECONCILED_TARGET_OBSERVED', { providerAccepted: null, lockSafeToRelease: false })) });
    await second.worker.tick(); await second.worker.tick();
    assert.equal(second.calls.some(call => call.url === CREATOR_BUDGET_TEST_URL), false);
    assert.equal(second.calls[0].method, 'GET');
    assert.equal(second.calls[1].url, `${CREATOR_BUDGET_TEST_URL}/${PERMIT.permitId}/reconcile`);
    assert.equal(second.calls[1].body, undefined);
    assert.equal(store.getCreatorBudgetTestLock().state, 'UNKNOWN');
    assert.equal(store.getCreatorBudgetTest(PERMIT.permitId).dispatchCount, 1);
    assert.equal(second.notifications.length, 1);
    assert.match(second.notifications[0].message, /ยังยืนยันไม่ได้/);
    assert.doesNotMatch(second.notifications[0].message, /TikTok ยืนยันปรับ/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('terminal success and notification claim survive restart and uncertain notify never redelivers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ppan-budget-notification-'));
  const file = join(directory, 'state.sqlite');
  let store = new SqliteStore(file);
  let deliveries = 0;
  try {
    pair(store); store.ensureCreatorPolicy({ now: AT });
    const first = harness({ store, notify: async () => { deliveries++; throw new Error('notification response lost'); } });
    await first.worker.tick();
    store.close();
    store = new SqliteStore(file);
    const second = harness({ store, notify: async () => { deliveries++; } });
    await second.worker.tick();
    assert.equal(deliveries, 1);
    assert.equal(second.calls.length, 0);
    assert.equal(second.worker.health().status, 'completed');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('two SQLite connections serialize one dispatch and never turn an in-flight status read into another execute', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ppan-budget-race-'));
  const firstStore = new SqliteStore(join(directory, 'state.sqlite'));
  const secondStore = new SqliteStore(join(directory, 'state.sqlite'));
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  try {
    pair(firstStore); firstStore.ensureCreatorPolicy({ now: AT });
    const first = harness({ store: firstStore, fetchImpl: () => pending });
    const second = harness({ store: secondStore, fetchImpl: async () => reply(result('SEND_RESERVED', {
      providerAccepted: null, observedBudgetMinor: null, lockSafeToRelease: false,
    })) });
    const inFlight = first.worker.tick();
    await new Promise(resolve => setImmediate(resolve));
    await second.worker.tick();
    assert.equal(first.calls.length, 1);
    assert.equal(second.calls.some(call => call.url === CREATOR_BUDGET_TEST_URL), false);
    assert.equal(secondStore.getCreatorBudgetTestLock().state, 'UNKNOWN');
    settle(reply(result()));
    await inFlight;
    assert.equal(firstStore.getCreatorBudgetTest(PERMIT.permitId).state, 'TERMINAL');
    await second.worker.tick();
    assert.equal(first.calls.length, 1);
    assert.equal(firstStore.getCreatorBudgetTest(PERMIT.permitId).dispatchCount, 1);
  } finally { firstStore.close(); secondStore.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('changed/replayed permit or a second permit for the same Bangkok day cannot create another test', async () => {
  const h = harness();
  try {
    await h.worker.tick();
    const changed = harness({ store: h.store, permit: { ...PERMIT, expiresAt: '2026-11-08T15:00:00.000Z' } });
    assert.equal((await changed.worker.tick()).reason, 'PERMIT_CHANGED');
    assert.equal(changed.calls.length, 0);
    const different = harness({ store: h.store, permit: { ...PERMIT, permitId: `${PERMIT.permitId}-again` } });
    assert.equal((await different.worker.tick()).reason, 'CREATOR_BUDGET_TEST_DAY_CONFLICT');
    assert.equal(different.calls.length, 0);
  } finally { h.store.close(); }
});

test('read-only recovery may run after expiry but financial execute may never run again', async () => {
  let failed = false;
  const h = harness({ fetchImpl: async (_url, init) => {
    if (!failed) { failed = true; throw new Error('timeout'); }
    return reply(result('FAILED_REJECTED', { providerAccepted: false, observedBudgetMinor: 300000 }));
  } });
  try {
    await h.worker.tick();
    h.setTime('2026-11-08T18:00:00.000Z');
    await h.worker.tick();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].method, 'GET');
    assert.equal(h.store.getCreatorBudgetTestLock(), null);
    assert.equal(h.worker.health().status, 'completed');
  } finally { h.store.close(); }
});

test('unexpected bodies, 5xx, redirect errors, and malformed success keep cap locked and never resend', async () => {
  for (const fetchImpl of [
    async () => reply({ token: KEY }),
    async () => reply(result('SUCCEEDED', { providerAccepted: false })),
    async () => reply(result(), 503),
    async () => { throw new Error('redirect'); },
    async () => reply(result('SUCCEEDED', { observedBudgetMinor: 359999 })),
    async () => reply(result('SUCCEEDED', { writeAttempted: false })),
  ]) {
    const h = harness({ fetchImpl });
    try {
      await h.worker.tick(); await h.worker.tick();
      assert.equal(h.store.getCreatorBudgetTestLock().state, 'UNKNOWN');
      assert.equal(h.calls.filter(call => call.url === CREATOR_BUDGET_TEST_URL).length, 1);
      assert.equal(JSON.stringify(h.store.getCreatorBudgetTest(PERMIT.permitId)).includes(KEY), false);
    } finally { h.store.close(); }
  }
});

test('proven reject/not-sent closes test without claiming success; revoked owner is never notified', async () => {
  for (const response of [
    result('REJECTED', { postCount: 0, writeAttempted: false, providerAccepted: null, observedBudgetMinor: null }),
    result('FAILED_REJECTED', { providerAccepted: false, observedBudgetMinor: 300000 }),
    result('FAILED_NOT_SENT', { writeAttempted: false, providerAccepted: false, observedBudgetMinor: null }),
  ]) {
    const h = harness({ fetchImpl: async () => reply(response, response.status === 'REJECTED' ? 409 : 200) });
    try {
      await h.worker.tick(); await h.worker.tick();
      assert.equal(h.calls.length, 1);
      assert.equal(h.store.getCreatorBudgetTestLock(), null);
      assert.equal(h.notifications.length, 1);
      assert.doesNotMatch(h.notifications[0].message, /TikTok ยืนยันปรับ/);
    } finally { h.store.close(); }
  }
  let h;
  h = harness({ fetchImpl: async () => {
    h.store.db.prepare('UPDATE line_approvers SET active = 0').run();
    return reply(result());
  } });
  try { await h.worker.tick(); assert.equal(h.notifications.length, 0); } finally { h.store.close(); }
});
