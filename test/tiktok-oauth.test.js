import assert from "node:assert/strict";
import test from "node:test";
import { TikTokOAuthClient, TikTokOAuthError } from "../src/tiktok-oauth.js";

const NOW = Date.parse("2026-07-28T10:00:00.000Z");
const REDIRECT_URI = "https://automation.whalebuddy69.com/oauth/tiktok/callback";
const APP_SECRET = "app-secret-value";
const STATE_SECRET = "state-secret-with-more-than-thirty-two-bytes";
const ACCESS_TOKEN = "access-token-value";
const FIXED_NONCE_BYTES = Buffer.alloc(32, 7);

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function client(overrides = {}) {
  return new TikTokOAuthClient({
    appId: "2010756294",
    appSecret: APP_SECRET,
    stateSecret: STATE_SECRET,
    redirectUri: REDIRECT_URI,
    clock: () => NOW,
    randomBytesImpl: () => FIXED_NONCE_BYTES,
    fetchImpl: async () => {
      throw new Error("unexpected fetch");
    },
    ...overrides
  });
}

function authorization(oauthClient) {
  const request = oauthClient.createAuthorizationRequest();
  return { request, callback: { state: request.state, expectedNonce: request.nonce } };
}

test("builds the official authorization URL with an HMAC-signed state", () => {
  const oauthClient = client();
  const request = oauthClient.createAuthorizationRequest();
  const url = new URL(request.url);

  assert.equal(url.origin, "https://business-api.tiktok.com");
  assert.equal(url.pathname, "/portal/auth");
  assert.equal(url.searchParams.get("app_id"), "2010756294");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(request.issuedAt, NOW);
  assert.equal(request.expiresAt, NOW + 10 * 60 * 1_000);
  assert.ok(!request.url.includes(APP_SECRET));
  assert.ok(!request.url.includes(STATE_SECRET));
});

test("verifies state only when nonce, redirect URI, signature, and lifetime match", () => {
  const oauthClient = client();
  const request = oauthClient.createAuthorizationRequest();
  const verified = oauthClient.verifyAuthorizationState({
    state: request.state,
    expectedNonce: request.nonce,
    redirectUri: REDIRECT_URI
  });

  assert.deepEqual(verified, {
    nonce: request.nonce,
    issuedAt: NOW,
    redirectUri: REDIRECT_URI,
    expiresAt: NOW + 10 * 60 * 1_000
  });
  assert.ok(Object.isFrozen(verified));
});

test("rejects a state whose HMAC was tampered with", () => {
  const oauthClient = client();
  const request = oauthClient.createAuthorizationRequest();
  const finalCharacter = request.state.endsWith("A") ? "B" : "A";
  const tampered = `${request.state.slice(0, -1)}${finalCharacter}`;

  assert.throws(
    () => oauthClient.verifyAuthorizationState({
      state: tampered,
      expectedNonce: request.nonce
    }),
    (error) => error instanceof TikTokOAuthError && error.code === "TIKTOK_OAUTH_INVALID_STATE"
  );
});

test("rejects state replayed with another server-side nonce", () => {
  const oauthClient = client();
  const request = oauthClient.createAuthorizationRequest();
  const otherNonce = Buffer.alloc(32, 9).toString("base64url");

  assert.throws(
    () => oauthClient.verifyAuthorizationState({
      state: request.state,
      expectedNonce: otherNonce
    }),
    (error) => error.code === "TIKTOK_OAUTH_INVALID_STATE"
  );
});

test("rejects state replayed against another callback URI", () => {
  const oauthClient = client();
  const request = oauthClient.createAuthorizationRequest();

  assert.throws(
    () => oauthClient.verifyAuthorizationState({
      state: request.state,
      expectedNonce: request.nonce,
      redirectUri: "https://attacker.example/oauth/callback"
    }),
    (error) => error.code === "TIKTOK_OAUTH_INVALID_STATE"
  );
});

test("rejects expired and implausibly future-dated state", () => {
  let now = NOW;
  const oauthClient = client({
    clock: () => now,
    stateMaxAgeMs: 1_000,
    clockSkewMs: 100
  });
  const request = oauthClient.createAuthorizationRequest();

  now = NOW + 1_001;
  assert.throws(
    () => oauthClient.verifyAuthorizationState({
      state: request.state,
      expectedNonce: request.nonce
    }),
    (error) => error.code === "TIKTOK_OAUTH_INVALID_STATE"
  );

  now = NOW - 101;
  assert.throws(
    () => oauthClient.verifyAuthorizationState({
      state: request.state,
      expectedNonce: request.nonce
    }),
    (error) => error.code === "TIKTOK_OAUTH_INVALID_STATE"
  );
});

