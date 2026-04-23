import { Box, Text, useApp, useInput, useStdout } from 'ink';
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
import {
  isDeregisteringOrDeregisteredInboxAgentState,
  isFailedRegistrationInboxAgentState,
  isPendingMasumiInboxAgentState,
  isUnavailableForChatInboxAgentState,
  type MasumiInboxAgentState,
} from '../../../shared/inbox-agent-registration';
import { formatRelativeTime } from '../services/format';
import { toCliError } from '../services/errors';
import {
  createInboxIdentity,
  deregisterInboxAgent,
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
import {
  approveChannelJoin,
  createChannel,
  listChannelMembers,
  readAuthenticatedChannelMessages,
  rejectChannelJoin,
  sendChannelMessage,
  setChannelMemberPermission,
  updateChannelSettings,
  verifyChannelMessages,
  type ChannelMemberListItem,
  type ChannelMessageItem,
} from '../services/channel';
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
  | { type: 'channels' }
  | { type: 'agents' }
  | { type: 'discover' }
  | { type: 'account' }
  | { type: 'help' };

type ShellThreadFilter = 'all' | 'unread' | 'direct';
type InboxFocus = 'navigator' | 'detail' | 'composer';
type InboxDetailTab = 'messages' | 'members' | 'approval';
type ChannelMode = 'overview' | 'detail';
type ChannelTab = 'messages' | 'members' | 'approvals';
type AccountFocus = 'security' | 'devices';
type AgentsFocus = 'owned' | 'discover';
type ShellFocus = 'sidebar' | 'content';

const SIDEBAR_NAV_ITEMS = ['inboxes', 'channels', 'agents', 'discover', 'account'] as const;
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
  selectedChannelSlug?: string | null;
  channelMode: ChannelMode;
  channelTab: ChannelTab;
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
  choices?: Array<{
    value: string;
    label: string;
  }>;
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
  trustNotice: string | null;
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

type ChannelMessagesPageState = {
  channelId: string | null;
  messages: ChannelMessageItem[];
  beforeSeqStack: Array<string | null>;
  pageIndex: number;
  loading: boolean;
  error: string | null;
  loaded: boolean;
};

type ChannelMembersPageState = {
  channelId: string | null;
  members: ChannelMemberListItem[];
  afterMemberIdStack: Array<string | null>;
  pageIndex: number;
  loading: boolean;
  error: string | null;
  loaded: boolean;
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
const MAX_TUI_DESCRIPTION_LINES = 4;
const CHANNEL_MESSAGE_PAGE_SIZE = 8;
const CHANNEL_MEMBER_PAGE_SIZE = 8;
const TAB_CELL_WIDTH = 18;
const TAB_CELL_GAP = 2;
const SIDEBAR_WIDTH = 20;
const SIDEBAR_CONTENT_WIDTH = SIDEBAR_WIDTH - 2;
const CLEAR_ROW_TAIL = '            ';
const DEFAULT_TERMINAL_COLUMNS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

type TerminalSize = {
  columns: number;
  rows: number;
};

function resolveTerminalSize(stdout: NodeJS.WriteStream): TerminalSize {
  const columns =
    typeof stdout.columns === 'number' && stdout.columns > 0
      ? stdout.columns
      : typeof process.stdout.columns === 'number' && process.stdout.columns > 0
        ? process.stdout.columns
        : DEFAULT_TERMINAL_COLUMNS;
  const rows =
    typeof stdout.rows === 'number' && stdout.rows > 0
      ? stdout.rows
      : typeof process.stdout.rows === 'number' && process.stdout.rows > 0
        ? process.stdout.rows
        : DEFAULT_TERMINAL_ROWS;
  return { columns, rows };
}

function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState<TerminalSize>(() =>
    resolveTerminalSize(stdout)
  );

  useEffect(() => {
    const updateTerminalSize = () => {
      setTerminalSize(resolveTerminalSize(stdout));
    };

    updateTerminalSize();
    stdout.on('resize', updateTerminalSize);
    return () => {
      stdout.off('resize', updateTerminalSize);
    };
  }, [stdout]);

  return terminalSize;
}

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

function createInitialChannelMessagesState(): ChannelMessagesPageState {
  return {
    channelId: null,
    messages: [],
    beforeSeqStack: [null],
    pageIndex: 0,
    loading: false,
    error: null,
    loaded: false,
  };
}

function createInitialChannelMembersState(): ChannelMembersPageState {
  return {
    channelId: null,
    members: [],
    afterMemberIdStack: [null],
    pageIndex: 0,
    loading: false,
    error: null,
    loaded: false,
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
    trustNotice: null,
    trustWarning: null,
    optimistic: true,
  };
}

function maskValue(value: string): string {
  return value ? '•'.repeat(value.length) : '';
}

function capTextLines(text: string, maxLines: number): string {
  return capTextToLines(text, maxLines).join('\n');
}

function capTextToLines(text: string, maxLines: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length <= maxLines) {
    return lines;
  }

  const capped = lines.slice(0, maxLines);
  const lastIndex = maxLines - 1;
  capped[lastIndex] = capped[lastIndex].length
    ? `${capped[lastIndex]}…`
    : '…';
  return capped;
}

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }

  const chars = Array.from(text);
  if (chars.length <= maxWidth) {
    return text;
  }

  if (maxWidth === 1) {
    return '…';
  }

  return `${chars.slice(0, maxWidth - 1).join('')}…`;
}

function truncateAndPadText(text: string, maxWidth: number): string {
  const truncated = truncateText(text, maxWidth);
  return `${truncated}${' '.repeat(Math.max(0, maxWidth - Array.from(truncated).length))}`;
}

function textWidth(text: string): number {
  return Array.from(text).length;
}

function formatDiscoveryListRow(params: {
  result: DiscoverSearchItem;
  selected: boolean;
  width: number;
}): string {
  const prefix = params.selected ? '▸ ' : '  ';
  const state = describeDiscoveryRegistrationState(params.result.registrationState);
  const suffix = ` · ${state}`;
  const summary = params.result.displayName?.trim() || params.result.slug;
  const identity = `${summary} · /${params.result.slug}`;
  const identityWidth = Math.max(0, params.width - Array.from(prefix).length - suffix.length);
  const body =
    identityWidth > 0
      ? `${truncateText(identity, identityWidth)}${suffix}`
      : truncateText(`${identity}${suffix}`, Math.max(0, params.width - Array.from(prefix).length));

  return truncateAndPadText(`${prefix}${body}`, params.width);
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

function normalizeChannelAccessModeInput(value: string): 'public' | 'approval_required' | null {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'public') {
    return 'public';
  }
  if (
    normalized === 'approval_required' ||
    normalized === 'approval' ||
    normalized === 'private'
  ) {
    return 'approval_required';
  }
  return null;
}

function normalizeChannelPermissionInput(value: string): 'read' | 'read_write' | 'admin' | null {
  const normalized = value.trim().toLowerCase().replace(/[-\s/]+/g, '_');
  if (normalized === 'read' || normalized === 'read_only' || normalized === 'readonly') {
    return 'read';
  }
  if (
    normalized === 'read_write' ||
    normalized === 'write' ||
    normalized === 'writer' ||
    normalized === 'readwrite'
  ) {
    return 'read_write';
  }
  if (normalized === 'admin') {
    return 'admin';
  }
  return null;
}

function normalizePublicJoinPermissionInput(value: string): 'read' | 'read_write' | null {
  const normalized = normalizeChannelPermissionInput(value);
  return normalized === 'read' || normalized === 'read_write' ? normalized : null;
}

function describeChannelPermission(permission: string): string {
  if (permission === 'read') return 'read only';
  if (permission === 'read_write') return 'read/write';
  if (permission === 'admin') return 'admin';
  return permission;
}

function parseYesNoInput(value: string, defaultValue: boolean): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (['yes', 'y', 'true', '1', 'on'].includes(normalized)) {
    return true;
  }
  if (['no', 'n', 'false', '0', 'off'].includes(normalized)) {
    return false;
  }
  return null;
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
    case 'deregistered':
      return `Managed agent ${params.slug} is deregistered and cannot be used for chats.`;
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

function getManagedAgentPrimaryActionLabel(agent: {
  managed: boolean;
  registered: boolean;
  deregistered: boolean;
} | null): string {
  if (!agent) {
    return 'register';
  }
  if (agent.deregistered) {
    return 're-register';
  }
  if (!agent.managed) {
    return 'register';
  }
  if (agent.registered) {
    return 'sync registration';
  }
  return 'sync registration';
}

function getManagedAgentPrimaryActionTitle(agent: {
  slug: string;
  managed: boolean;
  registered: boolean;
  deregistered: boolean;
} | null): string {
  if (!agent) {
    return 'Register managed agent';
  }
  if (agent.deregistered) {
    return `Re-registering managed agent for ${agent.slug}`;
  }
  if (!agent.managed) {
    return `Registering managed agent for ${agent.slug}`;
  }
  return `Syncing managed agent registration for ${agent.slug}`;
}

function describeDiscoveryRegistrationState(state: MasumiInboxAgentState): string {
  if (isFailedRegistrationInboxAgentState(state)) {
    return 'invalid';
  }
  if (isDeregisteringOrDeregisteredInboxAgentState(state)) {
    return state === 'DeregistrationConfirmed' ? 'deregistered' : 'deregistering';
  }
  if (isPendingMasumiInboxAgentState(state)) {
    return 'pending';
  }
  return 'registered';
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
    if (!isDeregisteringOrDeregisteredInboxAgentState(defaultActor.masumiRegistrationState)) {
      return defaultActor;
    }
    return (
      params.rows.actors.find(
        actor =>
          actor.inboxId === defaultActor.inboxId &&
          !isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)
      ) ?? null
    );
  }

  const requestedActor =
    params.rows.actors.find(actor => {
      return actor.inboxId === defaultActor.inboxId && actor.slug === params.slug;
    }) ?? null;
  if (
    requestedActor &&
    !isDeregisteringOrDeregisteredInboxAgentState(requestedActor.masumiRegistrationState)
  ) {
    return requestedActor;
  }
  if (!isDeregisteringOrDeregisteredInboxAgentState(defaultActor.masumiRegistrationState)) {
    return defaultActor;
  }
  return (
    params.rows.actors.find(
      actor =>
        actor.inboxId === defaultActor.inboxId &&
        !isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)
    ) ?? null
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
type LiveChannel = NonNullable<RootShellViewModel>['channels']['channels'][number];
type LiveChannelApproval = NonNullable<RootShellViewModel>['channels']['approvals'][number];

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
        trustNotice: decrypted.trustNotice,
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
        Math.min(
          current + THREAD_MESSAGE_WINDOW_SIZE,
          Math.max(allMessages.length - THREAD_MESSAGE_WINDOW_SIZE, 0)
        )
      ),
    scrollNewer: () =>
      setScrollOffset(current => Math.max(current - THREAD_MESSAGE_WINDOW_SIZE, 0)),
    resetThreadWindow: () => setScrollOffset(0),
  };
}

