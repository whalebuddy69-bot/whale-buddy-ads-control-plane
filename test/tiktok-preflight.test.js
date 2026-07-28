import assert from "node:assert/strict";
import test from "node:test";

import { runLiveGmvMaxPreflight } from "../src/tiktok-preflight.js";

const advertiserId = "7666005333864644624";
const expectedTikTokAccountId = "7285935731820920833";
const identityId = "7285935731820920777";
const storeId = "7494273466236699983";
const bcId = "7576520121268699154";

function fake(overrides = {}) {
  return {
    async getAdvertiserInfo() {
      return {
        advertiserId,
        currency: "THB",
        timezone: "Asia/Bangkok",
        accountStatus: "STATUS_ENABLE",
        requestId: "advertiser-rid"
      };
    },
    async getGmvMaxStores() {
      return {
        stores: [{
          storeId,
          storeAuthorizedBcId: bcId,
          isGmvMaxAvailable: true,
          exclusiveAuthorizedAdvertiserInfo: {
            advertiserId,
            authorizationStatus: "EFFECTIVE",
            identityId
          }
        }],
        requestId: "store-rid"
      };
    },
    async getGmvMaxIdentities() {
      return {
        identities: [{
          identityId,
          identityType: "BC_AUTH_TT",
          identityAuthorizedBcId: bcId,
          identityAuthorizedShopId: null,
          storeId: null,
          displayName: "Ppan",
          userName: "ppan",
          liveGmvMaxAvailable: false,
          unavailableReason: "OCCUPIED",
          isRunningCustomShopAds: false
        }],
        requestId: "identity-rid"
      };
    },
    async getLiveCampaigns() {
      return [{
        campaign_id: "1871072292203826",
        campaign_name: "Ppan LIVE",
        primary_status: "STATUS_DELIVERY_OK"
      }];
    },
    ...overrides
  };
}

function discover(tiktok = fake(), overrides = {}) {
  return runLiveGmvMaxPreflight({
    tiktok,
    advertiserId,
    expectedTikTokAccountId,
    expectedBusinessCenterId: bcId,
    expectedCurrency: "THB",
    expectedTimezone: "Asia/Bangkok",
    ...overrides
  });
}

test("first API read returns discovery data and never a create/update decision", async () => {
  const result = await discover();
  assert.equal(result.decision, "DISCOVERY_REQUIRED");
  assert.equal(result.writeAuthorized, false);
  assert.equal(result.expectedTikTokAccountId, expectedTikTokAccountId);
  assert.notEqual(result.expectedTikTokAccountId, result.identityCandidates[0].identityId);
  assert.deepEqual(result.identityCandidates[0], {
    identityId,
    identityType: "BC_AUTH_TT",
    identityAuthorizedBcId: bcId,
    identityAuthorizedShopId: null,
    storeId: null,
    displayName: "Ppan",
    userName: "ppan",
    liveGmvMaxAvailable: false,
    unavailableReason: "OCCUPIED",
    isRunningCustomShopAds: false
  });
  assert.deepEqual(result.campaignCandidates, [{
    campaignId: "1871072292203826",
    campaignName: "Ppan LIVE",
    primaryStatus: "STATUS_DELIVERY_OK",
    requiresStatusReview: false
  }]);
});

test("discovery uses only documented API identity bindings", async () => {
  const secondIdentityId = "7285935731820920666";
  const result = await discover(fake({
    async getGmvMaxStores() {
      return {
        stores: [{
          storeId,
          storeAuthorizedBcId: bcId,
          isGmvMaxAvailable: true,
          exclusiveAuthorizedAdvertiserInfo: {
            advertiserId,
            authorizationStatus: "EFFECTIVE",
            identityId: null
          }
        }],
        requestId: "store-rid"
      };
    },
    async getGmvMaxIdentities() {
      return {
        identities: [
          {
            identityId,
            identityType: "BC_AUTH_TT",
            identityAuthorizedBcId: bcId,
            liveGmvMaxAvailable: true,
            isRunningCustomShopAds: null
          },
          {
            identityId: secondIdentityId,
            identityType: "TTS_TT",
            storeId,
            liveGmvMaxAvailable: true,
            isRunningCustomShopAds: false
          },
          {
            identityId: "7285935731820920555",
            identityType: "BC_AUTH_TT",
            identityAuthorizedBcId: "7627179356976201745",
            liveGmvMaxAvailable: true,
            isRunningCustomShopAds: false
          }
        ],
        requestId: "identity-rid"
      };
    }
  }));
  assert.equal(result.decision, "DISCOVERY_REQUIRED");
  assert.deepEqual(
    result.identityCandidates.map((identity) => identity.identityId),
    [identityId, secondIdentityId]
  );
});

