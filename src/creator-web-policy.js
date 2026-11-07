import { createHash, timingSafeEqual } from "node:crypto";
import { CREATOR_POLICY_DEFAULTS, SRIHIW_CREATOR_POLICY_CLIENT } from "./creator-policy.js";

const CLIENT_ID = CREATOR_POLICY_DEFAULTS.clientId;
const ROOT = "/internal/automation/ppan/policy";
const CAP = `${ROOT}/cap`;
const LEASE = `${ROOT}/lease`;
const FINISH = `${ROOT}/finish`;
const SRIHIW_ROOT = "/internal/automation/srihiw/policy";
const SRIHIW_CAP = `${SRIHIW_ROOT}/cap`;
const SRIHIW_LEASE = `${SRIHIW_ROOT}/lease`;
const SRIHIW_FINISH = `${SRIHIW_ROOT}/finish`;
const SRIHIW_PATHS = new Set([SRIHIW_ROOT, SRIHIW_CAP, SRIHIW_LEASE, SRIHIW_FINISH]);
const PATHS = new Set([ROOT, CAP, LEASE, FINISH, ...SRIHIW_PATHS]);
const KEY = /^[A-Za-z0-9_-]{43,128}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTCOMES = new Set(["NOT_SENT", "PROVIDER_REJECTED", "APPLIED_VERIFIED", "OUTCOME_UNKNOWN"]);
const CONFLICTS = new Set([
  "CREATOR_WEB_POLICY_CHANGED", "CREATOR_WEB_POLICY_LOCKED", "CREATOR_WEB_LEASE_EXPIRED",
  "CREATOR_WEB_LEASE_CONFLICT", "CREATOR_WEB_LEASE_NOT_FOUND", "POLICY_CHANGED", "POLICY_LOCKED"
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
  capWriteEnabled = false, clock = () => new Date() } = {}) {
  const expected = validKey(key) ? digest(key) : null;
  return async (request, response, pathname) => {
    if (!expected) return fail(response, 404, "NOT_FOUND");
    if (request.url !== pathname || !PATHS.has(pathname)) return fail(response, 400, "INVALID_REQUEST");
    if (browserRequest(request.headers)) return fail(response, 403, "SERVER_TO_SERVER_ONLY");
    const supplied = request.headers["x-creator-web-key"];
    if (!validKey(supplied) || !timingSafeEqual(digest(supplied), expected)) {
      return fail(response, 401, "UNAUTHORIZED");
    }
    const srihiw = SRIHIW_PATHS.has(pathname);
    const clientId = srihiw ? SRIHIW_CREATOR_POLICY_CLIENT : CLIENT_ID;
    const capPath = pathname === CAP || pathname === SRIHIW_CAP;
    const method = pathname === ROOT || pathname === SRIHIW_ROOT ? "GET" : "POST";
    if (request.method !== method) return fail(response, 405, "METHOD_NOT_ALLOWED", { allow: method });
    if (capPath && capWriteEnabled !== true) return fail(response, 503, "CAP_WRITE_DISABLED");
    if (method === "POST" && !capPath && (srihiw ? srihiwLeaseEnabled : leaseEnabled) !== true) {
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
        if (srihiw && state === null) return write(response, 200, { schemaVersion: 1, clientId,
          configured: false, readAt: now.toISOString(), locked: false, capWriteEnabled: capability });
        const result = payloadOf(state, now, clientId);
        return result ? write(response, 200, { ...result, ...(srihiw ? { configured: true } : {}),
          capWriteEnabled: capability }) : fail(response, 503, "POLICY_UNAVAILABLE");
      }

      const parsed = await body(request);
      if (!parsed.payload) return fail(response, parsed.status, parsed.code, parsed.status === 413 ? { connection: "close" } : {});
      const input = parsed.payload;
      const now = new Date(clock());
      if (capPath) {
        const fields = ["revision", "capMinor", "actorUserId"];
        if (Object.keys(input).length !== fields.length || !fields.every(field => Object.hasOwn(input, field)
          && (validPositive(input[field]) || (srihiw && field === "revision" && input[field] === 0)))) {
          return fail(response, 400, "INVALID_REQUEST");
        }
        const result = payloadOf(store.updateCreatorWebCap({ clientId,
          revision: input.revision, capMinor: input.capMinor, actorUserId: input.actorUserId, now }), now, clientId);
        return result ? write(response, 200, { ...result, ...(srihiw ? { configured: true } : {}),
          capWriteEnabled: true }) : fail(response, 503, "POLICY_UNAVAILABLE");
      }
      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "operationId") || typeof input.operationId !== "string"
        || input.operationId.length !== 36 || !OPERATION_ID.test(input.operationId)) return fail(response, 400, "INVALID_REQUEST");
      if (pathname === LEASE || pathname === SRIHIW_LEASE) {
        if (!Object.hasOwn(input, "revision") || !validPositive(input.revision)) return fail(response, 400, "INVALID_REQUEST");
        const result = store.acquireCreatorWebPolicyLease({ clientId, operationId: input.operationId, revision: input.revision, now });
        const policy = payloadOf(result, now, clientId);
        if (!policy) return fail(response, 503, "POLICY_UNAVAILABLE");
        return write(response, 200, { ...policy, ...(srihiw ? { configured: true } : {}),
          operationId: result.operationId, expiresAt: result.expiresAt });
      }

      if (!Object.hasOwn(input, "outcome") || !OUTCOMES.has(input.outcome)) return fail(response, 400, "INVALID_REQUEST");
      const result = store.finishCreatorWebPolicyLease({ clientId, operationId: input.operationId, outcome: input.outcome, now });
      return write(response, 200, { schemaVersion: 1, ...result });
    } catch (error) {
      if (CONFLICTS.has(error?.code)) return fail(response, 409, error.code);
      return fail(response, 503, "POLICY_UNAVAILABLE");
    }
  };
}
