import assert from "node:assert/strict";
import test from "node:test";

import { validateConfig } from "../src/config.js";
import { RequestState } from "../src/domain.js";
import { requestCodeFor } from "../src/line.js";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";
import {
  TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
  telemetryUiCampaignRef
} from "../src/telemetry.js";

const liveNow = new Date("2026-07-20T05:00:00.000Z"); // 12:00 Asia/Bangkok

function config() {
  return validateConfig({
    agencyId: "whalebuddy-ads",
    requestTtlMinutes: 15,
    cooldownMinutes: 30,
    clients: [{
      id: "punpan_020",
      name: "punpan_020",
      lineApproverUserIds: ["U1"],
      linePairingEnabled: true,
      advertiserId: "7646832328389263378",
      shopBinding: { mode: "observe-and-pin" },
      telemetry: {
        source: "chrome-ui",
        browserProfile: "Whalebuddy Ads",
        tabGroup: "Ppan",
        businessCenterId: "7627179356976201745",
        sellerMode: "withoutShop",
        pageType: "live",
        schemaVersion: 1,
        maxSnapshotAgeSeconds: 900
      },
      timezone: "Asia/Bangkok",
      liveWindow: { start: "06:00", end: "23:00" },
      warningThreshold: 0.8,
      campaignSelector: {
        kind: "active-live-gmv-max",
        currency: "THB",
        expectedTikTokAccountId: "7285935731820920833",
        requireExactlyOne: true
      },
      budgetIncrease: { presetPercent: 20, allowManualTarget: true },
      budgetPolicy: { maxDailyBudget: 6000, effectiveFrom: "2026-07-19", revision: 1 }
    }]
  });
}

function snapshot(overrides = {}) {
  const campaignName = overrides.campaignName ?? "2026-07-20 06:00:00";
  const advertiserId = overrides.advertiserId ?? "7646832328389263378";
  return {
    schemaVersion: 1,
    uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
    snapshotId: overrides.snapshotId ?? "ts_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    clientId: "punpan_020",
    advertiserId,
    businessCenterId: "7627179356976201745",
    sellerMode: "withoutShop",
    pageType: "live",
    tiktokAccountId: "7285935731820920833",
    campaignId: null,
    campaignRef: telemetryUiCampaignRef({ advertiserId, campaignName }),
    campaignName,
    campaignType: "LIVE_GMV_MAX",
    campaignStatus: "ACTIVE",
    currency: "THB",
    dailyBudgetMinor: 100_000,
    totalBudgetMinor: 100_000,
    costMinor: 80_000,
    netCostMinor: 1,
    observedAt: "2026-07-20T04:59:30.000Z",
    source: { browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" },
    policy: { maxDailyBudgetMinor: 600_000, overDailyBudgetCap: false },
    ...overrides,
    campaignRef: overrides.campaignRef ?? telemetryUiCampaignRef({ advertiserId, campaignName }),
    source: overrides.source ?? { browserProfile: "Whalebuddy Ads", tabGroup: "Ppan" },
    policy: overrides.policy ?? { maxDailyBudgetMinor: 600_000, overDailyBudgetCap: false }
  };
}

class FakeLine {
  constructor() {
    this.pushes = [];
    this.replies = [];
  }

  async push(userId, message, retryKey) {
    this.pushes.push({ userId, message, retryKey });
  }

  async reply(replyToken, message) {
    this.replies.push({ replyToken, message });
  }
}

class ForbiddenTikTok {
  constructor() {
    this.calls = [];
  }

  async getCampaignInfo(input) {
    this.calls.push(["getCampaignInfo", input]);
    throw new Error("telemetry dry-run must not read TikTok");
  }

  async updateCampaignBudget(input) {
    this.calls.push(["updateCampaignBudget", input]);
    throw new Error("telemetry dry-run must not write TikTok");
  }
}

function harness({ enabled = true, now = () => new Date(liveNow) } = {}) {
  const store = new SqliteStore();
  const line = new FakeLine();
  const tiktok = new ForbiddenTikTok();
  const service = new BudgetGuardService({
    config: config(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    telemetryAlertsEnabled: enabled,
    logger: { error() {} },
    now
  });
  return { service, store, line, tiktok };
}

test("telemetry LINE alerts stay opt-in and use the exact 80% Cost boundary", async (t) => {
  const disabled = harness({ enabled: false });
  t.after(() => disabled.store.close());
  assert.equal(
    (await disabled.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot() })).status,
    "SKIP_TELEMETRY_ALERTS_DISABLED"
  );
  assert.equal(disabled.store.listBudgetRequests().length, 0);

  const active = harness();
  t.after(() => active.store.close());
  assert.equal(
    (await active.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot(), latest: false })).status,
    "SKIP_NOT_LATEST"
  );
  const below = await active.service.processTelemetrySnapshotForDryRunAlert({
    snapshot: snapshot({
      snapshotId: "ts_below-aaaaaaaa-aaaa-aaaa-aaaaaaaaaaaa",
      costMinor: 79_999,
      netCostMinor: 100_000
    })
  });
  assert.equal(below.status, "BELOW_THRESHOLD");
  assert.equal(active.store.listBudgetRequests().length, 0);

  const exact = await active.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot() });
  assert.equal(exact.status, "ALERT_DELIVERED");
  const request = active.store.requireBudgetRequest(exact.requestId);
  assert.equal(request.currentBudgetMinor, 100_000);
  assert.equal(request.metadata.suggestedTargetMinor, 120_000);
  assert.equal(request.guardrails.maxBudgetMinor, 600_000);
  assert.equal(request.campaignId, snapshot().campaignRef);
  assert.equal(request.metadata.observedCampaignId, null);
  assert.equal(request.metadata.telemetryOnly, true);
  assert.equal(request.metadata.dryRun, true);
  assert.equal(request.metadata.executionMode, "APPROVAL_ONLY");
  assert.match(JSON.stringify(active.line.pushes[0].message), /DRY-RUN|ทดสอบ/);
  assert.equal(active.tiktok.calls.length, 0);

  const repeated = await active.service.processTelemetrySnapshotForDryRunAlert({
    snapshot: snapshot({ snapshotId: "ts_newer-aaaaaaaa-aaaa-aaaa-aaaaaaaaaaaa" })
  });
  assert.equal(repeated.status, "SKIP_ACTIVE_REQUEST");
  assert.equal(active.store.listBudgetRequests().length, 1);
});

