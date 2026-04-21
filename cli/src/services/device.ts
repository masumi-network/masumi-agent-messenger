import { normalizeEmail } from '../../../shared/inbox-slug';
import { Timestamp } from 'spacetimedb';
import {
  buildDeviceShareContext,
  createDeviceVerificationCode,
  deviceShareRequestExpiresAt,
  createDeviceShareBundle,
  decryptDeviceShareBundle,
  hashDeviceVerificationCode,
  verifyDeviceVerificationCodeMatchesPublicKey,
} from '../../../shared/device-sharing';
import {
  DEVICE_SHARE_REQUEST_MAX_AGE_MS,
  DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS,
} from '../../../shared/device-share-constants';
import { timestampToDate, type TimestampLike } from '../../../shared/spacetime-time';
import { ensureAuthenticatedSession } from './auth';
import {
  exportNamespaceKeyShareSnapshot,
  getOrCreateCliDeviceKeyMaterial,
  importNamespaceKeyShareSnapshot,
} from './device-keys';
import { markImportedRotationKeysPendingFromSnapshot } from './imported-rotation-key-confirmation';
import { userError } from './errors';
import type { TaskReporter } from './command-runtime';
import { createSecretStore, type SecretStore } from './secret-store';
import {
  connectAuthenticated,
  disconnectConnection,
  readDeviceRows,
  subscribeDeviceTables,
} from './spacetimedb';

type ListedDevice = {
  deviceId: string;
  label: string | null;
  platform: string | null;
  status: string;
  approvedAt: string | null;
  revokedAt: string | null;
  pendingRequestCount: number;
};

export type RequestDeviceShareResult = {
  profile: string;
  deviceId: string;
  verificationCode: string;
  expiresAt: string;
  trustPhrase: string;
};

export type ClaimDeviceShareResult = {
  profile: string;
  deviceId: string;
  imported: boolean;
  timedOut: boolean;
  expiresAt: string | null;
  trustPhrase: string;
  sharedActorCount: number;
  sharedKeyVersionCount: number;
  pendingImportedRotationKeyCount: number;
};

export type ApproveDeviceShareResult = {
  profile: string;
  deviceId: string;
  sharedActorCount: number;
  sharedKeyVersionCount: number;
  expiresAt: string;
  trustPhrase: string;
};

const TRUST_ADJECTIVES = ['amber', 'brisk', 'cobalt', 'delta', 'ember', 'frost', 'glint', 'harbor'];
const TRUST_ANIMALS = ['otter', 'falcon', 'lynx', 'panda', 'orca', 'raven', 'fox', 'yak'];
const TRUST_EMOJIS = ['🦊', '🦉', '🐬', '🦁', '🐼', '🦄', '🛰️', '🔐'];

function computeTrustPhrase(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const normalized = Math.abs(hash);
  const emoji = TRUST_EMOJIS[normalized % TRUST_EMOJIS.length] ?? '🔐';
  const adjective = TRUST_ADJECTIVES[(normalized >> 8) % TRUST_ADJECTIVES.length] ?? 'steady';
  const animal = TRUST_ANIMALS[(normalized >> 16) % TRUST_ANIMALS.length] ?? 'wolf';
  return `${emoji} ${adjective}-${animal}`;
}

export type ListDevicesResult = {
  profile: string;
  devices: ListedDevice[];
};

export type RevokeDeviceResult = {
  profile: string;
  deviceId: string;
  revoked: true;
};

function defaultSecretStore(): SecretStore {
  return createSecretStore();
}

