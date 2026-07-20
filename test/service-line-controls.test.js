import assert from "node:assert/strict";
import test from "node:test";

import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";

class FakeLine {
  replies = [];
  pushes = [];
  failNextReply = false;
  failNextPush = false;
  async reply(replyToken, message) {
    if (this.failNextReply) {
      this.failNextReply = false;
      throw new Error("temporary LINE reply failure");
    }
    this.replies.push({ replyToken, message });
  }
  async push(to, message, retryKey) {
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error("temporary LINE push failure");
    }
    this.pushes.push({ to, message, retryKey });
  }
}

function controlConfig() {
  return {
    agencyId: "whalebuddy-ads",
    requestTtlMinutes: 15,
    clients: [{
      id: "punpan_020",
      name: "punpan_020",
      lineApproverUserIds: ["U1"],
      advertiserId: "7646832328389263378",
      timezone: "Asia/Bangkok",
      telemetry: {
        source: "chrome-ui",
        browserProfile: "Whalebuddy Ads",
        tabGroup: "Ppan",
        businessCenterId: "7627179356976201745",
        sellerMode: "withoutShop",
        pageType: "live",
        schemaVersion: 2,
        maxSnapshotAgeSeconds: 900
      },
      campaignSelector: {
        kind: "active-live-gmv-max",
        currency: "THB",
        expectedTikTokAccountId: "7285935731820920833",
        requireExactlyOne: true
      },
      liveWindow: { start: "06:00", end: "23:00" },
      budgetPolicy: { maxDailyBudget: 6000, effectiveFrom: "2026-07-19", revision: 1 },
      lineControl: {
        enabled: true,
        aliases: ["Ppan"],
        minDailyBudget: 100,
        minTargetRoi: 0.1,
        maxTargetRoi: 100,
        minTopUpThresholdPercent: 10,
        maxTopUpThresholdPercent: 95,
        minReportIntervalHours: 1,
        maxReportIntervalHours: 24,
        minCouponLeadMinutes: 5,
        maxCouponLeadMinutes: 180
      }
    }]
  };
}

function lineEvent({ id, text, sourceType = "user" }) {
  return {
    webhookEventId: id,
    type: "message",
    source: { type: sourceType, userId: "U1" },
    replyToken: `reply-${id}`,
    message: { type: "text", text }
  };
}

test("Ppan shortcut launch is authorized, versioned, and always dry-run before an executor exists", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    executionEnabled: false,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "shortcut-save",
    text: [
      "ตั้ง shortcut Ppan main",
      "ชื่อ {date} {start}:00",
      "งบ 3000",
      "ROI 3.5",
      "เติมเมื่อ 80%"
    ].join("\n")
  })]);
  assert.equal(store.getCampaignShortcut({
    clientId: "punpan_020",
    shortcutName: "main"
  }).revision, 1);

  await service.handleLineEvents([lineEvent({
    id: "shortcut-open",
    text: "เปิด Ppan main"
  })]);
  const confirmation = line.replies.at(-1).message;
  const serialized = JSON.stringify(confirmation);
  assert.match(serialized, /DRY-RUN/);
  assert.doesNotMatch(serialized, /7646832328389263378/);
  const match = serialized.match(/op=confirm&id=(ca_[0-9a-f]+)&v=1/);
  assert(match);

  await service.handleLineEvents([{
    webhookEventId: "shortcut-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-shortcut-confirm",
    postback: { data: `op=confirm&id=${match[1]}&v=1` }
  }]);
  const request = store.getCampaignControlRequest(match[1]);
  assert.equal(request.state, "CONFIRMED_DRY_RUN");
  assert.equal(request.data.desired.campaignName, "2026-07-20 06:00:00");
  assert.equal(request.data.desired.dailyBudgetMinor, 300_000);
  assert.equal(request.data.desired.targetRoiMilli, 3500);
  assert.match(line.replies.at(-1).message.text, /ไม่มีการเปลี่ยนแปลงบน TikTok/);
});

test("scheduled LINE report is durable and sends a stale/no-data warning once per occurrence", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    executionEnabled: false,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "report-subscribe",
    text: "รายงาน Ppan ทุก 1 ชั่วโมง"
  })]);
  assert.equal(store.getReportSubscription({
    clientId: "punpan_020",
    lineUserId: "U1"
  }).nextDueAt, "2026-07-20T11:00:00.000Z");

  now = new Date("2026-07-20T11:00:00.000Z");
  const outcomes = await service.processScheduledLineControls();
  assert.deepEqual(outcomes, [{ type: "REPORT", clientId: "punpan_020", status: "SENT" }]);
  assert.equal(line.pushes.length, 1);
  assert.match(line.pushes[0].message.text, /ยังไม่มีข้อมูลจาก Chrome reader/);
  assert.equal((await service.processScheduledLineControls()).length, 0);
});

