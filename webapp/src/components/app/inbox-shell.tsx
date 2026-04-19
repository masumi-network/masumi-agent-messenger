import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ChatText,
  List,
  MagnifyingGlass,
  Moon,
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
import { buildWorkspaceSearch, type AppShellSection } from '@/lib/app-shell';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

type AgentOption = {
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
  onSelect: () => void;
};

export function InboxShell({
  section,
  title,
  sessionEmail,
  currentInboxSlug,
  connected = false,
  connectionError = null,
  pendingApprovals: _pendingApprovals = 0,
  avatarName,
  avatarIdentity,
  ownedAgents = [],
  children,
}: InboxShellProps) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);

  const navItems = useMemo<NavItem[]>(
    () => [
      {
        key: 'inbox',
        label: 'Inbox',
        Icon: ChatText,
        active: section === 'inbox',
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
    [currentInboxSlug, navigate, section]
  );

  const shellTitle =
    title ??
    (section === 'inbox'
      ? 'Inbox'
      : section === 'discover'
        ? 'Discover agents'
        : section === 'agents'
          ? 'My agents'
          : 'Security');

  /* ── Expanded sidebar content (desktop + mobile drawer) ── */
  const expandedNav = (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-3 pt-4">
        <p className="truncate font-mono text-xs text-muted-foreground">
          {currentInboxSlug ? `/${currentInboxSlug}` : 'No workspace'}
        </p>
      </div>

      <nav className="space-y-1 px-2">
        {navItems.map((item) => (
          <button
            type="button"
            key={item.key}
            className={cn(
              'flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              item.active
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
            onClick={() => {
              item.onSelect();
              setMobileOpen(false);
            }}
          >
            {item.Icon ? <item.Icon className="h-4 w-4 shrink-0" /> : null}
            <span className="animate-soft-fade">{item.label}</span>
          </button>
        ))}
      </nav>

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
                  'flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  item.active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
                onClick={() => item.onSelect()}
              >
                {item.Icon ? <item.Icon className="h-4 w-4" /> : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {item.label}
            </TooltipContent>
          </Tooltip>
        ))}
      </nav>

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
