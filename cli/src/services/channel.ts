import type { Query, TypedTableDef } from 'spacetimedb';
import {
  prepareChannelMessage,
  verifySignedChannelMessage,
  type ChannelMessageSignatureInput,
} from '../../../shared/channel-crypto';
import { fromHex, toHex } from '../../../shared/crypto-utils';
import { randomSenderMessageId } from '../../../shared/agent-crypto';
import { isDeregisteringOrDeregisteredInboxAgentState } from '../../../shared/inbox-agent-registration';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { prepareSpacetimeSubscriptionQuery } from '../../../shared/spacetime-subscription-limits';
import {
  formatEncryptedMessageBody,
  isJsonContentType,
  normalizeContentType,
  normalizeEncryptedMessagePayload,
  type EncryptedMessagePayload,
} from '../../../shared/message-format';
import type {
  Agent,
  ChannelJoinRequest,
  ChannelMember,
  Channel,
} from '../../../webapp/src/module_bindings/types';
import { tables, type DbConnection, type SubscriptionHandle } from '../../../webapp/src/module_bindings';
import { getStoredActorKeyPair } from './actor-keys';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import { loadProfile } from './config-store';
import { connectivityError, userError } from './errors';
import { requireImportedRotationKeyConfirmed } from './imported-rotation-key-confirmation';
import { createSecretStore } from './secret-store';
import {
  connectAnonymous,
  connectAuthenticated,
  disconnectConnection,
  readAllOwnedAgents,
  readPendingChannelJoinRequests,
} from './spacetimedb';

type ChannelQuery = Query<TypedTableDef> | string;
const limitSubscription = prepareSpacetimeSubscriptionQuery;

export type ChannelListItem = {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  accessMode: 'public' | 'approval_required';
  discoverable: boolean;
  messageCount: string;
  lastMessageAt: string;
};

export type ChannelMessageItem = {
  id: string;
  messageId: string;
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
  agentCurrentKeyBundleVersion: string;
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
  discoverable?: boolean;
  status: string;
};

export type ChannelApprovalPermissionPrompt = (request: ChannelJoinRequestItem) => Promise<string>;

type ChannelSnapshot = {
  actors: Agent[];
  visible_channels: Channel[];
  memberships: ChannelMember[];
  requests: ChannelJoinRequest[];
};

type ChannelAccessModeInput = 'public' | 'approval_required';

function enumTag(value: { tag: string } | string | null | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return value?.tag ?? '';
}

function channelAccessModeToReducer(mode: ChannelAccessModeInput): { tag: 'Public' } | { tag: 'ApprovalRequired' } {
  return mode === 'approval_required' ? { tag: 'ApprovalRequired' } : { tag: 'Public' };
}

function channelAccessModeToCli(mode: { tag: string } | string | null | undefined): ChannelAccessModeInput {
  const tag = enumTag(mode);
  return tag === 'ApprovalRequired' || tag === 'approval_required' ? 'approval_required' : 'public';
}

function channelPermissionToReducer(
  permission: string
): { tag: 'Read' } | { tag: 'ReadWrite' } | { tag: 'Admin' } {
  if (permission === 'read_write' || permission === 'ReadWrite') return { tag: 'ReadWrite' };
  if (permission === 'admin' || permission === 'Admin') return { tag: 'Admin' };
  if (permission === 'read' || permission === 'Read') return { tag: 'Read' };
  throw userError('Permission must be read, read_write, or admin.', {
    code: 'INVALID_CHANNEL_PERMISSION',
  });
}

function channelPermissionToCli(permission: { tag: string } | string | null | undefined): string {
  const tag = enumTag(permission);
  if (tag === 'ReadWrite') return 'read_write';
  if (tag === 'Admin') return 'admin';
  if (tag === 'Read') return 'read';
  return tag || 'read';
}

function channelMessageCount(channel: Channel): bigint {
  return channel.messageCount;
}

