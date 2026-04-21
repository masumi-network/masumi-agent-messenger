import {
  comparePeerKeys,
  confirmPeerRotation,
  emptyPeerKeyTrustStore,
  fingerprintTuple,
  isKeyTupleKnown,
  isSigningKeyVersionTrusted,
  listPinnedPeers,
  parsePersistedPeerKeyTrustStore,
  pinPeerKeys,
  unpinPeer,
  type PeerKeyComparison,
  type PeerKeyTrustStore,
  type PeerKeyTuple,
  type PinnedPeer,
} from '../../../shared/peer-key-trust';

export type { PeerKeyComparison, PeerKeyTuple, PinnedPeer };
export { fingerprintTuple };

const STORAGE_KEY = 'masumi-agent-messenger.peerKeyTrust.v1';

export class PeerKeyTrustStoreCorruptError extends Error {
  constructor(cause?: unknown) {
    super('Peer key trust store is corrupt. Clear local storage and re-pin peers.');
    this.name = 'PeerKeyTrustStoreCorruptError';
    if (cause) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function hasLocalStorage(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined';
}

// Fail-closed: if the store is present but unparsable, throw. A silent reset
// would erase every pin and restart TOFU for the whole inbox, which is
// exactly the behavior an attacker wants.
function readStore(): PeerKeyTrustStore {
  if (!hasLocalStorage()) return emptyPeerKeyTrustStore();
  const raw = globalThis.localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyPeerKeyTrustStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsePersistedPeerKeyTrustStore(parsed);
  } catch (error) {
    throw new PeerKeyTrustStoreCorruptError(error);
  }
}

function writeStore(store: PeerKeyTrustStore): void {
  if (!hasLocalStorage()) return;
  globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function tupleFromVisibleActor(actor: {
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

export function comparePinnedPeer(
  publicIdentity: string,
  observed: PeerKeyTuple
): PeerKeyComparison {
  return comparePeerKeys(readStore(), publicIdentity, observed);
}

// Persist a new peer pin after the user has confirmed the keys out-of-band.
// Callers must present the fingerprint and get explicit consent first.
export function pinFirstObservation(
  publicIdentity: string,
  observed: PeerKeyTuple
): void {
  const store = readStore();
  if (store.peers[publicIdentity]) {
    throw new Error(
      `Peer ${publicIdentity} is already pinned. Use the rotation update path.`
    );
  }
  writeStore(pinPeerKeys(store, publicIdentity, observed, new Date().toISOString()));
}

export function autoPinPeerIfUnknown(
  publicIdentity: string,
  observed: PeerKeyTuple
): PeerKeyComparison {
  const store = readStore();
  const comparison = comparePeerKeys(store, publicIdentity, observed);
  if (comparison.status === 'unpinned') {
    writeStore(pinPeerKeys(store, publicIdentity, observed, new Date().toISOString()));
  }
  return comparison;
}

export function confirmPeerKeyRotation(
  publicIdentity: string,
  observed: PeerKeyTuple
): void {
  const store = readStore();
  writeStore(confirmPeerRotation(store, publicIdentity, observed, new Date().toISOString()));
}

export function unpinPeerKeys(publicIdentity: string): boolean {
  const store = readStore();
  if (!store.peers[publicIdentity]) return false;
  writeStore(unpinPeer(store, publicIdentity));
  return true;
}

export function listTrustedPeers(): PinnedPeer[] {
  return listPinnedPeers(readStore());
}

export function isInboundSignatureTrusted(
  publicIdentity: string,
  signingKeyVersion: string,
  signingPublicKey: string
): boolean {
  return isSigningKeyVersionTrusted(
    readStore(),
    publicIdentity,
    signingKeyVersion,
    signingPublicKey
  );
}

export function isPeerKeyTupleKnown(
  publicIdentity: string,
  tuple: PeerKeyTuple
): boolean {
  return isKeyTupleKnown(readStore(), publicIdentity, tuple);
}

export function describeTupleDiff(
  pinned: PeerKeyTuple,
  observed: PeerKeyTuple
): string[] {
  const messages: string[] = [];
  if (
    pinned.signingKeyVersion !== observed.signingKeyVersion ||
    pinned.signingPublicKey !== observed.signingPublicKey
  ) {
    messages.push(
      `Signing key changed: ${pinned.signingKeyVersion} → ${observed.signingKeyVersion}`
    );
  }
  if (
    pinned.encryptionKeyVersion !== observed.encryptionKeyVersion ||
    pinned.encryptionPublicKey !== observed.encryptionPublicKey
  ) {
    messages.push(
      `Encryption key changed: ${pinned.encryptionKeyVersion} → ${observed.encryptionKeyVersion}`
    );
  }
  return messages;
}
