import type { Query, TypedTableDef } from 'spacetimedb';
import {
  prepareChannelMessage,
  verifySignedChannelMessage,
  type ChannelMessageSignatureInput,
} from '../../../shared/channel-crypto';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import { isDeregisteringOrDeregisteredInboxAgentState } from '../../../shared/inbox-agent-registration';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { LEGACY_CHANNEL_SENDER_SIGNING_PUBLIC_KEY } from '../../../shared/message-limits';
import {
  formatEncryptedMessageBody,
  isJsonContentType,
  normalizeContentType,
  normalizeEncryptedMessagePayload,
  type EncryptedMessagePayload,
} from '../../../shared/message-format';
import type {
  Agent,
  ChannelMemberListRow,
  PublicChannelMirrorRow,
  PublicChannelPageRow,
  PublicRecentChannelMessage,
  VisibleChannelJoinRequestRow,
  VisibleChannelMembershipRow,
  VisibleChannelRow,
} from '../../../webapp/src/module_bindings/types';
import { tables, type DbConnection, type SubscriptionHandle } from '../../../webapp/src/module_bindings';
import { getStoredActorKeyPair } from './actor-keys';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import { loadProfile } from './config-store';
import { connectivityError, userError } from './errors';
import { createSecretStore } from './secret-store';
import {
  connectAnonymous,
  connectAuthenticated,
  disconnectConnection,
} from './spacetimedb';

type ChannelQuery = Query<TypedTableDef>;

export type ChannelListItem = {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  publicJoinPermission: string;
  discoverable: boolean;
  lastMessageSeq: string;
};

export type ChannelMessageItem = {
  id: string;
  channelSeq: string;
  sender: string;
  createdAt?: string | null;
  text: string | null;
  status: 'ok' | 'failed';
  error: string | null;
};

export type ChannelListResult = {
  profile: string;
  channels: ChannelListItem[];
};

export type ChannelShowResult = {
  profile: string;
  channel: ChannelListItem | null;
};

export type ChannelMessagesResult = {
  profile: string;
  slug: string;
  anonymous: boolean;
  cappedToRecent: boolean;
  messages: ChannelMessageItem[];
};

export type ChannelMemberListItem = {
  id: string;
  channelId: string;
  agentDbId: string;
  agentPublicIdentity: string;
  agentSlug: string;
  agentDisplayName: string | null;
  agentCurrentEncryptionPublicKey: string;
  agentCurrentEncryptionKeyVersion: string;
  permission: string;
  active: boolean;
  lastSentSeq: string;
};

export type ChannelMembersResult = {
  profile: string;
  slug: string;
  members: ChannelMemberListItem[];
};

export type ChannelJoinRequestItem = {
  id: string;
  channelId: string;
  channelSlug: string;
  channelTitle: string | null;
  requesterAgentDbId: string;
  requesterSlug: string;
  requesterDisplayName: string | null;
  permission: string;
  status: string;
  direction: string;
  createdAt: string;
  updatedAt: string;
};

export type ChannelJoinRequestsResult = {
  profile: string;
  requests: ChannelJoinRequestItem[];
};

export type ChannelMutationResult = {
  profile: string;
  slug?: string;
  channelId?: string;
  permission?: string;
  accessMode?: string;
  publicJoinPermission?: string;
  discoverable?: boolean;
  status: string;
};

export type ChannelApprovalPermissionPrompt = (request: ChannelJoinRequestItem) => Promise<string>;

type ChannelSnapshot = {
  actors: Agent[];
  visibleChannels: VisibleChannelRow[];
  memberships: VisibleChannelMembershipRow[];
  requests: VisibleChannelJoinRequestRow[];
};

type JoinedPublicChannelSnapshot = {
  channel: VisibleChannelRow;
  membership: VisibleChannelMembershipRow;
};

function subscribeQueries(
  conn: DbConnection,
  queries: ChannelQuery[],
  failureMessage: string
): Promise<SubscriptionHandle> {
  return new Promise((resolve, reject) => {
    const subscription = conn
      .subscriptionBuilder()
      .onApplied(() => {
        resolve(subscription);
      })
      .onError(error => {
        reject(
          connectivityError(failureMessage, {
            code: 'SPACETIMEDB_SUBSCRIPTION_FAILED',
            cause: error,
          })
        );
      })
      .subscribe(queries);
  });
}

function readChannelSnapshot(conn: DbConnection): ChannelSnapshot {
  return {
    actors: Array.from(conn.db.visibleAgents.iter()) as Agent[],
    visibleChannels: Array.from(conn.db.visibleChannels.iter()) as VisibleChannelRow[],
    memberships: Array.from(
      conn.db.visibleChannelMemberships.iter()
    ) as VisibleChannelMembershipRow[],
    requests: Array.from(
      conn.db.visibleChannelJoinRequests.iter()
    ) as VisibleChannelJoinRequestRow[],
  };
}

