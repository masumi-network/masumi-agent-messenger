import type { AgentKeyPair, InboundEncryptedMessage, InboundSecretEnvelope } from '../../../shared/agent-crypto';
import { decryptMessage } from '../../../shared/agent-crypto';
import {
  buildLegacyPublicMessageCapabilities,
  buildPublicMessageCapabilities,
  findUnsupportedMessageReasons,
  formatEncryptedMessageBody,
  parseDecryptedMessagePlaintext,
  type EncryptedMessageHeader,
  type PublicMessageCapabilities,
} from '../../../shared/message-format';
import {
  buildParticipantsByThreadId,
  findDefaultActorByEmail,
  resolveDirectCounterparty,
  summarizeThread,
} from '../../../shared/inbox-state';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { timestampToISOString } from '../../../shared/spacetime-time';
import type {
  VisibleAgentRow,
  VisibleAgentKeyBundleRow,
  VisibleThreadParticipantRow,
  VisibleThreadReadStateRow,
  VisibleThreadRow,
  VisibleThreadSecretEnvelopeRow,
  VisibleMessageRow,
} from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import { getStoredActorKeyPair } from './actor-keys';
import type { TaskReporter } from './command-runtime';
import { connectivityError, isCliError, userError } from './errors';
import {
  autoPinPeerIfUnknown,
  comparePinnedPeer,
  isInboundSignatureTrusted,
} from './peer-key-trust';
import { createSecretStore } from './secret-store';
import {
  connectAuthenticated,
  disconnectConnection,
  readLatestMessageRows,
  readMessageRows,
  subscribeMessageTables,
} from './spacetimedb';

export type InboxMessageItem = {
  id: string;
  threadId: string;
  threadSeq: string;
  createdAt: string;
  threadLabel: string;
  sender: {
    id: string;
    slug: string;
    displayName: string | null;
    publicIdentity: string;
  };
  text: string | null;
  decryptStatus: 'ok' | 'unsupported' | 'failed';
  decryptError: string | null;
  contentType: string | null;
  headerNames: string[];
  headers: EncryptedMessageHeader[] | null;
  unsupportedReasons: string[];
  legacyPlaintext: boolean;
  replyToMessageId: string | null;
  trustStatus: 'self' | 'trusted' | 'unpinned-first-seen' | 'untrusted-rotation';
  trustNotice: string | null;
  trustWarning: string | null;
};

export type NewMessageFeed = {
  authenticated: true;
  connected: true;
  profile: string;
  scope: {
    slug: string | null;
    threadId: string | null;
  };
  totalMessages: number;
  messages: InboxMessageItem[];
};

export type PaginatedNewMessageFeed = NewMessageFeed & {
  page: number;
  pageSize: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  nextPage: number | null;
  previousPage: number | null;
};

type MessageSnapshot = {
  actors: VisibleAgentRow[];
  bundles: VisibleAgentKeyBundleRow[];
  participants: VisibleThreadParticipantRow[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: VisibleThreadRow[];
  messages: VisibleMessageRow[];
};

type UnreadMessageContext = {
  defaultActor: VisibleAgentRow;
  ownActorIds: Set<bigint>;
  unreadMessages: VisibleMessageRow[];
};

function findVersionedKey(
  actor: VisibleAgentRow,
  bundles: VisibleAgentKeyBundleRow[],
  kind: 'encryption' | 'signing',
  version: string
): string | null {
  if (kind === 'encryption' && actor.currentEncryptionKeyVersion === version) {
    return actor.currentEncryptionPublicKey;
  }
  if (kind === 'signing' && actor.currentSigningKeyVersion === version) {
    return actor.currentSigningPublicKey;
  }
  if (kind === 'encryption') {
    return bundles.find(bundle => bundle.encryptionKeyVersion === version)?.encryptionPublicKey ?? null;
  }
  return bundles.find(bundle => bundle.signingKeyVersion === version)?.signingPublicKey ?? null;
}

function normalizePage(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw userError('Page must be a positive integer.', {
      code: 'INVALID_PAGE',
    });
  }
  return value;
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined) return 5;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw userError('Page size must be an integer between 1 and 50.', {
      code: 'INVALID_PAGE_SIZE',
    });
  }
  return value;
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

