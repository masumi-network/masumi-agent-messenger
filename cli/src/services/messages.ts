import type {
  AgentKeyPair,
  InboundEncryptedMessage,
  InboundSecretEnvelope,
} from '../../../shared/agent-crypto';
import {
  decryptMessage,
  normalizeEnvelopeWrapAlgorithm,
  normalizeMessageCipherAlgorithm,
} from '../../../shared/agent-crypto';
import { toHex } from '../../../shared/crypto-utils';
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
import type { DbConnection } from '../../../webapp/src/module_bindings';
import type {
  Agent,
  Thread,
  ThreadSecretEnvelope as VisibleThreadSecretEnvelopeRow,
  Message,
} from '../../../webapp/src/module_bindings/types';
import {
  toAgentPublicKeyKindTag,
  type AgentPublicKeyLookupRow,
} from '../../../webapp/src/lib/procedures';

type AgentPublicKeyLookupRequest = {
  agentDbId: bigint;
  keyKind: 'encryption' | 'signing';
  keyVersion: number;
};
import { ensureAuthenticatedSession } from './auth';
import { getStoredActorKeyPair } from './actor-keys';
import type { TaskReporter } from './command-runtime';
import { connectivityError, isCliError, userError } from './errors';
import {
  autoPinPeerIfUnknown,
  comparePinnedPeer,
  confirmPeerKeyRotation,
  type PeerKeyTuple,
} from './peer-key-trust';
import { createSecretStore } from './secret-store';
import {
  connectAuthenticated,
  disconnectConnection,
  readLatestMessageRows,
  readSubscribedMessageRows,
  subscribeMessageTables,
  type MessageRows,
  type VisibleThreadReadStateRow,
  type VisibleThreadParticipantRow,
} from './spacetimedb';
import { mergeRowsById } from './row-utils';

const AGENT_PUBLIC_KEY_LOOKUP_BATCH_SIZE = 100;

