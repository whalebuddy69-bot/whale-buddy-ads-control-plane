import assert from "node:assert/strict";
import test from "node:test";
import { RequestState } from "../src/domain.js";
import { requestCodeFor } from "../src/line.js";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";

const fixedNow = new Date("2026-07-18T04:00:00.000Z");

function makeConfig() {
  return {
    agencyId: "agency",
    pollIntervalSeconds: 300,
    requestTtlMinutes: 15,
    warningThreshold: 0.7,
    cooldownMinutes: 30,
    reconciliationWindowMinutes: 15,
    clients: [{
      id: "client",
      name: "ลูกค้า",
      lineApproverUserIds: ["U1"],
      advertiserId: "adv",
      storeId: "shop",
      storeAuthorizedBcId: "bc",
      timezone: "Asia/Bangkok",
      campaigns: [{
        id: "cmp",
        name: "LIVE Main",
        currency: "THB",
        maxDailyBudget: 30000,
        maxIncreasePercent: 100,
        suggestionMultiplier: 1.5,
        minIncrease: 1000
      }]
    }]
  };
}

class FakeLine {
  pushes = [];
  replies = [];
  pushAttempts = [];
  failPushes = false;
  pushFailuresRemaining = 0;
  async push(to, message, retryKey) {
    this.pushAttempts.push({ to, message, retryKey });
    if (this.failPushes || this.pushFailuresRemaining > 0) {
      if (this.pushFailuresRemaining > 0) this.pushFailuresRemaining -= 1;
      throw new Error("LINE unavailable");
    }
    this.pushes.push({ to, message, retryKey });
  }
  async reply(replyToken, message) { this.replies.push({ replyToken, message }); }
}

class FakeTikTok {
  budget = 10000;
  spend = 8000;
  updates = [];
  infoReads = 0;
  spendReads = 0;
  async getCampaignInfo() {
    this.infoReads += 1;
    return {
      advertiserId: "adv",
      campaignId: "cmp",
      storeId: "shop",
      storeAuthorizedBcId: "bc",
      budget: this.budget,
      operationStatus: "ENABLE",
      shoppingAdsType: "LIVE"
    };
  }
  async getTodayCampaignSpend() {
    this.spendReads += 1;
    return { spend: this.spend };
  }
  async updateCampaignBudget(input) {
    this.updates.push(input);
    this.budget = input.budget;
    return { requestId: "tt-update-1", data: {} };
  }
}

function makeService({ executionEnabled = true, tiktok: tiktokOverride } = {}) {
  const store = new SqliteStore(":memory:");
  const line = new FakeLine();
  const tiktok = tiktokOverride ?? new FakeTikTok();
  const service = new BudgetGuardService({
    config: makeConfig(),
    store,
    line,
    tiktok,
    executionEnabled,
    logger: { error() {} },
    now: () => new Date(fixedNow)
  });
  return { service, store, line, tiktok };
}

