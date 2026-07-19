import assert from "node:assert/strict";
import test from "node:test";
import { RequestState } from "../src/domain.js";
import { requestCodeFor } from "../src/line.js";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";

const liveNow = new Date("2026-07-19T04:00:00.000Z");

function dynamicConfig() {
  return {
    agencyId: "agency",
    pollIntervalSeconds: 300,
    requestTtlMinutes: 15,
    warningThreshold: 0.7,
    cooldownMinutes: 30,
    reconciliationWindowMinutes: 15,
    clients: [{
      id: "punpan_020",
      name: "punpan_020",
      lineApproverUserIds: ["U1"],
      linePairingEnabled: false,
      advertiserId: "adv",
      storeId: "shop",
      storeAuthorizedBcId: "bc",
      timezone: "Asia/Bangkok",
      liveWindow: { start: "06:00", end: "23:00" },
      warningThreshold: 0.8,
      campaignSelector: {
        kind: "active-live-gmv-max",
        currency: "THB",
        expectedTikTokAccountId: "tt-account",
        requireExactlyOne: true
      },
      budgetIncrease: { presetPercent: 20, allowManualTarget: true },
      budgetPolicy: { maxDailyBudget: 6000, effectiveFrom: "2026-07-19", revision: 1 }
    }]
  };
}

class DynamicLine {
  pushes = [];
  replies = [];
  async push(to, message, retryKey) { this.pushes.push({ to, message, retryKey }); }
  async reply(replyToken, message) { this.replies.push({ replyToken, message }); }
}

class DynamicTikTok {
  budget = 1000;
  spend = 800;
  campaignRows = [{ campaign_id: "daily-campaign", campaign_name: "2026-07-19 06:00:00" }];
  accountIds = ["tt-account"];
  updates = [];
  listCalls = 0;

  async getLiveCampaigns() {
    this.listCalls += 1;
    return this.campaignRows;
  }

  async getCampaignInfo({ campaignId }) {
    const row = this.campaignRows.find((item) => item.campaign_id === campaignId);
    return {
      advertiserId: "adv",
      campaignId,
      campaignName: row?.campaign_name ?? "unknown",
      storeId: "shop",
      storeAuthorizedBcId: "bc",
      shoppingAdsType: "LIVE",
      operationStatus: "ENABLE",
      budget: this.budget,
      raw: { tiktok_account_ids: this.accountIds }
    };
  }

  async getTodayCampaignSpend() { return { spend: this.spend, currency: "THB" }; }

  async updateCampaignBudget(input) {
    this.updates.push(input);
    this.budget = input.budget;
    return { requestId: "tt-dynamic-update" };
  }
}

function makeDynamicService({ now = () => new Date(liveNow), executionEnabled = true } = {}) {
  const config = dynamicConfig();
  const store = new SqliteStore(":memory:");
  const line = new DynamicLine();
  const tiktok = new DynamicTikTok();
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok,
    executionEnabled,
    logger: { error() {} },
    now
  });
  return { config, store, line, tiktok, service };
}

