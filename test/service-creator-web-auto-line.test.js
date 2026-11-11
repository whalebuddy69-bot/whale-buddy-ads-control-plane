import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CREATOR_BINDING } from '../src/creator-read.js';
import { creatorAutomationLineLabel, CREATOR_AUTO_LINE_RETRY_WINDOW_MS } from '../src/creator-web-auto-line.js';
import { parseCreatorPolicyText } from '../src/creator-policy.js';
import { BudgetGuardService } from '../src/service.js';
import { SqliteStore } from '../src/store.js';

const NOW = new Date('2026-11-08T01:00:00.000Z');
const PPAN = 'punpan_020';
const SRIHIW = 'srihiw';
const NNSHOP = 'nnshop5719';
const ASHOP = 'ashopbytheta';
const MYU = 'myushop4';
const BUBPA = 'bubpa_shop189';
const KOOL = 'koolkool888';
const BOOM = 'boomkan';
const OWNER = `U${'a'.repeat(32)}`;
const REPLACEMENT = `U${'b'.repeat(32)}`;
const HASH = createHash('sha256').update(OWNER).digest('hex');
const at = (ms) => new Date(NOW.getTime() + ms);

test('Automation labels use verified TikTok handles, never arbitrary input', () => {
  assert.deepEqual([PPAN, SRIHIW, NNSHOP, ASHOP, MYU, BUBPA, KOOL, BOOM].map(creatorAutomationLineLabel),
    ['@punpanshop888', '@srihiw', '@nnshop5719', '@ashopbytheta', '@myushop4', '@bubpa_shop189', '@koolkool888', '@boomkan']);
  assert.throws(() => creatorAutomationLineLabel('a_new_unverified_creator'));
  assert.equal(parseCreatorPolicyText('ตั้งเพดาน koolkool888 5000'), null);
  assert.equal(parseCreatorPolicyText('ตั้งเพดาน boomkan 5000'), null);
});

function pair(store, owner, now = NOW) {
  const codeHash = createHash('sha256').update(owner).digest('hex');
  store.createLinePairing({ clientId: PPAN, codeHash, createdAt: now, expiresAt: new Date(now.getTime() + 60_000) });
  store.consumeLinePairing({ clientId: PPAN, codeHash, lineUserId: owner, consumedAt: now });
}

function setupStore(store) {
  store.ensureCreatorPolicy({ now: NOW });
  store.updateCreatorWebCap({ clientId: SRIHIW, revision: 0, capMinor: 900_000, actorUserId: 42, now: NOW });
  pair(store, OWNER);
}

function reserve(store, clientId, outcome = 'APPLIED_VERIFIED') {
  const operationId = randomUUID();
  store.acquireCreatorWebPolicyLease({ clientId, revision: 1, operationId, now: NOW, lineRecipientUserId: OWNER,
    autoBudget: { previousBudgetMinor: 300_000, targetBudgetMinor: 360_000 } });
  if (outcome) store.finishCreatorWebPolicyLease({ clientId, operationId, outcome, now: NOW });
  return operationId;
}

