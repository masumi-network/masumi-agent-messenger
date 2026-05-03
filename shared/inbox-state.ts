import {
  compareTimestampsDesc,
  timestampToISOString,
  timestampToLocaleString,
  type TimestampLike,
} from './spacetime-time';

export type ActorLike = {
  id: bigint;
  accountId: bigint;
  email: string;
  slug: string;
  isDefault: boolean;
  publicIdentity: string;
  displayName?: string | null;
};

export type ThreadKindLike = string | { tag: string };

export type ThreadLike = {
  id: bigint;
  kind: ThreadKindLike;
  /** Sorted pair of agent db ids for direct threads; both `0n` for group threads. */
  directLowAgentDbId: bigint;
  directHighAgentDbId: bigint;
  title?: string | null;
  lastMessageAt: TimestampLike;
};

export function sortDirectAgentPair(a: bigint, b: bigint): { low: bigint; high: bigint } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

export type ThreadParticipantLike = {
  id?: bigint;
  threadId: bigint;
  agentDbId: bigint;
  active?: boolean;
  lastReadMessageId?: bigint | null;
  archived?: boolean;
};

function isDirectThreadKind(kind: ThreadKindLike): boolean {
  if (typeof kind === 'string') {
    return kind === 'direct' || kind === 'Direct';
  }
  return kind.tag === 'Direct';
}

export type MessageLike = {
  id: bigint;
  threadId: bigint;
  senderAgentDbId: bigint;
  createdAt: TimestampLike;
};

export type DirectInboxEntry<Actor extends ActorLike> = {
  actor: Actor;
  threadCount: number;
  newMessages: number;
  latestMessageAt: string | null;
  latestMessageAtMicros: bigint | null;
  latestThreadId: bigint | null;
};

export type PublicIdentityLike = {
  publicIdentity: string;
};

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const DIRECT_THREAD_ID_NAMESPACE = 0x8000000000000000n;
const DIRECT_THREAD_ID_MASK = 0x7fffffffffffffffn;

export type UnreadIncomingSelection<Actor extends ActorLike, Message extends MessageLike> = {
  defaultActor: Actor;
  ownActorIds: Set<bigint>;
  unreadMessages: Message[];
};

export function buildParticipantsByThreadId<Participant extends ThreadParticipantLike>(
  participants: Participant[]
): Map<bigint, Participant[]> {
  const participantsByThreadId = new Map<bigint, Participant[]>();
  for (const participant of participants) {
    const list = participantsByThreadId.get(participant.threadId) ?? [];
    list.push(participant);
    participantsByThreadId.set(participant.threadId, list);
  }
  return participantsByThreadId;
}

export function findDefaultActorByEmail<Actor extends ActorLike>(
  actors: Actor[],
  email: string
): Actor | null {
  return (
    actors.find(actor => actor.email === email && actor.isDefault) ?? null
  );
}

export function buildOwnActorIds<Actor extends ActorLike>(
  actors: Actor[],
  accountId: bigint
): Set<bigint> {
  return new Set(
    actors.filter(actor => actor.accountId === accountId).map(actor => actor.id)
  );
}

export function findActorIdByPublicIdentity<Actor extends ActorLike>(
  actors: Actor[],
  publicIdentity: string
): bigint | null {
  return actors.find(actor => actor.publicIdentity === publicIdentity)?.id ?? null;
}


export function buildDirectThreadKey(
  left: PublicIdentityLike,
  right: PublicIdentityLike
): string {
  const values = [left.publicIdentity, right.publicIdentity].sort();
  return `direct:${values[0]}:${values[1]}`;
}

export function buildDeterministicDirectThreadId(
  left: PublicIdentityLike,
  right: PublicIdentityLike
): bigint {
  let hash = FNV_OFFSET_BASIS_64;
  for (const codePoint of buildDirectThreadKey(left, right)) {
    hash ^= BigInt(codePoint.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
  }

  return (hash & DIRECT_THREAD_ID_MASK) | DIRECT_THREAD_ID_NAMESPACE;
}

export function generateClientThreadId(): bigint {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random values are required to create a thread id');
  }

  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return (value & DIRECT_THREAD_ID_MASK) | DIRECT_THREAD_ID_NAMESPACE;
}

export function isClientGeneratedThreadId(threadId: bigint): boolean {
  return (threadId & DIRECT_THREAD_ID_NAMESPACE) === DIRECT_THREAD_ID_NAMESPACE;
}

