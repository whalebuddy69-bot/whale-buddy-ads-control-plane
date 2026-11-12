import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveCreatorWebPolicyOptions } from '../src/creator-web-policy.js';
import { createHttpServer } from '../src/server.js';
import { SqliteStore } from '../src/store.js';

const CLIENT = 'bubpa_shop189';
const ROOT = '/internal/automation/bubpa_shop189/policy';
const KEY = 'R'.repeat(43);
const OWNER = `U${'9'.repeat(32)}`;
const NOW = new Date('2026-11-13T04:00:00.000Z');
const OLD_CAMPAIGN = '1881580307345762';
const NEW_CAMPAIGN = '1881670184981538';
const OLD_PROOF = { previousBudgetMinor: 240_000, targetBudgetMinor: 288_000, rounding: 'ceil-baht' };

function fixture(store = new SqliteStore()) {
  store.ensureCreatorPolicy({ now: NOW });
  store.updateCreatorWebCap({ clientId: CLIENT, revision: 0, capMinor: 1_000_000, actorUserId: 42, now: NOW });
  const codeHash = createHash('sha256').update(OWNER).digest('hex');
  store.createLinePairing({ clientId: 'punpan_020', codeHash, createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000) });
  store.consumeLinePairing({ clientId: 'punpan_020', codeHash, lineUserId: OWNER, consumedAt: NOW });
  const oldOperationId = randomUUID();
  store.acquireCreatorWebPolicyLease({ clientId: CLIENT, operationId: oldOperationId, revision: 1, now: NOW,
    autoBudget: OLD_PROOF, lineRecipientUserId: OWNER });
  store.finishCreatorWebPolicyLease({ clientId: CLIENT, operationId: oldOperationId, outcome: 'OUTCOME_UNKNOWN', now: NOW });
  const proof = { recoveryId: randomUUID(), operatorUserId: 42, oldOperationId, oldCampaignId: OLD_CAMPAIGN,
    newCampaignId: NEW_CAMPAIGN, revision: 1, acknowledgedUnknown: true };
  return { store, proof, oldOperationId };
}

