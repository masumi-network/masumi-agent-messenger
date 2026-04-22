import type { Agent } from '@/module_bindings/types';
import type { AgentKeyPair } from '@/lib/crypto';
import type { DefaultKeyIssue } from '@/lib/app-shell';
import type { MasumiRegistrationResult } from '../../../../shared/inbox-agent-registration';
import {
  buildLegacyPublicMessageCapabilities,
  buildPublicMessageCapabilities,
  type PublicMessageCapabilities,
} from '../../../../shared/message-format';

export function buildMasumiRegistrationSyncKey(actor: Agent | null): string | null {
  if (!actor) {
    return null;
  }

  return [
    actor.id.toString(),
    actor.slug,
    actor.masumiInboxAgentId ?? '',
    actor.masumiAgentIdentifier ?? '',
    actor.masumiRegistrationState ?? '',
  ].join('|');
}

export function matchesPublishedActorKeys(
  actor: Agent | undefined,
  keyPair: AgentKeyPair | null
): boolean {
  if (!actor || !keyPair) {
    return false;
  }

  return (
    actor.currentEncryptionPublicKey === keyPair.encryption.publicKey &&
    actor.currentEncryptionKeyVersion === keyPair.encryption.keyVersion &&
    actor.currentSigningPublicKey === keyPair.signing.publicKey &&
    actor.currentSigningKeyVersion === keyPair.signing.keyVersion
  );
}

export function getActorKeyIssue(
  actor: Agent | undefined,
  keyPair: AgentKeyPair | null
): DefaultKeyIssue {
  if (!keyPair) {
    return 'missing';
  }

  if (actor && !matchesPublishedActorKeys(actor, keyPair)) {
    return 'mismatch';
  }

  return null;
}

export function getActorPublishedCapabilities(
  actor: Agent
): PublicMessageCapabilities {
  return actor.supportedMessageContentTypes && actor.supportedMessageHeaderNames
    ? buildPublicMessageCapabilities({
        allowAllContentTypes:
          actor.allowAllMessageContentTypes ??
          actor.supportedMessageContentTypes.length === 0,
        allowAllHeaders:
          actor.allowAllMessageHeaders ??
          actor.supportedMessageHeaderNames.length === 0,
        supportedContentTypes: actor.supportedMessageContentTypes,
        supportedHeaders: actor.supportedMessageHeaderNames,
      })
    : buildLegacyPublicMessageCapabilities();
}

export function getActorSupportedContentTypes(actor: Agent): string[] {
  return getActorPublishedCapabilities(actor).supportedContentTypes;
}

export function getActorSupportedHeaderNames(actor: Agent): string[] {
  return getActorPublishedCapabilities(actor).supportedHeaders.map(
    header => header.name
  );
}

export function canAttemptManagedAgentRegistration(
  registration: Pick<
    MasumiRegistrationResult,
    'status' | 'inboxAgentId' | 'agentIdentifier' | 'registrationState'
  >
): boolean {
  if (registration.registrationState === 'DeregistrationConfirmed') {
    return false;
  }

  if (registration.inboxAgentId?.trim() || registration.agentIdentifier?.trim()) {
    return false;
  }

  if (
    registration.registrationState === 'RegistrationFailed' ||
    registration.status === 'failed'
  ) {
    return true;
  }

  if (
    registration.status === 'service_unavailable' &&
    registration.registrationState === null
  ) {
    return true;
  }

  if (registration.registrationState !== null) {
    return false;
  }

  return registration.status === 'skipped';
}

export function canAttemptManagedAgentDeregistration(
  registration: Pick<
    MasumiRegistrationResult,
    'inboxAgentId' | 'agentIdentifier' | 'registrationState'
  >
): boolean {
  return Boolean(
    registration.inboxAgentId?.trim() &&
      (registration.registrationState === 'RegistrationConfirmed' ||
        (!registration.registrationState && registration.agentIdentifier?.trim()))
  );
}

export function toggleSelection(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter(existing => existing !== value)
    : [...values, value];
}

export function inferAllowAllFromSelection(values: readonly string[]): boolean {
  return values.length === 0;
}

export function toActorIdentity(actor: Agent) {
  return {
    normalizedEmail: actor.normalizedEmail,
    slug: actor.slug,
    inboxIdentifier: actor.inboxIdentifier ?? undefined,
  };
}

export function formatRotateKeysError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unable to rotate keys';
  return `Key rotation did not finish. Existing published keys are still active. ${message}`;
}