function serviceWith(store, { ownerHash = null, nnOwnerHash = null, asOwnerHash = null, myuOwnerHash = null, bubpaOwnerHash = null,
  koolOwnerHash = null, boomOwnerHash = null, asUseSrihiw = false, myuUseSrihiw = false, bubpaUseSrihiw = false,
  koolUseSrihiw = false, boomUseSrihiw = false, fail = null } = {}) {
  const attempts = [];
  let now = NOW;
  let error = fail;
  const config = { clients: [{ id: PPAN, advertiserId: CREATOR_BINDING.advertiserId,
    lineControl: { enabled: true }, campaignSelector: { expectedTikTokAccountId: CREATOR_BINDING.tiktokAccountId } }] };
  const service = new BudgetGuardService({ config, store, creatorRead: { supports: (id) => id === PPAN },
    creatorWebLineUpdatesEnabled: true, creatorWebSrihiwLineSharedOwnerSha256: ownerHash,
    creatorWebNnshop5719LineSharedOwnerSha256: nnOwnerHash, creatorWebAshopbythetaLineSharedOwnerSha256: asOwnerHash,
    creatorWebMyushop4LineSharedOwnerSha256: myuOwnerHash, creatorWebBubpaShop189LineSharedOwnerSha256: bubpaOwnerHash,
    creatorWebKoolkool888LineSharedOwnerSha256: koolOwnerHash, creatorWebKoolkool888LineUseSrihiwOwner: koolUseSrihiw,
    creatorWebBoomkanLineSharedOwnerSha256: boomOwnerHash, creatorWebBoomkanLineUseSrihiwOwner: boomUseSrihiw,
    creatorWebAshopbythetaLineUseSrihiwOwner: asUseSrihiw,
    creatorWebMyushop4LineUseSrihiwOwner: myuUseSrihiw, creatorWebBubpaShop189LineUseSrihiwOwner: bubpaUseSrihiw,
    now: () => now, logger: { info() {} }, line: { async push(to, msg, key) {
      attempts.push({ to, msg, key });
      if (error) throw error;
      return { duplicate: attempts.length > 1 };
    } }, tiktok: new Proxy({}, { get() { assert.fail('TikTok adapter must not be touched for notifications'); } }) });
  return { service, attempts, advance: (ms) => { now = at(ms); }, setError: (value) => { error = value; } };
}

test('only the sole current Ppan pairing is exposed as a digest for explicit Srihiw setup', t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  store.ensureCreatorPolicy({ now: NOW });
  const { service } = serviceWith(store);
  assert.equal(service.creatorWebPpanOwnerDigest(), null);
  pair(store, OWNER);
  assert.equal(service.creatorWebPpanOwnerDigest(), HASH);
  assert.equal(service.creatorWebAutoLineRecipient(SRIHIW), null);
});

test('LINE retry freezes text, recipient, and retry UUID across timeout, restart, and acceptance', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-line-test-'));
  const dbPath = join(dir, 'test.sqlite');
  const first = new SqliteStore(dbPath);
  let second;
  t.after(() => { first.close(); second?.close(); rmSync(dir, { force: true, recursive: true }); });
  setupStore(first);
  reserve(first, PPAN);
  const original = serviceWith(first, { fail: { code: 'LINE_TRANSPORT_ERROR' } });
  assert.equal((await original.service.processCreatorWebLineUpdates())[0].status, 'LINE_RETRY_PENDING');
  assert.equal((await original.service.processCreatorWebLineUpdates()).length, 0);
  second = new SqliteStore(dbPath);
  const restarted = serviceWith(second);
  restarted.advance(60_000);
  assert.equal((await restarted.service.processCreatorWebLineUpdates())[0].status, 'LINE_ACCEPTED');
  assert.equal((await restarted.service.processCreatorWebLineUpdates()).length, 0);
  assert.deepEqual(original.attempts, restarted.attempts);
  assert.match(original.attempts[0].msg.text, /^✅ @punpanshop888 — เพิ่มงบอัตโนมัติสำเร็จ/);
  assert.equal(second.listAuditEvents({ eventType: 'CREATOR_WEB_AUTO_LINE_DELIVERY' }).length, 2);
});

test('existing auto delivery SQLite rows migrate to exact-satang without changing retry identity or content', t => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-line-rounding-test-'));
  const dbPath = join(dir, 'test.sqlite');
  let store = new SqliteStore(dbPath);
  t.after(() => { store?.close(); rmSync(dir, { force: true, recursive: true }); });
  setupStore(store);
  const operationId = reserve(store, PPAN);
  const select = 'SELECT retry_key, message_text, recipient_user_id, state FROM creator_web_auto_line_deliveries WHERE operation_id = ?';
  const original = store.db.prepare(select).get(operationId);
  store.db.exec('ALTER TABLE creator_web_auto_line_deliveries DROP COLUMN rounding');
  store.close();
  store = new SqliteStore(dbPath);
  assert.deepEqual(store.db.prepare(select).get(operationId), original);
  assert.equal(store.db.prepare('SELECT rounding FROM creator_web_auto_line_deliveries WHERE operation_id = ?').get(operationId).rounding,
    'exact-satang');
});

