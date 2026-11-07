import assert from "node:assert/strict";
import test from "node:test";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";
import { creatorCapChangeNonce } from "../src/creator-policy.js";

const NOW = new Date("2026-11-06T08:00:00.000Z");
function harness(t, { creatorLineCapWriteDisabled = false, creatorLineWebsiteOnly = false } = {}) {
  const store = new SqliteStore(); t.after(() => store.close());
  store.createLinePairing({ clientId: "punpan_020", codeHash: "a".repeat(64), createdAt: NOW, expiresAt: new Date(NOW.getTime() + 600000) });
  store.consumeLinePairing({ clientId: "punpan_020", codeHash: "a".repeat(64), lineUserId: "U1", consumedAt: NOW });
  const line = {
    replies: [], pushes: [], failNext: false,
    async reply(_token, message) { if (this.failNext) { this.failNext = false; throw new Error("temporary reply failure"); } this.replies.push(message); },
    async push(_userId, message) { this.pushes.push(message); }
  };
  let writes = 0;
  const service = new BudgetGuardService({
    config: { requestTtlMinutes: 15, clients: [{ id: "punpan_020", name: "Ppan", lineApproverUserIds: [], lineControl: { enabled: true, aliases: ["Ppan"] } }] },
    store, line, tiktok: { async updateCampaignBudget() { writes++; } }, executionEnabled: false,
    creatorLineCapWriteDisabled, creatorLineWebsiteOnly,
    now: () => NOW, logger: { error() {} }
  });
  return { store, line, service, writes: () => writes };
}
function textEvent(id, text, { userId = "U1", sourceType = "user" } = {}) {
  return { webhookEventId: id, type: "message", source: { type: sourceType, userId }, replyToken: id, message: { type: "text", text } };
}
function confirmation(id, nonce, options = {}) {
  return { webhookEventId: id, type: "postback", source: { type: options.sourceType ?? "user", userId: options.userId ?? "U1" }, replyToken: id,
    postback: { data: `action=creator-cap-confirm&nonce=${nonce}` } };
}

test("paired private owner can view/propose/confirm a cap; no proposal itself edits the cap or TikTok", async (t) => {
  const h = harness(t);
  await h.service.handleLineEvents([textEvent("view-cap", "ดูเพดาน Ppan")]);
  assert.match(h.line.replies.at(-1).text, /10,000/);
  await h.service.handleLineEvents([textEvent("set-cap", "ตั้งเพดาน Ppan 9000")]);
  const nonce = creatorCapChangeNonce({ clientId: "punpan_020", ownerLineUserId: "U1", sourceEventId: "set-cap" });
  assert.equal(h.store.getCreatorPolicy({ clientId: "punpan_020" }).capMinor, 1000000);
  assert.equal(h.line.replies.at(-1).type, "flex");
  await h.service.handleLineEvents([confirmation("confirm-cap", nonce)]);
  const policy = h.store.getCreatorPolicy({ clientId: "punpan_020" });
  assert.equal(policy.capMinor, 900000);
  assert.equal(policy.campaignCapMinor, 900000);
  assert.equal(policy.clientDailyCapMinor, 900000);
  assert.equal(policy.executionEnabled, false);
  assert.match(h.line.replies.at(-1).text, /ยังไม่ได้ปรับงบ TikTok/);
  assert.equal(h.writes(), 0);
});

test("foreign users, group chat and unknown aliases cannot propose or confirm cap changes", async (t) => {
  const h = harness(t);
  h.store.ensureCreatorPolicy({ clientId: "punpan_020", now: NOW });
  for (const event of [textEvent("foreign", "ตั้งเพดาน Ppan 9000", { userId: "U2" }), textEvent("group", "ตั้งเพดาน Ppan 9000", { sourceType: "group" }), textEvent("unknown", "ตั้งเพดาน Other 9000")]) {
    await h.service.handleLineEvents([event]);
  }
  await h.service.handleLineEvents([textEvent("owner-propose", "ตั้งเพดาน Ppan 9000")]);
  const nonce = creatorCapChangeNonce({ clientId: "punpan_020", ownerLineUserId: "U1", sourceEventId: "owner-propose" });
  await h.service.handleLineEvents([confirmation("foreign-confirm", nonce, { userId: "U2" })]);
  assert.doesNotMatch(JSON.stringify(h.line.replies.at(-1)), /9000|9,000/);
  await h.service.handleLineEvents([confirmation("group-confirm", nonce, { sourceType: "group" })]);
  assert.equal(h.store.getCreatorPolicy({ clientId: "punpan_020" }).capMinor, 1000000);
  assert.equal(h.store.getCreatorCapChange(nonce).status, "PENDING");
  assert.equal(h.writes(), 0);
});

