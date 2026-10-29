import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CALLBACK_PATH = "/oauth/tiktok-shop/callback";
export const BINDING_COOKIE = "__Host-whalebuddy_shop_oauth";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_TARGET_LENGTH = 8192;
const MAX_CODE_LENGTH = 4096;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function equalDigest(left, right) {
  return typeof left === "string" && typeof right === "string"
    && /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right)
    && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateRedirectUri(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("A controlled HTTPS callback URL is required."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== CALLBACK_PATH) {
    throw new TypeError("Use the exact controlled HTTPS Shop callback URL without credentials, query or fragment.");
  }
  return parsed.href;
}

// Test-only store. A configured deployment must inject an atomic shared store;
// the disabled standalone receiver does not instantiate or use any state store.
export function createMemoryStateStoreForTests() {
  const records = new Map();
  return {
    async put(record) {
      if (records.has(record.stateHash)) throw new Error("State collision.");
      records.set(record.stateHash, { ...record });
    },
    async consume({ stateHash, bindingHash, redirectUri, now }) {
      const record = records.get(stateHash);
      if (!record) return null;
      if (record.expiresAt <= now) { records.delete(stateHash); return null; }
      if (record.redirectUri !== redirectUri || !equalDigest(record.bindingHash, bindingHash)) return null;
      records.delete(stateHash); // Delete before any await: one winner per state.
      return { contextId: record.contextId };
    }
  };
}

export function createStateManager({ redirectUri, store, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const boundRedirectUri = validateRedirectUri(redirectUri);
  if (!store || typeof store.put !== "function" || typeof store.consume !== "function") {
    throw new TypeError("An atomic state store is required.");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > DEFAULT_TTL_MS) {
    throw new TypeError("State lifetime must be between one second and ten minutes.");
  }
  return {
    redirectUri: boundRedirectUri,
    async issue({ contextId } = {}) {
      if (typeof contextId !== "string" || !contextId || contextId.length > 128) {
        throw new TypeError("An authenticated initiating context is required.");
      }
      const state = randomBytes(32).toString("base64url");
      const binding = randomBytes(32).toString("base64url");
      const issuedAt = now();
      if (!Number.isSafeInteger(issuedAt)) throw new TypeError("Invalid clock.");
      await store.put({ stateHash: digest(state), bindingHash: digest(binding),
        redirectUri: boundRedirectUri, contextId, expiresAt: issuedAt + ttlMs });
      return {
        state,
        // Set only from a future authenticated authorization-start endpoint.
        cookie: `${BINDING_COOKIE}=${binding}; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; Secure; HttpOnly; SameSite=Lax`
      };
    },
    async consume({ state, cookieHeader }) {
      if (typeof state !== "string" || !TOKEN_PATTERN.test(state)) return null;
      if (typeof cookieHeader !== "string" || cookieHeader.length > MAX_REQUEST_TARGET_LENGTH) return null;
      const matches = cookieHeader.split(";").map((part) => part.trim())
        .filter((part) => part.slice(0, part.indexOf("=")) === BINDING_COOKIE);
      if (matches.length !== 1) return null;
      const binding = matches[0].slice(BINDING_COOKIE.length + 1);
      if (!TOKEN_PATTERN.test(binding)) return null;
      const instant = now();
      if (!Number.isSafeInteger(instant)) return null;
      const record = await store.consume({ stateHash: digest(state), bindingHash: digest(binding),
        redirectUri: boundRedirectUri, now: instant });
      return record && typeof record.contextId === "string" && record.contextId
        ? { contextId: record.contextId, redirectUri: boundRedirectUri } : null;
    }
  };
}

const MESSAGES = Object.freeze({
  UNCONFIGURED: "TikTok Shop authorization is not configured. No authorization was processed.",
  INVALID_REQUEST: "Invalid TikTok Shop callback. Restart the connection from the approved application.",
  INVALID_STATE: "The connection request is invalid or expired. Restart from the approved application.",
  DENIED: "TikTok Shop authorization was declined. No connection was completed.",
  FAILED: "TikTok Shop authorization could not be completed. Restart from the approved application.",
  COMPLETE: "TikTok Shop authorization was processed by the configured application. You may close this page.",
  NOT_FOUND: "Not found.",
  METHOD: "Method not allowed.",
  TOO_LONG: "Request target is too long."
});

function send(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...extraHeaders
  });
  response.end(body);
}