test("campaign controls are refused in a group chat", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    executionEnabled: false,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    logger: { error() {} }
  });
  t.after(() => store.close());
  await service.handleLineEvents([lineEvent({
    id: "group-menu",
    text: "เมนู Ppan",
    sourceType: "group"
  })]);
  assert.match(line.replies[0].message.text, /แชตส่วนตัว/);
});

test("coupon boost is approved in advance and produces a durable timed reminder", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    executionEnabled: false,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "coupon-create",
    text: "คูปอง Ppan 2026-07-20 20:00 ก่อน 30 นาที งบ 5000"
  })]);
  const serialized = JSON.stringify(line.replies.at(-1).message);
  const match = serialized.match(/op=confirm&id=(ca_[0-9a-f]+)&v=1/);
  assert(match);
  await service.handleLineEvents([{
    webhookEventId: "coupon-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-coupon-confirm",
    postback: { data: `op=confirm&id=${match[1]}&v=1` }
  }]);
  assert.match(line.replies.at(-1).message.text, /บันทึก Coupon Boost/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM coupon_schedules WHERE status = 'PENDING'").get().count, 1);

  now = new Date("2026-07-20T12:30:00.000Z");
  const outcomes = await service.processScheduledLineControls();
  assert.equal(outcomes[0].type, "COUPON");
  assert.equal(outcomes[0].status, "SENT");
  assert.equal(store.db.prepare("SELECT status FROM coupon_schedules").get().status, "SENT");
  assert.match(JSON.stringify(line.pushes.at(-1).message), /ใกล้ถึงเวลาคูปอง/);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /DRY-RUN/);
});

test("custom shortcut names stay blocked until Ppan has an API campaign-id binding", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    logger: { error() {} }
  });
  t.after(() => store.close());

  const [outcome] = await service.handleLineEvents([lineEvent({
    id: "custom-shortcut-name",
    text: [
      "ตั้ง shortcut Ppan promo",
      "ชื่อ Summer Promo",
      "งบ 3000",
      "ROI 3.5",
      "เติมเมื่อ 80%"
    ].join("\n")
  })]);
  assert.equal(outcome.status, "PROCESSED");
  assert.equal(store.getCampaignShortcut({
    clientId: "punpan_020",
    shortcutName: "promo"
  }), null);
  assert.match(line.replies.at(-1).message.text, /\{date\} \{start\}:00/);
});

test("failed control reply recovers by push without duplicating a shortcut or violating foreign keys", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    logger: { error() {} }
  });
  t.after(() => store.close());

  line.failNextReply = true;
  const [failed] = await service.handleLineEvents([lineEvent({
    id: "shortcut-reply-recovery",
    text: [
      "ตั้ง shortcut Ppan main",
      "ชื่อ {date} {start}:00",
      "งบ 3000",
      "ROI 3.5",
      "เติมเมื่อ 80%"
    ].join("\n")
  })]);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.error.code, "LINE_CONTROL_REPLY_FAILED");
  assert.equal(store.getCampaignShortcut({
    clientId: "punpan_020",
    shortcutName: "main"
  }).revision, 1);

  const recovered = await service.recoverLineWebhookEvents({ maxEvents: 5 });
  assert.deepEqual(recovered, [{ eventId: "shortcut-reply-recovery", status: "RECOVERED" }]);
  assert.equal(store.getCampaignShortcut({
    clientId: "punpan_020",
    shortcutName: "main"
  }).revision, 1);
  assert.equal(line.pushes.length, 1);
  assert.equal(store.getWebhookEvent("LINE", "shortcut-reply-recovery").requestId, null);
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("an abandoned control webhook replays the missing side effect before sending recovery", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  const event = lineEvent({
    id: "abandoned-shortcut",
    text: [
      "ตั้ง shortcut Ppan main",
      "ชื่อ {date} {start}:00",
      "งบ 3000",
      "ROI 3.5",
      "เติมเมื่อ 80%"
    ].join("\n")
  });
  store.recordWebhookEvent({
    provider: "LINE",
    eventId: event.webhookEventId,
    payload: {
      type: event.type,
      timestamp: null,
      sourceType: "user",
      messageType: "text",
      isRedelivery: false,
      command: {
        kind: "control_command",
        userId: "U1",
        sourceType: "user",
        command: {
          kind: "shortcut_upsert",
          clientAlias: "Ppan",
          shortcutName: "main",
          campaignNameTemplate: "{date} {start}:00",
          dailyBudget: 3000,
          targetRoi: 3.5,
          topUpThresholdPercent: 80
        }
      }
    },
    receivedAt: now
  });
  store.claimWebhookEvent({
    provider: "LINE",
    eventId: event.webhookEventId,
    claimedAt: now,
    leaseDurationMs: 1_000
  });

  now = new Date("2026-07-20T10:00:02.000Z");
  assert.deepEqual(await service.recoverLineWebhookEvents({ maxEvents: 5 }), [{
    eventId: "abandoned-shortcut",
    status: "RECOVERED"
  }]);
  assert.equal(store.getCampaignShortcut({
    clientId: "punpan_020",
    shortcutName: "main"
  }).revision, 1);
  assert.equal(line.pushes.length, 1);
});

