import { normalizeEmail } from '../../../shared/inbox-slug';
import type { MasumiRegistrationResult } from '../../../shared/inbox-agent-registration';
import {
  createEmptyMasumiRegistrationResult,
  isMasumiInboxAgentState,
  registrationResultFromMetadata,
  type MasumiActorRegistrationMetadata,
} from '../../../shared/inbox-agent-registration';
import type { Agent, Account } from '../../../webapp/src/module_bindings/types';
import {
  connectAuthenticated,
  disconnectConnection,
  readAccounts,
  readPublishedAgentKeyPair,
  subscribeInboxTables,
  type PublishedAgentKeyPair,
} from './spacetimedb';
import {
  ensureAuthenticatedSession,
} from './auth';
import {
  loadProfile,
  saveBootstrapSnapshot,
  type BootstrapSnapshot,
} from './config-store';
import { connectivityError } from './errors';
import { createSecretStore } from './secret-store';
import type { TaskReporter } from './command-runtime';
import {
  bootstrapAuthenticatedInbox,
  type BootstrapResult,
  type ConfirmDefaultSlugPrompt,
} from './inbox-bootstrap';
import {
  applyRegistrationMetadataToActor,
  syncMasumiInboxAgentRegistration,
  type ConfirmLinkedEmailPrompt,
  type ConfirmPublicDescriptionPrompt,
  type ConfirmRegistrationPrompt,
  type PauseHandler,
  type RegistrationMode,
} from './masumi-inbox-agent';

export type InboxStatusResult = {
  authenticated: boolean;
  connected: boolean;
  inbox: BootstrapSnapshot['inbox'] | null;
  actor: BootstrapSnapshot['actor'] | null;
  agentRegistration: MasumiRegistrationResult;
  keyVersions: {
    encryption: number | null;
    signing: number | null;
  };
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

function resolveDefaultInboxState(params: {
  email: string;
  accounts: Account[];
  actors: Agent[];
}): {
  inbox: Account;
  actor: Agent;
} | null {
  const inbox = params.accounts.find(row => row.email === params.email);
  const actor = params.actors.find(row => {
    return row.email === params.email && row.isDefault;
  });

  if (!inbox || !actor) {
    return null;
  }

  return { inbox, actor };
}

export async function bootstrapInbox(params: {
  profileName: string;
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
}): Promise<BootstrapResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  return bootstrapAuthenticatedInbox({
    profile,
    session,
    claims,
    displayName: params.displayName,
    reporter: params.reporter,
    registrationMode: params.registrationMode,
    desiredLinkedEmailVisibility: params.desiredLinkedEmailVisibility,
    desiredPublicDescription: params.desiredPublicDescription,
    confirmAgentRegistration: params.confirmAgentRegistration,
    confirmDefaultSlug: params.confirmDefaultSlug,
    confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
    confirmPublicDescription: params.confirmPublicDescription,
    pauseAfterRegistrationBlocked: params.pauseAfterRegistrationBlocked,
  });
}

