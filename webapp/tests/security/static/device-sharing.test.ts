import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveVerifiedDeviceShareRequest } from '@/lib/device-share';
import {
  buildDeviceShareContext,
  canonicalizeDeviceVerificationCode,
  createDeviceShareBundle,
  createDeviceVerificationCode,
  decryptDeviceShareBundle,
  formatDeviceVerificationCode,
  generateDeviceKeyPair,
  hashDeviceVerificationCode,
  parseDeviceVerificationCode,
  verifyDeviceVerificationCodeMatchesPublicKey,
  type DeviceKeyShareSnapshot,
} from '../../../../shared/device-sharing';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as Crypto;
}

function buildSampleSnapshot(): DeviceKeyShareSnapshot {
  return {
    version: 1,
    normalizedEmail: 'alice@example.com',
    createdAt: '2026-04-15T00:00:00.000Z',
    actors: [
      {
        identity: {
          normalizedEmail: 'alice@example.com',
          slug: 'alice',
        },
        current: {
          encryption: {
            publicKey: 'enc-public',
            privateKey: 'enc-private',
            keyVersion: 'enc-v1',
            algorithm: 'ecdh-p256-v1',
          },
          signing: {
            publicKey: 'sig-public',
            privateKey: 'sig-private',
            keyVersion: 'sig-v1',
            algorithm: 'ecdsa-p256-sha256-v1',
          },
        },
        archived: [],
      },
    ],
  };
}

function timestampLike(date: Date) {
  return {
    microsSinceUnixEpoch: BigInt(date.getTime()) * 1000n,
  };
}

