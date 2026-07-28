import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildBudgetAlertMessage,
  LineClient,
  parseBudgetText,
  parsePairingText,
  parsePostbackData,
  verifyLineSignature
} from "../src/line.js";

test("LINE client does not serialize its access token", () => {
  const accessToken = "line-access-token-sentinel";
  const client = new LineClient({
    accessToken,
    fetchImpl: async () => {
      throw new Error("not called");
    }
  });
  assert.doesNotMatch(JSON.stringify(client), new RegExp(accessToken));
});

test("verifyLineSignature validates the unparsed webhook bytes", () => {
  const raw = Buffer.from('{"events":[]}');
  const secret = "line-secret";
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(verifyLineSignature(raw, signature, secret), true);
  assert.equal(verifyLineSignature(Buffer.from('{"events":[1]}'), signature, secret), false);
});

test("parsePostbackData accepts only known actions and opaque IDs", () => {
  assert.deepEqual(parsePostbackData("a=suggest&id=abcDEF_123"), { action: "suggest", requestId: "abcDEF_123", version: null });
  assert.deepEqual(parsePostbackData("a=confirm&id=abcDEF_123&v=2"), { action: "confirm", requestId: "abcDEF_123", version: 2 });
  assert.equal(parsePostbackData("a=confirm&id=abcDEF_123"), null);
  assert.equal(parsePostbackData("a=transfer&id=abcDEF_123"), null);
  assert.equal(parsePostbackData("a=suggest&id=../../secret"), null);
});

test("parseBudgetText accepts Thai or English prefixes and strips separators", () => {
  assert.deepEqual(parseBudgetText("งบ abcdef123456 15,000"), { requestCode: "abcdef123456", amount: 15000 });
  assert.deepEqual(parseBudgetText("budget ABCDEF123456 12500.50"), { requestCode: "abcdef123456", amount: 12500.5 });
  assert.equal(parseBudgetText("งบ abcdef12 15000"), null);
  assert.equal(parseBudgetText("15000"), null);
});

test("parsePairingText accepts only an explicit high-entropy pairing command", () => {
  assert.deepEqual(parsePairingText("จับคู่ punpan_020 AbcdEFGH_1234567"), {
    clientId: "punpan_020",
    code: "AbcdEFGH_1234567"
  });
  assert.deepEqual(parsePairingText("pair client-1 abcdEFGH-1234567"), {
    clientId: "client-1",
    code: "abcdEFGH-1234567"
  });
  assert.equal(parsePairingText("จับคู่ punpan_020 short"), null);
  assert.equal(parsePairingText("AbcdEFGH_1234567"), null);
  assert.equal(parsePairingText("pair ../../etc AbcdEFGH_1234567"), null);
});

test("budget alert does not expose full advertiser IDs", () => {
  const message = buildBudgetAlertMessage({
    id: "abcdef12-3456-7890",
    clientName: "Client",
    campaignName: "Live",
    advertiserId: "1234567890123456",
    spend: 800,
    currentBudget: 1000,
    proposedBudget: 1500,
    maxBudget: 6000,
    presetLabel: "เพิ่มงบ 20%",
    currency: "THB",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    timezone: "Asia/Bangkok"
  });
  const serialized = JSON.stringify(message);
  assert.doesNotMatch(serialized, /1234567890123456/);
  assert.match(serialized, /••••3456/);
  assert.match(serialized, /งบ abcdef123456 6000/);
  assert.doesNotMatch(serialized, /15000/);
  assert.match(serialized, /เพิ่มงบ 20%/);
});

test("preset-only budget alert hides every manual-input affordance", () => {
  const message = buildBudgetAlertMessage({
    id: "abcdef12-3456-7890",
    clientName: "Client",
    campaignName: "Live",
    advertiserId: "1234567890123456",
    spend: 800,
    currentBudget: 1000,
    proposedBudget: 1200,
    maxBudget: 6000,
    presetLabel: "เพิ่มงบ 20%",
    allowManualTarget: false,
    currency: "THB",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    timezone: "Asia/Bangkok"
  });
  const serialized = JSON.stringify(message);
  assert.doesNotMatch(serialized, /กรอกงบเอง/);
  assert.doesNotMatch(serialized, /a=custom/);
  assert.doesNotMatch(serialized, /abcdef123456/);
  assert.match(serialized, /เพิ่มงบ 20%/);
  assert.match(serialized, /ไม่เพิ่ม/);
});

test("LINE push treats a retry-key 409 with accepted request ID as success", async () => {
  let calls = 0;
  const client = new LineClient({
    accessToken: "token",
    fetchImpl: async () => {
      calls += 1;
      return new Response("", {
        status: 409,
        headers: { "x-line-accepted-request-id": "accepted-123" }
      });
    }
  });
  const result = await client.push("U123", { type: "text", text: "hello" }, crypto.randomUUID());
  assert.deepEqual(result, { duplicate: true, acceptedRequestId: "accepted-123" });
  assert.equal(calls, 1);
});

test("LINE push does not accept an arbitrary 409", async () => {
  const client = new LineClient({
    accessToken: "token",
    fetchImpl: async () => new Response("conflict", { status: 409 })
  });
  await assert.rejects(
    client.push("U123", { type: "text", text: "hello" }, crypto.randomUUID()),
    (error) => error.status === 409 && error.retryable === false
  );
});

test("LINE push marks only an explicit invalid recipient as recipient-permanent", async () => {
  const client = new LineClient({
    accessToken: "token",
    fetchImpl: async () => new Response(JSON.stringify({
      message: "Failed to send messages",
      details: [{ message: "The property, to, is invalid.", property: "to" }]
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })
  });
  await assert.rejects(
    client.push("invalid", { type: "text", text: "hello" }, crypto.randomUUID()),
    (error) => error.status === 400
      && error.retryable === false
      && error.recipientPermanent === true
  );
});

test("LINE auth and malformed-message failures do not revoke a viable recipient", async () => {
  for (const response of [
    new Response(JSON.stringify({ message: "Authentication failed" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    }),
    new Response(JSON.stringify({
      message: "The request body has 1 error(s)",
      details: [{ message: "May not be empty", property: "messages[0].text" }]
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    }),
    new Response(JSON.stringify({ message: "Failed to send messages" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })
  ]) {
    const client = new LineClient({
      accessToken: "token",
      fetchImpl: async () => response
    });
    await assert.rejects(
      client.push("U123", { type: "text", text: "hello" }, crypto.randomUUID()),
      (error) => error.retryable === false && error.recipientPermanent === false
    );
  }
});
