import { cn } from '@/lib/utils';

const AVATAR_FILLS = [
  'bg-blue-600 text-white',
  'bg-emerald-600 text-white',
  'bg-violet-600 text-white',
  'bg-amber-600 text-white',
  'bg-rose-600 text-white',
  'bg-cyan-600 text-white',
  'bg-orange-600 text-white',
  'bg-fuchsia-600 text-white',
];

const AVATAR_SOFT_RINGS = [
  'ring-blue-500/20',
  'ring-emerald-500/20',
  'ring-violet-500/20',
  'ring-amber-500/20',
  'ring-rose-500/20',
  'ring-cyan-500/20',
  'ring-orange-500/20',
  'ring-fuchsia-500/20',
];

export const AGENT_ACCENT = [
  { bar: 'border-l-blue-500/70',    tint: 'hover:bg-blue-500/[0.04]',    ring: 'ring-blue-500/30' },
  { bar: 'border-l-emerald-500/70', tint: 'hover:bg-emerald-500/[0.04]', ring: 'ring-emerald-500/30' },
  { bar: 'border-l-violet-500/70',  tint: 'hover:bg-violet-500/[0.04]',  ring: 'ring-violet-500/30' },
  { bar: 'border-l-amber-500/70',   tint: 'hover:bg-amber-500/[0.04]',   ring: 'ring-amber-500/30' },
  { bar: 'border-l-rose-500/70',    tint: 'hover:bg-rose-500/[0.04]',    ring: 'ring-rose-500/30' },
  { bar: 'border-l-cyan-500/70',    tint: 'hover:bg-cyan-500/[0.04]',    ring: 'ring-cyan-500/30' },
  { bar: 'border-l-orange-500/70',  tint: 'hover:bg-orange-500/[0.04]',  ring: 'ring-orange-500/30' },
  { bar: 'border-l-fuchsia-500/70', tint: 'hover:bg-fuchsia-500/[0.04]', ring: 'ring-fuchsia-500/30' },
] as const;

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
  xl: 'h-14 w-14 text-base',
};

const SELF_FILL = 'bg-primary text-primary-foreground';
const SELF_SOFT_RING = 'ring-primary/30';

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

type AvatarBadge = 'verified' | 'unknown' | 'new';

const BADGE_CLASSES: Record<AvatarBadge, string> = {
  verified: 'bg-emerald-500 ring-background',
  unknown: 'bg-amber-500 ring-background',
  new: 'bg-primary ring-background',
};

const BADGE_LABEL: Record<AvatarBadge, string> = {
  verified: 'Verified agent',
  unknown: 'Unverified agent',
  new: 'New agent',
};

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getAgentColorIndex(identity: string): number {
  return hashString(identity) % AVATAR_FILLS.length;
}

export function AgentAvatar({
  name,
  identity,
  size = 'md',
  variant = 'default',
  badge,
  stacked = false,
  className,
}: {
  name: string;
  identity: string;
  size?: AvatarSize;
  variant?: 'default' | 'self';
  badge?: AvatarBadge;
  stacked?: boolean;
  className?: string;
}) {
  const colorIndex = getAgentColorIndex(identity);
  const initial = (name[0] ?? '?').toUpperCase();
  const fill = variant === 'self' ? SELF_FILL : AVATAR_FILLS[colorIndex];
  const softRing = variant === 'self' ? SELF_SOFT_RING : AVATAR_SOFT_RINGS[colorIndex];

  return (
    <div className={cn('relative inline-flex shrink-0', className)}>
      <div
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-lg font-mono font-medium',
          SIZE_CLASSES[size],
          fill,
          stacked ? 'ring-2 ring-background' : cn('ring-1', softRing)
        )}
        aria-hidden
      >
        {initial}
      </div>
      {badge ? (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2',
            BADGE_CLASSES[badge]
          )}
          aria-label={BADGE_LABEL[badge]}
          role="img"
        />
      ) : null}
    </div>
  );
}

export function AgentAvatarStack({
  agents,
  size = 'sm',
  max = 3,
  className,
}: {
  agents: Array<{ name: string; identity: string }>;
  size?: 'sm' | 'md';
  max?: number;
  className?: string;
}) {
  const visible = agents.slice(0, max);
  const overflow = Math.max(0, agents.length - visible.length);
  const overlapClass = size === 'sm' ? '-ml-1.5' : '-ml-2';
  const overflowSize = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs';

  return (
    <div className={cn('flex items-center', className)}>
      {visible.map((agent, index) => (
        <AgentAvatar
          key={`${agent.identity}:${index}`}
          name={agent.name}
          identity={agent.identity}
          size={size}
          stacked
          className={index === 0 ? '' : overlapClass}
        />
      ))}
      {overflow > 0 ? (
        <div
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-lg bg-muted font-mono font-medium text-muted-foreground ring-2 ring-background',
            overflowSize,
            overlapClass
          )}
          aria-label={`${overflow} more`}
        >
          +{overflow}
        </div>
      ) : null}
    </div>
  );
}
