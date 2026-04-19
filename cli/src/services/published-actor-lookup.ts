import {
  toResolvedPublishedActor,
  type PublishedActorIdentifierInputKind,
  type PublishedActorLookupLike,
  type ResolvedPublishedActor,
} from '../../../shared/published-actors';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { userError } from './errors';

export type ResolvedActorLookup<Actor extends PublishedActorLookupLike> = {
  input: string;
  inputKind: PublishedActorIdentifierInputKind;
  matchedActors: ResolvedPublishedActor[];
  selected: Actor;
  selectedActor: ResolvedPublishedActor;
};

type ResolvedActorMatch<Actor extends PublishedActorLookupLike> = {
  actor: Actor;
  resolvedActor: ResolvedPublishedActor;
};

function isValidEmailIdentifier(value: string): boolean {
  return value.includes('@') && !value.startsWith('@') && !value.endsWith('@');
}

function normalizePublishedActorIdentifier(value: string): {
  inputKind: PublishedActorIdentifierInputKind;
  normalizedIdentifier: string;
} {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Agent slug or email is required.');
  }

  if (trimmed.includes('@')) {
    const normalizedIdentifier = normalizeEmail(trimmed);
    if (!isValidEmailIdentifier(normalizedIdentifier)) {
      throw new Error('Agent slug or email is invalid.');
    }

    return {
      inputKind: 'email',
      normalizedIdentifier,
    };
  }

  const normalizedIdentifier = normalizeInboxSlug(trimmed);
  if (!normalizedIdentifier) {
    throw new Error('Agent slug or email is invalid.');
  }

  return {
    inputKind: 'slug',
    normalizedIdentifier,
  };
}

function toResolvedActorMatch<Actor extends PublishedActorLookupLike>(
  actor: Actor
): ResolvedActorMatch<Actor> {
  return {
    actor,
    resolvedActor: toResolvedPublishedActor(actor),
  };
}

function selectPublishedActorMatch<Actor extends PublishedActorLookupLike>(params: {
  inputKind: PublishedActorIdentifierInputKind;
  normalizedIdentifier: string;
  matches: ResolvedActorMatch<Actor>[];
}): ResolvedActorMatch<Actor> | null {
  return (
    (params.inputKind === 'slug'
      ? params.matches.find(match => match.actor.slug === params.normalizedIdentifier) ?? null
      : null) ??
    (params.inputKind === 'email'
      ? params.matches.find(match => match.actor.isDefault) ?? null
      : null) ??
    params.matches[0] ??
    null
  );
}

export async function resolvePublishedActorLookup<Actor extends PublishedActorLookupLike>(
  params: {
    identifier: string;
    lookupBySlug: (input: { slug: string }) => Promise<Actor[]>;
    lookupByEmail: (input: { email: string }) => Promise<Actor[]>;
    invalidMessage?: string;
    invalidCode?: string;
    notFoundCode?: string;
    fallbackMessage?: string;
  }
): Promise<ResolvedActorLookup<Actor>> {
  try {
    const { inputKind, normalizedIdentifier } = normalizePublishedActorIdentifier(
      params.identifier
    );

    if (inputKind === 'email') {
      const exactEmailMatches = (await params.lookupByEmail({
        email: normalizedIdentifier,
      })).map(toResolvedActorMatch);
      const selectedEmailMatch = selectPublishedActorMatch({
        inputKind,
        normalizedIdentifier,
        matches: exactEmailMatches,
      });

      if (selectedEmailMatch) {
        return {
          input: params.identifier,
          inputKind,
          matchedActors: exactEmailMatches.map(match => match.resolvedActor),
          selected: selectedEmailMatch.actor,
          selectedActor: selectedEmailMatch.resolvedActor,
        };
      }
    }

    if (inputKind === 'slug') {
      const exactSlugMatch = (await params.lookupBySlug({
        slug: normalizedIdentifier,
      }))[0] ?? null;

      if (exactSlugMatch) {
        const resolvedMatch = toResolvedActorMatch(exactSlugMatch);
        return {
          input: params.identifier,
          inputKind,
          matchedActors: [resolvedMatch.resolvedActor],
          selected: resolvedMatch.actor,
          selectedActor: resolvedMatch.resolvedActor,
        };
      }
    }

    throw new Error(
      inputKind === 'email'
        ? `No published inbox agents found for email \`${normalizedIdentifier}\`.`
        : `No published inbox actor found for slug \`${normalizedIdentifier}\`.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : null;
    if (
      message === 'Agent slug or email is required.' ||
      message === 'Agent slug or email is invalid.'
    ) {
      throw userError(params.invalidMessage ?? 'Inbox slug or email is invalid.', {
        code: params.invalidCode ?? 'INVALID_AGENT_IDENTIFIER',
      });
    }

    throw userError(
      message ?? params.fallbackMessage ?? 'Unable to resolve inbox slug or email.',
      {
        code: params.notFoundCode ?? 'ACTOR_NOT_FOUND',
      }
    );
  }
}
