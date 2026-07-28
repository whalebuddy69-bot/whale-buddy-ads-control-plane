import assert from "node:assert/strict";
import test from "node:test";
import { TikTokClient, TikTokApiError, dateInTimeZone } from "../src/tiktok.js";

test("TikTok client does not serialize its access token", () => {
  const client = new TikTokClient({
    accessToken: "access-token-secret-sentinel",
    fetchImpl: async () => {
      throw new Error("not called");
    }
  });
  assert.doesNotMatch(JSON.stringify(client), /access-token-secret-sentinel/);
});

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("getCampaignInfo sends stable IDs and normalizes the budget", async () => {
  let captured;
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response({
        code: 0,
        request_id: "tt-1",
        data: {
          advertiser_id: "adv",
          campaign_id: "cmp",
          budget: 12000,
          store_id: "shop",
          store_authorized_bc_id: "bc",
          shopping_ads_type: "LIVE",
          operation_status: "ENABLE"
        }
      });
    }
  });
  const result = await client.getCampaignInfo({ advertiserId: "adv", campaignId: "cmp" });
  assert.equal(result.budget, 12000);
  assert.match(captured.url, /advertiser_id=adv/);
  assert.match(captured.url, /campaign_id=cmp/);
  assert.equal(captured.options.headers["Access-Token"], "token");
});

test("updateCampaignBudget uses the official GMV Max update endpoint", async () => {
  let captured;
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response({ code: 0, request_id: "tt-2", data: {} });
    }
  });
  await client.updateCampaignBudget({ advertiserId: "adv", campaignId: "cmp", budget: 15000 });
  assert.match(captured.url, /\/campaign\/gmv_max\/update\/$/);
  assert.deepEqual(JSON.parse(captured.options.body), { advertiser_id: "adv", campaign_id: "cmp", budget: 15000 });
});

test("getAdvertiserInfo reads only currency, timezone, and account status", async () => {
  let captured;
  const accessToken = "advertiser-info-secret-sentinel";
  const client = new TikTokClient({
    accessToken,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response({
        code: 0,
        message: "OK",
        request_id: "advertiser-info-1",
        data: {
          list: [{
            advertiser_id: "7646832328389263378",
            currency: "THB",
            timezone: "Asia/Bangkok",
            status: "STATUS_ENABLE"
          }]
        }
      });
    }
  });

  const result = await client.getAdvertiserInfo({
    advertiserId: "7646832328389263378"
  });

  assert.deepEqual(result, {
    advertiserId: "7646832328389263378",
    currency: "THB",
    timezone: "Asia/Bangkok",
    accountStatus: "STATUS_ENABLE",
    requestId: "advertiser-info-1"
  });
  assert.match(captured.url, /\/advertiser\/info\//);
  const query = new URL(captured.url).searchParams;
  assert.deepEqual(JSON.parse(query.get("advertiser_ids")), ["7646832328389263378"]);
  assert.deepEqual(JSON.parse(query.get("fields")), [
    "advertiser_id",
    "currency",
    "timezone",
    "status"
  ]);
  assert.equal(captured.options.method, "GET");
  assert.equal(captured.options.body, undefined);
  assert.equal(captured.options.headers["Access-Token"], accessToken);
  assert.doesNotMatch(captured.url, new RegExp(accessToken));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(accessToken));
});

test("getAdvertiserInfo fails closed on an absent or out-of-scope account", async () => {
  const empty = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "advertiser-info-empty",
      data: { list: [] }
    })
  });
  await assert.rejects(() => empty.getAdvertiserInfo({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_ADVERTISER_INFO");
    assert.equal(error.requestId, "advertiser-info-empty");
    assert.match(error.message, /exactly one account/);
    return true;
  });

  const mismatched = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "advertiser-info-mismatch",
      data: {
        list: [{
          advertiser_id: "another-advertiser",
          currency: "THB",
          timezone: "Asia/Bangkok",
          status: "STATUS_ENABLE"
        }]
      }
    })
  });
  await assert.rejects(() => mismatched.getAdvertiserInfo({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_ADVERTISER_INFO");
    assert.equal(error.requestId, "advertiser-info-mismatch");
    assert.match(error.message, /different advertiser_id/);
    return true;
  });
});

