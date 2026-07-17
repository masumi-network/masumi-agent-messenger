import { useRef } from 'react';
import { CaretUp, SignOut } from '@phosphor-icons/react';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { clearUnlockedKeySession } from '@/lib/agent-session';

export function AccountMenu({
  email,
  activeAgentSlug,
  agentCount,
  avatarName,
  avatarIdentity,
  iconOnly,
}: {
  email: string;
  activeAgentSlug?: string;
  agentCount: number;
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
              aria-label={`Open account details for ${email}`}
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentAvatar
                name={identityLabel}
                identity={identity}
                size="sm"
              />
            </button>
          ) : (
            <button
              type="button"
              aria-label={`Open account details for ${email}`}
              className="group flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentAvatar
                name={identityLabel}
                identity={identity}
                size="sm"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {compactLabel}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  Signed-in account
                </span>
              </span>
              <CaretUp
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                weight="bold"
              />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side={iconOnly ? 'right' : 'top'}
          sideOffset={8}
          className="w-[min(19rem,calc(100vw-1rem))] p-2"
        >
          <DropdownMenuLabel className="px-2 py-2 font-normal text-foreground">
            <div className="flex items-start gap-3">
              <AgentAvatar
                name={identityLabel}
                identity={identity}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Signed-in account
                </p>
                <p className="mt-0.5 truncate text-sm font-medium" title={email}>
                  {email}
                </p>
              </div>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Active agent</dt>
                <dd className="truncate font-mono text-foreground">
                  {activeAgentSlug ? `/${activeAgentSlug}` : 'None selected'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Available agents</dt>
                <dd className="font-medium tabular-nums text-foreground">
                  {agentCount}
                </dd>
              </div>
            </dl>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-11 gap-2.5 text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={() => {
              clearUnlockedKeySession();
              logoutFormRef.current?.requestSubmit();
            }}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/10">
              <SignOut className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Log out</span>
              <span className="block text-xs text-muted-foreground">
                Lock the vault and end this session
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
