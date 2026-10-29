import test from "node:test";
import assert from "node:assert/strict";
import { CALLBACK_PATH, BINDING_COOKIE, createMemoryStateStoreForTests,
  createStateManager, createShopCallbackHandler } from "../src/tiktok-shop-callback.js";

// Offline-only fixtures. This example.test URL is never deployed or registered.
const REDIRECT_URI = `https://callback.example.test${CALLBACK_PATH}`;
const CODE = "offline-code-canary-do-not-log";
const TOKEN = "offline-token-canary-do-not-log";

async function invoke(handler, { method = "GET", url = CALLBACK_PATH, cookie } = {}) {
  const captured = { status: null, headers: {}, body: "" };
  const response = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(body) { captured.body = String(body ?? ""); }
  };
  await handler({ method, url, headers: cookie === undefined ? {} : { cookie } }, response);
  return captured;
}

const cookieHeader = (issued) => issued.cookie.split(";")[0];
const callbackUrl = (state, code = CODE, extra = {}) => {
  const params = new URLSearchParams({ state, code, ...extra });
  return `${CALLBACK_PATH}?${params}`;
};

async function fixture({ complete, store, ttlMs = 1000 } = {}) {
  let instant = 1_000_000;
  const audits = [];
  const completions = [];
  const manager = createStateManager({ redirectUri: REDIRECT_URI,
    store: store || createMemoryStateStoreForTests(), now: () => instant, ttlMs });
  const handler = createShopCallbackHandler({ enabled: true, stateManager: manager,
    audit: (event) => audits.push(event), completeAuthorization: async (value) => {
      completions.push(value);
      return complete ? complete(value) : { access_token: TOKEN };
    } });
  const issued = await manager.issue({ contextId: "offline-authenticated-operator" });
  return { handler, manager, issued, audits, completions, advance: (ms) => { instant += ms; } };
}

test("default callback rejects authorization before any state or completion processing", async () => {
  let called = false;
  const events = [];
  const handler = createShopCallbackHandler({ stateManager: { consume() { called = true; } },
    completeAuthorization() { called = true; }, audit: (event) => events.push(event) });
  const result = await invoke(handler, { url: `${CALLBACK_PATH}?code=${CODE}&state=untrusted` });
  assert.equal(result.status, 503);
  assert.equal(called, false);
  assert.deepEqual(events, [{ event: "shop_oauth_unconfigured" }]);
  assert.equal(result.body.includes(CODE), false);
});

test("enabling without a state manager and Shop adapter fails closed", () => {
  assert.throws(() => createShopCallbackHandler({ enabled: true }), /requires state validation/);
  assert.throws(() => createShopCallbackHandler({ enabled: "true" }), /Invalid callback configuration/);
});

test("state is random, hashed in storage, browser-bound, HTTPS-bound and short-lived", async () => {
  let stored;
  const manager = createStateManager({ redirectUri: REDIRECT_URI, now: () => 1000,
    store: { put(record) { stored = record; }, consume() {} } });
  const a = await manager.issue({ contextId: "offline-owner" });
  const b = await manager.issue({ contextId: "offline-owner" });
  assert.match(a.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.state, b.state);
  assert.match(a.cookie, /; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);
  assert.match(stored.stateHash, /^[a-f0-9]{64}$/);
  assert.match(stored.bindingHash, /^[a-f0-9]{64}$/);
  assert.equal(stored.expiresAt, 601000);
  assert.equal(stored.redirectUri, REDIRECT_URI);
  assert.equal(JSON.stringify(stored).includes(b.state), false);
  assert.equal(JSON.stringify(stored).includes(cookieHeader(b).split("=")[1]), false);
});

test("state issuance requires an authenticated initiating context", async () => {
  const manager = createStateManager({ redirectUri: REDIRECT_URI, store: createMemoryStateStoreForTests() });
  await assert.rejects(manager.issue(), /authenticated initiating context/);
  await assert.rejects(manager.issue({ contextId: "" }), /authenticated initiating context/);
});

test("redirect and state-store configuration cannot silently fall back", () => {
  for (const redirectUri of [undefined, "http://callback.example.test" + CALLBACK_PATH,
    REDIRECT_URI + "?code=x", REDIRECT_URI + "#fragment", "https://callback.example.test/ads-callback",
    "https://user:password@callback.example.test" + CALLBACK_PATH]) {
    assert.throws(() => createStateManager({ redirectUri, store: createMemoryStateStoreForTests() }));
  }
  assert.throws(() => createStateManager({ redirectUri: REDIRECT_URI }), /atomic state store/);
  assert.throws(() => createStateManager({ redirectUri: REDIRECT_URI, store: createMemoryStateStoreForTests(), ttlMs: 600001 }), /State lifetime/);
});

