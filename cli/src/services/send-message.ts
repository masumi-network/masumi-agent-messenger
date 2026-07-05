import {
  cacheSenderSecret,
  getCachedSenderSecret,
  normalizeEnvelopeWrapAlgorithm,
  prepareEncryptedMessage,
  randomSenderMessageId,
  unwrapSecretEnvelope,
  type ActorPublicKeys,
  type AgentKeyPair,
  type SenderSecretState,
} from '../../../shared/agent-crypto';
import { fromHex, toHex } from '../../../shared/crypto-utils';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  findActorIdByPublicIdentity,
  findDirectThreads as findDirectThreadsByIds,
  generateClientThreadId,
  isDirectThreadBetween,
  summarizeThread,
} from '../../../shared/inbox-state';
import {
  isDeregisteringOrDeregisteredInboxAgentState,
  isFailedRegistrationInboxAgentState,
} from '../../../shared/inbox-agent-registration';
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
  Agent,
  ThreadParticipant,
  ThreadParticipantPreview,
  Thread,
  ContactRequest,
  Message,
  ThreadSecretEnvelope as VisibleThreadSecretEnvelopeRow,
  ThreadInvite,
} from '../../../webapp/src/module_bindings/types';
import type { DbConnection } from '../../../webapp/src/module_bindings';
import { ensureAuthenticatedSession, type AuthSessionContext } from './auth';
import type { TaskReporter } from './command-runtime';
import { connectivityError, userError } from './errors';
import {
  autoPinPeerIfUnknown,
  comparePinnedPeer,
  confirmPeerKeyRotation,
  type PeerKeyTuple,
} from './peer-key-trust';
import { resolvePublishedActorLookup } from './published-actor-lookup';
import {
  resolveStoredActorKeyPairForPublishedActor,
  type PublishedActorKeyBundle,
} from './actor-keys';
import { resolvePreferredAgentSlug } from './agent-state';
import { requireImportedRotationKeyConfirmed } from './imported-rotation-key-confirmation';
import { createSecretStore } from './secret-store';
import {
  connectAuthenticated,
  disconnectConnection,
  readAllOwnedAgents,
  readAllThreadParticipants,
  readLatestMetadataRows,
  readOwnedAgentRow,
  readStatesFromVisibleThreadPage,
  withSpacetimeOperationTimeout,
  type VisibleThreadReadStateRow,
} from './spacetimedb';
import { lookupMasumiInboxAgentBySlug } from './masumi-inbox-agent';
import { mergeRowsById } from './row-utils';

