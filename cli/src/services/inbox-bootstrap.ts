import process from 'node:process';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import { generateAgentKeyPair } from '../../../shared/agent-crypto';
import type { MasumiRegistrationResult } from '../../../shared/inbox-agent-registration';
import { createEmptyMasumiRegistrationResult } from '../../../shared/inbox-agent-registration';
import { buildPreferredDefaultInboxSlug, normalizeEmail } from '../../../shared/inbox-slug';
import type { VisibleAgentRow, VisibleInboxRow } from '../../../webapp/src/module_bindings/types';
import {
  connectAuthenticated,
  disconnectConnection,
  readInboxRows,
  subscribeInboxTables,
  waitForBootstrapRows,
} from './spacetimedb';
import { saveBootstrapSnapshot, type BootstrapSnapshot, type ResolvedProfile } from './config-store';
import {
  ensureNamespaceVaultContainsDefaultActor,
  getOrCreateCliDeviceKeyMaterial,
} from './device-keys';
import { userError } from './errors';
import type { TaskReporter } from './command-runtime';
import { resolveStoredActorKeyPairForPublishedActor } from './actor-keys';
import {
  applyRegistrationMetadataToActor,
  syncMasumiInboxAgentRegistration,
  type ConfirmLinkedEmailPrompt,
  type ConfirmPublicDescriptionPrompt,
  type ConfirmRegistrationPrompt,
  type PauseHandler,
  type RegistrationMode,
} from './masumi-inbox-agent';
import { createSecretStore, type SecretStore } from './secret-store';
import type { IdTokenClaims, StoredOidcSession } from './oidc';

export type BootstrapKeySource =
  | 'existing_local'
  | 'new_local'
  | 'device_share'
  | 'backup_import'
  | 'rotated';

export type BootstrapRecoveryReason = 'missing' | 'mismatch' | null;

export type BootstrapRecoveryOption = 'device_share' | 'backup_import' | 'rotate';

export type ConfirmDefaultSlugPrompt = (params: {
  normalizedEmail: string;
  suggestedSlug: string;
}) => Promise<string>;

export type BootstrapResult = {
  connected: true;
  bootstrapped: true;
  inbox: BootstrapSnapshot['inbox'];
  actor: BootstrapSnapshot['actor'];
  agentRegistration: MasumiRegistrationResult;
  deviceId: string;
  localKeysReady: boolean;
  keySource: BootstrapKeySource;
  recoveryRequired: boolean;
  recoveryReason: BootstrapRecoveryReason;
  recoveryOptions: BootstrapRecoveryOption[];
  spacetimeIdentity: string;
  profile: string;
};

