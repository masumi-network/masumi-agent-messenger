import { useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { SignOut, Gear } from '@phosphor-icons/react';
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

export function AccountMenu({
  email,
  currentInboxSlug,
  avatarName,
  avatarIdentity,
  iconOnly,
}: {
  email: string;
  currentInboxSlug?: string;
  avatarName?: string;
  avatarIdentity?: string;
  iconOnly?: boolean;
}) {
  const logoutFormRef = useRef<HTMLFormElement | null>(null);
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

          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link
              to="/security"
              search={{
                agent: currentInboxSlug,
                panel: undefined,
              }}
            >
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
