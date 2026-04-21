import {
  emptyImportedRotationKeyConfirmationStore,
  getImportedRotationKeyConfirmationStatusFromStore,
  importedRotationActorKey,
  markImportedRotationSnapshotPendingInStore,
  parseImportedRotationKeyConfirmationStore,
  sameAgentKeyPairPublicTuple,
  confirmImportedRotationKeyInStore,
  type ImportedRotationKeyConfirmationStatus,
} from '../../../shared/imported-rotation-key-confirmation';
import type {
  ActorIdentity,
  AgentKeyPair,
} from './crypto';
import type {
  DeviceKeyShareSnapshot,
  SharedActorKeyMaterial,
} from '../../../shared/device-sharing';

const STORAGE_KEY = 'masumi-agent-messenger.importedRotationKeys.v1';

export type { ImportedRotationKeyConfirmationStatus };

function hasLocalStorage(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined';
}

function readStore() {
  if (!hasLocalStorage()) {
    return emptyImportedRotationKeyConfirmationStore();
  }
  const raw = globalThis.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return emptyImportedRotationKeyConfirmationStore();
  }
  return parseImportedRotationKeyConfirmationStore(JSON.parse(raw) as unknown);
}

function writeStore(store: ReturnType<typeof emptyImportedRotationKeyConfirmationStore>): void {
  if (!hasLocalStorage()) {
    return;
  }
  globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function getImportedRotationKeyConfirmationStatus(
  identity: ActorIdentity,
  keyPair: AgentKeyPair
): ImportedRotationKeyConfirmationStatus {
  return getImportedRotationKeyConfirmationStatusFromStore(readStore(), identity, keyPair);
}

export function confirmImportedRotationKey(
  identity: ActorIdentity,
  keyPair: AgentKeyPair
): ImportedRotationKeyConfirmationStatus['status'] {
  const result = confirmImportedRotationKeyInStore({
    store: readStore(),
    identity,
    keyPair,
    now: new Date().toISOString(),
  });
  writeStore(result.store);
  return result.previousStatus;
}

export function markImportedRotationSnapshotKeysPending(params: {
  snapshot: DeviceKeyShareSnapshot;
  knownCurrentKeys: Map<string, AgentKeyPair | null>;
}): number {
  const result = markImportedRotationSnapshotPendingInStore({
    store: readStore(),
    snapshot: params.snapshot,
    importedAt: new Date().toISOString(),
    isKnownCurrent: (actor: SharedActorKeyMaterial) => {
      const known = params.knownCurrentKeys.get(importedRotationActorKey(actor.identity));
      return sameAgentKeyPairPublicTuple(known, actor.current);
    },
  });
  if (result.changed) {
    writeStore(result.store);
  }
  return result.pendingCount;
}
