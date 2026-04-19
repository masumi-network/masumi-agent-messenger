import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  comparePeerKeys,
  confirmPeerRotation,
  emptyPeerKeyTrustStore,
  fingerprintTuple,
  isKeyTupleKnown,
  isSigningKeyVersionTrusted,
  listPinnedPeers,
  parsePersistedPeerKeyTrustStore,
  PeerKeyTrustStoreParseError,
  pinPeerKeys,
  unpinPeer,
  type PeerKeyComparison,
  type PeerKeyTrustStore,
  type PeerKeyTuple,
  type PinnedPeer,
} from '../../../shared/peer-key-trust';
import { resolveConfigDirectory } from './config-store';
import { userError } from './errors';

export type {
  PeerKeyComparison,
  PeerKeyTrustStore,
  PeerKeyTuple,
  PinnedPeer,
};

export { fingerprintTuple };

function resolveTrustFilePath(): string {
  return path.join(resolveConfigDirectory(), 'peer-key-trust.json');
}

async function readStore(): Promise<PeerKeyTrustStore> {
  const filePath = resolveTrustFilePath();
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsePersistedPeerKeyTrustStore(parsed);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyPeerKeyTrustStore();
    }
    if (error instanceof SyntaxError || error instanceof PeerKeyTrustStoreParseError) {
      throw userError('Peer key trust store is corrupt. Remove it and re-pin peers.', {
        code: 'PEER_KEY_TRUST_CORRUPT',
        cause: error,
      });
    }
    throw userError('Unable to read peer key trust store.', {
      code: 'PEER_KEY_TRUST_READ_FAILED',
      cause: error,
    });
  }
}

async function writeStore(store: PeerKeyTrustStore): Promise<void> {
  const filePath = resolveTrustFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export async function loadPeerKeyTrustStore(): Promise<PeerKeyTrustStore> {
  return readStore();
}

export async function comparePinnedPeer(
  publicIdentity: string,
  observed: PeerKeyTuple
): Promise<PeerKeyComparison> {
  const store = await readStore();
  return comparePeerKeys(store, publicIdentity, observed);
}

// Persist a new peer pin after an explicit trust command.
export async function pinFirstObservation(
  publicIdentity: string,
  observed: PeerKeyTuple,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  const store = await readStore();
  if (store.peers[publicIdentity]) {
    throw userError(
      `Peer ${publicIdentity} is already pinned. Use confirm-rotation to update.`,
      { code: 'PEER_KEY_ALREADY_PINNED' }
    );
  }
  const next = pinPeerKeys(store, publicIdentity, observed, now());
  await writeStore(next);
}

export async function autoPinPeerIfUnknown(
  publicIdentity: string,
  observed: PeerKeyTuple,
  now: () => string = () => new Date().toISOString()
): Promise<PeerKeyComparison> {
  const store = await readStore();
  const comparison = comparePeerKeys(store, publicIdentity, observed);
  if (comparison.status === 'unpinned') {
    const next = pinPeerKeys(store, publicIdentity, observed, now());
    await writeStore(next);
  }
  return comparison;
}

export async function confirmPeerKeyRotation(
  publicIdentity: string,
  observed: PeerKeyTuple,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  const store = await readStore();
  const next = confirmPeerRotation(store, publicIdentity, observed, now());
  await writeStore(next);
}

export async function unpinPeerKeys(publicIdentity: string): Promise<boolean> {
  const store = await readStore();
  if (!store.peers[publicIdentity]) return false;
  const next = unpinPeer(store, publicIdentity);
  await writeStore(next);
  return true;
}

export async function listTrustedPeers(): Promise<PinnedPeer[]> {
  const store = await readStore();
  return listPinnedPeers(store);
}

export async function isInboundSignatureTrusted(
  publicIdentity: string,
  signingKeyVersion: string,
  signingPublicKey: string
): Promise<boolean> {
  const store = await readStore();
  return isSigningKeyVersionTrusted(store, publicIdentity, signingKeyVersion, signingPublicKey);
}

export async function isPeerKeyTupleKnown(
  publicIdentity: string,
  tuple: PeerKeyTuple
): Promise<boolean> {
  const store = await readStore();
  return isKeyTupleKnown(store, publicIdentity, tuple);
}
