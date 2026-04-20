import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChatText,
  Check,
  Checks,
  CircleDashed,
  Clock,
  Gear,
  Lock,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Shield,
  ShieldCheck,
  ShieldSlash,
  Trash,
  Tray,
  UserMinus,
  UserPlus,
  Users,
  X,
} from '@phosphor-icons/react';
import { InboxShell } from '@/components/app/inbox-shell';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import { ThreadListItem } from '@/components/inbox/thread-list-item';
import { ConnectionStatus } from '@/components/thread/connection-status';
import { DayDivider } from '@/components/inbox/day-divider';
import { EmptyState } from '@/components/inbox/empty-state';
import { KeyRotationItem, MessageItem } from '@/components/inbox/message-item';
import { MessageComposer } from '@/components/inbox/message-composer';
import { computeDayBoundaries, computeGroupedFlags } from '@/lib/group-messages';
import { formatDayLabel } from '@/lib/format-relative-time';
import { staggeredDelay } from '@/lib/use-staggered-delay';
import { KeyVaultDialog } from '@/components/key-vault-form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  clearPendingDeviceShareKeyMaterial,
  commitStoredAgentKeyRotation,
  exportInboxKeyShareSnapshot,
  getKeyVaultStatus,
  getAgentKeyPairForEncryptionVersion,
  getOrCreateAgentKeyPair,
  getOrCreateDeviceKeyMaterial,
  initializeKeyVault,
  loadStoredAgentKeyPair,
  loadStoredDeviceKeyMaterial,
  previewStoredAgentKeyRotation,
  setActiveActorIdentity,
  type DeviceKeyMaterial,
  type KeyVaultOwner,
  unlockKeyVault,
} from '@/lib/agent-session';
import { describeActor } from '@/lib/agent-directory';
import {
  buildWorkspaceSearch,
  buildOwnedInboxAgentEntries,
  describeLocalVaultRequirement,
  findSessionOwnedInbox,
  parseComposeMode,
  parseOptionalThreadId,
  parseOptionalLookup,
  parseWorkspaceSettingsTab,
  parseWorkspaceTab,
  type DefaultKeyIssue,
} from '@/lib/app-shell';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { buildRouteHead } from '@/lib/seo';
import { buildLoginHref, useAuthSession } from '@/lib/auth-session';
import { KeysRecoveryDialog } from '@/components/app/keys-recovery-dialog';
import { RotationShareDialog } from '@/components/app/rotation-share-dialog';
import { formatTimestamp } from '@/lib/thread-format';
import {
  buildApprovedDeviceShare,
  importClaimedDeviceShare,
  prepareLocalDeviceShareRequest,
  resolveVerifiedDeviceShareRequest,
} from '@/lib/device-share';
import {
  consumeKeyBackupPrompt,
  queueKeyBackupPrompt,
} from '@/lib/key-backup-prompt';
import {
  autoPinPeerIfUnknown,
  comparePinnedPeer,
  confirmPeerKeyRotation,
  describeTupleDiff,
  isInboundSignatureTrusted,
  tupleFromVisibleActor,
  type PeerKeyTuple,
} from '@/lib/peer-key-trust';
import { resolvePublishedActorsForIdentifier } from '@/lib/published-actor-search';
import { useLiveTable } from '@/lib/spacetime-live-table';
import {
  cacheSenderSecret,
  decryptMessage,
  getCachedSenderSecret,
  prepareEncryptedMessage,
  type ActorIdentity,
  type ActorPublicKeys,
  type AgentKeyPair,
} from '@/lib/crypto';
import { DbConnection, reducers, tables } from '@/module_bindings';
import type {
  Agent,
  AgentKeyBundle,
  Thread,
  ThreadParticipant,
  ThreadReadState,
  ThreadSecretEnvelope,
  Device,
  DeviceKeyBundleAttachment,
  Inbox,
  Message,
  VisibleContactRequestRow,
  VisibleContactAllowlistEntryRow,
  VisibleThreadInviteRow,
  VisibleDeviceKeyBundleRow,
  VisibleDeviceShareRequestRow,
} from '@/module_bindings/types';
import { useReducer, useSpacetimeDB } from 'spacetimedb/tanstack';
import { Timestamp } from 'spacetimedb';
import {
  findDirectThreads,
  generateClientThreadId,
} from '../../../shared/inbox-state';
import {
  findUnsupportedMessageReasons,
  formatEncryptedMessageBody,
  parseDecryptedMessagePlaintext,
  type EncryptedMessageHeader,
} from '../../../shared/message-format';
import { MAX_MESSAGE_BODY_CHARS } from '../../../shared/message-limits';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { isTimestampInFuture } from '../../../shared/spacetime-time';
import type {
  PublishedActorLookupLike,
  ResolvedPublishedActor,
} from '../../../shared/published-actors';
import {
  formatRotateKeysError,
  getActorPublishedCapabilities,
  matchesPublishedActorKeys,
  toActorIdentity,
} from '@/features/workspace/actor-settings';
import { useWorkspaceWriteAccess } from '@/features/workspace/use-write-access';

const THREAD_LIST_PAGE_SIZE = 30;
const THREAD_TIMELINE_PAGE_SIZE = 50;
const THREAD_LIST_SCROLL_LOAD_THRESHOLD_PX = 64;

export const Route = createFileRoute('/$slug')({
  validateSearch: search => ({
    thread: parseOptionalThreadId(search.thread),
    compose: parseComposeMode(search.compose),
    lookup: parseOptionalLookup(search.lookup),
    tab: parseWorkspaceTab(search.tab),
    settings: parseWorkspaceSettingsTab(search.settings),
  }),
  head: ({ params }) =>
    buildRouteHead({
      title: `/${params.slug}`,
      description: `Encrypted threads for /${params.slug} on the Masumi network.`,
      path: `/${params.slug}`,
    }),
  component: InboxPage,
});

type DecryptedMessageState = {
  status: 'ok' | 'unsupported' | 'failed';
  bodyText: string | null;
  error: string | null;
  contentType: string | null;
  headerNames: string[];
  headers: EncryptedMessageHeader[] | null;
  unsupportedReasons: string[];
  revealedUnsupported: boolean;
  legacyPlaintext: boolean;
  trustStatus: 'self' | 'trusted' | 'unpinned-first-seen' | 'untrusted-rotation';
  trustWarning: string | null;
};
type DecryptedMap = Record<string, DecryptedMessageState>;
type DisplayInbox = Pick<
  Inbox,
  | 'normalizedEmail'
  | 'displayEmail'
  | 'authVerified'
  | 'emailAttested'
  | 'authIssuer'
  | 'authSubject'
> & {
  authVerifiedAt?: Inbox['authVerifiedAt'];
  authVerifiedAtLabel?: string;
};
type KeyRotationNotice = {
  actor: Agent;
  bundle: AgentKeyBundle;
};
type ThreadTimelineItem =
  | {
      kind: 'message';
      message: Message;
    }
  | {
      kind: 'keyRotation';
      notice: KeyRotationNotice;
    };
type PendingDeviceShareRequestState = {
  device: DeviceKeyMaterial;
  verificationCode: string;
  verificationSymbols: string[];
  verificationWords: string[];
  expiresAt: string;
};

type PublicLookupActor = {
  slug: string;
  publicIdentity: string;
  isDefault: boolean;
  displayName: string | null;
};

type PublicLookupRouteInfo = {
  description: string | null;
  linkedEmail: string | null;
};

type PublicLookupSummary = {
  activeThreads: number | null;
  dedicatedMemberCount: number | null;
  requestedThreads: number;
};

type ThreadRailFilter = 'active' | 'latest' | 'archived';
const THREAD_RAIL_FILTER_OPTIONS = [
  ['active', 'Active', ChatText],
  ['latest', 'Latest', Clock],
  ['archived', 'Archived', Archive],
] as const;

function describeResolvedActor(actor: ResolvedPublishedActor): string {
  return actor.displayName?.trim()
    ? `${actor.displayName} (${actor.slug})`
    : actor.slug;
}

function describeTargetSubtitle(actor: Agent | ResolvedPublishedActor): string | null {
  if ('normalizedEmail' in actor) {
    return actor.normalizedEmail ?? null;
  }

  const linkedEmail = actor.linkedEmail?.trim();
  return linkedEmail || null;
}

function normalizeNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function describeActorOption(actor: Agent | ResolvedPublishedActor): string {
  return 'normalizedEmail' in actor ? describeActor(actor) : describeResolvedActor(actor);
}

function actorOptionId(actor: Agent | ResolvedPublishedActor): string {
  return actor.publicIdentity;
}

function mergeResolvedActors(
  current: ResolvedPublishedActor[],
  incoming: ResolvedPublishedActor[]
): ResolvedPublishedActor[] {
  const merged = new Map(current.map(actor => [actor.publicIdentity, actor] as const));
  for (const actor of incoming) {
    merged.set(actor.publicIdentity, actor);
  }
  return Array.from(merged.values());
}

