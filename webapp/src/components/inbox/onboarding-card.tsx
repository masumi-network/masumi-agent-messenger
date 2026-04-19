import { useEffect, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { cn } from '@/lib/utils';

const KEY_PREFIX = 'masumi:onboard:v1:';

function storageKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function readDismissed(id: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey(id)) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(id), '1');
  } catch {
    // storage disabled
  }
}

export function OnboardingCard({
  id,
  icon: Icon,
  title,
  description,
  className,
}: {
  id: string;
  icon: PhosphorIcon;
  title: string;
  description: string;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(id));

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setDismissed(readDismissed(id));
    });
  }, [id]);

  if (dismissed) return null;

  return (
    <div
      className={cn(
        'animate-soft-enter relative flex items-start gap-3 rounded-md border border-border bg-muted/30 px-4 py-3',
        className
      )}
      role="note"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          persistDismissed(id);
          setDismissed(true);
        }}
        aria-label="Dismiss hint"
        className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
