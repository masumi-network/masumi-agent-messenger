import { useState } from 'react';
import {
  CaretDown,
  CircleNotch,
  Lock,
  LockOpen,
  Users,
} from '@phosphor-icons/react';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import { KeyVaultDialog } from '@/components/key-vault-form';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useKeyVault } from '@/hooks/use-key-vault';
import { cn } from '@/lib/utils';

export type ActiveAgentOption = {
  id?: bigint;
  slug: string;
  displayName?: string | null;
  publicIdentity: string;
};

export type ActiveAgentSelectorVariant = 'sidebar' | 'rail' | 'header';

type VaultVisualState = 'loading' | 'unlocked' | 'locked';

function VaultStatusIcon({
  state,
  className,
}: {
  state: VaultVisualState;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center',
        state === 'loading'
          ? 'animate-spin text-muted-foreground motion-reduce:animate-none'
          : state === 'unlocked'
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400',
        className
      )}
    >
      {state === 'loading' ? (
        <CircleNotch className="block size-3.5 shrink-0" weight="bold" />
      ) : state === 'unlocked' ? (
        <LockOpen className="block size-3.5 shrink-0" weight="bold" />
      ) : (
        <Lock className="block size-3.5 shrink-0" weight="bold" />
      )}
    </span>
  );
}

