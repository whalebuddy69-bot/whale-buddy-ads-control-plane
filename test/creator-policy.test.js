import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../src/store.js';
import {
  buildCreatorCapProposalMessage,
  buildCreatorCapResultMessage,
  buildCreatorPolicyStatusMessage,
  parseCreatorCapAmount,
  parseCreatorPolicyPostback,
  parseCreatorPolicyText,
} from '../src/creator-policy.js';

const CLIENT = 'punpan_020';
const OWNER = 'U-creator-owner';
const AT = '2026-11-06T08:30:00.000Z';
const LATER = '2026-11-06T08:31:00.000Z';
const code = value => error => error?.code === value;
function pair(store, user = OWNER) {
  const hash = createHash('sha256').update(user).digest('hex');
  store.createLinePairing({ clientId: CLIENT, codeHash: hash, createdAt: AT, expiresAt: '2026-11-06T08:40:00.000Z' });
  store.consumeLinePairing({ clientId: CLIENT, codeHash: hash, lineUserId: user, consumedAt: AT });
}
function harness() {
  const store = new SqliteStore();
  pair(store);
  store.ensureCreatorPolicy({ clientId: CLIENT, now: AT });
  const propose = (overrides = {}) => store.proposeCreatorCapChange({ clientId: CLIENT, ownerLineUserId: OWNER, capMinor: 900_000, sourceEventId: 'line-cap-event-1', now: AT, ...overrides });
  const confirm = (nonce, overrides = {}) => store.confirmCreatorCapChange({ nonce, ownerLineUserId: OWNER, now: LATER, ...overrides });
  return { store, propose, confirm };
}

