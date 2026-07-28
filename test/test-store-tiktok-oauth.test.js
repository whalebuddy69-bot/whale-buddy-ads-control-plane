import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DomainError } from '../src/domain.js';
import { SqliteStore } from '../src/store.js';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertCode(code) {
  return (error) => error instanceof DomainError && error.code === code;
}

function encryptOutsideStore(value) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(value, 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

test('TikTok OAuth state is bound, durable, atomic, and one-time', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gmv-max-tiktok-oauth-'));
  const filename = join(directory, 'oauth.sqlite');
  const rawNonce = 'oauth-state-raw-sentinel-4f937a';
  const nonceHash = hash(rawNonce);
  const first = new SqliteStore(filename);
  let created;
  try {
    created = first.createTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      nonceHash,
      createdAt: '2026-07-28T08:00:00.000Z',
      expiresAt: '2026-07-28T08:10:00.000Z',
    });
    assert.equal(created.clientId, 'punpan_020');
    assert.equal(created.lineUserId, 'U-owner');
    assert.equal('nonce' in created, false);
    assert.equal('nonceHash' in created, false);
  } finally {
    first.close();
  }

  const firstConsumer = new SqliteStore(filename);
  const competingConsumer = new SqliteStore(filename);
  try {
    assert.deepEqual(firstConsumer.getTikTokOAuthStateByNonceHash(nonceHash), {
      stateId: created.stateId,
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      createdAt: '2026-07-28T08:00:00.000Z',
      expiresAt: '2026-07-28T08:10:00.000Z',
      consumedAt: null,
    });
    assert.throws(() => firstConsumer.consumeTikTokOAuthState({
      clientId: 'another-client',
      lineUserId: 'U-owner',
      nonceHash,
      consumedAt: '2026-07-28T08:01:00.000Z',
    }), assertCode('TIKTOK_OAUTH_STATE_BINDING_MISMATCH'));
    assert.throws(() => firstConsumer.consumeTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-attacker',
      nonceHash,
      consumedAt: '2026-07-28T08:01:00.000Z',
    }), assertCode('TIKTOK_OAUTH_STATE_BINDING_MISMATCH'));

    const consumed = firstConsumer.consumeTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      nonceHash,
      consumedAt: '2026-07-28T08:01:00.000Z',
    });
    assert.deepEqual(consumed, {
      consumed: true,
      stateId: created.stateId,
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      consumedAt: '2026-07-28T08:01:00.000Z',
    });
    assert.throws(() => competingConsumer.consumeTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      nonceHash,
      consumedAt: '2026-07-28T08:02:00.000Z',
    }), assertCode('TIKTOK_OAUTH_STATE_ALREADY_CONSUMED'));

    const audits = firstConsumer.listAuditEvents()
      .filter((event) => event.eventType.startsWith('TIKTOK_OAUTH_STATE_'));
    assert.deepEqual(audits.map((event) => event.eventType), [
      'TIKTOK_OAUTH_STATE_CREATED',
      'TIKTOK_OAUTH_STATE_CONSUMED',
    ]);
    const serializedAudits = JSON.stringify(audits);
    assert.equal(serializedAudits.includes(rawNonce), false);
    assert.equal(serializedAudits.includes(nonceHash), false);
  } finally {
    competingConsumer.close();
    firstConsumer.close();
  }

  assert.equal(readFileSync(filename).includes(Buffer.from(rawNonce)), false);
});

