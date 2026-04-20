import {
  buildDeviceShareContext,
  countSharedActors,
  countSharedKeyVersions,
  createDeviceVerificationCode,
  deviceShareRequestExpiresAt,
  createDeviceShareBundle,
  decryptDeviceShareBundle,
  hasSharedPrivateKeyMaterial,
  hashDeviceVerificationCode,
  parseDeviceVerificationCode,
  type ParsedDeviceVerificationCode,
  verifyDeviceVerificationCodeMatchesPublicKey,
} from '../../../shared/device-sharing';
import {
  DEVICE_SHARE_REQUEST_MAX_AGE_MS,
  DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS,
} from '../../../shared/device-share-constants';
import { timestampToDate, type TimestampLike } from '../../../shared/spacetime-time';
import {
  createPendingDeviceShareKeyMaterial,
  exportInboxKeyShareSnapshot,
  importInboxKeyShareSnapshot,
  type DeviceKeyMaterial,
} from './agent-session';
import type { DeviceKeyShareSnapshot } from '../../../shared/device-sharing';

export type LocalDeviceShareRequest = {
  device: DeviceKeyMaterial;
  clientCreatedAt: Date;
  verificationCode: string;
  parsedCode: ParsedDeviceVerificationCode;
  verificationCodeHash: string;
  expiresAt: Date;
};

export type DeviceShareRequestLookupConnection = {
  procedures: {
    resolveDeviceShareRequestByCode(params: {
      verificationCodeHash: string;
    }): Promise<
      Array<{
        requestId: bigint;
        deviceId: string;
        deviceEncryptionPublicKey: string;
        clientCreatedAt: TimestampLike;
      }>
    >;
  };
};

export type VerifiedDeviceShareRequest = {
  requestId: bigint;
  deviceId: string;
  deviceEncryptionPublicKey: string;
  clientCreatedAt: Date;
  parsedCode: ParsedDeviceVerificationCode;
};

function assertFreshClientCreatedAt(value: TimestampLike): Date {
  const clientCreatedAt = timestampToDate(value);
  if (!clientCreatedAt) {
    throw new Error('Device share request is missing its creation timestamp.');
  }

  const deltaMs = Date.now() - clientCreatedAt.getTime();
  if (deltaMs > DEVICE_SHARE_REQUEST_MAX_AGE_MS + DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS) {
    throw new Error('Emoji share code has expired. Ask the requester to generate a new one.');
  }
  if (deltaMs < -DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS) {
    throw new Error(
      'Emoji share code has expired. The requesting device clock is too far ahead. Ask the requester to generate a new one.'
    );
  }

  return clientCreatedAt;
}

export async function prepareLocalDeviceShareRequest(
  normalizedEmail: string
): Promise<LocalDeviceShareRequest> {
  const device = await createPendingDeviceShareKeyMaterial(normalizedEmail);
  const clientCreatedAt = new Date();
  const verificationCode = await createDeviceVerificationCode({
    serializedPublicKey: device.keyPair.publicKey,
    clientCreatedAt,
  });
  const parsedCode = parseDeviceVerificationCode(verificationCode);
  const verificationCodeHash = await hashDeviceVerificationCode(verificationCode);
  const expiresAt = deviceShareRequestExpiresAt(clientCreatedAt);

  return {
    device,
    clientCreatedAt,
    verificationCode,
    parsedCode,
    verificationCodeHash,
    expiresAt,
  };
}

export async function resolveVerifiedDeviceShareRequest(params: {
  liveConnection: DeviceShareRequestLookupConnection;
  verificationCode: string;
}): Promise<VerifiedDeviceShareRequest> {
  const parsedCode = parseDeviceVerificationCode(params.verificationCode);
  const verificationCodeHash = await hashDeviceVerificationCode(params.verificationCode);
  const requestRows = await params.liveConnection.procedures.resolveDeviceShareRequestByCode({
    verificationCodeHash,
  });
  const request = requestRows[0];
  if (!request) {
    throw new Error('No pending device share request matches that verification code.');
  }

  const clientCreatedAt = assertFreshClientCreatedAt(request.clientCreatedAt);

  const matches = await verifyDeviceVerificationCodeMatchesPublicKey({
    code: params.verificationCode,
    serializedPublicKey: request.deviceEncryptionPublicKey,
    clientCreatedAt,
  });
  if (!matches) {
    throw new Error(
      'Verification code does not match the requesting one-time recovery key. Ask the requester to create a new emoji share code.'
    );
  }

  return {
    requestId: request.requestId,
    deviceId: request.deviceId,
    deviceEncryptionPublicKey: request.deviceEncryptionPublicKey,
    clientCreatedAt,
    parsedCode,
  };
}

export async function buildApprovedDeviceShare(params: {
  normalizedEmail: string;
  targetDeviceId: string;
  targetDeviceEncryptionPublicKey: string;
  sourceDevice: DeviceKeyMaterial;
  expiresInMinutes?: number;
  snapshot?: DeviceKeyShareSnapshot;
}) {
  const snapshot =
    params.snapshot ?? (await exportInboxKeyShareSnapshot(params.normalizedEmail));
  if (!hasSharedPrivateKeyMaterial(snapshot)) {
    throw new Error(
      'No local private keys are available on this device to share yet. Recover or import keys on the approving device first.'
    );
  }
  const bundle = await createDeviceShareBundle({
    sourceKeyPair: params.sourceDevice.keyPair,
    targetPublicKey: params.targetDeviceEncryptionPublicKey,
    context: buildDeviceShareContext(params.normalizedEmail, params.targetDeviceId),
    snapshot,
  });

  return {
    ...bundle,
    sourceDeviceId: params.sourceDevice.deviceId,
    sharedActorCount: countSharedActors(snapshot),
    sharedKeyVersionCount: countSharedKeyVersions(snapshot),
    expiresAt: new Date(Date.now() + (params.expiresInMinutes ?? 15) * 60_000),
  };
}

export async function importClaimedDeviceShare(params: {
  normalizedEmail: string;
  device: DeviceKeyMaterial;
  sourceEncryptionPublicKey: string;
  bundleCiphertext: string;
  bundleIv: string;
  bundleAlgorithm: string;
}) {
  const snapshot = await decryptDeviceShareBundle({
    recipientKeyPair: params.device.keyPair,
    sourceEncryptionPublicKey: params.sourceEncryptionPublicKey,
    bundleCiphertext: params.bundleCiphertext,
    bundleIv: params.bundleIv,
    bundleAlgorithm: params.bundleAlgorithm,
    context: buildDeviceShareContext(params.normalizedEmail, params.device.deviceId),
  });

  await importInboxKeyShareSnapshot(snapshot);
  return snapshot;
}
