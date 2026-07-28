import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgencyClientPickerMessage,
  buildAgencyControlMenuMessage,
  buildAgencyPerformanceReportMessage,
  buildAutoBoostSetupTemplateMessage,
  buildAutoBoostDryRunOccurrenceMessage,
  buildAutoBoostStatusMessage,
  buildCampaignAdjustmentMessage,
  buildCampaignCreateTemplateMessage,
  buildCampaignPauseChoicesMessage,
  buildControlConfirmationMessage,
  buildPerformanceReportMessage,
  parseControlCommand,
  parseControlPostbackData
} from "../src/line-controls.js";

function menuClient({
  id = "punpan_020",
  name = "punpan_020",
  alias = "Ppan",
  advertiserId = "7646832328389263378",
  tiktokAccountId = "7285935731820920833",
  currency = "THB"
} = {}) {
  return {
    id,
    name,
    advertiserId,
    budgetPolicy: { maxDailyBudget: 6000 },
    campaignSelector: { currency, expectedTikTokAccountId: tiktokAccountId },
    lineControl: {
      aliases: [alias],
      minDailyBudget: 100,
      autoBoost: { boostPercent: 10, leadMinutes: 10 }
    }
  };
}

function menuSnapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    campaignName: "2026-07-20 06:00:00",
    campaignStatus: "ACTIVE",
    dailyBudgetMinor: 300_000,
    costMinor: 240_000,
    grossRevenueMinor: 900_000,
    grossRoiMilli: 3750,
    netRevenueMinor: 850_000,
    netRoiMilli: 3542,
    gmvMinor: 900_000,
    currency: "THB",
    observedAt: "2026-07-20T10:00:00.000Z",
    ...overrides
  };
}

function collectActions(value, actions = []) {
  if (!value || typeof value !== "object") return actions;
  if (value.type && new Set(["message", "postback", "clipboard", "uri"]).has(value.type)) {
    actions.push(value);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => collectActions(item, actions));
    else if (child && typeof child === "object") collectActions(child, actions);
  }
  return actions;
}

test("parses bounded Ppan menu, report, action, and coupon commands", () => {
  assert.deepEqual(parseControlCommand("เมนู Ppan"), {
    kind: "menu",
    clientAlias: "Ppan"
  });
  assert.deepEqual(parseControlCommand("รายงาน Ppan ทุก 2 ชั่วโมง"), {
    kind: "report_subscribe",
    clientAlias: "Ppan",
    intervalHours: 2
  });
  assert.deepEqual(parseControlCommand("เชื่อม TikTok API Ppan"), {
    kind: "tiktok_oauth_start",
    clientAlias: "Ppan"
  });
  assert.deepEqual(parseControlCommand("ตรวจสอบ TikTok API Ppan"), {
    kind: "tiktok_api_preflight",
    clientAlias: "Ppan"
  });
  assert.deepEqual(parseControlCommand("LINE ID ของฉัน"), {
    kind: "my_line_id"
  });
  assert.deepEqual(parseControlCommand("ตั้งงบ Ppan 2,500"), {
    kind: "action",
    action: "UPDATE_BUDGET",
    clientAlias: "Ppan",
    amount: 2500
  });
  assert.deepEqual(parseControlCommand("คูปอง Ppan 2026-07-21 20:00 ก่อน 30 นาที งบ 5,000"), {
    kind: "coupon_schedule",
    clientAlias: "Ppan",
    localDate: "2026-07-21",
    localTime: "20:00",
    leadMinutes: 30,
    amount: 5000
  });
  assert.equal(parseControlCommand("รายงาน Ppan ทุก 0 ชั่วโมง"), null);
  assert.deepEqual(parseControlCommand("ตั้งงบ Ppan -1"), {
    kind: "invalid_template",
    template: "adjustment"
  });
  assert.equal(parseControlCommand("คูปอง Ppan พรุ่งนี้ ก่อนนิดหน่อย"), null);
});

