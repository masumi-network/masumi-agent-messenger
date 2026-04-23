import { t } from 'spacetimedb/server';
import { DeviceKeyBundleExpiryMode } from './constants';

export const SecretEnvelopeAttachment = t.object('SecretEnvelopeAttachment', {
  recipientPublicIdentity: t.string(),
  recipientEncryptionKeyVersion: t.string(),
  senderEncryptionKeyVersion: t.string(),
  signingKeyVersion: t.string(),
  wrappedSecretCiphertext: t.string(),
  wrappedSecretIv: t.string(),
  wrapAlgorithm: t.string(),
  signature: t.string(),
});

export const DeviceKeyBundleAttachment = t.object('DeviceKeyBundleAttachment', {
  deviceId: t.string(),
  sourceDeviceId: t.string().optional(),
  sourceEncryptionPublicKey: t.string(),
  sourceEncryptionKeyVersion: t.string(),
  sourceEncryptionAlgorithm: t.string().optional(),
  bundleCiphertext: t.string(),
  bundleIv: t.string(),
  bundleAlgorithm: t.string(),
  sharedAgentCount: t.u64(),
  sharedKeyVersionCount: t.u64(),
  expiresAt: t.timestamp(),
  expiryMode: DeviceKeyBundleExpiryMode,
});

