import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  autoPinPeerIfUnknown,
  comparePinnedPeer,
  confirmPeerKeyRotation,
  pinFirstObservation,
  unpinPeerKeys,
} from '../../../src/lib/peer-key-trust';

type StorageHolder = { localStorage: Storage } & typeof globalThis;

function installLocalStoragePolyfill(): void {
  const store = new Map<string, string>();
  const polyfill: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
  (globalThis as StorageHolder).localStorage = polyfill;
}

function clearLocalStoragePolyfill(): void {
  delete (globalThis as { localStorage?: Storage }).localStorage;
}

const PUBLIC_IDENTITY = 'peer-public-identity';

function tuple(version: number) {
  return {
    encryptionPublicKey: `enc-key-v${version}`,
    encryptionKeyVersion: version,
    signingPublicKey: `sig-key-v${version}`,
    signingKeyVersion: version,
  };
}

describe('webapp peer key trust — receiver auto-confirm', () => {
  beforeEach(() => {
    installLocalStoragePolyfill();
  });

  afterEach(() => {
    clearLocalStoragePolyfill();
  });

  it('flags a rotated tuple as `rotation-pending` against a pinned peer', () => {
    pinFirstObservation(PUBLIC_IDENTITY, tuple(1));

    const comparison = comparePinnedPeer(PUBLIC_IDENTITY, tuple(2));
    expect(comparison.status).toBe('rotated');
  });

  it('updates the local trust store when `confirmPeerKeyRotation` is called for a known peer', () => {
    pinFirstObservation(PUBLIC_IDENTITY, tuple(1));
    expect(comparePinnedPeer(PUBLIC_IDENTITY, tuple(2)).status).toBe('rotated');

    confirmPeerKeyRotation(PUBLIC_IDENTITY, tuple(2));

    expect(comparePinnedPeer(PUBLIC_IDENTITY, tuple(2)).status).toBe('matches');
    // The previous tuple is no longer the trusted current — only history.
    expect(comparePinnedPeer(PUBLIC_IDENTITY, tuple(1)).status).not.toBe('matches');
  });

  it('auto-pins on first observation rather than throwing for unknown peers', () => {
    expect(comparePinnedPeer(PUBLIC_IDENTITY, tuple(1)).status).toBe('unpinned');

    const result = autoPinPeerIfUnknown(PUBLIC_IDENTITY, tuple(1));
    expect(result.status).toBe('unpinned');
    expect(comparePinnedPeer(PUBLIC_IDENTITY, tuple(1)).status).toBe('matches');
  });

  it('handles confirming a rotation for a peer that was never pinned by treating the new tuple as current', () => {
    // Matches the runtime path where a rotation marker arrives on an inbound message
    // for a peer the local device has not yet observed. The receiver-gated trust model
    // should not throw — it should accept the tuple silently.
    expect(() => confirmPeerKeyRotation(PUBLIC_IDENTITY, tuple(3))).not.toThrow();
    expect(comparePinnedPeer(PUBLIC_IDENTITY, tuple(3)).status).toBe('matches');
  });

  it('clears the pin via unpin, restoring `unpinned` state', () => {
    pinFirstObservation(PUBLIC_IDENTITY, tuple(1));
    expect(unpinPeerKeys(PUBLIC_IDENTITY)).toBe(true);
    expect(comparePinnedPeer(PUBLIC_IDENTITY, tuple(1)).status).toBe('unpinned');
  });
});
