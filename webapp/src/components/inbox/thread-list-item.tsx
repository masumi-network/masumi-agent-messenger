import { Archive, Lock } from '@phosphor-icons/react';
import { AgentAvatar, AgentAvatarStack, AGENT_ACCENT, getAgentColorIndex } from './agent-avatar';
import { cn } from '@/lib/utils';

export type ThreadListItemParticipant = {
  name: string;
  identity: string;
};

export function ThreadListItem({
  title,
  participants,
  preview,
  timestamp,
  unreadCount = 0,
  locked = false,
  archived = false,
  active = false,
  onSelect,
  className,
}: {
  title: string;
  participants: ThreadListItemParticipant[];
  preview?: string | null;
  timestamp?: string | null;
  unreadCount?: number;
  locked?: boolean;
  archived?: boolean;
  active?: boolean;
  onSelect: () => void;
  className?: string;
}) {
  const accentKey = participants[0]?.identity ?? title;
  const accent = AGENT_ACCENT[getAgentColorIndex(accentKey) % AGENT_ACCENT.length];
  const hasUnread = unreadCount > 0;
  const cleanedPreview = preview
    ? preview.replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-start gap-3 rounded-md border-l-2 border-l-transparent px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active
          ? cn('bg-muted text-foreground', accent.bar)
          : cn('hover:bg-muted/50', accent.tint),
        className
      )}
    >
      <div className="shrink-0 pt-0.5">
        {participants.length > 1 ? (
          <AgentAvatarStack agents={participants.slice(0, 3)} size="sm" max={3} />
        ) : participants[0] ? (
          <AgentAvatar
            name={participants[0].name}
            identity={participants[0].identity}
            size="md"
          />
        ) : (
          <AgentAvatar name={title} identity={title} size="md" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 truncate text-sm leading-snug',
              hasUnread ? 'font-semibold text-foreground' : 'font-medium'
            )}
          >
            {title}
          </p>
          {timestamp ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {timestamp}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 truncate text-xs leading-snug',
              hasUnread ? 'text-foreground/80' : 'text-muted-foreground'
            )}
          >
            {cleanedPreview || (
              <span className="italic text-muted-foreground/70">
                {participants.length} participant{participants.length === 1 ? '' : 's'}
              </span>
            )}
          </p>
          {locked ? (
            <Lock
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-label="Locked"
            />
          ) : null}
          {archived ? (
            <Archive
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-label="Archived"
            />
          ) : null}
          {hasUnread ? (
            <span
              className="ml-0.5 inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[hsl(var(--unread))] px-1.5 text-[11px] font-semibold leading-none text-white"
              aria-label={`${unreadCount} unread`}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