async function createDryRunTerminal(service, eventSuffix) {
  const currentConfig = makeConfig();
  const request = await service.createAndSendRequest({
    client: currentConfig.clients[0],
    campaign: currentConfig.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: `evt-budget-aware-${eventSuffix}`,
    type: "postback",
    source: { userId: "U1" },
    replyToken: `reply-budget-aware-${eventSuffix}`,
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  return service.executeApprovedRequest(request.id, "U1");
}

test("monitor sends one alert and suppresses a second active request", async (t) => {
  const { service, store, line } = makeService();
  t.after(() => store.close());
  const first = await service.pollOnce();
  assert.equal(first[0].status, "ALERT_DELIVERED");
  assert.equal(line.pushes.length, 1);
  assert.equal(store.listBudgetRequests({ state: RequestState.PENDING_INPUT }).length, 1);
  const second = await service.pollOnce();
  assert.equal(second[0].status, "SKIP_ACTIVE_REQUEST");
});

test("an undelivered LINE alert remains visible and retries with the same idempotency key", async (t) => {
  const { service, store, line } = makeService();
  t.after(() => store.close());
  line.failPushes = true;
  const first = await service.pollOnce();
  assert.equal(first[0].status, "ALERT_PENDING");
  assert.equal(store.listBudgetRequests({ state: RequestState.PENDING_INPUT }).length, 1);
  const firstRetryKey = line.pushAttempts[0].retryKey;

  line.failPushes = false;
  const second = await service.pollOnce();
  assert.equal(second[0].status, "ALERT_DELIVERED");
  assert.equal(line.pushAttempts[1].retryKey, firstRetryKey);
  assert.equal(store.listBudgetRequests({ state: RequestState.PENDING_INPUT }).length, 1);
});

test("LINE approval is two-step and execution re-verifies then updates", async (t) => {
  const { service, store, line, tiktok } = makeService();
  t.after(() => store.close());
  const request = await service.createAndSendRequest({
    client: makeConfig().clients[0],
    campaign: makeConfig().clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-1",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-1",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  let updated = store.requireBudgetRequest(request.id);
  assert.equal(updated.state, RequestState.PENDING_APPROVAL);
  assert.equal(line.replies.length, 1);

  await service.handleLineEvents([{
    webhookEventId: "evt-2",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-2",
    postback: { data: `a=confirm&id=${request.id}&v=${updated.version}` }
  }]);
  assert.equal(store.getExecutionJob(request.id).status, "PENDING");
  await service.processExecutionJobs();
  updated = store.requireBudgetRequest(request.id);
  assert.equal(updated.state, RequestState.SUCCEEDED);
  assert.equal(tiktok.updates.length, 1);
  assert.equal(tiktok.updates[0].budget, 15000);
  assert.equal(line.pushes.length, 2);
  assert.match(line.pushes.at(-1).message.text, /ปรับงบแล้ว/);
  await service.retryPendingResults();
  assert.equal(line.pushes.length, 2);
});

test("legacy static requests still accept an explicitly typed budget", async (t) => {
  const { service, store, line } = makeService({ executionEnabled: false });
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });

  assert.equal(request.metadata.allowManualTarget, true);
  await service.handleLineEvents([{
    webhookEventId: "evt-static-manual-budget",
    type: "message",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-static-manual-budget",
    message: { type: "text", text: `งบ ${requestCodeFor(request.id)} 15000` }
  }]);

  assert.equal(store.requireBudgetRequest(request.id).targetBudgetMinor, 1500000);
  assert.match(line.replies.at(-1).message.altText, /ยืนยันงบใหม่/);
});

test("a stale LINE confirmation version cannot execute a budget change", async (t) => {
  const { service, store, line, tiktok } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-stale-suggest",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-stale-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  const pending = store.requireBudgetRequest(request.id);
  assert.equal(pending.state, RequestState.PENDING_APPROVAL);

  await service.handleLineEvents([{
    webhookEventId: "evt-stale-confirm",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-stale-confirm",
    postback: { data: `a=confirm&id=${request.id}&v=${pending.version + 1}` }
  }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.PENDING_APPROVAL);
  assert.equal(tiktok.updates.length, 0);
  assert.match(line.replies.at(-1).message.text, /เวอร์ชันเก่า/);
});

test("a processed confirmation survives a worker restart through the execution outbox", async (t) => {
  const { service, store, line, tiktok } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-outbox-suggest",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-outbox-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  const pending = store.requireBudgetRequest(request.id);
  await service.handleLineEvents([{
    webhookEventId: "evt-outbox-confirm",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-outbox-confirm",
    postback: { data: `a=confirm&id=${request.id}&v=${pending.version}` }
  }]);
  assert.equal(store.getWebhookEvent("LINE", "evt-outbox-confirm").status, "PROCESSED");
  assert.equal(store.getExecutionJob(request.id).status, "PENDING");
  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.PENDING_APPROVAL);

  const restarted = new BudgetGuardService({
    config,
    store,
    line,
    tiktok,
    executionEnabled: true,
    logger: { error() {} },
    now: () => new Date(fixedNow)
  });
  await restarted.processExecutionJobs();
  assert.equal(store.getExecutionJob(request.id).status, "COMPLETED");
  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.SUCCEEDED);
});

test("webhook event IDs are deduplicated", async (t) => {
  const { service, store } = makeService();
  t.after(() => store.close());
  const event = { webhookEventId: "evt-same", type: "message", source: { userId: "U1" }, message: { type: "text", text: "hello" } };
  const first = await service.handleLineEvents([event]);
  const second = await service.handleLineEvents([event]);
  assert.equal(first[0].status, "PROCESSED");
  assert.equal(second[0].status, "DUPLICATE");
});

test("one-time LINE pairing authorizes a direct-chat user without persisting the plaintext code", async (t) => {
  const config = makeConfig();
  config.clients[0].lineApproverUserIds = [];
  config.clients[0].linePairingEnabled = true;
  const store = new SqliteStore(":memory:");
  const line = new FakeLine();
  const tiktok = new FakeTikTok();
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok,
    executionEnabled: false,
    logger: { error() {} },
    now: () => new Date(fixedNow)
  });
  t.after(() => store.close());

  const pairing = service.createLinePairing({ clientId: "client", ttlMinutes: 10 });
  assert.match(pairing.command, /^จับคู่ client [A-Za-z0-9_-]{16,64}$/);

  const result = await service.handleLineEvents([{
    webhookEventId: "evt-pair-user",
    type: "message",
    source: { type: "user", userId: "U-PAIRED" },
    replyToken: "reply-pair-user",
    message: { type: "text", text: pairing.command }
  }]);

  assert.equal(result[0].status, "PROCESSED");
  assert.equal(store.isLineApprover({ clientId: "client", lineUserId: "U-PAIRED" }), true);
  assert.match(line.replies.at(-1).message.text, /จับคู่ผู้อนุมัติสำเร็จ/);
  const webhook = store.getWebhookEvent("LINE", "evt-pair-user");
  assert.equal(JSON.stringify(webhook.payload).includes(pairing.code), false);

  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  assert.deepEqual(request.authorizedLineUserIds, ["U-PAIRED"]);
});

