import { describe, expect, it } from 'vitest';
import {
  parseDeviceKeyShareSnapshot,
  type DeviceKeyShareSnapshot,
} from '../../../shared/device-sharing';

function publicKey(label: string): string {
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: `x-${label}`, y: `y-${label}` });
}

function privateKey(label: string): string {
  return JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    x: `x-${label}`,
    y: `y-${label}`,
    d: `d-${label}`,
  });
}

function keyPair(label: string, version: number = 1) {
  return {
    encryption: {
      publicKey: publicKey(`${label}-enc`),
      privateKey: privateKey(`${label}-enc`),
      keyVersion: version,
      algorithm: 'ecdh-p256-v1',
    },
    signing: {
      publicKey: publicKey(`${label}-sig`),
      privateKey: privateKey(`${label}-sig`),
      keyVersion: version,
      algorithm: 'ecdsa-p256-sha256-v1',
    },
  };
}

function snapshot(): DeviceKeyShareSnapshot {
  return {
    version: 1,
    email: 'Agent@Example.com',
    createdAt: '2026-04-14T12:00:00.000Z',
    actors: [
      {
        identity: {
          email: 'agent@example.com',
          slug: 'Agent Bot',
        },
        current: keyPair('current', 2),
        archived: [keyPair('archived', 1)],
      },
    ],
  };
}

describe('device key share snapshot validation', () => {
  it('normalizes and returns deeply validated actor key material', () => {
    const parsed = parseDeviceKeyShareSnapshot(snapshot());

    expect(parsed.email).toBe('agent@example.com');
    expect(parsed.actors[0].identity).toEqual({
      email: 'agent@example.com',
      slug: 'agent-bot',
    });
    expect(parsed.actors[0].current?.encryption.algorithm).toBe('ecdh-p256-v1');
    expect(parsed.actors[0].archived).toHaveLength(1);
  });

  it('rejects malformed key-pair structures before they can be persisted', () => {
    const invalid = snapshot();
    invalid.actors[0].current!.encryption.privateKey = 'not-json';

    expect(() => parseDeviceKeyShareSnapshot(invalid)).toThrow(
      'actors[0].current.encryption.privateKey must be a serialized JWK'
    );
  });

  it('rejects private JWK fields in public key slots', () => {
    const invalid = snapshot();
    invalid.actors[0].current!.encryption.publicKey = privateKey('leaked-public');

    expect(() => parseDeviceKeyShareSnapshot(invalid)).toThrow(
      'actors[0].current.encryption.publicKey must be a P-256 JWK'
    );
  });

  it('rejects unsupported actor key algorithms', () => {
    const invalid = snapshot();
    invalid.actors[0].archived[0].signing.algorithm = 'ed25519-v1';

    expect(() => parseDeviceKeyShareSnapshot(invalid)).toThrow(
      'actors[0].archived[0].signing.algorithm is unsupported'
    );
  });

  it('rejects actor identities outside the shared email namespace', () => {
    const invalid = snapshot();
    invalid.actors[0].identity.email = 'other@example.com';

    expect(() => parseDeviceKeyShareSnapshot(invalid)).toThrow(
      'actors[0].identity.email must match snapshot.email'
    );
  });
});
