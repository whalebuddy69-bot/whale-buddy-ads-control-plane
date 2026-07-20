import assert from "node:assert/strict";
import test from "node:test";

import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";

class FakeLine {
  replies = [];
  pushes = [];
  failNextReply = false;
  failNextPush = false;
  nextPushError = null;
  async reply(replyToken, message) {
    if (this.failNextReply) {
      this.failNextReply = false;
      throw new Error("temporary LINE reply failure");
    }
    this.replies.push({ replyToken, message });
  }
  async push(to, message, retryKey) {
    if (this.nextPushError) {
      const error = this.nextPushError;
      this.nextPushError = null;
      throw error;
    }
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
        maxCouponLeadMinutes: 180,
        autoBoost: {
          enabled: true,
          boostPercent: 10,
          leadMinutes: 10,
          maxWindows: 24
        }
      }
    }]
  };
}

function lineEvent({ id, text, sourceType = "user", timestamp }) {
  return {
    webhookEventId: id,
    type: "message",
    timestamp,
    source: { type: sourceType, userId: "U1" },
    replyToken: `reply-${id}`,
    message: { type: "text", text }
  };
}

function autoBoostDefinition({
  baseBudget = 3000,
  windows = ["18:00-19:00"]
} = {}) {
  return [
    "ตั้ง Auto Boost Ppan",
    `งบฐาน ${baseBudget}`,
    "เพิ่ม 10%",
    "ก่อน 10 นาที",
    "ช่วงเวลา",
    ...windows
  ].join("\n");
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

test("a due coupon reminder is pushed before Auto Boost and periodic reports", async (t) => {
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
  await service.handleLineEvents([lineEvent({
    id: "priority-auto-save",
    text: autoBoostDefinition({ windows: ["18:10-19:00"] })
  })]);
  await service.handleLineEvents([lineEvent({
    id: "priority-auto-on",
    text: "เปิด Auto Boost Ppan"
  })]);

  now = new Date("2026-07-20T11:00:00.000Z");
  const outcomes = await service.processScheduledLineControls();
  assert.equal(outcomes[0].type, "COUPON");
  assert.equal(outcomes[1].type, "AUTO_BOOST");
  assert.equal(outcomes[2].type, "REPORT");
  assert.match(JSON.stringify(line.pushes[0].message), /ใกล้ถึงเวลาคูปอง/);
  assert.match(JSON.stringify(line.pushes[1].message), /DRY-RUN Auto Boost/);
});

test("Auto Boost saves OFF, runs daily BOOST and RESTORE dry-runs once, and never calls TikTok", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const config = controlConfig();
  let now = new Date("2026-07-20T10:00:00.000Z"); // 17:00 Bangkok
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-boost-save",
    text: autoBoostDefinition()
  })]);
  const saved = store.getAutoBoostProfile({ clientId: "punpan_020" });
  assert.equal(saved.enabled, false);
  assert.equal(saved.executionMode, "DRY_RUN");
  assert.equal(saved.baseBudgetMinor, 300_000);
  assert.equal(saved.targetBudgetMinor, 330_000);
  assert.equal(saved.boostBps, 1_000);
  assert.match(JSON.stringify(line.replies.at(-1).message), /DRY-RUN/);
  assert.match(JSON.stringify(line.replies.at(-1).message), /ปิด/);

  await service.handleLineEvents([lineEvent({
    id: "auto-boost-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }).enabled, true);
  assert.match(JSON.stringify(line.replies.at(-1).message), /เปิด/);

  now = new Date("2026-07-20T10:50:00.000Z"); // 17:50 Bangkok, 10 minutes before 18:00
  const boostOutcomes = await service.processScheduledLineControls();
  const boost = boostOutcomes.find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(boost?.phase, "BOOST");
  assert.equal(boost?.status, "DRY_RUN_COMPLETED");
  assert.match(JSON.stringify(line.pushes.at(-1).message), /DRY-RUN/);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /3,000/);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /3,300/);
  assert.equal(tiktokCallCount, 0);

  const restartedService = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  assert.equal(
    (await restartedService.processScheduledLineControls())
      .filter((outcome) => outcome.type === "AUTO_BOOST").length,
    0
  );
  assert.equal(store.listAutoBoostOccurrences({ clientId: "punpan_020" }).length, 2);

  now = new Date("2026-07-20T12:00:00.000Z"); // 19:00 Bangkok
  const restoreOutcomes = await restartedService.processScheduledLineControls();
  const restore = restoreOutcomes.find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(restore?.phase, "RESTORE");
  assert.equal(restore?.status, "DRY_RUN_COMPLETED");
  assert.match(JSON.stringify(line.pushes.at(-1).message), /DRY-RUN/);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /คืนงบ/);
  assert.equal(tiktokCallCount, 0);

  assert.deepEqual(
    store.listAutoBoostOccurrences({ clientId: "punpan_020" })
      .map((occurrence) => [occurrence.phase, occurrence.status]),
    [["BOOST", "DRY_RUN_COMPLETED"], ["RESTORE", "DRY_RUN_COMPLETED"]]
  );
});

