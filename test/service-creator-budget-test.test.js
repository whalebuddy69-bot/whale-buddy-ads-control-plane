import assert from "node:assert/strict";
import test from "node:test";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";
import { buildPerformanceReportMessage } from "../src/line-controls.js";

const NOW = new Date("2026-11-07T00:00:00Z");
const result = { clientId: "punpan_020", ownerLineUserId: "U1", permitId: "ppan-test-20261107",
  status: "SUCCEEDED", observedBudgetMinor: 360000, message: "ทดสอบสำเร็จ" };
function harness(t) {
  const store = new SqliteStore(); t.after(() => store.close());
  store.createLinePairing({ clientId: "punpan_020", codeHash: "a".repeat(64), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 600000) });
  store.consumeLinePairing({ clientId: "punpan_020", codeHash: "a".repeat(64), lineUserId: "U1", consumedAt: NOW });
  const sent = [];
  const service = new BudgetGuardService({ store, config: { clients: [{ id: "punpan_020", lineApproverUserIds: [] }] },
    line: { async push(...args) { sent.push(args); } }, now: () => NOW });
  return { service, store, sent };
}
test("one-shot result goes only to the current paired private owner", async t => {
  const h = harness(t);
  await assert.rejects(h.service.notifyCreatorBudgetTestResult({ ...result, ownerLineUserId: "U2" }));
  await assert.rejects(h.service.notifyCreatorBudgetTestResult({ ...result, clientId: "other" }));
  assert.equal(h.sent.length, 0);
  await h.service.notifyCreatorBudgetTestResult(result);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][0], "U1");
  assert.deepEqual(h.sent[0][1], { type: "text", text: "ทดสอบสำเร็จ" });
  assert.match(h.sent[0][2], /^[a-f0-9-]{36}$/);
  assert.equal(h.store.listAuditEvents({ eventType: "CREATOR_BUDGET_TEST_LINE_RESULT_SENT" }).length, 1);
});
test("public worker health excludes campaign, budget and permit details", t => {
  const { service } = harness(t);
  service.creatorBudgetTest = { health: () => ({ enabled: true, status: "waiting-for-window", campaignId: "PRIVATE",
    permitId: "PRIVATE", capMinor: 1000000, key: "SECRET", generalAutoOptimizationEnabled: true }) };
  const health = service.creatorBudgetTestHealth();
  assert.equal(health.enabled, true);
  assert.equal(health.generalAutoOptimizationEnabled, false);
  assert.doesNotMatch(JSON.stringify(health), /PRIVATE|SECRET|1000000/);
});
test("failed result delivery is audited without reflecting transport credentials or resending", async t => {
  const h = harness(t);
  h.service.line.push = async () => { throw new Error("SECRET transport"); };
  await assert.rejects(h.service.notifyCreatorBudgetTestResult(result), /Delivery unconfirmed/);
  const audit = h.store.listAuditEvents({ eventType: "CREATOR_BUDGET_TEST_LINE_RESULT_UNCONFIRMED" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.automaticRetry, false);
  assert.doesNotMatch(JSON.stringify(audit), /SECRET/);
});
test("owner status distinguishes a dated one-shot from general Auto and read-only data", () => {
  const report = buildPerformanceReportMessage({ client: { name: "Ppan" }, stale: false, now: NOW, snapshot: {
    source: "tiktok-creator-api", advertiserId: "7666005333864644624", tiktokAccountId: "7285935731820920833",
    campaignId: "1881130110195874", campaignName: "Ppan", dailyBudgetMinor: 300000, costMinor: 0,
    currency: "THB", targetRoi: 30, observedAt: NOW.toISOString(), reportingDate: "2026-11-07",
    creatorBudgetTest: { enabled: true, status: "waiting-for-window", localDate: "2026-11-07",
      notBefore: "2026-11-06T22:00:00Z", expiresAt: "2026-11-07T05:00:00Z" }
  } });
  assert.match(report.text, /Auto ต่อเนื่องยังปิด/);
  assert.match(report.text, /รอช่วงเวลาที่อนุมัติ/);
  assert.match(report.text, /2,400/);
  assert.doesNotMatch(report.text, /ยังไม่เปิด Auto Top-up หรือคำสั่งเขียน TikTok/);
});