test("telemetry evaluator independently blocks stale, date/window, source, and cap violations", async (t) => {
  const cases = [
    [
      "SKIP_STALE_SNAPSHOT",
      {},
      snapshot({ observedAt: "2026-07-20T04:40:00.000Z" })
    ],
    [
      "SKIP_CAMPAIGN_NAME_MISMATCH",
      {},
      snapshot({ campaignName: "2026-07-19 06:00:00" })
    ],
    [
      "SKIP_CLIENT_BINDING_MISMATCH",
      {},
      snapshot({ source: { browserProfile: "Work", tabGroup: "Ppan" } })
    ],
    [
      "SKIP_OVER_POLICY_CAP",
      {},
      snapshot({
        dailyBudgetMinor: 600_001,
        totalBudgetMinor: 600_001,
        costMinor: 480_001,
        policy: { maxDailyBudgetMinor: 600_000, overDailyBudgetCap: true }
      })
    ],
    [
      "SKIP_NO_SAFE_INCREASE",
      {},
      snapshot({ dailyBudgetMinor: 600_000, totalBudgetMinor: 600_000, costMinor: 480_000 })
    ],
    [
      "SKIP_OUTSIDE_LIVE_WINDOW",
      { now: () => new Date("2026-07-20T16:00:00.000Z") },
      snapshot({ observedAt: "2026-07-20T15:59:30.000Z" })
    ]
  ];

  for (const [expected, options, input] of cases) {
    const current = harness(options);
    t.after(() => current.store.close());
    const result = await current.service.processTelemetrySnapshotForDryRunAlert({ snapshot: input });
    assert.equal(result.status, expected);
    assert.equal(current.store.listBudgetRequests().length, 0);
    assert.equal(current.line.pushes.length, 0);
    assert.equal(current.tiktok.calls.length, 0);
  }

  const revoked = harness();
  t.after(() => revoked.store.close());
  revoked.store.isTelemetrySnapshotCredentialActive = () => false;
  assert.equal(
    (await revoked.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot() })).status,
    "SKIP_REVOKED_TELEMETRY_CREDENTIAL"
  );
  assert.equal(revoked.store.listBudgetRequests().length, 0);
});