async function readPublicChannelMirrorBySlug(
  conn: DbConnection,
  normalizedSlug: string
): Promise<PublicChannelMirrorRow | null> {
  const publicChannelQuery = tables.publicChannels.where(row => row.slug.eq(normalizedSlug));
  const subscription = await subscribeQueries(
    conn,
    [publicChannelQuery],
    'Live public channel subscription failed.'
  );
  try {
    return (
      (Array.from(conn.db.publicChannels.iter()) as PublicChannelMirrorRow[]).find(
        row => row.slug === normalizedSlug
      ) ?? null
    );
  } finally {
    subscription.unsubscribe();
  }
}

function findJoinedPublicChannelSnapshot(params: {
  snapshot: ChannelSnapshot;
  slug: string;
  actorId: bigint;
}): JoinedPublicChannelSnapshot | null {
  const channel =
    params.snapshot.visibleChannels.find(row => row.slug === params.slug) ?? null;
  if (!channel) {
    return null;
  }

  const membership =
    params.snapshot.memberships.find(
      row =>
        row.channelId === channel.id &&
        row.agentDbId === params.actorId &&
        row.active
    ) ?? null;
  if (!membership) {
    return null;
  }

  return { channel, membership };
}

async function waitForJoinedPublicChannel(params: {
  read: () => ChannelSnapshot;
  slug: string;
  actorId: bigint;
  timeoutMs?: number;
}): Promise<JoinedPublicChannelSnapshot> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10_000);

  while (Date.now() < timeoutAt) {
    const joined = findJoinedPublicChannelSnapshot({
      snapshot: params.read(),
      slug: params.slug,
      actorId: params.actorId,
    });
    if (joined) {
      return joined;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for channel membership to sync.', {
    code: 'SPACETIMEDB_CHANNEL_JOIN_TIMEOUT',
  });
}

function publicChannelToListItem(channel: PublicChannelMirrorRow | PublicChannelPageRow): ChannelListItem {
  return {
    id: channel.channelId.toString(),
    slug: channel.slug,
    title: channel.title ?? null,
    description: channel.description ?? null,
    publicJoinPermission: channel.publicJoinPermission ?? 'read',
    discoverable: channel.discoverable,
    lastMessageSeq: channel.lastMessageSeq.toString(),
  };
}

function channelJoinRequestToItem(request: VisibleChannelJoinRequestRow): ChannelJoinRequestItem {
  return {
    id: request.id.toString(),
    channelId: request.channelId.toString(),
    channelSlug: request.channelSlug,
    channelTitle: request.channelTitle ?? null,
    requesterAgentDbId: request.requesterAgentDbId.toString(),
    requesterSlug: request.requesterSlug,
    requesterDisplayName: request.requesterDisplayName ?? null,
    permission: request.permission,
    status: request.status,
    direction: request.direction,
    createdAt: formatTimestamp(request.createdAt),
    updatedAt: formatTimestamp(request.updatedAt),
  };
}

function normalizeChannelSlugInput(slug: string): string {
  const normalized = normalizeInboxSlug(slug);
  if (!normalized) {
    throw userError('Channel slug is invalid.', {
      code: 'INVALID_CHANNEL_SLUG',
    });
  }
  return normalized;
}

const STALE_CHANNEL_SNAPSHOT_ERROR_PATTERNS = [
  'senderSigningKeyVersion must match',
  'senderSeq must be',
] as const;

function isStaleChannelSnapshotError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return STALE_CHANNEL_SNAPSHOT_ERROR_PATTERNS.some(pattern =>
    error.message.includes(pattern)
  );
}

function buildTextPayload(message: string, contentType?: string): EncryptedMessagePayload {
  const normalizedContentType = contentType ? normalizeContentType(contentType) : 'text/plain';
  const body = isJsonContentType(normalizedContentType)
    ? (() => {
        try {
          return JSON.parse(message) as EncryptedMessagePayload['body'];
        } catch {
          throw userError(
            `Message body must be valid JSON for content type \`${normalizedContentType}\`.`,
            { code: 'INVALID_MESSAGE_JSON_BODY' }
          );
        }
      })()
    : message;

  try {
    return normalizeEncryptedMessagePayload({
      contentType: normalizedContentType,
      body,
    });
  } catch (error) {
    throw userError(error instanceof Error ? error.message : 'Invalid channel message payload.', {
      code: 'INVALID_CHANNEL_MESSAGE_PAYLOAD',
    });
  }
}