test("LINE pairing refuses group-chat enrollment", async (t) => {
  const config = makeConfig();
  config.clients[0].lineApproverUserIds = [];
  config.clients[0].linePairingEnabled = true;
  const store = new SqliteStore(":memory:");
  const line = new FakeLine();
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok: new FakeTikTok(),
    executionEnabled: false,
    logger: { error() {} },
    now: () => new Date(fixedNow)
  });
  t.after(() => store.close());

  const pairing = service.createLinePairing({ clientId: "client", ttlMinutes: 10 });
  await service.handleLineEvents([{
    webhookEventId: "evt-pair-group",
    type: "message",
    source: { type: "group", groupId: "C1", userId: "U-GROUP" },
    replyToken: "reply-pair-group",
    message: { type: "text", text: pairing.command }
  }]);

  assert.equal(store.isLineApprover({ clientId: "client", lineUserId: "U-GROUP" }), false);
  assert.match(line.replies.at(-1).message.text, /แชตส่วนตัว/);
});

test("a durable LINE command is replayed after a webhook worker crash", async (t) => {
  const { service, store, line } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  store.recordWebhookEvent({
    provider: "LINE",
    eventId: "evt-crashed-before-processing",
    payload: {
      type: "postback",
      command: { kind: "postback", userId: "U1", data: `a=suggest&id=${request.id}` }
    },
    receivedAt: fixedNow
  });

  const outcomes = await service.recoverLineWebhookEvents();

  assert.deepEqual(outcomes, [{ eventId: "evt-crashed-before-processing", status: "RECOVERED" }]);
  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.PENDING_APPROVAL);
  assert.equal(store.getWebhookEvent("LINE", "evt-crashed-before-processing").status, "PROCESSED");
  assert.equal(line.pushes.length, 2);
  assert.match(line.pushes.at(-1).message.altText, /ยืนยันงบใหม่/);
});

test("one failed recovered LINE event cannot starve a later durable command", async (t) => {
  const { service, store, line } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  for (const [eventId, action] of [["evt-recovery-first", "suggest"], ["evt-recovery-second", "custom"]]) {
    store.recordWebhookEvent({
      provider: "LINE",
      eventId,
      payload: { command: { kind: "postback", userId: "U1", data: `a=${action}&id=${request.id}` } },
      receivedAt: fixedNow
    });
  }
  line.pushFailuresRemaining = 1;

  const outcomes = await service.recoverLineWebhookEvents();

  assert.deepEqual(outcomes.map(({ eventId, status }) => ({ eventId, status })), [
    { eventId: "evt-recovery-first", status: "FAILED" },
    { eventId: "evt-recovery-second", status: "RECOVERED" }
  ]);
  assert.equal(store.getWebhookEvent("LINE", "evt-recovery-first").attemptCount, 1);
  assert.equal(store.getWebhookEvent("LINE", "evt-recovery-second").status, "PROCESSED");
});

