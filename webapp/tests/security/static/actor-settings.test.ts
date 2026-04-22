import { describe, expect, it } from 'vitest';
import {
  canAttemptManagedAgentDeregistration,
  canAttemptManagedAgentRegistration,
} from '@/features/workspace/actor-settings';

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

    expect(
      canAttemptManagedAgentRegistration({
        status: 'deregistered',
        inboxAgentId: 'agent-123',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'DeregistrationConfirmed',
      })
    ).toBe(false);
  });
});

describe('canAttemptManagedAgentDeregistration', () => {
  it('allows deregistration when registration is confirmed', () => {
    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: 'agent-123',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'RegistrationConfirmed',
      })
    ).toBe(true);
  });

  it('allows deregistration for legacy rows with inboxAgentId + agentIdentifier but no registrationState', () => {
    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: 'agent-123',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: null,
      })
    ).toBe(true);
  });

  it('blocks deregistration when inboxAgentId is missing', () => {
    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: null,
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'RegistrationConfirmed',
      })
    ).toBe(false);

    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: '   ',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'RegistrationConfirmed',
      })
    ).toBe(false);
  });

  it('blocks deregistration for legacy rows when agentIdentifier is missing', () => {
    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: 'agent-123',
        agentIdentifier: null,
        registrationState: null,
      })
    ).toBe(false);
  });

  it('blocks deregistration for non-confirmed registration states', () => {
    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: 'agent-123',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'RegistrationRequested',
      })
    ).toBe(false);

    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: 'agent-123',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'DeregistrationConfirmed',
      })
    ).toBe(false);

    expect(
      canAttemptManagedAgentDeregistration({
        inboxAgentId: 'agent-123',
        agentIdentifier: 'did:masumi:agent-123',
        registrationState: 'RegistrationFailed',
      })
    ).toBe(false);
  });
});
