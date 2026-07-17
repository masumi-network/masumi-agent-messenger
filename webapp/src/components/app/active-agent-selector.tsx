import { useState } from 'react';
import {
  CaretDown,
  Check,
  Lock,
  LockOpen,
} from '@phosphor-icons/react';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import { KeyVaultDialog } from '@/components/key-vault-form';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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

export function ActiveAgentSelector({
  activeSlug,
  agents,
  compact = false,
  onSelect,
}: {
  activeSlug: string | null;
  agents: ActiveAgentOption[];
  compact?: boolean;
  onSelect: (slug: string) => void;
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <button
              type="button"
              aria-label={`${activeName}. ${vaultLabel}. Switch active agent`}
              title={`${activeAgent ? `/${activeAgent.slug}` : activeName} — ${vaultLabel}`}
              className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentAvatar
                name={activeName}
                identity={activeAgent?.publicIdentity ?? activeSlug ?? 'agent'}
                size="sm"
              />
              <span
                aria-hidden
                className={cn(
                  'absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full ring-2 ring-background',
                  vault.unlocked ? 'bg-emerald-500' : 'bg-amber-500'
                )}
              />
            </button>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                  {vault.unlocked ? (
                    <LockOpen className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Lock className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
                  )}
                  {activeAgent ? `/${activeAgent.slug} · ${vaultLabel}` : vaultLabel}
                </span>
              </span>
              <CaretDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={compact ? 'start' : 'end'}
          side={compact ? 'right' : 'bottom'}
          sideOffset={8}
          className="w-64"
        >
          <DropdownMenuLabel className="pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Active agent
          </DropdownMenuLabel>
          {agents.map(agent => {
            const isActive = agent.slug === activeSlug;
            const name = agent.displayName?.trim() || agent.slug;
            return (
              <DropdownMenuItem
                key={agent.slug}
                className="gap-2.5"
                onSelect={() => {
                  if (!isActive) {
                    onSelect(agent.slug);
                  }
                }}
              >
                <AgentAvatar
                  name={name}
                  identity={agent.publicIdentity}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    /{agent.slug}
                  </span>
                </span>
                {isActive ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={vault.loading || vault.unlocked}
            className="gap-2.5"
            onSelect={() => setVaultDialogOpen(true)}
          >
            {vault.unlocked ? (
              <LockOpen className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            )}
            <span className="flex-1">{vaultLabel}</span>
            {!vault.loading && !vault.unlocked ? (
              <span className="text-xs text-muted-foreground">
                {vault.initialized ? 'Unlock' : 'Create'}
              </span>
            ) : null}
          </DropdownMenuItem>
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
