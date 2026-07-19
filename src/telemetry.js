import crypto from "node:crypto";

const MAX_TEXT_LENGTH = 200;
const MAX_MONEY_MINOR = 100_000_000_000;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const CREDENTIAL_ID = /^tc_[A-Za-z0-9_-]{16,80}$/;
const SNAPSHOT_ID = /^ts_[A-Za-z0-9_-]{16,80}$/;
const TIKTOK_ID = /^\d{6,32}$/;

// The collector must hash this exact semantic-to-visible-header map. A TikTok
// table/header change therefore fails closed instead of silently moving spend
// or budget values into the wrong field.
export const TELEMETRY_UI_SCHEMA_V1 = Object.freeze({
  campaignName: "Campaign name",
  campaignStatus: "Status",
  tiktokAccountId: "Available TikTok accounts",
  dailyBudgetMinor: "Target ROI / budget > Daily budget",
  costMinor: "Cost",
  totalBudgetMinor: "Total budget",
  netCostMinor: "Net Cost"
});

export const TELEMETRY_UI_SCHEMA_FINGERPRINT_V1 = crypto
  .createHash("sha256")
  .update(JSON.stringify(TELEMETRY_UI_SCHEMA_V1), "utf8")
  .digest("hex");

export class TelemetryError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "TelemetryError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options) {
  throw new TelemetryError(code, message, options);
}

function requiredExactString(value, field, { maxLength = MAX_TEXT_LENGTH, pattern } = {}) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("INVALID_TELEMETRY_SNAPSHOT", `${field} must be a non-empty exact string`, {
      details: { field }
    });
  }
  if (value.length > maxLength || (pattern && !pattern.test(value))) {
    fail("INVALID_TELEMETRY_SNAPSHOT", `${field} has an invalid format`, {
      details: { field }
    });
  }
  return value;
}

function moneyMinor(value, field, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (positive && value === 0) ||
    value > MAX_MONEY_MINOR
  ) {
    fail(
      "INVALID_TELEMETRY_SNAPSHOT",
      `${field} must be a ${positive ? "positive" : "non-negative"} safe integer in minor currency units`,
      { details: { field } }
    );
  }
  return value;
}

function normalizeIsoTimestamp(value, field) {
  if (typeof value !== "string" || value.length > 40 || value !== value.trim()) {
    fail("INVALID_TELEMETRY_SNAPSHOT", `${field} must be an ISO-8601 timestamp`, {
      details: { field }
    });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail("INVALID_TELEMETRY_SNAPSHOT", `${field} must be an ISO-8601 timestamp`, {
      details: { field }
    });
  }
  return new Date(milliseconds).toISOString();
}

function exactObject(value, field, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TELEMETRY_SNAPSHOT", `${field} must be an object`, {
      details: { field }
    });
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    fail("INVALID_TELEMETRY_SNAPSHOT", `${field} contains unsupported fields`, {
      details: { field, unsupportedFields: unknown }
    });
  }
}

function configuredTelemetryClient(config, clientId) {
  const client = config?.clients?.find((candidate) => candidate.id === clientId);
  if (!client || client.telemetry?.source !== "chrome-ui") {
    fail("TELEMETRY_BINDING_MISMATCH", "Snapshot is not bound to an enabled telemetry client", {
      status: 403
    });
  }
  return client;
}

/**
 * Validates and normalizes the only payload accepted from the read-only Chrome
 * collector. Monetary values are integers in satang to avoid floating-point
 * ambiguity. No field in this payload grants mutation authority.
 */