function useLiveChannelMessages(params: {
  connectionState: ShellConnectionState;
  routeType: ShellRoute['type'];
  channelMode: ChannelMode;
  channelTab: ChannelTab;
  selectedChannelId: string | null;
}): {
  liveChannelMessages: ChannelMessageItem[];
  liveChannelMessagesError: string | null;
  liveChannelMessagesLoading: boolean;
  liveChannelMessagesLoaded: boolean;
} {
  const [messages, setMessages] = useState<ChannelMessageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (
      params.connectionState.mode !== 'ready' ||
      params.routeType !== 'channels' ||
      params.channelMode !== 'detail' ||
      params.channelTab !== 'messages' ||
      !params.selectedChannelId
    ) {
      setMessages([]);
      setError(null);
      setLoading(false);
      setLoaded(false);
      return;
    }

    let cancelled = false;
    const selectedChannelId = params.selectedChannelId;
    const rows = params.connectionState.rows.channelMessages
      .filter(message => message.channelId.toString() === selectedChannelId)
      .sort((left, right) => {
        if (left.channelSeq < right.channelSeq) return -1;
        if (left.channelSeq > right.channelSeq) return 1;
        return Number(left.id - right.id);
      })
      .slice(-CHANNEL_MESSAGE_PAGE_SIZE);

    setLoading(true);
    void verifyChannelMessages(
      null,
      rows.map(message => ({
        ...message,
        replyToMessageId: message.replyToMessageId ?? null,
      }))
    )
      .then(result => {
        if (!cancelled) {
          setMessages(result);
          setError(null);
          setLoaded(true);
        }
      })
      .catch(cause => {
        if (!cancelled) {
          setMessages([]);
          setError(toCliError(cause).message);
          setLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    params.channelMode,
    params.channelTab,
    params.connectionState,
    params.routeType,
    params.selectedChannelId,
  ]);

  return {
    liveChannelMessages: messages,
    liveChannelMessagesError: error,
    liveChannelMessagesLoading: loading,
    liveChannelMessagesLoaded: loaded,
  };
}

function renderList(params: {
  items: string[];
  selectedIndex: number;
  empty: string;
  color?: string;
  maxWidth?: number;
}) {
  if (params.items.length === 0) {
    return (
      <Text color="gray" wrap="truncate">
        {params.maxWidth ? truncateAndPadText(params.empty, params.maxWidth) : params.empty}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" width={params.maxWidth}>
      {params.items.map((item, index) => {
        const selected = index === params.selectedIndex;
        const row = `${selected ? '▸ ' : '  '}${item}`;
        return (
          <Text
            key={`${index}:${item}`}
            color={selected ? 'cyan' : params.color}
            bold={selected}
            wrap="truncate"
          >
            {params.maxWidth ? truncateAndPadText(row, params.maxWidth) : row}
          </Text>
        );
      })}
    </Box>
  );
}

function renderDiscoveryResultList(params: {
  results: DiscoverSearchItem[];
  selectedIndex: number;
  empty: string;
  width: number;
}) {
  const width = Math.max(1, params.width);
  if (params.results.length === 0) {
    return (
      <Text color="gray" wrap="truncate">
        {truncateAndPadText(params.empty, width)}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      {params.results.map((result, index) => {
        const selected = index === params.selectedIndex;
        return (
          <Text
            key={`${index}:${result.slug}:${result.registrationState}`}
            color={selected ? 'cyan' : undefined}
            bold={selected}
            wrap="truncate"
          >
            {formatDiscoveryListRow({
              result,
              selected,
              width,
            })}
          </Text>
        );
      })}
    </Box>
  );
}

function DescriptionLines({
  text,
  empty = 'not set',
  width,
}: {
  text?: string | null;
  empty?: string;
  width?: number;
}) {
  const trimmed = text?.trim() ?? '';
  const lines = trimmed ? capTextToLines(trimmed, MAX_TUI_DESCRIPTION_LINES) : [];
  const safeWidth = width ? Math.max(1, width) : undefined;

  if (lines.length === 0) {
    return (
      <Text color="gray" wrap="truncate">
        {safeWidth ? truncateAndPadText(empty, safeWidth) : empty}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" width={safeWidth}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} color="gray" wrap="truncate">
          {safeWidth
            ? truncateAndPadText(line.length > 0 ? line : ' ', safeWidth)
            : line.length > 0
              ? line
              : ' '}
        </Text>
      ))}
    </Box>
  );
}

function FixedLine({
  text,
  width,
  color,
  bold,
  dimColor,
}: {
  text: string;
  width?: number;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}) {
  const safeWidth = width ? Math.max(1, width) : undefined;
  return (
    <Text color={color} bold={bold} dimColor={dimColor} wrap="truncate">
      {safeWidth ? truncateAndPadText(text, safeWidth) : text}
    </Text>
  );
}

function TabStrip<T extends string>({
  tabs,
  active,
  width,
}: {
  tabs: Array<{ key: T; label: string; count?: number }>;
  active: T;
  width?: number;
}) {
  const labels = tabs.map(tab => {
    const isActive = tab.key === active;
    return `${isActive ? '▸ ' : '  '}${tab.label}${
      tab.count !== undefined ? ` ${tab.count.toString()}` : ''
    }`;
  });
  const naturalWidths = labels.map((label, index) => {
    const labelWidth = Array.from(label).length;
    return labelWidth + (index === labels.length - 1 ? 0 : TAB_CELL_GAP);
  });
  const naturalTotalWidth = naturalWidths.reduce((sum, value) => sum + value, 0);
  const availableWidth =
    typeof width === 'number' && Number.isFinite(width) && width > 0
      ? Math.floor(width)
      : naturalTotalWidth + CLEAR_ROW_TAIL.length;
  const shouldCompress = naturalTotalWidth > availableWidth;
  const compressedCellWidth =
    tabs.length > 0 ? Math.max(1, Math.floor(availableWidth / tabs.length)) : 1;
  let remainder = shouldCompress
    ? Math.max(0, availableWidth - compressedCellWidth * tabs.length)
    : 0;
  const cellWidths = naturalWidths.map(naturalWidth => {
    if (!shouldCompress) {
      return naturalWidth;
    }
    const extra = remainder > 0 ? 1 : 0;
    remainder = Math.max(0, remainder - 1);
    return compressedCellWidth + extra;
  });
  const usedWidth = cellWidths.reduce((sum, value) => sum + value, 0);
  const tailWidth = Math.max(0, availableWidth - usedWidth);

  return (
    <Box flexDirection="row" width={availableWidth}>
      {tabs.map((tab, index) => {
        const isActive = tab.key === active;
        return (
          <Text
            key={tab.key}
            color={isActive ? 'cyan' : 'gray'}
            bold={isActive}
            wrap="truncate"
          >
            {truncateAndPadText(labels[index] ?? '', cellWidths[index] ?? TAB_CELL_WIDTH)}
          </Text>
        );
      })}
      {tailWidth > 0 ? <Text>{' '.repeat(tailWidth)}</Text> : null}
    </Box>
  );
}

function MessageBodyLines({ text, width }: { text: string; width?: number }) {
  const lines = capTextToLines(text, MAX_MESSAGE_BODY_LINES);
  const safeWidth = width ? Math.max(1, width - 2) : undefined;
  return (
    <Box flexDirection="column" marginLeft={2} width={safeWidth}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} wrap="truncate">
          {safeWidth
            ? truncateAndPadText(line.length > 0 ? line : ' ', safeWidth)
            : line.length > 0
              ? line
              : ' '}
        </Text>
      ))}
    </Box>
  );
}

function ThreadMessageBlock({
  message,
  width,
}: {
  message: LiveThreadMessage;
  width?: number;
}) {
  const safeWidth = width ? Math.max(1, width) : undefined;
  const header = `From ${message.senderLabel} · ${formatTimestamp(message.createdAt)}${
    message.optimistic ? ' · syncing...' : ''
  }`;
  return (
    <Box key={message.id} flexDirection="column" marginBottom={1} width="100%">
      <Text color="gray" wrap="truncate">
        {safeWidth ? truncateAndPadText(header, safeWidth) : header}
      </Text>
      {message.trustNotice ? (
        <Text color="yellow" wrap="truncate">
          {safeWidth
            ? truncateAndPadText(`  ${message.trustNotice}`, safeWidth)
            : `  ${message.trustNotice}`}
        </Text>
      ) : null}
      {message.trustWarning ? (
        <Text color="red" wrap="truncate">
          {safeWidth
            ? truncateAndPadText(`  ${message.trustWarning}`, safeWidth)
            : `  ${message.trustWarning}`}
        </Text>
      ) : null}
      <MessageBodyLines text={message.body} width={safeWidth} />
    </Box>
  );
}

function ChannelMessageBlock({
  message,
  width,
}: {
  message: ChannelMessageItem;
  width?: number;
}) {
  const body = message.text ?? message.error ?? 'Unable to read message.';
  const safeWidth = width ? Math.max(1, width) : undefined;
  const header = `From ${message.sender} · ${
    message.createdAt ? formatTimestamp(message.createdAt) : 'time unavailable'
  } · #${message.channelSeq}${message.status === 'failed' ? ' · verification failed' : ''}`;
  return (
    <Box key={message.id} flexDirection="column" marginBottom={1} width="100%">
      <Text
        color={message.status === 'failed' ? 'red' : 'gray'}
        wrap="truncate"
      >
        {safeWidth ? truncateAndPadText(header, safeWidth) : header}
      </Text>
      <MessageBodyLines text={body} width={safeWidth} />
    </Box>
  );
}