test("failed proposal and confirmation replies recover durably without duplicate proposals or revisions", async (t) => {
  const h = harness(t);
  h.line.failNext = true;
  const result = await h.service.handleLineEvents([textEvent("failed-proposal", "ตั้งเพดาน Ppan 9500")]);
  assert.equal(result[0].status, "FAILED");
  const nonce = creatorCapChangeNonce({ clientId: "punpan_020", ownerLineUserId: "U1", sourceEventId: "failed-proposal" });
  await h.service.recoverLineWebhookEvents({ maxEvents: 5 });
  assert.equal(h.line.pushes.at(-1).type, "flex");
  assert.equal(h.store.getCreatorCapChange(nonce).status, "PENDING");
  h.line.failNext = true;
  await h.service.handleLineEvents([confirmation("failed-confirmation", nonce)]);
  const revision = h.store.getCreatorPolicy({ clientId: "punpan_020" }).revision;
  await h.service.recoverLineWebhookEvents({ maxEvents: 5 });
  assert.equal(h.store.getCreatorPolicy({ clientId: "punpan_020" }).revision, revision);
  assert.match(h.line.pushes.at(-1).text, /ยืนยันไปแล้ว/);
  assert.equal(h.writes(), 0);
});

test("abandoned pre-handler proposal and confirmation are replayed once with current owner authorization", async (t) => {
  const h = harness(t);
  h.store.recordWebhookEvent({ provider: "LINE", eventId: "abandoned-proposal", payload: {
    command: { kind: "control_command", sourceType: "user", userId: "U1", command: { kind: "creator_cap_propose", clientAlias: "Ppan", capMinor: 800000 } }
  }, receivedAt: NOW });
  await h.service.recoverLineWebhookEvents({ maxEvents: 5 });
  const nonce = creatorCapChangeNonce({ clientId: "punpan_020", ownerLineUserId: "U1", sourceEventId: "abandoned-proposal" });
  assert.equal(h.store.getCreatorCapChange(nonce).status, "PENDING");
  h.store.recordWebhookEvent({ provider: "LINE", eventId: "abandoned-confirm", payload: {
    command: { kind: "control_postback", sourceType: "user", userId: "U1", data: `action=creator-cap-confirm&nonce=${nonce}` }
  }, receivedAt: NOW });
  await h.service.recoverLineWebhookEvents({ maxEvents: 5 });
  const policy = h.store.getCreatorPolicy({ clientId: "punpan_020" });
  assert.equal(policy.capMinor, 800000);
  assert.equal(policy.revision, 2);
  assert.equal(policy.executionEnabled, false);
  assert.equal(h.writes(), 0);
});

test("website-only mode keeps cap reads but blocks new and old LINE writes including webhook recovery", async t => {
  const h = harness(t, { creatorLineCapWriteDisabled: true });
  const { change: old } = h.store.proposeCreatorCapChange({ clientId: "punpan_020", ownerLineUserId: "U1",
    capMinor: 800_000, sourceEventId: "pre-migration-proposal", now: NOW });
  await h.service.handleLineEvents([textEvent("view-web-cap", "ดูเพดาน Ppan")]);
  assert.match(h.line.replies.at(-1).text, /10,000/);
  assert.match(h.line.replies.at(-1).text, /https:\/\/report\.whalebuddy69\.com\/automation/);
  assert.doesNotMatch(h.line.replies.at(-1).text, /ตั้งเพดาน Ppan 10000/);
  await h.service.handleLineEvents([textEvent("blocked-propose", "ตั้งเพดาน Ppan 9000")]);
  assert.match(h.line.replies.at(-1).text, /ย้ายไปหน้า Automation/);
  await h.service.handleLineEvents([confirmation("blocked-confirm", old.nonce)]);
  assert.match(h.line.replies.at(-1).text, /ย้ายไปหน้า Automation/);
  const cancel = confirmation("blocked-cancel", old.nonce);
  cancel.postback.data = `action=creator-cap-cancel&nonce=${old.nonce}`;
  await h.service.handleLineEvents([cancel]);
  assert.match(h.line.replies.at(-1).text, /ย้ายไปหน้า Automation/);

  h.store.recordWebhookEvent({ provider: "LINE", eventId: "abandoned-migration-confirm", payload: {
    command: { kind: "control_postback", sourceType: "user", userId: "U1", data: `action=creator-cap-confirm&nonce=${old.nonce}` }
  }, receivedAt: NOW });
  h.store.recordWebhookEvent({ provider: "LINE", eventId: "abandoned-migration-propose", payload: {
    command: { kind: "control_command", sourceType: "user", userId: "U1", command: { kind: "creator_cap_propose", clientAlias: "Ppan", capMinor: 800000 } }
  }, receivedAt: NOW });
  await h.service.recoverLineWebhookEvents({ maxEvents: 5 });
  assert.equal(h.line.pushes.length, 2);
  for (const message of h.line.pushes) assert.match(message.text, /ย้ายไปหน้า Automation/);
  assert.equal(h.store.getCreatorCapChange(old.nonce).status, "PENDING");
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM creator_cap_changes").get().n, 1);
  assert.equal(h.store.getCreatorPolicy().revision, 1);
  assert.equal(h.writes(), 0);
});

