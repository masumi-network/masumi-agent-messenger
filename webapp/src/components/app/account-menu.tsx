import { useRef } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Check,
  SignOut,
  Gear,
} from '@phosphor-icons/react';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { clearUnlockedKeySession } from '@/lib/agent-session';
import { buildWorkspaceSearch } from '@/lib/app-shell';

type AgentOption = {
  slug: string;
  displayName?: string | null;
  publicIdentity: string;
};

export function AccountMenu({
  email,
  currentInboxSlug,
  avatarName,
  avatarIdentity,
  iconOnly,
  ownedAgents = [],
}: {
  email: string;
  currentInboxSlug?: string;
  avatarName?: string;
  avatarIdentity?: string;
  iconOnly?: boolean;
  ownedAgents?: AgentOption[];
}) {
  const logoutFormRef = useRef<HTMLFormElement | null>(null);
  const navigate = useNavigate();
  const compactLabel =
    email.split('@')[0] && email.split('@')[0] !== ''
      ? email.split('@')[0]
      : email;
  const identity = avatarIdentity ?? email;
  const identityLabel = avatarName ?? compactLabel;
  return (
    <>
      <form ref={logoutFormRef} action="/auth/logout" method="post" className="hidden" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {iconOnly ? (
            <button
              type="button"
              aria-label="Open account menu"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentAvatar
                name={identityLabel}
                identity={identity}
                size="sm"
              />
            </button>
          ) : (
            <Button variant="ghost" size="sm" className="w-full justify-start gap-2.5 px-2">
              <AgentAvatar
                name={identityLabel}
                identity={identity}
                size="sm"
              />
              <span className="truncate text-left font-mono text-xs">{compactLabel}</span>
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="py-2">
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          </DropdownMenuLabel>

          {ownedAgents.length > 1 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Switch agent
              </DropdownMenuLabel>
              {ownedAgents.map((agent) => {
                const isActive = agent.slug === currentInboxSlug;
                return (
                  <DropdownMenuItem
                    key={agent.slug}
                    className="gap-2.5"
                    onSelect={() => {
                      void navigate({
                        to: '/$slug',
                        params: { slug: agent.slug },
                        search: buildWorkspaceSearch({}),
                      });
                    }}
                  >
                    <AgentAvatar
                      name={agent.displayName ?? agent.slug}
                      identity={agent.publicIdentity}
                      size="sm"
                    />
                    <span className="flex-1 truncate font-mono text-xs">/{agent.slug}</span>
                    {isActive ? <Check className="h-3.5 w-3.5 text-foreground" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/security" search={{ panel: undefined }}>
              <Gear className="h-4 w-4" />
              Security
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              clearUnlockedKeySession();
              logoutFormRef.current?.requestSubmit();
            }}
          >
            <SignOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
