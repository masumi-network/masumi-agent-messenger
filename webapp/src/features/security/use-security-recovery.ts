import { useCallback, useEffect, useRef, useState } from 'react';
import { Timestamp } from 'spacetimedb';
import { useReducer } from 'spacetimedb/tanstack';
import {
  clearPendingDeviceShareKeyMaterial,
  getOrCreateDeviceKeyMaterial,
  loadStoredAgentKeyPair,
  loadStoredDeviceKeyMaterial,
  type DeviceKeyMaterial,
} from '@/lib/agent-session';
import { describeLocalVaultRequirement, type DefaultKeyIssue } from '@/lib/app-shell';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import {
  buildApprovedDeviceShare,
  decryptClaimedDeviceShare,
  importDeviceShareSnapshot,
  importClaimedDeviceShare,
  prepareLocalDeviceShareRequest,
  resolveVerifiedDeviceShareRequest,
  type DeviceShareRequestLookupConnection,
} from '@/lib/device-share';
import { markImportedRotationSnapshotKeysPending } from '@/lib/imported-rotation-key-confirmation';
import { fromHex, toHex } from '@/lib/crypto';
import type { UseKeyVaultResult } from '@/hooks/use-key-vault';
import { reducers } from '@/module_bindings';
import type {
  Agent,
  DeviceKeyBundle,
} from '@/module_bindings/types';
import { matchesPublishedActorKeys } from '../workspace/actor-settings';
import { isTimestampInFuture } from '../../../../shared/spacetime-time';
import type { AgentKeyPair } from '../../../../shared/agent-crypto';
import type { DeviceKeyShareSnapshot } from '../../../../shared/device-sharing';
import { importedRotationActorKey } from '../../../../shared/imported-rotation-key-confirmation';

type PendingDeviceRequest = {
  device: DeviceKeyMaterial;
  verificationCode: string;
  verificationSymbols: string[];
  verificationWords: string[];
  expiresAt: string;
};

function deviceKeyBundleRequiresRotationConfirmation(bundle: unknown): boolean {
  const purpose =
    typeof bundle === 'object' && bundle !== null && 'purpose' in bundle
      ? (bundle as { purpose?: string | { tag?: string } }).purpose
      : null;
  const tag = typeof purpose === 'string' ? purpose : purpose?.tag;
  return tag === 'RotationShare';
}

async function loadKnownCurrentKeysForSnapshot(
  snapshot: DeviceKeyShareSnapshot
): Promise<Map<string, AgentKeyPair | null>> {
  const knownCurrentKeys = new Map<string, AgentKeyPair | null>();
  await Promise.all(
    snapshot.actors.map(async actor => {
      knownCurrentKeys.set(
        importedRotationActorKey(actor.identity),
        await loadStoredAgentKeyPair(actor.identity)
      );
    })
  );
  return knownCurrentKeys;
}

export type SecurityLiveConnection = DeviceShareRequestLookupConnection & {
  procedures: DeviceShareRequestLookupConnection['procedures'] & {
    claimDeviceKeyBundle(params: {
      deviceId: string;
    }): Promise<
      ReadonlyArray<{
        sourceEncryptionPublicKey: string;
        bundleCiphertext: Uint8Array;
        bundleIv: Uint8Array;
        bundleAlgorithm: { tag: string };
      }>
    >;
  };
};

function bundleAlgorithmLabel(algorithm: { tag: string }): string {
  switch (algorithm.tag) {
    case 'AesGcm256V1':
      return 'aes-gcm-256-device-share-v1';
    default:
      return algorithm.tag;
  }
}