test('TikTok OAuth state expires at its exact boundary and nonce hashes cannot be reused', () => {
  const store = new SqliteStore();
  const nonceHash = hash('expiring-oauth-state');
  try {
    store.createTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      nonceHash,
      createdAt: '2026-07-28T08:00:00.000Z',
      expiresAt: '2026-07-28T08:10:00.000Z',
    });
    assert.throws(() => store.createTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      nonceHash,
      createdAt: '2026-07-28T08:01:00.000Z',
      expiresAt: '2026-07-28T08:11:00.000Z',
    }), assertCode('TIKTOK_OAUTH_STATE_REUSED'));
    assert.throws(() => store.consumeTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      nonceHash,
      consumedAt: '2026-07-28T08:10:00.000Z',
    }), assertCode('TIKTOK_OAUTH_STATE_EXPIRED'));

    const callbackHash = hash('callback-derives-durable-binding');
    const callbackState = store.createTikTokOAuthState({
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      nonceHash: callbackHash,
      createdAt: '2026-07-28T08:20:00.000Z',
      expiresAt: '2026-07-28T08:30:00.000Z',
    });
    assert.deepEqual(store.consumeTikTokOAuthState({
      nonceHash: callbackHash,
      consumedAt: '2026-07-28T08:21:00.000Z',
    }), {
      consumed: true,
      stateId: callbackState.stateId,
      clientId: 'punpan_020',
      lineUserId: 'U-owner',
      consumedAt: '2026-07-28T08:21:00.000Z',
    });
  } finally {
    store.close();
  }
});

test('encrypted TikTok credentials remap advertisers without revoking shared grants early', () => {
  const store = new SqliteStore();
  try {
    const oldCredential = store.saveTikTokCredential({
      credentialRef: 'tcred-old',
      clientId: 'punpan_020',
      appId: '2010756294',
      advertiserIds: ['advertiser-a', 'advertiser-b'],
      encryptedBlob: randomBytes(96),
      createdAt: '2026-07-28T08:00:00.000Z',
      updatedAt: '2026-07-28T08:00:00.000Z',
    });
    assert.deepEqual(oldCredential.advertiserIds, ['advertiser-a', 'advertiser-b']);
    assert(Object.isFrozen(oldCredential));
    assert(Object.isFrozen(oldCredential.advertiserIds));

    store.saveTikTokCredential({
      credentialRef: 'tcred-a',
      clientId: 'punpan_020',
      appId: '2010756294',
      advertiserIds: ['advertiser-a'],
      encryptedBlob: randomBytes(96),
      createdAt: '2026-07-28T08:05:00.000Z',
      updatedAt: '2026-07-28T08:05:00.000Z',
    });
    assert.equal(
      store.getTikTokCredentialByAdvertiserId('advertiser-a').credentialRef,
      'tcred-a',
    );
    assert.equal(
      store.getTikTokCredentialByAdvertiserId({ advertiserId: 'advertiser-b' }).credentialRef,
      'tcred-old',
    );
    assert.equal(store.getTikTokCredential({ credentialRef: 'tcred-old' }).revokedAt, null);

    store.saveTikTokCredential({
      credentialRef: 'tcred-b',
      clientId: 'punpan_020',
      appId: '2010756294',
      advertiserIds: ['advertiser-b'],
      encryptedBlob: randomBytes(96),
      createdAt: '2026-07-28T08:06:00.000Z',
      updatedAt: '2026-07-28T08:06:00.000Z',
    });
    const replaced = store.getTikTokCredential({ credentialRef: 'tcred-old' });
    assert.equal(replaced.revokedAt, '2026-07-28T08:06:00.000Z');
    assert.equal(replaced.replacedByCredentialRef, 'tcred-b');
    assert.equal(
      store.getTikTokCredentialByAdvertiserId({ advertiserId: 'advertiser-b' }).credentialRef,
      'tcred-b',
    );

    assert.throws(() => store.saveTikTokCredential({
      credentialRef: 'tcred-cross-client',
      clientId: 'wrong-client',
      appId: '2010756294',
      advertiserIds: ['advertiser-a'],
      encryptedBlob: randomBytes(96),
      createdAt: '2026-07-28T08:07:00.000Z',
      updatedAt: '2026-07-28T08:07:00.000Z',
    }), assertCode('TIKTOK_ADVERTISER_OWNERSHIP_CONFLICT'));
    assert.equal(
      store.getTikTokCredentialByAdvertiserId({ advertiserId: 'advertiser-a' }).credentialRef,
      'tcred-a',
    );
    assert.equal(
      store.getTikTokCredential({ credentialRef: 'tcred-cross-client' }),
      null,
    );

    const revoked = store.revokeTikTokCredential({
      credentialRef: 'tcred-a',
      revokedAt: '2026-07-28T08:08:00.000Z',
    });
    assert.equal(revoked.revokedAt, '2026-07-28T08:08:00.000Z');
    assert.equal(
      store.getTikTokCredentialByAdvertiserId({ advertiserId: 'advertiser-a' }),
      null,
    );
    assert.equal(store.revokeTikTokCredential({
      credentialRef: 'tcred-a',
      revokedAt: '2026-07-28T08:09:00.000Z',
    }).revokedAt, '2026-07-28T08:08:00.000Z');
  } finally {
    store.close();
  }
});

