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

  it('allows explicit recovery when only stale local pending state is recorded', () => {
    expect(
      canAttemptManagedAgentRegistration({
        status: 'service_unavailable',
        inboxAgentId: null,
        agentIdentifier: null,
        registrationState: 'RegistrationRequested',
      })
    ).toBe(true);
  });
});