test('ceil-baht SQLite migration preserves active floor and exact delivery proofs with their existing keys and claims', t => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-line-rounding-v2-'));
  const filename = join(dir, 'fixture.sqlite');
  let store = new SqliteStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  setupStore(store);
  const floorOp = randomUUID();
  const floorProof = { previousBudgetMinor: 40_001, targetBudgetMinor: 48_001, rounding: 'floor-satang' };
  store.acquireCreatorWebPolicyLease({ clientId: PPAN, revision: 1, operationId: floorOp, now: NOW, lineRecipientUserId: OWNER, autoBudget: floorProof });
  const exactOp = reserve(store, SRIHIW);
  assert.ok(store.claimCreatorWebAutoLineDelivery({ clientId: SRIHIW, recipientUserId: OWNER, now: NOW }));
  const table = 'creator_web_auto_line_deliveries';
  const read = () => store.db.prepare(`SELECT * FROM ${table} ORDER BY operation_id`).all();
  const before = read();
  const v2 = store.db.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').get('table', table).sql;
  const v1 = v2.replace(/^CREATE TABLE [^(]+/, 'CREATE TABLE outbox_v1 ')
    .replace(/rounding TEXT NOT NULL DEFAULT 'exact-satang'[\s\S]*?(?=,\s+retry_key)/,
      "rounding TEXT NOT NULL DEFAULT 'exact-satang'\n  CHECK(rounding = 'exact-satang' OR (rounding = 'floor-satang' AND client_id = 'punpan_020'))");
  assert.ok(!v1.includes('ceil-baht'));
  store.db.exec(`${v1}; INSERT INTO outbox_v1 SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE outbox_v1 RENAME TO ${table};`);
  store.close();
  store = new SqliteStore(filename);
  assert.deepEqual(read(), before);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(store.getCreatorWebPolicyState({ clientId: PPAN }).locked, true);
  assert.equal(store.getCreatorAutoLineResult({ clientId: SRIHIW, operationId: exactOp }), 'PENDING');
  assert.ok(store.acquireCreatorWebPolicyLease({ clientId: PPAN, revision: 1, operationId: floorOp, now: NOW, lineRecipientUserId: OWNER, autoBudget: floorProof }));
  store.close();
  store = new SqliteStore(filename);
  assert.deepEqual(read(), before);
});

test('Srihiw notifications require explicit exact pairing, never spill into manual or replacement LINE chats', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  reserve(store, SRIHIW);
  const noMapping = serviceWith(store);
  assert.equal(noMapping.service.creatorWebAutoLineRecipient(PPAN), OWNER);
  assert.equal(noMapping.service.creatorWebAutoLineRecipient(SRIHIW), null);
  assert.deepEqual(await noMapping.service.processCreatorWebLineUpdates(), []);
  assert.equal(noMapping.attempts.length, 0);
  const mapped = serviceWith(store, { ownerHash: HASH });
  assert.equal(mapped.service.creatorWebAutoLineRecipient(SRIHIW), OWNER);
  assert.equal((await mapped.service.processCreatorWebLineUpdates())[0].clientId, SRIHIW);
  assert.match(mapped.attempts[0].msg.text, /@srihiw.*เพิ่มงบอัตโนมัติสำเร็จ/);
  assert.doesNotMatch(mapped.attempts[0].msg.text, /Ppan|@punpanshop888/);
  reserve(store, SRIHIW);
  store.revokeLineApprover({ clientId: PPAN, lineUserId: OWNER, revokedAt: at(1000) });
  pair(store, REPLACEMENT, at(1000));
  mapped.advance(1000);
  assert.equal(mapped.service.creatorWebAutoLineRecipient(SRIHIW), null);
  assert.equal(mapped.service.creatorWebAutoLineRecipient(PPAN), REPLACEMENT);
  assert.deepEqual(await mapped.service.processCreatorWebLineUpdates(), []);
  assert.equal(mapped.attempts.length, 1);
});