async function queueSuggestedApproval({ service, store }, eventKey) {
  await service.pollOnce();
  const [request] = store.listBudgetRequests({ state: RequestState.PENDING_INPUT });
  await service.handleLineEvents([{
    webhookEventId: `${eventKey}-suggest`,
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: `${eventKey}-suggest-reply`,
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  const pending = store.requireBudgetRequest(request.id);
  await service.handleLineEvents([{
    webhookEventId: `${eventKey}-confirm`,
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: `${eventKey}-confirm-reply`,
    postback: { data: `a=confirm&id=${request.id}&v=${pending.version}` }
  }]);
  return request;
}

test("dynamic monitor alerts at 80%, snapshots +20% and cap, then re-resolves before update", async (t) => {
  const { store, line, tiktok, service } = makeDynamicService();
  t.after(() => store.close());

  const outcomes = await service.pollOnce();
  assert.equal(outcomes[0].status, "ALERT_DELIVERED");
  const [request] = store.listBudgetRequests({ state: RequestState.PENDING_INPUT });
  assert.equal(request.campaignId, "daily-campaign");
  assert.equal(request.currentBudgetMinor, 100000);
  assert.equal(request.metadata.suggestedTargetMinor, 120000);
  assert.equal(request.guardrails.maxBudgetMinor, 600000);
  assert.equal(request.guardrails.maxIncreaseMinor, 500000);
  assert.equal(request.metadata.dynamicPolicy.revision, 1);
  assert.match(JSON.stringify(line.pushes[0].message), /เพิ่มงบ 20%/);
  assert.match(JSON.stringify(line.pushes[0].message), /6000/);

  await service.handleLineEvents([{
    webhookEventId: "dynamic-suggest",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  const pending = store.requireBudgetRequest(request.id);
  assert.equal(pending.targetBudgetMinor, 120000);

  await service.handleLineEvents([{
    webhookEventId: "dynamic-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-confirm",
    postback: { data: `a=confirm&id=${request.id}&v=${pending.version}` }
  }]);
  await service.processExecutionJobs();

  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.SUCCEEDED);
  assert.deepEqual(tiktok.updates, [{ advertiserId: "adv", campaignId: "daily-campaign", budget: 1200 }]);
  assert.ok(tiktok.listCalls >= 3);
});

test("dynamic monitor uses the client 80% boundary exactly", async (t) => {
  const below = makeDynamicService();
  t.after(() => below.store.close());
  below.tiktok.spend = 799.99;
  assert.equal((await below.service.pollOnce())[0].status, "BELOW_THRESHOLD");
  assert.equal(below.line.pushes.length, 0);

  const exact = makeDynamicService();
  t.after(() => exact.store.close());
  exact.tiktok.spend = 800;
  assert.equal((await exact.service.pollOnce())[0].status, "ALERT_DELIVERED");
});

test("dynamic selector fails closed for campaign ambiguity or a non-unique TikTok identity", async (t) => {
  const ambiguous = makeDynamicService();
  t.after(() => ambiguous.store.close());
  ambiguous.tiktok.campaignRows = [
    { campaign_id: "daily-1", campaign_name: "2026-07-19 06:00:00" },
    { campaign_id: "daily-2", campaign_name: "2026-07-19 06:00:00" }
  ];
  const ambiguousOutcome = await ambiguous.service.pollOnce();
  assert.equal(ambiguousOutcome[0].status, "ERROR");
  assert.equal(ambiguousOutcome[0].error.code, "DYNAMIC_CAMPAIGN_AMBIGUOUS");
  assert.equal(ambiguous.tiktok.updates.length, 0);

  const missingIdentity = makeDynamicService();
  t.after(() => missingIdentity.store.close());
  missingIdentity.tiktok.accountIds = [];
  const missingOutcome = await missingIdentity.service.pollOnce();
  assert.equal(missingOutcome[0].status, "ERROR");
  assert.equal(missingOutcome[0].error.code, "TIKTOK_ACCOUNT_ID_UNVERIFIED");
  assert.equal(missingIdentity.tiktok.updates.length, 0);

  const multipleIdentities = makeDynamicService();
  t.after(() => multipleIdentities.store.close());
  multipleIdentities.tiktok.accountIds = ["tt-account", "another-account"];
  const multipleOutcome = await multipleIdentities.service.pollOnce();
  assert.equal(multipleOutcome[0].status, "ERROR");
  assert.equal(multipleOutcome[0].error.code, "TIKTOK_ACCOUNT_ID_AMBIGUOUS");
  assert.equal(multipleIdentities.line.pushes.length, 0);
  assert.equal(multipleIdentities.tiktok.updates.length, 0);
});

test("dynamic execution refuses a TikTok identity that becomes ambiguous after approval", async (t) => {
  const context = makeDynamicService();
  const { store, tiktok, service } = context;
  t.after(() => store.close());
  const request = await queueSuggestedApproval(context, "identity-change");

  tiktok.accountIds = ["tt-account", "another-account"];
  await service.processExecutionJobs();

  const cancelled = store.requireBudgetRequest(request.id);
  assert.equal(cancelled.state, RequestState.CANCELLED);
  assert.equal(cancelled.cancellation.reason, "TIKTOK_ACCOUNT_ID_AMBIGUOUS");
  assert.equal(tiktok.updates.length, 0);
});

test("a missing daily campaign inside the LIVE window is surfaced as an error", async (t) => {
  const missing = makeDynamicService();
  t.after(() => missing.store.close());
  missing.tiktok.campaignRows = [];

  const [outcome] = await missing.service.pollOnce();
  assert.equal(outcome.status, "ERROR");
  assert.equal(outcome.error.code, "DYNAMIC_CAMPAIGN_NOT_FOUND");
  assert.equal(missing.line.pushes.length, 0);
  assert.equal(missing.tiktok.updates.length, 0);
});

test("manual LINE target can use the full cap but not exceed it", async (t) => {
  const { store, line, service } = makeDynamicService({ executionEnabled: false });
  t.after(() => store.close());
  await service.pollOnce();
  const [request] = store.listBudgetRequests({ state: RequestState.PENDING_INPUT });
  const code = requestCodeFor(request.id);

  await service.handleLineEvents([{
    webhookEventId: "manual-cap",
    type: "message",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-manual-cap",
    message: { type: "text", text: `งบ ${code} 6000` }
  }]);
  assert.equal(store.requireBudgetRequest(request.id).targetBudgetMinor, 600000);
  assert.match(line.replies.at(-1).message.altText, /ยืนยันงบใหม่/);

  const over = makeDynamicService({ executionEnabled: false });
  t.after(() => over.store.close());
  await over.service.pollOnce();
  const [overRequest] = over.store.listBudgetRequests({ state: RequestState.PENDING_INPUT });
  await over.service.handleLineEvents([{
    webhookEventId: "manual-over-cap",
    type: "message",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-manual-over-cap",
    message: { type: "text", text: `งบ ${requestCodeFor(overRequest.id)} 6000.01` }
  }]);
  assert.equal(over.store.requireBudgetRequest(overRequest.id).state, RequestState.PENDING_INPUT);
  assert.match(over.line.replies.at(-1).message.text, /ใช้ไม่ได้/);
});

test("preset-only snapshot rejects forged custom postback and typed budget", async (t) => {
  const context = makeDynamicService({ executionEnabled: false });
  const { config, store, line, service } = context;
  t.after(() => store.close());
  config.clients[0].budgetIncrease.allowManualTarget = false;
  await service.pollOnce();
  const [request] = store.listBudgetRequests({ state: RequestState.PENDING_INPUT });

  assert.equal(request.metadata.allowManualTarget, false);
  assert.doesNotMatch(JSON.stringify(line.pushes[0].message), /a=custom|กรอกงบเอง/);

  await service.handleLineEvents([{
    webhookEventId: "preset-only-custom",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-preset-only-custom",
    postback: { data: `a=custom&id=${request.id}` }
  }]);
  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.PENDING_INPUT);
  assert.match(line.replies.at(-1).message.text, /เฉพาะงบที่ระบบแนะนำ/);

  await service.handleLineEvents([{
    webhookEventId: "preset-only-text",
    type: "message",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-preset-only-text",
    message: { type: "text", text: `งบ ${requestCodeFor(request.id)} 6000` }
  }]);
  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.PENDING_INPUT);
  assert.match(line.replies.at(-1).message.text, /ไม่อนุญาตให้กรอกงบเอง/);
});

test("dynamic execution cancels if the policy revision changes after LINE alert", async (t) => {
  const { config, store, tiktok, service } = makeDynamicService();
  t.after(() => store.close());
  await service.pollOnce();
  const [request] = store.listBudgetRequests({ state: RequestState.PENDING_INPUT });
  await service.handleLineEvents([{
    webhookEventId: "policy-suggest",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-policy-suggest",
    postback: { data: `a=suggest&id=${request.id}` }
  }]);
  const pending = store.requireBudgetRequest(request.id);
  config.clients[0].budgetPolicy.revision = 2;
  await service.handleLineEvents([{
    webhookEventId: "policy-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-policy-confirm",
    postback: { data: `a=confirm&id=${request.id}&v=${pending.version}` }
  }]);
  await service.processExecutionJobs();

  assert.equal(store.requireBudgetRequest(request.id).state, RequestState.CANCELLED);
  assert.equal(tiktok.updates.length, 0);
});

test("dynamic execution compares every authority field even without a revision bump", async (t) => {
  const cases = [
    ["presetPercent", (client) => { client.budgetIncrease.presetPercent = 25; }],
    ["allowManualTarget", (client) => { client.budgetIncrease.allowManualTarget = false; }],
    ["expectedTikTokAccountId", (client) => { client.campaignSelector.expectedTikTokAccountId = "different-account"; }],
    ["liveWindow", (client) => { client.liveWindow.end = "22:00"; }],
    ["maxDailyBudget", (client) => { client.budgetPolicy.maxDailyBudget = 7000; }],
    ["effectiveFrom", (client) => { client.budgetPolicy.effectiveFrom = "2026-07-18"; }],
    ["timezone", (client) => { client.timezone = "Asia/Singapore"; }],
    ["selector currency", (client) => { client.campaignSelector.currency = "USD"; }],
    ["selector kind", (client) => { client.campaignSelector.kind = "changed-selector"; }],
    ["requireExactlyOne", (client) => { client.campaignSelector.requireExactlyOne = false; }]
  ];

  for (const [index, [name, mutate]] of cases.entries()) {
    await t.test(name, async () => {
      const context = makeDynamicService();
      const { config, store, tiktok, service } = context;
      try {
        const request = await queueSuggestedApproval(context, `authority-${index}`);
        mutate(config.clients[0]);
        assert.equal(config.clients[0].budgetPolicy.revision, 1);

        await service.processExecutionJobs();

        const cancelled = store.requireBudgetRequest(request.id);
        assert.equal(cancelled.state, RequestState.CANCELLED);
        assert.equal(cancelled.cancellation.reason, "BUDGET_POLICY_CHANGED");
        assert.equal(tiktok.updates.length, 0);
      } finally {
        store.close();
      }
    });
  }
});

test("dynamic execution rejects a request after its local policy date changes", async (t) => {
  let current = new Date("2026-07-19T15:59:00.000Z"); // 22:59 Asia/Bangkok
  const context = makeDynamicService({ now: () => new Date(current) });
  const { config, store, tiktok, service } = context;
  t.after(() => store.close());
  config.requestTtlMinutes = 600;
  const request = await queueSuggestedApproval(context, "policy-date");

  current = new Date("2026-07-19T23:00:00.000Z"); // 06:00 next local date
  await service.processExecutionJobs();

  const cancelled = store.requireBudgetRequest(request.id);
  assert.equal(cancelled.state, RequestState.CANCELLED);
  assert.equal(cancelled.cancellation.reason, "BUDGET_POLICY_CHANGED");
  assert.equal(tiktok.updates.length, 0);
});

test("dynamic monitoring stays read-only outside the approved LIVE window", async (t) => {
  const outsideNow = () => new Date("2026-07-19T16:00:00.000Z"); // 23:00 Asia/Bangkok
  const { store, tiktok, service } = makeDynamicService({ now: outsideNow });
  t.after(() => store.close());
  const outcome = await service.pollOnce();
  assert.equal(outcome[0].status, "SKIP_OUTSIDE_LIVE_WINDOW");
  assert.equal(tiktok.listCalls, 0);
  assert.equal(tiktok.updates.length, 0);
});
