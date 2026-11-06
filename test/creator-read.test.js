import assert from "node:assert/strict";
import test from "node:test";
import { CREATOR_BINDING, CREATOR_READ_URL, CreatorReadProvider, creatorReadFromEnvironment, validateCreatorReadSnapshot } from "../src/creator-read.js";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";
import { buildAgencyPerformanceReportMessage, buildPerformanceReportMessage } from "../src/line-controls.js";
import { resolveRuntimeMode, requiredEnvironmentVariables, createHttpServer } from "../src/server.js";

const KEY = "bridge-key-canary-" + "k".repeat(43);
const NOW = new Date("2026-11-06T08:00:00.000Z");
function wire(overrides = {}) {
  return {
    schemaVersion: 1, clientId: "punpan_020", source: "tiktok-creator-api", readOnly: true,
    observedAt: NOW.toISOString(), reportingDate: "2026-11-06", timezone: "Asia/Bangkok",
    binding: { ...CREATOR_BINDING },
    campaign: { campaignId: "1881012999140370", campaignName: "Creator LIVE", status: "ACTIVE", operationStatus: "ENABLE", currency: "THB", dailyBudgetMinor: 300000, targetRoi: 32, spendMinor: 272352, gmvMinor: null, roi: null, liveViews: null },
    quality: { spendEstimated: true, spendSource: "TT_SHOP", reportLagSeconds: null, gmvAvailable: false, roiAvailable: false, liveViewsAvailable: false },
    capabilities: { read: true, budgetWrite: false, create: false, pause: false, autoOptimization: false },
    nativeAutoBudgetState: "UNKNOWN", ...overrides
  };
}
function response(value, options = {}) {
  return { ok: true, headers: new Headers(), async text() { return JSON.stringify(value); }, ...options };
}
function client() {
  return { id: "punpan_020", name: "Ppan", advertiserId: "legacy-advertiser", lineApproverUserIds: ["U1"],
    timezone: "Asia/Bangkok", telemetry: { source: "chrome-ui", maxSnapshotAgeSeconds: 900 },
    campaignSelector: { currency: "THB", expectedTikTokAccountId: CREATOR_BINDING.tiktokAccountId },
    lineControl: { enabled: true, aliases: ["Ppan"] } };
}

test("pinned read provider uses one GET and dedicated header without retaining arbitrary fields", async () => {
  let calls = 0;
  const provider = new CreatorReadProvider({ key: KEY, clock: () => NOW, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, CREATOR_READ_URL);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["X-Creator-Read-Key"], KEY);
    return response({ ...wire(), unknownSecret: "must-not-be-retained" });
  } });
  await Promise.all([provider.refresh(), provider.refresh()]);
  assert.equal(calls, 1);
  const result = provider.getReadSnapshot("punpan_020");
  assert.equal(result.stale, false);
  assert.equal(result.snapshot.costMinor, 272352);
  assert.equal(result.snapshot.gmvMinor, null);
  assert.equal(result.snapshot.grossRoiMilli, null);
  assert.equal(result.snapshot.advertiserId, CREATOR_BINDING.advertiserId);
  assert.equal(provider.getReadSnapshot("other-client"), null);
  assert.equal(JSON.stringify(result).includes("must-not-be-retained"), false);
  assert.equal(JSON.stringify(provider.health()).includes("272352"), false);
});

test("tuple, source, write capabilities and false zero results fail closed", () => {
  for (const bad of [
    wire({ binding: { ...CREATOR_BINDING, identityId: CREATOR_BINDING.tiktokAccountId } }),
    wire({ source: "chrome-ui" }), wire({ readOnly: false }),
    wire({ capabilities: { ...wire().capabilities, budgetWrite: true } }),
    wire({ campaign: { ...wire().campaign, gmvMinor: 0 } }),
    wire({ observedAt: "2026-11-06T09:00:00.000Z" })
  ]) assert.throws(() => validateCreatorReadSnapshot(bad, NOW), /UNVERIFIED/);
  assert.throws(() => new CreatorReadProvider({ key: KEY, url: "https://example.com/" }), /NOT_ALLOWED/);
});

