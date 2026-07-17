import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ChatText,
  Hash,
  List,
  MagnifyingGlass,
  Moon,
  Plus,
  Sun,
  Users,
  CaretLineLeft,
  CaretLineRight,
  CaretDown,
  CaretUp,
  DotsThree,
  GearSix,
} from '@phosphor-icons/react';
import { AccountMenu } from '@/components/app/account-menu';
import {
  ActiveAgentSelector,
  type ActiveAgentOption,
} from '@/components/app/active-agent-selector';
import { ConnectionStatus } from '@/components/thread/connection-status';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  buildWorkspaceSearch,
  type AppShellSection,
  type ChannelNavEntry,
} from '@/lib/app-shell';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

type InboxShellProps = {
  section: AppShellSection;
  title?: string;
  sessionEmail: string;
  currentInboxSlug?: string | null;
  connected?: boolean;
  connectionError?: string | null;
  pendingApprovals?: number;
  channelNavEntries?: ChannelNavEntry[];
  selectedChannelSlug?: string | null;
  avatarName?: string;
  avatarIdentity?: string;
  ownedAgents?: ActiveAgentOption[];
  onSelectAgent: (slug: string) => void;
  children: React.ReactNode;
};

type NavItem = {
  key: string;
  label: string;
  active: boolean;
  Icon?: React.ComponentType<{ className?: string }>;
  count?: number;
  onSelect: () => void;
};

const CHANNEL_PREVIEW_COUNT = 4;

function getChannelPreview(
  entries: ChannelNavEntry[],
  selectedSlug: string | null
): ChannelNavEntry[] {
  const preview = entries.slice(0, CHANNEL_PREVIEW_COUNT);
  const selected = selectedSlug
    ? entries.find(entry => entry.slug === selectedSlug)
    : null;

  if (
    !selected ||
    preview.some(entry => entry.channelId === selected.channelId)
  ) {
    return preview;
  }

  return [...entries.slice(0, CHANNEL_PREVIEW_COUNT - 1), selected];
}

function describeChannelPermission(entry: ChannelNavEntry): string {
  if (entry.isAdmin) return 'Admin';
  if (entry.permission.tag === 'ReadWrite') return 'Can post';
  if (entry.permission.tag === 'Read') return 'Read only';
  return 'Joined';
}