test("getAdvertiserInfo rejects malformed account context without coercion", async () => {
  for (const [field, value, expectedMessage] of [
    ["currency", "thb", /invalid currency/],
    ["timezone", " Asia\\/Bangkok", /invalid timezone/],
    ["status", "ENABLE", /invalid account status/]
  ]) {
    const account = {
      advertiser_id: "adv",
      currency: "THB",
      timezone: "Asia/Bangkok",
      status: "STATUS_ENABLE",
      [field]: value
    };
    const client = new TikTokClient({
      accessToken: "token",
      fetchImpl: async () => response({
        code: 0,
        request_id: `advertiser-info-invalid-${field}`,
        data: { list: [account] }
      })
    });

    await assert.rejects(() => client.getAdvertiserInfo({ advertiserId: "adv" }), (error) => {
      assert.equal(error.code, "TIKTOK_MALFORMED_ADVERTISER_INFO");
      assert.match(error.message, expectedMessage);
      return true;
    });
  }
});

test("getGmvMaxStores reads bindings and normalizes all binding IDs", async () => {
  let captured;
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response({
        code: 0,
        request_id: "stores-1",
        data: {
          store_list: [{
            store_id: 101,
            store_authorized_bc_id: 202,
            is_gmv_max_available: true,
            is_owner_bc: true,
            store_name: "Ppan Shop",
            store_status: "ACTIVE",
            store_authorized_bc_info: { bc_id: 202, bc_name: "Whale Buddy", user_role: "ADMIN" },
            exclusive_authorized_advertiser_info: {
              advertiser_id: 303,
              store_id: 101,
              identity_id: 404,
              authorization_status: "EFFECTIVE"
            }
          }]
        }
      });
    }
  });

  const result = await client.getGmvMaxStores({ advertiserId: 303 });

  assert.equal(result.requestId, "stores-1");
  assert.equal(result.stores.length, 1);
  assert.deepEqual(
    {
      storeId: result.stores[0].storeId,
      storeAuthorizedBcId: result.stores[0].storeAuthorizedBcId,
      bcId: result.stores[0].storeAuthorizedBcInfo.bcId,
      exclusiveAdvertiserId: result.stores[0].exclusiveAuthorizedAdvertiserInfo.advertiserId,
      exclusiveStoreId: result.stores[0].exclusiveAuthorizedAdvertiserInfo.storeId,
      exclusiveIdentityId: result.stores[0].exclusiveAuthorizedAdvertiserInfo.identityId
    },
    {
      storeId: "101",
      storeAuthorizedBcId: "202",
      bcId: "202",
      exclusiveAdvertiserId: "303",
      exclusiveStoreId: "101",
      exclusiveIdentityId: "404"
    }
  );
  assert.equal(result.stores[0].raw.store_name, "Ppan Shop");
  assert.match(captured.url, /\/gmv_max\/store\/list\//);
  assert.equal(new URL(captured.url).searchParams.get("advertiser_id"), "303");
  assert.equal(captured.options.method, "GET");
});

test("getGmvMaxStores fails closed on an incomplete or mismatched binding", async () => {
  const incomplete = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "stores-malformed",
      data: {
        store_list: [{
          store_id: "shop",
          store_authorized_bc_id: "bc",
          is_gmv_max_available: true
        }]
      }
    })
  });
  await assert.rejects(() => incomplete.getGmvMaxStores({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_STORE_LIST");
    assert.equal(error.requestId, "stores-malformed");
    return true;
  });

  const mismatched = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "stores-mismatch",
      data: {
        store_list: [{
          store_id: "shop",
          store_authorized_bc_id: "bc",
          is_gmv_max_available: true,
          is_owner_bc: true,
          exclusive_authorized_advertiser_info: {
            advertiser_id: "adv",
            store_id: "another-shop",
            authorization_status: "EFFECTIVE"
          }
        }]
      }
    })
  });
  await assert.rejects(() => mismatched.getGmvMaxStores({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_STORE_LIST");
    assert.match(error.message, /mismatched exclusive authorization/);
    return true;
  });
});