test("valid callback passes only the code and server-held context to the configured Shop adapter", async () => {
  const f = await fixture();
  const result = await invoke(f.handler, { url: callbackUrl(f.issued.state), cookie: cookieHeader(f.issued) });
  assert.equal(result.status, 200);
  assert.deepEqual(f.completions, [{ authCode: CODE, contextId: "offline-authenticated-operator", redirectUri: REDIRECT_URI }]);
  assert.deepEqual(f.audits, [{ event: "shop_oauth_completed" }]);
  assert.equal(result.body.includes(TOKEN), false);
  assert.match(result.headers["Set-Cookie"], /Max-Age=0/);
});

test("missing, malformed and unknown state never reaches completion", async () => {
  const f = await fixture();
  for (const state of ["", "invalid", "a".repeat(43)]) {
    const result = await invoke(f.handler, { url: callbackUrl(state), cookie: cookieHeader(f.issued) });
    assert.equal(result.status, 400);
  }
  assert.equal(f.completions.length, 0);
});

test("missing state and duplicate state/code/error parameters are rejected", async () => {
  const f = await fixture();
  for (const suffix of ["code=x", `state=${f.issued.state}&state=${f.issued.state}&code=x`,
    `state=${f.issued.state}&code=x&code=y`, `state=${f.issued.state}&code=x&error=a&error=b`]) {
    assert.equal((await invoke(f.handler, { url: `${CALLBACK_PATH}?${suffix}`, cookie: cookieHeader(f.issued) })).status, 400);
  }
  assert.equal(f.completions.length, 0);
});

test("browser-binding mismatch does not consume the legitimate flow", async () => {
  const f = await fixture();
  const another = await f.manager.issue({ contextId: "another-offline-operator" });
  assert.equal((await invoke(f.handler, { url: callbackUrl(f.issued.state), cookie: cookieHeader(another) })).status, 400);
  assert.equal((await invoke(f.handler, { url: callbackUrl(f.issued.state), cookie: cookieHeader(f.issued) })).status, 200);
  assert.equal(f.completions.length, 1);
});

test("missing, malformed and duplicated binding cookies are rejected", async () => {
  const f = await fixture();
  for (const cookie of [undefined, `${BINDING_COOKIE}=bad`, `${cookieHeader(f.issued)}; ${cookieHeader(f.issued)}`]) {
    assert.equal((await invoke(f.handler, { url: callbackUrl(f.issued.state), cookie })).status, 400);
  }
  assert.equal(f.completions.length, 0);
});

test("expired state cannot reach completion", async () => {
  const f = await fixture();
  f.advance(1000);
  const result = await invoke(f.handler, { url: callbackUrl(f.issued.state), cookie: cookieHeader(f.issued) });
  assert.equal(result.status, 400);
  assert.equal(f.completions.length, 0);
});

test("replayed and simultaneous callbacks have exactly one completion winner", async () => {
  const f = await fixture();
  const request = { url: callbackUrl(f.issued.state), cookie: cookieHeader(f.issued) };
  const pair = await Promise.all([invoke(f.handler, request), invoke(f.handler, request)]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 400]);
  assert.equal((await invoke(f.handler, request)).status, 400);
  assert.equal(f.completions.length, 1);
});

test("documented code=null and error=auth_denied rejects authorization", async () => {
  const f = await fixture();
  const result = await invoke(f.handler, { url: callbackUrl(f.issued.state, "null", { error: "auth_denied" }), cookie: cookieHeader(f.issued) });
  assert.equal(result.status, 403);
  assert.equal(f.completions.length, 0);
  assert.deepEqual(f.audits, [{ event: "shop_oauth_denied" }]);
});

test("denial cannot bypass state and browser verification", async () => {
  const f = await fixture();
  const result = await invoke(f.handler, { url: callbackUrl("a".repeat(43), "null", { error: "auth_denied" }), cookie: cookieHeader(f.issued) });
  assert.equal(result.status, 400);
  assert.deepEqual(f.audits, [{ event: "shop_oauth_invalid_state" }]);
});

test("literal null, missing, oversized and control-character codes are rejected", async () => {
  for (const code of ["null", "NULL", "", "x".repeat(4097), "bad\ncode"]) {
    const f = await fixture();
    assert.equal((await invoke(f.handler, { url: callbackUrl(f.issued.state, code), cookie: cookieHeader(f.issued) })).status, 400);
    assert.equal(f.completions.length, 0);
  }
});