test("parses agency menu choices and treats increase/decrease as relative budget actions", () => {
  assert.deepEqual(parseControlCommand("เมนู"), { kind: "agency_menu" });
  assert.deepEqual(parseControlCommand("สร้างแคมเปญใหม่"), { kind: "agency_section", section: "create" });
  assert.deepEqual(parseControlCommand("ปิดแคมเปญ"), { kind: "agency_section", section: "close" });
  assert.deepEqual(parseControlCommand("ปรับ เพิ่ม/ลด ข้อมูล"), { kind: "agency_section", section: "adjust" });
  assert.deepEqual(parseControlCommand("ตั้งค่า Auto Boost"), { kind: "agency_section", section: "auto_boost" });
  assert.deepEqual(parseControlCommand("อัพเดท Report ล่าสุด"), { kind: "agency_report" });
  assert.deepEqual(parseControlCommand("อัปเดต Report ล่าสุด หน้า 3"), {
    kind: "agency_report",
    page: 3
  });
  assert.deepEqual(parseControlCommand("ปิดแคมเปญ หน้า 2"), {
    kind: "agency_section",
    section: "close",
    page: 2
  });
  assert.deepEqual(parseControlCommand("สร้างแคมเปญใหม่ หน้า 2"), {
    kind: "agency_section",
    section: "create",
    page: 2
  });
  assert.deepEqual(parseControlCommand("ตั้งค่า Auto Boost หน้า 2"), {
    kind: "agency_section",
    section: "auto_boost",
    page: 2
  });
  assert.deepEqual(parseControlCommand("สร้างแคมเปญ Ppan"), {
    kind: "campaign_create_template",
    clientAlias: "Ppan"
  });
  assert.deepEqual(parseControlCommand("เพิ่มงบ Ppan 500"), {
    kind: "action",
    action: "ADJUST_BUDGET",
    clientAlias: "Ppan",
    amount: 500,
    direction: 1
  });
  assert.deepEqual(parseControlCommand("ลดงบ Ppan 500"), {
    kind: "action",
    action: "ADJUST_BUDGET",
    clientAlias: "Ppan",
    amount: 500,
    direction: -1
  });
  assert.deepEqual(parseControlCommand("ตั้ง shortcut Ppan new\nงบ 3000"), {
    kind: "invalid_template",
    template: "shortcut"
  });
  assert.deepEqual(parseControlCommand("ตั้ง Auto Boost Ppan\nงบฐาน 3000"), {
    kind: "invalid_template",
    template: "auto_boost"
  });
  assert.deepEqual(parseControlCommand("เพิ่มงบ Ppan ห้าร้อย"), {
    kind: "invalid_template",
    template: "adjustment"
  });
});

test("agency menu and account picker expose five choices without leaking account IDs", () => {
  const clients = Array.from({ length: 14 }, (_, index) => menuClient({
    id: `client_${index + 1}`,
    name: `Client ${index + 1}`,
    alias: `A${index + 1}`,
    advertiserId: `99999999999999${String(index + 1).padStart(2, "0")}`
  }));
  const menu = buildAgencyControlMenuMessage({ clients });
  const encodedMenu = JSON.stringify(menu);
  assert.match(encodedMenu, /สร้างแคมเปญใหม่/);
  assert.match(encodedMenu, /ปิดแคมเปญ/);
  assert.match(encodedMenu, /ปรับเพิ่ม \/ ลด/);
  assert.match(encodedMenu, /Auto Boost/);
  assert.match(encodedMenu, /Report ล่าสุด/);
  assert.doesNotMatch(encodedMenu, /9999999999999901/);

  const picker = buildAgencyClientPickerMessage({ clients, section: "create" });
  assert.equal(picker.quickReply.items.length, 12);
  assert.match(picker.text, /หน้า 1\/2.*14 บัญชี/s);
  assert.doesNotMatch(JSON.stringify(picker.quickReply), /A11|A12|A13|A14/);
  const pickerPageTwo = buildAgencyClientPickerMessage({ clients, section: "create", page: 2 });
  assert.match(JSON.stringify(pickerPageTwo.quickReply), /A11/);
  assert.match(pickerPageTwo.text, /หน้า 2\/2/);
  assert(pickerPageTwo.quickReply.items.length <= 13);
});

test("campaign templates and adjustment cards use aliases, mask identities, and gate stale data", () => {
  const client = menuClient();
  const snapshot = menuSnapshot();
  const create = buildCampaignCreateTemplateMessage({ client, shortcuts: [] });
  const encodedCreate = JSON.stringify(create);
  assert.match(encodedCreate, /clipboard/);
  assert.match(encodedCreate, /ตั้ง shortcut Ppan new/);
  assert.doesNotMatch(encodedCreate, /7646832328389263378/);

  const fresh = buildCampaignAdjustmentMessage({
    client,
    snapshot,
    stale: false,
    now: new Date("2026-07-20T10:05:00.000Z")
  });
  const encodedFresh = JSON.stringify(fresh);
  assert.match(encodedFresh, /เพิ่มงบ Ppan 500/);
  assert.match(encodedFresh, /•••3378/);
  assert.match(encodedFresh, /•••0833/);
  assert.doesNotMatch(encodedFresh, /7646832328389263378|7285935731820920833/);

  const stale = buildCampaignAdjustmentMessage({ client, snapshot, stale: true });
  assert.doesNotMatch(JSON.stringify(stale), /เพิ่มงบ Ppan 500/);
  assert.match(JSON.stringify(stale), /รีเฟรชสถานะ/);
});