test("getGmvMaxStores preserves an explicit unauthorized state without inventing an advertiser ID", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "stores-unauthorized",
      data: {
        store_list: [{
          store_id: "shop",
          store_authorized_bc_id: "bc",
          is_gmv_max_available: false,
          is_owner_bc: true,
          exclusive_authorized_advertiser_info: {
            store_id: "shop",
            authorization_status: "UNAUTHORIZED"
          }
        }]
      }
    })
  });

  const { stores } = await client.getGmvMaxStores({ advertiserId: "adv" });
  assert.equal(stores[0].exclusiveAuthorizedAdvertiserInfo.authorizationStatus, "UNAUTHORIZED");
  assert.equal(stores[0].exclusiveAuthorizedAdvertiserInfo.advertiserId, null);
});

test("getGmvMaxIdentities preserves LIVE availability and normalizes identity IDs", async () => {
  let captured;
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url) => {
      captured = String(url);
      return response({
        code: 0,
        request_id: "identities-1",
        data: {
          identity_list: [
            {
              identity_id: 501,
              identity_type: "BC_AUTH_TT",
              identity_authorized_bc_id: 202,
              live_gmv_max_available: true,
              product_gmv_max_available: false,
              is_running_custom_shop_ads: false,
              available_status: "AVAILABLE",
              display_name: "Ppan"
            },
            {
              identity_id: "502",
              identity_type: "TTS_TT",
              store_id: 101,
              live_gmv_max_available: false,
              unavailable_reason: "OCCUPIED",
              is_running_custom_shop_ads: true
            }
          ]
        }
      });
    }
  });

  const result = await client.getGmvMaxIdentities({
    advertiserId: 303,
    storeId: 101,
    storeAuthorizedBcId: 202
  });

  assert.equal(result.requestId, "identities-1");
  assert.equal(result.identities[0].identityId, "501");
  assert.equal(result.identities[0].identityAuthorizedBcId, "202");
  assert.equal(result.identities[0].liveGmvMaxAvailable, true);
  assert.equal(result.identities[0].isRunningCustomShopAds, false);
  assert.equal(result.identities[0].raw.display_name, "Ppan");
  assert.equal(result.identities[1].storeId, "101");
  assert.equal(result.identities[1].unavailableReason, "OCCUPIED");
  const query = new URL(captured).searchParams;
  assert.equal(query.get("advertiser_id"), "303");
  assert.equal(query.get("store_id"), "101");
  assert.equal(query.get("store_authorized_bc_id"), "202");
  assert.match(captured, /\/gmv_max\/identity\/get\//);
});

test("getGmvMaxIdentities fails closed when LIVE eligibility cannot be proven", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "identities-malformed",
      data: {
        identity_list: [{
          identity_id: "identity",
          identity_type: "BC_AUTH_TT",
          identity_authorized_bc_id: "bc"
        }]
      }
    })
  });

  await assert.rejects(() => client.getGmvMaxIdentities({
    advertiserId: "adv",
    storeId: "shop",
    storeAuthorizedBcId: "bc"
  }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_IDENTITY_LIST");
    assert.equal(error.requestId, "identities-malformed");
    assert.match(error.message, /live_gmv_max_available/);
    return true;
  });
});

test("getGmvMaxBidRecommendation uses LIVE inputs and validates its recommendation", async () => {
  let captured;
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url) => {
      captured = String(url);
      return response({
        code: 0,
        request_id: "recommend-1",
        data: { roas_bid: "3.75", budget: "1200" }
      });
    }
  });

  const result = await client.getGmvMaxBidRecommendation({
    advertiserId: 303,
    storeId: 101,
    identityId: 501
  });

  assert.deepEqual(result, {
    roasBid: 3.75,
    budget: 1200,
    requestId: "recommend-1",
    raw: { roas_bid: "3.75", budget: "1200" }
  });
  const query = new URL(captured).searchParams;
  assert.equal(query.get("advertiser_id"), "303");
  assert.equal(query.get("store_id"), "101");
  assert.equal(query.get("identity_id"), "501");
  assert.equal(query.get("shopping_ads_type"), "LIVE");
  assert.equal(query.get("optimization_goal"), "VALUE");
  assert.match(captured, /\/gmv_max\/bid\/recommend\//);
});

