import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const DEFAULT_AUTHORIZE_URL = "https://business-api.tiktok.com/portal/auth";
const DEFAULT_API_BASE_URL = "https://business-api.tiktok.com/open_api/v1.3";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STATE_MAX_AGE_MS = 10 * 60 * 1_000;
const DEFAULT_CLOCK_SKEW_MS = 30 * 1_000;
const MAX_STATE_MAX_AGE_MS = 15 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const STATE_VERSION = 1;
const NONCE_BYTES = 32;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class TikTokOAuthError extends Error {
  constructor(message, {
    code,
    status,
    apiCode,
    requestId,
    operation,
    outcomeKnown = true
  } = {}) {
    super(message);
    this.name = "TikTokOAuthError";
    this.code = code;
    this.status = status;
    this.apiCode = apiCode;
    this.requestId = requestId;
    this.operation = operation;
    this.outcomeKnown = outcomeKnown;
  }
}

function isPlainRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireOpaqueString(value, label, { maxLength = 16_384 } = {}) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty opaque string`);
  }
  return value;
}

function optionalOpaqueString(value, label, options) {
  if (value == null) return null;
  return requireOpaqueString(value, label, options);
}

function normalizeHttpsEndpoint(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new TypeError(`${label} must be an absolute HTTPS URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("redirectUri must be an absolute callback URL");
  }
  const loopbackHttp = url.protocol === "http:" && (
    url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
  );
  if (
    (url.protocol !== "https:" && !loopbackHttp)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new TypeError("redirectUri must use HTTPS (or HTTP loopback) and contain no credentials or fragment");
  }
  return url.toString();
}

function normalizeStateSecret(value) {
  let secret;
  if (typeof value === "string") {
    secret = Buffer.from(value, "utf8");
  } else if (value instanceof Uint8Array) {
    secret = Buffer.from(value);
  } else {
    throw new TypeError("stateSecret must be a string or byte array");
  }
  if (secret.byteLength < 32) {
    throw new TypeError("stateSecret must contain at least 32 bytes");
  }
  return secret;
}

function normalizeInteger(value, label, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function safeDigestEqual(left, right) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function signatureMatches(candidate, expected) {
  const fixedCandidate = Buffer.alloc(expected.byteLength);
  candidate.copy(fixedCandidate, 0, 0, Math.min(candidate.byteLength, expected.byteLength));
  const equal = timingSafeEqual(fixedCandidate, expected);
  return candidate.byteLength === expected.byteLength && equal;
}

function invalidState() {
  return new TikTokOAuthError("Invalid or expired TikTok OAuth state", {
    code: "TIKTOK_OAUTH_INVALID_STATE",
    operation: "verify_state",
    outcomeKnown: true
  });
}

function strictRequestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;
}

function normalizeAdvertiserIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("advertiser_ids must be an array");
  const ids = value.map((id) => requireOpaqueString(id, "advertiser_id", { maxLength: 128 }));
  if (new Set(ids).size !== ids.length) throw new TypeError("advertiser_ids must not contain duplicates");
  return ids;
}

function normalizeScopes(value) {
  if (value == null || value === "") return [];
  let scopes;
  if (typeof value === "string") {
    scopes = value.split(",").map((scope) => scope.trim());
  } else if (Array.isArray(value)) {
    scopes = value.map((scope) => {
      if (typeof scope === "string") return scope.trim();
      if (Number.isSafeInteger(scope)) return String(scope);
      throw new TypeError("scope must contain only strings or integers");
    });
  } else {
    throw new TypeError("scope must be a string or array");
  }
  if (scopes.some((scope) => scope.length === 0 || scope.length > 256 || /[\u0000-\u001f\u007f]/u.test(scope))) {
    throw new TypeError("scope contains an invalid value");
  }
  if (new Set(scopes).size !== scopes.length) throw new TypeError("scope must not contain duplicates");
  return scopes;
}

function optionalPositiveInteger(value, label) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

/**
 * A dependency-free OAuth client for TikTok Marketing API.
 *
 * Secrets are held in private class fields and are never attached to errors,
 * returned envelopes, or log messages. Callers must persist each returned
 * nonce server-side and delete it after a successful callback.
 */
