import assert from "node:assert/strict";
import test from "node:test";
import { BudgetGuardService } from "../src/service.js";
import { SqliteStore } from "../src/store.js";
import { creatorCapChangeNonce } from "../src/creator-policy.js";

const NOW = new Date("2026-11-06T08:00:00.000Z");
function harness(t) {
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
