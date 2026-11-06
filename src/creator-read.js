// Read-only Ppan bridge. This module has no TikTok token or mutation endpoint.
export const CREATOR_READ_URL = "https://gmv-max-report-production-3251.up.railway.app/internal/creator/punpan_020/snapshot";
export const CREATOR_BINDING = Object.freeze({
  advertiserId: "7666005333864644624",
  tiktokAccountId: "7285935731820920833",
  identityId: "9acd400c-e18e-5ad2-aed9-d3bac2e41d6a",
  identityType: "BC_AUTH_TT",
  identityAuthorizedBcId: "7627179356976201745"
});
const MAX_BYTES = 100_000;
const MAX_AGE_MS = 180_000;
const CLIENT_ID = "punpan_020";
const opaqueId = (value) => typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value);
const money = (value) => Number.isSafeInteger(value) && value >= 0;
function fail() { throw new Error("CREATOR_READ_RESPONSE_UNVERIFIED"); }

export function validateCreatorReadSnapshot(input, now = new Date()) {
  if (!input || input.schemaVersion !== 1 || input.clientId !== CLIENT_ID
    || input.source !== "tiktok-creator-api" || input.readOnly !== true
    || input.timezone !== "Asia/Bangkok") fail();
  if (Object.entries(CREATOR_BINDING).some(([key, value]) => input.binding?.[key] !== value)) fail();
  const observed = Date.parse(input.observedAt);
  if (!Number.isFinite(observed) || observed > new Date(now).getTime() + 30_000) fail();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reportingDate ?? "")) fail();
  if (input.capabilities?.read !== true
    || ["budgetWrite", "create", "pause", "autoOptimization"].some((key) => input.capabilities?.[key] !== false)) fail();
  const quality = input.quality;
  if (!quality || quality.spendEstimated !== true || quality.spendSource !== "TT_SHOP"
    || quality.reportLagSeconds !== null || quality.gmvAvailable !== false
    || quality.roiAvailable !== false || quality.liveViewsAvailable !== false) fail();
  let campaign = null;
  if (input.campaign !== null) {
    const value = input.campaign;
    if (!value || !opaqueId(value.campaignId) || typeof value.campaignName !== "string"
      || value.campaignName.length > 200 || value.status !== "ACTIVE" || value.operationStatus !== "ENABLE"
      || value.currency !== "THB" || !money(value.dailyBudgetMinor) || value.dailyBudgetMinor <= 0
      || !(value.spendMinor === null || money(value.spendMinor))
      || !(value.targetRoi === null || (Number.isFinite(value.targetRoi) && value.targetRoi >= 0))
      || value.gmvMinor !== null || value.roi !== null || value.liveViews !== null) fail();
    campaign = {
      campaignId: value.campaignId,
      campaignName: value.campaignName.replace(/[\u0000-\u001f\u007f]/g, ""),
      currency: "THB", dailyBudgetMinor: value.dailyBudgetMinor, spendMinor: value.spendMinor,
      targetRoi: value.targetRoi, status: "ACTIVE", operationStatus: "ENABLE"
    };
  }
  // Never retain unknown upstream fields or any upstream credential/error text.
  return Object.freeze({
    schemaVersion: 1, clientId: CLIENT_ID, source: "tiktok-creator-api", readOnly: true,
    observedAt: new Date(observed).toISOString(), reportingDate: input.reportingDate,
    timezone: "Asia/Bangkok", binding: CREATOR_BINDING,
    campaign, nativeAutoBudgetState: ["ENABLED", "DISABLED", "UNKNOWN", "CONFLICT"].includes(input.nativeAutoBudgetState)
      ? input.nativeAutoBudgetState : "UNKNOWN"
  });
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) fail();
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); fail(); }
        chunks.push(Buffer.from(item.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { reader.releaseLock(); }
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BYTES) fail();
  return JSON.parse(body);
}

export class CreatorReadProvider {
  #key;
  #fetch;
  #clock;
  #snapshot = null;
  #failed = false;
  #inFlight = null;
  constructor({ key, url = CREATOR_READ_URL, fetchImpl = globalThis.fetch, clock = () => new Date() }) {
    if (url !== CREATOR_READ_URL) throw new Error("CREATOR_READ_URL_NOT_ALLOWED");
    if (typeof key !== "string" || key.length < 43) throw new Error("CREATOR_READ_BRIDGE_KEY_REQUIRED");
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#clock = clock;
  }
  supports(clientId) { return clientId === CLIENT_ID; }
  async refresh() {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = Promise.resolve().then(async () => {
      try {
        const response = await this.#fetch(CREATOR_READ_URL, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "X-Creator-Read-Key": this.#key, Accept: "application/json" }
        });
        if (response.ok !== true) fail();
        const snapshot = validateCreatorReadSnapshot(await boundedJson(response), this.#clock());
        if (JSON.stringify(snapshot).includes(this.#key)) fail();
        this.#snapshot = snapshot;
        this.#failed = false;
        return { ok: true };
      } catch {
        this.#failed = true;
        return { ok: false, code: "CREATOR_READ_UNAVAILABLE" };
      }
    }).finally(() => { this.#inFlight = null; });
    return this.#inFlight;
  }
  getReadSnapshot(clientId) {
    if (!this.supports(clientId)) return null;
    const wire = this.#snapshot;
    const age = wire ? this.#clock().getTime() - Date.parse(wire.observedAt) : Infinity;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(this.#clock());
    const stale = this.#failed || age < -30_000 || age > MAX_AGE_MS || wire?.reportingDate !== date;
    const campaign = wire?.campaign;
    return {
      stale,
      snapshot: {
        source: "tiktok-creator-api", readOnly: true, unavailable: !wire,
        noActiveCampaign: !!wire && campaign === null,
        clientId: CLIENT_ID, advertiserId: CREATOR_BINDING.advertiserId,
        tiktokAccountId: CREATOR_BINDING.tiktokAccountId,
        observedAt: wire?.observedAt ?? null, reportingDate: wire?.reportingDate ?? null,
        campaignId: campaign?.campaignId ?? null, campaignName: campaign?.campaignName ?? null,
        campaignStatus: campaign?.status ?? null, currency: "THB",
        dailyBudgetMinor: campaign?.dailyBudgetMinor ?? null,
        costMinor: campaign?.spendMinor ?? null, targetRoi: campaign?.targetRoi ?? null,
        grossRevenueMinor: null, grossRoiMilli: null, netRevenueMinor: null,
        netRoiMilli: null, gmvMinor: null, liveViews: null,
        nativeAutoBudgetState: wire?.nativeAutoBudgetState ?? "UNKNOWN"
      }
    };
  }
  health() {
    const entry = this.getReadSnapshot(CLIENT_ID);
    return {
      enabled: true, source: "tiktok-creator-api", readOnly: true,
      status: entry.snapshot.unavailable ? "waiting-for-snapshot" : entry.stale ? "degraded" : "healthy",
      configuredClients: 1, freshClients: !entry.stale && !entry.snapshot.unavailable ? 1 : 0,
      latestObservedAt: entry.snapshot.observedAt,
      budgetWriteEnabled: false, autoOptimizationEnabled: false
    };
  }
}

export function creatorReadFromEnvironment(environment = process.env, options = {}) {
  if (!["true", "1", "yes", "on"].includes(String(environment.CREATOR_READ_ENABLED ?? "").toLowerCase())) return null;
  return new CreatorReadProvider({
    key: environment.CREATOR_READ_BRIDGE_KEY,
    url: environment.CREATOR_READ_URL,
    ...options
  });
}