type MessageSnapshot = {
  actors: Agent[];
  participants: VisibleThreadParticipant[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: Thread[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  messages: Message[];
};
type AuthenticatedProfile = Awaited<ReturnType<typeof ensureAuthenticatedSession>>['profile'];
type VisibleThreadParticipant = ThreadParticipantPreview & Partial<ThreadParticipant>;

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

const SEND_SPACETIME_OPERATION_TIMEOUT_MS = 15000;
const SEND_REDUCER_ACK_TIMEOUT_MS = 2500;

export type SendMessageToThreadResult = {
  sent: true;
  profile: string;
  actorSlug: string;
  threadId: string;
  threadKind: string;
  label: string;
  messageId: string;
  senderMessageId: string;
};

type SendMessageToThreadCoreParams = {
  profile: AuthenticatedProfile;
  email: string;
  conn: DbConnection;
  snapshot: MessageSnapshot;
  requestedThreadId: bigint;
  actorSlug?: string;
  message: string;
  contentType?: string;
  headerLines: string[];
  reporter: TaskReporter;
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
      senderMessageId: string;
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

function toCipherAlgorithm(_algorithm: string): { tag: 'AesGcm256V1' } {
  return { tag: 'AesGcm256V1' };
}

function toReducerEnvelopes(
  envelopes: ReadonlyArray<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: number;
    senderEncryptionKeyVersion: number;
    signingKeyVersion: number;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>
): Array<{
  recipientPublicIdentity: string;
  recipientEncryptionKeyVersion: number;
  senderEncryptionKeyVersion: number;
  signingKeyVersion: number;
  wrappedSecretCiphertext: Uint8Array;
  wrappedSecretIv: Uint8Array;
  wrapAlgorithm: { tag: 'EcdhP256AesGcm256V1' };
  signature: Uint8Array;
}> {
  return envelopes.map(env => ({
    ...env,
    wrappedSecretCiphertext: fromHex(env.wrappedSecretCiphertext),
    wrappedSecretIv: fromHex(env.wrappedSecretIv),
    wrapAlgorithm: { tag: 'EcdhP256AesGcm256V1' },
    signature: fromHex(env.signature),
  }));
}

function compareBigIntDesc(left: bigint, right: bigint): number {
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

async function runSendSpacetimeOperation<Result>(
  label: string,
  run: () => PromiseLike<Result>
): Promise<Result> {
  return await withSpacetimeOperationTimeout(
    {
      label,
      timeoutMs: SEND_SPACETIME_OPERATION_TIMEOUT_MS,
      code: 'SPACETIMEDB_SEND_OPERATION_TIMEOUT',
    },
    run
  );
}

async function submitSendEncryptedMessageReducer(params: {
  label: string;
  reporter: TaskReporter;
  run: () => PromiseLike<void>;
}): Promise<void> {
  const timeoutSentinel = Symbol('send-reducer-ack-timeout');
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const reducerPromise = Promise.resolve().then(() => params.run());
  const timeoutPromise = new Promise<typeof timeoutSentinel>(resolve => {
    timeoutId = setTimeout(() => {
      resolve(timeoutSentinel);
    }, SEND_REDUCER_ACK_TIMEOUT_MS);
  });

  const result = await Promise.race([reducerPromise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
  if (result === timeoutSentinel) {
    reducerPromise.catch(() => {
      // The reducer was submitted but the acknowledgement arrived after the
      // optimistic UI path returned. The next live refresh or explicit retry
      // will surface durable state; avoid an unhandled rejection here.
    });
    params.reporter.verbose?.(`${params.label} submitted; waiting for live sync`);
  }
}

function isApprovalRequiredForFirstContactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('requires approval for first contact') ||
    normalized.includes('direct contact requires approval')
  );
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

function tupleFromActorPublicKeys(actor: ActorPublicKeys): PeerKeyTuple {
  return {
    encryptionPublicKey: actor.encryptionPublicKey,
    encryptionKeyVersion: actor.encryptionKeyVersion,
    signingPublicKey: actor.signingPublicKey,
    signingKeyVersion: actor.signingKeyVersion,
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

export async function requirePeerKeyTrust(params: {
  publicIdentity: string;
  displayLabel: string;
  observed: PeerKeyTuple;
  allowFirstContactTrust: boolean;
}): Promise<void> {
  // Per CLAUDE.md "Peer Key Trust Rules": peer rotations are accepted client-side after the
  // published tuple is observed, while sender-owned imported keys are gated separately.
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
      `Keys for ${params.displayLabel} are not trusted for this existing contact. Verify them out-of-band, then run \`masumi-agent-messenger agent trust pin ${params.displayLabel}\` before sending.`,
      { code: 'PEER_KEY_UNPINNED' }
    );
  }

  await confirmPeerKeyRotation(params.publicIdentity, params.observed);
}

function toActorPublicKeys(
  actor: Agent,
  keys: {
    encryptionPublicKey: string;
    signingPublicKey: string;
  }
): ActorPublicKeys {
  return {
    actorId: actor.id,
    email: actor.email,
    slug: actor.slug,
    isDefault: actor.isDefault,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName ?? null,
    encryptionPublicKey: keys.encryptionPublicKey,
    encryptionKeyVersion: actor.currentKeyBundleVersion,
    signingPublicKey: keys.signingPublicKey,
    signingKeyVersion: actor.currentKeyBundleVersion,
  };
}

function toPublishedActorPublicKeys(target: PublishedActorLookupLike): ActorPublicKeys {
  return {
    email: '',
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
  conn: DbConnection;
  ownActor: Agent;
}): Promise<AgentKeyPair> {
  const secretStore = createSecretStore();
  const identity = {
    email: params.ownActor.email,
    slug: params.ownActor.slug,
  };
  const published = await resolvePublishedKeyBundle(params.conn, params.ownActor);
  const keyResolution = await resolveStoredActorKeyPairForPublishedActor({
    profile: params.profile,
    secretStore,
    identity,
    published,
  });

  if (keyResolution.status === 'matched') {
    await requireImportedRotationKeyConfirmed({
      identity,
      keyPair: keyResolution.keyPair,
    });
    return keyResolution.keyPair;
  }

  throw userError(
    keyResolution.status === 'mismatch'
      ? `Local agent key bundle for \`${params.ownActor.slug}\` no longer matches the published actor keys. Ask the user which option to use: recover/import matching keys with their approved device or backup, or approve \`agent key reset ${params.ownActor.slug} --json\`, which makes old encrypted messages unreadable from this CLI profile.`
      : `No local agent key bundle found for \`${params.ownActor.slug}\`. Ask the user which option to use: recover keys with their approved device or encrypted backup, or approve \`agent key reset ${params.ownActor.slug} --json\`, which makes old encrypted messages unreadable from this CLI profile.`,
    {
      code:
        keyResolution.status === 'mismatch'
          ? 'AGENT_KEYPAIR_OUT_OF_SYNC'
          : 'AGENT_KEYPAIR_REQUIRED',
      hint: 'masumi-agent-messenger account status --json',
    }
  );
}

function findLookupKey(
  rows: Awaited<ReturnType<DbConnection['procedures']['lookupAgentPublicKeys']>>,
  kind: 'Encryption' | 'Signing',
  version: number
): string | null {
  return rows.find(row => row.keyKind.tag === kind && row.keyVersion === version)?.publicKey ?? null;
}

async function resolvePublishedKeyBundle(
  conn: DbConnection,
  actor: Agent
): Promise<PublishedActorKeyBundle> {
  const rows = await runSendSpacetimeOperation('public key lookup', () =>
    conn.procedures.lookupAgentPublicKeys({
      requests: [
        {
          agentDbId: actor.id,
          keyKind: { tag: 'Encryption' },
          keyVersion: actor.currentKeyBundleVersion,
        },
        {
          agentDbId: actor.id,
          keyKind: { tag: 'Signing' },
          keyVersion: actor.currentKeyBundleVersion,
        },
      ],
    })
  );
  const encryptionPublicKey = findLookupKey(
    rows,
    'Encryption',
    actor.currentKeyBundleVersion
  );
  const signingPublicKey = findLookupKey(rows, 'Signing', actor.currentKeyBundleVersion);
  if (!encryptionPublicKey || !signingPublicKey) {
    throw userError(`Published public keys for \`${actor.slug}\` are unavailable.`, {
      code: 'AGENT_PUBLIC_KEYS_UNAVAILABLE',
    });
  }

  return {
    encryption: {
      publicKey: encryptionPublicKey,
      keyVersion: actor.currentKeyBundleVersion,
    },
    signing: {
      publicKey: signingPublicKey,
      keyVersion: actor.currentKeyBundleVersion,
    },
  };
}

async function resolveActorPublicKeys(
  conn: DbConnection,
  actor: Agent
): Promise<ActorPublicKeys> {
  const published = await resolvePublishedKeyBundle(conn, actor);
  return toActorPublicKeys(actor, {
    encryptionPublicKey: published.encryption.publicKey,
    signingPublicKey: published.signing.publicKey,
  });
}

async function lookupActorPublicKeysForEnvelope(params: {
  conn: DbConnection;
  actor: Agent;
  encryptionKeyVersion: number;
  signingKeyVersion: number;
}): Promise<{ encryptionPublicKey: string; signingPublicKey: string } | null> {
  const rows = await runSendSpacetimeOperation('envelope public key lookup', () =>
    params.conn.procedures.lookupAgentPublicKeys({
      requests: [
        {
          agentDbId: params.actor.id,
          keyKind: { tag: 'Encryption' },
          keyVersion: params.encryptionKeyVersion,
        },
        {
          agentDbId: params.actor.id,
          keyKind: { tag: 'Signing' },
          keyVersion: params.signingKeyVersion,
        },
      ],
    })
  );
  const encryptionPublicKey = findLookupKey(
    rows,
    'Encryption',
    params.encryptionKeyVersion
  );
  const signingPublicKey = findLookupKey(rows, 'Signing', params.signingKeyVersion);
  if (!encryptionPublicKey || !signingPublicKey) {
    return null;
  }
  return { encryptionPublicKey, signingPublicKey };
}

export async function resolveExistingSenderSecret(params: {
  conn: DbConnection;
  threadId: bigint;
  ownActor: Agent;
  keyPair: AgentKeyPair;
  latestSenderState: SenderSecretVersionState | undefined;
  envelopes: VisibleThreadSecretEnvelopeRow[];
  requiresSecretRotation: boolean;
}): Promise<SenderSecretState | null> {
  if (!params.latestSenderState || params.requiresSecretRotation) {
    return null;
  }
  const latestSenderState = params.latestSenderState;

  const cached = getCachedSenderSecret(
    params.threadId,
    params.ownActor.publicIdentity,
    latestSenderState.secretVersion
  );
  if (cached) {
    return cached;
  }

  const ownEnvelope = params.envelopes.find(envelope => {
    return (
      envelope.threadId === params.threadId &&
      envelope.membershipVersion === latestSenderState.membershipVersion &&
      envelope.senderAgentDbId === params.ownActor.id &&
      envelope.recipientAgentDbId === params.ownActor.id &&
      envelope.secretVersion === latestSenderState.secretVersion
    );
  });
  if (!ownEnvelope) {
    return null;
  }
  if (ownEnvelope.recipientEncryptionKeyVersion !== params.keyPair.encryption.keyVersion) {
    return null;
  }

  const keys = await lookupActorPublicKeysForEnvelope({
    conn: params.conn,
    actor: params.ownActor,
    encryptionKeyVersion: ownEnvelope.senderEncryptionKeyVersion,
    signingKeyVersion: ownEnvelope.signingKeyVersion,
  });
  if (!keys) {
    return null;
  }

  return await unwrapSecretEnvelope({
    threadId: params.threadId,
    senderPublicIdentity: params.ownActor.publicIdentity,
    recipientPublicIdentity: params.ownActor.publicIdentity,
    recipientKeyPair: params.keyPair,
    envelope: {
      id: ownEnvelope.id,
      threadId: ownEnvelope.threadId,
      secretVersion: ownEnvelope.secretVersion,
      senderActorId: ownEnvelope.senderAgentDbId,
      senderPublicIdentity: params.ownActor.publicIdentity,
      recipientActorId: ownEnvelope.recipientAgentDbId,
      recipientPublicIdentity: params.ownActor.publicIdentity,
      recipientEncryptionKeyVersion: ownEnvelope.recipientEncryptionKeyVersion,
      senderEncryptionKeyVersion: ownEnvelope.senderEncryptionKeyVersion,
      signingKeyVersion: ownEnvelope.signingKeyVersion,
      wrappedSecretCiphertext: toHex(ownEnvelope.wrappedSecretCiphertext),
      wrappedSecretIv: toHex(ownEnvelope.wrappedSecretIv),
      wrapAlgorithm: normalizeEnvelopeWrapAlgorithm(ownEnvelope.wrapAlgorithm),
      signature: toHex(ownEnvelope.signature),
    },
    senderEncryptionPublicKey: keys.encryptionPublicKey,
    envelopeSigningPublicKey: keys.signingPublicKey,
  });
}

function requireOwnedActor(params: {
  actors: Agent[];
  participants?: VisibleThreadParticipant[];
  email: string;
  actorSlug?: string;
  threadId?: bigint;
}): Agent {
  const ownedActors = params.actors.filter(actor => actor.email === params.email);

  if (params.actorSlug) {
    const normalizedSlug = normalizeInboxSlug(params.actorSlug);
    if (!normalizedSlug) {
      throw userError('Inbox slug is invalid.', {
        code: 'INVALID_SLUG',
      });
    }

    const actor = ownedActors.find(row => row.slug === normalizedSlug);
    if (!actor) {
      throw userError(`No owned inbox actor found for slug \`${normalizedSlug}\`.`, {
        code: 'OWNED_ACTOR_NOT_FOUND',
      });
    }

    if (isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState?.tag)) {
      throw userError(
        `Agent \`${actor.slug}\` is deregistering or deregistered and cannot send chats.`,
        {
          code: 'AGENT_DEREGISTERED',
        }
      );
    }

    return actor;
  }

  if (params.threadId !== undefined && params.participants !== undefined) {
    const activeParticipantAgentIds = new Set(
      params.participants
        .filter(participant => participant.threadId === params.threadId && participant.active)
        .map(participant => participant.agentDbId)
    );
    const candidates = ownedActors.filter(actor => activeParticipantAgentIds.has(actor.id));
    if (candidates.length === 1) {
      const actor = candidates[0]!;
      if (isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState?.tag)) {
        throw userError(
          `Agent \`${actor.slug}\` is deregistering or deregistered and cannot send chats.`,
          {
            code: 'AGENT_DEREGISTERED',
          }
        );
      }
      return actor;
    }
    if (candidates.length > 1) {
      throw userError(
        'Multiple owned agents are participants in this thread. Select one with `agent use <slug>` or pass --agent <slug>.',
        {
          code: 'AGENT_SLUG_REQUIRED',
        }
      );
    }
  }

  throw userError(
    'Select an active agent with `agent use <slug>` or pass --agent <slug> when sending outside a selected thread.',
    {
      code: 'AGENT_SLUG_REQUIRED',
    }
  );
}

function findDirectThread(
  threads: Thread[],
  actors: Agent[],
  ownActor: Agent,
  otherPublicIdentity: string
): Thread | null {
  return findDirectThreads(threads, actors, ownActor, otherPublicIdentity)[0] ?? null;
}

function findDirectThreads(
  threads: Thread[],
  actors: Agent[],
  ownActor: Agent,
  otherPublicIdentity: string
): Thread[] {
  const otherActorId = findActorIdByPublicIdentity(actors, otherPublicIdentity);
  if (otherActorId === null) {
    return [];
  }
  return findDirectThreadsByIds(threads, ownActor.id, otherActorId).sort((left, right) =>
    compareBigIntDesc(
      left.lastMessageAt.microsSinceUnixEpoch,
      right.lastMessageAt.microsSinceUnixEpoch
    )
  );
}

function requireDirectThreadById(params: {
  threads: Thread[];
  actors: Agent[];
  ownActor: Agent;
  otherPublicIdentity: string;
  threadId: bigint;
  targetSlug: string;
}): Thread {
  const thread = params.threads.find(row => row.id === params.threadId);
  if (!thread) {
    throw userError(`Direct thread ${params.threadId.toString()} is not visible.`, {
      code: 'DIRECT_THREAD_NOT_FOUND',
    });
  }

  if (thread.kind.tag !== 'Direct') {
    throw userError(`Thread ${params.threadId.toString()} is not a direct thread.`, {
      code: 'DIRECT_THREAD_INVALID_KIND',
    });
  }

  const otherActorId = findActorIdByPublicIdentity(params.actors, params.otherPublicIdentity);
  if (otherActorId === null || !isDirectThreadBetween(thread, params.ownActor.id, otherActorId)) {
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
  participants: VisibleThreadParticipant[],
  threadId: bigint,
  actorId: bigint
): VisibleThreadParticipant | null {
  return (
    participants.find(participant => participant.threadId === threadId && participant.agentDbId === actorId) ??
    null
  );
}

type SenderSecretVersionState = {
  membershipVersion: bigint;
  secretVersion: number;
};

// Two callers (send-message.ts:837 / :1567) intentionally pass `undefined` for
// `latestSenderMessage` because `participant.lastSentSecretVersion` is the post-rework
// source of truth and we don't want to scan the full thread history just to recompute it.
// Don't introduce a real `Message` here without re-validating the rotation invariant
// (`senderSecretRotationRequired` consumes the result).
function resolveSenderState(
  thread: Thread,
  latestSenderMessage: Message | undefined,
  senderParticipant: VisibleThreadParticipant | null
): SenderSecretVersionState | undefined {
  if (latestSenderMessage) {
    return {
      membershipVersion: latestSenderMessage.membershipVersion,
      secretVersion: latestSenderMessage.secretVersion,
    };
  }
  const lastSentSecretVersion = senderParticipant?.lastSentSecretVersion ?? 0;
  if (lastSentSecretVersion > 0) {
    return {
      // The new schema dropped `lastSentMembershipVersion`; pair the cached
      // last-sent secret with the thread's current membership version.
      membershipVersion: thread.membershipVersion,
      secretVersion: lastSentSecretVersion,
    };
  }
  return undefined;
}

function senderSecretRotationRequired(params: {
  senderActor: Agent;
  thread: Thread;
  latestSenderState: SenderSecretVersionState | undefined;
  participants: VisibleThreadParticipant[];
  actors: Agent[];
  envelopes: VisibleThreadSecretEnvelopeRow[];
}): boolean {
  const {
    senderActor,
    thread,
    latestSenderState,
    participants,
    actors,
    envelopes,
  } = params;
  if (!latestSenderState) {
    return false;
  }
  if (latestSenderState.membershipVersion !== thread.membershipVersion) {
    return true;
  }

  const actorsById = new Map(actors.map(actor => [actor.id, actor] as const));
  const expectedRecipients = new Map<bigint, Agent>();
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
      envelope.membershipVersion === latestSenderState.membershipVersion &&
      envelope.senderAgentDbId === senderActor.id &&
      envelope.secretVersion === latestSenderState.secretVersion
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

    if (envelope.senderEncryptionKeyVersion !== senderActor.currentKeyBundleVersion) {
      return true;
    }
    if (envelope.signingKeyVersion !== senderActor.currentKeyBundleVersion) {
      return true;
    }
    if (envelope.recipientEncryptionKeyVersion !== recipient.currentKeyBundleVersion) {
      return true;
    }
  }

  return false;
}

function requireVisibleThread(threads: Thread[], threadId: bigint): Thread {
  const thread = threads.find(row => row.id === threadId) ?? null;
  if (!thread) {
    throw userError(`Thread ${threadId.toString()} is not visible.`, {
      code: 'THREAD_NOT_FOUND',
    });
  }
  return thread;
}

async function waitForDirectThread(params: {
  read: () => Promise<MessageSnapshot>;
  ownActor: Agent;
  otherPublicIdentity: string;
  existingThreadIds?: Set<string>;
  timeoutMs?: number;
}): Promise<Thread> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const snapshot = await params.read();
    const matches = findDirectThreads(
      snapshot.threads,
      snapshot.actors,
      params.ownActor,
      params.otherPublicIdentity
    );
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

async function sendMessageToThreadCore(
  params: SendMessageToThreadCoreParams
): Promise<SendMessageToThreadResult> {
  const {
    profile,
    email,
    conn,
    snapshot,
    requestedThreadId,
    actorSlug,
    message,
    contentType,
    headerLines,
    reporter,
  } = params;
  const ownActor = requireOwnedActor({
    actors: snapshot.actors,
    participants: snapshot.participants,
    email,
    actorSlug,
    threadId: requestedThreadId,
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
    conn,
    ownActor,
  });

  const payload = buildEncryptedPayload({
    message,
    contentType,
    headerLines,
  });
  const recipientActors = snapshot.participants
    .filter(participant => participant.threadId === requestedThreadId && participant.active)
    .map(participant => snapshot.actors.find(actor => actor.id === participant.agentDbId))
    .filter((actor): actor is Agent => Boolean(actor));
  if (recipientActors.length === 0) {
    throw connectivityError('No active participants are visible for this thread.', {
      code: 'THREAD_PARTICIPANTS_NOT_VISIBLE',
    });
  }
  const recipients = await Promise.all(
    recipientActors.map(actor => resolveActorPublicKeys(conn, actor))
  );
  const recipientKeysByActorId = new Map(
    recipients
      .filter((recipient): recipient is ActorPublicKeys & { actorId: bigint } =>
        recipient.actorId !== undefined
      )
      .map(recipient => [recipient.actorId, recipient] as const)
  );
  const ownActorIdsForReply = buildOwnActorIds(snapshot.actors, ownActor.accountId);
  for (const recipient of recipientActors) {
    if (recipient.id === ownActor.id) continue;
    const recipientKeys = recipientKeysByActorId.get(recipient.id);
    if (!recipientKeys) {
      throw connectivityError(`Public keys for ${recipient.slug} are unavailable.`, {
        code: 'AGENT_PUBLIC_KEYS_UNAVAILABLE',
      });
    }
    await requirePeerKeyTrust({
      publicIdentity: recipient.publicIdentity,
      displayLabel: recipient.slug,
      observed: tupleFromActorPublicKeys(recipientKeys),
      allowFirstContactTrust: ownActorIdsForReply.has(recipient.id),
    });
  }

  // resolveSenderState falls back to the participant's cached
  // lastSentSecretVersion, so no per-thread message scan is needed here.
  const latestSenderState = resolveSenderState(thread, undefined, senderParticipant);

  // Envelopes for the rotation check are fetched on-demand via the indexed
  // procedure rather than read from a global subscription. Empty when the
  // sender has not yet published a secret in this thread.
  const envelopesForRotation = latestSenderState
    ? await runSendSpacetimeOperation('thread secret envelope lookup', () =>
        conn.procedures.listThreadSecretEnvelopes({
          agentDbId: ownActor.id,
          threadId: requestedThreadId,
          membershipVersion: latestSenderState.membershipVersion,
          senderAgentDbId: ownActor.id,
          recipientAgentDbId: undefined,
          secretVersion: latestSenderState.secretVersion,
          afterId: undefined,
          limit: undefined,
        })
      )
    : [];
  const requiresSecretRotation = senderSecretRotationRequired({
    senderActor: ownActor,
    thread,
    latestSenderState,
    participants: snapshot.participants,
    actors: snapshot.actors,
    envelopes: envelopesForRotation,
  });
  const existingSecret = await resolveExistingSenderSecret({
    conn,
    threadId: requestedThreadId,
    ownActor,
    keyPair,
    latestSenderState,
    envelopes: envelopesForRotation,
    requiresSecretRotation,
  });

  const senderMessageId = randomSenderMessageId();
  reporter.verbose?.(`Encrypting message for thread ${requestedThreadId.toString()}`);
  const prepared = await prepareEncryptedMessage({
    threadId: requestedThreadId,
    senderActorId: ownActor.id,
    senderPublicIdentity: ownActor.publicIdentity,
    senderMessageId,
    payload,
    keyPair,
    recipients,
    existingSecret,
    latestKnownSecretVersion: latestSenderState?.secretVersion ?? null,
    rotateSecret: requiresSecretRotation,
  });

  reporter.verbose?.(`Sending encrypted message to thread ${requestedThreadId.toString()}`);
  await submitSendEncryptedMessageReducer({
    label: 'send encrypted message reducer',
    reporter,
    run: () =>
      conn.reducers.sendEncryptedMessage({
        agentDbId: ownActor.id,
        threadId: requestedThreadId,
        secretVersion: prepared.secretVersion,
        signingKeyVersion: prepared.signingKeyVersion,
        senderMessageId,
        ciphertext: fromHex(prepared.ciphertext),
        iv: fromHex(prepared.iv),
        cipherAlgorithm: toCipherAlgorithm(prepared.cipherAlgorithm),
        signature: fromHex(prepared.signature),
        replyToMessageId: undefined,
        attachedSecretEnvelopes: toReducerEnvelopes(prepared.attachedSecretEnvelopes),
      }),
  });

  cacheSenderSecret(
    requestedThreadId,
    ownActor.publicIdentity,
    prepared.senderSecret.secretVersion,
    prepared.senderSecret.secretHex
  );

  // The reducer's success is the source of truth — no need to poll
  // listThreadMessages back to confirm the row landed.
  const activeParticipantsByThreadId = buildParticipantsByThreadId(
    snapshot.participants.filter(participant => participant.active)
  );
  const actorsById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));
  const ownActorIds = buildOwnActorIds(snapshot.actors, ownActor.accountId);
  const label = summarizeThread(
    thread,
    activeParticipantsByThreadId.get(thread.id) ?? [],
    actorsById,
    ownActorIds
  );

  reporter.success(`Encrypted message sent to thread ${requestedThreadId.toString()}`);

  return {
    sent: true,
    profile: profile.name,
    actorSlug: ownActor.slug,
    threadId: requestedThreadId.toString(),
    threadKind: thread.kind.tag === 'Direct' ? 'direct' : 'group',
    label,
    messageId: `sent:${requestedThreadId.toString()}:${senderMessageId.toString()}`,
    senderMessageId: senderMessageId.toString(),
  };
}

async function readThreadSendSnapshot(params: {
  conn: DbConnection;
  email: string;
  actorSlug?: string;
  threadId: bigint;
}): Promise<MessageSnapshot> {
  const explicitActor = params.actorSlug
    ? await runSendSpacetimeOperation('owned agent lookup', () =>
        readOwnedAgentRow(params.conn, {
          email: params.email,
          actorSlug: params.actorSlug,
        })
      )
    : null;
  const ownedActors = explicitActor
    ? [explicitActor]
    : await runSendSpacetimeOperation('owned agents lookup', () =>
        readAllOwnedAgents(params.conn)
      );
  const candidateActors = explicitActor
    ? [explicitActor]
    : ownedActors.filter(actor => actor.email === params.email);
  let threadPage: Awaited<ReturnType<DbConnection['procedures']['readVisibleThread']>> | undefined;
  let ownActor: Agent | null = null;
  for (const candidate of candidateActors) {
    const candidatePage = await runSendSpacetimeOperation('visible thread lookup', () =>
      params.conn.procedures.readVisibleThread({
        agentDbId: candidate.id,
        threadId: params.threadId,
      })
    );
    if (candidatePage?.threads.some(row => row.id === params.threadId)) {
      threadPage = candidatePage;
      ownActor = candidate;
      break;
    }
  }
  if (!threadPage) {
    if (params.actorSlug && !explicitActor) {
      const normalizedSlug = normalizeInboxSlug(params.actorSlug);
      throw userError(`No owned inbox actor found for slug \`${normalizedSlug ?? ''}\`.`, {
        code: 'OWNED_ACTOR_NOT_FOUND',
      });
    }
    return {
      actors: explicitActor ? [explicitActor] : [],
      participants: [],
      readStates: [],
      secretEnvelopes: [],
      threads: [],
      contactRequests: [],
      threadInvites: [],
      messages: [],
    };
  }
  ownActor ??= requireOwnedActor({
    actors: mergeRowsById(ownedActors, threadPage.actors),
    participants: threadPage.participantPreviews,
    email: params.email,
    actorSlug: params.actorSlug,
    threadId: params.threadId,
  });
  if (isDeregisteringOrDeregisteredInboxAgentState(ownActor.masumiRegistrationState?.tag)) {
    throw userError(
      `Agent \`${ownActor.slug}\` is deregistering or deregistered and cannot send chats.`,
      {
        code: 'AGENT_DEREGISTERED',
      }
    );
  }
  const thread = threadPage.threads.find(row => row.id === params.threadId);
  const senderParticipant = readStatesFromVisibleThreadPage(threadPage).find(participant => {
    return participant.threadId === params.threadId && participant.agentDbId === ownActor.id;
  });
  const senderLastSentSecretVersion = senderParticipant?.lastSentSecretVersion ?? 0;
  const latestSenderState =
    thread && senderLastSentSecretVersion > 0
      ? {
          // The new schema dropped `lastSentMembershipVersion`; pair the
          // cached secret version with the thread's current membership.
          membershipVersion: thread.membershipVersion,
          secretVersion: senderLastSentSecretVersion,
        }
      : undefined;
  const currentSecretEnvelopes =
    thread && latestSenderState
      ? await runSendSpacetimeOperation('thread secret envelope lookup', () =>
          params.conn.procedures.listThreadSecretEnvelopes({
            agentDbId: ownActor.id,
            threadId: params.threadId,
            membershipVersion: latestSenderState.membershipVersion,
            senderAgentDbId: ownActor.id,
            recipientAgentDbId: undefined,
            secretVersion: latestSenderState.secretVersion,
            afterId: undefined,
            limit: undefined,
          })
        )
      : [];
  const fullParticipants = await runSendSpacetimeOperation('thread participants lookup', () =>
    readAllThreadParticipants(params.conn, params.threadId)
  );

  return {
    actors: mergeRowsById(mergeRowsById([ownActor], threadPage.actors), fullParticipants.actors),
    participants: mergeRowsById<VisibleThreadParticipant>(
      threadPage.participantPreviews,
      fullParticipants.participants
    ),
    readStates: readStatesFromVisibleThreadPage(threadPage),
    secretEnvelopes: currentSecretEnvelopes,
    threads: threadPage.threads,
    contactRequests: [],
    threadInvites: [],
    messages: [],
  };
}

async function waitForContactRequest(params: {
  read: () => Promise<MessageSnapshot>;
  requesterActorId: bigint;
  targetPublicIdentity: string;
  existingRequestIds?: Set<string>;
  timeoutMs?: number;
}): Promise<ContactRequest> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const snapshot = await params.read();
    const request = snapshot.contactRequests.find(row => {
      return (
        row.requesterAgentDbId === params.requesterActorId &&
        row.targetPublicIdentity === params.targetPublicIdentity &&
        row.status.tag === 'Pending' &&
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

async function waitForContactRequestStatus(params: {
  read: () => Promise<MessageSnapshot>;
  requestId: bigint;
  status: ContactRequest['status'];
  timeoutMs?: number;
}): Promise<ContactRequest> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const snapshot = await params.read();
    const request = snapshot.contactRequests.find(row => row.id === params.requestId);
    if (request?.status.tag === params.status.tag) {
      return request;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for contact request status to sync.', {
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
  const actorSlug = await resolvePreferredAgentSlug(params.profileName, params.actorSlug);

  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
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
    params.reporter.verbose?.('Reading latest thread state');
    const read = () =>
      runSendSpacetimeOperation('latest metadata read', () =>
        readLatestMetadataRows(conn, {
          email,
          actorSlug,
        })
      );
    let snapshot = await read();
    if (
      requestedThreadId &&
      !snapshot.threads.some(thread => thread.id === requestedThreadId)
    ) {
      const visibleActor =
        (actorSlug
          ? await runSendSpacetimeOperation('owned agent lookup', () =>
              readOwnedAgentRow(conn, { email, actorSlug })
            )
          : null) ??
        snapshot.actors.find(actor => actor.email === email && actor.isDefault) ??
        snapshot.actors.find(actor => actor.email === email) ??
        null;
      const threadPage = visibleActor
        ? await runSendSpacetimeOperation('visible thread lookup', () =>
            conn.procedures.readVisibleThread({
              agentDbId: visibleActor.id,
              threadId: requestedThreadId,
            })
          )
        : null;
      if (threadPage) {
        const fullParticipants = await runSendSpacetimeOperation(
          'thread participants lookup',
          () => readAllThreadParticipants(conn, requestedThreadId)
        );
        snapshot = {
          ...snapshot,
          actors: mergeRowsById(
            mergeRowsById(snapshot.actors, threadPage.actors),
            fullParticipants.actors
          ),
          participants: mergeRowsById(
            snapshot.participants,
            mergeRowsById<VisibleThreadParticipant>(
              threadPage.participantPreviews,
              fullParticipants.participants
            )
          ),
          readStates: mergeRowsById(snapshot.readStates, readStatesFromVisibleThreadPage(threadPage)),
          threads: mergeRowsById(snapshot.threads, threadPage.threads),
        };
      }
    }
    const ownActor = requireOwnedActor({
      actors: snapshot.actors,
      participants: snapshot.participants,
      email,
      actorSlug,
      threadId: requestedThreadId ?? undefined,
    });
    const keyPair = await requireLocalActorKeyPairForSending({
      profile,
      conn,
      ownActor,
    });

    params.reporter.verbose?.(`Resolving recipient slug or email ${params.to}`);
    const targetLookup = await resolvePublishedActorLookup({
      identifier: params.to,
      lookupBySlug: input =>
        runSendSpacetimeOperation('published agent slug lookup', () =>
          conn.procedures.lookupPublishedAgentBySlug(input)
        ),
      lookupByEmail: input =>
        runSendSpacetimeOperation('published agent email lookup', () =>
          conn.procedures.lookupPublishedAgentsByEmailPage({
            ...input,
            afterId: undefined,
            limit: undefined,
          })
        ),
      invalidMessage: 'Recipient slug or email is invalid.',
      invalidCode: 'INVALID_AGENT_IDENTIFIER',
      notFoundCode: 'ACTOR_NOT_FOUND',
      fallbackMessage: 'No published agent found for that slug or email.',
    });
    const target = targetLookup.selected;
    let networkTarget: Awaited<ReturnType<typeof lookupMasumiInboxAgentBySlug>> = null;
    try {
      networkTarget = await lookupMasumiInboxAgentBySlug({
        issuer: profile.issuer,
        session,
        slug: target.slug,
      });
    } catch (lookupError) {
      // Masumi registry lookup is advisory — failures must not block the
      // send, but they also must not be silent. Surface at info level so
      // operators see the degraded check even without --verbose.
      const detail =
        lookupError instanceof Error ? lookupError.message : String(lookupError);
      params.reporter.info(
        `Masumi registration state for ${target.slug} could not be verified (${detail}); continuing with the published inbox route.`
      );
    }
    if (
      isDeregisteringOrDeregisteredInboxAgentState(networkTarget?.state) ||
      isFailedRegistrationInboxAgentState(networkTarget?.state)
    ) {
      const invalidRegistration = isFailedRegistrationInboxAgentState(networkTarget?.state);
      const reason = invalidRegistration
        ? 'has an invalid Masumi registration'
        : 'is deregistering or deregistered';
      throw userError(
        `Agent \`${target.slug}\` ${reason} and cannot be used for chats.`,
        {
          code: invalidRegistration
            ? 'AGENT_REGISTRATION_INVALID'
            : 'AGENT_DEREGISTERED',
        }
      );
    }

    if (target.publicIdentity === ownActor.publicIdentity) {
      throw userError('Use a different inbox slug or email for a direct thread.', {
        code: 'DIRECT_THREAD_SELF',
      });
    }

    params.reporter.verbose?.(`Loading public route for ${target.slug}`);
    const publishedRoute = (
      await runSendSpacetimeOperation('published public route lookup', () =>
        conn.procedures.lookupPublishedPublicRouteBySlug({
          slug: target.slug,
        })
      )
    )[0];
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
    let pendingRequest: ContactRequest | null =
      snapshot.contactRequests.find(request => {
        return (
          // direction is gone; "outgoing" means our agent is the requester.
          request.requesterAgentDbId === ownActor.id &&
          request.targetPublicIdentity === target.publicIdentity &&
          request.status.tag === 'Pending'
        );
      }) ?? null;
    let thread = requestedThreadId
      ? requireDirectThreadById({
          threads: snapshot.threads,
          actors: snapshot.actors,
          ownActor,
          otherPublicIdentity: target.publicIdentity,
          threadId: requestedThreadId,
          targetSlug: target.slug,
        })
      : findDirectThread(snapshot.threads, snapshot.actors, ownActor, target.publicIdentity);
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
        findDirectThreads(snapshot.threads, snapshot.actors, ownActor, target.publicIdentity).map(
          existingThread => existingThread.id.toString()
        )
      );
      try {
        params.reporter.verbose?.(`Creating direct thread with ${target.slug}`);
        await runSendSpacetimeOperation('create direct thread reducer', () =>
          conn.reducers.createThread({
            agentDbId: ownActor.id,
            kind: { tag: 'Direct' },
            otherAgentPublicIdentity: target.publicIdentity,
            participantPublicIdentities: undefined,
            title: params.title?.trim() ? params.title.trim() : undefined,
          })
        );
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
          const fallbackSnapshot = await read();
          const fallbackThread = findDirectThread(
            fallbackSnapshot.threads,
            fallbackSnapshot.actors,
            ownActor,
            target.publicIdentity
          );
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
        const senderMessageId = randomSenderMessageId();
        params.reporter.verbose?.(`Encrypting atomic first-contact request for ${target.slug}`);
        const prepared = await prepareEncryptedMessage({
          threadId: pendingThreadId,
          senderActorId: ownActor.id,
          senderPublicIdentity: ownActor.publicIdentity,
          senderMessageId,
          payload,
          keyPair,
          recipients: [
            await resolveActorPublicKeys(conn, ownActor),
            toPublishedActorPublicKeys(target),
          ],
          existingSecret: null,
          latestKnownSecretVersion: null,
          rotateSecret: false,
        });
        params.reporter.verbose?.(
          `Creating pending contact request with first message for ${target.slug}`
        );
        await runSendSpacetimeOperation('request direct contact reducer', () =>
          conn.reducers.requestDirectContact({
            agentDbId: ownActor.id,
            otherAgentPublicIdentity: target.publicIdentity,
            threadId: pendingThreadId,
            title: params.title?.trim() ? params.title.trim() : undefined,
            secretVersion: prepared.secretVersion,
            signingKeyVersion: prepared.signingKeyVersion,
            senderMessageId,
            ciphertext: fromHex(prepared.ciphertext),
            iv: fromHex(prepared.iv),
            cipherAlgorithm: toCipherAlgorithm(prepared.cipherAlgorithm),
            signature: fromHex(prepared.signature),
            attachedSecretEnvelopes: toReducerEnvelopes(prepared.attachedSecretEnvelopes),
          })
        );
        pendingRequest = await waitForContactRequest({
          read,
          requesterActorId: ownActor.id,
          targetPublicIdentity: target.publicIdentity,
          existingRequestIds,
        });
        const createdRequest = pendingRequest;

        cacheSenderSecret(
          pendingThreadId,
          ownActor.publicIdentity,
          prepared.senderSecret.secretVersion,
          prepared.senderSecret.secretHex
        );
        params.reporter.success(`Contact request sent to ${target.slug}`);

        const ownActorIds = buildOwnActorIds(snapshot.actors, ownActor.accountId);
        const targetOwnedActor = snapshot.actors.find(
          actor => actor.publicIdentity === target.publicIdentity && ownActorIds.has(actor.id)
        ) ?? null;

        if (targetOwnedActor) {
          params.reporter.verbose?.(`Auto-approving contact request from owned agent ${target.slug}`);
          await runSendSpacetimeOperation('approve contact request reducer', () =>
            conn.reducers.approveContactRequest({
              agentDbId: targetOwnedActor.id,
              requestId: createdRequest.id,
            })
          );
          const approvedRequest = await waitForContactRequestStatus({
            read,
            requestId: createdRequest.id,
            status: { tag: 'Approved' },
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
      throw userError('A pending contact request already exists for this actor pair.', {
        code: 'CONTACT_REQUEST_PENDING',
      });
    }

    if (!thread) {
      throw connectivityError('Direct thread is not visible after creation.', {
        code: 'DIRECT_THREAD_NOT_VISIBLE',
      });
    }

    snapshot = await runSendSpacetimeOperation('thread send snapshot read', () =>
      readThreadSendSnapshot({
        conn,
        email,
        actorSlug,
        threadId: thread.id,
      })
    );
    const senderParticipant = findParticipant(snapshot.participants, thread.id, ownActor.id);
    if (!senderParticipant) {
      throw connectivityError('Current actor is not visible as a participant in the direct thread.', {
        code: 'DIRECT_THREAD_PARTICIPANT_MISSING',
      });
    }

    const recipientActors = snapshot.participants
      .filter(participant => participant.threadId === thread.id && participant.active)
      .map(participant => snapshot.actors.find(actor => actor.id === participant.agentDbId))
      .filter((actor): actor is Agent => Boolean(actor));
    const recipients = await Promise.all(
      recipientActors.map(actor => resolveActorPublicKeys(conn, actor))
    );
    const recipientKeysByActorId = new Map(
      recipients
        .filter((recipient): recipient is ActorPublicKeys & { actorId: bigint } =>
          recipient.actorId !== undefined
        )
        .map(recipient => [recipient.actorId, recipient] as const)
    );
    const ownActorIdsForThread = buildOwnActorIds(snapshot.actors, ownActor.accountId);
    for (const recipient of recipientActors) {
      if (recipient.id === ownActor.id) continue;
      const recipientKeys = recipientKeysByActorId.get(recipient.id);
      if (!recipientKeys) {
        throw connectivityError(`Public keys for ${recipient.slug} are unavailable.`, {
          code: 'AGENT_PUBLIC_KEYS_UNAVAILABLE',
        });
      }
      await requirePeerKeyTrust({
        publicIdentity: recipient.publicIdentity,
        displayLabel: recipient.slug,
        observed: tupleFromActorPublicKeys(recipientKeys),
        allowFirstContactTrust: ownActorIdsForThread.has(recipient.id),
      });
    }

    // resolveSenderState falls back to the participant's cached
    // lastSentSecretVersion, so no snapshot.messages scan is needed here.
    const latestSenderState = resolveSenderState(thread, undefined, senderParticipant);

    const envelopesForRotation = latestSenderState
      ? await runSendSpacetimeOperation('thread secret envelope lookup', () =>
          conn.procedures.listThreadSecretEnvelopes({
            agentDbId: ownActor.id,
            threadId: thread.id,
            membershipVersion: latestSenderState.membershipVersion,
            senderAgentDbId: ownActor.id,
            recipientAgentDbId: undefined,
            secretVersion: latestSenderState.secretVersion,
            afterId: undefined,
            limit: undefined,
          })
        )
      : [];
    const requiresSecretRotation = senderSecretRotationRequired({
      senderActor: ownActor,
      thread,
      latestSenderState,
      participants: snapshot.participants,
      actors: snapshot.actors,
      envelopes: envelopesForRotation,
    });
    const existingSecret = await resolveExistingSenderSecret({
      conn,
      threadId: thread.id,
      ownActor,
      keyPair,
      latestSenderState,
      envelopes: envelopesForRotation,
      requiresSecretRotation,
    });

    const senderMessageId = randomSenderMessageId();

    params.reporter.verbose?.(`Encrypting message for ${target.slug}`);
    const prepared = await prepareEncryptedMessage({
      threadId: thread.id,
      senderActorId: ownActor.id,
      senderPublicIdentity: ownActor.publicIdentity,
      senderMessageId,
      payload,
      keyPair,
      recipients,
      existingSecret,
      latestKnownSecretVersion: latestSenderState?.secretVersion ?? null,
      rotateSecret: requiresSecretRotation,
    });

    params.reporter.verbose?.(`Sending encrypted message to ${target.slug}`);
    await submitSendEncryptedMessageReducer({
      label: 'send encrypted message reducer',
      reporter: params.reporter,
      run: () =>
        conn.reducers.sendEncryptedMessage({
          agentDbId: ownActor.id,
          threadId: thread.id,
          secretVersion: prepared.secretVersion,
          signingKeyVersion: prepared.signingKeyVersion,
          senderMessageId,
          ciphertext: fromHex(prepared.ciphertext),
          iv: fromHex(prepared.iv),
          cipherAlgorithm: toCipherAlgorithm(prepared.cipherAlgorithm),
          signature: fromHex(prepared.signature),
          replyToMessageId: undefined,
          attachedSecretEnvelopes: toReducerEnvelopes(prepared.attachedSecretEnvelopes),
        }),
    });

    cacheSenderSecret(
      thread.id,
      ownActor.publicIdentity,
      prepared.senderSecret.secretVersion,
      prepared.senderSecret.secretHex
    );

    // Reducer success is authoritative; no post-send poll needed.
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
      messageId: `sent:${thread.id.toString()}:${senderMessageId.toString()}`,
      senderMessageId: senderMessageId.toString(),
      createdDirectThread,
      targetLookup: {
        input: targetLookup.input,
        inputKind: targetLookup.inputKind,
        matchedActors: targetLookup.matchedActors,
        selected: targetLookup.selectedActor,
      },
    };
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
  const actorSlug = await resolvePreferredAgentSlug(params.profileName, params.actorSlug);

  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
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
    params.reporter.verbose?.('Reading latest thread state');
    const snapshot = await runSendSpacetimeOperation('thread send snapshot read', () =>
      readThreadSendSnapshot({
        conn,
        email,
        actorSlug,
        threadId: requestedThreadId,
      })
    );
    return await sendMessageToThreadCore({
      profile,
      email,
      conn,
      snapshot,
      requestedThreadId,
      actorSlug,
      message: params.message,
      contentType: params.contentType,
      headerLines: params.headerLines,
      reporter: params.reporter,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function sendMessageToThreadFromLiveSnapshot(params: {
  profileName: string;
  actorSlug?: string;
  auth?: AuthSessionContext;
  conn: DbConnection;
  snapshot: MessageSnapshot;
  threadId: string;
  message: string;
  contentType?: string;
  headerLines: string[];
  reporter: TaskReporter;
}): Promise<SendMessageToThreadResult> {
  const requestedThreadId = parseRequestedThreadId(params.threadId);
  if (!requestedThreadId) {
    throw userError('Thread id is required.', {
      code: 'INVALID_THREAD_ID',
    });
  }

  const { profile, claims } = params.auth ?? (await ensureAuthenticatedSession(params));
  const actorSlug = await resolvePreferredAgentSlug(params.profileName, params.actorSlug);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  return await sendMessageToThreadCore({
    profile,
    email,
    conn: params.conn,
    snapshot: params.snapshot,
    requestedThreadId,
    actorSlug,
    message: params.message,
    contentType: params.contentType,
    headerLines: params.headerLines,
    reporter: params.reporter,
  });
}
