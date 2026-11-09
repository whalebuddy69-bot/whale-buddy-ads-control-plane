import assert from "node:assert/strict";
import test from "node:test";
import { CREATOR_BINDING, CreatorReadProvider } from "../src/creator-read.js";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";

const CLIENT_ID = "punpan_020";
const start = new Date("2025-03-15T07:06:45.000Z");
const client = {
  id: CLIENT_ID, name: "Ppan", advertiserId: CREATOR_BINDING.advertiserId, lineApproverUserIds: ["U-static"],
  campaignSelector: { expectedTikTokAccountId: CREATOR_BINDING.tiktokAccountId },
  lineControl: { enabled: true, creatorBudgetPreviewEnabled: true }
};

function harness(t) {
  const store = new SqliteStore();
  t.after(() => store.close());
  let now = start;
  let spendMinor = 655123, dailyBudgetMinor = 780000, aggregateSpendComplete = true, failFetch = false;
  const fetchMethods = [];
  const read = new CreatorReadProvider({ key: "x".repeat(48), clock: () => now, fetchImpl: async (_url, options) => {
    fetchMethods.push(options.method);
    if (failFetch) throw new Error("bridge temporarily unavailable");
    return new Response(JSON.stringify({
      schemaVersion: 1, clientId: CLIENT_ID, source: "tiktok-creator-api", readOnly: true,
      observedAt: now.toISOString(), reportingDate: "2025-03-15", timezone: "Asia/Bangkok", binding: CREATOR_BINDING,
      campaign: { campaignId: "1234567890123456", campaignName: "Test LIVE", status: "ACTIVE", operationStatus: "ENABLE",
        currency: "THB", dailyBudgetMinor, spendMinor, targetRoi: 25, gmvMinor: null, roi: null, liveViews: null },
      quality: { spendEstimated: true, spendSource: "TT_SHOP", reportLagSeconds: null, gmvAvailable: false,
        roiAvailable: false, liveViewsAvailable: false, aggregateSpendComplete, aggregateSpendMinor: spendMinor + 75 },
      capabilities: { read: true, budgetWrite: false, create: false, pause: false, autoOptimization: false },
      nativeAutoBudgetState: "UNKNOWN"
    }));
  } });
  store.ensureCreatorPolicy({ clientId: CLIENT_ID, now });
  const pair = (userId, hash) => {
    store.createLinePairing({ clientId: CLIENT_ID, codeHash: hash.repeat(64), createdAt: now, expiresAt: new Date(now.getTime() + 600000) });
    store.consumeLinePairing({ clientId: CLIENT_ID, codeHash: hash.repeat(64), lineUserId: userId, consumedAt: now });
  };
  const pushes = [], logs = [];
  let failPush = false;
  const service = new BudgetGuardService({
    config: { clients: [client] }, store, creatorRead: read,
    line: { async push(to, message, retryKey) {
      pushes.push({ to, message, retryKey });
      if (failPush) throw new Error("unconfirmed LINE response");
    } },
    tiktok: new Proxy({}, { get() { assert.fail("preview must not touch the TikTok writer"); } }),
    now: () => now, logger: { info: (log) => logs.push(log), warn: (log) => logs.push(log) }
  });
  return { store, service, pair, pushes, logs, fetchMethods,
    failPush: () => { failPush = true; }, failFetch: () => { failFetch = true; },
    incomplete: () => { aggregateSpendComplete = false; },
    setBudgetSpend: (budget, spend) => { dailyBudgetMinor = budget; spendMinor = spend; },
    advance: (ms) => { now = new Date(now.getTime() + ms); } };
}

test("fresh Creator read sends one informational LINE proposal to the sole paired owner", async (t) => {
  const h = harness(t);
  h.pair("U-owner", "a");
  assert.deepEqual(h.service.creatorBudgetPreviewHealth(), { enabled: true, mode: "dry-run", budgetWriteEnabled: false });
  assert.deepEqual(await h.service.refreshCreatorRead(), { ok: true });
  const results = await Promise.all([h.service.processCreatorBudgetPreview(), h.service.processCreatorBudgetPreview()]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["DUPLICATE_COOLDOWN_OR_POLICY_CHANGED", "LINE_ACCEPTED"]);
  assert.deepEqual(h.fetchMethods, ["GET"]);
  const [{ to, message, retryKey }] = h.pushes;
  assert.equal(to, "U-owner");
  assert.match(retryKey, /^[0-9a-f-]{36}$/);
  assert.equal(message.type, "text");
  assert.match(message.text, /^🧪 @punpanshop888 — จำลองการเพิ่มงบ \(ไม่ได้เปลี่ยนงบจริง\)/);
  assert.match(message.text, /7,800.*→.*9,360/);
  assert.match(message.text, /9,360\.75.*10,000/);
  assert.match(message.text, /2025-03-15 14:06/);
  assert.equal(h.store.getCreatorPolicy({ clientId: CLIENT_ID }).executionEnabled, false);
  assert.deepEqual(h.logs.map(JSON.parse), [{ event: "creator_budget_preview", status: "LINE_ACCEPTED", mode: "dry-run" }]);
});

test("no preview for absent/multiple paired owners, incomplete spend, failed refresh, or unsafe target", async (t) => {
  const h = harness(t);
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "SNAPSHOT_NOT_FRESH");
  await h.service.refreshCreatorRead();
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "PAIRED_OWNER_UNVERIFIED");
  h.pair("U-owner", "a");
  h.pair("U-other-owner", "b");
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "PAIRED_OWNER_UNVERIFIED");
  h.setBudgetSpend(900000, 765123);
  await h.service.refreshCreatorRead();
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "CAMPAIGN_CAP_EXCEEDED");
  h.incomplete();
  await h.service.refreshCreatorRead();
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "AGGREGATE_SPEND_UNVERIFIED");
  h.failFetch();
  await h.service.refreshCreatorRead();
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "SNAPSHOT_NOT_FRESH");
  assert.equal(h.pushes.length, 0);
});

test("unconfirmed LINE delivery does not create a second push for that budget", async (t) => {
  const h = harness(t);
  h.pair("U-owner", "a");
  h.failPush();
  await h.service.refreshCreatorRead();
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "LINE_UNCONFIRMED");
  h.advance(20 * 60_000);
  await h.service.refreshCreatorRead();
  assert.equal((await h.service.processCreatorBudgetPreview()).status, "DUPLICATE_COOLDOWN_OR_POLICY_CHANGED");
  assert.equal(h.pushes.length, 1);
});