export function InboxShell({
  section,
  title,
  sessionEmail,
  currentInboxSlug,
  connected = false,
  connectionError = null,
  pendingApprovals = 0,
  channelNavEntries = [],
  selectedChannelSlug = null,
  avatarName,
  avatarIdentity,
  ownedAgents = [],
  onSelectAgent,
  children,
}: InboxShellProps) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [channelsExpanded, setChannelsExpanded] = useState(false);
  const channelApprovalCount = useMemo(
    () =>
      channelNavEntries.reduce(
        (total, entry) => total + entry.pendingApprovals,
        0
      ),
    [channelNavEntries]
  );
  const channelPreview = getChannelPreview(
    channelNavEntries,
    selectedChannelSlug
  );
  const renderExpandedChannelList =
    channelsExpanded && (sidebarExpanded || mobileOpen);
  const visibleChannelEntries = renderExpandedChannelList
    ? channelNavEntries
    : channelPreview;
  const channelListHasOverflow =
    channelNavEntries.length > CHANNEL_PREVIEW_COUNT;

  function handleSelectAgent(slug: string) {
    if (slug === currentInboxSlug) {
      return;
    }

    setMobileOpen(false);
    onSelectAgent(slug);
  }

  function handleManageAgents() {
    setMobileOpen(false);
    void navigate({
      to: '/agents',
      search: {
        agent: currentInboxSlug ?? undefined,
      },
    });
  }

  const navItems = useMemo<NavItem[]>(
    () => [
      {
        key: 'inbox',
        label: 'Inbox',
        Icon: ChatText,
        active: section === 'inbox',
        count: pendingApprovals,
        onSelect: () => {
          if (!currentInboxSlug) {
            void navigate({
              to: '/',
            });
            return;
          }

          void navigate({
            to: '/$slug',
            params: { slug: currentInboxSlug },
            search: buildWorkspaceSearch({}),
          });
        },
      },
      {
        key: 'channels',
        label: 'Channels',
        Icon: Hash,
        active: section === 'channels',
        count: channelApprovalCount,
        onSelect: () => {
          void navigate({
            to: '/channels',
            search: {
              agent: currentInboxSlug ?? undefined,
              tab: 'public',
            },
          });
        },
      },
      {
        key: 'discover',
        label: 'Discover agents',
        Icon: MagnifyingGlass,
        active: section === 'discover',
        onSelect: () => {
          void navigate({
            to: '/discover',
            search: {
              agent: currentInboxSlug ?? undefined,
            },
          });
        },
      },
    ],
    [channelApprovalCount, currentInboxSlug, navigate, pendingApprovals, section]
  );
  const utilityNavItems = useMemo<NavItem[]>(
    () => [
      {
        key: 'agents',
        label: 'My agents',
        Icon: Users,
        active: section === 'agents',
        onSelect: () => {
          void navigate({
            to: '/agents',
            search: {
              agent: currentInboxSlug ?? undefined,
            },
          });
        },
      },
      {
        key: 'security',
        label: 'Security settings',
        Icon: GearSix,
        active: section === 'security',
        onSelect: () => {
          void navigate({
            to: '/security',
            search: {
              agent: currentInboxSlug ?? undefined,
              panel: undefined,
            },
          });
        },
      },
    ],
    [currentInboxSlug, navigate, section]
  );

  const shellTitle =
    title ??
    (section === 'inbox'
      ? 'Inbox'
      : section === 'discover'
        ? 'Discover agents'
        : section === 'channels'
          ? 'Channels'
          : section === 'agents'
            ? 'My agents'
            : 'Security');

  /* ── Expanded sidebar content (desktop + mobile drawer) ── */
  const expandedNav = (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-3 pt-4">
        <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/70 lg:text-[10px]">
          Workspace agent
        </p>
        <div className="mt-2">
          <ActiveAgentSelector
            activeSlug={currentInboxSlug ?? null}
            agents={ownedAgents}
            onSelect={handleSelectAgent}
            onManageAgents={handleManageAgents}
          />
        </div>
      </div>

      <nav className="space-y-0.5 px-2">
        {navItems.map((item) => (
          <button
            type="button"
            key={item.key}
            className={cn(
              'group relative flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-9',
              item.active
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
            onClick={() => {
              item.onSelect();
              setMobileOpen(false);
            }}
          >
            {item.active ? (
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
              />
            ) : null}
            {item.Icon ? (
              <item.Icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  item.active
                    ? 'text-primary'
                    : 'text-muted-foreground group-hover:text-foreground'
                )}
              />
            ) : null}
            <span className="animate-soft-fade">{item.label}</span>
            {item.count && item.count > 0 ? (
              <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-sm font-semibold text-primary-foreground lg:text-[10px]">
                {item.count}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="mt-5 flex min-h-0 flex-1 flex-col px-2">
        <div className="mb-2 flex items-start justify-between gap-2 px-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/70 lg:text-[10px]">
              Channels
            </p>
            {channelNavEntries.length > 0 ? (
              <p className="mt-0.5 truncate text-sm text-muted-foreground lg:text-[11px]">
                {channelNavEntries.length} joined
                {currentInboxSlug ? ` by /${currentInboxSlug}` : ''}
              </p>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Add channel"
                className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-6 lg:w-6"
                onClick={() => {
                  void navigate({
                    to: '/channels',
                    search: {
                      agent: currentInboxSlug ?? undefined,
                      tab: 'mine',
                    },
                  });
                  setMobileOpen(false);
                }}
              >
                <Plus className="size-3.5 shrink-0" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Add channel
            </TooltipContent>
          </Tooltip>
        </div>

        {channelNavEntries.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            No joined channels
          </p>
        ) : (
          <div
            className={cn(
              'space-y-0.5',
              channelsExpanded &&
                'min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1'
            )}
          >
            {visibleChannelEntries.map(entry => {
              const active = selectedChannelSlug === entry.slug;
              const subtitle =
                entry.description?.trim() || `#${entry.slug}`;
              const permissionLabel = describeChannelPermission(entry);
              return (
                <button
                  type="button"
                  key={entry.channelId.toString()}
                  className={cn(
                    'group relative flex min-h-14 w-full min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  onClick={() => {
                    void navigate({
                      to: '/channels/$slug',
                      params: { slug: entry.slug },
                      search: {
                        agent: currentInboxSlug ?? undefined,
                      },
                    });
                    setMobileOpen(false);
                  }}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/70 transition-colors',
                      active
                        ? 'text-primary ring-1 ring-primary/15'
                        : 'text-muted-foreground/70 group-hover:text-foreground'
                    )}
                    aria-hidden
                  >
                    <Hash
                      className="block size-4 shrink-0"
                      weight={active ? 'bold' : 'regular'}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {entry.title?.trim() || entry.slug}
                    </span>
                    <span className="mt-0.5 block truncate text-sm leading-snug text-muted-foreground lg:text-xs">
                      {subtitle} · {permissionLabel}
                    </span>
                  </span>
                  {entry.pendingApprovals > 0 ? (
                    <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-sm font-semibold leading-none text-primary-foreground lg:text-[10px]">
                      {entry.pendingApprovals}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        {channelListHasOverflow ? (
          <button
            type="button"
            aria-expanded={channelsExpanded}
            className="mt-1 flex h-11 shrink-0 items-center justify-between rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8 lg:text-xs"
            onClick={() => setChannelsExpanded(expanded => !expanded)}
          >
            <span>
              {channelsExpanded
                ? 'Show fewer'
                : `Show all ${channelNavEntries.length} channels`}
            </span>
            {channelsExpanded ? (
              <CaretUp className="size-3.5 shrink-0" weight="bold" />
            ) : (
              <CaretDown className="size-3.5 shrink-0" weight="bold" />
            )}
          </button>
        ) : null}
      </div>

      <div className="mt-auto shrink-0 border-t border-border/60 px-2 pb-2 pt-2">
        <nav aria-label="Account navigation" className="space-y-0.5">
          {utilityNavItems.map(item => (
            <button
              type="button"
              key={item.key}
              className={cn(
                'group relative flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-9',
                item.active
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
              onClick={() => {
                item.onSelect();
                setMobileOpen(false);
              }}
            >
              {item.active ? (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
                />
              ) : null}
              {item.Icon ? (
                <item.Icon
                  aria-hidden
                  className={cn(
                    'size-4 shrink-0 transition-colors',
                    item.active
                      ? 'text-primary'
                      : 'text-muted-foreground group-hover:text-foreground'
                  )}
                />
              ) : null}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="mt-1.5 border-t border-border/50 pt-1.5">
          <AccountMenu
            email={sessionEmail}
            avatarName={avatarName}
            avatarIdentity={avatarIdentity}
            activeAgentSlug={currentInboxSlug ?? undefined}
            agentCount={ownedAgents.length}
          />
        </div>
      </div>
    </div>
  );

  /* ── Collapsed sidebar rail (icons only) ── */
  const collapsedNav = (
    <div className="flex h-full flex-col items-center py-4">
      <ActiveAgentSelector
        activeSlug={currentInboxSlug ?? null}
        agents={ownedAgents}
        variant="rail"
        onSelect={handleSelectAgent}
        onManageAgents={handleManageAgents}
      />
      <div className="my-3 h-px w-6 bg-border/70" />
      <nav className="space-y-1.5">
        {navItems.map((item) => (
          <Tooltip key={item.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={item.label}
                className={cn(
                  'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  item.active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
                onClick={() => item.onSelect()}
              >
                {item.active ? (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
                  />
                ) : null}
                {item.Icon ? <item.Icon className="h-4 w-4" /> : null}
                {item.count && item.count > 0 ? (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background" />
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {item.label}
            </TooltipContent>
          </Tooltip>
        ))}
      </nav>

      <div className="mt-3 space-y-1.5">
        <div className="mx-auto h-px w-6 bg-border/70" />
        {channelPreview.map(entry => {
          const active = selectedChannelSlug === entry.slug;
          const label = entry.title?.trim() || entry.slug;
          return (
            <Tooltip key={entry.channelId.toString()}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Open #${entry.slug}`}
                  className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  onClick={() => {
                    void navigate({
                      to: '/channels/$slug',
                      params: { slug: entry.slug },
                      search: {
                        agent: currentInboxSlug ?? undefined,
                      },
                    });
                  }}
                >
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
                    />
                  ) : null}
                  <Hash className="h-4 w-4" />
                  {entry.pendingApprovals > 0 ? (
                    <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background" />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {label}
                {entry.pendingApprovals > 0
                  ? `, ${entry.pendingApprovals} pending`
                  : ''}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {channelListHasOverflow ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Show all ${channelNavEntries.length} channels`}
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setSidebarExpanded(true);
                  setChannelsExpanded(true);
                }}
              >
                <DotsThree className="size-4 shrink-0" weight="bold" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Show all {channelNavEntries.length} channels
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Add channel"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                void navigate({
                  to: '/channels',
                  search: {
                    agent: currentInboxSlug ?? undefined,
                    tab: 'mine',
                  },
                });
              }}
            >
              <Plus className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Add channel
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-auto flex flex-col items-center gap-1.5 pb-2">
        <div className="mb-1 h-px w-6 bg-border/70" />
        {utilityNavItems.map(item => (
          <Tooltip key={item.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={item.label}
                className={cn(
                  'relative flex size-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  item.active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
                onClick={() => item.onSelect()}
              >
                {item.active ? (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
                  />
                ) : null}
                {item.Icon ? <item.Icon aria-hidden className="size-4" /> : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {item.label}
            </TooltipContent>
          </Tooltip>
        ))}
        <div className="my-1 h-px w-6 bg-border/70" />
        <AccountMenu
          email={sessionEmail}
          avatarName={avatarName}
          avatarIdentity={avatarIdentity}
          activeAgentSlug={currentInboxSlug ?? undefined}
          agentCount={ownedAgents.length}
          iconOnly
        />
      </div>
    </div>
  );

  return (
    <div className="h-screen overflow-hidden bg-background">
      <div className="flex h-screen">
        {/* Desktop sidebar */}
        <aside
          className={cn(
            'hidden h-screen shrink-0 overflow-hidden border-r border-border/50 bg-background lg:block',
            sidebarExpanded ? 'w-[252px]' : 'w-[52px]'
          )}
        >
          <div className="flex h-full flex-col">
            <button
              type="button"
              onClick={() => setSidebarExpanded(!sidebarExpanded)}
              aria-label={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
              className={cn(
                'flex h-12 shrink-0 items-center border-b border-border/40 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                sidebarExpanded ? 'justify-end px-3' : 'justify-center'
              )}
            >
              {sidebarExpanded ? (
                <CaretLineLeft className="h-3.5 w-3.5" />
              ) : (
                <CaretLineRight className="h-3.5 w-3.5" />
              )}
            </button>
            {sidebarExpanded ? expandedNav : collapsedNav}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-border/50 bg-background/95">
            <div className="flex min-h-14 items-center gap-3 px-4 py-3 md:px-6">
              <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-11 w-11 rounded-md p-0 lg:hidden"
                  >
                    <List className="h-4 w-4" />
                    <span className="sr-only">Open navigation</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="left-0 top-0 h-screen w-[86vw] max-w-[280px] translate-x-0 translate-y-0 overflow-hidden rounded-none border-r border-border/50 bg-background p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left">
                  <DialogTitle className="sr-only">Navigation</DialogTitle>
                  {expandedNav}
                </DialogContent>
              </Dialog>

              <div className="min-w-0 flex-1">
                <h1
                  key={shellTitle}
                  className="animate-soft-fade truncate text-base font-semibold tracking-tight"
                >
                  {shellTitle}
                </h1>
              </div>
              <div className="lg:hidden">
                <ActiveAgentSelector
                  activeSlug={currentInboxSlug ?? null}
                  agents={ownedAgents}
                  variant="header"
                  onSelect={handleSelectAgent}
                  onManageAgents={handleManageAgents}
                />
              </div>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8 lg:w-8"
              >
                {theme === 'dark' ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="sr-only" role="status" aria-live="polite">
              {currentInboxSlug
                ? `Active workspace agent is ${currentInboxSlug}`
                : 'No active workspace agent selected'}
            </p>
          </header>

          <main className="animate-soft-enter flex-1 overflow-auto px-4 py-5 md:px-6 md:py-6">
            {children}
          </main>
        </div>
      </div>

      {/* Floating connection indicator */}
      <div className="fixed bottom-4 right-4 z-30">
        <ConnectionStatus
          connected={connected}
          compact
          errorMessage={connectionError}
          host={import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000'}
          className="h-2.5 w-2.5"
        />
      </div>
    </div>
  );
}