async function http(t, { enabled = true, leaseEnabled = true, f = fixture() } = {}) {
  t.after(() => f.store.close());
  const server = createHttpServer({ store: f.store, clock: () => NOW,
    service: { creatorWebAutoLineRecipient: clientId => clientId === CLIENT ? OWNER : null },
    creatorWebPolicyOptions: { key: KEY, leaseEnabled: true, bubpaShop189RecoveryEnabled: enabled, bubpaShop189LeaseEnabled: leaseEnabled, capWriteEnabled: true } });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, input, headers = {}) => {
    const res = await fetch(`${url}${path}`, { headers: { 'x-creator-web-key': KEY,
      ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    return { status: res.status, body: await res.json() };
  };
  return { ...f, request, recover: (input = f.proof, headers) => request(`${ROOT}/recover-unknown`, input, headers) };
}

test('UNKNOWN recovery is exact-scope, server-only, separately opt-in and requires the full operator acknowledgement', async t => {
  const disabled = await http(t, { enabled: false });
  assert.equal((await disabled.recover()).body.error.code, 'RECOVERY_DISABLED');
  const noLease = await http(t, { leaseEnabled: false });
  assert.equal((await noLease.recover()).body.error.code, 'LEASE_DISABLED');
  const h = await http(t);
  assert.equal((await h.request(`${ROOT}/recover-unknown`)).status, 405);
  assert.equal((await h.recover(h.proof, { origin: 'https://report.whalebuddy69.com' })).status, 403);
  assert.equal((await h.recover(h.proof, { cookie: 'owner=not-authority' })).status, 403);
  assert.equal((await h.recover(h.proof, { 'x-creator-web-key': 'wrong' })).status, 401);
  for (const input of [{ ...h.proof, acknowledgedUnknown: false }, { ...h.proof, acknowledgedUnknown: 'true' },
    { ...h.proof, oldCampaignId: NEW_CAMPAIGN }, { ...h.proof, newCampaignId: Number(NEW_CAMPAIGN) },
    { ...h.proof, operatorUserId: '42' }, { ...h.proof, recoveryId: 'not-a-uuid' }, { ...h.proof, extra: true }]) {
    assert.equal((await h.recover(input)).status, 400);
  }
  const { acknowledgedUnknown, ...missing } = h.proof;
  assert.equal((await h.recover(missing)).status, 400);
  for (const scope of ['ppan', 'srihiw', 'myushop4', 'BUBPA_SHOP189']) {
    assert.equal((await h.request(`/internal/automation/${scope}/policy/recover-unknown`, h.proof)).status, 404);
  }
  for (const flag of [undefined, false, true, 'True', '1', 'false']) assert.equal(resolveCreatorWebPolicyOptions({
    CREATOR_WEB_POLICY_BRIDGE_KEY: KEY, CREATOR_WEB_BUBPA_SHOP189_RECOVERY_ENABLED: flag,
  }, { controlPlaneOnly: true, creatorReadEnabled: true }).bubpaShop189RecoveryEnabled, false);
  assert.equal(resolveCreatorWebPolicyOptions({ CREATOR_WEB_POLICY_BRIDGE_KEY: KEY, CREATOR_WEB_BUBPA_SHOP189_RECOVERY_ENABLED: 'true' },
    { controlPlaneOnly: true, creatorReadEnabled: true }).bubpaShop189RecoveryEnabled, true);
  assert.equal(h.store.getCreatorWebPolicyState({ clientId: CLIENT }).locked, true);
});

test('recovery preserves UNKNOWN and reserved history, restricts the replacement campaign, and never emits old success', async t => {
  const h = await http(t);
  const oldLease = h.store.db.prepare('SELECT * FROM creator_web_policy_leases WHERE operation_id=?').get(h.oldOperationId);
  const oldOutbox = h.store.db.prepare('SELECT * FROM creator_web_auto_line_deliveries WHERE operation_id=?').get(h.oldOperationId);
  const oldPolicy = h.store.getCreatorWebPolicyState({ clientId: CLIENT }).policy;
  const expected = { schemaVersion: 1, clientId: CLIENT, recoveryId: h.proof.recoveryId, oldOperationId: h.oldOperationId,
    oldCampaignId: OLD_CAMPAIGN, newCampaignId: NEW_CAMPAIGN, status: 'QUARANTINED', historicalOutcome: 'OUTCOME_UNKNOWN', locked: false };
  assert.deepEqual(await h.recover(), { status: 200, body: expected });
  assert.deepEqual(await h.recover(), { status: 200, body: expected });
  assert.deepEqual({ ...h.store.db.prepare('SELECT * FROM creator_web_policy_leases WHERE operation_id=?').get(h.oldOperationId) },
    { ...oldLease, quarantined_by_recovery_id: h.proof.recoveryId });
  assert.deepEqual(h.store.db.prepare('SELECT * FROM creator_web_auto_line_deliveries WHERE operation_id=?').get(h.oldOperationId), oldOutbox);
  assert.deepEqual(h.store.getCreatorWebPolicyState({ clientId: CLIENT }).policy, oldPolicy);
  const status = (await h.request(ROOT)).body;
  assert.equal(status.writeCampaignId, NEW_CAMPAIGN);
  assert.equal(status.recoveryId, h.proof.recoveryId);
  assert.equal(status.locked, false);
  assert.equal(status.campaignCapMinor, 1_000_000);
  assert.equal(h.store.getCreatorAutoLineResult({ clientId: CLIENT, operationId: h.oldOperationId }), 'UNKNOWN');
  assert.equal(h.store.claimCreatorWebAutoLineDelivery({ clientId: CLIENT, recipientUserId: OWNER, now: NOW }), null);
  assert.deepEqual(h.store.claimCreatorWebLineNotices({ now: NOW }), []);
  const operationId = randomUUID(), nextProof = { previousBudgetMinor: 200_000, targetBudgetMinor: 240_000, rounding: 'ceil-baht' };
  for (const campaignId of [undefined, OLD_CAMPAIGN, '1881670184981539']) {
    const input = { operationId, revision: 1, autoBudget: nextProof, ...(campaignId ? { campaignId } : {}) };
    assert.equal((await h.request(`${ROOT}/lease`, input)).body.error.code, 'CREATOR_WEB_CAMPAIGN_RESTRICTED');
  }
  const lease = await h.request(`${ROOT}/lease`, { operationId, revision: 1, autoBudget: nextProof, campaignId: NEW_CAMPAIGN });
  assert.equal(lease.status, 200);
  assert.equal(lease.body.writeCampaignId, NEW_CAMPAIGN);
  assert.equal(lease.body.recoveryId, h.proof.recoveryId);
  assert.equal(h.store.db.prepare('SELECT campaign_id FROM creator_web_policy_leases WHERE operation_id=?').get(operationId).campaign_id, NEW_CAMPAIGN);
  assert.deepEqual(await h.recover(), { status: 200, body: { ...expected, locked: true } });
  for (const outcome of ['APPLIED_VERIFIED', 'NOT_SENT', 'PROVIDER_REJECTED', 'OUTCOME_UNKNOWN']) {
    assert.equal((await h.request(`${ROOT}/finish`, { operationId: h.oldOperationId, outcome })).body.error.code, 'CREATOR_WEB_LEASE_QUARANTINED');
  }
  assert.equal((await h.request(`${ROOT}/lease`, { operationId: h.oldOperationId, revision: 1, autoBudget: OLD_PROOF })).body.error.code,
    'CREATOR_WEB_LEASE_QUARANTINED');
  assert.equal((await h.request(`${ROOT}/finish`, { operationId, outcome: 'APPLIED_VERIFIED' })).status, 200);
  const claim = h.store.claimCreatorWebAutoLineDelivery({ clientId: CLIENT, recipientUserId: OWNER, now: NOW });
  assert.equal(claim.operationId, operationId);
  assert.match(claim.messageText, /2,000.*2,400/);
  assert.doesNotMatch(claim.messageText, /2,880/);
  assert.equal(h.store.listAuditEvents({ eventType: 'CREATOR_WEB_UNKNOWN_QUARANTINED' }).length, 1);
  assert.equal(h.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('recovery rejects stale proof and reused IDs without changing either lease or opening another scope', async t => {
  const h = await http(t);
  for (const patch of [{ revision: 2 }, { oldOperationId: randomUUID() }]) {
    assert.equal((await h.recover({ ...h.proof, ...patch })).body.error.code, 'CREATOR_WEB_RECOVERY_CONFLICT');
  }
  assert.equal((await h.recover()).status, 200);
  for (const patch of [{ operatorUserId: 43 }, { recoveryId: randomUUID() }, { newCampaignId: '1881670184981539' },
    { oldCampaignId: '1881580307345763' }, { oldOperationId: randomUUID() }]) {
    assert.equal((await h.recover({ ...h.proof, ...patch })).body.error.code, 'CREATOR_WEB_RECOVERY_CONFLICT');
  }
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM creator_web_unknown_recoveries').get().n, 1);
  assert.equal((await h.request('/internal/automation/ppan/policy')).body.writeCampaignId, undefined);
  assert.equal((await h.request('/internal/automation/ppan/policy/lease', { operationId: randomUUID(), revision: 1, campaignId: NEW_CAMPAIGN })).status, 409);
});

test('quarantine annotation, audit and old outbox are immutable, while the original named unique fence protects new leases', t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.store.recoverCreatorWebUnknownLease({ clientId: CLIENT, ...f.proof, now: NOW });
  for (const sql of ["UPDATE creator_web_policy_leases SET outcome='APPLIED_VERIFIED' WHERE operation_id=?",
    'UPDATE creator_web_policy_leases SET quarantined_by_recovery_id=NULL WHERE operation_id=?',
    'DELETE FROM creator_web_policy_leases WHERE operation_id=?',
    "UPDATE creator_web_auto_line_deliveries SET state='NOT_APPLIED' WHERE operation_id=?",
    'DELETE FROM creator_web_auto_line_deliveries WHERE operation_id=?']) assert.throws(() => f.store.db.prepare(sql).run(f.oldOperationId), /immutable/);
  for (const sql of ['DELETE FROM creator_web_unknown_recoveries', "UPDATE creator_web_unknown_recoveries SET new_campaign_id='1881670184981539'"])
    assert.throws(() => f.store.db.exec(sql), /immutable/);
  const op = randomUUID();
  f.store.acquireCreatorWebPolicyLease({ clientId: CLIENT, operationId: op, revision: 1, campaignId: NEW_CAMPAIGN, now: NOW });
  assert.throws(() => f.store.db.prepare(`INSERT INTO creator_web_policy_leases
    (operation_id,client_id,policy_revision,acquired_at,expires_at,campaign_id) VALUES (?,?,1,?,?,?)`)
    .run(randomUUID(), CLIENT, NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString(), NEW_CAMPAIGN), /UNIQUE constraint failed/);
  const index = f.store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='creator_web_policy_one_held_lease'").get().sql;
  assert.match(index, /UNIQUE INDEX creator_web_policy_one_held_lease/);
  assert.match(index, /quarantined_by_recovery_id IS NULL/);
});

test('migration of the actual old lease index preserves old rows, supports quarantine plus a new held lease, and remains fenced after restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'unknown-recovery-migration-'));
  const filename = join(dir, 'fixture.sqlite');
  let f = fixture(new SqliteStore(filename));
  t.after(() => { f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const oldRows = f.store.db.prepare('SELECT * FROM creator_web_auto_line_deliveries').all();
  const oldCore = f.store.db.prepare(`SELECT operation_id,client_id,policy_revision,acquired_at,expires_at,outcome,outcome_at
    FROM creator_web_policy_leases`).all();
  for (const { name } of f.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'creator_web_%'").all()) {
    f.store.db.exec(`DROP TRIGGER ${name}`);
  }
  f.store.db.exec(`DROP INDEX creator_web_policy_one_held_lease;
    ALTER TABLE creator_web_policy_leases DROP COLUMN quarantined_by_recovery_id;
    ALTER TABLE creator_web_policy_leases DROP COLUMN campaign_id;
    DROP TABLE creator_web_unknown_recoveries;
    CREATE UNIQUE INDEX creator_web_policy_one_held_lease
      ON creator_web_policy_leases(client_id) WHERE outcome IS NULL OR outcome = 'OUTCOME_UNKNOWN';`);
  f.store.close();
  f.store = new SqliteStore(filename);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM creator_web_auto_line_deliveries').all(), oldRows);
  assert.deepEqual(f.store.db.prepare(`SELECT operation_id,client_id,policy_revision,acquired_at,expires_at,outcome,outcome_at
    FROM creator_web_policy_leases`).all(), oldCore);
  assert.equal(f.store.getCreatorWebPolicyState({ clientId: CLIENT }).locked, true);
  f.store.recoverCreatorWebUnknownLease({ clientId: CLIENT, ...f.proof, now: NOW });
  const newOp = randomUUID();
  f.store.acquireCreatorWebPolicyLease({ clientId: CLIENT, operationId: newOp, revision: 1, campaignId: NEW_CAMPAIGN, now: NOW });
  f.store.close();
  f.store = new SqliteStore(filename);
  assert.equal(f.store.getCreatorWebPolicyState({ clientId: CLIENT }).locked, true);
  assert.equal(f.store.getCreatorWebPolicyState({ clientId: CLIENT }).writeCampaignId, NEW_CAMPAIGN);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM creator_web_auto_line_deliveries').all(), oldRows);
  assert.throws(() => f.store.acquireCreatorWebPolicyLease({ clientId: CLIENT, operationId: randomUUID(), revision: 1,
    campaignId: NEW_CAMPAIGN, now: NOW }), { code: 'CREATOR_WEB_POLICY_LOCKED' });
  assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('a failed recovery audit insert rolls back quarantine and release atomically', t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.store.db.exec(`CREATE TRIGGER fixture_fail_recovery BEFORE INSERT ON audit_events
    WHEN NEW.event_type='CREATOR_WEB_UNKNOWN_QUARANTINED' BEGIN SELECT RAISE(ABORT,'injected recovery audit failure'); END;`);
  assert.throws(() => f.store.recoverCreatorWebUnknownLease({ clientId: CLIENT, ...f.proof, now: NOW }), /injected/);
  assert.equal(f.store.getCreatorWebPolicyState({ clientId: CLIENT }).locked, true);
  assert.equal(f.store.getCreatorWebPolicyState({ clientId: CLIENT }).writeCampaignId, undefined);
  assert.equal(f.store.db.prepare('SELECT quarantined_by_recovery_id FROM creator_web_policy_leases WHERE operation_id=?').get(f.oldOperationId).quarantined_by_recovery_id, null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM creator_web_unknown_recoveries').get().n, 0);
});

test('migration refuses an unrecognized named fence instead of dropping or silently broadening it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'unknown-recovery-schema-reject-'));
  const filename = join(dir, 'fixture.sqlite');
  const f = fixture(new SqliteStore(filename));
  t.after(() => { f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  f.store.db.exec(`DROP INDEX creator_web_policy_one_held_lease;
    CREATE UNIQUE INDEX creator_web_policy_one_held_lease ON creator_web_policy_leases(client_id) WHERE outcome IS NULL;`);
  const select = "SELECT sql FROM sqlite_schema WHERE name='creator_web_policy_one_held_lease'";
  const original = f.store.db.prepare(select).get();
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    `import {SqliteStore} from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    try {const store=new SqliteStore(${JSON.stringify(filename)});store.close();process.exitCode=1;}
    catch(error){if(error.message!=='Unrecognized Creator policy lease fence schema')process.exitCode=2;}`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(f.store.db.prepare(select).get(), original);
  assert.equal(f.store.getCreatorWebPolicyState({ clientId: CLIENT }).locked, true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM creator_web_unknown_recoveries').get().n, 0);
});