export function validateTelemetrySnapshot(input, {
  config,
  credential,
  now = new Date(),
  maxFutureSkewSeconds = 60
} = {}) {
  exactObject(input, "snapshot", [
    "schemaVersion",
    "uiSchemaFingerprint",
    "snapshotId",
    "clientId",
    "advertiserId",
    "businessCenterId",
    "sellerMode",
    "pageType",
    "tiktokAccountId",
    "campaignId",
    "campaignRef",
    "campaignName",
    "campaignType",
    "campaignStatus",
    "currency",
    "dailyBudgetMinor",
    "totalBudgetMinor",
    "costMinor",
    "netCostMinor",
    "observedAt",
    "source"
  ]);
  if (input.schemaVersion !== 1) {
    fail("UNSUPPORTED_TELEMETRY_SCHEMA", "schemaVersion must be 1");
  }
  if (input.uiSchemaFingerprint !== TELEMETRY_UI_SCHEMA_FINGERPRINT_V1) {
    fail(
      "TELEMETRY_UI_SCHEMA_MISMATCH",
      "TikTok UI header mapping does not match the approved telemetry schema"
    );
  }

  const snapshotId = requiredExactString(input.snapshotId, "snapshotId", {
    maxLength: 83,
    pattern: SNAPSHOT_ID
  });
  const clientId = requiredExactString(input.clientId, "clientId", { maxLength: 128 });
  const client = configuredTelemetryClient(config, clientId);
  if (!credential || credential.clientId !== clientId || credential.revokedAt !== null) {
    fail("TELEMETRY_BINDING_MISMATCH", "Credential is not active for this client", { status: 403 });
  }

  const advertiserId = requiredExactString(input.advertiserId, "advertiserId", {
    maxLength: 32,
    pattern: TIKTOK_ID
  });
  if (advertiserId !== client.advertiserId) {
    fail("TELEMETRY_BINDING_MISMATCH", "advertiserId does not match the enrolled client", {
      status: 403
    });
  }

  const businessCenterId = requiredExactString(input.businessCenterId, "businessCenterId", {
    maxLength: 32,
    pattern: TIKTOK_ID
  });
  if (
    businessCenterId !== client.telemetry.businessCenterId ||
    businessCenterId !== credential.businessCenterId
  ) {
    fail("TELEMETRY_BINDING_MISMATCH", "businessCenterId does not match enrollment", {
      status: 403
    });
  }
  if (
    input.sellerMode !== client.telemetry.sellerMode ||
    input.sellerMode !== credential.sellerMode
  ) {
    fail("TELEMETRY_BINDING_MISMATCH", "sellerMode does not match enrollment", { status: 403 });
  }
  if (
    input.pageType !== client.telemetry.pageType ||
    input.pageType !== credential.pageType
  ) {
    fail("TELEMETRY_BINDING_MISMATCH", "pageType does not match enrollment", { status: 403 });
  }

  const tiktokAccountId = requiredExactString(input.tiktokAccountId, "tiktokAccountId", {
    maxLength: 32,
    pattern: TIKTOK_ID
  });
  if (
    client.campaignSelector?.expectedTikTokAccountId &&
    tiktokAccountId !== client.campaignSelector.expectedTikTokAccountId
  ) {
    fail("TELEMETRY_BINDING_MISMATCH", "tiktokAccountId does not match the approved selector", {
      status: 403
    });
  }

  const campaignName = requiredExactString(input.campaignName, "campaignName");
  let campaignId = null;
  let configuredCampaign;
  let expectedCampaignRef;
  if (client.campaignSelector) {
    if (input.campaignId !== undefined && input.campaignId !== null) {
      fail(
        "TELEMETRY_BINDING_MISMATCH",
        "campaignId must be null when the Chrome UI does not expose a campaign ID",
        { status: 403 }
      );
    }
    expectedCampaignRef = telemetryUiCampaignRef({ advertiserId, campaignName });
  } else {
    campaignId = requiredExactString(input.campaignId, "campaignId", { maxLength: 128 });
    configuredCampaign = client.campaigns?.find((campaign) => campaign.id === campaignId);
    if (!configuredCampaign || campaignName !== configuredCampaign.name) {
      fail("TELEMETRY_BINDING_MISMATCH", "campaign identity is not approved for this client", {
        status: 403
      });
    }
    expectedCampaignRef = `id:${campaignId}`;
  }
  const campaignRef = requiredExactString(input.campaignRef, "campaignRef", { maxLength: 131 });
  if (campaignRef !== expectedCampaignRef) {
    fail("TELEMETRY_BINDING_MISMATCH", "campaignRef does not match the observed campaign identity", {
      status: 403
    });
  }
  if (input.campaignType !== "LIVE_GMV_MAX") {
    fail("TELEMETRY_BINDING_MISMATCH", "campaignType must be LIVE_GMV_MAX", { status: 403 });
  }
  if (input.campaignStatus !== "ACTIVE") {
    fail("TELEMETRY_BINDING_MISMATCH", "campaignStatus must be ACTIVE", { status: 403 });
  }

  const currency = requiredExactString(input.currency, "currency", { maxLength: 3 }).toUpperCase();
  const expectedCurrency = configuredCampaign?.currency ?? client.campaignSelector?.currency;
  if (currency !== "THB" || currency !== expectedCurrency) {
    fail("TELEMETRY_BINDING_MISMATCH", "currency does not match the approved campaign", {
      status: 403
    });
  }

  exactObject(input.source, "source", ["browserProfile", "tabGroup"]);
  const browserProfile = requiredExactString(input.source.browserProfile, "source.browserProfile");
  const tabGroup = requiredExactString(input.source.tabGroup, "source.tabGroup");
  if (
    browserProfile !== client.telemetry.browserProfile ||
    tabGroup !== client.telemetry.tabGroup ||
    browserProfile !== credential.browserProfile ||
    tabGroup !== credential.tabGroup
  ) {
    fail("TELEMETRY_BINDING_MISMATCH", "Chrome profile or tab group does not match enrollment", {
      status: 403
    });
  }

  const observedAt = normalizeIsoTimestamp(input.observedAt, "observedAt");
  const nowMilliseconds = new Date(now).getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new TypeError("now must be a valid date");
  const observedMilliseconds = Date.parse(observedAt);
  const maxAgeSeconds = client.telemetry.maxSnapshotAgeSeconds;
  if (observedMilliseconds > nowMilliseconds + maxFutureSkewSeconds * 1000) {
    fail("TELEMETRY_TIMESTAMP_OUT_OF_RANGE", "observedAt is too far in the future");
  }
  if (observedMilliseconds < nowMilliseconds - maxAgeSeconds * 1000) {
    fail("TELEMETRY_TIMESTAMP_OUT_OF_RANGE", "observedAt is too old");
  }

  const dailyBudgetMinor = moneyMinor(input.dailyBudgetMinor, "dailyBudgetMinor", { positive: true });
  const totalBudgetMinor = moneyMinor(input.totalBudgetMinor, "totalBudgetMinor", { positive: true });
  const costMinor = moneyMinor(input.costMinor, "costMinor");
  const netCostMinor = moneyMinor(input.netCostMinor, "netCostMinor");
  const policyCapMinor = client.budgetPolicy == null
    ? Math.round(configuredCampaign.maxDailyBudget * 100)
    : Math.round(client.budgetPolicy.maxDailyBudget * 100);

  return Object.freeze({
    schemaVersion: 1,
    uiSchemaFingerprint: TELEMETRY_UI_SCHEMA_FINGERPRINT_V1,
    snapshotId,
    clientId,
    advertiserId,
    businessCenterId,
    sellerMode: input.sellerMode,
    pageType: input.pageType,
    tiktokAccountId,
    campaignId,
    campaignRef,
    campaignName,
    campaignType: "LIVE_GMV_MAX",
    campaignStatus: "ACTIVE",
    currency,
    dailyBudgetMinor,
    totalBudgetMinor,
    costMinor,
    netCostMinor,
    observedAt,
    source: Object.freeze({ browserProfile, tabGroup }),
    policy: Object.freeze({
      maxDailyBudgetMinor: policyCapMinor,
      overDailyBudgetCap: dailyBudgetMinor > policyCapMinor
    })
  });
}