test("requires a separate state signing secret with at least 32 bytes", () => {
  assert.throws(
    () => client({ stateSecret: "too-short" }),
    /at least 32 bytes/
  );
});

test("exchanges a verified code with the official JSON body and normalizes tokens", async () => {
  let captured;
  const oauthClient = client({
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response({
        code: 0,
        message: "OK",
        request_id: "oauth-request-1",
        data: {
          access_token: ACCESS_TOKEN,
          refresh_token: "refresh-token-value",
          advertiser_ids: ["7646832328389263378"],
          scope: "campaign.read,campaign.write",
          expires_in: 86_400,
          refresh_token_expires_in: 31_536_000,
          token_type: "Bearer"
        }
      });
    }
  });
  const { request, callback } = authorization(oauthClient);

  const result = await oauthClient.exchangeAuthorizationCode({
    authCode: "one-time-auth-code",
    ...callback
  });

  assert.equal(captured.url, "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.equal(captured.options.headers.Accept, "application/json");
  assert.ok(captured.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(captured.options.body), {
    app_id: "2010756294",
    secret: APP_SECRET,
    auth_code: "one-time-auth-code"
  });
  assert.equal(result.accessToken, ACCESS_TOKEN);
  assert.equal(result.refreshToken, "refresh-token-value");
  assert.deepEqual(result.advertiserIds, ["7646832328389263378"]);
  assert.deepEqual(result.scopes, ["campaign.read", "campaign.write"]);
  assert.equal(result.expiresInSeconds, 86_400);
  assert.equal(result.refreshTokenExpiresInSeconds, 31_536_000);
  assert.equal(result.tokenType, "Bearer");
  assert.equal(result.requestId, "oauth-request-1");
  assert.equal(result.verifiedState.nonce, request.nonce);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.advertiserIds));
});

test("never sends a code exchange until OAuth state has been verified", async () => {
  let calls = 0;
  const oauthClient = client({
    fetchImpl: async () => {
      calls += 1;
      return response({});
    }
  });
  const request = oauthClient.createAuthorizationRequest();

  await assert.rejects(
    () => oauthClient.exchangeAuthorizationCode({
      authCode: "one-time-auth-code",
      state: request.state,
      expectedNonce: Buffer.alloc(32, 8).toString("base64url")
    }),
    (error) => error.code === "TIKTOK_OAUTH_INVALID_STATE"
  );
  assert.equal(calls, 0);
});

test("fails closed on a successful envelope with a malformed token body", async () => {
  const oauthClient = client({
    fetchImpl: async () => response({
      code: 0,
      request_id: "oauth-malformed",
      data: { advertiser_ids: ["adv"] }
    })
  });
  const { callback } = authorization(oauthClient);

  await assert.rejects(
    () => oauthClient.exchangeAuthorizationCode({
      authCode: "one-time-auth-code",
      ...callback
    }),
    (error) => {
      assert.equal(error.code, "TIKTOK_OAUTH_MALFORMED_TOKEN_RESPONSE");
      assert.equal(error.requestId, "oauth-malformed");
      assert.equal(error.outcomeKnown, false);
      return true;
    }
  );
});

test("uses GET only for advertiser grants and normalizes the complete list", async () => {
  let captured;
  const oauthClient = client({
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response({
        code: 0,
        message: "OK",
        request_id: "grant-request-1",
        data: {
          list: [
            {
              advertiser_id: "7646832328389263378",
              advertiser_name: "punpan_020"
            },
            {
              advertiser_id: "7000000000000000001",
              advertiser_name: "Second Client"
            }
          ]
        }
      });
    }
  });

  const result = await oauthClient.getAdvertiserGrant({ accessToken: ACCESS_TOKEN });
  const url = new URL(captured.url);

  assert.equal(url.origin, "https://business-api.tiktok.com");
  assert.equal(url.pathname, "/open_api/v1.3/oauth2/advertiser/get/");
  assert.equal(url.searchParams.get("app_id"), "2010756294");
  assert.equal(url.searchParams.get("secret"), APP_SECRET);
  assert.equal(captured.options.method, "GET");
  assert.equal(captured.options.headers["Access-Token"], ACCESS_TOKEN);
  assert.equal(captured.options.headers.Accept, "application/json");
  assert.equal(captured.options.headers["Content-Type"], undefined);
  assert.equal(captured.options.body, undefined);
  assert.deepEqual(result.advertisers, [
    { advertiserId: "7646832328389263378", advertiserName: "punpan_020" },
    { advertiserId: "7000000000000000001", advertiserName: "Second Client" }
  ]);
  assert.deepEqual(result.advertiserIds, [
    "7646832328389263378",
    "7000000000000000001"
  ]);
  assert.equal(result.requestId, "grant-request-1");
});

