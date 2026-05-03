import type { DbConnection } from '@/module_bindings';
import type {
  Agent,
  ChannelJoinRequest,
  ContactAllowlistEntry,
  ContactRequest,
  Device,
  ThreadInvite,
  ThreadParticipantPreview,
} from '@/module_bindings/types';

const OWNED_AGENT_PAGE_SIZE = 250;
const OWNED_DEVICE_PAGE_SIZE = 100;
const CONTACT_ALLOWLIST_PAGE_SIZE = 250;
const PENDING_CONTACT_REQUEST_PAGE_SIZE = 250;
const PENDING_THREAD_INVITE_PAGE_SIZE = 250;
const PENDING_CHANNEL_JOIN_REQUEST_PAGE_SIZE = 25;

export async function readAllOwnedAgents(conn: DbConnection): Promise<Agent[]> {
  const rows: Agent[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listOwnedAgentsPage({
      afterId,
      limit: OWNED_AGENT_PAGE_SIZE,
    });
    rows.push(...page.agents);
    if (!page.nextAfterId) {
      return rows;
    }
    afterId = page.nextAfterId;
  }
}

export async function readAllOwnedDevices(conn: DbConnection): Promise<Device[]> {
  const rows: Device[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listOwnedDevices({
      afterId,
      limit: OWNED_DEVICE_PAGE_SIZE,
    });
    rows.push(...page);
    if (page.length < OWNED_DEVICE_PAGE_SIZE) {
      return rows;
    }
    afterId = page.at(-1)?.id;
    if (afterId === undefined) {
      return rows;
    }
  }
}

export async function readAllContactAllowlistEntries(
  conn: DbConnection
): Promise<ContactAllowlistEntry[]> {
  const rows: ContactAllowlistEntry[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listContactAllowlistEntries({
      afterId,
      limit: CONTACT_ALLOWLIST_PAGE_SIZE,
    });
    rows.push(...page);
    if (page.length < CONTACT_ALLOWLIST_PAGE_SIZE) {
      return rows;
    }
    afterId = page.at(-1)?.id;
    if (afterId === undefined) {
      return rows;
    }
  }
}

export async function readPendingContactRequests(
  conn: DbConnection
): Promise<ContactRequest[]> {
  const rows: ContactRequest[] = [];
  let afterSortKey: string | undefined;
  for (;;) {
    const page = await conn.procedures.listPendingContactRequestsPage({
      afterSortKey,
      limit: PENDING_CONTACT_REQUEST_PAGE_SIZE,
    });
    rows.push(...page.contactRequests);
    if (!page.nextAfterSortKey) {
      return rows;
    }
    afterSortKey = page.nextAfterSortKey;
  }
}

export async function readPendingThreadInvites(
  conn: DbConnection
): Promise<ThreadInvite[]> {
  const rows: ThreadInvite[] = [];
  let afterSortKey: string | undefined;
  for (;;) {
    const page = await conn.procedures.listPendingThreadInvitesPage({
      afterSortKey,
      limit: PENDING_THREAD_INVITE_PAGE_SIZE,
    });
    rows.push(...page.threadInvites);
    if (!page.nextAfterSortKey) {
      return rows;
    }
    afterSortKey = page.nextAfterSortKey;
  }
}

export async function readPendingChannelJoinRequests(
  conn: DbConnection
): Promise<ChannelJoinRequest[]> {
  const rows: ChannelJoinRequest[] = [];
  let afterSortKey: string | undefined;
  for (;;) {
    const page = await conn.procedures.listPendingChannelJoinRequestsPage({
      afterSortKey,
      limit: PENDING_CHANNEL_JOIN_REQUEST_PAGE_SIZE,
    });
    rows.push(...page.joinRequests);
    if (!page.nextAfterSortKey) {
      return rows;
    }
    afterSortKey = page.nextAfterSortKey;
  }
}

export async function readAllThreadParticipants(
  conn: DbConnection,
  threadId: bigint
): Promise<{ actors: Agent[]; participants: ThreadParticipantPreview[] }> {
  const actors: Agent[] = [];
  const participants: ThreadParticipantPreview[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listThreadParticipants({
      threadId,
      afterId,
      limit: 50,
    });
    actors.push(...page.actors);
    participants.push(...page.participants);
    if (!page.nextAfterId) {
      return { actors, participants };
    }
    afterId = page.nextAfterId;
  }
}
