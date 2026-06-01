import {
  isDeregisteringOrDeregisteredInboxAgentState,
  type MasumiRegistrationResult,
} from '../../../shared/inbox-agent-registration';
import {
  buildDeviceShareContext,
  countSharedActors,
  countSharedKeyVersions,
  createDeviceShareBundle,
} from '../../../shared/device-sharing';
import { fromHex } from '../../../shared/crypto-utils';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { ensureAuthenticatedSession } from './auth';
import {
  commitStoredActorKeyRotation,
  getOrCreateStoredActorKeyPair,
  previewStoredActorKeyRotation,
} from './actor-keys';
import type { TaskReporter } from './command-runtime';
import {
  connectivityError,
  inboxBootstrapRequiredError,
  isCliError,
  userError,
} from './errors';
import {
  exportNamespaceKeyShareSnapshot,
  getOrCreateCliDeviceKeyMaterial,
} from './device-keys';
import {
  applyRegistrationMetadataToActor,
  deregisterMasumiInboxAgentRegistration,
  importOwnedSaasInboxAgents,
  syncMasumiInboxAgentRegistration,
  type ConfirmLinkedEmailPrompt,
  type ConfirmPublicDescriptionPrompt,
  type ConfirmRegistrationPrompt,
  type OwnedSaasAgentImportSummary,
  type PauseHandler,
  type RegistrationMode,
} from './masumi-inbox-agent';
import { createSecretStore } from './secret-store';
import {
  connectAuthenticated,
  disconnectConnection,
  readDeviceRows,
  readAccounts,
  subscribeDeviceTables,
  subscribeInboxTables,
} from './spacetimedb';
import type { Agent } from '../../../webapp/src/module_bindings/types';

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim();
  }

  if (typeof error === 'string') {
    return error.trim();
  }

  return String(error).trim();
}

type CreatedInboxIdentity = {
  id: string;
  slug: string;
  publicIdentity: string;
  displayName: string | null;
  keyVersions: {
    encryption: number;
    signing: number;
  };
};