function toMessageSignatureInput(message: {
  channelId: bigint;
  senderPublicIdentity: string;
  senderSeq: bigint;
  senderSigningKeyVersion: string;
  plaintext: string;
  replyToMessageId?: bigint | null;
}): ChannelMessageSignatureInput {
  return {
    channelId: message.channelId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderSeq: message.senderSeq,
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    replyToMessageId: message.replyToMessageId ?? null,
  };
}

function buildChannelSigningKey(agentDbId: bigint, signingKeyVersion: string): string {
  return `${agentDbId.toString()}:${signingKeyVersion}`;
}

function readStoredChannelSigningPublicKey(value: string): string | null {
  const normalized = value.trim();
  if (normalized === LEGACY_CHANNEL_SENDER_SIGNING_PUBLIC_KEY) {
    return null;
  }
  return normalized ? normalized : null;
}

async function resolveChannelMessageSigningKeys(
  conn: DbConnection | null,
  messages: Array<{
    senderAgentDbId?: bigint;
    senderSigningKeyVersion: string;
    senderSigningPublicKey: string;
  }>
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (!conn) {
    return resolved;
  }

  const requests = Array.from(
    new Map(
      messages
        .filter(
          (
            message
          ): message is {
            senderAgentDbId: bigint;
            senderSigningKeyVersion: string;
            senderSigningPublicKey: string;
          } =>
            message.senderAgentDbId !== undefined &&
            !readStoredChannelSigningPublicKey(message.senderSigningPublicKey)
        )
        .map(message => [
          buildChannelSigningKey(message.senderAgentDbId, message.senderSigningKeyVersion),
          {
            agentDbId: message.senderAgentDbId,
            signingKeyVersion: message.senderSigningKeyVersion,
          },
        ])
    ).values()
  );

  if (requests.length === 0) {
    return resolved;
  }

  const rows = (await conn.procedures.lookupPublishedAgentSigningKeys({
    requests,
  })) as Array<{
    agentDbId: bigint;
    signingKeyVersion: string;
    signingPublicKey: string;
  }>;

  for (const row of rows) {
    resolved.set(
      buildChannelSigningKey(row.agentDbId, row.signingKeyVersion),
      row.signingPublicKey
    );
  }

  return resolved;
}

export async function verifyChannelMessages(
  conn: DbConnection | null,
  messages: Array<{
    id: bigint;
    channelId: bigint;
    channelSeq: bigint;
    senderAgentDbId?: bigint;
    senderPublicIdentity: string;
    senderSeq: bigint;
    senderSigningPublicKey: string;
    senderSigningKeyVersion: string;
    plaintext: string;
    signature: string;
    replyToMessageId?: bigint | null;
    createdAt?: { toDate(): Date } | null;
  }>
): Promise<ChannelMessageItem[]> {
  const resolvedSigningKeys = await resolveChannelMessageSigningKeys(conn, messages);
  return Promise.all(
    messages.map(async message => {
      const senderSigningPublicKey =
        readStoredChannelSigningPublicKey(message.senderSigningPublicKey) ??
        (message.senderAgentDbId !== undefined
          ? resolvedSigningKeys.get(
              buildChannelSigningKey(message.senderAgentDbId, message.senderSigningKeyVersion)
            ) ?? null
          : null);

      try {
        if (!senderSigningPublicKey) {
          throw new Error('Unable to resolve sender signing key');
        }

        const verified = await verifySignedChannelMessage({
          input: toMessageSignatureInput(message),
          signature: message.signature,
          senderSigningPublicKey,
        });
        return {
          id: message.id.toString(),
          channelSeq: message.channelSeq.toString(),
          sender: message.senderPublicIdentity,
          createdAt: message.createdAt?.toDate().toISOString() ?? null,
          text: formatEncryptedMessageBody(verified.payload),
          status: 'ok',
          error: null,
        } satisfies ChannelMessageItem;
      } catch (error) {
        return {
          id: message.id.toString(),
          channelSeq: message.channelSeq.toString(),
          sender: message.senderPublicIdentity,
          createdAt: message.createdAt?.toDate().toISOString() ?? null,
          text: null,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unable to verify channel message',
        } satisfies ChannelMessageItem;
      }
    })
  );
}

function channelMemberToListItem(member: ChannelMemberListRow): ChannelMemberListItem {
  return {
    id: member.id.toString(),
    channelId: member.channelId.toString(),
    agentDbId: member.agentDbId.toString(),
    agentPublicIdentity: member.agentPublicIdentity,
    agentSlug: member.agentSlug,
    agentDisplayName: member.agentDisplayName ?? null,
    agentCurrentEncryptionPublicKey: member.agentCurrentEncryptionPublicKey,
    agentCurrentEncryptionKeyVersion: member.agentCurrentEncryptionKeyVersion,
    permission: member.permission,
    active: member.active,
    lastSentSeq: member.lastSentSeq.toString(),
  };
}