export function telemetryUiCampaignRef({ advertiserId, campaignName } = {}) {
  if (typeof advertiserId !== "string" || typeof campaignName !== "string") {
    throw new TypeError("advertiserId and campaignName must be strings");
  }
  const digest = crypto
    .createHash("sha256")
    .update(advertiserId, "utf8")
    .update("\0", "utf8")
    .update(campaignName, "utf8")
    .digest("hex");
  return `ui:${digest}`;
}

export function validateTelemetryPublicKeyJwk(value) {
  try {
    exactObject(value, "publicKeyJwk", ["kty", "crv", "x", "y", "ext", "key_ops"]);
  } catch {
    fail("INVALID_TELEMETRY_PUBLIC_KEY", "publicKeyJwk must be a P-256 verification key");
  }
  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    !BASE64URL_32_BYTES.test(value.x ?? "") ||
    !BASE64URL_32_BYTES.test(value.y ?? "") ||
    (value.ext !== undefined && value.ext !== true) ||
    (value.key_ops !== undefined && (
      !Array.isArray(value.key_ops) ||
      value.key_ops.some((operation) => operation !== "verify")
    ))
  ) {
    fail("INVALID_TELEMETRY_PUBLIC_KEY", "publicKeyJwk must be a P-256 verification key");
  }
  const normalized = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: value.x,
    y: value.y,
    ext: true,
    key_ops: Object.freeze(["verify"])
  });
  try {
    crypto.createPublicKey({ key: { ...normalized, key_ops: ["verify"] }, format: "jwk" });
  } catch {
    fail("INVALID_TELEMETRY_PUBLIC_KEY", "publicKeyJwk is not a valid P-256 point");
  }
  return normalized;
}

