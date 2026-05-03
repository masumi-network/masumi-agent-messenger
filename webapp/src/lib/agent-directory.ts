type DescribableActor = {
  slug: string;
  publicIdentity: string;
  email: string;
  isDefault?: boolean;
  displayName?: string | null;
};

export function describeActor(actor: DescribableActor | undefined): string {
  if (!actor) return 'Unknown actor';

  return actor.displayName?.trim()
    ? `${actor.displayName} (${actor.slug})`
    : actor.slug;
}