export async function loadCurrentBootstrapSnapshot(params: {
  profileName: string;
  reporter: TaskReporter;
}): Promise<BootstrapSnapshot | null> {
  const { session, claims, profile } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    return null;
  }

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn, identityHex } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.(`Connected as ${identityHex}`);

  try {
    const subscription = await subscribeInboxTables(conn);
    try {
      const { accounts, actors } = await readAccounts(conn);
      const liveState = resolveDefaultInboxState({
        email,
        accounts,
        actors,
      });
      if (!liveState) {
        return null;
      }
      const actorKeys = await readPublishedAgentKeyPair(conn, liveState.actor);
      if (!actorKeys) {
        throw connectivityError('Published default inbox key bundle is missing.', {
          code: 'BOOTSTRAP_KEYS_UNAVAILABLE',
        });
      }

      const snapshot = toBootstrapSnapshot({
        email: email,
        identityHex,
        inbox: liveState.inbox,
        actor: liveState.actor,
        actorKeys,
      });
      await saveBootstrapSnapshot(profile.name, snapshot);
      return snapshot;
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function inboxStatus(params: {
  profileName: string;
  reporter: TaskReporter;
  registrationMode?: RegistrationMode;
  desiredLinkedEmailVisibility?: boolean;
  desiredPublicDescription?: string;
  confirmAgentRegistration?: ConfirmRegistrationPrompt;
  confirmLinkedEmailVisibility?: ConfirmLinkedEmailPrompt;
  confirmPublicDescription?: ConfirmPublicDescriptionPrompt;
  pauseAfterRegistrationBlocked?: PauseHandler;
}): Promise<InboxStatusResult> {
  const profile = await loadProfile(params.profileName);

  try {
    const { session, claims, profile: ensuredProfile } = await ensureAuthenticatedSession(params);
    const secretStore = createSecretStore();
    const keyPair = await secretStore.getAgentKeyPair(ensuredProfile.name);
    const email = normalizeEmail(claims.email ?? '');

    params.reporter.verbose?.('Connecting to SpacetimeDB');
    const { conn, identityHex } = await connectAuthenticated({
      host: ensuredProfile.spacetimeHost,
      databaseName: ensuredProfile.spacetimeDbName,
      sessionToken: session.idToken,
    });
    params.reporter.verbose?.(`Connected as ${identityHex}`);

    try {
      const subscription = await subscribeInboxTables(conn);
      try {
        const { accounts, actors } = await readAccounts(conn);
        const liveState = resolveDefaultInboxState({
          email,
          accounts,
          actors,
        });

        if (liveState) {
          const syncedRegistration = await syncMasumiInboxAgentRegistration({
            profile: ensuredProfile,
            session,
            conn,
            actor: liveState.actor,
            reporter: params.reporter,
            mode: params.registrationMode ?? 'skip',
            desiredLinkedEmailVisibility: params.desiredLinkedEmailVisibility,
            desiredPublicDescription: params.desiredPublicDescription,
            confirmRegistration: params.confirmAgentRegistration,
            confirmLinkedEmailVisibility: params.confirmLinkedEmailVisibility,
            confirmPublicDescription: params.confirmPublicDescription,
            pauseAfterBlocked: params.pauseAfterRegistrationBlocked,
          });
          const resolvedActor = applyRegistrationMetadataToActor(
            liveState.actor,
            syncedRegistration.metadata
          );
          const actorKeys = await readPublishedAgentKeyPair(conn, resolvedActor);
          if (!actorKeys) {
            throw connectivityError('Published default inbox key bundle is missing.', {
              code: 'BOOTSTRAP_KEYS_UNAVAILABLE',
            });
          }
          const snapshot = toBootstrapSnapshot({
            email: email,
            identityHex,
            inbox: liveState.inbox,
            actor: resolvedActor,
            actorKeys,
          });
          await saveBootstrapSnapshot(ensuredProfile.name, snapshot);

          return {
            authenticated: true,
            connected: true,
            inbox: snapshot.inbox,
            actor: snapshot.actor,
            agentRegistration: syncedRegistration.registration,
            keyVersions: snapshot.keyVersions,
            profile: ensuredProfile.name,
          };
        }

        return {
          authenticated: true,
          connected: true,
          inbox: null,
          actor: null,
          agentRegistration: createEmptyMasumiRegistrationResult(),
          keyVersions: {
            encryption: keyPair?.encryption.keyVersion ?? null,
            signing: keyPair?.signing.keyVersion ?? null,
          },
          profile: ensuredProfile.name,
        };
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      disconnectConnection(conn);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'AUTH_REQUIRED'
    ) {
      const snapshot = profile.bootstrapSnapshot ?? null;
      const snapshotRegistrationMetadata: MasumiActorRegistrationMetadata | null =
        snapshot?.actor
          ? {
              masumiRegistrationNetwork:
                snapshot.actor.masumiRegistrationNetwork ?? undefined,
              masumiInboxAgentId: snapshot.actor.masumiInboxAgentId ?? undefined,
              masumiAgentIdentifier: snapshot.actor.masumiAgentIdentifier ?? undefined,
              masumiRegistrationState:
                snapshot.actor.masumiRegistrationState &&
                isMasumiInboxAgentState(snapshot.actor.masumiRegistrationState)
                  ? snapshot.actor.masumiRegistrationState
                  : undefined,
            }
          : null;
      return {
        authenticated: false,
        connected: false,
        inbox: snapshot?.inbox ?? null,
        actor: snapshot?.actor ?? null,
        agentRegistration:
          snapshotRegistrationMetadata &&
          Object.values(snapshotRegistrationMetadata).some(value => value !== undefined)
            ? registrationResultFromMetadata(snapshotRegistrationMetadata)
            : createEmptyMasumiRegistrationResult(),
        keyVersions: {
          encryption: snapshot?.keyVersions.encryption ?? null,
          signing: snapshot?.keyVersions.signing ?? null,
        },
        profile: profile.name,
      };
    }

    throw connectivityError('Unable to read live inbox status.', {
      code: 'INBOX_STATUS_FAILED',
      cause: error,
    });
  }
}