export function findDirectThreads<Thread extends ThreadLike>(
  threads: Thread[],
  ownActorId: bigint,
  otherActorId: bigint
): Thread[] {
  const { low, high } = sortDirectAgentPair(ownActorId, otherActorId);
  return threads
    .filter(
      thread =>
        isDirectThreadKind(thread.kind) &&
        thread.directLowAgentDbId === low &&
        thread.directHighAgentDbId === high
    )
    .sort(
      (left, right) =>
        Number(right.lastMessageAt.microsSinceUnixEpoch - left.lastMessageAt.microsSinceUnixEpoch) ||
        Number(right.id - left.id)
    );
}

export function isDirectThreadBetween<Thread extends ThreadLike>(
  thread: Thread,
  ownActorId: bigint,
  otherActorId: bigint
): boolean {
  if (!isDirectThreadKind(thread.kind)) return false;
  const { low, high } = sortDirectAgentPair(ownActorId, otherActorId);
  return thread.directLowAgentDbId === low && thread.directHighAgentDbId === high;
}

export function summarizeThread<Actor extends ActorLike, Thread extends ThreadLike, Participant extends ThreadParticipantLike>(
  thread: Thread,
  participants: Participant[],
  actorById: Map<bigint, Actor>,
  ownActorIds?: Set<bigint>
): string {
  if (thread.title?.trim()) {
    return thread.title;
  }

  const names = participants
    .filter(participant => !ownActorIds || !ownActorIds.has(participant.agentDbId))
    .map(participant => actorById.get(participant.agentDbId))
    .filter((actor): actor is Actor => Boolean(actor))
    .map(actor => actor.displayName?.trim() || actor.slug);

  return names.join(', ') || `Thread ${thread.id.toString()}`;
}

export function resolveDirectCounterparty<
  Actor extends ActorLike,
  Thread extends ThreadLike,
  Participant extends ThreadParticipantLike,
>(
  params: {
    thread: Thread;
    participantsByThreadId: Map<bigint, Participant[]>;
    actorsById: Map<bigint, Actor>;
    ownActorIds: Set<bigint>;
  }
): Actor | null {
  if (!isDirectThreadKind(params.thread.kind)) {
    return null;
  }

  return (
    (params.participantsByThreadId.get(params.thread.id) ?? [])
      .filter(participant => !params.ownActorIds.has(participant.agentDbId))
      .map(participant => params.actorsById.get(participant.agentDbId))
      .filter((actor): actor is Actor => Boolean(actor))
      .sort((left, right) => {
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }
        return left.slug.localeCompare(right.slug);
      })[0] ?? null
  );
}

export function selectUnreadIncomingMessages<
  Actor extends ActorLike,
  Participant extends ThreadParticipantLike,
  Message extends MessageLike,
>(
  params: {
    actors: Actor[];
    participants: Participant[];
    messages: Message[];
    email: string;
  }
): UnreadIncomingSelection<Actor, Message> | null {
  const defaultActor = findDefaultActorByEmail(params.actors, params.email);
  if (!defaultActor) {
    return null;
  }

  const ownActorIds = buildOwnActorIds(params.actors, defaultActor.accountId);
  const archivedThreadIds = new Set(
    params.participants
      .filter(participant => participant.agentDbId === defaultActor.id && participant.archived)
      .map(participant => participant.threadId)
  );

  const lastReadByThreadId = new Map<bigint, bigint>();
  for (const participant of params.participants) {
    if (
      participant.agentDbId !== defaultActor.id ||
      participant.active === false ||
      participant.archived
    ) {
      continue;
    }
    lastReadByThreadId.set(participant.threadId, participant.lastReadMessageId ?? 0n);
  }

  const unreadMessages = params.messages
    .filter(message => !archivedThreadIds.has(message.threadId))
    .filter(message => !ownActorIds.has(message.senderAgentDbId))
    .filter(message => message.id > (lastReadByThreadId.get(message.threadId) ?? 0n))
    .sort((left, right) => {
      const byTime = compareTimestampsDesc(left.createdAt, right.createdAt);
      if (byTime !== 0) {
        return byTime;
      }
      return Number((right.id ?? 0n) - (left.id ?? 0n));
    });

  return {
    defaultActor,
    ownActorIds,
    unreadMessages,
  };
}

