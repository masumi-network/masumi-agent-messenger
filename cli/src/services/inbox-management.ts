import type { MasumiRegistrationResult } from '../../../shared/inbox-agent-registration';
import {
  buildDeviceShareContext,
  countSharedActors,
  countSharedKeyVersions,
  createDeviceShareBundle,
} from '../../../shared/device-sharing';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { Timestamp } from 'spacetimedb';
import { ensureAuthenticatedSession } from './auth';
import {
  commitStoredActorKeyRotation,
  getOrCreateStoredActorKeyPair,
  previewStoredActorKeyRotation,
} from './actor-keys';
import type { TaskReporter } from './command-runtime';
import { connectivityError, isCliError, userError } from './errors';
import {
  exportNamespaceKeyShareSnapshot,
  getOrCreateCliDeviceKeyMaterial,
} from './device-keys';
import {
  applyRegistrationMetadataToActor,
  syncMasumiInboxAgentRegistration,
  type ConfirmLinkedEmailPrompt,
  type ConfirmPublicDescriptionPrompt,
  type ConfirmRegistrationPrompt,
  type PauseHandler,
  type RegistrationMode,
} from './masumi-inbox-agent';
import { createSecretStore } from './secret-store';
import {
  connectAuthenticated,
  disconnectConnection,
  readDeviceRows,
  readInboxRows,
  subscribeDeviceTables,
  subscribeInboxTables,
} from './spacetimedb';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';

type CreatedInboxIdentity = {
  id: string;
  slug: string;
  publicIdentity: string;
  displayName: string | null;
  keyVersions: {
    encryption: string;
    signing: string;
  };
};

export type CreateInboxIdentityResult = {
  profile: string;
  actor: CreatedInboxIdentity;
  registration: MasumiRegistrationResult;
};

export type RegisterInboxAgentResult = {
  profile: string;
  actor: {
    id: string;
    slug: string;
    publicIdentity: string;
  };
  registration: Awaited<ReturnType<typeof syncMasumiInboxAgentRegistration>>['registration'];
};

export type RotateInboxKeysResult = {
  profile: string;
  actor: {
    id: string;
    slug: string;
    publicIdentity: string;
  };
  keyVersions: {
    encryption: string;
    signing: string;
  };
  sharedDeviceIds: string[];
  revokedDeviceIds: string[];
};

