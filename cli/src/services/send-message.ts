import {
  cacheSenderSecret,
  getCachedSenderSecret,
  prepareEncryptedMessage,
  type ActorPublicKeys,
  type AgentKeyPair,
} from '../../../shared/agent-crypto';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  generateClientThreadId,
  summarizeThread,
} from '../../../shared/inbox-state';
import {
  findUnsupportedMessageReasons,
  isJsonContentType,
  normalizeContentType,
  normalizeEncryptedMessagePayload,
  type EncryptedMessagePayload,
} from '../../../shared/message-format';
import type {
  PublishedActorLookupLike,
  PublishedActorIdentifierInputKind,
  ResolvedPublishedActor,
} from '../../../shared/published-actors';
import type {
  VisibleAgentRow,
  VisibleThreadParticipantRow,
  VisibleThreadRow,
  VisibleContactRequestRow,
  VisibleMessageRow,
  VisibleThreadSecretEnvelopeRow,
} from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import { connectivityError, userError } from './errors';
import {
  autoPinPeerIfUnknown,
  comparePinnedPeer,
  type PeerKeyTuple,
} from './peer-key-trust';
import { resolvePublishedActorLookup } from './published-actor-lookup';
import { resolveStoredActorKeyPairForPublishedActor } from './actor-keys';
import { createSecretStore } from './secret-store';
import {
  connectAuthenticated,
  disconnectConnection,
  readMessageRows,
  subscribeMessageTables,
} from './spacetimedb';

type SendTargetSummary = {
  slug: string;
  publicIdentity: string;
  displayName: string | null;
};

type SendTargetLookupMetadata = {
  input: string;
  inputKind: PublishedActorIdentifierInputKind;
  matchedActors: ResolvedPublishedActor[];
  selected: ResolvedPublishedActor;
};

export type SendMessageToThreadResult = {
  sent: true;
  profile: string;
  actorSlug: string;
  threadId: string;
  threadKind: string;
  label: string;
  messageId: string;
  threadSeq: string;
};

export type SendMessageResult =
  | {
      sent: true;
      approvalRequired: false;
      profile: string;
      selectionMode: 'latest' | 'new' | 'thread-id';
      to: SendTargetSummary;
      threadId: string;
      messageId: string;
      threadSeq: string;
      createdDirectThread: boolean;
      targetLookup: SendTargetLookupMetadata;
    }
  | {
      sent: false;
      approvalRequired: boolean;
      profile: string;
      selectionMode: 'new';
      to: SendTargetSummary;
      threadId: string;
      requestId: string;
      requestStatus: 'pending' | 'approved';
      createdDirectThread: false;
      targetLookup: SendTargetLookupMetadata;
    };

function compareBigIntDesc(left: bigint, right: bigint): number {
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

function buildDirectKey(left: { publicIdentity: string }, right: { publicIdentity: string }): string {
  const values = [left.publicIdentity, right.publicIdentity].sort();
  return `direct:${values[0]}:${values[1]}`;
}

function isApprovalRequiredForFirstContactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('requires approval for first contact');
}

function parseRequestedThreadId(value: string | undefined): bigint | null {
  if (!value) return null;

  try {
    const parsed = BigInt(value);
    if (parsed < 1n) {
      throw new Error('negative');
    }
    return parsed;
  } catch {
    throw userError('Thread id must be a positive integer.', {
      code: 'INVALID_THREAD_ID',
    });
  }
}

