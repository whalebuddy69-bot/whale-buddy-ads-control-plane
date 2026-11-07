import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCreatorWebPolicyOptions } from "../src/creator-web-policy.js";
import { createHttpServer } from "../src/server.js";
import { SqliteStore } from "../src/store.js";

const KEY = "A".repeat(43);
const NOW = new Date("2026-11-08T00:00:00.000Z");
const ROOT = "/internal/automation/ppan/policy";
const SRIHIW_ROOT = "/internal/automation/srihiw/policy";
const CLIENT = "punpan_020";
const OWNER = "U-fixture-ppan-owner";
const LATER = (ms, at = NOW) => new Date(at.getTime() + ms);
const ACTIVE = { controlPlaneOnly: true, creatorReadEnabled: true };

function pair(store, userId = OWNER) {
  const codeHash = createHash("sha256").update(userId).digest("hex");
  store.createLinePairing({ clientId: CLIENT, codeHash, createdAt: NOW, expiresAt: LATER(600_000) });
  store.consumeLinePairing({ clientId: CLIENT, codeHash, lineUserId: userId, consumedAt: NOW });
}

function policyStore(t) {
  const store = new SqliteStore();
  t.after(() => store.close());
  store.ensureCreatorPolicy({ now: NOW });
  return store;
}