function parseOptionalU64(value: string | undefined, label: string): bigint | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = BigInt(value.trim());
    if (parsed < 0n) {
      throw new Error('negative');
    }
    return parsed;
  } catch {
    throw userError(`${label} must be a non-negative integer.`, {
      code: 'INVALID_UINT_ARGUMENT',
    });
  }
}

function parseRequiredU64(value: string, label: string): bigint {
  const parsed = parseOptionalU64(value, label);
  if (parsed === undefined) {
    throw userError(`${label} is required.`, {
      code: 'MISSING_UINT_ARGUMENT',
    });
  }
  return parsed;
}

function matchesPublishedActorKeys(actor: Agent, keyPair: AgentKeyPair): boolean {
  return (
    actor.currentEncryptionPublicKey === keyPair.encryption.publicKey &&
    actor.currentEncryptionKeyVersion === keyPair.encryption.keyVersion &&
    actor.currentSigningPublicKey === keyPair.signing.publicKey &&
    actor.currentSigningKeyVersion === keyPair.signing.keyVersion
  );
}

function requireDefaultActor(actors: Agent[], normalizedEmail: string): Agent {
  const actor = actors.find(row => row.isDefault && row.normalizedEmail === normalizedEmail);
  if (!actor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }
  return actor;
}

function requireOwnedActor(params: {
  actors: Agent[];
  normalizedEmail: string;
  actorSlug?: string;
}): Agent {
  const defaultActor = requireDefaultActor(params.actors, params.normalizedEmail);
  if (!params.actorSlug) {
    if (isDeregisteringOrDeregisteredInboxAgentState(defaultActor.masumiRegistrationState)) {
      throw userError(
        `Agent \`${defaultActor.slug}\` is deregistering or deregistered and cannot be used for channels.`,
        {
          code: 'AGENT_DEREGISTERED',
        }
      );
    }
    return defaultActor;
  }
  const normalizedSlug = normalizeInboxSlug(params.actorSlug);
  if (!normalizedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_AGENT_SLUG',
    });
  }
  const actor = params.actors.find(row => {
    return row.inboxId === defaultActor.inboxId && row.slug === normalizedSlug;
  });
  if (!actor) {
    throw userError(`No owned agent found for slug \`${normalizedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }
  if (isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)) {
    throw userError(
      `Agent \`${actor.slug}\` is deregistering or deregistered and cannot be used for channels.`,
      {
        code: 'AGENT_DEREGISTERED',
      }
    );
  }
  return actor;
}

function requireChannelAdminActor(params: {
  actors: Agent[];
  memberships: VisibleChannelMembershipRow[];
  normalizedEmail: string;
  channelId: bigint;
  actorSlug?: string;
}): Agent {
  const defaultActor = requireDefaultActor(params.actors, params.normalizedEmail);
  const candidates = params.actorSlug
    ? [
        requireOwnedActor({
          actors: params.actors,
          normalizedEmail: params.normalizedEmail,
          actorSlug: params.actorSlug,
        }),
      ]
    : [
        defaultActor,
        ...params.actors.filter(
          actor => actor.inboxId === defaultActor.inboxId && actor.id !== defaultActor.id
        ),
      ].filter(
        actor => !isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)
      );
  const adminActor = candidates.find(actor =>
    params.memberships.some(
      membership =>
        membership.channelId === params.channelId &&
        membership.agentDbId === actor.id &&
        membership.active &&
        membership.permission === 'admin'
    )
  );

  if (!adminActor) {
    throw userError('No owned admin agent found for this channel.', {
      code: 'CHANNEL_ADMIN_REQUIRED',
    });
  }

  return adminActor;
}

async function requireLocalKeyPair(params: {
  profile: Awaited<ReturnType<typeof ensureAuthenticatedSession>>['profile'];
  actor: Agent;
}) {
  const secretStore = createSecretStore();
  const keyPair = await getStoredActorKeyPair({
    profile: params.profile,
    secretStore,
    identity: {
      normalizedEmail: params.actor.normalizedEmail,
      slug: params.actor.slug,
      inboxIdentifier: params.actor.inboxIdentifier ?? undefined,
    },
  });
  if (!keyPair) {
    throw userError(`No local private keys found for \`${params.actor.slug}\`.`, {
      code: 'AGENT_KEYPAIR_REQUIRED',
    });
  }
  if (!matchesPublishedActorKeys(params.actor, keyPair)) {
    throw userError(
      `Local private keys do not match the published keys for \`${params.actor.slug}\`. Restore or rotate keys before using this channel.`,
      { code: 'AGENT_KEYPAIR_MISMATCH' }
    );
  }
  return keyPair;
}

