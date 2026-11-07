import { createHash, timingSafeEqual } from "node:crypto";
import {
  ASHOPBYTHETA_CREATOR_POLICY_CLIENT, CREATOR_POLICY_DEFAULTS, EXTRA_CREATOR_WEB_POLICY_CLIENTS,
  NNSHOP5719_CREATOR_POLICY_CLIENT, SRIHIW_CREATOR_POLICY_CLIENT,
} from "./creator-policy.js";
import { parseCreatorWebAutoBudget, validCreatorLineRecipient } from "./creator-web-auto-line.js";

const CLIENT_ID = CREATOR_POLICY_DEFAULTS.clientId;
// No arbitrary caller-provided slug resolves to a policy. The legacy Ppan URL
// is retained and every additional scope is a literal reviewed allowlist entry.
const PATHS = new Map([["ppan", CLIENT_ID], ...EXTRA_CREATOR_WEB_POLICY_CLIENTS.map(clientId => [clientId, clientId])]
  .flatMap(([slug, clientId]) => {
    const root = `/internal/automation/${slug}/policy`;
    return [[root, { clientId, action: "read" }], ...["cap", "lease", "finish"].map(action => [`${root}/${action}`, { clientId, action }])];
  }));
const KEY = /^[A-Za-z0-9_-]{43,128}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTCOMES = new Set(["NOT_SENT", "PROVIDER_REJECTED", "APPLIED_VERIFIED", "OUTCOME_UNKNOWN"]);
const CONFLICTS = new Set([
  "CREATOR_WEB_POLICY_CHANGED", "CREATOR_WEB_POLICY_LOCKED", "CREATOR_WEB_LEASE_EXPIRED",
  "CREATOR_WEB_LEASE_CONFLICT", "CREATOR_WEB_LEASE_NOT_FOUND", "CREATOR_WEB_AUTO_LINE_NOT_READY", "POLICY_CHANGED", "POLICY_LOCKED"
]);
const MAX_BODY_BYTES = 512;
const digest = (value) => createHash("sha256").update(value).digest();
const validKey = (value) => typeof value === "string" && value === value.trim() && KEY.test(value);

export const isCreatorWebPolicyPath = (pathname) => PATHS.has(pathname);

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
    readAt: now.toISOString(), locked: result.locked };
}

/** Only the Railway peer may read, edit the cap, or hold this policy. No path calls TikTok. */
export function createCreatorWebPolicyHandler({ store, key, leaseEnabled = false, srihiwLeaseEnabled = false,
  nnshop5719LeaseEnabled = false, ashopbythetaLeaseEnabled = false,
  capWriteEnabled = false, resolveAutoLineRecipient = () => null, clock = () => new Date() } = {}) {
  const expected = validKey(key) ? digest(key) : null;
  const leaseByClient = new Map([[CLIENT_ID, leaseEnabled], [SRIHIW_CREATOR_POLICY_CLIENT, srihiwLeaseEnabled],
    [NNSHOP5719_CREATOR_POLICY_CLIENT, nnshop5719LeaseEnabled], [ASHOPBYTHETA_CREATOR_POLICY_CLIENT, ashopbythetaLeaseEnabled]]);
  function autoRecipient(clientId) {
    try {
      const result = resolveAutoLineRecipient(clientId);
      return validCreatorLineRecipient(result) ? result : null;
    } catch { return null; }
  }
  return async (request, response, pathname) => {
    if (!expected) return fail(response, 404, "NOT_FOUND");
    const scope = PATHS.get(pathname);
    if (request.url !== pathname || !scope) return fail(response, 400, "INVALID_REQUEST");
    if (browserRequest(request.headers)) return fail(response, 403, "SERVER_TO_SERVER_ONLY");
    const supplied = request.headers["x-creator-web-key"];
    if (!validKey(supplied) || !timingSafeEqual(digest(supplied), expected)) {
      return fail(response, 401, "UNAUTHORIZED");
    }
    const { clientId, action } = scope;
    const extra = clientId !== CLIENT_ID;
    const capPath = action === "cap";
    const scopeLeaseEnabled = leaseByClient.get(clientId) === true;
    const method = action === "read" ? "GET" : "POST";
    if (request.method !== method) return fail(response, 405, "METHOD_NOT_ALLOWED", { allow: method });
    if (capPath && capWriteEnabled !== true) return fail(response, 503, "CAP_WRITE_DISABLED");
    if (method === "POST" && !capPath && !scopeLeaseEnabled) {
      return fail(response, 503, "LEASE_DISABLED");
    }

    try {
      if (method === "GET") {
        if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) !== 0) {
          return fail(response, 400, "INVALID_REQUEST");
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
        if (Object.keys(input).length !== (isAuto ? 3 : 2) || !Object.hasOwn(input, "revision") || !validPositive(input.revision)) {
          return fail(response, 400, "INVALID_REQUEST");
        }
        const autoBudget = isAuto ? parseCreatorWebAutoBudget(input.autoBudget) : undefined;
        if (isAuto && !autoBudget) return fail(response, 400, "INVALID_REQUEST");
        const lineRecipientUserId = isAuto ? autoRecipient(clientId) : undefined;
        if (isAuto && !lineRecipientUserId) return fail(response, 409, "CREATOR_WEB_AUTO_LINE_NOT_READY");
        const result = store.acquireCreatorWebPolicyLease({ clientId, operationId: input.operationId, revision: input.revision, now,
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
