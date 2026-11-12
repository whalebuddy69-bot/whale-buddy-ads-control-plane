import { createHash, timingSafeEqual } from "node:crypto";
import {
  ASHOPBYTHETA_CREATOR_POLICY_CLIENT, BOOMKAN_CREATOR_POLICY_CLIENT, BUBPA_SHOP189_CREATOR_POLICY_CLIENT, CREATOR_POLICY_DEFAULTS,
  EXTRA_CREATOR_WEB_POLICY_CLIENTS, KOOLKOOL888_CREATOR_POLICY_CLIENT, MYUSHOP4_CREATOR_POLICY_CLIENT,
  NNSHOP5719_CREATOR_POLICY_CLIENT, SRIHIW_CREATOR_POLICY_CLIENT,
} from "./creator-policy.js";
import { parseCreatorCheckFailureAlert, parseCreatorWebAutoBudget, validCreatorLineRecipient } from "./creator-web-auto-line.js";

const CLIENT_ID = CREATOR_POLICY_DEFAULTS.clientId;
// No arbitrary caller-provided slug resolves to a policy. The legacy Ppan URL
// is retained and every additional scope is a literal reviewed allowlist entry.
const PATHS = new Map([["ppan", CLIENT_ID], ...EXTRA_CREATOR_WEB_POLICY_CLIENTS.map(clientId => [clientId, clientId])]
  .flatMap(([slug, clientId]) => {
    const root = `/internal/automation/${slug}/policy`;
    return [[root, { clientId, action: "read" }], ...["cap", "lease", "finish", "check-failure-alert"].map(action => [`${root}/${action}`, { clientId, action }])];
  }));
const KEY = /^[A-Za-z0-9_-]{43,128}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LINE_RESULT_PATH = /^\/internal\/automation\/([a-z0-9_]+)\/policy\/line-result\/([^/]+)$/;
const LINE_RESULT_SCOPES = new Map([["ppan", CLIENT_ID], [ASHOPBYTHETA_CREATOR_POLICY_CLIENT, ASHOPBYTHETA_CREATOR_POLICY_CLIENT],
  [MYUSHOP4_CREATOR_POLICY_CLIENT, MYUSHOP4_CREATOR_POLICY_CLIENT], [BUBPA_SHOP189_CREATOR_POLICY_CLIENT, BUBPA_SHOP189_CREATOR_POLICY_CLIENT],
  [KOOLKOOL888_CREATOR_POLICY_CLIENT, KOOLKOOL888_CREATOR_POLICY_CLIENT], [BOOMKAN_CREATOR_POLICY_CLIENT, BOOMKAN_CREATOR_POLICY_CLIENT]]);
const SRIHIW_LINE_OWNER_PATH = "/internal/automation/srihiw/policy/line-owner-binding";
const BUBPA_RECOVERY_PATH = "/internal/automation/bubpa_shop189/policy/recover-unknown";
const CAMPAIGN_ID = /^[1-9][0-9]{9,24}$/;
const AUTO_LINE_RESULT_STATUSES = new Set(["PENDING", "ACCEPTED", "UNCONFIRMED", "UNKNOWN"]);
const CHECK_FAILURE_STATES = new Set(["PENDING", "ACCEPTED", "UNCONFIRMED", "EXPIRED"]);
const OUTCOMES = new Set(["NOT_SENT", "PROVIDER_REJECTED", "APPLIED_VERIFIED", "OUTCOME_UNKNOWN"]);
const CONFLICTS = new Set([
  "CREATOR_WEB_POLICY_CHANGED", "CREATOR_WEB_POLICY_LOCKED", "CREATOR_WEB_LEASE_EXPIRED",
  "CREATOR_WEB_LEASE_CONFLICT", "CREATOR_WEB_LEASE_NOT_FOUND", "CREATOR_WEB_AUTO_LINE_NOT_READY", "POLICY_CHANGED", "POLICY_LOCKED",
  "CREATOR_WEB_CHECK_FAILURE_CONFLICT", "CREATOR_WEB_RECOVERY_CONFLICT", "CREATOR_WEB_LEASE_QUARANTINED", "CREATOR_WEB_CAMPAIGN_RESTRICTED"
]);
const MAX_BODY_BYTES = 512;
const digest = (value) => createHash("sha256").update(value).digest();
const validKey = (value) => typeof value === "string" && value === value.trim() && KEY.test(value);

function scopeFor(pathname) {
  if (typeof pathname !== "string") return undefined;
  if (pathname === BUBPA_RECOVERY_PATH) return { clientId: BUBPA_SHOP189_CREATOR_POLICY_CLIENT, action: "recover-unknown" };
  if (pathname === SRIHIW_LINE_OWNER_PATH) return { clientId: SRIHIW_CREATOR_POLICY_CLIENT, action: "line-owner-binding" };
  const result = LINE_RESULT_PATH.exec(pathname);
  if (result && OPERATION_ID.test(result[2])) {
    const clientId = LINE_RESULT_SCOPES.get(result[1]);
    if (clientId) return { clientId, action: "line-result", operationId: result[2] };
  }
  return PATHS.get(pathname);
}
export const isCreatorWebPolicyPath = (pathname) => !!scopeFor(pathname);