async function localHttp(t, { leaseEnabled = true, srihiwLeaseEnabled = false,
  capWriteEnabled = false, key = KEY, store = policyStore(t), service = {} } = {}) {
  let clock = NOW;
  const server = createHttpServer({ service, store, clock: () => clock,
    creatorWebPolicyOptions: { key, leaseEnabled, srihiwLeaseEnabled, capWriteEnabled } });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { store, clockAt: value => { clock = value; }, get: async (path = ROOT, init = {}) => {
    const response = await fetch(`${url}${path}`, { ...init, redirect: "manual", headers: { "x-creator-web-key": KEY, ...init.headers } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("location"), null);
    return { status: response.status, body: await response.json() };
  } };
}

function post(body, headers = {}) {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

test("policy bridge is opt-in and never reuses credentials or enables leases on a truthy flag", () => {
  const env = { CREATOR_WEB_POLICY_BRIDGE_KEY: KEY, CREATOR_WEB_POLICY_LEASE_ENABLED: "true" };
  assert.deepEqual(resolveCreatorWebPolicyOptions(env, ACTIVE), { key: KEY, leaseEnabled: true, srihiwLeaseEnabled: false, capWriteEnabled: false });
  assert.deepEqual(resolveCreatorWebPolicyOptions({ ...env, CREATOR_WEB_POLICY_CAP_WRITE_ENABLED: "true" }, ACTIVE),
    { key: KEY, leaseEnabled: true, srihiwLeaseEnabled: false, capWriteEnabled: true });
  assert.deepEqual(resolveCreatorWebPolicyOptions({ ...env, CREATOR_WEB_POLICY_LEASE_ENABLED: "false",
    CREATOR_WEB_SRIHIW_BUDGET_LEASE_ENABLED: "true" }, ACTIVE),
    { key: KEY, leaseEnabled: false, srihiwLeaseEnabled: true, capWriteEnabled: false });
  for (const config of [undefined, {}, { controlPlaneOnly: false, creatorReadEnabled: true }, { controlPlaneOnly: true, creatorReadEnabled: false }]) {
    assert.deepEqual(resolveCreatorWebPolicyOptions(env, config), { key: null, leaseEnabled: false, srihiwLeaseEnabled: false, capWriteEnabled: false });
  }
  for (const name of ["ADMIN_API_KEY", "CREATOR_READ_BRIDGE_KEY", "CREATOR_BUDGET_TEST_KEY", "LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "TIKTOK_ACCESS_TOKEN"]) {
    assert.deepEqual(resolveCreatorWebPolicyOptions({ ...env, [name]: KEY, CREATOR_WEB_POLICY_CAP_WRITE_ENABLED: "true" }, ACTIVE),
      { key: null, leaseEnabled: false, srihiwLeaseEnabled: false, capWriteEnabled: false });
  }
  assert.deepEqual(resolveCreatorWebPolicyOptions({ ...env, CREATOR_WEB_POLICY_LEASE_ENABLED: true, CREATOR_WEB_POLICY_CAP_WRITE_ENABLED: true }, ACTIVE),
    { key: KEY, leaseEnabled: false, srihiwLeaseEnabled: false, capWriteEnabled: false });
  assert.deepEqual(resolveCreatorWebPolicyOptions({ ...env, CREATOR_WEB_POLICY_BRIDGE_KEY: `${KEY}\n` }, ACTIVE),
    { key: null, leaseEnabled: false, srihiwLeaseEnabled: false, capWriteEnabled: false });
});

test("the HTTP policy reader is authenticated, fixed-scope, non-browser, no-store and does not expose owner or secret", async t => {
  const h = await localHttp(t);
  pair(h.store);
  assert.deepEqual(await h.get(), { status: 200, body: { schemaVersion: 1, clientId: CLIENT, revision: 1,
    campaignCapMinor: 1_000_000, clientDailyCapMinor: 1_000_000, readAt: NOW.toISOString(), locked: false, capWriteEnabled: false, autoLineReady: false } });
  assert.equal((await h.get(ROOT, { headers: { "x-creator-web-key": "X".repeat(43), authorization: `Bearer ${KEY}` } })).status, 401);
  for (const headers of [{ origin: "https://example.test" }, { cookie: "a=b" }, { "sec-fetch-site": "same-origin" }]) {
    assert.equal((await h.get(ROOT, { headers })).status, 403);
  }
  assert.equal((await h.get(`${ROOT}?campaignId=other`)).status, 400);
  assert.equal((await h.get(ROOT, { method: "OPTIONS" })).status, 405);
  assert.equal((await h.get(ROOT, post({}))).status, 405);
});

test("HTTP lease and finish are off by default even when read is available", async t => {
  const h = await localHttp(t, { leaseEnabled: false });
  const operationId = randomUUID();
  assert.equal((await h.get()).status, 200);
  for (const [suffix, body] of [["lease", { operationId, revision: 1 }], ["finish", { operationId, outcome: "NOT_SENT" }]]) {
    assert.deepEqual(await h.get(`${ROOT}/${suffix}`, post(body)), { status: 503, body: { error: { code: "LEASE_DISABLED" } } });
  }
  assert.equal((await h.get()).body.locked, false);
  const disabled = await localHttp(t, { key: null });
  assert.equal((await disabled.get()).status, 404);
});

test("automatic lease requires a scoped LINE recipient, binds the exact increase, and emits no notice before readback", async t => {
  const recipient = `U${"2".repeat(32)}`;
  const service = { creatorWebAutoLineRecipient: id => id === CLIENT ? recipient : null };
  const h = await localHttp(t, { service, capWriteEnabled: true, srihiwLeaseEnabled: true });
  pair(h.store, recipient);
  await h.get(`${SRIHIW_ROOT}/cap`, post({ revision: 0, capMinor: 900_000, actorUserId: 42 }));
  assert.equal((await h.get()).body.autoLineReady, true);
  assert.equal(JSON.stringify(await h.get()).includes(recipient), false);
  assert.equal((await h.get(SRIHIW_ROOT)).body.autoLineReady, false);
  const operationId = randomUUID();
  const args = { operationId, revision: 1, autoBudget: { previousBudgetMinor: 300_000, targetBudgetMinor: 360_000 } };
  assert.deepEqual(await h.get(`${SRIHIW_ROOT}/lease`, post(args)),
    { status: 409, body: { error: { code: "CREATOR_WEB_AUTO_LINE_NOT_READY" } } });
  assert.equal((await h.get(`${ROOT}/lease`, post({ ...args, autoBudget: { previousBudgetMinor: 300_000, targetBudgetMinor: 360_001 } }))).status, 400);
  assert.equal((await h.get(`${ROOT}/lease`, post({ ...args, autoBudget: { previousBudgetMinor: 900_000, targetBudgetMinor: 1_080_000 } }))).status, 409);
  assert.equal((await h.get(`${ROOT}/lease`, post({ ...args, recipientUserId: recipient }))).status, 400);
  assert.equal((await h.get(`${ROOT}/lease`, post(args))).status, 200);
  assert.equal((await h.get(`${ROOT}/lease`, post(args))).status, 200);
  assert.equal((await h.get(`${ROOT}/lease`, post({ operationId, revision: 1 }))).status, 409);
  assert.equal((await h.get(`${ROOT}/lease`, post({ ...args, autoBudget: { previousBudgetMinor: 400_000, targetBudgetMinor: 480_000 } }))).status, 409);
  const claim = () => h.store.claimCreatorWebAutoLineDelivery({ clientId: CLIENT, recipientUserId: recipient, now: NOW });
  assert.equal(claim(), null);
  assert.equal((await h.get(`${ROOT}/finish`, post({ operationId, outcome: "OUTCOME_UNKNOWN" }))).status, 200);
  assert.equal(claim(), null);
  assert.equal((await h.get(`${ROOT}/finish`, post({ operationId, outcome: "APPLIED_VERIFIED" }))).status, 200);
  assert.equal((await h.get(`${ROOT}/finish`, post({ operationId, outcome: "APPLIED_VERIFIED" }))).status, 200);
  const delivery = claim();
  assert.equal(delivery.operationId, operationId);
  assert.match(delivery.messageText, /Ppan.*เพิ่มงบอัตโนมัติสำเร็จ/);
  assert.match(delivery.messageText, /3,000.*3,600/);
  assert.deepEqual(h.store.claimCreatorWebLineNotices({ now: NOW }), []);
  assert.equal(claim(), null);
});

test("cap bridge has its own opt-in and never accepts browser or foreign target input", async t => {
  const args = { revision: 1, capMinor: 550_000, actorUserId: 42 };
  const disabled = await localHttp(t);
  for (const root of [ROOT, SRIHIW_ROOT]) {
    assert.deepEqual(await disabled.get(`${root}/cap`, post(args)), { status: 503, body: { error: { code: "CAP_WRITE_DISABLED" } } });
  }
  const h = await localHttp(t, { capWriteEnabled: true, leaseEnabled: false });
  const path = `${ROOT}/cap`;
  for (const headers of [{ origin: "https://example.test" }, { cookie: "a=b" }, { "sec-fetch-site": "same-origin" }]) {
    assert.equal((await h.get(path, post(args, headers))).status, 403);
  }
  assert.equal((await h.get(path, post(args, { "x-creator-web-key": "X".repeat(43) }))).status, 401);
  assert.equal((await h.get(path)).status, 405);
  assert.equal((await h.get(`${path}?clientId=srihiw`, post(args))).status, 400);
  for (const invalid of [{ ...args, clientId: "srihiw" }, { ...args, revision: 0 }, { ...args, actorUserId: "42" },
    { ...args, capMinor: -1 }, { ...args, capMinor: 5.1 }, { ...args, capMinor: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await h.get(path, post(invalid))).status, 400);
  }
  assert.equal((await h.get(ROOT)).body.revision, 1);
  const written = await h.get(path, post(args));
  assert.deepEqual(written, { status: 200, body: { schemaVersion: 1, clientId: CLIENT, revision: 2, campaignCapMinor: args.capMinor,
    clientDailyCapMinor: args.capMinor, readAt: NOW.toISOString(), locked: false, capWriteEnabled: true, autoLineReady: false } });
  assert.equal(h.store.getCreatorPolicy().executionEnabled, false);
  assert.deepEqual(await h.get(path, post({ ...args, revision: 2 })), written);
  assert.deepEqual(await h.get(path, post(args)), { status: 409, body: { error: { code: "POLICY_CHANGED" } } });
  const events = h.store.listAuditEvents({ eventType: "CREATOR_WEB_CAP_CHANGED" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actorType, "WEB_USER");
  assert.equal(events[0].actorId, "42");
});

test("Srihiw cap starts unconfigured, uses revision zero once, and does not implicitly enable leases or edit Ppan", async t => {
  const h = await localHttp(t, { capWriteEnabled: true });
  assert.deepEqual(await h.get(SRIHIW_ROOT), { status: 200, body: { schemaVersion: 1, clientId: "srihiw",
    configured: false, readAt: NOW.toISOString(), locked: false, capWriteEnabled: true, autoLineReady: false } });
  assert.equal(h.store.getCreatorWebPolicyState({ clientId: "srihiw" }), null);
  const path = `${SRIHIW_ROOT}/cap`;
  const args = { revision: 0, capMinor: 1_800_000, actorUserId: 42 };
  assert.deepEqual(await h.get(path, post({ ...args, revision: 1 })), { status: 409, body: { error: { code: "POLICY_CHANGED" } } });
  const created = await h.get(path, post(args));
  assert.deepEqual(created, { status: 200, body: { schemaVersion: 1, clientId: "srihiw", configured: true, revision: 1,
    campaignCapMinor: args.capMinor, clientDailyCapMinor: args.capMinor, readAt: NOW.toISOString(), locked: false, capWriteEnabled: true, autoLineReady: false } });
  assert.deepEqual(await h.get(SRIHIW_ROOT), created);
  assert.deepEqual(await h.get(path, post(args)), { status: 409, body: { error: { code: "POLICY_CHANGED" } } });
  assert.equal((await h.get(path, post({ ...args, revision: 1, capMinor: 1_000_000 }))).body.revision, 2);
  assert.equal(h.store.getCreatorWebPolicyState({ clientId: "srihiw" }).policy.executionEnabled, false);
  assert.equal((await h.get(ROOT)).body.campaignCapMinor, 1_000_000);
  assert.equal((await h.get(ROOT)).body.revision, 1);
  assert.deepEqual(await h.get(`${SRIHIW_ROOT}/lease`, post({ operationId: randomUUID(), revision: 2 })),
    { status: 503, body: { error: { code: "LEASE_DISABLED" } } });
});

test("Srihiw leases require its own initialized cap, exclude only Srihiw, and never notify Ppan", async t => {
  const h = await localHttp(t, { capWriteEnabled: true, srihiwLeaseEnabled: true });
  pair(h.store);
  const sri = randomUUID(), ppan = randomUUID();
  const lock = (root, operationId, revision = 1) => h.get(`${root}/lease`, post({ operationId, revision }));
  const finish = (root, operationId, outcome) => h.get(`${root}/finish`, post({ operationId, outcome }));
  const cap = (root, revision, capMinor) => h.get(`${root}/cap`, post({ revision, capMinor, actorUserId: 42 }));
  assert.equal((await lock(SRIHIW_ROOT, sri)).body.error.code, "CREATOR_WEB_POLICY_CHANGED");
  assert.equal((await cap(SRIHIW_ROOT, 0, 2_000_000)).status, 200);
  const lease = await lock(SRIHIW_ROOT, sri);
  assert.deepEqual(lease, { status: 200, body: { schemaVersion: 1, clientId: "srihiw", configured: true,
    revision: 1, campaignCapMinor: 2_000_000, clientDailyCapMinor: 2_000_000, readAt: NOW.toISOString(),
    locked: true, operationId: sri, expiresAt: LATER(60_000).toISOString() } });
  assert.equal((await lock(SRIHIW_ROOT, randomUUID())).body.error.code, "CREATOR_WEB_POLICY_LOCKED");
  assert.equal((await lock(ROOT, sri)).body.error.code, "CREATOR_WEB_LEASE_CONFLICT");
  assert.equal((await lock(ROOT, ppan)).status, 200);
  assert.equal((await finish(SRIHIW_ROOT, ppan, "APPLIED_VERIFIED")).body.error.code, "CREATOR_WEB_LEASE_NOT_FOUND");
  assert.equal((await finish(ROOT, sri, "APPLIED_VERIFIED")).body.error.code, "CREATOR_WEB_LEASE_NOT_FOUND");
  assert.equal((await finish(ROOT, ppan, "APPLIED_VERIFIED")).status, 200);
  assert.equal((await finish(SRIHIW_ROOT, sri, "OUTCOME_UNKNOWN")).body.locked, true);
  assert.equal((await cap(SRIHIW_ROOT, 1, 1_500_000)).body.error.code, "POLICY_LOCKED");
  assert.equal((await cap(ROOT, 1, 1_600_000)).status, 200);
  assert.equal((await finish(SRIHIW_ROOT, sri, "NOT_SENT")).body.error.code, "CREATOR_WEB_LEASE_CONFLICT");
  assert.equal((await finish(SRIHIW_ROOT, sri, "APPLIED_VERIFIED")).body.locked, false);
  assert.equal((await cap(SRIHIW_ROOT, 1, 1_500_000)).status, 200);
  assert.deepEqual(h.store.claimCreatorWebLineNotices({ now: NOW }), [{ operationId: ppan, outcome: "APPLIED_VERIFIED" }]);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM creator_web_line_notices WHERE client_id = 'srihiw'").get().n, 0);
});

test("website cap CAS shares budget leases and protects even expired or unknown writes", async t => {
  const h = await localHttp(t, { capWriteEnabled: true });
  const args = { revision: 1, capMinor: 1_500_000, actorUserId: 42 };
  const path = `${ROOT}/cap`;
  const operationId = randomUUID();
  h.store.acquireCreatorWebPolicyLease({ operationId, revision: 1, now: NOW });
  h.clockAt(LATER(61_000));
  const locked = { status: 409, body: { error: { code: "POLICY_LOCKED" } } };
  assert.deepEqual(await h.get(path, post(args)), locked);
  h.store.finishCreatorWebPolicyLease({ operationId, outcome: "OUTCOME_UNKNOWN", now: LATER(61_000) });
  assert.deepEqual(await h.get(path, post(args)), locked);
  assert.equal((await h.get(`${SRIHIW_ROOT}/cap`, post({ ...args, revision: 0 }))).status, 200);
  h.store.finishCreatorWebPolicyLease({ operationId, outcome: "APPLIED_VERIFIED", now: LATER(61_000) });
  assert.equal((await h.get(path, post(args))).body.revision, 2);
  assert.equal((await h.get(`${ROOT}/lease`, post({ operationId: randomUUID(), revision: 1 }))).body.error.code, "CREATOR_WEB_POLICY_CHANGED");
});

test("lease HTTP requests have exact bounded fields and never fabricate an absent operation", async t => {
  const h = await localHttp(t);
  const operationId = randomUUID();
  const acquire = (input) => h.get(`${ROOT}/lease`, post(input));
  assert.equal((await acquire({ operationId, revision: 1, targetMinor: 1 })).status, 400);
  assert.equal((await acquire({ operationId: "not-a-uuid", revision: 1 })).status, 400);
  assert.equal((await acquire({ operationId, revision: "1" })).status, 400);
  assert.equal((await acquire({ operationId, revision: 1, large: "x".repeat(600) })).status, 413);
  assert.equal((await h.get(`${ROOT}/lease`, { method: "POST", body: "bad json" })).status, 415);
  assert.equal((await h.get(`${ROOT}/lease`, post({ operationId, revision: 1 }, { "content-type": "text/plain" }))).status, 415);
  assert.deepEqual(await acquire({ operationId, revision: 2 }), { status: 409, body: { error: { code: "CREATOR_WEB_POLICY_CHANGED" } } });
  assert.deepEqual(await h.get(`${ROOT}/finish`, post({ operationId, outcome: "NOT_SENT" })), {
    status: 409, body: { error: { code: "CREATOR_WEB_LEASE_NOT_FOUND" } }
  });
  const lease = await acquire({ operationId, revision: 1 });
  assert.equal(lease.status, 200);
  assert.equal(lease.body.operationId, operationId);
  assert.equal(lease.body.expiresAt, LATER(60_000).toISOString());
  assert.equal(lease.body.locked, true);
  assert.equal((await h.get()).body.locked, true);
  h.clockAt(LATER(20_000));
  assert.equal((await acquire({ operationId, revision: 1 })).body.expiresAt, lease.body.expiresAt);
  h.clockAt(LATER(60_000));
  assert.deepEqual(await acquire({ operationId, revision: 1 }), { status: 409, body: { error: { code: "CREATOR_WEB_LEASE_EXPIRED" } } });
  assert.equal((await acquire({ operationId: randomUUID(), revision: 1 })).body.error.code, "CREATOR_WEB_POLICY_LOCKED");
  const finish = { operationId, outcome: "NOT_SENT" };
  assert.deepEqual(await h.get(`${ROOT}/finish`, post(finish)), { status: 200, body: { schemaVersion: 1, ...finish, locked: false } });
  assert.deepEqual(await h.get(`${ROOT}/finish`, post(finish)), { status: 200, body: { schemaVersion: 1, ...finish, locked: false } });
  assert.equal((await h.get(`${ROOT}/finish`, post({ ...finish, outcome: "APPLIED_VERIFIED" }))).body.error.code, "CREATOR_WEB_LEASE_CONFLICT");
  assert.equal((await h.get()).body.locked, false);
});

test("durable lease survives restart, blocks other writers and cap revisions, and unknown may only be reconciled as applied", t => {
  const directory = mkdtempSync(join(tmpdir(), "creator-web-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite");
  const operationId = randomUUID();
  const first = new SqliteStore(file);
  first.ensureCreatorPolicy({ now: NOW });
  pair(first);
  const { change } = first.proposeCreatorCapChange({ clientId: CLIENT, ownerLineUserId: OWNER,
    capMinor: 2_000_000, sourceEventId: "web-policy-cap-fixture", now: NOW });
  first.acquireCreatorWebPolicyLease({ operationId, revision: 1, now: NOW });
  first.close();
  const second = new SqliteStore(file);
  try {
    const now = LATER(61_000);
    assert.equal(second.getCreatorWebPolicyState().locked, true);
    assert.throws(() => second.confirmCreatorCapChange({ nonce: change.nonce, ownerLineUserId: OWNER, now }),
      { code: "CREATOR_BUDGET_TEST_IN_FLIGHT" });
    assert.throws(() => second.acquireCreatorWebPolicyLease({ operationId: randomUUID(), revision: 1, now }),
      { code: "CREATOR_WEB_POLICY_LOCKED" });
    second.finishCreatorWebPolicyLease({ operationId, outcome: "OUTCOME_UNKNOWN", now });
    assert.equal(second.getCreatorWebPolicyState().locked, true);
    assert.throws(() => second.finishCreatorWebPolicyLease({ operationId, outcome: "NOT_SENT", now }),
      { code: "CREATOR_WEB_LEASE_CONFLICT" });
    assert.throws(() => second.finishCreatorWebPolicyLease({ operationId, outcome: "PROVIDER_REJECTED", now }),
      { code: "CREATOR_WEB_LEASE_CONFLICT" });
    second.finishCreatorWebPolicyLease({ operationId, outcome: "APPLIED_VERIFIED", now });
    assert.equal(second.getCreatorWebPolicyState().locked, false);
    const { policy } = second.confirmCreatorCapChange({ nonce: change.nonce, ownerLineUserId: OWNER, now });
    assert.equal(policy.revision, 2);
    assert.equal(policy.campaignCapMinor, 2_000_000);
    assert.deepEqual(second.claimCreatorWebLineNotices({ now }), [{ operationId, outcome: "APPLIED_VERIFIED" }]);
    assert.deepEqual(second.claimCreatorWebLineNotices({ now }), []);
  } finally { second.close(); }
});

test("legacy writer and web writer share the cap lock in both directions", t => {
  const store = policyStore(t);
  pair(store);
  const operationId = randomUUID();
  // Existing guard expects its historical internal fixture scope. Never send this to TikTok.
  const permit = { permitId: "legacy-synthetic-permit", clientId: CLIENT, policyRevision: 1,
    campaignId: "1881130110195874", expectedBudgetMinor: 300000, targetBudgetMinor: 360000,
    capMinor: 1000000, nativeAutoBudgetVerifiedOff: true, exclusiveWriterConfirmed: true,
    localDate: "2026-11-08", notBefore: NOW.toISOString(), expiresAt: LATER(600_000).toISOString() };
  const args = { permit, permitDigest: "f".repeat(64), now: NOW };
  store.acquireCreatorWebPolicyLease({ operationId, revision: 1, now: NOW });
  assert.throws(() => store.beginCreatorBudgetTest(args), { code: "CREATOR_BUDGET_TEST_IN_FLIGHT" });
  store.finishCreatorWebPolicyLease({ operationId, outcome: "NOT_SENT", now: NOW });
  assert.equal(store.beginCreatorBudgetTest(args).dispatch, true);
  assert.equal(store.getCreatorWebPolicyState().locked, true);
  assert.throws(() => store.updateCreatorWebCap({ revision: 1, capMinor: 1_500_000, actorUserId: 42, now: NOW }),
    { code: "POLICY_LOCKED" });
  assert.throws(() => store.acquireCreatorWebPolicyLease({ operationId: randomUUID(), revision: 1, now: NOW }),
    { code: "CREATOR_WEB_POLICY_LOCKED" });
});

test("LINE notice and digest claims need one active paired owner; at most one notice per operation and slot per day", t => {
  const store = policyStore(t);
  const operationId = randomUUID();
  store.acquireCreatorWebPolicyLease({ operationId, revision: 1, now: NOW });
  store.finishCreatorWebPolicyLease({ operationId, outcome: "OUTCOME_UNKNOWN", now: NOW });
  assert.deepEqual(store.claimCreatorWebLineNotices({ now: NOW }), []);
  assert.equal(store.reserveCreatorWebDigest({ slot: "12:00", now: NOW }), false);
  pair(store);
  assert.deepEqual(store.claimCreatorWebLineNotices({ now: NOW }), [{ operationId, outcome: "OUTCOME_UNKNOWN" }]);
  store.finishCreatorWebPolicyLease({ operationId, outcome: "APPLIED_VERIFIED", now: NOW });
  assert.deepEqual(store.claimCreatorWebLineNotices({ now: NOW }), []);
  assert.equal(store.reserveCreatorWebDigest({ slot: "12:00", now: NOW }), true);
  assert.equal(store.reserveCreatorWebDigest({ slot: "12:00", now: NOW }), false);
  assert.equal(store.reserveCreatorWebDigest({ slot: "21:00", now: NOW }), true);
  assert.equal(store.reserveCreatorWebDigest({ slot: "12:00", now: LATER(86_400_000) }), true);
  assert.throws(() => store.reserveCreatorWebDigest({ slot: "10:00", now: NOW }), { code: "INVALID_REQUEST" });
});
