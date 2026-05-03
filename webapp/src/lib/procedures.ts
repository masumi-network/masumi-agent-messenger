/**
 * Re-exports generated procedure-related types under the names callers use,
 * plus a couple of small string-to-tagged-enum adapters at the boundary.
 */
import type { DbConnection } from '@/module_bindings';
import type {
  Agent,
  AgentKeyBundle,
  AgentKeyBundleLookupRequest,
  AgentPublicKeyKind as GeneratedAgentPublicKeyKind,
  AgentPublicKeyLookupRow as GeneratedAgentPublicKeyLookupRow,
  AgentPublicKeyLookupRequest as GeneratedAgentPublicKeyLookupRequest,
  Channel,
  ChannelMember,
  ChannelMessage,
  Device,
  DeviceKeyBundle,
  DeviceShareRequest,
  ListThreadMessagesPage,
  Message,
  OwnedAgentPage,
  PublishedAgentLookupRow,
  PublishedAgentSigningKeyLookupRequest,
  PublishedAgentSigningKeyLookupRow,
  PublishedPublicRouteContactPolicy,
  PublishedPublicRouteHeaderCapability,
  PublishedPublicRouteRow,
  ResolvedDeviceShareRequestRow,
  Thread,
  ThreadParticipant,
  ThreadParticipantPreview,
  ThreadSecretEnvelope,
  VisibleChannelState,
  VisibleThreadPage,
} from '@/module_bindings/types';

export type ProcedureConnection = Pick<DbConnection, 'procedures'>;

export type AgentPublicKeyKindString = 'encryption' | 'signing';

export function toAgentPublicKeyKindTag(
  kind: AgentPublicKeyKindString
): GeneratedAgentPublicKeyKind {
  return kind === 'encryption' ? { tag: 'Encryption' } : { tag: 'Signing' };
}

export function fromAgentPublicKeyKindTag(
  kind: GeneratedAgentPublicKeyKind
): AgentPublicKeyKindString {
  return kind.tag === 'Encryption' ? 'encryption' : 'signing';
}

export type AgentPublicKeyLookupRequestInput = {
  agentDbId: bigint;
  keyKind: AgentPublicKeyKindString;
  keyVersion: number;
};

export function toGeneratedAgentPublicKeyLookupRequest(
  input: AgentPublicKeyLookupRequestInput
): GeneratedAgentPublicKeyLookupRequest {
  return {
    agentDbId: input.agentDbId,
    keyKind: toAgentPublicKeyKindTag(input.keyKind),
    keyVersion: input.keyVersion,
  };
}

export type {
  Agent,
  AgentKeyBundle,
  AgentKeyBundleLookupRequest,
  Channel,
  ChannelMember,
  ChannelMessage,
  Device,
  DeviceKeyBundle,
  DeviceShareRequest,
  ListThreadMessagesPage,
  Message,
  OwnedAgentPage,
  PublishedAgentLookupRow,
  PublishedAgentSigningKeyLookupRequest,
  PublishedAgentSigningKeyLookupRow,
  PublishedPublicRouteContactPolicy,
  PublishedPublicRouteHeaderCapability,
  PublishedPublicRouteRow,
  ResolvedDeviceShareRequestRow,
  Thread,
  ThreadParticipant,
  ThreadParticipantPreview,
  ThreadSecretEnvelope,
  VisibleChannelState,
  VisibleThreadPage,
};

export type AgentPublicKeyKind = GeneratedAgentPublicKeyKind;
export type AgentPublicKeyLookupRow = GeneratedAgentPublicKeyLookupRow;
export type AgentPublicKeyLookupRequest = GeneratedAgentPublicKeyLookupRequest;
