import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  TikTokApiControl,
  buildTikTokOAuthConnectedMessage
} from "../src/tiktok-api-control.js";

const nonce = crypto.randomBytes(32).toString("base64url");
const encodedStatePayload = Buffer.from(JSON.stringify({
  v: 1,
  nonce,
  issuedAt: Date.parse("2026-07-28T10:00:00.000Z"),
  redirectUri: "https://example.com/oauth/tiktok/callback"
})).toString("base64url");
const state = `${encodedStatePayload}.signature`;
const encryptionKey = crypto.randomBytes(32).toString("base64url");
const appId = "7667234745498992657";
const advertiserId = "7666005333864644624";

function config() {
  return {
    agencyId: "whalebuddy-ads",
    clients: [{
      id: "punpan_020",
      name: "punpan_020",
      lineApproverUserIds: ["U-owner"],
      advertiserId,
      lineControl: { enabled: true, aliases: ["Ppan"] },
      campaignSelector: { expectedTikTokAccountId: "7285935731820920833" },
      telemetry: { businessCenterId: "7627179356976201745" }
    }]
  };
}

function harness({
  tokenAdvertiserIds = [advertiserId],
  grantAdvertiserIds = [advertiserId],
  oauthAdminLineUserIds = ["U-owner"]
} = {}) {
  const calls = [];
  const nonceDigest = crypto.createHash("sha256").update(nonce).digest("hex");
  const store = {
    createTikTokOAuthState(input) {
      calls.push(["createState", input]);
    },
    getTikTokOAuthStateByNonceHash(value) {
      assert.equal(value, nonceDigest);
      return {
        stateId: "ttstate-1",
        clientId: "whalebuddy-ads",
        lineUserId: "U-owner",
        consumedAt: null
      };
    },
    consumeTikTokOAuthState(input) {
      calls.push(["consumeState", input]);
    },
    saveTikTokCredential(input) {
      calls.push(["saveCredential", input]);
      assert.equal(input.encryptedBlob.includes(Buffer.from("token-secret-sentinel")), false);
    },
    appendAuditEvent(input) {
      calls.push(["audit", input]);
    }
  };
  const oauthClient = {
    createAuthorizationRequest() {
      return {
        url: "https://business-api.tiktok.com/portal/auth?state=x",
        nonce,
        issuedAt: Date.parse("2026-07-28T10:00:00.000Z"),
        expiresAt: Date.parse("2026-07-28T10:05:00.000Z")
      };
    },
    verifyAuthorizationState(input) {
      calls.push(["verifyState", input]);
    },
    async exchangeAuthorizationCode(input) {
      calls.push(["exchange", input]);
      return {
        accessToken: "token-secret-sentinel",
        refreshToken: null,
        advertiserIds: tokenAdvertiserIds,
        scopes: [],
        expiresInSeconds: null,
        refreshTokenExpiresInSeconds: null,
        tokenType: null,
        requestId: "token-rid"
      };
    },
    async getAdvertiserGrant() {
      return {
        advertiserIds: grantAdvertiserIds,
        requestId: "grant-rid"
      };
    }
  };
  const line = {
    async push(to, message) {
      calls.push(["push", { to, message }]);
    }
  };
  const control = new TikTokApiControl({
    oauthClient,
    credentialRouter: { clientForAdvertiser() {} },
    store,
    line,
    config: config(),
    appId,
    oauthAdminLineUserIds,
    encryptionKey,
    now: () => new Date("2026-07-28T10:01:00.000Z")
  });
  return { control, calls };
}

test("TikTok API control persists one-time state and encrypted agency grant", async () => {
  const { control, calls } = harness();
  const start = control.createAuthorizationRequest({ lineUserId: "U-owner" });
  assert.match(start.url, /^https:\/\/business-api\.tiktok\.com\//);
  assert.equal(calls[0][0], "createState");
  assert.equal(calls[0][1].clientId, "whalebuddy-ads");
  assert.notEqual(calls[0][1].nonceHash, nonce);

  const result = await control.completeAuthorization({
    authCode: "auth-code",
    state
  });
  assert.deepEqual(result.advertiserIds, [advertiserId]);
  const saved = calls.find(([name]) => name === "saveCredential")[1];
  assert.equal(saved.clientId, "whalebuddy-ads");
  assert.deepEqual(saved.advertiserIds, [advertiserId]);
  assert.equal(calls.some(([name]) => name === "push"), true);
  const audit = calls.find(([name]) => name === "audit")[1];
  assert.equal(audit.actorType, "LINE_USER");
  assert.equal(audit.actorId, "U-owner");
  assert.equal(audit.details.stateId, "ttstate-1");
  assert.equal(audit.details.tokenRequestId, "token-rid");
  assert.equal(audit.details.grantRequestId, "grant-rid");
  assert.doesNotMatch(JSON.stringify(audit), /token-secret-sentinel/);
});

test("TikTok API control rejects inconsistent token and grant scopes", async () => {
  const { control, calls } = harness({
    tokenAdvertiserIds: [advertiserId],
    grantAdvertiserIds: ["7594326831382298641"]
  });
  await assert.rejects(
    control.completeAuthorization({ authCode: "auth-code", state }),
    { code: "TIKTOK_OAUTH_GRANT_MISMATCH" }
  );
  assert.equal(calls.some(([name]) => name === "saveCredential"), false);
});

test("TikTok API control does not infer an OAuth admin from client approvers", () => {
  const { control, calls } = harness({
    oauthAdminLineUserIds: ["U-explicit-agency-admin"]
  });
  assert.throws(
    () => control.createAuthorizationRequest({ lineUserId: "U-owner" }),
    { code: "TIKTOK_OAUTH_AGENCY_APPROVER_REQUIRED" }
  );
  assert.equal(calls.some(([name]) => name === "createState"), false);
});

test("OAuth success message never includes tokens and shows config matching", () => {
  const message = buildTikTokOAuthConnectedMessage({
    config: config(),
    advertiserIds: [advertiserId]
  });
  assert.match(message.text, /Ppan/);
  assert.match(message.text, /1\/1/);
  assert.doesNotMatch(message.text, /access.?token/i);
});
