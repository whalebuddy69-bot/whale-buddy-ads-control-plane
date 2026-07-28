import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { encryptSecretJson } from "../src/secret-box.js";
import {
  TikTokCredentialRouter,
  tiktokCredentialAad
} from "../src/tiktok-credential-router.js";

const appId = "7667234745498992657";
const advertiserId = "7666005333864644624";
const encryptionKey = crypto.randomBytes(32).toString("base64url");

function credential(overrides = {}) {
  const metadata = {
    credentialRef: "ttcred_1234567890",
    clientId: "whalebuddy-ads",
    appId,
    advertiserIds: [advertiserId],
    createdAt: "2026-07-28T00:00:00.000Z",
    ...overrides
  };
  return {
    ...metadata,
    encryptedBlob: encryptSecretJson(
      { accessToken: "authorized-access-token-value" },
      { key: encryptionKey, aad: tiktokCredentialAad(metadata) }
    )
  };
}

test("credential router selects by advertiser and decrypts only in memory", () => {
  const stored = credential();
  const seen = [];
  class FakeClient {
    constructor(options) {
      seen.push(options);
    }

    getAdvertiserInfo() {}
    getCampaignInfo() {}
    getGmvMaxStores() {}
    getGmvMaxIdentities() {}
    getGmvMaxBidRecommendation() {}
    getLiveCampaigns() {}
    getTodayCampaignSpend() {}
    updateCampaignBudget() {}
  }
  const router = new TikTokCredentialRouter({
    store: {
      getTikTokCredentialByAdvertiserId(id) {
        assert.equal(id, advertiserId);
        return stored;
      }
    },
    encryptionKey,
    appId,
    credentialOwnerId: "whalebuddy-ads",
    ClientClass: FakeClient
  });
  assert.deepEqual(router.credentialStatus(advertiserId), {
    connected: true,
    advertiserId,
    credentialRef: stored.credentialRef,
    authorizedAt: stored.createdAt,
    expiresAt: null
  });
  const readOnly = router.clientForAdvertiser(advertiserId);
  assert.equal(typeof readOnly.getCampaignInfo, "function");
  assert.equal(typeof readOnly.getGmvMaxStores, "function");
  assert.equal(readOnly.updateCampaignBudget, undefined);
  assert.equal(readOnly instanceof FakeClient, false);
  assert.equal(seen[0].accessToken, "authorized-access-token-value");
  assert.doesNotMatch(JSON.stringify(router), new RegExp(encryptionKey));
});

test("credential router fails closed for missing and mismatched grants", () => {
  const missing = new TikTokCredentialRouter({
    store: { getTikTokCredentialByAdvertiserId: () => null },
    encryptionKey,
    appId,
    credentialOwnerId: "whalebuddy-ads"
  });
  assert.deepEqual(missing.credentialStatus(advertiserId), {
    connected: false,
    advertiserId
  });
  assert.throws(() => missing.clientForAdvertiser(advertiserId), {
    code: "TIKTOK_CREDENTIAL_NOT_FOUND"
  });

  const mismatched = new TikTokCredentialRouter({
    store: {
      getTikTokCredentialByAdvertiserId: () => credential({
        advertiserIds: ["7594326831382298641"]
      })
    },
    encryptionKey,
    appId,
    credentialOwnerId: "whalebuddy-ads"
  });
  assert.throws(() => mismatched.clientForAdvertiser(advertiserId), {
    code: "TIKTOK_CREDENTIAL_BINDING_INVALID"
  });
});