test('credential database stores only the opaque encrypted blob and non-secret routing metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gmv-max-tiktok-credential-'));
  const filename = join(directory, 'credential.sqlite');
  const plaintextSentinel = JSON.stringify({
    accessToken: 'access-token-plaintext-sentinel-9143',
    refreshToken: 'refresh-token-plaintext-sentinel-2048',
    expiresAt: '2026-08-01T00:00:00.000Z',
    refreshMetadata: { refreshTokenExpiresAt: '2026-09-01T00:00:00.000Z' },
  });
  const encryptedBlob = encryptOutsideStore(plaintextSentinel);
  const store = new SqliteStore(filename);
  try {
    assert.throws(() => store.saveTikTokCredential({
      credentialRef: 'plaintext-rejected',
      clientId: 'punpan_020',
      appId: '2010756294',
      advertiserIds: ['advertiser-a'],
      encryptedBlob: plaintextSentinel,
      createdAt: '2026-07-28T08:00:00.000Z',
      updatedAt: '2026-07-28T08:00:00.000Z',
    }), assertCode('INVALID_REQUEST'));

    store.saveTikTokCredential({
      credentialRef: 'encrypted-credential',
      clientId: 'punpan_020',
      appId: '2010756294',
      advertiserIds: ['advertiser-a'],
      encryptedBlob,
      createdAt: '2026-07-28T08:00:00.000Z',
      updatedAt: '2026-07-28T08:00:00.000Z',
    });
    assert.deepEqual(
      store.getTikTokCredential({ credentialRef: 'encrypted-credential' }).encryptedBlob,
      encryptedBlob,
    );
    const auditJson = JSON.stringify(store.listAuditEvents({
      eventType: 'TIKTOK_CREDENTIAL_SAVED',
    }));
    assert.equal(auditJson.includes('access-token-plaintext-sentinel-9143'), false);
    assert.equal(auditJson.includes(encryptedBlob.toString('hex')), false);
  } finally {
    store.close();
  }

  const raw = new DatabaseSync(filename, { readOnly: true });
  try {
    const columns = raw.prepare('PRAGMA table_info(tiktok_credentials)').all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      'credential_ref',
      'client_id',
      'app_id',
      'advertiser_ids_json',
      'encrypted_blob',
      'created_at',
      'updated_at',
      'revoked_at',
      'replaced_by_credential_ref',
    ]);
    assert.equal(
      raw.prepare(`
        SELECT typeof(encrypted_blob) AS type
        FROM tiktok_credentials
        WHERE credential_ref = 'encrypted-credential'
      `).get().type,
      'blob',
    );
  } finally {
    raw.close();
  }

  const databaseFiles = [filename, `${filename}-wal`, `${filename}-shm`]
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => readFileSync(candidate));
  const rawBytes = Buffer.concat(databaseFiles);
  assert.equal(rawBytes.includes(Buffer.from('access-token-plaintext-sentinel-9143')), false);
  assert.equal(rawBytes.includes(Buffer.from('refresh-token-plaintext-sentinel-2048')), false);
  assert.equal(rawBytes.includes(Buffer.from('2026-08-01T00:00:00.000Z')), false);
});