test("fresh webhook commands outrank an older page of permanent recovery failures", async (t) => {
  const { service, store, line } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  line.failPushes = true;
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  for (const [eventId, action] of [
    ["evt-page-01", "suggest"],
    ["evt-page-02", "custom"],
    ["evt-page-03", "custom"]
  ]) {
    store.recordWebhookEvent({
      provider: "LINE",
      eventId,
      payload: { command: { kind: "postback", userId: "U1", data: `a=${action}&id=${request.id}` } },
      receivedAt: fixedNow
    });
  }

  await service.recoverLineWebhookEvents({ maxEvents: 2 });
  assert.equal(store.getWebhookEvent("LINE", "evt-page-03").status, "RECEIVED");
  await service.recoverLineWebhookEvents({ maxEvents: 2 });

  assert.equal(store.getWebhookEvent("LINE", "evt-page-03").attemptCount, 1);
  assert.equal(store.getWebhookEvent("LINE", "evt-page-01").attemptCount, 2);
  assert.equal(store.getWebhookEvent("LINE", "evt-page-02").attemptCount, 1);
});

test("recovered reject reports the actual state when another approval already won", async (t) => {
  const { service, store, line } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  const pending = store.submitBudgetAmount(request.id, {
    actorLineUserId: "U1",
    increaseMinor: 500000,
    now: fixedNow
  });
  store.enqueueExecutionJob({ requestId: request.id, actorLineUserId: "U1", createdAt: fixedNow });
  await service.processExecutionJobs();
  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.SUCCEEDED);
  store.recordWebhookEvent({
    provider: "LINE",
    eventId: "evt-late-reject",
    payload: { command: { kind: "postback", userId: "U1", data: `a=reject&id=${pending.id}` } },
    receivedAt: fixedNow
  });

  await service.recoverLineWebhookEvents();

  assert.match(line.pushes.at(-1).message.text, /ไม่ได้ยกเลิกคำขอ/);
  assert.match(line.pushes.at(-1).message.text, /SUCCEEDED/);
});

test("webhook recovery never pushes request details to an unauthorized LINE user", async (t) => {
  const { service, store, line } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  store.recordWebhookEvent({
    provider: "LINE",
    eventId: "evt-unauthorized-recovery",
    payload: { command: { kind: "postback", userId: "U2", data: `a=suggest&id=${request.id}` } },
    receivedAt: fixedNow
  });

  await service.recoverLineWebhookEvents();

  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.PENDING_INPUT);
  assert.equal(line.pushes.length, 1);
  assert.equal(store.getWebhookEvent("LINE", "evt-unauthorized-recovery").status, "PROCESSED");
});

test("execution kill switch cancels an approved request without touching TikTok", async (t) => {
  const { service, store, tiktok } = makeService({ executionEnabled: false });
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-dry",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-dry",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  const result = await service.executeApprovedRequest(request.id, "U1");
  assert.equal(result.state, RequestState.CANCELLED);
  assert.equal(tiktok.updates.length, 0);
});

test("a terminal request enforces campaign cooldown before another alert", async (t) => {
  const { service, store } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-cooldown-suggest",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-cooldown-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  await service.executeApprovedRequest(request.id, "U1");

  const outcome = await service.pollOnce();
  assert.equal(outcome[0].status, "SKIP_COOLDOWN");
});

test("API monitor reads current budget before cooldown and skips spend unless the budget changed", async (t) => {
  const { service, store, tiktok } = makeService({ executionEnabled: false });
  t.after(() => store.close());
  const terminal = await createDryRunTerminal(service, "monitor");
  assert.equal(terminal.state, RequestState.CANCELLED);
  assert.equal(tiktok.infoReads, 0);
  assert.equal(tiktok.spendReads, 0);

  const unchanged = await service.pollOnce();
  assert.equal(unchanged[0].status, "SKIP_COOLDOWN");
  assert.equal(tiktok.infoReads, 1);
  assert.equal(tiktok.spendReads, 0);

  tiktok.budget = 12000;
  tiktok.spend = 9600;
  const changed = await service.pollOnce();
  assert.equal(changed[0].status, "ALERT_DELIVERED");
  assert.equal(tiktok.infoReads, 2);
  assert.equal(tiktok.spendReads, 1);
  assert.equal(store.requireBudgetRequest(changed[0].requestId).currentBudgetMinor, 1_200_000);
});

