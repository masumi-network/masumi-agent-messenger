import { CheckCircle, Question, Warning } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

type TrustLevel = 'verified' | 'unverified' | 'unknown';

const LEVEL_STYLES: Record<
  TrustLevel,
  { icon: typeof CheckCircle; label: string; className: string }
> = {
  verified: {
    icon: CheckCircle,
    label: 'Verified',
    className:
      'bg-emerald-500/10 text-emerald-500 ring-1 ring-inset ring-emerald-500/30',
  },
  unverified: {
    icon: Question,
    label: 'Not yet verified',
    className: 'bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border',
  },
  unknown: {
    icon: Warning,
    label: 'Unknown device',
    className: 'bg-amber-500/10 text-amber-500 ring-1 ring-inset ring-amber-500/30',
  },
};

export function TrustHint({
  level,
  label,
  className,
}: {
  level: TrustLevel;
  label?: string;
  className?: string;
}) {
  const config = LEVEL_STYLES[level];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        config.className,
        className
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label ?? config.label}
    </span>
  );
}