test("failures retain only a stale API observation and do not leak raw errors or credentials", async () => {
  let failed = false;
  const provider = new CreatorReadProvider({ key: KEY, clock: () => NOW, fetchImpl: async () => {
    if (failed) throw new Error(`secret ${KEY}`);
    return response(wire());
  } });
  await provider.refresh();
  failed = true;
  const result = await provider.refresh();
  assert.deepEqual(result, { ok: false, code: "CREATOR_READ_UNAVAILABLE" });
  assert.equal(provider.getReadSnapshot("punpan_020").stale, true);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(provider.health().status, "degraded");
});

test("size bounds, HTTP failure, sync fetch failure and credential reflection stay sanitized", async () => {
  let mode = 0;
  const provider = new CreatorReadProvider({ key: KEY, clock: () => NOW, fetchImpl: () => {
    if (mode === 0) throw new Error(KEY);
    if (mode === 1) return response(wire(), { ok: false });
    if (mode === 2) return response(wire(), { headers: new Headers({ "content-length": "100001" }) });
    if (mode === 3) return response(wire({ campaign: { ...wire().campaign, campaignName: KEY } }));
    return response(wire());
  } });
  for (mode = 0; mode < 4; mode++) {
    assert.equal((await provider.refresh()).ok, false);
    assert.equal(provider.getReadSnapshot("punpan_020").snapshot.unavailable, true);
  }
  assert.equal((await provider.refresh()).ok, true);
});

test("stale/date-bound observations and no-active snapshots never imply active current data", async () => {
  let now = NOW;
  const provider = new CreatorReadProvider({ key: KEY, clock: () => now, fetchImpl: async () => response(wire({ campaign: null })) });
  await provider.refresh();
  assert.equal(provider.getReadSnapshot("punpan_020").snapshot.noActiveCampaign, true);
  now = new Date(NOW.getTime() + 181000);
  assert.equal(provider.getReadSnapshot("punpan_020").stale, true);
  assert.equal(provider.health().freshClients, 0);
});

test("LINE status and combined report label Creator data, unavailable metrics and target ROI truthfully", async () => {
  const provider = new CreatorReadProvider({ key: KEY, clock: () => NOW, fetchImpl: async () => response(wire()) });
  const before = provider.getReadSnapshot("punpan_020");
  assert.match(buildPerformanceReportMessage({ client: client(), ...before, now: NOW }).text, /ยังดึงข้อมูล Creator API/);
  await provider.refresh();
  const entry = { client: client(), ...provider.getReadSnapshot("punpan_020"), now: NOW };
  const report = buildPerformanceReportMessage(entry);
  assert.match(report.text, /ROI Target ที่ตั้งไว้: 32/);
  assert.match(report.text, /GMV \/ ROI จริง \/ LIVE Views: ยังยืนยันข้อมูลไม่ครบ/);
  assert.match(report.text, /7666005333864644624/);
  assert.doesNotMatch(report.text, /ข้อมูลจาก Chrome|Gross ROI: 0|Net ROI: 0/);
  assert.match(JSON.stringify(buildAgencyPerformanceReportMessage({ entries: [entry], now: NOW })), /Creator API/);
});