test("close choices block stale actions and multi-account reports stay separated", () => {
  const ppan = menuClient();
  const second = menuClient({ id: "client_2", name: "Second", alias: "Second" });
  const snapshot = menuSnapshot();
  const freshClose = buildCampaignPauseChoicesMessage({
    entries: [{ client: ppan, snapshot, stale: false }],
    now: new Date("2026-07-20T10:05:00.000Z")
  });
  assert.match(JSON.stringify(freshClose), /พัก Ppan/);
  const staleClose = buildCampaignPauseChoicesMessage({
    entries: [{ client: ppan, snapshot, stale: true }]
  });
  assert.doesNotMatch(JSON.stringify(staleClose), /พัก Ppan/);

  const report = buildAgencyPerformanceReportMessage({
    entries: [
      { client: ppan, snapshot, stale: false },
      { client: second, snapshot: menuSnapshot({ currency: "USD" }), stale: false }
    ],
    now: new Date("2026-07-20T10:05:00.000Z")
  });
  assert.equal(report.contents.type, "carousel");
  assert.equal(report.contents.contents.length, 2);
  assert.match(JSON.stringify(report.contents.contents[0]), /punpan_020/);
  assert.match(JSON.stringify(report.contents.contents[1]), /Second/);
});

test("large authorized portfolios stay within LINE page and carousel limits", () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    client: menuClient({
      id: `portfolio_${index + 1}`,
      name: `Portfolio ${index + 1}`,
      alias: `Port${index + 1}`
    }),
    snapshot: menuSnapshot({ campaignName: `Campaign ${index + 1}` }),
    stale: false
  }));
  for (const page of [1, 2, 3]) {
    const report = buildAgencyPerformanceReportMessage({ entries, page });
    const close = buildCampaignPauseChoicesMessage({ entries, page });
    for (const message of [report, close]) {
      assert.equal(message.contents.type, "carousel");
      assert(message.contents.contents.length <= 10);
      assert.match(message.altText, new RegExp(`หน้า ${page}\\/3`));
    }
  }
  assert.equal(buildAgencyPerformanceReportMessage({ entries, page: 3 }).contents.contents.length, 5);
  assert.match(
    JSON.stringify(buildAgencyPerformanceReportMessage({ entries, page: 1 }).quickReply),
    /หน้าถัดไป/
  );

  const maximumDisplayEntries = Array.from({ length: 10 }, (_, index) => ({
    client: menuClient({ id: `max_${index}`, name: "ก".repeat(80), alias: `M${index}` }),
    snapshot: menuSnapshot({ campaignName: "ข".repeat(200) }),
    stale: false
  }));
  const maximumReport = buildAgencyPerformanceReportMessage({ entries: maximumDisplayEntries });
  const maximumClose = buildCampaignPauseChoicesMessage({ entries: maximumDisplayEntries });
  assert(Buffer.byteLength(JSON.stringify(maximumReport), "utf8") < 50_000);
  assert(Buffer.byteLength(JSON.stringify(maximumClose), "utf8") < 50_000);
});

test("Auto Boost setup provides an editable clipboard template", () => {
  const message = buildAutoBoostSetupTemplateMessage({
    client: menuClient(),
    snapshot: menuSnapshot(),
    stale: false
  });
  const encoded = JSON.stringify(message);
  assert.match(encoded, /ตั้ง Auto Boost Ppan/);
  assert.match(encoded, /งบฐาน 3000/);
  assert.match(encoded, /clipboard/);
});

test("every generated clipboard template round-trips through the bounded command parser", () => {
  const client = menuClient();
  const snapshot = menuSnapshot();
  const messages = [
    buildCampaignCreateTemplateMessage({ client, shortcuts: [] }),
    buildCampaignAdjustmentMessage({ client, snapshot, stale: false }),
    buildAutoBoostSetupTemplateMessage({ client, snapshot, stale: false }),
    buildAutoBoostStatusMessage({
      client,
      plan: {
        enabled: false,
        executionMode: "DRY_RUN",
        baseBudgetMinor: 300_000,
        targetBudgetMinor: 330_000,
        boostBps: 1_000,
        leadMinutes: 10,
        originalWindows: [{ start: "12:00", end: "13:00" }]
      }
    })
  ];
  const actions = messages.flatMap((message) => collectActions(message));
  const clipboardActions = actions.filter((action) => action.type === "clipboard");
  assert(clipboardActions.length >= 7);
  for (const action of actions) {
    assert(Array.from(action.label ?? "").length <= 20);
    if (action.text) assert(action.text.length <= 300);
  }
  for (const action of clipboardActions) {
    assert(action.clipboardText.length <= 1_000);
    assert.notEqual(parseControlCommand(action.clipboardText), null, action.clipboardText);
  }
});

