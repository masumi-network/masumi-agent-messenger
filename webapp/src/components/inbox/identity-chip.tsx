import { useState } from 'react';
import { Copy, Check } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { AgentAvatar } from './agent-avatar';
import { TrustHint } from './trust-hint';
import { cn } from '@/lib/utils';

/**
 * Short fingerprint derived from a public identity — first and last 4 chars.
 * Progressive-disclosure affordance: hides the full hex unless the user opens
 * the popover.
 */
function shortFingerprint(identity: string): string {
  if (identity.length <= 12) return identity;
  return `${identity.slice(0, 4)}…${identity.slice(-4)}`;
}

export function IdentityChip({
  name,
  identity,
  trust = 'unverified',
  isSelf = false,
  className,
}: {
  name: string;
  identity: string;
  trust?: 'verified' | 'unverified' | 'unknown';
  isSelf?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(identity);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard may be unavailable
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-2 rounded-full px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className
          )}
          aria-label={`Show identity details for ${name}`}
        >
          <AgentAvatar name={name} identity={identity} size="sm" variant={isSelf ? 'self' : 'default'} />
          <span className="truncate">{isSelf ? 'You' : name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {shortFingerprint(identity)}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <AgentAvatar name={name} identity={identity} size="lg" variant={isSelf ? 'self' : 'default'} />
            <div className="min-w-0 space-y-1.5">
              <p className="truncate text-sm font-semibold">{isSelf ? `${name} (you)` : name}</p>
              <TrustHint level={trust} />
            </div>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Identity key</p>
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground break-all">
              {identity}
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full"
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy identity key
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