test('new Creators require separate exact owner mappings and preserve Creator label and operation scope', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  for (const clientId of [NNSHOP, ASHOP]) {
    store.updateCreatorWebCap({ clientId, revision: 0, capMinor: 900_000, actorUserId: 42, now: NOW });
    reserve(store, clientId);
  }
  const nn = serviceWith(store, { nnOwnerHash: HASH, asOwnerHash: createHash('sha256').update(REPLACEMENT).digest('hex') });
  assert.equal(nn.service.creatorWebAutoLineRecipient(NNSHOP), OWNER);
  assert.equal(nn.service.creatorWebAutoLineRecipient(ASHOP), null);
  assert.equal(nn.service.creatorWebAutoLineRecipient(SRIHIW), null);
  assert.equal(nn.service.creatorWebAutoLineRecipient('toString'), null);
  assert.deepEqual((await nn.service.processCreatorWebLineUpdates()).map(result => result.clientId), [NNSHOP]);
  assert.match(nn.attempts[0].msg.text, /nnshop5719/);
  assert.doesNotMatch(nn.attempts[0].msg.text, /Ppan|ashopbytheta|srihiw/);
  const as = serviceWith(store, { asOwnerHash: HASH });
  assert.deepEqual((await as.service.processCreatorWebLineUpdates()).map(result => result.clientId), [ASHOP]);
  assert.match(as.attempts[0].msg.text, /ashopbytheta/);
  assert.doesNotMatch(as.attempts[0].msg.text, /Ppan|nnshop5719|srihiw/);
  assert.notEqual(as.attempts[0].key, nn.attempts[0].key);
});

test('myushop4 and bubpa need independent recipient consent and never fall back or cross-route', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  for (const clientId of [MYU, BUBPA]) {
    store.updateCreatorWebCap({ clientId, revision: 0, capMinor: 900_000, actorUserId: 42, now: NOW });
    reserve(store, clientId);
  }
  const wrongHash = createHash('sha256').update(REPLACEMENT).digest('hex');
  const onlyMyu = serviceWith(store, { asOwnerHash: HASH, myuOwnerHash: HASH, bubpaOwnerHash: wrongHash });
  assert.equal(onlyMyu.service.creatorWebAutoLineRecipient(MYU), OWNER);
  assert.equal(onlyMyu.service.creatorWebAutoLineRecipient(BUBPA), null);
  assert.deepEqual((await onlyMyu.service.processCreatorWebLineUpdates()).map(result => result.clientId), [MYU]);
  assert.equal(onlyMyu.attempts[0].to, OWNER);
  assert.match(onlyMyu.attempts[0].msg.text, /^✅ @myushop4 — /);
  const onlyBubpa = serviceWith(store, { bubpaOwnerHash: HASH });
  assert.equal(onlyBubpa.service.creatorWebAutoLineRecipient(MYU), null);
  assert.equal(onlyBubpa.service.creatorWebAutoLineRecipient(BUBPA), OWNER);
  assert.deepEqual((await onlyBubpa.service.processCreatorWebLineUpdates()).map(result => result.clientId), [BUBPA]);
  assert.match(onlyBubpa.attempts[0].msg.text, /^✅ @bubpa_shop189 — /);
  assert.notEqual(onlyBubpa.attempts[0].key, onlyMyu.attempts[0].key);
});

