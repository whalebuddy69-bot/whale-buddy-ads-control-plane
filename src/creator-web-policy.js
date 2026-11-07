import { createHash, timingSafeEqual } from "node:crypto";

const CLIENT_ID = "punpan_020";
const ROOT = "/internal/automation/ppan/policy";
const PATHS = new Set([ROOT, `${ROOT}/lease`, `${ROOT}/finish`]);
const KEY = /^[A-Za-z0-9_-]{43,128}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTCOMES = new Set(["NOT_SENT", "PROVIDER_REJECTED", "APPLIED_VERIFIED", "OUTCOME_UNKNOWN"]);
const CONFLICTS = new Set([
  "CREATOR_WEB_POLICY_CHANGED", "CREATOR_WEB_POLICY_LOCKED", "CREATOR_WEB_LEASE_EXPIRED",
  "CREATOR_WEB_LEASE_CONFLICT", "CREATOR_WEB_LEASE_NOT_FOUND"
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
  return { key, leaseEnabled: key !== null && env?.CREATOR_WEB_POLICY_LEASE_ENABLED === "true" };
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

function payloadOf(result, now) {
  const p = result?.policy;
  if (!p || p.clientId !== CLIENT_ID || !validPositive(p.revision) || !validPositive(p.campaignCapMinor)
    || !validPositive(p.clientDailyCapMinor) || typeof result.locked !== "boolean") return null;
  return { schemaVersion: 1, clientId: CLIENT_ID, revision: p.revision,
    campaignCapMinor: p.campaignCapMinor, clientDailyCapMinor: p.clientDailyCapMinor,
    readAt: now.toISOString(), locked: result.locked };
}

/** Only the Railway peer may read or hold this policy. No path calls TikTok. */
export function createCreatorWebPolicyHandler({ store, key, leaseEnabled = false, clock = () => new Date() } = {}) {
  const expected = validKey(key) ? digest(key) : null;
  return async (request, response, pathname) => {
    if (!expected) return fail(response, 404, "NOT_FOUND");
    if (request.url !== pathname || !PATHS.has(pathname)) return fail(response, 400, "INVALID_REQUEST");
    if (browserRequest(request.headers)) return fail(response, 403, "SERVER_TO_SERVER_ONLY");
    const supplied = request.headers["x-creator-web-key"];
    if (!validKey(supplied) || !timingSafeEqual(digest(supplied), expected)) {
      return fail(response, 401, "UNAUTHORIZED");
    }
    const method = pathname === ROOT ? "GET" : "POST";
    if (request.method !== method) return fail(response, 405, "METHOD_NOT_ALLOWED", { allow: method });
    if (method === "POST" && leaseEnabled !== true) return fail(response, 503, "LEASE_DISABLED");

    try {
      if (method === "GET") {
        if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) !== 0) {
          return fail(response, 400, "INVALID_REQUEST");
        }
        const result = payloadOf(store.getCreatorWebPolicyState({ clientId: CLIENT_ID }), new Date(clock()));
        return result ? write(response, 200, result) : fail(response, 503, "POLICY_UNAVAILABLE");
      }

      const parsed = await body(request);
      if (!parsed.payload) return fail(response, parsed.status, parsed.code, parsed.status === 413 ? { connection: "close" } : {});
      const input = parsed.payload;
      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "operationId") || typeof input.operationId !== "string"
        || input.operationId.length !== 36 || !OPERATION_ID.test(input.operationId)) return fail(response, 400, "INVALID_REQUEST");
      const now = new Date(clock());
      if (pathname === `${ROOT}/lease`) {
        if (!Object.hasOwn(input, "revision") || !validPositive(input.revision)) return fail(response, 400, "INVALID_REQUEST");
        const result = store.acquireCreatorWebPolicyLease({ clientId: CLIENT_ID, operationId: input.operationId, revision: input.revision, now });
        const policy = payloadOf(result, now);
        if (!policy) return fail(response, 503, "POLICY_UNAVAILABLE");
        return write(response, 200, { ...policy, operationId: result.operationId, expiresAt: result.expiresAt });
      }

      if (!Object.hasOwn(input, "outcome") || !OUTCOMES.has(input.outcome)) return fail(response, 400, "INVALID_REQUEST");
      const result = store.finishCreatorWebPolicyLease({ clientId: CLIENT_ID, operationId: input.operationId, outcome: input.outcome, now });
      return write(response, 200, { schemaVersion: 1, ...result });
    } catch (error) {
      if (CONFLICTS.has(error?.code)) return fail(response, 409, error.code);
      return fail(response, 503, "POLICY_UNAVAILABLE");
    }
  };
}
