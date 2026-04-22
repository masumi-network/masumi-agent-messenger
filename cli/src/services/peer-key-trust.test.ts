import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  comparePeerKeys,
  confirmPeerRotation,
  emptyPeerKeyTrustStore,
  isKeyTupleKnown,
  isSigningKeyVersionTrusted,
  listPinnedPeers,
  parsePersistedPeerKeyTrustStore,
  parsePeerKeyTrustStore,
  PeerKeyTrustStoreParseError,
  pinPeerKeys,
  unpinPeer,
  type PeerKeyTuple,
} from '../../../shared/peer-key-trust';
import { autoPinPeerIfUnknown as autoPinPeerIfUnknownInStore } from './peer-key-trust';

const tupleA: PeerKeyTuple = {
  encryptionPublicKey: 'enc-A',
  encryptionKeyVersion: 'v1',
  signingPublicKey: 'sig-A',
  signingKeyVersion: 'v1',
};

const tupleBRotatedKeys: PeerKeyTuple = {
  encryptionPublicKey: 'enc-B',
  encryptionKeyVersion: 'v2',
  signingPublicKey: 'sig-B',
  signingKeyVersion: 'v2',
};

const tupleCSigningOnly: PeerKeyTuple = {
  encryptionPublicKey: 'enc-A',
  encryptionKeyVersion: 'v1',
  signingPublicKey: 'sig-C',
  signingKeyVersion: 'v3',
};

describe('peer-key-trust', () => {
  it('reports unpinned peers as unpinned', () => {
    const store = emptyPeerKeyTrustStore();
    expect(comparePeerKeys(store, 'alice', tupleA).status).toBe('unpinned');
  });

  it('pins first observation and recognizes matches', () => {
    const pinned = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18');
    const cmp = comparePeerKeys(pinned, 'alice', tupleA);
    expect(cmp.status).toBe('matches');
  });

  it('detects rotation when the pinned tuple changes', () => {
    const pinned = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18');
    const cmp = comparePeerKeys(pinned, 'alice', tupleBRotatedKeys);
    expect(cmp.status).toBe('rotated');
    if (cmp.status !== 'rotated') return;
    expect(cmp.diff.encryptionKeyVersionChanged).toBe(true);
    expect(cmp.diff.signingKeyVersionChanged).toBe(true);
  });

  it('detects partial rotation (signing only)', () => {
    const pinned = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18');
    const cmp = comparePeerKeys(pinned, 'alice', tupleCSigningOnly);
    expect(cmp.status).toBe('rotated');
    if (cmp.status !== 'rotated') return;
    expect(cmp.diff.signingKeyVersionChanged).toBe(true);
    expect(cmp.diff.signingPublicKeyChanged).toBe(true);
    expect(cmp.diff.encryptionKeyVersionChanged).toBe(false);
  });

  it('promotes a confirmed rotation and retains history', () => {
    const pinned = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18T10:00:00Z');
    const confirmed = confirmPeerRotation(pinned, 'alice', tupleBRotatedKeys, '2026-04-18T11:00:00Z');
    const cmp = comparePeerKeys(confirmed, 'alice', tupleBRotatedKeys);
    expect(cmp.status).toBe('matches');
    const record = confirmed.peers.alice;
    expect(record).toBeDefined();
    expect(record?.history).toHaveLength(2);
  });

  it('treats historical tuples as known for inbound trust', () => {
    const pinned = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18T10:00:00Z');
    const rotated = confirmPeerRotation(pinned, 'alice', tupleBRotatedKeys, '2026-04-18T11:00:00Z');
    expect(isKeyTupleKnown(rotated, 'alice', tupleA)).toBe(true);
    expect(isKeyTupleKnown(rotated, 'alice', tupleBRotatedKeys)).toBe(true);
  });

  it('trusts historical signing key versions for signature verification', () => {
    const pinned = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18T10:00:00Z');
    const rotated = confirmPeerRotation(pinned, 'alice', tupleBRotatedKeys, '2026-04-18T11:00:00Z');
    expect(
      isSigningKeyVersionTrusted(rotated, 'alice', 'v1', 'sig-A')
    ).toBe(true);
    expect(
      isSigningKeyVersionTrusted(rotated, 'alice', 'v2', 'sig-B')
    ).toBe(true);
    expect(
      isSigningKeyVersionTrusted(rotated, 'alice', 'v2', 'sig-WRONG')
    ).toBe(false);
  });

  it('unpin removes the peer entry', () => {
    const pinned = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18');
    const removed = unpinPeer(pinned, 'alice');
    expect(comparePeerKeys(removed, 'alice', tupleA).status).toBe('unpinned');
  });

  it('listPinnedPeers returns sorted entries', () => {
    const store = pinPeerKeys(
      pinPeerKeys(emptyPeerKeyTrustStore(), 'zara', tupleA, '2026-04-18'),
      'alice',
      tupleBRotatedKeys,
      '2026-04-18'
    );
    expect(listPinnedPeers(store).map(entry => entry.publicIdentity)).toEqual(['alice', 'zara']);
  });

  it('parsePeerKeyTrustStore recovers a well-formed store', () => {
    const store = pinPeerKeys(emptyPeerKeyTrustStore(), 'alice', tupleA, '2026-04-18');
    const roundTripped = parsePeerKeyTrustStore(JSON.parse(JSON.stringify(store)));
    expect(roundTripped).toEqual(store);
  });

  it('parsePeerKeyTrustStore returns an empty store on malformed input', () => {
    expect(parsePeerKeyTrustStore(null)).toEqual(emptyPeerKeyTrustStore());
    expect(parsePeerKeyTrustStore({ version: 99 })).toEqual(emptyPeerKeyTrustStore());
    expect(parsePeerKeyTrustStore({ version: 1, peers: 'bad' })).toEqual(emptyPeerKeyTrustStore());
  });

  it('parsePersistedPeerKeyTrustStore fails closed on malformed persisted input', () => {
    expect(() => parsePersistedPeerKeyTrustStore(null)).toThrow(PeerKeyTrustStoreParseError);
    expect(() => parsePersistedPeerKeyTrustStore({ version: 99 })).toThrow(
      PeerKeyTrustStoreParseError
    );
    expect(() => parsePersistedPeerKeyTrustStore({ version: 1, peers: 'bad' })).toThrow(
      PeerKeyTrustStoreParseError
    );
    expect(() =>
      parsePersistedPeerKeyTrustStore({
        version: 1,
        peers: {
          alice: {
            publicIdentity: 'mallory',
            pinnedAt: '2026-04-18',
            current: tupleA,
            history: [{ ...tupleA, confirmedAt: '2026-04-18' }],
          },
        },
      })
    ).toThrow(PeerKeyTrustStoreParseError);
  });

  it('returns the locked comparison when another process pins first', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'peer-key-trust-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const results = await Promise.all([
        autoPinPeerIfUnknownInStore('alice', tupleA),
        autoPinPeerIfUnknownInStore('alice', tupleBRotatedKeys),
      ]);

      expect(results.map(result => result.status).sort()).toEqual(['rotated', 'unpinned']);
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