test("a failed required RESTORE blocks the next BOOST until the restore succeeds", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-barrier-save",
    text: autoBoostDefinition({ windows: ["18:00-18:10", "18:21-18:30"] })
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-barrier-on",
    text: "เปิด Auto Boost Ppan"
  })]);

  now = new Date("2026-07-20T10:50:00.000Z");
  await service.processScheduledLineControls();
  assert.equal(line.pushes.length, 1);

  line.failNextPush = true;
  now = new Date("2026-07-20T11:10:00.000Z");
  const failedRestore = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(failedRestore?.phase, "RESTORE");
  assert.equal(failedRestore?.status, "LINE_RETRY_PENDING");

  now = new Date("2026-07-20T11:11:00.000Z");
  assert.equal(
    (await service.processScheduledLineControls())
      .filter((outcome) => outcome.type === "AUTO_BOOST").length,
    0
  );
  const occurrences = store.listAutoBoostOccurrences({ clientId: "punpan_020" });
  assert.equal(
    occurrences.find((item) => item.phase === "BOOST" && item.blockIndex === 1).status,
    "PENDING"
  );

  now = new Date("2026-07-20T11:12:01.000Z");
  const restored = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(restored?.phase, "RESTORE");
  assert.equal(restored?.status, "DRY_RUN_COMPLETED");

  now = new Date("2026-07-20T11:12:02.000Z");
  const nextBoost = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(nextBoost?.phase, "BOOST");
  assert.equal(nextBoost?.status, "DRY_RUN_COMPLETED");
  assert.equal(line.pushes.length, 3);
  assert.equal(tiktokCallCount, 0);
});

test("a permanent LINE rejection cannot lock a required RESTORE forever", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-permanent-save",
    text: autoBoostDefinition({ windows: ["18:00-18:10", "18:21-18:30"] })
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-permanent-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  now = new Date("2026-07-20T10:50:00.000Z");
  await service.processScheduledLineControls();

  line.nextPushError = Object.assign(new Error("LINE recipient is invalid"), {
    status: 400,
    retryable: false,
    recipientPermanent: true
  });
  now = new Date("2026-07-20T11:10:00.000Z");
  const restore = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(restore?.phase, "RESTORE");
  assert.equal(restore?.status, "DRY_RUN_COMPLETED_NO_RECIPIENT");
  const storedRestore = store.listAutoBoostOccurrences({
    clientId: "punpan_020",
    phase: "RESTORE"
  }).find((item) => item.blockIndex === 0);
  assert.equal(storedRestore.status, "DRY_RUN_COMPLETED");
  assert.match(storedRestore.lastError, /permanently rejected/);

  now = new Date("2026-07-20T11:11:00.000Z");
  const nextBoost = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(nextBoost?.phase, "BOOST");
  assert.equal(nextBoost?.status, "DRY_RUN_COMPLETED");
  assert.equal(line.pushes.length, 2);
  assert.equal(tiktokCallCount, 0);
});

