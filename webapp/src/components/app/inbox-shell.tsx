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
} from '@phosphor-icons/react';
import { AccountMenu } from '@/components/app/account-menu';
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

type AgentOption = {
  id?: bigint;
  slug: string;
  displayName?: string | null;
  publicIdentity: string;
};

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
  ownedAgents?: AgentOption[];
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
  children,
}: InboxShellProps) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const channelApprovalCount = useMemo(
    () =>
      channelNavEntries.reduce(
        (total, entry) => total + entry.pendingApprovals,
        0
      ),
    [channelNavEntries]
  );

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
          });
        },
      },
      {
        key: 'agents',
        label: 'My agents',
        Icon: Users,
        active: section === 'agents',
        onSelect: () => {
          void navigate({
            to: '/agents',
          });
        },
      },
    ],
    [channelApprovalCount, currentInboxSlug, navigate, pendingApprovals, section]
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
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Workspace
        </p>
        <p className="mt-1 truncate font-mono text-sm font-medium text-foreground/90">
          {currentInboxSlug ? `/${currentInboxSlug}` : 'No workspace'}
        </p>
      </div>

      <nav className="space-y-0.5 px-2">
        {navItems.map((item) => (
          <button
            type="button"
            key={item.key}
            className={cn(
              'group relative flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
              <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                {item.count}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Channels
          </p>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Add channel"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  void navigate({ to: '/channels' });
                  setMobileOpen(false);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Add channel
            </TooltipContent>
          </Tooltip>
        </div>

        {channelNavEntries.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No joined channels
          </p>
        ) : (
          <div className="space-y-0.5">
            {channelNavEntries.map(entry => {
              const active = selectedChannelSlug === entry.slug;
              return (
                <button
                  type="button"
                  key={entry.channelId.toString()}
                  className={cn(
                    'group relative flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  onClick={() => {
                    void navigate({
                      to: '/channels/$slug',
                      params: { slug: entry.slug },
                    });
                    setMobileOpen(false);
                  }}
                >
                  <Hash
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-colors',
                      active
                        ? 'text-primary'
                        : 'text-muted-foreground/70 group-hover:text-foreground'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {entry.title?.trim() || entry.slug}
                  </span>
                  {entry.pendingApprovals > 0 ? (
                    <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                      {entry.pendingApprovals}
                    </span>
                  ) : entry.isAdmin ? (
                    <span className="shrink-0 rounded-full border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      admin
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-auto p-2">
        <AccountMenu
          email={sessionEmail}
          avatarName={avatarName}
          avatarIdentity={avatarIdentity}
          currentInboxSlug={currentInboxSlug ?? undefined}
          ownedAgents={ownedAgents}
        />
      </div>
    </div>
  );

  /* ── Collapsed sidebar rail (icons only) ── */
  const collapsedNav = (
    <div className="flex h-full flex-col items-center py-4">
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
        {channelNavEntries.slice(0, 8).map(entry => {
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Add channel"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                void navigate({ to: '/channels' });
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

      <div className="mt-auto pb-2">
        <AccountMenu
          email={sessionEmail}
          avatarName={avatarName}
          avatarIdentity={avatarIdentity}
          currentInboxSlug={currentInboxSlug ?? undefined}
          ownedAgents={ownedAgents}
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
            'hidden h-screen shrink-0 overflow-hidden border-r border-border/50 bg-background transition-[width] duration-200 ease-in-out lg:block',
            sidebarExpanded ? 'w-[220px]' : 'w-[52px]'
          )}
        >
          <div className="flex h-full flex-col">
            <button
              type="button"
              onClick={() => setSidebarExpanded(!sidebarExpanded)}
              aria-label={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
              className={cn(
                'flex h-12 shrink-0 items-center border-b border-border/40 text-muted-foreground transition-colors hover:text-foreground',
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
          <header className="sticky top-0 z-20 border-b border-border/50 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
            <div className="flex min-h-14 items-center gap-3 px-4 py-3 md:px-6">
              <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-8 w-8 rounded-md p-0 lg:hidden"
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
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {theme === 'dark' ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </button>
            </div>
          </header>

          <main key={section} className="animate-soft-enter flex-1 overflow-auto px-4 py-5 md:px-6 md:py-6">{children}</main>
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