export function buildUnreadCountByThreadId<Message extends MessageLike>(
  messages: Message[]
): Map<bigint, number> {
  const counts = new Map<bigint, number>();
  for (const message of messages) {
    counts.set(message.threadId, (counts.get(message.threadId) ?? 0) + 1);
  }
  return counts;
}

export function buildDirectInboxEntries<
  Actor extends ActorLike,
  Thread extends ThreadLike,
  Participant extends ThreadParticipantLike,
  Message extends MessageLike,
>(
  params: {
    actors: Actor[];
    threads: Thread[];
    participants: Participant[];
    messages: Message[];
    ownAccountId: bigint | null;
    dateFormat?: 'iso' | 'locale';
  }
): DirectInboxEntry<Actor>[] {
  if (params.ownAccountId === null) {
    return [];
  }

  const ownActorIds = buildOwnActorIds(params.actors, params.ownAccountId);
  const actorsById = new Map(params.actors.map(actor => [actor.id, actor] as const));
  const participantsByThreadId = buildParticipantsByThreadId(params.participants);
  const unreadCountByThreadId = new Map<bigint, number>();

  for (const thread of params.threads) {
    const ownParticipants = (participantsByThreadId.get(thread.id) ?? []).filter(participant =>
      ownActorIds.has(participant.agentDbId)
    );
    if (ownParticipants.length === 0) {
      continue;
    }

    const activeOwnParticipants = ownParticipants.filter(participant => {
      return participant.active !== false && !participant.archived;
    });
    if (activeOwnParticipants.length === 0) {
      unreadCountByThreadId.set(thread.id, 0);
      continue;
    }
    const lastReadMessageId = activeOwnParticipants.reduce((max, participant) => {
      const current = participant.lastReadMessageId ?? 0n;
      return current > max ? current : max;
    }, 0n);
    const unreadCount = params.messages.filter(
      message =>
        message.threadId === thread.id &&
        !ownActorIds.has(message.senderAgentDbId) &&
        message.id > lastReadMessageId
    ).length;
    unreadCountByThreadId.set(thread.id, unreadCount);
  }

  const grouped = new Map<bigint, DirectInboxEntry<Actor>>();
  for (const thread of params.threads.filter(thread => isDirectThreadKind(thread.kind))) {
    const counterparty = resolveDirectCounterparty({
      thread,
      participantsByThreadId,
      actorsById,
      ownActorIds,
    });
    if (!counterparty) {
      continue;
    }

    const formattedTime =
      params.dateFormat === 'iso'
        ? timestampToISOString(thread.lastMessageAt)
        : timestampToLocaleString(thread.lastMessageAt);

    const existing = grouped.get(counterparty.id);
    if (!existing) {
      grouped.set(counterparty.id, {
        actor: counterparty,
        threadCount: 1,
        newMessages: unreadCountByThreadId.get(thread.id) ?? 0,
        latestMessageAt: formattedTime,
        latestMessageAtMicros: thread.lastMessageAt.microsSinceUnixEpoch,
        latestThreadId: thread.id,
      });
      continue;
    }

    existing.threadCount += 1;
    existing.newMessages += unreadCountByThreadId.get(thread.id) ?? 0;
    if (
      existing.latestMessageAtMicros === null ||
      thread.lastMessageAt.microsSinceUnixEpoch > existing.latestMessageAtMicros ||
      (thread.lastMessageAt.microsSinceUnixEpoch === existing.latestMessageAtMicros &&
        (existing.latestThreadId === null || thread.id > existing.latestThreadId))
    ) {
      existing.latestMessageAtMicros = thread.lastMessageAt.microsSinceUnixEpoch;
      existing.latestMessageAt = formattedTime;
      existing.latestThreadId = thread.id;
    }
  }

  return [...grouped.values()].sort((left, right) => {
    if (left.latestMessageAtMicros !== null && right.latestMessageAtMicros !== null) {
      if (left.latestMessageAtMicros > right.latestMessageAtMicros) return -1;
      if (left.latestMessageAtMicros < right.latestMessageAtMicros) return 1;
    } else if (left.latestMessageAtMicros !== null) {
      return -1;
    } else if (right.latestMessageAtMicros !== null) {
      return 1;
    }

    return left.actor.slug.localeCompare(right.actor.slug);
  });
}
