import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PPAN_AUTO_WATCH_URL, processPpanAutoWatch, readPpanAutoWatch, validatePpanAutoWatch } from "../src/ppan-auto-watch.js";
import { SqliteStore } from "../src/store.js";

const KEY = "x".repeat(43), OWNER = `U${"a".repeat(32)}`, NEW_OWNER = `U${"b".repeat(32)}`;
const BASE = new Date("2026-11-08T05:00:00.000Z").getTime();
const sessionId = randomUUID();
const ACTIVE = { schemaVersion: 1, clientId: "punpan_020", armState: "ACTIVE", sessionId, incident: null };

test("watchdog read uses the fixed read-only origin, rejects wrong scope and bounds upstream payloads", async () => {
  let calls = 0;
  const result = await readPpanAutoWatch({ key: KEY, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, PPAN_AUTO_WATCH_URL);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["X-Creator-Read-Key"], KEY);
    assert.equal(init.headers["X-Creator-Web-Key"], undefined);
    return Response.json(ACTIVE);
  } });
  assert.deepEqual(result, { armState: "ACTIVE", sessionId, incident: null });
  assert.equal(calls, 1);
  for (const invalid of [{ ...ACTIVE, clientId: "srihiw" }, { ...ACTIVE, recipient: OWNER }, { ...ACTIVE, sessionId: null },
    { ...ACTIVE, incident: { sessionId, kind: "WATCH_UNAVAILABLE", incidentKey: String(BASE) } }]) {
    assert.throws(() => validatePpanAutoWatch(invalid), /UNVERIFIED/);
  }
  await assert.rejects(readPpanAutoWatch({ key: KEY, fetchImpl: async () => Response.json({ ...ACTIVE, extra: "a".repeat(2500) }) }), /UNVERIFIED/);
});

function harness(t) {
  const store = new SqliteStore(); t.after(() => store.close());
  let now = BASE, owner = OWNER, state = ACTIVE, readUnavailable = false, pushUnavailable = false;
  const deliveries = [], logs = [];
  const tick = () => processPpanAutoWatch({ store, read: async () => {
    if (readUnavailable) throw new Error("fixture outage");
    return validatePpanAutoWatch(state);
  }, resolveOwner: () => owner, line: { push: async (...args) => {
    deliveries.push(args);
    if (pushUnavailable) throw Object.assign(new Error("fixture LINE transport error"), { code: "LINE_TRANSPORT_ERROR" });
  } }, clock: () => new Date(now), logger: { info: event => logs.push(event) } });
  return { store, deliveries, logs, tick, time: ms => { now = BASE + ms; }, setOwner: id => { owner = id; },
    set: value => { state = value; }, failRead: value => { readUnavailable = value; }, failPush: value => { pushUnavailable = value; } };
}

test("only a recently confirmed armed Ppan alerts for an API outage; repeat and inactive polls never send", async t => {
  const h = harness(t);
  h.failRead(true);
  assert.equal(await h.tick(), null);
  h.failRead(false);
  assert.equal(await h.tick(), null);
  h.failRead(true);
  h.time(2 * 60_000);
  assert.equal(await h.tick(), null);
  h.time(3 * 60_000);
  assert.deepEqual(await h.tick(), { event: "creator_ppan_auto_watch", kind: "WATCH_UNAVAILABLE", status: "LINE_ACCEPTED" });
  assert.match(h.deliveries[0][1].text, /Ppan.*ติดต่อระบบตรวจ Auto ไม่ได้/);
  assert.equal(h.deliveries[0][0], OWNER);
  h.time(4 * 60_000);
  assert.equal(await h.tick(), null);
  assert.equal(h.deliveries.length, 1);
  h.failRead(false);
  h.set({ ...ACTIVE, armState: "INACTIVE" });
  await h.tick();
  h.failRead(true);
  h.time(8 * 60_000);
  assert.equal(await h.tick(), null);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.logs[0].includes(OWNER), false);
});

test("upstream ambiguous result alerts once and uses a durable retry key without rerouting after pairing changes", async t => {
  const h = harness(t), incidentKey = randomUUID();
  h.set({ ...ACTIVE, incident: { kind: "OUTCOME_UNKNOWN", sessionId, incidentKey } });
  h.failPush(true);
  assert.equal((await h.tick()).status, "LINE_RETRY_PENDING");
  h.time(60_000);
  h.setOwner(NEW_OWNER);
  assert.equal(await h.tick(), null);
  assert.equal(h.deliveries.length, 1);
  h.setOwner(OWNER);
  h.failPush(false);
  assert.equal((await h.tick()).status, "LINE_ACCEPTED");
  assert.equal(h.deliveries.length, 2);
  assert.equal(h.deliveries[1][2], h.deliveries[0][2]);
  assert.match(h.deliveries[1][1].text, /ไม่ส่งซ้ำ/);
  h.time(120_000);
  assert.equal(await h.tick(), null);
});
