import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../src/store.js';

const CLIENT = 'punpan_020';
const NOW = new Date('2026-11-07T07:00:00.000Z');
const COOLDOWN_MS = 15 * 60_000;
const key = (id) => `cbp_${id.repeat(64)}`;
const after = (ms, at = NOW) => new Date(at.getTime() + ms);

function reserve(store, { now = NOW, preview = key('a'), policyRevision = 1, ...overrides } = {}) {
  return store.reserveCreatorBudgetPreview({ clientId: CLIENT, key: preview, policyRevision, now,
    cooldownMs: COOLDOWN_MS, ...overrides });
}

function storeFor(t) {
  const store = new SqliteStore();
  t.after(() => store.close());
  return store;
}

test('Creator preview reservations are exclusive across connections and a restart', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'creator-preview-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const first = new SqliteStore(path);
  const second = new SqliteStore(path);
  try {
    first.ensureCreatorPolicy({ clientId: CLIENT, now: NOW });
    assert.equal(reserve(first), true);
    assert.equal(reserve(second), false);
    assert.equal(reserve(second, { now: after(COOLDOWN_MS - 1), preview: key('b') }), false);
    assert.equal(reserve(second, { now: after(COOLDOWN_MS), preview: key('b') }), true);
  } finally {
    second.close();
    first.close();
  }
  const restarted = new SqliteStore(path);
  try {
    const now = after(2 * COOLDOWN_MS);
    assert.equal(reserve(restarted, { now }), false);
    assert.equal(reserve(restarted, { now, preview: key('b') }), false);
    assert.equal(reserve(restarted, { now, preview: key('c') }), true);
  } finally {
    restarted.close();
  }
});

test('cap revisions gate each preview but do not reset dedupe or cooldown', (t) => {
  const store = storeFor(t);
  assert.equal(reserve(store), false);
  store.ensureCreatorPolicy({ clientId: CLIENT, now: NOW });
  assert.equal(reserve(store, { policyRevision: 2 }), false);
  assert.equal(reserve(store), true);

  const ownerLineUserId = 'U-owner';
  store.createLinePairing({ clientId: CLIENT, codeHash: 'e'.repeat(64), createdAt: NOW, expiresAt: after(600_000) });
  store.consumeLinePairing({ clientId: CLIENT, codeHash: 'e'.repeat(64), lineUserId: ownerLineUserId, consumedAt: NOW });
  const { change } = store.proposeCreatorCapChange({ clientId: CLIENT, ownerLineUserId,
    capMinor: 950_000, sourceEventId: 'cap-preview-test', now: after(1_000) });
  const { policy } = store.confirmCreatorCapChange({ nonce: change.nonce, ownerLineUserId, now: after(2_000) });
  assert.equal(policy.revision, 2);
  assert.equal(reserve(store, { now: after(3_000), preview: key('b'), policyRevision: 2 }), false);
  assert.equal(reserve(store, { now: after(COOLDOWN_MS), preview: key('b') }), false);
  assert.equal(reserve(store, { now: after(COOLDOWN_MS), policyRevision: 2 }), false);
  assert.equal(reserve(store, { now: after(COOLDOWN_MS), preview: key('b'), policyRevision: 2 }), true);
});

test('Creator preview reservations use Bangkok days and prune only expired days', (t) => {
  const store = storeFor(t);
  const beforeMidnight = new Date('2026-11-07T16:59:00.000Z');
  const midnight = new Date('2026-11-07T17:00:00.000Z');
  store.ensureCreatorPolicy({ clientId: CLIENT, now: NOW });
  assert.equal(reserve(store, { now: beforeMidnight }), true);
  assert.equal(reserve(store, { now: midnight, preview: key('b') }), false);
  assert.equal(reserve(store, { now: after(COOLDOWN_MS, midnight), preview: key('b') }), true);
  assert.equal(reserve(store, { now: after(7 * 86_400_000 + COOLDOWN_MS, midnight), preview: key('c') }), true);

  const rows = store.db.prepare('SELECT local_date FROM creator_budget_preview_notifications ORDER BY local_date').all();
  assert.deepEqual(rows.map((row) => row.local_date), ['2026-11-08', '2026-11-15']);
});

test('Creator preview reservation rejects invalid scope, keys, and timers', (t) => {
  const store = storeFor(t);
  store.ensureCreatorPolicy({ clientId: CLIENT, now: NOW });
  assert.throws(() => reserve(store, { clientId: 'other' }), { code: 'CREATOR_POLICY_CLIENT_NOT_ALLOWED' });
  assert.throws(() => reserve(store, { preview: 'arbitrary-key' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => reserve(store, { policyRevision: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => reserve(store, { cooldownMs: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => reserve(store, { now: new Date(NaN) }), { code: 'INVALID_REQUEST' });
  assert.equal(reserve(store, { now: after(-1) }), false);
  store.db.exec("UPDATE creator_auto_policies SET mode = 'PAUSED'");
  assert.equal(reserve(store), false);
  store.db.exec("UPDATE creator_auto_policies SET mode = 'AUTO', execution_enabled = 1");
  assert.equal(reserve(store), false);
});