test("campaign-control money cards honor the account currency", () => {
  const client = menuClient({ currency: "USD" });
  const create = JSON.stringify(buildCampaignCreateTemplateMessage({ client, shortcuts: [] }));
  const setup = JSON.stringify(buildAutoBoostSetupTemplateMessage({ client }));
  const confirmation = JSON.stringify(buildControlConfirmationMessage({
    id: "ca_12345678-1234-1234-1234-123456789abc",
    version: 1,
    action: "ADJUST_BUDGET",
    data: {
      clientName: client.name,
      advertiserId: client.advertiserId,
      currency: "USD",
      dryRun: true,
      before: { dailyBudgetMinor: 300_000 },
      desired: { budgetDeltaMinor: 50_000, dailyBudgetMinor: 350_000 }
    }
  }));
  for (const encoded of [create, setup, confirmation]) {
    assert.match(encoded, /US\$|\$/);
    assert.doesNotMatch(encoded, /฿/);
  }
});
test("shortcut definitions require one exact value for every field", () => {
  assert.deepEqual(parseControlCommand([
    "ตั้ง shortcut Ppan main",
    "ชื่อ {date} {start}:00",
    "งบ 3000",
    "ROI 3.5",
    "เติมเมื่อ 80%"
  ].join("\n")), {
    kind: "shortcut_upsert",
    clientAlias: "Ppan",
    shortcutName: "main",
    campaignNameTemplate: "{date} {start}:00",
    dailyBudget: 3000,
    targetRoi: 3.5,
    topUpThresholdPercent: 80
  });
  assert.deepEqual(parseControlCommand([
    "ตั้ง shortcut Ppan main",
    "ชื่อ Live",
    "งบ 3000",
    "ROI 3.5"
  ].join("\n")), { kind: "invalid_template", template: "shortcut" });
  assert.deepEqual(parseControlCommand([
    "ตั้ง shortcut Ppan main",
    "ชื่อ Live",
    "งบ 3000",
    "ROI 3.5",
    "เติมเมื่อ 80%",
    "advertiser 123"
  ].join("\n")), { kind: "invalid_template", template: "shortcut" });
});

test("parses one multiline Auto Boost schedule and its LINE toggle commands", () => {
  assert.deepEqual(parseControlCommand([
    "ตั้ง Auto Boost Ppan",
    "งบฐาน 3000",
    "เพิ่ม 10%",
    "ก่อน 10 นาที",
    "ช่วงเวลา",
    "12:00-13:00",
    "15:00-16:00",
    "20:00-21:00"
  ].join("\n")), {
    kind: "auto_boost_upsert",
    clientAlias: "Ppan",
    baseBudget: 3000,
    boostPercent: 10,
    leadMinutes: 10,
    windows: [
      { start: "12:00", end: "13:00" },
      { start: "15:00", end: "16:00" },
      { start: "20:00", end: "21:00" }
    ]
  });
  assert.deepEqual(parseControlCommand("ดู Auto Boost Ppan"), {
    kind: "auto_boost_status",
    clientAlias: "Ppan"
  });
  assert.deepEqual(parseControlCommand("เปิด Auto Boost Ppan"), {
    kind: "auto_boost_toggle",
    clientAlias: "Ppan",
    enabled: true
  });
  assert.deepEqual(parseControlCommand("ปิด Auto Boost Ppan"), {
    kind: "auto_boost_toggle",
    clientAlias: "Ppan",
    enabled: false
  });
});

test("Auto Boost parser keeps grammar bounded and leaves policy enforcement to service", () => {
  const command = (overrides = {}) => [
    "ตั้ง Auto Boost Ppan",
    overrides.base ?? "งบฐาน 3000",
    overrides.boost ?? "เพิ่ม 12.5%",
    overrides.lead ?? "ก่อน 15 นาที",
    overrides.label ?? "ช่วงเวลา",
    ...(overrides.windows ?? ["12:00-13:00"])
  ].join("\n");
  assert.equal(parseControlCommand(command()).boostPercent, 12.5);
  assert.equal(parseControlCommand(command()).leadMinutes, 15);
  const invalidAutoBoost = { kind: "invalid_template", template: "auto_boost" };
  assert.deepEqual(parseControlCommand(command({ boost: "ก่อน 10 นาที", lead: "เพิ่ม 10%" })), invalidAutoBoost);
  assert.deepEqual(parseControlCommand(command({ windows: ["23:00-06:00"] })), invalidAutoBoost);
  assert.deepEqual(parseControlCommand(command({ windows: [] })), invalidAutoBoost);
  assert.deepEqual(parseControlCommand(command({
    windows: Array.from({ length: 25 }, () => "12:00-13:00")
  })), invalidAutoBoost);
});