function parseHeaderLine(line: string): { name: string; value: string } {
  const separatorIndex = line.indexOf(':');
  if (separatorIndex < 1) {
    throw userError(
      `Header \`${line}\` must use the form "Name: Value".`,
      {
        code: 'INVALID_MESSAGE_HEADER',
      }
    );
  }

  return {
    name: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function buildEncryptedPayload(params: {
  message: string;
  contentType?: string;
  headerLines: string[];
}): EncryptedMessagePayload {
  let resolvedContentType = params.contentType
    ? normalizeContentType(params.contentType)
    : 'text/plain';
  let sawContentTypeHeader = false;
  const headers: NonNullable<EncryptedMessagePayload['headers']> = [];

  for (const line of params.headerLines) {
    const { name, value } = parseHeaderLine(line);
    if (name.trim().toLowerCase() === 'content-type') {
      const normalizedHeaderContentType = normalizeContentType(value);
      if (sawContentTypeHeader) {
        throw userError('Specify `Content-Type` at most once.', {
          code: 'MESSAGE_CONTENT_TYPE_DUPLICATE',
        });
      }
      sawContentTypeHeader = true;
      if (params.contentType && normalizedHeaderContentType !== resolvedContentType) {
        throw userError(
          'Use either `--content-type` or `Content-Type:` with the same value.',
          {
            code: 'MESSAGE_CONTENT_TYPE_CONFLICT',
          }
        );
      }
      resolvedContentType = normalizedHeaderContentType;
      continue;
    }

    headers.push({
      name,
      value,
    });
  }

  const body = isJsonContentType(resolvedContentType)
    ? (() => {
        try {
          return JSON.parse(params.message) as EncryptedMessagePayload['body'];
        } catch {
          throw userError(
            `Message body must be valid JSON for content type \`${resolvedContentType}\`.`,
            {
              code: 'INVALID_MESSAGE_JSON_BODY',
            }
          );
        }
      })()
    : params.message;

  try {
    return normalizeEncryptedMessagePayload({
      contentType: resolvedContentType,
      ...(headers.length > 0 ? { headers } : {}),
      body,
    });
  } catch (error) {
    throw userError(error instanceof Error ? error.message : 'Invalid encrypted message payload.', {
      code: 'INVALID_MESSAGE_PAYLOAD',
    });
  }
}

function tupleFromVisibleActor(actor: VisibleAgentRow): PeerKeyTuple {
  return {
    encryptionPublicKey: actor.currentEncryptionPublicKey,
    encryptionKeyVersion: actor.currentEncryptionKeyVersion,
    signingPublicKey: actor.currentSigningPublicKey,
    signingKeyVersion: actor.currentSigningKeyVersion,
  };
}

function tupleFromPublishedActor(actor: PublishedActorLookupLike): PeerKeyTuple {
  return {
    encryptionPublicKey: actor.encryptionPublicKey,
    encryptionKeyVersion: actor.encryptionKeyVersion,
    signingPublicKey: actor.signingPublicKey,
    signingKeyVersion: actor.signingKeyVersion,
  };
}

async function requirePeerKeyTrust(params: {
  publicIdentity: string;
  displayLabel: string;
  observed: PeerKeyTuple;
  allowFirstContactTrust: boolean;
}): Promise<void> {
  const comparison = params.allowFirstContactTrust
    ? await autoPinPeerIfUnknown(params.publicIdentity, params.observed)
    : await comparePinnedPeer(params.publicIdentity, params.observed);
  if (
    comparison.status === 'matches' ||
    (comparison.status === 'unpinned' && params.allowFirstContactTrust)
  ) {
    return;
  }

  if (comparison.status === 'unpinned') {
    throw userError(
      `Keys for ${params.displayLabel} are not trusted for this existing contact. Verify them out-of-band, then run \`masumi-agent-messenger inbox trust pin ${params.displayLabel}\` before sending.`,
      { code: 'PEER_KEY_UNPINNED' }
    );
  }

  const diffParts: string[] = [];
  if (comparison.diff.signingKeyVersionChanged || comparison.diff.signingPublicKeyChanged) {
    diffParts.push(
      `signing ${comparison.pinned.current.signingKeyVersion} → ${params.observed.signingKeyVersion}`
    );
  }
  if (
    comparison.diff.encryptionKeyVersionChanged ||
    comparison.diff.encryptionPublicKeyChanged
  ) {
    diffParts.push(
      `encryption ${comparison.pinned.current.encryptionKeyVersion} → ${params.observed.encryptionKeyVersion}`
    );
  }
  throw userError(
    `Keys for ${params.displayLabel} have rotated (${diffParts.join(', ')}). Verify the new keys out-of-band, then run \`masumi-agent-messenger inbox trust pin --force ${params.displayLabel}\` before sending.`,
    { code: 'PEER_KEY_ROTATION_UNCONFIRMED' }
  );
}

function toActorPublicKeys(actor: VisibleAgentRow): ActorPublicKeys {
  return {
    actorId: actor.id,
    normalizedEmail: actor.normalizedEmail,
    slug: actor.slug,
    inboxIdentifier: actor.inboxIdentifier ?? undefined,
    isDefault: actor.isDefault,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName ?? null,
    encryptionPublicKey: actor.currentEncryptionPublicKey,
    encryptionKeyVersion: actor.currentEncryptionKeyVersion,
    signingPublicKey: actor.currentSigningPublicKey,
    signingKeyVersion: actor.currentSigningKeyVersion,
  };
}

function toPublishedActorPublicKeys(target: PublishedActorLookupLike): ActorPublicKeys {
  return {
    normalizedEmail: '',
    slug: target.slug,
    isDefault: target.isDefault,
    publicIdentity: target.publicIdentity,
    displayName: target.displayName ?? null,
    encryptionPublicKey: target.encryptionPublicKey,
    encryptionKeyVersion: target.encryptionKeyVersion,
    signingPublicKey: target.signingPublicKey,
    signingKeyVersion: target.signingKeyVersion,
  };
}

async function requireLocalActorKeyPairForSending(params: {
  profile: Awaited<ReturnType<typeof ensureAuthenticatedSession>>['profile'];
  ownActor: VisibleAgentRow;
}): Promise<AgentKeyPair> {
  const secretStore = createSecretStore();
  const keyResolution = await resolveStoredActorKeyPairForPublishedActor({
    profile: params.profile,
    secretStore,
    identity: {
      normalizedEmail: params.ownActor.normalizedEmail,
      slug: params.ownActor.slug,
      inboxIdentifier: params.ownActor.inboxIdentifier ?? undefined,
    },
    published: {
      encryption: {
        publicKey: params.ownActor.currentEncryptionPublicKey,
        keyVersion: params.ownActor.currentEncryptionKeyVersion,
      },
      signing: {
        publicKey: params.ownActor.currentSigningPublicKey,
        keyVersion: params.ownActor.currentSigningKeyVersion,
      },
    },
  });

  if (keyResolution.status === 'matched') {
    return keyResolution.keyPair;
  }

  throw userError(
    keyResolution.status === 'mismatch'
      ? `Local agent key bundle for \`${params.ownActor.slug}\` no longer matches the published actor keys. Run \`masumi-agent-messenger account recover\`, import an encrypted backup, or rotate keys before sending from this CLI profile.`
      : `No local agent key bundle found for \`${params.ownActor.slug}\`. Run \`masumi-agent-messenger account recover\` or import an encrypted backup before sending from this CLI profile.`,
    {
      code:
        keyResolution.status === 'mismatch'
          ? 'AGENT_KEYPAIR_OUT_OF_SYNC'
          : 'AGENT_KEYPAIR_REQUIRED',
    }
  );
}

function requireDefaultActor(actors: VisibleAgentRow[], normalizedEmail: string): VisibleAgentRow {
  const actor = actors.find(row => row.isDefault && row.normalizedEmail === normalizedEmail);
  if (!actor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }
  return actor;
}

function requireOwnedActor(params: {
  actors: VisibleAgentRow[];
  normalizedEmail: string;
  actorSlug?: string;
}): VisibleAgentRow {
  const defaultActor = requireDefaultActor(params.actors, params.normalizedEmail);
  if (!params.actorSlug) {
    return defaultActor;
  }

  const normalizedSlug = normalizeInboxSlug(params.actorSlug);
  if (!normalizedSlug) {
    throw userError('Inbox slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const actor = params.actors.find(row => {
    return row.inboxId === defaultActor.inboxId && row.slug === normalizedSlug;
  });
  if (!actor) {
    throw userError(`No owned inbox actor found for slug \`${normalizedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }

  return actor;
}

function findDirectThread(
  threads: VisibleThreadRow[],
  ownActor: VisibleAgentRow,
  otherPublicIdentity: string
): VisibleThreadRow | null {
  const matches = findDirectThreads(threads, ownActor, otherPublicIdentity);
  return matches[0] ?? null;
}

function findDirectThreads(
  threads: VisibleThreadRow[],
  ownActor: VisibleAgentRow,
  otherPublicIdentity: string
): VisibleThreadRow[] {
  const dedupeKey = buildDirectKey(ownActor, { publicIdentity: otherPublicIdentity });
  return threads
    .filter(thread => thread.kind === 'direct' && thread.dedupeKey === dedupeKey)
    .sort((left, right) =>
      compareBigIntDesc(
        left.lastMessageAt.microsSinceUnixEpoch,
        right.lastMessageAt.microsSinceUnixEpoch
      )
    );
}

function requireDirectThreadById(params: {
  threads: VisibleThreadRow[];
  ownActor: VisibleAgentRow;
  otherPublicIdentity: string;
  threadId: bigint;
  targetSlug: string;
}): VisibleThreadRow {
  const thread = params.threads.find(row => row.id === params.threadId);
  if (!thread) {
    throw userError(`Direct thread ${params.threadId.toString()} is not visible.`, {
      code: 'DIRECT_THREAD_NOT_FOUND',
    });
  }

  if (thread.kind !== 'direct') {
    throw userError(`Thread ${params.threadId.toString()} is not a direct thread.`, {
      code: 'DIRECT_THREAD_INVALID_KIND',
    });
  }

  const expectedDirectKey = buildDirectKey(params.ownActor, {
    publicIdentity: params.otherPublicIdentity,
  });
  if (thread.dedupeKey !== expectedDirectKey) {
    throw userError(
      `Thread ${params.threadId.toString()} does not match recipient slug \`${params.targetSlug}\`.`,
      {
        code: 'DIRECT_THREAD_TARGET_MISMATCH',
      }
    );
  }

  return thread;
}

function findParticipant(
  participants: VisibleThreadParticipantRow[],
  threadId: bigint,
  actorId: bigint
): VisibleThreadParticipantRow | null {
  return (
    participants.find(participant => participant.threadId === threadId && participant.agentDbId === actorId) ??
    null
  );
}

function senderSecretRotationRequired(params: {
  senderActor: VisibleAgentRow;
  thread: VisibleThreadRow;
  latestSenderMessage: VisibleMessageRow | undefined;
  participants: VisibleThreadParticipantRow[];
  actors: VisibleAgentRow[];
  envelopes: VisibleThreadSecretEnvelopeRow[];
}): boolean {
  const {
    senderActor,
    thread,
    latestSenderMessage,
    participants,
    actors,
    envelopes,
  } = params;
  if (!latestSenderMessage) {
    return false;
  }
  if (latestSenderMessage.membershipVersion !== thread.membershipVersion) {
    return true;
  }

  const actorsById = new Map(actors.map(actor => [actor.id, actor] as const));
  const expectedRecipients = new Map<bigint, VisibleAgentRow>();
  for (const participant of participants) {
    if (participant.threadId !== thread.id || !participant.active) {
      continue;
    }
    const actor = actorsById.get(participant.agentDbId);
    if (!actor) {
      return true;
    }
    expectedRecipients.set(participant.agentDbId, actor);
  }

  const currentVersionEnvelopes = envelopes.filter(envelope => {
    return (
      envelope.threadId === thread.id &&
      envelope.membershipVersion === latestSenderMessage.membershipVersion &&
      envelope.senderAgentDbId === senderActor.id &&
      envelope.secretVersion === latestSenderMessage.secretVersion
    );
  });
  if (currentVersionEnvelopes.length !== expectedRecipients.size) {
    return true;
  }

  const seenRecipients = new Set<bigint>();
  for (const envelope of currentVersionEnvelopes) {
    const recipient = expectedRecipients.get(envelope.recipientAgentDbId);
    if (!recipient || seenRecipients.has(envelope.recipientAgentDbId)) {
      return true;
    }
    seenRecipients.add(envelope.recipientAgentDbId);

    if (envelope.senderEncryptionKeyVersion !== senderActor.currentEncryptionKeyVersion) {
      return true;
    }
    if (envelope.signingKeyVersion !== senderActor.currentSigningKeyVersion) {
      return true;
    }
    if (envelope.recipientEncryptionKeyVersion !== recipient.currentEncryptionKeyVersion) {
      return true;
    }
  }

  return false;
}

function requireVisibleThread(threads: VisibleThreadRow[], threadId: bigint): VisibleThreadRow {
  const thread = threads.find(row => row.id === threadId) ?? null;
  if (!thread) {
    throw userError(`Thread ${threadId.toString()} is not visible.`, {
      code: 'THREAD_NOT_FOUND',
    });
  }
  return thread;
}

async function waitForDirectThread(params: {
  read: () => ReturnType<typeof readMessageRows>;
  ownActor: VisibleAgentRow;
  otherPublicIdentity: string;
  existingThreadIds?: Set<string>;
  timeoutMs?: number;
}): Promise<VisibleThreadRow> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const snapshot = params.read();
    const matches = findDirectThreads(snapshot.threads, params.ownActor, params.otherPublicIdentity);
    const existing = params.existingThreadIds
      ? matches.find(thread => !params.existingThreadIds?.has(thread.id.toString())) ?? null
      : (matches[0] ?? null);
    if (existing) {
      return existing;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for direct thread creation to sync.', {
    code: 'SPACETIMEDB_DIRECT_THREAD_TIMEOUT',
  });
}