function requireOwnedActor(params: {
  actors: VisibleAgentRow[];
  normalizedEmail: string;
  actorSlug?: string;
}): VisibleAgentRow {
  const defaultActor =
    params.actors.find(actor => actor.normalizedEmail === params.normalizedEmail && actor.isDefault) ??
    null;
  if (!defaultActor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }

  const ownedActors = params.actors.filter(actor => actor.inboxId === defaultActor.inboxId);
  if (!params.actorSlug) {
    return defaultActor;
  }

  const normalizedSlug = normalizeInboxSlug(params.actorSlug);
  if (!normalizedSlug) {
    throw userError('Inbox slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const actor = ownedActors.find(candidate => candidate.slug === normalizedSlug);
  if (!actor) {
    throw userError(`No owned inbox actor found for slug \`${normalizedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }

  return actor;
}

export async function createInboxIdentity(params: {
  profileName: string;
  slug: string;
  displayName?: string;
  reporter: TaskReporter;
  registrationMode?: RegistrationMode;
  desiredLinkedEmailVisibility?: boolean;
  desiredPublicDescription?: string;
  confirmRegistration?: ConfirmRegistrationPrompt;
  confirmLinkedEmailVisibility?: ConfirmLinkedEmailPrompt;
  confirmPublicDescription?: ConfirmPublicDescriptionPrompt;
  pauseAfterRegistrationBlocked?: PauseHandler;
}): Promise<CreateInboxIdentityResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const normalizedSlug = normalizeInboxSlug(params.slug);
  if (!normalizedSlug) {
    throw userError('Inbox slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const secretStore = createSecretStore();
  const keyPair = await getOrCreateStoredActorKeyPair({
    profile,
    secretStore,
    identity: {
      normalizedEmail,
      slug: normalizedSlug,
      inboxIdentifier: normalizedSlug,
    },
  });

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Subscribing to inbox state');
    const subscription = await subscribeInboxTables(conn);

    try {
      await conn.reducers.createInboxIdentity({
        slug: normalizedSlug,
        displayName: params.displayName?.trim() || undefined,
        encryptionPublicKey: keyPair.encryption.publicKey,
        encryptionKeyVersion: keyPair.encryption.keyVersion,
        encryptionAlgorithm: keyPair.encryption.algorithm,
        signingPublicKey: keyPair.signing.publicKey,
        signingKeyVersion: keyPair.signing.keyVersion,
        signingAlgorithm: keyPair.signing.algorithm,
      });

      const actor = await new Promise<Awaited<ReturnType<typeof readInboxRows>>['actors'][number]>(
        (resolve, reject) => {
          const timeoutAt = Date.now() + 10_000;
          const poll = () => {
            const row = readInboxRows(conn).actors.find(candidate => candidate.slug === normalizedSlug);
            if (row) {
              resolve(row);
              return;
            }
            if (Date.now() >= timeoutAt) {
              reject(
                connectivityError('Timed out waiting for the inbox slug to sync.', {
                  code: 'SPACETIMEDB_INBOX_CREATE_TIMEOUT',
                })
              );
              return;
            }
            setTimeout(poll, 100);
          };
          poll();
        }
      );

      params.reporter.success(`Created inbox slug ${actor.slug}`);
      const registration = await syncMasumiInboxAgentRegistration({
        profile,
        session,
        conn,
        actor,
        reporter: params.reporter,
        mode: params.registrationMode ?? 'skip',
        desiredLinkedEmailVisibility: params.desiredLinkedEmailVisibility,
        desiredPublicDescription: params.desiredPublicDescription,
        confirmRegistration: params.confirmRegistration,
        confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
        confirmPublicDescription: params.confirmPublicDescription,
        pauseAfterBlocked: params.pauseAfterRegistrationBlocked,
      });
      const resolvedActor = applyRegistrationMetadataToActor(actor, registration.metadata);

      return {
        profile: profile.name,
        actor: {
          id: resolvedActor.id.toString(),
          slug: resolvedActor.slug,
          publicIdentity: resolvedActor.publicIdentity,
          displayName: resolvedActor.displayName ?? null,
          keyVersions: {
            encryption: resolvedActor.currentEncryptionKeyVersion,
            signing: resolvedActor.currentSigningKeyVersion,
          },
        },
        registration: registration.registration,
      };
    } finally {
      subscription.unsubscribe();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to create the inbox slug.', {
      code: 'INBOX_CREATE_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function registerInboxAgent(params: {
  profileName: string;
  actorSlug?: string;
  reporter: TaskReporter;
  registrationMode?: RegistrationMode;
  desiredLinkedEmailVisibility?: boolean;
  desiredPublicDescription?: string;
  confirmRegistration?: ConfirmRegistrationPrompt;
  confirmLinkedEmailVisibility?: ConfirmLinkedEmailPrompt;
  confirmPublicDescription?: ConfirmPublicDescriptionPrompt;
  pauseAfterRegistrationBlocked?: PauseHandler;
}): Promise<RegisterInboxAgentResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Subscribing to inbox state');
    const subscription = await subscribeInboxTables(conn);

    try {
      const { actors } = readInboxRows(conn);
      const actor = requireOwnedActor({
        actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });
      const registration = await syncMasumiInboxAgentRegistration({
        profile,
        session,
        conn,
        actor,
        reporter: params.reporter,
        mode: params.registrationMode ?? 'auto',
        desiredLinkedEmailVisibility: params.desiredLinkedEmailVisibility,
        desiredPublicDescription: params.desiredPublicDescription,
        confirmRegistration: params.confirmRegistration,
        confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
        confirmPublicDescription: params.confirmPublicDescription,
        pauseAfterBlocked: params.pauseAfterRegistrationBlocked,
      });
      const resolvedActor = applyRegistrationMetadataToActor(actor, registration.metadata);

      return {
        profile: profile.name,
        actor: {
          id: resolvedActor.id.toString(),
          slug: resolvedActor.slug,
          publicIdentity: resolvedActor.publicIdentity,
        },
        registration: registration.registration,
      };
    } finally {
      subscription.unsubscribe();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to sync the managed inbox-agent registration.', {
      code: 'INBOX_AGENT_REGISTER_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function rotateInboxKeys(params: {
  profileName: string;
  actorSlug?: string;
  shareDeviceIds?: string[];
  revokeDeviceIds?: string[];
  reporter: TaskReporter;
}): Promise<RotateInboxKeysResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const secretStore = createSecretStore();

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Subscribing to device state');
    const subscription = await subscribeDeviceTables(conn);

    try {
      const rows = readDeviceRows(conn);
      const actor = requireOwnedActor({
        actors: rows.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });
      const rotationPlan = await previewStoredActorKeyRotation({
        profile,
        secretStore,
        identity: {
          normalizedEmail,
          slug: actor.slug,
          inboxIdentifier: actor.inboxIdentifier ?? undefined,
        },
        currentEncryptionKeyVersion: actor.currentEncryptionKeyVersion,
        currentSigningKeyVersion: actor.currentSigningKeyVersion,
      });
      const sourceDevice = await getOrCreateCliDeviceKeyMaterial(profile.name, secretStore);
      await conn.reducers.registerDevice({
        deviceId: sourceDevice.deviceId,
        label: `CLI (${process.platform})`,
        platform: process.platform,
        deviceEncryptionPublicKey: sourceDevice.keyPair.publicKey,
        deviceEncryptionKeyVersion: sourceDevice.keyPair.keyVersion,
        deviceEncryptionAlgorithm: sourceDevice.keyPair.algorithm,
      });

      const snapshot = await exportNamespaceKeyShareSnapshot({
        profile,
        secretStore,
        overrides: [
          {
            identity: {
              normalizedEmail,
              slug: actor.slug,
              inboxIdentifier: actor.inboxIdentifier ?? undefined,
            },
            current: rotationPlan.rotated,
            archived:
              rotationPlan.nextVault.actors.find(
                vaultActor => vaultActor.identity.slug === actor.slug
              )?.archived ?? [],
          },
        ],
      });
      const sharedActorCount = countSharedActors(snapshot);
      const sharedKeyVersionCount = countSharedKeyVersions(snapshot);
      const approvedDevices = rows.devices.filter(device => device.status === 'approved');
      const requestedShareIds = Array.from(new Set(params.shareDeviceIds ?? []));
      const requestedRevokeIds = Array.from(new Set(params.revokeDeviceIds ?? []));
      const sharedDeviceIds: string[] = [];
      const deviceShareBundles = [];

      for (const deviceId of requestedShareIds) {
        if (deviceId === sourceDevice.deviceId || requestedRevokeIds.includes(deviceId)) {
          continue;
        }

        const targetDevice = approvedDevices.find(device => device.deviceId === deviceId);
        if (!targetDevice) {
          throw userError(`Approved device \`${deviceId}\` was not found.`, {
            code: 'DEVICE_NOT_FOUND',
          });
        }

        const bundle = await createDeviceShareBundle({
          sourceKeyPair: sourceDevice.keyPair,
          targetPublicKey: targetDevice.deviceEncryptionPublicKey,
          context: buildDeviceShareContext(normalizedEmail, targetDevice.deviceId),
          snapshot,
        });
        deviceShareBundles.push({
          deviceId: targetDevice.deviceId,
          sourceDeviceId: sourceDevice.deviceId,
          sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: bundle.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: bundle.sourceEncryptionAlgorithm,
          bundleCiphertext: bundle.bundleCiphertext,
          bundleIv: bundle.bundleIv,
          bundleAlgorithm: bundle.bundleAlgorithm,
          sharedAgentCount: sharedActorCount,
          sharedKeyVersionCount,
          expiresAt: Timestamp.fromDate(new Date(Date.now() + 15 * 60_000)),
        });
        sharedDeviceIds.push(targetDevice.deviceId);
      }

      await conn.reducers.rotateAgentKeys({
        agentDbId: actor.id,
        encryptionPublicKey: rotationPlan.rotated.encryption.publicKey,
        encryptionKeyVersion: rotationPlan.rotated.encryption.keyVersion,
        encryptionAlgorithm: rotationPlan.rotated.encryption.algorithm,
        signingPublicKey: rotationPlan.rotated.signing.publicKey,
        signingKeyVersion: rotationPlan.rotated.signing.keyVersion,
        signingAlgorithm: rotationPlan.rotated.signing.algorithm,
        deviceKeyBundles: deviceShareBundles,
        revokeDeviceIds: requestedRevokeIds,
      });

      await commitStoredActorKeyRotation({
        profile,
        secretStore,
        identity: {
          normalizedEmail,
          slug: actor.slug,
          inboxIdentifier: actor.inboxIdentifier ?? undefined,
        },
        plan: rotationPlan,
      });

      return {
        profile: profile.name,
        actor: {
          id: actor.id.toString(),
          slug: actor.slug,
          publicIdentity: actor.publicIdentity,
        },
        keyVersions: {
          encryption: rotationPlan.rotated.encryption.keyVersion,
          signing: rotationPlan.rotated.signing.keyVersion,
        },
        sharedDeviceIds,
        revokedDeviceIds: requestedRevokeIds,
      };
    } finally {
      subscription.unsubscribe();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError(
      'Unable to rotate inbox keys. Existing published keys are still active unless rotation completed successfully.',
      {
      code: 'INBOX_ROTATE_KEYS_FAILED',
      cause: error,
      }
    );
  } finally {
    disconnectConnection(conn);
  }
}