function requireNormalizedEmail(email: string | null | undefined): string {
  const normalized = normalizeEmail(email ?? '');
  if (!normalized) {
    throw userError('Current OIDC session is missing a verified email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }
  return normalized;
}

function toIso(value: { toDate(): Date } | Date): string {
  return (value instanceof Date ? value : value.toDate()).toISOString();
}

function compareTimestamp(
  left: { microsSinceUnixEpoch: bigint },
  right: { microsSinceUnixEpoch: bigint }
): number {
  if (left.microsSinceUnixEpoch < right.microsSinceUnixEpoch) return -1;
  if (left.microsSinceUnixEpoch > right.microsSinceUnixEpoch) return 1;
  return 0;
}

function isFutureTimestamp(value: { microsSinceUnixEpoch: bigint }): boolean {
  return (
    value.microsSinceUnixEpoch >
    (BigInt(Date.now()) - BigInt(DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS)) * 1000n
  );
}

function deviceKeyBundleNeverExpires(bundle: { expiryMode?: { tag: string } }): boolean {
  return bundle.expiryMode?.tag === 'NeverExpires' || bundle.expiryMode?.tag === 'neverExpires';
}

function assertFreshClientCreatedAt(value: TimestampLike): Date {
  const clientCreatedAt = timestampToDate(value);
  if (!clientCreatedAt) {
    throw userError('Device share request is missing its creation timestamp.', {
      code: 'DEVICE_SHARE_REQUEST_INVALID',
    });
  }

  const deltaMs = Date.now() - clientCreatedAt.getTime();
  if (deltaMs > DEVICE_SHARE_REQUEST_MAX_AGE_MS + DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS) {
    throw userError('Emoji verification code has expired. Ask the requester to generate a new one.', {
      code: 'DEVICE_SHARE_REQUEST_EXPIRED',
    });
  }
  if (deltaMs < -DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS) {
    throw userError(
      'Emoji verification code is too far in the future. Ask the requester to generate a new one.',
      {
        code: 'DEVICE_SHARE_REQUEST_CLOCK_SKEW',
      }
    );
  }

  return clientCreatedAt;
}

export async function requestDeviceShare(params: {
  profileName: string;
  reporter: TaskReporter;
  secretStore?: SecretStore;
}): Promise<RequestDeviceShareResult> {
  const secretStore = params.secretStore ?? defaultSecretStore();
  const auth = await ensureAuthenticatedSession({
    profileName: params.profileName,
    reporter: params.reporter,
    secretStore,
  });
  requireNormalizedEmail(auth.claims.email);
  const deviceMaterial = await getOrCreateCliDeviceKeyMaterial(auth.profile.name, secretStore);
  const trustPhrase = computeTrustPhrase(deviceMaterial.keyPair.publicKey);
  const clientCreatedAt = new Date();
  const verificationCode = await createDeviceVerificationCode({
    serializedPublicKey: deviceMaterial.keyPair.publicKey,
    clientCreatedAt,
  });
  const verificationCodeHash = await hashDeviceVerificationCode(verificationCode);
  const expiresAt = deviceShareRequestExpiresAt(clientCreatedAt);

  params.reporter.verbose?.('Registering CLI device');
  const { conn } = await connectAuthenticated({
    host: auth.profile.spacetimeHost,
    databaseName: auth.profile.spacetimeDbName,
    sessionToken: auth.session.idToken,
  });

  try {
    const subscription = await subscribeDeviceTables(conn);
    try {
      await conn.reducers.registerDevice({
        deviceId: deviceMaterial.deviceId,
        label: `CLI (${process.platform})`,
        platform: process.platform,
        deviceEncryptionPublicKey: deviceMaterial.keyPair.publicKey,
        deviceEncryptionKeyVersion: deviceMaterial.keyPair.keyVersion,
        deviceEncryptionAlgorithm: deviceMaterial.keyPair.algorithm,
      });
      await conn.reducers.createDeviceShareRequest({
        deviceId: deviceMaterial.deviceId,
        verificationCodeHash,
        clientCreatedAt: Timestamp.fromDate(clientCreatedAt),
      });
    } finally {
      subscription.unsubscribe();
    }

    params.reporter.setBanner?.({
      code: verificationCode,
      label: 'Verification code',
      hint:
        `Enter in trusted device CLI: masumi-agent-messenger auth device approve --code ${verificationCode}\n` +
        'Then run `masumi-agent-messenger auth device claim` here to import the shared keys.',
    });
    params.reporter.verbose?.(`Device ID: ${deviceMaterial.deviceId}`);
    params.reporter.verbose?.(`Code expires at ${expiresAt.toISOString()}`);

    return {
      profile: auth.profile.name,
      deviceId: deviceMaterial.deviceId,
      verificationCode,
      expiresAt: expiresAt.toISOString(),
      trustPhrase,
    };
  } finally {
    disconnectConnection(conn);
  }
}

export async function claimDeviceShare(params: {
  profileName: string;
  reporter: TaskReporter;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  secretStore?: SecretStore;
}): Promise<ClaimDeviceShareResult> {
  const secretStore = params.secretStore ?? defaultSecretStore();
  const auth = await ensureAuthenticatedSession({
    profileName: params.profileName,
    reporter: params.reporter,
    secretStore,
  });
  const normalizedEmail = requireNormalizedEmail(auth.claims.email);
  const deviceMaterial = await getOrCreateCliDeviceKeyMaterial(auth.profile.name, secretStore);
  const trustPhrase = computeTrustPhrase(deviceMaterial.keyPair.publicKey);
  const sleep = params.sleep ?? (async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)));

  // Default to the request lifetime so a fresh `claim` right after `request`
  // waits about as long as the shared code itself is valid.
  const defaultTimeoutMs = DEVICE_SHARE_REQUEST_MAX_AGE_MS;
  const timeoutMs = Math.max(0, params.timeoutMs ?? defaultTimeoutMs);
  const deadline = Date.now() + timeoutMs;

  const { conn } = await connectAuthenticated({
    host: auth.profile.spacetimeHost,
    databaseName: auth.profile.spacetimeDbName,
    sessionToken: auth.session.idToken,
  });

  try {
    params.reporter.info('Waiting for another device to approve and share keys');

    let attempted = false;
    while (!attempted || Date.now() < deadline) {
      attempted = true;
      const claimed = await conn.procedures.claimDeviceKeyBundle({
        deviceId: deviceMaterial.deviceId,
      });
      const bundle = claimed[0];
      if (bundle) {
        const bundleNeverExpires = deviceKeyBundleNeverExpires(bundle);
        const snapshot = await decryptDeviceShareBundle({
          recipientKeyPair: deviceMaterial.keyPair,
          sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
          bundleCiphertext: bundle.bundleCiphertext,
          bundleIv: bundle.bundleIv,
          bundleAlgorithm: bundle.bundleAlgorithm,
          context: buildDeviceShareContext(normalizedEmail, deviceMaterial.deviceId),
        });
        const previousVault = bundleNeverExpires
          ? await secretStore.getNamespaceKeyVault(auth.profile.name)
          : null;
        const previousDefaultKeyPair = bundleNeverExpires
          ? await secretStore.getAgentKeyPair(auth.profile.name)
          : null;
        await importNamespaceKeyShareSnapshot({
          profile: auth.profile,
          secretStore,
          snapshot,
        });
        const pendingImportedRotationKeyCount = bundleNeverExpires
          ? await markImportedRotationKeysPendingFromSnapshot({
              profile: auth.profile,
              secretStore,
              snapshot,
              previousVault,
              previousDefaultKeyPair,
            })
          : 0;
        if (pendingImportedRotationKeyCount > 0) {
          params.reporter.info(
            `Rotated private keys require local confirmation before sending. Run \`masumi-agent-messenger auth keys confirm --slug ${snapshot.actors[0]?.identity.slug ?? '<slug>'}\`.`
          );
        }
        params.reporter.clearBanner?.();
        params.reporter.success('Imported shared private keys');
        return {
          profile: auth.profile.name,
          deviceId: deviceMaterial.deviceId,
          imported: true,
          timedOut: false,
          expiresAt: null,
          trustPhrase,
          sharedActorCount: snapshot.actors.length,
          sharedKeyVersionCount: snapshot.actors.reduce((count, actor) => {
            return count + (actor.current ? 1 : 0) + actor.archived.length;
          }, 0),
          pendingImportedRotationKeyCount,
        };
      }

      if (Date.now() >= deadline) {
        break;
      }
      await sleep(2_000);
    }

    return {
      profile: auth.profile.name,
      deviceId: deviceMaterial.deviceId,
      imported: false,
      timedOut: true,
      expiresAt: null,
      trustPhrase,
      sharedActorCount: 0,
      sharedKeyVersionCount: 0,
      pendingImportedRotationKeyCount: 0,
    };
  } finally {
    disconnectConnection(conn);
  }
}