test("manual API request keeps unchanged-budget cooldown but bypasses it after a verified change", async (t) => {
  const { service, store, tiktok } = makeService({ executionEnabled: false });
  t.after(() => store.close());
  const terminal = await createDryRunTerminal(service, "manual");
  assert.equal(terminal.state, RequestState.CANCELLED);

  await assert.rejects(
    () => service.createManualRequest({ advertiserId: "adv", campaignId: "cmp", proposedBudget: 15000 }),
    (error) => error?.code === "COOLDOWN_ACTIVE"
  );
  assert.equal(tiktok.infoReads, 1);
  assert.equal(tiktok.spendReads, 0);

  tiktok.budget = 12000;
  tiktok.spend = 9600;
  const changed = await service.createManualRequest({
    advertiserId: "adv",
    campaignId: "cmp",
    proposedBudget: 15000
  });
  assert.equal(changed.currentBudgetMinor, 1_200_000);
  assert.equal(changed.metadata.source, "ADMIN");
  assert.equal(tiktok.infoReads, 2);
  assert.equal(tiktok.spendReads, 1);
});

test("timeout after TikTok applied the absolute budget reconciles to success", async (t) => {
  class TimeoutAfterApplyTikTok extends FakeTikTok {
    async updateCampaignBudget(input) {
      this.updates.push(input);
      this.budget = input.budget;
      const error = new Error("socket closed after write");
      error.code = "TIKTOK_TRANSPORT_ERROR";
      error.outcomeKnown = false;
      throw error;
    }
  }
  const { service, store, tiktok } = makeService({ tiktok: new TimeoutAfterApplyTikTok() });
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-timeout-suggest",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-timeout-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);

  const uncertain = await service.executeApprovedRequest(request.id, "U1");
  assert.equal(uncertain.state, RequestState.EXECUTING);
  assert.equal(tiktok.updates.length, 1);
  const reconciliation = await service.recoverExecutingRequests();
  assert.equal(reconciliation[0].status, "SUCCEEDED");
  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.SUCCEEDED);
});

test("delayed TikTok propagation stays EXECUTING inside the reconciliation window", async (t) => {
  class DelayedTikTok extends FakeTikTok {
    target = null;
    async updateCampaignBudget(input) {
      this.updates.push(input);
      this.target = input.budget;
      return { requestId: "delayed-write", data: {} };
    }
  }
  const delayed = new DelayedTikTok();
  const { service, store } = makeService({ tiktok: delayed });
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-delay-suggest",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-delay-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);

  const uncertain = await service.executeApprovedRequest(request.id, "U1");
  assert.equal(uncertain.state, RequestState.EXECUTING);
  const firstRead = await service.recoverExecutingRequests();
  assert.equal(firstRead[0].status, "RETRY_LATER");
  delayed.budget = delayed.target;
  const secondRead = await service.recoverExecutingRequests();
  assert.equal(secondRead[0].status, "SUCCEEDED");
});

test("execution fails closed when the current multi-account identity changes", async (t) => {
  class WrongBusinessCenterTikTok extends FakeTikTok {
    async getCampaignInfo() {
      return { ...(await super.getCampaignInfo()), storeAuthorizedBcId: "different-bc" };
    }
  }
  const { service, store, tiktok } = makeService({ tiktok: new WrongBusinessCenterTikTok() });
  t.after(() => store.close());
  const config = makeConfig();
  const request = await service.createAndSendRequest({
    client: config.clients[0],
    campaign: config.clients[0].campaigns[0],
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 15000
  });
  await service.handleLineEvents([{
    webhookEventId: "evt-identity-suggest",
    type: "postback",
    source: { userId: "U1" },
    replyToken: "reply-identity-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);

  const result = await service.executeApprovedRequest(request.id, "U1");
  assert.equal(result.state, RequestState.CANCELLED);
  assert.equal(result.cancellation.reason, "BUSINESS_CENTER_MISMATCH");
  assert.equal(tiktok.updates.length, 0);
});

test("minIncrease cannot widen the hard maxIncreasePercent guardrail", async (t) => {
  const { service, store } = makeService();
  t.after(() => store.close());
  const config = makeConfig();
  const campaign = {
    ...config.clients[0].campaigns[0],
    maxIncreasePercent: 10,
    minIncrease: 10000
  };
  await assert.rejects(() => service.createAndSendRequest({
    client: config.clients[0],
    campaign,
    currentBudget: 10000,
    spend: 8000,
    proposedBudget: 20000
  }), (error) => error.code === "NO_SAFE_INCREASE");
});