test("turning Auto Boost OFF after BOOST preserves and drains its RESTORE", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const config = controlConfig();
  let now = new Date("2026-07-20T10:00:00.000Z"); // 17:00 Bangkok
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-drain-save",
    text: autoBoostDefinition()
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-drain-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  now = new Date("2026-07-20T10:50:00.000Z");
  await service.processScheduledLineControls();

  now = new Date("2026-07-20T11:00:00.000Z");
  await service.handleLineEvents([lineEvent({
    id: "auto-drain-off",
    text: "ปิด Auto Boost Ppan"
  })]);
  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }).enabled, false);
  assert.deepEqual(
    store.listAutoBoostOccurrences({ clientId: "punpan_020" })
      .map((occurrence) => [occurrence.phase, occurrence.status]),
    [["BOOST", "DRY_RUN_COMPLETED"], ["RESTORE", "PENDING"]]
  );
  assert.match(JSON.stringify(line.replies.at(-1).message), /คืนงบให้ครบ/);
  assert.match(JSON.stringify(line.replies.at(-1).message), /กำลังรอคืนงบ/);

  await service.handleLineEvents([lineEvent({
    id: "auto-drain-early-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }).enabled, false);
  assert.match(JSON.stringify(line.replies.at(-1).message), /รอคืนงบ/);

  now = new Date("2026-07-20T12:20:00.000Z"); // Recover 20 minutes after window end.
  await service.handleLineEvents([lineEvent({
    id: "auto-drain-overdue-status",
    text: "ดู Auto Boost Ppan"
  })]);
  assert.match(JSON.stringify(line.replies.at(-1).message), /กำลังรอคืนงบ/);
  assert.match(JSON.stringify(line.replies.at(-1).message), /คืนงบครั้งถัดไป/);

  config.clients[0].lineControl.autoBoost.enabled = false;
  config.clients[0].lineControl.autoBoost.boostPercent = 11;
  const restore = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(restore?.phase, "RESTORE");
  assert.equal(restore?.status, "DRY_RUN_COMPLETED");
  assert.match(JSON.stringify(line.pushes.at(-1).message), /คืนงบ/);
  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }).enabled, false);
  assert.equal(tiktokCallCount, 0);
});

test("turning Auto Boost OFF marks an abandoned BOOST uncertain and still restores", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-processing-save",
    text: autoBoostDefinition()
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-processing-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  const [abandonedBoost] = store.claimDueAutoBoostOccurrences({
    now: "2026-07-20T10:50:00.000Z",
    limit: 1,
    leaseDurationMs: 60_000
  });
  assert.equal(abandonedBoost.phase, "BOOST");

  now = new Date("2026-07-20T10:50:30.000Z");
  await service.handleLineEvents([lineEvent({
    id: "auto-processing-off",
    text: "ปิด Auto Boost Ppan"
  })]);
  assert.deepEqual(
    store.listAutoBoostOccurrences({ clientId: "punpan_020" })
      .map((occurrence) => [occurrence.phase, occurrence.status]),
    [["BOOST", "PROCESSING"], ["RESTORE", "PENDING"]]
  );

  now = new Date("2026-07-20T10:51:01.000Z");
  const uncertainBoost = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(uncertainBoost?.phase, "BOOST");
  assert.equal(uncertainBoost?.status, "OUTCOME_UNKNOWN");

  now = new Date("2026-07-20T12:20:00.000Z");
  const restored = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(restored?.phase, "RESTORE");
  assert.equal(restored?.status, "DRY_RUN_COMPLETED");
  assert.equal(line.pushes.length, 1);
  assert.equal(tiktokCallCount, 0);
});

