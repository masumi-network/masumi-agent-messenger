import process from 'node:process';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import { generateAgentKeyPair } from '../../../shared/agent-crypto';
import type { MasumiRegistrationResult } from '../../../shared/inbox-agent-registration';
import { createEmptyMasumiRegistrationResult } from '../../../shared/inbox-agent-registration';
import { buildPreferredDefaultInboxSlug, normalizeEmail } from '../../../shared/inbox-slug';
import type { Agent, Account } from '../../../webapp/src/module_bindings/types';
import {
  connectAuthenticated,
  disconnectConnection,
  publishedAgentKeyPairFromBundle,
  publishedAgentKeyPairMatches,
  readAccounts,
  readAgentCurrentKeyBundle,
  readPublishedAgentKeyPair,
  subscribeInboxTables,
  waitForBootstrapRows,
  type PublishedAgentKeyPair,
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
  importOwnedSaasInboxAgents,
  syncMasumiInboxAgentRegistration,
  type ConfirmLinkedEmailPrompt,
  type ConfirmPublicDescriptionPrompt,
  type ConfirmRegistrationPrompt,
  type OwnedSaasAgentImportSummary,
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

export type ConfirmDefaultSlugPromptResult =
  | string
  | {
      slug: string;
      publicDescription?: string | null;
    };

export type ConfirmDefaultSlugPrompt = (params: {
  email: string;
  suggestedSlug: string;
}) => Promise<ConfirmDefaultSlugPromptResult>;

export type BootstrapResult = {
  connected: true;
  bootstrapped: true;
  inbox: BootstrapSnapshot['inbox'];
  actor: BootstrapSnapshot['actor'];
  agentRegistration: MasumiRegistrationResult;
  ownedAgentImport: OwnedSaasAgentImportSummary;
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
  inbox: Account;
  actor: Agent;
  actorKeys: PublishedAgentKeyPair;
}): BootstrapSnapshot {
  return {
    email: params.email,
    spacetimeIdentity: params.identityHex,
    inbox: {
      id: params.inbox.id.toString(),
      email: params.inbox.email,
    },
    actor: {
      id: params.actor.id.toString(),
      slug: params.actor.slug,
      publicIdentity: params.actor.publicIdentity,
      displayName: params.actor.displayName ?? null,
      masumiRegistrationNetwork: params.actor.masumiRegistrationNetwork ?? undefined,
      masumiInboxAgentId: params.actor.masumiInboxAgentId ?? undefined,
      masumiAgentIdentifier: params.actor.masumiAgentIdentifier ?? undefined,
      masumiRegistrationState: params.actor.masumiRegistrationState?.tag ?? undefined,
    },
    keyVersions: {
      encryption: params.actorKeys.encryption.keyVersion,
      signing: params.actorKeys.signing.keyVersion,
    },
    actorKeys: {
      encryption: {
        publicKey: params.actorKeys.encryption.publicKey,
        keyVersion: params.actorKeys.encryption.keyVersion,
      },
      signing: {
        publicKey: params.actorKeys.signing.publicKey,
        keyVersion: params.actorKeys.signing.keyVersion,
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
    encryptionKeyVersion: 1,
    signingKeyVersion: 1,
  });
  await secretStore.setAgentKeyPair(profileName, created);
  reporter.verbose?.('Stored agent key bundle in OS keychain');
  return created;
}

function readDefaultActor(
  email: string,
  actors: Agent[]
): Agent | null {
  return (
    actors.find(actor => {
      return actor.email === email && actor.isDefault;
    }) ?? null
  );
}

function matchesPublishedDefaultActor(
  published: PublishedAgentKeyPair,
  keyPair: AgentKeyPair
): boolean {
  return publishedAgentKeyPairMatches(published, {
    encryption: {
      publicKey: keyPair.encryption.publicKey,
      keyVersion: keyPair.encryption.keyVersion,
    },
    signing: {
      publicKey: keyPair.signing.publicKey,
      keyVersion: keyPair.signing.keyVersion,
    },
  });
}

function requireVerifiedEmail(claims: IdTokenClaims): string {
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }
  return email;
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

  const email = requireVerifiedEmail(params.claims);
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
      const { actors } = await readAccounts(conn);
      const existingDefaultActor = readDefaultActor(email, actors);
      const suggestedDefaultSlug = buildPreferredDefaultInboxSlug(email, slug =>
        actors.some(actor => actor.slug === slug)
      );
      let setupPublicDescription = params.desiredPublicDescription;
      let defaultSlug: string | undefined;
      if (!existingDefaultActor) {
        const defaultSetup = params.confirmDefaultSlug
          ? await params.confirmDefaultSlug({
              email,
              suggestedSlug: suggestedDefaultSlug,
            })
          : suggestedDefaultSlug;
        if (typeof defaultSetup === 'string') {
          defaultSlug = defaultSetup;
        } else {
          defaultSlug = defaultSetup.slug;
          const publicDescription = defaultSetup.publicDescription?.trim();
          if (publicDescription) {
            setupPublicDescription = publicDescription;
          }
        }
      }
      const publishedKeyPair = existingDefaultActor
        ? await readPublishedAgentKeyPair(conn, existingDefaultActor)
        : null;
      if (existingDefaultActor && !publishedKeyPair) {
        throw userError('Published default inbox key bundle is missing.', {
          code: 'BOOTSTRAP_KEYS_UNAVAILABLE',
        });
      }

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
            email,
            slug: existingDefaultActor.slug,
          },
          published: publishedKeyPair!,
        });

        if (resolvedLocalKeys.status === 'matched') {
          localKeyPair = resolvedLocalKeys.keyPair;
          if (
            !existingLocalKeyPair ||
            !matchesPublishedDefaultActor(publishedKeyPair!, existingLocalKeyPair)
          ) {
            params.reporter.verbose?.('Recovered matching local agent key bundle for the published default inbox');
          } else {
            params.reporter.verbose?.('Loaded local agent key bundle');
          }
        } else {
          params.reporter.info(
            resolvedLocalKeys.status === 'mismatch'
              ? 'Local agent key bundle does not match the published default inbox keys. Recover the correct private keys, import a backup, or reset keys before this CLI profile can decrypt messages.'
              : 'Default inbox already exists. Reusing published public keys and keeping local private key recovery pending for this CLI profile.'
          );
          localKeyPair = null;
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
      await conn.reducers.upsertAccountFromOidcIdentity({
        displayName: params.displayName?.trim() || params.claims.name?.trim() || undefined,
        defaultSlug,
        encryptionPublicKey: keyPair.encryption.publicKey,
        keyBundleVersion: keyPair.encryption.keyVersion,
        encryptionAlgorithm: { tag: 'EcdhP256V1' },
        signingPublicKey: keyPair.signing.publicKey,
        signingAlgorithm: { tag: 'EcdsaP256Sha256V1' },
        deviceId: deviceMaterial.deviceId,
        deviceLabel: `CLI (${process.platform})`,
        devicePlatform: process.platform,
        deviceEncryptionPublicKey: deviceMaterial.keyPair.publicKey,
        deviceEncryptionKeyVersion: deviceMaterial.keyPair.keyVersion,
        deviceEncryptionAlgorithm: { tag: 'EcdhP256DeviceV1' },
      });

      params.reporter.info('Syncing inbox...');
      const { inbox, actor } = await waitForBootstrapRows({
        conn,
        email,
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
        desiredPublicDescription: setupPublicDescription,
        confirmRegistration: params.confirmAgentRegistration,
        confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
        confirmPublicDescription: params.confirmPublicDescription,
        pauseAfterBlocked: params.pauseAfterRegistrationBlocked,
      });
      resolvedActor = applyRegistrationMetadataToActor(actor, syncedRegistration.metadata);
      agentRegistration = syncedRegistration.registration;
      const resolvedBundle = await readAgentCurrentKeyBundle(conn, resolvedActor);
      const actorKeys = resolvedBundle
        ? publishedAgentKeyPairFromBundle(resolvedBundle)
        : {
            encryption: {
              publicKey: keyPair.encryption.publicKey,
              keyVersion: keyPair.encryption.keyVersion,
            },
            signing: {
              publicKey: keyPair.signing.publicKey,
              keyVersion: keyPair.signing.keyVersion,
            },
          };

      const snapshot = toBootstrapSnapshot({
        email: email,
        identityHex,
        inbox,
        actor: resolvedActor,
        actorKeys,
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
      const ownedAgentImport = await importOwnedSaasInboxAgents({
        profile: {
          ...params.profile,
          bootstrapSnapshot: snapshot,
        },
        session: params.session,
        conn,
        email,
        reporter: params.reporter,
        secretStore,
        apply: true,
      });
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
        ownedAgentImport,
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