test('explicit per-scope Srihiw recipient opt-in fails closed for missing, conflicting, or rotated binding', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  const wrongHash = createHash('sha256').update(REPLACEMENT).digest('hex');
  const recipient = (clientId, flags) => serviceWith(store, flags).service.creatorWebAutoLineRecipient(clientId);
  assert.equal(recipient(ASHOP, { ownerHash: HASH }), null);
  assert.equal(recipient(ASHOP, { ownerHash: HASH, asUseSrihiw: 'true' }), null);
  assert.equal(recipient(ASHOP, { ownerHash: HASH, asUseSrihiw: true }), OWNER);
  assert.equal(recipient(MYU, { ownerHash: HASH, asUseSrihiw: true }), null);
  assert.equal(recipient(MYU, { myuUseSrihiw: true }), null);
  assert.equal(recipient(MYU, { myuUseSrihiw: true, ownerHash: wrongHash, myuOwnerHash: HASH }), null);
  assert.equal(recipient(MYU, { myuUseSrihiw: true, ownerHash: HASH, myuOwnerHash: wrongHash }), null);
  assert.equal(recipient(BUBPA, { bubpaUseSrihiw: true, ownerHash: HASH, bubpaOwnerHash: '' }), null);
  assert.equal(recipient(BUBPA, { bubpaUseSrihiw: true, ownerHash: HASH, bubpaOwnerHash: HASH }), OWNER);
  assert.equal(recipient(BUBPA, { bubpaOwnerHash: HASH }), OWNER);
  assert.equal(recipient(NNSHOP, { ownerHash: HASH, asUseSrihiw: true, myuUseSrihiw: true, bubpaUseSrihiw: true }), null);

  store.updateCreatorWebCap({ clientId: MYU, revision: 0, capMinor: 900_000, actorUserId: 42, now: NOW });
  reserve(store, MYU);
  const optIn = serviceWith(store, { myuUseSrihiw: true, ownerHash: HASH });
  assert.deepEqual((await optIn.service.processCreatorWebLineUpdates()).map(result => result.clientId), [MYU]);
  assert.equal(optIn.attempts[0].to, OWNER);
  assert.match(optIn.attempts[0].msg.text, /^✅ @myushop4 — /);
  reserve(store, MYU);
  store.revokeLineApprover({ clientId: PPAN, lineUserId: OWNER, revokedAt: at(1000) });
  pair(store, REPLACEMENT, at(1000));
  optIn.advance(1000);
  assert.equal(optIn.service.creatorWebAutoLineRecipient(MYU), null);
  assert.deepEqual(await optIn.service.processCreatorWebLineUpdates(), []);
  assert.equal(optIn.attempts.length, 1);
});

test('koolkool888 opts into the same private recipient only by exact verified consent', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  store.updateCreatorWebCap({ clientId: KOOL, revision: 0, capMinor: 900_000, actorUserId: 42, now: NOW });
  const operationId = reserve(store, KOOL);
  const wrongHash = createHash('sha256').update(REPLACEMENT).digest('hex');
  for (const flags of [{ ownerHash: HASH, myuUseSrihiw: true }, { koolUseSrihiw: true },
    { koolUseSrihiw: true, ownerHash: wrongHash, koolOwnerHash: HASH },
    { koolUseSrihiw: true, ownerHash: HASH, koolOwnerHash: wrongHash },
    { koolUseSrihiw: true, ownerHash: HASH, koolOwnerHash: '' }]) {
    const denied = serviceWith(store, flags);
    assert.equal(denied.service.creatorWebAutoLineRecipient(KOOL), null);
    assert.deepEqual(await denied.service.processCreatorWebLineUpdates(), []);
  }
  assert.equal(serviceWith(store, { koolOwnerHash: HASH }).service.creatorWebAutoLineRecipient(KOOL), OWNER);
  const allowed = serviceWith(store, { ownerHash: HASH, koolUseSrihiw: true });
  assert.equal(allowed.service.creatorWebAutoLineRecipient(KOOL), OWNER);
  assert.equal(allowed.service.creatorWebAutoLineRecipient(MYU), null);
  assert.deepEqual((await allowed.service.processCreatorWebLineUpdates()).map(result => result.clientId), [KOOL]);
  assert.equal(allowed.attempts[0].to, OWNER);
  assert.match(allowed.attempts[0].msg.text, /^✅ @koolkool888 — /);
  assert.equal(store.getCreatorAutoLineResult({ clientId: KOOL, operationId }), 'ACCEPTED');
});