export function ActiveAgentSelector({
  activeSlug,
  agents,
  variant = 'sidebar',
  onSelect,
  onManageAgents,
}: {
  activeSlug: string | null;
  agents: ActiveAgentOption[];
  variant?: ActiveAgentSelectorVariant;
  onSelect: (slug: string) => void;
  onManageAgents?: () => void;
}) {
  const vault = useKeyVault();
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const activeAgent =
    agents.find(agent => agent.slug === activeSlug) ?? null;
  const activeName =
    activeAgent?.displayName?.trim() || activeAgent?.slug || 'Select agent';
  const vaultLabel = vault.loading
    ? 'Checking vault'
    : vault.unlocked
      ? 'Vault unlocked'
      : vault.initialized
        ? 'Vault locked'
        : 'Vault not created';
  const vaultVisualState: VaultVisualState = vault.loading
    ? 'loading'
    : vault.unlocked
      ? 'unlocked'
      : 'locked';
  const isRail = variant === 'rail';
  const isHeader = variant === 'header';
  const triggerLabel = activeAgent
    ? `Acting as /${activeAgent.slug}`
    : 'Select active agent';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {isRail ? (
            <button
              type="button"
              aria-label={`${triggerLabel}. ${vaultLabel}. Switch active agent`}
              title={`${triggerLabel} · ${vaultLabel}`}
              className="relative flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentAvatar
                name={activeName}
                identity={activeAgent?.publicIdentity ?? activeSlug ?? 'agent'}
                size="md"
              />
              <span className="absolute -bottom-0.5 -right-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
                <VaultStatusIcon state={vaultVisualState} />
              </span>
            </button>
          ) : isHeader ? (
            <button
              type="button"
              aria-label={`${triggerLabel}. ${vaultLabel}. Switch active agent`}
              className="flex h-11 min-w-0 max-w-[11rem] items-center gap-2 rounded-lg border border-border/70 bg-card/70 px-2.5 text-left shadow-xs transition-[background-color,border-color,box-shadow] hover:border-border hover:bg-muted/50 hover:shadow-soft-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[15rem] lg:h-9"
            >
              <AgentAvatar
                name={activeName}
                identity={activeAgent?.publicIdentity ?? activeSlug ?? 'agent'}
                size="sm"
              />
              <span className="min-w-0 flex-1">
                <span className="hidden text-[11px] font-medium leading-none text-muted-foreground xl:block">
                  Acting as
                </span>
                <span className="block truncate font-mono text-sm font-medium leading-tight">
                  {activeAgent ? `/${activeAgent.slug}` : 'Select agent'}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <VaultStatusIcon state={vaultVisualState} />
                <CaretDown
                  aria-hidden
                  className="hidden size-3 shrink-0 sm:block"
                  weight="bold"
                />
              </span>
            </button>
          ) : (
            <button
              type="button"
              aria-label={`${triggerLabel}. ${vaultLabel}. Switch active agent`}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-border/70 bg-card/60 px-2.5 py-2 text-left shadow-xs transition-[background-color,border-color,box-shadow] hover:border-border hover:bg-muted/50 hover:shadow-soft-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentAvatar
                name={activeName}
                identity={activeAgent?.publicIdentity ?? activeSlug ?? 'agent'}
                size="md"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {activeName}
                </span>
                <span className="flex items-center gap-1.5 truncate text-sm text-muted-foreground lg:text-xs">
                  <VaultStatusIcon state={vaultVisualState} />
                  {activeAgent
                    ? `/${activeAgent.slug} · ${vaultLabel}`
                    : vaultLabel}
                </span>
              </span>
              <CaretDown
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
                weight="bold"
              />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={isRail ? 'start' : 'end'}
          side={isRail ? 'right' : 'bottom'}
          sideOffset={8}
          className="w-[min(19rem,calc(100vw-1rem))]"
        >
          <DropdownMenuLabel className="pb-1.5 pt-2 text-sm font-medium text-muted-foreground lg:text-xs">
            Act as
          </DropdownMenuLabel>
          {agents.length === 0 ? (
            <p className="px-2.5 py-3 text-sm text-muted-foreground">
              No active agents in this account.
            </p>
          ) : (
            <DropdownMenuRadioGroup
              value={activeSlug ?? ''}
              onValueChange={slug => {
                if (slug !== activeSlug) {
                  onSelect(slug);
                }
              }}
              className="max-h-[min(22rem,55vh)] overflow-y-auto"
            >
              {agents.map(agent => {
                const name = agent.displayName?.trim() || agent.slug;
                return (
                  <DropdownMenuRadioItem
                    key={agent.slug}
                    value={agent.slug}
                    className="min-h-11 gap-2.5 py-2 pl-8"
                  >
                    <AgentAvatar
                      name={name}
                      identity={agent.publicIdentity}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {name}
                      </span>
                      <span className="block truncate font-mono text-sm text-muted-foreground lg:text-xs">
                        /{agent.slug}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          )}
          <DropdownMenuSeparator />
          {vault.unlocked ? (
            <div
              className="flex min-h-11 items-center gap-2.5 px-2.5 py-2 text-sm"
              role="status"
            >
              <VaultStatusIcon state="unlocked" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Vault unlocked</span>
                <span className="block text-sm text-muted-foreground lg:text-xs">
                  Agent keys are available in this tab
                </span>
              </span>
            </div>
          ) : (
            <DropdownMenuItem
              disabled={vault.loading}
              className="min-h-11 gap-2.5"
              onSelect={() => setVaultDialogOpen(true)}
            >
              <VaultStatusIcon state={vaultVisualState} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{vaultLabel}</span>
                <span className="block text-sm text-muted-foreground lg:text-xs">
                  {vault.initialized
                    ? 'Unlock keys for agent actions'
                    : 'Create a vault for agent keys'}
                </span>
              </span>
            </DropdownMenuItem>
          )}
          {onManageAgents ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="min-h-11 gap-2.5"
                onSelect={onManageAgents}
              >
                <Users className="size-4 shrink-0" aria-hidden />
                <span className="font-medium">Manage agents</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <KeyVaultDialog
        open={vaultDialogOpen && !vault.unlocked}
        onOpenChange={setVaultDialogOpen}
        mode={vault.initialized ? 'unlock' : 'setup'}
        busy={vault.submitting}
        error={vault.error}
        title={vault.initialized ? 'Unlock Private Keys' : 'Create Private Key Vault'}
        description="One browser vault protects the private keys for every agent in this account. Unlock it once, then switch agents without exposing another agent’s workspace."
        submitLabel={vault.initialized ? 'Unlock keys' : 'Create vault'}
        onSubmit={vault.handleSubmit}
      />
    </>
  );
}