test("getGmvMaxBidRecommendation rejects malformed or unscoped LIVE requests", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "recommend-malformed",
      data: { roas_bid: 0, budget: 1200 }
    })
  });

  await assert.rejects(
    () => client.getGmvMaxBidRecommendation({ advertiserId: "adv", storeId: "shop" }),
    /identityId is required/
  );
  await assert.rejects(() => client.getGmvMaxBidRecommendation({
    advertiserId: "adv",
    storeId: "shop",
    identityId: "identity"
  }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_BID_RECOMMENDATION");
    assert.equal(error.requestId, "recommend-malformed");
    return true;
  });
});

test("getLiveCampaigns reads every page and preserves LIVE filters", async () => {
  const captured = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ campaign_id: `cmp-${index + 1}` }));
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url) => {
      captured.push(String(url));
      const page = Number(new URL(url).searchParams.get("page"));
      return response({
        code: 0,
        request_id: `campaign-list-${page}`,
        data: {
          list: page === 1 ? firstPage : [{ campaign_id: "cmp-101" }],
          page_info: { page, page_size: 100, total_page: 2, total_number: 101 }
        }
      });
    }
  });

  const campaigns = await client.getLiveCampaigns({
    advertiserId: "adv",
    storeId: "shop",
    campaignIds: ["cmp-1", 2]
  });

  assert.equal(campaigns.length, 101);
  assert.equal(campaigns.at(-1).campaign_id, "cmp-101");
  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
  const firstQuery = new URL(captured[0]).searchParams;
  assert.equal(firstQuery.get("page_size"), "100");
  assert.deepEqual(JSON.parse(firstQuery.get("filtering")), {
    gmv_max_promotion_types: ["LIVE_GMV_MAX"],
    store_ids: ["shop"],
    campaign_ids: ["cmp-1", "2"]
  });
  assert.match(captured[0], /\/gmv_max\/campaign\/get\//);
});

test("getLiveCampaigns accepts an explicitly empty paginated result", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "campaign-list-empty",
      data: {
        list: [],
        page_info: { page: 1, page_size: 100, total_page: 1, total_number: 0 }
      }
    })
  });

  assert.deepEqual(await client.getLiveCampaigns({ advertiserId: "adv" }), []);
});

test("getLiveCampaigns fails closed before reading an unbounded candidate set", async () => {
  let captured;
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url) => {
      captured = String(url);
      return response({
        code: 0,
        request_id: "campaign-list-over-limit",
        data: {
          list: Array.from({ length: 25 }, (_, index) => ({ campaign_id: `cmp-${index + 1}` })),
          page_info: { page: 1, page_size: 25, total_page: 2, total_number: 26 }
        }
      });
    }
  });

  await assert.rejects(
    () => client.getLiveCampaigns({ advertiserId: "adv", maxResults: 25 }),
    { code: "TIKTOK_CAMPAIGN_CANDIDATE_LIMIT", requestId: "campaign-list-over-limit" }
  );
  assert.equal(new URL(captured).searchParams.get("page_size"), "25");
});

test("getLiveCampaigns rejects missing pagination instead of returning a partial list", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "campaign-list-missing-page-info",
      data: { list: [{ campaign_id: "cmp" }] }
    })
  });

  await assert.rejects(() => client.getLiveCampaigns({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_CAMPAIGN_LIST");
    assert.equal(error.requestId, "campaign-list-missing-page-info");
    return true;
  });
});

test("getLiveCampaigns rejects non-advancing pagination", async () => {
  let calls = 0;
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ campaign_id: `cmp-${index + 1}` }));
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => {
      calls += 1;
      return response({
        code: 0,
        request_id: `campaign-list-replay-${calls}`,
        data: {
          list: calls === 1 ? firstPage : [{ campaign_id: "cmp-101" }],
          page_info: { page: 1, page_size: 100, total_page: 2, total_number: 101 }
        }
      });
    }
  });

  await assert.rejects(() => client.getLiveCampaigns({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_CAMPAIGN_LIST");
    assert.match(error.message, /did not advance/);
    return true;
  });
  assert.equal(calls, 2);
});