export function resolveCreatorWebPolicyOptions(env, { controlPlaneOnly, creatorReadEnabled } = {}) {
  const value = env?.CREATOR_WEB_POLICY_BRIDGE_KEY;
  // Optional and fail-closed. No existing service secret may be reused for this boundary.
  const otherKeys = [env?.ADMIN_API_KEY, env?.CREATOR_READ_BRIDGE_KEY, env?.CREATOR_BUDGET_TEST_KEY,
    env?.LINE_CHANNEL_SECRET, env?.LINE_CHANNEL_ACCESS_TOKEN, env?.TIKTOK_ACCESS_TOKEN];
  const key = controlPlaneOnly === true && creatorReadEnabled === true
    && validKey(value) && !otherKeys.includes(value) ? value : null;
  return { key, leaseEnabled: key !== null && env?.CREATOR_WEB_POLICY_LEASE_ENABLED === "true",
    srihiwLeaseEnabled: key !== null && env?.CREATOR_WEB_SRIHIW_BUDGET_LEASE_ENABLED === "true",
    nnshop5719LeaseEnabled: key !== null && env?.CREATOR_WEB_NNSHOP5719_BUDGET_LEASE_ENABLED === "true",
    ashopbythetaLeaseEnabled: key !== null && env?.CREATOR_WEB_ASHOPBYTHETA_BUDGET_LEASE_ENABLED === "true",
    myushop4LeaseEnabled: key !== null && env?.CREATOR_WEB_MYUSHOP4_BUDGET_LEASE_ENABLED === "true",
    bubpaShop189LeaseEnabled: key !== null && env?.CREATOR_WEB_BUBPA_SHOP189_BUDGET_LEASE_ENABLED === "true",
    koolkool888LeaseEnabled: key !== null && env?.CREATOR_WEB_KOOLKOOL888_BUDGET_LEASE_ENABLED === "true",
    boomkanLeaseEnabled: key !== null && env?.CREATOR_WEB_BOOMKAN_BUDGET_LEASE_ENABLED === "true",
    bubpaShop189RecoveryEnabled: key !== null && env?.CREATOR_WEB_BUBPA_SHOP189_RECOVERY_ENABLED === "true",
    capWriteEnabled: key !== null && env?.CREATOR_WEB_POLICY_CAP_WRITE_ENABLED === "true" };
}

function write(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers
  });
  response.end(JSON.stringify(body));
}

function fail(response, status, code, headers) {
  return write(response, status, { error: { code } }, headers);
}

function browserRequest(headers) {
  // Node/Undici adds sec-fetch-mode itself; it is not a browser signal alone.
  return Object.keys(headers ?? {}).some((key) => key === "origin" || key === "referer" || key === "cookie"
    || ["sec-fetch-site", "sec-fetch-dest", "sec-fetch-user"].includes(key) || key.startsWith("access-control-request-"));
}

async function body(request) {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    return { status: 413, code: "BODY_TOO_LARGE" };
  }
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers["content-type"] ?? "")
    || (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity")) {
    return { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" };
  }
  let size = 0;
  const chunks = [];
  const stream = typeof request.iterator === "function" ? request.iterator({ destroyOnReturn: false }) : request;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) return { status: 413, code: "BODY_TOO_LARGE" };
    chunks.push(buffer);
  }
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return { payload };
  } catch { /* Invalid JSON is never echoed. */ }
  return { status: 400, code: "INVALID_REQUEST" };
}

function validPositive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function payloadOf(result, now, clientId = CLIENT_ID) {
  const p = result?.policy;
  if (!p || p.clientId !== clientId || !validPositive(p.revision) || !validPositive(p.campaignCapMinor)
    || !validPositive(p.clientDailyCapMinor) || typeof result.locked !== "boolean") return null;
  return { schemaVersion: 1, clientId, revision: p.revision,
    campaignCapMinor: p.campaignCapMinor, clientDailyCapMinor: p.clientDailyCapMinor,
    readAt: now.toISOString(), locked: result.locked,
    ...(result.writeCampaignId ? { writeCampaignId: result.writeCampaignId, recoveryId: result.recoveryId } : {}) };
}

