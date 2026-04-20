import { useCallback, useEffect, useState } from 'react';
import { Timestamp } from 'spacetimedb';
import { useReducer } from 'spacetimedb/tanstack';
import {
  clearPendingDeviceShareKeyMaterial,
  getOrCreateDeviceKeyMaterial,
  loadStoredAgentKeyPair,
  type DeviceKeyMaterial,
} from '@/lib/agent-session';
import { describeLocalVaultRequirement, type DefaultKeyIssue } from '@/lib/app-shell';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import {
  buildApprovedDeviceShare,
  importClaimedDeviceShare,
  prepareLocalDeviceShareRequest,
  resolveVerifiedDeviceShareRequest,
  type DeviceShareRequestLookupConnection,
} from '@/lib/device-share';
import type { UseKeyVaultResult } from '@/hooks/use-key-vault';
import { reducers } from '@/module_bindings';
import type {
  Agent,
  VisibleDeviceKeyBundleRow,
} from '@/module_bindings/types';
import { matchesPublishedActorKeys } from '../workspace/actor-settings';

type PendingDeviceRequest = {
  device: DeviceKeyMaterial;
  verificationCode: string;
  verificationSymbols: string[];
  verificationWords: string[];
  expiresAt: string;
};

export type SecurityLiveConnection = DeviceShareRequestLookupConnection & {
  procedures: DeviceShareRequestLookupConnection['procedures'] & {
    claimDeviceKeyBundle(params: {
      deviceId: string;
    }): Promise<
      Array<{
        sourceEncryptionPublicKey: string;
        bundleCiphertext: string;
        bundleIv: string;
        bundleAlgorithm: string;
      }>
    >;
  };
};

export function useSecurityRecovery(params: {
  existingDefaultActor: Agent | null;
  normalizedEmail: string;
  liveConnection: SecurityLiveConnection | null;
  canWrite: boolean;
  writeReason: string | null;
  vault: UseKeyVaultResult;
  deviceShareBundles: VisibleDeviceKeyBundleRow[];
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultKeyIssue, setDefaultKeyIssue] = useState<DefaultKeyIssue>(null);
  const [deviceShareBusy, setDeviceShareBusy] = useState(false);
  const [verifyingDeviceRequest, setVerifyingDeviceRequest] = useState(false);
  const [deviceVerificationCode, setDeviceVerificationCode] = useState('');
  const [pendingDeviceRequest, setPendingDeviceRequest] =
    useState<PendingDeviceRequest | null>(null);

  const registerDeviceReducer = useReducer(reducers.registerDevice);
  const createDeviceShareRequestReducer = useReducer(reducers.createDeviceShareRequest);
  const approveDeviceShareReducer = useReducer(reducers.approveDeviceShare);
  const revokeDeviceReducer = useReducer(reducers.revokeDevice);

  const inspectDefaultKeyIssue = useCallback(async (): Promise<DefaultKeyIssue> => {
    if (!params.existingDefaultActor) {
      return null;
    }

    const keyPair = await loadStoredAgentKeyPair({
      normalizedEmail: params.normalizedEmail,
      slug: params.existingDefaultActor.slug,
    });

    if (!keyPair) {
      return 'missing';
    }

    return matchesPublishedActorKeys(params.existingDefaultActor, keyPair)
      ? null
      : 'mismatch';
  }, [params.existingDefaultActor, params.normalizedEmail]);

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
      deviceShareBusy ||
      !params.existingDefaultActor
    ) {
      return;
    }

    const matchingBundle = params.deviceShareBundles.find(bundle => {
      return bundle.targetDeviceId === pendingDeviceRequest.device.deviceId && !bundle.consumedAt;
    });
    if (!matchingBundle) {
      return;
    }

    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setDeviceShareBusy(true);
      }
    });

    void params.liveConnection.procedures
      .claimDeviceKeyBundle({
        deviceId: pendingDeviceRequest.device.deviceId,
      })
      .then(async result => {
        const bundle = result[0];
        if (!bundle) {
          return;
        }

        await importClaimedDeviceShare({
          normalizedEmail: params.normalizedEmail,
          device: pendingDeviceRequest.device,
          sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
          bundleCiphertext: bundle.bundleCiphertext,
          bundleIv: bundle.bundleIv,
          bundleAlgorithm: bundle.bundleAlgorithm,
        });
        await clearPendingDeviceShareKeyMaterial(params.normalizedEmail);

        if (cancelled) {
          return;
        }

        const nextIssue = await inspectDefaultKeyIssue();
        if (cancelled) {
          return;
        }

        setPendingDeviceRequest(null);
        setDefaultKeyIssue(nextIssue);
        setFeedback(
          nextIssue
            ? 'A key bundle arrived, but the default inbox keys are still incomplete for this browser.'
            : 'Imported private keys from another approved device.'
        );
      })
      .catch(claimError => {
        if (!cancelled) {
          setError(
            claimError instanceof Error
              ? claimError.message
              : 'Unable to import the shared device bundle'
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDeviceShareBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    deviceShareBusy,
    inspectDefaultKeyIssue,
    params.deviceShareBundles,
    params.existingDefaultActor,
    params.liveConnection,
    params.normalizedEmail,
    pendingDeviceRequest,
  ]);

  async function ensureCurrentDeviceRegistration(): Promise<DeviceKeyMaterial> {
    const device = await getOrCreateDeviceKeyMaterial(params.normalizedEmail);
    await Promise.resolve(
      registerDeviceReducer({
        deviceId: device.deviceId,
        label: 'Browser',
        platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
        deviceEncryptionPublicKey: device.keyPair.publicKey,
        deviceEncryptionKeyVersion: device.keyPair.keyVersion,
        deviceEncryptionAlgorithm: device.keyPair.algorithm,
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
      const prepared = await prepareLocalDeviceShareRequest(params.normalizedEmail);
      await Promise.resolve(
        registerDeviceReducer({
          deviceId: prepared.device.deviceId,
          label: 'One-time recovery key',
          platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
          deviceEncryptionPublicKey: prepared.device.keyPair.publicKey,
          deviceEncryptionKeyVersion: prepared.device.keyPair.keyVersion,
          deviceEncryptionAlgorithm: prepared.device.keyPair.algorithm,
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
        normalizedEmail: params.normalizedEmail,
        targetDeviceId: request.deviceId,
        targetDeviceEncryptionPublicKey: request.deviceEncryptionPublicKey,
        sourceDevice,
      });

      await Promise.resolve(
        approveDeviceShareReducer({
          requestId: request.requestId,
          sourceDeviceId: approvedShare.sourceDeviceId,
          sourceEncryptionPublicKey: approvedShare.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: approvedShare.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: approvedShare.sourceEncryptionAlgorithm,
          bundleCiphertext: approvedShare.bundleCiphertext,
          bundleIv: approvedShare.bundleIv,
          bundleAlgorithm: approvedShare.bundleAlgorithm,
          sharedAgentCount: BigInt(approvedShare.sharedActorCount),
          sharedKeyVersionCount: BigInt(approvedShare.sharedKeyVersionCount),
          expiresAt: Timestamp.fromDate(approvedShare.expiresAt),
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