export function validateTelemetryEnrollmentRequest(input) {
  exactObject(input, "enrollment", ["clientId", "enrollmentCode", "installationId", "publicKeyJwk"]);
  const clientId = requiredExactString(input.clientId, "clientId", { maxLength: 128 });
  const enrollmentCode = requiredExactString(input.enrollmentCode, "enrollmentCode", {
    maxLength: 43,
    pattern: BASE64URL_32_BYTES
  });
  const installationId = requiredExactString(input.installationId, "installationId", {
    maxLength: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{15,127}$/
  });
  return Object.freeze({
    clientId,
    enrollmentCode,
    installationId,
    publicKeyJwk: validateTelemetryPublicKeyJwk(input.publicKeyJwk)
  });
}

export function telemetryEnrollmentCodeHash(code) {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

export function telemetrySigningMessage({ credentialId, timestamp, nonce, rawBody }) {
  if (!CREDENTIAL_ID.test(credentialId ?? "")) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry credential is invalid", { status: 401 });
  }
  if (typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp)) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry timestamp is invalid", { status: 401 });
  }
  if (!BASE64URL_NONCE.test(nonce ?? "")) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry nonce is invalid", { status: 401 });
  }
  if (!Buffer.isBuffer(rawBody)) {
    throw new TypeError("rawBody must be a Buffer");
  }
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  return Buffer.from(`v1\n${credentialId}\n${timestamp}\n${nonce}\n${bodyHash}`, "utf8");
}

export function verifyTelemetryRequest({
  rawBody,
  headers,
  credential,
  now = new Date(),
  maxClockSkewSeconds = 300
} = {}) {
  const credentialId = headers?.["x-wb-telemetry-credential"];
  const timestamp = headers?.["x-wb-telemetry-timestamp"];
  const nonce = headers?.["x-wb-telemetry-nonce"];
  const signatureHeader = headers?.["x-wb-telemetry-signature"];
  if (
    typeof credentialId !== "string" ||
    credential?.credentialId !== credentialId ||
    credential.revokedAt !== null ||
    typeof signatureHeader !== "string" ||
    !signatureHeader.startsWith("v1=")
  ) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry authentication failed", { status: 401 });
  }
  const seconds = Number(timestamp);
  const nowSeconds = Math.floor(new Date(now).getTime() / 1000);
  if (!/^\d{10}$/.test(timestamp ?? "") || !Number.isSafeInteger(seconds) || Math.abs(nowSeconds - seconds) > maxClockSkewSeconds) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry authentication failed", { status: 401 });
  }
  const message = telemetrySigningMessage({ credentialId, timestamp, nonce, rawBody });
  const signatureText = signatureHeader.slice(3);
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureText)) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry authentication failed", { status: 401 });
  }
  const signature = Buffer.from(signatureText, "base64url");
  if (signature.length !== 64) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry authentication failed", { status: 401 });
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: credential.publicKeyJwk, format: "jwk" });
  } catch {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry authentication failed", { status: 401 });
  }
  const valid = crypto.verify("sha256", message, {
    key: publicKey,
    dsaEncoding: "ieee-p1363"
  }, signature);
  if (!valid) {
    fail("INVALID_TELEMETRY_AUTH", "Telemetry authentication failed", { status: 401 });
  }
  return Object.freeze({ credentialId, timestamp, nonce });
}

export function telemetryCredentialIdFromHeaders(headers) {
  const credentialId = headers?.["x-wb-telemetry-credential"];
  return typeof credentialId === "string" && CREDENTIAL_ID.test(credentialId)
    ? credentialId
    : null;
}

export function telemetryPayloadHash(rawBody) {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}