function InboxComposeDialog({
  open,
  onOpenChange,
  canWrite,
  vaultUnlocked,
  connected,
  composeLookupSlug,
  onComposeLookupSlugChange,
  onResolveComposeTargets,
  composeOptions,
  selectedComposeActorIds,
  onToggleComposeActor,
  composeThreadTitle,
  onComposeThreadTitleChange,
  composeThreadLocked,
  onComposeThreadLockedChange,
  composeFirstMessage,
  onComposeFirstMessageChange,
  onSubmitCompose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
  vaultUnlocked: boolean;
  connected: boolean;
  composeLookupSlug: string;
  onComposeLookupSlugChange: (value: string) => void;
  onResolveComposeTargets: () => void | Promise<void>;
  composeOptions: Array<Agent | ResolvedPublishedActor>;
  selectedComposeActorIds: string[];
  onToggleComposeActor: (actorId: string) => void;
  composeThreadTitle: string;
  onComposeThreadTitleChange: (value: string) => void;
  composeThreadLocked: boolean;
  onComposeThreadLockedChange: (checked: boolean) => void;
  composeFirstMessage: string;
  onComposeFirstMessageChange: (value: string) => void;
  onSubmitCompose: () => void | Promise<void>;
}) {
  const selectedComposeActors = composeOptions.filter(actor =>
    selectedComposeActorIds.includes(actorOptionId(actor))
  );
  const selectedCount = selectedComposeActorIds.length;
  const isDirectMode = selectedCount === 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] w-full max-w-[38rem] animate-soft-fade overflow-y-auto border-border bg-background/95 p-4">
          <DialogHeader className="space-y-1">
          <DialogTitle>Add thread</DialogTitle>
          <DialogDescription>Find recipients and start a thread.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={composeLookupSlug}
              onChange={event => onComposeLookupSlugChange(event.target.value)}
              placeholder="Slug or email (e.g. /planner-bot)"
              disabled={!canWrite}
              className="h-9 text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void onResolveComposeTargets()}
              disabled={!canWrite || !composeLookupSlug.trim()}
            >
              <MagnifyingGlass className="h-4 w-4" />
              Search
            </Button>
          </div>

          {composeOptions.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Search a slug or email to add recipients.
            </p>
          ) : (
            <div className="max-h-60 space-y-1 overflow-y-auto pr-1">
              {composeOptions.map((actor, index) => {
                const actorId = actorOptionId(actor);
                const subtitle = describeTargetSubtitle(actor);
                const isSelected = selectedComposeActorIds.includes(actorId);

                return (
                  <button
                    key={actorId}
                    type="button"
                    onClick={() => onToggleComposeActor(actorId)}
                    disabled={!canWrite}
                    style={staggeredDelay(index, 12)}
                    className={`animate-soft-subtle flex w-full flex-col rounded-md border px-2.5 py-2 text-left transition ${
                      isSelected
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2 truncate text-sm font-medium leading-snug">
                      <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />
                      {describeActorOption(actor)}
                    </span>
                    {subtitle ? (
                      <span className="mt-1 truncate text-[11px] text-muted-foreground">
                        {subtitle}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-xs font-medium">
              <Users className="h-3.5 w-3.5" />
              Selected: {selectedCount}
            </div>
            {selectedComposeActors.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {selectedComposeActors.map((actor) => {
                  const actorId = actorOptionId(actor);
                  return (
                    <Badge
                      key={actorId}
                      variant="secondary"
                      className="gap-1"
                    >
                      <Check className="h-3 w-3" />
                      {describeActorOption(actor)}
                    </Badge>
                  );
                })}
              </div>
            ) : null}
          </div>

          <Input
            value={composeThreadTitle}
            onChange={event => onComposeThreadTitleChange(event.target.value)}
            placeholder="Thread title (optional)"
            disabled={!canWrite}
            className="h-9 text-sm"
          />

          {!isDirectMode ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={composeThreadLocked}
                onChange={event => onComposeThreadLockedChange(event.target.checked)}
                disabled={!canWrite || selectedCount <= 1}
              />
              Lock membership
            </label>
          ) : null}

          {isDirectMode ? (
            <Textarea
              value={composeFirstMessage}
              onChange={event => onComposeFirstMessageChange(event.target.value)}
              placeholder="First message"
              maxLength={MAX_MESSAGE_BODY_CHARS}
              disabled={!canWrite || !vaultUnlocked}
              className="min-h-24 text-sm"
            />
          ) : null}

          <p className="text-xs text-muted-foreground">
            {isDirectMode
              ? connected
                ? 'Direct threads need a first message.'
                : 'Waiting for live connection before threads can open.'
              : selectedCount > 1
                ? 'Create a group thread with all selected recipients.'
                : 'Group threads need at least two recipients.'}
          </p>

          <Button
            type="button"
            className="w-full"
            onClick={() => void onSubmitCompose()}
            disabled={
              !canWrite ||
              !connected ||
              selectedCount === 0 ||
              (isDirectMode && (!vaultUnlocked || !composeFirstMessage.trim()))
            }
          >
            {isDirectMode ? <ChatText className="h-4 w-4" /> : <Users className="h-4 w-4" />}
            {isDirectMode ? 'Request thread' : 'Create thread'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ParticipantsDialog({
  open,
  onOpenChange,
  title,
  participants,
  actorById,
  activeActorId,
  activeParticipantIsAdmin,
  locked,
  canWriteToActiveInbox,
  pendingParticipantLookupSlug,
  onPendingParticipantLookupSlugChange,
  onResolveAddParticipant,
  addParticipantOptions,
  pendingParticipantId,
  onPendingParticipantIdChange,
  onAddParticipant,
  onRemoveParticipant,
  onSetParticipantAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  participants: ThreadParticipant[];
  actorById: Map<bigint, Agent>;
  activeActorId: bigint | null;
  activeParticipantIsAdmin: boolean;
  locked: boolean;
  canWriteToActiveInbox: boolean;
  pendingParticipantLookupSlug: string;
  onPendingParticipantLookupSlugChange: (value: string) => void;
  onResolveAddParticipant: () => void | Promise<void>;
  addParticipantOptions: Array<Agent | ResolvedPublishedActor>;
  pendingParticipantId: string;
  onPendingParticipantIdChange: (value: string) => void;
  onAddParticipant: () => void | Promise<void>;
  onRemoveParticipant: (participantActorId: bigint) => void | Promise<void>;
  onSetParticipantAdmin: (participantActorId: bigint, isAdmin: boolean) => void | Promise<void>;
}) {
  const isLocked = locked;
  const canManageMembership = activeParticipantIsAdmin && canWriteToActiveInbox && !isLocked;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] w-full max-w-2xl overflow-y-auto border-border bg-background/95 p-4">
        <DialogHeader className="space-y-1">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Review members, roles, and secure membership changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pb-1">
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <p className="text-sm font-medium">Members</p>
              <Badge variant="secondary" className="text-[10px]">{participants.length.toString()} total</Badge>
            </div>

            {participants.length > 0 ? (
              <ScrollArea className="max-h-72">
                <div className="space-y-0.5 p-1.5">
                  {participants
                    .slice()
                    .sort((left, right) => {
                      if (left.isAdmin !== right.isAdmin) {
                        return left.isAdmin ? -1 : 1;
                      }

                      return (
                        (actorById.get(left.agentDbId)?.displayName ?? left.agentDbId.toString()).localeCompare(
                          actorById.get(right.agentDbId)?.displayName ?? right.agentDbId.toString()
                        ) || Number(left.id - right.id)
                      );
                    })
                    .map(participant => {
                      const participantActor = actorById.get(participant.agentDbId);
                      const isSelf = participant.agentDbId === activeActorId;
                      const canRemove = isSelf || canManageMembership;
                      const canChangeRole = canManageMembership && !isSelf;
                      const name = participantActor
                        ? describeActor(participantActor)
                        : `Actor ${participant.agentDbId.toString()}`;
                      const identity = participantActor?.publicIdentity ?? null;
                      const displayName =
                        participantActor?.displayName?.trim() ??
                        participantActor?.slug ??
                        name;

                      return (
                        <div
                          key={participant.id.toString()}
                          className="flex items-start gap-3 rounded-md px-2.5 py-2 hover:bg-muted/50"
                        >
                          <AgentAvatar
                            name={displayName}
                            identity={identity ?? name}
                            size="sm"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{displayName}</p>
                            {identity ? (
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                {identity}
                              </p>
                            ) : null}
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {participant.isAdmin ? <Badge variant="secondary" className="text-[10px]">admin</Badge> : null}
                              {isSelf ? <Badge variant="secondary">you</Badge> : null}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <label className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="accent-primary"
                                checked={participant.isAdmin}
                                onChange={event =>
                                  void onSetParticipantAdmin(participant.agentDbId, event.target.checked)
                                }
                                disabled={!canChangeRole}
                              />
                              admin
                            </label>
                            {canRemove ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void onRemoveParticipant(participant.agentDbId)}
                                aria-label={`Remove ${name}`}
                              >
                                <UserMinus className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </ScrollArea>
            ) : (
              <p className="px-3 py-2 text-sm text-muted-foreground">No members found.</p>
            )}

            {isLocked ? (
              <div className="flex items-start gap-2 border-t border-border px-3 py-2 text-sm text-muted-foreground">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Membership is locked. Ask an admin to unlock this thread before editing members.
                </span>
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-3 py-2">
              <p className="text-sm font-medium">Membership rules</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
              {canManageMembership
                  ? 'Admins can add members and update roles.'
                  : isLocked
                    ? 'Membership changes are locked for this thread.'
                    : 'Only admins can edit membership right now.'}
              </p>
            </div>

            {canManageMembership ? (
              <div className="space-y-2 p-3">
                <div className="flex gap-2">
                  <Input
                    value={pendingParticipantLookupSlug}
                    onChange={event => onPendingParticipantLookupSlugChange(event.target.value)}
                    placeholder="Add by slug or email"
                    disabled={!canWriteToActiveInbox}
                    className="h-8 text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void onResolveAddParticipant()}
                    disabled={!canWriteToActiveInbox || !pendingParticipantLookupSlug.trim()}
                  >
                    <MagnifyingGlass className="h-4 w-4" />
                  </Button>
                </div>
                {addParticipantOptions.length > 0 ? (
                  <div className="flex gap-2">
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                      value={pendingParticipantId}
                      onChange={event => onPendingParticipantIdChange(event.target.value)}
                      disabled={!canWriteToActiveInbox}
                    >
                      {addParticipantOptions.map(actor => (
                        <option key={actorOptionId(actor)} value={actorOptionId(actor)}>
                          {describeActorOption(actor)}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void onAddParticipant()}
                      disabled={!canWriteToActiveInbox || !pendingParticipantId}
                    >
                      <UserPlus className="h-4 w-4" />
                      Add
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {pendingParticipantLookupSlug.trim()
                      ? 'No matching inboxes found. Resolve first, then add.'
                      : 'Resolve a slug or email to add a member.'}
                  </p>
                )}
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                Ask the admin to add members or update roles.
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function isApprovalRequiredForFirstContactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('requires approval for first contact');
}

export class PeerKeyRotationUnconfirmedError extends Error {
  readonly slug: string;
  readonly publicIdentity: string;
  readonly diff: string[];

  constructor(params: { slug: string; publicIdentity: string; diff: string[] }) {
    super(
      `Keys for ${params.slug} have rotated: ${params.diff.join('; ')}. Verify out-of-band, then confirm the new keys before sending.`
    );
    this.name = 'PeerKeyRotationUnconfirmedError';
    this.slug = params.slug;
    this.publicIdentity = params.publicIdentity;
    this.diff = params.diff;
  }
}

async function ensurePeerTrust(params: {
  slug: string;
  publicIdentity: string;
  observed: PeerKeyTuple;
  allowFirstContactTrust: boolean;
  confirm?: (message: string) => boolean | Promise<boolean>;
}): Promise<void> {
  const comparison = params.allowFirstContactTrust
    ? autoPinPeerIfUnknown(params.publicIdentity, params.observed)
    : comparePinnedPeer(params.publicIdentity, params.observed);
  if (
    comparison.status === 'matches' ||
    (comparison.status === 'unpinned' && params.allowFirstContactTrust)
  ) {
    return;
  }

  if (comparison.status === 'unpinned') {
    throw new Error(
      `Keys for "${params.slug}" are not trusted for this existing contact. Verify them out-of-band before sending.`
    );
  }

  const diff = describeTupleDiff(comparison.pinned.current, params.observed);
  const confirmFn =
    params.confirm ??
    (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function'
      ? (message: string) => globalThis.confirm(message)
      : () => false);

  const message = `Keys for "${params.slug}" have rotated:\n\n${diff.join('\n')}\n\nOnly trust these keys after verifying out-of-band (e.g. a message in a separate channel). Trust the new keys?`;
  const accepted = await Promise.resolve(confirmFn(message));
  if (!accepted) {
    throw new PeerKeyRotationUnconfirmedError({
      slug: params.slug,
      publicIdentity: params.publicIdentity,
      diff,
    });
  }
  confirmPeerKeyRotation(params.publicIdentity, params.observed);
}

function toActorPublicKeys(actor: Agent): ActorPublicKeys {
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

function toPublishedActorPublicKeys(actor: PublishedActorLookupLike): ActorPublicKeys {
  return {
    normalizedEmail: '',
    slug: actor.slug,
    isDefault: actor.isDefault,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName ?? null,
    encryptionPublicKey: actor.encryptionPublicKey,
    encryptionKeyVersion: actor.encryptionKeyVersion,
    signingPublicKey: actor.signingPublicKey,
    signingKeyVersion: actor.signingKeyVersion,
  };
}

function compareTimestamp(
  left: { microsSinceUnixEpoch: bigint },
  right: { microsSinceUnixEpoch: bigint }
): number {
  if (left.microsSinceUnixEpoch < right.microsSinceUnixEpoch) return -1;
  if (left.microsSinceUnixEpoch > right.microsSinceUnixEpoch) return 1;
  return 0;
}

function mergeThreadTimeline(
  messages: Message[],
  keyRotationNotices: KeyRotationNotice[]
): ThreadTimelineItem[] {
  const timeline: ThreadTimelineItem[] = [];
  let noticeIndex = 0;

  for (const message of messages) {
    while (
      noticeIndex < keyRotationNotices.length &&
      compareTimestamp(keyRotationNotices[noticeIndex].bundle.createdAt, message.createdAt) <= 0
    ) {
      timeline.push({
        kind: 'keyRotation',
        notice: keyRotationNotices[noticeIndex],
      });
      noticeIndex += 1;
    }

    timeline.push({
      kind: 'message',
      message,
    });
  }

  while (noticeIndex < keyRotationNotices.length) {
    timeline.push({
      kind: 'keyRotation',
      notice: keyRotationNotices[noticeIndex],
    });
    noticeIndex += 1;
  }

  return timeline;
}

function sameKeyPair(left: AgentKeyPair | null, right: AgentKeyPair | null): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function getActiveActorKeyIssue(
  actor: Agent | undefined,
  keyPair: AgentKeyPair | null
): DefaultKeyIssue {
  if (!keyPair) {
    return 'missing';
  }

  if (actor && !matchesPublishedActorKeys(actor, keyPair)) {
    return 'mismatch';
  }

  return null;
}

function getActiveActorKeyError(issue: DefaultKeyIssue): string | null {
  if (issue === 'missing') {
    return 'No local private key material was found for this inbox slug. Import a backup, recover keys from another device, or override them with a new rotation.';
  }

  if (issue === 'mismatch') {
    return 'Local private keys do not match the published keys for this inbox slug. Import a newer backup, recover from another device, or override them with a new rotation.';
  }

  return null;
}

function findVersionedKey(
  actor: Agent,
  bundles: AgentKeyBundle[],
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

function threadSummary(thread: Thread, participants: ThreadParticipant[], actorById: Map<bigint, Agent>): string {
  const names = participants
    .map(participant => actorById.get(participant.agentDbId))
    .filter((actor): actor is Agent => Boolean(actor))
    .map(actor => actor.displayName?.trim() || actor.slug);
  return thread.title?.trim() || names.join(', ') || thread.dedupeKey;
}

function secretRotationRequired(params: {
  senderActor: Agent | undefined;
  latestSenderMessage: Message | undefined;
  currentMembershipVersion: bigint | undefined;
  participants: ThreadParticipant[];
  actorById: Map<bigint, Agent>;
  envelopes: ThreadSecretEnvelope[];
}): boolean {
  const {
    senderActor,
    latestSenderMessage,
    currentMembershipVersion,
    participants,
    actorById,
    envelopes,
  } = params;
  if (!senderActor || !latestSenderMessage) {
    return false;
  }
  if (
    currentMembershipVersion !== undefined &&
    latestSenderMessage.membershipVersion !== currentMembershipVersion
  ) {
    return true;
  }

  const expectedRecipients = new Map<bigint, Agent>();
  for (const participant of participants) {
    const actor = actorById.get(participant.agentDbId);
    if (!actor) {
      return true;
    }
    expectedRecipients.set(participant.agentDbId, actor);
  }

  const currentVersionEnvelopes = envelopes.filter(envelope => {
    return (
      envelope.threadId === latestSenderMessage.threadId &&
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

function InboxPage() {
  const auth = useAuthSession();
  const params = Route.useParams();

  if (auth.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="space-y-3 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Tray className="h-5 w-5 text-primary" aria-hidden />
            </div>
            <p className="font-mono text-sm text-muted-foreground">Loading session…</p>
          </div>
        </div>
      </div>
    );
  }

  if (auth.status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10">
              <Tray className="h-6 w-6 text-destructive" aria-hidden />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Connection failed</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {auth.error ?? 'Unable to load auth session.'}
            </p>
          </div>
          <Button onClick={() => void auth.refresh()} className="w-full">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (auth.status !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-md border border-primary/20 bg-primary/10">
              <Tray className="h-7 w-7 text-primary" aria-hidden />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">
              <span className="font-mono text-primary">/{params.slug}</span>
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to open this inbox.
            </p>
          </div>

          <Card>
            <CardContent className="space-y-4 pt-6">
              <Button asChild className="w-full" size="lg">
                <a href={buildLoginHref(`/${params.slug}`)}>Sign in with Masumi</a>
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                The public endpoint at{' '}
                <span className="font-mono text-foreground/70">/{params.slug}/public</span>{' '}
                remains accessible without authentication.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return <AuthenticatedInboxPage />;
}

function AuthenticatedInboxPage() {
  const auth = useAuthSession();
  const params = Route.useParams();
  const search = Route.useSearch();
  const activeWorkspaceTab = search.tab ?? 'inbox';
  const navigate = useNavigate();
  const conn = useSpacetimeDB();
  const liveConnection = conn.getConnection() as DbConnection | null;
  const [hydrated, setHydrated] = useState(false);
  const connected = hydrated ? conn.isActive : false;
  const [slugPresence, setSlugPresence] = useState<'checking' | 'present' | 'missing' | 'error'>(
    'checking'
  );
  const [slugProbeError, setSlugProbeError] = useState<string | null>(null);
  const [actorKeyPair, setActorKeyPair] = useState<AgentKeyPair | null>(null);
  const [localKeyIssue, setLocalKeyIssue] = useState<DefaultKeyIssue>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [showKeysRecoveryDialog, setShowKeysRecoveryDialog] = useState(false);
  const [showVaultDialog, setShowVaultDialog] = useState(false);
  const [showParticipantsDialog, setShowParticipantsDialog] = useState(false);
  const [actorActionError, setActorActionError] = useState<string | null>(null);
  const [actorFeedback, setActorFeedback] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<bigint | null>(null);
  const [pendingVisibleThreadCount, setPendingVisibleThreadCount] = useState<number | null>(null);
  const [newInboxSlug, setNewInboxSlug] = useState('');
  const [newInboxDisplayName, setNewInboxDisplayName] = useState('');
  const [composeLookupSlug, setComposeLookupSlug] = useState('');
  const [composeResolvedTargets, setComposeResolvedTargets] = useState<ResolvedPublishedActor[]>([]);
  const [composeThreadTitle, setComposeThreadTitle] = useState('');
  const [composeThreadLocked, setComposeThreadLocked] = useState(false);
  const [composeFirstMessage, setComposeFirstMessage] = useState('');
  const [composeSelectedActorIds, setComposeSelectedActorIds] = useState<string[]>([]);
  const [pendingParticipantId, setPendingParticipantId] = useState<string>('');
  const [pendingParticipantLookupSlug, setPendingParticipantLookupSlug] = useState('');
  const [resolvedAddTargets, setResolvedAddTargets] = useState<ResolvedPublishedActor[]>([]);
  const [composerInput, setComposerInput] = useState('');
  const [rotateSecret, setRotateSecret] = useState(false);
  const [decryptedMessageById, setDecryptedMessageById] = useState<DecryptedMap>({});
  const [vaultInitialized, setVaultInitialized] = useState(false);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [vaultLoading, setVaultLoading] = useState(true);
  const [vaultSubmitting, setVaultSubmitting] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [deviceActionBusy, setDeviceActionBusy] = useState(false);
  const [verifyingDeviceRequest, setVerifyingDeviceRequest] = useState(false);
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [allowlistBusy, setAllowlistBusy] = useState(false);
  const [allowlistAgentInput, setAllowlistAgentInput] = useState('');
  const [allowlistEmailInput, setAllowlistEmailInput] = useState('');
  const [deviceVerificationCode, setDeviceVerificationCode] = useState('');
  const [pendingDeviceShareRequest, setPendingDeviceShareRequest] =
    useState<PendingDeviceShareRequestState | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [showRotationSharePrompt, setShowRotationSharePrompt] = useState(false);
  const [rotationShareDeviceIds, setRotationShareDeviceIds] = useState<string[]>([]);
  const [rotationRevokeDeviceIds, setRotationRevokeDeviceIds] = useState<string[]>([]);
  const [threadSearchQuery, setThreadSearchQuery] = useState('');
  const [threadRailFilter, setThreadRailFilter] = useState<ThreadRailFilter>('active');
  const [threadRailPage, setThreadRailPage] = useState(1);
  const [threadTimelinePage, setThreadTimelinePage] = useState(1);
  const [lookupTargetActor, setLookupTargetActor] = useState<PublicLookupActor | null>(null);
  const [lookupTargetRoute, setLookupTargetRoute] = useState<PublicLookupRouteInfo | null>(null);
  const [lookupTargetLoading, setLookupTargetLoading] = useState(false);
  const [lookupTargetError, setLookupTargetError] = useState<string | null>(null);
  const [lookupTargetRouteLoading, setLookupTargetRouteLoading] = useState(false);
  const [lookupTargetRouteError, setLookupTargetRouteError] = useState<string | null>(null);
  const [lookupTargetSummary, setLookupTargetSummary] = useState<PublicLookupSummary | null>(null);
  const lastAutoResolvedLookupRef = useRef<string | null>(null);
  const threadTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollTimelineRef = useRef(true);
  const lastTimelineSignatureRef = useRef<string | null>(null);
  const authenticatedSession =
    auth.status === 'authenticated' ? auth.session : null;
  const keyVaultOwner = useMemo<KeyVaultOwner | null>(
    () =>
      authenticatedSession
        ? {
            userId: `${authenticatedSession.user.issuer}:${authenticatedSession.user.subject}`,
            normalizedEmail: normalizeEmail(authenticatedSession.user.email ?? ''),
          }
        : null,
    [authenticatedSession]
  );

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated || !keyVaultOwner) {
      return;
    }

    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setVaultLoading(true);
      }
    });
    void getKeyVaultStatus(keyVaultOwner)
      .then(status => {
        if (cancelled) return;
        setVaultInitialized(status.initialized);
        setVaultUnlocked(status.unlocked);
        setVaultError(null);
      })
      .catch(vaultStatusError => {
        if (cancelled) return;
        setVaultError(
          vaultStatusError instanceof Error
            ? vaultStatusError.message
            : 'Unable to inspect the local key vault'
        );
      })
      .finally(() => {
        if (!cancelled) {
          setVaultLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hydrated, keyVaultOwner]);

  const createInboxIdentityReducer = useReducer(reducers.createInboxIdentity);
  const addContactAllowlistEntryReducer = useReducer(reducers.addContactAllowlistEntry);
  const removeContactAllowlistEntryReducer = useReducer(reducers.removeContactAllowlistEntry);
  const approveContactRequestReducer = useReducer(reducers.approveContactRequest);
  const rejectContactRequestReducer = useReducer(reducers.rejectContactRequest);
  const acceptThreadInviteReducer = useReducer(reducers.acceptThreadInvite);
  const rejectThreadInviteReducer = useReducer(reducers.rejectThreadInvite);
  const registerDeviceReducer = useReducer(reducers.registerDevice);
  const createDeviceShareRequestReducer = useReducer(reducers.createDeviceShareRequest);
  const approveDeviceShareReducer = useReducer(reducers.approveDeviceShare);
  const revokeDeviceReducer = useReducer(reducers.revokeDevice);
  const rotateAgentKeysReducer = useReducer(reducers.rotateAgentKeys);
  const createDirectThreadReducer = useReducer(reducers.createDirectThread);
  const requestDirectContactWithFirstMessageReducer = useReducer(
    reducers.requestDirectContactWithFirstMessage
  );
  const createGroupThreadReducer = useReducer(reducers.createGroupThread);
  const addThreadParticipantReducer = useReducer(reducers.addThreadParticipant);
  const removeThreadParticipantReducer = useReducer(reducers.removeThreadParticipant);
  const setThreadParticipantAdminReducer = useReducer(reducers.setThreadParticipantAdmin);
  const sendEncryptedMessageReducer = useReducer(reducers.sendEncryptedMessage);
  const markThreadReadReducer = useReducer(reducers.markThreadRead);
  const setThreadArchivedReducer = useReducer(reducers.setThreadArchived);
  const deleteThreadReducer = useReducer(reducers.deleteThread);

  const [inboxes, inboxesReady, inboxesError] = useLiveTable<Inbox>(
    tables.visibleInboxes,
    'visibleInboxes'
  );
  const [actors, actorsReady, actorsError] = useLiveTable<Agent>(
    tables.visibleAgents,
    'visibleAgents'
  );
  const [agentKeyBundles, agentKeyBundlesReady, agentKeyBundlesError] = useLiveTable<AgentKeyBundle>(
    tables.visibleAgentKeyBundles,
    'visibleAgentKeyBundles'
  );
  const [devices, devicesReady, devicesError] = useLiveTable<Device>(
    tables.visibleDevices,
    'visibleDevices'
  );
  const [, deviceShareRequestsReady, deviceShareRequestsError] = useLiveTable<VisibleDeviceShareRequestRow>(
    tables.visibleDeviceShareRequests,
    'visibleDeviceShareRequests'
  );
  const [deviceShareBundles, deviceShareBundlesReady, deviceShareBundlesError] = useLiveTable<VisibleDeviceKeyBundleRow>(
    tables.visibleDeviceKeyBundles,
    'visibleDeviceKeyBundles'
  );
  const [threads, threadsReady, threadsError] = useLiveTable<Thread>(tables.visibleThreads, 'visibleThreads');
  const [threadParticipants, threadParticipantsReady, threadParticipantsError] = useLiveTable<ThreadParticipant>(
    tables.visibleThreadParticipants,
    'visibleThreadParticipants'
  );
  const [threadReadStates, threadReadStatesReady, threadReadStatesError] = useLiveTable<ThreadReadState>(
    tables.visibleThreadReadStates,
    'visibleThreadReadStates'
  );
  const [threadSecretEnvelopes, threadSecretEnvelopesReady, threadSecretEnvelopesError] = useLiveTable<ThreadSecretEnvelope>(
    tables.visibleThreadSecretEnvelopes,
    'visibleThreadSecretEnvelopes'
  );
  const [contactRequests, contactRequestsReady, contactRequestsError] = useLiveTable<VisibleContactRequestRow>(
    tables.visibleContactRequests,
    'visibleContactRequests'
  );
  const [threadInvites, threadInvitesReady, threadInvitesError] = useLiveTable<VisibleThreadInviteRow>(
    tables.visibleThreadInvites,
    'visibleThreadInvites'
  );
  const [allowlistEntries, allowlistEntriesReady, allowlistEntriesError] = useLiveTable<VisibleContactAllowlistEntryRow>(
    tables.visibleContactAllowlistEntries,
    'visibleContactAllowlistEntries'
  );
  const [messages, messagesReady, messagesError] = useLiveTable<Message>(
    tables.visibleMessages,
    'visibleMessages'
  );

  const normalizedRouteSlug = useMemo(() => normalizeInboxSlug(params.slug), [params.slug]);
  const normalizedLookupSlug = useMemo(() => normalizeInboxSlug(search.lookup ?? ''), [search.lookup]);
  const shouldShowLookupPanel = Boolean(
    normalizedLookupSlug && normalizedLookupSlug !== normalizedRouteSlug
  );

  const activeActor = useMemo(
    () => actors.find(row => row.slug === normalizedRouteSlug),
    [actors, normalizedRouteSlug]
  );
  const activeActorContactRequests = useMemo(() => {
    if (!activeActor) {
      return [];
    }

    return contactRequests
      .filter(request => {
        return request.targetAgentDbId === activeActor.id || request.requesterAgentDbId === activeActor.id;
      })
      .sort(
        (left, right) =>
          Number(right.updatedAt.microsSinceUnixEpoch - left.updatedAt.microsSinceUnixEpoch) ||
          Number(right.id - left.id)
      );
  }, [activeActor, contactRequests]);
  const incomingContactRequests = useMemo(
    () => activeActorContactRequests.filter(request => request.direction === 'incoming'),
    [activeActorContactRequests]
  );
  const outgoingContactRequests = useMemo(
    () => activeActorContactRequests.filter(request => request.direction === 'outgoing'),
    [activeActorContactRequests]
  );
  const activeActorThreadInvites = useMemo(() => {
    if (!activeActor) {
      return [];
    }

    return threadInvites
      .filter(invite => {
        return invite.inviteeAgentDbId === activeActor.id || invite.inviterAgentDbId === activeActor.id;
      })
      .sort(
        (left, right) =>
          Number(right.updatedAt.microsSinceUnixEpoch - left.updatedAt.microsSinceUnixEpoch) ||
          Number(right.id - left.id)
      );
  }, [activeActor, threadInvites]);
  const incomingThreadInvites = useMemo(
    () => activeActorThreadInvites.filter(invite => invite.inviteeAgentDbId === activeActor?.id),
    [activeActor?.id, activeActorThreadInvites]
  );
  const outgoingThreadInvites = useMemo(
    () => activeActorThreadInvites.filter(invite => invite.inviterAgentDbId === activeActor?.id),
    [activeActor?.id, activeActorThreadInvites]
  );
  const inboxAllowlistEntries = useMemo(
    () =>
      allowlistEntries
        .filter(entry => (activeActor ? entry.inboxId === activeActor.inboxId : false))
        .sort(
          (left, right) =>
            Number(right.createdAt.microsSinceUnixEpoch - left.createdAt.microsSinceUnixEpoch) ||
            Number(right.id - left.id)
        ),
    [activeActor, allowlistEntries]
  );

  const coreLoading = !actorsReady || (!activeActor && slugPresence === 'checking');
  const secondaryLoading =
    !inboxesReady ||
    !agentKeyBundlesReady ||
    !devicesReady ||
    !deviceShareRequestsReady ||
    !deviceShareBundlesReady ||
    !threadsReady ||
    !threadParticipantsReady ||
    !threadReadStatesReady ||
    !threadSecretEnvelopesReady ||
    !contactRequestsReady ||
    !threadInvitesReady ||
    !allowlistEntriesReady ||
    !messagesReady;
  const liveTableError =
    actorsError ||
    inboxesError ||
    agentKeyBundlesError ||
    devicesError ||
    deviceShareRequestsError ||
    deviceShareBundlesError ||
    threadsError ||
    threadParticipantsError ||
    threadReadStatesError ||
    threadSecretEnvelopesError ||
    contactRequestsError ||
    threadInvitesError ||
    allowlistEntriesError ||
    messagesError;

  const inbox = useMemo(
    () => inboxes.find(row => row.id === activeActor?.inboxId),
    [activeActor?.inboxId, inboxes]
  );
  const normalizedSessionEmail = useMemo(
    () =>
      authenticatedSession?.user.email
        ? normalizeEmail(authenticatedSession.user.email)
        : null,
    [authenticatedSession?.user.email]
  );
  const ownedInbox = useMemo(
    () => findSessionOwnedInbox({ inboxes, session: authenticatedSession }),
    [authenticatedSession, inboxes]
  );
  const displayInbox = useMemo<DisplayInbox | null>(() => {
    if (inbox) {
      return {
        normalizedEmail: inbox.normalizedEmail,
        displayEmail: inbox.displayEmail,
        authVerified: inbox.authVerified,
        emailAttested: inbox.emailAttested,
        authIssuer: inbox.authIssuer,
        authSubject: inbox.authSubject,
        authVerifiedAt: inbox.authVerifiedAt,
      };
    }

    if (!authenticatedSession?.user.email || !activeActor) {
      return null;
    }

    const normalizedSessionEmail = normalizeEmail(authenticatedSession.user.email);
    if (normalizedSessionEmail !== activeActor.normalizedEmail) {
      return null;
    }

    if (!ownedInbox || ownedInbox.id !== activeActor.inboxId) {
      return null;
    }

    return {
      normalizedEmail: ownedInbox.normalizedEmail,
      displayEmail: authenticatedSession.user.email,
      authVerified: authenticatedSession.user.emailVerified,
      emailAttested: authenticatedSession.user.emailVerified,
      authIssuer: authenticatedSession.user.issuer,
      authSubject: authenticatedSession.user.subject,
      authVerifiedAtLabel: 'Current authenticated session',
    };
  }, [activeActor, authenticatedSession, inbox, ownedInbox]);
  const shellOwnedInboxes = useMemo(
    () =>
      buildOwnedInboxAgentEntries({
        actors,
        ownInboxId: ownedInbox?.id ?? null,
        normalizedEmail: ownedInbox?.normalizedEmail ?? normalizedSessionEmail ?? '',
      }),
    [actors, normalizedSessionEmail, ownedInbox]
  );
  useEffect(() => {
    if (
      !authenticatedSession ||
      !authenticatedSession.user.emailVerified ||
      !actorsReady ||
      !inboxesReady ||
      shellOwnedInboxes.length > 0
    ) {
      return;
    }

    void navigate({
      to: '/',
      replace: true,
    });
  }, [
    actorsReady,
    authenticatedSession,
    inboxesReady,
    navigate,
    shellOwnedInboxes.length,
  ]);
  const sessionOwnsActiveInbox = Boolean(
    authenticatedSession &&
      inbox &&
      normalizedSessionEmail &&
      normalizedSessionEmail === inbox.normalizedEmail &&
      authenticatedSession.user.issuer === inbox.authIssuer &&
      authenticatedSession.user.subject === inbox.authSubject
  );
  useEffect(() => {
    if (!sessionOwnsActiveInbox || vaultLoading) {
      return deferEffectStateUpdate(() => {
        setShowVaultDialog(false);
      });
    }

    return deferEffectStateUpdate(() => {
      setShowVaultDialog(!vaultUnlocked);
    });
  }, [sessionOwnsActiveInbox, vaultLoading, vaultUnlocked]);
  const writeAccess = useWorkspaceWriteAccess({
    connected,
    session: authenticatedSession,
    normalizedSessionEmail,
    inbox: inbox ?? null,
    connectionIdentity: conn.identity ?? null,
    hasActor: Boolean(activeActor),
  });
  const canWriteToActiveInbox = writeAccess.canWrite;
  useEffect(() => {
    if (!displayInbox || !activeActor) {
      return;
    }

    const pendingPrompt = consumeKeyBackupPrompt({
      normalizedEmail: displayInbox.normalizedEmail,
      slug: activeActor.slug,
    });
    if (!pendingPrompt) {
      return;
    }

  }, [activeActor, displayInbox]);
  const writeAuthorizationError = writeAccess.reason;
  const activeActorIdentity = useMemo(
    () => (activeActor ? toActorIdentity(activeActor) : null),
    [activeActor]
  );
  const ownedDevices = useMemo(() => {
    if (!displayInbox) {
      return [];
    }

    return devices
      .filter(device => device.inboxId === inbox?.id)
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }, [devices, displayInbox, inbox?.id]);
  const approvedDevices = useMemo(
    () =>
      ownedDevices.filter(device => device.status === 'approved' && !device.revokedAt),
    [ownedDevices]
  );
  const actorKeysMatchPublished = useMemo(
    () => Boolean(activeActor && actorKeyPair && matchesPublishedActorKeys(activeActor, actorKeyPair)),
    [activeActor, actorKeyPair]
  );

  function handleRevealUnsupportedMessage(messageId: bigint) {
    setDecryptedMessageById(current => {
      const key = messageId.toString();
      const existing = current[key];
      if (!existing || existing.status !== 'unsupported') {
        return current;
      }
      return {
        ...current,
        [key]: {
          ...existing,
          revealedUnsupported: true,
        },
      };
    });
  }

  function ensureAuthorizedWriteAccess(): boolean {
    if (canWriteToActiveInbox) {
      return true;
    }
    setActorActionError(
      writeAuthorizationError ??
        'Current OIDC session is not authorized to write to this inbox.'
    );
    return false;
  }

  function readCurrentVisibleState() {
    if (!liveConnection) {
      throw new Error('Live SpacetimeDB connection is unavailable.');
    }

    return {
      actors: Array.from(liveConnection.db.visibleAgents.iter()) as Agent[],
      threads: Array.from(liveConnection.db.visibleThreads.iter()) as Thread[],
      participants: Array.from(liveConnection.db.visibleThreadParticipants.iter()) as ThreadParticipant[],
      messages: Array.from(liveConnection.db.visibleMessages.iter()) as Message[],
      threadSecretEnvelopes: Array.from(
        liveConnection.db.visibleThreadSecretEnvelopes.iter()
      ) as ThreadSecretEnvelope[],
      contactRequests: Array.from(liveConnection.db.visibleContactRequests.iter()) as VisibleContactRequestRow[],
      threadInvites: Array.from(liveConnection.db.visibleThreadInvites.iter()) as VisibleThreadInviteRow[],
    };
  }

  async function waitForNewDirectThread(params: {
    ownActor: Agent;
    otherPublicIdentity: string;
    existingThreadIds: Set<string>;
    timeoutMs?: number;
  }): Promise<Thread> {
    const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

    while (Date.now() < timeoutAt) {
      const snapshot = readCurrentVisibleState();
      const nextThread =
        findDirectThreads(snapshot.threads, params.ownActor, params.otherPublicIdentity).find(thread => {
          return !params.existingThreadIds.has(thread.id.toString());
        }) ?? null;
      if (nextThread) {
        return nextThread;
      }
      await new Promise(resolve => {
        setTimeout(resolve, 100);
      });
    }

    throw new Error('Timed out waiting for the direct thread to sync.');
  }

  async function waitForParticipantAddResult(params: {
    threadId: bigint;
    participantPublicIdentity: string;
    timeoutMs?: number;
  }): Promise<'added' | 'invited'> {
    const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

    while (Date.now() < timeoutAt) {
      const snapshot = readCurrentVisibleState();
      const active = snapshot.participants.some(participant => {
        const actor = snapshot.actors.find(candidate => candidate.id === participant.agentDbId);
        return (
          participant.threadId === params.threadId &&
          participant.active &&
          actor?.publicIdentity === params.participantPublicIdentity
        );
      });
      if (active) {
        return 'added';
      }

      const pendingInvite = snapshot.threadInvites.some(invite => {
        return (
          invite.threadId === params.threadId &&
          invite.inviteePublicIdentity === params.participantPublicIdentity &&
          invite.status === 'pending'
        );
      });
      if (pendingInvite) {
        return 'invited';
      }

      await new Promise(resolve => {
        setTimeout(resolve, 100);
      });
    }

    throw new Error('Timed out waiting for the membership change to sync.');
  }

  async function handleApproveContactRequest(requestId: bigint) {
    if (!activeActor) {
      return;
    }

    setApprovalActionRequestId(requestId.toString());
    setActorActionError(null);
    setActorFeedback(null);

    try {
      if (!ensureAuthorizedWriteAccess()) {
        return;
      }

      await Promise.resolve(
        approveContactRequestReducer({
          agentDbId: activeActor.id,
          requestId,
        })
      );
      setActorFeedback(`Approved contact request #${requestId.toString()}.`);
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to approve the contact request'
      );
    } finally {
      setApprovalActionRequestId(null);
    }
  }

  async function handleRejectContactRequest(requestId: bigint) {
    if (!activeActor) {
      return;
    }

    setApprovalActionRequestId(requestId.toString());
    setActorActionError(null);
    setActorFeedback(null);

    try {
      if (!ensureAuthorizedWriteAccess()) {
        return;
      }

      await Promise.resolve(
        rejectContactRequestReducer({
          agentDbId: activeActor.id,
          requestId,
        })
      );
      setActorFeedback(`Rejected contact request #${requestId.toString()}.`);
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to reject the contact request'
      );
    } finally {
      setApprovalActionRequestId(null);
    }
  }

  async function handleAcceptThreadInvite(inviteId: bigint) {
    if (!activeActor) {
      return;
    }

    setApprovalActionRequestId(`invite:${inviteId.toString()}`);
    setActorActionError(null);
    setActorFeedback(null);

    try {
      if (!ensureAuthorizedWriteAccess()) {
        return;
      }

      await Promise.resolve(
        acceptThreadInviteReducer({
          agentDbId: activeActor.id,
          inviteId,
        })
      );
      setActorFeedback(`Accepted thread invite #${inviteId.toString()}.`);
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to accept the thread invite'
      );
    } finally {
      setApprovalActionRequestId(null);
    }
  }

  async function handleRejectThreadInvite(inviteId: bigint) {
    if (!activeActor) {
      return;
    }

    setApprovalActionRequestId(`invite:${inviteId.toString()}`);
    setActorActionError(null);
    setActorFeedback(null);

    try {
      if (!ensureAuthorizedWriteAccess()) {
        return;
      }

      await Promise.resolve(
        rejectThreadInviteReducer({
          agentDbId: activeActor.id,
          inviteId,
        })
      );
      setActorFeedback(`Rejected thread invite #${inviteId.toString()}.`);
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to reject the thread invite'
      );
    } finally {
      setApprovalActionRequestId(null);
    }
  }

  async function handleAddAllowlistAgent() {
    if (!activeActor || !allowlistAgentInput.trim() || !liveConnection) {
      return;
    }

    setAllowlistBusy(true);
    setActorActionError(null);
    setActorFeedback(null);

    try {
      if (!ensureAuthorizedWriteAccess()) {
        return;
      }

      const resolved = await resolveVisiblePublishedActors(allowlistAgentInput);
      await Promise.resolve(
        addContactAllowlistEntryReducer({
          agentDbId: activeActor.id,
          agentPublicIdentity: resolved.selected.publicIdentity,
          email: undefined,
        })
      );
      setAllowlistAgentInput('');
      setActorFeedback('Agent added to the inbox-wide allowlist.');
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to add the agent to the allowlist'
      );
    } finally {
      setAllowlistBusy(false);
    }
  }

  async function handleAddAllowlistEmail() {
    if (!activeActor || !allowlistEmailInput.trim()) {
      return;
    }

    setAllowlistBusy(true);
    setActorActionError(null);
    setActorFeedback(null);

    try {
      if (!ensureAuthorizedWriteAccess()) {
        return;
      }

      await Promise.resolve(
        addContactAllowlistEntryReducer({
          agentDbId: activeActor.id,
          agentPublicIdentity: undefined,
          email: allowlistEmailInput.trim(),
        })
      );
      setAllowlistEmailInput('');
      setActorFeedback('Email added to the inbox-wide allowlist.');
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to add the email to the allowlist'
      );
    } finally {
      setAllowlistBusy(false);
    }
  }

  async function handleRemoveAllowlistEntry(entryId: bigint) {
    if (!activeActor) {
      return;
    }

    setAllowlistBusy(true);
    setActorActionError(null);
    setActorFeedback(null);

    try {
      if (!ensureAuthorizedWriteAccess()) {
        return;
      }

      await Promise.resolve(
        removeContactAllowlistEntryReducer({
          agentDbId: activeActor.id,
          entryId,
        })
      );
      setActorFeedback('Allowlist entry removed.');
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to remove the allowlist entry'
      );
    } finally {
      setAllowlistBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setSlugPresence('checking');
        setSlugProbeError(null);
      }
    });

    void fetch(`/${encodeURIComponent(normalizedRouteSlug)}/public`, {
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
      .then(response => {
        if (response.status === 404) {
          setSlugPresence('missing');
          return;
        }
        if (!response.ok) {
          throw new Error(`Slug probe failed (${response.status})`);
        }
        setSlugPresence('present');
      })
      .catch(error => {
        if ((error as Error).name === 'AbortError') {
          return;
        }

        setSlugPresence('error');
        setSlugProbeError(
          error instanceof Error ? error.message : 'Unable to verify inbox slug'
        );
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [normalizedRouteSlug]);

  useEffect(() => {
    if (!activeActor || !shouldShowLookupPanel || !normalizedLookupSlug || !liveConnection) {
      return deferEffectStateUpdate(() => {
        setLookupTargetActor(null);
        setLookupTargetError(null);
        setLookupTargetLoading(false);
      });
    }

    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setLookupTargetLoading(true);
        setLookupTargetError(null);
        setLookupTargetRoute(null);
        setLookupTargetRouteLoading(false);
        setLookupTargetRouteError(null);
      }
    });

    void (async () => {
      try {
        const found = await liveConnection.procedures.lookupPublishedAgentBySlug({
          slug: normalizedLookupSlug,
        });
        if (cancelled) {
          return;
        }

        const actor = found[0];
        if (!actor) {
          setLookupTargetError('No published details found for that actor.');
          setLookupTargetActor(null);
          setLookupTargetLoading(false);
          return;
        }

        setLookupTargetActor({
          slug: actor.slug,
          publicIdentity: actor.publicIdentity,
          isDefault: actor.isDefault,
          displayName: normalizeNullableText(actor.displayName),
        });
      } catch (error) {
        if (!cancelled) {
          setLookupTargetError(
            error instanceof Error ? error.message : 'Unable to load lookup actor info.'
          );
          setLookupTargetActor(null);
        }
      } finally {
        if (!cancelled) {
          setLookupTargetLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeActor, liveConnection, normalizedLookupSlug, shouldShowLookupPanel]);

  useEffect(() => {
    if (!shouldShowLookupPanel || !normalizedLookupSlug) {
      return deferEffectStateUpdate(() => {
        setLookupTargetRoute(null);
        setLookupTargetRouteError(null);
        setLookupTargetRouteLoading(false);
      });
    }

    const controller = new AbortController();
    let cancelled = false;

    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setLookupTargetRouteLoading(true);
        setLookupTargetRouteError(null);
      }
    });

    void fetch(`/${encodeURIComponent(normalizedLookupSlug)}/public`, {
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
      .then(async response => {
        if (cancelled) {
          return;
        }

        if (response.status === 404) {
          setLookupTargetRoute(null);
          return;
        }
        if (!response.ok) {
          throw new Error(`Public endpoint probe failed (${response.status})`);
        }

        const json = (await response.json()) as {
          description?: unknown;
          linkedEmail?: unknown;
        };
        if (cancelled) {
          return;
        }

        setLookupTargetRoute({
          description: normalizeNullableText(json.description),
          linkedEmail: normalizeNullableText(json.linkedEmail),
        });
      })
      .catch(error => {
        if (cancelled || (error as Error).name === 'AbortError') {
          return;
        }

        setLookupTargetRouteError(
          error instanceof Error ? error.message : 'Unable to load public route details.'
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLookupTargetRouteLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [normalizedLookupSlug, shouldShowLookupPanel]);

  const actorById = useMemo(
    () => new Map<bigint, Agent>(actors.map(actor => [actor.id, actor])),
    [actors]
  );

  const bundlesByActorId = useMemo(() => {
    const map = new Map<bigint, AgentKeyBundle[]>();
    for (const bundle of agentKeyBundles) {
      const rows = map.get(bundle.agentDbId);
      if (rows) rows.push(bundle);
      else map.set(bundle.agentDbId, [bundle]);
    }
    return map;
  }, [agentKeyBundles]);

  const participantsByThreadId = useMemo(() => {
    const map = new Map<bigint, ThreadParticipant[]>();
    for (const participant of threadParticipants) {
      if (!participant.active) continue;
      const rows = map.get(participant.threadId);
      if (rows) rows.push(participant);
      else map.set(participant.threadId, [participant]);
    }
    return map;
  }, [threadParticipants]);

  const readStateByThreadId = useMemo(() => {
    const map = new Map<bigint, ThreadReadState>();
    if (!activeActor) return map;

    for (const readState of threadReadStates) {
      if (readState.agentDbId === activeActor.id) {
        map.set(readState.threadId, readState);
      }
    }
    return map;
  }, [activeActor, threadReadStates]);

  useEffect(() => {
    if (!activeActor) return;
    return deferEffectStateUpdate(() => {
      setActiveActorIdentity(toActorIdentity(activeActor));
    });
  }, [activeActor]);

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setActorKeyPair(null);
      setLocalKeyIssue(null);
      setShowKeysRecoveryDialog(false);
      setSessionError(null);
      setVaultError(null);
      setPendingDeviceShareRequest(null);
      setDeviceVerificationCode('');
      setCurrentDeviceId(null);
      setShowRotationSharePrompt(false);
      setRotationShareDeviceIds([]);
      setRotationRevokeDeviceIds([]);
      setDecryptedMessageById({});
      setComposerInput('');
      setRotateSecret(false);
      setComposeLookupSlug('');
      setComposeResolvedTargets([]);
      setComposeFirstMessage('');
      setComposeThreadTitle('');
      setComposeThreadLocked(false);
      setComposeSelectedActorIds([]);
      setPendingParticipantLookupSlug('');
      setResolvedAddTargets([]);
      setAllowlistAgentInput('');
      setAllowlistEmailInput('');
    });
  }, [activeActorIdentity?.slug]);

  useEffect(() => {
    if (!displayInbox || !vaultUnlocked) {
      return deferEffectStateUpdate(() => {
        setCurrentDeviceId(null);
      });
    }

    let cancelled = false;
    void loadStoredDeviceKeyMaterial(displayInbox.normalizedEmail)
      .then(device => {
        if (cancelled) return;
        setCurrentDeviceId(device?.deviceId ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentDeviceId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [displayInbox, vaultUnlocked]);

  useEffect(() => {
    if (!activeActorIdentity || !connected || !canWriteToActiveInbox) {
      return deferEffectStateUpdate(() => {
        setActorKeyPair(null);
        setLocalKeyIssue(null);
        setSessionError(null);
      });
    }
    if (!vaultUnlocked) {
      return deferEffectStateUpdate(() => {
        setActorKeyPair(null);
        setLocalKeyIssue(null);
        setSessionError(
          vaultLoading
            ? null
            : describeLocalVaultRequirement({
                initialized: vaultInitialized,
                phrase: 'to load private keys for this inbox',
              })
        );
      });
    }

    let cancelled = false;
    void loadStoredAgentKeyPair(activeActorIdentity)
      .then(keyPair => {
        if (cancelled) return;
        const nextIssue = getActiveActorKeyIssue(activeActor, keyPair);
        setActorKeyPair((current: AgentKeyPair | null) =>
          sameKeyPair(current, keyPair) ? current : keyPair
        );
        setLocalKeyIssue(nextIssue);
        setSessionError(getActiveActorKeyError(nextIssue));
      })
      .catch(error => {
        if (cancelled) return;
        setActorKeyPair(null);
        setLocalKeyIssue(null);
        setSessionError(error instanceof Error ? error.message : 'Failed to load local keys');
      });

    return () => {
      cancelled = true;
    };
  }, [activeActor, activeActorIdentity, canWriteToActiveInbox, connected, vaultInitialized, vaultLoading, vaultUnlocked]);

  useEffect(() => {
    if (!localKeyIssue) {
      return;
    }

    return deferEffectStateUpdate(() => {
      setShowKeysRecoveryDialog(true);
    });
  }, [localKeyIssue]);

  useEffect(() => {
    if (
      !pendingDeviceShareRequest ||
      !connected ||
      !liveConnection ||
      deviceActionBusy ||
      !displayInbox
    ) {
      return;
    }

    const matchingBundle = deviceShareBundles.find(bundle => {
      return (
        bundle.targetDeviceId === pendingDeviceShareRequest.device.deviceId &&
        !bundle.consumedAt &&
        isTimestampInFuture(bundle.expiresAt)
      );
    });
    if (!matchingBundle) {
      return;
    }

    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setDeviceActionBusy(true);
      }
    });
    void liveConnection.procedures
      .claimDeviceKeyBundle({
        deviceId: pendingDeviceShareRequest.device.deviceId,
      })
      .then(async result => {
        const bundle = result[0];
        if (!bundle) {
          return;
        }

        await importClaimedDeviceShare({
          normalizedEmail: displayInbox.normalizedEmail,
          device: pendingDeviceShareRequest.device,
          sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
          bundleCiphertext: bundle.bundleCiphertext,
          bundleIv: bundle.bundleIv,
          bundleAlgorithm: bundle.bundleAlgorithm,
        });
        await clearPendingDeviceShareKeyMaterial(displayInbox.normalizedEmail);
        if (cancelled) return;

        setPendingDeviceShareRequest(null);
        if (activeActorIdentity) {
          const importedKeyPair = await loadStoredAgentKeyPair(activeActorIdentity);
          if (!cancelled) {
            const nextIssue = getActiveActorKeyIssue(activeActor, importedKeyPair);
            const nextError = getActiveActorKeyError(nextIssue);
            setActorKeyPair(importedKeyPair);
            setLocalKeyIssue(nextIssue);
            setSessionError(nextError);
            setShowKeysRecoveryDialog(Boolean(nextIssue));
            setActorFeedback(nextError ? null : 'Private keys imported from another device.');
          }
        }
      })
      .catch(claimError => {
        if (cancelled) return;
        setActorActionError(
          claimError instanceof Error
            ? claimError.message
            : 'Unable to import the shared device bundle'
        );
      })
      .finally(() => {
        if (!cancelled) {
          setDeviceActionBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeActor,
    activeActorIdentity,
    connected,
    deviceActionBusy,
    deviceShareBundles,
    displayInbox,
    liveConnection,
    pendingDeviceShareRequest,
  ]);

  const visibleThreads = useMemo(() => {
    if (!activeActor) return [];
    return threads
      .filter(thread =>
        (participantsByThreadId.get(thread.id) ?? []).some(participant => participant.agentDbId === activeActor.id)
      )
      .sort(
        (left, right) =>
          Number(right.lastMessageAt.microsSinceUnixEpoch - left.lastMessageAt.microsSinceUnixEpoch) ||
          Number(right.id - left.id)
      );
  }, [activeActor, threads, participantsByThreadId]);
  const lookupTargetActorRow = useMemo(
    () =>
      shouldShowLookupPanel && lookupTargetActor
        ? actors.find(actor => actor.publicIdentity === lookupTargetActor.publicIdentity)
        : null,
    [actors, lookupTargetActor, shouldShowLookupPanel]
  );
  useEffect(() => {
    if (!activeActor || !lookupTargetActor) {
      return deferEffectStateUpdate(() => {
        setLookupTargetSummary(null);
      });
    }

    if (!shouldShowLookupPanel) {
      return deferEffectStateUpdate(() => {
        setLookupTargetSummary(null);
      });
    }

    const requestedThreads = contactRequests.filter(request => {
      const involvesActive =
        request.requesterAgentDbId === activeActor.id || request.targetAgentDbId === activeActor.id;
      const involvesLookup =
        request.requesterPublicIdentity === lookupTargetActor.publicIdentity ||
        request.targetPublicIdentity === lookupTargetActor.publicIdentity;
      const isPending = request.status === 'pending';

      return involvesActive && involvesLookup && isPending;
    }).length;

    let activeThreads: number | null = null;
    let dedicatedMemberCount: number | null = null;

    if (lookupTargetActorRow) {
      let totalActiveThreads = 0;
      const dedicatedMembers = new Set<bigint>();

      for (const thread of visibleThreads) {
        const participants = participantsByThreadId.get(thread.id) ?? [];
        const hasTarget = participants.some(participant => participant.agentDbId === lookupTargetActorRow.id);

        if (!hasTarget) {
          continue;
        }

        const archived = readStateByThreadId.get(thread.id)?.archived ?? false;
        if (archived) {
          continue;
        }

        totalActiveThreads += 1;

        for (const participant of participants) {
          if (
            participant.agentDbId !== activeActor.id &&
            participant.agentDbId !== lookupTargetActorRow.id
          ) {
            dedicatedMembers.add(participant.agentDbId);
          }
        }
      }

      activeThreads = totalActiveThreads;
      dedicatedMemberCount = dedicatedMembers.size;
    }

    return deferEffectStateUpdate(() => {
      setLookupTargetSummary({
        activeThreads,
        dedicatedMemberCount,
        requestedThreads,
      });
    });
  }, [
    activeActor,
    contactRequests,
    lookupTargetActor,
    lookupTargetActorRow,
    participantsByThreadId,
    readStateByThreadId,
    shouldShowLookupPanel,
    visibleThreads,
  ]);
  const unreadCountByThreadId = useMemo(() => {
    const map = new Map<bigint, number>();

    for (const thread of visibleThreads) {
      const readState = readStateByThreadId.get(thread.id);
      const unreadCount =
        readState?.lastReadThreadSeq === undefined
          ? Number(thread.lastMessageSeq)
          : Number(thread.lastMessageSeq - readState.lastReadThreadSeq);

      map.set(thread.id, Math.max(0, unreadCount));
    }

    return map;
  }, [readStateByThreadId, visibleThreads]);
  const filteredThreads = useMemo(() => {
    const normalizedQuery = threadSearchQuery.trim().toLowerCase();

    return visibleThreads.filter(thread => {
      const readState = readStateByThreadId.get(thread.id);
      const archived = readState?.archived ?? false;
      const unreadCount = unreadCountByThreadId.get(thread.id) ?? 0;

      if (threadRailFilter === 'active' && archived) {
        return false;
      }
      if (threadRailFilter === 'latest' && (archived || unreadCount === 0)) {
        return false;
      }
      if (threadRailFilter === 'archived' && !archived) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      const participantList = participantsByThreadId.get(thread.id) ?? [];
      const haystack = [
        threadSummary(thread, participantList, actorById),
        ...participantList
          .map(participant => actorById.get(participant.agentDbId))
          .filter((actor): actor is Agent => Boolean(actor))
          .flatMap(actor => [actor.slug, actor.displayName ?? '', actor.publicIdentity]),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [
    actorById,
    threadRailFilter,
    threadSearchQuery,
    participantsByThreadId,
    readStateByThreadId,
    unreadCountByThreadId,
    visibleThreads,
  ]);
  const threadRailPageCount = useMemo(
    () => Math.max(1, Math.ceil(filteredThreads.length / THREAD_LIST_PAGE_SIZE)),
    [filteredThreads.length]
  );
  const selectedThreadRailIndex = useMemo(() => {
    if (!selectedThreadId) {
      return -1;
    }
    return filteredThreads.findIndex(thread => thread.id === selectedThreadId);
  }, [filteredThreads, selectedThreadId]);

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setThreadRailPage(current => {
        if (selectedThreadRailIndex >= 0) {
          const target = Math.floor(selectedThreadRailIndex / THREAD_LIST_PAGE_SIZE) + 1;
          return target;
        }
        return Math.min(current, threadRailPageCount);
      });
    });
  }, [threadRailPageCount, selectedThreadRailIndex]);

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setThreadRailPage(1);
    });
  }, [threadSearchQuery, threadRailFilter]);

  const visibleThreadRailPageStart = (threadRailPage - 1) * THREAD_LIST_PAGE_SIZE;
  const visibleThreadRailPageEnd = Math.min(
    visibleThreadRailPageStart + THREAD_LIST_PAGE_SIZE,
    filteredThreads.length
  );
  const paginatedThreads = useMemo(
    () => filteredThreads.slice(visibleThreadRailPageStart, visibleThreadRailPageEnd),
    [filteredThreads, visibleThreadRailPageStart, visibleThreadRailPageEnd]
  );
  const canLoadOlderThreads = threadRailPage < threadRailPageCount;
  const canLoadNewerThreads = threadRailPage > 1;
  const composeDialogOpen = Boolean(search.compose);

  const handleThreadRailScroll = (event: UIEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const nearBottom =
      target.scrollHeight - target.clientHeight - target.scrollTop <= THREAD_LIST_SCROLL_LOAD_THRESHOLD_PX;
    const nearTop = target.scrollTop <= THREAD_LIST_SCROLL_LOAD_THRESHOLD_PX;

    if (nearBottom && canLoadOlderThreads) {
      setThreadRailPage(page => Math.min(page + 1, threadRailPageCount));
      return;
    }

    if (nearTop && canLoadNewerThreads) {
      setThreadRailPage(page => Math.max(1, page - 1));
    }
  };

  const handleThreadTimelineScroll = (event: UIEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const nearBottom =
      target.scrollHeight - target.clientHeight - target.scrollTop <= THREAD_LIST_SCROLL_LOAD_THRESHOLD_PX;
    const nearTop = target.scrollTop <= THREAD_LIST_SCROLL_LOAD_THRESHOLD_PX;

    shouldAutoScrollTimelineRef.current = nearBottom;

    if (nearTop && canLoadOlderTimeline) {
      setThreadTimelinePage(page => Math.min(page + 1, threadTimelinePageCount));
      return;
    }

    if (nearBottom && canLoadNewerTimeline) {
      setThreadTimelinePage(page => Math.max(1, page - 1));
    }
  };

  function closeComposeDialog(options?: {
    threadId?: bigint | null;
  }) {
    if (!activeActor) {
      return;
    }

    void navigate({
      to: '/$slug',
      params: { slug: activeActor.slug },
      search: buildWorkspaceSearch({
        thread:
          options?.threadId !== undefined
            ? options.threadId?.toString()
            : search.thread,
        compose: undefined,
        lookup: undefined,
        tab: search.tab,
        settings: search.settings,
      }),
      replace: true,
    });
    setComposeLookupSlug('');
    setComposeResolvedTargets([]);
    setComposeSelectedActorIds([]);
    setComposeThreadTitle('');
    setComposeThreadLocked(false);
    setComposeFirstMessage('');
    setActorActionError(null);
    setActorFeedback(null);
  }

  function openComposeDialog() {
    if (!activeActor) {
      return;
    }

    void navigate({
      to: '/$slug',
      params: { slug: activeActor.slug },
      search: buildWorkspaceSearch({
        thread: search.thread,
        compose: 'add',
        lookup: search.lookup,
        tab: search.tab,
        settings: search.settings,
      }),
      replace: true,
    });
  }

  useEffect(() => {
    const requestedThread = search.thread;
    if (!requestedThread) {
      return;
    }

    try {
      const requestedThreadId = BigInt(requestedThread);
      if (
        requestedThreadId !== selectedThreadId &&
        visibleThreads.some(thread => thread.id === requestedThreadId)
      ) {
        return deferEffectStateUpdate(() => {
          setSelectedThreadId(requestedThreadId);
        });
      }
    } catch {
      // Ignore malformed thread ids in the URL and fall back to the default selection logic.
    }
  }, [search.thread, selectedThreadId, visibleThreads]);

  useEffect(() => {
    if (pendingVisibleThreadCount !== null) {
      if (visibleThreads.length >= pendingVisibleThreadCount && visibleThreads[0]) {
        return deferEffectStateUpdate(() => {
          setSelectedThreadId(visibleThreads[0].id);
          setPendingVisibleThreadCount(null);
        });
      }
    }
    if (selectedThreadId !== null && visibleThreads.some(thread => thread.id === selectedThreadId)) return;
    return deferEffectStateUpdate(() => {
      setSelectedThreadId(visibleThreads[0]?.id ?? null);
    });
  }, [pendingVisibleThreadCount, selectedThreadId, visibleThreads]);

  const resolveVisiblePublishedActors = useCallback(async (identifier: string): Promise<{
    matches: ResolvedPublishedActor[];
    selected: ResolvedPublishedActor;
  }> => {
    if (!liveConnection || !authenticatedSession) {
      throw new Error('Sign in and connect to SpacetimeDB before looking up inbox slugs or emails.');
    }

    return resolvePublishedActorsForIdentifier({
      identifier,
      liveConnection,
    });
  }, [authenticatedSession, liveConnection]);

  useEffect(() => {
    const requestedLookup = search.lookup?.trim() ?? '';
    if (!search.compose || !requestedLookup || !activeActor) {
      lastAutoResolvedLookupRef.current = null;
      return;
    }
    if (lastAutoResolvedLookupRef.current === requestedLookup) {
      return;
    }

    lastAutoResolvedLookupRef.current = requestedLookup;
    setComposeLookupSlug(requestedLookup);
    void (async () => {
      try {
        const resolved = await resolveVisiblePublishedActors(requestedLookup);
        const matches = resolved.matches.filter(
          actor => !activeActor || actor.publicIdentity !== activeActor.publicIdentity
        );
        if (matches.length > 0) {
          setComposeResolvedTargets(current => mergeResolvedActors(current, matches));
          const selected =
            matches.find(actor => actor.publicIdentity === resolved.selected.publicIdentity) ??
            matches[0];
          setComposeSelectedActorIds(current =>
            selected && !current.includes(selected.publicIdentity)
              ? [...current, selected.publicIdentity]
              : current
          );
          setComposeLookupSlug('');
        }
        if (activeActor) {
          void navigate({
            to: '/$slug',
            params: { slug: activeActor.slug },
            search: buildWorkspaceSearch({
              thread: search.thread,
              compose: search.compose,
              lookup: undefined,
              tab: search.tab,
              settings: search.settings,
            }),
            replace: true,
          });
        }
      } catch {
        // Auto-resolve failures are silent
      }
    })();
  }, [activeActor, navigate, resolveVisiblePublishedActors, search.thread, search.compose, search.lookup, search.settings, search.tab]);

  const selectedThread = useMemo(
    () => visibleThreads.find(thread => thread.id === selectedThreadId),
    [selectedThreadId, visibleThreads]
  );
  useEffect(() => {
    shouldAutoScrollTimelineRef.current = true;
  }, [selectedThread?.id]);
  useEffect(() => {
    if (!selectedThread) {
      return deferEffectStateUpdate(() => {
        setShowParticipantsDialog(false);
      });
    }
  }, [selectedThread]);

  const selectedThreadParticipants = useMemo(
    () => (selectedThread ? participantsByThreadId.get(selectedThread.id) ?? [] : []),
    [participantsByThreadId, selectedThread]
  );
  const selectedThreadPendingInvites = useMemo(
    () =>
      selectedThread
        ? threadInvites.filter(invite => {
            return invite.threadId === selectedThread.id && invite.status === 'pending';
          })
        : [],
    [selectedThread, threadInvites]
  );

  const selectedThreadMessages = useMemo(
    () =>
      selectedThread
        ? messages
            .filter(message => message.threadId === selectedThread.id)
            .sort((left, right) => Number(left.threadSeq - right.threadSeq))
        : [],
    [messages, selectedThread]
  );

  const selectedThreadKeyRotations = useMemo(() => {
    if (!selectedThread) return [];

    return selectedThreadParticipants
      .flatMap(participant => {
        const actor = actorById.get(participant.agentDbId);
        if (!actor) return [];

        return (bundlesByActorId.get(participant.agentDbId) ?? [])
          .filter(bundle => compareTimestamp(bundle.createdAt, participant.joinedAt) > 0)
          .map(
            bundle =>
              ({
                actor,
                bundle,
              }) satisfies KeyRotationNotice
          );
      })
      .sort((left, right) => {
        const timeOrder = compareTimestamp(left.bundle.createdAt, right.bundle.createdAt);
        if (timeOrder !== 0) return timeOrder;
        return Number(left.bundle.id - right.bundle.id);
      });
  }, [actorById, bundlesByActorId, selectedThread, selectedThreadParticipants]);

  const selectedThreadTimeline = useMemo(
    () => mergeThreadTimeline(selectedThreadMessages, selectedThreadKeyRotations),
    [selectedThreadKeyRotations, selectedThreadMessages]
  );
  const threadTimelinePageCount = useMemo(
    () => Math.max(1, Math.ceil(selectedThreadTimeline.length / THREAD_TIMELINE_PAGE_SIZE)),
    [selectedThreadTimeline.length]
  );

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setThreadTimelinePage(1);
    });
  }, [selectedThread?.id]);

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setThreadTimelinePage(current => Math.min(current, threadTimelinePageCount));
    });
  }, [threadTimelinePageCount]);

  const selectedThreadTimelineWindowEnd = Math.max(
    0,
    selectedThreadTimeline.length - (threadTimelinePage - 1) * THREAD_TIMELINE_PAGE_SIZE
  );
  const selectedThreadTimelineWindowStart = Math.max(
    0,
    selectedThreadTimelineWindowEnd - THREAD_TIMELINE_PAGE_SIZE
  );
  const paginatedThreadTimeline = useMemo(
    () =>
      selectedThreadTimeline.slice(
        selectedThreadTimelineWindowStart,
        selectedThreadTimelineWindowEnd
      ),
    [selectedThreadTimeline, selectedThreadTimelineWindowEnd, selectedThreadTimelineWindowStart]
  );
  const canLoadOlderTimeline = threadTimelinePage < threadTimelinePageCount;
  const canLoadNewerTimeline = threadTimelinePage > 1;
  const latestTimelineItemSignature = useMemo(() => {
    const latestItem = selectedThreadTimeline[selectedThreadTimeline.length - 1];
    if (!latestItem) {
      return null;
    }

    if (latestItem.kind === 'keyRotation') {
      return `key-rotation-${latestItem.notice.bundle.id.toString()}`;
    }

    return `message-${latestItem.message.id.toString()}`;
  }, [selectedThreadTimeline]);

  useEffect(() => {
    const timelineScrollContainer = threadTimelineScrollRef.current;
    if (!timelineScrollContainer) {
      return;
    }

    if (!latestTimelineItemSignature) {
      lastTimelineSignatureRef.current = null;
      return;
    }

    if (latestTimelineItemSignature === lastTimelineSignatureRef.current) {
      return;
    }

    if (!shouldAutoScrollTimelineRef.current || threadTimelinePage !== 1) {
      lastTimelineSignatureRef.current = latestTimelineItemSignature;
      return;
    }

    lastTimelineSignatureRef.current = latestTimelineItemSignature;
    timelineScrollContainer.scrollTop = timelineScrollContainer.scrollHeight;
  }, [threadTimelinePage, latestTimelineItemSignature, selectedThread]);

  const latestSelectedThreadSenderMessage = useMemo(
    () =>
      activeActor
        ? [...selectedThreadMessages]
            .filter(message => message.senderAgentDbId === activeActor.id)
            .sort((left, right) => Number(right.senderSeq - left.senderSeq))[0]
        : undefined,
    [activeActor, selectedThreadMessages]
  );

  const requiresSecretRotation = useMemo(
    () =>
      secretRotationRequired({
        senderActor: activeActor,
        latestSenderMessage: latestSelectedThreadSenderMessage,
        currentMembershipVersion: selectedThread?.membershipVersion,
        participants: selectedThreadParticipants,
        actorById,
        envelopes: threadSecretEnvelopes,
      }),
    [
      activeActor,
      actorById,
      selectedThread?.membershipVersion,
      threadSecretEnvelopes,
      latestSelectedThreadSenderMessage,
      selectedThreadParticipants,
    ]
  );

  const activeParticipant = useMemo(
    () =>
      activeActor && selectedThread
        ? selectedThreadParticipants.find(participant => participant.agentDbId === activeActor.id)
        : undefined,
    [activeActor, selectedThread, selectedThreadParticipants]
  );

  const composeOptions = useMemo(() => {
    const options: Array<Agent | ResolvedPublishedActor> = actors
      .filter(actor => !activeActor || actor.id !== activeActor.id)
      .sort((left, right) => describeActor(left).localeCompare(describeActor(right)));
    for (const actor of composeResolvedTargets) {
      if (
        (!activeActor || actor.publicIdentity !== activeActor.publicIdentity) &&
        !options.some(option => actorOptionId(option) === actor.publicIdentity)
      ) {
        options.push(actor);
      }
    }
    return options;
  }, [activeActor, actors, composeResolvedTargets]);
  const activeParticipantIsAdmin = Boolean(activeParticipant?.isAdmin);
  const availableAddTargets = useMemo(() => {
    if (!selectedThread) return [];
    const activeIds = new Set(
      selectedThreadParticipants.map(participant => participant.agentDbId.toString())
    );
    const pendingInviteIdentities = new Set(
      selectedThreadPendingInvites.map(invite => invite.inviteePublicIdentity)
    );
    return actors
      .filter(actor => {
        return (
          !activeIds.has(actor.id.toString()) &&
          !pendingInviteIdentities.has(actor.publicIdentity)
        );
      })
      .sort((left, right) => describeActor(left).localeCompare(describeActor(right)));
  }, [actors, selectedThread, selectedThreadParticipants, selectedThreadPendingInvites]);
  const addParticipantOptions = useMemo(() => {
    const options: Array<Agent | ResolvedPublishedActor> = [...availableAddTargets];
    const participantPublicIdentities = new Set([
      ...selectedThreadParticipants
        .map(participant => actorById.get(participant.agentDbId)?.publicIdentity)
        .filter((value): value is string => Boolean(value)),
      ...selectedThreadPendingInvites.map(invite => invite.inviteePublicIdentity),
    ]);
    for (const actor of resolvedAddTargets) {
      if (
        !participantPublicIdentities.has(actor.publicIdentity) &&
        !options.some(option => actorOptionId(option) === actor.publicIdentity)
      ) {
        options.push(actor);
      }
    }
    return options;
  }, [
    actorById,
    availableAddTargets,
    resolvedAddTargets,
    selectedThreadParticipants,
    selectedThreadPendingInvites,
  ]);

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setComposeSelectedActorIds(current =>
        current.filter(id => composeOptions.some(actor => actorOptionId(actor) === id))
      );
    });
  }, [composeOptions]);

  useEffect(() => {
    if (!addParticipantOptions.some(actor => actorOptionId(actor) === pendingParticipantId)) {
      return deferEffectStateUpdate(() => {
        setPendingParticipantId(
          addParticipantOptions[0] ? actorOptionId(addParticipantOptions[0]) : ''
        );
      });
    }
  }, [addParticipantOptions, pendingParticipantId]);

  useEffect(() => {
    if (!activeActor || !actorKeyPair || !selectedThread) {
      return deferEffectStateUpdate(() => {
        setDecryptedMessageById({});
      });
    }
    if (!matchesPublishedActorKeys(activeActor, actorKeyPair)) {
      return deferEffectStateUpdate(() => {
        setSessionError('Local keys do not match the currently published keys for this inbox.');
        setDecryptedMessageById({});
      });
    }

    let cancelled = false;

    const decryptAll = async () => {
      const next: DecryptedMap = {};
      const ownCapabilities = getActorPublishedCapabilities(activeActor);

      for (const message of selectedThreadMessages) {
        const senderActor = actorById.get(message.senderAgentDbId);
        if (!senderActor) continue;

        let messageTrustStatus: DecryptedMessageState['trustStatus'] = 'trusted';
        let messageTrustWarning: string | null = null;
        if (senderActor.inboxId === activeActor.inboxId) {
          messageTrustStatus = 'self';
        } else {
          const observedTuple = tupleFromVisibleActor(senderActor);
          const allowFirstContactTrust = message.threadSeq === 1n && message.senderSeq === 1n;
          const comparison = allowFirstContactTrust
            ? autoPinPeerIfUnknown(senderActor.publicIdentity, observedTuple)
            : comparePinnedPeer(senderActor.publicIdentity, observedTuple);
          if (comparison.status === 'unpinned') {
            messageTrustStatus = 'unpinned-first-seen';
            if (!allowFirstContactTrust) {
              messageTrustWarning = `${senderActor.slug} keys are not trusted for this existing contact. Verify out-of-band before trusting.`;
            }
          } else if (comparison.status === 'rotated') {
            const messageSigningKey = findVersionedKey(
              senderActor,
              bundlesByActorId.get(senderActor.id) ?? [],
              'signing',
              message.signingKeyVersion
            );
            const messageTrusted = Boolean(messageSigningKey) && isInboundSignatureTrusted(
              senderActor.publicIdentity,
              message.signingKeyVersion,
              messageSigningKey ?? ''
            );
            if (!messageTrusted) {
              messageTrustStatus = 'untrusted-rotation';
              messageTrustWarning = `${senderActor.slug} has rotated keys. Verify out-of-band before trusting.`;
            }
          }
        }

        const envelope = threadSecretEnvelopes.find(row => {
          return (
            row.threadId === message.threadId &&
            row.senderAgentDbId === message.senderAgentDbId &&
            row.recipientAgentDbId === activeActor.id &&
            row.membershipVersion === message.membershipVersion &&
            row.secretVersion === message.secretVersion
          );
        });

        if (!envelope) {
          next[message.id.toString()] = {
            status: 'failed',
            bodyText: null,
            error: 'No envelope available for this inbox',
            contentType: null,
            headerNames: [],
            headers: null,
            unsupportedReasons: [],
            revealedUnsupported: false,
            legacyPlaintext: false,
            trustStatus: messageTrustStatus,
            trustWarning: messageTrustWarning,
          };
          continue;
        }

        const senderBundles = bundlesByActorId.get(senderActor.id) ?? [];
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
          message.signingKeyVersion
        );
        const envelopeSigningPublicKey = findVersionedKey(
          senderActor,
          senderBundles,
          'signing',
          envelope.signingKeyVersion
        );

        if (!senderEncryptionPublicKey || !messageSigningPublicKey || !envelopeSigningPublicKey) {
          next[message.id.toString()] = {
            status: 'failed',
            bodyText: null,
            error: 'Missing sender public keys for this message',
            contentType: null,
            headerNames: [],
            headers: null,
            unsupportedReasons: [],
            revealedUnsupported: false,
            legacyPlaintext: false,
            trustStatus: messageTrustStatus,
            trustWarning: messageTrustWarning,
          };
          continue;
        }

        const recipientKeyPair = getAgentKeyPairForEncryptionVersion(
          toActorIdentity(activeActor),
          envelope.recipientEncryptionKeyVersion
        );

        if (!recipientKeyPair) {
          next[message.id.toString()] = {
            status: 'failed',
            bodyText: null,
            error: 'Missing local private key for this envelope version',
            contentType: null,
            headerNames: [],
            headers: null,
            unsupportedReasons: [],
            revealedUnsupported: false,
            legacyPlaintext: false,
            trustStatus: messageTrustStatus,
            trustWarning: messageTrustWarning,
          };
          continue;
        }

        try {
          const plaintext = await decryptMessage({
            recipientKeyPair,
            recipientPublicIdentity: activeActor.publicIdentity,
            message: {
              threadId: message.threadId,
              senderActorId: senderActor.id,
              senderPublicIdentity: senderActor.publicIdentity,
              senderSeq: message.senderSeq,
              secretVersion: message.secretVersion,
              signingKeyVersion: message.signingKeyVersion,
              ciphertext: message.ciphertext,
              iv: message.iv,
              cipherAlgorithm: message.cipherAlgorithm,
              signature: message.signature,
              replyToMessageId: message.replyToMessageId ?? undefined,
            },
            envelope: {
              id: envelope.id,
              threadId: envelope.threadId,
              secretVersion: envelope.secretVersion,
              senderActorId: envelope.senderAgentDbId,
              senderPublicIdentity: senderActor.publicIdentity,
              recipientActorId: envelope.recipientAgentDbId,
              recipientPublicIdentity: activeActor.publicIdentity,
              recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
              senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
              signingKeyVersion: envelope.signingKeyVersion,
              wrappedSecretCiphertext: envelope.wrappedSecretCiphertext,
              wrappedSecretIv: envelope.wrappedSecretIv,
              wrapAlgorithm: envelope.wrapAlgorithm,
              signature: envelope.signature,
            },
            senderEncryptionPublicKey,
            messageSigningPublicKey,
            envelopeSigningPublicKey,
          });
          const parsed = parseDecryptedMessagePlaintext(plaintext);
          const unsupportedReasons = [
            ...(parsed.invalidStructuredEnvelopeReason
              ? [parsed.invalidStructuredEnvelopeReason]
              : []),
            ...findUnsupportedMessageReasons({
              payload: parsed.payload,
              capabilities: ownCapabilities,
            }),
          ];
          const headers = parsed.invalidStructuredEnvelopeReason
            ? []
            : parsed.payload.headers ?? [];
          const contentType = parsed.invalidStructuredEnvelopeReason
            ? null
            : parsed.payload.contentType;
          next[message.id.toString()] = {
            status: unsupportedReasons.length > 0 ? 'unsupported' : 'ok',
            bodyText: formatEncryptedMessageBody(parsed.payload),
            error: null,
            contentType,
            headerNames: headers.map(header => header.name),
            headers,
            unsupportedReasons,
            revealedUnsupported: false,
            legacyPlaintext: parsed.legacyPlaintext,
            trustStatus: messageTrustStatus,
            trustWarning: messageTrustWarning,
          };
        } catch (error) {
          next[message.id.toString()] = {
            status: 'failed',
            bodyText: null,
            error: error instanceof Error ? error.message : 'Unable to decrypt',
            contentType: null,
            headerNames: [],
            headers: null,
            unsupportedReasons: [],
            revealedUnsupported: false,
            legacyPlaintext: false,
            trustStatus: messageTrustStatus,
            trustWarning: messageTrustWarning,
          };
        }
      }

      if (!cancelled) {
        setDecryptedMessageById(current => {
          for (const [messageId, state] of Object.entries(next)) {
            if (state.status === 'unsupported' && current[messageId]?.revealedUnsupported) {
              state.revealedUnsupported = true;
            }
          }
          return next;
        });
      }
    };

    void decryptAll();

    return () => {
      cancelled = true;
    };
  }, [
    activeActor,
    actorById,
    actorKeyPair,
    bundlesByActorId,
    threadSecretEnvelopes,
    selectedThread,
    selectedThreadMessages,
  ]);

  async function handleCreateInboxIdentity(event: React.FormEvent) {
    event.preventDefault();
    if (!displayInbox || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    if (!vaultUnlocked) {
      setActorActionError(
        describeLocalVaultRequirement({
          initialized: vaultInitialized,
          phrase: 'before creating inbox keys',
        })
      );
      return;
    }

    setActorActionError(null);
    setActorFeedback(null);

    const normalizedSlug = normalizeInboxSlug(newInboxSlug);
    if (!normalizedSlug) {
      setActorActionError('Inbox slug is required.');
      return;
    }

    try {
      const identity: ActorIdentity = {
        normalizedEmail: displayInbox.normalizedEmail,
        slug: normalizedSlug,
        inboxIdentifier: normalizedSlug,
      };
      const keyPair = await getOrCreateAgentKeyPair(identity);
      await Promise.resolve(
        createInboxIdentityReducer({
          slug: normalizedSlug,
          displayName: newInboxDisplayName.trim() || undefined,
          encryptionPublicKey: keyPair.encryption.publicKey,
          encryptionKeyVersion: keyPair.encryption.keyVersion,
          encryptionAlgorithm: keyPair.encryption.algorithm,
          signingPublicKey: keyPair.signing.publicKey,
          signingKeyVersion: keyPair.signing.keyVersion,
          signingAlgorithm: keyPair.signing.algorithm,
        })
      );
      queueKeyBackupPrompt({
        normalizedEmail: displayInbox.normalizedEmail,
        slug: normalizedSlug,
        reason: 'created',
      });
      setActiveActorIdentity(identity);
      setNewInboxSlug('');
      setNewInboxDisplayName('');
      void navigate({
        to: '/$slug',
        params: { slug: normalizedSlug },
        search: buildWorkspaceSearch({}),
      });
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to create inbox slug');
    }
  }

  async function handleRotateKeys() {
    if (!activeActor || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    if (!vaultUnlocked) {
      setActorActionError(
        describeLocalVaultRequirement({
          initialized: vaultInitialized,
          phrase: 'before rotating inbox keys',
        })
      );
      return;
    }

    if (approvedDevices.length === 0) {
      await performRotateKeys([], []);
      return;
    }

    setRotationShareDeviceIds(
      approvedDevices
        .filter(device => device.deviceId !== currentDeviceId)
        .map(device => device.deviceId)
    );
    setRotationRevokeDeviceIds([]);
    setShowRotationSharePrompt(true);
  }

  async function handleOverrideKeys() {
    setShowKeysRecoveryDialog(false);
    await handleRotateKeys();
  }

  function handleRotationShareChange(deviceId: string, checked: boolean) {
    setRotationShareDeviceIds(current => {
      if (checked) {
        return current.includes(deviceId) ? current : [...current, deviceId];
      }

      return current.filter(value => value !== deviceId);
    });

    if (checked) {
      setRotationRevokeDeviceIds(current => current.filter(value => value !== deviceId));
    }
  }

  function handleRotationRevokeChange(deviceId: string, checked: boolean) {
    if (deviceId === currentDeviceId) {
      return;
    }

    setRotationRevokeDeviceIds(current => {
      if (checked) {
        return current.includes(deviceId) ? current : [...current, deviceId];
      }

      return current.filter(value => value !== deviceId);
    });

    if (checked) {
      setRotationShareDeviceIds(current => current.filter(value => value !== deviceId));
    }
  }

  async function ensureCurrentDeviceRegistration(normalizedEmail: string): Promise<DeviceKeyMaterial> {
    const device = await getOrCreateDeviceKeyMaterial(normalizedEmail);
    await Promise.resolve(
      registerDeviceReducer({
        deviceId: device.deviceId,
        label: 'Browser',
        platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
        deviceEncryptionPublicKey: device.keyPair.publicKey,
        deviceEncryptionKeyVersion: device.keyPair.keyVersion,
        deviceEncryptionAlgorithm: device.keyPair.algorithm,
      })
    );
    return device;
  }

  async function performRotateKeys(
    shareDeviceIds: string[],
    revokeDeviceIds: string[]
  ): Promise<void> {
    if (!activeActor || !displayInbox) {
      return;
    }

    setActorActionError(null);
    setActorFeedback(null);
    setDeviceActionBusy(true);

    let publishedRotation = false;
    try {
      const rotationPlan = await previewStoredAgentKeyRotation(toActorIdentity(activeActor), {
        encryptionPublicKey: activeActor.currentEncryptionPublicKey,
        encryptionKeyVersion: activeActor.currentEncryptionKeyVersion,
        signingPublicKey: activeActor.currentSigningPublicKey,
        signingKeyVersion: activeActor.currentSigningKeyVersion,
      });
      const sourceDevice = await ensureCurrentDeviceRegistration(displayInbox.normalizedEmail);
      const normalizedRevokeDeviceIds = Array.from(new Set(revokeDeviceIds));
      const rotationBundles: DeviceKeyBundleAttachment[] = [];
      const rotationSnapshot = await exportInboxKeyShareSnapshot(displayInbox.normalizedEmail, {
        overrides: [rotationPlan.nextSharedMaterial],
      });

      for (const deviceId of Array.from(new Set(shareDeviceIds))) {
        if (deviceId === sourceDevice.deviceId || normalizedRevokeDeviceIds.includes(deviceId)) {
          continue;
        }

        const targetDevice = approvedDevices.find(device => device.deviceId === deviceId);
        if (!targetDevice) {
          continue;
        }

        const approvedShare = await buildApprovedDeviceShare({
          normalizedEmail: displayInbox.normalizedEmail,
          targetDeviceId: targetDevice.deviceId,
          targetDeviceEncryptionPublicKey: targetDevice.deviceEncryptionPublicKey,
          sourceDevice,
          snapshot: rotationSnapshot,
        });

        rotationBundles.push({
          deviceId: targetDevice.deviceId,
          sourceDeviceId: approvedShare.sourceDeviceId,
          sourceEncryptionPublicKey: approvedShare.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: approvedShare.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: approvedShare.sourceEncryptionAlgorithm,
          bundleCiphertext: approvedShare.bundleCiphertext,
          bundleIv: approvedShare.bundleIv,
          bundleAlgorithm: approvedShare.bundleAlgorithm,
          sharedAgentCount: BigInt(approvedShare.sharedActorCount),
          sharedKeyVersionCount: BigInt(approvedShare.sharedKeyVersionCount),
          expiresAt: Timestamp.fromDate(approvedShare.expiresAt),
        });
      }

      await Promise.resolve(
        rotateAgentKeysReducer({
          agentDbId: activeActor.id,
          encryptionPublicKey: rotationPlan.rotated.encryption.publicKey,
          encryptionKeyVersion: rotationPlan.rotated.encryption.keyVersion,
          encryptionAlgorithm: rotationPlan.rotated.encryption.algorithm,
          signingPublicKey: rotationPlan.rotated.signing.publicKey,
          signingKeyVersion: rotationPlan.rotated.signing.keyVersion,
          signingAlgorithm: rotationPlan.rotated.signing.algorithm,
          deviceKeyBundles: rotationBundles,
          revokeDeviceIds: normalizedRevokeDeviceIds,
        })
      );
      publishedRotation = true;
      await commitStoredAgentKeyRotation(rotationPlan);
      setActorKeyPair(rotationPlan.rotated);
      setLocalKeyIssue(null);
      setSessionError(null);
      setShowKeysRecoveryDialog(false);
      setRotateSecret(true);
      setShowRotationSharePrompt(false);
      setActorFeedback(
        rotationBundles.length > 0 || normalizedRevokeDeviceIds.length > 0
          ? `Keys rotated. Shared to ${rotationBundles.length.toString()} device(s) and revoked ${normalizedRevokeDeviceIds.length.toString()} device(s).`
          : 'Keys rotated. The next message will rotate the sender secret.'
      );
    } catch (error) {
      if (publishedRotation) {
        setLocalKeyIssue('missing');
        setSessionError(
          'New keys were published, but this browser could not save the matching private keys locally. Recover them from another device or a backup before continuing.'
        );
        setShowKeysRecoveryDialog(true);
        setActorActionError(
          error instanceof Error
            ? `Keys were published, but saving them locally failed. ${error.message}`
            : 'Keys were published, but saving them locally failed.'
        );
      } else {
        setActorActionError(formatRotateKeysError(error));
      }
    } finally {
      setDeviceActionBusy(false);
    }
  }

  async function handleRequestDeviceShare() {
    if (!displayInbox || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    if (!vaultUnlocked) {
      setActorActionError(
        describeLocalVaultRequirement({
          initialized: vaultInitialized,
          phrase: 'before requesting a device share',
        })
      );
      return;
    }

    setActorActionError(null);
    setActorFeedback(null);
    setDeviceActionBusy(true);

    try {
      const prepared = await prepareLocalDeviceShareRequest(displayInbox.normalizedEmail);
      await Promise.resolve(
        registerDeviceReducer({
          deviceId: prepared.device.deviceId,
          label: 'One-time recovery key',
          platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
          deviceEncryptionPublicKey: prepared.device.keyPair.publicKey,
          deviceEncryptionKeyVersion: prepared.device.keyPair.keyVersion,
          deviceEncryptionAlgorithm: prepared.device.keyPair.algorithm,
        })
      );
      await Promise.resolve(
        createDeviceShareRequestReducer({
          deviceId: prepared.device.deviceId,
          verificationCodeHash: prepared.verificationCodeHash,
          clientCreatedAt: Timestamp.fromDate(prepared.clientCreatedAt),
        })
      );
      setPendingDeviceShareRequest({
        device: prepared.device,
        verificationCode: prepared.parsedCode.formattedCode,
        verificationSymbols: prepared.parsedCode.symbols,
        verificationWords: prepared.parsedCode.words,
        expiresAt: prepared.expiresAt.toISOString(),
      });
      setActorFeedback('Device share request created. Approve it from another authenticated device.');
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to create a device share request'
      );
    } finally {
      setDeviceActionBusy(false);
    }
  }

  async function handleApproveDeviceShareByCode() {
    if (!displayInbox || !connected || !liveConnection) return;
    if (!ensureAuthorizedWriteAccess()) return;
    if (!vaultUnlocked) {
      setActorActionError(
        describeLocalVaultRequirement({
          initialized: vaultInitialized,
          phrase: 'before approving a device share',
        })
      );
      return;
    }

    const trimmedCode = deviceVerificationCode.trim();
    if (!trimmedCode) {
      setActorActionError('Enter an emoji verification code to approve a share.');
      return;
    }

    setActorActionError(null);
    setActorFeedback(null);
    setDeviceActionBusy(true);

    try {
      const sourceDevice = await ensureCurrentDeviceRegistration(displayInbox.normalizedEmail);
      setVerifyingDeviceRequest(true);
      const request = await resolveVerifiedDeviceShareRequest({
        liveConnection,
        verificationCode: trimmedCode,
      });
      setVerifyingDeviceRequest(false);

      const approvedShare = await buildApprovedDeviceShare({
        normalizedEmail: displayInbox.normalizedEmail,
        targetDeviceId: request.deviceId,
        targetDeviceEncryptionPublicKey: request.deviceEncryptionPublicKey,
        sourceDevice,
      });

      await Promise.resolve(
        approveDeviceShareReducer({
          requestId: request.requestId,
          sourceDeviceId: approvedShare.sourceDeviceId,
          sourceEncryptionPublicKey: approvedShare.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: approvedShare.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: approvedShare.sourceEncryptionAlgorithm,
          bundleCiphertext: approvedShare.bundleCiphertext,
          bundleIv: approvedShare.bundleIv,
          bundleAlgorithm: approvedShare.bundleAlgorithm,
          sharedAgentCount: BigInt(approvedShare.sharedActorCount),
          sharedKeyVersionCount: BigInt(approvedShare.sharedKeyVersionCount),
          expiresAt: Timestamp.fromDate(approvedShare.expiresAt),
        })
      );

      setDeviceVerificationCode('');
      setActorFeedback(`Shared private keys to device ${request.deviceId}.`);
      setShowKeysRecoveryDialog(false);
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to approve device share');
    } finally {
      setVerifyingDeviceRequest(false);
      setDeviceActionBusy(false);
    }
  }

  async function handleRevokeDevice(deviceId: string) {
    if (!connected) return;
    if (!ensureAuthorizedWriteAccess()) return;

    setActorActionError(null);
    setActorFeedback(null);
    setDeviceActionBusy(true);

    try {
      await Promise.resolve(
        revokeDeviceReducer({
          deviceId,
        })
      );
      setActorFeedback(`Revoked device ${deviceId}.`);
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to revoke device');
    } finally {
      setDeviceActionBusy(false);
    }
  }

  async function handleBackupImportSuccess() {
    setActorActionError(null);
    setActorFeedback(null);

    if (!activeActorIdentity) {
      return;
    }

    const importedKeyPair = await loadStoredAgentKeyPair(activeActorIdentity);
    const nextIssue = getActiveActorKeyIssue(activeActor, importedKeyPair);
    const nextError = getActiveActorKeyError(nextIssue);
    setActorKeyPair(importedKeyPair);
    setLocalKeyIssue(nextIssue);
    setSessionError(nextError);
    setShowKeysRecoveryDialog(Boolean(nextIssue));
    if (!nextError) {
      setActorFeedback('Encrypted backup imported. Local private keys were restored.');
    }
  }

  async function resolveRecipientPublicKeys(
    target: Agent | ResolvedPublishedActor
  ): Promise<ActorPublicKeys> {
    if ('normalizedEmail' in target) {
      return toActorPublicKeys(target);
    }
    if (!liveConnection) {
      throw new Error('Sign in and connect to SpacetimeDB before sending messages.');
    }

    const publishedActor = (
      await liveConnection.procedures.lookupPublishedAgentBySlug({
        slug: target.slug,
      })
    )[0];
    if (!publishedActor) {
      throw new Error('Recipient public keys are unavailable.');
    }

    return toPublishedActorPublicKeys(publishedActor);
  }


  async function handleResolveAddParticipant() {
    setActorActionError(null);
    setActorFeedback(null);

    try {
      const resolved = await resolveVisiblePublishedActors(pendingParticipantLookupSlug);
      const existingParticipantIds = new Set(
        selectedThreadParticipants
          .map(participant => actorById.get(participant.agentDbId)?.publicIdentity)
          .filter((value): value is string => Boolean(value))
      );
      const matches = resolved.matches.filter(
        actor => !existingParticipantIds.has(actor.publicIdentity)
      );
      if (matches.length === 0) {
        throw new Error('That inbox slug or email is already a participant in this thread.');
      }

      const selected =
        matches.find(actor => actor.publicIdentity === resolved.selected.publicIdentity) ??
        matches[0];
      setResolvedAddTargets(current => mergeResolvedActors(current, matches));
      setPendingParticipantId(selected?.publicIdentity ?? '');
      setPendingParticipantLookupSlug('');
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to resolve inbox slug or email'
      );
    }
  }

  async function handleResolveComposeTargets() {
    setActorActionError(null);
    setActorFeedback(null);
    try {
      const resolved = await resolveVisiblePublishedActors(composeLookupSlug);
      const matches = resolved.matches.filter(
        actor => !activeActor || actor.publicIdentity !== activeActor.publicIdentity
      );
      if (matches.length === 0) {
        throw new Error('No matching agents found for that slug or email.');
      }
      setComposeResolvedTargets(current => mergeResolvedActors(current, matches));
      const selected =
        matches.find(actor => actor.publicIdentity === resolved.selected.publicIdentity) ??
        matches[0];
      setComposeSelectedActorIds(current =>
        selected && !current.includes(selected.publicIdentity)
          ? [...current, selected.publicIdentity]
          : current
      );
      setComposeLookupSlug('');
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to resolve inbox slug or email'
      );
    }
  }

  async function handleSubmitCompose() {
    if (!activeActor || !connected || !ensureAuthorizedWriteAccess()) {
      return;
    }
    setActorActionError(null);
    setActorFeedback(null);

    if (composeSelectedActorIds.length === 0) {
      setActorActionError('Select at least one recipient.');
      return;
    }

    const recipients = composeOptions.filter(actor =>
      composeSelectedActorIds.includes(actorOptionId(actor))
    );
    if (recipients.length !== composeSelectedActorIds.length) {
      setActorActionError('Some selected recipients are unavailable. Search again and select again.');
      return;
    }

    const isDirect = composeSelectedActorIds.length === 1;
      if (!isDirect && composeSelectedActorIds.length < 2) {
      setActorActionError('Choose at least one more recipient for a group thread.');
      return;
    }

    if (isDirect) {
      const recipient = recipients[0];
      if (!actorKeyPair || !liveConnection) {
        return;
      }

      if (!vaultUnlocked) {
        setActorActionError(
          describeLocalVaultRequirement({
            initialized: vaultInitialized,
            phrase: 'before sending messages',
          })
        );
        return;
      }

      if (!composeFirstMessage.trim()) {
        setActorActionError('Add a message to request this thread.');
        return;
      }
      if (composeFirstMessage.length > MAX_MESSAGE_BODY_CHARS) {
        setActorActionError(
          `Message text must be ${MAX_MESSAGE_BODY_CHARS.toLocaleString()} characters or fewer.`
        );
        return;
      }
      if (!matchesPublishedActorKeys(activeActor, actorKeyPair)) {
        setActorActionError('Current inbox keys are still loading. Try again in a moment.');
        return;
      }

      try {
        const outgoingPayload = {
          contentType: 'text/plain',
          body: composeFirstMessage,
        } as const;
        const publishedRoute = (
          await liveConnection.procedures.lookupPublishedPublicRouteBySlug({
            slug: (recipient as Agent).slug,
          })
        )[0];
        if (!publishedRoute) {
          throw new Error('Recipient public route is unavailable.');
        }

        const unsupportedReasons = findUnsupportedMessageReasons({
          payload: outgoingPayload,
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
        if (unsupportedReasons.length > 0) {
          throw new Error(
            `Cannot send to ${describeActorOption(recipient)}: ${unsupportedReasons.join(' ')}`
          );
        }

        const recipientKeys = await resolveRecipientPublicKeys(recipient);
        const targetPublicIdentity = actorOptionId(recipient);
        const visibleState = readCurrentVisibleState();
        let pendingRequest =
          visibleState.contactRequests.find(request => {
            return (
              request.requesterAgentDbId === activeActor.id &&
              request.targetPublicIdentity === targetPublicIdentity &&
              request.status === 'pending'
            );
          }) ?? null;
        const visibleDirectThreads = findDirectThreads(
          visibleState.threads,
          activeActor,
          targetPublicIdentity
        );
        const pendingThreadId = pendingRequest?.threadId ?? null;
        let thread: Thread | null =
          visibleDirectThreads.find(existingThread => existingThread.id === pendingThreadId) ??
          visibleDirectThreads[0] ??
          null;

        if (thread) {
          pendingRequest = null;
        }

        if (pendingRequest?.messageCount && pendingRequest.messageCount > 0n) {
          throw new Error('A pending contact request already exists for this actor pair.');
        }

        await ensurePeerTrust({
          slug: recipientKeys.slug,
          publicIdentity: recipientKeys.publicIdentity,
          observed: {
            encryptionPublicKey: recipientKeys.encryptionPublicKey,
            encryptionKeyVersion: recipientKeys.encryptionKeyVersion,
            signingPublicKey: recipientKeys.signingPublicKey,
            signingKeyVersion: recipientKeys.signingKeyVersion,
          },
          allowFirstContactTrust: !thread,
        });

        if (!thread && !pendingRequest) {
          const existingThreadIds = new Set(
            visibleDirectThreads.map(existingThread => existingThread.id.toString())
          );

          try {
            await Promise.resolve(
              createDirectThreadReducer({
                agentDbId: activeActor.id,
                otherAgentPublicIdentity: targetPublicIdentity,
                membershipLocked: undefined,
                title: composeThreadTitle.trim() || undefined,
              })
            );
            thread = await waitForNewDirectThread({
              ownActor: activeActor,
              otherPublicIdentity: targetPublicIdentity,
              existingThreadIds,
            });
          } catch (error) {
            if (!isApprovalRequiredForFirstContactError(error)) {
              throw error;
            }

            const pendingThreadId = generateClientThreadId();
            const prepared = await prepareEncryptedMessage({
              threadId: pendingThreadId,
              senderActorId: activeActor.id,
              senderPublicIdentity: activeActor.publicIdentity,
              senderSeq: 1n,
              payload: outgoingPayload,
              keyPair: actorKeyPair,
              recipients: [toActorPublicKeys(activeActor), recipientKeys],
              existingSecret: null,
              latestKnownSecretVersion: null,
              rotateSecret: false,
            });

            await Promise.resolve(
              requestDirectContactWithFirstMessageReducer({
                agentDbId: activeActor.id,
                otherAgentPublicIdentity: targetPublicIdentity,
                threadId: pendingThreadId,
                membershipLocked: undefined,
                title: composeThreadTitle.trim() || undefined,
                secretVersion: prepared.secretVersion,
                signingKeyVersion: prepared.signingKeyVersion,
                senderSeq: 1n,
                ciphertext: prepared.ciphertext,
                iv: prepared.iv,
                cipherAlgorithm: prepared.cipherAlgorithm,
                signature: prepared.signature,
                replyToMessageId: undefined,
                attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
              })
            );

            cacheSenderSecret(
              pendingThreadId,
              activeActor.publicIdentity,
              prepared.senderSecret.secretVersion,
              prepared.senderSecret.secretHex
            );
            setComposeThreadTitle('');
            setComposeFirstMessage('');
            setComposeSelectedActorIds([]);
            setComposeResolvedTargets([]);
            setActorFeedback('First-contact request sent for approval.');
            closeComposeDialog();
            return;
          }
        }

        if (pendingRequest) {
          const prepared = await prepareEncryptedMessage({
            threadId: pendingRequest.threadId,
            senderActorId: activeActor.id,
            senderPublicIdentity: activeActor.publicIdentity,
            senderSeq: 1n,
            payload: outgoingPayload,
            keyPair: actorKeyPair,
            recipients: [toActorPublicKeys(activeActor), recipientKeys],
            existingSecret: null,
            latestKnownSecretVersion: null,
            rotateSecret: false,
          });

          await Promise.resolve(
            sendEncryptedMessageReducer({
              agentDbId: activeActor.id,
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
            })
          );

          cacheSenderSecret(
            pendingRequest.threadId,
            activeActor.publicIdentity,
            prepared.senderSecret.secretVersion,
            prepared.senderSecret.secretHex
          );
          setComposeThreadTitle('');
          setComposeFirstMessage('');
          setComposeSelectedActorIds([]);
          setActorFeedback('First-contact request sent for approval.');
          closeComposeDialog();
          return;
        }

        if (!thread) {
          throw new Error('Direct thread did not become visible.');
        }

        const directThread = thread;
        const currentState = readCurrentVisibleState();
        const currentThreadParticipants = currentState.participants.filter(participant => {
          return participant.threadId === directThread.id && participant.active;
        });
        const senderParticipant =
          currentThreadParticipants.find(participant => {
            return participant.agentDbId === activeActor.id;
          }) ?? null;
        if (!senderParticipant) {
          throw new Error(
            'Current actor is not visible as a participant in the direct thread.'
          );
        }
        const latestThreadSenderMessage = currentState.messages
          .filter(message => {
            return message.threadId === directThread.id && message.senderAgentDbId === activeActor.id;
          })
          .sort((left, right) => Number(right.senderSeq - left.senderSeq))[0];
        const existingSecret = latestThreadSenderMessage
          ? getCachedSenderSecret(
              directThread.id,
              activeActor.publicIdentity,
              latestThreadSenderMessage.secretVersion
            )
          : null;
        const currentActorById = new Map<bigint, Agent>(
          currentState.actors.map(actor => [actor.id, actor])
        );
        currentActorById.set(activeActor.id, activeActor);
        const composeRequiresSecretRotation = secretRotationRequired({
          senderActor: activeActor,
          latestSenderMessage: latestThreadSenderMessage,
          currentMembershipVersion: directThread.membershipVersion,
          participants: currentThreadParticipants,
          actorById: currentActorById,
          envelopes: currentState.threadSecretEnvelopes,
        });

        const prepared = await prepareEncryptedMessage({
          threadId: directThread.id,
          senderActorId: activeActor.id,
          senderPublicIdentity: activeActor.publicIdentity,
          senderSeq: senderParticipant.lastSentSeq + 1n,
          payload: outgoingPayload,
          keyPair: actorKeyPair,
          recipients: [toActorPublicKeys(activeActor), recipientKeys],
          existingSecret,
          latestKnownSecretVersion: latestThreadSenderMessage?.secretVersion ?? null,
          rotateSecret: composeRequiresSecretRotation,
        });

        await Promise.resolve(
          sendEncryptedMessageReducer({
            agentDbId: activeActor.id,
            threadId: directThread.id,
            secretVersion: prepared.secretVersion,
            signingKeyVersion: prepared.signingKeyVersion,
            senderSeq: senderParticipant.lastSentSeq + 1n,
            ciphertext: prepared.ciphertext,
            iv: prepared.iv,
            cipherAlgorithm: prepared.cipherAlgorithm,
            signature: prepared.signature,
            replyToMessageId: undefined,
            attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
          })
        );

        cacheSenderSecret(
          directThread.id,
          activeActor.publicIdentity,
          prepared.senderSecret.secretVersion,
          prepared.senderSecret.secretHex
        );

        setComposeSelectedActorIds([]);
        setComposeResolvedTargets([]);
        setComposeThreadTitle('');
        setComposeFirstMessage('');
        setSelectedThreadId(directThread.id);
        setActorFeedback('Thread requested.');
        closeComposeDialog({ threadId: directThread.id });
      } catch (error) {
        setActorActionError(
          error instanceof Error ? error.message : 'Unable to create direct thread'
        );
      }

      return;
    }

    try {
      await Promise.resolve(
        createGroupThreadReducer({
          agentDbId: activeActor.id,
          participantPublicIdentities: composeSelectedActorIds,
          membershipLocked: composeThreadLocked,
          title: composeThreadTitle.trim() || undefined,
        })
      );
      setComposeThreadTitle('');
      setComposeThreadLocked(false);
      setComposeSelectedActorIds([]);
      setComposeResolvedTargets([]);
      setComposeFirstMessage('');
      setPendingVisibleThreadCount(visibleThreads.length + 1);
      setActorFeedback('Group thread created.');
      closeComposeDialog();
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to create group thread');
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function handleAddParticipant() {
    if (!activeActor || !selectedThread || !pendingParticipantId || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    setActorActionError(null);
    setActorFeedback(null);

    try {
      await Promise.resolve(
        addThreadParticipantReducer({
          agentDbId: activeActor.id,
          threadId: selectedThread.id,
          participantPublicIdentity: pendingParticipantId,
        })
      );
      const addResult = await waitForParticipantAddResult({
        threadId: selectedThread.id,
        participantPublicIdentity: pendingParticipantId,
      });
      setResolvedAddTargets([]);
      if (addResult === 'added') {
        setRotateSecret(true);
        setActorFeedback('Participant added. Next message must rotate sender secret.');
      } else {
        setRotateSecret(false);
        setActorFeedback('Thread invite sent. The agent will join after accepting.');
      }
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to add participant');
    }
  }

  async function handleRemoveParticipant(participantActorId: bigint) {
    if (!activeActor || !selectedThread || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    setActorActionError(null);
    setActorFeedback(null);

    try {
      await Promise.resolve(
        removeThreadParticipantReducer({
          agentDbId: activeActor.id,
          threadId: selectedThread.id,
          participantAgentDbId: participantActorId,
        })
      );
      if (participantActorId === activeActor.id) {
        setSelectedThreadId(null);
        setShowParticipantsDialog(false);
        setActorFeedback('You left the thread.');
      } else {
        setRotateSecret(true);
        setActorFeedback('Participant removed. Next message must rotate sender secret.');
      }
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to remove participant');
    }
  }

  async function handleSetParticipantAdmin(participantActorId: bigint, isAdmin: boolean) {
    if (!activeActor || !selectedThread || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    setActorActionError(null);
    setActorFeedback(null);

    try {
      await Promise.resolve(
        setThreadParticipantAdminReducer({
          agentDbId: activeActor.id,
          threadId: selectedThread.id,
          participantAgentDbId: participantActorId,
          isAdmin,
        })
      );
      setActorFeedback('Participant role updated.');
    } catch (error) {
      setActorActionError(
        error instanceof Error ? error.message : 'Unable to update participant role'
      );
    }
  }

  async function handleSendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!activeActor || !actorKeyPair || !selectedThread || !activeParticipant || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    if (!vaultUnlocked) {
        setActorActionError(
          describeLocalVaultRequirement({
            initialized: vaultInitialized,
            phrase: 'before sending messages',
          })
        );
      return;
    }

    setActorActionError(null);
    setActorFeedback(null);
    if (composerInput.length > MAX_MESSAGE_BODY_CHARS) {
      setActorActionError(
        `Message text must be ${MAX_MESSAGE_BODY_CHARS.toLocaleString()} characters or fewer.`
      );
      return;
    }
    if (!matchesPublishedActorKeys(activeActor, actorKeyPair)) {
      setActorActionError('Current inbox keys are still loading. Try again in a moment.');
      return;
    }

    try {
      const outgoingPayload = {
        contentType: 'text/plain',
        body: composerInput,
      } as const;
      const recipients = selectedThreadParticipants
        .map(participant => actorById.get(participant.agentDbId))
        .filter((actor): actor is Agent => Boolean(actor))
        .map(
          actor =>
            ({
              actorId: actor.id,
              normalizedEmail: actor.normalizedEmail,
              slug: actor.slug,
              inboxIdentifier: actor.inboxIdentifier ?? undefined,
              isDefault: actor.isDefault,
              publicIdentity: actor.publicIdentity,
              displayName: actor.displayName,
              encryptionPublicKey: actor.currentEncryptionPublicKey,
              encryptionKeyVersion: actor.currentEncryptionKeyVersion,
              signingPublicKey: actor.currentSigningPublicKey,
              signingKeyVersion: actor.currentSigningKeyVersion,
            }) satisfies ActorPublicKeys
        );
      const unsupportedRecipients = selectedThreadParticipants
        .map(participant => actorById.get(participant.agentDbId))
        .filter((actor): actor is Agent => actor != null)
        .filter(actor => actor.id !== activeActor.id)
        .map(actor => ({
          actor,
          reasons: findUnsupportedMessageReasons({
            payload: outgoingPayload,
            capabilities: getActorPublishedCapabilities(actor),
          }),
        }))
        .filter(entry => entry.reasons.length > 0);
      if (unsupportedRecipients.length > 0) {
        const first = unsupportedRecipients[0];
        setActorActionError(
          `Cannot send to ${describeActor(first.actor)}: ${first.reasons.join(' ')}`
        );
        return;
      }

      const recipientPeers = selectedThreadParticipants
        .map(participant => actorById.get(participant.agentDbId))
        .filter((actor): actor is Agent => Boolean(actor))
        .filter(actor => actor.id !== activeActor.id);
      for (const recipientActor of recipientPeers) {
        await ensurePeerTrust({
          slug: recipientActor.slug,
          publicIdentity: recipientActor.publicIdentity,
          observed: tupleFromVisibleActor(recipientActor),
          allowFirstContactTrust: false,
        });
      }

      const existingSecret = latestSelectedThreadSenderMessage
        ? getCachedSenderSecret(
            selectedThread.id,
            activeActor.publicIdentity,
            latestSelectedThreadSenderMessage.secretVersion
          )
        : null;

      const prepared = await prepareEncryptedMessage({
        threadId: selectedThread.id,
        senderActorId: activeActor.id,
        senderPublicIdentity: activeActor.publicIdentity,
        senderSeq: activeParticipant.lastSentSeq + 1n,
        payload: outgoingPayload,
        keyPair: actorKeyPair,
        recipients,
        existingSecret,
        latestKnownSecretVersion: latestSelectedThreadSenderMessage?.secretVersion ?? null,
        rotateSecret: rotateSecret || requiresSecretRotation,
      });

      await Promise.resolve(
        sendEncryptedMessageReducer({
          agentDbId: activeActor.id,
          threadId: selectedThread.id,
          secretVersion: prepared.secretVersion,
          signingKeyVersion: prepared.signingKeyVersion,
          senderSeq: activeParticipant.lastSentSeq + 1n,
          ciphertext: prepared.ciphertext,
          iv: prepared.iv,
          cipherAlgorithm: prepared.cipherAlgorithm,
          signature: prepared.signature,
          replyToMessageId: undefined,
          attachedSecretEnvelopes: prepared.attachedSecretEnvelopes,
        })
      );

      cacheSenderSecret(
        selectedThread.id,
        activeActor.publicIdentity,
        prepared.senderSecret.secretVersion,
        prepared.senderSecret.secretHex
      );
      setComposerInput('');
      setRotateSecret(false);
      setActorFeedback('Message sent.');
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to send message');
    }
  }

  async function handleMarkRead() {
    if (!activeActor || !selectedThread || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    setActorActionError(null);
    setActorFeedback(null);
    try {
      await Promise.resolve(
        markThreadReadReducer({
          agentDbId: activeActor.id,
          threadId: selectedThread.id,
          upToThreadSeq: selectedThread.lastMessageSeq,
        })
      );
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to update read state');
    }
  }

  async function handleToggleArchived() {
    if (!activeActor || !selectedThread || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;
    setActorActionError(null);
    setActorFeedback(null);
    const archived = !(readStateByThreadId.get(selectedThread.id)?.archived ?? false);
    try {
      await Promise.resolve(
        setThreadArchivedReducer({
          agentDbId: activeActor.id,
          threadId: selectedThread.id,
          archived,
        })
      );
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to update archive state');
    }
  }

  async function handleDeleteThread() {
    if (!activeActor || !selectedThread || !connected) return;
    if (!ensureAuthorizedWriteAccess()) return;

    const confirmFn =
      typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function'
        ? (message: string) => globalThis.confirm(message)
        : () => false;
    const accepted = confirmFn(
      `Permanently delete this thread? All messages, participants, and history will be removed. This cannot be undone.`
    );
    if (!accepted) return;

    setActorActionError(null);
    setActorFeedback(null);
    try {
      await Promise.resolve(
        deleteThreadReducer({
          agentDbId: activeActor.id,
          threadId: selectedThread.id,
        })
      );
      setSelectedThreadId(null);
    } catch (error) {
      setActorActionError(error instanceof Error ? error.message : 'Unable to delete thread');
    }
  }

  async function handleVaultSubmit(passphrase: string): Promise<void> {
    setVaultSubmitting(true);
    setVaultError(null);

    try {
      if (!keyVaultOwner) {
        throw new Error('Masumi user identity is required before unlocking private keys.');
      }
      if (vaultInitialized) {
        await unlockKeyVault(keyVaultOwner, passphrase);
      } else {
        await initializeKeyVault(keyVaultOwner, passphrase);
        setVaultInitialized(true);
      }
      setVaultUnlocked(true);
      setSessionError(null);
    } catch (vaultUnlockError) {
      setVaultError(
        vaultUnlockError instanceof Error
          ? vaultUnlockError.message
          : 'Unable to unlock the local key vault'
      );
      throw vaultUnlockError instanceof Error
        ? vaultUnlockError
        : new Error('Unable to unlock the local key vault');
    } finally {
      setVaultSubmitting(false);
    }
  }

  const selectedThreadTitle = selectedThread
    ? threadSummary(selectedThread, selectedThreadParticipants, actorById)
    : 'Thread';
  const composerDisabledReason =
    !canWriteToActiveInbox
        ? writeAuthorizationError ?? 'Current session is read-only for this inbox.'
        : !vaultUnlocked
          ? describeLocalVaultRequirement({
              initialized: vaultInitialized,
              phrase: 'before sending messages',
            })
        : !actorKeysMatchPublished
          ? 'Current inbox keys are still loading or out of sync with published keys.'
    : !activeParticipant
            ? 'Current inbox is not an active participant in this thread.'
            : null;
  const showVaultLockedThreadGuard =
    sessionOwnsActiveInbox && !vaultLoading && !vaultUnlocked && !showVaultDialog;

  if (!activeActor && slugPresence === 'missing') {
    return (
      <section className="space-y-4 p-4 md:p-6">
          <ConnectionStatus
            connected={connected}
            errorMessage={conn.connectionError?.message ?? null}
            host={import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000'}
          />
        <Alert variant="destructive">
          <AlertTitle>Inbox not found</AlertTitle>
          <AlertDescription>
            No inbox slug matches <span className="font-mono">{params.slug}</span>.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  if (!activeActor && !coreLoading) {
    return (
      <section className="space-y-4 p-4 md:p-6">
          <ConnectionStatus
            connected={connected}
            errorMessage={conn.connectionError?.message ?? null}
            host={import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000'}
          />
        <Alert variant="destructive">
          <AlertTitle>Inbox state unavailable</AlertTitle>
          <AlertDescription>
            Live inbox identity sync did not resolve for{' '}
            <span className="font-mono">{params.slug}</span>
            {slugPresence === 'present'
              ? '. The slug exists, but the authenticated inbox state is still not visible in the live connection.'
              : slugProbeError
                ? ` ${slugProbeError}`
                : '.'}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const pendingIncomingContactRequestCount = incomingContactRequests.filter(
    request => request.status === 'pending'
  ).length;
  const pendingIncomingThreadInviteCount = incomingThreadInvites.filter(
    invite => invite.status === 'pending'
  ).length;
  const pendingIncomingCount =
    pendingIncomingContactRequestCount + pendingIncomingThreadInviteCount;
  const incomingApprovalCount = incomingContactRequests.length + incomingThreadInvites.length;
  const outgoingApprovalCount = outgoingContactRequests.length + outgoingThreadInvites.length;
  const shownLookupPanel = shouldShowLookupPanel;
  const lookupActorLabel = lookupTargetActor
    ? lookupTargetActor.displayName && lookupTargetActor.displayName !== lookupTargetActor.slug
      ? lookupTargetActor.displayName
      : lookupTargetActor.slug
    : search.lookup?.trim() ?? '';
  const showLookupActiveThreadsBadge =
    !!lookupTargetSummary &&
    lookupTargetSummary.activeThreads !== null &&
    lookupTargetSummary.activeThreads > 0 &&
    (lookupTargetSummary.dedicatedMemberCount === null || lookupTargetSummary.dedicatedMemberCount <= 0);
  const showLookupDedicatedMembersBadge =
    !!lookupTargetSummary &&
    lookupTargetSummary.dedicatedMemberCount !== null &&
    lookupTargetSummary.dedicatedMemberCount > 0;

  function clearLookupPanel() {
    void navigate({
      to: '/$slug',
      params: { slug: activeActor?.slug ?? params.slug },
      search: buildWorkspaceSearch({
        thread: search.thread,
        compose: search.compose,
        tab: search.tab,
        settings: search.settings,
      }),
        replace: true,
      });
  }

  function openLookupCompose() {
    if (!activeActor || !lookupTargetActor) {
      return;
    }

    void navigate({
      to: '/$slug',
      params: { slug: activeActor.slug },
      search: buildWorkspaceSearch({
        thread: search.thread,
        compose: 'add',
        lookup: lookupTargetActor.slug,
        tab: search.tab,
        settings: search.settings,
      }),
      replace: true,
    });
  }

  return (
      <InboxShell
        section="inbox"
        title="Inbox"
        sessionEmail={authenticatedSession?.user.email ?? ''}
        currentInboxSlug={activeActor?.slug ?? null}
        connected={connected}
        connectionError={conn.connectionError?.message ?? null}
        pendingApprovals={pendingIncomingCount}
        avatarName={activeActor?.displayName ?? activeActor?.slug ?? authenticatedSession?.user.email ?? undefined}
        avatarIdentity={activeActor?.publicIdentity ?? activeActor?.slug ?? authenticatedSession?.user.email ?? undefined}
      >
      {displayInbox ? (
        <KeysRecoveryDialog
          open={showKeysRecoveryDialog}
          onOpenChange={open => {
            if (deviceActionBusy) {
              return;
            }
            setShowKeysRecoveryDialog(open);
          }}
          mode="recovery"
          normalizedEmail={displayInbox.normalizedEmail}
          defaultKeyIssue={localKeyIssue}
          vaultUnlocked={vaultUnlocked}
          deviceShareBusy={deviceActionBusy}
          verifyingRequest={verifyingDeviceRequest}
          pendingDeviceRequest={
            pendingDeviceShareRequest
              ? {
                  deviceId: pendingDeviceShareRequest.device.deviceId,
                  verificationCode: pendingDeviceShareRequest.verificationCode,
                  verificationSymbols: pendingDeviceShareRequest.verificationSymbols,
                  verificationWords: pendingDeviceShareRequest.verificationWords,
                  expiresAt: pendingDeviceShareRequest.expiresAt,
                }
              : null
          }
          devices={ownedDevices}
          deviceVerificationCode={deviceVerificationCode}
          onDeviceVerificationCodeChange={setDeviceVerificationCode}
          onRequestKeys={handleRequestDeviceShare}
          onApproveCode={handleApproveDeviceShareByCode}
          onRevokeDevice={handleRevokeDevice}
          onImportSuccess={handleBackupImportSuccess}
          onOverrideKeys={handleOverrideKeys}
          errorMessage={actorActionError}
          autoGenerateCodeOnMissingKeys
        />
      ) : null}

      <RotationShareDialog
        open={showRotationSharePrompt}
        onOpenChange={open => {
          if (deviceActionBusy) {
            return;
          }
          setShowRotationSharePrompt(open);
        }}
        devices={approvedDevices}
        currentDeviceId={currentDeviceId}
        shareDeviceIds={rotationShareDeviceIds}
        revokeDeviceIds={rotationRevokeDeviceIds}
        busy={deviceActionBusy}
        onShareChange={handleRotationShareChange}
        onRevokeChange={handleRotationRevokeChange}
        onConfirm={() => performRotateKeys(rotationShareDeviceIds, rotationRevokeDeviceIds)}
      />

      {coreLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full rounded-md" />
          <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
            <Skeleton className="h-64 w-full rounded-md" />
            <Skeleton className="h-64 w-full rounded-md" />
          </div>
        </div>
      ) : null}

      {!coreLoading && secondaryLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-md" />
          <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
            <div className="space-y-3">
              <Skeleton className="h-16 w-full rounded-md" />
              <Skeleton className="h-16 w-full rounded-md" />
              <Skeleton className="h-16 w-full rounded-md" />
            </div>
            <Skeleton className="h-64 w-full rounded-md" />
          </div>
        </div>
      ) : null}

      {(sessionError || (!sessionError && liveTableError) || actorActionError || actorFeedback) ? (
        <div className="space-y-2">
          {sessionError ? (
            <Alert variant="destructive" onDismiss={() => setSessionError(null)}>
              <AlertDescription>{sessionError}</AlertDescription>
            </Alert>
          ) : null}
          {!sessionError && liveTableError ? (
            <Alert variant="destructive">
              <AlertDescription>{liveTableError}</AlertDescription>
            </Alert>
          ) : null}
          {actorActionError ? (
            <Alert variant="destructive" onDismiss={() => setActorActionError(null)}>
              <AlertDescription>{actorActionError}</AlertDescription>
            </Alert>
          ) : null}
          {actorFeedback ? (
            <Alert variant="info" onDismiss={() => setActorFeedback(null)}>
              <AlertDescription>{actorFeedback}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {shownLookupPanel ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">Agent Lookup</p>
                {lookupTargetLoading ? (
              <>
                <Skeleton className="mt-1 h-4 w-40" />
                <Skeleton className="mt-1 h-3 w-28" />
              </>
            ) : (
              <>
                <p className="truncate text-sm font-medium">
                  {lookupActorLabel}
                </p>
              </>
            )}
              </div>
              <Button variant="ghost" size="sm" onClick={clearLookupPanel}>
                <span className="text-xs">Close</span>
              </Button>
            </div>

            {lookupTargetError ? (
              <Alert variant="destructive">
                <AlertTitle>Lookup failed</AlertTitle>
                <AlertDescription>{lookupTargetError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {lookupTargetRouteLoading ? (
                  <Skeleton className="h-3 w-full max-w-[24ch]" />
                ) : (
                  lookupTargetRoute?.description ?? 'No public description available.'
                )}
              </p>
              {lookupTargetRoute?.linkedEmail ? (
                <p className="truncate text-xs text-muted-foreground">
                  Contact: {lookupTargetRoute.linkedEmail}
                </p>
              ) : null}
              {lookupTargetRouteError ? (
                <p className="text-xs text-destructive">{lookupTargetRouteError}</p>
              ) : null}
              <div className="flex flex-wrap gap-2 text-xs">
                {showLookupActiveThreadsBadge ? (
                  <Badge variant="secondary">
                    Active threads: {lookupTargetSummary?.activeThreads}
                  </Badge>
                ) : null}
                {showLookupDedicatedMembersBadge ? (
                  <Badge variant="secondary">
                    Dedicated members: {lookupTargetSummary?.dedicatedMemberCount}
                  </Badge>
                ) : null}
                {lookupTargetSummary && lookupTargetSummary.requestedThreads > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="secondary">
                        Open thread requests: {lookupTargetSummary.requestedThreads}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>Pending contact requests between these two agents</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">
                  Active threads: {lookupTargetSummary?.activeThreads ?? 'n/a'}
                </Badge>
                <Badge variant="secondary">
                  Dedicated members: {lookupTargetSummary?.dedicatedMemberCount ?? 'n/a'}
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary">
                      Open thread requests: {lookupTargetSummary?.requestedThreads ?? 'n/a'}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>Pending contact requests between these two agents</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                {lookupTargetError || lookupTargetLoading ? null : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={openLookupCompose}
                    disabled={!lookupTargetActor}
                  >
                Start thread
                  </Button>
                )}
              </div>
            </div>
            {lookupTargetSummary ? null : (
              <p className="text-xs text-muted-foreground">
                Active and requested thread counts are unavailable until both actors are visible in this session.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {sessionOwnsActiveInbox && !vaultLoading && !vaultUnlocked ? (
        <>
          <Alert>
            <AlertTitle>
              {vaultInitialized ? 'Private keys are locked' : 'Private key vault required'}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {vaultInitialized
                ? 'Unlock the local private key vault before decrypting messages, rotating keys, or sending updates from this inbox.'
                : 'Create a local private key vault before generating or storing inbox keys in this browser.'}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => setShowVaultDialog(true)}
                disabled={vaultSubmitting}
              >
                {vaultInitialized ? 'Unlock keys' : 'Create vault'}
              </Button>
            </AlertDescription>
          </Alert>
          <KeyVaultDialog
            open={showVaultDialog}
            onOpenChange={setShowVaultDialog}
            mode={vaultInitialized ? 'unlock' : 'setup'}
            busy={vaultSubmitting}
            error={vaultError}
            title={vaultInitialized ? 'Unlock Private Keys' : 'Create Private Key Vault'}
            description={
              vaultInitialized
                ? 'Enter your passphrase to unlock local private keys for decryption, key rotation, and sending.'
                : 'Create a passphrase to encrypt this browser’s private key vault before generating or importing inbox keys.'
            }
            submitLabel={vaultInitialized ? 'Unlock keys' : 'Create vault'}
            onSubmit={async passphrase => {
              await handleVaultSubmit(passphrase);
            }}
          />
        </>
      ) : null}

      {activeActor && writeAuthorizationError ? (
        <Alert variant="destructive">
          <AlertTitle>Read-only session</AlertTitle>
          <AlertDescription>{writeAuthorizationError}</AlertDescription>
        </Alert>
      ) : null}

      {activeActor && displayInbox ? (
        <Tabs
          value={activeWorkspaceTab}
          onValueChange={value => {
            if (value !== 'inbox' && value !== 'approvals' && value !== 'settings') {
              return;
            }

            void navigate({
              to: '/$slug',
              params: { slug: activeActor.slug },
              search: buildWorkspaceSearch({
                thread: search.thread,
                compose: search.compose,
                lookup: search.lookup,
                tab: value,
                settings: value === 'settings' ? 'advanced' : undefined,
              }),
              replace: true,
            });
          }}
          className="space-y-5"
        >
          <TabsList className="h-9 w-auto justify-start gap-0.5 rounded-lg bg-muted/50 p-0.5">
            <TabsTrigger
              value="inbox"
              className="rounded-md px-3.5 py-1.5 text-xs"
            >
              <ChatText className="h-3.5 w-3.5" />
              Messages
            </TabsTrigger>
            <TabsTrigger
              value="approvals"
              className="relative rounded-md px-3.5 py-1.5 text-xs"
            >
              <Shield className="h-3.5 w-3.5" />
              Approvals
              {pendingIncomingCount > 0 ? (
                <Badge className="ml-1.5 h-[18px] min-w-[18px] rounded-full bg-[hsl(var(--unread))] px-1.5 text-[10px] font-semibold leading-none text-white">
                  {pendingIncomingCount}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger
              value="settings"
              className="rounded-md px-3.5 py-1.5 text-xs"
            >
              <Gear className="h-3.5 w-3.5" />
              Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="inbox" className="mt-0">
            <>
              <InboxComposeDialog
                open={composeDialogOpen}
                onOpenChange={open => {
                  if (!open) {
                    closeComposeDialog();
                  }
                }}
                canWrite={canWriteToActiveInbox}
                vaultUnlocked={vaultUnlocked}
                connected={connected}
                composeLookupSlug={composeLookupSlug}
                onComposeLookupSlugChange={setComposeLookupSlug}
                onResolveComposeTargets={handleResolveComposeTargets}
                composeOptions={composeOptions}
                selectedComposeActorIds={composeSelectedActorIds}
                onToggleComposeActor={(actorId: string) => {
                  setComposeSelectedActorIds(current =>
                    current.includes(actorId)
                      ? current.filter(id => id !== actorId)
                      : [...current, actorId]
                  );
                }}
                composeThreadTitle={composeThreadTitle}
                onComposeThreadTitleChange={setComposeThreadTitle}
                composeThreadLocked={composeThreadLocked}
                onComposeThreadLockedChange={setComposeThreadLocked}
                composeFirstMessage={composeFirstMessage}
                onComposeFirstMessageChange={setComposeFirstMessage}
                onSubmitCompose={handleSubmitCompose}
              />

              <ParticipantsDialog
                open={showParticipantsDialog}
                onOpenChange={setShowParticipantsDialog}
                title={selectedThreadTitle}
                participants={selectedThreadParticipants}
                actorById={actorById}
                activeActorId={activeActor?.id ?? null}
                activeParticipantIsAdmin={activeParticipantIsAdmin}
                locked={selectedThread?.membershipLocked ?? false}
                canWriteToActiveInbox={canWriteToActiveInbox}
                pendingParticipantLookupSlug={pendingParticipantLookupSlug}
                onPendingParticipantLookupSlugChange={setPendingParticipantLookupSlug}
                onResolveAddParticipant={handleResolveAddParticipant}
                addParticipantOptions={addParticipantOptions}
                pendingParticipantId={pendingParticipantId}
                onPendingParticipantIdChange={setPendingParticipantId}
                onAddParticipant={handleAddParticipant}
                onRemoveParticipant={handleRemoveParticipant}
                onSetParticipantAdmin={handleSetParticipantAdmin}
              />

              <div className="grid gap-4 xl:min-h-[calc(100vh-13rem)] xl:grid-cols-[320px_minmax(0,1fr)]">
                <div className="flex min-h-0 flex-col gap-3">
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="brand"
                      type="button"
                      onClick={() => openComposeDialog()}
                    >
                      <Plus className="h-4 w-4" />
                      New thread
                    </Button>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="space-y-2 pb-3">
                      <Input
                        value={threadSearchQuery}
                        onChange={event => setThreadSearchQuery(event.target.value)}
                        placeholder="Search threads..."
                        className="h-9 text-sm"
                      />
                      <div className="flex flex-wrap gap-1.5">
                        {THREAD_RAIL_FILTER_OPTIONS.map(([value, label, Icon]) => (
                          <Button
                            key={value}
                            type="button"
                            size="xs"
                            variant={threadRailFilter === value ? 'secondary' : 'ghost'}
                            onClick={() => setThreadRailFilter(value)}
                          >
                            <Icon className="h-3.5 w-3.5" />
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div
                          className="min-h-0 flex-1 overflow-y-auto"
                          onScrollCapture={handleThreadRailScroll}
                        >
                          <div className="space-y-1">
                          {visibleThreads.length === 0 ? (
                            <EmptyState
                              icon={ChatText}
                              title="Your inbox is quiet"
                              description="Start a thread with another agent to begin messaging."
                            />
                          ) : filteredThreads.length === 0 ? (
                              <EmptyState
                                icon={MagnifyingGlass}
                                title="No threads match"
                                description="Try a different search or filter."
                              />
                          ) : (
                            paginatedThreads.map((thread) => {
                              const threadParticipantList = participantsByThreadId.get(thread.id) ?? [];
                              const unreadCount = unreadCountByThreadId.get(thread.id) ?? 0;
                              const archived =
                                readStateByThreadId.get(thread.id)?.archived ?? false;

                              const title = threadSummary(thread, threadParticipantList, actorById);
                              const participantsForRow = threadParticipantList
                                .map(participant => {
                                  const actor = actorById.get(participant.agentDbId);
                                  if (!actor) return null;
                                  return {
                                    name: actor.displayName?.trim() || actor.slug,
                                    identity: actor.publicIdentity,
                                  };
                                })
                                .filter((entry): entry is { name: string; identity: string } => entry !== null);

                              return (
                                <ThreadListItem
                                  key={thread.id.toString()}
                                  title={title}
                                  participants={participantsForRow}
                                  preview={null}
                                  unreadCount={unreadCount}
                                  locked={thread.membershipLocked}
                                  archived={archived}
                                  active={selectedThreadId === thread.id}
                                  onSelect={() => {
                                    setSelectedThreadId(thread.id);
                                    void navigate({
                                      to: '/$slug',
                                      params: { slug: activeActor.slug },
                                      search: buildWorkspaceSearch({
                                        thread: thread.id.toString(),
                                        compose: search.compose ?? undefined,
                                        lookup: undefined,
                                      }),
                                      replace: true,
                                    });
                                  }}
                                />
                              );
                            })
                          )}
                        </div>
                      </div>
                      <div className="py-2 text-center">
                        <p className="text-[11px] text-muted-foreground">
                          {filteredThreads.length === 0
                            ? 'No threads'
                            : `${visibleThreadRailPageStart + 1}\u2013${visibleThreadRailPageEnd} of ${filteredThreads.length}`}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/40 xl:h-[calc(100vh-13rem)]">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/30 px-4 py-3 md:px-5">
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-semibold">
                        {selectedThreadTitle}
                      </p>
                      {selectedThread ? (
                        <p className="text-xs text-muted-foreground">
                          {selectedThreadParticipants.length} participant{selectedThreadParticipants.length === 1 ? '' : 's'}
                          {selectedThread.membershipLocked ? ' · locked' : ''}
                        </p>
                      ) : null}
                    </div>
                    {selectedThread ? (
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setShowParticipantsDialog(true)}
                        >
                          <Users className="h-3.5 w-3.5" />
                          Participants
                        </Button>
                        {activeParticipantIsAdmin ? <Badge variant="secondary" className="text-[10px]">admin</Badge> : null}
                        <Button
                          size="xs"
                          variant="ghost"
                          className="w-7 p-0"
                          aria-label="Mark all as read"
                          onClick={() => void handleMarkRead()}
                        >
                          <Checks className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="w-7 p-0"
                          aria-label="Toggle archive"
                          onClick={() => void handleToggleArchived()}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                        {activeParticipantIsAdmin ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="w-7 p-0 text-destructive hover:text-destructive"
                            aria-label="Delete thread"
                            onClick={() => void handleDeleteThread()}
                          >
                            <Trash className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-5">
                    {!selectedThread ? (
                      <EmptyState
                        icon={ChatText}
                        title="Pick a thread to view"
                        description="Choose a conversation from the list on the left."
                      />
                    ) : (
                      <>
                        {composerDisabledReason && !showVaultLockedThreadGuard ? (
                          <Alert>
                            <AlertDescription>{composerDisabledReason}</AlertDescription>
                          </Alert>
                        ) : null}
                        {!composerDisabledReason && (rotateSecret || requiresSecretRotation) ? (
                          <Alert>
                            <AlertDescription>
                              Next message will rotate sender secret for current members.
                            </AlertDescription>
                          </Alert>
                        ) : null}

                        {showVaultLockedThreadGuard ? (
                          <div className="flex min-h-0 flex-1 items-center">
                            <Alert>
                              <AlertTitle>
                                {vaultInitialized ? 'Private keys are locked' : 'Private key vault required'}
                              </AlertTitle>
                              <AlertDescription className="space-y-3">
                                <p>
                                  {vaultInitialized
                                    ? 'Unlock vault to view thread messages and send replies from this inbox.'
                                    : 'Create vault to view thread messages and send replies from this inbox.'}
                                </p>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => setShowVaultDialog(true)}
                                  disabled={vaultSubmitting}
                                >
                                  {vaultInitialized ? 'Open unlock vault' : 'Create vault now'}
                                </Button>
                              </AlertDescription>
                            </Alert>
                          </div>
                        ) : (
                          <>
                            <div
                              ref={threadTimelineScrollRef}
                              className="min-h-0 flex-1 overflow-y-auto px-1 pr-2"
                              onScrollCapture={handleThreadTimelineScroll}
                            >
                              <div>
                                {paginatedThreadTimeline.length === 0 ? (
                                  <EmptyState
                                    icon={ChatText}
                                    title="No messages yet"
                                    description="Say hello to kick things off."
                                    hint="Messages are end-to-end encrypted — only you and the recipient can read them."
                                  />
                                ) : (() => {
                                  const timelineMeta = paginatedThreadTimeline.map((item) => {
                                    if (item.kind === 'keyRotation') {
                                      return {
                                        senderId: `krot:${item.notice.bundle.id.toString()}`,
                                        createdAtMs: Number(
                                          item.notice.bundle.createdAt.microsSinceUnixEpoch / 1000n
                                        ),
                                      };
                                    }
                                    return {
                                      senderId: item.message.senderAgentDbId.toString(),
                                      createdAtMs: Number(
                                        item.message.createdAt.microsSinceUnixEpoch / 1000n
                                      ),
                                    };
                                  });
                                  const groupedFlags = computeGroupedFlags(timelineMeta);
                                  const dayBoundaries = computeDayBoundaries(timelineMeta);
                                  return paginatedThreadTimeline.map((item, index) => {
                                    const showDayDivider = dayBoundaries[index];
                                    const dayLabel = showDayDivider
                                      ? formatDayLabel(timelineMeta[index]!.createdAtMs)
                                      : null;
                                    if (item.kind === 'keyRotation') {
                                      return (
                                        <div key={`kr-${item.notice.bundle.id.toString()}`}>
                                          {dayLabel ? <DayDivider label={dayLabel} /> : null}
                                          <div
                                            style={staggeredDelay(index, 24)}
                                            className="animate-soft-enter"
                                          >
                                            <KeyRotationItem
                                              actorName={describeActor(item.notice.actor)}
                                              timestamp={formatTimestamp(item.notice.bundle.createdAt)}
                                            />
                                          </div>
                                        </div>
                                      );
                                    }
                                    const { message } = item;
                                    const sender = actorById.get(message.senderAgentDbId);
                                    const senderName = sender
                                      ? sender.displayName?.trim() || sender.slug
                                      : `Actor ${message.senderAgentDbId.toString()}`;
                                    return (
                                      <div key={message.id.toString()}>
                                        {dayLabel ? <DayDivider label={dayLabel} /> : null}
                                        <MessageItem
                                          senderName={senderName}
                                          senderIdentity={
                                            sender?.publicIdentity ??
                                            message.senderAgentDbId.toString()
                                          }
                                          timestamp={formatTimestamp(message.createdAt)}
                                          messageState={decryptedMessageById[message.id.toString()]}
                                          isOwnMessage={Boolean(
                                            activeActor && message.senderAgentDbId === activeActor.id
                                          )}
                                          groupedWithPrevious={groupedFlags[index]}
                                          onRevealUnsupported={() =>
                                            handleRevealUnsupportedMessage(message.id)
                                          }
                                          className="animate-soft-enter"
                                        />
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            </div>
                            <MessageComposer
                              value={composerInput}
                              onChange={setComposerInput}
                              onKeyDown={handleComposerKeyDown}
                              onSubmit={handleSendMessage}
                              maxLength={MAX_MESSAGE_BODY_CHARS}
                              disabled={Boolean(composerDisabledReason)}
                            />
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          </TabsContent>

          <TabsContent value="approvals" className="mt-0">
            <div className="space-y-5">
              <section className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1">
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" /> Incoming
                  </p>
                  <p className="text-xl font-semibold">
                    {incomingApprovalCount.toString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {pendingIncomingCount.toString()} pending
                  </p>
                </div>
                <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1">
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                    <PaperPlaneTilt className="h-3.5 w-3.5" /> Outgoing
                  </p>
                  <p className="text-xl font-semibold">
                    {outgoingApprovalCount.toString()}
                  </p>
                  <p className="text-xs text-muted-foreground">Awaiting response</p>
                </div>
                <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1">
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                    <Shield className="h-3.5 w-3.5" /> Allowlist
                  </p>
                  <p className="text-xl font-semibold">
                    {inboxAllowlistEntries.length.toString()}
                  </p>
                  <p className="text-xs text-muted-foreground">Bypass approvals</p>
                </div>
              </section>

              <section className="space-y-3">
                <div>
                  <h2 className="text-sm font-medium">Incoming contact requests</h2>
                  <p className="text-xs text-muted-foreground">/{activeActor.slug}</p>
                </div>
                {incomingContactRequests.length === 0 ? (
                  <EmptyState
                    icon={Shield}
                    title="No incoming requests"
                    description="When other agents request contact, they appear here."
                  />
                ) : (
                    <div className="space-y-2">
                      {incomingContactRequests.map((request, index) => (
                        <div
                          key={request.id.toString()}
                          style={staggeredDelay(index, 12)}
                          className="animate-soft-subtle flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                        >
                        <div className="min-w-0">
                          <p className="truncate text-sm">{request.requesterSlug}</p>
                          <p className="text-xs text-muted-foreground">
                            {request.status === 'pending' ? 'Waiting for approval' : request.status}
                          </p>
                        </div>
                        {request.status === 'pending' ? (
                          <div className="flex gap-2">
                            <Button
                              size="xs"
                              onClick={() => void handleApproveContactRequest(request.id)}
                              disabled={approvalActionRequestId !== null}
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                              Approve
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => void handleRejectContactRequest(request.id)}
                              disabled={approvalActionRequestId !== null}
                            >
                              <ShieldSlash className="h-3.5 w-3.5" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">{request.status}</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <Separator />

              <section className="space-y-3">
                <div>
                  <h2 className="text-sm font-medium">Incoming group invites</h2>
                  <p className="text-xs text-muted-foreground">/{activeActor.slug}</p>
                </div>
                {incomingThreadInvites.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="No group invites"
                    description="Group thread invites that need approval appear here."
                  />
                ) : (
                  <div className="space-y-2">
                    {incomingThreadInvites.map((invite, index) => (
                      <div
                        key={invite.id.toString()}
                        style={staggeredDelay(index, 12)}
                        className="animate-soft-subtle flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">
                            {invite.threadTitle ?? `Thread #${invite.threadId.toString()}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Invited by {invite.inviterDisplayName ?? invite.inviterSlug}
                          </p>
                        </div>
                        {invite.status === 'pending' ? (
                          <div className="flex gap-2">
                            <Button
                              size="xs"
                              onClick={() => void handleAcceptThreadInvite(invite.id)}
                              disabled={approvalActionRequestId !== null}
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                              Accept
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => void handleRejectThreadInvite(invite.id)}
                              disabled={approvalActionRequestId !== null}
                            >
                              <ShieldSlash className="h-3.5 w-3.5" />
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            {invite.status}
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <Separator />

              <section className="space-y-3">
                <h2 className="text-sm font-medium">Outgoing contact requests</h2>
                {outgoingContactRequests.length === 0 ? (
                  <EmptyState
                    icon={Shield}
                    title="No outgoing requests"
                    description="Requests you sent to other agents appear here."
                  />
                ) : (
                    <div className="space-y-2">
                      {outgoingContactRequests.map((request, index) => (
                        <div
                          key={request.id.toString()}
                          style={staggeredDelay(index, 12)}
                          className="animate-soft-subtle flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                        >
                        <div className="min-w-0">
                          <p className="truncate text-sm">{request.targetSlug}</p>
                          <p className="text-xs text-muted-foreground">{request.status}</p>
                        </div>
                        <Badge variant="secondary" className="text-[10px]">{request.status}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <Separator />

              <section className="space-y-3">
                <h2 className="text-sm font-medium">Outgoing group invites</h2>
                {outgoingThreadInvites.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="No outgoing group invites"
                    description="Group invites you sent to other agents appear here."
                  />
                ) : (
                  <div className="space-y-2">
                    {outgoingThreadInvites.map((invite, index) => (
                      <div
                        key={invite.id.toString()}
                        style={staggeredDelay(index, 12)}
                        className="animate-soft-subtle flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">
                            {invite.inviteeDisplayName ?? invite.inviteeSlug}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {invite.threadTitle ?? `Thread #${invite.threadId.toString()}`}
                          </p>
                        </div>
                        <Badge variant="secondary" className="text-[10px]">
                          {invite.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <Separator />

              <section className="space-y-3">
                <h2 className="text-sm font-medium">Allowlist</h2>
                <div className="grid gap-2 lg:grid-cols-2">
                  <div className="flex gap-2">
                    <Input
                      value={allowlistAgentInput}
                      onChange={e => setAllowlistAgentInput(e.target.value)}
                      placeholder="Agent slug"
                      className="h-8 text-sm"
                      disabled={!canWriteToActiveInbox || allowlistBusy}
                    />
                    <Button
                      size="sm"
                      className="h-8 px-3"
                      variant="secondary"
                      onClick={() => void handleAddAllowlistAgent()}
                      disabled={
                        !canWriteToActiveInbox ||
                        allowlistBusy ||
                        !allowlistAgentInput.trim()
                      }
                    >
                      Add
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={allowlistEmailInput}
                      onChange={e => setAllowlistEmailInput(e.target.value)}
                      placeholder="Email"
                      className="h-8 text-sm"
                      disabled={!canWriteToActiveInbox || allowlistBusy}
                    />
                    <Button
                      size="sm"
                      className="h-8 px-3"
                      variant="secondary"
                      onClick={() => void handleAddAllowlistEmail()}
                      disabled={
                        !canWriteToActiveInbox ||
                        allowlistBusy ||
                        !allowlistEmailInput.trim()
                      }
                    >
                      Add
                    </Button>
                  </div>
                </div>
                {inboxAllowlistEntries.length > 0 ? (
                    <div className="space-y-1.5">
                      {inboxAllowlistEntries.map((entry, index) => (
                        <div
                          key={entry.id.toString()}
                          style={staggeredDelay(index, 12)}
                          className="animate-soft-subtle flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                        >
                        <p className="truncate text-xs">
                          {entry.agentPublicIdentity ??
                            entry.displayEmail ??
                            entry.normalizedEmail ??
                            `Entry #${entry.id.toString()}`}
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 px-0"
                          onClick={() => void handleRemoveAllowlistEntry(entry.id)}
                          disabled={allowlistBusy}
                          aria-label={`Remove ${entry.agentPublicIdentity ?? entry.normalizedEmail ?? entry.id.toString()}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          </TabsContent>

          <TabsContent value="settings" className="mt-0">
            <section className="space-y-4">
              <h2 className="text-sm font-medium">Create inbox alias</h2>
              <form className="space-y-2" onSubmit={handleCreateInboxIdentity}>
                <Input
                  value={newInboxSlug}
                  onChange={e => setNewInboxSlug(e.target.value)}
                  placeholder="New slug"
                  className="h-8 text-sm"
                  disabled={!canWriteToActiveInbox || !vaultUnlocked}
                />
                <Input
                  value={newInboxDisplayName}
                  onChange={e => setNewInboxDisplayName(e.target.value)}
                  placeholder="Display name (optional)"
                  className="h-8 text-sm"
                  disabled={!canWriteToActiveInbox || !vaultUnlocked}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  className="h-7 w-full text-xs md:w-auto"
                  disabled={
                    !canWriteToActiveInbox ||
                    !vaultUnlocked ||
                    !newInboxSlug.trim()
                  }
                >
                  <Plus className="h-3.5 w-3.5" /> Create alias
                </Button>
              </form>
            </section>
          </TabsContent>
        </Tabs>
      ) : null}
    </InboxShell>
  );
}