test('boomkan opt-in never inherits another scope consent, rejects conflicting bindings, and preserves exact result and incident labels', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  store.updateCreatorWebCap({ clientId: BOOM, revision: 0, capMinor: 900_000, actorUserId: 42, now: NOW });
  const operationId = reserve(store, BOOM);
  const incident = { incidentId: randomUUID(), advertiserName: 'Boomkan Ads', tiktokUsername: BOOM, failedChecks: 10 };
  assert.equal(store.enqueueCreatorCheckFailureAlert({ clientId: BOOM, alert: incident, recipientUserId: OWNER, now: NOW }), 'PENDING');
  const wrongHash = createHash('sha256').update(REPLACEMENT).digest('hex');
  for (const flags of [{ ownerHash: HASH, koolUseSrihiw: true }, { ownerHash: HASH, boomUseSrihiw: 'true' }, { boomUseSrihiw: true },
    { ownerHash: wrongHash, boomUseSrihiw: true, boomOwnerHash: HASH },
    { ownerHash: HASH, boomUseSrihiw: true, boomOwnerHash: wrongHash },
    { ownerHash: HASH, boomUseSrihiw: true, boomOwnerHash: '' },
    { ownerHash: HASH, boomUseSrihiw: true, boomOwnerHash: 'bad-hash' }]) {
    const denied = serviceWith(store, flags);
    assert.equal(denied.service.creatorWebAutoLineRecipient(BOOM), null);
    assert.deepEqual(await denied.service.processCreatorWebLineUpdates(), []);
    assert.deepEqual(denied.attempts, []);
  }
  assert.equal(serviceWith(store, { boomOwnerHash: HASH }).service.creatorWebAutoLineRecipient(BOOM), OWNER);
  const allowed = serviceWith(store, { ownerHash: HASH, boomUseSrihiw: true });
  assert.equal(allowed.service.creatorWebAutoLineRecipient(BOOM), OWNER);
  assert.equal(allowed.service.creatorWebAutoLineRecipient(KOOL), null);
  const result = await allowed.service.processCreatorWebLineUpdates();
  assert.deepEqual(result.map(r => [r.clientId, r.type, r.status]), [[BOOM, 'AUTO_BUDGET_RESULT', 'LINE_ACCEPTED'], [BOOM, 'AUTO_CHECK_FAILURES', 'LINE_ACCEPTED']]);
  assert.equal(allowed.attempts.length, 2);
  assert.equal(allowed.attempts[0].to, OWNER);
  assert.match(allowed.attempts[0].msg.text, /^✅ @boomkan — /);
  assert.match(allowed.attempts[1].msg.text, /บัญชีโฆษณา: Boomkan Ads\nTikTok: @boomkan\n/);
  assert.equal(store.getCreatorAutoLineResult({ clientId: BOOM, operationId }), 'ACCEPTED');
  assert.equal(store.getCreatorAutoLineResult({ clientId: KOOL, operationId }), 'UNKNOWN');
  assert.deepEqual(await allowed.service.processCreatorWebLineUpdates(), []);
  reserve(store, BOOM);
  store.revokeLineApprover({ clientId: PPAN, lineUserId: OWNER, revokedAt: at(1000) });
  pair(store, REPLACEMENT, at(1000));
  allowed.advance(1000);
  assert.equal(allowed.service.creatorWebAutoLineRecipient(BOOM), null);
  assert.deepEqual(await allowed.service.processCreatorWebLineUpdates(), []);
  assert.equal(allowed.attempts.length, 2);
});