test("fails closed when advertiser grant rows are missing or duplicated", async (t) => {
  await t.test("missing list", async () => {
    const oauthClient = client({
      fetchImpl: async () => response({
        code: 0,
        request_id: "grant-missing",
        data: {}
      })
    });
    await assert.rejects(
      () => oauthClient.getAdvertiserGrant({ accessToken: ACCESS_TOKEN }),
      (error) => error.code === "TIKTOK_OAUTH_MALFORMED_GRANT_RESPONSE"
    );
  });

  await t.test("duplicate advertiser", async () => {
    const oauthClient = client({
      fetchImpl: async () => response({
        code: 0,
        request_id: "grant-duplicate",
        data: {
          list: [
            { advertiser_id: "adv", advertiser_name: "A" },
            { advertiser_id: "adv", advertiser_name: "A again" }
          ]
        }
      })
    });
    await assert.rejects(
      () => oauthClient.getAdvertiserGrant({ accessToken: ACCESS_TOKEN }),
      (error) => error.code === "TIKTOK_OAUTH_MALFORMED_GRANT_RESPONSE"
    );
  });
});

test("redacts secrets, codes, tokens, and untrusted TikTok messages from errors", async () => {
  const authCode = "sensitive-auth-code";
  const untrustedMessage = `leak ${APP_SECRET} ${authCode} ${ACCESS_TOKEN}`;
  const oauthClient = client({
    fetchImpl: async () => response({
      code: 40001,
      message: untrustedMessage,
      request_id: "safe-request-id"
    })
  });
  const { callback } = authorization(oauthClient);

  await assert.rejects(
    () => oauthClient.exchangeAuthorizationCode({ authCode, ...callback }),
    (error) => {
      const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
      assert.equal(error.code, "TIKTOK_OAUTH_API_ERROR");
      assert.equal(error.apiCode, 40001);
      assert.equal(error.requestId, "safe-request-id");
      assert.ok(!serialized.includes(APP_SECRET));
      assert.ok(!serialized.includes(authCode));
      assert.ok(!serialized.includes(ACCESS_TOKEN));
      assert.ok(!serialized.includes(untrustedMessage));
      assert.equal("payload" in error, false);
      assert.equal("cause" in error, false);
      return true;
    }
  );
});

test("does not expose private secrets when the client is serialized", () => {
  assert.equal(JSON.stringify(client()), "{}");
  assert.ok(!String(client()).includes(APP_SECRET));
  assert.ok(!String(client()).includes(STATE_SECRET));
});

test("times out a hung OAuth request without retaining the fetch error as a cause", async () => {
  const oauthClient = client({
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      const keepEventLoopAlive = setInterval(() => {}, 1_000);
      options.signal.addEventListener("abort", () => {
        clearInterval(keepEventLoopAlive);
        reject(options.signal.reason);
      }, { once: true });
    })
  });
  const { callback } = authorization(oauthClient);

  await assert.rejects(
    () => oauthClient.exchangeAuthorizationCode({
      authCode: "one-time-auth-code",
      ...callback
    }),
    (error) => {
      assert.equal(error.code, "TIKTOK_OAUTH_TIMEOUT");
      assert.equal(error.outcomeKnown, false);
      assert.equal("cause" in error, false);
      return true;
    }
  );
});

test("fails closed on invalid JSON and missing request IDs", async (t) => {
  await t.test("invalid JSON", async () => {
    const oauthClient = client({
      fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 200 })
    });
    await assert.rejects(
      () => oauthClient.getAdvertiserGrant({ accessToken: ACCESS_TOKEN }),
      (error) => error.code === "TIKTOK_OAUTH_INVALID_RESPONSE"
    );
  });

  await t.test("missing request ID", async () => {
    const oauthClient = client({
      fetchImpl: async () => response({ code: 0, data: { list: [] } })
    });
    await assert.rejects(
      () => oauthClient.getAdvertiserGrant({ accessToken: ACCESS_TOKEN }),
      (error) => error.code === "TIKTOK_OAUTH_INVALID_RESPONSE"
    );
  });
});
