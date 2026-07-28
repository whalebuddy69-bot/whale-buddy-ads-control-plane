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
const GMV_MAX_CAMPAIGN_MAX_RESULTS = 1_000;
const ADVERTISER_INFO_FIELDS = Object.freeze([
  "advertiser_id",
  "currency",
  "timezone",
  "status"
]);

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

function malformedReadResponse(code, message, payload) {
  return new TikTokApiError(message, {
    code,
    requestId: payload?.request_id,
    outcomeKnown: true
  });
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function responseId(value, field, { code, label, payload }) {
  if (typeof value === "string" && value !== "" && value.trim() === value) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  throw malformedReadResponse(code, `TikTok ${label} returned an invalid ${field}`, payload);
}

function requestIdValue(value, field) {
  if (typeof value === "string" && value !== "" && value.trim() === value) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error(`${field} is required`);
}

function optionalResponseId(value, field, context) {
  return value == null ? null : responseId(value, field, context);
}

export class TikTokClient {
  #accessToken;
  #fetch;
  #baseUrl;
  #timeoutMs;

  constructor({
    accessToken,
    fetchImpl = globalThis.fetch,
    baseUrl = "https://business-api.tiktok.com/open_api/v1.3",
    timeoutMs = 15_000
  }) {
    if (!accessToken) throw new Error("TikTok access token is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("TikTok timeoutMs must be at least 1000");
    this.#accessToken = accessToken;
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#timeoutMs = timeoutMs;
  }

  async #request(path, { method = "GET", query, body } = {}) {
    const url = new URL(`${this.#baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, stringifyQueryValue(value));
      }
    }
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          "Access-Token": this.#accessToken,
          "Content-Type": "application/json"
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs)
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

  /**
   * Reads the immutable account context needed to interpret money and dates.
   * The official v1.3 endpoint accepts advertiser_ids and fields as JSON arrays
   * in the query string and returns matching accounts in data.list.
   */
  async getAdvertiserInfo({ advertiserId } = {}) {
    const requestedAdvertiserId = requestIdValue(advertiserId, "advertiserId");
    const payload = await this.#request("/advertiser/info/", {
      query: {
        advertiser_ids: [requestedAdvertiserId],
        fields: ADVERTISER_INFO_FIELDS
      }
    });
    const code = "TIKTOK_MALFORMED_ADVERTISER_INFO";

    if (!isRecord(payload.data) || !Array.isArray(payload.data.list)) {
      throw malformedReadResponse(code, "TikTok advertiser info omitted data.list", payload);
    }
    if (payload.data.list.length !== 1 || !isRecord(payload.data.list[0])) {
      throw malformedReadResponse(
        code,
        "TikTok advertiser info did not return exactly one account",
        payload
      );
    }

    const account = payload.data.list[0];
    if (
      typeof account.advertiser_id !== "string"
      || account.advertiser_id === ""
      || account.advertiser_id.trim() !== account.advertiser_id
    ) {
      throw malformedReadResponse(code, "TikTok advertiser info returned an invalid advertiser_id", payload);
    }
    if (account.advertiser_id !== requestedAdvertiserId) {
      throw malformedReadResponse(code, "TikTok advertiser info returned a different advertiser_id", payload);
    }
    if (typeof account.currency !== "string" || !/^[A-Z]{3}$/.test(account.currency)) {
      throw malformedReadResponse(code, "TikTok advertiser info returned an invalid currency", payload);
    }
    if (
      typeof account.timezone !== "string"
      || !/^[A-Za-z0-9_+./:-]{1,100}$/.test(account.timezone)
    ) {
      throw malformedReadResponse(code, "TikTok advertiser info returned an invalid timezone", payload);
    }
    if (
      typeof account.status !== "string"
      || !/^STATUS_[A-Z0-9_]+$/.test(account.status)
    ) {
      throw malformedReadResponse(code, "TikTok advertiser info returned an invalid account status", payload);
    }

    return {
      advertiserId: account.advertiser_id,
      currency: account.currency,
      timezone: account.timezone,
      accountStatus: account.status,
      requestId: payload.request_id
    };
  }

  async getGmvMaxStores({ advertiserId } = {}) {
    const payload = await this.#request("/gmv_max/store/list/", {
      query: { advertiser_id: requestIdValue(advertiserId, "advertiserId") }
    });
    const context = {
      code: "TIKTOK_MALFORMED_STORE_LIST",
      label: "GMV Max store list",
      payload
    };
    if (!isRecord(payload.data) || !Array.isArray(payload.data.store_list)) {
      throw malformedReadResponse(
        context.code,
        "TikTok GMV Max store list omitted data.store_list",
        payload
      );
    }

    const seen = new Set();
    const stores = payload.data.store_list.map((store) => {
      if (!isRecord(store)) {
        throw malformedReadResponse(context.code, "TikTok GMV Max store list returned an invalid store", payload);
      }
      const storeId = responseId(store.store_id, "store_id", context);
      const storeAuthorizedBcId = responseId(store.store_authorized_bc_id, "store_authorized_bc_id", context);
      if (typeof store.is_gmv_max_available !== "boolean" || typeof store.is_owner_bc !== "boolean") {
        throw malformedReadResponse(
          context.code,
          "TikTok GMV Max store list omitted availability or ownership",
          payload
        );
      }
      const key = `${storeId}:${storeAuthorizedBcId}`;
      if (seen.has(key)) {
        throw malformedReadResponse(context.code, "TikTok GMV Max store list returned a duplicate store binding", payload);
      }
      seen.add(key);

      let storeAuthorizedBcInfo = null;
      if (store.store_authorized_bc_info != null) {
        if (!isRecord(store.store_authorized_bc_info)) {
          throw malformedReadResponse(context.code, "TikTok GMV Max store list returned invalid Business Center info", payload);
        }
        const bcId = responseId(store.store_authorized_bc_info.bc_id, "store_authorized_bc_info.bc_id", context);
        if (bcId !== storeAuthorizedBcId) {
          throw malformedReadResponse(context.code, "TikTok GMV Max store list returned mismatched Business Center IDs", payload);
        }
        storeAuthorizedBcInfo = {
          bcId,
          bcName: store.store_authorized_bc_info.bc_name ?? null,
          userRole: store.store_authorized_bc_info.user_role ?? null,
          raw: store.store_authorized_bc_info
        };
      }

      let exclusiveAuthorizedAdvertiserInfo = null;
      if (store.exclusive_authorized_advertiser_info != null) {
        const info = store.exclusive_authorized_advertiser_info;
        if (!isRecord(info)) {
          throw malformedReadResponse(context.code, "TikTok GMV Max store list returned invalid exclusive authorization", payload);
        }
        if (typeof info.authorization_status !== "string" || info.authorization_status === "") {
          throw malformedReadResponse(
            context.code,
            "TikTok GMV Max store list omitted exclusive authorization status",
            payload
          );
        }
        const exclusiveStoreId = responseId(info.store_id, "exclusive_authorized_advertiser_info.store_id", context);
        if (exclusiveStoreId !== storeId) {
          throw malformedReadResponse(context.code, "TikTok GMV Max store list returned mismatched exclusive authorization", payload);
        }
        const exclusiveAdvertiserId = optionalResponseId(
          info.advertiser_id,
          "exclusive_authorized_advertiser_info.advertiser_id",
          context
        );
        if (info.authorization_status === "EFFECTIVE" && exclusiveAdvertiserId == null) {
          throw malformedReadResponse(
            context.code,
            "TikTok GMV Max effective exclusive authorization omitted advertiser_id",
            payload
          );
        }
        exclusiveAuthorizedAdvertiserInfo = {
          advertiserId: exclusiveAdvertiserId,
          storeId: exclusiveStoreId,
          identityId: optionalResponseId(
            info.identity_id,
            "exclusive_authorized_advertiser_info.identity_id",
            context
          ),
          advertiserName: info.advertiser_name ?? null,
          advertiserStatus: info.advertiser_status ?? null,
          authorizationStatus: info.authorization_status,
          raw: info
        };
      }

      return {
        storeId,
        storeAuthorizedBcId,
        isGmvMaxAvailable: store.is_gmv_max_available,
        isOwnerBc: store.is_owner_bc,
        storeName: store.store_name ?? null,
        storeCode: store.store_code ?? null,
        storeStatus: store.store_status ?? null,
        storeAuthorizedBcInfo,
        exclusiveAuthorizedAdvertiserInfo,
        raw: store
      };
    });

    return { stores, requestId: payload.request_id };
  }

  async getGmvMaxIdentities({ advertiserId, storeId, storeAuthorizedBcId } = {}) {
    const requestedStoreId = requestIdValue(storeId, "storeId");
    const payload = await this.#request("/gmv_max/identity/get/", {
      query: {
        advertiser_id: requestIdValue(advertiserId, "advertiserId"),
        store_id: requestedStoreId,
        store_authorized_bc_id: requestIdValue(storeAuthorizedBcId, "storeAuthorizedBcId")
      }
    });
    const context = {
      code: "TIKTOK_MALFORMED_IDENTITY_LIST",
      label: "GMV Max identity list",
      payload
    };
    if (!isRecord(payload.data) || !Array.isArray(payload.data.identity_list)) {
      throw malformedReadResponse(
        context.code,
        "TikTok GMV Max identity list omitted data.identity_list",
        payload
      );
    }

    const supportedIdentityTypes = new Set(["TT_USER", "BC_AUTH_TT", "TTS_TT"]);
    const seen = new Set();
    const identities = payload.data.identity_list.map((identity) => {
      if (!isRecord(identity)) {
        throw malformedReadResponse(context.code, "TikTok GMV Max identity list returned an invalid identity", payload);
      }
      const identityId = responseId(identity.identity_id, "identity_id", context);
      if (typeof identity.identity_type !== "string" || !supportedIdentityTypes.has(identity.identity_type)) {
        throw malformedReadResponse(context.code, "TikTok GMV Max identity list returned an invalid identity_type", payload);
      }
      if (typeof identity.live_gmv_max_available !== "boolean") {
        throw malformedReadResponse(context.code, "TikTok GMV Max identity list omitted live_gmv_max_available", payload);
      }
      if (
        identity.product_gmv_max_available != null
        && typeof identity.product_gmv_max_available !== "boolean"
      ) {
        throw malformedReadResponse(context.code, "TikTok GMV Max identity list returned invalid product availability", payload);
      }
      if (
        identity.is_running_custom_shop_ads != null
        && typeof identity.is_running_custom_shop_ads !== "boolean"
      ) {
        throw malformedReadResponse(context.code, "TikTok GMV Max identity list returned invalid Shopping Ads occupancy", payload);
      }

      const identityAuthorizedBcId = optionalResponseId(
        identity.identity_authorized_bc_id,
        "identity_authorized_bc_id",
        context
      );
      const identityAuthorizedShopId = optionalResponseId(
        identity.identity_authorized_shop_id,
        "identity_authorized_shop_id",
        context
      );
      const identityStoreId = optionalResponseId(identity.store_id, "store_id", context);
      if (identity.identity_type === "BC_AUTH_TT" && identityAuthorizedBcId == null) {
        throw malformedReadResponse(context.code, "TikTok GMV Max BC identity omitted identity_authorized_bc_id", payload);
      }
      if (identity.identity_type === "TTS_TT" && identityStoreId == null) {
        throw malformedReadResponse(context.code, "TikTok GMV Max Shop identity omitted store_id", payload);
      }
      if (identityStoreId != null && identityStoreId !== requestedStoreId) {
        throw malformedReadResponse(context.code, "TikTok GMV Max identity list returned an identity for another store", payload);
      }
      if (!identity.live_gmv_max_available) {
        if (typeof identity.unavailable_reason !== "string" || identity.unavailable_reason === "") {
          throw malformedReadResponse(context.code, "TikTok GMV Max unavailable identity omitted unavailable_reason", payload);
        }
      } else if (identity.unavailable_reason != null) {
        throw malformedReadResponse(context.code, "TikTok GMV Max available identity returned unavailable_reason", payload);
      }

      const key = [
        identity.identity_type,
        identityId,
        identityAuthorizedBcId ?? "",
        identityAuthorizedShopId ?? "",
        identityStoreId ?? ""
      ].join(":");
      if (seen.has(key)) {
        throw malformedReadResponse(context.code, "TikTok GMV Max identity list returned a duplicate identity", payload);
      }
      seen.add(key);

      return {
        identityId,
        identityType: identity.identity_type,
        identityAuthorizedBcId,
        identityAuthorizedShopId,
        storeId: identityStoreId,
        liveGmvMaxAvailable: identity.live_gmv_max_available,
        productGmvMaxAvailable: identity.product_gmv_max_available ?? null,
        isRunningCustomShopAds: identity.is_running_custom_shop_ads ?? null,
        availableStatus: identity.available_status ?? null,
        unavailableReason: identity.unavailable_reason ?? null,
        displayName: identity.display_name ?? null,
        userName: identity.user_name ?? null,
        raw: identity
      };
    });

    return { identities, requestId: payload.request_id };
  }

  async getGmvMaxBidRecommendation({
    advertiserId,
    storeId,
    identityId,
    shoppingAdsType = "LIVE",
    optimizationGoal = "VALUE",
    itemGroupIds
  } = {}) {
    if (shoppingAdsType !== "LIVE" && shoppingAdsType !== "PRODUCT") {
      throw new Error("shoppingAdsType must be LIVE or PRODUCT");
    }
    if (optimizationGoal !== "VALUE") throw new Error("optimizationGoal must be VALUE");
    if (shoppingAdsType === "LIVE" && !identityId) {
      throw new Error("identityId is required for a LIVE GMV Max recommendation");
    }
    if (shoppingAdsType === "LIVE" && itemGroupIds?.length) {
      throw new Error("itemGroupIds are not valid for a LIVE GMV Max recommendation");
    }
    if (itemGroupIds != null && (!Array.isArray(itemGroupIds) || itemGroupIds.length > 50)) {
      throw new Error("itemGroupIds must contain at most 50 IDs");
    }

    const payload = await this.#request("/gmv_max/bid/recommend/", {
      query: {
        advertiser_id: requestIdValue(advertiserId, "advertiserId"),
        store_id: requestIdValue(storeId, "storeId"),
        shopping_ads_type: shoppingAdsType,
        optimization_goal: optimizationGoal,
        identity_id: identityId == null ? undefined : requestIdValue(identityId, "identityId"),
        item_group_ids: itemGroupIds?.map((itemGroupId) => requestIdValue(itemGroupId, "itemGroupId"))
      }
    });
    const context = {
      code: "TIKTOK_MALFORMED_BID_RECOMMENDATION",
      label: "GMV Max bid recommendation",
      payload
    };
    if (!isRecord(payload.data)) {
      throw malformedReadResponse(context.code, "TikTok GMV Max bid recommendation omitted data", payload);
    }
    const roasBid = Number(payload.data.roas_bid);
    const budget = Number(payload.data.budget);
    if (!Number.isFinite(roasBid) || roasBid <= 0 || !Number.isFinite(budget) || budget <= 0) {
      throw malformedReadResponse(
        context.code,
        "TikTok GMV Max bid recommendation returned an invalid ROI target or budget",
        payload
      );
    }
    return { roasBid, budget, requestId: payload.request_id, raw: payload.data };
  }

  async getLiveCampaigns({
    advertiserId,
    storeId,
    campaignIds,
    maxResults = GMV_MAX_CAMPAIGN_MAX_RESULTS
  } = {}) {
    if (
      !Number.isSafeInteger(maxResults)
      || maxResults < 1
      || maxResults > GMV_MAX_CAMPAIGN_MAX_RESULTS
    ) {
      throw new Error(`maxResults must be an integer between 1 and ${GMV_MAX_CAMPAIGN_MAX_RESULTS}`);
    }
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
          page_size: Math.min(GMV_MAX_CAMPAIGN_PAGE_SIZE, maxResults)
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
      if (totalNumber > maxResults) {
        throw new TikTokApiError(
          `TikTok GMV Max campaign candidates exceeded the read-only limit of ${maxResults}`,
          {
            code: "TIKTOK_CAMPAIGN_CANDIDATE_LIMIT",
            requestId: payload.request_id,
            outcomeKnown: true
          }
        );
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
