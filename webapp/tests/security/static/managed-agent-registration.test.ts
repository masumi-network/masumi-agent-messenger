import { describe, expect, it } from 'vitest';
import { canAttemptManagedAgentRegistration } from '@/features/workspace/actor-settings';

describe('managed agent registration retry policy', () => {
  it('allows retry after a transient service outage before any registration is recorded', () => {
    expect(
      canAttemptManagedAgentRegistration({
        status: 'service_unavailable',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: null,
      })
    ).toBe(true);
  });

  it('still blocks retry when a non-failed registration state is already recorded', () => {
    expect(
      canAttemptManagedAgentRegistration({
        status: 'service_unavailable',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: 'RegistrationRequested',
      })
    ).toBe(false);
  });
});
