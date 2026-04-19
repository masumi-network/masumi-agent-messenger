import { describe, expect, it } from 'vitest';
import { canAttemptManagedAgentRegistration } from '@/features/workspace/actor-settings';

describe('canAttemptManagedAgentRegistration', () => {
  it('allows the first registration attempt from a pristine state', () => {
    expect(
      canAttemptManagedAgentRegistration({
        status: 'skipped',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: null,
      })
    ).toBe(true);
  });

  it('allows retrying when the last attempt failed', () => {
    expect(
      canAttemptManagedAgentRegistration({
        status: 'failed',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: null,
      })
    ).toBe(true);

    expect(
      canAttemptManagedAgentRegistration({
        status: 'skipped',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: 'RegistrationFailed',
      })
    ).toBe(true);
  });

  it('blocks retry when registration is already recorded and not failed', () => {
    expect(
      canAttemptManagedAgentRegistration({
        status: 'registered',
        inboxAgentId: 'agent-123',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'RegistrationConfirmed',
      })
    ).toBe(false);

    expect(
      canAttemptManagedAgentRegistration({
        status: 'skipped',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: 'RegistrationRequested',
      })
    ).toBe(false);

    expect(
      canAttemptManagedAgentRegistration({
        status: 'insufficient_credits',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: null,
      })
    ).toBe(false);
  });
});