test('strict money parsing preserves cents and rejects malformed, zero, unsafe, exponent and signed values', () => {
  for (const [value, expected] of [['10000', 1_000_000], ['10,000', 1_000_000], ['1,000.25', 100_025], ['0.01', 1], ['１００００', 1_000_000], ['90071992547409.91', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(parseCreatorCapAmount(value), expected);
  }
  for (const value of ['0', '-1', '+1', '1e4', 'NaN', 'Infinity', '10,00', ',100', '00', '1.001', '1.', '10000 บาท', ' 100 ', '90071992547409.92', '1\n2', '', null, 100]) {
    assert.equal(parseCreatorCapAmount(value), null, String(value));
  }
});

test('only explicit Ppan aliases and exact one-line commands are accepted', () => {
  assert.deepEqual(parseCreatorPolicyText('ตั้งเพดาน Ppan 10,000'), { kind: 'creator_cap_propose', clientAlias: 'Ppan', capMinor: 1_000_000 });
  assert.deepEqual(parseCreatorPolicyText('ดูเพดาน punpan_020'), { kind: 'creator_cap_view', clientAlias: 'punpan_020' });
  assert.equal(parseCreatorPolicyText('ตั้งเพดาน other-client 10000'), null);
  assert.equal(parseCreatorPolicyText('ตั้งเพดาน 7666005333864644624 10000'), null);
  assert.equal(parseCreatorPolicyText('ตั้งเพดาน Ppan 10000 extra'), null);
  assert.equal(parseCreatorPolicyText('ตั้งเพดาน Ppan -1'), null);
  assert.equal(parseCreatorPolicyText('ดูเพดาน Ppan\nตั้งเพดาน Ppan 10000'), null);
});

test('postbacks allow only one action and one bounded opaque nonce', () => {
  const nonce = `cc_${'a'.repeat(32)}`;
  assert.deepEqual(parseCreatorPolicyPostback(`action=creator-cap-confirm&nonce=${nonce}`), { kind: 'creator_cap_confirm', nonce });
  assert.deepEqual(parseCreatorPolicyPostback(`action=creator-cap-cancel&nonce=${nonce}`), { kind: 'creator_cap_cancel', nonce });
  for (const value of [`action=creator-cap-confirm&nonce=${nonce}&nonce=${nonce}`, `action=creator-cap-confirm&nonce=${nonce}&client=other`, 'action=creator-cap-confirm&nonce=bad', `action=other&nonce=${nonce}`]) assert.equal(parseCreatorPolicyPostback(value), null);
});

test('default current CF policy is durable, revisioned, and never enables real execution', () => {
  const store = new SqliteStore();
  try {
    const first = store.ensureCreatorPolicy({ clientId: CLIENT, now: AT });
    assert.equal(first.capMinor, 1_000_000);
    assert.equal(first.campaignCapMinor, first.clientDailyCapMinor);
    assert.equal(first.thresholdBps, 8000);
    assert.equal(first.increaseBps, 2000);
    assert.equal(first.mode, 'AUTO_PENDING_TEST');
    assert.equal(first.executionEnabled, false);
    assert.equal(first.timezone, 'Asia/Bangkok');
    assert.deepEqual(store.ensureCreatorPolicy({ clientId: CLIENT, now: LATER }), first);
    assert.equal(store.listAuditEvents({ eventType: 'CREATOR_POLICY_INITIALIZED' }).length, 1);
    assert.throws(() => store.ensureCreatorPolicy({ clientId: 'other', now: AT }), code('CREATOR_POLICY_CLIENT_NOT_ALLOWED'));
  } finally { store.close(); }
});

test('unauthorized owners cannot initialize proposals or change policy', () => {
  const store = new SqliteStore();
  try {
    assert.throws(() => store.proposeCreatorCapChange({ clientId: CLIENT, ownerLineUserId: OWNER, capMinor: 100_000, sourceEventId: 'unauthorized', now: AT }), code('LINE_NOT_AUTHORIZED'));
    assert.equal(store.getCreatorPolicy({ clientId: CLIENT }), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM creator_cap_changes').get().n, 0);
  } finally { store.close(); }
});

test('cap proposal changes nothing until confirmed, then applies the same campaign and client-day caps atomically', () => {
  const { store, propose, confirm } = harness();
  try {
    const pending = propose();
    assert.equal(pending.status, 'PENDING');
    assert.equal(store.getCreatorPolicy({ clientId: CLIENT }).capMinor, 1_000_000);
    assert.equal(pending.change.expiresAt, '2026-11-06T08:45:00.000Z');
    const result = confirm(pending.change.nonce);
    assert.equal(result.status, 'CONFIRMED');
    assert.equal(result.policy.revision, 2);
    assert.equal(result.policy.campaignCapMinor, 900_000);
    assert.equal(result.policy.clientDailyCapMinor, 900_000);
    assert.equal(result.policy.executionEnabled, false);
    assert.equal(result.policy.mode, 'AUTO_PENDING_TEST');
    assert.equal(store.listAuditEvents({ eventType: 'CREATOR_CAP_CONFIRMED' }).length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM execution_jobs').get().n, 0);
  } finally { store.close(); }
});

test('source-event redelivery reuses the proposal and conflicting reuse fails', () => {
  const { store, propose } = harness();
  try {
    const first = propose();
    const replay = propose({ now: LATER });
    assert.equal(replay.status, 'ALREADY_PENDING');
    assert.equal(replay.change.nonce, first.change.nonce);
    assert.equal(replay.change.expiresAt, first.change.expiresAt);
    assert.equal(store.listAuditEvents({ eventType: 'CREATOR_CAP_PROPOSED' }).length, 1);
    assert.throws(() => propose({ capMinor: 800_000 }), code('CREATOR_CAP_EVENT_CONFLICT'));
  } finally { store.close(); }
});

test('newer proposals supersede earlier pending proposals without applying either', () => {
  const { store, propose, confirm } = harness();
  try {
    const old = propose();
    const newer = propose({ sourceEventId: 'line-cap-event-2', capMinor: 700_000, now: LATER });
    assert.equal(store.getCreatorCapChange(old.change.nonce).status, 'CANCELLED');
    assert.throws(() => confirm(old.change.nonce), code('CREATOR_CAP_CANCELLED'));
    assert.equal(store.getCreatorPolicy({ clientId: CLIENT }).capMinor, 1_000_000);
    assert.equal(confirm(newer.change.nonce, { now: '2026-11-06T08:32:00.000Z' }).policy.capMinor, 700_000);
  } finally { store.close(); }
});

test('even another paired owner cannot use a pending confirmation nonce', () => {
  const { store, propose, confirm } = harness();
  try {
    pair(store, 'U-other-paired');
    const pending = propose();
    assert.throws(() => confirm(pending.change.nonce, { ownerLineUserId: 'U-other-paired' }), code('LINE_NOT_AUTHORIZED'));
    assert.throws(() => store.cancelCreatorCapChange({ nonce: pending.change.nonce, ownerLineUserId: 'U-other-paired', now: LATER }), code('LINE_NOT_AUTHORIZED'));
    assert.equal(store.getCreatorCapChange(pending.change.nonce).status, 'PENDING');
  } finally { store.close(); }
});

test('expired, future-created, and revoked-owner confirmations fail closed', () => {
  const { store, propose, confirm } = harness();
  try {
    const pending = propose();
    assert.throws(() => confirm(pending.change.nonce, { now: pending.change.expiresAt }), code('CREATOR_CAP_EXPIRED'));
    assert.throws(() => confirm(pending.change.nonce, { now: '2026-11-06T08:29:59.000Z' }), code('CREATOR_CAP_TIME_INVALID'));
    store.db.prepare('UPDATE line_approvers SET active = 0 WHERE client_id = ? AND line_user_id = ?').run(CLIENT, OWNER);
    assert.throws(() => confirm(pending.change.nonce), code('LINE_NOT_AUTHORIZED'));
    assert.equal(store.getCreatorPolicy({ clientId: CLIENT }).revision, 1);
  } finally { store.close(); }
});

test('policy revision changes reject an otherwise valid pending confirmation', () => {
  const { store, propose, confirm } = harness();
  try {
    pair(store, 'U-second-owner');
    const first = propose();
    const second = propose({ ownerLineUserId: 'U-second-owner', sourceEventId: 'second-owner-event', capMinor: 800_000 });
    confirm(second.change.nonce, { ownerLineUserId: 'U-second-owner' });
    assert.throws(() => confirm(first.change.nonce), code('CREATOR_POLICY_CHANGED'));
    assert.equal(store.getCreatorPolicy({ clientId: CLIENT }).capMinor, 800_000);
  } finally { store.close(); }
});

test('confirm/cancel redelivery is idempotent and never undoes a confirmed policy', () => {
  const { store, propose, confirm } = harness();
  try {
    const first = propose();
    const cancelled = store.cancelCreatorCapChange({ nonce: first.change.nonce, ownerLineUserId: OWNER, now: LATER });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(store.cancelCreatorCapChange({ nonce: first.change.nonce, ownerLineUserId: OWNER, now: LATER }).status, 'ALREADY_CANCELLED');
    assert.throws(() => confirm(first.change.nonce), code('CREATOR_CAP_CANCELLED'));
    const second = propose({ sourceEventId: 'second-event' });
    confirm(second.change.nonce);
    assert.equal(confirm(second.change.nonce).status, 'ALREADY_CONFIRMED');
    assert.equal(store.cancelCreatorCapChange({ nonce: second.change.nonce, ownerLineUserId: OWNER, now: LATER }).status, 'ALREADY_CONFIRMED');
    assert.equal(store.listAuditEvents({ eventType: 'CREATOR_CAP_CONFIRMED' }).length, 1);
    assert.equal(store.getCreatorPolicy({ clientId: CLIENT }).revision, 2);
  } finally { store.close(); }
});

test('new cap setting does not re-enable a paused or otherwise disabled policy', () => {
  const { store, propose, confirm } = harness();
  try {
    store.db.prepare("UPDATE creator_auto_policies SET mode = 'PAUSED', execution_enabled = 0 WHERE client_id = ?").run(CLIENT);
    const result = confirm(propose().change.nonce);
    assert.equal(result.policy.mode, 'PAUSED');
    assert.equal(result.policy.executionEnabled, false);
    assert.match(buildCreatorPolicyStatusMessage(result.policy).text, /พัก Auto/);
    for (const capMinor of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10000']) assert.throws(() => propose({ capMinor }), code('CREATOR_CAP_INVALID'));
  } finally { store.close(); }
});

test('messages distinguish cap policy from budget writes, warn about lower caps, and use bounded postbacks', () => {
  const { store, propose } = harness();
  try {
    const pending = propose();
    const status = buildCreatorPolicyStatusMessage(pending.policy);
    assert.match(status.text, /10,000/);
    assert.match(status.text, /รอผ่านการทดสอบ/);
    assert.match(status.text, /80% → เพิ่ม 20%/);
    const proposal = buildCreatorCapProposalMessage(pending.change);
    assert.equal(proposal.type, 'flex');
    assert.match(JSON.stringify(proposal), /ไม่ปรับงบ TikTok/);
    assert.match(JSON.stringify(proposal), /ไม่ได้ย้อนยอดใช้/);
    for (const button of proposal.contents.footer.contents) {
      assert.ok(button.action.label.length <= 20);
      assert.ok(button.action.data.length <= 300);
      assert.ok(parseCreatorPolicyPostback(button.action.data));
    }
    assert.match(buildCreatorCapResultMessage({ policy: pending.policy, status: 'CONFIRMED' }).text, /ยังไม่ได้ปรับงบ TikTok/);
  } finally { store.close(); }
});

test('confirmed cap survives restart and ensure never resets it to the initial default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whalebuddy-creator-cap-'));
  const path = join(dir, 'policy.sqlite');
  let store;
  try {
    store = new SqliteStore(path);
    pair(store);
    const pending = store.proposeCreatorCapChange({ clientId: CLIENT, ownerLineUserId: OWNER, capMinor: 800_000, sourceEventId: 'durable-event', now: AT });
    store.confirmCreatorCapChange({ nonce: pending.change.nonce, ownerLineUserId: OWNER, now: LATER });
    store.close();
    store = new SqliteStore(path);
    const policy = store.ensureCreatorPolicy({ clientId: CLIENT, now: '2026-11-07T08:30:00.000Z' });
    assert.equal(policy.capMinor, 800_000);
    assert.equal(policy.revision, 2);
    assert.equal(store.getCreatorCapChange(pending.change.nonce).status, 'CONFIRMED');
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