async function waitForSentMessage(params: {
  read: () => ReturnType<typeof readMessageRows>;
  threadId: bigint;
  senderActorId: bigint;
  senderSeq: bigint;
  timeoutMs?: number;
}): Promise<VisibleMessageRow> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const snapshot = params.read();
    const message = snapshot.messages.find(row => {
      return (
        row.threadId === params.threadId &&
        row.senderAgentDbId === params.senderActorId &&
        row.senderSeq === params.senderSeq
      );
    });

    if (message) {
      return message;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for sent message to sync.', {
    code: 'SPACETIMEDB_MESSAGE_TIMEOUT',
  });
}

async function waitForContactRequest(params: {
  read: () => ReturnType<typeof readMessageRows>;
  requesterActorId: bigint;
  targetPublicIdentity: string;
  existingRequestIds?: Set<string>;
  timeoutMs?: number;
}): Promise<VisibleContactRequestRow> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const snapshot = params.read();
    const request = snapshot.contactRequests.find(row => {
      return (
        row.requesterAgentDbId === params.requesterActorId &&
        row.targetPublicIdentity === params.targetPublicIdentity &&
        row.status === 'pending' &&
        !params.existingRequestIds?.has(row.id.toString())
      );
    });

    if (request) {
      return request;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for the contact request to sync.', {
    code: 'CONTACT_REQUEST_SYNC_TIMEOUT',
  });
}