test('adding boomkan to an existing SQLite file preserves every old policy, lease fence, delivery proof and claim', t => {
  const dir = mkdtempSync(join(tmpdir(), 'boomkan-additive-test-'));
  const filename = join(dir, 'fixture.sqlite');
  let store = new SqliteStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  setupStore(store);
  for (const clientId of [NNSHOP, ASHOP, MYU, BUBPA, KOOL]) {
    store.updateCreatorWebCap({ clientId, revision: 0, capMinor: 900_000, actorUserId: 42, now: NOW });
  }
  const ppanOp = randomUUID(), ppanProof = { previousBudgetMinor: 40_001, targetBudgetMinor: 48_001, rounding: 'floor-satang' };
  store.acquireCreatorWebPolicyLease({ clientId: PPAN, revision: 1, operationId: ppanOp, now: NOW, lineRecipientUserId: OWNER, autoBudget: ppanProof });
  reserve(store, SRIHIW, 'OUTCOME_UNKNOWN');
  reserve(store, NNSHOP, null);
  const pending = reserve(store, ASHOP);
  assert.ok(store.claimCreatorWebAutoLineDelivery({ clientId: ASHOP, recipientUserId: OWNER, now: NOW }));
  const accepted = reserve(store, MYU);
  const claim = store.claimCreatorWebAutoLineDelivery({ clientId: MYU, recipientUserId: OWNER, now: NOW });
  store.finishCreatorWebAutoLineDelivery({ operationId: accepted, claimToken: claim.claimToken, result: 'ACCEPTED', now: NOW });
  reserve(store, BUBPA, 'NOT_SENT');
  const koolProof = { previousBudgetMinor: 40_001, targetBudgetMinor: 48_100, rounding: 'ceil-baht' }, koolOp = randomUUID();
  store.acquireCreatorWebPolicyLease({ clientId: KOOL, revision: 1, operationId: koolOp, now: NOW, lineRecipientUserId: OWNER, autoBudget: koolProof });
  store.finishCreatorWebPolicyLease({ clientId: KOOL, operationId: koolOp, outcome: 'APPLIED_VERIFIED', now: NOW });
  const tables = ['creator_auto_policies', 'creator_web_policy_leases', 'creator_web_auto_line_deliveries', 'creator_web_check_failure_alerts'];
  const priorRows = () => Object.fromEntries(tables.map(table => [table,
    store.db.prepare(`SELECT * FROM ${table} WHERE client_id <> ? ORDER BY rowid`).all(BOOM)]));
  const schema = () => store.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'creator_%' ORDER BY type,name").all();
  const rows = priorRows(), ddl = schema(), audit = store.listAuditEvents();
  store.close();
  store = new SqliteStore(filename);
  assert.equal(store.getCreatorWebPolicyState({ clientId: BOOM }), null);
  assert.deepEqual(priorRows(), rows);
  assert.deepEqual(schema(), ddl);
  store.updateCreatorWebCap({ clientId: BOOM, revision: 0, capMinor: 48_100, actorUserId: 42, now: NOW });
  const boomOp = randomUUID();
  store.acquireCreatorWebPolicyLease({ clientId: BOOM, revision: 1, operationId: boomOp, now: NOW, lineRecipientUserId: OWNER, autoBudget: koolProof });
  assert.equal(store.getCreatorWebPolicyState({ clientId: BOOM }).locked, true);
  for (const clientId of [PPAN, SRIHIW, NNSHOP, BOOM]) {
    assert.equal(store.getCreatorWebPolicyState({ clientId }).locked, true);
    assert.throws(() => store.acquireCreatorWebPolicyLease({ clientId, revision: 1, operationId: randomUUID(), now: at(120_000) }),
      { code: 'CREATOR_WEB_POLICY_LOCKED' });
  }
  store.finishCreatorWebPolicyLease({ clientId: BOOM, operationId: boomOp, outcome: 'APPLIED_VERIFIED', now: NOW });
  assert.equal(store.getCreatorAutoLineResult({ clientId: BOOM, operationId: pending }), 'UNKNOWN');
  assert.equal(store.getCreatorAutoLineResult({ clientId: ASHOP, operationId: boomOp }), 'UNKNOWN');
  assert.equal(store.getCreatorAutoLineResult({ clientId: BOOM, operationId: boomOp }), 'PENDING');
  assert.deepEqual(priorRows(), rows);
  assert.deepEqual(schema(), ddl);
  assert.deepEqual(store.listAuditEvents().slice(0, audit.length), audit);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  store.close();
  store = new SqliteStore(filename);
  assert.deepEqual(priorRows(), rows);
  assert.deepEqual(schema(), ddl);
});