test("a committed control postback with a failed reply recovers without storing its control id in legacy FKs", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "postback-recovery-save",
    text: [
      "ตั้ง shortcut Ppan main",
      "ชื่อ {date} {start}:00",
      "งบ 3000",
      "ROI 3.5",
      "เติมเมื่อ 80%"
    ].join("\n")
  })]);
  await service.handleLineEvents([lineEvent({
    id: "postback-recovery-open",
    text: "เปิด Ppan main"
  })]);
  const serialized = JSON.stringify(line.replies.at(-1).message);
  const [, controlRequestId] = serialized.match(/op=confirm&id=(ca_[0-9a-f]+)&v=1/);

  line.failNextReply = true;
  const [failed] = await service.handleLineEvents([{
    webhookEventId: "postback-recovery-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-postback-recovery-confirm",
    postback: { data: `op=confirm&id=${controlRequestId}&v=1` }
  }]);
  assert.equal(failed.status, "FAILED");
  assert.equal(store.getCampaignControlRequest(controlRequestId).state, "CONFIRMED_DRY_RUN");

  assert.equal((await service.recoverLineWebhookEvents({ maxEvents: 5 }))[0].status, "RECOVERED");
  assert.equal(store.getWebhookEvent("LINE", "postback-recovery-confirm").requestId, null);
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.match(line.pushes.at(-1).message.text, /ไม่มีการเปลี่ยนแปลง TikTok/);
});

test("failed scheduled report advances to the next interval and outside-LIVE reports still deliver", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T17:30:00.000Z"); // 00:30 Bangkok
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "night-report-subscribe",
    text: "รายงาน Ppan ทุก 1 ชั่วโมง"
  })]);
  now = new Date("2026-07-20T18:30:00.000Z");
  line.failNextPush = true;
  assert.deepEqual(await service.processScheduledLineControls(), [{
    type: "REPORT",
    clientId: "punpan_020",
    status: "FAILED_NEXT_INTERVAL"
  }]);
  assert.equal(store.getReportSubscription({
    clientId: "punpan_020",
    lineUserId: "U1"
  }).nextDueAt, "2026-07-20T19:30:00.000Z");
  assert.equal((await service.processScheduledLineControls()).length, 0);

  now = new Date("2026-07-20T19:30:00.000Z");
  assert.equal((await service.processScheduledLineControls())[0].status, "SENT");
  assert.equal(line.pushes.length, 1);
});

test("a due coupon reminder is pushed before periodic reports", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "priority-report",
    text: "รายงาน Ppan ทุก 1 ชั่วโมง"
  })]);
  await service.handleLineEvents([lineEvent({
    id: "priority-coupon",
    text: "คูปอง Ppan 2026-07-20 18:30 ก่อน 30 นาที งบ 5000"
  })]);
  const serialized = JSON.stringify(line.replies.at(-1).message);
  const [, requestId] = serialized.match(/op=confirm&id=(ca_[0-9a-f]+)&v=1/);
  await service.handleLineEvents([{
    webhookEventId: "priority-coupon-confirm",
    type: "postback",
    source: { type: "user", userId: "U1" },
    replyToken: "reply-priority-coupon-confirm",
    postback: { data: `op=confirm&id=${requestId}&v=1` }
  }]);

  now = new Date("2026-07-20T11:00:00.000Z");
  const outcomes = await service.processScheduledLineControls();
  assert.equal(outcomes[0].type, "COUPON");
  assert.equal(outcomes[1].type, "REPORT");
  assert.match(JSON.stringify(line.pushes[0].message), /ใกล้ถึงเวลาคูปอง/);
});
