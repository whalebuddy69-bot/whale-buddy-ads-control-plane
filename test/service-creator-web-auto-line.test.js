import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CREATOR_BINDING } from '../src/creator-read.js';
import { CREATOR_AUTO_LINE_RETRY_WINDOW_MS } from '../src/creator-web-auto-line.js';
import { BudgetGuardService } from '../src/service.js';
import { SqliteStore } from '../src/store.js';

const NOW = new Date('2026-11-08T01:00:00.000Z');
const PPAN = 'punpan_020';
const SRIHIW = 'srihiw';
const OWNER = `U${'a'.repeat(32)}`;
const REPLACEMENT = `U${'b'.repeat(32)}`;
const HASH = createHash('sha256').update(OWNER).digest('hex');
const at = (ms) => new Date(NOW.getTime() + ms);

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

function serviceWith(store, { ownerHash = null, fail = null } = {}) {
  const attempts = [];
  let now = NOW;
  let error = fail;
  const config = { clients: [{ id: PPAN, advertiserId: CREATOR_BINDING.advertiserId,
    lineControl: { enabled: true }, campaignSelector: { expectedTikTokAccountId: CREATOR_BINDING.tiktokAccountId } }] };
  const service = new BudgetGuardService({ config, store, creatorRead: { supports: (id) => id === PPAN },
    creatorWebLineUpdatesEnabled: true, creatorWebSrihiwLineSharedOwnerSha256: ownerHash,
    now: () => now, logger: { info() {} }, line: { async push(to, msg, key) {
      attempts.push({ to, msg, key });
      if (error) throw error;
      return { duplicate: attempts.length > 1 };
    } }, tiktok: new Proxy({}, { get() { assert.fail('TikTok adapter must not be touched for notifications'); } }) });
  return { service, attempts, advance: (ms) => { now = at(ms); }, setError: (value) => { error = value; } };
}

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
  assert.equal(second.listAuditEvents({ eventType: 'CREATOR_WEB_AUTO_LINE_DELIVERY' }).length, 2);
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
  assert.match(mapped.attempts[0].msg.text, /srihiw.*เพิ่มงบอัตโนมัติสำเร็จ/);
  assert.doesNotMatch(mapped.attempts[0].msg.text, /Ppan/);
  reserve(store, SRIHIW);
  store.revokeLineApprover({ clientId: PPAN, lineUserId: OWNER, revokedAt: at(1000) });
  pair(store, REPLACEMENT, at(1000));
  mapped.advance(1000);
  assert.equal(mapped.service.creatorWebAutoLineRecipient(SRIHIW), null);
  assert.equal(mapped.service.creatorWebAutoLineRecipient(PPAN), REPLACEMENT);
  assert.deepEqual(await mapped.service.processCreatorWebLineUpdates(), []);
  assert.equal(mapped.attempts.length, 1);
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