type JoinedPublicChannelSnapshot = {
  channel: Channel;
  membership: ChannelMember;
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

async function readChannelSnapshot(conn: DbConnection): Promise<ChannelSnapshot> {
  const [actors, requests] = await Promise.all([
    readAllOwnedAgents(conn),
    readPendingChannelJoinRequests(conn),
  ]);
  return {
    actors,
    visible_channels: Array.from(conn.db.visible_channels.iter()) as Channel[],
    memberships: Array.from(
      conn.db.visible_channel_memberships.iter()
    ) as ChannelMember[],
    requests,
  };
}

async function lookupPublicChannelBySlug(
  conn: DbConnection,
  normalizedSlug: string
): Promise<Channel | null> {
  return (await conn.procedures.lookupPublicChannelBySlug({
    slug: normalizedSlug,
  })) ?? null;
}

async function readVisibleChannelStateSnapshot(
  conn: DbConnection,
  params: {
    channelId?: bigint;
    channelSlug?: string;
    requestId?: bigint;
  }
): Promise<ChannelSnapshot> {
  const state = await conn.procedures.readVisibleChannelState({
    channelId: params.channelId,
    channelSlug: params.channelSlug,
  });
  const [actors, requests] = await Promise.all([
    readAllOwnedAgents(conn),
    readPendingChannelJoinRequests(conn),
  ]);
  return {
    actors,
    visible_channels: state ? [state.channel] : [],
    memberships: state?.member ? [state.member] : [],
    requests: params.requestId
      ? requests.filter(request => request.id === params.requestId)
      : state
        ? requests.filter(request => request.channelId === state.channel.id)
        : requests,
  };
}

async function readOwnedChannelActor(params: {
  conn: DbConnection;
  email: string;
  actorSlug?: string;
}): Promise<Agent> {
  const normalizedSlug =
    params.actorSlug === undefined ? undefined : normalizeInboxSlug(params.actorSlug);
  if (params.actorSlug !== undefined && !normalizedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_AGENT_SLUG',
    });
  }
  if (!normalizedSlug) {
    throw userError('Pass --agent <slug> for channel actions.', {
      code: 'AGENT_SLUG_REQUIRED',
    });
  }
  const actor = await params.conn.procedures.readOwnedAgent({
    slug: normalizedSlug,
  });
  if (!actor) {
    throw userError(
      `No owned agent found for slug \`${normalizedSlug}\`.`,
      {
        code: 'OWNED_ACTOR_NOT_FOUND',
      }
    );
  }
  if (actor.email !== params.email) {
    throw userError('Current OIDC session email does not match the selected agent.', {
      code: 'OIDC_EMAIL_MISMATCH',
    });
  }
  if (isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState?.tag)) {
    throw userError(
      `Agent \`${actor.slug}\` is deregistering or deregistered and cannot be used for channels.`,
      {
        code: 'AGENT_DEREGISTERED',
      }
    );
  }
  return actor;
}