test("Ads auth_code callback shape is not accepted as a Shop callback", async () => {
  const f = await fixture();
  const result = await invoke(f.handler, { url: `${CALLBACK_PATH}?auth_code=${CODE}&state=${f.issued.state}`, cookie: cookieHeader(f.issued) });
  assert.equal(result.status, 400);
  assert.equal(f.completions.length, 0);
});

test("unknown provider error is generic and never echoed", async () => {
  const f = await fixture();
  const result = await invoke(f.handler, { url: callbackUrl(f.issued.state, CODE, { error: TOKEN }), cookie: cookieHeader(f.issued) });
  assert.equal(result.status, 400);
  assert.equal(f.completions.length, 0);
  assert.equal(JSON.stringify({ result, audit: f.audits }).includes(TOKEN), false);
});

test("completion exceptions are redacted and consumed state cannot retry a code", async () => {
  const f = await fixture({ complete: () => { throw new Error(`code=${CODE}; access_token=${TOKEN}`); } });
  const request = { url: callbackUrl(f.issued.state), cookie: cookieHeader(f.issued) };
  const result = await invoke(f.handler, request);
  assert.equal(result.status, 502);
  assert.equal((await invoke(f.handler, request)).status, 400);
  assert.equal(f.completions.length, 1);
  assert.equal(JSON.stringify({ result, audit: f.audits }).includes(CODE), false);
  assert.equal(JSON.stringify({ result, audit: f.audits }).includes(TOKEN), false);
});

test("state-store failure fails closed without exposing its exception", async () => {
  const events = [];
  const handler = createShopCallbackHandler({ enabled: true, audit: (e) => events.push(e),
    stateManager: { consume() { throw new Error(CODE + TOKEN); } },
    completeAuthorization() { assert.fail("Completion must not run."); } });
  const result = await invoke(handler, { url: callbackUrl("a".repeat(43)) });
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify({ result, events }).includes(CODE), false);
  assert.equal(JSON.stringify({ result, events }).includes(TOKEN), false);
});

test("application logging never receives request codes, cookies, state, tokens or exceptions", async (t) => {
  const logs = [];
  for (const method of ["log", "warn", "error", "info", "debug"]) t.mock.method(console, method, (...args) => logs.push(args));
  const f = await fixture({ complete: () => { throw new Error(`${CODE} ${TOKEN}`); } });
  const result = await invoke(f.handler, { url: callbackUrl(f.issued.state), cookie: cookieHeader(f.issued) });
  const visible = JSON.stringify({ logs, result, audits: f.audits });
  for (const value of [CODE, TOKEN, f.issued.state, cookieHeader(f.issued).split("=")[1]]) assert.equal(visible.includes(value), false);
  assert.deepEqual(logs, []);
  assert.deepEqual(f.audits, [{ event: "shop_oauth_completion_failed" }]);
});

test("throwing audit hooks cannot leak or alter an authorization outcome", async () => {
  const result = await invoke(createShopCallbackHandler({ audit() { throw new Error(TOKEN); } }), { url: callbackUrl("a".repeat(43)) });
  assert.equal(result.status, 503);
  assert.equal(result.body.includes(TOKEN), false);
});

test("rejected asynchronous audit hooks are handled without leaking exceptions", async (t) => {
  const logs = [];
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, (...args) => logs.push(args));
  const result = await invoke(createShopCallbackHandler({ audit: async () => { throw new Error(TOKEN); } }),
    { url: callbackUrl("a".repeat(43)) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.status, 503);
  assert.equal(result.body.includes(TOKEN), false);
  assert.deepEqual(logs, []);
});

test("callback responses disable caching, referrers and embedded resources", async () => {
  const result = await invoke(createShopCallbackHandler());
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Referrer-Policy"], "no-referrer");
  assert.match(result.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.equal(result.headers["X-Content-Type-Options"], "nosniff");
});

test("unsupported methods and other routes do not process authorization", async () => {
  const f = await fixture();
  const result = await invoke(f.handler, { method: "POST", url: callbackUrl(f.issued.state) });
  assert.equal(result.status, 405);
  assert.equal(result.headers.Allow, "GET");
  assert.equal((await invoke(f.handler, { url: "/oauth/tiktok/callback?auth_code=x" })).status, 404);
  assert.equal(f.completions.length, 0);
});

test("oversized callback targets are rejected without parsing or echoing values", async () => {
  const result = await invoke(createShopCallbackHandler(), { url: `${CALLBACK_PATH}?code=${CODE}${"x".repeat(8192)}` });
  assert.equal(result.status, 414);
  assert.equal(result.body.includes(CODE), false);
});