describe('device sharing verification codes', () => {
  it('uses the exact Matrix emoji table and English labels', () => {
    const parsed = parseDeviceVerificationCode('🐶🐱🦁🐎 🦄🐷🐘🐰');
    const smileyParsed = parseDeviceVerificationCode('🎂❤️😀🤖 🎩👓🔧🎅');

    expect(parsed.formattedCode).toBe('🐶🐱🦁🐎🦄🐷🐘🐰');
    expect(smileyParsed.formattedCode).toBe('🎂❤️😀🤖🎩👓🔧🎅');
    expect(parsed.symbols).toEqual(['🐶', '🐱', '🦁', '🐎', '🦄', '🐷', '🐘', '🐰']);
    expect(parsed.words).toEqual([
      'Dog',
      'Cat',
      'Lion',
      'Horse',
      'Unicorn',
      'Pig',
      'Elephant',
      'Rabbit',
    ]);
    expect(smileyParsed.symbols[2]).toBe('😀');
    expect(smileyParsed.words[2]).toBe('Smiley');
  });

  it('round trips generation, parsing, and formatting for an 8-symbol Matrix code', async () => {
    const requester = await generateDeviceKeyPair();
    const clientCreatedAt = new Date('2026-04-15T12:00:00.000Z');
    const verificationCode = await createDeviceVerificationCode({
      serializedPublicKey: requester.publicKey,
      clientCreatedAt,
    });
    const parsed = parseDeviceVerificationCode(verificationCode);

    expect(parsed.symbols).toHaveLength(8);
    expect(parsed.words).toHaveLength(8);
    expect(parsed.fingerprintHex).toHaveLength(12);
    expect(parsed.formattedCode).not.toContain(' ');
    expect(canonicalizeDeviceVerificationCode(parsed.formattedCode)).toBe(parsed.canonicalCode);
    expect(formatDeviceVerificationCode(parsed.canonicalCode)).toBe(parsed.formattedCode);
  });

  it('hashes canonical and whitespace-variant inputs identically', async () => {
    const requester = await generateDeviceKeyPair();
    const verificationCode = await createDeviceVerificationCode({
      serializedPublicKey: requester.publicKey,
      clientCreatedAt: new Date('2026-04-15T12:00:00.000Z'),
    });
    const parsed = parseDeviceVerificationCode(verificationCode);
    const whitespaceVariant = `${parsed.symbols.slice(0, 4).join('')}  \n${parsed.symbols
      .slice(4)
      .join('')}`;

    await expect(hashDeviceVerificationCode(whitespaceVariant)).resolves.toBe(
      await hashDeviceVerificationCode(parsed.canonicalCode)
    );
  });

  it('is deterministic for the same timestamp and one-time public key, and changes when either changes', async () => {
    const requester = await generateDeviceKeyPair();
    const clientCreatedAt = new Date('2026-04-15T12:00:00.000Z');
    const verificationCode = await createDeviceVerificationCode({
      serializedPublicKey: requester.publicKey,
      clientCreatedAt,
    });

    await expect(
      createDeviceVerificationCode({
        serializedPublicKey: requester.publicKey,
        clientCreatedAt,
      })
    ).resolves.toBe(verificationCode);
    await expect(
      createDeviceVerificationCode({
        serializedPublicKey: requester.publicKey,
        clientCreatedAt: new Date(clientCreatedAt.getTime() + 60_000),
      })
    ).resolves.not.toBe(verificationCode);
    await expect(
      verifyDeviceVerificationCodeMatchesPublicKey({
        code: verificationCode,
        serializedPublicKey: requester.publicKey,
        clientCreatedAt,
      })
    ).resolves.toBe(true);
  });

  it('rejects mismatched public keys even when the lookup token resolves', async () => {
    const requester = await generateDeviceKeyPair();
    const substituted = await generateDeviceKeyPair();
    const clientCreatedAt = new Date(Date.now() - 60_000);
    const verificationCode = await createDeviceVerificationCode({
      serializedPublicKey: requester.publicKey,
      clientCreatedAt,
    });
    const verificationCodeHash = await hashDeviceVerificationCode(verificationCode);

    await expect(
      verifyDeviceVerificationCodeMatchesPublicKey({
        code: verificationCode,
        serializedPublicKey: substituted.publicKey,
        clientCreatedAt,
      })
    ).resolves.toBe(false);

    await expect(
      resolveVerifiedDeviceShareRequest({
        verificationCode,
        liveConnection: {
          procedures: {
            async resolveDeviceShareRequestByCode(params) {
              return params.verificationCodeHash === verificationCodeHash
                ? [
                    {
                      requestId: 7n,
                      deviceId: 'device-substituted',
                      deviceEncryptionPublicKey: substituted.publicKey,
                      clientCreatedAt: timestampLike(clientCreatedAt),
                    },
                  ]
                : [];
            },
          },
        },
      })
    ).rejects.toThrow(/one-time recovery key/i);
  });

  it('resolves a verified request when the returned public key and timestamp match', async () => {
    const requester = await generateDeviceKeyPair();
    const clientCreatedAt = new Date(Date.now() - 60_000);
    const verificationCode = await createDeviceVerificationCode({
      serializedPublicKey: requester.publicKey,
      clientCreatedAt,
    });
    const verificationCodeHash = await hashDeviceVerificationCode(verificationCode);

    await expect(
      resolveVerifiedDeviceShareRequest({
        verificationCode,
        liveConnection: {
          procedures: {
            async resolveDeviceShareRequestByCode(params) {
              return params.verificationCodeHash === verificationCodeHash
                ? [
                    {
                      requestId: 11n,
                      deviceId: 'device-verified',
                      deviceEncryptionPublicKey: requester.publicKey,
                      clientCreatedAt: timestampLike(clientCreatedAt),
                    },
                  ]
                : [];
            },
          },
        },
      })
    ).resolves.toMatchObject({
      requestId: 11n,
      deviceId: 'device-verified',
      deviceEncryptionPublicKey: requester.publicKey,
      clientCreatedAt,
    });
  });

  it('rejects expired requests locally after lookup', async () => {
    const requester = await generateDeviceKeyPair();
    const clientCreatedAt = new Date(Date.now() - 11 * 60_000);
    const verificationCode = await createDeviceVerificationCode({
      serializedPublicKey: requester.publicKey,
      clientCreatedAt,
    });
    const verificationCodeHash = await hashDeviceVerificationCode(verificationCode);

    await expect(
      resolveVerifiedDeviceShareRequest({
        verificationCode,
        liveConnection: {
          procedures: {
            async resolveDeviceShareRequestByCode(params) {
              return params.verificationCodeHash === verificationCodeHash
                ? [
                    {
                      requestId: 13n,
                      deviceId: 'device-expired',
                      deviceEncryptionPublicKey: requester.publicKey,
                      clientCreatedAt: timestampLike(clientCreatedAt),
                    },
                  ]
                : [];
            },
          },
        },
      })
    ).rejects.toThrow(/expired/i);
  });

  it('rejects legacy ASCII codes', async () => {
    expect(() => canonicalizeDeviceVerificationCode('ABCD-EFGH')).toThrow(
      /legacy text auth codes are no longer supported/i
    );
    await expect(hashDeviceVerificationCode('ABCD-EFGH')).rejects.toThrow(
      /legacy text auth codes are no longer supported/i
    );
  });

  it('keeps bundle encryption and decryption compatible after verification changes', async () => {
    const sourceDevice = await generateDeviceKeyPair();
    const targetDevice = await generateDeviceKeyPair();
    const snapshot = buildSampleSnapshot();
    const context = buildDeviceShareContext(snapshot.normalizedEmail, 'device-target');

    const bundle = await createDeviceShareBundle({
      sourceKeyPair: sourceDevice,
      targetPublicKey: targetDevice.publicKey,
      context,
      snapshot,
    });
    const decrypted = await decryptDeviceShareBundle({
      recipientKeyPair: targetDevice,
      sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
      bundleCiphertext: bundle.bundleCiphertext,
      bundleIv: bundle.bundleIv,
      bundleAlgorithm: bundle.bundleAlgorithm,
      context,
    });

    expect(decrypted).toEqual(snapshot);
  });
});