test("telemetry dry-run supports the +20% preset/manual cap and confirmation never queues TikTok", async (t) => {
  const current = harness();
  t.after(() => current.store.close());
  const alert = await current.service.processTelemetrySnapshotForDryRunAlert({
    snapshot: snapshot({ dailyBudgetMinor: 590_000, totalBudgetMinor: 590_000, costMinor: 472_000 })
  });
  let request = current.store.requireBudgetRequest(alert.requestId);
  assert.equal(request.metadata.suggestedTargetMinor, 600_000);

  await current.service.handleLineEvents([{
    webhookEventId: "telemetry-suggest",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  request = current.store.requireBudgetRequest(request.id);
  assert.equal(request.state, RequestState.PENDING_APPROVAL);
  assert.equal(request.targetBudgetMinor, 600_000);
  assert.match(JSON.stringify(current.line.replies.at(-1).message), /ไม่แก้งบจริง|DRY-RUN/);
  assert.throws(
    () => current.store.enqueueExecutionJob({
      requestId: request.id,
      actorLineUserId: "U1",
      createdAt: liveNow
    }),
    (error) => error?.code === "TELEMETRY_ONLY_REQUEST"
  );

  await current.service.handleLineEvents([{
    webhookEventId: "telemetry-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-confirm",
    postback: { data: `a=confirm&id=${request.id}&v=${request.version}` }
  }]);
  request = current.store.requireBudgetRequest(request.id);
  assert.equal(request.state, RequestState.CANCELLED);
  assert.match(request.cancellation.reason, /^Dry run:/);
  assert.equal(current.store.getExecutionJob(request.id), null);
  assert.equal(current.tiktok.calls.length, 0);
  assert.match(current.line.pushes.at(-1).message.text, /ยังไม่แก้งบ|ไม่มีการเปลี่ยนงบจริง|ทดสอบสำเร็จ/);
});

test("typed telemetry target may reach but never exceed the 6,000 THB cap", async (t) => {
  const accepted = harness();
  t.after(() => accepted.store.close());
  const first = await accepted.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot() });
  const firstRequest = accepted.store.requireBudgetRequest(first.requestId);
  await accepted.service.handleLineEvents([{
    webhookEventId: "telemetry-manual-cap",
    type: "message",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-manual-cap",
    message: { type: "text", text: `งบ ${requestCodeFor(firstRequest.id)} 6000` }
  }]);
  assert.equal(accepted.store.requireBudgetRequest(firstRequest.id).targetBudgetMinor, 600_000);

  const rejected = harness();
  t.after(() => rejected.store.close());
  const second = await rejected.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot() });
  const secondRequest = rejected.store.requireBudgetRequest(second.requestId);
  await rejected.service.handleLineEvents([{
    webhookEventId: "telemetry-manual-over-cap",
    type: "message",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-manual-over-cap",
    message: { type: "text", text: `งบ ${requestCodeFor(secondRequest.id)} 6000.01` }
  }]);
  assert.equal(rejected.store.requireBudgetRequest(secondRequest.id).state, RequestState.PENDING_INPUT);
  assert.match(rejected.line.replies.at(-1).message.text, /ใช้ไม่ได้|ceiling/i);
  assert.equal(rejected.tiktok.calls.length, 0);
});

