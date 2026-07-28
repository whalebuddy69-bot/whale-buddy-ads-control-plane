import crypto from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

export function parseSecretBoxKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("secret-box key must be 32 random bytes encoded as unpadded base64url");
  }
  const key = Buffer.from(value, "base64url");
  if (key.length !== KEY_BYTES || key.toString("base64url") !== value) {
    throw new Error("secret-box key must be canonical unpadded base64url");
  }
  return key;
}

function normalizedKey(key) {
  if (Buffer.isBuffer(key) && key.length === KEY_BYTES) return key;
  return parseSecretBoxKey(key);
}

function normalizedAad(aad) {
  if (typeof aad !== "string" || aad.length < 1 || aad.length > 1_000) {
    throw new Error("secret-box aad must be a non-empty bounded string");
  }
  return Buffer.from(aad, "utf8");
}

export function encryptSecretJson(value, { key, aad }) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", normalizedKey(key), nonce, {
    authTagLength: TAG_BYTES
  });
  cipher.setAAD(normalizedAad(aad));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    v: ENVELOPE_VERSION,
    alg: "A256GCM",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
  plaintext.fill(0);
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

export function decryptSecretJson(encryptedBlob, { key, aad }) {
  if (!Buffer.isBuffer(encryptedBlob) || encryptedBlob.length < 1 || encryptedBlob.length > 1_000_000) {
    throw new Error("encrypted secret blob is invalid");
  }
  let envelope;
  try {
    envelope = JSON.parse(encryptedBlob.toString("utf8"));
  } catch {
    throw new Error("encrypted secret envelope is invalid");
  }
  if (
    envelope?.v !== ENVELOPE_VERSION
    || envelope?.alg !== "A256GCM"
    || typeof envelope.nonce !== "string"
    || typeof envelope.ciphertext !== "string"
    || typeof envelope.tag !== "string"
  ) {
    throw new Error("encrypted secret envelope is unsupported");
  }
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("encrypted secret envelope is malformed");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", normalizedKey(key), nonce, {
      authTagLength: TAG_BYTES
    });
    decipher.setAAD(normalizedAad(aad));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  } catch (cause) {
    const error = new Error("encrypted secret could not be authenticated");
    error.code = "SECRET_DECRYPTION_FAILED";
    error.cause = cause;
    throw error;
  }
}