export class TikTokOAuthClient {
  #appId;
  #appSecret;
  #stateSecret;
  #redirectUri;
  #authorizeUrl;
  #apiBaseUrl;
  #fetch;
  #timeoutMs;
  #stateMaxAgeMs;
  #clockSkewMs;
  #clock;
  #randomBytes;

  constructor({
    appId,
    appSecret,
    stateSecret,
    redirectUri,
    fetchImpl = globalThis.fetch,
    authorizeUrl = DEFAULT_AUTHORIZE_URL,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    stateMaxAgeMs = DEFAULT_STATE_MAX_AGE_MS,
    clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
    clock = Date.now,
    randomBytesImpl = randomBytes
  }) {
    this.#appId = requireOpaqueString(appId, "appId", { maxLength: 256 });
    this.#appSecret = requireOpaqueString(appSecret, "appSecret");
    this.#stateSecret = normalizeStateSecret(stateSecret);
    this.#redirectUri = normalizeRedirectUri(redirectUri);
    this.#authorizeUrl = normalizeHttpsEndpoint(authorizeUrl, "authorizeUrl");
    this.#apiBaseUrl = normalizeHttpsEndpoint(apiBaseUrl, "apiBaseUrl");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof randomBytesImpl !== "function") throw new TypeError("randomBytesImpl must be a function");
    this.#fetch = fetchImpl;
    this.#timeoutMs = normalizeInteger(timeoutMs, "timeoutMs", { min: 1, max: 60_000 });
    this.#stateMaxAgeMs = normalizeInteger(stateMaxAgeMs, "stateMaxAgeMs", {
      min: 1,
      max: MAX_STATE_MAX_AGE_MS
    });
    this.#clockSkewMs = normalizeInteger(clockSkewMs, "clockSkewMs", { min: 0, max: 60_000 });
    this.#clock = clock;
    this.#randomBytes = randomBytesImpl;
  }

  createAuthorizationRequest() {
    const issuedAt = this.#clock();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error("OAuth clock returned an invalid timestamp");
    }
    const nonceBytes = this.#randomBytes(NONCE_BYTES);
    if (!(nonceBytes instanceof Uint8Array) || nonceBytes.byteLength !== NONCE_BYTES) {
      throw new Error("OAuth nonce source must return exactly 32 bytes");
    }
    const nonce = Buffer.from(nonceBytes).toString("base64url");
    const payload = {
      v: STATE_VERSION,
      nonce,
      issuedAt,
      redirectUri: this.#redirectUri
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#stateSecret)
      .update(encodedPayload, "ascii")
      .digest("base64url");
    const state = `${encodedPayload}.${signature}`;
    const url = new URL(this.#authorizeUrl);
    url.searchParams.set("app_id", this.#appId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", this.#redirectUri);
    return Object.freeze({
      url: url.toString(),
      state,
      nonce,
      issuedAt,
      expiresAt: issuedAt + this.#stateMaxAgeMs
    });
  }

  verifyAuthorizationState({
    state,
    expectedNonce,
    redirectUri = this.#redirectUri
  }) {
    try {
      if (typeof state !== "string" || state.length === 0 || state.length > 8_192) throw invalidState();
      if (typeof expectedNonce !== "string" || !NONCE_PATTERN.test(expectedNonce)) throw invalidState();
      const expectedRedirectUri = normalizeRedirectUri(redirectUri);
      const pieces = state.split(".");
      if (
        pieces.length !== 2
        || !BASE64URL_PATTERN.test(pieces[0])
        || !BASE64URL_PATTERN.test(pieces[1])
      ) {
        throw invalidState();
      }

      const expectedSignature = createHmac("sha256", this.#stateSecret)
        .update(pieces[0], "ascii")
        .digest();
      const candidateSignature = Buffer.from(pieces[1], "base64url");
      if (!signatureMatches(candidateSignature, expectedSignature)) {
        throw invalidState();
      }

      let payload;
      try {
        payload = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
      } catch {
        throw invalidState();
      }
      if (!isPlainRecord(payload)) throw invalidState();
      const keys = Object.keys(payload).sort();
      if (keys.join(",") !== "issuedAt,nonce,redirectUri,v") throw invalidState();
      if (
        payload.v !== STATE_VERSION
        || typeof payload.nonce !== "string"
        || !NONCE_PATTERN.test(payload.nonce)
        || !Number.isSafeInteger(payload.issuedAt)
        || payload.issuedAt < 0
        || typeof payload.redirectUri !== "string"
      ) {
        throw invalidState();
      }
      if (
        !safeDigestEqual(payload.nonce, expectedNonce)
        || !safeDigestEqual(payload.redirectUri, expectedRedirectUri)
      ) {
        throw invalidState();
      }

      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < 0) throw invalidState();
      if (
        payload.issuedAt > now + this.#clockSkewMs
        || now - payload.issuedAt > this.#stateMaxAgeMs
      ) {
        throw invalidState();
      }
      return Object.freeze({
        nonce: payload.nonce,
        issuedAt: payload.issuedAt,
        redirectUri: payload.redirectUri,
        expiresAt: payload.issuedAt + this.#stateMaxAgeMs
      });
    } catch (error) {
      if (error instanceof TikTokOAuthError && error.code === "TIKTOK_OAUTH_INVALID_STATE") throw error;
      throw invalidState();
    }
  }

  async exchangeAuthorizationCode({
    authCode,
    state,
    expectedNonce,
    redirectUri = this.#redirectUri
  }) {
    const verifiedState = this.verifyAuthorizationState({ state, expectedNonce, redirectUri });
    const code = requireOpaqueString(authCode, "authCode", { maxLength: 4_096 });
    const payload = await this.#requestJson("/oauth2/access_token/", {
      method: "POST",
      operation: "exchange_code",
      body: {
        app_id: this.#appId,
        secret: this.#appSecret,
        auth_code: code
      }
    });

    try {
      if (!isPlainRecord(payload.data)) throw new TypeError("data must be an object");
      const accessToken = requireOpaqueString(payload.data.access_token, "access_token");
      const refreshToken = optionalOpaqueString(payload.data.refresh_token, "refresh_token");
      const advertiserIds = normalizeAdvertiserIds(payload.data.advertiser_ids);
      const scopes = normalizeScopes(payload.data.scope);
      const expiresInSeconds = optionalPositiveInteger(payload.data.expires_in, "expires_in");
      const refreshTokenExpiresInSeconds = optionalPositiveInteger(
        payload.data.refresh_token_expires_in,
        "refresh_token_expires_in"
      );
      const tokenType = optionalOpaqueString(payload.data.token_type, "token_type", { maxLength: 64 });
      return Object.freeze({
        accessToken,
        refreshToken,
        advertiserIds: Object.freeze(advertiserIds),
        scopes: Object.freeze(scopes),
        expiresInSeconds,
        refreshTokenExpiresInSeconds,
        tokenType,
        requestId: payload.requestId,
        verifiedState
      });
    } catch {
      throw new TikTokOAuthError("TikTok returned a malformed OAuth token response", {
        code: "TIKTOK_OAUTH_MALFORMED_TOKEN_RESPONSE",
        requestId: payload.requestId,
        operation: "exchange_code",
        outcomeKnown: false
      });
    }
  }

  async getAdvertiserGrant({ accessToken }) {
    const token = requireOpaqueString(accessToken, "accessToken");
    const payload = await this.#requestJson("/oauth2/advertiser/get/", {
      method: "GET",
      operation: "get_advertiser_grant",
      query: {
        app_id: this.#appId,
        secret: this.#appSecret
      },
      accessToken: token
    });

    try {
      if (!isPlainRecord(payload.data) || !Array.isArray(payload.data.list)) {
        throw new TypeError("data.list must be an array");
      }
      const ids = new Set();
      const advertisers = payload.data.list.map((advertiser) => {
        if (!isPlainRecord(advertiser)) throw new TypeError("advertiser must be an object");
        const advertiserId = requireOpaqueString(
          advertiser.advertiser_id,
          "advertiser_id",
          { maxLength: 128 }
        );
        if (ids.has(advertiserId)) throw new TypeError("duplicate advertiser_id");
        ids.add(advertiserId);
        const advertiserName = advertiser.advertiser_name == null
          ? null
          : String(advertiser.advertiser_name);
        if (
          advertiserName != null
          && (
            advertiserName.length === 0
            || advertiserName.length > 1_024
            || /[\u0000-\u001f\u007f]/u.test(advertiserName)
          )
        ) {
          throw new TypeError("invalid advertiser_name");
        }
        return Object.freeze({ advertiserId, advertiserName });
      });
      return Object.freeze({
        advertisers: Object.freeze(advertisers),
        advertiserIds: Object.freeze(advertisers.map(({ advertiserId }) => advertiserId)),
        requestId: payload.requestId
      });
    } catch {
      throw new TikTokOAuthError("TikTok returned a malformed advertiser grant response", {
        code: "TIKTOK_OAUTH_MALFORMED_GRANT_RESPONSE",
        requestId: payload.requestId,
        operation: "get_advertiser_grant",
        outcomeKnown: true
      });
    }
  }

  async #requestJson(path, {
    method,
    operation,
    query,
    body,
    accessToken
  }) {
    const url = new URL(`${this.#apiBaseUrl}${path}`);
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, value);
      }
    }
    const headers = { Accept: "application/json" };
    if (accessToken) headers["Access-Token"] = accessToken;
    if (body) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new TikTokOAuthError(
        timedOut ? "TikTok OAuth request timed out" : "TikTok OAuth transport failed",
        {
          code: timedOut ? "TIKTOK_OAUTH_TIMEOUT" : "TIKTOK_OAUTH_TRANSPORT_ERROR",
          operation,
          outcomeKnown: method === "GET"
        }
      );
    }

    if (
      response == null
      || typeof response.ok !== "boolean"
      || !Number.isSafeInteger(response.status)
      || typeof response.text !== "function"
    ) {
      throw new TikTokOAuthError("TikTok returned an invalid OAuth HTTP response", {
        code: "TIKTOK_OAUTH_INVALID_HTTP_RESPONSE",
        operation,
        outcomeKnown: method === "GET"
      });
    }

    let text;
    try {
      text = await response.text();
    } catch {
      throw new TikTokOAuthError("TikTok OAuth response body could not be read", {
        code: "TIKTOK_OAUTH_INVALID_RESPONSE",
        status: response.status,
        operation,
        outcomeKnown: method === "GET"
      });
    }
    if (text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new TikTokOAuthError("TikTok returned an invalid OAuth response", {
        code: "TIKTOK_OAUTH_INVALID_RESPONSE",
        status: response.status,
        operation,
        outcomeKnown: method === "GET"
      });
    }

    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new TikTokOAuthError("TikTok returned invalid OAuth JSON", {
        code: "TIKTOK_OAUTH_INVALID_RESPONSE",
        status: response.status,
        operation,
        outcomeKnown: method === "GET"
      });
    }
    const requestId = isPlainRecord(envelope) ? strictRequestId(envelope.request_id) : null;
    const apiCode = isPlainRecord(envelope) && Number.isSafeInteger(envelope.code)
      ? envelope.code
      : null;

    if (!response.ok) {
      throw new TikTokOAuthError("TikTok OAuth HTTP request failed", {
        code: "TIKTOK_OAUTH_HTTP_ERROR",
        status: response.status,
        apiCode,
        requestId,
        operation,
        outcomeKnown: method === "GET" || response.status < 500
      });
    }
    if (!isPlainRecord(envelope) || !Number.isSafeInteger(envelope.code)) {
      throw new TikTokOAuthError("TikTok returned a malformed OAuth envelope", {
        code: "TIKTOK_OAUTH_INVALID_RESPONSE",
        status: response.status,
        requestId,
        operation,
        outcomeKnown: method === "GET"
      });
    }
    if (envelope.code !== 0) {
      throw new TikTokOAuthError("TikTok rejected the OAuth request", {
        code: "TIKTOK_OAUTH_API_ERROR",
        status: response.status,
        apiCode: envelope.code,
        requestId,
        operation,
        outcomeKnown: true
      });
    }
    if (!requestId) {
      throw new TikTokOAuthError("TikTok OAuth response omitted its request ID", {
        code: "TIKTOK_OAUTH_INVALID_RESPONSE",
        status: response.status,
        operation,
        outcomeKnown: method === "GET"
      });
    }
    return { data: envelope.data, requestId };
  }
}