function normalizeMessageScope(params: {
  slug?: string;
  threadId?: string;
}): {
  slug: string | null;
  threadId: bigint | null;
  threadIdText: string | null;
} {
  if (params.slug && params.threadId) {
    throw userError('Choose either `--slug` or a thread id, not both.', {
      code: 'MESSAGE_SCOPE_CONFLICT',
    });
  }

  const slug = params.slug ? normalizeInboxSlug(params.slug) : null;
  if (params.slug && !slug) {
    throw userError('Inbox slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const threadId = parseRequestedThreadId(params.threadId);
  return {
    slug,
    threadId,
    threadIdText: threadId?.toString() ?? null,
  };
}

export function selectUnreadIncomingMessages(
  snapshot: MessageSnapshot,
  normalizedEmail: string,
  actorSlug?: string
): UnreadMessageContext {
  const defaultActor = findDefaultActorByEmail(snapshot.actors, normalizedEmail);
  if (!defaultActor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }

  const requestedSlug = actorSlug ? normalizeInboxSlug(actorSlug) : null;
  if (actorSlug && !requestedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const recipientActor =
    requestedSlug
      ? snapshot.actors.find(
          actor =>
            actor.inboxId === defaultActor.inboxId && actor.slug === requestedSlug
        ) ?? null
      : defaultActor;
  if (!recipientActor) {
    throw userError(`No owned agent found for slug \`${requestedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }

  const selectedActorIds = new Set([recipientActor.id]);
  const recipientThreadIds = new Set(
    snapshot.participants
      .filter(participant => {
        return participant.agentDbId === recipientActor.id && participant.active;
      })
      .map(participant => participant.threadId)
  );
  const archivedThreadIds = new Set(
    snapshot.readStates
      .filter(readState => readState.agentDbId === recipientActor.id && readState.archived)
      .map(readState => readState.threadId)
  );
  const lastReadByThreadId = new Map<bigint, bigint>();
  for (const readState of snapshot.readStates) {
    if (readState.agentDbId !== recipientActor.id || readState.archived) {
      continue;
    }
    lastReadByThreadId.set(readState.threadId, readState.lastReadThreadSeq ?? 0n);
  }

  const unreadMessages = snapshot.messages
    .filter(message => recipientThreadIds.has(message.threadId))
    .filter(message => !archivedThreadIds.has(message.threadId))
    .filter(message => message.senderAgentDbId !== recipientActor.id)
    .filter(message => message.threadSeq > (lastReadByThreadId.get(message.threadId) ?? 0n))
    .sort((left, right) => {
      if (left.createdAt.microsSinceUnixEpoch < right.createdAt.microsSinceUnixEpoch) return 1;
      if (left.createdAt.microsSinceUnixEpoch > right.createdAt.microsSinceUnixEpoch) return -1;
      return Number(right.threadSeq - left.threadSeq);
    });

  return {
    defaultActor: recipientActor,
    ownActorIds: selectedActorIds,
    unreadMessages,
  };
}

function buildDirectCounterpartyByThreadId(params: {
  participants: VisibleThreadParticipantRow[];
  actorsById: Map<bigint, VisibleAgentRow>;
  threadsById: Map<bigint, VisibleThreadRow>;
  ownActorIds: Set<bigint>;
}): Map<bigint, VisibleAgentRow> {
  const participantsByThreadId = buildParticipantsByThreadId(params.participants);

  const counterpartByThreadId = new Map<bigint, VisibleAgentRow>();
  for (const [threadId] of participantsByThreadId) {
    const thread = params.threadsById.get(threadId);
    if (!thread || thread.kind !== 'direct') continue;

    const counterpart = resolveDirectCounterparty({
      thread,
      participantsByThreadId,
      actorsById: params.actorsById,
      ownActorIds: params.ownActorIds,
    });

    if (counterpart) {
      counterpartByThreadId.set(threadId, counterpart);
    }
  }

  return counterpartByThreadId;
}

export type MessageTrustStatus = 'self' | 'trusted' | 'unpinned-first-seen' | 'untrusted-rotation';

export async function decryptVisibleMessage(params: {
  message: VisibleMessageRow;
  defaultActor: VisibleAgentRow;
  actorsById: Map<bigint, VisibleAgentRow>;
  bundlesByActorId: Map<bigint, VisibleAgentKeyBundleRow[]>;
  ownActorIds?: Set<bigint>;
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  recipientKeyPair: AgentKeyPair | null;
  readUnsupported?: boolean;
}): Promise<{
  text: string | null;
  decryptStatus: 'ok' | 'unsupported' | 'failed';
  decryptError: string | null;
  contentType: string | null;
  headerNames: string[];
  headers: EncryptedMessageHeader[] | null;
  unsupportedReasons: string[];
  legacyPlaintext: boolean;
  trustStatus: MessageTrustStatus;
  trustNotice: string | null;
  trustWarning: string | null;
}> {
  const senderActor = params.actorsById.get(params.message.senderAgentDbId);
  if (!senderActor) {
    return {
      text: null,
      decryptStatus: 'failed',
      decryptError: 'Missing sender actor for this message.',
      contentType: null,
      headerNames: [],
      headers: null,
      unsupportedReasons: [],
      legacyPlaintext: false,
      trustStatus: 'trusted',
      trustNotice: null,
      trustWarning: null,
    };
  }

  const isSelfSender = params.ownActorIds?.has(senderActor.id) ?? false;
  let trustStatus: MessageTrustStatus = 'trusted';
  let trustNotice: string | null = null;
  let trustWarning: string | null = null;
  if (!isSelfSender) {
    const observedTuple = {
      encryptionPublicKey: senderActor.currentEncryptionPublicKey,
      encryptionKeyVersion: senderActor.currentEncryptionKeyVersion,
      signingPublicKey: senderActor.currentSigningPublicKey,
      signingKeyVersion: senderActor.currentSigningKeyVersion,
    };
    const allowFirstContactTrust =
      params.message.threadSeq === 1n && params.message.senderSeq === 1n;
    const comparison = allowFirstContactTrust
      ? await autoPinPeerIfUnknown(senderActor.publicIdentity, observedTuple)
      : await comparePinnedPeer(senderActor.publicIdentity, observedTuple);
    if (comparison.status === 'unpinned') {
      trustStatus = 'unpinned-first-seen';
      if (!allowFirstContactTrust) {
        trustWarning = `${senderActor.slug} keys are not trusted for this existing contact. Verify out-of-band, then run \`masumi-agent-messenger agent trust pin ${senderActor.slug}\`.`;
      }
    } else if (comparison.status === 'rotated') {
      trustNotice = `Key rotation: ${senderActor.slug} refreshed keys.`;
      const messageSigningKey = findVersionedKey(
        senderActor,
        params.bundlesByActorId.get(senderActor.id) ?? [],
        'signing',
        params.message.signingKeyVersion
      );
      if (!messageSigningKey) {
        trustStatus = 'untrusted-rotation';
        trustWarning = `${senderActor.slug} has rotated keys, but the signing key for version ${params.message.signingKeyVersion} could not be found.`;
      } else {
        const messageSigningTrusted = await isInboundSignatureTrusted(
          senderActor.publicIdentity,
          params.message.signingKeyVersion,
          messageSigningKey
        );
        if (!messageSigningTrusted) {
          trustStatus = 'untrusted-rotation';
          trustWarning = `${senderActor.slug} has rotated keys. Message signature is not trusted.`;
        }
      }
    }
  } else {
    trustStatus = 'self';
  }

  const envelope = params.secretEnvelopes.find(row => {
    return (
      row.threadId === params.message.threadId &&
      row.secretVersion === params.message.secretVersion &&
      row.membershipVersion === params.message.membershipVersion &&
      row.senderAgentDbId === params.message.senderAgentDbId &&
      row.recipientAgentDbId === params.defaultActor.id
    );
  });

  if (!envelope) {
    return {
      text: null,
      decryptStatus: 'failed',
      decryptError: 'No envelope available for this inbox.',
      contentType: null,
      headerNames: [],
      headers: null,
      unsupportedReasons: [],
      legacyPlaintext: false,
      trustStatus,
      trustNotice,
      trustWarning,
    };
  }

  const senderBundles = params.bundlesByActorId.get(senderActor.id) ?? [];
  const senderEncryptionPublicKey = findVersionedKey(
    senderActor,
    senderBundles,
    'encryption',
    envelope.senderEncryptionKeyVersion
  );
  const messageSigningPublicKey = findVersionedKey(
    senderActor,
    senderBundles,
    'signing',
    params.message.signingKeyVersion
  );
  const envelopeSigningPublicKey = findVersionedKey(
    senderActor,
    senderBundles,
    'signing',
    envelope.signingKeyVersion
  );

  if (!senderEncryptionPublicKey || !messageSigningPublicKey || !envelopeSigningPublicKey) {
    return {
      text: null,
      decryptStatus: 'failed',
      decryptError: 'Missing sender public keys for this message.',
      contentType: null,
      headerNames: [],
      headers: null,
      unsupportedReasons: [],
      legacyPlaintext: false,
      trustStatus,
      trustNotice,
      trustWarning,
    };
  }

  if (
    !params.recipientKeyPair ||
    params.recipientKeyPair.encryption.keyVersion !== envelope.recipientEncryptionKeyVersion
  ) {
    return {
      text: null,
      decryptStatus: 'failed',
      decryptError: 'Missing local private key for this envelope version.',
      contentType: null,
      headerNames: [],
      headers: null,
      unsupportedReasons: [],
      legacyPlaintext: false,
      trustStatus,
      trustNotice,
      trustWarning,
    };
  }

  try {
    const plaintext = await decryptMessage({
      recipientKeyPair: params.recipientKeyPair,
      recipientPublicIdentity: params.defaultActor.publicIdentity,
      message: {
        threadId: params.message.threadId,
        senderActorId: senderActor.id,
        senderPublicIdentity: senderActor.publicIdentity,
        senderSeq: params.message.senderSeq,
        secretVersion: params.message.secretVersion,
        signingKeyVersion: params.message.signingKeyVersion,
        ciphertext: params.message.ciphertext,
        iv: params.message.iv,
        cipherAlgorithm: params.message.cipherAlgorithm,
        signature: params.message.signature,
        replyToMessageId: params.message.replyToMessageId ?? undefined,
      } satisfies InboundEncryptedMessage,
      envelope: {
        id: envelope.id,
        threadId: envelope.threadId,
        secretVersion: envelope.secretVersion,
        senderActorId: envelope.senderAgentDbId,
        senderPublicIdentity: senderActor.publicIdentity,
        recipientActorId: envelope.recipientAgentDbId,
        recipientPublicIdentity: params.defaultActor.publicIdentity,
        recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
        senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
        signingKeyVersion: envelope.signingKeyVersion,
        wrappedSecretCiphertext: envelope.wrappedSecretCiphertext,
        wrappedSecretIv: envelope.wrappedSecretIv,
        wrapAlgorithm: envelope.wrapAlgorithm,
        signature: envelope.signature,
      } satisfies InboundSecretEnvelope,
      senderEncryptionPublicKey,
      messageSigningPublicKey,
      envelopeSigningPublicKey,
    });

    const parsed = parseDecryptedMessagePlaintext(plaintext);
    const capabilities: PublicMessageCapabilities =
      params.defaultActor.supportedMessageContentTypes &&
      params.defaultActor.supportedMessageHeaderNames
        ? buildPublicMessageCapabilities({
            allowAllContentTypes:
              params.defaultActor.allowAllMessageContentTypes ??
              (params.defaultActor.supportedMessageContentTypes.length === 0),
            allowAllHeaders:
              params.defaultActor.allowAllMessageHeaders ??
              (params.defaultActor.supportedMessageHeaderNames.length === 0),
            supportedContentTypes: params.defaultActor.supportedMessageContentTypes,
            supportedHeaders: params.defaultActor.supportedMessageHeaderNames,
          })
        : buildLegacyPublicMessageCapabilities();
    const unsupportedReasons = [
      ...(parsed.invalidStructuredEnvelopeReason
        ? [parsed.invalidStructuredEnvelopeReason]
        : []),
      ...findUnsupportedMessageReasons({
        payload: parsed.payload,
        capabilities,
      }),
    ];
    const headers = parsed.invalidStructuredEnvelopeReason
      ? []
      : parsed.payload.headers ?? [];
    const contentType = parsed.invalidStructuredEnvelopeReason
      ? null
      : parsed.payload.contentType;

    if (unsupportedReasons.length > 0 && !params.readUnsupported) {
      return {
        text: null,
        decryptStatus: 'unsupported',
        decryptError: null,
        contentType,
        headerNames: headers.map(header => header.name),
        headers: null,
        unsupportedReasons,
        legacyPlaintext: parsed.legacyPlaintext,
        trustStatus,
        trustNotice,
        trustWarning,
      };
    }

    return {
      text: formatEncryptedMessageBody(parsed.payload),
      decryptStatus: unsupportedReasons.length > 0 ? 'unsupported' : 'ok',
      decryptError: null,
      contentType,
      headerNames: headers.map(header => header.name),
      headers,
      unsupportedReasons,
      legacyPlaintext: parsed.legacyPlaintext,
      trustStatus,
      trustNotice,
      trustWarning,
    };
  } catch (error) {
    return {
      text: null,
      decryptStatus: 'failed',
      decryptError: error instanceof Error ? error.message : 'Unable to decrypt message.',
      contentType: null,
      headerNames: [],
      headers: null,
      unsupportedReasons: [],
      legacyPlaintext: false,
      trustStatus,
      trustNotice,
      trustWarning,
    };
  }
}

export async function readNewMessages(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string;
  slug?: string;
  threadId?: string;
  readUnsupported?: boolean;
  readMode?: 'latest' | 'subscription';
}): Promise<NewMessageFeed> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const secretStore = createSecretStore();
  const scope = normalizeMessageScope({
    slug: params.slug,
    threadId: params.threadId,
  });

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    const readMode = params.readMode ?? 'subscription';
    let unsubscribe: (() => void) | undefined;
    let snapshot: ReturnType<typeof readMessageRows>;
    if (readMode === 'latest') {
      params.reporter.verbose?.('Reading latest message state');
      snapshot = await readLatestMessageRows(conn);
    } else {
      params.reporter.verbose?.('Subscribing to message state');
      const subscription = await subscribeMessageTables(conn);
      unsubscribe = () => {
        subscription.unsubscribe();
      };
      snapshot = readMessageRows(conn);
    }

    try {
      params.reporter.verbose?.('Collecting unread messages');
      const { defaultActor, ownActorIds, unreadMessages } = selectUnreadIncomingMessages(
        snapshot,
        normalizedEmail,
        params.actorSlug
      );
      const recipientKeyPair = await getStoredActorKeyPair({
        profile,
        secretStore,
        identity: {
          normalizedEmail,
          slug: defaultActor.slug,
          inboxIdentifier: defaultActor.inboxIdentifier ?? defaultActor.slug,
        },
      });

      const actorsById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));
      const bundlesByActorId = new Map<bigint, VisibleAgentKeyBundleRow[]>();
      for (const bundle of snapshot.bundles) {
        const list = bundlesByActorId.get(bundle.agentDbId) ?? [];
        list.push(bundle);
        bundlesByActorId.set(bundle.agentDbId, list);
      }
      const participantsByThreadId = buildParticipantsByThreadId(snapshot.participants);
      const threadsById = new Map(snapshot.threads.map(thread => [thread.id, thread] as const));
      const counterpartByThreadId = buildDirectCounterpartyByThreadId({
        participants: snapshot.participants,
        actorsById,
        threadsById,
        ownActorIds,
      });

      const scopedUnreadMessages = unreadMessages.filter(message => {
        if (scope.threadId && message.threadId !== scope.threadId) {
          return false;
        }

        if (scope.slug) {
          return counterpartByThreadId.get(message.threadId)?.slug === scope.slug;
        }

        return true;
      });

      const messages = await Promise.all(
        scopedUnreadMessages.map(async message => {
          const senderActor = actorsById.get(message.senderAgentDbId);
          const thread = threadsById.get(message.threadId);
          const decrypted = await decryptVisibleMessage({
            message,
            defaultActor,
            actorsById,
            bundlesByActorId,
            ownActorIds,
            secretEnvelopes: snapshot.secretEnvelopes,
            recipientKeyPair,
            readUnsupported: params.readUnsupported,
          });

          return {
            id: message.id.toString(),
            threadId: message.threadId.toString(),
            threadSeq: message.threadSeq.toString(),
            createdAt: timestampToISOString(message.createdAt),
            threadLabel: thread
              ? summarizeThread(
                  thread,
                  participantsByThreadId.get(thread.id) ?? [],
                  actorsById,
                  ownActorIds
                )
      : `Thread ${message.threadId.toString()}`,
            sender: {
              id: senderActor?.id.toString() ?? message.senderAgentDbId.toString(),
              slug: senderActor?.slug ?? 'unknown',
              displayName: senderActor?.displayName ?? null,
              publicIdentity: senderActor?.publicIdentity ?? 'unknown',
            },
            text: decrypted.text,
            decryptStatus: decrypted.decryptStatus,
            decryptError: decrypted.decryptError,
            contentType: decrypted.contentType,
            headerNames: decrypted.headerNames,
            headers: decrypted.headers,
            unsupportedReasons: decrypted.unsupportedReasons,
            legacyPlaintext: decrypted.legacyPlaintext,
            replyToMessageId: message.replyToMessageId?.toString() ?? null,
            trustStatus: decrypted.trustStatus,
            trustNotice: decrypted.trustNotice,
            trustWarning: decrypted.trustWarning,
          } satisfies InboxMessageItem;
        })
      );

      params.reporter.success(`Loaded ${messages.length} new message${messages.length === 1 ? '' : 's'}`);

      return {
        authenticated: true,
        connected: true,
        profile: profile.name,
        scope: {
          slug: scope.slug,
          threadId: scope.threadIdText,
        },
        totalMessages: messages.length,
        messages,
      };
    } finally {
      unsubscribe?.();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to load new messages.', {
      code: 'INBOX_MESSAGES_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export function paginateNewMessages(
  feed: NewMessageFeed,
  params?: {
    page?: number;
    pageSize?: number;
  }
): PaginatedNewMessageFeed {
  const page = normalizePage(params?.page);
  const pageSize = normalizePageSize(params?.pageSize);
  const totalPages = Math.max(1, Math.ceil(feed.totalMessages / pageSize));
  const boundedPage = Math.min(page, totalPages);
  const start = (boundedPage - 1) * pageSize;
  const end = start + pageSize;

  return {
    ...feed,
    page: boundedPage,
    pageSize,
    totalPages,
    hasPrevious: boundedPage > 1,
    hasNext: boundedPage < totalPages,
    previousPage: boundedPage > 1 ? boundedPage - 1 : null,
    nextPage: boundedPage < totalPages ? boundedPage + 1 : null,
    messages: feed.messages.slice(start, end),
  };
}
