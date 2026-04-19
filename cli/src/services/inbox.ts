import { normalizeEmail } from '../../../shared/inbox-slug';
import type { MasumiRegistrationResult } from '../../../shared/inbox-agent-registration';
import {
  createEmptyMasumiRegistrationResult,
  isMasumiInboxAgentState,
  registrationResultFromMetadata,
  type MasumiActorRegistrationMetadata,
} from '../../../shared/inbox-agent-registration';
import type { VisibleAgentRow, VisibleInboxRow } from '../../../webapp/src/module_bindings/types';
import {
  connectAuthenticated,
  disconnectConnection,
  readInboxRows,
  subscribeInboxTables,
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
    encryption: string | null;
    signing: string | null;
  };
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

function resolveDefaultInboxState(params: {
  normalizedEmail: string;
  inboxes: VisibleInboxRow[];
  actors: VisibleAgentRow[];
}): {
  inbox: VisibleInboxRow;
  actor: VisibleAgentRow;
} | null {
  const inbox = params.inboxes.find(row => row.normalizedEmail === params.normalizedEmail);
  const actor = params.actors.find(row => {
    return row.normalizedEmail === params.normalizedEmail && row.isDefault;
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const { inboxes, actors } = readInboxRows(conn);
      const liveState = resolveDefaultInboxState({
        normalizedEmail,
        inboxes,
        actors,
      });
      if (!liveState) {
        return null;
      }

      const snapshot = toBootstrapSnapshot({
        email: normalizedEmail,
        identityHex,
        inbox: liveState.inbox,
        actor: liveState.actor,
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
    const normalizedEmail = normalizeEmail(claims.email ?? '');

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
        const { inboxes, actors } = readInboxRows(conn);
        const liveState = resolveDefaultInboxState({
          normalizedEmail,
          inboxes,
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
          const snapshot = toBootstrapSnapshot({
            email: normalizedEmail,
            identityHex,
            inbox: liveState.inbox,
            actor: resolvedActor,
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
