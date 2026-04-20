import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskBanner } from './task-screen';
import type { GlobalOptions, TaskReporter } from '../services/command-runtime';
import {
  authStatus,
  ensureAuthenticatedSession,
  login,
  logout,
  removeLocalKeys,
  requestVerificationEmailForIssuer,
  type AuthSessionContext,
} from '../services/auth';
import {
  buildRootShellViewModel,
  type InboxSectionKey,
  type RootShellConnectionHealth,
  type RootShellViewModel,
  type ShellSecurityState,
} from '../services/root-shell-model';
import {
  connectAuthenticated,
  disconnectConnection,
  readShellRows,
  subscribeShellTables,
  type ShellRows,
} from '../services/spacetimedb';
import { formatRelativeTime } from '../services/format';
import { toCliError } from '../services/errors';
import {
  createInboxIdentity,
  registerInboxAgent,
  rotateInboxKeys,
} from '../services/inbox-management';
import {
  addThreadParticipant,
  createGroupThread,
  markThreadRead,
  removeThreadParticipant,
  setThreadArchived,
} from '../services/thread';
import { sendMessageToThread, sendMessageToSlug } from '../services/send-message';
import {
  resolveContactRequest,
  setPublicDescription,
  setPublicLinkedEmailVisibility,
} from '../services/contact-management';
import {
  approveDeviceShare,
  claimDeviceShare,
  requestDeviceShare,
  revokeDeviceShareAccess,
} from '../services/device';
import {
  discoverAgents,
  showDiscoveredAgent,
  type DiscoverSearchItem,
  type DiscoverSearchResult,
  type DiscoverShowResult,
} from '../services/discover';
import { lookupInboxes, type InboxLookupResult } from '../services/inbox-lookup';
import {
  backupInboxKeys,
  defaultBackupFilePath,
  restoreInboxKeys,
} from '../services/key-backup';
import { createSecretStore } from '../services/secret-store';
import { getStoredActorKeyPair } from '../services/actor-keys';
import { decryptVisibleMessage } from '../services/messages';
import { findDefaultActorByEmail } from '../../../shared/inbox-state';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import type { VisibleAgentRow, VisibleMessageRow } from '../../../webapp/src/module_bindings/types';

type ShellRoute =
  | { type: 'auth' }
  | { type: 'inboxes' }
  | { type: 'agents' }
  | { type: 'discover' }
  | { type: 'account' }
  | { type: 'help' };

type ShellThreadFilter = 'all' | 'unread' | 'direct';
type InboxFocus = 'navigator' | 'detail' | 'composer';
type AccountFocus = 'security' | 'devices';
type AgentsFocus = 'owned' | 'discover';
type ShellFocus = 'sidebar' | 'content';

const SIDEBAR_NAV_ITEMS = ['inboxes', 'agents', 'discover', 'account'] as const;
type SidebarNavItem = (typeof SIDEBAR_NAV_ITEMS)[number];

function toSidebarSelectionIndex(routeType: ShellRoute['type'] | undefined): number {
  if (!routeType) {
    return 0;
  }
  const index = SIDEBAR_NAV_ITEMS.indexOf(routeType as SidebarNavItem);
  return index >= 0 ? index : 0;
}

export type RootShellSnapshot = {
  route: ShellRoute;
  activeInboxSlug?: string | null;
  inboxSection: InboxSectionKey;
  threadFilter: ShellThreadFilter;
  selectedInboxItemId?: string | null;
  selectedAgentSlug?: string | null;
  agentsFocus: AgentsFocus;
  accountFocus: AccountFocus;
  shellFocus: ShellFocus;
};

type RootShellTaskState = {
  busy: boolean;
  active: string | null;
  logs: string[];
  banner: TaskBanner | null;
  error: string | null;
  notice: string | null;
};

type TaskPanelField = {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  allowEmpty?: boolean;
  lookup?: {
    mode: 'inbox_lookup' | 'saas_agent';
    tokenMode?: 'single' | 'comma_list';
  };
  validate?: (value: string, values: Record<string, string>) => string | null;
};

type TaskPanelState = {
  title: string;
  help: string;
  submitLabel: string;
  fields: TaskPanelField[];
  stepIndex: number;
  onCancel?: () => Promise<void> | void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
};

type LookupSuggestionItem = {
  id: string;
  value: string;
  label: string;
  detail: string;
  source: 'contact' | 'saas';
};

type TaskLookupState = {
  fieldKey: string | null;
  query: string;
  loading: boolean;
  items: LookupSuggestionItem[];
  error: string | null;
};

type AgentDiscoveryState = {
  query: string;
  mode: 'browse' | 'search';
  page: number;
  take: number;
  hasNextPage: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  results: DiscoverSearchItem[];
};

type DiscoverDetailState =
  | {
      status: 'idle';
      slug: string | null;
      detail: null;
      error: null;
    }
  | {
      status: 'loading';
      slug: string;
      detail: null;
      error: null;
    }
  | {
      status: 'ready';
      slug: string;
      detail: DiscoverShowResult;
      error: null;
    }
  | {
      status: 'error';
      slug: string;
      detail: null;
      error: string;
    };

type PendingRegistrationPrompt = {
  slug: string;
  publicDescription?: string | null;
};

type ShellConnectionState =
  | {
      mode: 'loading';
      connection: 'connecting' | 'reconnecting';
      error: string | null;
    }
  | {
      mode: 'signed_out';
      connection: 'signed_out';
      error: string | null;
    }
  | {
      mode: 'ready';
      connection: 'live' | 'reconnecting' | 'error';
      error: string | null;
      auth: AuthSessionContext;
      rows: ShellRows;
    };

type RootShellProps = {
  options: GlobalOptions;
  initialSnapshot?: RootShellSnapshot;
  onExit: () => void;
  onHandoff: (args: string[], snapshot: RootShellSnapshot) => void;
};

type LiveThreadMessage = {
  id: string;
  threadSeq: bigint;
  createdAtMicros: bigint;
  senderLabel: string;
  createdAt: string;
  body: string;
  decryptStatus: 'ok' | 'unsupported' | 'failed';
  trustStatus: 'self' | 'trusted' | 'unpinned-first-seen' | 'untrusted-rotation';
  trustWarning: string | null;
  optimistic?: boolean;
};

type LiveThreadWindow = {
  visibleMessages: LiveThreadMessage[];
  firstMessage: LiveThreadMessage | null;
  totalMessages: number;
  windowStart: number;
  windowEnd: number;
  canScrollOlder: boolean;
  canScrollNewer: boolean;
};

type FooterModeItem = {
  key: string;
  label: string;
};

type FooterMode = {
  label: string;
  detail?: string;
  items: FooterModeItem[];
};

type SecurityAction = {
  id:
    | 'request-share'
    | 'approve-share'
    | 'import-backup'
    | 'export-backup'
    | 'rotate-keys'
    | 'remove-local-keys'
    | 'logout';
  label: string;
  description: string;
};

const DEFAULT_SECURITY_STATE: ShellSecurityState = {
  status: 'healthy',
  title: 'Private keys are ready',
  description: 'Local keys are ready for the active agent.',
};

const DEFAULT_AGENT_DISCOVERY_TAKE = 10;
const THREAD_MESSAGE_WINDOW_SIZE = 4;
const MAX_MESSAGE_BODY_LINES = 15;

function createInitialAgentDiscoveryState(): AgentDiscoveryState {
  return {
    query: '',
    mode: 'browse',
    page: 1,
    take: DEFAULT_AGENT_DISCOVERY_TAKE,
    hasNextPage: false,
    loaded: false,
    loading: false,
    error: null,
    results: [],
  };
}

function createInitialDiscoverDetailState(): DiscoverDetailState {
  return {
    status: 'idle',
    slug: null,
    detail: null,
    error: null,
  };
}


function pushLog(logs: string[], next: string): string[] {
  return [...logs, next].slice(-4);
}

function silentReporter(): TaskReporter {
  return {
    info() {},
    success() {},
    verbose() {},
  };
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(index, 0), total - 1);
}

function clampCursor(index: number, total: number): number {
  return Math.min(Math.max(index, 0), total);
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return 'n/a';
  }
  return formatRelativeTime(value);
}

function createOptimisticThreadMessage(params: {
  messageId: string;
  threadSeq: string;
  senderLabel: string;
  body: string;
  createdAt?: Date;
}): LiveThreadMessage {
  const createdAt = params.createdAt ?? new Date();
  return {
    id: params.messageId,
    threadSeq: BigInt(params.threadSeq),
    createdAtMicros: BigInt(createdAt.getTime()) * 1000n,
    senderLabel: params.senderLabel,
    createdAt: createdAt.toISOString(),
    body: params.body,
    decryptStatus: 'ok',
    trustStatus: 'self',
    trustWarning: null,
    optimistic: true,
  };
}

function maskValue(value: string): string {
  return value ? '•'.repeat(value.length) : '';
}

function capTextLines(text: string, maxLines: number): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length <= maxLines) {
    return text;
  }

  const capped = lines.slice(0, maxLines);
  const lastIndex = maxLines - 1;
  capped[lastIndex] = capped[lastIndex].length
    ? `${capped[lastIndex]}…`
    : '…';
  return capped.join('\n');
}


function parseCommaSeparated(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
    )
  );
}

function resolveLookupQuery(
  value: string,
  tokenMode: 'single' | 'comma_list' = 'single'
): string {
  if (tokenMode === 'comma_list') {
    const parts = value.split(',');
    return parts[parts.length - 1]?.trim() ?? '';
  }

  return value.trim();
}

function applySuggestionValue(params: {
  currentValue: string;
  suggestionValue: string;
  tokenMode: 'single' | 'comma_list';
}): string {
  if (params.tokenMode === 'comma_list') {
    const committedValues = params.currentValue
      .split(',')
      .slice(0, -1)
      .map(item => item.trim())
      .filter(Boolean);

    return [...committedValues, params.suggestionValue].join(', ') + ', ';
  }

  return params.suggestionValue;
}

function buildInboxLookupSuggestionItems(params: {
  result: InboxLookupResult;
  ownSlug?: string | null;
  ownPublicIdentity?: string | null;
}): LookupSuggestionItem[] {
  const ownSlug = params.ownSlug?.trim().toLowerCase() ?? null;
  const ownPublicIdentity = params.ownPublicIdentity?.trim().toLowerCase() ?? null;
  const shouldInclude = (slug: string, publicIdentity: string): boolean => {
    if (ownSlug && slug.trim().toLowerCase() === ownSlug) {
      return false;
    }
    if (ownPublicIdentity && publicIdentity.trim().toLowerCase() === ownPublicIdentity) {
      return false;
    }
    return true;
  };

  return [
    ...params.result.results
      .filter(item => shouldInclude(item.slug, item.publicIdentity))
      .map(item => ({
      id: `contact:${item.publicIdentity}`,
      value: item.slug,
      label: item.displayName?.trim() ? `${item.slug} · ${item.displayName}` : item.slug,
      detail: `${item.publicIdentity} · ${item.threadCount} thread${item.threadCount === 1 ? '' : 's'} · ${item.newMessages} unread · local`,
      source: 'contact',
    } satisfies LookupSuggestionItem)),
    ...params.result.discoveredResults
      .filter(item => shouldInclude(item.slug, item.publicIdentity))
      .map(item => ({
      id: `saas:${item.publicIdentity}`,
      value: item.slug,
      label: item.displayName?.trim() ? `${item.slug} · ${item.displayName}` : item.slug,
      detail: `${item.publicIdentity} · verified SaaS`,
      source: 'saas',
    } satisfies LookupSuggestionItem)),
  ];
}

function buildDiscoverSuggestionItems(result: DiscoverSearchResult): LookupSuggestionItem[] {
  return result.results.map(item => ({
    id: `saas:${item.publicIdentity ?? item.slug}`,
    value: item.slug,
    label: item.displayName?.trim() ? `${item.slug} · ${item.displayName}` : item.slug,
    detail:
      item.description?.trim() ||
      item.publicIdentity ||
      'verified SaaS agent',
    source: 'saas',
  } satisfies LookupSuggestionItem));
}

function describeManagedAgentRegistration(params: {
  slug: string;
  status: string;
  error?: string | null;
}): string {
  switch (params.status) {
    case 'registered':
      return `Registered managed agent for ${params.slug}.`;
    case 'already_registered_or_discovered':
      return `Registered managed agent for ${params.slug}.`;
    case 'pending':
      return `Managed agent registration for ${params.slug} is pending.`;
    case 'insufficient_credits':
      return (
        params.error ??
        `Not enough Masumi credits to register ${params.slug} right now. Top up Masumi credits, then press M in Agents to register.`
      );
    case 'scope_missing':
      return params.error ?? 'Missing the Masumi SaaS scope required for agent registration.';
    case 'service_unavailable':
      return params.error ?? 'Masumi SaaS is currently unavailable.';
    case 'failed':
      return params.error ?? `Managed agent registration failed for ${params.slug}.`;
    case 'skipped':
      return `Skipped managed agent registration for ${params.slug}.`;
    default:
      return `Managed agent status: ${params.status}.`;
  }
}

function findOwnedActor(params: {
  rows: ShellRows;
  normalizedEmail: string;
  slug?: string | null;
}): VisibleAgentRow | null {
  const defaultActor = findDefaultActorByEmail(params.rows.actors, params.normalizedEmail);
  if (!defaultActor) {
    return null;
  }

  if (!params.slug) {
    return defaultActor;
  }

  return (
    params.rows.actors.find(actor => {
      return actor.inboxId === defaultActor.inboxId && actor.slug === params.slug;
    }) ?? defaultActor
  );
}

function matchesPublishedActorKeys(actor: VisibleAgentRow, keyPair: NonNullable<Awaited<ReturnType<typeof getStoredActorKeyPair>>>): boolean {
  return (
    actor.currentEncryptionPublicKey === keyPair.encryption.publicKey &&
    actor.currentEncryptionKeyVersion === keyPair.encryption.keyVersion &&
    actor.currentSigningPublicKey === keyPair.signing.publicKey &&
    actor.currentSigningKeyVersion === keyPair.signing.keyVersion
  );
}

async function inspectLocalSecurityState(params: {
  auth: AuthSessionContext;
  actor: VisibleAgentRow;
}): Promise<ShellSecurityState> {
  const secretStore = createSecretStore();
  const keyPair = await getStoredActorKeyPair({
    profile: params.auth.profile,
    secretStore,
    identity: {
      normalizedEmail: params.actor.normalizedEmail,
      slug: params.actor.slug,
      inboxIdentifier: params.actor.inboxIdentifier ?? undefined,
    },
  });

  if (!keyPair) {
    return {
      status: 'missing',
      title: 'Private keys are missing on this machine',
      description:
        'Recover them from another device, import a backup, or rotate keys in Account.',
    };
  }

  if (!matchesPublishedActorKeys(params.actor, keyPair)) {
    return {
      status: 'mismatch',
      title: 'Local keys do not match the published inbox keys',
      description:
        'Import newer keys from another device or backup, or rotate keys here.',
    };
  }

  return DEFAULT_SECURITY_STATE;
}

function createShellReporter(params: {
  setTask: React.Dispatch<React.SetStateAction<RootShellTaskState>>;
  verbose: boolean;
}): TaskReporter {
  return {
    info(text) {
      params.setTask(current => ({
        ...current,
        active: text,
        logs: pushLog(current.logs, text),
      }));
    },
    success(text) {
      params.setTask(current => ({
        ...current,
        active: null,
        logs: pushLog(current.logs, text),
      }));
    },
    verbose(text) {
      if (!params.verbose) {
        return;
      }
      params.setTask(current => ({
        ...current,
        active: text,
        logs: pushLog(current.logs, text),
      }));
    },
    setBanner(banner) {
      params.setTask(current => ({
        ...current,
        banner,
      }));
    },
    clearBanner() {
      params.setTask(current => ({
        ...current,
        banner: null,
      }));
    },
    async waitForKeypress() {},
  };
}

