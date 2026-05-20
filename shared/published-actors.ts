import { normalizeInboxSlug } from './inbox-slug';

export type PublishedActorLookupLike = {
  agentDbId: bigint;
  slug: string;
  publicIdentity: string;
  isDefault: boolean;
  displayName?: string | null;
  agentIdentifier?: string | null;
  encryptionKeyVersion: number;
  encryptionPublicKey: string;
  signingKeyVersion: number;
  signingPublicKey: string;
  linkedEmail?: string | null;
};

export type ResolvedPublishedActor = {
  agentDbId: bigint;
  slug: string;
  publicIdentity: string;
  isDefault: boolean;
  displayName: string | null;
  linkedEmail?: string | null;
};

export function toResolvedPublishedActor<Actor extends PublishedActorLookupLike>(
  actor: Actor
): ResolvedPublishedActor {
  return {
    agentDbId: actor.agentDbId,
    slug: actor.slug,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    displayName: actor.displayName ?? null,
    linkedEmail: actor.linkedEmail,
  };
}

export type PublishedActorIdentifierInputKind = 'slug' | 'email';

export async function lookupPublishedAgentBySlug<Actor extends PublishedActorLookupLike>(params: {
  slug: string;
  lookup: (input: { slug: string }) => Promise<Actor[]>;
}): Promise<Actor> {
  const normalizedSlug = normalizeInboxSlug(params.slug);
  if (!normalizedSlug) {
    throw new Error('Slug is required.');
  }

  const actor = (await params.lookup({ slug: normalizedSlug }))[0];
  if (!actor) {
    throw new Error(`No published agent found for slug \`${normalizedSlug}\`.`);
  }

  return actor;
}