test("only paired private LINE reports see API cache; execution never consumes it", async (t) => {
  const store = new SqliteStore(); t.after(() => store.close());
  let legacyReads = 0, writes = 0;
  const config = { clients: [client()], requestTtlMinutes: 15 };
  store.getLatestTelemetry = () => { legacyReads++; return null; };
  const line = { replies: [], async reply(_token, message) { this.replies.push(message); }, async push() {} };
  const provider = new CreatorReadProvider({ key: KEY, clock: () => NOW, fetchImpl: async () => response(wire()) });
  await provider.refresh();
  const service = new BudgetGuardService({ config, store, line, creatorRead: provider, executionEnabled: false,
    tiktok: { async updateCampaignBudget() { writes++; throw new Error("must-not-execute"); } }, now: () => NOW, logger: { error() {} } });
  function event(id, text, userId = "U1", sourceType = "user") {
    return { webhookEventId: id, type: "message", replyToken: id, source: { type: sourceType, userId }, message: { type: "text", text } };
  }
  await service.handleLineEvents([event("fresh-status", "สถานะ Ppan")]);
  assert.match(line.replies.at(-1).text, /Creator API/);
  assert.equal(legacyReads, 0);
  await service.handleLineEvents([event("fresh-report", "อัปเดต Report ล่าสุด")]);
  assert.match(JSON.stringify(line.replies.at(-1)), /Creator API/);
  assert.equal(legacyReads, 0);
  await service.handleLineEvents([event("unauthorized", "สถานะ Ppan", "U2")]);
  assert.doesNotMatch(JSON.stringify(line.replies.at(-1)), /2723|Creator LIVE|7666005333864644624/);
  await service.handleLineEvents([event("group", "สถานะ Ppan", "U1", "group")]);
  assert.doesNotMatch(JSON.stringify(line.replies.at(-1)), /2723|Creator LIVE/);
  await service.handleLineEvents([event("adjust", "ปรับข้อมูล Ppan")]);
  assert.ok(legacyReads > 0, "financial controls retain their independent legacy source");
  assert.equal(writes, 0);
});

test("Creator read mode clamps all runtime writers and has explicit required secrets", () => {
  const runtime = resolveRuntimeMode({ CREATOR_READ_ENABLED: "true", CONTROL_PLANE_ONLY: "false", EXECUTION_ENABLED: "true", MONITOR_ENABLED: "true", CHROME_TELEMETRY_ALERTS_ENABLED: "true" });
  assert.equal(runtime.controlPlaneOnly, true);
  assert.equal(runtime.executionEnabled, false);
  assert.equal(runtime.monitorEnabled, false);
  assert.equal(runtime.telemetryAlertsEnabled, false);
  assert.equal(requiredEnvironmentVariables(runtime).includes("TIKTOK_ACCESS_TOKEN"), false);
  assert.equal(requiredEnvironmentVariables(runtime).includes("CREATOR_READ_BRIDGE_KEY"), true);
  assert.equal(creatorReadFromEnvironment({}), null);
});

test("health exposes no financial data and Creator admin reads require the existing bearer key", async () => {
  const provider = new CreatorReadProvider({ key: KEY, clock: () => NOW, fetchImpl: async () => response(wire()) });
  await provider.refresh();
  const runtime = resolveRuntimeMode({ CREATOR_READ_ENABLED: "true" });
  const service = { creatorRead: provider, creatorReadHealth: () => provider.health(), refreshCreatorRead: () => provider.refresh() };
  const server = createHttpServer({ service, store: {}, adminApiKey: "a".repeat(43), channelSecret: "none", runtime, config: { clients: [] }, clock: () => NOW });
  async function invoke(url, authorization) {
    return new Promise((resolve) => server.emit("request", {
      method: "GET", url, headers: authorization ? { authorization } : {}, socket: { remoteAddress: "127.0.0.1" }
    }, { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } }));
  }
  const health = await invoke("/health");
  assert.equal(health.body.adapters.creatorApiRead.freshClients, 1);
  assert.doesNotMatch(JSON.stringify(health), /272352|300000|1881012999140370|7666005333864644624/);
  assert.equal((await invoke("/admin/creator-read")).status, 401);
  assert.equal((await invoke("/admin/creator-read", "Bearer wrong")).status, 401);
  const valid = await invoke("/admin/creator-read", `Bearer ${"a".repeat(43)}`);
  assert.equal(valid.status, 200);
  assert.equal(valid.body.observation.snapshot.costMinor, 272352);
});