export function createShopCallbackHandler({ enabled = false, stateManager, completeAuthorization,
  audit = () => {} } = {}) {
  if (typeof enabled !== "boolean" || typeof audit !== "function") throw new TypeError("Invalid callback configuration.");
  if (enabled && (!stateManager || typeof stateManager.consume !== "function"
    || typeof completeAuthorization !== "function")) {
    throw new TypeError("Configured authorization requires state validation and a Shop completion adapter.");
  }
  // Only fixed event names cross this boundary. Never log requests, URLs,
  // query values, exceptions, cookies, authorization codes or adapter results.
  const record = (event) => {
    try {
      Promise.resolve(audit(Object.freeze({ event }))).catch(() => {});
    } catch { /* Audit must not leak or change outcome. */ }
  };
  const clearCookie = { "Set-Cookie": `${BINDING_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` };

  return async function handle(request, response) {
    const target = request.url;
    if (typeof target !== "string" || target.length > MAX_REQUEST_TARGET_LENGTH) {
      record("shop_oauth_invalid_request"); return send(response, 414, MESSAGES.TOO_LONG);
    }
    let url;
    try { url = new URL(target, "http://callback.invalid"); }
    catch { record("shop_oauth_invalid_request"); return send(response, 400, MESSAGES.INVALID_REQUEST); }
    if (url.pathname !== CALLBACK_PATH) return send(response, 404, MESSAGES.NOT_FOUND);
    if (request.method !== "GET") return send(response, 405, MESSAGES.METHOD, { Allow: "GET" });
    if (!enabled) { record("shop_oauth_unconfigured"); return send(response, 503, MESSAGES.UNCONFIGURED); }

    const params = url.searchParams;
    if (params.getAll("state").length !== 1 || params.getAll("code").length > 1
      || params.getAll("error").length > 1 || params.has("auth_code")) {
      record("shop_oauth_invalid_request"); return send(response, 400, MESSAGES.INVALID_REQUEST);
    }
    let context;
    try { context = await stateManager.consume({ state: params.get("state"), cookieHeader: request.headers?.cookie }); }
    catch { record("shop_oauth_state_failed"); return send(response, 503, MESSAGES.FAILED); }
    if (!context) { record("shop_oauth_invalid_state"); return send(response, 400, MESSAGES.INVALID_STATE); }

    if (params.has("error")) {
      const denied = params.get("error") === "auth_denied";
      record(denied ? "shop_oauth_denied" : "shop_oauth_provider_error");
      return send(response, denied ? 403 : 400, denied ? MESSAGES.DENIED : MESSAGES.FAILED, clearCookie);
    }
    const authCode = params.get("code");
    if (!authCode || authCode.length > MAX_CODE_LENGTH || /^null$/i.test(authCode)
      || /[\u0000-\u001f\u007f]/.test(authCode)) {
      record("shop_oauth_invalid_request"); return send(response, 400, MESSAGES.INVALID_REQUEST, clearCookie);
    }
    try {
      // This adapter is intentionally absent from the standalone receiver.
      // Future implementation must use Shop seller OAuth and separately approved
      // credential storage, scope/identity verification; never the Ads adapter.
      await completeAuthorization({ authCode, contextId: context.contextId, redirectUri: context.redirectUri });
      record("shop_oauth_completed"); return send(response, 200, MESSAGES.COMPLETE, clearCookie);
    } catch {
      // State is consumed before exchange. An unknown/failed outcome must never
      // blindly retry the same one-time code; start a new authorized flow.
      record("shop_oauth_completion_failed"); return send(response, 502, MESSAGES.FAILED, clearCookie);
    }
  };
}