test("revoking the owner cannot delete a required Auto Boost RESTORE", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const config = controlConfig();
  config.clients[0].lineApproverUserIds = [];
  let now = new Date("2026-07-20T10:00:00.000Z");
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  const pairingHash = "a".repeat(64);
  store.createLinePairing({
    clientId: "punpan_020",
    codeHash: pairingHash,
    createdAt: "2026-07-20T09:00:00.000Z",
    expiresAt: "2026-07-20T09:10:00.000Z"
  });
  store.consumeLinePairing({
    clientId: "punpan_020",
    codeHash: pairingHash,
    lineUserId: "U1",
    consumedAt: "2026-07-20T09:01:00.000Z"
  });
  await service.handleLineEvents([lineEvent({
    id: "auto-revoke-save",
    text: autoBoostDefinition()
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-revoke-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  const [abandonedBoost] = store.claimDueAutoBoostOccurrences({
    now: "2026-07-20T10:50:00.000Z",
    limit: 1,
    leaseDurationMs: 60_000
  });
  assert.equal(abandonedBoost.phase, "BOOST");

  const revoked = store.revokeLineApprover({
    clientId: "punpan_020",
    lineUserId: "U1",
    revokedAt: "2026-07-20T10:50:30.000Z"
  });
  assert.equal(revoked.counts.autoBoostProfilesDisabled, 1);
  assert.equal(revoked.counts.autoBoostOccurrencesCancelled, 0);
  assert.equal(store.listAutoBoostOccurrences({
    clientId: "punpan_020",
    phase: "RESTORE"
  })[0].status, "PENDING");

  now = new Date("2026-07-20T10:51:01.000Z");
  const uncertain = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(uncertain?.phase, "BOOST");
  assert.equal(uncertain?.status, "OUTCOME_UNKNOWN");
  assert.equal(line.pushes.length, 0);

  now = new Date("2026-07-20T12:20:00.000Z");
  const restore = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(restore?.phase, "RESTORE");
  assert.equal(restore?.status, "DRY_RUN_COMPLETED_NO_RECIPIENT");
  assert.equal(line.pushes.length, 0);
  const storedRestore = store.listAutoBoostOccurrences({
    clientId: "punpan_020",
    phase: "RESTORE"
  })[0];
  assert.equal(storedRestore.status, "DRY_RUN_COMPLETED");
  assert.match(storedRestore.lastError, /no current approver/);
  assert.equal(tiktokCallCount, 0);
});

test("turning Auto Boost OFF prevents future scheduled dry-run messages", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-off-save",
    text: autoBoostDefinition({ windows: ["20:00-21:00"] })
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-off-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-off-off",
    text: "ปิด Auto Boost Ppan"
  })]);
  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }).enabled, false);

  const pushesBeforeDue = line.pushes.length;
  now = new Date("2026-07-20T12:50:00.000Z"); // 19:50 Bangkok
  assert.equal(
    (await service.processScheduledLineControls())
      .filter((outcome) => outcome.type === "AUTO_BOOST").length,
    0
  );
  assert.equal(line.pushes.length, pushesBeforeDue);
  assert.equal(tiktokCallCount, 0);
});

test("Auto Boost rejects a target above the Ppan daily cap without saving a plan", async (t) => {
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
    id: "auto-cap-reject",
    text: autoBoostDefinition({ baseBudget: 6000 })
  })]);

  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }), null);
  const response = JSON.stringify(line.replies.at(-1).message);
  assert.match(response, /เพดาน|เกิน/);
  assert.match(response, /6,000|6000/);
  assert.match(response, /DRY-RUN/);
});