test("confirmation rechecks request expiry before any dry-run completion or queue", async (t) => {
  let clock = new Date(liveNow);
  const current = harness({ now: () => new Date(clock) });
  t.after(() => current.store.close());
  const alert = await current.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot() });
  let request = current.store.requireBudgetRequest(alert.requestId);
  await current.service.handleLineEvents([{
    webhookEventId: "telemetry-expiry-suggest",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-expiry-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  request = current.store.requireBudgetRequest(request.id);
  clock = new Date(request.expiresAt);
  await current.service.handleLineEvents([{
    webhookEventId: "telemetry-expiry-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-expiry-confirm",
    postback: { data: `a=confirm&id=${request.id}&v=${request.version}` }
  }]);
  assert.equal(current.store.requireBudgetRequest(request.id).state, RequestState.EXPIRED);
  assert.equal(current.store.getExecutionJob(request.id), null);
  assert.equal(current.tiktok.calls.length, 0);
  assert.match(current.line.replies.at(-1).message.text, /หมดอายุ/);
});

test("a verified daily-budget change bypasses cooldown, starts a new round, and notifies once", async (t) => {
  const current = harness();
  t.after(() => current.store.close());
  const firstAlert = await current.service.processTelemetrySnapshotForDryRunAlert({ snapshot: snapshot() });
  let firstRequest = current.store.requireBudgetRequest(firstAlert.requestId);
  await current.service.handleLineEvents([{
    webhookEventId: "telemetry-round-suggest",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-round-suggest",
    postback: { data: `a=suggest&id=${firstRequest.id}` }
  }]);
  firstRequest = current.store.requireBudgetRequest(firstRequest.id);
  await current.service.handleLineEvents([{
    webhookEventId: "telemetry-round-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-round-confirm",
    postback: { data: `a=confirm&id=${firstRequest.id}&v=${firstRequest.version}` }
  }]);
  assert.equal(current.store.requireBudgetRequest(firstRequest.id).state, RequestState.CANCELLED);

  const unchanged = await current.service.processTelemetrySnapshotForDryRunAlert({
    snapshot: snapshot({ snapshotId: "ts_same-budget-after-terminal-aaaaaaaaaaaa" })
  });
  assert.equal(unchanged.status, "SKIP_COOLDOWN");

  const changedBelow = await current.service.processTelemetrySnapshotForDryRunAlert({
    snapshot: snapshot({
      snapshotId: "ts_changed-budget-below-threshold-aaaaaaaa",
      dailyBudgetMinor: 120_000,
      totalBudgetMinor: 120_000,
      costMinor: 60_000
    })
  });
  assert.equal(changedBelow.status, "BELOW_THRESHOLD");
  const changeMessages = () => current.line.pushes.filter(({ message }) =>
    typeof message?.text === "string" && message.text.includes("ปรับงบแล้ว")
  );
  assert.equal(changeMessages().length, 1);
  assert.match(changeMessages()[0].message.text, /ระบบนี้ไม่ได้แก้ TikTok/);

  const repeatedChanged = await current.service.processTelemetrySnapshotForDryRunAlert({
    snapshot: snapshot({
      snapshotId: "ts_changed-budget-repeated-aaaaaaaaaaaaa",
      dailyBudgetMinor: 120_000,
      totalBudgetMinor: 120_000,
      costMinor: 60_000
    })
  });
  assert.equal(repeatedChanged.status, "BELOW_THRESHOLD");
  assert.equal(changeMessages().length, 1);

  const secondAlert = await current.service.processTelemetrySnapshotForDryRunAlert({
    snapshot: snapshot({
      snapshotId: "ts_changed-budget-at-threshold-aaaaaaaaa",
      dailyBudgetMinor: 120_000,
      totalBudgetMinor: 120_000,
      costMinor: 96_000
    })
  });
  assert.equal(secondAlert.status, "ALERT_DELIVERED");
  const secondRequest = current.store.requireBudgetRequest(secondAlert.requestId);
  assert.notEqual(secondRequest.id, firstRequest.id);
  assert.equal(secondRequest.currentBudgetMinor, 120_000);
  assert.equal(secondRequest.metadata.suggestedTargetMinor, 144_000);
  assert.equal(changeMessages().length, 1);
  assert.equal(current.tiktok.calls.length, 0);

  const sentAudits = current.store.listAuditEvents({
    requestId: firstRequest.id,
    eventType: "LINE_BUDGET_CHANGE_SENT",
    limit: 1000
  });
  assert.equal(sentAudits.length, 1);
  assert.equal(sentAudits[0].details.observedBudgetMinor, 120_000);
});

test("latest-snapshot worker records one persistent evaluation marker", async () => {
  const input = snapshot({ costMinor: 79_999 });
  const evaluations = new Map();
  const store = {
    listLatestTelemetry() { return [input]; },
    getTelemetryAlertEvaluation(snapshotId) { return evaluations.get(snapshotId) ?? null; },
    getLatestBudgetRequest() { return null; },
    recordTelemetryAlertEvaluation(value) {
      evaluations.set(value.snapshotId, value);
      return value;
    }
  };
  const service = new BudgetGuardService({
    config: config(),
    store,
    line: new FakeLine(),
    tiktok: new ForbiddenTikTok(),
    telemetryAlertsEnabled: true,
    now: () => new Date(liveNow)
  });
  assert.equal((await service.processLatestTelemetryDryRunAlerts()).length, 1);
  assert.equal(evaluations.get(input.snapshotId).status, "BELOW_THRESHOLD");
  assert.equal((await service.processLatestTelemetryDryRunAlerts()).length, 0);
  await assert.rejects(
    () => service.processLatestTelemetryDryRunAlerts({ limit: 0 }),
    (error) => error?.code === "INVALID_REQUEST"
  );
});

test("latest-snapshot worker records evaluator errors once instead of retrying forever", async () => {
  const input = snapshot();
  const evaluations = new Map();
  const logs = [];
  const store = {
    listLatestTelemetry() { return [input]; },
    getTelemetryAlertEvaluation(snapshotId) { return evaluations.get(snapshotId) ?? null; },
    recordTelemetryAlertEvaluation(value) {
      evaluations.set(value.snapshotId, value);
      return value;
    },
    isTelemetrySnapshotCredentialActive() { return true; },
    listLineApprovers() { return []; },
    getLatestBudgetRequest() { return null; }
  };
  const noApprovers = config();
  noApprovers.clients[0].lineApproverUserIds = [];
  const service = new BudgetGuardService({
    config: noApprovers,
    store,
    line: new FakeLine(),
    tiktok: new ForbiddenTikTok(),
    telemetryAlertsEnabled: true,
    logger: { error(message, details) { logs.push({ message, details }); } },
    now: () => new Date(liveNow)
  });

  const first = await service.processLatestTelemetryDryRunAlerts();
  assert.equal(first[0].status, "ERROR");
  assert.equal(first[0].errorCode, "NO_LINE_APPROVER");
  assert.equal(evaluations.get(input.snapshotId).status, "ERROR");
  assert.equal(logs.length, 1);
  assert.equal((await service.processLatestTelemetryDryRunAlerts()).length, 0);
  assert.equal(logs.length, 1);
});