test("getLiveCampaigns rejects pagination beyond its safety bound", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({
      code: 0,
      request_id: "campaign-list-too-many-pages",
      data: {
        list: Array.from({ length: 100 }, (_, index) => ({ campaign_id: `cmp-${index + 1}` })),
        page_info: { page: 1, page_size: 100, total_page: 10_001, total_number: 1_000_001 }
      }
    })
  });

  await assert.rejects(() => client.getLiveCampaigns({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_CAMPAIGN_LIST");
    assert.match(error.message, /invalid pagination/);
    return true;
  });
});

test("getLiveCampaigns rejects an incomplete final page", async () => {
  let calls = 0;
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ campaign_id: `cmp-${index + 1}` }));
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => {
      calls += 1;
      return response({
        code: 0,
        request_id: `campaign-list-partial-${calls}`,
        data: {
          list: calls === 1 ? firstPage : [],
          page_info: { page: calls, page_size: 100, total_page: 2, total_number: 101 }
        }
      });
    }
  });

  await assert.rejects(() => client.getLiveCampaigns({ advertiserId: "adv" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_CAMPAIGN_LIST");
    assert.match(error.message, /incomplete page/);
    return true;
  });
  assert.equal(calls, 2);
});

test("getTodayCampaignSpend uses the scoped GMV Max report and paginates", async () => {
  const captured = [];
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async (url) => {
      captured.push(String(url));
      const page = Number(new URL(url).searchParams.get("page"));
      return response({
      code: 0,
      request_id: `tt-3-${page}`,
      data: {
        list: [{ dimensions: { campaign_id: "cmp", stat_time_day: "2026-07-18" }, metrics: { cost: page === 1 ? "700" : "50.5", currency: "THB" } }],
        page_info: { page, page_size: 1000, total_page: 2, total_number: 2 }
      }
      });
    }
  });
  const result = await client.getTodayCampaignSpend({
    advertiserId: "adv",
    storeId: "shop",
    campaignId: "cmp",
    now: new Date("2026-07-18T02:00:00Z")
  });
  assert.equal(result.spend, 750.5);
  assert.equal(result.currency, "THB");
  assert.equal(result.date, "2026-07-18");
  assert.equal(captured.length, 2);
  const query = new URL(captured[0]).searchParams;
  assert.equal(query.get("store_ids"), '["shop"]');
  assert.deepEqual(JSON.parse(query.get("filtering")), { gmv_max_promotion_types: ["LIVE"], campaign_ids: ["cmp"] });
  assert.match(captured[0], /\/gmv_max\/report\/get\//);
});

test("campaign info fails closed when identity fields are omitted", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => response({ code: 0, request_id: "missing", data: { budget: 1000 } })
  });
  await assert.rejects(() => client.getCampaignInfo({ advertiserId: "adv", campaignId: "cmp" }), (error) => {
    assert.equal(error.code, "TIKTOK_MALFORMED_CAMPAIGN_INFO");
    return true;
  });
});

test("a TikTok write transport failure is explicitly outcome-unknown", async () => {
  const client = new TikTokClient({
    accessToken: "token",
    fetchImpl: async () => { throw new Error("socket reset"); }
  });
  await assert.rejects(() => client.updateCampaignBudget({ advertiserId: "adv", campaignId: "cmp", budget: 15000 }), (error) => {
    assert.equal(error.code, "TIKTOK_TRANSPORT_ERROR");
    assert.equal(error.outcomeKnown, false);
    return true;
  });
});

test("API business errors preserve TikTok request IDs", async () => {
  const client = new TikTokClient({ accessToken: "token", fetchImpl: async () => response({ code: 40001, message: "bad", request_id: "rid" }) });
  await assert.rejects(() => client.getCampaignInfo({ advertiserId: "a", campaignId: "c" }), (error) => {
    assert.ok(error instanceof TikTokApiError);
    assert.equal(error.requestId, "rid");
    return true;
  });
});

test("dateInTimeZone observes the ad-account timezone", () => {
  assert.equal(dateInTimeZone(new Date("2026-07-17T18:30:00Z"), "Asia/Bangkok"), "2026-07-18");
});