export async function sendMessageToSlug(params: {
  profileName: string;
  actorSlug?: string;
  to: string;
  message: string;
  contentType?: string;
  headerLines: string[];
  forceUnsupported?: boolean;
  title?: string;
  createNew?: boolean;
  threadId?: string;
  reporter: TaskReporter;
}): Promise<SendMessageResult> {
  const requestedThreadId = parseRequestedThreadId(params.threadId);
  if (params.createNew && requestedThreadId) {
    throw userError('Use either `--new` or `--thread-id`, not both.', {
      code: 'SEND_THREAD_SELECTION_CONFLICT',
    });
  }

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
    params.reporter.verbose?.('Subscribing to thread state');
    const subscription = await subscribeMessageTables(conn);

    try {
      const read = () => readMessageRows(conn);
      let snapshot = read();
      const ownActor = requireOwnedActor({
        actors: snapshot.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });
      const keyPair = await requireLocalActorKeyPairForSending({
        profile,
        ownActor,
      });

      params.reporter.verbose?.(`Resolving recipient slug or email ${params.to}`);
      const targetLookup = await resolvePublishedActorLookup({
        identifier: params.to,
        lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
        lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
        invalidMessage: 'Recipient slug or email is invalid.',
        invalidCode: 'INVALID_AGENT_IDENTIFIER',
        notFoundCode: 'ACTOR_NOT_FOUND',
        fallbackMessage: 'No published inbox actor found for that slug or email.',
      });
      const target = targetLookup.selected;

      if (target.publicIdentity === ownActor.publicIdentity) {
        throw userError('Use a different inbox slug or email for a direct thread.', {
          code: 'DIRECT_THREAD_SELF',
        });
      }

      params.reporter.verbose?.(`Loading public route for ${target.slug}`);
      const publishedRoute = (await conn.procedures.lookupPublishedPublicRouteBySlug({
        slug: target.slug,
      }))[0];
      if (!publishedRoute) {
        throw connectivityError('Recipient public route is unavailable.', {
          code: 'PUBLIC_ROUTE_UNAVAILABLE',
        });
      }

      const payload = buildEncryptedPayload({
        message: params.message,
        contentType: params.contentType,
        headerLines: params.headerLines,
      });
      const unsupportedReasons = findUnsupportedMessageReasons({
        payload,
        capabilities: {
          allowAllContentTypes: publishedRoute.allowAllContentTypes,
          allowAllHeaders: publishedRoute.allowAllHeaders,
          supportedContentTypes: publishedRoute.supportedContentTypes,
          supportedHeaders: publishedRoute.supportedHeaders.map(header => ({
            name: header.name,
            required: header.required ?? undefined,
            allowMultiple: header.allowMultiple ?? undefined,
            sensitive: header.sensitive ?? undefined,
            allowedPrefixes: header.allowedPrefixes ?? undefined,
          })),
        },
      });
      if (unsupportedReasons.length > 0 && !params.forceUnsupported) {
        throw userError(unsupportedReasons.join(' '), {
          code: 'UNSUPPORTED_MESSAGE_PAYLOAD',
        });
      }
      if (unsupportedReasons.length > 0 && params.forceUnsupported) {
        params.reporter.info(
          `Sending unsupported payload anyway: ${unsupportedReasons.join(' ')}`
        );
      }

      const selectionMode: SendMessageResult['selectionMode'] = requestedThreadId
        ? 'thread-id'
        : params.createNew
          ? 'new'
          : 'latest';
      let pendingRequest: VisibleContactRequestRow | null =
        snapshot.contactRequests.find(request => {
          return (
            request.direction === 'outgoing' &&
            request.requesterAgentDbId === ownActor.id &&
            request.targetPublicIdentity === target.publicIdentity &&
            request.status === 'pending'
          );
        }) ?? null;
      let thread = requestedThreadId
        ? requireDirectThreadById({
            threads: snapshot.threads,
            ownActor,
            otherPublicIdentity: target.publicIdentity,
            threadId: requestedThreadId,
            targetSlug: target.slug,
          })
        : findDirectThread(snapshot.threads, ownActor, target.publicIdentity);
      let createdDirectThread = false;

      if (pendingRequest && thread) {
        params.reporter.verbose?.(
          `Pending contact request is satisfied by visible thread ${thread.id.toString()}; sending in that thread.`
        );
        pendingRequest = null;
      }

      if (requestedThreadId) {
        params.reporter.verbose?.(`Using direct thread ${requestedThreadId.toString()}`);
      }

      if ((!thread || params.createNew) && !pendingRequest) {
        await requirePeerKeyTrust({
          publicIdentity: target.publicIdentity,
          displayLabel: target.slug,
          observed: tupleFromPublishedActor(target),
          allowFirstContactTrust: !thread,
        });

        const existingThreadIds = new Set(
          findDirectThreads(snapshot.threads, ownActor, target.publicIdentity).map(existingThread =>
            existingThread.id.toString()
          )
        );
        try {
          params.reporter.verbose?.(`Creating direct thread with ${target.slug}`);
          await conn.reducers.createDirectThread({
            agentDbId: ownActor.id,
            otherAgentPublicIdentity: target.publicIdentity,
            membershipLocked: undefined,
            title: params.title?.trim() ? params.title.trim() : undefined,
          });
          try {
            createdDirectThread = true;
            thread = await waitForDirectThread({
              read,
              ownActor,
              otherPublicIdentity: target.publicIdentity,
              existingThreadIds,
            });
            params.reporter.verbose?.(`Direct thread ready: ${thread.id.toString()}`);
          } catch (error) {
            const fallbackThread = findDirectThread(read().threads, ownActor, target.publicIdentity);
            if (!fallbackThread) {
              throw error;
            }
            // --new explicitly asked for a fresh direct thread. If the backend
            // was idempotent (no new row synced) and we would be reusing an
            // existing thread, surface that instead of silently doing so.
            if (params.createNew) {
              throw userError(
                `--new could not create a fresh direct thread with ${target.slug}; existing thread ${fallbackThread.id.toString()} already exists. Omit --new to reuse it, or pass --thread-id ${fallbackThread.id.toString()} to send there explicitly.`,
                {
                  code: 'DIRECT_THREAD_NEW_NOT_CREATED',
                }
              );
            }
            createdDirectThread = false;
            thread = fallbackThread;
            params.reporter.verbose?.(
              `No new direct thread row synced; using existing thread ${fallbackThread.id.toString()}.`
            );
          }
        } catch (error) {
          if (requestedThreadId || !isApprovalRequiredForFirstContactError(error)) {
            throw error;
          }

          const existingRequestIds = new Set(
            snapshot.contactRequests.map(request => request.id.toString())
          );
          const pendingThreadId = generateClientThreadId();
          params.reporter.verbose?.(`Encrypting atomic first-contact request for ${target.slug}`);
          const prepared = await prepareEncryptedMessage({
            threadId: pendingThreadId,
            senderActorId: ownActor.id,
            senderPublicIdentity: ownActor.publicIdentity,
            senderSeq: 1n,
            payload,
            keyPair,
            recipients: [toActorPublicKeys(ownActor), toPublishedActorPublicKeys(target)],
            existingSecret: null,
            latestKnownSecretVersion: null,
            rotateSecret: false,
          });
          params.reporter.verbose?.(
            `Creating pending contact request with first message for ${target.slug}`
          );
          await conn.reducers.requestDirectContactWithFirstMessage({
            agentDbId: ownActor.id,
            otherAgentPublicIdentity: target.publicIdentity,
            threadId: pendingThreadId,
            membershipLocked: undefined,
            title: params.title?.trim() ? params.title.trim() : undefined,
            secretVersion: prepared.secretVersion,
            signingKeyVersion: prepared.signingKeyVersion,
            senderSeq: 1n,
            ciphertext: prepared.ciphertext,
            iv: prepared.iv,
            cipherAlgorithm: prepared.cipherAlgorithm,
            signature: prepared.signature,
            replyToMessageId: undefined,
            attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
          });
          pendingRequest = await waitForContactRequest({
            read,
            requesterActorId: ownActor.id,
            targetPublicIdentity: target.publicIdentity,
            existingRequestIds,
          });

          cacheSenderSecret(
            pendingThreadId,
            ownActor.publicIdentity,
            prepared.senderSecret.secretVersion,
            prepared.senderSecret.secretHex
          );
          params.reporter.success(`Contact request sent to ${target.slug}`);

          const ownActorIds = buildOwnActorIds(snapshot.actors, ownActor.inboxId);
          const targetOwnedActor = snapshot.actors.find(
            actor => actor.publicIdentity === target.publicIdentity && ownActorIds.has(actor.id)
          ) ?? null;

          if (targetOwnedActor) {
            params.reporter.verbose?.(`Auto-approving contact request from owned agent ${target.slug}`);
            await conn.reducers.approveContactRequest({
              agentDbId: targetOwnedActor.id,
              requestId: pendingRequest.id,
            });
            const approvedRequest = await new Promise<VisibleContactRequestRow>((resolve, reject) => {
              const timeoutAt = Date.now() + 10000;
              const poll = () => {
                const req = read().contactRequests.find(r => r.id === pendingRequest!.id);
                if (req?.status === 'approved') { resolve(req); return; }
                if (Date.now() >= timeoutAt) {
                  reject(connectivityError('Timed out waiting for auto-approval to sync.', { code: 'CONTACT_REQUEST_SYNC_TIMEOUT' }));
                  return;
                }
                setTimeout(poll, 100);
              };
              poll();
            });
            return {
              sent: false,
              approvalRequired: false,
              profile: profile.name,
              selectionMode: 'new',
              to: {
                slug: target.slug,
                publicIdentity: target.publicIdentity,
                displayName: target.displayName ?? null,
              },
              threadId: approvedRequest.threadId.toString(),
              requestId: approvedRequest.id.toString(),
              requestStatus: 'approved',
              createdDirectThread: false,
              targetLookup: {
                input: targetLookup.input,
                inputKind: targetLookup.inputKind,
                matchedActors: targetLookup.matchedActors,
                selected: targetLookup.selectedActor,
              },
            };
          }

          return {
            sent: false,
            approvalRequired: true,
            profile: profile.name,
            selectionMode: 'new',
            to: {
              slug: target.slug,
              publicIdentity: target.publicIdentity,
              displayName: target.displayName ?? null,
            },
            threadId: pendingRequest.threadId.toString(),
            requestId: pendingRequest.id.toString(),
            requestStatus: 'pending',
            createdDirectThread: false,
            targetLookup: {
              input: targetLookup.input,
              inputKind: targetLookup.inputKind,
              matchedActors: targetLookup.matchedActors,
              selected: targetLookup.selectedActor,
            },
          };
        }
      }

      if (pendingRequest) {
        if (pendingRequest.messageCount > 0n) {
          throw userError('A pending contact request already exists for this actor pair.', {
            code: 'CONTACT_REQUEST_PENDING',
          });
        }

        await requirePeerKeyTrust({
          publicIdentity: target.publicIdentity,
          displayLabel: target.slug,
          observed: tupleFromPublishedActor(target),
          allowFirstContactTrust: true,
        });

        params.reporter.verbose?.(`Encrypting first-contact request for ${target.slug}`);
        const prepared = await prepareEncryptedMessage({
          threadId: pendingRequest.threadId,
          senderActorId: ownActor.id,
          senderPublicIdentity: ownActor.publicIdentity,
          senderSeq: 1n,
          payload,
          keyPair,
          recipients: [toActorPublicKeys(ownActor), toPublishedActorPublicKeys(target)],
          existingSecret: null,
          latestKnownSecretVersion: null,
          rotateSecret: false,
        });

        params.reporter.verbose?.(`Sending hidden first-contact message to ${target.slug}`);
        await conn.reducers.sendEncryptedMessage({
          agentDbId: ownActor.id,
          threadId: pendingRequest.threadId,
          secretVersion: prepared.secretVersion,
          signingKeyVersion: prepared.signingKeyVersion,
          senderSeq: 1n,
          ciphertext: prepared.ciphertext,
          iv: prepared.iv,
          cipherAlgorithm: prepared.cipherAlgorithm,
          signature: prepared.signature,
          replyToMessageId: undefined,
          attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
        });

        cacheSenderSecret(
          pendingRequest.threadId,
          ownActor.publicIdentity,
          prepared.senderSecret.secretVersion,
          prepared.senderSecret.secretHex
        );
        params.reporter.success(`Contact request sent to ${target.slug}`);

        return {
          sent: false,
          approvalRequired: true,
          profile: profile.name,
          selectionMode: 'new',
          to: {
            slug: target.slug,
            publicIdentity: target.publicIdentity,
            displayName: target.displayName ?? null,
          },
          threadId: pendingRequest.threadId.toString(),
          requestId: pendingRequest.id.toString(),
          requestStatus: 'pending',
          createdDirectThread: false,
          targetLookup: {
            input: targetLookup.input,
            inputKind: targetLookup.inputKind,
            matchedActors: targetLookup.matchedActors,
            selected: targetLookup.selectedActor,
          },
        };
      }

      if (!thread) {
        throw connectivityError('Direct thread is not visible after creation.', {
          code: 'DIRECT_THREAD_NOT_VISIBLE',
        });
      }

      snapshot = read();
      const senderParticipant = findParticipant(snapshot.participants, thread.id, ownActor.id);
      if (!senderParticipant) {
        throw connectivityError('Current actor is not visible as a participant in the direct thread.', {
          code: 'DIRECT_THREAD_PARTICIPANT_MISSING',
        });
      }

      const recipientActors = snapshot.participants
        .filter(participant => participant.threadId === thread.id && participant.active)
        .map(participant => snapshot.actors.find(actor => actor.id === participant.agentDbId))
        .filter((actor): actor is VisibleAgentRow => Boolean(actor));
      const ownActorIdsForThread = buildOwnActorIds(snapshot.actors, ownActor.inboxId);
      for (const recipient of recipientActors) {
        if (recipient.id === ownActor.id) continue;
        await requirePeerKeyTrust({
          publicIdentity: recipient.publicIdentity,
          displayLabel: recipient.slug,
          observed: tupleFromVisibleActor(recipient),
          allowFirstContactTrust: ownActorIdsForThread.has(recipient.id),
        });
      }
      const recipients = recipientActors.map(toActorPublicKeys);

      const latestSenderMessage = [...snapshot.messages]
        .filter(message => message.threadId === thread.id && message.senderAgentDbId === ownActor.id)
        .sort((left, right) => compareBigIntDesc(left.senderSeq, right.senderSeq))[0];

      const existingSecret = latestSenderMessage
        ? getCachedSenderSecret(thread.id, ownActor.publicIdentity, latestSenderMessage.secretVersion)
        : null;
      const requiresSecretRotation = senderSecretRotationRequired({
        senderActor: ownActor,
        thread,
        latestSenderMessage,
        participants: snapshot.participants,
        actors: snapshot.actors,
        envelopes: snapshot.secretEnvelopes,
      });

      params.reporter.verbose?.(`Encrypting message for ${target.slug}`);
      const prepared = await prepareEncryptedMessage({
        threadId: thread.id,
        senderActorId: ownActor.id,
        senderPublicIdentity: ownActor.publicIdentity,
        senderSeq: senderParticipant.lastSentSeq + 1n,
        payload,
        keyPair,
        recipients,
        existingSecret,
        latestKnownSecretVersion: latestSenderMessage?.secretVersion ?? null,
        rotateSecret: requiresSecretRotation,
      });

      params.reporter.verbose?.(`Sending encrypted message to ${target.slug}`);
      await conn.reducers.sendEncryptedMessage({
        agentDbId: ownActor.id,
        threadId: thread.id,
        secretVersion: prepared.secretVersion,
        signingKeyVersion: prepared.signingKeyVersion,
        senderSeq: senderParticipant.lastSentSeq + 1n,
        ciphertext: prepared.ciphertext,
        iv: prepared.iv,
        cipherAlgorithm: prepared.cipherAlgorithm,
        signature: prepared.signature,
        replyToMessageId: undefined,
        attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
      });

      cacheSenderSecret(
        thread.id,
        ownActor.publicIdentity,
        prepared.senderSecret.secretVersion,
        prepared.senderSecret.secretHex
      );

      const sentMessage = await waitForSentMessage({
        read,
        threadId: thread.id,
        senderActorId: ownActor.id,
        senderSeq: senderParticipant.lastSentSeq + 1n,
      });
      params.reporter.success(`Encrypted message sent to ${target.slug}`);

      return {
        sent: true,
        approvalRequired: false,
        profile: profile.name,
        selectionMode,
        to: {
          slug: target.slug,
          publicIdentity: target.publicIdentity,
          displayName: target.displayName ?? null,
        },
        threadId: thread.id.toString(),
        messageId: sentMessage.id.toString(),
        threadSeq: sentMessage.threadSeq.toString(),
        createdDirectThread,
        targetLookup: {
          input: targetLookup.input,
          inputKind: targetLookup.inputKind,
          matchedActors: targetLookup.matchedActors,
          selected: targetLookup.selectedActor,
        },
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function sendMessageToThread(params: {
  profileName: string;
  actorSlug?: string;
  threadId: string;
  message: string;
  contentType?: string;
  headerLines: string[];
  forceUnsupported?: boolean;
  reporter: TaskReporter;
}): Promise<SendMessageToThreadResult> {
  const requestedThreadId = parseRequestedThreadId(params.threadId);
  if (!requestedThreadId) {
    throw userError('Thread id is required.', {
      code: 'INVALID_THREAD_ID',
    });
  }

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
    params.reporter.verbose?.('Subscribing to thread state');
    const subscription = await subscribeMessageTables(conn);

    try {
      const read = () => readMessageRows(conn);
      const snapshot = read();
      const ownActor = requireOwnedActor({
        actors: snapshot.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });
      const thread = requireVisibleThread(snapshot.threads, requestedThreadId);
      const senderParticipant = findParticipant(snapshot.participants, requestedThreadId, ownActor.id);
      if (!senderParticipant?.active) {
        throw userError(`Actor is not an active participant in thread ${requestedThreadId.toString()}.`, {
          code: 'THREAD_PARTICIPANT_REQUIRED',
        });
      }

      const keyPair = await requireLocalActorKeyPairForSending({
        profile,
        ownActor,
      });

      const payload = buildEncryptedPayload({
        message: params.message,
        contentType: params.contentType,
        headerLines: params.headerLines,
      });
      const recipientActors = snapshot.participants
        .filter(participant => participant.threadId === requestedThreadId && participant.active)
        .map(participant => snapshot.actors.find(actor => actor.id === participant.agentDbId))
        .filter((actor): actor is VisibleAgentRow => Boolean(actor));
      if (recipientActors.length === 0) {
        throw connectivityError('No active participants are visible for this thread.', {
          code: 'THREAD_PARTICIPANTS_NOT_VISIBLE',
        });
      }
      const ownActorIdsForReply = buildOwnActorIds(snapshot.actors, ownActor.inboxId);
      for (const recipient of recipientActors) {
        if (recipient.id === ownActor.id) continue;
        await requirePeerKeyTrust({
          publicIdentity: recipient.publicIdentity,
          displayLabel: recipient.slug,
          observed: tupleFromVisibleActor(recipient),
          allowFirstContactTrust: ownActorIdsForReply.has(recipient.id),
        });
      }
      const recipients = recipientActors.map(toActorPublicKeys);

      const latestSenderMessage = [...snapshot.messages]
        .filter(message => message.threadId === requestedThreadId && message.senderAgentDbId === ownActor.id)
        .sort((left, right) => compareBigIntDesc(left.senderSeq, right.senderSeq))[0];

      const existingSecret = latestSenderMessage
        ? getCachedSenderSecret(
            requestedThreadId,
            ownActor.publicIdentity,
            latestSenderMessage.secretVersion
          )
        : null;
      const requiresSecretRotation = senderSecretRotationRequired({
        senderActor: ownActor,
        thread,
        latestSenderMessage,
        participants: snapshot.participants,
        actors: snapshot.actors,
        envelopes: snapshot.secretEnvelopes,
      });

      params.reporter.verbose?.(`Encrypting message for thread ${requestedThreadId.toString()}`);
      const prepared = await prepareEncryptedMessage({
        threadId: requestedThreadId,
        senderActorId: ownActor.id,
        senderPublicIdentity: ownActor.publicIdentity,
        senderSeq: senderParticipant.lastSentSeq + 1n,
        payload,
        keyPair,
        recipients,
        existingSecret,
        latestKnownSecretVersion: latestSenderMessage?.secretVersion ?? null,
        rotateSecret: requiresSecretRotation,
      });

      params.reporter.verbose?.(`Sending encrypted message to thread ${requestedThreadId.toString()}`);
      await conn.reducers.sendEncryptedMessage({
        agentDbId: ownActor.id,
        threadId: requestedThreadId,
        secretVersion: prepared.secretVersion,
        signingKeyVersion: prepared.signingKeyVersion,
        senderSeq: senderParticipant.lastSentSeq + 1n,
        ciphertext: prepared.ciphertext,
        iv: prepared.iv,
        cipherAlgorithm: prepared.cipherAlgorithm,
        signature: prepared.signature,
        replyToMessageId: undefined,
        attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
      });

      cacheSenderSecret(
        requestedThreadId,
        ownActor.publicIdentity,
        prepared.senderSecret.secretVersion,
        prepared.senderSecret.secretHex
      );

      const sentMessage = await waitForSentMessage({
        read,
        threadId: requestedThreadId,
        senderActorId: ownActor.id,
        senderSeq: senderParticipant.lastSentSeq + 1n,
      });

      const activeParticipantsByThreadId = buildParticipantsByThreadId(
        snapshot.participants.filter(participant => participant.active)
      );
      const actorsById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));
      const ownActorIds = buildOwnActorIds(snapshot.actors, ownActor.inboxId);
      const label = summarizeThread(
        thread,
        activeParticipantsByThreadId.get(thread.id) ?? [],
        actorsById,
        ownActorIds
      );

      params.reporter.success(`Encrypted message sent to thread ${requestedThreadId.toString()}`);

      return {
        sent: true,
        profile: profile.name,
        actorSlug: ownActor.slug,
        threadId: requestedThreadId.toString(),
        threadKind: thread.kind,
        label,
        messageId: sentMessage.id.toString(),
        threadSeq: sentMessage.threadSeq.toString(),
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}
