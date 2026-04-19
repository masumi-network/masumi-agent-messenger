import type { PublicContactPolicy } from '../../../shared/contact-policy';
import type { PublicHeaderCapability } from '../../../shared/message-format';
import { DbConnection } from '../module_bindings';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import { ensureWorkspaceEnvLoaded } from './workspace-env.server';
import { setGlobalLogLevel } from 'spacetimedb';

ensureWorkspaceEnvLoaded();
setGlobalLogLevel('warn');

const HOST = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? 'agentmessenger-dev';

export type PublishedPublicRoute = {
  agentIdentifier: string | null;
  linkedEmail: string | null;
  description: string | null;
  encryptionKeyVersion: string;
  encryptionAlgorithm: string;
  encryptionPublicKey: unknown;
  signingKeyVersion: string;
  signingAlgorithm: string;
  signingPublicKey: unknown;
  allowAllContentTypes: boolean;
  allowAllHeaders: boolean;
  supportedContentTypes: string[];
  supportedHeaders: PublicHeaderCapability[];
  contactPolicy: PublicContactPolicy;
};

export type PublishedActorLookup = {
  slug: string;
  publicIdentity: string;
  isDefault: boolean;
  displayName: string | null;
  agentIdentifier: string | null;
  encryptionKeyVersion: string;
  encryptionAlgorithm: string;
  encryptionPublicKey: unknown;
  signingKeyVersion: string;
  signingAlgorithm: string;
  signingPublicKey: unknown;
};

function parseStoredJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return trimmed;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function withErrorContext(action: string, error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`${action}: ${error.message}`);
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return new Error(`${action}: ${error}`);
  }

  return new Error(action);
}

async function withConnection<T>(
  subscribe: (conn: DbConnection, resolve: (value: T) => void, reject: (error: Error) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('SpacetimeDB connection timeout'));
    }, 10000);

    DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .onConnect(conn => {
        subscribe(
          conn,
          value => {
            clearTimeout(timeoutId);
            conn.disconnect();
            resolve(value);
          },
          error => {
            clearTimeout(timeoutId);
            conn.disconnect();
            reject(error);
          }
        );
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timeoutId);
        reject(withErrorContext('SpacetimeDB connection failed', error));
      })
      .build();
  });
}

export async function resolvePublishedActorBySlug(
  slug: string
): Promise<PublishedActorLookup | null> {
  const normalizedSlug = normalizeInboxSlug(slug);
  if (!normalizedSlug) {
    return null;
  }

  return withConnection((conn, resolve, reject) => {
    void conn.procedures
      .lookupPublishedAgentBySlug({ slug: normalizedSlug })
      .then(result => {
        const actor = result[0];
        if (!actor) {
          resolve(null);
          return;
        }

        resolve({
          slug: actor.slug,
          publicIdentity: actor.publicIdentity,
          isDefault: actor.isDefault,
          displayName: actor.displayName ?? null,
          agentIdentifier: actor.agentIdentifier ?? null,
          encryptionKeyVersion: actor.encryptionKeyVersion,
          encryptionAlgorithm: actor.encryptionAlgorithm,
          encryptionPublicKey: parseStoredJson(actor.encryptionPublicKey),
          signingKeyVersion: actor.signingKeyVersion,
          signingAlgorithm: actor.signingAlgorithm,
          signingPublicKey: parseStoredJson(actor.signingPublicKey),
        });
      })
      .catch(error => {
        reject(
          withErrorContext(
            `lookupPublishedAgentBySlug(${normalizedSlug}) failed`,
            error
          )
        );
      });
  });
}

export async function fetchPublishedPublicRouteBySlug(
  slug: string
): Promise<PublishedPublicRoute | null> {
  const normalizedSlug = normalizeInboxSlug(slug);
  if (!normalizedSlug) {
    return null;
  }

  return withConnection((conn, resolve, reject) => {
    void conn.procedures
      .lookupPublishedPublicRouteBySlug({ slug: normalizedSlug })
      .then(result => {
        const route = result[0];
        if (!route) {
          resolve(null);
          return;
        }

        resolve({
          agentIdentifier: route.agentIdentifier ?? null,
          linkedEmail: route.linkedEmail ?? null,
          description: route.description ?? null,
          encryptionKeyVersion: route.encryptionKeyVersion,
          encryptionAlgorithm: route.encryptionAlgorithm,
          encryptionPublicKey: parseStoredJson(route.encryptionPublicKey),
          signingKeyVersion: route.signingKeyVersion,
          signingAlgorithm: route.signingAlgorithm,
          signingPublicKey: parseStoredJson(route.signingPublicKey),
          allowAllContentTypes: route.allowAllContentTypes,
          allowAllHeaders: route.allowAllHeaders,
          supportedContentTypes: route.supportedContentTypes,
          supportedHeaders: route.supportedHeaders.map(header => ({
            name: header.name,
            required: header.required ?? undefined,
            allowMultiple: header.allowMultiple ?? undefined,
            sensitive: header.sensitive ?? undefined,
            allowedPrefixes: header.allowedPrefixes ?? undefined,
          })),
          contactPolicy: {
            mode: route.contactPolicy.mode as PublicContactPolicy['mode'],
            allowlistScope:
              route.contactPolicy.allowlistScope as PublicContactPolicy['allowlistScope'],
            allowlistKinds: route.contactPolicy.allowlistKinds as PublicContactPolicy['allowlistKinds'],
            messagePreviewVisibleBeforeApproval:
              route.contactPolicy.messagePreviewVisibleBeforeApproval as false,
          },
        });
      })
      .catch(error => {
        reject(
          withErrorContext(
            `lookupPublishedPublicRouteBySlug(${normalizedSlug}) failed`,
            error
          )
        );
      });
  });
}
