export class TikTokApiError extends Error {
  constructor(message, { code, requestId, status, payload, outcomeKnown = true, cause } = {}) {
    super(message);
    this.name = "TikTokApiError";
    this.code = code;
    this.requestId = requestId;
    this.status = status;
    this.payload = payload;
    this.outcomeKnown = outcomeKnown;
    if (cause) this.cause = cause;
  }
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function stringifyQueryValue(value) {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

const GMV_MAX_CAMPAIGN_PAGE_SIZE = 100;
const GMV_MAX_CAMPAIGN_MAX_PAGES = 10_000;

function paginationInteger(value, { min, max }) {
  if (typeof value === "string" && !/^(0|[1-9]\d*)$/.test(value)) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function malformedCampaignList(message, payload) {
  return new TikTokApiError(message, {
    code: "TIKTOK_MALFORMED_CAMPAIGN_LIST",
    requestId: payload?.request_id,
    outcomeKnown: true
  });
}

export class TikTokClient {
  constructor({
    accessToken,
    fetchImpl = globalThis.fetch,
    baseUrl = "https://business-api.tiktok.com/open_api/v1.3",
    timeoutMs = 15_000
  }) {
    if (!accessToken) throw new Error("TikTok access token is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("TikTok timeoutMs must be at least 1000");
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async #request(path, { method = "GET", query, body } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, stringifyQueryValue(value));
      }
    }
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          "Access-Token": this.accessToken,
          "Content-Type": "application/json"
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new TikTokApiError(`TikTok transport failed: ${error?.message ?? "network error"}`, {
        code: "TIKTOK_TRANSPORT_ERROR",
        outcomeKnown: method === "GET",
        cause: error
      });
    }
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new TikTokApiError(`TikTok returned invalid JSON (${response.status})`, {
        code: "TIKTOK_INVALID_RESPONSE",
        status: response.status,
        payload: text.slice(0, 500),
        outcomeKnown: method === "GET"
      });
    }
    if (!response.ok || payload.code !== 0) {
      throw new TikTokApiError(payload.message || `TikTok API failed (${response.status})`, {
        code: payload.code,
        requestId: payload.request_id,
        status: response.status,
        payload,
        outcomeKnown: method === "GET" || response.status < 500
      });
    }
    return payload;
  }

