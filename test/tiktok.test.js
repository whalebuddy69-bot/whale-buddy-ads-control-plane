import assert from "node:assert/strict";
import test from "node:test";
import { TikTokClient, TikTokApiError, dateInTimeZone } from "../src/tiktok.js";

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
