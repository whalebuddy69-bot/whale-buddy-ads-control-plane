import assert from "node:assert/strict";
import test from "node:test";

import {
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