export type InboxMessageItem = {
  id: string;
  threadId: string;
  messageId: string;
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
  actors: Agent[];
  participants: VisibleThreadParticipantRow[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: Thread[];
  messages: Message[];
};
type AgentPublicKeyKind = 'encryption' | 'signing';

type UnreadMessageContext = {
  defaultActor: Agent;
  ownActorIds: Set<bigint>;
  unreadMessages: Message[];
};

function findVersionedKey(
  _actor: Agent,
  publicKeys: AgentPublicKeyLookupRow[],
  kind: AgentPublicKeyKind,
  version: number
): string | null {
  const expectedTag = kind === 'encryption' ? 'Encryption' : 'Signing';
  return (
    publicKeys.find(key => key.keyKind.tag === expectedTag && key.keyVersion === version)
      ?.publicKey ?? null
  );
}

function tupleFromAgentPublicKeyRows(
  actor: Agent,
  publicKeys: AgentPublicKeyLookupRow[]
): PeerKeyTuple | null {
  const encryptionPublicKey = findVersionedKey(
    actor,
    publicKeys,
    'encryption',
    actor.currentKeyBundleVersion
  );
  const signingPublicKey = findVersionedKey(
    actor,
    publicKeys,
    'signing',
    actor.currentKeyBundleVersion
  );

  if (!encryptionPublicKey || !signingPublicKey) {
    return null;
  }

  return {
    encryptionPublicKey,
    encryptionKeyVersion: actor.currentKeyBundleVersion,
    signingPublicKey,
    signingKeyVersion: actor.currentKeyBundleVersion,
  };
}

function addPublicKeyLookupRequest(params: {
  requestsByKey: Map<string, AgentPublicKeyLookupRequest>;
  actorsById: Map<bigint, Agent>;
  agentDbId: bigint;
  keyKind: AgentPublicKeyKind;
  keyVersion: number;
}) {
  const requestKey = `${params.agentDbId.toString()}:${params.keyKind}:${params.keyVersion}`;
  params.requestsByKey.set(requestKey, {
    agentDbId: params.agentDbId,
    keyKind: params.keyKind,
    keyVersion: params.keyVersion,
  });
}

export function collectMessagePublicKeyLookupRequests(params: {
  messages: Message[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  actorsById: Map<bigint, Agent>;
}): AgentPublicKeyLookupRequest[] {
  const requestsByKey = new Map<string, AgentPublicKeyLookupRequest>();
  const messageSecretKeys = new Set(
    params.messages.map(message =>
      [
        message.threadId.toString(),
        message.membershipVersion.toString(),
        message.senderAgentDbId.toString(),
        message.secretVersion,
      ].join(':')
    )
  );

  for (const message of params.messages) {
    const senderActor = params.actorsById.get(message.senderAgentDbId);
    if (senderActor) {
      addPublicKeyLookupRequest({
        requestsByKey,
        actorsById: params.actorsById,
        agentDbId: senderActor.id,
        keyKind: 'encryption',
        keyVersion: senderActor.currentKeyBundleVersion,
      });
      addPublicKeyLookupRequest({
        requestsByKey,
        actorsById: params.actorsById,
        agentDbId: senderActor.id,
        keyKind: 'signing',
        keyVersion: senderActor.currentKeyBundleVersion,
      });
    }
    addPublicKeyLookupRequest({
      requestsByKey,
      actorsById: params.actorsById,
      agentDbId: message.senderAgentDbId,
      keyKind: 'signing',
      keyVersion: message.signingKeyVersion,
    });
  }

  for (const envelope of params.secretEnvelopes) {
    const messageSecretKey = [
      envelope.threadId.toString(),
      envelope.membershipVersion.toString(),
      envelope.senderAgentDbId.toString(),
      envelope.secretVersion,
    ].join(':');
    if (!messageSecretKeys.has(messageSecretKey)) {
      continue;
    }

    addPublicKeyLookupRequest({
      requestsByKey,
      actorsById: params.actorsById,
      agentDbId: envelope.senderAgentDbId,
      keyKind: 'encryption',
      keyVersion: envelope.senderEncryptionKeyVersion,
    });
    addPublicKeyLookupRequest({
      requestsByKey,
      actorsById: params.actorsById,
      agentDbId: envelope.senderAgentDbId,
      keyKind: 'signing',
      keyVersion: envelope.signingKeyVersion,
    });
  }

  return Array.from(requestsByKey.values());
}

export async function lookupMessagePublicKeys(params: {
  conn: DbConnection;
  agentDbId: bigint;
  messages: Message[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  actorsById: Map<bigint, Agent>;
}): Promise<AgentPublicKeyLookupRow[]> {
  const requests = collectMessagePublicKeyLookupRequests({
    messages: params.messages,
    secretEnvelopes: params.secretEnvelopes,
    actorsById: params.actorsById,
  });
  const rows: AgentPublicKeyLookupRow[] = [];
  for (let index = 0; index < requests.length; index += AGENT_PUBLIC_KEY_LOOKUP_BATCH_SIZE) {
    const batch = requests.slice(index, index + AGENT_PUBLIC_KEY_LOOKUP_BATCH_SIZE).map(
      request => ({
        agentDbId: request.agentDbId,
        keyKind: toAgentPublicKeyKindTag(request.keyKind),
        keyVersion: request.keyVersion,
      })
    );
    rows.push(...(await params.conn.procedures.lookupAgentPublicKeys({ requests: batch })));
  }
  return rows;
}

export function buildPublicKeysByActorId(
  publicKeys: AgentPublicKeyLookupRow[]
): Map<bigint, AgentPublicKeyLookupRow[]> {
  const publicKeysByActorId = new Map<bigint, AgentPublicKeyLookupRow[]>();
  for (const publicKey of publicKeys) {
    const list = publicKeysByActorId.get(publicKey.agentDbId) ?? [];
    list.push(publicKey);
    publicKeysByActorId.set(publicKey.agentDbId, list);
  }
  return publicKeysByActorId;
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
  if (!Number.isInteger(value) || value < 1 || value > 25) {
    throw userError('Page size must be an integer between 1 and 25.', {
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
  email: string,
  actorSlug?: string
): UnreadMessageContext {
  const defaultActor = findDefaultActorByEmail(snapshot.actors, email);
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
            actor.accountId === defaultActor.accountId && actor.slug === requestedSlug
        ) ?? null
      : defaultActor;
  if (!recipientActor) {
    throw userError(`No owned agent found for slug \`${requestedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }

  const selectedActorIds = new Set([recipientActor.id]);
  const participantStates = mergeRowsById<VisibleThreadParticipantRow>(
    snapshot.participants,
    snapshot.readStates
  );
  const recipientThreadIds = new Set(
    participantStates
      .filter(participant => {
        return participant.agentDbId === recipientActor.id && participant.active;
      })
      .map(participant => participant.threadId)
  );
  const archivedThreadIds = new Set(
    participantStates
      .filter(participant => participant.agentDbId === recipientActor.id && participant.archived)
      .map(participant => participant.threadId)
  );
  const lastReadByThreadId = new Map<bigint, bigint>();
  for (const participant of participantStates) {
    if (
      participant.agentDbId !== recipientActor.id ||
      participant.active === false ||
      participant.archived
    ) {
      continue;
    }
    lastReadByThreadId.set(participant.threadId, participant.lastReadMessageId ?? 0n);
  }

  const unreadMessages = snapshot.messages
    .filter(message => recipientThreadIds.has(message.threadId))
    .filter(message => !archivedThreadIds.has(message.threadId))
    .filter(message => message.senderAgentDbId !== recipientActor.id)
    .filter(message => message.id > (lastReadByThreadId.get(message.threadId) ?? 0n))
    .sort((left, right) => {
      if (left.createdAt.microsSinceUnixEpoch < right.createdAt.microsSinceUnixEpoch) return 1;
      if (left.createdAt.microsSinceUnixEpoch > right.createdAt.microsSinceUnixEpoch) return -1;
      return Number(right.id - left.id);
    });

  return {
    defaultActor: recipientActor,
    ownActorIds: selectedActorIds,
    unreadMessages,
  };
}

function buildDirectCounterpartyByThreadId(params: {
  participants: VisibleThreadParticipantRow[];
  actorsById: Map<bigint, Agent>;
  threadsById: Map<bigint, Thread>;
  ownActorIds: Set<bigint>;
}): Map<bigint, Agent> {
  const participantsByThreadId = buildParticipantsByThreadId(params.participants);

  const counterpartByThreadId = new Map<bigint, Agent>();
  for (const [threadId] of participantsByThreadId) {
    const thread = params.threadsById.get(threadId);
    if (!thread || thread.kind.tag !== 'Direct') continue;

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
  message: Message;
  defaultActor: Agent;
  actorsById: Map<bigint, Agent>;
  publicKeysByActorId: Map<bigint, AgentPublicKeyLookupRow[]>;
  ownActorIds?: Set<bigint>;
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  recipientKeyPair: AgentKeyPair | null;
  readUnsupported?: boolean;
  allowFirstContactTrust?: boolean;
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
  let rotationToConfirm: PeerKeyTuple | null = null;
  if (!isSelfSender) {
    const senderPublicKeys = params.publicKeysByActorId.get(senderActor.id) ?? [];
    const observedTuple = tupleFromAgentPublicKeyRows(senderActor, senderPublicKeys);
    if (!observedTuple) {
      trustStatus = 'untrusted-rotation';
      trustWarning = `${senderActor.slug} keys could not be resolved for trust verification.`;
    } else {
      const allowFirstContactTrust = params.allowFirstContactTrust === true;
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
          senderPublicKeys,
          'signing',
          params.message.signingKeyVersion
        );
        if (!messageSigningKey) {
          trustStatus = 'untrusted-rotation';
          trustWarning = `${senderActor.slug} has rotated keys, but the signing key for version ${params.message.signingKeyVersion} could not be found.`;
        } else {
          rotationToConfirm = observedTuple;
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

  const senderPublicKeys = params.publicKeysByActorId.get(senderActor.id) ?? [];
  const senderEncryptionPublicKey = findVersionedKey(
    senderActor,
    senderPublicKeys,
    'encryption',
    envelope.senderEncryptionKeyVersion
  );
  const messageSigningPublicKey = findVersionedKey(
    senderActor,
    senderPublicKeys,
    'signing',
    params.message.signingKeyVersion
  );
  const envelopeSigningPublicKey = findVersionedKey(
    senderActor,
    senderPublicKeys,
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
        senderMessageId: params.message.senderMessageId,
        secretVersion: params.message.secretVersion,
        signingKeyVersion: params.message.signingKeyVersion,
        ciphertext: toHex(params.message.ciphertext),
        iv: toHex(params.message.iv),
        cipherAlgorithm: normalizeMessageCipherAlgorithm(params.message.cipherAlgorithm),
        signature: toHex(params.message.signature),
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
        wrappedSecretCiphertext: toHex(envelope.wrappedSecretCiphertext),
        wrappedSecretIv: toHex(envelope.wrappedSecretIv),
        wrapAlgorithm: normalizeEnvelopeWrapAlgorithm(envelope.wrapAlgorithm),
        signature: toHex(envelope.signature),
      } satisfies InboundSecretEnvelope,
      senderEncryptionPublicKey,
      messageSigningPublicKey,
      envelopeSigningPublicKey,
    });

    if (rotationToConfirm) {
      try {
        await confirmPeerKeyRotation(senderActor.publicIdentity, rotationToConfirm);
      } catch {
        trustWarning =
          trustWarning ??
          `${senderActor.slug} rotated keys, but the local trust store could not be updated.`;
      }
    }

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
  pageSize?: number;
}): Promise<NewMessageFeed> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const secretStore = createSecretStore();
  const scope = normalizeMessageScope({
    slug: params.slug,
    threadId: params.threadId,
  });
  const messagePageSize = BigInt(normalizePageSize(params.pageSize));

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
    let snapshot: MessageRows;
    if (readMode === 'latest') {
      params.reporter.verbose?.('Reading latest message state');
      snapshot = await readLatestMessageRows(conn, {
        email,
        actorSlug: params.actorSlug,
        threadId: scope.threadId,
        counterpartySlug: scope.slug,
        messagePageSize,
      });
    } else {
      params.reporter.verbose?.('Subscribing to message state');
      const subscription = await subscribeMessageTables(conn);
      unsubscribe = () => {
        subscription.unsubscribe();
      };
      snapshot = await readSubscribedMessageRows(conn, {
        email,
        actorSlug: params.actorSlug,
        threadId: scope.threadId,
        counterpartySlug: scope.slug,
        messagePageSize,
      });
    }

    try {
      params.reporter.verbose?.('Collecting unread messages');
      const { defaultActor, ownActorIds, unreadMessages } = selectUnreadIncomingMessages(
        snapshot,
        email,
        params.actorSlug
      );
      const recipientKeyPair = await getStoredActorKeyPair({
        profile,
        secretStore,
        identity: {
          email,
          slug: defaultActor.slug,
          accountIdentifier: defaultActor.slug,
        },
      });

      const actorsById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));
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
      const publicKeysByActorId = buildPublicKeysByActorId(
        await lookupMessagePublicKeys({
          conn,
          agentDbId: defaultActor.id,
          messages: scopedUnreadMessages,
          secretEnvelopes: snapshot.secretEnvelopes,
          actorsById,
        })
      );

      const messages = await Promise.all(
        scopedUnreadMessages.map(async message => {
          const senderActor = actorsById.get(message.senderAgentDbId);
          const thread = threadsById.get(message.threadId);
          const decrypted = await decryptVisibleMessage({
            message,
            defaultActor,
            actorsById,
            publicKeysByActorId,
            ownActorIds,
            secretEnvelopes: snapshot.secretEnvelopes,
            recipientKeyPair,
            readUnsupported: params.readUnsupported,
            // First-contact heuristic: only the very first message on a fresh thread can
            // auto-pin the peer's keys without prior trust. If two messages race to land
            // before the subscription flushes, the second one falls through to
            // `unpinned-first-seen` and the user is prompted to confirm — this is the
            // intentional safe default; do not loosen the equality without re-evaluating
            // the trust model.
            allowFirstContactTrust:
              thread?.messageCount === 1n && thread.lastMessageId === message.id,
          });

          return {
            id: message.id.toString(),
            threadId: message.threadId.toString(),
            messageId: message.id.toString(),
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