function useRootShellConnection(profileName: string) {
  const [state, setState] = useState<ShellConnectionState>({
    mode: 'loading',
    connection: 'connecting',
    error: null,
  });
  const [reconnectToken, setReconnectToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: NodeJS.Timeout | null = null;
    let conn: Awaited<ReturnType<typeof connectAuthenticated>>['conn'] | null = null;
    let unsubscribe: (() => void) | null = null;

    const connect = async () => {
      setState({
        mode: 'loading',
        connection: reconnectToken === 0 ? 'connecting' : 'reconnecting',
        error: null,
      });

      try {
        const status = await authStatus({
          profileName,
          reporter: silentReporter(),
        });
        if (!status.authenticated) {
          if (!cancelled) {
            setState({
              mode: 'signed_out',
              connection: 'signed_out',
              error: null,
            });
          }
          return;
        }

        const auth = await ensureAuthenticatedSession({
          profileName,
          reporter: silentReporter(),
        });
        if (cancelled) {
          return;
        }

        const connected = await connectAuthenticated({
          host: auth.profile.spacetimeHost,
          databaseName: auth.profile.spacetimeDbName,
          sessionToken: auth.session.idToken,
        });
        conn = connected.conn;

        const publishRows = () => {
          if (!conn || cancelled) {
            return;
          }

          setState({
            mode: 'ready',
            connection: 'live',
            error: null,
            auth,
            rows: readShellRows(conn),
          });
        };

        const subscription = await subscribeShellTables(conn, {
          onUpdate: publishRows,
          onError: errorMessage => {
            if (cancelled) {
              return;
            }

            setState(current => {
              if (current.mode !== 'ready') {
                return current;
              }

              return {
                ...current,
                connection: 'error',
                error: errorMessage,
              };
            });

            if (!retryTimeout) {
              retryTimeout = setTimeout(() => {
                setReconnectToken(value => value + 1);
              }, 1000);
            }
          },
        });
        unsubscribe = () => {
          subscription.unsubscribe();
        };
        publishRows();
      } catch (error) {
        if (cancelled) {
          return;
        }

        const cliError = toCliError(error);
        if (cliError.code === 'AUTH_REQUIRED') {
          setState({
            mode: 'signed_out',
            connection: 'signed_out',
            error: cliError.message,
          });
          return;
        }

        setState({
          mode: 'loading',
          connection: 'reconnecting',
          error: cliError.message,
        });

        retryTimeout = setTimeout(() => {
          setReconnectToken(value => value + 1);
        }, 1000);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
      unsubscribe?.();
      if (conn) {
        disconnectConnection(conn);
      }
    };
  }, [profileName, reconnectToken]);

  return {
    state,
    reconnect: () => setReconnectToken(value => value + 1),
  };
}

type LiveInboxSectionItem = NonNullable<RootShellViewModel>['inboxes']['sections'][number]['items'][number];
type LiveSelectedThread = NonNullable<RootShellViewModel>['inboxes']['threads'][number];
type LiveSelectedRequest = NonNullable<RootShellViewModel>['inboxes']['requests'][number];

