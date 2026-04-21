export type PeerKeyTuple = {
  encryptionPublicKey: string;
  encryptionKeyVersion: string;
  signingPublicKey: string;
  signingKeyVersion: string;
};

export type PinnedPeer = {
  publicIdentity: string;
  pinnedAt: string;
  current: PeerKeyTuple;
  history: Array<PeerKeyTuple & { confirmedAt: string }>;
};

export type PeerKeyTrustStore = {
  version: 1;
  peers: Record<string, PinnedPeer>;
};

export type PeerKeyComparison =
  | { status: 'unpinned' }
  | { status: 'matches'; pinned: PinnedPeer }
  | { status: 'rotated'; pinned: PinnedPeer; diff: PeerKeyTupleDiff };

export type PeerKeyTupleDiff = {
  encryptionKeyVersionChanged: boolean;
  encryptionPublicKeyChanged: boolean;
  signingKeyVersionChanged: boolean;
  signingPublicKeyChanged: boolean;
};

export const PEER_KEY_TRUST_STORE_VERSION = 1 as const;

export class PeerKeyTrustStoreParseError extends Error {
  constructor(message = 'Peer key trust store is malformed') {
    super(message);
    this.name = 'PeerKeyTrustStoreParseError';
  }
}

export function emptyPeerKeyTrustStore(): PeerKeyTrustStore {
  return { version: PEER_KEY_TRUST_STORE_VERSION, peers: {} };
}

export function tupleFromActorLike(actor: {
  currentEncryptionPublicKey: string;
  currentEncryptionKeyVersion: string;
  currentSigningPublicKey: string;
  currentSigningKeyVersion: string;
}): PeerKeyTuple {
  return {
    encryptionPublicKey: actor.currentEncryptionPublicKey,
    encryptionKeyVersion: actor.currentEncryptionKeyVersion,
    signingPublicKey: actor.currentSigningPublicKey,
    signingKeyVersion: actor.currentSigningKeyVersion,
  };
}

export function tupleFromPublishedActor(actor: {
  encryptionPublicKey: string;
  encryptionKeyVersion: string;
  signingPublicKey: string;
  signingKeyVersion: string;
}): PeerKeyTuple {
  return {
    encryptionPublicKey: actor.encryptionPublicKey,
    encryptionKeyVersion: actor.encryptionKeyVersion,
    signingPublicKey: actor.signingPublicKey,
    signingKeyVersion: actor.signingKeyVersion,
  };
}

export function tuplesEqual(left: PeerKeyTuple, right: PeerKeyTuple): boolean {
  return (
    left.encryptionPublicKey === right.encryptionPublicKey &&
    left.encryptionKeyVersion === right.encryptionKeyVersion &&
    left.signingPublicKey === right.signingPublicKey &&
    left.signingKeyVersion === right.signingKeyVersion
  );
}

export function diffTuples(
  pinned: PeerKeyTuple,
  observed: PeerKeyTuple
): PeerKeyTupleDiff {
  return {
    encryptionKeyVersionChanged:
      pinned.encryptionKeyVersion !== observed.encryptionKeyVersion,
    encryptionPublicKeyChanged:
      pinned.encryptionPublicKey !== observed.encryptionPublicKey,
    signingKeyVersionChanged:
      pinned.signingKeyVersion !== observed.signingKeyVersion,
    signingPublicKeyChanged:
      pinned.signingPublicKey !== observed.signingPublicKey,
  };
}

export function comparePeerKeys(
  store: PeerKeyTrustStore,
  publicIdentity: string,
  observed: PeerKeyTuple
): PeerKeyComparison {
  const pinned = store.peers[publicIdentity];
  if (!pinned) {
    return { status: 'unpinned' };
  }
  if (tuplesEqual(pinned.current, observed)) {
    return { status: 'matches', pinned };
  }
  return {
    status: 'rotated',
    pinned,
    diff: diffTuples(pinned.current, observed),
  };
}

export function isKeyTupleKnown(
  store: PeerKeyTrustStore,
  publicIdentity: string,
  observed: PeerKeyTuple
): boolean {
  const pinned = store.peers[publicIdentity];
  if (!pinned) return false;
  if (tuplesEqual(pinned.current, observed)) return true;
  return pinned.history.some(entry =>
    tuplesEqual(
      {
        encryptionPublicKey: entry.encryptionPublicKey,
        encryptionKeyVersion: entry.encryptionKeyVersion,
        signingPublicKey: entry.signingPublicKey,
        signingKeyVersion: entry.signingKeyVersion,
      },
      observed
    )
  );
}

export function isSigningKeyVersionTrusted(
  store: PeerKeyTrustStore,
  publicIdentity: string,
  signingKeyVersion: string,
  signingPublicKey: string
): boolean {
  const pinned = store.peers[publicIdentity];
  if (!pinned) return false;
  if (
    pinned.current.signingKeyVersion === signingKeyVersion &&
    pinned.current.signingPublicKey === signingPublicKey
  ) {
    return true;
  }
  return pinned.history.some(entry =>
    entry.signingKeyVersion === signingKeyVersion &&
    entry.signingPublicKey === signingPublicKey
  );
}