test("control postbacks are opaque, versioned, and allow-listed", () => {
  const id = "ca_12345678-1234-1234-1234-123456789abc";
  assert.deepEqual(parseControlPostbackData(`op=confirm&id=${id}&v=1`), {
    action: "confirm",
    requestId: id,
    version: 1
  });
  assert.equal(parseControlPostbackData(`op=confirm&id=${id}`), null);
  assert.equal(parseControlPostbackData(`op=delete&id=${id}&v=1`), null);
  assert.equal(parseControlPostbackData("op=confirm&id=../../etc/passwd&v=1"), null);
});

test("performance report labels Gross/Net data and marks stale snapshots", () => {
  const message = buildPerformanceReportMessage({
    client: { name: "punpan_020" },
    snapshot: {
      schemaVersion: 2,
      campaignName: "2026-07-20 06:00:00",
      dailyBudgetMinor: 300_000,
      costMinor: 240_000,
      grossRevenueMinor: 900_000,
      grossRoiMilli: 3750,
      netRevenueMinor: 850_000,
      netRoiMilli: 3542,
      gmvMinor: 900_000,
      currency: "THB",
      observedAt: "2026-07-20T10:00:00.000Z"
    },
    now: new Date("2026-07-20T10:20:00.000Z"),
    stale: true
  });
  assert.match(message.text, /ข้อมูลเก่า/);
  assert.match(message.text, /ยอดขาย Gross/);
  assert.match(message.text, /Gross ROI: 3\.75/);
  assert.match(message.text, /ยอดขาย Net/);
  assert.match(message.text, /ไม่ใช้ข้อมูลชุดนี้ตัดสินใจ/);
});

test("Auto Boost Flex exposes an ON/OFF message toggle, DRY-RUN, and masks advertiser ID", () => {
  const client = {
    name: "punpan_020",
    advertiserId: "7646832328389263378",
    lineControl: { aliases: ["Ppan"] }
  };
  const plan = {
    enabled: false,
    executionMode: "DRY_RUN",
    baseBudgetMinor: 300_000,
    targetBudgetMinor: 330_000,
    boostBps: 1_000,
    leadMinutes: 10,
    originalWindows: [
      { start: "12:00", end: "13:00" },
      { start: "20:00", end: "21:00" }
    ]
  };
  const off = buildAutoBoostStatusMessage({ client, plan });
  const encodedOff = JSON.stringify(off);
  assert.match(off.altText, /OFF \(DRY-RUN\)/);
  assert.match(encodedOff, /เปิด Auto Boost Ppan/);
  assert.match(encodedOff, /••••3378/);
  assert.doesNotMatch(encodedOff, /7646832328389263378/);
  assert.match(encodedOff, /12:00-13:00/);

  const on = buildAutoBoostStatusMessage({ client, plan: { ...plan, enabled: true } });
  assert.match(JSON.stringify(on), /ปิด Auto Boost Ppan/);
});

test("Auto Boost occurrence messages describe boost and restore without claiming a TikTok write", () => {
  const client = {
    name: "punpan_020",
    advertiserId: "7646832328389263378"
  };
  const plan = { baseBudgetMinor: 300_000, targetBudgetMinor: 330_000 };
  const boost = buildAutoBoostDryRunOccurrenceMessage({
    client,
    plan,
    occurrence: { phase: "BOOST", dueAt: "2026-07-21T04:50:00.000Z" }
  });
  assert.match(boost.text, /DRY-RUN Auto Boost/);
  assert.match(boost.text, /฿3,000.*→.*฿3,300/);
  assert.match(boost.text, /ยังไม่ได้เปลี่ยนงบใน TikTok/);

  const restore = buildAutoBoostDryRunOccurrenceMessage({
    client,
    plan,
    occurrence: { phase: "RESTORE", dueAt: "2026-07-21T06:00:00.000Z" }
  });
  assert.match(restore.text, /คืนงบ Auto Boost/);
  assert.match(restore.text, /฿3,300.*→.*฿3,000/);
});
