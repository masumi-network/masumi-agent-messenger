import { describe, expect, it } from 'vitest';
import { canAttemptManagedAgentRegistration } from '@/features/workspace/actor-settings';
import {
  masumiRegistrationOutcomeToHttpStatus,
  masumiRegistrationSyncOutcomeToHttpStatus,
} from '../../../../shared/inbox-agent-registration';

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

describe('managed agent registration HTTP status', () => {
  it('treats an absent registration as a successful sync snapshot', () => {
    expect(masumiRegistrationOutcomeToHttpStatus('skipped')).toBe(404);
    expect(masumiRegistrationSyncOutcomeToHttpStatus('skipped')).toBe(200);
  });

  it('preserves actionable registration failure statuses during sync', () => {
    expect(masumiRegistrationSyncOutcomeToHttpStatus('scope_missing')).toBe(403);
    expect(masumiRegistrationSyncOutcomeToHttpStatus('service_unavailable')).toBe(503);
  });
});