test("failed Auto Boost replies recover without duplicating profile revisions or ON generations", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost recovery must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    logger: { error() {} }
  });
  t.after(() => store.close());

  line.failNextReply = true;
  const [failedUpsert] = await service.handleLineEvents([lineEvent({
    id: "auto-recovery-save",
    text: autoBoostDefinition()
  })]);
  assert.equal(failedUpsert.status, "FAILED");
  assert.equal(failedUpsert.error.code, "LINE_CONTROL_REPLY_FAILED");
  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }).revision, 1);

  assert.deepEqual(await service.recoverLineWebhookEvents({ maxEvents: 5 }), [{
    eventId: "auto-recovery-save",
    status: "RECOVERED"
  }]);
  let profile = store.getAutoBoostProfile({ clientId: "punpan_020" });
  assert.equal(profile.revision, 1);
  assert.equal(profile.enabled, false);
  assert.equal(profile.activationGeneration, 0);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /DRY-RUN/);

  line.failNextReply = true;
  const [failedToggle] = await service.handleLineEvents([lineEvent({
    id: "auto-recovery-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  assert.equal(failedToggle.status, "FAILED");
  assert.equal(failedToggle.error.code, "LINE_CONTROL_REPLY_FAILED");
  profile = store.getAutoBoostProfile({ clientId: "punpan_020" });
  assert.equal(profile.enabled, true);
  assert.equal(profile.activationGeneration, 1);

  assert.deepEqual(await service.recoverLineWebhookEvents({ maxEvents: 5 }), [{
    eventId: "auto-recovery-on",
    status: "RECOVERED"
  }]);
  profile = store.getAutoBoostProfile({ clientId: "punpan_020" });
  assert.equal(profile.revision, 1);
  assert.equal(profile.activationGeneration, 1);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /DRY-RUN/);
  assert.equal(tiktokCallCount, 0);
});

test("enabled Auto Boost materializes and runs the next Bangkok date exactly once", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z");
  let tiktokCallCount = 0;
  const tiktok = new Proxy({}, {
    get() {
      return async () => {
        tiktokCallCount += 1;
        throw new Error("Auto Boost DRY-RUN must not call TikTok");
      };
    }
  });
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-next-day-save",
    text: autoBoostDefinition()
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-next-day-on",
    text: "เปิด Auto Boost Ppan"
  })]);

  now = new Date("2026-07-20T10:50:00.000Z");
  assert.equal(
    (await service.processScheduledLineControls())
      .filter((outcome) => outcome.type === "AUTO_BOOST").length,
    1
  );
  now = new Date("2026-07-20T12:00:00.000Z");
  assert.equal(
    (await service.processScheduledLineControls())
      .filter((outcome) => outcome.type === "AUTO_BOOST").length,
    1
  );

  const nextDatePushStart = line.pushes.length;
  now = new Date("2026-07-21T10:50:00.000Z"); // 17:50 Bangkok on the next date
  const nextDateOutcomes = await service.processScheduledLineControls();
  const nextDateBoosts = nextDateOutcomes.filter((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(nextDateBoosts.length, 1);
  assert.equal(nextDateBoosts[0].phase, "BOOST");
  assert.equal(nextDateBoosts[0].status, "DRY_RUN_COMPLETED");
  assert.equal(line.pushes.length, nextDatePushStart + 1);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /DRY-RUN/);

  assert.equal(
    (await service.processScheduledLineControls())
      .filter((outcome) => outcome.type === "AUTO_BOOST").length,
    0
  );
  assert.equal(line.pushes.length, nextDatePushStart + 1);

  const occurrences = store.listAutoBoostOccurrences({ clientId: "punpan_020" });
  assert.equal(occurrences.length, 4);
  assert.equal(occurrences.filter((occurrence) => occurrence.localDate === "2026-07-21").length, 2);
  assert.equal(
    occurrences.filter((occurrence) => (
      occurrence.localDate === "2026-07-21"
      && occurrence.phase === "BOOST"
      && occurrence.status === "DRY_RUN_COMPLETED"
    )).length,
    1
  );
  assert.equal(tiktokCallCount, 0);
});

test("Auto Boost skips RESTORE when the matching BOOST missed its deadline", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:30:00.000Z"); // 17:30 Bangkok
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-missed-save",
    text: autoBoostDefinition({ windows: ["17:00-18:00"] })
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-missed-on",
    text: "เปิด Auto Boost Ppan"
  })]);

  assert.equal((await service.processScheduledLineControls()).length, 0);
  assert.equal(store.listAutoBoostOccurrences({
    clientId: "punpan_020",
    phase: "BOOST"
  })[0].status, "SKIPPED");

  now = new Date("2026-07-20T11:00:00.000Z");
  const [restore] = await service.processScheduledLineControls();
  assert.equal(restore.type, "AUTO_BOOST");
  assert.equal(restore.phase, "RESTORE");
  assert.equal(restore.status, "SKIPPED");
  assert.equal(line.pushes.length, 0);
  assert.equal(store.listAutoBoostOccurrences({
    clientId: "punpan_020",
    phase: "RESTORE"
  })[0].status, "SKIPPED");
});