function sortPublicChannels<T extends PublicChannelMirrorRow | PublicChannelPageRow>(channels: T[]): T[] {
  return [...channels].sort((left, right) => {
    if (left.lastMessageAt.microsSinceUnixEpoch > right.lastMessageAt.microsSinceUnixEpoch) {
      return -1;
    }
    if (left.lastMessageAt.microsSinceUnixEpoch < right.lastMessageAt.microsSinceUnixEpoch) {
      return 1;
    }
    if (left.channelId > right.channelId) return -1;
    if (left.channelId < right.channelId) return 1;
    return left.slug.localeCompare(right.slug);
  });
}

async function connectForAuthenticatedChannels(params: {
  profileName: string;
  reporter: TaskReporter;
}) {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  let subscription: SubscriptionHandle;
  try {
    subscription = await subscribeQueries(
      conn,
      [
        tables.visibleAgents,
        tables.visibleChannels,
        tables.visibleChannelMemberships,
        tables.visibleChannelJoinRequests,
      ],
      'Live channel subscription failed.'
    );
  } catch (error) {
    disconnectConnection(conn);
    throw error;
  }
  return {
    profile,
    normalizedEmail,
    conn,
    subscription,
  };
}

export async function listPublicChannels(params: {
  profileName: string;
  limit?: string;
  reporter: TaskReporter;
}): Promise<ChannelListResult> {
  const profile = await loadProfile(params.profileName);
  const { conn } = await connectAnonymous({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
  });
  try {
    const pageRows = await conn.procedures.listPublicChannels({
      beforeLastMessageAtMicros: undefined,
      beforeChannelId: undefined,
      limit: parseOptionalU64(params.limit, 'limit') ?? 25n,
    });
    const channels = sortPublicChannels(pageRows).map(publicChannelToListItem);
    params.reporter.success(`Loaded ${channels.length.toString()} public channel${channels.length === 1 ? '' : 's'}`);
    return {
      profile: profile.name,
      channels,
    };
  } finally {
    disconnectConnection(conn);
  }
}