test("global website-only LINE mode blocks operational commands and replies without replaying prior actions", async t => {
  const h = harness(t, { creatorLineWebsiteOnly: true });
  h.store.ensureCreatorPolicy({ now: NOW });
  await h.service.handleLineEvents([textEvent("global-view", "ดูเพดาน Ppan"), textEvent("global-status", "สถานะ Ppan")]);
  assert.match(h.line.replies[0].text, /10,000/);
  assert.doesNotMatch(JSON.stringify(h.line.replies[1]), /LINE ใช้ดูสถานะและรับแจ้งเตือน/);

  const oldCap = h.store.proposeCreatorCapChange({ clientId: "punpan_020", ownerLineUserId: "U1",
    capMinor: 800_000, sourceEventId: "old-global-cap", now: NOW }).change;
  const back = (id, data) => ({ ...confirmation(id, oldCap.nonce), postback: { data } });
  const blocked = [
    textEvent("global-set-cap", "ตั้งเพดาน Ppan 8000"),
    textEvent("global-adjust", "ตั้งงบ Ppan 1500"),
    textEvent("global-sub", "รายงาน Ppan ทุก 2 ชั่วโมง"),
    textEvent("global-boost", "เปิด Auto Boost Ppan"),
    textEvent("global-budget", "งบ abcdef123456 1500"),
    confirmation("global-confirm", oldCap.nonce),
    back("global-old-control", "op=confirm&id=ca_1234567890abcdef&v=1"),
    back("global-old-budget", "a=confirm&id=old-request&v=1"),
    textEvent("global-help", "เมนู"),
  ];
  await h.service.handleLineEvents(blocked);
  for (const message of h.line.replies.slice(2)) {
    assert.match(message.text, /LINE ใช้ดูสถานะและรับแจ้งเตือน/);
    assert.match(message.text, /https:\/\/report\.whalebuddy69\.com\/automation/);
  }
  for (const [id, command] of [
    ["global-recover-control", { kind: "control_command", command: { kind: "report_subscribe", clientAlias: "Ppan", intervalHours: 2 } }],
    ["global-recover-cap", { kind: "control_postback", data: `action=creator-cap-confirm&nonce=${oldCap.nonce}` }],
    ["global-recover-budget", { kind: "postback", data: "a=confirm&id=old-request&v=1" }],
  ]) h.store.recordWebhookEvent({ provider: "LINE", eventId: id, payload: { sourceType: "user", command: { ...command, userId: "U1" } }, receivedAt: NOW });
  assert.equal((await h.service.recoverLineWebhookEvents({ maxEvents: 5 })).length, 3);
  assert.equal(h.line.pushes.length, 3);
  for (const message of h.line.pushes) assert.match(message.text, /LINE ใช้ดูสถานะและรับแจ้งเตือน/);
  assert.equal(h.store.getCreatorCapChange(oldCap.nonce).status, "PENDING");
  assert.equal(h.store.getCreatorPolicy().revision, 1);
  assert.equal(h.store.getReportSubscription({ clientId: "punpan_020", lineUserId: "U1" }), null);
  assert.equal(h.writes(), 0);
});