test('check-failure LINE retries use the same key and a rotated recipient never inherits the incident', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  const incident = { incidentId: randomUUID(), advertiserName: 'Kool แอด · LIVE', tiktokUsername: KOOL, failedChecks: 10 };
  const enqueue = (alert = incident, recipientUserId = OWNER, now = NOW) => store.enqueueCreatorCheckFailureAlert({ clientId: KOOL, alert, recipientUserId, now });
  assert.equal(enqueue(), 'PENDING');
  assert.equal(enqueue(), 'PENDING');
  const noConsent = serviceWith(store, { ownerHash: HASH, myuUseSrihiw: true });
  assert.deepEqual(await noConsent.service.processCreatorWebLineUpdates(), []);
  const flaky = serviceWith(store, { koolOwnerHash: HASH, fail: Object.assign(new Error('mock transport'), { code: 'LINE_TRANSPORT_ERROR' }) });
  assert.deepEqual(await flaky.service.processCreatorWebLineUpdates(), [
    { event: 'creator_web_line_update', type: 'AUTO_CHECK_FAILURES', clientId: KOOL, status: 'LINE_RETRY_PENDING' },
  ]);
  assert.equal(flaky.attempts[0].to, OWNER);
  assert.match(flaky.attempts[0].msg.text, /ตรวจไม่สำเร็จ 10 รอบติดกัน \(ตรวจประมาณทุก 1 นาที\)\nบัญชีโฆษณา: Kool แอด · LIVE\nTikTok: @koolkool888\nตรวจสถานะบนเว็บ: https:\/\/report\.whalebuddy69\.com\/automation$/);
  assert.notEqual(flaky.attempts[0].key, incident.incidentId);
  assert.deepEqual(await flaky.service.processCreatorWebLineUpdates(), []);
  flaky.advance(60_000); flaky.setError(null);
  assert.equal((await flaky.service.processCreatorWebLineUpdates())[0].status, 'LINE_ACCEPTED');
  assert.equal(flaky.attempts[1].key, flaky.attempts[0].key);
  assert.equal(enqueue(incident, OWNER, at(60_000)), 'ACCEPTED');
  assert.deepEqual(await flaky.service.processCreatorWebLineUpdates(), []);

  const retained = { ...incident, incidentId: randomUUID() };
  assert.equal(enqueue(retained, OWNER, at(60_000)), 'PENDING');
  store.revokeLineApprover({ clientId: PPAN, lineUserId: OWNER, revokedAt: at(61_000) });
  pair(store, REPLACEMENT, at(61_000));
  const replacementHash = createHash('sha256').update(REPLACEMENT).digest('hex');
  const replacement = serviceWith(store, { koolOwnerHash: replacementHash });
  replacement.advance(62_000);
  assert.deepEqual(await replacement.service.processCreatorWebLineUpdates(), []);
  assert.throws(() => enqueue(retained, REPLACEMENT, at(62_000)), { code: 'CREATOR_WEB_CHECK_FAILURE_CONFLICT' });
  assert.deepEqual(replacement.attempts, []);
});

test('claim survives a crash and expires before LINE could forget deduplication; 4xx is not retried', async t => {
  const store = new SqliteStore();
  t.after(() => store.close());
  setupStore(store);
  const operationId = reserve(store, PPAN);
  const claim = (now) => store.claimCreatorWebAutoLineDelivery({ clientId: PPAN, recipientUserId: OWNER, now });
  const original = claim(NOW);
  assert.equal(original.operationId, operationId);
  assert.equal(claim(at(44_999)), null);
  const recovered = claim(at(45_000));
  assert.equal(recovered.retryKey, original.retryKey);
  assert.equal(recovered.messageText, original.messageText);
  assert.notEqual(recovered.claimToken, original.claimToken);
  assert.equal(store.finishCreatorWebAutoLineDelivery({ operationId, claimToken: original.claimToken, result: 'ACCEPTED', now: at(45_000) }), false);
  assert.equal(claim(at(CREATOR_AUTO_LINE_RETRY_WINDOW_MS)), null);
  const { state } = store.db.prepare('SELECT state FROM creator_web_auto_line_deliveries WHERE operation_id = ?').get(operationId);
  assert.equal(state, 'EXPIRED');
  reserve(store, PPAN);
  const failed = serviceWith(store, { fail: { status: 400 } });
  assert.equal((await failed.service.processCreatorWebLineUpdates())[0].status, 'LINE_UNCONFIRMED');
  failed.advance(60_000);
  assert.deepEqual(await failed.service.processCreatorWebLineUpdates(), []);
  assert.equal(failed.attempts.length, 1);
});