function useLiveInboxSelection(params: {
  model: RootShellViewModel | null;
  inboxSection: InboxSectionKey;
  threadFilter: ShellThreadFilter;
  selectedInboxItemId: string | null;
  setSelectedInboxItemId: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const inboxSectionItems = useMemo<LiveInboxSectionItem[]>(() => {
    if (!params.model) {
      return [];
    }

    const section = params.model.inboxes.sections.find(
      candidate => candidate.key === params.inboxSection
    );
    if (!section) {
      return [];
    }

    if (params.inboxSection === 'pending') {
      return section.items;
    }

    const threadMap = new Map(params.model.inboxes.threads.map(thread => [thread.id, thread] as const));
    return section.items.filter(item => {
      if (item.kind !== 'thread' || !item.threadId) {
        return true;
      }

      const thread = threadMap.get(item.threadId);
      if (!thread) {
        return false;
      }
      if (params.threadFilter === 'unread') {
        return thread.unreadMessages > 0;
      }
      if (params.threadFilter === 'direct') {
        return thread.kind === 'direct';
      }
      return true;
    });
  }, [params.threadFilter, params.inboxSection, params.model]);

  useEffect(() => {
    if (!inboxSectionItems.some(item => item.id === params.selectedInboxItemId)) {
      params.setSelectedInboxItemId(inboxSectionItems[0]?.id ?? null);
    }
  }, [inboxSectionItems, params.selectedInboxItemId, params.setSelectedInboxItemId]);

  const selectedInboxItem = useMemo<LiveInboxSectionItem | null>(
    () =>
      inboxSectionItems.find(item => item.id === params.selectedInboxItemId) ??
      inboxSectionItems[0] ??
      null,
    [inboxSectionItems, params.selectedInboxItemId]
  );

  const selectedInboxIndex = useMemo(
    () =>
      selectedInboxItem
        ? inboxSectionItems.findIndex(item => item.id === selectedInboxItem.id)
        : 0,
    [inboxSectionItems, selectedInboxItem]
  );

  const selectedThread = useMemo<LiveSelectedThread | null>(
    () =>
      selectedInboxItem?.threadId
        ? params.model?.inboxes.threads.find(thread => thread.id === selectedInboxItem.threadId) ?? null
        : null,
    [params.model, selectedInboxItem?.threadId]
  );

  const selectedRequest = useMemo<LiveSelectedRequest | null>(
    () =>
      selectedInboxItem?.requestId
        ? params.model?.inboxes.requests.find(
            request => request.id === selectedInboxItem.requestId
          ) ?? null
        : null,
    [params.model, selectedInboxItem?.requestId]
  );

  return {
    inboxSectionItems,
    selectedInboxItem,
    selectedInboxIndex,
    selectedThread,
    selectedRequest,
  };
}

function compareVisibleThreadMessages(left: VisibleMessageRow, right: VisibleMessageRow): number {
  if (left.threadSeq < right.threadSeq) return -1;
  if (left.threadSeq > right.threadSeq) return 1;
  if (left.createdAt.microsSinceUnixEpoch < right.createdAt.microsSinceUnixEpoch) return -1;
  if (left.createdAt.microsSinceUnixEpoch > right.createdAt.microsSinceUnixEpoch) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function compareLiveThreadMessages(left: LiveThreadMessage, right: LiveThreadMessage): number {
  if (left.threadSeq < right.threadSeq) return -1;
  if (left.threadSeq > right.threadSeq) return 1;
  if (left.createdAtMicros < right.createdAtMicros) return -1;
  if (left.createdAtMicros > right.createdAtMicros) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function mergeLiveThreadMessages(params: {
  liveMessages: LiveThreadMessage[];
  optimisticMessages: LiveThreadMessage[];
}): LiveThreadMessage[] {
  const byId = new Map(params.liveMessages.map(message => [message.id, message] as const));

  for (const message of params.optimisticMessages) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }

  return [...byId.values()].sort(compareLiveThreadMessages);
}

async function buildLiveThreadMessages(params: {
  rows: ShellRows;
  auth: AuthSessionContext;
  normalizedEmail: string;
  activeInboxSlug: string | null;
  threadId: string;
}): Promise<LiveThreadMessage[]> {
  const actor = findOwnedActor({
    rows: params.rows,
    normalizedEmail: params.normalizedEmail,
    slug: params.activeInboxSlug,
  });
  if (!actor) {
    return [];
  }

  const requestedThreadId = BigInt(params.threadId);
  const secretStore = createSecretStore();
  const recipientKeyPair = await getStoredActorKeyPair({
    profile: params.auth.profile,
    secretStore,
    identity: {
      normalizedEmail: actor.normalizedEmail,
      slug: actor.slug,
      inboxIdentifier: actor.inboxIdentifier ?? actor.slug,
    },
  });
  const actorsById = new Map(params.rows.actors.map(row => [row.id, row] as const));
  const bundlesByActorId = new Map<bigint, typeof params.rows.bundles>();
  for (const bundle of params.rows.bundles) {
    const list = bundlesByActorId.get(bundle.agentDbId) ?? [];
    list.push(bundle);
    bundlesByActorId.set(bundle.agentDbId, list);
  }
  const ownActorIds = new Set(
    params.rows.actors
      .filter(row => row.inboxId === actor.inboxId)
      .map(row => row.id)
  );

  const threadMessages = params.rows.messages
    .filter(message => message.threadId === requestedThreadId)
    .sort(compareVisibleThreadMessages);

  return await Promise.all(
    threadMessages.map(async message => {
      const sender = actorsById.get(message.senderAgentDbId);
      const decrypted = await decryptVisibleMessage({
        message,
        defaultActor: actor,
        actorsById,
        bundlesByActorId,
        ownActorIds,
        secretEnvelopes: params.rows.secretEnvelopes,
        recipientKeyPair,
      });

      return {
        id: message.id.toString(),
        threadSeq: message.threadSeq,
        createdAtMicros: message.createdAt.microsSinceUnixEpoch,
        senderLabel: sender?.displayName?.trim() || sender?.slug || 'unknown',
        createdAt: message.createdAt.toDate().toISOString(),
        body:
          decrypted.text ??
          `[${decrypted.decryptStatus === 'failed' ? decrypted.decryptError ?? 'Unable to decrypt' : 'Unsupported content blocked'}]`,
        decryptStatus: decrypted.decryptStatus,
        trustStatus: decrypted.trustStatus,
        trustWarning: decrypted.trustWarning,
      } satisfies LiveThreadMessage;
    })
  );
}

function useLiveThreadMessages(params: {
  connectionState: ShellConnectionState;
  normalizedEmail: string;
  activeInboxSlug: string | null;
  routeType: ShellRoute['type'];
  selectedInboxItem: LiveInboxSectionItem | null;
  optimisticMessages: LiveThreadMessage[];
  refreshToken: string;
}) {
  const [threadMessages, setThreadMessages] = useState<LiveThreadMessage[]>([]);
  const [threadMessagesError, setThreadMessagesError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    setScrollOffset(0);
  }, [params.selectedInboxItem?.threadId]);

  useEffect(() => {
    if (
      params.connectionState.mode !== 'ready' ||
      params.routeType !== 'inboxes' ||
      !params.selectedInboxItem?.threadId
    ) {
      setThreadMessages([]);
      setThreadMessagesError(null);
      setScrollOffset(0);
      return;
    }

    let cancelled = false;
    void buildLiveThreadMessages({
      rows: params.connectionState.rows,
      auth: params.connectionState.auth,
      normalizedEmail: params.normalizedEmail,
      activeInboxSlug: params.activeInboxSlug,
      threadId: params.selectedInboxItem.threadId,
    })
      .then(result => {
        if (!cancelled) {
          setThreadMessages(result);
          setThreadMessagesError(null);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setThreadMessages([]);
          setThreadMessagesError(toCliError(error).message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    params.activeInboxSlug,
    params.connectionState,
    params.normalizedEmail,
    params.refreshToken,
    params.routeType,
    params.selectedInboxItem?.threadId,
  ]);

  useEffect(() => {
    const maxOffset = Math.max(
      mergeLiveThreadMessages({
        liveMessages: threadMessages,
        optimisticMessages: params.optimisticMessages,
      }).length - THREAD_MESSAGE_WINDOW_SIZE,
      0
    );
    setScrollOffset(current => Math.min(current, maxOffset));
  }, [threadMessages, params.optimisticMessages]);

  const allMessages = useMemo(
    () =>
      mergeLiveThreadMessages({
        liveMessages: threadMessages,
        optimisticMessages: params.optimisticMessages,
      }),
    [threadMessages, params.optimisticMessages]
  );

  const window = useMemo<LiveThreadWindow>(() => {
    const totalMessages = allMessages.length;
    const windowEnd = Math.max(totalMessages - scrollOffset, 0);
    const windowStart = Math.max(0, windowEnd - THREAD_MESSAGE_WINDOW_SIZE);

    return {
      visibleMessages: allMessages.slice(windowStart, windowEnd),
      firstMessage: allMessages[0] ?? null,
      totalMessages,
      windowStart,
      windowEnd,
      canScrollOlder: windowStart > 0,
      canScrollNewer: windowEnd < totalMessages,
    };
  }, [allMessages, scrollOffset]);

  return {
    threadMessages: window.visibleMessages,
    threadMessagesError,
    firstThreadMessage: window.firstMessage,
    totalThreadMessages: window.totalMessages,
    threadWindowStart: window.windowStart,
    threadWindowEnd: window.windowEnd,
    canScrollOlder: window.canScrollOlder,
    canScrollNewer: window.canScrollNewer,
    scrollOlder: () =>
      setScrollOffset(current =>
        Math.min(current + 1, Math.max(allMessages.length - THREAD_MESSAGE_WINDOW_SIZE, 0))
      ),
    scrollNewer: () => setScrollOffset(current => Math.max(current - 1, 0)),
    resetThreadWindow: () => setScrollOffset(0),
  };
}

const INK_SENDER_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red'] as const;

function senderInkColor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return INK_SENDER_COLORS[Math.abs(hash) % INK_SENDER_COLORS.length]!;
}

function renderList(params: {
  items: string[];
  selectedIndex: number;
  empty: string;
  color?: string;
}) {
  if (params.items.length === 0) {
    return <Text color="gray">{params.empty}</Text>;
  }

  return (
    <Box flexDirection="column">
      {params.items.map((item, index) => (
        <Text key={`${index}:${item}`} color={index === params.selectedIndex ? 'cyan' : params.color}>
          {index === params.selectedIndex ? '▸ ' : '  '}
          {item}
        </Text>
      ))}
    </Box>
  );
}

function HelpBar({ items }: { items: Array<{ key: string; label: string }> }) {
  return (
    <Text>
      {items.map((item, index) => (
        <Text key={item.key}>
          {index > 0 ? <Text color="gray"> · </Text> : null}
          <Text color="cyan" bold>
            {item.key}
          </Text>
          <Text color="gray"> {item.label}</Text>
        </Text>
      ))}
    </Text>
  );
}

function ModeBar({ mode }: { mode: FooterMode }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        <Text color="cyan" bold>
          Mode
        </Text>
        <Text color="gray"> · </Text>
        <Text>{mode.label}</Text>
        {mode.detail ? (
          <>
            <Text color="gray"> · </Text>
            <Text color="gray">{mode.detail}</Text>
          </>
        ) : null}
      </Text>
      {mode.items.length > 0 ? <HelpBar items={mode.items} /> : null}
    </Box>
  );
}

const SIDEBAR_LABELS: Record<SidebarNavItem, string> = {
  inboxes: 'Inbox',
  agents: 'My Agents',
  discover: 'Discover',
  account: 'Account',
};
const SIDEBAR_ICONS: Record<SidebarNavItem, string> = {
  inboxes: '[i]',
  agents: '[a]',
  discover: '[d]',
  account: '[u]',
};

function Sidebar({
  active,
  selectedNav,
  slug,
  connectionLabel,
  connectionDotColor,
  unreadCount,
  pendingCount,
  shellFocus,
}: {
  active: ShellRoute['type'];
  selectedNav: SidebarNavItem;
  slug: string | null;
  connectionLabel: string;
  connectionDotColor: string;
  unreadCount: number;
  pendingCount: number;
  shellFocus: ShellFocus;
}) {
  return (
    <Box
      flexDirection="column"
      width={20}
      borderStyle="single"
      borderRight
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderColor="gray"
      paddingRight={1}
    >
      <Text color="cyanBright" bold>◆ AGENT MESSENGER</Text>
      {slug ? <Text color="gray">/{slug}</Text> : <Text color="gray">encrypted inbox</Text>}
      <Text> </Text>
      {SIDEBAR_NAV_ITEMS.map(item => {
        const isActive = active === item;
        const isSelected = shellFocus === 'sidebar' && selectedNav === item;
        const badge =
          item === 'inboxes' && unreadCount > 0
            ? ` ${unreadCount}`
            : item === 'inboxes' && pendingCount > 0
              ? ` ${pendingCount}p`
              : '';
        return (
          <Text
            key={item}
            color={isSelected ? 'cyan' : isActive ? 'cyan' : shellFocus === 'sidebar' ? undefined : 'gray'}
          >
            {isSelected ? '▸ ' : isActive ? '• ' : '  '}
            <Text color="gray">{SIDEBAR_ICONS[item]} </Text>
            {SIDEBAR_LABELS[item]}
            {badge ? <Text color="yellow">{badge}</Text> : null}
          </Text>
        );
      })}
      <Text> </Text>
      <Text color="gray">↑/↓ select</Text>
      <Text color="gray">Enter open</Text>
      <Text color="gray">I/A/D/U jump</Text>
      <Text color="gray">Tab focus</Text>
      <Text color="gray">Q quit</Text>
      <Text color="gray">? help</Text>
      <Box flexGrow={1} />
      {connectionLabel !== 'live' ? (
        <Text>
          <Text color={connectionDotColor}>●</Text>
          <Text color="gray"> {connectionLabel}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

function TaskPanel({
  panel,
  lookupState,
  selectedLookupIndex,
  cursorIndex,
}: {
  panel: TaskPanelState;
  lookupState: TaskLookupState;
  selectedLookupIndex: number;
  cursorIndex: number;
}) {
  const currentField = panel.fields[panel.stepIndex] ?? null;
  const isLastField = panel.stepIndex >= panel.fields.length - 1;
  const showLookup =
    currentField &&
    lookupState.fieldKey === currentField.key &&
    (lookupState.loading || lookupState.error || lookupState.items.length > 0);

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingLeft={1}
      paddingRight={1}
    >
      <Text color="cyan" bold>
        {panel.title}
      </Text>
      <Text color="gray">{panel.help}</Text>
      {panel.fields.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {panel.fields.map((field, index) => {
            const displayValue = field.secret ? maskValue(field.value) : field.value;
            const isActive = index === panel.stepIndex;
            const activeCursor = isActive ? clampCursor(cursorIndex, displayValue.length) : displayValue.length;
            const valuePrefix = displayValue.slice(0, activeCursor);
            const valueSuffix = displayValue.slice(activeCursor);
            return (
              <Text key={field.key} color={isActive ? 'cyan' : undefined}>
                {isActive ? '▸ ' : '  '}
                {field.label}:{' '}
                {displayValue ? (
                  <>
                    <Text>{valuePrefix}</Text>
                    {isActive ? <Text color="cyan">_</Text> : null}
                    <Text>{valueSuffix}</Text>
                  </>
                ) : (
                  <>
                    {isActive ? <Text color="cyan">_</Text> : null}
                    <Text color="gray">{field.placeholder ?? ''}</Text>
                  </>
                )}
              </Text>
            );
          })}
        </Box>
      ) : (
        <Text color="yellow">Press Enter to continue or Esc to cancel.</Text>
      )}
      {showLookup ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Suggestions</Text>
          {lookupState.loading ? <Text color="gray">  Searching…</Text> : null}
          {lookupState.items.map((item, index) => (
            <Box key={item.id} flexDirection="column">
              <Text color={index === selectedLookupIndex ? 'cyan' : undefined}>
                {index === selectedLookupIndex ? '▸ ' : '  '}
                {item.label}
                <Text color="gray"> · {item.source === 'contact' ? 'local' : 'saas'}</Text>
              </Text>
              <Text color="gray">    {item.detail}</Text>
            </Box>
          ))}
          {lookupState.error ? <Text color="red">  {lookupState.error}</Text> : null}
          {lookupState.items.length > 0 ? (
            <Text color="gray">Tab accept suggestion · ↑/↓ choose</Text>
          ) : null}
        </Box>
      ) : null}
      <Text color="gray">
        Step {Math.min(panel.stepIndex + 1, Math.max(panel.fields.length, 1)).toString()}/
        {Math.max(panel.fields.length, 1).toString()} · ←/→ cursor · Enter {currentField && !isLastField ? 'next' : panel.submitLabel.toLowerCase()} · Esc cancel
      </Text>
    </Box>
  );
}

export function RootShell({
  options,
  initialSnapshot,
  onExit,
  onHandoff,
}: RootShellProps) {
  void onHandoff;
  const { exit } = useApp();
  const { state: connectionState, reconnect } = useRootShellConnection(options.profile);
  const [route, setRoute] = useState<ShellRoute>(initialSnapshot?.route ?? { type: 'auth' });
  const [activeInboxSlug, setActiveInboxSlug] = useState<string | null>(
    initialSnapshot?.activeInboxSlug ?? null
  );
  const [inboxSection, setInboxSection] = useState<InboxSectionKey>(
    initialSnapshot?.inboxSection ?? 'threads'
  );
  const [threadFilter, setThreadFilter] = useState<ShellThreadFilter>(
    initialSnapshot?.threadFilter ?? 'all'
  );
  const [selectedInboxItemId, setSelectedInboxItemId] = useState<string | null>(
    initialSnapshot?.selectedInboxItemId ?? null
  );
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(
    initialSnapshot?.selectedAgentSlug ?? null
  );
  const [accountFocus, setAccountFocus] = useState<AccountFocus>(
    initialSnapshot?.accountFocus ?? 'security'
  );
  const [shellFocus, setShellFocus] = useState<ShellFocus>(
    initialSnapshot?.shellFocus ?? 'content'
  );
  const [sidebarNavIndex, setSidebarNavIndex] = useState(() =>
    toSidebarSelectionIndex(initialSnapshot?.route.type)
  );
  const [deviceSelection, setDeviceSelection] = useState(0);
  const [securityActionIndex, setSecurityActionIndex] = useState(0);
  const [inboxFocus, setInboxFocus] = useState<InboxFocus>('navigator');
  const [threadDrafts, setThreadDrafts] = useState<Record<string, string>>({});
  const [threadDraftCursorByThreadId, setThreadDraftCursorByThreadId] = useState<Record<string, number>>({});
  const [optimisticThreadMessagesByThreadId, setOptimisticThreadMessagesByThreadId] = useState<
    Record<string, LiveThreadMessage[]>
  >({});
  const [taskPanel, setTaskPanel] = useState<TaskPanelState | null>(null);
  const [taskLookup, setTaskLookup] = useState<TaskLookupState>({
    fieldKey: null,
    query: '',
    loading: false,
    items: [],
    error: null,
  });
  const [taskLookupIndex, setTaskLookupIndex] = useState(0);
  const [taskCursorIndex, setTaskCursorIndex] = useState(0);
  const [task, setTask] = useState<RootShellTaskState>({
    busy: false,
    active: null,
    logs: [],
    banner: null,
    error: null,
    notice: null,
  });
  const [securityState, setSecurityState] = useState<ShellSecurityState>(DEFAULT_SECURITY_STATE);
  const [securityRefreshToken, setSecurityRefreshToken] = useState(0);
  const [liveInboxRefreshToken, setLiveInboxRefreshToken] = useState(0);
  const [pendingBackupPrompt, setPendingBackupPrompt] = useState<string | null>(null);
  const [agentDiscovery, setAgentDiscovery] = useState<AgentDiscoveryState>(
    createInitialAgentDiscoveryState
  );
  const [selectedDiscoveryIndex, setSelectedDiscoveryIndex] = useState(0);
  const [discoverDetail, setDiscoverDetail] = useState<DiscoverDetailState>(
    createInitialDiscoverDetailState
  );
  const [pendingRegistrationPrompt, setPendingRegistrationPrompt] =
    useState<PendingRegistrationPrompt | null>(null);
  const agentDiscoveryRequestRef = useRef(0);
  const activeTaskFieldKeyRef = useRef<string | null>(null);
  const initialSetupPublicDescriptionRef = useRef<string | null>(null);

  const normalizedEmail =
    connectionState.mode === 'ready'
      ? normalizeEmail(connectionState.auth.claims.email ?? '')
      : '';

  const activeActorRow = useMemo(() => {
    if (connectionState.mode !== 'ready' || !normalizedEmail) {
      return null;
    }

    return findOwnedActor({
      rows: connectionState.rows,
      normalizedEmail,
      slug: activeInboxSlug,
    });
  }, [activeInboxSlug, connectionState, normalizedEmail]);

  useEffect(() => {
    if (connectionState.mode === 'signed_out') {
      setRoute({ type: 'auth' });
      setActiveInboxSlug(null);
      setSelectedAgentSlug(null);
      setSelectedInboxItemId(null);
      setTaskPanel(null);
      setTaskLookup({
        fieldKey: null,
        query: '',
        loading: false,
        items: [],
        error: null,
      });
      setTaskCursorIndex(0);
      activeTaskFieldKeyRef.current = null;
      setAgentDiscovery(createInitialAgentDiscoveryState());
      setDiscoverDetail(createInitialDiscoverDetailState());
      setPendingRegistrationPrompt(null);
      setSecurityState(DEFAULT_SECURITY_STATE);
      return;
    }

    if (connectionState.mode === 'ready' && activeActorRow) {
      if (activeInboxSlug !== activeActorRow.slug) {
        setActiveInboxSlug(activeActorRow.slug);
      }
      if (route.type === 'auth') {
        setRoute({ type: 'inboxes' });
      }
    }
  }, [activeActorRow, activeInboxSlug, connectionState.mode, route.type]);

  useEffect(() => {
    if (shellFocus !== 'sidebar') {
      return;
    }
    setSidebarNavIndex(toSidebarSelectionIndex(route.type));
  }, [route.type, shellFocus]);

  useEffect(() => {
    if (connectionState.mode !== 'ready' || !activeActorRow) {
      setSecurityState(DEFAULT_SECURITY_STATE);
      return;
    }

    let cancelled = false;
    void inspectLocalSecurityState({
      auth: connectionState.auth,
      actor: activeActorRow,
    })
      .then(result => {
        if (!cancelled) {
          setSecurityState(result);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setSecurityState({
            status: 'mismatch',
            title: 'Unable to inspect local keys',
            description: error instanceof Error ? error.message : 'Unable to inspect local keys.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeActorRow?.currentEncryptionKeyVersion,
    activeActorRow?.currentSigningKeyVersion,
    activeActorRow?.id,
    connectionState.mode,
    connectionState.mode === 'ready' ? connectionState.auth.profile.name : null,
    securityRefreshToken,
  ]);

  const model = useMemo<RootShellViewModel | null>(() => {
    if (connectionState.mode !== 'ready' || !normalizedEmail) {
      return null;
    }

    return buildRootShellViewModel({
      rows: connectionState.rows,
      normalizedEmail,
      activeInboxSlug,
      securityState,
      connectionHealth: connectionState.connection as RootShellConnectionHealth,
      pendingBackupPrompt,
    });
  }, [
    activeInboxSlug,
    connectionState,
    normalizedEmail,
    pendingBackupPrompt,
    securityState,
  ]);

  useEffect(() => {
    if (!model) {
      return;
    }

    if (!selectedAgentSlug || !model.agents.agentSummaries.some(agent => agent.slug === selectedAgentSlug)) {
      setSelectedAgentSlug(model.activeInbox.slug);
    }
  }, [model, selectedAgentSlug]);

  const selectedAgent =
    model?.agents.agentSummaries.find(agent => agent.slug === selectedAgentSlug) ??
    model?.agents.agentSummaries[0] ??
    null;
  const selectedAgentIndex = model?.agents.agentSummaries.findIndex(
    agent => agent.slug === selectedAgent?.slug
  ) ?? 0;
  const selectedDiscoveryResult =
    agentDiscovery.results[clampIndex(selectedDiscoveryIndex, agentDiscovery.results.length)] ??
    null;
  const sharedThreadsWithDiscoveredAgent = useMemo(() => {
    if (!model || !selectedDiscoveryResult) {
      return [];
    }
    return model.inboxes.threads.filter(thread => thread.participants.includes(selectedDiscoveryResult.slug));
  }, [model, selectedDiscoveryResult]);
  const pendingRequestsWithDiscoveredAgent = useMemo(() => {
    if (!model || !selectedDiscoveryResult) {
      return [];
    }
    return model.inboxes.requests.filter(
      request =>
        request.requesterSlug === selectedDiscoveryResult.slug ||
        request.targetSlug === selectedDiscoveryResult.slug
    );
  }, [model, selectedDiscoveryResult]);
  const selectedDiscoveryDedicatedMembers = useMemo(() => {
    if (!model || !selectedDiscoveryResult) {
      return null;
    }

    const memberSlugs = new Set<string>();
    for (const thread of sharedThreadsWithDiscoveredAgent) {
      for (const participant of thread.participants) {
        memberSlugs.add(participant);
      }
    }
    memberSlugs.delete(selectedDiscoveryResult.slug);
    memberSlugs.delete(model.activeInbox.slug);

    return memberSlugs.size;
  }, [model, selectedDiscoveryResult, sharedThreadsWithDiscoveredAgent]);
  const selectedDiscoverySummaryRows = useMemo(() => {
    const rows: string[] = [];

    if (
      sharedThreadsWithDiscoveredAgent.length > 0 &&
      (selectedDiscoveryDedicatedMembers === null || selectedDiscoveryDedicatedMembers <= 0)
    ) {
      rows.push(
        `${sharedThreadsWithDiscoveredAgent.length} open thread${sharedThreadsWithDiscoveredAgent.length === 1 ? '' : 's'}`
      );
    } else if (selectedDiscoveryDedicatedMembers !== null && selectedDiscoveryDedicatedMembers > 0) {
      rows.push(
        `${selectedDiscoveryDedicatedMembers} dedicated member${selectedDiscoveryDedicatedMembers === 1 ? '' : 's'}`
      );
    }
    if (pendingRequestsWithDiscoveredAgent.length > 0) {
      rows.push(
        `${pendingRequestsWithDiscoveredAgent.length} pending request${pendingRequestsWithDiscoveredAgent.length === 1 ? '' : 's'}`
      );
    }

    return rows;
  }, [
    pendingRequestsWithDiscoveredAgent.length,
    sharedThreadsWithDiscoveredAgent.length,
    selectedDiscoveryDedicatedMembers,
  ]);
  const selectedDiscoveryPublicMetrics = useMemo(() => {
    if (!model || !selectedDiscoveryResult) {
      return {
        activeThreads: null,
        dedicatedMembers: null,
        requestedThreads: null,
      };
    }

    return {
      activeThreads: sharedThreadsWithDiscoveredAgent.length,
      dedicatedMembers: selectedDiscoveryDedicatedMembers,
      requestedThreads: pendingRequestsWithDiscoveredAgent.length,
    };
  }, [model, selectedDiscoveryResult, selectedDiscoveryDedicatedMembers, sharedThreadsWithDiscoveredAgent, pendingRequestsWithDiscoveredAgent]);
  const selectedDiscoveryDetail =
    selectedDiscoveryResult &&
    discoverDetail.status === 'ready' &&
    discoverDetail.slug === selectedDiscoveryResult.slug
      ? discoverDetail.detail
      : null;
  const currentTaskField = taskPanel?.fields[taskPanel.stepIndex] ?? null;
  useEffect(() => {
    if (!currentTaskField) {
      activeTaskFieldKeyRef.current = null;
      setTaskCursorIndex(0);
      return;
    }

    setTaskCursorIndex(current => {
      const valueLength = currentTaskField.value.length;
      if (activeTaskFieldKeyRef.current !== currentTaskField.key) {
        activeTaskFieldKeyRef.current = currentTaskField.key;
        return valueLength;
      }
      return clampCursor(current, valueLength);
    });
  }, [currentTaskField]);

  const {
    inboxSectionItems,
    selectedInboxItem,
    selectedInboxIndex,
    selectedThread,
    selectedRequest,
  } = useLiveInboxSelection({
    model,
    inboxSection,
    threadFilter,
    selectedInboxItemId,
    setSelectedInboxItemId,
  });

  const {
    threadMessages,
    threadMessagesError,
    firstThreadMessage,
    totalThreadMessages,
    threadWindowStart,
    threadWindowEnd,
    resetThreadWindow,
  } = useLiveThreadMessages({
    connectionState,
    normalizedEmail,
    activeInboxSlug: model?.activeInbox.slug ?? null,
    routeType: route.type,
    selectedInboxItem,
    optimisticMessages:
      selectedInboxItem?.threadId
        ? optimisticThreadMessagesByThreadId[selectedInboxItem.threadId] ?? []
        : [],
    refreshToken: `${liveInboxRefreshToken}:${securityRefreshToken}`,
  });

  const securityActions = useMemo<SecurityAction[]>(() => {
    const recoveryLabel =
      securityState.status === 'healthy'
        ? 'Sync this machine from another device'
        : 'Recover private keys from another device now';
    return [
      {
        id: 'request-share',
        label: recoveryLabel,
        description: 'Show a code here and approve it on another device.',
      },
      {
        id: 'approve-share',
        label: 'Approve a device share code',
        description: 'Approve a recovery code from another device.',
      },
      {
        id: 'import-backup',
        label: 'Import encrypted backup',
        description: 'Restore keys from an encrypted backup.',
      },
      {
        id: 'export-backup',
        label: 'Export encrypted backup',
        description: 'Save an encrypted backup of local keys.',
      },
      {
        id: 'rotate-keys',
        label: 'Rotate agent keys',
        description: 'Rotate keys and optionally share or revoke devices.',
      },
      {
        id: 'remove-local-keys',
        label: 'Remove local keys',
        description: 'Wipe local key material on this device and sign out.',
      },
      {
        id: 'logout',
        label: 'Sign out',
        description: 'Clear the local session on this machine (keeps keys).',
      },
    ];
  }, [securityState.status]);

  useEffect(() => {
    if (!selectedDiscoveryResult) {
      setDiscoverDetail(current =>
        current.status === 'idle' && current.slug === null
          ? current
          : createInitialDiscoverDetailState()
      );
      return;
    }
    setDiscoverDetail(current => {
      if (
        (current.status === 'ready' || current.status === 'loading' || current.status === 'error') &&
        current.slug === selectedDiscoveryResult.slug
      ) {
        return current;
      }
      return createInitialDiscoverDetailState();
    });
  }, [selectedDiscoveryResult]);

  const selectedSecurityAction =
    securityActions[clampIndex(securityActionIndex, securityActions.length)] ?? null;
  const selectedDevice =
    model?.account.devices[clampIndex(deviceSelection, model.account.devices.length)] ?? null;

  useEffect(() => {
    setDeviceSelection(current => clampIndex(current, model?.account.devices.length ?? 0));
  }, [model?.account.devices.length]);

  useEffect(() => {
    setSecurityActionIndex(current => clampIndex(current, securityActions.length));
  }, [securityActions.length]);

  useEffect(() => {
    if (!taskPanel || !currentTaskField?.lookup || connectionState.mode !== 'ready') {
      setTaskLookup({
        fieldKey: null,
        query: '',
        loading: false,
        items: [],
        error: null,
      });
      return;
    }

    const query = resolveLookupQuery(
      currentTaskField.value,
      currentTaskField.lookup.tokenMode ?? 'single'
    );

    if (!query) {
      setTaskLookup({
        fieldKey: currentTaskField.key,
        query: '',
        loading: false,
        items: [],
        error: null,
      });
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(() => {
      void (async () => {
        setTaskLookup(current => ({
          ...current,
          fieldKey: currentTaskField.key,
          query,
          loading: true,
          error: null,
        }));

        try {
          if (currentTaskField.lookup?.mode === 'saas_agent') {
            const result = await discoverAgents({
              profileName: options.profile,
              reporter: silentReporter(),
              query,
              limit: 6,
              actorSlug: model?.activeInbox.slug ?? null,
            });

            if (cancelled) {
              return;
            }

            setTaskLookup({
              fieldKey: currentTaskField.key,
              query,
              loading: false,
              items: buildDiscoverSuggestionItems(result),
              error: null,
            });
            return;
          }

          const result = await lookupInboxes({
            profileName: options.profile,
            query,
            limit: 6,
            reporter: silentReporter(),
          });

          if (cancelled) {
            return;
          }

          setTaskLookup({
            fieldKey: currentTaskField.key,
            query,
            loading: false,
            items: buildInboxLookupSuggestionItems({
              result,
              ownSlug: model?.activeInbox.slug ?? null,
              ownPublicIdentity: model?.activeInbox.publicIdentity ?? null,
            }),
            error: result.discoveryError,
          });
        } catch (error) {
          if (cancelled) {
            return;
          }

          setTaskLookup({
            fieldKey: currentTaskField.key,
            query,
            loading: false,
            items: [],
            error: toCliError(error).message,
          });
        }
      })();
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [
    connectionState.mode,
    currentTaskField?.key,
    currentTaskField?.lookup,
    currentTaskField?.value,
    model?.activeInbox.slug,
    options.profile,
    taskPanel,
  ]);

  useEffect(() => {
    setTaskLookupIndex(current => clampIndex(current, taskLookup.items.length));
  }, [taskLookup.fieldKey, taskLookup.items.length, taskLookup.query]);

  useEffect(() => {
    setSelectedDiscoveryIndex(current =>
      clampIndex(current, agentDiscovery.results.length)
    );
  }, [agentDiscovery.results.length]);

  useEffect(() => {
    if (connectionState.mode !== 'ready') {
      return;
    }

    const syncedMessageIds = new Set(connectionState.rows.messages.map(message => message.id.toString()));
    setOptimisticThreadMessagesByThreadId(current => {
      let changed = false;
      const nextEntries = Object.entries(current)
        .map(([threadId, messages]) => {
          const remaining = messages.filter(message => !syncedMessageIds.has(message.id));
          if (remaining.length !== messages.length) {
            changed = true;
          }
          return remaining.length > 0 ? ([threadId, remaining] as const) : null;
        })
        .filter((entry): entry is readonly [string, LiveThreadMessage[]] => Boolean(entry));

      return changed ? Object.fromEntries(nextEntries) : current;
    });
  }, [connectionState]);

  const snapshot = useMemo<RootShellSnapshot>(
    () => ({
      route,
      activeInboxSlug,
      inboxSection,
      threadFilter,
      selectedInboxItemId,
      selectedAgentSlug,
      agentsFocus: route.type === 'discover' ? 'discover' : 'owned',
      accountFocus,
      shellFocus,
    }),
    [
      accountFocus,
      activeInboxSlug,
      threadFilter,
      inboxSection,
      route,
      selectedAgentSlug,
      selectedInboxItemId,
      shellFocus,
    ]
  );
  void snapshot;

  const loadAgentDiscovery = async (params?: {
    query?: string;
    page?: number;
    announce?: boolean;
  }): Promise<void> => {
    if (connectionState.mode !== 'ready') {
      return;
    }

    const query = (params?.query ?? agentDiscovery.query).trim();
    const page = params?.page ?? agentDiscovery.page;
    const requestId = agentDiscoveryRequestRef.current + 1;
    agentDiscoveryRequestRef.current = requestId;

    setAgentDiscovery(current => ({
      ...current,
      query,
      mode: query ? 'search' : 'browse',
      page,
      loading: true,
      error: null,
    }));

    try {
      const result = await discoverAgents({
        profileName: options.profile,
        reporter: silentReporter(),
        query: query || undefined,
        limit: agentDiscovery.take,
        page,
        actorSlug: model?.activeInbox.slug ?? null,
      });

      if (agentDiscoveryRequestRef.current !== requestId) {
        return;
      }

      setAgentDiscovery({
        query: result.query ?? '',
        mode: result.mode,
        page: result.page,
        take: result.take,
        hasNextPage: result.hasNextPage,
        loaded: true,
        loading: false,
        error: null,
        results: result.results,
      });
      setSelectedDiscoveryIndex(0);

      if (params?.announce) {
        setTask(current => ({
          ...current,
          notice:
            result.total > 0
              ? result.mode === 'search'
                ? `Found ${result.total} verified agent${result.total === 1 ? '' : 's'}.`
                : `Loaded ${result.total} registered agent${result.total === 1 ? '' : 's'}.`
              : result.mode === 'search'
                ? `No verified agents matched ${query}.`
                : 'No registered agents found on this page.',
        }));
      }
    } catch (error) {
      if (agentDiscoveryRequestRef.current !== requestId) {
        return;
      }

      const message = toCliError(error).message;
      setAgentDiscovery(current => ({
        ...current,
        query,
        mode: query ? 'search' : 'browse',
        page,
        hasNextPage: false,
        loaded: true,
        loading: false,
        error: message,
        results: [],
      }));

      if (params?.announce) {
        setTask(current => ({
          ...current,
          error: message,
        }));
      }
    }
  };

  const changeAgentDiscoveryPage = async (direction: 1 | -1): Promise<void> => {
    if (agentDiscovery.loading) {
      return;
    }

    const nextPage =
      direction < 0
        ? Math.max(1, agentDiscovery.page - 1)
        : agentDiscovery.hasNextPage
          ? agentDiscovery.page + 1
          : agentDiscovery.page;

    if (nextPage === agentDiscovery.page) {
      return;
    }

    await loadAgentDiscovery({
      query: agentDiscovery.query,
      page: nextPage,
    });
  };

  useEffect(() => {
    if (
      connectionState.mode !== 'ready' ||
      route.type !== 'discover' ||
      agentDiscovery.loaded ||
      agentDiscovery.loading
    ) {
      return;
    }

    void loadAgentDiscovery({
      query: agentDiscovery.query,
      page: agentDiscovery.page,
    });
  }, [
    agentDiscovery.loaded,
    agentDiscovery.loading,
    agentDiscovery.page,
    agentDiscovery.query,
    connectionState.mode,
    route.type,
  ]);

  const performTask = async <T,>(
    label: string,
    runner: (reporter: TaskReporter) => Promise<T>,
    onSuccess?: (result: T) => void
  ): Promise<void> => {
    if (task.busy) {
      return;
    }

    setTask(current => ({
      ...current,
      busy: true,
      active: label,
      error: null,
      notice: null,
      logs: pushLog(current.logs, label),
    }));

    const reporter = createShellReporter({
      setTask,
      verbose: options.verbose,
    });

    try {
      const result = await runner(reporter);
      setTask(current => ({
        ...current,
        busy: false,
        active: null,
        error: null,
      }));
      onSuccess?.(result);
    } catch (error) {
      const cliError = toCliError(error);
      setTask(current => ({
        ...current,
        busy: false,
        active: null,
        error: cliError.message,
        logs: pushLog(current.logs, cliError.message),
      }));
    }
  };

  const openTaskPanel = (panel: Omit<TaskPanelState, 'stepIndex'>) => {
    setTaskLookup({
      fieldKey: null,
      query: '',
      loading: false,
      items: [],
      error: null,
    });
    setTaskLookupIndex(0);
    setTaskCursorIndex(panel.fields[0]?.value.length ?? 0);
    activeTaskFieldKeyRef.current = null;
    setTaskPanel({
      ...panel,
      stepIndex: 0,
    });
  };

  const promptDefaultSlugForInitialSetup = (params: {
    normalizedEmail: string;
    suggestedSlug: string;
  }): Promise<{
    slug: string;
    publicDescription: string | null;
  }> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const settle = (handler: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        handler();
      };

      openTaskPanel({
        title: 'Confirm public slug',
        help: `Use the generated slug for ${params.normalizedEmail}, or edit it before continuing.`,
        submitLabel: 'Use slug',
        fields: [
          {
            key: 'slug',
            label: 'Slug',
            value: params.suggestedSlug,
            placeholder: params.suggestedSlug,
            validate: value =>
              normalizeInboxSlug(value) ? null : 'Enter a valid slug to continue.',
          },
          {
            key: 'publicDescription',
            label: 'Description',
            value: '',
            placeholder: 'optional public description',
            allowEmpty: true,
          },
        ],
        onCancel: () => {
          settle(() => reject(new Error('Slug confirmation cancelled.')));
        },
        onSubmit: async values => {
          setTaskPanel(null);
          setTaskCursorIndex(0);
          activeTaskFieldKeyRef.current = null;
          const publicDescription = values.publicDescription?.trim() || null;
          initialSetupPublicDescriptionRef.current = publicDescription;
          settle(() =>
            resolve({
              slug: values.slug.trim() || params.suggestedSlug,
              publicDescription,
            })
          );
        },
      });
    });

  const setMainRoute = (type: ShellRoute['type']) => {
    if (connectionState.mode !== 'ready' && type !== 'auth' && type !== 'help') {
      return;
    }
    setSidebarNavIndex(toSidebarSelectionIndex(type));
    setRoute({ type });
    setShellFocus('content');
  };

  const cycleActiveInbox = (direction: 1 | -1) => {
    if (!model || model.ownedInboxes.length <= 1) {
      return;
    }

    const currentIndex = model.ownedInboxes.findIndex(inbox => inbox.slug === model.activeInbox.slug);
    const nextIndex =
      (currentIndex + direction + model.ownedInboxes.length) % model.ownedInboxes.length;
    const nextInbox = model.ownedInboxes[nextIndex];
    if (!nextInbox) {
      return;
    }

    setActiveInboxSlug(nextInbox.slug);
    setSelectedAgentSlug(nextInbox.slug);
    setTask(current => ({
      ...current,
      notice: `Active agent set to ${nextInbox.slug}.`,
    }));
  };

  const confirmDuplicateDirectTitle = (params: {
    recipientSlug: string;
    title: string;
    onConfirm: () => Promise<void>;
  }): boolean => {
    if (!model) {
      return false;
    }
    const normalizedTitle = params.title.trim().toLowerCase();
    if (!normalizedTitle) {
      return false;
    }
    const hasMatchingThread = model.inboxes.threads.some(thread => {
      return (
        thread.participants.includes(params.recipientSlug) &&
        thread.label.trim().toLowerCase() === normalizedTitle
      );
    });
    if (!hasMatchingThread) {
      return false;
    }

    openTaskPanel({
      title: 'Thread title already exists',
      help:
        `A thread with ${params.recipientSlug} and title "${params.title.trim()}" already exists. ` +
        'Press Enter to create another anyway, or Esc to cancel.',
      submitLabel: 'Create anyway',
      fields: [],
      onSubmit: async () => {
        setTaskPanel(null);
        await params.onConfirm();
      },
    });
    return true;
  };

  const openDirectMessageTask = () => {
    openTaskPanel({
      title: 'Start direct message',
      help:
        'Enter a slug or email, optional thread title, then the first message. Suggestions include verified SaaS matches.',
      submitLabel: 'Send',
      fields: [
        {
          key: 'recipient',
          label: 'Recipient',
          value: '',
          placeholder: 'slug or email',
          lookup: {
            mode: 'inbox_lookup',
            tokenMode: 'single',
          },
        },
        {
          key: 'title',
          label: 'Thread title',
          value: '',
          placeholder: 'optional (defaults to recipient display)',
          allowEmpty: true,
        },
        {
          key: 'message',
          label: 'First message',
          value: '',
          placeholder: 'encrypted message body',
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model) {
          return;
        }
        const message = values.message;
        if (!message.trim()) {
          setTask(current => ({
            ...current,
            error: 'Message cannot be empty.',
          }));
          return;
        }
        const sendNewDirect = async () => {
          await performTask(
            `Sending message to ${values.recipient}`,
            reporter =>
              sendMessageToSlug({
                profileName: options.profile,
                actorSlug: model.activeInbox.slug,
                to: values.recipient,
                message,
                title: values.title.trim() || undefined,
                createNew: true,
                headerLines: [],
                reporter,
              }),
            result => {
              setRoute({ type: 'inboxes' });
              setInboxSection(result.sent ? 'threads' : 'pending');
              setSelectedInboxItemId(
                result.sent ? `thread:${result.threadId}` : `request:${result.requestId}`
              );
              if (result.sent) {
                setInboxFocus('detail');
                setOptimisticThreadMessagesByThreadId(current => ({
                  ...current,
                  [result.threadId]: [
                    ...(current[result.threadId] ?? []),
                    createOptimisticThreadMessage({
                      messageId: result.messageId,
                      threadSeq: result.threadSeq,
                      senderLabel: model.activeInbox.displayName?.trim() || model.activeInbox.slug,
                      body: values.message.trim(),
                    }),
                  ],
                }));
                resetThreadWindow();
              } else {
                setInboxFocus('navigator');
              }
              setLiveInboxRefreshToken(token => token + 1);
              setTask(current => ({
                ...current,
                notice: result.sent
                  ? `Sent to ${result.to.slug}.`
                  : `Contact request sent to ${result.to.slug}.`,
              }));
            }
          );
        };

        const recipientSlug = values.recipient.includes('@') ? null : values.recipient.trim() || null;
        if (
          recipientSlug &&
          confirmDuplicateDirectTitle({
            recipientSlug,
            title: values.title,
            onConfirm: sendNewDirect,
          })
        ) {
          return;
        }
        await sendNewDirect();
      },
    });
  };

  const openGroupTask = () => {
    openTaskPanel({
      title: 'Create group',
      help:
        'Add comma-separated participants, an optional title, and an optional first draft.',
      submitLabel: 'Create group',
      fields: [
        {
          key: 'participants',
          label: 'Participants',
          value: '',
          placeholder: 'slug-one, email@example.com',
          lookup: {
            mode: 'inbox_lookup',
            tokenMode: 'comma_list',
          },
        },
        {
          key: 'title',
          label: 'Title',
          value: '',
          placeholder: 'optional',
          allowEmpty: true,
        },
        {
          key: 'message',
          label: 'Initial message',
          value: '',
          placeholder: 'draft that will be loaded into the composer',
          allowEmpty: true,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model) {
          return;
        }
        const participants = parseCommaSeparated(values.participants);
        if (participants.length === 0) {
          setTask(current => ({
            ...current,
            error: 'Provide at least one participant slug or email.',
          }));
          return;
        }
        await performTask(
          'Creating group thread',
          reporter =>
            createGroupThread({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              participants,
              title: values.title || undefined,
              reporter,
            }),
          result => {
            if (values.message.trim()) {
              setThreadDrafts(current => ({
                ...current,
                [result.threadId]: values.message.trim(),
              }));
            }
            setRoute({ type: 'inboxes' });
            setInboxSection('threads');
            setSelectedInboxItemId(`thread:${result.threadId}`);
            setInboxFocus(values.message.trim() ? 'composer' : 'navigator');
            setTask(current => ({
              ...current,
              notice: values.message.trim()
                ? `Group created. Review the drafted first message for thread #${result.threadId}.`
                : `Created group thread #${result.threadId}.`,
            }));
          }
        );
      },
    });
  };

  const openCreateAgentTask = () => {
    openTaskPanel({
      title: 'Create agent',
      help: 'Create an owned agent with optional public profile details.',
      submitLabel: 'Create',
      fields: [
        {
          key: 'slug',
          label: 'Slug',
          value: '',
          placeholder: 'new-agent',
        },
        {
          key: 'displayName',
          label: 'Display name',
          value: '',
          placeholder: 'optional',
          allowEmpty: true,
        },
        {
          key: 'publicDescription',
          label: 'Description',
          value: '',
          placeholder: 'optional public description',
          allowEmpty: true,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        await performTask(
          `Creating inbox ${values.slug}`,
          reporter =>
            createInboxIdentity({
              profileName: options.profile,
              slug: values.slug,
              displayName: values.displayName || undefined,
              desiredPublicDescription: values.publicDescription || undefined,
              reporter,
            }),
          result => {
            setActiveInboxSlug(result.actor.slug);
            setSelectedAgentSlug(result.actor.slug);
            setRoute({ type: 'agents' });
            setPendingRegistrationPrompt(
              result.registration.status === 'skipped'
                ? {
                    slug: result.actor.slug,
                    publicDescription: values.publicDescription || null,
                  }
                : null
            );
            setPendingBackupPrompt(
              'New local keys were created. Export a backup from Account.'
            );
            setTask(current => ({
              ...current,
              notice:
                result.registration.status === 'skipped'
                  ? `Created agent ${result.actor.slug}. Press Enter to register it or N to skip.`
                  : describeManagedAgentRegistration({
                      slug: result.actor.slug,
                      status: result.registration.status,
                      error: result.registration.error,
                    }),
            }));
          }
        );
      },
    });
  };

  const openDiscoverSearchTask = () => {
    openTaskPanel({
      title: 'Discover agents',
      help:
        'Search verified agents, or leave it empty to browse registered agents.',
      submitLabel: 'Search',
      fields: [
        {
          key: 'query',
          label: 'Query',
          value: agentDiscovery.query,
          placeholder: 'slug, email, or display name',
          allowEmpty: true,
          lookup: {
            mode: 'saas_agent',
            tokenMode: 'single',
          },
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        const query = values.query.trim();
        await loadAgentDiscovery({
          query,
          page: 1,
          announce: true,
        });
      },
    });
  };

  const openDiscoverDetails = async (slug: string): Promise<void> => {
    setDiscoverDetail({
      status: 'loading',
      slug,
      detail: null,
      error: null,
    });

    try {
      const detail = await showDiscoveredAgent({
        profileName: options.profile,
        reporter: silentReporter(),
        identifier: slug,
        actorSlug: model?.activeInbox.slug ?? null,
      });
      setDiscoverDetail({
        status: 'ready',
        slug,
        detail,
        error: null,
      });
    } catch (error) {
      setDiscoverDetail({
        status: 'error',
        slug,
        detail: null,
        error: toCliError(error).message,
      });
    }
  };

  const openDirectMessageTaskForDiscoveredAgent = (target: { slug: string; displayName: string | null }) => {
    openTaskPanel({
      title: `Start direct message with ${target.slug}`,
      help: 'Send the first encrypted message to start a thread.',
      submitLabel: 'Send',
      fields: [
        {
          key: 'title',
          label: 'Thread title',
          value: target.displayName?.trim() ?? '',
          placeholder: 'optional (defaults to recipient display)',
          allowEmpty: true,
        },
        {
          key: 'message',
          label: 'First message',
          value: '',
          placeholder: 'encrypted message body',
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model) {
          return;
        }
        const message = values.message;
        if (!message.trim()) {
          setTask(current => ({
            ...current,
            error: 'Message cannot be empty.',
          }));
          return;
        }
        const sendNewDirect = async () => {
          await performTask(
            `Sending message to ${target.slug}`,
            reporter =>
              sendMessageToSlug({
                profileName: options.profile,
                actorSlug: model.activeInbox.slug,
                to: target.slug,
                message,
                title: values.title.trim() || undefined,
                createNew: true,
                headerLines: [],
                reporter,
              }),
            () => {
              setLiveInboxRefreshToken(token => token + 1);
              setTask(current => ({
                ...current,
                notice: `Started thread with ${target.slug}.`,
              }));
              setMainRoute('inboxes');
            }
          );
        };

        if (
          confirmDuplicateDirectTitle({
            recipientSlug: target.slug,
            title: values.title,
            onConfirm: sendNewDirect,
          })
        ) {
          return;
        }
        await sendNewDirect();
      },
    });
  };

  const openEditDescriptionTask = () => {
    if (!selectedAgent) {
      return;
    }

    openTaskPanel({
      title: `Public description for ${selectedAgent.slug}`,
      help: 'Edit the public description. Leave it empty to clear it.',
      submitLabel: 'Save',
      fields: [
        {
          key: 'description',
          label: 'Description',
          value: selectedAgent.publicDescription ?? '',
          placeholder: 'empty clears the description',
          allowEmpty: true,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        await performTask(
          `Updating public description for ${selectedAgent.slug}`,
          reporter =>
            setPublicDescription({
              profileName: options.profile,
              actorSlug: selectedAgent.slug,
              description: values.description,
              reporter,
            }),
          () => {
            setTask(current => ({
              ...current,
              notice: `Updated public description for ${selectedAgent.slug}.`,
            }));
          }
        );
      },
    });
  };

  const toggleLinkedEmailVisibility = async () => {
    if (!selectedAgent) {
      return;
    }

    await performTask(
      `${selectedAgent.publicLinkedEmailEnabled ? 'Hiding' : 'Showing'} linked email`,
      reporter =>
        setPublicLinkedEmailVisibility({
          profileName: options.profile,
          actorSlug: selectedAgent.slug,
          enabled: !selectedAgent.publicLinkedEmailEnabled,
          reporter,
        }),
      result => {
        setTask(current => ({
          ...current,
          notice: result.enabled
            ? `Linked email is now visible for ${result.slug}.`
            : `Linked email is now hidden for ${result.slug}.`,
        }));
      }
    );
  };

  const registerSelectedAgent = async () => {
    if (!selectedAgent) {
      return;
    }

    await performTask(
      `Syncing managed agent for ${selectedAgent.slug}`,
      reporter =>
        registerInboxAgent({
          profileName: options.profile,
          actorSlug: selectedAgent.slug,
          reporter,
          registrationMode: 'auto',
          desiredLinkedEmailVisibility: true,
          desiredPublicDescription: selectedAgent.publicDescription ?? undefined,
        }),
      result => {
        setTask(current => ({
          ...current,
          notice: describeManagedAgentRegistration({
            slug: result.actor.slug,
            status: result.registration.status,
            error: result.registration.error,
          }),
        }));
      }
    );
  };

  const openApproveShareTask = () => {
    openTaskPanel({
      title: 'Approve device share',
      help: 'Enter the share code from the other device.',
      submitLabel: 'Approve',
      fields: [
        {
          key: 'code',
          label: 'Share code',
          value: '',
          placeholder: 'ABCD-EFGH',
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        await performTask(
          `Approving device share ${values.code}`,
          reporter =>
            approveDeviceShare({
              profileName: options.profile,
              reporter,
              code: values.code,
            }),
          result => {
            setTask(current => ({
              ...current,
              notice: `Shared keys to device ${result.deviceId}.`,
            }));
          }
        );
      },
    });
  };

  const openBackupExportTask = () => {
    const defaultPath = defaultBackupFilePath(
      model?.activeInbox.publicIdentity ? normalizedEmail : normalizedEmail
    );

    openTaskPanel({
      title: 'Export encrypted backup',
      help:
        'Choose a file path and passphrase. Both passphrase fields must match.',
      submitLabel: 'Export',
      fields: [
        {
          key: 'filePath',
          label: 'File path',
          value: defaultPath,
          placeholder: defaultPath,
        },
        {
          key: 'passphrase',
          label: 'Passphrase',
          value: '',
          secret: true,
        },
        {
          key: 'confirmPassphrase',
          label: 'Confirm passphrase',
          value: '',
          secret: true,
          validate: (value, values) =>
            value !== values.passphrase ? 'Backup passphrases must match.' : null,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        await performTask(
          'Exporting encrypted backup',
          reporter =>
            backupInboxKeys({
              profileName: options.profile,
              filePath: values.filePath,
              passphrase: values.passphrase,
              reporter,
            }),
          result => {
            setPendingBackupPrompt(null);
            setTask(current => ({
              ...current,
              notice: `Encrypted backup saved to ${result.filePath}.`,
            }));
          }
        );
      },
    });
  };

  const openBackupImportTask = () => {
    openTaskPanel({
      title: 'Import encrypted backup',
      help: 'Enter the backup file path and passphrase.',
      submitLabel: 'Import',
      fields: [
        {
          key: 'filePath',
          label: 'File path',
          value: '',
          placeholder: '/path/to/backup.json',
        },
        {
          key: 'passphrase',
          label: 'Passphrase',
          value: '',
          secret: true,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        await performTask(
          'Importing encrypted backup',
          reporter =>
            restoreInboxKeys({
              profileName: options.profile,
              filePath: values.filePath,
              passphrase: values.passphrase,
              reporter,
              expectedNormalizedEmail: normalizedEmail || undefined,
            }),
          result => {
            setSecurityRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice: `Imported encrypted backup from ${result.filePath}.`,
            }));
          }
        );
      },
    });
  };

  const openRotateKeysTask = () => {
    const approvedDeviceIds =
      model?.account.devices
        .filter(device => device.status === 'approved')
        .map(device => device.deviceId)
        .join(', ') || 'no approved devices';

    openTaskPanel({
      title: 'Rotate agent keys',
      help: `Use comma-separated device ids. Approved: ${approvedDeviceIds}`,
      submitLabel: 'Rotate',
      fields: [
        {
          key: 'shareDeviceIds',
          label: 'Share to devices',
          value: '',
          placeholder: 'optional comma-separated device ids',
          allowEmpty: true,
        },
        {
          key: 'revokeDeviceIds',
          label: 'Revoke devices',
          value: '',
          placeholder: 'optional comma-separated device ids',
          allowEmpty: true,
        },
        {
          key: 'confirmation',
          label: 'Confirm',
          value: '',
          placeholder: 'type ROTATE',
          validate: value =>
            value !== 'ROTATE' ? 'Type ROTATE to confirm key rotation.' : null,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model) {
          return;
        }
        await performTask(
          `Rotating agent keys for ${model.activeInbox.slug}`,
          reporter =>
            rotateInboxKeys({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              shareDeviceIds: parseCommaSeparated(values.shareDeviceIds),
              revokeDeviceIds: parseCommaSeparated(values.revokeDeviceIds),
              reporter,
            }),
          result => {
            setPendingBackupPrompt(
              `Keys for ${result.actor.slug} were rotated. Export a new backup from Account > Security.`
            );
            setSecurityRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice:
                result.sharedDeviceIds.length > 0 || result.revokedDeviceIds.length > 0
                  ? `Keys rotated. Shared to ${result.sharedDeviceIds.length.toString()} device(s) and revoked ${result.revokedDeviceIds.length.toString()} device(s).`
                  : 'Keys rotated successfully.',
            }));
          }
        );
      },
    });
  };

  const executeSecurityAction = async () => {
    if (!selectedSecurityAction || !model) {
      return;
    }

    if (selectedSecurityAction.id === 'request-share') {
      await performTask(
        'Requesting device key share',
        async reporter => {
          await requestDeviceShare({
            profileName: options.profile,
            reporter,
          });
          return claimDeviceShare({
            profileName: options.profile,
            reporter,
          });
        },
        result => {
          setTask(current => ({
            ...current,
            banner: null,
            notice: result.imported
              ? `Recovered ${result.sharedKeyVersionCount.toString()} key version(s) from another device.`
              : 'No key share was approved before the request expired.',
          }));
          if (result.imported) {
            setSecurityRefreshToken(token => token + 1);
          }
        }
      );
      return;
    }
    if (selectedSecurityAction.id === 'approve-share') {
      openApproveShareTask();
      return;
    }
    if (selectedSecurityAction.id === 'import-backup') {
      openBackupImportTask();
      return;
    }
    if (selectedSecurityAction.id === 'export-backup') {
      openBackupExportTask();
      return;
    }
    if (selectedSecurityAction.id === 'rotate-keys') {
      openRotateKeysTask();
      return;
    }
    if (selectedSecurityAction.id === 'remove-local-keys') {
      await performTask(
        'Removing local keys',
        reporter =>
          removeLocalKeys({
            profileName: options.profile,
            reporter,
          }),
        () => {
          reconnect();
          setTask(current => ({
            ...current,
            banner: null,
            notice: 'Local keys removed. Signed out.',
          }));
          setRoute({ type: 'auth' });
        }
      );
      return;
    }
    if (selectedSecurityAction.id === 'logout') {
      await performTask(
        'Signing out',
        reporter =>
          logout({
            profileName: options.profile,
            reporter,
          }),
        () => {
          reconnect();
          setTask(current => ({
            ...current,
            banner: null,
            notice: 'Signed out (local keys kept).',
          }));
          setRoute({ type: 'auth' });
        }
      );
    }
  };

  useInput(async (input, key) => {
    if (key.ctrl && input === 'c') {
      onExit();
      exit();
      return;
    }

    if (task.busy && !taskPanel) {
      return;
    }

    if (!task.busy && pendingRegistrationPrompt) {
      const prompt = pendingRegistrationPrompt;

      if (input === 'q') {
        onExit();
        exit();
        return;
      }

      if (key.escape || input.toLowerCase() === 'n') {
        setPendingRegistrationPrompt(null);
        setTask(current => ({
          ...current,
          error: null,
          notice: 'Skipped managed agent registration for now. Press M in Agents to register later.',
        }));
        return;
      }

      if (input.toLowerCase() === 'y' || key.return) {
        const desiredPublicDescription =
          prompt.publicDescription?.trim() ||
          (activeActorRow?.slug === prompt.slug
            ? activeActorRow.publicDescription ?? undefined
            : undefined);

        setPendingRegistrationPrompt(null);
        await performTask(
          `Registering managed agent for ${prompt.slug}`,
          reporter =>
            registerInboxAgent({
              profileName: options.profile,
              actorSlug: prompt.slug,
              reporter,
              registrationMode: 'auto',
              desiredLinkedEmailVisibility: true,
              desiredPublicDescription,
            }),
          result => {
            setTask(current => ({
              ...current,
              notice: describeManagedAgentRegistration({
                slug: result.actor.slug,
                status: result.registration.status,
                error: result.registration.error,
              }),
            }));
          }
        );
        return;
      }

      if (input || key.return) {
        setTask(current => ({
          ...current,
          error: 'Press Y to register now or N to skip for now.',
        }));
      }
      return;
    }

    if (taskPanel) {
      const currentField = taskPanel.fields[taskPanel.stepIndex] ?? null;

      if (key.escape) {
        const onCancel = taskPanel.onCancel;
        setTaskPanel(null);
        setTaskCursorIndex(0);
        activeTaskFieldKeyRef.current = null;
        await onCancel?.();
        return;
      }

      if (taskLookup.items.length > 0 && (key.downArrow || key.upArrow)) {
        setTaskLookupIndex(current =>
          clampIndex(
            current + (key.downArrow ? 1 : -1),
            taskLookup.items.length
          )
        );
        return;
      }

      if (key.tab && currentField?.lookup && taskLookup.items.length > 0) {
        const selectedSuggestion =
          taskLookup.items[clampIndex(taskLookupIndex, taskLookup.items.length)] ?? null;
        if (!selectedSuggestion) {
          return;
        }
        const nextValue = applySuggestionValue({
          currentValue: currentField.value,
          suggestionValue: selectedSuggestion.value,
          tokenMode: currentField.lookup?.tokenMode ?? 'single',
        });

        setTaskPanel(current =>
          current
            ? {
                ...current,
                fields: current.fields.map(field =>
                  field.key === currentField.key
                    ? {
                        ...field,
                        value: nextValue,
                      }
                    : field
                ),
              }
            : current
        );
        setTaskCursorIndex(nextValue.length);
        setTask(current => ({
          ...current,
          error: null,
        }));
        return;
      }

      if (key.return) {
        if (!currentField) {
          await taskPanel.onSubmit({});
          return;
        }

        let resolvedCurrentValue = currentField.value;
        if (currentField.lookup && taskLookup.items.length > 0 && taskLookup.query.trim()) {
          const selectedSuggestion =
            taskLookup.items[clampIndex(taskLookupIndex, taskLookup.items.length)] ?? null;
          if (selectedSuggestion) {
            resolvedCurrentValue = applySuggestionValue({
              currentValue: currentField.value,
              suggestionValue: selectedSuggestion.value,
              tokenMode: currentField.lookup.tokenMode ?? 'single',
            });
            setTaskPanel(current =>
              current
                ? {
                    ...current,
                    fields: current.fields.map(field =>
                      field.key === currentField.key
                        ? {
                            ...field,
                            value: resolvedCurrentValue,
                          }
                        : field
                    ),
                  }
                : current
            );
          }
        }

        const trimmedValue = resolvedCurrentValue.trim();
        if (!trimmedValue && !currentField.allowEmpty) {
          setTask(current => ({
            ...current,
            error: `Enter ${currentField.label.toLowerCase()} to continue.`,
          }));
          return;
        }

        const values = Object.fromEntries(
          taskPanel.fields.map(field => [
            field.key,
            field.key === currentField.key
              ? trimmedValue
              : (field.allowEmpty ? field.value.trim() : field.value.trim()),
          ])
        );
        const validationError = currentField.validate?.(values[currentField.key] ?? '', values);
        if (validationError) {
          setTask(current => ({
            ...current,
            error: validationError,
          }));
          return;
        }

        if (taskPanel.stepIndex < taskPanel.fields.length - 1) {
          setTaskPanel(current =>
            current
              ? {
                  ...current,
                  stepIndex: current.stepIndex + 1,
                }
              : current
          );
          return;
        }

        await taskPanel.onSubmit(values);
        return;
      }

      if (key.backspace || key.delete) {
        if (!currentField) {
          return;
        }
        const cursor = clampCursor(taskCursorIndex, currentField.value.length);
        const shouldDeleteBackward =
          key.backspace || (key.delete && cursor >= currentField.value.length);
        if (shouldDeleteBackward && cursor === 0) {
          return;
        }
        if (!shouldDeleteBackward && cursor >= currentField.value.length) {
          return;
        }
        setTaskPanel(current =>
          current && currentField
            ? {
                ...current,
                fields: current.fields.map(field =>
                  field.key === currentField.key
                    ? {
                        ...field,
                        value: shouldDeleteBackward
                          ? field.value.slice(0, cursor - 1) + field.value.slice(cursor)
                          : field.value.slice(0, cursor) + field.value.slice(cursor + 1),
                      }
                    : field
                ),
              }
            : current
        );
        setTaskCursorIndex(current =>
          clampCursor(
            current + (shouldDeleteBackward ? -1 : 0),
            Math.max(0, currentField.value.length - 1)
          )
        );
        return;
      }

      if (key.leftArrow && currentField) {
        setTaskCursorIndex(current => clampCursor(current - 1, currentField.value.length));
        return;
      }

      if (key.rightArrow && currentField) {
        setTaskCursorIndex(current => clampCursor(current + 1, currentField.value.length));
        return;
      }

      if (!key.ctrl && !key.meta && input && currentField) {
        const cursor = clampCursor(taskCursorIndex, currentField.value.length);
        setTaskPanel(current =>
          current
            ? {
                ...current,
                fields: current.fields.map(field =>
                  field.key === currentField.key
                    ? {
                        ...field,
                        value: field.value.slice(0, cursor) + input + field.value.slice(cursor),
                      }
                    : field
                ),
              }
            : current
        );
        setTaskCursorIndex(current => current + input.length);
      }
      return;
    }

    if (route.type === 'inboxes' && inboxFocus === 'composer' && selectedThread) {
      const currentDraft = threadDrafts[selectedThread.id] ?? '';
      const draftCursor = clampCursor(
        threadDraftCursorByThreadId[selectedThread.id] ?? currentDraft.length,
        currentDraft.length
      );

      if (key.escape) {
        setInboxFocus('detail');
        return;
      }

      if ((key.ctrl && input === 's') || (key.ctrl && input === 'x')) {
        if (securityState.status !== 'healthy') {
          setTask(current => ({
            ...current,
            notice: 'Private keys missing. Recover keys in Account security before sending messages.',
          }));
          setRoute({ type: 'account' });
          setAccountFocus('security');
          setInboxFocus('detail');
          return;
        }
        if (!model) {
          return;
        }
        if (!currentDraft.trim()) {
          setTask(current => ({
            ...current,
            error: 'Message cannot be empty.',
          }));
          return;
        }
        await performTask(
          `Sending message to thread #${selectedThread.id}`,
          reporter =>
            sendMessageToThread({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              message: currentDraft.trim(),
              threadId: selectedThread.id,
              headerLines: [],
              reporter,
            }),
          result => {
            setThreadDrafts(current => ({
              ...current,
              [selectedThread.id]: '',
            }));
            setThreadDraftCursorByThreadId(current => ({
              ...current,
              [selectedThread.id]: 0,
            }));
            setOptimisticThreadMessagesByThreadId(current => ({
              ...current,
              [selectedThread.id]: [
                ...(current[selectedThread.id] ?? []),
                createOptimisticThreadMessage({
                  messageId: result.messageId,
                  threadSeq: result.threadSeq,
                  senderLabel: model.activeInbox.displayName?.trim() || model.activeInbox.slug,
                  body: currentDraft.trim(),
                }),
              ],
            }));
            resetThreadWindow();
            setLiveInboxRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice: 'Message sent.',
            }));
          }
        );
        return;
      }

      if (key.leftArrow) {
        setThreadDraftCursorByThreadId(current => ({
          ...current,
          [selectedThread.id]: clampCursor(draftCursor - 1, currentDraft.length),
        }));
        return;
      }

      if (key.rightArrow) {
        setThreadDraftCursorByThreadId(current => ({
          ...current,
          [selectedThread.id]: clampCursor(draftCursor + 1, currentDraft.length),
        }));
        return;
      }

      if (key.return) {
        setThreadDrafts(current => ({
          ...current,
          [selectedThread.id]:
            currentDraft.slice(0, draftCursor) + '\n' + currentDraft.slice(draftCursor),
        }));
        setThreadDraftCursorByThreadId(current => ({
          ...current,
          [selectedThread.id]: draftCursor + 1,
        }));
        return;
      }

      if (key.backspace || key.delete) {
        if (key.backspace && draftCursor === 0) {
          return;
        }
        const atEnd = draftCursor >= currentDraft.length;
        if (key.delete && atEnd && draftCursor === 0) {
          return;
        }
        const shouldDeletePrevious = key.backspace || (key.delete && atEnd);
        setThreadDrafts(current => ({
          ...current,
          [selectedThread.id]: shouldDeletePrevious
            ? currentDraft.slice(0, draftCursor - 1) + currentDraft.slice(draftCursor)
            : currentDraft.slice(0, draftCursor) + currentDraft.slice(draftCursor + 1),
        }));
        setThreadDraftCursorByThreadId(current => ({
          ...current,
          [selectedThread.id]: shouldDeletePrevious ? draftCursor - 1 : draftCursor,
        }));
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        setThreadDrafts(current => ({
          ...current,
          [selectedThread.id]:
            currentDraft.slice(0, draftCursor) + input + currentDraft.slice(draftCursor),
        }));
        setThreadDraftCursorByThreadId(current => ({
          ...current,
          [selectedThread.id]: draftCursor + input.length,
        }));
      }
      return;
    }

    if (input === 'q') {
      onExit();
      exit();
      return;
    }

    if (input.toLowerCase() === 'r' || (key.ctrl && input.toLowerCase() === 'r')) {
      reconnect();
      setTask(current => ({
        ...current,
        notice: 'Reconnecting to SpacetimeDB...',
      }));
      return;
    }

    if (input === '?') {
      setRoute({ type: 'help' });
      return;
    }

    if (route.type === 'help') {
      if (key.escape || key.return) {
        setRoute({
          type: connectionState.mode === 'ready' ? 'inboxes' : 'auth',
        });
      }
      return;
    }

    if (connectionState.mode === 'signed_out' || route.type === 'auth') {
      if (input === 'l') {
        await performTask(
          'Signing in',
          reporter => {
            initialSetupPublicDescriptionRef.current = null;
            return login({
              profileName: options.profile,
              reporter,
              registrationMode: 'skip',
              confirmDefaultSlug: promptDefaultSlugForInitialSetup,
              waitForEnter: async () => {},
            });
          },
          result => {
            reconnect();
            setPendingRegistrationPrompt(
              result.agentRegistration.status === 'skipped'
                ? {
                    slug: result.actor.slug,
                    publicDescription: initialSetupPublicDescriptionRef.current,
                  }
                : null
            );
            setTask(current => ({
              ...current,
              notice: result.recoveryRequired
                ? 'Authenticated. Recover private keys from another device or backup before sending messages. Press [U] for Account security now.'
                : result.agentRegistration.status === 'skipped'
                  ? 'Authenticated and account synced. Press Enter to register the managed agent or N to skip.'
                  : describeManagedAgentRegistration({
                      slug: result.actor.slug,
                      status: result.agentRegistration.status,
                      error: result.agentRegistration.error,
                    }),
            }));
            setRoute(result.recoveryRequired ? { type: 'account' } : { type: 'inboxes' });
          }
        );
        return;
      }

      if (input === 'v') {
        openTaskPanel({
          title: 'Verification email',
          help: 'Enter the email to receive the verification link.',
          submitLabel: 'Send',
          fields: [
            {
              key: 'email',
              label: 'Email',
              value: '',
              placeholder: 'you@example.com',
            },
          ],
          onSubmit: async values => {
            setTaskPanel(null);
            await performTask(
              `Requesting verification email for ${values.email}`,
              reporter =>
                requestVerificationEmailForIssuer({
                  profileName: options.profile,
                  email: values.email,
                  reporter,
                }),
              () => {
                setTask(current => ({
                  ...current,
                  notice: 'Verification email requested.',
                }));
              }
            );
          },
        });
        return;
      }

      if (input === 's') {
        await performTask(
          'Checking account status',
          reporter =>
            authStatus({
              profileName: options.profile,
              reporter,
            }),
          result => {
            setTask(current => ({
              ...current,
              notice: result.authenticated
                ? `Signed in as ${result.email ?? result.subject ?? 'unknown'}.`
                : 'No active login session.',
            }));
          }
        );
      }
      return;
    }

    if (!model) {
      return;
    }

    if (key.tab) {
      setShellFocus(current => current === 'sidebar' ? 'content' : 'sidebar');
      return;
    }

    if (key.escape) {
      if (route.type === 'inboxes' && inboxFocus === 'composer') {
        setInboxFocus('detail');
        return;
      }
      if (shellFocus === 'content') {
        setShellFocus('sidebar');
      }
      return;
    }

    if (shellFocus === 'sidebar') {
      const currentSidebarIndex = clampIndex(sidebarNavIndex, SIDEBAR_NAV_ITEMS.length);
      const sidebarShortcut = input.toLowerCase();
      if (sidebarShortcut === 'i') {
        setMainRoute('inboxes');
        return;
      }
      if (sidebarShortcut === 'a') {
        setMainRoute('agents');
        return;
      }
      if (sidebarShortcut === 'd') {
        setMainRoute('discover');
        return;
      }
      if (sidebarShortcut === 'u') {
        setMainRoute('account');
        return;
      }
      if (key.downArrow) {
        const nextIndex = (currentSidebarIndex + 1) % SIDEBAR_NAV_ITEMS.length;
        setSidebarNavIndex(nextIndex);
        return;
      }
      if (key.upArrow) {
        const nextIndex = (currentSidebarIndex - 1 + SIDEBAR_NAV_ITEMS.length) % SIDEBAR_NAV_ITEMS.length;
        setSidebarNavIndex(nextIndex);
        return;
      }
      if (key.return) {
        const selectedRoute = SIDEBAR_NAV_ITEMS[currentSidebarIndex];
        if (selectedRoute) {
          setMainRoute(selectedRoute);
        }
        return;
      }
      if (key.rightArrow) {
        setShellFocus('content');
        return;
      }
      return;
    }

    if (route.type === 'inboxes') {
      if (inboxFocus === 'detail' && selectedThread) {
        if (key.escape) {
          setInboxFocus('navigator');
          return;
        }
        if (key.return) {
          if (securityState.status !== 'healthy') {
            setTask(current => ({
              ...current,
              notice: 'Private keys missing. Recover keys in Account security before sending messages.',
            }));
            setRoute({ type: 'account' });
            setAccountFocus('security');
            return;
          }
          resetThreadWindow();
          setInboxFocus('composer');
          return;
        }
        if (input === 'e') {
          if (securityState.status !== 'healthy') {
            setTask(current => ({
              ...current,
              notice: 'Private keys missing. Recover keys in Account security before sending messages.',
            }));
            setRoute({ type: 'account' });
            setAccountFocus('security');
            return;
          }
          resetThreadWindow();
          setInboxFocus('composer');
          return;
        }
        if (input === 'm') {
          await performTask(
            `Marking thread #${selectedThread.id} as read`,
            reporter =>
              markThreadRead({
                profileName: options.profile,
                actorSlug: model.activeInbox.slug,
                threadId: selectedThread.id,
                reporter,
              }),
            () => {
              setLiveInboxRefreshToken(token => token + 1);
              setTask(current => ({
                ...current,
                notice: `Marked thread #${selectedThread.id} as read.`,
              }));
            }
          );
          return;
        }
        return;
      }
      if (key.leftArrow) {
        const sections: InboxSectionKey[] = ['threads', 'pending', 'archived'];
        const index = sections.indexOf(inboxSection);
        setInboxSection(sections[(index - 1 + sections.length) % sections.length]!);
        setInboxFocus('navigator');
        return;
      }
      if (key.rightArrow) {
        const sections: InboxSectionKey[] = ['threads', 'pending', 'archived'];
        const index = sections.indexOf(inboxSection);
        setInboxSection(sections[(index + 1) % sections.length]!);
        setInboxFocus('navigator');
        return;
      }
      if (input === '[') {
        cycleActiveInbox(-1);
        return;
      }
      if (input === ']') {
        cycleActiveInbox(1);
        return;
      }
      if (input === 'f') {
        setThreadFilter(current =>
          current === 'all' ? 'unread' : current === 'unread' ? 'direct' : 'all'
        );
        return;
      }
      if (key.downArrow) {
        const next = inboxSectionItems[clampIndex(selectedInboxIndex + 1, inboxSectionItems.length)];
        if (next) {
          setSelectedInboxItemId(next.id);
        }
        return;
      }
      if (key.upArrow) {
        const next = inboxSectionItems[clampIndex(selectedInboxIndex - 1, inboxSectionItems.length)];
        if (next) {
          setSelectedInboxItemId(next.id);
        }
        return;
      }
      if (key.return) {
        if (selectedThread) {
          resetThreadWindow();
          setInboxFocus('detail');
        }
        return;
      }
      if (input === 'n') {
        openDirectMessageTask();
        return;
      }
      if (input === 'g') {
        openGroupTask();
        return;
      }
      if (input === 'm' && selectedThread) {
        await performTask(
          `Marking thread #${selectedThread.id} as read`,
          reporter =>
            markThreadRead({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              threadId: selectedThread.id,
              reporter,
            }),
          () => {
            setLiveInboxRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice: `Marked thread #${selectedThread.id} as read.`,
            }));
          }
        );
        return;
      }
      if (input === 'z' && selectedThread && inboxFocus === 'navigator') {
        await performTask(
          `${selectedThread.archived ? 'Restoring' : 'Archiving'} thread #${selectedThread.id}`,
          reporter =>
            setThreadArchived({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              threadId: selectedThread.id,
              archived: !selectedThread.archived,
              reporter,
            }),
          result => {
            setLiveInboxRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice: result.archived ? 'Thread archived.' : 'Thread restored.',
            }));
          }
        );
        return;
      }
      if (input === 'a' && selectedRequest?.direction === 'incoming') {
        await performTask(
          `Approving request #${selectedRequest.id}`,
          reporter =>
            resolveContactRequest({
              profileName: options.profile,
              requestId: selectedRequest.id,
              action: 'approve',
              reporter,
            }),
          () => {
            setLiveInboxRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice: `Approved request #${selectedRequest.id}.`,
            }));
          }
        );
        return;
      }
      if (input === 'x' && selectedRequest?.direction === 'incoming') {
        await performTask(
          `Rejecting request #${selectedRequest.id}`,
          reporter =>
            resolveContactRequest({
              profileName: options.profile,
              requestId: selectedRequest.id,
              action: 'reject',
              reporter,
            }),
          () => {
            setLiveInboxRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice: `Rejected request #${selectedRequest.id}.`,
            }));
          }
        );
        return;
      }
      if (input === '+' && selectedThread) {
        openTaskPanel({
          title: 'Add participant',
          help:
            'Enter a slug or email to add. Suggestions include verified SaaS matches.',
          submitLabel: 'Add',
          fields: [
            {
              key: 'participant',
              label: 'Participant',
              value: '',
              placeholder: 'slug or email',
              lookup: {
                mode: 'inbox_lookup',
                tokenMode: 'single',
              },
            },
          ],
          onSubmit: async values => {
            setTaskPanel(null);
            await performTask(
              `Adding ${values.participant} to thread #${selectedThread.id}`,
              reporter =>
                addThreadParticipant({
                  profileName: options.profile,
                  actorSlug: model.activeInbox.slug,
                  threadId: selectedThread.id,
                  participant: values.participant,
                  reporter,
                }),
              result => {
                setLiveInboxRefreshToken(token => token + 1);
                setTask(current => ({
                  ...current,
                notice: `Added ${result.participant} to thread.`,
                }));
              }
            );
          },
        });
        return;
      }
      if (input === '-' && selectedThread) {
        openTaskPanel({
          title: 'Remove participant',
          help: 'Enter the agent slug to remove.',
          submitLabel: 'Remove',
          fields: [
            {
              key: 'participant',
              label: 'Participant',
              value: '',
              placeholder: 'slug',
            },
          ],
          onSubmit: async values => {
            setTaskPanel(null);
            await performTask(
              `Removing ${values.participant} from thread #${selectedThread.id}`,
              reporter =>
                removeThreadParticipant({
                  profileName: options.profile,
                  actorSlug: model.activeInbox.slug,
                  threadId: selectedThread.id,
                  participant: values.participant,
                  reporter,
                }),
              result => {
                setLiveInboxRefreshToken(token => token + 1);
                setTask(current => ({
                  ...current,
                notice: `Removed ${result.participant} from thread.`,
                }));
              }
            );
          },
        });
      }
      return;
    }

    if (route.type === 'agents') {
      if (key.downArrow) {
        const next =
          model.agents.agentSummaries[
            clampIndex(selectedAgentIndex + 1, model.agents.agentSummaries.length)
          ];
        if (next) {
          setSelectedAgentSlug(next.slug);
        }
        return;
      }
      if (key.upArrow) {
        const next =
          model.agents.agentSummaries[
            clampIndex(selectedAgentIndex - 1, model.agents.agentSummaries.length)
          ];
        if (next) {
          setSelectedAgentSlug(next.slug);
        }
        return;
      }
      if (key.return) {
        if (selectedAgent) {
          setActiveInboxSlug(selectedAgent.slug);
          setTask(current => ({
            ...current,
            notice: `Active agent set to ${selectedAgent.slug}.`,
          }));
        }
        return;
      }
      if (input === 'n') {
        openCreateAgentTask();
        return;
      }
      if (input === 'p') {
        openEditDescriptionTask();
        return;
      }
      if (input === 'l') {
        await toggleLinkedEmailVisibility();
        return;
      }
      if (input === 'm') {
        await registerSelectedAgent();
      }
      return;
    }

    if (route.type === 'discover') {
      if (key.downArrow) {
        setSelectedDiscoveryIndex(current =>
          clampIndex(current + 1, agentDiscovery.results.length)
        );
        return;
      }
      if (key.upArrow) {
        setSelectedDiscoveryIndex(current =>
          clampIndex(current - 1, agentDiscovery.results.length)
        );
        return;
      }
      if (input === '[') {
        await changeAgentDiscoveryPage(-1);
        return;
      }
      if (input === ']') {
        await changeAgentDiscoveryPage(1);
        return;
      }
      if ((input && input.toLowerCase() === 's') || input === '/') {
        openDiscoverSearchTask();
        return;
      }
      if (input && input.toLowerCase() === 'n' && selectedDiscoveryResult) {
        openDirectMessageTaskForDiscoveredAgent({
          slug: selectedDiscoveryResult.slug,
          displayName: selectedDiscoveryResult.displayName ?? null,
        });
        return;
      }
      if (key.return) {
        if (selectedDiscoveryResult) {
          await openDiscoverDetails(selectedDiscoveryResult.slug);
        }
        return;
      }
      return;
    }

    if (route.type === 'account') {
      if (key.leftArrow) {
        setAccountFocus(current => (current === 'security' ? 'devices' : 'security'));
        return;
      }
      if (key.rightArrow) {
        setAccountFocus(current => (current === 'security' ? 'devices' : 'security'));
        return;
      }
      if (accountFocus === 'security') {
        if (key.downArrow) {
          setSecurityActionIndex(current => clampIndex(current + 1, securityActions.length));
          return;
        }
        if (key.upArrow) {
          setSecurityActionIndex(current => clampIndex(current - 1, securityActions.length));
          return;
        }
        if (key.return) {
          await executeSecurityAction();
        }
        return;
      }

      if (key.downArrow) {
        setDeviceSelection(current => clampIndex(current + 1, model.account.devices.length));
        return;
      }
      if (key.upArrow) {
        setDeviceSelection(current => clampIndex(current - 1, model.account.devices.length));
        return;
      }
      if (input === 'x' && selectedDevice) {
        await performTask(
          `Revoking device ${selectedDevice.deviceId}`,
          reporter =>
            revokeDeviceShareAccess({
              profileName: options.profile,
              reporter,
              deviceId: selectedDevice.deviceId,
            }),
          () => {
            setTask(current => ({
              ...current,
              notice: `Revoked device ${selectedDevice.deviceId}.`,
            }));
          }
        );
      }
    }
  });

  const connectionLabel =
    connectionState.mode === 'ready'
      ? connectionState.connection
      : connectionState.connection === 'signed_out'
        ? 'signed_out'
        : 'connecting';
  const connectionDotColor =
    connectionLabel === 'live'
      ? 'green'
      : connectionLabel === 'reconnecting' || connectionLabel === 'connecting'
        ? 'yellow'
        : connectionLabel === 'signed_out'
          ? 'gray'
          : 'red';
  const selectedSecurityActionLabel = selectedSecurityAction?.label ?? 'No action selected';
  const selectedSidebarNav =
    SIDEBAR_NAV_ITEMS[clampIndex(sidebarNavIndex, SIDEBAR_NAV_ITEMS.length)] ?? 'inboxes';

  const sectionTitle =
    route.type === 'inboxes'
      ? 'Inbox'
      : route.type === 'agents'
        ? 'My Agents'
        : route.type === 'discover'
          ? 'Discover'
        : route.type === 'account'
          ? 'Account'
          : route.type === 'help'
            ? 'Help'
            : '';
  const sectionIcon =
    route.type === 'inboxes'
      ? '[i]'
      : route.type === 'agents'
        ? '[a]'
        : route.type === 'discover'
          ? '[d]'
          : route.type === 'account'
            ? '[u]'
            : route.type === 'help'
              ? '[?]'
              : '';

  const contentHeader = (
    <Box flexDirection="column">
      <Text>
        {sectionIcon ? <Text color="gray">{sectionIcon} </Text> : null}
        <Text color="cyan" bold>{sectionTitle}</Text>
        {model ? (
          <>
            <Text color="gray"> · </Text>
            <Text>{model.activeInbox.slug}</Text>
          </>
        ) : null}
      </Text>
      <Text color="gray" dimColor>{'─'.repeat(Math.min((process.stdout.columns || 80) - 22, 58))}</Text>
    </Box>
  );

  const statusBar = (
    <Box flexDirection="column">
      {taskPanel ? (
        <TaskPanel
          panel={taskPanel}
          lookupState={taskLookup}
          selectedLookupIndex={taskLookupIndex}
          cursorIndex={taskCursorIndex}
        />
      ) : null}
      {pendingRegistrationPrompt ? (
        <Box borderStyle="single" borderColor="yellow" paddingLeft={1} paddingRight={1} flexDirection="column">
          <Text>
            Register managed agent for <Text color="yellowBright">{pendingRegistrationPrompt.slug}</Text> now?
          </Text>
          <Text color="gray">This publishes the inbox agent for Masumi SaaS discovery.</Text>
          {pendingRegistrationPrompt.publicDescription ? (
            <Text color="gray">Description will be published with this agent.</Text>
          ) : null}
          <Text color="yellow">Enter/Y yes · N later</Text>
        </Box>
      ) : null}
      {task.banner ? (
        <Box borderStyle="single" borderColor="yellow" paddingLeft={1} paddingRight={1} flexDirection="column">
          <Text>{task.banner.label ?? 'Code'}: <Text color="yellowBright">{task.banner.code}</Text></Text>
          <Text color="gray">{task.banner.hint}</Text>
        </Box>
      ) : null}
      {task.active ? <Text color="yellow">⠋ {task.active}</Text> : null}
      {task.notice ? <Text color="green">✓ {task.notice}</Text> : null}
      {task.error ? <Text color="red">✗ {task.error}</Text> : null}
      {connectionState.error ? <Text color="red">{connectionState.error}</Text> : null}
    </Box>
  );

  const footerMode: FooterMode = (() => {
    if (taskPanel) {
      const currentField = taskPanel.fields[taskPanel.stepIndex] ?? null;
      const isLastField = taskPanel.stepIndex >= taskPanel.fields.length - 1;
      return {
        label: 'Form input',
        detail: taskPanel.title,
        items: [
          { key: 'Type', label: currentField ? `edit ${currentField.label.toLowerCase()}` : 'review' },
          ...(taskLookup.items.length > 0
            ? [
                { key: '↑/↓', label: 'choose suggestion' },
                { key: 'Tab', label: 'accept suggestion' },
              ]
            : []),
          {
            key: 'Enter',
            label:
              currentField && !isLastField
                ? 'next field'
                : taskPanel.submitLabel.toLowerCase(),
          },
          { key: 'Esc', label: 'cancel' },
        ],
      };
    }

    if (task.busy) {
      return {
        label: 'Working',
        detail: task.active ?? undefined,
        items: [],
      };
    }

    if (pendingRegistrationPrompt) {
      return {
        label: 'Managed agent prompt',
        detail: pendingRegistrationPrompt.slug,
        items: [
          { key: 'Y', label: 'register now' },
          { key: 'N/Esc', label: 'skip for now' },
          { key: 'Q', label: 'quit' },
        ],
      };
    }

    if (connectionState.mode === 'loading') {
      return {
        label: 'Connecting',
        detail: connectionLabel,
        items: [
          { key: 'R', label: 'reconnect' },
          { key: 'Q', label: 'quit' },
        ],
      };
    }

    if (connectionState.mode === 'signed_out' || route.type === 'auth') {
      return {
        label: 'Signed out',
        items: [
          { key: 'L', label: 'sign in' },
          { key: 'V', label: 'verification email' },
          { key: 'S', label: 'account status' },
          { key: 'Q', label: 'quit' },
        ],
      };
    }

    if (!model) {
      return {
        label: 'Loading shell',
        items: [],
      };
    }

    if (route.type === 'help') {
      return {
        label: 'Help',
        detail: 'reference',
        items: [
          { key: 'Esc', label: 'close help' },
          { key: 'Tab', label: 'sidebar' },
          { key: 'Q', label: 'quit' },
        ],
      };
    }

    if (shellFocus === 'sidebar') {
      return {
        label: 'Sidebar navigation',
        detail: SIDEBAR_LABELS[selectedSidebarNav],
        items: [
          { key: '↑/↓', label: 'select section' },
          { key: 'I/A/D/U', label: 'open by hotkey' },
          { key: 'Enter', label: 'open selected' },
          { key: '→', label: 'content focus' },
          { key: 'Tab', label: 'content' },
          { key: 'Q', label: 'quit' },
        ],
      };
    }

    if (route.type === 'inboxes') {
      if (inboxFocus === 'composer' && selectedThread) {
        return {
          label: 'Compose message',
          detail: selectedThread.label,
          items: [
            { key: 'Type', label: 'edit draft' },
            { key: 'Enter', label: 'new line' },
            { key: 'Ctrl+S/X', label: 'send' },
            { key: 'Esc', label: 'thread' },
          ],
        };
      }

      if (inboxFocus === 'detail' && selectedThread) {
        return {
          label: 'Thread viewer',
          detail: selectedThread.label,
          items: [
            { key: 'Enter/E', label: 'compose' },
            { key: 'M', label: 'mark read' },
            { key: 'Esc', label: 'thread list' },
          ],
        };
      }

      if (inboxSection === 'pending' && selectedRequest) {
        return {
          label: 'Pending request',
          detail:
            selectedRequest.direction === 'incoming'
              ? selectedRequest.requesterDisplayName ?? selectedRequest.requesterSlug
              : selectedRequest.targetDisplayName ?? selectedRequest.targetSlug,
          items: [
            { key: '↑/↓', label: 'move requests' },
            ...(selectedRequest.direction === 'incoming'
              ? [{ key: 'A/X', label: 'approve/reject' }]
              : []),
            { key: '←/→', label: 'section' },
            { key: '[ ]', label: 'agent' },
            { key: 'Tab', label: 'sidebar' },
          ],
        };
      }

      return {
        label: 'Inbox navigator',
        detail: `${inboxSection} · ${threadFilter}`,
        items: [
          { key: '↑/↓', label: 'move threads' },
          { key: 'Enter', label: selectedThread ? 'open thread' : 'select' },
          ...(selectedThread ? [{ key: 'M', label: 'mark read' }] : []),
          ...(selectedThread ? [{ key: 'Z', label: selectedThread.archived ? 'restore' : 'archive' }] : []),
          ...(selectedThread ? [{ key: '+/-', label: 'participants' }] : []),
          { key: 'F', label: 'filter' },
          { key: '←/→', label: 'section' },
          { key: '[ ]', label: 'agent' },
          { key: 'N/G', label: 'new DM/group' },
          { key: 'Tab', label: 'sidebar' },
        ],
      };
    }

    if (route.type === 'agents') {
      return {
        label: 'My agents',
        detail: selectedAgent?.slug ?? undefined,
        items: [
          { key: '↑/↓', label: 'move agents' },
          { key: 'Enter', label: 'set active' },
          { key: 'N', label: 'create agent' },
          { key: 'P', label: 'description' },
          { key: 'L', label: 'linked email' },
          { key: 'M', label: 'register/sync' },
          { key: 'Tab', label: 'sidebar' },
        ],
      };
    }

    if (route.type === 'discover') {
      return {
        label: 'Agent discovery',
        detail: agentDiscovery.query || 'browse',
        items: [
          { key: '↑/↓', label: 'move results' },
          { key: 'Enter', label: 'open details' },
          { key: 'S//', label: 'search' },
          ...(selectedDiscoveryResult ? [{ key: 'N', label: 'new thread' }] : []),
          { key: '[ ]', label: 'page' },
          { key: 'Tab', label: 'sidebar' },
        ],
      };
    }

    if (route.type === 'account') {
      return {
        label: accountFocus === 'security' ? 'Account security' : 'Trusted devices',
        detail: accountFocus === 'security' ? selectedSecurityActionLabel : selectedDevice?.deviceId,
        items: [
          { key: '←/→', label: 'switch tab' },
          { key: '↑/↓', label: accountFocus === 'security' ? 'move actions' : 'move devices' },
          ...(accountFocus === 'security'
            ? [{ key: 'Enter', label: 'run action' }]
            : [{ key: 'X', label: 'revoke device' }]),
          { key: 'Tab', label: 'sidebar' },
        ],
      };
    }

    return {
      label: 'Shell',
      items: [
        { key: 'Tab', label: 'sidebar' },
        { key: '?', label: 'help' },
        { key: 'Q', label: 'quit' },
      ],
    };
  })();

  if (connectionState.mode === 'loading') {
    return (
      <Box flexDirection="column">
        {statusBar}
        <ModeBar mode={footerMode} />
      </Box>
    );
  }

  if (connectionState.mode === 'signed_out' || route.type === 'auth') {
    return (
      <Box flexDirection="column">
        <Text color="gray" dimColor>{'─'.repeat(Math.min(process.stdout.columns || 80, 80))}</Text>
        <Text> </Text>
        <Text color="yellow">You are signed out.</Text>
        <Text color="gray">Sign in to sync, recover keys, and manage devices.</Text>
        <Text> </Text>
        {statusBar}
        <ModeBar mode={footerMode} />
      </Box>
    );
  }

  if (!model) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Loading shell state...</Text>
        {statusBar}
        <ModeBar mode={footerMode} />
      </Box>
    );
  }

  const attentionItems = model.dashboard.attentionItems;

  return (
    <Box flexDirection="row">
      <Sidebar
        active={route.type}
        selectedNav={selectedSidebarNav}
        slug={model.activeInbox.slug}
        connectionLabel={connectionLabel}
        connectionDotColor={connectionDotColor}
        unreadCount={model.unreadCount}
        pendingCount={model.pendingRequestCount}
        shellFocus={shellFocus}
      />
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {contentHeader}

        {attentionItems.length > 0 && route.type === 'inboxes' ? (
          <Box flexDirection="column">
            {attentionItems.map(item => (
              <Text key={item.id} color={item.severity === 'critical' ? 'red' : 'yellow'}>
                {item.severity === 'critical' ? '✗' : '⚠'} {item.title}
                {item.id.startsWith('security:') ? ' · Press [U] to recover now.' : null}
              </Text>
            ))}
          </Box>
        ) : null}

        {route.type === 'help' ? (
          <Box flexDirection="column">
            <Text>  <Text color="cyan" bold>Inbox</Text> — threads, pending requests, message composition</Text>
            <Text>  <Text color="cyan" bold>My Agents</Text> — owned agents, profile, managed agent sync</Text>
            <Text>  <Text color="cyan" bold>Discover</Text> — browse verified SaaS agents and search by slug or email</Text>
            <Text>  <Text color="cyan" bold>Account</Text> — recovery, backups, trusted devices, rotation</Text>
            <Text> </Text>
            <Text color="gray">  Tab moves between content and sidebar. In sidebar, ↑/↓ selects and Enter opens.</Text>
            <Text color="gray">  In thread detail, Enter opens compose. In compose, Enter adds a line and Ctrl+S sends.</Text>
            <Text color="gray">  The footer always shows the current mode and the keys that work there.</Text>
          </Box>
        ) : null}

        {route.type === 'inboxes' ? (
          <Box flexDirection="column">
            <Text color="gray">
              section <Text color="white">{inboxSection}</Text>
              <Text color="gray"> · filter </Text>
              <Text color="white">{threadFilter}</Text>
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text color={inboxFocus === 'navigator' ? 'cyan' : 'white'}>◆ Navigator</Text>
              {renderList({
                items: inboxSectionItems.map(item => `${item.label} · ${item.subtitle}`),
                selectedIndex: selectedInboxIndex,
                empty:
                  inboxSection === 'pending'
                    ? 'No pending requests for this agent.'
                    : 'No threads match this section and filter.',
              })}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={inboxFocus === 'detail' || inboxFocus === 'composer' ? 'cyan' : 'white'}>
                ◆ Thread
              </Text>
              {selectedRequest ? (
                <Box flexDirection="column">
                  <Text>
                    <Text bold>
                      {selectedRequest.direction === 'incoming'
                        ? selectedRequest.requesterDisplayName ?? selectedRequest.requesterSlug
                        : selectedRequest.targetDisplayName ?? selectedRequest.targetSlug}
                    </Text>
                    <Text color="gray"> · {selectedRequest.direction}</Text>
                  </Text>
                  <Text color="gray">
                    {selectedRequest.messageCount} message(s) · updated {formatTimestamp(selectedRequest.updatedAt)}
                  </Text>
                  {firstThreadMessage ? (
                    <Text>
                      First message: <Text color="white">{capTextLines(firstThreadMessage.body, MAX_MESSAGE_BODY_LINES)}</Text>
                    </Text>
                  ) : (
                    <Text color="gray">No visible message preview yet.</Text>
                  )}
                </Box>
              ) : selectedThread ? (
                <Box flexDirection="column">
                  <Text>
                    <Text bold>{selectedThread.label}</Text>
                    <Text color="gray"> · {selectedThread.participantCount.toString()} participants</Text>
                    {selectedThread.locked ? <Text color="gray"> · locked</Text> : null}
                  </Text>
                  <Text color="gray">
                    Messages {totalThreadMessages === 0 ? '0-0' : `${(threadWindowStart + 1).toString()}-${threadWindowEnd.toString()}`} of {totalThreadMessages.toString()}
                  </Text>
                  {threadMessagesError ? <Text color="red">✗ {threadMessagesError}</Text> : null}
                  {threadMessages.length > 0 ? (
                    threadMessages.map(message => (
                      <Box key={message.id} flexDirection="column" marginBottom={1}>
                        <Text>
                          <Text color={senderInkColor(message.senderLabel)} bold>{message.senderLabel}</Text>
                          <Text color="gray">
                            {' · '}
                            {formatTimestamp(message.createdAt)}
                            {message.optimistic ? ' · syncing…' : ''}
                          </Text>
                        </Text>
                          <Text>
                            {capTextLines(message.body, MAX_MESSAGE_BODY_LINES)}
                          </Text>
                      </Box>
                    ))
                  ) : (
                    <Text color="gray">No visible messages yet.</Text>
                  )}
                  <Box marginTop={1} flexDirection="column">
                    <Text color={inboxFocus === 'composer' ? 'cyan' : 'gray'}>
                      {inboxFocus === 'composer' ? '◆ Draft' : 'Draft'}
                    </Text>
                    {(threadDrafts[selectedThread.id] ?? '').length > 0 ? (
                      inboxFocus === 'composer' ? (
                        <Text>
                          <Text>
                            {(threadDrafts[selectedThread.id] ?? '').slice(
                              0,
                              clampCursor(
                                threadDraftCursorByThreadId[selectedThread.id] ??
                                  (threadDrafts[selectedThread.id] ?? '').length,
                                (threadDrafts[selectedThread.id] ?? '').length
                              )
                            )}
                          </Text>
                          <Text color="cyan">_</Text>
                          <Text>
                            {(threadDrafts[selectedThread.id] ?? '').slice(
                              clampCursor(
                                threadDraftCursorByThreadId[selectedThread.id] ??
                                  (threadDrafts[selectedThread.id] ?? '').length,
                                (threadDrafts[selectedThread.id] ?? '').length
                              )
                            )}
                          </Text>
                        </Text>
                      ) : (
                        <Text>{threadDrafts[selectedThread.id]}</Text>
                      )
                    ) : (
                      <Text color="gray">
                        {inboxFocus === 'composer'
                          ? 'Type your message. Enter adds a new line.'
                          : 'Press Enter or E to start writing.'}
                      </Text>
                    )}
                    {inboxFocus === 'composer' && (threadDrafts[selectedThread.id] ?? '').length === 0 ? (
                      <Text color="cyan">_</Text>
                    ) : null}
                  </Box>
                </Box>
              ) : (
                <Text color="gray">Select a thread or pending request to see details here.</Text>
              )}
            </Box>
          </Box>
        ) : null}

        {route.type === 'agents' ? (
          <Box flexDirection="column">
            <Box marginTop={1} flexDirection="column">
              <Text color="cyan">◆ My agents</Text>
              {renderList({
                items: model.agents.agentSummaries.map(agent => {
                  const flags = [
                    agent.slug === model.activeInbox.slug ? 'active' : null,
                    agent.isDefault ? 'default' : null,
                    agent.managed ? '✓ managed' : '✗ not managed',
                    agent.registered ? '✓ published' : '✗ unpublished',
                  ].filter(Boolean).join(' · ');
                  return `${agent.slug} · ${flags}`;
                }),
                selectedIndex: clampIndex(selectedAgentIndex, model.agents.agentSummaries.length),
                empty: 'No owned agents found.',
              })}
              {selectedAgent ? (
                <Box marginTop={1} flexDirection="column">
                  <Text color="cyan">◆ Selected agent</Text>
                  <Text>
                    <Text bold>{selectedAgent.displayName ?? selectedAgent.slug}</Text>
                    <Text color="gray"> · {selectedAgent.publicIdentity}</Text>
                  </Text>
                  <Text color="gray">linked email {selectedAgent.publicLinkedEmailEnabled ? 'visible' : 'hidden'}</Text>
                  <Text>
                    Description: {selectedAgent.publicDescription
                      ? <Text>{selectedAgent.publicDescription}</Text>
                      : <Text color="gray">not set</Text>}
                  </Text>
                </Box>
              ) : null}
            </Box>
          </Box>
        ) : null}

        {route.type === 'discover' ? (
          <Box flexDirection="column">
            <Box marginTop={1} flexDirection="column">
              <Text color="cyan">◆ Discover</Text>
              {agentDiscovery.error ? (
                <Text color="red">{agentDiscovery.error}</Text>
              ) : (
                <Text color="gray">
                  {agentDiscovery.loading
                    ? `Loading ${agentDiscovery.mode === 'search' ? 'verified' : 'registered'} agents…`
                    : agentDiscovery.mode === 'search'
                      ? `query ${agentDiscovery.query} · page ${agentDiscovery.page}${agentDiscovery.hasNextPage ? ' · more' : ''}`
                      : `registered agents · page ${agentDiscovery.page}${agentDiscovery.hasNextPage ? ' · more' : agentDiscovery.loaded ? ' · last page' : ''}`}
                </Text>
              )}
              {renderList({
                items: agentDiscovery.results.map(result => {
                  const summary = result.displayName?.trim()
                    ? result.displayName
                    : result.slug;
                  const detail = result.description?.trim() || 'verified SaaS agent';
                  return `${summary} · ${detail}`;
                }),
                selectedIndex: clampIndex(selectedDiscoveryIndex, agentDiscovery.results.length),
                empty:
                  agentDiscovery.mode === 'search'
                    ? 'No verified SaaS matches on this page.'
                    : agentDiscovery.loaded
                      ? 'No registered SaaS agents on this page.'
                      : 'Loading discovery results…',
              })}
              {selectedDiscoveryResult ? (
                <Box marginTop={1} flexDirection="column">
                  <Text color="cyan">◆ Selected discovery result</Text>
                  <Text>
                    <Text bold>{selectedDiscoveryResult.displayName ?? selectedDiscoveryResult.slug}</Text>
                  </Text>
                  <Text color="gray">
                    {selectedDiscoveryResult.description?.trim() || 'verified SaaS agent'}
                  </Text>
                  <Text color="gray">
                    {selectedDiscoverySummaryRows.length > 0
                      ? selectedDiscoverySummaryRows.join(' · ')
                      : 'No known thread relationship yet.'}
                  </Text>
                  <Text color="gray">Enter opens full details · S search · N new thread</Text>
                </Box>
              ) : null}
              {selectedDiscoveryResult ? (
                <Box marginTop={1} flexDirection="column">
                  <Text color="cyan">◆ Public details</Text>
                  <Text color="gray">
                    Open threads: {selectedDiscoveryPublicMetrics.activeThreads ?? 'n/a'}
                  </Text>
                  <Text color="gray">
                    Dedicated members: {selectedDiscoveryPublicMetrics.dedicatedMembers ?? 'n/a'}
                  </Text>
                  <Text color="gray">
                    Open thread requests: {selectedDiscoveryPublicMetrics.requestedThreads ?? 'n/a'}
                  </Text>
                  {discoverDetail.status === 'loading' &&
                  discoverDetail.slug === selectedDiscoveryResult.slug ? (
                    <Text color="gray">Loading public details…</Text>
                  ) : null}
                  {discoverDetail.status === 'error' &&
                  discoverDetail.slug === selectedDiscoveryResult.slug ? (
                    <Text color="red">{discoverDetail.error}</Text>
                  ) : null}
                  {selectedDiscoveryDetail ? (
                    <Box flexDirection="column">
                      <Text>
                        Public identity:{' '}
                        {selectedDiscoveryDetail.selected.publicIdentity ? (
                          <Text>{selectedDiscoveryDetail.selected.publicIdentity}</Text>
                        ) : (
                          <Text color="gray">not published</Text>
                        )}
                      </Text>
                      <Text>
                        Inbox published:{' '}
                        <Text>{selectedDiscoveryDetail.selected.inboxPublished ? 'yes' : 'no'}</Text>
                      </Text>
                      <Text>
                        Description:{' '}
                        {selectedDiscoveryDetail.selected.description ? (
                          <Text>{selectedDiscoveryDetail.selected.description}</Text>
                        ) : (
                          <Text color="gray">not set</Text>
                        )}
                      </Text>
                      <Text>
                        Encryption key version:{' '}
                        <Text>{selectedDiscoveryDetail.selected.encryptionKeyVersion ?? 'n/a'}</Text>
                        <Text color="gray"> · signing key version </Text>
                        <Text>{selectedDiscoveryDetail.selected.signingKeyVersion ?? 'n/a'}</Text>
                      </Text>
                      {selectedDiscoveryDetail.publicRoute ? (
                        <Box flexDirection="column">
                          <Text>
                            Linked email:{' '}
                            {selectedDiscoveryDetail.publicRoute.linkedEmail ? (
                              <Text>{selectedDiscoveryDetail.publicRoute.linkedEmail}</Text>
                            ) : (
                              <Text color="gray">not published</Text>
                            )}
                          </Text>
                          <Text>
                            Contact policy: <Text>{selectedDiscoveryDetail.publicRoute.contactPolicy.mode}</Text>
                            <Text color="gray"> · allowlist </Text>
                            <Text>{selectedDiscoveryDetail.publicRoute.contactPolicy.allowlistScope}</Text>
                          </Text>
                          <Text color="gray">
                            Preview before approval:{' '}
                            {selectedDiscoveryDetail.publicRoute.contactPolicy
                              .messagePreviewVisibleBeforeApproval
                              ? 'yes'
                              : 'no'}
                          </Text>
                          <Text color="gray">
                            Content types:{' '}
                            {selectedDiscoveryDetail.publicRoute.allowAllContentTypes
                              ? 'all'
                              : selectedDiscoveryDetail.publicRoute.supportedContentTypes.length > 0
                                ? selectedDiscoveryDetail.publicRoute.supportedContentTypes.join(', ')
                                : 'none'}
                          </Text>
                          <Text color="gray">
                            Headers:{' '}
                            {selectedDiscoveryDetail.publicRoute.allowAllHeaders
                              ? 'all'
                              : selectedDiscoveryDetail.publicRoute.supportedHeaders.length > 0
                                ? selectedDiscoveryDetail.publicRoute.supportedHeaders
                                    .map(header => header.name)
                                    .join(', ')
                                : 'none'}
                          </Text>
                        </Box>
                      ) : (
                        <Text color="gray">
                          No extended public route metadata is published for this agent.
                        </Text>
                      )}
                      {sharedThreadsWithDiscoveredAgent.length > 0 ? (
                        <Text color="gray">
                          Latest shared thread:{' '}
                          {sharedThreadsWithDiscoveredAgent[0]?.label ?? 'n/a'} ·{' '}
                          {formatTimestamp(sharedThreadsWithDiscoveredAgent[0]?.lastMessageAt)}
                        </Text>
                      ) : (
                        <Text color="gray">No shared threads yet. Press N to start one.</Text>
                      )}
                    </Box>
                  ) : (
                    <Text color="gray">Press Enter to load public details for this agent.</Text>
                  )}
                </Box>
              ) : null}
            </Box>
          </Box>
        ) : null}

        {route.type === 'account' ? (
          <Box flexDirection="column">
            <Text>
              Signed in as <Text bold>{connectionState.auth.claims.email ?? 'unknown'}</Text>
              <Text color="gray"> · profile {connectionState.auth.profile.name}</Text>
            </Text>
            <Text>
              <Text color={accountFocus === 'security' ? 'cyan' : 'gray'}>
                {accountFocus === 'security' ? '▸ ' : '  '}Security
              </Text>
              <Text color="gray"> · </Text>
              <Text color={accountFocus === 'devices' ? 'cyan' : 'gray'}>
                {accountFocus === 'devices' ? '▸ ' : '  '}Devices
              </Text>
            </Text>
            {accountFocus === 'security' ? (
              <Box marginTop={1} flexDirection="column">
                <Text color="cyan">◆ Security & recovery</Text>
                <Text><Text bold>{model.account.securityState.title}</Text></Text>
                <Text color="gray">{model.account.securityState.description}</Text>
                {renderList({
                  items: securityActions.map(action => `${action.label} · ${action.description}`),
                  selectedIndex: clampIndex(securityActionIndex, securityActions.length),
                  empty: 'No account actions available.',
                })}
              </Box>
            ) : (
              <Box marginTop={1} flexDirection="column">
                <Text color="cyan">◆ Trusted devices</Text>
                {model.account.deviceRequests.length > 0 ? (
                  model.account.deviceRequests.slice(0, 3).map(request => (
                    <Text key={request.id} color="yellow">
                      {'  '}pending {request.deviceId} · expires {formatTimestamp(request.expiresAt)}
                    </Text>
                  ))
                ) : null}
                {renderList({
                  items: model.account.devices.map(
                    device =>
                      `${device.label ?? device.deviceId} · ${device.status} · ${formatTimestamp(device.lastSeenAt)}${device.pendingShareCount > 0 ? ` · ${device.pendingShareCount} pending` : ''}`
                  ),
                  selectedIndex: clampIndex(deviceSelection, model.account.devices.length),
                  empty: 'No trusted devices found.',
                })}
              </Box>
            )}
          </Box>
        ) : null}

        {statusBar}
        <ModeBar mode={footerMode} />
      </Box>
    </Box>
  );
}