function toBootstrapSnapshot(params: {
  email: string;
  identityHex: string;
  inbox: VisibleInboxRow;
  actor: VisibleAgentRow;
}): BootstrapSnapshot {
  return {
    email: params.email,
    spacetimeIdentity: params.identityHex,
    inbox: {
      id: params.inbox.id.toString(),
      normalizedEmail: params.inbox.normalizedEmail,
      displayEmail: params.inbox.displayEmail,
    },
    actor: {
      id: params.actor.id.toString(),
      slug: params.actor.slug,
      publicIdentity: params.actor.publicIdentity,
      displayName: params.actor.displayName ?? null,
      masumiRegistrationNetwork: params.actor.masumiRegistrationNetwork ?? undefined,
      masumiInboxAgentId: params.actor.masumiInboxAgentId ?? undefined,
      masumiAgentIdentifier: params.actor.masumiAgentIdentifier ?? undefined,
      masumiRegistrationState: params.actor.masumiRegistrationState ?? undefined,
    },
    keyVersions: {
      encryption: params.actor.currentEncryptionKeyVersion,
      signing: params.actor.currentSigningKeyVersion,
    },
    actorKeys: {
      encryption: {
        publicKey: params.actor.currentEncryptionPublicKey,
        keyVersion: params.actor.currentEncryptionKeyVersion,
      },
      signing: {
        publicKey: params.actor.currentSigningPublicKey,
        keyVersion: params.actor.currentSigningKeyVersion,
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

async function createAgentKeyPair(
  profileName: string,
  reporter: TaskReporter,
  secretStore: SecretStore
): Promise<AgentKeyPair> {
  reporter.verbose?.('Generating local agent key bundle');
  const created = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  await secretStore.setAgentKeyPair(profileName, created);
  reporter.verbose?.('Stored agent key bundle in OS keychain');
  return created;
}

type PublishedDefaultActorKeys = {
  encryption: {
    publicKey: string;
    keyVersion: string;
    algorithm: string;
  };
  signing: {
    publicKey: string;
    keyVersion: string;
    algorithm: string;
  };
};

function readDefaultActor(
  normalizedEmail: string,
  actors: VisibleAgentRow[]
): VisibleAgentRow | null {
  return (
    actors.find(actor => {
      return actor.normalizedEmail === normalizedEmail && actor.isDefault;
    }) ?? null
  );
}

function matchesPublishedDefaultActor(
  actor: VisibleAgentRow,
  keyPair: AgentKeyPair
): boolean {
  return (
    actor.currentEncryptionPublicKey === keyPair.encryption.publicKey &&
    actor.currentEncryptionKeyVersion === keyPair.encryption.keyVersion &&
    actor.currentSigningPublicKey === keyPair.signing.publicKey &&
    actor.currentSigningKeyVersion === keyPair.signing.keyVersion
  );
}

function toPublishedDefaultActorKeys(actor: VisibleAgentRow): PublishedDefaultActorKeys {
  return {
    encryption: {
      publicKey: actor.currentEncryptionPublicKey,
      keyVersion: actor.currentEncryptionKeyVersion,
      algorithm: actor.currentEncryptionAlgorithm,
    },
    signing: {
      publicKey: actor.currentSigningPublicKey,
      keyVersion: actor.currentSigningKeyVersion,
      algorithm: actor.currentSigningAlgorithm,
    },
  };
}

function requireVerifiedEmail(claims: IdTokenClaims): string {
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }
  return normalizedEmail;
}

export async function bootstrapAuthenticatedInbox(params: {
  profile: ResolvedProfile;
  session: StoredOidcSession;
  claims: IdTokenClaims;
  displayName?: string;
  reporter: TaskReporter;
  registrationMode?: RegistrationMode;
  desiredLinkedEmailVisibility?: boolean;
  desiredPublicDescription?: string;
  confirmAgentRegistration?: ConfirmRegistrationPrompt;
  confirmDefaultSlug?: ConfirmDefaultSlugPrompt;
  confirmLinkedEmailVisibility?: ConfirmLinkedEmailPrompt;
  confirmPublicDescription?: ConfirmPublicDescriptionPrompt;
  pauseAfterRegistrationBlocked?: PauseHandler;
  secretStore?: SecretStore;
}): Promise<BootstrapResult> {
  if (!params.claims.emailVerified) {
    throw userError('Current OIDC session email is not verified.', {
      code: 'OIDC_EMAIL_NOT_VERIFIED',
    });
  }

  const normalizedEmail = requireVerifiedEmail(params.claims);
  const secretStore = params.secretStore ?? createSecretStore();

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn, identityHex } = await connectAuthenticated({
    host: params.profile.spacetimeHost,
    databaseName: params.profile.spacetimeDbName,
    sessionToken: params.session.idToken,
  });
  params.reporter.verbose?.(`Connected as ${identityHex}`);

  try {
    params.reporter.verbose?.('Subscribing to inbox state');
    const subscription = await subscribeInboxTables(conn);

    try {
      params.reporter.verbose?.('Bootstrapping default inbox');
      const existingLocalKeyPair = await secretStore.getAgentKeyPair(params.profile.name);
      const { actors } = readInboxRows(conn);
      const existingDefaultActor = readDefaultActor(normalizedEmail, actors);
      const suggestedDefaultSlug = buildPreferredDefaultInboxSlug(normalizedEmail, slug =>
        actors.some(actor => actor.slug === slug)
      );
      const defaultSlug = !existingDefaultActor
        ? await (params.confirmDefaultSlug
            ? params.confirmDefaultSlug({
                normalizedEmail,
                suggestedSlug: suggestedDefaultSlug,
              })
            : Promise.resolve(suggestedDefaultSlug))
        : undefined;
      const publishedKeyPair = existingDefaultActor
        ? toPublishedDefaultActorKeys(existingDefaultActor)
        : null;

      let localKeyPair = existingLocalKeyPair;
      let keySource: BootstrapKeySource = 'existing_local';
      let recoveryRequired = false;
      let recoveryReason: BootstrapRecoveryReason = null;
      let recoveryOptions: BootstrapRecoveryOption[] = [];

      if (!existingDefaultActor && !localKeyPair) {
        localKeyPair = await createAgentKeyPair(
          params.profile.name,
          params.reporter,
          secretStore
        );
        keySource = 'new_local';
      } else if (existingDefaultActor) {
        const resolvedLocalKeys = await resolveStoredActorKeyPairForPublishedActor({
          profile: params.profile,
          secretStore,
          identity: {
            normalizedEmail,
            slug: existingDefaultActor.slug,
            inboxIdentifier: existingDefaultActor.inboxIdentifier ?? undefined,
          },
          published: publishedKeyPair!,
        });

        if (resolvedLocalKeys.status === 'matched') {
          localKeyPair = resolvedLocalKeys.keyPair;
          if (
            !existingLocalKeyPair ||
            !matchesPublishedDefaultActor(existingDefaultActor, existingLocalKeyPair)
          ) {
            params.reporter.verbose?.('Recovered matching local agent key bundle for the published default inbox');
          } else {
            params.reporter.verbose?.('Loaded local agent key bundle');
          }
        } else {
          params.reporter.info(
            resolvedLocalKeys.status === 'mismatch'
              ? 'Local agent key bundle does not match the published default inbox keys. Recover the correct private keys, import a backup, or rotate keys before this CLI profile can decrypt messages.'
              : 'Default inbox already exists. Reusing published public keys and keeping local private key recovery pending for this CLI profile.'
          );
          recoveryRequired = true;
          recoveryReason = resolvedLocalKeys.status;
          recoveryOptions = ['device_share', 'backup_import', 'rotate'];
        }
      } else if (existingLocalKeyPair) {
        params.reporter.verbose?.('Loaded local agent key bundle');
      }
      const keyPair = localKeyPair ?? publishedKeyPair;
      if (!keyPair) {
        throw userError('Unable to resolve the current inbox key bundle.', {
          code: 'BOOTSTRAP_KEYS_UNAVAILABLE',
        });
      }
      const deviceMaterial = await getOrCreateCliDeviceKeyMaterial(
        params.profile.name,
        secretStore
      );
      await conn.reducers.upsertInboxFromOidcIdentity({
        displayName: params.displayName?.trim() || params.claims.name?.trim() || undefined,
        defaultSlug,
        encryptionPublicKey: keyPair.encryption.publicKey,
        encryptionKeyVersion: keyPair.encryption.keyVersion,
        encryptionAlgorithm: keyPair.encryption.algorithm,
        signingPublicKey: keyPair.signing.publicKey,
        signingKeyVersion: keyPair.signing.keyVersion,
        signingAlgorithm: keyPair.signing.algorithm,
        deviceId: deviceMaterial.deviceId,
        deviceLabel: `CLI (${process.platform})`,
        devicePlatform: process.platform,
        deviceEncryptionPublicKey: deviceMaterial.keyPair.publicKey,
        deviceEncryptionKeyVersion: deviceMaterial.keyPair.keyVersion,
        deviceEncryptionAlgorithm: deviceMaterial.keyPair.algorithm,
      });

      params.reporter.info('Syncing inbox...');
      const { inbox, actor } = await waitForBootstrapRows({
        conn,
        normalizedEmail,
        encryptionPublicKey: keyPair.encryption.publicKey,
        encryptionKeyVersion: keyPair.encryption.keyVersion,
        signingPublicKey: keyPair.signing.publicKey,
        signingKeyVersion: keyPair.signing.keyVersion,
        deviceId: deviceMaterial.deviceId,
      });

      let resolvedActor = actor;
      let agentRegistration = createEmptyMasumiRegistrationResult();
      const registrationMode = params.registrationMode ?? 'skip';
      const syncedRegistration = await syncMasumiInboxAgentRegistration({
        profile: params.profile,
        session: params.session,
        conn,
        actor,
        reporter: params.reporter,
        mode: registrationMode,
        desiredLinkedEmailVisibility: params.desiredLinkedEmailVisibility,
        desiredPublicDescription: params.desiredPublicDescription,
        confirmRegistration: params.confirmAgentRegistration,
        confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
        confirmPublicDescription: params.confirmPublicDescription,
        pauseAfterBlocked: params.pauseAfterRegistrationBlocked,
      });
      resolvedActor = applyRegistrationMetadataToActor(actor, syncedRegistration.metadata);
      agentRegistration = syncedRegistration.registration;

      const snapshot = toBootstrapSnapshot({
        email: normalizedEmail,
        identityHex,
        inbox,
        actor: resolvedActor,
      });
      await saveBootstrapSnapshot(params.profile.name, snapshot);
      if (localKeyPair) {
        await ensureNamespaceVaultContainsDefaultActor({
          profile: {
            ...params.profile,
            bootstrapSnapshot: snapshot,
          },
          secretStore,
          keyPair: localKeyPair,
        });
      }
      params.reporter.success(`Inbox synced for ${actor.slug}`);
      if (!localKeyPair) {
        params.reporter.info(
          'CLI device is registered and approved, but this profile still needs private keys from another device or backup.'
        );
      }

      return {
        connected: true,
        bootstrapped: true,
        inbox: snapshot.inbox,
        actor: snapshot.actor,
        agentRegistration,
        deviceId: deviceMaterial.deviceId,
        localKeysReady: Boolean(localKeyPair),
        keySource,
        recoveryRequired,
        recoveryReason,
        recoveryOptions,
        spacetimeIdentity: identityHex,
        profile: params.profile.name,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}