test("Auto Boost leaves RESTORE unclaimed while the matching BOOST is still recoverable", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  let now = new Date("2026-07-20T10:00:00.000Z"); // 17:00 Bangkok
  const service = new BudgetGuardService({
    config: controlConfig(),
    store,
    line,
    tiktok: null,
    executionEnabled: true,
    now: () => new Date(now),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-wait-save",
    text: autoBoostDefinition({ windows: ["18:00-18:01"] })
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-wait-on",
    text: "เปิด Auto Boost Ppan"
  })]);

  // Simulate a worker that has accepted the BOOST delivery but has not yet
  // committed its result. Its lease remains recoverable past RESTORE due time.
  const [boostClaim] = store.claimDueAutoBoostOccurrences({
    now: "2026-07-20T10:59:59.000Z",
    limit: 1,
    leaseDurationMs: 120_000
  });
  assert.equal(boostClaim.phase, "BOOST");
  assert.equal(boostClaim.status, "PROCESSING");

  now = new Date("2026-07-20T11:01:00.000Z"); // 18:01 Bangkok
  assert.equal(
    (await service.processScheduledLineControls())
      .filter((outcome) => outcome.type === "AUTO_BOOST").length,
    0
  );
  assert.equal(line.pushes.length, 0);
  assert.equal(store.listAutoBoostOccurrences({
    clientId: "punpan_020",
    phase: "RESTORE"
  })[0].status, "PENDING");

  store.finishAutoBoostOccurrence({
    id: boostClaim.id,
    leaseToken: boostClaim.leaseToken,
    status: "DRY_RUN_COMPLETED",
    now: "2026-07-20T11:01:01.000Z"
  });
  now = new Date("2026-07-20T11:01:02.000Z");
  const restored = (await service.processScheduledLineControls())
    .find((outcome) => outcome.type === "AUTO_BOOST");
  assert.equal(restored?.phase, "RESTORE");
  assert.equal(restored?.status, "DRY_RUN_COMPLETED");
  assert.equal(line.pushes.length, 1);
  assert.match(JSON.stringify(line.pushes[0].message), /คืนงบ/);
});

test("a currently authorized operator can turn Auto Boost OFF after policy changes", async (t) => {
  const store = new SqliteStore();
  const line = new FakeLine();
  const config = controlConfig();
  const service = new BudgetGuardService({
    config,
    store,
    line,
    tiktok: null,
    now: () => new Date("2026-07-20T10:00:00.000Z"),
    logger: { error() {} }
  });
  t.after(() => store.close());

  await service.handleLineEvents([lineEvent({
    id: "auto-policy-save",
    text: autoBoostDefinition()
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-policy-on",
    text: "เปิด Auto Boost Ppan"
  })]);
  config.clients[0].lineControl.autoBoost.boostPercent = 11;

  await service.handleLineEvents([lineEvent({
    id: "auto-policy-off",
    text: "ปิด Auto Boost Ppan"
  })]);
  assert.equal(store.getAutoBoostProfile({ clientId: "punpan_020" }).enabled, false);
  assert.match(JSON.stringify(line.replies.at(-1).message), /ปิด Auto Boost|ปิด Auto Boost แล้ว/);
});

test("recovery ignores an older abandoned Auto Boost ON after a newer OFF", async (t) => {
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
    id: "auto-order-save",
    text: autoBoostDefinition(),
    timestamp: 1_774_000_000_000
  })]);
  await service.handleLineEvents([lineEvent({
    id: "auto-order-new-off",
    text: "ปิด Auto Boost Ppan",
    timestamp: 1_774_000_003_000
  })]);
  const newerSequence = store.getWebhookEvent("LINE", "auto-order-new-off").sequence;
  store.recordWebhookEvent({
    provider: "LINE",
    eventId: "auto-order-old-on",
    receivedAt: new Date("2026-07-20T10:00:01.000Z"),
    payload: {
      type: "message",
      timestamp: 1_774_000_002_000,
      sourceType: "user",
      messageType: "text",
      isRedelivery: false,
      command: {
        kind: "control_command",
        userId: "U1",
        sourceType: "user",
        command: { kind: "auto_boost_toggle", clientAlias: "Ppan", enabled: true }
      }
    }
  });
  assert(store.getWebhookEvent("LINE", "auto-order-old-on").sequence > newerSequence);

  assert.deepEqual(await service.recoverLineWebhookEvents({ maxEvents: 5 }), [{
    eventId: "auto-order-old-on",
    status: "RECOVERED"
  }]);
  const profile = store.getAutoBoostProfile({ clientId: "punpan_020" });
  assert.equal(profile.enabled, false);
  assert.equal(profile.activationGeneration, 0);
  assert.equal(profile.lastCommandSequence, newerSequence);
  assert.equal(profile.lastCommandTimestampMs, 1_774_000_003_000);
  assert.equal(store.listAuditEvents({
    eventType: "AUTO_BOOST_STALE_COMMAND_IGNORED"
  }).length, 1);
  assert.match(JSON.stringify(line.pushes.at(-1).message), /OFF.*DRY-RUN|DRY-RUN.*OFF/);
});
