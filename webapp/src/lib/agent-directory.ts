type DescribableActor = {
  slug: string;
  publicIdentity: string;
  normalizedEmail: string;
  inboxIdentifier?: string | null;
  isDefault?: boolean;
  displayName?: string | null;
};

export function describeActor(actor: DescribableActor | undefined): string {
  if (!actor) return 'Unknown actor';

  return actor.displayName?.trim()
    ? `${actor.displayName} (${actor.slug})`
    : actor.slug;
}

export function buildDirectThreadKey(
  left: { publicIdentity: string },
  right: { publicIdentity: string }
): string {
  const values = [left.publicIdentity, right.publicIdentity].sort();
  return `direct:${values[0]}:${values[1]}`;
}