test("discovery blocks an exclusive authorization bound to another API identity", async () => {
  const result = await discover(fake({
    async getGmvMaxStores() {
      return {
        stores: [{
          storeId,
          storeAuthorizedBcId: bcId,
          isGmvMaxAvailable: true,
          exclusiveAuthorizedAdvertiserInfo: {
            advertiserId,
            authorizationStatus: "EFFECTIVE",
            identityId: "7285935731820920999"
          }
        }],
        requestId: "store-rid"
      };
    }
  }));
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.reason, "NO_DOCUMENTED_API_IDENTITY_CANDIDATE");
});

test("discovery blocks account, Business Center, and authorization mismatches", async (t) => {
  await t.test("currency", async () => {
    const result = await discover(fake({
      async getAdvertiserInfo() {
        return {
          advertiserId,
          currency: "USD",
          timezone: "Asia/Bangkok",
          accountStatus: "STATUS_ENABLE",
          requestId: "advertiser-rid"
        };
      }
    }));
    assert.equal(result.reason, "ADVERTISER_CURRENCY_MISMATCH");
  });

  await t.test("Business Center", async () => {
    const result = await discover(fake(), {
      expectedBusinessCenterId: "7627179356976201745"
    });
    assert.equal(result.reason, "NO_EXCLUSIVELY_AUTHORIZED_STORE");
  });

  await t.test("exclusive authorization status", async () => {
    const result = await discover(fake({
      async getGmvMaxStores() {
        return {
          stores: [{
            storeId,
            storeAuthorizedBcId: bcId,
            isGmvMaxAvailable: true,
            exclusiveAuthorizedAdvertiserInfo: {
              advertiserId,
              authorizationStatus: "UNAUTHORIZED",
              identityId
            }
          }],
          requestId: "store-rid"
        };
      }
    }));
    assert.equal(result.reason, "NO_EXCLUSIVELY_AUTHORIZED_STORE");
  });
});

test("discovery surfaces missing campaign status for mandatory operator review", async () => {
  const result = await discover(fake({
    async getLiveCampaigns() {
      return [{
        campaign_id: "1871072292203826",
        campaign_name: "Historical campaign"
      }];
    }
  }));
  assert.equal(result.decision, "DISCOVERY_REQUIRED");
  assert.equal(result.campaignCandidates[0].primaryStatus, null);
  assert.equal(result.campaignCandidates[0].requiresStatusReview, true);
});

test("discovery blocks an oversized LIVE campaign candidate set", async () => {
  const result = await discover(fake({
    async getLiveCampaigns() {
      const error = new Error("too many candidates");
      error.code = "TIKTOK_CAMPAIGN_CANDIDATE_LIMIT";
      error.requestId = "campaign-limit-rid";
      throw error;
    }
  }));
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.reason, "TOO_MANY_LIVE_CAMPAIGN_CANDIDATES");
  assert.equal(result.requestIds.includes("campaign-limit-rid"), true);
});

test("discovery rejects malformed campaign IDs instead of inventing a binding", async () => {
  await assert.rejects(
    discover(fake({
      async getLiveCampaigns() {
        return [{ campaign_id: "not-an-id", primary_status: "STATUS_DISABLE" }];
      }
    })),
    /campaign_id must be a TikTok numeric ID/
  );
});
