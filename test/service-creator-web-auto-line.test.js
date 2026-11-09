import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CREATOR_BINDING } from '../src/creator-read.js';
import { creatorAutomationLineLabel, CREATOR_AUTO_LINE_RETRY_WINDOW_MS } from '../src/creator-web-auto-line.js';
import { BudgetGuardService } from '../src/service.js';
import { SqliteStore } from '../src/store.js';

const NOW = new Date('2026-11-08T01:00:00.000Z');
const PPAN = 'punpan_020';
const SRIHIW = 'srihiw';
const NNSHOP = 'nnshop5719';
const ASHOP = 'ashopbytheta';
const MYU = 'myushop4';
const BUBPA = 'bubpa_shop189';
const OWNER = `U${'a'.repeat(32)}`;
const REPLACEMENT = `U${'b'.repeat(32)}`;
const HASH = createHash('sha256').update(OWNER).digest('hex');
const at = (ms) => new Date(NOW.getTime() + ms);

test('Automation labels use verified TikTok handles, never arbitrary input', () => {
  assert.deepEqual([PPAN, SRIHIW, NNSHOP, ASHOP, MYU, BUBPA].map(creatorAutomationLineLabel),
    ['@punpanshop888', '@srihiw', '@nnshop5719', '@ashopbytheta', '@myushop4', '@bubpa_shop189']);
  assert.throws(() => creatorAutomationLineLabel('a_new_unverified_creator'));
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
  asUseSrihiw = false, myuUseSrihiw = false, bubpaUseSrihiw = false, fail = null } = {}) {
  const attempts = [];
  let now = NOW;
  let error = fail;
  const config = { clients: [{ id: PPAN, advertiserId: CREATOR_BINDING.advertiserId,
    lineControl: { enabled: true }, campaignSelector: { expectedTikTokAccountId: CREATOR_BINDING.tiktokAccountId } }] };
  const service = new BudgetGuardService({ config, store, creatorRead: { supports: (id) => id === PPAN },
    creatorWebLineUpdatesEnabled: true, creatorWebSrihiwLineSharedOwnerSha256: ownerHash,
    creatorWebNnshop5719LineSharedOwnerSha256: nnOwnerHash, creatorWebAshopbythetaLineSharedOwnerSha256: asOwnerHash,
    creatorWebMyushop4LineSharedOwnerSha256: myuOwnerHash, creatorWebBubpaShop189LineSharedOwnerSha256: bubpaOwnerHash,
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