/** Only the Railway peer may read, edit the cap, or hold this policy. No path calls TikTok. */
export function createCreatorWebPolicyHandler({ store, key, leaseEnabled = false, srihiwLeaseEnabled = false,
  nnshop5719LeaseEnabled = false, ashopbythetaLeaseEnabled = false, myushop4LeaseEnabled = false, bubpaShop189LeaseEnabled = false,
  koolkool888LeaseEnabled = false, boomkanLeaseEnabled = false, bubpaShop189RecoveryEnabled = false,
  capWriteEnabled = false, resolveAutoLineRecipient = () => null, resolvePpanOwnerDigest = () => null, clock = () => new Date() } = {}) {
  const expected = validKey(key) ? digest(key) : null;
  const leaseByClient = new Map([[CLIENT_ID, leaseEnabled], [SRIHIW_CREATOR_POLICY_CLIENT, srihiwLeaseEnabled],
    [NNSHOP5719_CREATOR_POLICY_CLIENT, nnshop5719LeaseEnabled], [ASHOPBYTHETA_CREATOR_POLICY_CLIENT, ashopbythetaLeaseEnabled],
    [MYUSHOP4_CREATOR_POLICY_CLIENT, myushop4LeaseEnabled], [BUBPA_SHOP189_CREATOR_POLICY_CLIENT, bubpaShop189LeaseEnabled],
    [KOOLKOOL888_CREATOR_POLICY_CLIENT, koolkool888LeaseEnabled], [BOOMKAN_CREATOR_POLICY_CLIENT, boomkanLeaseEnabled]]);
  function autoRecipient(clientId) {
    try {
      const result = resolveAutoLineRecipient(clientId);
      return validCreatorLineRecipient(result) ? result : null;
    } catch { return null; }
  }
  return async (request, response, pathname) => {
    if (!expected) return fail(response, 404, "NOT_FOUND");
    const scope = scopeFor(pathname);
    if (request.url !== pathname || !scope) return fail(response, 400, "INVALID_REQUEST");
    if (browserRequest(request.headers)) return fail(response, 403, "SERVER_TO_SERVER_ONLY");
    const supplied = request.headers["x-creator-web-key"];
    if (!validKey(supplied) || !timingSafeEqual(digest(supplied), expected)) {
      return fail(response, 401, "UNAUTHORIZED");
    }
    const { clientId, action } = scope;
    const extra = clientId !== CLIENT_ID;
    const capPath = action === "cap";
    const checkFailurePath = action === "check-failure-alert";
    const scopeLeaseEnabled = leaseByClient.get(clientId) === true;
    const method = ["read", "line-result", "line-owner-binding"].includes(action) ? "GET" : "POST";
    if (request.method !== method) return fail(response, 405, "METHOD_NOT_ALLOWED", { allow: method });
    if (capPath && capWriteEnabled !== true) return fail(response, 503, "CAP_WRITE_DISABLED");
    if (action === "recover-unknown" && bubpaShop189RecoveryEnabled !== true) return fail(response, 503, "RECOVERY_DISABLED");
    if (method === "POST" && !capPath && !checkFailurePath && !scopeLeaseEnabled) {
      return fail(response, 503, "LEASE_DISABLED");
    }

    try {
      if (method === "GET") {
        if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) !== 0) {
          return fail(response, 400, "INVALID_REQUEST");
        }
        if (action === "line-result") {
          const status = store.getCreatorAutoLineResult({ clientId, operationId: scope.operationId });
          return AUTO_LINE_RESULT_STATUSES.has(status)
            ? write(response, 200, { schemaVersion: 1, clientId, operationId: scope.operationId, status })
            : fail(response, 503, "LINE_RESULT_UNAVAILABLE");
        }
        if (action === "line-owner-binding") {
          const ownerSha256 = resolvePpanOwnerDigest();
          return ownerSha256 === null || (typeof ownerSha256 === "string" && /^[0-9a-f]{64}$/.test(ownerSha256))
            ? write(response, 200, { schemaVersion: 1, clientId, ownerSha256 })
            : fail(response, 503, "LINE_BINDING_UNAVAILABLE");
        }
        const state = store.getCreatorWebPolicyState({ clientId });
        const now = new Date(clock());
        const capability = capWriteEnabled === true;
        const autoLineReady = scopeLeaseEnabled && !!autoRecipient(clientId);
        if (extra && state === null) return write(response, 200, { schemaVersion: 1, clientId,
          configured: false, readAt: now.toISOString(), locked: false, capWriteEnabled: capability, autoLineReady: false });
        const result = payloadOf(state, now, clientId);
        return result ? write(response, 200, { ...result, ...(extra ? { configured: true } : {}),
          capWriteEnabled: capability, autoLineReady }) : fail(response, 503, "POLICY_UNAVAILABLE");
      }

      const parsed = await body(request);
      if (!parsed.payload) return fail(response, parsed.status, parsed.code, parsed.status === 413 ? { connection: "close" } : {});
      const input = parsed.payload;
      const now = new Date(clock());
      if (action === "recover-unknown") {
        const fields = ["recoveryId", "operatorUserId", "oldOperationId", "oldCampaignId", "newCampaignId", "revision", "acknowledgedUnknown"];
        if (Object.keys(input).length !== fields.length || !fields.every(field => Object.hasOwn(input, field)) ||
          !OPERATION_ID.test(input.recoveryId ?? "") || !OPERATION_ID.test(input.oldOperationId ?? "") ||
          typeof input.oldCampaignId !== "string" || !CAMPAIGN_ID.test(input.oldCampaignId) || typeof input.newCampaignId !== "string" ||
          !CAMPAIGN_ID.test(input.newCampaignId) || input.oldCampaignId === input.newCampaignId || !validPositive(input.operatorUserId) ||
          !validPositive(input.revision) || input.acknowledgedUnknown !== true) return fail(response, 400, "INVALID_REQUEST");
        const result = store.recoverCreatorWebUnknownLease({ clientId, ...input, now });
        return write(response, 200, { schemaVersion: 1, ...result });
      }
      if (checkFailurePath) {
        const alert = parseCreatorCheckFailureAlert(input, clientId);
        if (!alert) return fail(response, 400, "INVALID_REQUEST");
        const recipientUserId = autoRecipient(clientId);
        if (!recipientUserId) return fail(response, 409, "CREATOR_WEB_AUTO_LINE_NOT_READY");
        const status = store.enqueueCreatorCheckFailureAlert({ clientId, alert, recipientUserId, now });
        return CHECK_FAILURE_STATES.has(status)
          ? write(response, 200, { schemaVersion: 1, clientId, incidentId: alert.incidentId, status })
          : fail(response, 503, "CHECK_FAILURE_ALERT_UNAVAILABLE");
      }
      if (capPath) {
        const fields = ["revision", "capMinor", "actorUserId"];
        if (Object.keys(input).length !== fields.length || !fields.every(field => Object.hasOwn(input, field)
          && (validPositive(input[field]) || (extra && field === "revision" && input[field] === 0)))) {
          return fail(response, 400, "INVALID_REQUEST");
        }
        const result = payloadOf(store.updateCreatorWebCap({ clientId,
          revision: input.revision, capMinor: input.capMinor, actorUserId: input.actorUserId, now }), now, clientId);
        return result ? write(response, 200, { ...result, ...(extra ? { configured: true } : {}),
          capWriteEnabled: true, autoLineReady: scopeLeaseEnabled && !!autoRecipient(clientId) })
          : fail(response, 503, "POLICY_UNAVAILABLE");
      }
      if (!Object.hasOwn(input, "operationId") || typeof input.operationId !== "string"
        || input.operationId.length !== 36 || !OPERATION_ID.test(input.operationId)) return fail(response, 400, "INVALID_REQUEST");
      if (action === "lease") {
        const isAuto = Object.hasOwn(input, "autoBudget");
        const hasCampaign = Object.hasOwn(input, "campaignId");
        if (Object.keys(input).length !== (isAuto ? 3 : 2) + (hasCampaign ? 1 : 0) || !Object.hasOwn(input, "revision") || !validPositive(input.revision) ||
          (hasCampaign && (typeof input.campaignId !== "string" || !CAMPAIGN_ID.test(input.campaignId)))) {
          return fail(response, 400, "INVALID_REQUEST");
        }
        const autoBudget = isAuto ? parseCreatorWebAutoBudget(input.autoBudget, clientId) : undefined;
        if (isAuto && !autoBudget) return fail(response, 400, "INVALID_REQUEST");
        const lineRecipientUserId = isAuto ? autoRecipient(clientId) : undefined;
        if (isAuto && !lineRecipientUserId) return fail(response, 409, "CREATOR_WEB_AUTO_LINE_NOT_READY");
        const result = store.acquireCreatorWebPolicyLease({ clientId, operationId: input.operationId, revision: input.revision, now,
          ...(hasCampaign ? { campaignId: input.campaignId } : {}),
          ...(isAuto ? { autoBudget, lineRecipientUserId } : {}) });
        const policy = payloadOf(result, now, clientId);
        if (!policy) return fail(response, 503, "POLICY_UNAVAILABLE");
        return write(response, 200, { ...policy, ...(extra ? { configured: true } : {}),
          operationId: result.operationId, expiresAt: result.expiresAt });
      }

      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "outcome") || !OUTCOMES.has(input.outcome)) {
        return fail(response, 400, "INVALID_REQUEST");
      }
      const result = store.finishCreatorWebPolicyLease({ clientId, operationId: input.operationId, outcome: input.outcome, now });
      return write(response, 200, { schemaVersion: 1, ...result });
    } catch (error) {
      if (CONFLICTS.has(error?.code)) return fail(response, 409, error.code);
      return fail(response, 503, "POLICY_UNAVAILABLE");
    }
  };
}