// Record the first trusted observation of a peer's keys. Throws if the peer is
// already pinned; callers use the rotation promotion path for changed keys.
export function pinPeerKeys(
  store: PeerKeyTrustStore,
  publicIdentity: string,
  tuple: PeerKeyTuple,
  pinnedAt: string
): PeerKeyTrustStore {
  if (store.peers[publicIdentity]) {
    throw new Error(
      `Peer ${publicIdentity} is already pinned. Use the rotation update path.`
    );
  }
  const next: PinnedPeer = {
    publicIdentity,
    pinnedAt,
    current: tuple,
    history: [{ ...tuple, confirmedAt: pinnedAt }],
  };
  return {
    version: PEER_KEY_TRUST_STORE_VERSION,
    peers: { ...store.peers, [publicIdentity]: next },
  };
}

// Human-readable fingerprint of a key tuple, suitable for out-of-band
// verification (safety-number equivalent). Groups the hex of each public key
// into 4-char blocks for readability.
export function fingerprintTuple(tuple: PeerKeyTuple): {
  signing: string;
  encryption: string;
  signingVersion: string;
  encryptionVersion: string;
} {
  return {
    signing: groupFingerprint(tuple.signingPublicKey),
    encryption: groupFingerprint(tuple.encryptionPublicKey),
    signingVersion: tuple.signingKeyVersion,
    encryptionVersion: tuple.encryptionKeyVersion,
  };
}

function groupFingerprint(key: string): string {
  const clean = key.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (clean.length === 0) return key;
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    groups.push(clean.slice(i, i + 4));
  }
  return groups.join(' ');
}

export function confirmPeerRotation(
  store: PeerKeyTrustStore,
  publicIdentity: string,
  tuple: PeerKeyTuple,
  confirmedAt: string
): PeerKeyTrustStore {
  const existing = store.peers[publicIdentity];
  if (!existing) {
    return pinPeerKeys(store, publicIdentity, tuple, confirmedAt);
  }
  if (tuplesEqual(existing.current, tuple)) {
    return store;
  }
  const alreadyInHistory = existing.history.some(entry =>
    tuplesEqual(
      {
        encryptionPublicKey: entry.encryptionPublicKey,
        encryptionKeyVersion: entry.encryptionKeyVersion,
        signingPublicKey: entry.signingPublicKey,
        signingKeyVersion: entry.signingKeyVersion,
      },
      tuple
    )
  );
  const nextHistory = alreadyInHistory
    ? existing.history
    : [...existing.history, { ...tuple, confirmedAt }];
  const next: PinnedPeer = {
    ...existing,
    current: tuple,
    history: nextHistory,
  };
  return {
    version: PEER_KEY_TRUST_STORE_VERSION,
    peers: { ...store.peers, [publicIdentity]: next },
  };
}

export function unpinPeer(
  store: PeerKeyTrustStore,
  publicIdentity: string
): PeerKeyTrustStore {
  if (!store.peers[publicIdentity]) return store;
  const { [publicIdentity]: _removed, ...rest } = store.peers;
  return { version: PEER_KEY_TRUST_STORE_VERSION, peers: rest };
}

export function listPinnedPeers(store: PeerKeyTrustStore): PinnedPeer[] {
  return Object.values(store.peers).sort((left, right) =>
    left.publicIdentity.localeCompare(right.publicIdentity)
  );
}

function isPeerKeyTuple(value: unknown): value is PeerKeyTuple {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.encryptionPublicKey === 'string' &&
    typeof record.encryptionKeyVersion === 'string' &&
    typeof record.signingPublicKey === 'string' &&
    typeof record.signingKeyVersion === 'string'
  );
}

function isPinnedPeer(value: unknown): value is PinnedPeer {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.publicIdentity !== 'string' ||
    typeof record.pinnedAt !== 'string' ||
    !isPeerKeyTuple(record.current) ||
    !Array.isArray(record.history)
  ) {
    return false;
  }
  return record.history.every(entry => {
    if (typeof entry !== 'object' || entry === null) return false;
    const entryRecord = entry as Record<string, unknown>;
    return isPeerKeyTuple(entry) && typeof entryRecord.confirmedAt === 'string';
  });
}

function invalidPeerKeyTrustStore(strict: boolean, message: string): PeerKeyTrustStore {
  if (strict) {
    throw new PeerKeyTrustStoreParseError(message);
  }
  return emptyPeerKeyTrustStore();
}

function parsePeerKeyTrustStoreInternal(raw: unknown, strict: boolean): PeerKeyTrustStore {
  if (typeof raw !== 'object' || raw === null) {
    return invalidPeerKeyTrustStore(strict, 'Peer key trust store must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== PEER_KEY_TRUST_STORE_VERSION) {
    return invalidPeerKeyTrustStore(strict, 'Peer key trust store version is unsupported');
  }
  if (
    typeof record.peers !== 'object' ||
    record.peers === null ||
    Array.isArray(record.peers)
  ) {
    return invalidPeerKeyTrustStore(strict, 'Peer key trust store peers must be an object');
  }

  const peers: Record<string, PinnedPeer> = {};
  for (const [key, value] of Object.entries(record.peers as Record<string, unknown>)) {
    if (isPinnedPeer(value) && value.publicIdentity === key) {
      peers[key] = value;
    } else if (strict) {
      throw new PeerKeyTrustStoreParseError(`Peer key trust entry for ${key} is malformed`);
    }
  }
  return { version: PEER_KEY_TRUST_STORE_VERSION, peers };
}

export function parsePeerKeyTrustStore(raw: unknown): PeerKeyTrustStore {
  return parsePeerKeyTrustStoreInternal(raw, false);
}

export function parsePersistedPeerKeyTrustStore(raw: unknown): PeerKeyTrustStore {
  return parsePeerKeyTrustStoreInternal(raw, true);
}