function packFooterItems(items: FooterModeItem[], width: number): FooterModeItem[][] {
  const safeWidth = Math.max(1, width);
  const lines: FooterModeItem[][] = [];
  let currentLine: FooterModeItem[] = [];
  let currentWidth = 0;

  for (const item of items) {
    const itemWidth = textWidth(`${item.key} ${item.label}`);
    const nextWidth = currentLine.length === 0 ? itemWidth : currentWidth + 3 + itemWidth;
    if (currentLine.length > 0 && nextWidth > safeWidth) {
      lines.push(currentLine);
      currentLine = [item];
      currentWidth = itemWidth;
      continue;
    }
    currentLine.push(item);
    currentWidth = nextWidth;
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

function HelpBar({
  items,
  width,
}: {
  items: Array<{ key: string; label: string }>;
  width?: number;
}) {
  const safeWidth = width ? Math.max(1, width) : undefined;
  if (!safeWidth) {
    return (
      <Text>
        {items.map((item, index) => (
          <Text key={`${index}:${item.key}:${item.label}`}>
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

  return (
    <Box flexDirection="column" width={safeWidth}>
      {packFooterItems(items, safeWidth).map((lineItems, lineIndex) => {
        const lineText = lineItems
          .map(item => `${item.key} ${item.label}`)
          .join(' · ');
        if (textWidth(lineText) > safeWidth) {
          return (
            <Text key={`line:${lineIndex}`} color="gray" wrap="truncate">
              {truncateAndPadText(lineText, safeWidth)}
            </Text>
          );
        }
        const tailWidth = Math.max(0, safeWidth - textWidth(lineText));
        return (
          <Text key={`line:${lineIndex}`}>
            {lineItems.map((item, index) => (
              <Text key={`${index}:${item.key}:${item.label}`}>
                {index > 0 ? <Text color="gray"> · </Text> : null}
                <Text color="cyan" bold>
                  {item.key}
                </Text>
                <Text color="gray"> {item.label}</Text>
              </Text>
            ))}
            {tailWidth > 0 ? <Text>{' '.repeat(tailWidth)}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function ModeBar({ mode, width }: { mode: FooterMode; width?: number }) {
  const safeWidth = width ? Math.max(1, width) : undefined;
  const modeLine = `Mode · ${mode.label}${mode.detail ? ` · ${mode.detail}` : ''}`;
  return (
    <Box marginTop={1} flexDirection="column" width={safeWidth}>
      {safeWidth ? (
        <Text color="gray" wrap="truncate">
          {truncateAndPadText(modeLine, safeWidth)}
        </Text>
      ) : (
        <Text color="gray">{modeLine}</Text>
      )}
      {mode.items.length > 0 ? <HelpBar items={mode.items} width={safeWidth} /> : null}
    </Box>
  );
}

const SIDEBAR_LABELS: Record<SidebarNavItem, string> = {
  inboxes: 'Inbox',
  channels: 'Channels',
  agents: 'My Agents',
  discover: 'Discover',
  account: 'Account',
};
const SIDEBAR_ICONS: Record<SidebarNavItem, string> = {
  inboxes: '[i]',
  channels: '[c]',
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
  channelApprovalCount,
  shellFocus,
}: {
  active: ShellRoute['type'];
  selectedNav: SidebarNavItem;
  slug: string | null;
  connectionLabel: string;
  connectionDotColor: string;
  unreadCount: number;
  pendingCount: number;
  channelApprovalCount: number;
  shellFocus: ShellFocus;
}) {
  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height="100%"
      overflow="hidden"
      borderStyle="single"
      borderRight
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderColor="gray"
      paddingRight={1}
    >
      <Text color="cyanBright" bold wrap="truncate">
        {truncateAndPadText('◆ MASUMI AGENT MESSENGER', SIDEBAR_CONTENT_WIDTH)}
      </Text>
      <Text color="gray" wrap="truncate">
        {truncateAndPadText(slug ? `/${slug}` : 'encrypted inbox', SIDEBAR_CONTENT_WIDTH)}
      </Text>
      <Text> </Text>
      {SIDEBAR_NAV_ITEMS.map(item => {
        const isActive = active === item;
        const isSelected = shellFocus === 'sidebar' && selectedNav === item;
        const badge =
          item === 'inboxes' && unreadCount > 0
            ? ` ${unreadCount}`
            : item === 'inboxes' && pendingCount > 0
              ? ` ${pendingCount}p`
              : item === 'channels' && channelApprovalCount > 0
                ? ` ${channelApprovalCount}p`
              : '';
        return (
          <Text
            key={item}
            color={isSelected ? 'cyan' : isActive ? 'cyan' : shellFocus === 'sidebar' ? undefined : 'gray'}
            wrap="truncate"
          >
            {truncateAndPadText(
              `${isSelected ? '▸ ' : isActive ? '• ' : '  '}${SIDEBAR_ICONS[item]} ${
                SIDEBAR_LABELS[item]
              }${badge}`,
              SIDEBAR_CONTENT_WIDTH
            )}
          </Text>
        );
      })}
      <Text> </Text>
      <Text color="gray">↑/↓ select</Text>
      <Text color="gray">Enter open</Text>
      <Text color="gray">I/C/A/D/U jump</Text>
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
  width,
}: {
  panel: TaskPanelState;
  lookupState: TaskLookupState;
  selectedLookupIndex: number;
  cursorIndex: number;
  width?: number;
}) {
  const currentField = panel.fields[panel.stepIndex] ?? null;
  const isLastField = panel.stepIndex >= panel.fields.length - 1;
  const showLookup =
    currentField &&
    lookupState.fieldKey === currentField.key &&
    (lookupState.loading || lookupState.error || lookupState.items.length > 0);
  const safeWidth = width ? Math.max(1, width) : undefined;
  const innerWidth = safeWidth ? Math.max(1, safeWidth - 4) : undefined;

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingLeft={1}
      paddingRight={1}
      width={safeWidth}
    >
      <Text color="cyan" bold>
        {innerWidth ? truncateAndPadText(panel.title, innerWidth) : panel.title}
      </Text>
      <Text color="gray" wrap="truncate">
        {innerWidth ? truncateAndPadText(panel.help, innerWidth) : panel.help}
      </Text>
      {panel.fields.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {panel.fields.map((field, index) => {
            const choiceLabel = field.choices?.find(choice => choice.value === field.value)?.label;
            const displayValue = field.choices
              ? choiceLabel ?? field.value
              : field.secret
                ? maskValue(field.value)
                : field.value;
            const isActive = index === panel.stepIndex;
            const activeCursor = isActive ? clampCursor(cursorIndex, displayValue.length) : displayValue.length;
            const valuePrefix = displayValue.slice(0, activeCursor);
            const valueSuffix = displayValue.slice(activeCursor);
            const rowValue = field.choices
              ? displayValue
              : displayValue
                ? `${valuePrefix}${isActive ? '_' : ''}${valueSuffix}`
                : `${isActive ? '_' : ''}${field.placeholder ?? ''}`;
            const row = `${isActive ? '▸ ' : '  '}${field.label}: ${rowValue}`;
            return (
              <Text
                key={field.key}
                color={isActive ? 'cyan' : undefined}
                wrap="truncate"
              >
                {innerWidth ? truncateAndPadText(row, innerWidth) : row}
              </Text>
            );
          })}
        </Box>
      ) : (
        <Text color="yellow" wrap="truncate">
          {innerWidth
            ? truncateAndPadText('Press Enter to continue or Esc to cancel.', innerWidth)
            : 'Press Enter to continue or Esc to cancel.'}
        </Text>
      )}
      {showLookup ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">
            {innerWidth ? truncateAndPadText('Suggestions', innerWidth) : 'Suggestions'}
          </Text>
          {lookupState.loading ? (
            <Text color="gray">
              {innerWidth ? truncateAndPadText('  Searching…', innerWidth) : '  Searching…'}
            </Text>
          ) : null}
          {lookupState.items.map((item, index) => (
            <Box key={item.id} flexDirection="column">
              <Text
                color={index === selectedLookupIndex ? 'cyan' : undefined}
                wrap="truncate"
              >
                {innerWidth
                  ? truncateAndPadText(
                      `${index === selectedLookupIndex ? '▸ ' : '  '}${item.label} · ${
                        item.source === 'contact' ? 'local' : 'saas'
                      }`,
                      innerWidth
                    )
                  : `${index === selectedLookupIndex ? '▸ ' : '  '}${item.label} · ${
                      item.source === 'contact' ? 'local' : 'saas'
                    }`}
              </Text>
              <Text color="gray" wrap="truncate">
                {innerWidth
                  ? truncateAndPadText(`    ${item.detail}`, innerWidth)
                  : `    ${item.detail}`}
              </Text>
            </Box>
          ))}
          {lookupState.error ? (
            <Text color="red" wrap="truncate">
              {innerWidth
                ? truncateAndPadText(`  ${lookupState.error}`, innerWidth)
                : `  ${lookupState.error}`}
            </Text>
          ) : null}
          {lookupState.items.length > 0 ? (
            <Text color="gray" wrap="truncate">
              {innerWidth
                ? truncateAndPadText('Tab accept suggestion · ↑/↓ choose', innerWidth)
                : 'Tab accept suggestion · ↑/↓ choose'}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Text color="gray" wrap="truncate">
        {innerWidth
          ? truncateAndPadText(
              `Step ${Math.min(panel.stepIndex + 1, Math.max(panel.fields.length, 1)).toString()}/${Math.max(panel.fields.length, 1).toString()} · ${currentField?.choices ? '↑/↓ select' : '←/→ cursor'} · Enter ${currentField && !isLastField ? 'next' : panel.submitLabel.toLowerCase()} · Esc cancel`,
              innerWidth
            )
          : `Step ${Math.min(panel.stepIndex + 1, Math.max(panel.fields.length, 1)).toString()}/${Math.max(panel.fields.length, 1).toString()} · ${currentField?.choices ? '↑/↓ select' : '←/→ cursor'} · Enter ${currentField && !isLastField ? 'next' : panel.submitLabel.toLowerCase()} · Esc cancel`}
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
  const terminalSize = useTerminalSize();
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
  const [selectedChannelSlug, setSelectedChannelSlug] = useState<string | null>(
    initialSnapshot?.selectedChannelSlug ?? null
  );
  const [channelMode, setChannelMode] = useState<ChannelMode>(
    initialSnapshot?.channelMode ?? 'overview'
  );
  const [channelTab, setChannelTab] = useState<ChannelTab>(
    initialSnapshot?.channelTab ?? 'messages'
  );
  const [channelApprovalIndex, setChannelApprovalIndex] = useState(0);
  const [channelMemberIndex, setChannelMemberIndex] = useState(0);
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
  const [inboxDetailTab, setInboxDetailTab] = useState<InboxDetailTab>('messages');
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
  const [channelMessagesState, setChannelMessagesState] = useState<ChannelMessagesPageState>(
    createInitialChannelMessagesState
  );
  const [channelMembersState, setChannelMembersState] = useState<ChannelMembersPageState>(
    createInitialChannelMembersState
  );
  const agentDiscoveryRequestRef = useRef(0);
  const channelMessagesRequestRef = useRef(0);
  const channelMembersRequestRef = useRef(0);
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
      setSelectedChannelSlug(null);
      setChannelMode('overview');
      setChannelTab('messages');
      setChannelApprovalIndex(0);
      setChannelMessagesState(createInitialChannelMessagesState());
      setChannelMembersState(createInitialChannelMembersState());
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
        setSelectedChannelSlug(null);
        setChannelMode('overview');
        setChannelTab('messages');
        setChannelMessagesState(createInitialChannelMessagesState());
        setChannelMembersState(createInitialChannelMembersState());
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
    canScrollOlder,
    canScrollNewer,
    scrollOlder,
    scrollNewer,
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

  const selectedInboxItemKind = selectedInboxItem?.kind ?? null;
  const inboxTabs = useMemo<Array<{ key: InboxDetailTab; label: string; count?: number }>>(() => {
    if (selectedInboxItemKind === 'request') {
      return [{ key: 'approval', label: 'Approval' }];
    }
    return [
      { key: 'messages', label: 'Messages', count: totalThreadMessages },
      { key: 'members', label: 'Members', count: selectedThread?.participantCount ?? 0 },
    ];
  }, [selectedInboxItemKind, selectedThread?.participantCount, totalThreadMessages]);

  useEffect(() => {
    setInboxDetailTab(selectedInboxItemKind === 'request' ? 'approval' : 'messages');
  }, [selectedInboxItemId, selectedInboxItemKind]);

  useEffect(() => {
    if (!inboxTabs.some(tab => tab.key === inboxDetailTab)) {
      setInboxDetailTab(inboxTabs[0]?.key ?? 'messages');
    }
  }, [inboxDetailTab, inboxTabs]);

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
  const channelSelectedBySlug: LiveChannel | null =
    model?.channels.channels.find(channel => channel.slug === selectedChannelSlug) ?? null;
  const selectedChannel: LiveChannel | null =
    channelSelectedBySlug ??
    (selectedChannelSlug === null || channelMode === 'overview'
      ? model?.channels.channels[0] ?? null
      : null);
  const selectedChannelIndex =
    selectedChannel && model
      ? model.channels.channels.findIndex(channel => channel.slug === selectedChannel.slug)
      : 0;
  const selectedChannelApprovals = useMemo<LiveChannelApproval[]>(() => {
    if (!model || !selectedChannel?.isAdmin) {
      return [];
    }
    return model.channels.approvals.filter(
      approval => approval.channelId === selectedChannel.id
    );
  }, [model, selectedChannel?.id, selectedChannel?.isAdmin]);
  const selectedChannelApproval =
    selectedChannelApprovals[clampIndex(channelApprovalIndex, selectedChannelApprovals.length)] ??
    null;
  const canSendSelectedChannel = selectedChannel?.canSend === true;
  const channelTabs = useMemo<Array<{ key: ChannelTab; label: string; count?: number }>>(
    () => [
      { key: 'messages', label: 'Messages' },
      { key: 'members', label: 'Members' },
      ...(selectedChannel?.isAdmin
        ? [
            {
              key: 'approvals' as const,
              label: 'Approvals',
              count: selectedChannelApprovals.length,
            },
          ]
        : []),
    ],
    [selectedChannel?.isAdmin, selectedChannelApprovals.length]
  );
  const {
    liveChannelMessages,
    liveChannelMessagesError,
    liveChannelMessagesLoading,
    liveChannelMessagesLoaded,
  } = useLiveChannelMessages({
    connectionState,
    routeType: route.type,
    channelMode,
    channelTab,
    selectedChannelId: selectedChannel?.id ?? null,
  });
  const selectedChannelMessagePageIndex =
    channelMessagesState.channelId === selectedChannel?.id ? channelMessagesState.pageIndex : 0;
  const shouldUseLiveChannelMessages =
    selectedChannel !== null && selectedChannelMessagePageIndex === 0;
  const selectedChannelMessageItems = shouldUseLiveChannelMessages
    ? liveChannelMessages
    : channelMessagesState.channelId === selectedChannel?.id
      ? channelMessagesState.messages
      : [];
  const selectedChannelMemberItems =
    channelMembersState.channelId === selectedChannel?.id
      ? channelMembersState.members
      : [];
  const selectedChannelMember =
    selectedChannelMemberItems[clampIndex(channelMemberIndex, selectedChannelMemberItems.length)] ??
    null;
  const selectedChannelMessagesLoading =
    shouldUseLiveChannelMessages
      ? liveChannelMessagesLoading && !liveChannelMessagesLoaded
      : channelMessagesState.channelId === selectedChannel?.id && channelMessagesState.loading;
  const selectedChannelMembersLoading =
    channelMembersState.channelId === selectedChannel?.id && channelMembersState.loading;
  const selectedChannelMessagesError =
    shouldUseLiveChannelMessages
      ? liveChannelMessagesError
      : channelMessagesState.channelId === selectedChannel?.id
        ? channelMessagesState.error
        : null;
  const selectedChannelMembersError =
    channelMembersState.channelId === selectedChannel?.id ? channelMembersState.error : null;
  const canPageChannelMessagesNewer = selectedChannelMessagePageIndex > 0;
  const canPageChannelMessagesOlder =
    selectedChannel !== null &&
    selectedChannelMessageItems.length >= CHANNEL_MESSAGE_PAGE_SIZE;
  const canPageChannelMembersNewer =
    channelMembersState.channelId === selectedChannel?.id && channelMembersState.pageIndex > 0;
  const canPageChannelMembersOlder =
    channelMembersState.channelId === selectedChannel?.id &&
    selectedChannelMemberItems.length >= CHANNEL_MEMBER_PAGE_SIZE;

  useEffect(() => {
    if (!model) {
      return;
    }
    if (model.channels.channels.length === 0) {
      setSelectedChannelSlug(null);
      setChannelMode('overview');
      setChannelTab('messages');
      return;
    }
    if (selectedChannelSlug === null) {
      setSelectedChannelSlug(model.channels.channels[0]?.slug ?? null);
      setChannelMode('overview');
      setChannelTab('messages');
    }
  }, [model, selectedChannelSlug]);

  useEffect(() => {
    setChannelApprovalIndex(current =>
      clampIndex(current, selectedChannelApprovals.length)
    );
  }, [selectedChannelApprovals.length]);

  useEffect(() => {
    setChannelMemberIndex(current => clampIndex(current, selectedChannelMemberItems.length));
  }, [selectedChannelMemberItems.length]);

  useEffect(() => {
    if (channelTab === 'approvals' && !selectedChannel?.isAdmin) {
      setChannelTab('messages');
    }
  }, [channelTab, selectedChannel?.isAdmin]);

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
      selectedChannelSlug,
      channelMode,
      channelTab,
      selectedAgentSlug,
      agentsFocus: route.type === 'discover' ? 'discover' : 'owned',
      accountFocus,
      shellFocus,
    }),
    [
      accountFocus,
      activeInboxSlug,
      channelMode,
      channelTab,
      threadFilter,
      inboxSection,
      route,
      selectedChannelSlug,
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

  const loadSelectedChannelMessages = async (params?: {
    beforeSeq?: string | null;
    pageIndex?: number;
    beforeSeqStack?: Array<string | null>;
  }): Promise<void> => {
    if (!selectedChannel || !model) {
      return;
    }

    const requestId = channelMessagesRequestRef.current + 1;
    channelMessagesRequestRef.current = requestId;
    const beforeSeq = params?.beforeSeq ?? null;
    const beforeSeqStack = params?.beforeSeqStack ?? [beforeSeq];
    const pageIndex = params?.pageIndex ?? Math.max(beforeSeqStack.length - 1, 0);

    setChannelMessagesState(current => ({
      ...current,
      channelId: selectedChannel.id,
      loading: true,
      error: null,
      beforeSeqStack,
      pageIndex,
    }));

    try {
      const result = await readAuthenticatedChannelMessages({
        profileName: options.profile,
        actorSlug: model.activeInbox.slug,
        slug: selectedChannel.slug,
        beforeChannelSeq: beforeSeq ?? undefined,
        limit: String(CHANNEL_MESSAGE_PAGE_SIZE),
        reporter: silentReporter(),
      });

      if (channelMessagesRequestRef.current !== requestId) {
        return;
      }

      setChannelMessagesState({
        channelId: selectedChannel.id,
        messages: result.messages,
        beforeSeqStack,
        pageIndex,
        loading: false,
        error: null,
        loaded: true,
      });
    } catch (error) {
      if (channelMessagesRequestRef.current !== requestId) {
        return;
      }
      setChannelMessagesState(current => ({
        ...current,
        channelId: selectedChannel.id,
        loading: false,
        loaded: true,
        error: toCliError(error).message,
      }));
    }
  };

  const pageSelectedChannelMessages = async (direction: 1 | -1): Promise<void> => {
    if (!selectedChannel || channelMessagesState.loading) {
      return;
    }
    const pageIndex =
      channelMessagesState.channelId === selectedChannel.id ? channelMessagesState.pageIndex : 0;
    const beforeSeqStack =
      channelMessagesState.channelId === selectedChannel.id
        ? channelMessagesState.beforeSeqStack
        : [null];

    if (direction < 0) {
      if (pageIndex <= 0) {
        return;
      }
      const nextIndex = pageIndex - 1;
      const nextBeforeSeq = beforeSeqStack[nextIndex] ?? null;
      await loadSelectedChannelMessages({
        beforeSeq: nextBeforeSeq,
        pageIndex: nextIndex,
        beforeSeqStack,
      });
      return;
    }

    const firstMessage = selectedChannelMessageItems[0] ?? null;
    if (!firstMessage || selectedChannelMessageItems.length < CHANNEL_MESSAGE_PAGE_SIZE) {
      return;
    }
    const nextBeforeSeq = firstMessage.channelSeq;
    const nextStack = beforeSeqStack.slice(
      0,
      pageIndex + 1
    );
    nextStack.push(nextBeforeSeq);
    await loadSelectedChannelMessages({
      beforeSeq: nextBeforeSeq,
      pageIndex: nextStack.length - 1,
      beforeSeqStack: nextStack,
    });
  };

  const loadSelectedChannelMembers = async (params?: {
    afterMemberId?: string | null;
    pageIndex?: number;
    afterMemberIdStack?: Array<string | null>;
  }): Promise<void> => {
    if (!selectedChannel || !model) {
      return;
    }

    const requestId = channelMembersRequestRef.current + 1;
    channelMembersRequestRef.current = requestId;
    const afterMemberId = params?.afterMemberId ?? null;
    const afterMemberIdStack = params?.afterMemberIdStack ?? [afterMemberId];
    const pageIndex = params?.pageIndex ?? Math.max(afterMemberIdStack.length - 1, 0);

    setChannelMembersState(current => ({
      ...current,
      channelId: selectedChannel.id,
      loading: true,
      error: null,
      afterMemberIdStack,
      pageIndex,
    }));

    try {
      const result = await listChannelMembers({
        profileName: options.profile,
        actorSlug: model.activeInbox.slug,
        slug: selectedChannel.slug,
        afterMemberId: afterMemberId ?? undefined,
        limit: String(CHANNEL_MEMBER_PAGE_SIZE),
        reporter: silentReporter(),
      });

      if (channelMembersRequestRef.current !== requestId) {
        return;
      }

      setChannelMembersState({
        channelId: selectedChannel.id,
        members: result.members,
        afterMemberIdStack,
        pageIndex,
        loading: false,
        error: null,
        loaded: true,
      });
    } catch (error) {
      if (channelMembersRequestRef.current !== requestId) {
        return;
      }
      setChannelMembersState(current => ({
        ...current,
        channelId: selectedChannel.id,
        loading: false,
        loaded: true,
        error: toCliError(error).message,
      }));
    }
  };

  const pageSelectedChannelMembers = async (direction: 1 | -1): Promise<void> => {
    if (!selectedChannel || channelMembersState.loading) {
      return;
    }
    const pageIndex =
      channelMembersState.channelId === selectedChannel.id ? channelMembersState.pageIndex : 0;
    const afterMemberIdStack =
      channelMembersState.channelId === selectedChannel.id
        ? channelMembersState.afterMemberIdStack
        : [null];

    if (direction < 0) {
      if (pageIndex <= 0) {
        return;
      }
      const nextIndex = pageIndex - 1;
      const nextAfterMemberId = afterMemberIdStack[nextIndex] ?? null;
      await loadSelectedChannelMembers({
        afterMemberId: nextAfterMemberId,
        pageIndex: nextIndex,
        afterMemberIdStack,
      });
      return;
    }

    const lastMember = selectedChannelMemberItems[selectedChannelMemberItems.length - 1] ?? null;
    if (!lastMember || selectedChannelMemberItems.length < CHANNEL_MEMBER_PAGE_SIZE) {
      return;
    }
    const nextAfterMemberId = lastMember.id;
    const nextStack = afterMemberIdStack.slice(
      0,
      pageIndex + 1
    );
    nextStack.push(nextAfterMemberId);
    await loadSelectedChannelMembers({
      afterMemberId: nextAfterMemberId,
      pageIndex: nextStack.length - 1,
      afterMemberIdStack: nextStack,
    });
  };

  useEffect(() => {
    if (route.type !== 'channels' || channelMode !== 'detail' || channelTab !== 'messages') {
      return;
    }
    if (!selectedChannel || channelMessagesState.channelId === selectedChannel.id) {
      return;
    }
    void loadSelectedChannelMessages({
      beforeSeq: null,
      pageIndex: 0,
      beforeSeqStack: [null],
    });
  }, [
    channelMessagesState.channelId,
    channelMode,
    channelTab,
    route.type,
    selectedChannel?.id,
  ]);

  useEffect(() => {
    if (route.type !== 'channels' || channelMode !== 'detail' || channelTab !== 'members') {
      return;
    }
    if (!selectedChannel || channelMembersState.channelId === selectedChannel.id) {
      return;
    }
    void loadSelectedChannelMembers({
      afterMemberId: null,
      pageIndex: 0,
      afterMemberIdStack: [null],
    });
  }, [
    channelMembersState.channelId,
    channelMode,
    channelTab,
    route.type,
    selectedChannel?.id,
  ]);

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
    setSelectedChannelSlug(null);
    setChannelMode('overview');
    setChannelTab('messages');
    setChannelMessagesState(createInitialChannelMessagesState());
    setChannelMembersState(createInitialChannelMembersState());
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

  const openAddThreadParticipantTask = () => {
    if (!selectedThread || !model || selectedThread.locked) {
      return;
    }
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
  };

  const openRemoveThreadParticipantTask = () => {
    if (!selectedThread || !model || selectedThread.locked) {
      return;
    }
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
  };

  const openAddChannelTask = () => {
    openTaskPanel({
      title: 'Add channel',
      help:
        'Create a signed plaintext channel from the active agent. Channels are not end-to-end private.',
      submitLabel: 'Add',
      fields: [
        {
          key: 'slug',
          label: 'Slug',
          value: '',
          placeholder: 'ops-updates',
          validate: value =>
            normalizeInboxSlug(value) ? null : 'Enter a valid channel slug.',
        },
        {
          key: 'title',
          label: 'Title',
          value: '',
          placeholder: 'optional',
          allowEmpty: true,
        },
        {
          key: 'description',
          label: 'Description',
          value: '',
          placeholder: 'optional public channel description',
          allowEmpty: true,
        },
        {
          key: 'accessMode',
          label: 'Access',
          value: 'public',
          placeholder: 'public or approval_required',
          choices: [
            { value: 'public', label: 'Public' },
            { value: 'approval_required', label: 'Approval required' },
          ],
          validate: value =>
            normalizeChannelAccessModeInput(value)
              ? null
              : 'Use public or approval_required.',
        },
        {
          key: 'publicJoinPermission',
          label: 'Public join',
          value: 'read',
          placeholder: 'read or read_write',
          choices: [
            { value: 'read', label: 'Read only' },
            { value: 'read_write', label: 'Read/write' },
          ],
          validate: (value, values) =>
            normalizeChannelAccessModeInput(values.accessMode) === 'public' &&
            !normalizePublicJoinPermissionInput(value)
              ? 'Use read or read_write.'
              : null,
        },
        {
          key: 'discoverable',
          label: 'Discoverable',
          value: 'yes',
          placeholder: 'yes or no',
          validate: value =>
            parseYesNoInput(value, true) === null ? 'Use yes or no.' : null,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model) {
          return;
        }
        const accessMode = normalizeChannelAccessModeInput(values.accessMode);
        const publicJoinPermission = normalizePublicJoinPermissionInput(
          values.publicJoinPermission
        );
        const discoverable = parseYesNoInput(values.discoverable, true);
        if (!accessMode || !publicJoinPermission || discoverable === null) {
          setTask(current => ({
            ...current,
            error: 'Channel access, public join permission, or discoverability is invalid.',
          }));
          return;
        }
        await performTask(
          `Adding channel ${values.slug}`,
          reporter =>
            createChannel({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              slug: values.slug,
              title: values.title || undefined,
              description: values.description || undefined,
              accessMode,
              publicJoinPermission,
              discoverable,
              reporter,
            }),
          result => {
            setRoute({ type: 'channels' });
            setSelectedChannelSlug(result.slug ?? values.slug.trim());
            setChannelMode('detail');
            setChannelTab('messages');
            setChannelMessagesState(createInitialChannelMessagesState());
            setChannelMembersState(createInitialChannelMembersState());
            setTask(current => ({
              ...current,
              notice: `Channel ${result.slug ?? values.slug.trim()} ${result.status}.`,
            }));
          }
        );
      },
    });
  };

  const openUpdateChannelSettingsTask = () => {
    if (!selectedChannel?.isAdmin || !model) {
      setTask(current => ({
        ...current,
        notice: selectedChannel
          ? `Only channel admins can update /${selectedChannel.slug}.`
          : 'Select a channel before updating settings.',
      }));
      return;
    }

    openTaskPanel({
      title: `Edit /${selectedChannel.slug}`,
      help: 'Update channel access, public join defaults, and discovery visibility.',
      submitLabel: 'Save',
      fields: [
        {
          key: 'accessMode',
          label: 'Access',
          value: normalizeChannelAccessModeInput(selectedChannel.accessMode) ?? 'public',
          choices: [
            { value: 'public', label: 'Public' },
            { value: 'approval_required', label: 'Approval required' },
          ],
          validate: value =>
            normalizeChannelAccessModeInput(value)
              ? null
              : 'Use public or approval_required.',
        },
        {
          key: 'publicJoinPermission',
          label: 'Public join',
          value:
            normalizePublicJoinPermissionInput(selectedChannel.publicJoinPermission) ?? 'read',
          choices: [
            { value: 'read', label: 'Read only' },
            { value: 'read_write', label: 'Read/write' },
          ],
          validate: value =>
            normalizePublicJoinPermissionInput(value) ? null : 'Use read or read_write.',
        },
        {
          key: 'discoverable',
          label: 'Discoverable',
          value: selectedChannel.discoverable ? 'yes' : 'no',
          placeholder: 'yes or no',
          validate: value =>
            parseYesNoInput(value, true) === null ? 'Use yes or no.' : null,
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model || !selectedChannel) {
          return;
        }
        const accessMode = normalizeChannelAccessModeInput(values.accessMode);
        const publicJoinPermission = normalizePublicJoinPermissionInput(
          values.publicJoinPermission
        );
        const discoverable = parseYesNoInput(values.discoverable, true);
        if (!accessMode || !publicJoinPermission || discoverable === null) {
          setTask(current => ({
            ...current,
            error: 'Channel access, public join permission, or discoverability is invalid.',
          }));
          return;
        }
        await performTask(
          `Updating /${selectedChannel.slug}`,
          reporter =>
            updateChannelSettings({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              slug: selectedChannel.slug,
              accessMode,
              publicJoinPermission,
              discoverable,
              reporter,
            }),
          () => {
            setLiveInboxRefreshToken(token => token + 1);
            setTask(current => ({
              ...current,
              notice: `Updated settings for /${selectedChannel.slug}.`,
            }));
          }
        );
      },
    });
  };

  const openSendChannelMessageTask = () => {
    if (!selectedChannel || !canSendSelectedChannel) {
      setTask(current => ({
        ...current,
        notice: selectedChannel
          ? `/${selectedChannel.slug} is read-only for ${selectedChannel.actorSlug}.`
          : 'Select a channel before sending.',
      }));
      return;
    }

    openTaskPanel({
      title: `Send to /${selectedChannel.slug}`,
      help:
        `Post signed plaintext as ${model?.activeInbox.slug ?? selectedChannel.actorSlug}. Channels are shared feeds, not private threads.`,
      submitLabel: 'Send',
      fields: [
        {
          key: 'message',
          label: 'Message',
          value: '',
          placeholder: 'channel message body',
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model) {
          return;
        }
        const message = values.message.trim();
        if (!message) {
          setTask(current => ({
            ...current,
            error: 'Message cannot be empty.',
          }));
          return;
        }
        await performTask(
          `Sending message to /${selectedChannel.slug}`,
          reporter =>
            sendChannelMessage({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              slug: selectedChannel.slug,
              message,
              contentType: 'text/plain',
              reporter,
            }),
          result => {
            void loadSelectedChannelMessages({
              beforeSeq: null,
              pageIndex: 0,
              beforeSeqStack: [null],
            });
            setTask(current => ({
              ...current,
              notice: `Sent message to /${result.slug ?? selectedChannel.slug}.`,
            }));
          }
        );
      },
    });
  };

  const openApproveChannelJoinTask = (approval: LiveChannelApproval) => {
    openTaskPanel({
      title: `Approve ${approval.requesterSlug}`,
      help: `Choose the permission to grant in #${approval.channelSlug}.`,
      submitLabel: 'Approve',
      fields: [
        {
          key: 'permission',
          label: 'Permission',
          value: normalizeChannelPermissionInput(approval.permission) ?? 'read',
          choices: [
            { value: 'read', label: 'Read only' },
            { value: 'read_write', label: 'Read/write' },
            { value: 'admin', label: 'Admin' },
          ],
          validate: value =>
            normalizeChannelPermissionInput(value) ? null : 'Choose a valid permission.',
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model) {
          return;
        }
        const permission = normalizeChannelPermissionInput(values.permission);
        if (!permission) {
          setTask(current => ({
            ...current,
            error: 'Choose a valid channel permission.',
          }));
          return;
        }
        await performTask(
          `Approving channel request #${approval.id}`,
          reporter =>
            approveChannelJoin({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              requestId: approval.id,
              permission,
              reporter,
            }),
          () => {
            setChannelApprovalIndex(0);
            setTask(current => ({
              ...current,
              notice: `Approved ${approval.requesterSlug} as ${describeChannelPermission(
                permission
              )}.`,
            }));
          }
        );
      },
    });
  };

  const openSetChannelMemberPermissionTask = (member: ChannelMemberListItem) => {
    if (!selectedChannel?.isAdmin) {
      return;
    }
    openTaskPanel({
      title: `Set ${member.agentSlug} permission`,
      help: `Choose the member permission in #${selectedChannel.slug}.`,
      submitLabel: 'Save',
      fields: [
        {
          key: 'permission',
          label: 'Permission',
          value: normalizeChannelPermissionInput(member.permission) ?? 'read',
          choices: [
            { value: 'read', label: 'Read only' },
            { value: 'read_write', label: 'Read/write' },
            { value: 'admin', label: 'Admin' },
          ],
          validate: value =>
            normalizeChannelPermissionInput(value) ? null : 'Choose a valid permission.',
        },
      ],
      onSubmit: async values => {
        setTaskPanel(null);
        if (!model || !selectedChannel) {
          return;
        }
        const permission = normalizeChannelPermissionInput(values.permission);
        if (!permission) {
          setTask(current => ({
            ...current,
            error: 'Choose a valid channel permission.',
          }));
          return;
        }
        await performTask(
          `Updating ${member.agentSlug} in /${selectedChannel.slug}`,
          reporter =>
            setChannelMemberPermission({
              profileName: options.profile,
              actorSlug: model.activeInbox.slug,
              slug: selectedChannel.slug,
              memberAgentDbId: member.agentDbId,
              permission,
              reporter,
            }),
          () => {
            setChannelMembersState(current =>
              current.channelId === selectedChannel.id
                ? {
                    ...current,
                    members: current.members.map(row =>
                      row.agentDbId === member.agentDbId ? { ...row, permission } : row
                    ),
                  }
                : current
            );
            setTask(current => ({
              ...current,
              notice: `Updated ${member.agentSlug} to ${describeChannelPermission(permission)}.`,
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
            setSelectedChannelSlug(null);
            setChannelMode('overview');
            setChannelTab('messages');
            setChannelMessagesState(createInitialChannelMessagesState());
            setChannelMembersState(createInitialChannelMembersState());
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
      getManagedAgentPrimaryActionTitle(selectedAgent),
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

  const openDeregisterSelectedAgentTask = () => {
    if (!selectedAgent) {
      return;
    }

    if (selectedAgent.deregistered) {
      setTask(current => ({
        ...current,
        notice: `Agent ${selectedAgent.slug} is already deregistering or deregistered.`,
      }));
      return;
    }

    if (!selectedAgent.managed || !selectedAgent.registered) {
      setTask(current => ({
        ...current,
        error: 'Only registered managed agents can be deregistered.',
      }));
      return;
    }

    const agent = selectedAgent;
    openTaskPanel({
      title: `Deregister ${agent.slug}`,
      help:
        `Warning: this removes /${agent.slug} from Masumi network discovery and prevents new chats. ` +
        'Local inbox history remains in SpacetimeDB. Type the slug to confirm.',
      submitLabel: 'Deregister',
      fields: [
        {
          key: 'confirmation',
          label: 'Confirm slug',
          value: '',
          placeholder: agent.slug,
          validate: value =>
            value !== agent.slug ? `Type ${agent.slug} to confirm deregistration.` : null,
        },
      ],
      onSubmit: async () => {
        setTaskPanel(null);
        await performTask(
          `Deregistering managed agent for ${agent.slug}`,
          reporter =>
            deregisterInboxAgent({
              profileName: options.profile,
              actorSlug: agent.slug,
              reporter,
            }),
          result => {
            setActiveInboxSlug(current =>
              current === result.actor.slug ? null : current
            );
            setSelectedChannelSlug(null);
            setChannelMode('overview');
            setChannelTab('messages');
            setChannelMessagesState(createInitialChannelMessagesState());
            setChannelMembersState(createInitialChannelMembersState());
            setTask(current => ({
              ...current,
              notice:
                result.registration.registrationState === 'DeregistrationConfirmed'
                  ? `Managed agent ${result.actor.slug} is deregistered.`
                  : `Managed agent ${result.actor.slug} status: ${
                      result.registration.registrationState ?? result.registration.status
                    }.`,
            }));
          }
        );
      },
    });
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
    const defaultShareDeviceIds =
      model?.account.devices
        .filter(device => device.status === 'approved')
        .map(device => device.deviceId)
        .join(', ') ?? '';
    const approvedDeviceIds =
      model?.account.devices
        .filter(device => device.status === 'approved')
        .map(device => device.deviceId)
        .join(', ') || 'no approved devices';

    openTaskPanel({
      title: 'Rotate agent keys',
      help: `Rotated keys sync to approved devices listed below by default. Remove ids to leave devices unsynced, or move ids to revoke them. Approved: ${approvedDeviceIds}`,
      submitLabel: 'Rotate',
      fields: [
        {
          key: 'shareDeviceIds',
          label: 'Share to devices',
          value: defaultShareDeviceIds,
          placeholder: 'comma-separated device ids',
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

      if (currentField?.choices && (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow)) {
        const direction = key.upArrow || key.leftArrow ? -1 : 1;
        const currentIndex = currentField.choices.findIndex(
          choice => choice.value === currentField.value
        );
        const nextChoice =
          currentField.choices[
            clampIndex(Math.max(currentIndex, 0) + direction, currentField.choices.length)
          ];
        if (nextChoice) {
          setTaskPanel(current =>
            current
              ? {
                  ...current,
                  fields: current.fields.map(field =>
                    field.key === currentField.key
                      ? {
                          ...field,
                          value: nextChoice.value,
                        }
                      : field
                  ),
                }
              : current
          );
        }
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
        if (currentField.choices) {
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
        if (currentField.choices) {
          return;
        }
        setTaskCursorIndex(current => clampCursor(current - 1, currentField.value.length));
        return;
      }

      if (key.rightArrow && currentField) {
        if (currentField.choices) {
          return;
        }
        setTaskCursorIndex(current => clampCursor(current + 1, currentField.value.length));
        return;
      }

      if (!key.ctrl && !key.meta && input && currentField) {
        if (currentField.choices) {
          return;
        }
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
      if (route.type === 'inboxes' && inboxFocus === 'detail') {
        setInboxFocus('navigator');
        return;
      }
      if (route.type === 'channels' && channelMode === 'detail') {
        setChannelMode('overview');
        setChannelTab('messages');
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
      if (sidebarShortcut === 'c') {
        setMainRoute('channels');
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
      if (inboxFocus === 'detail' && selectedRequest) {
        if (key.leftArrow || key.rightArrow) {
          setInboxDetailTab('approval');
          return;
        }
        if ((input === 'a' || key.return) && selectedRequest.direction === 'incoming') {
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
              setInboxFocus('navigator');
              setTask(current => ({
                ...current,
                notice: `Approved request #${selectedRequest.id}.`,
              }));
            }
          );
          return;
        }
        if (input === 'x' && selectedRequest.direction === 'incoming') {
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
              setInboxFocus('navigator');
              setTask(current => ({
                ...current,
                notice: `Rejected request #${selectedRequest.id}.`,
              }));
            }
          );
        }
        return;
      }

      if (inboxFocus === 'detail' && selectedThread) {
        if (key.leftArrow || key.rightArrow) {
          const currentIndex = inboxTabs.findIndex(tab => tab.key === inboxDetailTab);
          const direction = key.leftArrow ? -1 : 1;
          const nextIndex =
            (Math.max(currentIndex, 0) + direction + inboxTabs.length) % inboxTabs.length;
          setInboxDetailTab(inboxTabs[nextIndex]?.key ?? 'messages');
          return;
        }
        if (inboxDetailTab === 'members') {
          if (input === '+') {
            openAddThreadParticipantTask();
            return;
          }
          if (input === '-') {
            openRemoveThreadParticipantTask();
            return;
          }
          return;
        }
        if (input.toLowerCase() === 's') {
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
        if (inboxDetailTab === 'messages' && key.upArrow) {
          scrollOlder();
          return;
        }
        if (inboxDetailTab === 'messages' && key.downArrow) {
          scrollNewer();
          return;
        }
        if (input === 'm' && selectedThread.unreadMessages > 0) {
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
        if (selectedRequest) {
          setInboxDetailTab('approval');
          setInboxFocus('detail');
        } else if (selectedThread) {
          resetThreadWindow();
          setInboxDetailTab('messages');
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
      if (input === 'm' && selectedThread && selectedThread.unreadMessages > 0) {
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
      return;
    }

    if (route.type === 'channels') {
      const lowerInput = input.toLowerCase();

      if (channelMode === 'overview') {
        if (lowerInput === 'n' || input === '+') {
          openAddChannelTask();
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
        if (key.downArrow) {
          const next =
            model.channels.channels[
              clampIndex(selectedChannelIndex + 1, model.channels.channels.length)
            ];
          if (next) {
            setSelectedChannelSlug(next.slug);
            setChannelApprovalIndex(0);
          }
          return;
        }
        if (key.upArrow) {
          const next =
            model.channels.channels[
              clampIndex(selectedChannelIndex - 1, model.channels.channels.length)
            ];
          if (next) {
            setSelectedChannelSlug(next.slug);
            setChannelApprovalIndex(0);
          }
          return;
        }
        if (key.return && selectedChannel) {
          setSelectedChannelSlug(selectedChannel.slug);
          setChannelMode('detail');
          setChannelTab('messages');
          setChannelApprovalIndex(0);
          return;
        }
        return;
      }

      if (!selectedChannel) {
        setChannelMode('overview');
        setChannelTab('messages');
        return;
      }

      if (lowerInput === 'e' && selectedChannel.isAdmin) {
        openUpdateChannelSettingsTask();
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        const currentIndex = channelTabs.findIndex(tab => tab.key === channelTab);
        const direction = key.leftArrow ? -1 : 1;
        const nextIndex =
          (Math.max(currentIndex, 0) + direction + channelTabs.length) % channelTabs.length;
        setChannelTab(channelTabs[nextIndex]?.key ?? 'messages');
        return;
      }

      if (channelTab === 'messages') {
        if (input === '[' || key.upArrow) {
          await pageSelectedChannelMessages(key.upArrow ? 1 : -1);
          return;
        }
        if (input === ']' || key.downArrow) {
          await pageSelectedChannelMessages(key.downArrow ? -1 : 1);
          return;
        }
        if (lowerInput === 's' && canSendSelectedChannel) {
          openSendChannelMessageTask();
          return;
        }
        return;
      }

      if (channelTab === 'members') {
        if (key.downArrow) {
          setChannelMemberIndex(current =>
            clampIndex(current + 1, selectedChannelMemberItems.length)
          );
          return;
        }
        if (key.upArrow) {
          setChannelMemberIndex(current =>
            clampIndex(current - 1, selectedChannelMemberItems.length)
          );
          return;
        }
        if (input === '[') {
          await pageSelectedChannelMembers(-1);
          return;
        }
        if (input === ']') {
          await pageSelectedChannelMembers(1);
          return;
        }
        if (
          (lowerInput === 'p' || key.return) &&
          selectedChannel.isAdmin &&
          selectedChannelMember?.active
        ) {
          openSetChannelMemberPermissionTask(selectedChannelMember);
          return;
        }
        return;
      }

      if (channelTab === 'approvals') {
        if (!selectedChannel.isAdmin) {
          setChannelTab('messages');
          return;
        }
        if (key.downArrow) {
          setChannelApprovalIndex(current =>
            clampIndex(current + 1, selectedChannelApprovals.length)
          );
          return;
        }
        if (key.upArrow) {
          setChannelApprovalIndex(current =>
            clampIndex(current - 1, selectedChannelApprovals.length)
          );
          return;
        }
        if ((input === 'a' || key.return) && selectedChannelApproval) {
          openApproveChannelJoinTask(selectedChannelApproval);
          return;
        }
        if (input === 'x' && selectedChannelApproval) {
          await performTask(
            `Rejecting channel request #${selectedChannelApproval.id}`,
            reporter =>
              rejectChannelJoin({
                profileName: options.profile,
                actorSlug: model.activeInbox.slug,
                requestId: selectedChannelApproval.id,
                reporter,
              }),
            () => {
              setChannelApprovalIndex(0);
              setTask(current => ({
                ...current,
                notice: `Rejected channel request #${selectedChannelApproval.id}.`,
              }));
            }
          );
        }
        return;
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
          if (selectedAgent.deregistered) {
            setTask(current => ({
              ...current,
              notice: `Agent ${selectedAgent.slug} is deregistered and cannot be selected as active.`,
            }));
            return;
          }
          setActiveInboxSlug(selectedAgent.slug);
          setSelectedChannelSlug(null);
          setChannelMode('overview');
          setChannelTab('messages');
          setChannelMessagesState(createInitialChannelMessagesState());
          setChannelMembersState(createInitialChannelMembersState());
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
        return;
      }
      if (input.toLowerCase() === 'd') {
        openDeregisterSelectedAgentTask();
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
        if (isUnavailableForChatInboxAgentState(selectedDiscoveryResult.registrationState)) {
          setTask(current => ({
            ...current,
            notice: `Agent ${selectedDiscoveryResult.slug} is ${describeDiscoveryRegistrationState(selectedDiscoveryResult.registrationState)} and cannot be used for chats.`,
          }));
          return;
        }
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
      : route.type === 'channels'
        ? 'Channels'
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
      : route.type === 'channels'
        ? '[c]'
      : route.type === 'agents'
        ? '[a]'
        : route.type === 'discover'
          ? '[d]'
          : route.type === 'account'
            ? '[u]'
            : route.type === 'help'
              ? '[?]'
              : '';
  const headerRuleWidth = Math.max(0, Math.min(terminalSize.columns - 22, 58));
  const fullRuleWidth = Math.max(0, Math.min(terminalSize.columns, 80));
  const fullContentWidth = Math.max(1, fullRuleWidth);
  const contentListWidth = Math.max(1, terminalSize.columns - SIDEBAR_WIDTH - 3);
  const activePanelWidth = model ? contentListWidth : fullContentWidth;

  const contentHeader = (
    <Box flexDirection="column">
      <FixedLine
        text={`${sectionIcon ? `${sectionIcon} ` : ''}${sectionTitle}${
          model ? ` · ${model.activeInbox.slug}` : ''
        }`}
        width={activePanelWidth}
        color="cyan"
        bold
      />
      <Text color="gray" dimColor>{'─'.repeat(headerRuleWidth)}</Text>
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
          width={activePanelWidth}
        />
      ) : null}
      {pendingRegistrationPrompt ? (
        <Box
          borderStyle="single"
          borderColor="yellow"
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          width={activePanelWidth}
        >
          <FixedLine
            text={`Register managed agent for ${pendingRegistrationPrompt.slug} now?`}
            width={Math.max(1, activePanelWidth - 4)}
            color="yellow"
          />
          <FixedLine
            text="This publishes the inbox agent for Masumi SaaS discovery."
            width={Math.max(1, activePanelWidth - 4)}
            color="gray"
          />
          {pendingRegistrationPrompt.publicDescription ? (
            <FixedLine
              text="Description will be published with this agent."
              width={Math.max(1, activePanelWidth - 4)}
              color="gray"
            />
          ) : null}
          <FixedLine
            text="Enter/Y yes · N later"
            width={Math.max(1, activePanelWidth - 4)}
            color="yellow"
          />
        </Box>
      ) : null}
      {task.banner ? (
        <Box
          borderStyle="single"
          borderColor="yellow"
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          width={activePanelWidth}
        >
          <FixedLine
            text={`${task.banner.label ?? 'Code'}: ${task.banner.code}`}
            width={Math.max(1, activePanelWidth - 4)}
            color="yellow"
          />
          <FixedLine
            text={task.banner.hint}
            width={Math.max(1, activePanelWidth - 4)}
            color="gray"
          />
        </Box>
      ) : null}
      {task.active ? (
        <FixedLine text={`⠋ ${task.active}`} width={activePanelWidth} color="yellow" />
      ) : null}
      {task.notice ? (
        <FixedLine text={`✓ ${task.notice}`} width={activePanelWidth} color="green" />
      ) : null}
      {task.error ? (
        <FixedLine text={`✗ ${task.error}`} width={activePanelWidth} color="red" />
      ) : null}
      {connectionState.error ? (
        <FixedLine text={connectionState.error} width={activePanelWidth} color="red" />
      ) : null}
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
          { key: 'I/C/A/D/U', label: 'open by hotkey' },
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
          label: 'Thread Composer',
          detail: selectedThread.label,
          items: [
            { key: 'Type', label: 'edit draft' },
            { key: 'Enter', label: 'new line' },
            { key: 'Ctrl+S/X', label: 'send' },
            { key: 'Esc', label: 'thread messages' },
          ],
        };
      }

      if (inboxFocus === 'detail' && selectedRequest) {
        return {
          label: 'Thread Approval',
          detail:
            selectedRequest.direction === 'incoming'
              ? selectedRequest.requesterDisplayName ?? selectedRequest.requesterSlug
              : selectedRequest.targetDisplayName ?? selectedRequest.targetSlug,
          items: [
            ...(selectedRequest.direction === 'incoming'
              ? [{ key: 'A/Enter', label: 'approve' }, { key: 'X', label: 'reject' }]
              : []),
            { key: 'Esc', label: 'inbox overview' },
            { key: 'Tab', label: 'sidebar' },
          ],
        };
      }

      if (inboxFocus === 'detail' && selectedThread) {
        if (inboxDetailTab === 'members') {
          return {
            label: 'Thread Members',
            detail: selectedThread.label,
            items: [
              { key: '←/→', label: 'switch tab' },
              ...(!selectedThread.locked
                ? [{ key: '+/-', label: 'add/remove member' }]
                : []),
              { key: 'Esc', label: 'inbox overview' },
              { key: 'Tab', label: 'sidebar' },
            ],
          };
        }

        return {
          label: 'Thread Messages',
          detail: selectedThread.label,
          items: [
            { key: '←/→', label: 'switch tab' },
            {
              key: 'S',
              label: securityState.status === 'healthy' ? 'write message' : 'recover keys',
            },
            ...(canScrollOlder || canScrollNewer
              ? [{ key: '↑/↓', label: 'page messages' }]
              : []),
            ...(selectedThread.unreadMessages > 0 ? [{ key: 'M', label: 'mark read' }] : []),
            { key: 'Esc', label: 'inbox overview' },
            { key: 'Tab', label: 'sidebar' },
          ],
        };
      }

      if (inboxSection === 'pending' && selectedRequest) {
        return {
          label: 'Inbox Overview',
          detail:
            selectedRequest.direction === 'incoming'
              ? selectedRequest.requesterDisplayName ?? selectedRequest.requesterSlug
              : selectedRequest.targetDisplayName ?? selectedRequest.targetSlug,
          items: [
            ...(inboxSectionItems.length > 1 ? [{ key: '↑/↓', label: 'move requests' }] : []),
            { key: 'Enter', label: 'open approval' },
            { key: '←/→', label: 'section' },
            ...(model.ownedInboxes.length > 1 ? [{ key: '[ ]', label: 'agent' }] : []),
            { key: 'Tab', label: 'sidebar' },
          ],
        };
      }

      const overviewItemLabel = inboxSection === 'pending' ? 'requests' : 'threads';
      const selectedOverviewKind = selectedRequest
        ? 'request'
        : selectedThread
          ? 'thread'
          : 'item';
      return {
        label: 'Inbox Overview',
        detail: `${inboxSection} · ${threadFilter}`,
        items: [
          ...(inboxSectionItems.length > 1
            ? [{ key: '↑/↓', label: `move ${overviewItemLabel}` }]
            : []),
          ...(selectedInboxItem ? [{ key: 'Enter', label: `open ${selectedOverviewKind}` }] : []),
          ...(selectedThread && selectedThread.unreadMessages > 0
            ? [{ key: 'M', label: 'mark read' }]
            : []),
          ...(selectedThread ? [{ key: 'Z', label: selectedThread.archived ? 'restore' : 'archive' }] : []),
          { key: 'F', label: 'filter' },
          { key: '←/→', label: 'section' },
          ...(model.ownedInboxes.length > 1 ? [{ key: '[ ]', label: 'agent' }] : []),
          { key: 'N/G', label: 'new DM/group' },
          { key: 'Tab', label: 'sidebar' },
        ],
      };
    }

    if (route.type === 'channels') {
      if (channelMode === 'overview') {
        return {
          label: 'Channel Overview',
          detail: model.activeInbox.slug,
          items: [
            ...(model.channels.channels.length > 1
              ? [{ key: '↑/↓', label: 'select channel' }]
              : []),
            ...(selectedChannel ? [{ key: 'Enter', label: 'open channel' }] : []),
            { key: 'N/+', label: 'add channel' },
            ...(model.ownedInboxes.length > 1 ? [{ key: '[ ]', label: 'agent' }] : []),
            { key: 'Tab', label: 'sidebar' },
          ],
        };
      }

      if (channelTab === 'members') {
        return {
          label: 'Channel Members',
          detail: selectedChannel ? `#${selectedChannel.slug}` : undefined,
          items: [
            ...(channelTabs.length > 1 ? [{ key: '←/→', label: 'switch tab' }] : []),
            ...(selectedChannel?.isAdmin ? [{ key: 'E', label: 'settings' }] : []),
            ...(selectedChannelMemberItems.length > 1
              ? [{ key: '↑/↓', label: 'select member' }]
              : []),
            ...(selectedChannel?.isAdmin && selectedChannelMember?.active
              ? [{ key: 'P/Enter', label: 'set permission' }]
              : []),
            ...(canPageChannelMembersNewer || canPageChannelMembersOlder
              ? [{ key: '[ ]', label: 'page members' }]
              : []),
            { key: 'Esc', label: 'overview' },
            { key: 'Tab', label: 'sidebar' },
          ],
        };
      }

      if (channelTab === 'approvals' && selectedChannel?.isAdmin) {
        return {
          label: 'Channel Approvals',
          detail: selectedChannel ? `#${selectedChannel.slug}` : undefined,
          items: [
            ...(selectedChannelApprovals.length > 1
              ? [{ key: '↑/↓', label: 'select request' }]
              : []),
            { key: 'E', label: 'settings' },
            ...(selectedChannelApproval ? [{ key: 'A/Enter', label: 'approve' }] : []),
            ...(selectedChannelApproval ? [{ key: 'X', label: 'reject' }] : []),
            ...(channelTabs.length > 1 ? [{ key: '←/→', label: 'switch tab' }] : []),
            { key: 'Esc', label: 'overview' },
            { key: 'Tab', label: 'sidebar' },
          ],
        };
      }

      return {
        label: 'Channel Messages',
        detail: selectedChannel ? `#${selectedChannel.slug}` : undefined,
        items: [
          ...(channelTabs.length > 1 ? [{ key: '←/→', label: 'switch tab' }] : []),
          ...(selectedChannel?.isAdmin ? [{ key: 'E', label: 'settings' }] : []),
          ...(canSendSelectedChannel ? [{ key: 'S', label: 'send text' }] : []),
          ...(canPageChannelMessagesNewer || canPageChannelMessagesOlder
            ? [{ key: '↑/↓', label: 'page messages' }]
            : []),
          { key: 'Esc', label: 'overview' },
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
          { key: 'M', label: getManagedAgentPrimaryActionLabel(selectedAgent) },
          { key: 'D', label: 'deregister' },
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
          ...(selectedDiscoveryResult &&
          !isUnavailableForChatInboxAgentState(selectedDiscoveryResult.registrationState)
            ? [{ key: 'N', label: 'new thread' }]
            : []),
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
      <Box flexDirection="column" height={terminalSize.rows} overflow="hidden">
        {statusBar}
        <ModeBar mode={footerMode} width={fullContentWidth} />
      </Box>
    );
  }

  if (connectionState.mode === 'signed_out' || route.type === 'auth') {
    return (
      <Box flexDirection="column" height={terminalSize.rows} overflow="hidden">
        <Text color="gray" dimColor>{'─'.repeat(fullRuleWidth)}</Text>
        <Text> </Text>
        <Text color="yellow">You are signed out.</Text>
        <Text color="gray">Sign in to sync, recover keys, and manage devices.</Text>
        <Text> </Text>
        {statusBar}
        <ModeBar mode={footerMode} width={fullContentWidth} />
      </Box>
    );
  }

  if (!model) {
    const readyRows = connectionState.mode === 'ready' ? connectionState.rows : null;
    const defaultActor =
      readyRows && normalizedEmail
        ? readyRows.actors.find(
            actor => actor.isDefault && actor.normalizedEmail === normalizedEmail
          ) ?? null
        : null;
    const ownedActors =
      readyRows && defaultActor
        ? readyRows.actors
            .filter(actor => actor.inboxId === defaultActor.inboxId)
            .sort((left, right) => left.slug.localeCompare(right.slug))
        : [];
    const allOwnedActorsDeregistered =
      ownedActors.length > 0 &&
      ownedActors.every(actor =>
        isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)
      );

    if (allOwnedActorsDeregistered) {
      return (
        <Box flexDirection="column" height={terminalSize.rows} overflow="hidden">
          <Text color="yellow">
            All owned agents are deregistering or deregistered.
          </Text>
          <Text color="gray">
            Create or recover a usable inbox agent before sending chats or joining channels.
          </Text>
          <Box marginTop={1} flexDirection="column">
            {ownedActors.map(actor => (
              <FixedLine
                key={actor.id.toString()}
                text={`${actor.slug} · ${actor.masumiRegistrationState ?? 'unknown'}`}
                width={fullContentWidth}
              />
            ))}
          </Box>
          <Text> </Text>
          {statusBar}
          <ModeBar mode={footerMode} width={fullContentWidth} />
        </Box>
      );
    }

    return (
      <Box flexDirection="column" height={terminalSize.rows} overflow="hidden">
        <Text color="yellow">Loading shell state...</Text>
        {statusBar}
        <ModeBar mode={footerMode} width={fullContentWidth} />
      </Box>
    );
  }

  const attentionItems = model.dashboard.attentionItems;

  return (
    <Box flexDirection="row" height={terminalSize.rows} overflow="hidden">
      <Sidebar
        active={route.type}
        selectedNav={selectedSidebarNav}
        slug={model.activeInbox.slug}
        connectionLabel={connectionLabel}
        connectionDotColor={connectionDotColor}
        unreadCount={model.unreadCount}
        pendingCount={model.pendingRequestCount}
        channelApprovalCount={model.channels.pendingApprovalCount}
        shellFocus={shellFocus}
      />
      <Box
        flexDirection="column"
        flexGrow={1}
        height="100%"
        overflow="hidden"
        paddingLeft={1}
      >
        {contentHeader}

        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden">
          {attentionItems.length > 0 && route.type === 'inboxes' ? (
            <Box flexDirection="column">
              {attentionItems.map(item => (
                <FixedLine
                  key={item.id}
                  text={`${item.severity === 'critical' ? '✗' : '⚠'} ${item.title}${
                    item.id.startsWith('security:') ? ' · Press [U] to recover now.' : ''
                  }`}
                  width={contentListWidth}
                  color={item.severity === 'critical' ? 'red' : 'yellow'}
                />
              ))}
            </Box>
          ) : null}

        {route.type === 'help' ? (
          <Box flexDirection="column">
            <FixedLine text="  Inbox — threads, pending requests, message composition" width={contentListWidth} color="cyan" />
            <FixedLine text="  Channels — signed plaintext channels and admin join approvals" width={contentListWidth} color="cyan" />
            <FixedLine text="  My Agents — owned agents, profile, managed agent sync" width={contentListWidth} color="cyan" />
            <FixedLine text="  Discover — browse verified SaaS agents and search by slug or email" width={contentListWidth} color="cyan" />
            <FixedLine text="  Account — recovery, backups, trusted devices, rotation" width={contentListWidth} color="cyan" />
            <Text> </Text>
            <FixedLine text="  Tab moves between content and sidebar. In sidebar, ↑/↓ selects and Enter opens." width={contentListWidth} color="gray" />
            <FixedLine text="  In thread and channel messages, S starts writing. In a thread draft, Enter adds a line and Ctrl+S sends." width={contentListWidth} color="gray" />
            <FixedLine text="  The footer always shows the current mode and the keys that work there." width={contentListWidth} color="gray" />
          </Box>
        ) : null}

        {route.type === 'inboxes' ? (
          <Box flexDirection="column">
            <FixedLine
              text={`section ${inboxSection} · filter ${threadFilter}`}
              width={contentListWidth}
              color="gray"
            />
            <Box marginTop={1}>
              <TabStrip
                tabs={model.inboxes.sections.map(section => ({
                  key: section.key,
                  label: section.label,
                  count: section.count,
                }))}
                active={inboxSection}
                width={contentListWidth}
              />
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={inboxFocus === 'navigator' ? 'cyan' : 'white'} bold={inboxFocus === 'navigator'}>
                ◆ Inbox overview
              </Text>
              {renderList({
                items: inboxSectionItems.map(item => `${item.label} · ${item.subtitle}`),
                selectedIndex: selectedInboxIndex,
                empty:
                  inboxSection === 'pending'
                    ? 'No pending requests for this agent.'
                    : 'No threads match this section and filter.',
                maxWidth: contentListWidth,
              })}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text
                color={inboxFocus === 'detail' || inboxFocus === 'composer' ? 'cyan' : 'white'}
                bold={inboxFocus === 'detail' || inboxFocus === 'composer'}
              >
                ◆ Thread detail
              </Text>
              {selectedRequest ? (
                <Box flexDirection="column">
                  <FixedLine
                    text={`${
                      selectedRequest.direction === 'incoming'
                        ? selectedRequest.requesterDisplayName ?? selectedRequest.requesterSlug
                        : selectedRequest.targetDisplayName ?? selectedRequest.targetSlug
                    } · ${selectedRequest.direction}`}
                    width={contentListWidth}
                    bold
                  />
                  <FixedLine
                    text={`${selectedRequest.messageCount} message(s) · updated ${formatTimestamp(selectedRequest.updatedAt)}`}
                    width={contentListWidth}
                    color="gray"
                  />
                  {inboxFocus === 'detail' ? (
                    <Box marginTop={1}>
                      <TabStrip tabs={inboxTabs} active={inboxDetailTab} width={contentListWidth} />
                    </Box>
                  ) : null}
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
                    <FixedLine
                      text={`${selectedThread.label} · ${selectedThread.participantCount.toString()} participants${
                        selectedThread.locked ? ' · locked' : ''
                      }`}
                      width={contentListWidth}
                      bold
                    />
                    {inboxFocus === 'detail' || inboxFocus === 'composer' ? (
                      <Box marginTop={1}>
                        <TabStrip tabs={inboxTabs} active={inboxDetailTab} width={contentListWidth} />
                      </Box>
                    ) : null}
                    {inboxDetailTab === 'members' && inboxFocus === 'detail' ? (
                      <Box marginTop={1} flexDirection="column">
                        <Text color="gray">
                          {selectedThread.participantCount.toString()} member
                          {selectedThread.participantCount === 1 ? '' : 's'}
                        </Text>
                        {selectedThread.participants.length > 0 ? (
                          selectedThread.participants.map(participant => (
                            <FixedLine
                              key={participant}
                              text={`${participant}${
                                participant === model.activeInbox.slug ? ' · active agent' : ''
                              }`}
                              width={contentListWidth}
                              color={participant === model.activeInbox.slug ? 'cyan' : undefined}
                            />
                          ))
                        ) : (
                          <Text color="gray">No visible participants yet.</Text>
                        )}
                      </Box>
                    ) : (
                      <>
                        <FixedLine
                          text={`Thread messages · ${
                            totalThreadMessages === 0
                              ? '0-0'
                              : `${(threadWindowStart + 1).toString()}-${threadWindowEnd.toString()}`
                          } of ${totalThreadMessages.toString()}`}
                          width={contentListWidth}
                          color="gray"
                        />
                        {threadMessagesError ? <Text color="red">✗ {threadMessagesError}</Text> : null}
                        {threadMessages.length > 0 ? (
                          threadMessages.map(message => (
                            <ThreadMessageBlock
                              key={message.id}
                              message={message}
                              width={contentListWidth}
                            />
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
                                : 'Press S to start writing.'}
                            </Text>
                          )}
                          {inboxFocus === 'composer' && (threadDrafts[selectedThread.id] ?? '').length === 0 ? (
                            <Text color="cyan">_</Text>
                          ) : null}
                        </Box>
                      </>
                    )}
                  </Box>
              ) : (
                <Text color="gray">Select a thread or pending request to see details here.</Text>
              )}
            </Box>
          </Box>
        ) : null}

        {route.type === 'channels' ? (
          <Box flexDirection="column">
            <FixedLine
              text={`agent ${model.activeInbox.slug} · pending approvals ${model.channels.pendingApprovalCount.toString()}`}
              width={contentListWidth}
              color="gray"
            />
              {channelMode === 'overview' ? (
                <Box marginTop={1} flexDirection="column">
                  <Text color="cyan" bold>◆ Channel overview</Text>
                  {renderList({
                    items: model.channels.channels.map(channel => {
                      const labels = [
                        channel.permission,
                        channel.canSend ? 'can send' : null,
                        channel.accessMode === 'public'
                          ? `join ${describeChannelPermission(channel.publicJoinPermission)}`
                          : null,
                        channel.pendingApprovals > 0
                          ? `${channel.pendingApprovals.toString()} pending`
                          : null,
                        channel.discoverable ? 'discoverable' : 'hidden',
                      ].filter(Boolean);
                      return `#${channel.slug} · ${channel.title ?? 'untitled'} · ${labels.join(' · ')}`;
                    }),
                    selectedIndex: clampIndex(selectedChannelIndex, model.channels.channels.length),
                    empty: 'No channels for the active agent yet. Press N or + to add one.',
                    maxWidth: contentListWidth,
                  })}
                {selectedChannel ? (
                  <Box marginTop={1} flexDirection="column">
                    <FixedLine
                      text={`◆ Selected #${selectedChannel.slug} · ${selectedChannel.title ?? 'untitled'}`}
                      width={contentListWidth}
                      color="cyan"
                      bold
                    />
                    <FixedLine
                      text={`${
                        selectedChannel.accessMode === 'approval_required'
                          ? 'approval required'
                          : selectedChannel.accessMode
                      }${
                        selectedChannel.accessMode === 'public'
                          ? ` · join ${describeChannelPermission(
                              selectedChannel.publicJoinPermission
                            )}`
                          : ''
                      } · messages ${selectedChannel.lastMessageSeq} · last ${formatTimestamp(selectedChannel.lastMessageAt)}`}
                      width={contentListWidth}
                      color="gray"
                    />
                    <FixedLine
                      text={`${model.activeInbox.slug} has ${selectedChannel.permission}${
                        canSendSelectedChannel ? ' · can send' : ''
                      }${
                        selectedChannel.pendingApprovals > 0
                          ? ` · ${selectedChannel.pendingApprovals.toString()} pending`
                          : ''
                      }`}
                      width={contentListWidth}
                      color="gray"
                    />
                    {selectedChannel.description ? (
                      <DescriptionLines
                        text={selectedChannel.description}
                        width={contentListWidth}
                      />
                    ) : null}
                  </Box>
                ) : null}
              </Box>
            ) : selectedChannel ? (
              <Box marginTop={1} flexDirection="column">
                <FixedLine
                  text={`◆ #${selectedChannel.slug} · ${selectedChannel.title ?? 'untitled'}`}
                  width={contentListWidth}
                  color="cyan"
                  bold
                />
                <FixedLine
                  text={`${model.activeInbox.slug} has ${selectedChannel.permission}${
                    canSendSelectedChannel ? ' · can send' : ''
                  }${selectedChannel.isAdmin ? ' · admin' : ''} · messages ${
                    selectedChannel.lastMessageSeq
                  }`}
                  width={contentListWidth}
                  color="gray"
                />
                <FixedLine
                  text={`${
                    selectedChannel.accessMode === 'approval_required'
                      ? 'approval required'
                      : selectedChannel.accessMode
                  }${
                    selectedChannel.accessMode === 'public'
                      ? ` · join ${describeChannelPermission(
                          selectedChannel.publicJoinPermission
                        )}`
                      : ''
                  } · ${selectedChannel.discoverable ? 'discoverable' : 'hidden'}`}
                  width={contentListWidth}
                  color="gray"
                />
                {selectedChannel.description ? (
                  <DescriptionLines
                    text={selectedChannel.description}
                    width={contentListWidth}
                  />
                ) : null}
                <Box marginTop={1}>
                  <TabStrip tabs={channelTabs} active={channelTab} width={contentListWidth} />
                </Box>
                {channelTab === 'messages' ? (
                  <Box marginTop={1} flexDirection="column">
                    <FixedLine
                      text={`Channel messages · page ${(selectedChannelMessagePageIndex + 1).toString()}${
                        selectedChannelMessagesLoading ? ' · loading' : ''
                      }${canPageChannelMessagesNewer ? ' · newer available' : ''}${
                        canPageChannelMessagesOlder ? ' · older available' : ''
                      }`}
                      width={contentListWidth}
                      color="gray"
                    />
                    {selectedChannelMessagesError ? (
                      <Text color="red">✗ {selectedChannelMessagesError}</Text>
                    ) : null}
                    {selectedChannelMessageItems.length > 0 ? (
                      selectedChannelMessageItems.map(message => (
                        <ChannelMessageBlock
                          key={message.id}
                          message={message}
                          width={contentListWidth}
                        />
                      ))
                    ) : selectedChannelMessagesLoading ? (
                      <Text color="gray">Loading channel messages...</Text>
                    ) : (
                      <Text color="gray">No visible channel messages yet.</Text>
                    )}
                  </Box>
                ) : null}
                {channelTab === 'members' ? (
                  <Box marginTop={1} flexDirection="column">
                    <FixedLine
                      text={`Channel members · page ${(channelMembersState.pageIndex + 1).toString()}${
                        selectedChannelMembersLoading ? ' · loading' : ''
                      }${canPageChannelMembersNewer ? ' · newer available' : ''}${
                        canPageChannelMembersOlder ? ' · older available' : ''
                      }`}
                      width={contentListWidth}
                      color="gray"
                    />
                    {selectedChannelMembersError ? (
                      <Text color="red">✗ {selectedChannelMembersError}</Text>
                    ) : null}
                    {selectedChannelMemberItems.length > 0 ? (
                      <>
                        {renderList({
                          items: selectedChannelMemberItems.map(member => {
                            const label = member.agentDisplayName?.trim() || member.agentSlug;
                            return `${label} · ${member.agentSlug} · ${describeChannelPermission(
                              member.permission
                            )}${member.active ? '' : ' · inactive'} · sent ${member.lastSentSeq}`;
                          }),
                          selectedIndex: clampIndex(
                            channelMemberIndex,
                            selectedChannelMemberItems.length
                          ),
                          empty: 'No visible channel members yet.',
                          maxWidth: contentListWidth,
                        })}
                        {selectedChannelMember ? (
                          <Box marginTop={1} flexDirection="column">
                            <FixedLine
                              text={`${selectedChannelMember.agentDisplayName?.trim() || selectedChannelMember.agentSlug} · ${describeChannelPermission(selectedChannelMember.permission)}`}
                              width={contentListWidth}
                              bold
                            />
                            <FixedLine
                              text={`agent id ${selectedChannelMember.agentDbId} · ${
                                selectedChannelMember.active ? 'active' : 'inactive'
                              } · sent ${selectedChannelMember.lastSentSeq}`}
                              width={contentListWidth}
                              color="gray"
                            />
                          </Box>
                        ) : null}
                      </>
                    ) : selectedChannelMembersLoading ? (
                      <Text color="gray">Loading channel members...</Text>
                    ) : (
                      <Text color="gray">No visible channel members yet.</Text>
                    )}
                  </Box>
                ) : null}
                {channelTab === 'approvals' && selectedChannel.isAdmin ? (
                  <Box marginTop={1} flexDirection="column">
                    {renderList({
                      items: selectedChannelApprovals.map(request => {
                        const requester =
                          request.requesterDisplayName?.trim() || request.requesterSlug;
                        return `${requester} · ${request.permission} · ${formatTimestamp(request.updatedAt)}`;
                      }),
                      selectedIndex: clampIndex(
                        channelApprovalIndex,
                        selectedChannelApprovals.length
                      ),
                      empty: `No pending join approvals for #${selectedChannel.slug}.`,
                      maxWidth: contentListWidth,
                    })}
                    {selectedChannelApproval ? (
                      <Box marginTop={1} flexDirection="column">
                        <FixedLine
                          text={`${
                            selectedChannelApproval.requesterDisplayName ??
                            selectedChannelApproval.requesterSlug
                          } requested ${selectedChannelApproval.permission}`}
                          width={contentListWidth}
                          bold
                        />
                        <FixedLine
                          text={`request #${selectedChannelApproval.id} · created ${formatTimestamp(selectedChannelApproval.createdAt)}`}
                          width={contentListWidth}
                          color="gray"
                        />
                      </Box>
                    ) : null}
                  </Box>
                ) : null}
              </Box>
            ) : (
              <Box marginTop={1} flexDirection="column">
                <Text color="gray">Select or add a channel to open details.</Text>
              </Box>
            )}
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
                    agent.deregistered
                      ? 'deregistered'
                      : agent.registered
                        ? '✓ published'
                        : '✗ unpublished',
                  ].filter(Boolean).join(' · ');
                  return `${agent.slug} · ${flags}`;
                }),
                selectedIndex: clampIndex(selectedAgentIndex, model.agents.agentSummaries.length),
                empty: 'No owned agents found.',
                maxWidth: contentListWidth,
              })}
              {selectedAgent ? (
                <Box marginTop={1} flexDirection="column">
                  <Text color="cyan">◆ Selected agent</Text>
                  <FixedLine
                    text={`${selectedAgent.displayName ?? selectedAgent.slug} · ${selectedAgent.publicIdentity}`}
                    width={contentListWidth}
                    bold
                  />
                  <FixedLine
                    text={`linked email ${selectedAgent.publicLinkedEmailEnabled ? 'visible' : 'hidden'}`}
                    width={contentListWidth}
                    color="gray"
                  />
                  <Box marginTop={1} flexDirection="column">
                    <Text color="gray">Description</Text>
                    <Box marginLeft={2}>
                      <DescriptionLines
                        text={selectedAgent.publicDescription}
                        empty="No public description set."
                        width={Math.max(1, contentListWidth - 2)}
                      />
                    </Box>
                  </Box>
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
              {renderDiscoveryResultList({
                results: agentDiscovery.results,
                selectedIndex: clampIndex(selectedDiscoveryIndex, agentDiscovery.results.length),
                empty:
                  agentDiscovery.mode === 'search'
                    ? 'No verified SaaS matches on this page.'
                    : agentDiscovery.loaded
                      ? 'No registered SaaS agents on this page.'
                      : 'Loading discovery results…',
                width: contentListWidth,
              })}
              {selectedDiscoveryResult ? (
                <Box marginTop={1} flexDirection="column">
                  <Text color="cyan">◆ Selected discovery result</Text>
                  <FixedLine
                    text={selectedDiscoveryResult.displayName ?? selectedDiscoveryResult.slug}
                    width={contentListWidth}
                    bold
                  />
                  <Box marginTop={1} flexDirection="column">
                    <Text color="gray">Description</Text>
                    <Box marginLeft={2}>
                      <DescriptionLines
                        text={selectedDiscoveryResult.description}
                        width={Math.max(1, contentListWidth - 2)}
                        empty={
                          isUnavailableForChatInboxAgentState(
                            selectedDiscoveryResult.registrationState
                          )
                            ? `${describeDiscoveryRegistrationState(selectedDiscoveryResult.registrationState)} SaaS agent.`
                            : 'No public description set.'
                        }
                      />
                    </Box>
                  </Box>
                  <FixedLine
                    text={
                      selectedDiscoverySummaryRows.length > 0
                        ? selectedDiscoverySummaryRows.join(' · ')
                        : 'No known thread relationship yet.'
                    }
                    width={contentListWidth}
                    color="gray"
                  />
                  <FixedLine
                    text="Enter opens full details · S search · N new thread"
                    width={contentListWidth}
                    color="gray"
                  />
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
                      <FixedLine
                        text={`Public identity: ${
                          selectedDiscoveryDetail.selected.publicIdentity ?? 'not published'
                        }`}
                        width={contentListWidth}
                      />
                      <FixedLine
                        text={`Inbox published: ${selectedDiscoveryDetail.selected.inboxPublished ? 'yes' : 'no'}`}
                        width={contentListWidth}
                      />
                      <Box marginTop={1} flexDirection="column">
                        <Text color="gray">Description</Text>
                        <Box marginLeft={2}>
                          <DescriptionLines
                            text={selectedDiscoveryDetail.selected.description}
                            empty="No public description set."
                            width={Math.max(1, contentListWidth - 2)}
                          />
                        </Box>
                      </Box>
                      <FixedLine
                        text={`Encryption key version: ${
                          selectedDiscoveryDetail.selected.encryptionKeyVersion ?? 'n/a'
                        } · signing key version ${
                          selectedDiscoveryDetail.selected.signingKeyVersion ?? 'n/a'
                        }`}
                        width={contentListWidth}
                      />
                      {selectedDiscoveryDetail.publicRoute ? (
                        <Box flexDirection="column">
                          <FixedLine
                            text={`Linked email: ${
                              selectedDiscoveryDetail.publicRoute.linkedEmail ?? 'not published'
                            }`}
                            width={contentListWidth}
                          />
                          <FixedLine
                            text={`Contact policy: ${selectedDiscoveryDetail.publicRoute.contactPolicy.mode} · allowlist ${selectedDiscoveryDetail.publicRoute.contactPolicy.allowlistScope}`}
                            width={contentListWidth}
                          />
                          <FixedLine
                            text={`Preview before approval: ${
                              selectedDiscoveryDetail.publicRoute.contactPolicy
                                .messagePreviewVisibleBeforeApproval
                                ? 'yes'
                                : 'no'
                            }`}
                            width={contentListWidth}
                            color="gray"
                          />
                          <FixedLine
                            text={`Content types: ${
                              selectedDiscoveryDetail.publicRoute.allowAllContentTypes
                                ? 'all'
                                : selectedDiscoveryDetail.publicRoute.supportedContentTypes.length > 0
                                  ? selectedDiscoveryDetail.publicRoute.supportedContentTypes.join(', ')
                                  : 'none'
                            }`}
                            width={contentListWidth}
                            color="gray"
                          />
                          <FixedLine
                            text={`Headers: ${
                              selectedDiscoveryDetail.publicRoute.allowAllHeaders
                                ? 'all'
                                : selectedDiscoveryDetail.publicRoute.supportedHeaders.length > 0
                                  ? selectedDiscoveryDetail.publicRoute.supportedHeaders
                                      .map(header => header.name)
                                      .join(', ')
                                  : 'none'
                            }`}
                            width={contentListWidth}
                            color="gray"
                          />
                        </Box>
                      ) : (
                        <FixedLine
                          text="No extended public route metadata is published for this agent."
                          width={contentListWidth}
                          color="gray"
                        />
                      )}
                      {sharedThreadsWithDiscoveredAgent.length > 0 ? (
                        <FixedLine
                          text={`Latest shared thread: ${
                            sharedThreadsWithDiscoveredAgent[0]?.label ?? 'n/a'
                          } · ${formatTimestamp(sharedThreadsWithDiscoveredAgent[0]?.lastMessageAt)}`}
                          width={contentListWidth}
                          color="gray"
                        />
                      ) : (
                        <FixedLine
                          text="No shared threads yet. Press N to start one."
                          width={contentListWidth}
                          color="gray"
                        />
                      )}
                    </Box>
                  ) : (
                    <FixedLine
                      text="Press Enter to load public details for this agent."
                      width={contentListWidth}
                      color="gray"
                    />
                  )}
                </Box>
              ) : null}
            </Box>
          </Box>
        ) : null}

        {route.type === 'account' ? (
          <Box flexDirection="column">
            <FixedLine
              text={`Signed in as ${connectionState.auth.claims.email ?? 'unknown'} · profile ${connectionState.auth.profile.name}`}
              width={contentListWidth}
            />
            <FixedLine
              text={`${accountFocus === 'security' ? '▸ ' : '  '}Security · ${
                accountFocus === 'devices' ? '▸ ' : '  '
              }Devices`}
              width={contentListWidth}
              color="gray"
            />
            {accountFocus === 'security' ? (
              <Box marginTop={1} flexDirection="column">
                <Text color="cyan">◆ Security & recovery</Text>
                <FixedLine
                  text={model.account.securityState.title}
                  width={contentListWidth}
                  bold
                />
                <FixedLine
                  text={model.account.securityState.description}
                  width={contentListWidth}
                  color="gray"
                />
                {renderList({
                  items: securityActions.map(action => `${action.label} · ${action.description}`),
                  selectedIndex: clampIndex(securityActionIndex, securityActions.length),
                  empty: 'No account actions available.',
                  maxWidth: contentListWidth,
                })}
              </Box>
            ) : (
              <Box marginTop={1} flexDirection="column">
                <Text color="cyan">◆ Trusted devices</Text>
                {model.account.deviceRequests.length > 0 ? (
                  model.account.deviceRequests.slice(0, 3).map(request => (
                    <FixedLine
                      key={request.id}
                      text={`  pending ${request.deviceId} · expires ${formatTimestamp(request.expiresAt)}`}
                      width={contentListWidth}
                      color="yellow"
                    />
                  ))
                ) : null}
                {renderList({
                  items: model.account.devices.map(
                    device =>
                      `${device.label ?? device.deviceId} · ${device.status} · ${formatTimestamp(device.lastSeenAt)}${device.pendingShareCount > 0 ? ` · ${device.pendingShareCount} pending` : ''}`
                  ),
                  selectedIndex: clampIndex(deviceSelection, model.account.devices.length),
                  empty: 'No trusted devices found.',
                  maxWidth: contentListWidth,
                })}
              </Box>
            )}
          </Box>
        ) : null}

        </Box>

        <Box flexShrink={0} flexDirection="column">
          {statusBar}
          <ModeBar mode={footerMode} width={contentListWidth} />
        </Box>
      </Box>
    </Box>
  );
}