export const VisibleInboxRow = t.object('VisibleInboxRow', {
  id: t.u64(),
  normalizedEmail: t.string(),
  displayEmail: t.string(),
  ownerIdentity: t.identity(),
  authSubject: t.string(),
  authIssuer: t.string(),
  authVerified: t.bool(),
  emailAttested: t.bool(),
  authVerifiedAt: t.timestamp(),
  authExpiresAt: t.timestamp().optional(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

export const VisibleAgentRow = t.object('VisibleAgentRow', {
  id: t.u64(),
  inboxId: t.u64(),
  normalizedEmail: t.string(),
  slug: t.string(),
  inboxIdentifier: t.string().optional(),
  isDefault: t.bool(),
  publicIdentity: t.string(),
  displayName: t.string().optional(),
  publicLinkedEmailEnabled: t.bool(),
  publicDescription: t.string().optional(),
  allowAllMessageContentTypes: t.bool().optional(),
  allowAllMessageHeaders: t.bool().optional(),
  supportedMessageContentTypes: t.array(t.string()).optional(),
  supportedMessageHeaderNames: t.array(t.string()).optional(),
  currentEncryptionPublicKey: t.string(),
  currentEncryptionKeyVersion: t.string(),
  currentEncryptionAlgorithm: t.string(),
  currentSigningPublicKey: t.string(),
  currentSigningKeyVersion: t.string(),
  currentSigningAlgorithm: t.string(),
  masumiRegistrationNetwork: t.string().optional(),
  masumiInboxAgentId: t.string().optional(),
  masumiAgentIdentifier: t.string().optional(),
  masumiRegistrationState: t.string().optional(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

export const VisibleAgentKeyBundleRow = t.object('VisibleAgentKeyBundleRow', {
  id: t.u64(),
  agentDbId: t.u64(),
  publicIdentity: t.string(),
  encryptionPublicKey: t.string(),
  encryptionKeyVersion: t.string(),
  encryptionAlgorithm: t.string(),
  signingPublicKey: t.string(),
  signingKeyVersion: t.string(),
  signingAlgorithm: t.string(),
  createdAt: t.timestamp(),
});

export const VisibleDeviceRow = t.object('VisibleDeviceRow', {
  id: t.u64(),
  deviceId: t.string(),
  inboxId: t.u64(),
  label: t.string().optional(),
  platform: t.string().optional(),
  deviceEncryptionPublicKey: t.string(),
  deviceEncryptionKeyVersion: t.string(),
  deviceEncryptionAlgorithm: t.string(),
  status: t.string(),
  approvedAt: t.timestamp().optional(),
  revokedAt: t.timestamp().optional(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
  lastSeenAt: t.timestamp(),
});

export const VisibleDeviceShareRequestRow = t.object('VisibleDeviceShareRequestRow', {
  id: t.u64(),
  deviceId: t.string(),
  label: t.string().optional(),
  platform: t.string().optional(),
  clientCreatedAt: t.timestamp(),
  expiresAt: t.timestamp(),
  createdAt: t.timestamp(),
  approvedAt: t.timestamp().optional(),
  consumedAt: t.timestamp().optional(),
});

export const VisibleDeviceKeyBundleRow = t.object('VisibleDeviceKeyBundleRow', {
  id: t.u64(),
  targetDeviceId: t.string(),
  sourceDeviceId: t.string().optional(),
  sourceEncryptionPublicKey: t.string(),
  sourceEncryptionKeyVersion: t.string(),
  sourceEncryptionAlgorithm: t.string(),
  bundleAlgorithm: t.string(),
  sharedAgentCount: t.u64(),
  sharedKeyVersionCount: t.u64(),
  createdAt: t.timestamp(),
  expiresAt: t.timestamp(),
  consumedAt: t.timestamp().optional(),
  expiryMode: DeviceKeyBundleExpiryMode,
});

export const VisibleThreadRow = t.object('VisibleThreadRow', {
  id: t.u64(),
  dedupeKey: t.string(),
  kind: t.string(),
  membershipLocked: t.bool(),
  title: t.string().optional(),
  creatorAgentDbId: t.u64(),
  membershipVersion: t.u64(),
  nextThreadSeq: t.u64(),
  lastMessageSeq: t.u64(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
  lastMessageAt: t.timestamp(),
});

export const VisibleThreadParticipantRow = t.object('VisibleThreadParticipantRow', {
  id: t.u64(),
  threadId: t.u64(),
  agentDbId: t.u64(),
  joinedAt: t.timestamp(),
  lastSentSeq: t.u64(),
  lastSentMembershipVersion: t.u64().optional(),
  lastSentSecretVersion: t.string().optional(),
  isAdmin: t.bool(),
  active: t.bool(),
});

export const VisibleThreadSecretEnvelopeRow = t.object('VisibleThreadSecretEnvelopeRow', {
  id: t.u64(),
  threadId: t.u64(),
  membershipVersion: t.u64(),
  secretVersion: t.string(),
  senderAgentDbId: t.u64(),
  recipientAgentDbId: t.u64(),
  senderEncryptionKeyVersion: t.string(),
  recipientEncryptionKeyVersion: t.string(),
  signingKeyVersion: t.string(),
  wrappedSecretCiphertext: t.string(),
  wrappedSecretIv: t.string(),
  wrapAlgorithm: t.string(),
  signature: t.string(),
  createdAt: t.timestamp(),
});

export const VisibleMessageRow = t.object('VisibleMessageRow', {
  id: t.u64(),
  threadId: t.u64(),
  threadSeq: t.u64(),
  membershipVersion: t.u64(),
  senderAgentDbId: t.u64(),
  senderSeq: t.u64(),
  secretVersion: t.string(),
  secretVersionStart: t.bool(),
  signingKeyVersion: t.string(),
  ciphertext: t.string(),
  iv: t.string(),
  cipherAlgorithm: t.string(),
  signature: t.string(),
  replyToMessageId: t.u64().optional(),
  createdAt: t.timestamp(),
});

export const VisibleThreadReadStateRow = t.object('VisibleThreadReadStateRow', {
  id: t.u64(),
  threadId: t.u64(),
  agentDbId: t.u64(),
  lastReadThreadSeq: t.u64().optional(),
  archived: t.bool(),
  updatedAt: t.timestamp(),
});

export const ChannelMessageRow = t.object('ChannelMessageRow', {
  id: t.u64(),
  channelId: t.u64(),
  channelSeq: t.u64(),
  senderAgentDbId: t.u64(),
  senderPublicIdentity: t.string(),
  senderSeq: t.u64(),
  senderSigningPublicKey: t.string(),
  senderSigningKeyVersion: t.string(),
  plaintext: t.string(),
  signature: t.string(),
  replyToMessageId: t.u64().optional(),
  createdAt: t.timestamp(),
});

export const VisibleChannelMessageRow = t.object('VisibleChannelMessageRow', {
  id: t.u64(),
  channelId: t.u64(),
  channelSeq: t.u64(),
  senderAgentDbId: t.u64(),
  senderPublicIdentity: t.string(),
  senderSeq: t.u64(),
  senderSigningPublicKey: t.string(),
  senderSigningKeyVersion: t.string(),
  plaintext: t.string(),
  signature: t.string(),
  replyToMessageId: t.u64().optional(),
  createdAt: t.timestamp(),
});

export const SelectedPublicRecentChannelMessageRow = t.object('SelectedPublicRecentChannelMessageRow', {
  id: t.u64(),
  channelId: t.u64(),
  channelSeq: t.u64(),
  senderAgentDbId: t.u64(),
  senderPublicIdentity: t.string(),
  senderSeq: t.u64(),
  senderSigningPublicKey: t.string(),
  senderSigningKeyVersion: t.string(),
  plaintext: t.string(),
  signature: t.string(),
  replyToMessageId: t.u64().optional(),
  createdAt: t.timestamp(),
});

export const VisibleChannelRow = t.object('VisibleChannelRow', {
  id: t.u64(),
  slug: t.string(),
  title: t.string().optional(),
  description: t.string().optional(),
  accessMode: t.string(),
  publicJoinPermission: t.string(),
  discoverable: t.bool(),
  creatorAgentDbId: t.u64(),
  lastMessageSeq: t.u64(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
  lastMessageAt: t.timestamp(),
});

export const VisibleChannelMembershipRow = t.object('VisibleChannelMembershipRow', {
  id: t.u64(),
  channelId: t.u64(),
  agentDbId: t.u64(),
  permission: t.string(),
  active: t.bool(),
  lastSentSeq: t.u64(),
  joinedAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

export const ChannelMemberListRowSchema = t.object('ChannelMemberListRow', {
  id: t.u64(),
  channelId: t.u64(),
  agentDbId: t.u64(),
  agentPublicIdentity: t.string(),
  agentSlug: t.string(),
  agentDisplayName: t.string().optional(),
  agentCurrentEncryptionPublicKey: t.string(),
  agentCurrentEncryptionKeyVersion: t.string(),
  permission: t.string(),
  active: t.bool(),
  lastSentSeq: t.u64(),
  joinedAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

export const VisibleChannelJoinRequestRow = t.object('VisibleChannelJoinRequestRow', {
  id: t.u64(),
  channelId: t.u64(),
  channelSlug: t.string(),
  channelTitle: t.string().optional(),
  requesterAgentDbId: t.u64(),
  requesterPublicIdentity: t.string(),
  requesterSlug: t.string(),
  requesterDisplayName: t.string().optional(),
  requesterCurrentEncryptionPublicKey: t.string(),
  requesterCurrentEncryptionKeyVersion: t.string(),
  permission: t.string(),
  status: t.string(),
  direction: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
  resolvedAt: t.timestamp().optional(),
  resolvedByAgentDbId: t.u64().optional(),
});

export const VisibleThreadInviteRow = t.object('VisibleThreadInviteRow', {
  id: t.u64(),
  threadId: t.u64(),
  inviterAgentDbId: t.u64(),
  inviterPublicIdentity: t.string(),
  inviterSlug: t.string(),
  inviterDisplayName: t.string().optional(),
  inviteeAgentDbId: t.u64(),
  inviteePublicIdentity: t.string(),
  inviteeSlug: t.string(),
  inviteeDisplayName: t.string().optional(),
  threadTitle: t.string().optional(),
  status: t.string(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
  resolvedAt: t.timestamp().optional(),
  resolvedByAgentDbId: t.u64().optional(),
});

export const VisibleContactRequestRow = t.object('VisibleContactRequestRow', {
  id: t.u64(),
  threadId: t.u64(),
  requesterAgentDbId: t.u64(),
  requesterPublicIdentity: t.string(),
  requesterSlug: t.string(),
  requesterDisplayName: t.string().optional(),
  requesterNormalizedEmail: t.string(),
  requesterDisplayEmail: t.string(),
  requesterLinkedEmail: t.string().optional(),
  targetAgentDbId: t.u64(),
  targetPublicIdentity: t.string(),
  targetSlug: t.string(),
  targetDisplayName: t.string().optional(),
  targetLinkedEmail: t.string().optional(),
  direction: t.string(),
  status: t.string(),
  messageCount: t.u64(),
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
  resolvedAt: t.timestamp().optional(),
  resolvedByAgentDbId: t.u64().optional(),
});

export const VisibleContactAllowlistEntryRow = t.object('VisibleContactAllowlistEntryRow', {
  id: t.u64(),
  inboxId: t.u64(),
  kind: t.string(),
  agentPublicIdentity: t.string().optional(),
  agentSlug: t.string().optional(),
  agentDisplayName: t.string().optional(),
  normalizedEmail: t.string().optional(),
  displayEmail: t.string().optional(),
  createdByAgentDbId: t.u64(),
  createdAt: t.timestamp(),
});

export const PublishedAgentLookupRow = t.object('PublishedAgentLookupRow', {
  slug: t.string(),
  publicIdentity: t.string(),
  isDefault: t.bool(),
  displayName: t.string().optional(),
  agentIdentifier: t.string().optional(),
  encryptionKeyVersion: t.string(),
  encryptionAlgorithm: t.string(),
  encryptionPublicKey: t.string(),
  signingKeyVersion: t.string(),
  signingAlgorithm: t.string(),
  signingPublicKey: t.string(),
});

export const PublishedPublicRouteRow = t.object('PublishedPublicRouteRow', {
  agentIdentifier: t.string().optional(),
  linkedEmail: t.string().optional(),
  description: t.string().optional(),
  encryptionKeyVersion: t.string(),
  encryptionAlgorithm: t.string(),
  encryptionPublicKey: t.string(),
  signingKeyVersion: t.string(),
  signingAlgorithm: t.string(),
  signingPublicKey: t.string(),
  allowAllContentTypes: t.bool(),
  allowAllHeaders: t.bool(),
  supportedContentTypes: t.array(t.string()),
  supportedHeaders: t.array(
    t.object('PublishedPublicHeaderCapabilityRow', {
      name: t.string(),
      required: t.bool().optional(),
      allowMultiple: t.bool().optional(),
      sensitive: t.bool().optional(),
      allowedPrefixes: t.array(t.string()).optional(),
    })
  ),
  contactPolicy: t.object('PublishedContactPolicyRow', {
    mode: t.string(),
    allowlistScope: t.string(),
    allowlistKinds: t.array(t.string()),
    messagePreviewVisibleBeforeApproval: t.bool(),
  }),
});

export const ResolvedDeviceShareRequestRow = t.object('ResolvedDeviceShareRequestRow', {
  requestId: t.u64(),
  deviceId: t.string(),
  label: t.string().optional(),
  platform: t.string().optional(),
  deviceEncryptionPublicKey: t.string(),
  deviceEncryptionKeyVersion: t.string(),
  deviceEncryptionAlgorithm: t.string(),
  clientCreatedAt: t.timestamp(),
  expiresAt: t.timestamp(),
  createdAt: t.timestamp(),
});

export const ClaimedDeviceKeyBundleRow = t.object('ClaimedDeviceKeyBundleRow', {
  bundleId: t.u64(),
  targetDeviceId: t.string(),
  sourceDeviceId: t.string().optional(),
  sourceEncryptionPublicKey: t.string(),
  sourceEncryptionKeyVersion: t.string(),
  sourceEncryptionAlgorithm: t.string(),
  bundleCiphertext: t.string(),
  bundleIv: t.string(),
  bundleAlgorithm: t.string(),
  sharedAgentCount: t.u64(),
  sharedKeyVersionCount: t.u64(),
  createdAt: t.timestamp(),
  expiresAt: t.timestamp(),
  expiryMode: DeviceKeyBundleExpiryMode,
});