export async function approveDeviceShare(params: {
  profileName: string;
  reporter: TaskReporter;
  code?: string;
  deviceId?: string;
  secretStore?: SecretStore;
}): Promise<ApproveDeviceShareResult> {
  if (!params.code?.trim() && !params.deviceId?.trim()) {
    throw userError('Provide either --code or --device-id to approve a device share.', {
      code: 'DEVICE_SHARE_SELECTION_REQUIRED',
    });
  }

  const secretStore = params.secretStore ?? defaultSecretStore();
  const auth = await ensureAuthenticatedSession({
    profileName: params.profileName,
    reporter: params.reporter,
    secretStore,
  });
  const normalizedEmail = requireNormalizedEmail(auth.claims.email);

  params.reporter.verbose?.('Preparing approving device');
  const sourceDevice = await getOrCreateCliDeviceKeyMaterial(auth.profile.name, secretStore);
  const snapshot = await exportNamespaceKeyShareSnapshot({
    profile: auth.profile,
    secretStore,
  });

  const { conn } = await connectAuthenticated({
    host: auth.profile.spacetimeHost,
    databaseName: auth.profile.spacetimeDbName,
    sessionToken: auth.session.idToken,
  });

  try {
    const subscription = await subscribeDeviceTables(conn);
    try {
      await conn.reducers.registerDevice({
        deviceId: sourceDevice.deviceId,
        label: `CLI (${process.platform})`,
        platform: process.platform,
        deviceEncryptionPublicKey: sourceDevice.keyPair.publicKey,
        deviceEncryptionKeyVersion: sourceDevice.keyPair.keyVersion,
        deviceEncryptionAlgorithm: sourceDevice.keyPair.algorithm,
      });

      const rows = readDeviceRows(conn);
      let targetRequest:
        | {
            requestId: bigint;
            deviceId: string;
            deviceEncryptionPublicKey: string;
            clientCreatedAt?: Date;
          }
        | undefined;

      if (params.code?.trim()) {
        const verificationCodeHash = await hashDeviceVerificationCode(params.code);
        const resolved = await conn.procedures.resolveDeviceShareRequestByCode({
          verificationCodeHash,
        });
        const request = resolved[0];
        if (request) {
          const clientCreatedAt = assertFreshClientCreatedAt(request.clientCreatedAt);
          const matches = await verifyDeviceVerificationCodeMatchesPublicKey({
            code: params.code,
            serializedPublicKey: request.deviceEncryptionPublicKey,
            clientCreatedAt,
          });
          if (!matches) {
            throw userError(
              'Verification code does not match the requesting one-time recovery key.',
              {
                code: 'DEVICE_SHARE_VERIFICATION_MISMATCH',
              }
            );
          }

          targetRequest = {
            requestId: request.requestId,
            deviceId: request.deviceId,
            deviceEncryptionPublicKey: request.deviceEncryptionPublicKey,
            clientCreatedAt,
          };
        }
      } else if (params.deviceId?.trim()) {
        const requestedDeviceId = params.deviceId.trim();
        const device = rows.devices.find(row => row.deviceId === requestedDeviceId);
        const pendingRequests = rows.requests
          .filter(request => {
            return (
              request.deviceId === requestedDeviceId &&
              !request.approvedAt &&
              !request.consumedAt &&
              isFutureTimestamp(request.expiresAt)
            );
          })
          .sort((left, right) => {
            const timeOrder = compareTimestamp(left.createdAt, right.createdAt);
            if (timeOrder !== 0) return timeOrder;
            return Number(left.id - right.id);
          });

        const request = pendingRequests[pendingRequests.length - 1];
        if (request && device) {
          targetRequest = {
            requestId: request.id,
            deviceId: device.deviceId,
            deviceEncryptionPublicKey: device.deviceEncryptionPublicKey,
            clientCreatedAt: timestampToDate(request.clientCreatedAt),
          };
        }
      }

      if (!targetRequest) {
        throw userError('No pending device share request could be resolved.', {
          code: 'DEVICE_SHARE_REQUEST_NOT_FOUND',
        });
      }

      const trustPhrase = computeTrustPhrase(targetRequest.deviceEncryptionPublicKey);
      const bundle = await createDeviceShareBundle({
        sourceKeyPair: sourceDevice.keyPair,
        targetPublicKey: targetRequest.deviceEncryptionPublicKey,
        context: buildDeviceShareContext(normalizedEmail, targetRequest.deviceId),
        snapshot,
      });

      const sharedKeyVersionCount = snapshot.actors.reduce((count, actor) => {
        return count + (actor.current ? 1 : 0) + actor.archived.length;
      }, 0);
      const expiresAt = new Date(Date.now() + 15 * 60_000);

      await conn.reducers.approveDeviceShare({
        requestId: targetRequest.requestId,
        sourceDeviceId: sourceDevice.deviceId,
        ...bundle,
        sharedAgentCount: BigInt(snapshot.actors.length),
        sharedKeyVersionCount: BigInt(sharedKeyVersionCount),
        expiresAt: Timestamp.fromDate(expiresAt),
      });

      params.reporter.success(`Shared keys to device ${targetRequest.deviceId}`);
      return {
        profile: auth.profile.name,
        deviceId: targetRequest.deviceId,
        sharedActorCount: snapshot.actors.length,
        sharedKeyVersionCount,
        expiresAt: expiresAt.toISOString(),
        trustPhrase,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function listDevices(params: {
  profileName: string;
  reporter: TaskReporter;
  secretStore?: SecretStore;
}): Promise<ListDevicesResult> {
  const secretStore = params.secretStore ?? defaultSecretStore();
  const auth = await ensureAuthenticatedSession({
    profileName: params.profileName,
    reporter: params.reporter,
    secretStore,
  });

  const { conn } = await connectAuthenticated({
    host: auth.profile.spacetimeHost,
    databaseName: auth.profile.spacetimeDbName,
    sessionToken: auth.session.idToken,
  });

  try {
    const subscription = await subscribeDeviceTables(conn);
    try {
      const rows = readDeviceRows(conn);
      return {
        profile: auth.profile.name,
        devices: rows.devices.map(device => ({
          deviceId: device.deviceId,
          label: device.label ?? null,
          platform: device.platform ?? null,
          status: device.status,
          approvedAt: device.approvedAt ? toIso(device.approvedAt) : null,
          revokedAt: device.revokedAt ? toIso(device.revokedAt) : null,
          pendingRequestCount: rows.requests.filter(request => {
            return (
              request.deviceId === device.deviceId &&
              !request.approvedAt &&
              !request.consumedAt
            );
          }).length,
        })),
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function revokeDeviceShareAccess(params: {
  profileName: string;
  deviceId: string;
  reporter: TaskReporter;
  secretStore?: SecretStore;
}): Promise<RevokeDeviceResult> {
  const secretStore = params.secretStore ?? defaultSecretStore();
  const auth = await ensureAuthenticatedSession({
    profileName: params.profileName,
    reporter: params.reporter,
    secretStore,
  });

  const { conn } = await connectAuthenticated({
    host: auth.profile.spacetimeHost,
    databaseName: auth.profile.spacetimeDbName,
    sessionToken: auth.session.idToken,
  });

  try {
    const subscription = await subscribeDeviceTables(conn);
    try {
      await conn.reducers.revokeDevice({
        deviceId: params.deviceId.trim(),
      });
      params.reporter.success(`Revoked device ${params.deviceId.trim()}`);
      return {
        profile: auth.profile.name,
        deviceId: params.deviceId.trim(),
        revoked: true,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}