export async function readPublicChannelMessages(params: {
  profileName: string;
  slug: string;
  reporter: TaskReporter;
}): Promise<ChannelMessagesResult> {
  const profile = await loadProfile(params.profileName);
  const normalizedSlug = normalizeChannelSlugInput(params.slug);
  const { conn } = await connectAnonymous({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
  });
  try {
    const publicChannelQuery = tables.publicChannels.where(row => row.slug.eq(normalizedSlug));
    const channelSubscription = await subscribeQueries(
      conn,
      [publicChannelQuery],
      'Live public channel subscription failed.'
    );
    try {
      const channel =
        (Array.from(conn.db.publicChannels.iter()) as PublicChannelMirrorRow[]).find(
          row => row.slug === normalizedSlug
        ) ?? null;
      if (!channel) {
        throw userError(`Public channel \`${normalizedSlug}\` was not found.`, {
          code: 'CHANNEL_NOT_FOUND',
        });
      }
      const publicRecentQuery = tables.publicRecentChannelMessages.where(row =>
        row.channelId.eq(channel.channelId)
      );
      const publicRecentSubscription = await subscribeQueries(
        conn,
        [publicRecentQuery],
        'Live public channel message subscription failed.'
      );
      try {
        const rows = (Array.from(
          conn.db.publicRecentChannelMessages.iter()
        ) as PublicRecentChannelMessage[]).sort((left, right) => {
          if (left.channelSeq < right.channelSeq) return -1;
          if (left.channelSeq > right.channelSeq) return 1;
          return Number(left.id - right.id);
        });
        const messages = await verifyChannelMessages(
          conn,
          rows.map(message => ({
            ...message,
            replyToMessageId: message.replyToMessageId ?? null,
          }))
        );
        params.reporter.success(`Loaded ${messages.length.toString()} recent channel message${messages.length === 1 ? '' : 's'}`);
        return {
          profile: profile.name,
          slug: channel.slug,
          anonymous: true,
          cappedToRecent: true,
          messages,
        };
      } finally {
        publicRecentSubscription.unsubscribe();
      }
    } finally {
      channelSubscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function showPublicChannel(params: {
  profileName: string;
  slug: string;
  reporter: TaskReporter;
}): Promise<ChannelShowResult> {
  const profile = await loadProfile(params.profileName);
  const normalizedSlug = normalizeChannelSlugInput(params.slug);
  const { conn } = await connectAnonymous({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
  });
  try {
    const publicChannelQuery = tables.publicChannels.where(row => row.slug.eq(normalizedSlug));
    const subscription = await subscribeQueries(
      conn,
      [publicChannelQuery],
      'Live public channel subscription failed.'
    );
    try {
      const channel =
        (Array.from(conn.db.publicChannels.iter()) as PublicChannelMirrorRow[]).find(
          row => row.slug === normalizedSlug
        ) ?? null;
      params.reporter.success(channel ? `Loaded #${channel.slug}` : `Channel ${normalizedSlug} not found`);
      return {
        profile: profile.name,
        channel: channel ? publicChannelToListItem(channel) : null,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function readAuthenticatedChannelMessages(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  beforeChannelSeq?: string;
  limit?: string;
  reporter: TaskReporter;
}): Promise<ChannelMessagesResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const actor = requireOwnedActor({
      actors: snapshot.actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const visibleChannel =
      snapshot.visibleChannels.find(row => row.slug === normalizedSlug) ?? null;
    const publicChannel = visibleChannel
      ? null
      : await readPublicChannelMirrorBySlug(conn, normalizedSlug);
    if (!visibleChannel && !publicChannel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const channelId = visibleChannel?.id ?? publicChannel?.channelId;
    const channelSlug = visibleChannel?.slug ?? publicChannel?.slug ?? normalizedSlug;
    const rows = await conn.procedures.listChannelMessages({
      agentDbId: actor.id,
      channelId,
      channelSlug: undefined,
      beforeChannelSeq: parseOptionalU64(params.beforeChannelSeq, 'beforeChannelSeq'),
      limit: parseOptionalU64(params.limit, 'limit') ?? 25n,
    });
    const sortedRows = [...rows].sort((left, right) => {
      if (left.channelSeq < right.channelSeq) return -1;
      if (left.channelSeq > right.channelSeq) return 1;
      return Number(left.id - right.id);
    });
    const messages = await verifyChannelMessages(conn, sortedRows);
    params.reporter.success(`Loaded ${messages.length.toString()} channel message${messages.length === 1 ? '' : 's'}`);
    return {
      profile: profile.name,
      slug: channelSlug,
      anonymous: false,
      cappedToRecent: false,
      messages,
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function listChannelMembers(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  afterMemberId?: string;
  limit?: string;
  reporter: TaskReporter;
}): Promise<ChannelMembersResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const actor = requireOwnedActor({
      actors: snapshot.actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const channel =
      snapshot.visibleChannels.find(row => row.slug === normalizeChannelSlugInput(params.slug)) ??
      null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const members = await conn.procedures.listChannelMembers({
      agentDbId: actor.id,
      channelId: channel.id,
      channelSlug: undefined,
      afterMemberId: parseOptionalU64(params.afterMemberId, 'afterMemberId'),
      limit: parseOptionalU64(params.limit, 'limit') ?? 25n,
    });
    params.reporter.success(`Loaded ${members.length.toString()} channel member${members.length === 1 ? '' : 's'}`);
    return {
      profile: profile.name,
      slug: channel.slug,
      members: members.map(channelMemberToListItem),
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function createChannel(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  title?: string;
  description?: string;
  accessMode: 'public' | 'approval_required';
  publicJoinPermission?: string;
  discoverable: boolean;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const actor = requireOwnedActor({
      actors: readChannelSnapshot(conn).actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    await conn.reducers.createChannel({
      agentDbId: actor.id,
      slug: normalizedSlug,
      title: params.title?.trim() || undefined,
      description: params.description?.trim() || undefined,
      accessMode: params.accessMode,
      publicJoinPermission: params.publicJoinPermission,
      discoverable: params.discoverable,
    });
    params.reporter.success(`Created channel ${params.slug}`);
    return {
      profile: profile.name,
      slug: normalizedSlug,
      publicJoinPermission: params.publicJoinPermission ?? 'read',
      status: 'created',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function updateChannelSettings(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  accessMode?: 'public' | 'approval_required';
  publicJoinPermission?: string;
  discoverable?: boolean;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  if (
    params.accessMode === undefined &&
    params.publicJoinPermission === undefined &&
    params.discoverable === undefined
  ) {
    throw userError('Pass at least one channel setting to update.', {
      code: 'CHANNEL_SETTING_REQUIRED',
    });
  }

  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const channel =
      snapshot.visibleChannels.find(row => row.slug === normalizedSlug) ?? null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const adminActor = requireChannelAdminActor({
      actors: snapshot.actors,
      memberships: snapshot.memberships,
      normalizedEmail,
      channelId: channel.id,
      actorSlug: params.actorSlug,
    });

    await conn.reducers.updateChannelSettings({
      agentDbId: adminActor.id,
      channelId: channel.id,
      channelSlug: undefined,
      accessMode: params.accessMode,
      publicJoinPermission: params.publicJoinPermission,
      discoverable: params.discoverable,
    });
    params.reporter.success(`Updated channel settings for ${params.slug}`);
    return {
      profile: profile.name,
      slug: channel.slug,
      channelId: channel.id.toString(),
      accessMode: params.accessMode,
      publicJoinPermission: params.publicJoinPermission,
      discoverable: params.discoverable,
      status: 'settings-updated',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function joinPublicChannel(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const actor = requireOwnedActor({
      actors: readChannelSnapshot(conn).actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    await conn.reducers.joinPublicChannel({
      agentDbId: actor.id,
      channelId: undefined,
      channelSlug: normalizedSlug,
    });
    const { channel: joinedChannel, membership: joinedMembership } =
      await waitForJoinedPublicChannel({
        read: () => readChannelSnapshot(conn),
        slug: normalizedSlug,
        actorId: actor.id,
      });
    const permission = joinedMembership.permission;
    params.reporter.success(`Joined public channel ${params.slug}`);
    return {
      profile: profile.name,
      slug: normalizedSlug,
      channelId: joinedChannel.id.toString(),
      permission,
      status: 'joined',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function requestChannelJoin(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  permission: string;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const actor = requireOwnedActor({
      actors: readChannelSnapshot(conn).actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    await conn.reducers.requestChannelJoin({
      agentDbId: actor.id,
      channelId: undefined,
      channelSlug: normalizeChannelSlugInput(params.slug),
      permission: params.permission,
    });
    params.reporter.success(`Requested access to ${params.slug}`);
    return {
      profile: profile.name,
      slug: normalizeChannelSlugInput(params.slug),
      status: 'requested',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function sendChannelMessage(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  message: string;
  contentType?: string;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;

  async function attemptSend(): Promise<ChannelMutationResult> {
    const snapshot = readChannelSnapshot(conn);
    const actor = requireOwnedActor({
      actors: snapshot.actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const channel =
      snapshot.visibleChannels.find(row => row.slug === normalizeChannelSlugInput(params.slug)) ??
      null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const membership =
      snapshot.memberships.find(
        row => row.channelId === channel.id && row.agentDbId === actor.id && row.active
      ) ?? null;
    if (!membership) {
      throw userError('Join the channel before sending.', {
        code: 'CHANNEL_MEMBERSHIP_REQUIRED',
      });
    }
    const keyPair = await requireLocalKeyPair({ profile, actor });
    const nextSeq = membership.lastSentSeq + 1n;
    const prepared = await prepareChannelMessage({
      channelId: channel.id,
      senderPublicIdentity: actor.publicIdentity,
      senderSeq: nextSeq,
      keyPair,
      payload: buildTextPayload(params.message, params.contentType),
    });
    await conn.reducers.sendChannelMessage({
      agentDbId: actor.id,
      channelId: channel.id,
      senderSeq: nextSeq,
      senderSigningKeyVersion: prepared.senderSigningKeyVersion,
      plaintext: prepared.plaintext,
      signature: prepared.signature,
      replyToMessageId: undefined,
    });
    return {
      profile: profile.name,
      slug: channel.slug,
      channelId: channel.id.toString(),
      status: 'sent',
    };
  }

  try {
    const maxRetries = 2;
    let result: ChannelMutationResult | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        result = await attemptSend();
        break;
      } catch (error) {
        lastError = error;
        if (!isStaleChannelSnapshotError(error) || attempt === maxRetries) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (!result) {
      throw lastError ?? new Error('Failed to send channel message');
    }
    params.reporter.success(`Sent message to ${params.slug}`);
    return result;
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

function formatTimestamp(timestamp: { microsSinceUnixEpoch: bigint }): string {
  const millis = Number(timestamp.microsSinceUnixEpoch / 1000n);
  return new Date(millis).toISOString();
}

export async function listChannelJoinRequests(params: {
  profileName: string;
  actorSlug?: string;
  slug?: string;
  direction?: 'incoming' | 'outgoing';
  includeResolved?: boolean;
  requireAdmin?: boolean;
  reporter: TaskReporter;
}): Promise<ChannelJoinRequestsResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const channelSlug = params.slug ? normalizeChannelSlugInput(params.slug) : null;
    const selectedChannel = channelSlug
      ? snapshot.visibleChannels.find(row => row.slug === channelSlug) ?? null
      : null;
    const selectedChannelId = selectedChannel?.id ?? null;

    if (channelSlug && !selectedChannel) {
      throw userError(`Channel \`${channelSlug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }

    if (params.requireAdmin) {
      if (selectedChannelId === null) {
        throw userError('A channel slug is required for channel approvals.', {
          code: 'CHANNEL_SLUG_REQUIRED',
        });
      }
      requireChannelAdminActor({
        actors: snapshot.actors,
        memberships: snapshot.memberships,
        normalizedEmail,
        channelId: selectedChannelId,
        actorSlug: params.actorSlug,
      });
    }

    const filtered = snapshot.requests.filter(request => {
      if (selectedChannelId !== null && request.channelId !== selectedChannelId) {
        return false;
      }
      if (params.direction && request.direction !== params.direction) {
        return false;
      }
      if (!params.includeResolved && request.status !== 'pending') {
        return false;
      }
      return true;
    });
    const requests: ChannelJoinRequestItem[] = filtered
      .slice()
      .sort((left, right) => {
        if (left.createdAt.microsSinceUnixEpoch < right.createdAt.microsSinceUnixEpoch) return 1;
        if (left.createdAt.microsSinceUnixEpoch > right.createdAt.microsSinceUnixEpoch) return -1;
        return 0;
      })
      .map(channelJoinRequestToItem);
    params.reporter.success(
      `Loaded ${requests.length.toString()} channel join request${requests.length === 1 ? '' : 's'}`
    );
    return {
      profile: profile.name,
      requests,
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function approveChannelJoin(params: {
  profileName: string;
  actorSlug?: string;
  requestId: string;
  permission?: string;
  selectPermission?: ChannelApprovalPermissionPrompt;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const adminActor = requireOwnedActor({
      actors: snapshot.actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const requestId = parseRequiredU64(params.requestId, 'requestId');
    const request = snapshot.requests.find(row => row.id === requestId);
    if (!request) {
      throw userError(`Channel join request ${params.requestId} is not visible.`, {
        code: 'CHANNEL_REQUEST_NOT_FOUND',
      });
    }
    const channel =
      snapshot.visibleChannels.find(row => row.id === request.channelId) ?? null;
    if (!channel) {
      throw userError(`Channel join request ${params.requestId} channel is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const permission =
      params.permission ??
      (params.selectPermission
        ? await params.selectPermission(channelJoinRequestToItem(request))
        : request.permission || 'read');
    await conn.reducers.approveChannelJoin({
      agentDbId: adminActor.id,
      requestId,
      permission,
    });
    params.reporter.success(`Approved channel join request ${params.requestId}`);
    return {
      profile: profile.name,
      channelId: request.channelId.toString(),
      permission,
      status: 'approved',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function rejectChannelJoin(params: {
  profileName: string;
  actorSlug?: string;
  requestId: string;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const adminActor = requireOwnedActor({
      actors: snapshot.actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const requestId = parseRequiredU64(params.requestId, 'requestId');
    await conn.reducers.rejectChannelJoin({
      agentDbId: adminActor.id,
      requestId,
    });
    params.reporter.success(`Rejected channel join request ${params.requestId}`);
    return {
      profile: profile.name,
      status: 'rejected',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function setChannelMemberPermission(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  memberAgentDbId: string;
  permission: string;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const adminActor = requireOwnedActor({
      actors: snapshot.actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const channel =
      snapshot.visibleChannels.find(row => row.slug === normalizeChannelSlugInput(params.slug)) ??
      null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    await conn.reducers.setChannelMemberPermission({
      agentDbId: adminActor.id,
      channelId: channel.id,
      memberAgentDbId: parseRequiredU64(params.memberAgentDbId, 'memberAgentDbId'),
      permission: params.permission,
    });
    params.reporter.success(`Updated member permission in ${params.slug}`);
    return {
      profile: profile.name,
      slug: channel.slug,
      channelId: channel.id.toString(),
      status: 'permission-updated',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}

export async function removeChannelMember(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  memberAgentDbId: string;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, normalizedEmail, conn, subscription } = connected;
  try {
    const snapshot = readChannelSnapshot(conn);
    const actor = requireOwnedActor({
      actors: snapshot.actors,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const channel =
      snapshot.visibleChannels.find(row => row.slug === normalizeChannelSlugInput(params.slug)) ??
      null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    await conn.reducers.removeChannelMember({
      agentDbId: actor.id,
      channelId: channel.id,
      memberAgentDbId: parseRequiredU64(params.memberAgentDbId, 'memberAgentDbId'),
    });
    params.reporter.success(`Removed member from ${params.slug}`);
    return {
      profile: profile.name,
      slug: channel.slug,
      channelId: channel.id.toString(),
      status: 'member-removed',
    };
  } finally {
    subscription.unsubscribe();
    disconnectConnection(conn);
  }
}
