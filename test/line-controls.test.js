import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutoBoostDryRunOccurrenceMessage,
  buildAutoBoostStatusMessage,
  buildPerformanceReportMessage,
  parseControlCommand,
  parseControlPostbackData
} from "../src/line-controls.js";

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
  assert.equal(parseControlCommand("ตั้งงบ Ppan -1"), null);
  assert.equal(parseControlCommand("คูปอง Ppan พรุ่งนี้ ก่อนนิดหน่อย"), null);
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
  assert.equal(parseControlCommand([
    "ตั้ง shortcut Ppan main",
    "ชื่อ Live",
    "งบ 3000",
    "ROI 3.5"
  ].join("\n")), null);
  assert.equal(parseControlCommand([
    "ตั้ง shortcut Ppan main",
    "ชื่อ Live",
    "งบ 3000",
    "ROI 3.5",
    "เติมเมื่อ 80%",
    "advertiser 123"
  ].join("\n")), null);
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
  assert.equal(parseControlCommand(command({ boost: "ก่อน 10 นาที", lead: "เพิ่ม 10%" })), null);
  assert.equal(parseControlCommand(command({ windows: ["23:00-06:00"] })), null);
  assert.equal(parseControlCommand(command({ windows: [] })), null);
  assert.equal(parseControlCommand(command({
    windows: Array.from({ length: 25 }, () => "12:00-13:00")
  })), null);
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