export type CreateAgentResult = {
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

export type DeregisterInboxAgentResult = {
  profile: string;
  actor: {
    id: string;
    slug: string;
    publicIdentity: string;
  };
  registration: Awaited<
    ReturnType<typeof deregisterMasumiInboxAgentRegistration>
  >['registration'];
};

export type RotateInboxKeysResult = {
  profile: string;
  actor: {
    id: string;
    slug: string;
    publicIdentity: string;
  };
  keyVersions: {
    encryption: number;
    signing: number;
  };
  sharedDeviceIds: string[];
  revokedDeviceIds: string[];
  deviceSyncError?: string;
};

export type SyncOwnedSaasInboxAgentsResult = {
  profile: string;
  import: OwnedSaasAgentImportSummary;
};

export type RotationDeviceCandidate = {
  deviceId: string;
  label: string | null;
  platform: string | null;
  status: { tag: string };
  isCurrentDevice: boolean;
};

function requireOwnedActor(params: {
  actors: Agent[];
  email: string;
  actorSlug?: string;
}): Agent {
  const defaultActor =
    params.actors.find(actor => actor.email === params.email && actor.isDefault) ??
    null;
  if (!defaultActor) {
    throw inboxBootstrapRequiredError();
  }

  const ownedActors = params.actors.filter(actor => actor.accountId === defaultActor.accountId);
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

export async function createAgent(params: {
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
}): Promise<CreateAgentResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
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
      email,
      slug: normalizedSlug,
      accountIdentifier: normalizedSlug,
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
      await conn.reducers.createAgent({
        slug: normalizedSlug,
        displayName: params.displayName?.trim() || undefined,
        encryptionPublicKey: keyPair.encryption.publicKey,
        keyBundleVersion: keyPair.encryption.keyVersion,
        encryptionAlgorithm: { tag: 'EcdhP256V1' },
        signingPublicKey: keyPair.signing.publicKey,
        signingAlgorithm: { tag: 'EcdsaP256Sha256V1' },
      });

      const actor = await new Promise<Awaited<ReturnType<typeof readAccounts>>['actors'][number]>(
        (resolve, reject) => {
          const timeoutAt = Date.now() + 10_000;
          const poll = async () => {
            const row = (await readAccounts(conn)).actors.find(candidate => candidate.slug === normalizedSlug);
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
            setTimeout(() => {
              void poll().catch(reject);
            }, 100);
          };
          void poll().catch(reject);
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
            encryption: resolvedActor.currentKeyBundleVersion,
            signing: resolvedActor.currentKeyBundleVersion,
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
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
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
      const { actors } = await readAccounts(conn);
      const actor = requireOwnedActor({
        actors,
        email,
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
    const detail = describeUnknownError(error);
    throw connectivityError(
      detail
        ? `Unable to sync the managed inbox-agent registration: ${detail}`
        : 'Unable to sync the managed inbox-agent registration.',
      {
        code: 'INBOX_AGENT_REGISTER_FAILED',
        cause: error,
      }
    );
  } finally {
    disconnectConnection(conn);
  }
}

export async function syncOwnedSaasInboxAgents(params: {
  profileName: string;
  reporter: TaskReporter;
  apply?: boolean;
}): Promise<SyncOwnedSaasInboxAgentsResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeInboxTables(conn);
    try {
      const imported = await importOwnedSaasInboxAgents({
        profile,
        session,
        conn,
        email,
        reporter: params.reporter,
        apply: params.apply,
      });
      return {
        profile: profile.name,
        import: imported,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function deregisterInboxAgent(params: {
  profileName: string;
  actorSlug?: string;
  reporter: TaskReporter;
}): Promise<DeregisterInboxAgentResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
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
      const { actors } = await readAccounts(conn);
      const actor = requireOwnedActor({
        actors,
        email,
        actorSlug: params.actorSlug,
      });
      const registration = await deregisterMasumiInboxAgentRegistration({
        profile,
        session,
        conn,
        actor,
        reporter: params.reporter,
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
    const detail = describeUnknownError(error);
    throw connectivityError(
      detail
        ? `Unable to deregister the managed inbox-agent: ${detail}`
        : 'Unable to deregister the managed inbox-agent.',
      {
        code: 'INBOX_AGENT_DEREGISTER_FAILED',
        cause: error,
      }
    );
  } finally {
    disconnectConnection(conn);
  }
}

export async function listRotationDeviceCandidates(params: {
  profileName: string;
  reporter: TaskReporter;
}): Promise<{
  profile: string;
  currentDeviceId: string;
  devices: RotationDeviceCandidate[];
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const secretStore = createSecretStore();
  const currentDevice = await getOrCreateCliDeviceKeyMaterial(profile.name, secretStore);

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    const subscription = await subscribeDeviceTables(conn);
    try {
      const rows = await readDeviceRows(conn);
      return {
        profile: profile.name,
        currentDeviceId: currentDevice.deviceId,
        devices: rows.devices
          .filter(device => device.status.tag === 'Approved')
          .map(device => ({
            deviceId: device.deviceId,
            label: device.label ?? null,
            platform: device.platform ?? null,
            status: device.status,
            isCurrentDevice: device.deviceId === currentDevice.deviceId,
          })),
      };
    } finally {
      subscription.unsubscribe();
    }
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
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
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
      const rows = await readDeviceRows(conn);
      const actor = requireOwnedActor({
        actors: rows.actors,
        email,
        actorSlug: params.actorSlug,
      });
      if (isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState?.tag)) {
        throw userError(
          `Agent \`${actor.slug}\` is deregistering or deregistered and cannot rotate inbox keys.`,
          {
            code: 'AGENT_DEREGISTERED',
          }
        );
      }
      const rotationPlan = await previewStoredActorKeyRotation({
        profile,
        secretStore,
        identity: {
          email,
          slug: actor.slug,
        },
        currentKeyBundleVersion: actor.currentKeyBundleVersion,
      });
      const sourceDevice = await getOrCreateCliDeviceKeyMaterial(profile.name, secretStore);
      await conn.reducers.registerDevice({
        deviceId: sourceDevice.deviceId,
        label: `CLI (${process.platform})`,
        platform: process.platform,
        deviceEncryptionPublicKey: sourceDevice.keyPair.publicKey,
        deviceEncryptionKeyVersion: sourceDevice.keyPair.keyVersion,
        deviceEncryptionAlgorithm: { tag: 'EcdhP256DeviceV1' },
      });

      const snapshot = await exportNamespaceKeyShareSnapshot({
        profile,
        secretStore,
        overrides: [
          {
            identity: {
              email,
              slug: actor.slug,
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
      const approvedDevices = rows.devices.filter(device => device.status.tag === 'Approved');
      const requestedRevokeIds = Array.from(new Set(params.revokeDeviceIds ?? []));
      const requestedShareIds = Array.from(new Set(params.shareDeviceIds ?? []));
      const sharedDeviceIds: string[] = [];
      const revokedDeviceIds: string[] = [];
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
          context: buildDeviceShareContext(email, targetDevice.deviceId),
          snapshot,
        });
        deviceShareBundles.push({
          deviceId: targetDevice.deviceId,
          sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: bundle.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: bundle.sourceEncryptionAlgorithm,
          bundleCiphertext: bundle.bundleCiphertext,
          bundleIv: bundle.bundleIv,
          bundleAlgorithm: bundle.bundleAlgorithm,
          sharedAgentCount: sharedActorCount,
          sharedKeyVersionCount,
        });
      }

      await conn.reducers.rotateAgentKeys({
        agentDbId: actor.id,
        encryptionPublicKey: rotationPlan.rotated.encryption.publicKey,
        keyBundleVersion: rotationPlan.rotated.encryption.keyVersion,
        encryptionAlgorithm: { tag: 'EcdhP256V1' },
        signingPublicKey: rotationPlan.rotated.signing.publicKey,
        signingAlgorithm: { tag: 'EcdsaP256Sha256V1' },
      });
      await commitStoredActorKeyRotation({
        profile,
        secretStore,
        identity: {
          email,
          slug: actor.slug,
        },
        plan: rotationPlan,
      });

      let deviceSyncError: string | undefined;
      try {
        for (const bundle of deviceShareBundles) {
          await conn.reducers.shareDeviceKeyBundle({
            targetDeviceId: bundle.deviceId,
            sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
            sourceEncryptionKeyVersion: bundle.sourceEncryptionKeyVersion,
            sourceEncryptionAlgorithm: { tag: 'EcdhP256DeviceV1' },
            bundleCiphertext: fromHex(bundle.bundleCiphertext),
            bundleIv: fromHex(bundle.bundleIv),
            bundleAlgorithm: { tag: 'AesGcm256V1' },
            sharedAgentCount: bundle.sharedAgentCount,
            sharedKeyVersionCount: bundle.sharedKeyVersionCount,
          });
          sharedDeviceIds.push(bundle.deviceId);
        }

        for (const deviceId of requestedRevokeIds) {
          await conn.reducers.revokeDevice({ deviceId });
          revokedDeviceIds.push(deviceId);
        }
      } catch (error) {
        deviceSyncError =
          error instanceof Error
            ? error.message
            : 'Unable to finish device sharing or revocation.';
      }

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
        revokedDeviceIds,
        ...(deviceSyncError ? { deviceSyncError } : {}),
      };
    } finally {
      subscription.unsubscribe();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError(
      'Unable to reset inbox keys. Existing published keys are still active unless reset completed successfully.',
      {
        code: 'INBOX_ROTATE_KEYS_FAILED',
        cause: error,
      }
    );
  } finally {
    disconnectConnection(conn);
  }
}