export function useSecurityRecovery(params: {
  existingDefaultActor: Agent | null;
  email: string;
  liveConnection: SecurityLiveConnection | null;
  canWrite: boolean;
  writeReason: string | null;
  vault: UseKeyVaultResult;
  deviceShareBundles: DeviceKeyBundle[];
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultKeyIssue, setDefaultKeyIssue] = useState<DefaultKeyIssue>(null);
  const [deviceShareBusy, setDeviceShareBusy] = useState(false);
  const [verifyingDeviceRequest, setVerifyingDeviceRequest] = useState(false);
  const [deviceVerificationCode, setDeviceVerificationCode] = useState('');
  const [pendingDeviceRequest, setPendingDeviceRequest] =
    useState<PendingDeviceRequest | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pendingDeviceRequestRef = useRef<PendingDeviceRequest | null>(null);
  const deviceShareClaimDeviceIdRef = useRef<string | null>(null);

  const registerDeviceReducer = useReducer(reducers.registerDevice);
  const createDeviceShareRequestReducer = useReducer(reducers.createDeviceShareRequest);
  const approveDeviceShareReducer = useReducer(reducers.approveDeviceShareRequest);
  const revokeDeviceReducer = useReducer(reducers.revokeDevice);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    pendingDeviceRequestRef.current = pendingDeviceRequest;
  }, [pendingDeviceRequest]);

  useEffect(() => {
    if (!params.vault.unlocked) {
      return deferEffectStateUpdate(() => {
        setCurrentDeviceId(null);
      });
    }

    let cancelled = false;
    void loadStoredDeviceKeyMaterial(params.email)
      .then(device => {
        if (!cancelled) {
          setCurrentDeviceId(device?.deviceId ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentDeviceId(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [params.email, params.vault.unlocked]);

  const inspectDefaultKeyIssue = useCallback(async (): Promise<DefaultKeyIssue> => {
    if (!params.existingDefaultActor) {
      return null;
    }

    const keyPair = await loadStoredAgentKeyPair({
      email: params.email,
      slug: params.existingDefaultActor.slug,
    });

    if (!keyPair) {
      return 'missing';
    }

    return matchesPublishedActorKeys(params.existingDefaultActor, keyPair)
      ? null
      : 'mismatch';
  }, [params.existingDefaultActor, params.email]);

  useEffect(() => {
    if (!params.vault.unlocked || !params.existingDefaultActor) {
      return deferEffectStateUpdate(() => {
        setDefaultKeyIssue(null);
      });
    }

    let cancelled = false;
    void inspectDefaultKeyIssue()
      .then(issue => {
        if (!cancelled) {
          setDefaultKeyIssue(issue);
        }
      })
      .catch(keyIssueError => {
        if (!cancelled) {
          setError(
            keyIssueError instanceof Error
              ? keyIssueError.message
              : 'Unable to inspect local key material'
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [inspectDefaultKeyIssue, params.existingDefaultActor, params.vault.unlocked]);

  useEffect(() => {
    if (
      !pendingDeviceRequest ||
      !params.liveConnection ||
      !params.existingDefaultActor
    ) {
      return;
    }

    const targetDeviceId = pendingDeviceRequest.device.deviceId;
    if (deviceShareClaimDeviceIdRef.current !== null) {
      return;
    }

    const matchingBundle = params.deviceShareBundles.find(bundle => {
      return (
        bundle.targetDeviceId === targetDeviceId &&
        !bundle.consumedAt &&
        isTimestampInFuture(bundle.expiresAt)
      );
    });
    if (!matchingBundle) {
      return;
    }

    deviceShareClaimDeviceIdRef.current = targetDeviceId;
    const claimIsCurrent = () =>
      mountedRef.current && deviceShareClaimDeviceIdRef.current === targetDeviceId;
    const pendingRequestStillMatches = () =>
      pendingDeviceRequestRef.current?.device.deviceId === targetDeviceId;

    deferEffectStateUpdate(() => {
      if (claimIsCurrent()) {
        setDeviceShareBusy(true);
      }
    });

    void params.liveConnection.procedures
      .claimDeviceKeyBundle({
        deviceId: targetDeviceId,
      })
      .then(async result => {
        const bundle = result[0];
        if (!bundle) {
          return;
        }

        await importClaimedDeviceShare({
          email: params.email,
          device: pendingDeviceRequest.device,
          sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
          bundleCiphertext: toHex(bundle.bundleCiphertext),
          bundleIv: toHex(bundle.bundleIv),
          bundleAlgorithm: bundleAlgorithmLabel(bundle.bundleAlgorithm),
        });
        await clearPendingDeviceShareKeyMaterial(params.email);

        if (!claimIsCurrent() || !pendingRequestStillMatches()) {
          return;
        }

        setPendingDeviceRequest(null);
        setFeedback('Imported private keys from another approved device.');

        let nextIssue: DefaultKeyIssue;
        try {
          nextIssue = await inspectDefaultKeyIssue();
        } catch (keyIssueError) {
          if (claimIsCurrent()) {
            setError(
              keyIssueError instanceof Error
                ? `Private keys were imported, but the local key status could not be refreshed. ${keyIssueError.message}`
                : 'Private keys were imported, but the local key status could not be refreshed.'
            );
          }
          return;
        }

        if (!claimIsCurrent()) {
          return;
        }

        setDefaultKeyIssue(nextIssue);
        setFeedback(
          nextIssue
            ? 'A key bundle arrived, but the default inbox keys are still incomplete for this browser.'
            : 'Imported private keys from another approved device.'
        );
      })
      .catch(claimError => {
        if (claimIsCurrent()) {
          setError(
            claimError instanceof Error
              ? claimError.message
              : 'Unable to import the shared device bundle'
          );
        }
      })
      .finally(() => {
        if (deviceShareClaimDeviceIdRef.current === targetDeviceId) {
          deviceShareClaimDeviceIdRef.current = null;
          if (mountedRef.current) {
            setDeviceShareBusy(false);
          }
        }
      });
  }, [
    inspectDefaultKeyIssue,
    params.deviceShareBundles,
    params.existingDefaultActor,
    params.liveConnection,
    params.email,
    pendingDeviceRequest,
  ]);

  useEffect(() => {
    if (
      !currentDeviceId ||
      !params.liveConnection ||
      !params.existingDefaultActor ||
      !params.vault.unlocked
    ) {
      return;
    }
    if (deviceShareClaimDeviceIdRef.current !== null) {
      return;
    }

    const liveConnection = params.liveConnection;
    const matchingBundle = params.deviceShareBundles.find(bundle => {
      return (
        bundle.targetDeviceId === currentDeviceId &&
        !bundle.consumedAt &&
        isTimestampInFuture(bundle.expiresAt)
      );
    });
    if (!matchingBundle) {
      return;
    }

    deviceShareClaimDeviceIdRef.current = currentDeviceId;
    const claimIsCurrent = () =>
      mountedRef.current && deviceShareClaimDeviceIdRef.current === currentDeviceId;

    deferEffectStateUpdate(() => {
      if (claimIsCurrent()) {
        setDeviceShareBusy(true);
      }
    });

    void (async () => {
      const device = await loadStoredDeviceKeyMaterial(params.email);
      if (!device || device.deviceId !== currentDeviceId) {
        return;
      }

      const result = await liveConnection.procedures.claimDeviceKeyBundle({
        deviceId: currentDeviceId,
      });
      const bundle = result[0];
      if (!bundle) {
        return;
      }

      const snapshot = await decryptClaimedDeviceShare({
        email: params.email,
        device,
        sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
        bundleCiphertext: toHex(bundle.bundleCiphertext),
        bundleIv: toHex(bundle.bundleIv),
        bundleAlgorithm: bundleAlgorithmLabel(bundle.bundleAlgorithm),
      });
      const knownCurrentKeys = deviceKeyBundleRequiresRotationConfirmation(matchingBundle)
        ? await loadKnownCurrentKeysForSnapshot(snapshot)
        : null;
      await importDeviceShareSnapshot(snapshot);
      if (knownCurrentKeys) {
        markImportedRotationSnapshotKeysPending({
          snapshot,
          knownCurrentKeys,
        });
      }
      if (!claimIsCurrent()) {
        return;
      }

      let nextIssue: DefaultKeyIssue;
      try {
        nextIssue = await inspectDefaultKeyIssue();
      } catch (keyIssueError) {
        if (claimIsCurrent()) {
          setError(
            keyIssueError instanceof Error
              ? `Reset private keys were imported, but the local key status could not be refreshed. ${keyIssueError.message}`
              : 'Reset private keys were imported, but the local key status could not be refreshed.'
          );
        }
        return;
      }

      if (!claimIsCurrent()) {
        return;
      }

      setDefaultKeyIssue(nextIssue);
      setFeedback(
        nextIssue
          ? 'A key bundle arrived, but the default inbox keys are still incomplete for this browser.'
          : 'Reset private keys imported on this device.'
      );
    })()
      .catch(claimError => {
        if (claimIsCurrent()) {
          setError(
            claimError instanceof Error
              ? claimError.message
              : 'Unable to import the shared device bundle'
          );
        }
      })
      .finally(() => {
        if (deviceShareClaimDeviceIdRef.current === currentDeviceId) {
          deviceShareClaimDeviceIdRef.current = null;
          if (mountedRef.current) {
            setDeviceShareBusy(false);
          }
        }
      });
  }, [
    currentDeviceId,
    inspectDefaultKeyIssue,
    params.deviceShareBundles,
    params.existingDefaultActor,
    params.liveConnection,
    params.email,
    params.vault.unlocked,
  ]);

  async function ensureCurrentDeviceRegistration(): Promise<DeviceKeyMaterial> {
    const device = await getOrCreateDeviceKeyMaterial(params.email);
    await Promise.resolve(
      registerDeviceReducer({
        deviceId: device.deviceId,
        label: 'Browser',
        platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
        deviceEncryptionPublicKey: device.keyPair.publicKey,
        deviceEncryptionKeyVersion: device.keyPair.keyVersion,
        deviceEncryptionAlgorithm: { tag: 'EcdhP256DeviceV1' },
      })
    );
    return device;
  }

  async function handleRequestKeysFromAnotherDevice() {
    if (!params.canWrite) {
      setError(params.writeReason ?? 'Wait for a writable live session before requesting keys.');
      return;
    }

    if (!params.vault.unlocked) {
      setError(
        describeLocalVaultRequirement({
          initialized: params.vault.initialized,
          phrase: 'before requesting keys from another device',
        })
      );
      return;
    }

    setDeviceShareBusy(true);
    setError(null);
    setFeedback(null);

    try {
      const prepared = await prepareLocalDeviceShareRequest(params.email);
      await Promise.resolve(
        registerDeviceReducer({
          deviceId: prepared.device.deviceId,
          label: 'One-time recovery key',
          platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
          deviceEncryptionPublicKey: prepared.device.keyPair.publicKey,
          deviceEncryptionKeyVersion: prepared.device.keyPair.keyVersion,
          deviceEncryptionAlgorithm: { tag: 'EcdhP256DeviceV1' },
        })
      );
      await Promise.resolve(
        createDeviceShareRequestReducer({
          deviceId: prepared.device.deviceId,
          verificationCodeHash: prepared.verificationCodeHash,
          clientCreatedAt: Timestamp.fromDate(prepared.clientCreatedAt),
        })
      );
      setPendingDeviceRequest({
        device: prepared.device,
        verificationCode: prepared.parsedCode.formattedCode,
        verificationSymbols: prepared.parsedCode.symbols,
        verificationWords: prepared.parsedCode.words,
        expiresAt: prepared.expiresAt.toISOString(),
      });
      setFeedback('Device share request created. Approve it from another trusted device.');
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Unable to create a device share request'
      );
    } finally {
      setDeviceShareBusy(false);
    }
  }

  async function handleApproveDeviceShareByCode() {
    if (!params.canWrite) {
      setError(params.writeReason ?? 'Wait for a writable live session before approving a share.');
      return;
    }

    if (!params.vault.unlocked) {
      setError(
        describeLocalVaultRequirement({
          initialized: params.vault.initialized,
          phrase: 'before approving a device share',
        })
      );
      return;
    }

    if (!params.liveConnection) {
      setError('Wait for the live connection before approving a share.');
      return;
    }

    const trimmedCode = deviceVerificationCode.trim();
    if (!trimmedCode) {
      setError('Enter an emoji verification code to approve a share.');
      return;
    }

    setDeviceShareBusy(true);
    setError(null);
    setFeedback(null);

    try {
      const sourceDevice = await ensureCurrentDeviceRegistration();
      setVerifyingDeviceRequest(true);
      const request = await resolveVerifiedDeviceShareRequest({
        liveConnection: params.liveConnection,
        verificationCode: trimmedCode,
      });
      setVerifyingDeviceRequest(false);

      const approvedShare = await buildApprovedDeviceShare({
        email: params.email,
        targetDeviceId: request.deviceId,
        targetDeviceEncryptionPublicKey: request.deviceEncryptionPublicKey,
        sourceDevice,
        expiresInMinutes: 15,
      });

      await Promise.resolve(
        approveDeviceShareReducer({
          requestId: request.requestId,
          sourceEncryptionPublicKey: approvedShare.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: approvedShare.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: { tag: 'EcdhP256DeviceV1' },
          bundleCiphertext: fromHex(approvedShare.bundleCiphertext),
          bundleIv: fromHex(approvedShare.bundleIv),
          bundleAlgorithm: { tag: 'AesGcm256V1' },
          sharedAgentCount: BigInt(approvedShare.sharedActorCount),
          sharedKeyVersionCount: BigInt(approvedShare.sharedKeyVersionCount),
        })
      );

      setDeviceVerificationCode('');
      setFeedback(`Shared private keys to device ${request.deviceId}.`);
    } catch (approveError) {
      setError(
        approveError instanceof Error
          ? approveError.message
          : 'Unable to approve the device share'
      );
    } finally {
      setVerifyingDeviceRequest(false);
      setDeviceShareBusy(false);
    }
  }

  async function handleRevokeDevice(deviceId: string) {
    if (!params.canWrite) {
      setError(params.writeReason ?? 'Current browser session is read-only for device updates.');
      return;
    }

    setDeviceShareBusy(true);
    setError(null);
    setFeedback(null);

    try {
      await Promise.resolve(
        revokeDeviceReducer({
          deviceId,
        })
      );
      setFeedback(`Revoked device ${deviceId}.`);
    } catch (revokeError) {
      setError(
        revokeError instanceof Error ? revokeError.message : 'Unable to revoke the device'
      );
    } finally {
      setDeviceShareBusy(false);
    }
  }

  async function handleBackupImportSuccess() {
    const nextIssue = await inspectDefaultKeyIssue();
    setDefaultKeyIssue(nextIssue);
    setFeedback(
      nextIssue
        ? 'Encrypted backup imported, but the default inbox keys are still incomplete for this browser.'
        : 'Encrypted backup imported. Local private keys were restored.'
    );
  }

  return {
    feedback,
    error,
    defaultKeyIssue,
    deviceShareBusy,
    verifyingDeviceRequest,
    deviceVerificationCode,
    pendingDeviceRequest,
    setFeedback,
    setError,
    setDeviceVerificationCode,
    handleRequestKeysFromAnotherDevice,
    handleApproveDeviceShareByCode,
    handleRevokeDevice,
    handleBackupImportSuccess,
  };
}
