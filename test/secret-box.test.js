import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  decryptSecretJson,
  encryptSecretJson,
  parseSecretBoxKey
} from "../src/secret-box.js";

const key = crypto.randomBytes(32).toString("base64url");

test("secret box encrypts authenticated JSON without plaintext leakage", () => {
  const value = { accessToken: "plain-token-sentinel", advertiserIds: ["123"] };
  const blob = encryptSecretJson(value, { key, aad: "credential:cred_1:app_1" });
  assert.equal(blob.includes(Buffer.from("plain-token-sentinel")), false);
  assert.deepEqual(
    decryptSecretJson(blob, { key, aad: "credential:cred_1:app_1" }),
    value
  );
});

test("secret box rejects a different binding and tampering", () => {
  const blob = encryptSecretJson({ accessToken: "token" }, {
    key,
    aad: "credential:cred_1:app_1"
  });
  assert.throws(
    () => decryptSecretJson(blob, { key, aad: "credential:cred_2:app_1" }),
    { code: "SECRET_DECRYPTION_FAILED" }
  );

  const envelope = JSON.parse(blob.toString("utf8"));
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString("base64url");
  assert.throws(
    () => decryptSecretJson(Buffer.from(JSON.stringify(envelope)), {
      key,
      aad: "credential:cred_1:app_1"
    }),
    { code: "SECRET_DECRYPTION_FAILED" }
  );
});

test("secret box requires a canonical 32-byte base64url key", () => {
  assert.equal(parseSecretBoxKey(key).length, 32);
  assert.throws(() => parseSecretBoxKey("short"));
  assert.throws(() => parseSecretBoxKey(`${key}=`));
});