function findJoinedPublicChannelSnapshot(params: {
  snapshot: ChannelSnapshot;
  slug: string;
  actorId: bigint;
}): JoinedPublicChannelSnapshot | null {
  const channel =
    params.snapshot.visible_channels.find(row => row.slug === params.slug) ?? null;
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
  read: () => ChannelSnapshot | Promise<ChannelSnapshot>;
  slug: string;
  actorId: bigint;
  timeoutMs?: number;
}): Promise<JoinedPublicChannelSnapshot> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10_000);

  while (Date.now() < timeoutAt) {
    const joined = findJoinedPublicChannelSnapshot({
      snapshot: await params.read(),
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

function channelToListItem(channel: Channel): ChannelListItem {
  return {
    id: channel.id.toString(),
    slug: channel.slug,
    title: channel.title ?? null,
    description: channel.description ?? null,
    accessMode: channelAccessModeToCli(channel.accessMode),
    discoverable: channel.discoverable,
    messageCount: channelMessageCount(channel).toString(),
    lastMessageAt: formatTimestamp(channel.lastMessageAt),
  };
}

function channelJoinRequestToItem(
  request: ChannelJoinRequest,
  params: {
    channel?: Channel | null;
    requester?: Agent | null;
    ownedAgentIds?: Set<bigint>;
    adminChannelIds?: Set<bigint>;
  } = {}
): ChannelJoinRequestItem {
  const channel = params.channel ?? null;
  const requester = params.requester ?? null;
  const isOutgoing = params.ownedAgentIds?.has(request.requesterAgentDbId) ?? false;
  const isIncoming = params.adminChannelIds?.has(request.channelId) ?? false;
  return {
    id: request.id.toString(),
    channelId: request.channelId.toString(),
    channelSlug: channel?.slug ?? `channel:${request.channelId.toString()}`,
    channelTitle: channel?.title ?? null,
    requesterAgentDbId: request.requesterAgentDbId.toString(),
    requesterSlug: requester?.slug ?? `agent:${request.requesterAgentDbId.toString()}`,
    requesterDisplayName: requester?.displayName ?? null,
    permission: channelPermissionToCli(request.permission),
    status: enumTag(request.status).toLowerCase(),
    direction: isOutgoing && !isIncoming ? 'outgoing' : 'incoming',
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
  senderMessageId: bigint;
  senderSigningKeyVersion: number;
  plaintext: string;
  replyToMessageId?: bigint | null;
}): ChannelMessageSignatureInput {
  return {
    channelId: message.channelId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderMessageId: message.senderMessageId,
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    replyToMessageId: message.replyToMessageId ?? null,
  };
}

function buildChannelSigningKey(agentDbId: bigint, signingKeyVersion: number): string {
  return `${agentDbId.toString()}:${signingKeyVersion}`;
}

async function resolveChannelMessageSigningKeys(
  conn: DbConnection | null,
  messages: Array<{
    senderAgentDbId?: bigint;
    senderSigningKeyVersion: number;
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
          (message): message is { senderAgentDbId: bigint; senderSigningKeyVersion: number } =>
            message.senderAgentDbId !== undefined
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
    signingKeyVersion: number;
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
    senderAgentDbId?: bigint;
    senderPublicIdentity: string;
    senderMessageId: bigint;
    senderSigningKeyVersion: number;
    plaintext: string;
    signature: string | Uint8Array;
    replyToMessageId?: bigint | null;
    createdAt?: { toDate(): Date } | null;
  }>
): Promise<ChannelMessageItem[]> {
  const resolvedSigningKeys = await resolveChannelMessageSigningKeys(conn, messages);
  return Promise.all(
    messages.map(async message => {
      const senderSigningPublicKey =
        message.senderAgentDbId !== undefined
          ? resolvedSigningKeys.get(
              buildChannelSigningKey(message.senderAgentDbId, message.senderSigningKeyVersion)
            ) ?? null
          : null;

      try {
        if (!senderSigningPublicKey) {
          throw new Error('Unable to resolve sender signing key');
        }

        const verified = await verifySignedChannelMessage({
          input: toMessageSignatureInput(message),
          signature: typeof message.signature === 'string' ? message.signature : toHex(message.signature),
          senderSigningPublicKey,
        });
        return {
          id: message.id.toString(),
          messageId: message.id.toString(),
          sender: message.senderPublicIdentity,
          createdAt: message.createdAt?.toDate().toISOString() ?? null,
          text: formatEncryptedMessageBody(verified.payload),
          status: 'ok',
          error: null,
        } satisfies ChannelMessageItem;
      } catch (error) {
        return {
          id: message.id.toString(),
          messageId: message.id.toString(),
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

function channelMemberToListItem(
  member: ChannelMember,
  agent: Agent | null = null
): ChannelMemberListItem {
  return {
    id: member.id.toString(),
    channelId: member.channelId.toString(),
    agentDbId: member.agentDbId.toString(),
    agentPublicIdentity: agent?.publicIdentity ?? '',
    agentSlug: agent?.slug ?? `agent:${member.agentDbId.toString()}`,
    agentDisplayName: agent?.displayName ?? null,
    agentCurrentEncryptionPublicKey: '',
    agentCurrentKeyBundleVersion: agent?.currentKeyBundleVersion?.toString() ?? '',
    permission: channelPermissionToCli(member.permission),
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

function parseOptionalU32(value: string | undefined, label: string): number | undefined {
  const parsed = parseOptionalU64(value, label);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed > 0xffffffffn) {
    throw userError(`${label} must be a 32-bit unsigned integer.`, {
      code: 'INVALID_UINT_ARGUMENT',
    });
  }
  return Number(parsed);
}

function requireChannelAdminActor(params: {
  actors: Agent[];
  memberships: ChannelMember[];
  email: string;
  channelId: bigint;
  actorSlug?: string;
  preferredActor?: Agent;
}): Agent {
  const actor = params.preferredActor;
  if (!actor) {
    throw userError('Pass --agent <slug> for channel admin actions.', {
      code: 'AGENT_SLUG_REQUIRED',
    });
  }
  const hasAdminMembership = params.memberships.some(
    membership =>
      membership.channelId === params.channelId &&
      membership.agentDbId === actor.id &&
      membership.active &&
      enumTag(membership.permission) === 'Admin'
  );

  if (!hasAdminMembership) {
    throw userError('No owned admin agent found for this channel.', {
      code: 'CHANNEL_ADMIN_REQUIRED',
    });
  }

  return actor;
}

async function requireLocalKeyPair(params: {
  conn: DbConnection;
  profile: Awaited<ReturnType<typeof ensureAuthenticatedSession>>['profile'];
  actor: Agent;
}) {
  const secretStore = createSecretStore();
  const identity = {
    email: params.actor.email,
    slug: params.actor.slug,
  };
  const keyPair = await getStoredActorKeyPair({
    profile: params.profile,
    secretStore,
    identity,
  });
  if (!keyPair) {
    throw userError(`No local private keys found for \`${params.actor.slug}\`.`, {
      code: 'AGENT_KEYPAIR_REQUIRED',
    });
  }
  const publishedKeys = await params.conn.procedures.lookupAgentPublicKeys({
    requests: [
      {
        agentDbId: params.actor.id,
        keyKind: { tag: 'Encryption' },
        keyVersion: params.actor.currentKeyBundleVersion,
      },
      {
        agentDbId: params.actor.id,
        keyKind: { tag: 'Signing' },
        keyVersion: params.actor.currentKeyBundleVersion,
      },
    ],
  });
  const publishedEncryptionKey =
    publishedKeys.find(row => row.keyKind.tag === 'Encryption')?.publicKey ?? null;
  const publishedSigningKey =
    publishedKeys.find(row => row.keyKind.tag === 'Signing')?.publicKey ?? null;
  if (
    publishedEncryptionKey !== keyPair.encryption.publicKey ||
    publishedSigningKey !== keyPair.signing.publicKey ||
    params.actor.currentKeyBundleVersion !== keyPair.encryption.keyVersion ||
    params.actor.currentKeyBundleVersion !== keyPair.signing.keyVersion
  ) {
    throw userError(
      `Local private keys do not match the published keys for \`${params.actor.slug}\`. Restore or reset keys before using this channel.`,
      { code: 'AGENT_KEYPAIR_MISMATCH' }
    );
  }
  await requireImportedRotationKeyConfirmed({
    identity,
    keyPair,
  });
  return keyPair;
}

function sortChannels<T extends Channel>(channels: T[]): T[] {
  return [...channels].sort((left, right) => {
    if (left.lastMessageAt.microsSinceUnixEpoch > right.lastMessageAt.microsSinceUnixEpoch) {
      return -1;
    }
    if (left.lastMessageAt.microsSinceUnixEpoch < right.lastMessageAt.microsSinceUnixEpoch) {
      return 1;
    }
    if (left.id > right.id) return -1;
    if (left.id < right.id) return 1;
    return left.slug.localeCompare(right.slug);
  });
}

async function connectForAuthenticatedChannels(params: {
  profileName: string;
  reporter: TaskReporter;
}, options: { includeJoinRequests?: boolean } = {}) {
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
  let subscription: SubscriptionHandle;
  try {
    const queries: ChannelQuery[] = [
      limitSubscription(tables.visible_channels, 'visible_channels'),
      limitSubscription(tables.visible_channel_memberships, 'visible_channel_memberships'),
    ];
    void options.includeJoinRequests;
    subscription = await subscribeQueries(
      conn,
      queries,
      'Live channel subscription failed.'
    );
  } catch (error) {
    disconnectConnection(conn);
    throw error;
  }
  return {
    profile,
    email,
    conn,
    subscription,
  };
}

export async function listDiscoverableChannels(params: {
  profileName: string;
  limit?: string;
  reporter: TaskReporter;
}): Promise<ChannelListResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, conn, subscription } = connected;
  try {
    const pageRows = await conn.procedures.listDiscoverableChannels({
      beforeLastMessageAt: undefined,
      beforeChannelId: undefined,
      limit: parseOptionalU32(params.limit, 'limit') ?? 25,
    });
    const channels = sortChannels(pageRows).map(channelToListItem);
    params.reporter.success(`Loaded ${channels.length.toString()} discoverable channel${channels.length === 1 ? '' : 's'}`);
    return {
      profile: profile.name,
      channels,
    };
  } finally {
    subscription.unsubscribe();
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
    const channel = await lookupPublicChannelBySlug(conn, normalizedSlug);
    if (!channel) {
      throw userError(`Public channel \`${normalizedSlug}\` was not found.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const rows = await conn.procedures.listPublicChannelMessages({
      channelSlug: normalizedSlug,
      beforeMessageId: undefined,
      limit: 25,
    });
    const messages = await verifyChannelMessages(
      conn,
      [...rows]
        .sort((left, right) => {
          if (left.id < right.id) return -1;
          if (left.id > right.id) return 1;
          return Number(left.id - right.id);
        })
        .map(message => ({
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
    const channel = await lookupPublicChannelBySlug(conn, normalizedSlug);
    params.reporter.success(channel ? `Loaded #${channel.slug}` : `Channel ${normalizedSlug} not found`);
    return {
      profile: profile.name,
      channel: channel ? channelToListItem(channel) : null,
    };
  } finally {
    disconnectConnection(conn);
  }
}

export async function readAuthenticatedChannelMessages(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  beforeMessageId?: string;
  limit?: string;
  reporter: TaskReporter;
}): Promise<ChannelMessagesResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, email, conn, subscription } = connected;
  try {
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const actor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const channelState = await readVisibleChannelStateSnapshot(conn, {
      channelSlug: normalizedSlug,
    });
    const visibleChannel =
      channelState.visible_channels.find(row => row.slug === normalizedSlug) ?? null;
    const publicChannel = visibleChannel
      ? null
      : await lookupPublicChannelBySlug(conn, normalizedSlug);
    if (!visibleChannel && !publicChannel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const channelId = visibleChannel?.id ?? publicChannel?.id;
    if (channelId === undefined) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const channelSlug = visibleChannel?.slug ?? publicChannel?.slug ?? normalizedSlug;
    const rows =
      visibleChannel && channelState.memberships.some(row => row.agentDbId === actor.id && row.active)
        ? await conn.procedures.listChannelMessages({
            channelId,
            beforeMessageId: parseOptionalU64(params.beforeMessageId, 'beforeMessageId'),
            limit: parseOptionalU32(params.limit, 'limit') ?? 25,
          })
        : await conn.procedures.listPublicChannelMessages({
            channelSlug,
            beforeMessageId: parseOptionalU64(params.beforeMessageId, 'beforeMessageId'),
            limit: parseOptionalU32(params.limit, 'limit') ?? 25,
          });
    const sortedRows = [...rows].sort((left, right) => {
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
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
  const { profile, email, conn, subscription } = connected;
  try {
    await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const channelState = await readVisibleChannelStateSnapshot(conn, {
      channelSlug: normalizedSlug,
    });
    const channel =
      channelState.visible_channels.find(row => row.slug === normalizedSlug) ?? null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const members = await conn.procedures.listChannelMembers({
      channelId: channel.id,
      afterId: parseOptionalU64(params.afterMemberId, 'afterMemberId'),
      limit: parseOptionalU32(params.limit, 'limit') ?? 25,
    });
    const agentsById = new Map(channelState.actors.map(agent => [agent.id, agent] as const));
    params.reporter.success(`Loaded ${members.length.toString()} channel member${members.length === 1 ? '' : 's'}`);
    return {
      profile: profile.name,
      slug: channel.slug,
      members: members.map(member => channelMemberToListItem(member, agentsById.get(member.agentDbId) ?? null)),
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
  discoverable: boolean;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, email, conn, subscription } = connected;
  try {
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const actor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    await conn.reducers.createChannel({
      agentDbId: actor.id,
      slug: normalizedSlug,
      title: params.title?.trim() || undefined,
      description: params.description?.trim() || undefined,
      accessMode: channelAccessModeToReducer(params.accessMode),
      discoverable: params.discoverable,
      defaultPermission: undefined,
    });
    params.reporter.success(`Created channel ${params.slug}`);
    return {
      profile: profile.name,
      slug: normalizedSlug,
      accessMode: params.accessMode,
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
  discoverable?: boolean;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  if (
    params.accessMode === undefined &&
    params.discoverable === undefined
  ) {
    throw userError('Pass at least one channel setting to update.', {
      code: 'CHANNEL_SETTING_REQUIRED',
    });
  }

  const connected = await connectForAuthenticatedChannels(params);
  const { profile, email, conn, subscription } = connected;
  try {
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const actor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const channelState = await readVisibleChannelStateSnapshot(conn, {
      channelSlug: normalizedSlug,
    });
    const channel =
      channelState.visible_channels.find(row => row.slug === normalizedSlug) ?? null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const adminActor = requireChannelAdminActor({
      actors: channelState.actors,
      memberships: channelState.memberships,
      email,
      channelId: channel.id,
      actorSlug: params.actorSlug,
      preferredActor: actor,
    });

    await conn.reducers.updateChannelSettings({
      agentDbId: adminActor.id,
      channelId: channel.id,
      title: undefined,
      description: undefined,
      accessMode: params.accessMode ? channelAccessModeToReducer(params.accessMode) : undefined,
      discoverable: params.discoverable,
      defaultPermission: undefined,
    });
    params.reporter.success(`Updated channel settings for ${params.slug}`);
    return {
      profile: profile.name,
      slug: channel.slug,
      channelId: channel.id.toString(),
      accessMode: params.accessMode,
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
  const { profile, email, conn, subscription } = connected;
  try {
    const actor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const publicChannel = await lookupPublicChannelBySlug(conn, normalizedSlug);
    if (!publicChannel) {
      throw userError(`Public channel \`${normalizedSlug}\` was not found.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    await conn.reducers.joinPublicChannel({
      agentDbId: actor.id,
      channelId: publicChannel.id,
    });
    const { channel: joinedChannel, membership: joinedMembership } =
      await waitForJoinedPublicChannel({
        read: () =>
          readVisibleChannelStateSnapshot(conn, {
            channelSlug: normalizedSlug,
          }),
        slug: normalizedSlug,
        actorId: actor.id,
      });
    const permission = channelPermissionToCli(joinedMembership.permission);
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
  const { profile, email, conn, subscription } = connected;
  try {
    const actor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const state = await conn.procedures.readVisibleChannelState({
      channelId: undefined,
      channelSlug: normalizedSlug,
    });
    if (!state) {
      throw userError(`Channel \`${normalizedSlug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    await conn.reducers.requestChannelJoin({
      agentDbId: actor.id,
      channelId: state.channel.id,
      requestedPermission: channelPermissionToReducer(params.permission),
    });
    params.reporter.success(`Requested access to ${params.slug}`);
    return {
      profile: profile.name,
      slug: normalizedSlug,
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
  // No pre-send subscription: send paths only need three procedure reads
  // (owner, channel state, then the send reducer). `senderMessageId`
  // uniqueness is enforced server-side, so there is no client-side
  // bookkeeping that requires a live view.
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
    const actor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const channelState = await readVisibleChannelStateSnapshot(conn, {
      channelSlug: normalizedSlug,
    });
    const channel =
      channelState.visible_channels.find(row => row.slug === normalizedSlug) ?? null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    const membership =
      channelState.memberships.find(
        row => row.channelId === channel.id && row.agentDbId === actor.id && row.active
      ) ?? null;
    if (!membership) {
      throw userError('Join the channel before sending.', {
        code: 'CHANNEL_MEMBERSHIP_REQUIRED',
      });
    }
    const keyPair = await requireLocalKeyPair({ conn, profile, actor });
    const senderMessageId = randomSenderMessageId();
    const prepared = await prepareChannelMessage({
      channelId: channel.id,
      senderPublicIdentity: actor.publicIdentity,
      senderMessageId,
      keyPair,
      payload: buildTextPayload(params.message, params.contentType),
    });
    // The reducer's success is authoritative; no post-send poll needed.
    await conn.reducers.sendChannelMessage({
      agentDbId: actor.id,
      channelId: channel.id,
      senderMessageId,
      senderSigningKeyVersion: prepared.senderSigningKeyVersion,
      plaintext: prepared.plaintext,
      signature: fromHex(prepared.signature),
      replyToMessageId: undefined,
    });
    params.reporter.success(`Sent message to ${params.slug}`);
    return {
      profile: profile.name,
      slug: channel.slug,
      channelId: channel.id.toString(),
      status: 'sent',
    };
  } finally {
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
  const connected = await connectForAuthenticatedChannels(params, {
    includeJoinRequests: !params.slug,
  });
  const { profile, email, conn, subscription } = connected;
  try {
    const snapshot = await readChannelSnapshot(conn);
    const channelSlug = params.slug ? normalizeChannelSlugInput(params.slug) : null;
    const actor = params.actorSlug
      ? await readOwnedChannelActor({
          conn,
          email,
          actorSlug: params.actorSlug,
        })
      : null;
    const channelState = channelSlug
      ? await readVisibleChannelStateSnapshot(conn, {
          channelSlug,
        })
      : snapshot;
    const selectedChannel = channelSlug
      ? channelState.visible_channels.find(row => row.slug === channelSlug) ?? null
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
        actors: channelState.actors,
        memberships: channelState.memberships,
        email,
        channelId: selectedChannelId,
        actorSlug: params.actorSlug,
        preferredActor: actor ?? undefined,
      });
    }

    const ownedAgentIds = new Set(channelState.actors.map(agent => agent.id));
    const adminChannelIds = new Set(
      channelState.memberships
        .filter(membership => membership.active && enumTag(membership.permission) === 'Admin')
        .map(membership => membership.channelId)
    );
    const channelsById = new Map(channelState.visible_channels.map(channel => [channel.id, channel] as const));
    const agentsById = new Map(channelState.actors.map(agent => [agent.id, agent] as const));
    const resolved = params.includeResolved
      ? await conn.procedures.listResolvedChannelJoinRequests({
          afterSortKey: undefined,
          limit: 25,
        }).then(page => page.joinRequests)
      : [];
    const requestRows = [...channelState.requests, ...resolved].filter(
      (request, index, rows) => rows.findIndex(candidate => candidate.id === request.id) === index
    );
    const filtered = requestRows.filter(request => {
      if (selectedChannelId !== null && request.channelId !== selectedChannelId) {
        return false;
      }
      const direction =
        ownedAgentIds.has(request.requesterAgentDbId) && !adminChannelIds.has(request.channelId)
          ? 'outgoing'
          : 'incoming';
      if (params.direction && direction !== params.direction) {
        return false;
      }
      if (!params.includeResolved && enumTag(request.status) !== 'Pending') {
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
      .map(request =>
        channelJoinRequestToItem(request, {
          channel: channelsById.get(request.channelId) ?? null,
          requester: agentsById.get(request.requesterAgentDbId) ?? null,
          ownedAgentIds,
          adminChannelIds,
        })
      );
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
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params, {
    includeJoinRequests: true,
  });
  const { profile, email, conn, subscription } = connected;
  try {
    const adminActor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const requestId = parseRequiredU64(params.requestId, 'requestId');
    const snapshot = await readChannelSnapshot(conn);
    const request = snapshot.requests.find(row => row.id === requestId);
    if (!request) {
      throw userError(`Channel join request ${params.requestId} is not visible.`, {
        code: 'CHANNEL_REQUEST_NOT_FOUND',
      });
    }
    const channel =
      snapshot.visible_channels.find(row => row.id === request.channelId) ?? null;
    if (!channel) {
      throw userError(`Channel join request ${params.requestId} channel is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    requireChannelAdminActor({
      actors: snapshot.actors,
      memberships: snapshot.memberships,
      email,
      channelId: request.channelId,
      actorSlug: params.actorSlug,
      preferredActor: adminActor,
    });
    await conn.reducers.approveChannelJoin({
      agentDbId: adminActor.id,
      requestId,
    });
    params.reporter.success(`Approved channel join request ${params.requestId}`);
    return {
      profile: profile.name,
      channelId: request.channelId.toString(),
      permission: channelPermissionToCli(request.permission),
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
  const connected = await connectForAuthenticatedChannels(params, {
    includeJoinRequests: true,
  });
  const { profile, email, conn, subscription } = connected;
  try {
    const adminActor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const requestId = parseRequiredU64(params.requestId, 'requestId');
    const snapshot = await readChannelSnapshot(conn);
    const request = snapshot.requests.find(row => row.id === requestId);
    if (!request) {
      throw userError(`Channel join request ${params.requestId} is not visible.`, {
        code: 'CHANNEL_REQUEST_NOT_FOUND',
      });
    }
    requireChannelAdminActor({
      actors: snapshot.actors,
      memberships: snapshot.memberships,
      email,
      channelId: request.channelId,
      actorSlug: params.actorSlug,
      preferredActor: adminActor,
    });
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

export async function updateChannelMemberPermission(params: {
  profileName: string;
  actorSlug?: string;
  slug: string;
  memberAgentDbId: string;
  permission: string;
  reporter: TaskReporter;
}): Promise<ChannelMutationResult> {
  const connected = await connectForAuthenticatedChannels(params);
  const { profile, email, conn, subscription } = connected;
  try {
    const adminActor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const channelState = await readVisibleChannelStateSnapshot(conn, {
      channelSlug: normalizedSlug,
    });
    const channel =
      channelState.visible_channels.find(row => row.slug === normalizedSlug) ?? null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    await conn.reducers.updateChannelMemberPermission({
      agentDbId: adminActor.id,
      channelId: channel.id,
      targetAgentDbId: parseRequiredU64(params.memberAgentDbId, 'memberAgentDbId'),
      permission: channelPermissionToReducer(params.permission),
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
  const { profile, email, conn, subscription } = connected;
  try {
    const actor = await readOwnedChannelActor({
      conn,
      email,
      actorSlug: params.actorSlug,
    });
    const normalizedSlug = normalizeChannelSlugInput(params.slug);
    const channelState = await readVisibleChannelStateSnapshot(conn, {
      channelSlug: normalizedSlug,
    });
    const channel =
      channelState.visible_channels.find(row => row.slug === normalizedSlug) ?? null;
    if (!channel) {
      throw userError(`Channel \`${params.slug}\` is not visible.`, {
        code: 'CHANNEL_NOT_FOUND',
      });
    }
    await conn.reducers.removeChannelMember({
      agentDbId: actor.id,
      channelId: channel.id,
      targetAgentDbId: parseRequiredU64(params.memberAgentDbId, 'memberAgentDbId'),
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