  #requireCampaignInfo(data, requestId) {
    const requiredStrings = [
      "advertiser_id",
      "campaign_id",
      "store_id",
      "store_authorized_bc_id",
      "shopping_ads_type",
      "operation_status"
    ];
    for (const field of requiredStrings) {
      if (typeof data?.[field] !== "string" || data[field] === "") {
        throw new TikTokApiError(`TikTok campaign info omitted ${field}`, {
          code: "TIKTOK_MALFORMED_CAMPAIGN_INFO",
          requestId,
          outcomeKnown: true
        });
      }
    }
    const budget = Number(data.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new TikTokApiError("TikTok campaign info returned an invalid budget", {
        code: "TIKTOK_MALFORMED_CAMPAIGN_INFO",
        requestId,
        outcomeKnown: true
      });
    }
    return budget;
  }

  async getCampaignInfo({ advertiserId, campaignId }) {
    const payload = await this.#request("/campaign/gmv_max/info/", {
      query: { advertiser_id: advertiserId, campaign_id: campaignId }
    });
    const data = payload.data ?? {};
    const budget = this.#requireCampaignInfo(data, payload.request_id);
    return {
      advertiserId: String(data.advertiser_id),
      campaignId: String(data.campaign_id),
      campaignName: data.campaign_name,
      budget,
      operationStatus: data.operation_status,
      shoppingAdsType: data.shopping_ads_type,
      storeId: String(data.store_id),
      storeAuthorizedBcId: String(data.store_authorized_bc_id),
      raw: data,
      requestId: payload.request_id
    };
  }

  async updateCampaignBudget({ advertiserId, campaignId, budget }) {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error("budget must be a positive number");
    const payload = await this.#request("/campaign/gmv_max/update/", {
      method: "POST",
      body: { advertiser_id: String(advertiserId), campaign_id: String(campaignId), budget }
    });
    return { data: payload.data ?? {}, requestId: payload.request_id };
  }

  async getLiveCampaigns({ advertiserId, storeId, campaignIds } = {}) {
    const filtering = { gmv_max_promotion_types: ["LIVE_GMV_MAX"] };
    if (storeId) filtering.store_ids = [String(storeId)];
    if (campaignIds?.length) filtering.campaign_ids = campaignIds.map(String);
    const campaigns = [];
    const seenCampaignIds = new Set();
    let expectedPageSize;
    let expectedTotalPages;
    let expectedTotalNumber;

    for (let page = 1; page <= GMV_MAX_CAMPAIGN_MAX_PAGES; page += 1) {
      const payload = await this.#request("/gmv_max/campaign/get/", {
        query: {
          advertiser_id: advertiserId,
          filtering,
          page,
          page_size: GMV_MAX_CAMPAIGN_PAGE_SIZE
        }
      });
      const pageRows = payload.data?.list;
      const pageInfo = payload.data?.page_info;
      if (!Array.isArray(pageRows)) {
        throw malformedCampaignList("TikTok GMV Max campaign list omitted data.list", payload);
      }
      if (pageInfo == null || typeof pageInfo !== "object" || Array.isArray(pageInfo)) {
        throw malformedCampaignList("TikTok GMV Max campaign list omitted data.page_info", payload);
      }

      const responsePage = paginationInteger(pageInfo.page, { min: 1, max: GMV_MAX_CAMPAIGN_MAX_PAGES });
      const pageSize = paginationInteger(pageInfo.page_size, { min: 1, max: GMV_MAX_CAMPAIGN_PAGE_SIZE });
      const totalPages = paginationInteger(pageInfo.total_page, { min: 0, max: GMV_MAX_CAMPAIGN_MAX_PAGES });
      const totalNumber = paginationInteger(pageInfo.total_number, { min: 0, max: Number.MAX_SAFE_INTEGER });
      if (responsePage == null || pageSize == null || totalPages == null || totalNumber == null) {
        throw malformedCampaignList("TikTok GMV Max campaign list returned invalid pagination", payload);
      }
      if (responsePage !== page) {
        throw malformedCampaignList("TikTok GMV Max campaign pagination did not advance", payload);
      }
      if (totalNumber === 0) {
        if (page !== 1 || pageRows.length !== 0 || (totalPages !== 0 && totalPages !== 1)) {
          throw malformedCampaignList("TikTok GMV Max campaign list returned inconsistent empty pagination", payload);
        }
        return [];
      }
      if (Math.ceil(totalNumber / pageSize) !== totalPages) {
        throw malformedCampaignList("TikTok GMV Max campaign list returned inconsistent pagination totals", payload);
      }
      if (page > totalPages || pageRows.length === 0 || pageRows.length > pageSize) {
        throw malformedCampaignList("TikTok GMV Max campaign list returned an incomplete page", payload);
      }
      if (page < totalPages && pageRows.length !== pageSize) {
        throw malformedCampaignList("TikTok GMV Max campaign list returned a short intermediate page", payload);
      }

      if (page === 1) {
        expectedPageSize = pageSize;
        expectedTotalPages = totalPages;
        expectedTotalNumber = totalNumber;
      } else if (
        pageSize !== expectedPageSize
        || totalPages !== expectedTotalPages
        || totalNumber !== expectedTotalNumber
      ) {
        throw malformedCampaignList("TikTok GMV Max campaign pagination changed while reading", payload);
      }

      for (const campaign of pageRows) {
        const campaignId = campaign?.campaign_id;
        if (typeof campaignId === "string" && campaignId !== "") {
          if (seenCampaignIds.has(campaignId)) {
            throw malformedCampaignList("TikTok GMV Max campaign pagination returned a duplicate campaign", payload);
          }
          seenCampaignIds.add(campaignId);
        }
        campaigns.push(campaign);
      }
      if (campaigns.length > expectedTotalNumber) {
        throw malformedCampaignList("TikTok GMV Max campaign list exceeded its reported total", payload);
      }
      if (page === expectedTotalPages) {
        if (campaigns.length !== expectedTotalNumber) {
          throw malformedCampaignList("TikTok GMV Max campaign list ended before its reported total", payload);
        }
        return campaigns;
      }
    }

    throw malformedCampaignList("TikTok GMV Max campaign pagination exceeded the safety limit");
  }

  /**
   * Reads current-day cost from TikTok's dedicated GMV Max report. The request
   * is scoped by advertiser, Shop, LIVE type, and campaign and paginates the
   * complete response. Reporting is delayed, so callers must alert early and
   * must not treat this value as a real-time financial ledger.
   */
  async getTodayCampaignSpend({ advertiserId, storeId, campaignId, timezone = "Asia/Bangkok", now = new Date() }) {
    if (!storeId) throw new Error("storeId is required for a GMV Max report");
    const date = dateInTimeZone(now, timezone);
    const rows = [];
    const requestIds = [];
    let page = 1;
    let totalPages = 1;
    do {
      const payload = await this.#request("/gmv_max/report/get/", {
        query: {
          advertiser_id: advertiserId,
          store_ids: [String(storeId)],
          start_date: date,
          end_date: date,
          metrics: ["cost"],
          dimensions: ["campaign_id", "stat_time_day"],
          filtering: {
            gmv_max_promotion_types: ["LIVE"],
            campaign_ids: [String(campaignId)]
          },
          page,
          page_size: 1000
        }
      });
      requestIds.push(payload.request_id);
      const pageRows = payload.data?.list;
      if (!Array.isArray(pageRows)) {
        throw new TikTokApiError("TikTok GMV Max report omitted data.list", {
          code: "TIKTOK_MALFORMED_REPORT",
          requestId: payload.request_id,
          outcomeKnown: true
        });
      }
      rows.push(...pageRows);
      totalPages = Number(payload.data?.page_info?.total_page ?? 1);
      if (!Number.isSafeInteger(totalPages) || totalPages < 0 || totalPages > 10_000 || (totalPages === 0 && pageRows.length > 0)) {
        throw new TikTokApiError("TikTok GMV Max report returned invalid pagination", {
          code: "TIKTOK_MALFORMED_REPORT",
          requestId: payload.request_id,
          outcomeKnown: true
        });
      }
      page += 1;
    } while (page <= totalPages);

    let spend = 0;
    const currencies = new Set();
    for (const row of rows) {
      if (String(row.dimensions?.campaign_id) !== String(campaignId)) {
        throw new TikTokApiError("TikTok GMV Max report returned a campaign outside the requested filter", {
          code: "TIKTOK_REPORT_SCOPE_MISMATCH",
          outcomeKnown: true
        });
      }
      const cost = Number(row.metrics?.cost);
      if (!Number.isFinite(cost) || cost < 0) {
        throw new TikTokApiError("TikTok GMV Max report returned invalid cost", {
          code: "TIKTOK_MALFORMED_REPORT",
          outcomeKnown: true
        });
      }
      spend += cost;
      if (row.metrics?.currency) currencies.add(String(row.metrics.currency));
    }
    if (currencies.size > 1) {
      throw new TikTokApiError("TikTok GMV Max report returned mixed currencies", {
        code: "TIKTOK_REPORT_CURRENCY_MISMATCH",
        outcomeKnown: true
      });
    }
    return {
      spend,
      currency: currencies.size === 1 ? [...currencies][0] : null,
      date,
      rowCount: rows.length,
      requestIds
    };
  }
}

export { dateInTimeZone };
