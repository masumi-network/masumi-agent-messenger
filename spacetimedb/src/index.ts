import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import {
  buildPreferredDefaultInboxSlug,
  inboxSlugContainsEmailToken,
  isReservedInboxSlug,
  normalizeEmail as normalizeSharedEmail,
  normalizeInboxSlug,
} from '../../shared/inbox-slug';
import {
  CONTACT_REQUEST_STATUSES,
  CONTACT_ALLOWLIST_KINDS,
  DEFAULT_PUBLIC_CONTACT_POLICY,
  MAX_PUBLIC_DESCRIPTION_CHARS,
} from '../../shared/contact-policy';
import {
  buildLegacyPublicMessageCapabilities,
  buildPublicMessageCapabilities,
  normalizeSupportedContentTypes,
  normalizeSupportedHeaderNames,
} from '../../shared/message-format';
import {
  DEVICE_SHARE_REQUEST_EXPIRY_MS,
  DEVICE_SHARE_REQUEST_MAX_AGE_MS,
  DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS,
} from '../../shared/device-share-constants';
import {
  MAX_MESSAGE_ALGORITHM_CHARS,
  MAX_MESSAGE_CIPHERTEXT_HEX_CHARS,
  MAX_MESSAGE_IV_HEX_CHARS,
  MAX_MESSAGE_SIGNATURE_HEX_CHARS,
  MAX_MESSAGE_VERSION_CHARS,
  MAX_WRAPPED_SECRET_CIPHERTEXT_HEX_CHARS,
  MAX_WRAPPED_SECRET_IV_HEX_CHARS,
} from '../../shared/message-limits';
import {
  TRUSTED_OIDC_AUDIENCES,
  TRUSTED_OIDC_ISSUERS,
} from '../../shared/generated-oidc-config';
import { isClientGeneratedThreadId } from '../../shared/inbox-state';

const MAX_DEVICE_ID_CHARS = 128;
const MAX_DISPLAY_NAME_CHARS = 160;
const MAX_THREAD_TITLE_CHARS = 200;
const MAX_PUBLIC_KEY_CHARS = 4096;
const MAX_DEVICE_LABEL_CHARS = 120;
const MAX_DEVICE_PLATFORM_CHARS = 120;
const MAX_DEVICE_STATUS_CHARS = 32;
const MAX_DEVICE_VERIFICATION_CODE_HASH_CHARS = 128;
const MAX_DEVICE_BUNDLE_ALGORITHM_CHARS = 120;
const MAX_DEVICE_BUNDLE_CIPHERTEXT_HEX_CHARS = 262_144;
const MAX_MASUMI_NETWORK_CHARS = 32;
const MAX_MASUMI_REGISTRATION_ID_CHARS = 128;
const MAX_MASUMI_AGENT_IDENTIFIER_CHARS = 256;
const MAX_MASUMI_REGISTRATION_STATE_CHARS = 64;
const MAX_CONTACT_REQUEST_STATUS_CHARS = 32;
const MAX_CONTACT_ALLOWLIST_KIND_CHARS = 16;
const MAX_THREAD_FANOUT = 50;
const DEFAULT_AGENT_ENCRYPTION_ALGORITHM = 'ecdh-p256-v1';
const DEFAULT_AGENT_SIGNING_ALGORITHM = 'ecdsa-p256-sha256-v1';
const DEFAULT_DEVICE_ENCRYPTION_ALGORITHM = 'ecdh-p256-device-v1';
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const EMAIL_LOOKUP_RATE_WINDOW_MS = 60_000;
const EMAIL_LOOKUP_RATE_MAX_PER_WINDOW = 5n;
const DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS = 60_000;
const DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW = 5n;
const DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS = 15 * 60_000;
const RATE_LIMIT_REPORT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEVICE_KEY_BUNDLE_EXPIRY_MODES = ['expires', 'neverExpires'] as const;
const THREAD_INVITE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
const DeviceKeyBundleExpiryMode = t.enum(
  'DeviceKeyBundleExpiryMode',
  DEVICE_KEY_BUNDLE_EXPIRY_MODES
);
type DeviceKeyBundleExpiryModeValue = {
  tag: (typeof DEVICE_KEY_BUNDLE_EXPIRY_MODES)[number];
};
const DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES: DeviceKeyBundleExpiryModeValue = {
  tag: 'expires',
};
const DEVICE_KEY_BUNDLE_EXPIRY_MODE_NEVER_EXPIRES: DeviceKeyBundleExpiryModeValue = {
  tag: 'neverExpires',
};

const SecretEnvelopeAttachment = t.object('SecretEnvelopeAttachment', {
  recipientPublicIdentity: t.string(),
  recipientEncryptionKeyVersion: t.string(),
  senderEncryptionKeyVersion: t.string(),
  signingKeyVersion: t.string(),
  wrappedSecretCiphertext: t.string(),
  wrappedSecretIv: t.string(),
  wrapAlgorithm: t.string(),
  signature: t.string(),
});

const DeviceKeyBundleAttachment = t.object('DeviceKeyBundleAttachment', {
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

const VisibleInboxRow = t.object('VisibleInboxRow', {
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

const VisibleAgentRow = t.object('VisibleAgentRow', {
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

const VisibleAgentKeyBundleRow = t.object('VisibleAgentKeyBundleRow', {
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

const VisibleDeviceRow = t.object('VisibleDeviceRow', {
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

const VisibleDeviceShareRequestRow = t.object('VisibleDeviceShareRequestRow', {
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

const VisibleDeviceKeyBundleRow = t.object('VisibleDeviceKeyBundleRow', {
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

const VisibleThreadRow = t.object('VisibleThreadRow', {
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

const VisibleThreadParticipantRow = t.object('VisibleThreadParticipantRow', {
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

const VisibleThreadSecretEnvelopeRow = t.object('VisibleThreadSecretEnvelopeRow', {
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

const VisibleMessageRow = t.object('VisibleMessageRow', {
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

const VisibleThreadReadStateRow = t.object('VisibleThreadReadStateRow', {
  id: t.u64(),
  threadId: t.u64(),
  agentDbId: t.u64(),
  lastReadThreadSeq: t.u64().optional(),
  archived: t.bool(),
  updatedAt: t.timestamp(),
});

const VisibleThreadInviteRow = t.object('VisibleThreadInviteRow', {
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

const VisibleContactRequestRow = t.object('VisibleContactRequestRow', {
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

const VisibleContactAllowlistEntryRow = t.object('VisibleContactAllowlistEntryRow', {
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

const PublishedAgentLookupRow = t.object('PublishedAgentLookupRow', {
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

const PublishedPublicRouteRow = t.object('PublishedPublicRouteRow', {
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

const ResolvedDeviceShareRequestRow = t.object('ResolvedDeviceShareRequestRow', {
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

const ClaimedDeviceKeyBundleRow = t.object('ClaimedDeviceKeyBundleRow', {
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

const inboxAuthLeaseExpiryTable = table(
  {
    name: 'inbox_auth_lease_expiry',
    indexes: [
      {
        accessor: 'inbox_auth_lease_expiry_lease_id',
        algorithm: 'btree',
        columns: ['leaseId'],
      },
    ],
    scheduled: (): any => expireInboxAuthLease,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    leaseId: t.u64(),
    ownerIdentity: t.identity(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);

const rateLimitCleanupTable = table(
  {
    name: 'rate_limit_cleanup',
    indexes: [
      {
        accessor: 'rate_limit_cleanup_bucket_key',
        algorithm: 'btree',
        columns: ['bucketKey'],
      },
    ],
    scheduled: (): any => expireRateLimitBucket,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    bucketKey: t.string(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);

const rateLimitReportCleanupTable = table(
  {
    name: 'rate_limit_report_cleanup',
    indexes: [
      {
        accessor: 'rate_limit_report_cleanup_report_id',
        algorithm: 'btree',
        columns: ['reportId'],
      },
    ],
    scheduled: (): any => expireRateLimitReport,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    reportId: t.u64(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);

const deviceKeyBundleExpiryTable = table(
  {
    name: 'device_key_bundle_expiry',
    indexes: [
      {
        accessor: 'device_key_bundle_expiry_bundle_id',
        algorithm: 'btree',
        columns: ['bundleId'],
      },
    ],
    scheduled: (): any => expireDeviceKeyBundle,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    bundleId: t.u64(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  inbox: table(
    {
      name: 'inbox',
      indexes: [
        {
          accessor: 'inbox_auth_subject',
          algorithm: 'btree',
          columns: ['authSubject'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      normalizedEmail: t.string().unique(),
      displayEmail: t.string(),
      ownerIdentity: t.identity().unique(),
      authSubject: t.string(),
      authIssuer: t.string(),
      authIdentityKey: t.string().unique(),
      authVerified: t.bool(),
      emailAttested: t.bool(),
      authVerifiedAt: t.timestamp(),
      authExpiresAt: t.timestamp().optional(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
    }
  ),
  inboxAuthLease: table(
    {
      name: 'inbox_auth_lease',
      indexes: [
        {
          accessor: 'inbox_auth_lease_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      ownerIdentity: t.identity().unique(),
      inboxId: t.u64(),
      authIdentityKey: t.string(),
      normalizedEmail: t.string(),
      authIssuer: t.string(),
      authSubject: t.string(),
      expiresAt: t.timestamp(),
      active: t.bool(),
      updatedAt: t.timestamp(),
    }
  ),
  inboxAuthLeaseExpiry: inboxAuthLeaseExpiryTable,
  agent: table(
    {
      name: 'agent',
      indexes: [
        {
          accessor: 'agent_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'agent_normalized_email',
          algorithm: 'btree',
          columns: ['normalizedEmail'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      inboxId: t.u64(),
      normalizedEmail: t.string(),
      slug: t.string().unique(),
      inboxIdentifier: t.string().optional(),
      isDefault: t.bool(),
      publicIdentity: t.string().unique(),
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
    }
  ),
  agentKeyBundle: table(
    {
      name: 'agent_key_bundle',
      indexes: [
        {
          accessor: 'agent_key_bundle_agent_db_id',
          algorithm: 'btree',
          columns: ['agentDbId'],
        },
        {
          accessor: 'agent_key_bundle_public_identity',
          algorithm: 'btree',
          columns: ['publicIdentity'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      agentDbId: t.u64(),
      publicIdentity: t.string(),
      uniqueKey: t.string().unique(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string(),
      createdAt: t.timestamp(),
    }
  ),
  device: table(
    {
      name: 'device',
      indexes: [
        {
          accessor: 'device_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      deviceId: t.string(),
      inboxId: t.u64(),
      uniqueKey: t.string().unique(),
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
    }
  ),
  deviceShareRequest: table(
    {
      name: 'device_share_request',
      indexes: [
        {
          accessor: 'device_share_request_device_id',
          algorithm: 'btree',
          columns: ['deviceId'],
        },
        {
          accessor: 'device_share_request_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'device_share_request_verification_code_hash',
          algorithm: 'btree',
          columns: ['verificationCodeHash'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      deviceId: t.string(),
      inboxId: t.u64(),
      verificationCodeHash: t.string(),
      clientCreatedAt: t.timestamp(),
      expiresAt: t.timestamp(),
      createdAt: t.timestamp(),
      approvedAt: t.timestamp().optional(),
      consumedAt: t.timestamp().optional(),
    }
  ),
  deviceKeyBundle: table(
    {
      name: 'device_key_bundle',
      indexes: [
        {
          accessor: 'device_key_bundle_target_device_id',
          algorithm: 'btree',
          columns: ['targetDeviceId'],
        },
        {
          accessor: 'device_key_bundle_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      targetDeviceId: t.string(),
      inboxId: t.u64(),
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
      consumedAt: t.timestamp().optional(),
      expiryMode: DeviceKeyBundleExpiryMode.default(DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES),
    }
  ),
  deviceKeyBundleExpiry: deviceKeyBundleExpiryTable,
  thread: table(
    {
      name: 'thread',
      indexes: [
        {
          accessor: 'thread_dedupe_key',
          algorithm: 'btree',
          columns: ['dedupeKey'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
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
    }
  ),
  directThreadIndex: table(
    {
      name: 'direct_thread_index',
      indexes: [
        {
          accessor: 'direct_thread_index_direct_key',
          algorithm: 'btree',
          columns: ['directKey'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      directKey: t.string(),
      threadId: t.u64().unique(),
      createdAt: t.timestamp(),
    }
  ),
  threadParticipant: table(
    {
      name: 'thread_participant',
      indexes: [
        {
          accessor: 'thread_participant_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'thread_participant_agent_db_id',
          algorithm: 'btree',
          columns: ['agentDbId'],
        },
        {
          accessor: 'thread_participant_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      agentDbId: t.u64(),
      inboxId: t.u64(),
      uniqueKey: t.string().unique(),
      joinedAt: t.timestamp(),
      lastSentSeq: t.u64(),
      lastSentMembershipVersion: t.u64().optional(),
      lastSentSecretVersion: t.string().optional(),
      isAdmin: t.bool(),
      active: t.bool(),
    }
  ),
  threadSecretEnvelope: table(
    {
      name: 'thread_secret_envelope',
      indexes: [
        {
          accessor: 'thread_secret_envelope_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'thread_secret_envelope_recipient_agent_db_id',
          algorithm: 'btree',
          columns: ['recipientAgentDbId'],
        },
        {
          accessor: 'thread_secret_envelope_sender_agent_db_id',
          algorithm: 'btree',
          columns: ['senderAgentDbId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      membershipVersion: t.u64(),
      secretVersion: t.string(),
      senderAgentDbId: t.u64(),
      recipientAgentDbId: t.u64(),
      uniqueKey: t.string().unique(),
      senderEncryptionKeyVersion: t.string(),
      recipientEncryptionKeyVersion: t.string(),
      signingKeyVersion: t.string(),
      wrappedSecretCiphertext: t.string(),
      wrappedSecretIv: t.string(),
      wrapAlgorithm: t.string(),
      signature: t.string(),
      createdAt: t.timestamp(),
    }
  ),
  message: table(
    {
      name: 'message',
      indexes: [
        {
          accessor: 'message_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'message_sender_agent_db_id',
          algorithm: 'btree',
          columns: ['senderAgentDbId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      threadSeq: t.u64(),
      threadSeqKey: t.string().unique(),
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
    }
  ),
  threadReadState: table(
    {
      name: 'thread_read_state',
      indexes: [
        {
          accessor: 'thread_read_state_agent_db_id',
          algorithm: 'btree',
          columns: ['agentDbId'],
        },
        {
          accessor: 'thread_read_state_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      agentDbId: t.u64(),
      uniqueKey: t.string().unique(),
      lastReadThreadSeq: t.u64().optional(),
      archived: t.bool(),
      updatedAt: t.timestamp(),
    }
  ),
  threadInvite: table(
    {
      name: 'thread_invite',
      indexes: [
        {
          accessor: 'thread_invite_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'thread_invite_invitee_agent_db_id',
          algorithm: 'btree',
          columns: ['inviteeAgentDbId'],
        },
        {
          accessor: 'thread_invite_invitee_inbox_id',
          algorithm: 'btree',
          columns: ['inviteeInboxId'],
        },
        {
          accessor: 'thread_invite_inviter_agent_db_id',
          algorithm: 'btree',
          columns: ['inviterAgentDbId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      inviterAgentDbId: t.u64(),
      inviteeAgentDbId: t.u64(),
      inviteeInboxId: t.u64(),
      uniqueKey: t.string().unique(),
      status: t.string(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      resolvedAt: t.timestamp().optional(),
      resolvedByAgentDbId: t.u64().optional(),
    }
  ),
  contactRequest: table(
    {
      name: 'contact_request',
      indexes: [
        {
          accessor: 'contact_request_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'contact_request_requester_agent_db_id',
          algorithm: 'btree',
          columns: ['requesterAgentDbId'],
        },
        {
          accessor: 'contact_request_target_agent_db_id',
          algorithm: 'btree',
          columns: ['targetAgentDbId'],
        },
        {
          accessor: 'contact_request_status',
          algorithm: 'btree',
          columns: ['status'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      requesterAgentDbId: t.u64(),
      requesterPublicIdentity: t.string(),
      requesterSlug: t.string(),
      requesterDisplayName: t.string().optional(),
      requesterNormalizedEmail: t.string(),
      requesterDisplayEmail: t.string(),
      targetAgentDbId: t.u64(),
      targetPublicIdentity: t.string(),
      targetSlug: t.string(),
      targetDisplayName: t.string().optional(),
      status: t.enum('ContactRequestStatus', CONTACT_REQUEST_STATUSES),
      hiddenMessageCount: t.u64(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      resolvedAt: t.timestamp().optional(),
      resolvedByAgentDbId: t.u64().optional(),
    }
  ),
  rateLimit: table(
    {
      name: 'rate_limit',
    },
    {
      id: t.u64().primaryKey().autoInc(),
      bucketKey: t.string().unique(),
      action: t.string(),
      ownerIdentity: t.identity(),
      windowStart: t.timestamp(),
      expiresAt: t.timestamp(),
      count: t.u64(),
      limitedCount: t.u64(),
      firstLimitedAt: t.timestamp().optional(),
      lastLimitedAt: t.timestamp().optional(),
      updatedAt: t.timestamp(),
    }
  ),
  rateLimitCleanup: rateLimitCleanupTable,
  rateLimitReport: table(
    {
      name: 'rate_limit_report',
      indexes: [
        {
          accessor: 'rate_limit_report_bucket_key',
          algorithm: 'btree',
          columns: ['bucketKey'],
        },
        {
          accessor: 'rate_limit_report_owner_identity',
          algorithm: 'btree',
          columns: ['ownerIdentity'],
        },
        {
          accessor: 'rate_limit_report_action',
          algorithm: 'btree',
          columns: ['action'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      reportKey: t.string().unique(),
      bucketKey: t.string(),
      action: t.string(),
      ownerIdentity: t.identity(),
      windowStart: t.timestamp(),
      windowExpiresAt: t.timestamp(),
      allowedCount: t.u64(),
      limitedCount: t.u64(),
      firstLimitedAt: t.timestamp().optional(),
      lastLimitedAt: t.timestamp().optional(),
      reportedAt: t.timestamp(),
      expiresAt: t.timestamp(),
    }
  ),
  rateLimitReportCleanup: rateLimitReportCleanupTable,
  contactAllowlistEntry: table(
    {
      name: 'contact_allowlist_entry',
      indexes: [
        {
          accessor: 'contact_allowlist_entry_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'contact_allowlist_entry_agent_public_identity',
          algorithm: 'btree',
          columns: ['agentPublicIdentity'],
        },
        {
          accessor: 'contact_allowlist_entry_normalized_email',
          algorithm: 'btree',
          columns: ['normalizedEmail'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      inboxId: t.u64(),
      kind: t.enum('ContactAllowlistKind', CONTACT_ALLOWLIST_KINDS),
      uniqueKey: t.string().unique(),
      agentPublicIdentity: t.string().optional(),
      agentSlug: t.string().optional(),
      agentDisplayName: t.string().optional(),
      normalizedEmail: t.string().optional(),
      displayEmail: t.string().optional(),
      createdByAgentDbId: t.u64(),
      createdAt: t.timestamp(),
    }
  ),
});

export default spacetimedb;

type OidcIdentityClaims = {
  normalizedEmail: string;
  displayEmail: string;
  subject: string;
  issuer: string;
  displayName?: string;
  expiresAt?: Timestamp;
};

type ModuleCtx = Parameters<typeof createInboxIdentity>[0];
type InboxRow = NonNullable<ReturnType<ModuleCtx['db']['inbox']['id']['find']>>;
type ActorRow = NonNullable<ReturnType<ModuleCtx['db']['agent']['id']['find']>>;
type DeviceRow = NonNullable<ReturnType<ModuleCtx['db']['device']['id']['find']>>;
type DeviceShareRequestRow = NonNullable<
  ReturnType<ModuleCtx['db']['deviceShareRequest']['id']['find']>
>;
type DeviceKeyBundleRow = NonNullable<
  ReturnType<ModuleCtx['db']['deviceKeyBundle']['id']['find']>
>;
type InboxAuthLeaseRow = NonNullable<ReturnType<ModuleCtx['db']['inboxAuthLease']['id']['find']>>;
type RateLimitRow = NonNullable<ReturnType<ModuleCtx['db']['rateLimit']['id']['find']>>;
type RateLimitReportRow = NonNullable<ReturnType<ModuleCtx['db']['rateLimitReport']['id']['find']>>;
type ThreadRow = NonNullable<ReturnType<ModuleCtx['db']['thread']['id']['find']>>;
type DirectThreadIndexRow = NonNullable<
  ReturnType<ModuleCtx['db']['directThreadIndex']['id']['find']>
>;
type ThreadParticipantRow = NonNullable<
  ReturnType<ModuleCtx['db']['threadParticipant']['id']['find']>
>;
type ThreadSecretEnvelopeRow = NonNullable<
  ReturnType<ModuleCtx['db']['threadSecretEnvelope']['id']['find']>
>;
type MessageRow = NonNullable<ReturnType<ModuleCtx['db']['message']['id']['find']>>;
type ThreadReadStateRow = NonNullable<ReturnType<ModuleCtx['db']['threadReadState']['id']['find']>>;
type ThreadInviteRow = NonNullable<ReturnType<ModuleCtx['db']['threadInvite']['id']['find']>>;
type ContactRequestRow = NonNullable<
  ReturnType<ModuleCtx['db']['contactRequest']['id']['find']>
>;
type ContactAllowlistEntryRow = NonNullable<
  ReturnType<ModuleCtx['db']['contactAllowlistEntry']['id']['find']>
>;
type StripMutators<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? {
        [K in keyof T as K extends 'insert' | 'update' | 'delete' ? never : K]: StripMutators<
          T[K]
        >;
      }
    : T;
type ReadDbCtx = {
  sender: ModuleCtx['sender'];
  db: {
    [K in keyof ModuleCtx['db']]: StripMutators<ModuleCtx['db'][K]>;
  };
};
type ReadAuthCtx = ReadDbCtx & Pick<ModuleCtx, 'senderAuth' | 'timestamp'>;
type MaybeReadAuthCtx = ReadDbCtx & Partial<Pick<ModuleCtx, 'senderAuth'>>;
type DeviceReadDbCtx = ReadDbCtx;
type DeviceReadAuthCtx = ReadAuthCtx;

function normalizeEmail(value: string): string {
  return requireNonEmpty(normalizeSharedEmail(value), 'email');
}

function normalizeCustomInboxSlug(value: string, normalizedEmail: string): string {
  const normalizedSlug = requireNonEmpty(normalizeInboxSlug(value), 'slug');
  if (isReservedInboxSlug(normalizedSlug)) {
    throw new SenderError('slug is reserved');
  }
  if (inboxSlugContainsEmailToken(normalizedSlug, normalizedEmail)) {
    throw new SenderError('slug must not contain the email token');
  }
  return normalizedSlug;
}

function normalizeExplicitDefaultInboxSlug(value: string): string {
  const normalizedSlug = requireNonEmpty(normalizeInboxSlug(value), 'defaultSlug');
  if (isReservedInboxSlug(normalizedSlug)) {
    throw new SenderError('defaultSlug is reserved');
  }
  return normalizedSlug;
}

function buildPublicIdentity(slug: string): string {
  return requireNonEmpty(normalizeInboxSlug(slug), 'publicIdentity');
}

function normalizePublicIdentity(value: string): string {
  return requireNonEmpty(normalizeInboxSlug(value), 'publicIdentity');
}

function buildDefaultSlug(ctx: ModuleCtx, normalizedEmail: string): string {
  try {
    return buildPreferredDefaultInboxSlug(normalizedEmail, slug => Boolean(getActorBySlug(ctx, slug)));
  } catch (error) {
    throw new SenderError(
      error instanceof Error ? error.message : 'Unable to generate an available default slug'
    );
  }
}

function requireAvailableSlug(
  ctx: ModuleCtx,
  slug: string,
  options?: { allowActorId?: bigint }
): string {
  const existing = getActorBySlug(ctx, slug);
  if (existing && existing.id !== options?.allowActorId) {
    throw new SenderError('slug is already registered');
  }
  return slug;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SenderError(`${field} is required`);
  return trimmed;
}

function requireMaxLength(value: string, maxLength: number, field: string): string {
  if (value.length > maxLength) {
    throw new SenderError(`${field} must be ${maxLength.toString()} characters or fewer`);
  }
  return value;
}

function requireHexMaxLength(value: string, maxLength: number, field: string): string {
  const normalized = requireNonEmpty(value, field);
  requireMaxLength(normalized, maxLength, field);
  if (normalized.length % 2 !== 0 || !HEX_PATTERN.test(normalized)) {
    throw new SenderError(`${field} must be even-length hexadecimal`);
  }
  return normalized;
}

function normalizePublicKey(value: string, field: string): string {
  const normalized = requireNonEmpty(value, field);
  requireMaxLength(normalized, MAX_PUBLIC_KEY_CHARS, field);
  return normalized;
}

function normalizeOptionalDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_DISPLAY_NAME_CHARS, 'displayName');
  return normalized;
}

function normalizeOptionalThreadTitle(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_THREAD_TITLE_CHARS, 'title');
  return normalized;
}

function requireValidEmail(value: string, field: string): string {
  const normalized = normalizeEmail(value);
  if (!normalized.includes('@') || normalized.startsWith('@') || normalized.endsWith('@')) {
    throw new SenderError(`${field} must be a valid email`);
  }
  return normalized;
}

function compareTimestamp(left: Timestamp, right: Timestamp): number {
  if (left.microsSinceUnixEpoch < right.microsSinceUnixEpoch) return -1;
  if (left.microsSinceUnixEpoch > right.microsSinceUnixEpoch) return 1;
  return 0;
}

function isTimestampExpired(expiresAt: Timestamp, now: Timestamp): boolean {
  return compareTimestamp(expiresAt, now) <= 0;
}

function durationMillisecondsToMicros(milliseconds: number): bigint {
  return BigInt(milliseconds) * 1000n;
}

function timestampPlusMilliseconds(value: Timestamp, milliseconds: number): Timestamp {
  return new Timestamp(
    value.microsSinceUnixEpoch + durationMillisecondsToMicros(milliseconds)
  );
}

function requireClaimableDeviceKeyBundleExpiry(now: Timestamp, expiresAt: Timestamp): void {
  if (compareTimestamp(expiresAt, now) <= 0) {
    throw new SenderError('Device key bundle expiresAt must be in the future');
  }

  const latestAllowedExpiry = timestampPlusMilliseconds(
    now,
    DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS
  );
  if (compareTimestamp(expiresAt, latestAllowedExpiry) > 0) {
    throw new SenderError('Device key bundle expiresAt is too far in the future');
  }
}

function cancelRateLimitCleanupSchedules(
  dbCtx: { db: ModuleCtx['db'] },
  bucketKey: string
): void {
  for (const cleanup of Array.from(
    dbCtx.db.rateLimitCleanup.rate_limit_cleanup_bucket_key.filter(bucketKey)
  )) {
    dbCtx.db.rateLimitCleanup.delete(cleanup);
  }
}

function scheduleRateLimitCleanup(
  dbCtx: { db: ModuleCtx['db'] },
  bucketKey: string,
  expiresAt: Timestamp,
  now: Timestamp
): void {
  cancelRateLimitCleanupSchedules(dbCtx, bucketKey);
  dbCtx.db.rateLimitCleanup.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(expiresAt.microsSinceUnixEpoch),
    bucketKey,
    expiresAt,
    createdAt: now,
  });
}

function buildRateLimitReportKey(
  bucketKey: string,
  windowStart: Timestamp,
  windowExpiresAt: Timestamp
): string {
  return `${bucketKey}\u0000${windowStart.microsSinceUnixEpoch.toString()}\u0000${windowExpiresAt.microsSinceUnixEpoch.toString()}`;
}

function cancelRateLimitReportCleanupSchedules(
  dbCtx: { db: ModuleCtx['db'] },
  reportId: bigint
): void {
  for (const cleanup of Array.from(
    dbCtx.db.rateLimitReportCleanup.rate_limit_report_cleanup_report_id.filter(reportId)
  )) {
    dbCtx.db.rateLimitReportCleanup.delete(cleanup);
  }
}

function scheduleRateLimitReportCleanup(
  dbCtx: { db: ModuleCtx['db'] },
  report: RateLimitReportRow,
  now: Timestamp
): void {
  cancelRateLimitReportCleanupSchedules(dbCtx, report.id);
  dbCtx.db.rateLimitReportCleanup.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(report.expiresAt.microsSinceUnixEpoch),
    reportId: report.id,
    expiresAt: report.expiresAt,
    createdAt: now,
  });
}

function reportRateLimitBucket(
  dbCtx: { db: ModuleCtx['db'] },
  bucket: RateLimitRow,
  reportedAt: Timestamp
): void {
  if (bucket.limitedCount === 0n) {
    return;
  }

  const reportKey = buildRateLimitReportKey(
    bucket.bucketKey,
    bucket.windowStart,
    bucket.expiresAt
  );
  const reportExpiresAt = timestampPlusMilliseconds(reportedAt, RATE_LIMIT_REPORT_RETENTION_MS);
  const existing = dbCtx.db.rateLimitReport.reportKey.find(reportKey);
  const report = existing
    ? dbCtx.db.rateLimitReport.id.update({
        ...existing,
        allowedCount: bucket.count,
        limitedCount: bucket.limitedCount,
        firstLimitedAt: bucket.firstLimitedAt,
        lastLimitedAt: bucket.lastLimitedAt,
        reportedAt,
        expiresAt: reportExpiresAt,
      })
    : dbCtx.db.rateLimitReport.insert({
        id: 0n,
        reportKey,
        bucketKey: bucket.bucketKey,
        action: bucket.action,
        ownerIdentity: bucket.ownerIdentity,
        windowStart: bucket.windowStart,
        windowExpiresAt: bucket.expiresAt,
        allowedCount: bucket.count,
        limitedCount: bucket.limitedCount,
        firstLimitedAt: bucket.firstLimitedAt,
        lastLimitedAt: bucket.lastLimitedAt,
        reportedAt,
        expiresAt: reportExpiresAt,
      });

  scheduleRateLimitReportCleanup(dbCtx, report, reportedAt);
}

function enforceRateLimit(
  dbCtx: { db: ModuleCtx['db'] },
  params: {
    bucketKey: string;
    action: string;
    ownerIdentity: ModuleCtx['sender'];
    now: Timestamp;
    windowMs: number;
    maxCount: bigint;
  }
): boolean {
  const { bucketKey, action, ownerIdentity, now, windowMs, maxCount } = params;
  const existing = dbCtx.db.rateLimit.bucketKey.find(bucketKey);
  const expiresAt = timestampPlusMilliseconds(now, windowMs);
  if (!existing) {
    dbCtx.db.rateLimit.insert({
      id: 0n,
      bucketKey,
      action,
      ownerIdentity,
      windowStart: now,
      expiresAt,
      count: 1n,
      limitedCount: 0n,
      firstLimitedAt: undefined,
      lastLimitedAt: undefined,
      updatedAt: now,
    });
    scheduleRateLimitCleanup(dbCtx, bucketKey, expiresAt, now);
    return true;
  }

  if (isTimestampExpired(existing.expiresAt, now)) {
    reportRateLimitBucket(dbCtx, existing, now);
    dbCtx.db.rateLimit.id.update({
      ...existing,
      action,
      ownerIdentity,
      windowStart: now,
      expiresAt,
      count: 1n,
      limitedCount: 0n,
      firstLimitedAt: undefined,
      lastLimitedAt: undefined,
      updatedAt: now,
    });
    scheduleRateLimitCleanup(dbCtx, bucketKey, expiresAt, now);
    return true;
  }

  if (existing.count >= maxCount) {
    dbCtx.db.rateLimit.id.update({
      ...existing,
      action,
      ownerIdentity,
      limitedCount: existing.limitedCount + 1n,
      firstLimitedAt: existing.firstLimitedAt ?? now,
      lastLimitedAt: now,
      updatedAt: now,
    });
    return false;
  }
  dbCtx.db.rateLimit.id.update({
    ...existing,
    action,
    ownerIdentity,
    count: existing.count + 1n,
    updatedAt: now,
  });
  return true;
}

function normalizeDeviceId(value: string): string {
  const normalized = requireNonEmpty(value, 'deviceId');
  requireMaxLength(normalized, MAX_DEVICE_ID_CHARS, 'deviceId');
  return normalized;
}

function normalizeOptionalDeviceLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_DEVICE_LABEL_CHARS, 'label');
  return normalized;
}

function normalizeOptionalPlatform(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_DEVICE_PLATFORM_CHARS, 'platform');
  return normalized;
}

function normalizeDeviceStatus(value: string): string {
  const normalized = requireNonEmpty(value, 'status');
  requireMaxLength(normalized, MAX_DEVICE_STATUS_CHARS, 'status');
  return normalized;
}

function normalizeAlgorithm(value: string, field: string): string {
  const normalized = requireNonEmpty(value, field);
  requireMaxLength(normalized, MAX_MESSAGE_ALGORITHM_CHARS, field);
  return normalized;
}

function normalizeOptionalAlgorithm(
  value: string | undefined,
  fallback: string,
  field: string
): string {
  return normalizeAlgorithm(value?.trim() ? value.trim() : fallback, field);
}

function normalizeOptionalMasumiNetwork(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_MASUMI_NETWORK_CHARS, 'masumiRegistrationNetwork');
  return normalized;
}

function normalizeOptionalMasumiRegistrationId(
  value: string | undefined,
  field: 'masumiInboxAgentId' | 'masumiAgentIdentifier'
): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(
    normalized,
    field === 'masumiInboxAgentId'
      ? MAX_MASUMI_REGISTRATION_ID_CHARS
      : MAX_MASUMI_AGENT_IDENTIFIER_CHARS,
    field
  );
  return normalized;
}

function normalizeOptionalMasumiRegistrationState(
  value: string | undefined
): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_MASUMI_REGISTRATION_STATE_CHARS, 'masumiRegistrationState');
  return normalized;
}

function normalizeOptionalPublicDescription(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_PUBLIC_DESCRIPTION_CHARS, 'publicDescription');
  return normalized;
}

function normalizeContactRequestStatus(value: string): { tag: (typeof CONTACT_REQUEST_STATUSES)[number] } {
  const normalized = requireNonEmpty(value, 'contactRequestStatus');
  requireMaxLength(normalized, MAX_CONTACT_REQUEST_STATUS_CHARS, 'contactRequestStatus');
  if (!CONTACT_REQUEST_STATUSES.includes(normalized as (typeof CONTACT_REQUEST_STATUSES)[number])) {
    throw new SenderError('contactRequestStatus is invalid');
  }
  return { tag: normalized as (typeof CONTACT_REQUEST_STATUSES)[number] };
}

function normalizeContactAllowlistKind(value: string): { tag: (typeof CONTACT_ALLOWLIST_KINDS)[number] } {
  const normalized = requireNonEmpty(value, 'contactAllowlistKind');
  requireMaxLength(normalized, MAX_CONTACT_ALLOWLIST_KIND_CHARS, 'contactAllowlistKind');
  if (!CONTACT_ALLOWLIST_KINDS.includes(normalized as (typeof CONTACT_ALLOWLIST_KINDS)[number])) {
    throw new SenderError('contactAllowlistKind is invalid');
  }
  return { tag: normalized as (typeof CONTACT_ALLOWLIST_KINDS)[number] };
}

function normalizeThreadInviteStatus(value: string) {
  const normalized = requireNonEmpty(value, 'threadInviteStatus');
  requireMaxLength(normalized, MAX_CONTACT_REQUEST_STATUS_CHARS, 'threadInviteStatus');
  if (!THREAD_INVITE_STATUSES.includes(normalized as (typeof THREAD_INVITE_STATUSES)[number])) {
    throw new SenderError('threadInviteStatus is invalid');
  }
  return normalized as (typeof THREAD_INVITE_STATUSES)[number];
}

function requireMaxArrayLength<T>(values: readonly T[], maxLength: number, field: string): void {
  if (values.length > maxLength) {
    throw new SenderError(`${field} may include at most ${maxLength.toString()} items`);
  }
}

function normalizeVerificationCodeHash(value: string): string {
  const normalized = requireNonEmpty(value, 'verificationCodeHash');
  requireMaxLength(
    normalized,
    MAX_DEVICE_VERIFICATION_CODE_HASH_CHARS,
    'verificationCodeHash'
  );
  return normalized;
}

function readStringClaim(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBooleanClaim(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function readNumericClaim(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function requireOidcIdentityClaims(ctx: ReadAuthCtx): OidcIdentityClaims {
  const jwt = ctx.senderAuth.jwt;
  if (!jwt) {
    throw new SenderError('OIDC authentication is required before this action');
  }

  if (!TRUSTED_OIDC_ISSUERS.has(jwt.issuer)) {
    throw new SenderError('Unauthorized issuer');
  }

  if (!jwt.audience.some(audience => TRUSTED_OIDC_AUDIENCES.has(audience as never))) {
    throw new SenderError('Unauthorized audience');
  }

  const payload = jwt.fullPayload as Record<string, unknown>;
  const displayEmail = requireNonEmpty(
    readStringClaim(payload, 'email') ?? '',
    'jwt.email'
  );
  if (!readBooleanClaim(payload, 'email_verified')) {
    throw new SenderError('OIDC token requires email_verified=true');
  }

  const exp = readNumericClaim(payload, 'exp');
  if (exp === undefined) {
    throw new SenderError('OIDC token exp claim is required');
  }
  const expiresAt = Timestamp.fromDate(new Date(exp * 1000));
  if (isTimestampExpired(expiresAt, ctx.timestamp)) {
    throw new SenderError('OIDC token is expired');
  }

  return {
    normalizedEmail: requireValidEmail(displayEmail, 'jwt.email'),
    displayEmail,
    subject: requireNonEmpty(jwt.subject, 'jwt.sub'),
    issuer: requireNonEmpty(jwt.issuer, 'jwt.iss'),
    displayName: readStringClaim(payload, 'name'),
    expiresAt,
  };
}

function getInboxes(ctx: ReadDbCtx) {
  return Array.from(ctx.db.inbox.iter()) as Array<ReturnType<typeof getRequiredInboxById>>;
}

function getActors(ctx: ReadDbCtx) {
  return Array.from(ctx.db.agent.iter()) as Array<ReturnType<typeof getRequiredActorByDbId>>;
}

function getDevices(ctx: DeviceReadDbCtx) {
  return Array.from(ctx.db.device.iter()) as Array<ReturnType<typeof getRequiredDeviceByRowId>>;
}

function getDevicesByInboxId(ctx: DeviceReadDbCtx, inboxId: bigint) {
  return Array.from(ctx.db.device.device_inbox_id.filter(inboxId));
}

function getDeviceShareRequests(ctx: DeviceReadDbCtx) {
  return Array.from(ctx.db.deviceShareRequest.iter()) as Array<
    ReturnType<typeof getRequiredDeviceShareRequestByRowId>
  >;
}

function getDeviceKeyBundles(ctx: DeviceReadDbCtx) {
  return Array.from(ctx.db.deviceKeyBundle.iter()) as Array<
    ReturnType<typeof getRequiredDeviceKeyBundleByRowId>
  >;
}

function getContactAllowlistEntriesByInboxId(ctx: ReadDbCtx, inboxId: bigint) {
  return Array.from(ctx.db.contactAllowlistEntry.contact_allowlist_entry_inbox_id.filter(inboxId));
}

function firstMatchingRow<Row>(rows: Iterable<Row>): Row | null {
  for (const row of rows) {
    return row;
  }
  return null;
}

function dedupeRowsById<Row extends { id: bigint }>(rows: Iterable<Row>): Row[] {
  const deduped = new Map<string, Row>();
  for (const row of rows) {
    deduped.set(row.id.toString(), row);
  }
  return Array.from(deduped.values());
}

function getInboxByNormalizedEmail(ctx: ReadDbCtx, normalizedEmail: string) {
  return ctx.db.inbox.normalizedEmail.find(normalizedEmail);
}

function getInboxByOwnerIdentity(ctx: ReadDbCtx) {
  return ctx.db.inbox.ownerIdentity.find(ctx.sender);
}

function buildInboxAuthIdentityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

function requireFutureOidcExpiry(ctx: ModuleCtx, oidcClaims: OidcIdentityClaims): Timestamp {
  if (!oidcClaims.expiresAt) {
    throw new SenderError('OIDC token exp claim is required');
  }
  if (isTimestampExpired(oidcClaims.expiresAt, ctx.timestamp)) {
    throw new SenderError('OIDC token is expired');
  }
  return oidcClaims.expiresAt;
}

function cancelInboxAuthLeaseExpirySchedules(ctx: ModuleCtx, leaseId: bigint) {
  for (const expiry of Array.from(
    ctx.db.inboxAuthLeaseExpiry.inbox_auth_lease_expiry_lease_id.filter(leaseId)
  )) {
    ctx.db.inboxAuthLeaseExpiry.delete(expiry);
  }
}

function scheduleInboxAuthLeaseExpiry(ctx: ModuleCtx, lease: InboxAuthLeaseRow) {
  cancelInboxAuthLeaseExpirySchedules(ctx, lease.id);
  ctx.db.inboxAuthLeaseExpiry.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(lease.expiresAt.microsSinceUnixEpoch),
    leaseId: lease.id,
    ownerIdentity: lease.ownerIdentity,
    expiresAt: lease.expiresAt,
    createdAt: ctx.timestamp,
  });
}

function deactivateInboxAuthLease(ctx: ModuleCtx, lease: InboxAuthLeaseRow) {
  cancelInboxAuthLeaseExpirySchedules(ctx, lease.id);
  if (!lease.active) {
    return;
  }
  ctx.db.inboxAuthLease.id.update({
    ...lease,
    active: false,
    updatedAt: ctx.timestamp,
  });
}

function deactivateSenderInboxAuthLease(ctx: ModuleCtx) {
  const lease = ctx.db.inboxAuthLease.ownerIdentity.find(ctx.sender);
  if (!lease) {
    return;
  }
  deactivateInboxAuthLease(ctx, lease);
}

const EXPECTED_INBOX_AUTH_LEASE_REFRESH_ERRORS = new Set([
  'OIDC authentication is required before this action',
  'Unauthorized issuer',
  'Unauthorized audience',
  'jwt.email is required',
  'jwt.email must be a valid email',
  'jwt.sub is required',
  'jwt.iss is required',
  'OIDC token requires email_verified=true',
  'OIDC token exp claim is required',
  'OIDC token is expired',
  'Current OIDC session is not authorized for this inbox',
  'Current OIDC session email does not match this inbox namespace',
  'Inbox auth verification is required before this action',
]);

function isExpectedInboxAuthLeaseRefreshError(error: unknown): boolean {
  return (
    error instanceof SenderError && EXPECTED_INBOX_AUTH_LEASE_REFRESH_ERRORS.has(error.message)
  );
}

function upsertInboxAuthLease(
  ctx: ModuleCtx,
  inbox: InboxRow,
  oidcClaims: OidcIdentityClaims
) {
  if (inbox.authIssuer !== oidcClaims.issuer || inbox.authSubject !== oidcClaims.subject) {
    throw new SenderError('Current OIDC session is not authorized for this inbox');
  }
  if (inbox.normalizedEmail !== oidcClaims.normalizedEmail) {
    throw new SenderError('Current OIDC session email does not match this inbox namespace');
  }

  const expiresAt = requireFutureOidcExpiry(ctx, oidcClaims);
  const authIdentityKey = buildInboxAuthIdentityKey(oidcClaims.issuer, oidcClaims.subject);
  const existing = ctx.db.inboxAuthLease.ownerIdentity.find(ctx.sender);

  const lease = existing
    ? ctx.db.inboxAuthLease.id.update({
        ...existing,
        inboxId: inbox.id,
        authIdentityKey,
        normalizedEmail: inbox.normalizedEmail,
        authIssuer: oidcClaims.issuer,
        authSubject: oidcClaims.subject,
        expiresAt,
        active: true,
        updatedAt: ctx.timestamp,
      })
    : ctx.db.inboxAuthLease.insert({
        id: 0n,
        ownerIdentity: ctx.sender,
        inboxId: inbox.id,
        authIdentityKey,
        normalizedEmail: inbox.normalizedEmail,
        authIssuer: oidcClaims.issuer,
        authSubject: oidcClaims.subject,
        expiresAt,
        active: true,
        updatedAt: ctx.timestamp,
      });

  if (!isTimestampExpired(lease.expiresAt, ctx.timestamp)) {
    scheduleInboxAuthLeaseExpiry(ctx, lease);
    return lease;
  }
  throw new SenderError('OIDC token is expired');
}

function refreshInboxAuthLeaseForInbox(ctx: ModuleCtx, inbox: InboxRow) {
  const oidcClaims = requireOidcIdentityClaims(ctx);
  requireInboxMatchesOidcClaims(inbox, oidcClaims);
  requireVerifiedInbox(inbox);
  const lease = upsertInboxAuthLease(ctx, inbox, oidcClaims);
  reconcileDeviceKeyBundleExpiryState(ctx, inbox.id, ctx.timestamp);
  return lease;
}

function getActiveInboxAuthLease(ctx: ReadDbCtx, inbox: InboxRow) {
  const lease = ctx.db.inboxAuthLease.ownerIdentity.find(ctx.sender);
  if (!lease || !lease.active) {
    return null;
  }
  if (lease.inboxId !== inbox.id) {
    return null;
  }
  // Expiry is enforced by the scheduled `expireInboxAuthLease` reducer flipping
  // `active = false`. Views cannot access wall-clock time (no `ctx.timestamp`)
  // and must remain deterministic — do not call `Timestamp.now()` here.
  if (
    lease.authIdentityKey !== buildInboxAuthIdentityKey(inbox.authIssuer, inbox.authSubject) ||
    lease.normalizedEmail !== inbox.normalizedEmail ||
    lease.authIssuer !== inbox.authIssuer ||
    lease.authSubject !== inbox.authSubject
  ) {
    return null;
  }
  return lease;
}

function buildThreadParticipantKey(threadId: bigint, agentDbId: bigint): string {
  return `${threadId.toString()}:${agentDbId.toString()}`;
}

function buildMessageThreadSeqKey(threadId: bigint, threadSeq: bigint): string {
  return `${threadId.toString()}:${threadSeq.toString()}`;
}

function buildThreadReadStateKey(threadId: bigint, agentDbId: bigint): string {
  return `${threadId.toString()}:${agentDbId.toString()}`;
}

function buildThreadInviteKey(threadId: bigint, inviteeAgentDbId: bigint): string {
  return `${threadId.toString()}:${inviteeAgentDbId.toString()}`;
}

function buildThreadSecretEnvelopeKey(
  threadId: bigint,
  membershipVersion: bigint,
  secretVersion: string,
  senderAgentDbId: bigint,
  recipientAgentDbId: bigint
): string {
  return `${threadId.toString()}:${membershipVersion.toString()}:${secretVersion}:${senderAgentDbId.toString()}:${recipientAgentDbId.toString()}`;
}

function buildSenderSecretVisibilityKey(
  membershipVersion: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
): string {
  return `${membershipVersion.toString()}:${senderAgentDbId.toString()}:${secretVersion}`;
}

function buildAgentKeyBundleKey(
  agentDbId: bigint,
  encryptionKeyVersion: string,
  signingKeyVersion: string
): string {
  return `${agentDbId.toString()}:${encryptionKeyVersion}:${signingKeyVersion}`;
}

function buildContactAllowlistEntryKey(
  inboxId: bigint,
  kind: string,
  agentPublicIdentity: string | undefined,
  normalizedEmail: string | undefined
): string {
  return `${inboxId.toString()}:${kind}:${agentPublicIdentity ?? ''}:${normalizedEmail ?? ''}`;
}

function buildDeviceKey(inboxId: bigint, deviceId: string): string {
  return `${inboxId.toString()}:${deviceId.length.toString()}:${deviceId}`;
}

function getDefaultInboxIdentity(ctx: ReadDbCtx, inboxId: bigint) {
  return getActorsByInboxId(ctx, inboxId).find(actor => actor.isDefault);
}

function getActorBySlug(ctx: ReadDbCtx, slug: string) {
  return ctx.db.agent.slug.find(slug);
}

function getActorsByInboxId(ctx: ReadDbCtx, inboxId: bigint) {
  return Array.from(ctx.db.agent.agent_inbox_id.filter(inboxId));
}

function getOwnActorIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  return new Set(getActorsByInboxId(ctx, inboxId).map(actor => actor.id));
}

function getPublicActorsByNormalizedEmail(ctx: ReadDbCtx, normalizedEmail: string) {
  const inbox = getInboxByNormalizedEmail(ctx, normalizedEmail);
  if (!inbox) {
    return [];
  }

  return getActorsByInboxId(ctx, inbox.id)
    .filter(actor => actor.publicLinkedEmailEnabled)
    .sort(comparePublishedActorRows);
}

function getActorByPublicIdentity(ctx: ReadDbCtx, publicIdentity: string) {
  return ctx.db.agent.publicIdentity.find(publicIdentity);
}

function comparePublishedActorRows(
  left: ReturnType<typeof getRequiredActorByDbId>,
  right: ReturnType<typeof getRequiredActorByDbId>
): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }
  if (left.slug < right.slug) return -1;
  if (left.slug > right.slug) return 1;
  return 0;
}

function toPublishedAgentLookupRow(actor: ReturnType<typeof getRequiredActorByDbId>) {
  return {
    slug: actor.slug,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    displayName: actor.displayName,
      agentIdentifier: actor.masumiAgentIdentifier,
      encryptionKeyVersion: actor.currentEncryptionKeyVersion,
      encryptionAlgorithm: actor.currentEncryptionAlgorithm,
      encryptionPublicKey: actor.currentEncryptionPublicKey,
      signingKeyVersion: actor.currentSigningKeyVersion,
      signingAlgorithm: actor.currentSigningAlgorithm,
      signingPublicKey: actor.currentSigningPublicKey,
  };
}

function getActorPublishedMessageCapabilities(actor: ReturnType<typeof getRequiredActorByDbId>) {
  if (!actor.supportedMessageContentTypes || !actor.supportedMessageHeaderNames) {
    return buildLegacyPublicMessageCapabilities();
  }

  return buildPublicMessageCapabilities({
    allowAllContentTypes:
      actor.allowAllMessageContentTypes ?? (actor.supportedMessageContentTypes.length === 0),
    allowAllHeaders:
      actor.allowAllMessageHeaders ?? (actor.supportedMessageHeaderNames.length === 0),
    supportedContentTypes: actor.supportedMessageContentTypes,
    supportedHeaders: actor.supportedMessageHeaderNames,
  });
}

function toPublishedPublicHeaderCapabilityRow(capability: ReturnType<
  typeof getActorPublishedMessageCapabilities
>['supportedHeaders'][number]) {
  return {
    name: capability.name,
    required: capability.required ?? undefined,
    allowMultiple: capability.allowMultiple ?? undefined,
    sensitive: capability.sensitive ?? undefined,
    allowedPrefixes: capability.allowedPrefixes ?? undefined,
  };
}

function toPublishedPublicRouteRow(
  actor: ReturnType<typeof getRequiredActorByDbId>,
  inbox: ReturnType<typeof getRequiredInboxById>
) {
  const capabilities = getActorPublishedMessageCapabilities(actor);
  return {
    agentIdentifier: actor.masumiAgentIdentifier,
    linkedEmail: actor.publicLinkedEmailEnabled ? inbox.displayEmail : undefined,
      description: actor.publicDescription,
      encryptionKeyVersion: actor.currentEncryptionKeyVersion,
      encryptionAlgorithm: actor.currentEncryptionAlgorithm,
      encryptionPublicKey: actor.currentEncryptionPublicKey,
      signingKeyVersion: actor.currentSigningKeyVersion,
      signingAlgorithm: actor.currentSigningAlgorithm,
      signingPublicKey: actor.currentSigningPublicKey,
    allowAllContentTypes: capabilities.allowAllContentTypes,
    allowAllHeaders: capabilities.allowAllHeaders,
    supportedContentTypes: capabilities.supportedContentTypes,
    supportedHeaders: capabilities.supportedHeaders.map(toPublishedPublicHeaderCapabilityRow),
    contactPolicy: {
      ...DEFAULT_PUBLIC_CONTACT_POLICY,
      allowlistKinds: [...DEFAULT_PUBLIC_CONTACT_POLICY.allowlistKinds],
    },
  };
}

function getDeviceByInboxDeviceId(ctx: DeviceReadDbCtx, inboxId: bigint, deviceId: string) {
  return ctx.db.device.uniqueKey.find(buildDeviceKey(inboxId, deviceId));
}

function getRequiredInboxById(ctx: ReadDbCtx, inboxId: bigint) {
  const inbox = ctx.db.inbox.id.find(inboxId);
  if (!inbox) {
    throw new SenderError('Inbox was not found');
  }
  return inbox;
}

function getRequiredActorByDbId(ctx: ReadDbCtx, agentDbId: bigint) {
  const actor = ctx.db.agent.id.find(agentDbId);
  if (!actor) {
    throw new SenderError('Actor was not found');
  }
  return actor;
}

function getRequiredActorByPublicIdentity(ctx: ReadDbCtx, publicIdentity: string) {
  const actor = getActorByPublicIdentity(ctx, normalizePublicIdentity(publicIdentity));
  if (!actor) {
    throw new SenderError('Actor was not found');
  }
  return actor;
}

function getRequiredDeviceByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const device = ctx.db.device.id.find(rowId);
  if (!device) {
    throw new SenderError('Device was not found');
  }
  return device;
}

function getRequiredDeviceShareRequestByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const request = ctx.db.deviceShareRequest.id.find(rowId);
  if (!request) {
    throw new SenderError('Device share request was not found');
  }
  return request;
}

function getRequiredDeviceKeyBundleByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const bundle = ctx.db.deviceKeyBundle.id.find(rowId);
  if (!bundle) {
    throw new SenderError('Device key share bundle was not found');
  }
  return bundle;
}

function getRequiredContactRequestByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const request = ctx.db.contactRequest.id.find(rowId);
  if (!request) {
    throw new SenderError('Contact request was not found');
  }
  return request;
}

function getRequiredContactAllowlistEntryByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const entry = ctx.db.contactAllowlistEntry.id.find(rowId);
  if (!entry) {
    throw new SenderError('Contact allowlist entry was not found');
  }
  return entry;
}

function getRequiredThreadInviteByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const invite = ctx.db.threadInvite.id.find(rowId);
  if (!invite) {
    throw new SenderError('Thread invite was not found');
  }
  return invite;
}

function getOwnedInboxAnyStatus(ctx: ReadAuthCtx) {
  const inbox = getInboxByOwnerIdentity(ctx);
  if (!inbox) {
    throw new SenderError('No inbox is bound to this identity');
  }
  requireInboxMatchesOidcIdentity(ctx, inbox);
  return inbox;
}

function hasSenderAuth(ctx: MaybeReadAuthCtx): ctx is ReadAuthCtx {
  return Boolean(ctx.senderAuth);
}

function getReadableInbox(ctx: MaybeReadAuthCtx) {
  const inbox = getInboxByOwnerIdentity(ctx);
  if (!inbox) {
    return null;
  }

  try {
    requireVerifiedInbox(inbox);
    if (!getActiveInboxAuthLease(ctx, inbox)) {
      return null;
    }
    return inbox;
  } catch {
    return null;
  }
}

function requireInboxMatchesOidcClaims(
  inbox: ReturnType<typeof getRequiredInboxById>,
  oidcClaims: OidcIdentityClaims
) {
  if (inbox.authIssuer !== oidcClaims.issuer || inbox.authSubject !== oidcClaims.subject) {
    throw new SenderError('Current OIDC session is not authorized for this inbox');
  }
  if (inbox.normalizedEmail !== oidcClaims.normalizedEmail) {
    throw new SenderError('Current OIDC session email does not match this inbox namespace');
  }
}

function requireInboxMatchesOidcIdentity(
  ctx: ReadAuthCtx,
  inbox: ReturnType<typeof getRequiredInboxById>
) {
  const oidcClaims = requireOidcIdentityClaims(ctx);
  requireInboxMatchesOidcClaims(inbox, oidcClaims);
}

function requireVerifiedInbox(inbox: ReturnType<typeof getRequiredInboxById>) {
  if (!inbox.authVerified || !inbox.emailAttested) {
    throw new SenderError('Inbox auth verification is required before this action');
  }
}

function getOwnedInbox(ctx: ReadAuthCtx) {
  const inbox = getOwnedInboxAnyStatus(ctx);
  requireVerifiedInbox(inbox);
  return inbox;
}

function getOwnedActorWithInbox(
  ctx: ModuleCtx,
  agentDbId: bigint
): { actor: ActorRow; inbox: InboxRow } {
  const actor = getRequiredActorByDbId(ctx, agentDbId);
  const inbox = getOwnedInbox(ctx);
  if (actor.inboxId !== inbox.id) {
    throw new SenderError('Actor is not owned by this inbox identity');
  }
  return { actor, inbox };
}

function getOwnedActor(ctx: ModuleCtx, agentDbId: bigint) {
  const { actor } = getOwnedActorWithInbox(ctx, agentDbId);
  return actor;
}

function getContactRequestByThreadId(ctx: ReadDbCtx, threadId: bigint) {
  return (
    Array.from(ctx.db.contactRequest.contact_request_thread_id.filter(threadId))
      .sort((left, right) => {
        const timeOrder = compareTimestamp(right.updatedAt, left.updatedAt);
        if (timeOrder !== 0) return timeOrder;
        if (right.id > left.id) return 1;
        if (right.id < left.id) return -1;
        return 0;
      })[0] ?? null
  );
}

function hasDirectThreadParticipants(
  ctx: ReadDbCtx,
  threadId: bigint,
  leftActorId: bigint,
  rightActorId: bigint
) {
  const participants = getActiveThreadParticipants(ctx, threadId);
  return (
    participants.some(participant => participant.agentDbId === leftActorId) &&
    participants.some(participant => participant.agentDbId === rightActorId)
  );
}

function hasApprovedDirectThreadForActors(
  ctx: ReadDbCtx,
  leftActor: ReturnType<typeof getRequiredActorByDbId>,
  rightActor: ReturnType<typeof getRequiredActorByDbId>
) {
  const directKey = buildDirectKey(leftActor, rightActor);
  return getDirectThreadsForKey(ctx, directKey).some(thread => {
    if (thread.kind !== 'direct' || thread.dedupeKey !== directKey) {
      return false;
    }
    if (!hasDirectThreadParticipants(ctx, thread.id, leftActor.id, rightActor.id)) {
      return false;
    }
    const request = getContactRequestByThreadId(ctx, thread.id);
    return !request || request.status.tag === 'approved';
  });
}

function findPendingContactRequestForActors(
  ctx: ReadDbCtx,
  leftActor: ReturnType<typeof getRequiredActorByDbId>,
  rightActor: ReturnType<typeof getRequiredActorByDbId>
) {
  const directKey = buildDirectKey(leftActor, rightActor);
  return getDirectThreadsForKey(ctx, directKey)
    .filter(thread => hasDirectThreadParticipants(ctx, thread.id, leftActor.id, rightActor.id))
    .map(thread => getContactRequestByThreadId(ctx, thread.id))
    .find((request): request is NonNullable<typeof request> => {
      return Boolean(request && request.status.tag === 'pending');
    });
}

function isSenderOnAllowlistForTargetInbox(
  ctx: ReadDbCtx,
  senderActor: ReturnType<typeof getRequiredActorByDbId>,
  targetActor: ReturnType<typeof getRequiredActorByDbId>
) {
  const targetInbox = getRequiredInboxById(ctx, targetActor.inboxId);
  const senderInbox = getRequiredInboxById(ctx, senderActor.inboxId);
  return getContactAllowlistEntriesByInboxId(ctx, targetInbox.id).some(entry => {
    if (entry.inboxId !== targetInbox.id) {
      return false;
    }

    if (entry.kind.tag === 'agent') {
      return entry.agentPublicIdentity === senderActor.publicIdentity;
    }
    if (entry.kind.tag === 'email') {
      return entry.normalizedEmail === senderInbox.normalizedEmail;
    }
    return false;
  });
}

function isDirectContactAllowed(
  ctx: ReadDbCtx,
  requesterActor: ReturnType<typeof getRequiredActorByDbId>,
  targetActor: ReturnType<typeof getRequiredActorByDbId>
) {
  return (
    isSenderOnAllowlistForTargetInbox(ctx, requesterActor, targetActor) ||
    hasApprovedDirectThreadForActors(ctx, requesterActor, targetActor)
  );
}

function requirePendingDirectContactResolvedForThreadMutation(
  ctx: ModuleCtx,
  threadId: bigint
) {
  const request = getContactRequestByThreadId(ctx, threadId);
  if (!request) {
    return;
  }

  if (request.status.tag === 'approved') {
    return;
  }

  const requesterActor = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
  const targetActor = getRequiredActorByDbId(ctx, request.targetAgentDbId);
  if (isDirectContactAllowed(ctx, requesterActor, targetActor)) {
    return;
  }

  throw new SenderError(
    'Pending direct-contact threads cannot change membership or envelopes until the requester is allowlisted or the request is approved'
  );
}

function isThreadVisibleInNormalViews(ctx: ReadDbCtx, threadId: bigint) {
  const request = getContactRequestByThreadId(ctx, threadId);
  if (!request || request.status.tag === 'approved') {
    return true;
  }

  const requesterActor = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
  const targetActor = getRequiredActorByDbId(ctx, request.targetAgentDbId);
  return isDirectContactAllowed(ctx, requesterActor, targetActor);
}

function buildActiveThreadIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const candidateThreadIds = new Set(
    Array.from(ctx.db.threadParticipant.thread_participant_inbox_id.filter(inboxId))
      .filter(participant => participant.active)
      .map(participant => participant.threadId)
  );

  return new Set(
    Array.from(candidateThreadIds).filter(threadId => isThreadVisibleInNormalViews(ctx, threadId))
  );
}

function buildVisibleThreadIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const candidateThreadIds = new Set(
    Array.from(ctx.db.threadParticipant.thread_participant_inbox_id.filter(inboxId)).map(
      participant => participant.threadId
    )
  );

  return new Set(
    Array.from(candidateThreadIds).filter(threadId => isThreadVisibleInNormalViews(ctx, threadId))
  );
}

function buildVisibleThreadParticipantIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const visibleParticipantIds = new Set<bigint>();
  const activeThreadIds = buildActiveThreadIdsForInbox(ctx, inboxId);
  const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inboxId);
  const ownActorIds = getOwnActorIdsForInbox(ctx, inboxId);

  for (const threadId of activeThreadIds) {
    for (const participant of ctx.db.threadParticipant.thread_participant_thread_id.filter(threadId)) {
      visibleParticipantIds.add(participant.id);
    }
  }

  for (const participant of ctx.db.threadParticipant.thread_participant_inbox_id.filter(inboxId)) {
    if (visibleThreadIds.has(participant.threadId)) {
      visibleParticipantIds.add(participant.id);
    }
  }

  for (const agentDbId of ownActorIds) {
    for (const envelope of ctx.db.threadSecretEnvelope.thread_secret_envelope_sender_agent_db_id.filter(agentDbId)) {
      if (visibleThreadIds.has(envelope.threadId)) {
        const senderParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.senderAgentDbId)
        );
        const recipientParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.recipientAgentDbId)
        );
        if (senderParticipant) visibleParticipantIds.add(senderParticipant.id);
        if (recipientParticipant) visibleParticipantIds.add(recipientParticipant.id);
      }
    }
    for (const envelope of ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(agentDbId)) {
      if (visibleThreadIds.has(envelope.threadId)) {
        const senderParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.senderAgentDbId)
        );
        const recipientParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.recipientAgentDbId)
        );
        if (senderParticipant) visibleParticipantIds.add(senderParticipant.id);
        if (recipientParticipant) visibleParticipantIds.add(recipientParticipant.id);
      }
    }
  }

  return visibleParticipantIds;
}

function buildVisibleAgentIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const visibleActorIds = new Set<bigint>(getOwnActorIdsForInbox(ctx, inboxId));

  for (const participantId of buildVisibleThreadParticipantIdsForInbox(ctx, inboxId)) {
    const participant = ctx.db.threadParticipant.id.find(participantId);
    if (participant) {
      visibleActorIds.add(participant.agentDbId);
    }
  }

  return visibleActorIds;
}

function isActorOwnedByInbox(actor: ActorRow, inboxId: bigint) {
  return actor.inboxId === inboxId;
}

function getActorLinkedEmailForViewer(ctx: ReadDbCtx, inboxId: bigint, actor: ActorRow) {
  if (!actor.publicLinkedEmailEnabled && !isActorOwnedByInbox(actor, inboxId)) {
    return null;
  }
  return getRequiredInboxById(ctx, actor.inboxId);
}

function toSanitizedVisibleAgentRow(ctx: ReadDbCtx, inboxId: bigint, actor: ActorRow) {
  if (isActorOwnedByInbox(actor, inboxId)) {
    return actor;
  }

  const linkedInbox = getActorLinkedEmailForViewer(ctx, inboxId, actor);
  return {
    id: actor.id,
    inboxId: 0n,
    normalizedEmail: linkedInbox?.normalizedEmail ?? '',
    slug: actor.slug,
    inboxIdentifier: undefined,
    isDefault: false,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName,
    publicLinkedEmailEnabled: actor.publicLinkedEmailEnabled,
    publicDescription: actor.publicDescription,
    allowAllMessageContentTypes: actor.allowAllMessageContentTypes,
    allowAllMessageHeaders: actor.allowAllMessageHeaders,
    supportedMessageContentTypes: actor.supportedMessageContentTypes,
    supportedMessageHeaderNames: actor.supportedMessageHeaderNames,
    currentEncryptionPublicKey: actor.currentEncryptionPublicKey,
    currentEncryptionKeyVersion: actor.currentEncryptionKeyVersion,
    currentEncryptionAlgorithm: actor.currentEncryptionAlgorithm,
    currentSigningPublicKey: actor.currentSigningPublicKey,
    currentSigningKeyVersion: actor.currentSigningKeyVersion,
    currentSigningAlgorithm: actor.currentSigningAlgorithm,
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier,
    masumiRegistrationState: undefined,
    createdAt: actor.createdAt,
    updatedAt: actor.updatedAt,
  };
}

function toVisibleContactRequestRow(
  ctx: ReadDbCtx,
  inboxId: bigint,
  request: ReturnType<typeof getRequiredContactRequestByRowId>
) {
  const requester = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
  const target = getRequiredActorByDbId(ctx, request.targetAgentDbId);
  const requesterEmail = getActorLinkedEmailForViewer(ctx, inboxId, requester);
  const targetEmail = getActorLinkedEmailForViewer(ctx, inboxId, target);
  return {
    id: request.id,
    threadId: request.threadId,
    requesterAgentDbId: request.requesterAgentDbId,
    requesterPublicIdentity: request.requesterPublicIdentity,
    requesterSlug: request.requesterSlug,
    requesterDisplayName: request.requesterDisplayName,
    requesterNormalizedEmail: requesterEmail?.normalizedEmail ?? '',
    requesterDisplayEmail: requesterEmail?.displayEmail ?? '',
    requesterLinkedEmail: requesterEmail?.displayEmail,
    targetAgentDbId: request.targetAgentDbId,
    targetPublicIdentity: request.targetPublicIdentity,
    targetSlug: request.targetSlug,
    targetDisplayName: request.targetDisplayName ?? target.displayName,
    targetLinkedEmail: targetEmail?.displayEmail,
    direction: target.inboxId === inboxId ? 'incoming' : 'outgoing',
    status: request.status.tag,
    messageCount: ctx.db.thread.id.find(request.threadId)?.lastMessageSeq ?? 0n,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    resolvedAt: request.resolvedAt,
    resolvedByAgentDbId: request.resolvedByAgentDbId,
  };
}

function toVisibleThreadInviteRow(ctx: ReadDbCtx, invite: ThreadInviteRow) {
  const thread = ctx.db.thread.id.find(invite.threadId);
  const inviter = getRequiredActorByDbId(ctx, invite.inviterAgentDbId);
  const invitee = getRequiredActorByDbId(ctx, invite.inviteeAgentDbId);
  return {
    id: invite.id,
    threadId: invite.threadId,
    inviterAgentDbId: invite.inviterAgentDbId,
    inviterPublicIdentity: inviter.publicIdentity,
    inviterSlug: inviter.slug,
    inviterDisplayName: inviter.displayName,
    inviteeAgentDbId: invite.inviteeAgentDbId,
    inviteePublicIdentity: invitee.publicIdentity,
    inviteeSlug: invitee.slug,
    inviteeDisplayName: invitee.displayName,
    threadTitle: thread?.title,
    status: invite.status,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt,
    resolvedAt: invite.resolvedAt,
    resolvedByAgentDbId: invite.resolvedByAgentDbId,
  };
}

function getVisibleContactRequestsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  return dedupeRowsById(
    Array.from(getOwnActorIdsForInbox(ctx, inboxId)).flatMap(agentDbId => [
      ...Array.from(ctx.db.contactRequest.contact_request_requester_agent_db_id.filter(agentDbId)),
      ...Array.from(ctx.db.contactRequest.contact_request_target_agent_db_id.filter(agentDbId)),
    ])
  );
}

function getOwnedDevices(ctx: DeviceReadAuthCtx) {
  const inbox = getOwnedInbox(ctx);
  return getDevicesByInboxId(ctx, inbox.id);
}

function getOwnedDevice(ctx: DeviceReadAuthCtx, deviceId: string) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const inbox = getOwnedInbox(ctx);
  const device = getDeviceByInboxDeviceId(ctx, inbox.id, normalizedDeviceId);
  if (!device || device.inboxId !== inbox.id) {
    throw new SenderError('Device was not found for this inbox');
  }
  return device;
}

function upsertInboxDevice(
  ctx: ModuleCtx,
  inboxId: bigint,
  {
    deviceId,
    label,
      platform,
      deviceEncryptionPublicKey,
      deviceEncryptionKeyVersion,
      deviceEncryptionAlgorithm,
    }: {
      deviceId: string;
      label?: string;
      platform?: string;
      deviceEncryptionPublicKey: string;
      deviceEncryptionKeyVersion: string;
      deviceEncryptionAlgorithm?: string;
    },
  options?: { autoApprove?: boolean }
) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const normalizedLabel = normalizeOptionalDeviceLabel(label);
  const normalizedPlatform = normalizeOptionalPlatform(platform);
  const normalizedDeviceEncryptionPublicKey = normalizePublicKey(
    deviceEncryptionPublicKey,
    'deviceEncryptionPublicKey'
  );
    const normalizedDeviceEncryptionKeyVersion = requireNonEmpty(
      deviceEncryptionKeyVersion,
      'deviceEncryptionKeyVersion'
    );
    const normalizedDeviceEncryptionAlgorithm = normalizeOptionalAlgorithm(
      deviceEncryptionAlgorithm,
      DEFAULT_DEVICE_ENCRYPTION_ALGORITHM,
      'deviceEncryptionAlgorithm'
    );
    const autoApprove = options?.autoApprove === true;

  requireMaxLength(
    normalizedDeviceEncryptionKeyVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'deviceEncryptionKeyVersion'
  );

  const existing = getDeviceByInboxDeviceId(ctx, inboxId, normalizedDeviceId);
  if (!existing) {
    ctx.db.device.insert({
      id: 0n,
      deviceId: normalizedDeviceId,
      inboxId,
      uniqueKey: buildDeviceKey(inboxId, normalizedDeviceId),
      label: normalizedLabel,
	        platform: normalizedPlatform,
	        deviceEncryptionPublicKey: normalizedDeviceEncryptionPublicKey,
        deviceEncryptionKeyVersion: normalizedDeviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm: normalizedDeviceEncryptionAlgorithm,
        status: normalizeDeviceStatus(autoApprove ? 'approved' : 'pending'),
      approvedAt: autoApprove ? ctx.timestamp : undefined,
      revokedAt: undefined,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
    return;
  }

	    const keyChanged =
	      existing.deviceEncryptionPublicKey !== normalizedDeviceEncryptionPublicKey ||
	      existing.deviceEncryptionKeyVersion !== normalizedDeviceEncryptionKeyVersion ||
	      existing.deviceEncryptionAlgorithm !== normalizedDeviceEncryptionAlgorithm;
  const shouldResetApproval = Boolean(existing.revokedAt) || keyChanged;
  if (keyChanged) {
    invalidatePendingDeviceShareRequests(ctx, inboxId, normalizedDeviceId);
    invalidatePendingDeviceKeyBundles(ctx, inboxId, normalizedDeviceId);
  }

  ctx.db.device.id.update({
    ...existing,
    label: normalizedLabel,
      platform: normalizedPlatform,
      deviceEncryptionPublicKey: normalizedDeviceEncryptionPublicKey,
      deviceEncryptionKeyVersion: normalizedDeviceEncryptionKeyVersion,
      deviceEncryptionAlgorithm: normalizedDeviceEncryptionAlgorithm,
    status: normalizeDeviceStatus(
      autoApprove
        ? 'approved'
        : shouldResetApproval
          ? 'pending'
          : existing.approvedAt
            ? 'approved'
            : existing.status
    ),
    approvedAt: autoApprove
      ? existing.approvedAt ?? ctx.timestamp
      : shouldResetApproval
        ? undefined
        : existing.approvedAt,
    revokedAt: autoApprove ? undefined : shouldResetApproval ? undefined : existing.revokedAt,
    updatedAt: ctx.timestamp,
    lastSeenAt: ctx.timestamp,
  });
}

function getRequestsForOwnedDevices(ctx: DeviceReadAuthCtx) {
  const inbox = getOwnedInbox(ctx);
  return Array.from(ctx.db.deviceShareRequest.device_share_request_inbox_id.filter(inbox.id));
}

function getBundlesForOwnedDevices(ctx: DeviceReadAuthCtx) {
  const inbox = getOwnedInbox(ctx);
  return Array.from(ctx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(inbox.id));
}

function isPendingDeviceShareRequest(
  request: ReturnType<typeof getRequiredDeviceShareRequestByRowId>,
  now: Timestamp
) {
  return !request.approvedAt && !request.consumedAt && !isTimestampExpired(request.expiresAt, now);
}

function isNeverExpiringDeviceKeyBundle(
  bundle: ReturnType<typeof getRequiredDeviceKeyBundleByRowId>
) {
  return bundle.expiryMode.tag === 'neverExpires';
}

function isClaimableDeviceKeyBundle(
  bundle: ReturnType<typeof getRequiredDeviceKeyBundleByRowId>,
  now: Timestamp
) {
  return !bundle.consumedAt && (isNeverExpiringDeviceKeyBundle(bundle) || !isTimestampExpired(bundle.expiresAt, now));
}

function invalidatePendingDeviceShareRequests(
  ctx: ModuleCtx,
  inboxId: bigint,
  deviceId: string,
  options?: { approvedAt?: Timestamp; consumedAt?: Timestamp }
) {
  for (const request of ctx.db.deviceShareRequest.device_share_request_device_id.filter(deviceId)) {
    if (request.inboxId !== inboxId) continue;
    if (request.consumedAt) continue;

    ctx.db.deviceShareRequest.id.update({
      ...request,
      approvedAt: options?.approvedAt ?? request.approvedAt,
      consumedAt: options?.consumedAt ?? ctx.timestamp,
    });
  }
}

function invalidatePendingDeviceKeyBundles(ctx: ModuleCtx, inboxId: bigint, deviceId: string) {
  for (const bundle of ctx.db.deviceKeyBundle.device_key_bundle_target_device_id.filter(deviceId)) {
    if (bundle.inboxId !== inboxId) continue;
    if (bundle.consumedAt) continue;
    ctx.db.deviceKeyBundle.id.update({
      ...bundle,
      consumedAt: ctx.timestamp,
    });
  }
}

function scheduleDeviceKeyBundleExpiry(ctx: ModuleCtx, bundle: DeviceKeyBundleRow) {
  if (isNeverExpiringDeviceKeyBundle(bundle)) {
    return;
  }
  for (const expiry of ctx.db.deviceKeyBundleExpiry.device_key_bundle_expiry_bundle_id.filter(
    bundle.id
  )) {
    if (expiry.expiresAt.microsSinceUnixEpoch === bundle.expiresAt.microsSinceUnixEpoch) {
      return;
    }
  }

  ctx.db.deviceKeyBundleExpiry.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(bundle.expiresAt.microsSinceUnixEpoch),
    bundleId: bundle.id,
    expiresAt: bundle.expiresAt,
    createdAt: ctx.timestamp,
  });
}

function reconcileDeviceKeyBundleExpiryState(ctx: ModuleCtx, inboxId: bigint, now: Timestamp) {
  for (const bundle of ctx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(inboxId)) {
    if (bundle.consumedAt || isNeverExpiringDeviceKeyBundle(bundle)) {
      continue;
    }

    if (isTimestampExpired(bundle.expiresAt, now)) {
      ctx.db.deviceKeyBundle.id.update({
        ...bundle,
        consumedAt: now,
      });
      continue;
    }

    scheduleDeviceKeyBundleExpiry(ctx, bundle);
  }
}

function insertDeviceKeyBundle(
  ctx: ModuleCtx,
  attachment: {
    deviceId: string;
      sourceDeviceId?: string;
      sourceEncryptionPublicKey: string;
      sourceEncryptionKeyVersion: string;
      sourceEncryptionAlgorithm?: string;
      bundleCiphertext: string;
    bundleIv: string;
    bundleAlgorithm: string;
    sharedAgentCount: bigint;
    sharedKeyVersionCount: bigint;
    expiresAt: Timestamp;
    expiryMode: DeviceKeyBundleExpiryModeValue;
  }
) {
  const normalizedDeviceId = normalizeDeviceId(attachment.deviceId);
  const targetDevice = getOwnedDevice(ctx, normalizedDeviceId);
  if (targetDevice.revokedAt || targetDevice.status === 'revoked') {
    throw new SenderError(`Device ${normalizedDeviceId} is revoked`);
  }

  const normalizedSourceDeviceId = attachment.sourceDeviceId?.trim() || undefined;
  const normalizedSourceEncryptionPublicKey = normalizePublicKey(
    attachment.sourceEncryptionPublicKey,
    'sourceEncryptionPublicKey'
  );
    const normalizedSourceEncryptionKeyVersion = requireNonEmpty(
      attachment.sourceEncryptionKeyVersion,
      'sourceEncryptionKeyVersion'
    );
    const normalizedSourceEncryptionAlgorithm = normalizeOptionalAlgorithm(
      attachment.sourceEncryptionAlgorithm,
      DEFAULT_DEVICE_ENCRYPTION_ALGORITHM,
      'sourceEncryptionAlgorithm'
    );
  const normalizedBundleCiphertext = requireHexMaxLength(
    attachment.bundleCiphertext,
    MAX_DEVICE_BUNDLE_CIPHERTEXT_HEX_CHARS,
    'bundleCiphertext'
  );
  const normalizedBundleIv = requireHexMaxLength(
    attachment.bundleIv,
    MAX_MESSAGE_IV_HEX_CHARS,
    'bundleIv'
  );
  const normalizedBundleAlgorithm = requireNonEmpty(
    attachment.bundleAlgorithm,
    'bundleAlgorithm'
  );

  requireMaxLength(
    normalizedSourceEncryptionKeyVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'sourceEncryptionKeyVersion'
  );
  requireMaxLength(
    normalizedBundleAlgorithm,
    MAX_DEVICE_BUNDLE_ALGORITHM_CHARS,
    'bundleAlgorithm'
  );
  requireClaimableDeviceKeyBundleExpiry(ctx.timestamp, attachment.expiresAt);

  invalidatePendingDeviceKeyBundles(ctx, targetDevice.inboxId, normalizedDeviceId);

  const insertedBundle = ctx.db.deviceKeyBundle.insert({
    id: 0n,
    targetDeviceId: normalizedDeviceId,
    inboxId: targetDevice.inboxId,
	      sourceDeviceId: normalizedSourceDeviceId,
	      sourceEncryptionPublicKey: normalizedSourceEncryptionPublicKey,
      sourceEncryptionKeyVersion: normalizedSourceEncryptionKeyVersion,
      sourceEncryptionAlgorithm: normalizedSourceEncryptionAlgorithm,
      bundleCiphertext: normalizedBundleCiphertext,
    bundleIv: normalizedBundleIv,
    bundleAlgorithm: normalizedBundleAlgorithm,
    sharedAgentCount: attachment.sharedAgentCount,
    sharedKeyVersionCount: attachment.sharedKeyVersionCount,
    createdAt: ctx.timestamp,
    expiresAt: attachment.expiresAt,
    consumedAt: undefined,
    expiryMode: attachment.expiryMode,
  });
  scheduleDeviceKeyBundleExpiry(ctx, insertedBundle);
}

function getThreadParticipants(ctx: ReadDbCtx, threadId: bigint) {
  return Array.from(ctx.db.threadParticipant.thread_participant_thread_id.filter(threadId));
}

function getActiveThreadParticipants(ctx: ReadDbCtx, threadId: bigint) {
  return getThreadParticipants(ctx, threadId).filter(participant => participant.active);
}

function getThreadInvites(ctx: ReadDbCtx, threadId: bigint) {
  return Array.from(ctx.db.threadInvite.thread_invite_thread_id.filter(threadId));
}

function getPendingThreadInvites(ctx: ReadDbCtx, threadId: bigint) {
  return getThreadInvites(ctx, threadId).filter(invite => invite.status === 'pending');
}

function requireThreadFanoutCapacity(ctx: ReadDbCtx, threadId: bigint, additionalCount = 1) {
  const activeCount = getActiveThreadParticipants(ctx, threadId).length;
  const pendingCount = getPendingThreadInvites(ctx, threadId).length;
  if (activeCount + pendingCount + additionalCount > MAX_THREAD_FANOUT) {
    throw new SenderError(
      `Threads may include at most ${MAX_THREAD_FANOUT.toString()} active or pending participants`
    );
  }
}

function ensureThreadInvite(
  ctx: ModuleCtx,
  threadId: bigint,
  inviterAgent: ReturnType<typeof getRequiredActorByDbId>,
  inviteeAgent: ReturnType<typeof getRequiredActorByDbId>
): boolean {
  const existing = ctx.db.threadInvite.uniqueKey.find(
    buildThreadInviteKey(threadId, inviteeAgent.id)
  );

  if (!existing) {
    requireThreadFanoutCapacity(ctx, threadId);
    ctx.db.threadInvite.insert({
      id: 0n,
      threadId,
      inviterAgentDbId: inviterAgent.id,
      inviteeAgentDbId: inviteeAgent.id,
      inviteeInboxId: inviteeAgent.inboxId,
      uniqueKey: buildThreadInviteKey(threadId, inviteeAgent.id),
      status: normalizeThreadInviteStatus('pending'),
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolvedByAgentDbId: undefined,
    });
    return true;
  }

  if (existing.status === 'pending') {
    return false;
  }

  requireThreadFanoutCapacity(ctx, threadId);
  ctx.db.threadInvite.id.update({
    ...existing,
    inviterAgentDbId: inviterAgent.id,
    inviteeInboxId: inviteeAgent.inboxId,
    status: normalizeThreadInviteStatus('pending'),
    updatedAt: ctx.timestamp,
    resolvedAt: undefined,
    resolvedByAgentDbId: undefined,
  });
  return true;
}

function resolveThreadInvite(
  ctx: ModuleCtx,
  invite: ThreadInviteRow,
  status: (typeof THREAD_INVITE_STATUSES)[number],
  resolverAgentDbId: bigint
) {
  ctx.db.threadInvite.id.update({
    ...invite,
    status: normalizeThreadInviteStatus(status),
    updatedAt: ctx.timestamp,
    resolvedAt: ctx.timestamp,
    resolvedByAgentDbId: resolverAgentDbId,
  });
}

function deleteThreadAndDependents(
  ctx: ModuleCtx,
  threadId: bigint,
  options?: { preserveContactRequests?: boolean }
) {
  const directIndex = ctx.db.directThreadIndex.threadId.find(threadId);
  if (directIndex) {
    ctx.db.directThreadIndex.id.delete(directIndex.id);
  }
  for (const message of Array.from(ctx.db.message.message_thread_id.filter(threadId))) {
    ctx.db.message.id.delete(message.id);
  }
  for (const envelope of Array.from(
    ctx.db.threadSecretEnvelope.thread_secret_envelope_thread_id.filter(threadId)
  )) {
    ctx.db.threadSecretEnvelope.id.delete(envelope.id);
  }
  for (const readState of Array.from(
    ctx.db.threadReadState.thread_read_state_thread_id.filter(threadId)
  )) {
    ctx.db.threadReadState.id.delete(readState.id);
  }
  for (const invite of getThreadInvites(ctx, threadId)) {
    ctx.db.threadInvite.id.delete(invite.id);
  }
  for (const participant of getThreadParticipants(ctx, threadId)) {
    ctx.db.threadParticipant.id.delete(participant.id);
  }
  if (!options?.preserveContactRequests) {
    for (const request of Array.from(
      ctx.db.contactRequest.contact_request_thread_id.filter(threadId)
    )) {
      ctx.db.contactRequest.id.delete(request.id);
    }
  }
  ctx.db.thread.id.delete(threadId);
}

function requireCurrentEnvelopeVersions(params: {
  senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  recipientAgent: ReturnType<typeof getRequiredActorByDbId>;
  senderEncryptionKeyVersion: string;
  recipientEncryptionKeyVersion: string;
  signingKeyVersion: string;
}) {
  const normalizedSenderEncryptionVersion = requireNonEmpty(
    params.senderEncryptionKeyVersion,
    'senderEncryptionKeyVersion'
  );
  const normalizedRecipientEncryptionVersion = requireNonEmpty(
    params.recipientEncryptionKeyVersion,
    'recipientEncryptionKeyVersion'
  );
  const normalizedSigningVersion = requireNonEmpty(
    params.signingKeyVersion,
    'signingKeyVersion'
  );
  requireMaxLength(
    normalizedSenderEncryptionVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'senderEncryptionKeyVersion'
  );
  requireMaxLength(
    normalizedRecipientEncryptionVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'recipientEncryptionKeyVersion'
  );
  requireMaxLength(
    normalizedSigningVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'signingKeyVersion'
  );

  if (normalizedSenderEncryptionVersion !== params.senderAgent.currentEncryptionKeyVersion) {
    throw new SenderError(
      'senderEncryptionKeyVersion must match the sender current encryption key version'
    );
  }
  if (normalizedRecipientEncryptionVersion !== params.recipientAgent.currentEncryptionKeyVersion) {
    throw new SenderError(
      'recipientEncryptionKeyVersion must match the recipient current encryption key version'
    );
  }
  if (normalizedSigningVersion !== params.senderAgent.currentSigningKeyVersion) {
    throw new SenderError('signingKeyVersion must match the sender current signing key version');
  }
}

function buildDirectKey(
  left: { publicIdentity: string },
  right: { publicIdentity: string }
): string {
  const values = [left.publicIdentity, right.publicIdentity].sort();
  return `direct:${values[0]}:${values[1]}`;
}

function getDirectThreadsForKey(ctx: ReadDbCtx, directKey: string) {
  const byId = new Map<string, ThreadRow>();
  for (const indexed of ctx.db.directThreadIndex.direct_thread_index_direct_key.filter(directKey)) {
    const thread = ctx.db.thread.id.find(indexed.threadId);
    if (thread) {
      byId.set(thread.id.toString(), thread);
    }
  }

  for (const thread of ctx.db.thread.thread_dedupe_key.filter(directKey)) {
    if (thread.kind === 'direct' && thread.dedupeKey === directKey) {
      byId.set(thread.id.toString(), thread);
    }
  }

  return Array.from(byId.values());
}

function buildGroupKey(
  actor: { publicIdentity: string },
  sequence: bigint
): string {
  return `group:${actor.publicIdentity}:${sequence.toString()}`;
}

function createDirectThreadRecord(
  ctx: ModuleCtx,
  actor: ReturnType<typeof getRequiredActorByDbId>,
  otherActor: ReturnType<typeof getRequiredActorByDbId>,
  options?: { membershipLocked?: boolean; title?: string; threadId?: bigint }
) {
  const directKey = buildDirectKey(actor, otherActor);
  const directThreadId = options?.threadId ?? 0n;

  if (options?.threadId !== undefined) {
    if (directThreadId === 0n) {
      throw new SenderError('threadId must be non-zero');
    }
    if (!isClientGeneratedThreadId(directThreadId)) {
      throw new SenderError('threadId must be a client-generated thread id');
    }
    if (ctx.db.thread.id.find(directThreadId)) {
      throw new SenderError('Thread id collision detected. Generate a new thread id and try again.');
    }
  }

  const thread = ctx.db.thread.insert({
    id: directThreadId,
    dedupeKey: directKey,
    kind: 'direct',
    membershipLocked: options?.membershipLocked ?? true,
    title: normalizeOptionalThreadTitle(options?.title),
    creatorAgentDbId: actor.id,
    membershipVersion: 1n,
    nextThreadSeq: 1n,
    lastMessageSeq: 0n,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    lastMessageAt: ctx.timestamp,
  });

  ctx.db.directThreadIndex.insert({
    id: 0n,
    directKey,
    threadId: thread.id,
    createdAt: ctx.timestamp,
  });

  ensureThreadParticipant(ctx, thread.id, actor, { isAdmin: true });
  ensureThreadParticipant(ctx, thread.id, otherActor);
  return thread;
}

function ensureThreadParticipant(
  ctx: ModuleCtx,
  threadId: bigint,
  actor: { id: bigint; inboxId: bigint },
  options?: { isAdmin?: boolean }
): boolean {
  const existingParticipant = getThreadParticipants(ctx, threadId).find(participant => {
    return participant.agentDbId === actor.id;
  });

  if (!existingParticipant) {
    ctx.db.threadParticipant.insert({
      id: 0n,
      threadId,
      agentDbId: actor.id,
      inboxId: actor.inboxId,
      uniqueKey: buildThreadParticipantKey(threadId, actor.id),
      joinedAt: ctx.timestamp,
      lastSentSeq: 0n,
      lastSentMembershipVersion: undefined,
      lastSentSecretVersion: undefined,
      isAdmin: options?.isAdmin ?? false,
      active: true,
      });
      return true;
    }

    const wasInactive = !existingParticipant.active;
    const needsInboxIdBackfill = existingParticipant.inboxId !== actor.inboxId;
    if (
      wasInactive ||
      needsInboxIdBackfill ||
      ((options?.isAdmin ?? false) && !existingParticipant.isAdmin)
    ) {
      ctx.db.threadParticipant.id.update({
        ...existingParticipant,
        inboxId: actor.inboxId,
        active: true,
        isAdmin: existingParticipant.isAdmin || (options?.isAdmin ?? false),
      });
    }
    return wasInactive;
}

function requireActiveThreadParticipant(
  ctx: ModuleCtx,
  threadId: bigint,
  agentDbId: bigint
) {
  const participant = getActiveThreadParticipants(ctx, threadId).find(
    row => row.agentDbId === agentDbId
  );
  if (!participant) {
    throw new SenderError('Actor is not a participant in this thread');
  }
  return participant;
}

function requireVisibleThreadParticipant(
  ctx: ReadDbCtx,
  threadId: bigint,
  agentDbId: bigint
) {
  const participant = getThreadParticipants(ctx, threadId).find(
    row => row.agentDbId === agentDbId
  );
  if (!participant) {
    throw new SenderError('Actor is not a participant in this thread');
  }
  if (!isThreadVisibleInNormalViews(ctx, threadId)) {
    throw new SenderError('Thread is not visible to this actor');
  }
  return participant;
}

function requireAdminThreadParticipant(
  ctx: ModuleCtx,
  threadId: bigint,
  agentDbId: bigint
) {
  const participant = requireActiveThreadParticipant(ctx, threadId, agentDbId);
  if (!participant.isAdmin) {
    throw new SenderError('Actor is not an admin in this thread');
  }
  return participant;
}

function promoteReplacementAdmin(ctx: ModuleCtx, threadId: bigint) {
  const activeParticipants = getActiveThreadParticipants(ctx, threadId);
  if (activeParticipants.length === 0) return;
  if (activeParticipants.some(participant => participant.isAdmin)) return;

  const [nextAdmin] = [...activeParticipants].sort((left, right) => Number(left.id - right.id));
  if (!nextAdmin) return;

  ctx.db.threadParticipant.id.update({
    ...nextAdmin,
    isAdmin: true,
  });
}

function getSenderLastSentState(
  senderParticipant: ThreadParticipantRow
): { membershipVersion: bigint; secretVersion: string } | null {
  if (
    senderParticipant.lastSentSeq === 0n ||
    senderParticipant.lastSentMembershipVersion === undefined ||
    senderParticipant.lastSentSecretVersion === undefined
  ) {
    return null;
  }
  return {
    membershipVersion: senderParticipant.lastSentMembershipVersion,
    secretVersion: senderParticipant.lastSentSecretVersion,
  };
}

function getSecretEnvelopesForVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  membershipVersion: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return getSecretEnvelopesForSenderSecretVersion(
    ctx,
    threadId,
    senderAgentDbId,
    secretVersion
  ).filter(envelope => envelope.membershipVersion === membershipVersion);
}

function getSecretEnvelopesForSenderSecretVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return Array.from(
    ctx.db.threadSecretEnvelope.thread_secret_envelope_sender_agent_db_id.filter(senderAgentDbId)
  ).filter(envelope => {
    return (
      envelope.threadId === threadId &&
      envelope.senderAgentDbId === senderAgentDbId &&
      envelope.secretVersion === secretVersion
    );
  });
}

function senderHasMessageWithSecretVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return Array.from(
    ctx.db.message.message_sender_agent_db_id.filter(senderAgentDbId)
  ).some(message => {
    return (
      message.threadId === threadId &&
      message.senderAgentDbId === senderAgentDbId &&
      message.secretVersion === secretVersion
    );
  });
}

function senderHasMessageForMembershipSecretVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  membershipVersion: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return Array.from(
    ctx.db.message.message_sender_agent_db_id.filter(senderAgentDbId)
  ).some(message => {
    return (
      message.threadId === threadId &&
      message.membershipVersion === membershipVersion &&
      message.senderAgentDbId === senderAgentDbId &&
      message.secretVersion === secretVersion
    );
  });
}

function canAgentReadMessage(ctx: ReadDbCtx, agentDbId: bigint, message: MessageRow) {
  if (message.senderAgentDbId === agentDbId) {
    return true;
  }

  const messageSenderSecretKey = buildSenderSecretVisibilityKey(
    message.membershipVersion,
    message.senderAgentDbId,
    message.secretVersion
  );
  return Array.from(
    ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(agentDbId)
  ).some(envelope => {
    return (
      envelope.threadId === message.threadId &&
      buildSenderSecretVisibilityKey(
        envelope.membershipVersion,
        envelope.senderAgentDbId,
        envelope.secretVersion
      ) === messageSenderSecretKey
    );
  });
}

function getThreadReadStateForActor(ctx: ReadDbCtx, threadId: bigint, agentDbId: bigint) {
  return ctx.db.threadReadState.uniqueKey.find(buildThreadReadStateKey(threadId, agentDbId));
}

function requireExactEnvelopeCoverageForVersion(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  activeParticipants: ReturnType<typeof getActiveThreadParticipants>;
}) {
  const envelopes = getSecretEnvelopesForVersion(
      params.ctx,
      params.threadId,
      params.membershipVersion,
      params.senderAgent.id,
    params.secretVersion
  );
  const expectedRecipientIds = new Set(params.activeParticipants.map(row => row.agentDbId));

  if (envelopes.length !== expectedRecipientIds.size) {
    throw new SenderError('secretVersion does not cover the current active participant set');
  }

  const seenRecipients = new Set<bigint>();
  for (const envelope of envelopes) {
    if (!expectedRecipientIds.has(envelope.recipientAgentDbId)) {
      throw new SenderError('secretVersion includes envelopes for inactive participants');
    }
    if (seenRecipients.has(envelope.recipientAgentDbId)) {
      throw new SenderError('secretVersion includes duplicate recipient envelopes');
    }
    seenRecipients.add(envelope.recipientAgentDbId);

    const recipientActor = getRequiredActorByDbId(params.ctx, envelope.recipientAgentDbId);
    if (
      envelope.senderEncryptionKeyVersion !== params.senderAgent.currentEncryptionKeyVersion ||
      envelope.signingKeyVersion !== params.senderAgent.currentSigningKeyVersion ||
      envelope.recipientEncryptionKeyVersion !== recipientActor.currentEncryptionKeyVersion
    ) {
      throw new SenderError(
        'Sender or recipient key rotated since this secretVersion was published. Rotate the sender secret by attaching fresh envelopes to the next message.'
      );
    }
    requireCurrentEnvelopeVersions({
      senderAgent: params.senderAgent,
      recipientAgent: recipientActor,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
    });
  }
}

function validateAttachedSecretEnvelopes(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  activeParticipants: ReturnType<typeof getActiveThreadParticipants>;
  attachedSecretEnvelopes: Array<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: string;
    senderEncryptionKeyVersion: string;
    signingKeyVersion: string;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>;
}) {
  requireMaxArrayLength(
    params.attachedSecretEnvelopes,
    MAX_THREAD_FANOUT,
    'attachedSecretEnvelopes'
  );

  const expectedRecipientIds = new Set(params.activeParticipants.map(row => row.agentDbId));

  if (params.attachedSecretEnvelopes.length !== expectedRecipientIds.size) {
    throw new SenderError('Rotation envelopes must cover every active participant exactly once');
  }

  if (
    getSecretEnvelopesForVersion(
        params.ctx,
        params.threadId,
        params.membershipVersion,
        params.senderAgent.id,
      params.secretVersion
    ).length > 0
  ) {
    throw new SenderError('secretVersion is already published for this sender');
  }

  const seenRecipients = new Set<bigint>();
  for (const envelope of params.attachedSecretEnvelopes) {
    const recipientPublicIdentity = requireNonEmpty(
      envelope.recipientPublicIdentity,
      'recipientPublicIdentity'
    );
    const recipientActor = getRequiredActorByPublicIdentity(params.ctx, recipientPublicIdentity);

    if (!expectedRecipientIds.has(recipientActor.id)) {
      throw new SenderError('Rotation envelope recipient is not an active participant');
    }
    if (seenRecipients.has(recipientActor.id)) {
      throw new SenderError('Duplicate secret envelope recipient');
    }
    seenRecipients.add(recipientActor.id);

    requireNonEmpty(envelope.recipientEncryptionKeyVersion, 'recipientEncryptionKeyVersion');
    requireNonEmpty(envelope.senderEncryptionKeyVersion, 'senderEncryptionKeyVersion');
    requireNonEmpty(envelope.signingKeyVersion, 'signingKeyVersion');
    requireHexMaxLength(
      envelope.wrappedSecretCiphertext.trim(),
      MAX_WRAPPED_SECRET_CIPHERTEXT_HEX_CHARS,
      'wrappedSecretCiphertext'
    );
    requireHexMaxLength(
      envelope.wrappedSecretIv.trim(),
      MAX_WRAPPED_SECRET_IV_HEX_CHARS,
      'wrappedSecretIv'
    );
    requireNonEmpty(envelope.wrapAlgorithm, 'wrapAlgorithm');
    requireHexMaxLength(
      envelope.signature.trim(),
      MAX_MESSAGE_SIGNATURE_HEX_CHARS,
      'signature'
    );
    requireMaxLength(
      envelope.recipientEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'recipientEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.senderEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'senderEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.signingKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'signingKeyVersion'
    );
    requireMaxLength(
      envelope.wrapAlgorithm.trim(),
      MAX_MESSAGE_ALGORITHM_CHARS,
      'wrapAlgorithm'
    );
    requireCurrentEnvelopeVersions({
      senderAgent: params.senderAgent,
      recipientAgent: recipientActor,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
    });
  }
}

function validateBackfillSecretEnvelopes(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  activeParticipants: ReturnType<typeof getActiveThreadParticipants>;
  attachedSecretEnvelopes: Array<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: string;
    senderEncryptionKeyVersion: string;
    signingKeyVersion: string;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>;
}) {
  requireMaxArrayLength(
    params.attachedSecretEnvelopes,
    MAX_THREAD_FANOUT,
    'attachedSecretEnvelopes'
  );

  if (params.attachedSecretEnvelopes.length === 0) {
    throw new SenderError('attachedSecretEnvelopes must include at least one envelope');
  }

  const expectedRecipientIds = new Set(params.activeParticipants.map(row => row.agentDbId));
  const seenRecipients = new Set<bigint>();
  for (const envelope of params.attachedSecretEnvelopes) {
    const recipientPublicIdentity = requireNonEmpty(
      envelope.recipientPublicIdentity,
      'recipientPublicIdentity'
    );
    const recipientActor = getRequiredActorByPublicIdentity(params.ctx, recipientPublicIdentity);

    if (!expectedRecipientIds.has(recipientActor.id)) {
      throw new SenderError('Backfill envelope recipient is not an active participant');
    }
    if (seenRecipients.has(recipientActor.id)) {
      throw new SenderError('Duplicate secret envelope recipient');
    }
    seenRecipients.add(recipientActor.id);

    requireNonEmpty(envelope.recipientEncryptionKeyVersion, 'recipientEncryptionKeyVersion');
    requireNonEmpty(envelope.senderEncryptionKeyVersion, 'senderEncryptionKeyVersion');
    requireNonEmpty(envelope.signingKeyVersion, 'signingKeyVersion');
    requireHexMaxLength(
      envelope.wrappedSecretCiphertext.trim(),
      MAX_WRAPPED_SECRET_CIPHERTEXT_HEX_CHARS,
      'wrappedSecretCiphertext'
    );
    requireHexMaxLength(
      envelope.wrappedSecretIv.trim(),
      MAX_WRAPPED_SECRET_IV_HEX_CHARS,
      'wrappedSecretIv'
    );
    requireNonEmpty(envelope.wrapAlgorithm, 'wrapAlgorithm');
    requireHexMaxLength(
      envelope.signature.trim(),
      MAX_MESSAGE_SIGNATURE_HEX_CHARS,
      'signature'
    );
    requireMaxLength(
      envelope.recipientEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'recipientEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.senderEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'senderEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.signingKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'signingKeyVersion'
    );
    requireMaxLength(
      envelope.wrapAlgorithm.trim(),
      MAX_MESSAGE_ALGORITHM_CHARS,
      'wrapAlgorithm'
    );
    requireCurrentEnvelopeVersions({
      senderAgent: params.senderAgent,
      recipientAgent: recipientActor,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
    });

    const uniqueKey = buildThreadSecretEnvelopeKey(
      params.threadId,
      params.membershipVersion,
      params.secretVersion,
      params.senderAgent.id,
      recipientActor.id
    );
    if (params.ctx.db.threadSecretEnvelope.uniqueKey.find(uniqueKey)) {
      throw new SenderError('Secret envelope is already published for this recipient');
    }
  }
}

function insertAttachedSecretEnvelopes(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  attachedSecretEnvelopes: Array<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: string;
    senderEncryptionKeyVersion: string;
    signingKeyVersion: string;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>;
}) {
  for (const envelope of params.attachedSecretEnvelopes) {
    const recipientActor = getRequiredActorByPublicIdentity(
      params.ctx,
      requireNonEmpty(envelope.recipientPublicIdentity, 'recipientPublicIdentity')
    );
    params.ctx.db.threadSecretEnvelope.insert({
        id: 0n,
        threadId: params.threadId,
        membershipVersion: params.membershipVersion,
        secretVersion: params.secretVersion,
      senderAgentDbId: params.senderAgent.id,
      recipientAgentDbId: recipientActor.id,
      uniqueKey: buildThreadSecretEnvelopeKey(
        params.threadId,
        params.membershipVersion,
        params.secretVersion,
        params.senderAgent.id,
        recipientActor.id
      ),
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion.trim(),
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion.trim(),
      signingKeyVersion: envelope.signingKeyVersion.trim(),
      wrappedSecretCiphertext: envelope.wrappedSecretCiphertext.trim(),
      wrappedSecretIv: envelope.wrappedSecretIv.trim(),
      wrapAlgorithm: envelope.wrapAlgorithm.trim(),
      signature: envelope.signature.trim(),
      createdAt: params.ctx.timestamp,
    });
  }
}

export const visibleInboxes = spacetimedb.view(
  { public: true },
  t.array(VisibleInboxRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    return inbox ? [inbox] : [];
  }
);

export const visibleAgents = spacetimedb.view(
  { public: true },
  t.array(VisibleAgentRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return Array.from(buildVisibleAgentIdsForInbox(ctx, inbox.id))
      .map(agentDbId => ctx.db.agent.id.find(agentDbId))
      .filter((actor): actor is NonNullable<typeof actor> => Boolean(actor))
      .map(actor => toSanitizedVisibleAgentRow(ctx, inbox.id, actor));
  }
);

export const visibleAgentKeyBundles = spacetimedb.view(
  { public: true },
  t.array(VisibleAgentKeyBundleRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return Array.from(buildVisibleAgentIdsForInbox(ctx, inbox.id)).flatMap(agentDbId =>
      Array.from(ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id.filter(agentDbId))
    );
  }
);

export const visibleDevices = spacetimedb.view(
  { public: true },
  t.array(VisibleDeviceRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return getDevicesByInboxId(ctx, inbox.id);
  }
);

export const visibleDeviceShareRequests = spacetimedb.view(
  { public: true },
  t.array(VisibleDeviceShareRequestRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const devicesById = new Map(
      getDevicesByInboxId(ctx, inbox.id).map(device => [device.deviceId, device] as const)
    );
    const visibleRequests = Array.from(
      ctx.db.deviceShareRequest.device_share_request_inbox_id.filter(inbox.id)
    ).filter(request => !request.consumedAt && devicesById.has(request.deviceId));

    return visibleRequests
      .map(request => {
        const device = devicesById.get(request.deviceId);
        return {
          id: request.id,
          deviceId: request.deviceId,
          label: device?.label,
          platform: device?.platform,
          clientCreatedAt: request.clientCreatedAt,
          expiresAt: request.expiresAt,
          createdAt: request.createdAt,
          approvedAt: request.approvedAt,
          consumedAt: request.consumedAt,
        };
      });
  }
);

export const visibleDeviceKeyBundles = spacetimedb.view(
  { public: true },
  t.array(VisibleDeviceKeyBundleRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const deviceIds = new Set(getDevicesByInboxId(ctx, inbox.id).map(device => device.deviceId));
    return Array.from(ctx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(inbox.id))
      .filter(bundle => !bundle.consumedAt && deviceIds.has(bundle.targetDeviceId))
      .map(bundle => ({
        id: bundle.id,
        targetDeviceId: bundle.targetDeviceId,
        sourceDeviceId: bundle.sourceDeviceId,
        sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
        sourceEncryptionKeyVersion: bundle.sourceEncryptionKeyVersion,
        sourceEncryptionAlgorithm: bundle.sourceEncryptionAlgorithm,
        bundleAlgorithm: bundle.bundleAlgorithm,
        sharedAgentCount: bundle.sharedAgentCount,
        sharedKeyVersionCount: bundle.sharedKeyVersionCount,
        createdAt: bundle.createdAt,
        expiresAt: bundle.expiresAt,
        consumedAt: bundle.consumedAt,
        expiryMode: bundle.expiryMode,
      }));
  }
);

export const visibleThreads = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inbox.id);

    return Array.from(visibleThreadIds)
      .map(threadId => ctx.db.thread.id.find(threadId))
      .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));
  }
);

export const visibleThreadParticipants = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadParticipantRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return Array.from(buildVisibleThreadParticipantIdsForInbox(ctx, inbox.id))
      .map(participantId => ctx.db.threadParticipant.id.find(participantId))
      .filter((participant): participant is NonNullable<typeof participant> => Boolean(participant))
      .map(participant => ({
        id: participant.id,
        threadId: participant.threadId,
        agentDbId: participant.agentDbId,
        joinedAt: participant.joinedAt,
        lastSentSeq: participant.lastSentSeq,
        lastSentMembershipVersion: participant.lastSentMembershipVersion,
        lastSentSecretVersion: participant.lastSentSecretVersion,
        isAdmin: participant.isAdmin,
        active: participant.active,
      }));
  }
);

export const visibleThreadReadStates = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadReadStateRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = new Set(
      Array.from(ctx.db.agent.agent_inbox_id.filter(inbox.id)).map(actor => actor.id)
    );
    const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inbox.id);

    return Array.from(ownActorIds).flatMap(agentDbId =>
      Array.from(ctx.db.threadReadState.thread_read_state_agent_db_id.filter(agentDbId)).filter(
        readState => visibleThreadIds.has(readState.threadId)
      )
    );
  }
);

export const visibleThreadInvites = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadInviteRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const incomingInvites = Array.from(
      ctx.db.threadInvite.thread_invite_invitee_inbox_id.filter(inbox.id)
    );
    const outgoingInvites = Array.from(getOwnActorIdsForInbox(ctx, inbox.id)).flatMap(agentDbId =>
      Array.from(ctx.db.threadInvite.thread_invite_inviter_agent_db_id.filter(agentDbId))
    );

    return dedupeRowsById([...incomingInvites, ...outgoingInvites])
      .map(invite => toVisibleThreadInviteRow(ctx, invite));
  }
);

export const visibleThreadSecretEnvelopes = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadSecretEnvelopeRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = new Set(
      Array.from(ctx.db.agent.agent_inbox_id.filter(inbox.id)).map(actor => actor.id)
    );
    const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inbox.id);

    return dedupeRowsById(
      Array.from(ownActorIds).flatMap(agentDbId => [
        ...Array.from(
          ctx.db.threadSecretEnvelope.thread_secret_envelope_sender_agent_db_id.filter(agentDbId)
        ),
        ...Array.from(
          ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(agentDbId)
        ),
      ]).filter(envelope => visibleThreadIds.has(envelope.threadId))
    );
  }
);

export const visibleMessages = spacetimedb.view(
  { public: true },
  t.array(VisibleMessageRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = getOwnActorIdsForInbox(ctx, inbox.id);
    const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inbox.id);

    return Array.from(visibleThreadIds).flatMap(threadId => {
      const ownSenderVersionKeys = new Set(
        Array.from(ownActorIds).flatMap(agentDbId =>
          Array.from(
            ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(
              agentDbId
            )
          )
        )
          .filter(envelope => envelope.threadId === threadId)
          .map(envelope =>
            buildSenderSecretVisibilityKey(
              envelope.membershipVersion,
              envelope.senderAgentDbId,
              envelope.secretVersion
            )
          )
      );

      return Array.from(
        ctx.db.message.message_thread_id.filter(threadId)
      ).filter(
        message =>
          ownActorIds.has(message.senderAgentDbId) ||
          ownSenderVersionKeys.has(
            buildSenderSecretVisibilityKey(
              message.membershipVersion,
              message.senderAgentDbId,
              message.secretVersion
            )
          )
      );
    });
  }
);

export const visibleContactRequests = spacetimedb.view(
  { public: true },
  t.array(VisibleContactRequestRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return getVisibleContactRequestsForInbox(ctx, inbox.id)
      .map(request => toVisibleContactRequestRow(ctx, inbox.id, request));
  }
);

export const visibleContactAllowlistEntries = spacetimedb.view(
  { public: true },
  t.array(VisibleContactAllowlistEntryRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return getContactAllowlistEntriesByInboxId(ctx, inbox.id)
      .map(entry => ({
        id: entry.id,
        inboxId: entry.inboxId,
        kind: entry.kind.tag,
        agentPublicIdentity: entry.agentPublicIdentity,
        agentSlug: entry.agentSlug,
        agentDisplayName: entry.agentDisplayName,
        normalizedEmail: entry.normalizedEmail,
        displayEmail: entry.displayEmail,
        createdByAgentDbId: entry.createdByAgentDbId,
        createdAt: entry.createdAt,
      }));
  }
);

export const expireInboxAuthLease = spacetimedb.reducer(
  { arg: inboxAuthLeaseExpiryTable.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) {
      throw new SenderError('This reducer can only be called by the scheduler');
    }

    const lease = ctx.db.inboxAuthLease.id.find(arg.leaseId);
    ctx.db.inboxAuthLeaseExpiry.delete(arg);
    if (!lease || !lease.active) {
      return;
    }
    if (
      lease.ownerIdentity.toHexString() !== arg.ownerIdentity.toHexString() ||
      lease.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(lease.expiresAt, Timestamp.now())
    ) {
      return;
    }

    ctx.db.inboxAuthLease.id.update({
      ...lease,
      active: false,
      updatedAt: ctx.timestamp,
    });
  }
);

export const expireDeviceKeyBundle = spacetimedb.reducer(
  { arg: deviceKeyBundleExpiryTable.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) {
      throw new SenderError('This reducer can only be called by the scheduler');
    }

    const bundle = ctx.db.deviceKeyBundle.id.find(arg.bundleId);
    ctx.db.deviceKeyBundleExpiry.delete(arg);
    if (!bundle || bundle.consumedAt || isNeverExpiringDeviceKeyBundle(bundle)) {
      return;
    }
    if (
      bundle.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(bundle.expiresAt, ctx.timestamp)
    ) {
      return;
    }

    ctx.db.deviceKeyBundle.id.update({
      ...bundle,
      consumedAt: ctx.timestamp,
    });
  }
);

export const expireRateLimitBucket = spacetimedb.reducer(
  { arg: rateLimitCleanupTable.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) {
      throw new SenderError('This reducer can only be called by the scheduler');
    }

    const bucket = ctx.db.rateLimit.bucketKey.find(arg.bucketKey);
    ctx.db.rateLimitCleanup.delete(arg);
    if (!bucket) {
      return;
    }
    if (
      bucket.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(bucket.expiresAt, ctx.timestamp)
    ) {
      return;
    }

    reportRateLimitBucket(ctx, bucket, ctx.timestamp);
    ctx.db.rateLimit.id.delete(bucket.id);
  }
);

export const expireRateLimitReport = spacetimedb.reducer(
  { arg: rateLimitReportCleanupTable.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) {
      throw new SenderError('This reducer can only be called by the scheduler');
    }

    const report = ctx.db.rateLimitReport.id.find(arg.reportId);
    ctx.db.rateLimitReportCleanup.delete(arg);
    if (!report) {
      return;
    }
    if (
      report.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(report.expiresAt, ctx.timestamp)
    ) {
      return;
    }

    ctx.db.rateLimitReport.id.delete(report.id);
  }
);

export const clientConnected = spacetimedb.clientConnected(ctx => {
  const inbox = getInboxByOwnerIdentity(ctx);
  if (!inbox) {
    return;
  }
  try {
    refreshInboxAuthLeaseForInbox(ctx, inbox);
  } catch (error) {
    if (isExpectedInboxAuthLeaseRefreshError(error)) {
      deactivateSenderInboxAuthLease(ctx);
      return;
    }
    throw error;
  }
});

export const refreshInboxAuthLease = spacetimedb.reducer(ctx => {
  const inbox = getOwnedInboxAnyStatus(ctx);
  requireVerifiedInbox(inbox);
  refreshInboxAuthLeaseForInbox(ctx, inbox);
});

export const lookupPublishedAgentBySlug = spacetimedb.procedure(
  {
    slug: t.string(),
  },
  t.array(PublishedAgentLookupRow),
  (ctx, { slug }) => {
    return ctx.withTx(tx => {
      const normalizedSlug = normalizeInboxSlug(slug);
      if (!normalizedSlug) {
        return [];
      }

      const actor = getActorBySlug(tx, normalizedSlug);
      if (!actor) {
        return [];
      }

      return [toPublishedAgentLookupRow(actor)];
    });
  }
);

export const lookupPublishedAgentsByEmail = spacetimedb.procedure(
  {
    email: t.string(),
  },
  t.array(PublishedAgentLookupRow),
  (ctx, { email }) => {
    return ctx.withTx(tx => {
      const allowed = enforceRateLimit(tx, {
        bucketKey: `email_lookup:${ctx.sender.toHexString()}`,
        action: 'email_lookup',
        ownerIdentity: ctx.sender,
        now: ctx.timestamp,
        windowMs: EMAIL_LOOKUP_RATE_WINDOW_MS,
        maxCount: EMAIL_LOOKUP_RATE_MAX_PER_WINDOW,
      });
      if (!allowed) {
        return [];
      }

      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return [];
      }

      return getPublicActorsByNormalizedEmail(tx, normalizedEmail).map(
        toPublishedAgentLookupRow
      );
    });
  }
);

export const lookupPublishedPublicRouteBySlug = spacetimedb.procedure(
  {
    slug: t.string(),
  },
  t.array(PublishedPublicRouteRow),
  (ctx, { slug }) => {
    return ctx.withTx(tx => {
      const normalizedSlug = normalizeInboxSlug(slug);
      if (!normalizedSlug) {
        return [];
      }

      const actor = getActorBySlug(tx, normalizedSlug);
      if (!actor) {
        return [];
      }

      const inbox = tx.db.inbox.id.find(actor.inboxId);
      if (!inbox) {
        return [];
      }

      return [toPublishedPublicRouteRow(actor, inbox)];
    });
  }
);

export const resolveDeviceShareRequestByCode = spacetimedb.procedure(
  {
    verificationCodeHash: t.string(),
  },
  t.array(ResolvedDeviceShareRequestRow),
  (ctx, { verificationCodeHash }) => {
    return ctx.withTx(tx => {
      const inbox = getOwnedInbox(tx);
      const allowed = enforceRateLimit(tx, {
        bucketKey: `device_share_resolve:${ctx.sender.toHexString()}`,
        action: 'device_share_resolve',
        ownerIdentity: ctx.sender,
        now: ctx.timestamp,
        windowMs: DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS,
        maxCount: DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW,
      });
      if (!allowed) {
        return [];
      }
      const normalizedVerificationCodeHash =
        normalizeVerificationCodeHash(verificationCodeHash);
      let resolved:
        | {
            request: DeviceShareRequestRow;
            device: DeviceRow;
          }
        | undefined;
      for (const candidate of tx.db.deviceShareRequest.device_share_request_verification_code_hash.filter(
        normalizedVerificationCodeHash
      )) {
        if (
          candidate.inboxId !== inbox.id ||
          candidate.approvedAt ||
          candidate.consumedAt ||
          isTimestampExpired(candidate.expiresAt, ctx.timestamp)
        ) {
          continue;
        }

        const candidateDevice = getDeviceByInboxDeviceId(tx, inbox.id, candidate.deviceId);
        if (
          candidateDevice &&
          candidateDevice.inboxId === inbox.id &&
          !candidateDevice.revokedAt &&
          candidateDevice.status !== 'revoked'
        ) {
          resolved = { request: candidate, device: candidateDevice };
          break;
        }
      }

      if (!resolved) {
        return [];
      }

      const { request, device } = resolved;

      return [
        {
          requestId: request.id,
          deviceId: device.deviceId,
          label: device.label,
          platform: device.platform,
          deviceEncryptionPublicKey: device.deviceEncryptionPublicKey,
          deviceEncryptionKeyVersion: device.deviceEncryptionKeyVersion,
          deviceEncryptionAlgorithm: device.deviceEncryptionAlgorithm,
          clientCreatedAt: request.clientCreatedAt,
          expiresAt: request.expiresAt,
          createdAt: request.createdAt,
        },
      ];
    });
  }
);

export const claimDeviceKeyBundle = spacetimedb.procedure(
  {
    deviceId: t.string(),
  },
  t.array(ClaimedDeviceKeyBundleRow),
  (ctx, { deviceId }) => {
    return ctx.withTx(tx => {
      const device = getOwnedDevice(tx, normalizeDeviceId(deviceId));
      if (device.revokedAt || device.status === 'revoked') {
        throw new SenderError('Device is revoked and cannot claim new key shares');
      }
      if (device.status !== 'approved' || !device.approvedAt) {
        throw new SenderError('Device is pending approval and cannot claim new key shares');
      }

      const claimableBundles = Array.from(
        tx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(device.inboxId)
      )
        .filter(bundle => bundle.targetDeviceId === device.deviceId)
        .filter(bundle => isClaimableDeviceKeyBundle(bundle, ctx.timestamp))
        .sort((left, right) => {
          const timeOrder = compareTimestamp(left.createdAt, right.createdAt);
          if (timeOrder !== 0) return timeOrder;
          return Number(left.id - right.id);
        });

      const bundle =
        claimableBundles.length > 0
          ? claimableBundles[claimableBundles.length - 1]
          : undefined;
      if (!bundle) {
        return [];
      }

      tx.db.deviceKeyBundle.id.update({
        ...bundle,
        consumedAt: ctx.timestamp,
      });

      tx.db.device.id.update({
        ...device,
        lastSeenAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });

      return [
        {
          bundleId: bundle.id,
          targetDeviceId: bundle.targetDeviceId,
            sourceDeviceId: bundle.sourceDeviceId,
            sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
            sourceEncryptionKeyVersion: bundle.sourceEncryptionKeyVersion,
            sourceEncryptionAlgorithm: bundle.sourceEncryptionAlgorithm,
            bundleCiphertext: bundle.bundleCiphertext,
          bundleIv: bundle.bundleIv,
          bundleAlgorithm: bundle.bundleAlgorithm,
          sharedAgentCount: bundle.sharedAgentCount,
          sharedKeyVersionCount: bundle.sharedKeyVersionCount,
          createdAt: bundle.createdAt,
          expiresAt: bundle.expiresAt,
          expiryMode: bundle.expiryMode,
        },
      ];
    });
  }
);

export const registerDevice = spacetimedb.reducer(
  {
    deviceId: t.string(),
    label: t.string().optional(),
      platform: t.string().optional(),
      deviceEncryptionPublicKey: t.string(),
      deviceEncryptionKeyVersion: t.string(),
      deviceEncryptionAlgorithm: t.string().optional(),
    },
    (
      ctx,
      {
        deviceId,
        label,
        platform,
        deviceEncryptionPublicKey,
        deviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm,
      }
    ) => {
      const inbox = getOwnedInbox(ctx);
      upsertInboxDevice(ctx, inbox.id, {
        deviceId,
        label,
        platform,
        deviceEncryptionPublicKey,
        deviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm,
      });
    }
);

export const createDeviceShareRequest = spacetimedb.reducer(
  {
    deviceId: t.string(),
    verificationCodeHash: t.string(),
    clientCreatedAt: t.timestamp(),
  },
  (ctx, { deviceId, verificationCodeHash, clientCreatedAt }) => {
    const device = getOwnedDevice(ctx, normalizeDeviceId(deviceId));
    const normalizedVerificationCodeHash =
      normalizeVerificationCodeHash(verificationCodeHash);
    const maxAgeMicros = durationMillisecondsToMicros(DEVICE_SHARE_REQUEST_MAX_AGE_MS);
    const maxFutureSkewMicros = durationMillisecondsToMicros(
      DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS
    );
    const createdMicros = clientCreatedAt.microsSinceUnixEpoch;
    const nowMicros = ctx.timestamp.microsSinceUnixEpoch;

    if (device.revokedAt || device.status === 'revoked') {
      throw new SenderError('Revoked devices cannot create new share requests');
    }
    if (createdMicros < nowMicros - maxAgeMicros) {
      throw new SenderError(
        'Device share request is too old. Generate a new emoji share code and try again.'
      );
    }
    if (createdMicros > nowMicros + maxFutureSkewMicros) {
      throw new SenderError(
        'Device share request is too far in the future. Check the requesting device clock and try again.'
      );
    }

    invalidatePendingDeviceShareRequests(ctx, device.inboxId, device.deviceId);

    ctx.db.deviceShareRequest.insert({
      id: 0n,
      deviceId: device.deviceId,
      inboxId: device.inboxId,
      verificationCodeHash: normalizedVerificationCodeHash,
      clientCreatedAt,
      expiresAt: timestampPlusMilliseconds(clientCreatedAt, DEVICE_SHARE_REQUEST_EXPIRY_MS),
      createdAt: ctx.timestamp,
      approvedAt: undefined,
      consumedAt: undefined,
    });

    ctx.db.device.id.update({
      ...device,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
  }
);

export const approveDeviceShare = spacetimedb.reducer(
  {
    requestId: t.u64(),
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
  },
  (
    ctx,
    {
      requestId,
        sourceDeviceId,
        sourceEncryptionPublicKey,
        sourceEncryptionKeyVersion,
        sourceEncryptionAlgorithm,
        bundleCiphertext,
      bundleIv,
      bundleAlgorithm,
      sharedAgentCount,
      sharedKeyVersionCount,
      expiresAt,
    }
	  ) => {
	    const request = getRequiredDeviceShareRequestByRowId(ctx, requestId);
	    const device = getOwnedDevice(ctx, request.deviceId);
	    if (request.inboxId !== device.inboxId) {
	      throw new SenderError('Device share request does not belong to this inbox');
	    }

	    if (!isPendingDeviceShareRequest(request, ctx.timestamp)) {
      throw new SenderError('Device share request is no longer pending');
    }
    if (device.revokedAt || device.status === 'revoked') {
      throw new SenderError('Target device is revoked');
    }

    const normalizedSourceDeviceId = sourceDeviceId?.trim() || undefined;
    if (normalizedSourceDeviceId) {
      const sourceDevice = getOwnedDevice(ctx, normalizedSourceDeviceId);
      if (sourceDevice.revokedAt || sourceDevice.status === 'revoked') {
        throw new SenderError('Source device is revoked');
      }
      if (sourceDevice.status !== 'approved' || !sourceDevice.approvedAt) {
        throw new SenderError('Source device must be approved before it can share keys');
      }
      if (sourceDevice.deviceId === device.deviceId) {
        throw new SenderError('Source device cannot be the target device');
      }
    }

    insertDeviceKeyBundle(ctx, {
      deviceId: device.deviceId,
        sourceDeviceId: normalizedSourceDeviceId,
        sourceEncryptionPublicKey,
        sourceEncryptionKeyVersion,
        sourceEncryptionAlgorithm,
        bundleCiphertext,
      bundleIv,
      bundleAlgorithm,
        sharedAgentCount,
        sharedKeyVersionCount,
        expiresAt,
        expiryMode: DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES,
      });

    ctx.db.deviceShareRequest.id.update({
      ...request,
      approvedAt: ctx.timestamp,
      consumedAt: ctx.timestamp,
    });

    ctx.db.device.id.update({
      ...device,
      status: normalizeDeviceStatus('approved'),
      approvedAt: device.approvedAt ?? ctx.timestamp,
      revokedAt: undefined,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
  }
);

export const revokeDevice = spacetimedb.reducer(
  {
    deviceId: t.string(),
  },
  (ctx, { deviceId }) => {
    const device = getOwnedDevice(ctx, normalizeDeviceId(deviceId));
    if (device.revokedAt && device.status === 'revoked') {
      return;
    }

    invalidatePendingDeviceShareRequests(ctx, device.inboxId, device.deviceId);
    invalidatePendingDeviceKeyBundles(ctx, device.inboxId, device.deviceId);

    ctx.db.device.id.update({
      ...device,
      status: normalizeDeviceStatus('revoked'),
      revokedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
  }
);

export const upsertMasumiInboxAgentRegistration = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    masumiRegistrationNetwork: t.string().optional(),
    masumiInboxAgentId: t.string().optional(),
    masumiAgentIdentifier: t.string().optional(),
    masumiRegistrationState: t.string().optional(),
  },
  (
    ctx,
    {
      agentDbId,
      masumiRegistrationNetwork,
      masumiInboxAgentId,
      masumiAgentIdentifier,
      masumiRegistrationState,
    }
  ) => {
    const actor = getOwnedActor(ctx, agentDbId);

    ctx.db.agent.id.update({
      ...actor,
      masumiRegistrationNetwork: normalizeOptionalMasumiNetwork(masumiRegistrationNetwork),
      masumiInboxAgentId: normalizeOptionalMasumiRegistrationId(
        masumiInboxAgentId,
        'masumiInboxAgentId'
      ),
      masumiAgentIdentifier: normalizeOptionalMasumiRegistrationId(
        masumiAgentIdentifier,
        'masumiAgentIdentifier'
      ),
      masumiRegistrationState: normalizeOptionalMasumiRegistrationState(
        masumiRegistrationState
      ),
      updatedAt: ctx.timestamp,
    });
  }
);

export const setAgentPublicLinkedEmailVisibility = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    enabled: t.bool(),
  },
  (ctx, { agentDbId, enabled }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    ctx.db.agent.id.update({
      ...actor,
      publicLinkedEmailEnabled: enabled,
      updatedAt: ctx.timestamp,
    });
  }
);

export const setAgentPublicDescription = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    description: t.string().optional(),
  },
  (ctx, { agentDbId, description }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    ctx.db.agent.id.update({
      ...actor,
      publicDescription: normalizeOptionalPublicDescription(description),
      updatedAt: ctx.timestamp,
    });
  }
);

export const updateAgentProfile = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    displayName: t.string().optional(),
    clearDisplayName: t.bool().optional(),
    publicDescription: t.string().optional(),
    clearPublicDescription: t.bool().optional(),
    publicLinkedEmailEnabled: t.bool().optional(),
  },
  (
    ctx,
    {
      agentDbId,
      displayName,
      clearDisplayName,
      publicDescription,
      clearPublicDescription,
      publicLinkedEmailEnabled,
    }
  ) => {
    const actor = getOwnedActor(ctx, agentDbId);

    if (displayName?.trim() && clearDisplayName) {
      throw new SenderError('Choose either displayName or clearDisplayName');
    }
    if (publicDescription?.trim() && clearPublicDescription) {
      throw new SenderError(
        'Choose either publicDescription or clearPublicDescription'
      );
    }

    const nextDisplayName = clearDisplayName
      ? undefined
      : displayName !== undefined
        ? normalizeOptionalDisplayName(displayName)
        : actor.displayName;
    const nextPublicDescription = clearPublicDescription
      ? undefined
      : publicDescription !== undefined
        ? normalizeOptionalPublicDescription(publicDescription)
        : actor.publicDescription;
    const nextPublicLinkedEmailEnabled =
      publicLinkedEmailEnabled ?? actor.publicLinkedEmailEnabled;

    ctx.db.agent.id.update({
      ...actor,
      displayName: nextDisplayName,
      publicDescription: nextPublicDescription,
      publicLinkedEmailEnabled: nextPublicLinkedEmailEnabled,
      updatedAt: ctx.timestamp,
    });
  }
);

export const setAgentPublicMessageCapabilities = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    allowAllContentTypes: t.bool().optional(),
    allowAllHeaders: t.bool().optional(),
    supportedContentTypes: t.array(t.string()),
    supportedHeaders: t.array(t.string()),
  },
  (ctx, { agentDbId, allowAllContentTypes, allowAllHeaders, supportedContentTypes, supportedHeaders }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    let normalizedContentTypes: string[];
    let normalizedHeaders: string[];
    try {
      normalizedContentTypes = normalizeSupportedContentTypes(supportedContentTypes);
      normalizedHeaders = normalizeSupportedHeaderNames(supportedHeaders);
    } catch (error) {
      throw new SenderError(error instanceof Error ? error.message : 'Invalid public message capabilities');
    }

    ctx.db.agent.id.update({
      ...actor,
      allowAllMessageContentTypes:
        normalizedContentTypes.length === 0
          ? true
          : (allowAllContentTypes ?? actor.allowAllMessageContentTypes ?? false),
      allowAllMessageHeaders:
        normalizedHeaders.length === 0
          ? true
          : (allowAllHeaders ?? actor.allowAllMessageHeaders ?? false),
      supportedMessageContentTypes: normalizedContentTypes,
      supportedMessageHeaderNames: normalizedHeaders,
      updatedAt: ctx.timestamp,
    });
  }
);

export const addContactAllowlistEntry = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    agentPublicIdentity: t.string().optional(),
    email: t.string().optional(),
  },
  (ctx, { agentDbId, agentPublicIdentity, email }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const inbox = getOwnedInbox(ctx);
    const normalizedAgentPublicIdentity = agentPublicIdentity?.trim()
      ? normalizePublicIdentity(agentPublicIdentity)
      : undefined;
    const trimmedEmail = email?.trim();
    const normalizedEmail = trimmedEmail ? requireValidEmail(trimmedEmail, 'email') : undefined;
    const displayEmailInput = trimmedEmail || undefined;

    if (Boolean(normalizedAgentPublicIdentity) === Boolean(normalizedEmail)) {
      throw new SenderError('Provide exactly one contact allowlist value');
    }

    const existingEntries = getContactAllowlistEntriesByInboxId(ctx, inbox.id);

    if (normalizedAgentPublicIdentity) {
      const targetActor = getRequiredActorByPublicIdentity(ctx, normalizedAgentPublicIdentity);
      const existing = existingEntries.find(entry => {
        return (
          entry.inboxId === inbox.id &&
          entry.kind.tag === 'agent' &&
          entry.agentPublicIdentity === targetActor.publicIdentity
        );
      });
      if (existing) {
        return;
      }

      const agentKind = normalizeContactAllowlistKind('agent');
      ctx.db.contactAllowlistEntry.insert({
        id: 0n,
        inboxId: inbox.id,
        kind: agentKind,
        uniqueKey: buildContactAllowlistEntryKey(
          inbox.id,
          agentKind.tag,
          targetActor.publicIdentity,
          undefined
        ),
        agentPublicIdentity: targetActor.publicIdentity,
        agentSlug: targetActor.slug,
        agentDisplayName: targetActor.displayName,
        normalizedEmail: undefined,
        displayEmail: undefined,
        createdByAgentDbId: actor.id,
        createdAt: ctx.timestamp,
      });
      return;
    }

    const existing = existingEntries.find(entry => {
      return (
        entry.inboxId === inbox.id &&
        entry.kind.tag === 'email' &&
        entry.normalizedEmail === normalizedEmail
      );
    });
    if (existing) {
      return;
    }

    const emailKind = normalizeContactAllowlistKind('email');
    ctx.db.contactAllowlistEntry.insert({
      id: 0n,
      inboxId: inbox.id,
      kind: emailKind,
      uniqueKey: buildContactAllowlistEntryKey(inbox.id, emailKind.tag, undefined, normalizedEmail),
      agentPublicIdentity: undefined,
      agentSlug: undefined,
      agentDisplayName: undefined,
      normalizedEmail,
      displayEmail: displayEmailInput ?? normalizedEmail,
      createdByAgentDbId: actor.id,
      createdAt: ctx.timestamp,
    });
  }
);

export const removeContactAllowlistEntry = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    entryId: t.u64(),
  },
  (ctx, { agentDbId, entryId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const entry = getRequiredContactAllowlistEntryByRowId(ctx, entryId);
    if (entry.inboxId !== actor.inboxId) {
      throw new SenderError('Contact allowlist entry does not belong to this inbox');
    }

    ctx.db.contactAllowlistEntry.id.delete(entryId);
  }
);

export const approveContactRequest = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    requestId: t.u64(),
  },
  (ctx, { agentDbId, requestId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const request = getRequiredContactRequestByRowId(ctx, requestId);
    if (request.targetAgentDbId !== actor.id) {
      throw new SenderError('Only the target inbox slug may approve this contact request');
    }
    if (request.status.tag !== 'pending') {
      throw new SenderError('Only pending contact requests can be approved');
    }

    ctx.db.contactRequest.id.update({
      ...request,
      status: normalizeContactRequestStatus('approved'),
      updatedAt: ctx.timestamp,
      resolvedAt: ctx.timestamp,
      resolvedByAgentDbId: actor.id,
    });
  }
);

export const rejectContactRequest = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    requestId: t.u64(),
  },
  (ctx, { agentDbId, requestId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const request = getRequiredContactRequestByRowId(ctx, requestId);
    if (request.targetAgentDbId !== actor.id) {
      throw new SenderError('Only the target inbox slug may reject this contact request');
    }
    if (request.status.tag !== 'pending') {
      throw new SenderError('Only pending contact requests can be rejected');
    }

    ctx.db.contactRequest.id.update({
      ...request,
      status: normalizeContactRequestStatus('rejected'),
      updatedAt: ctx.timestamp,
      resolvedAt: ctx.timestamp,
      resolvedByAgentDbId: actor.id,
    });
    deleteThreadAndDependents(ctx, request.threadId, { preserveContactRequests: true });
  }
);

export const upsertInboxFromOidcIdentity = spacetimedb.reducer(
  {
    displayName: t.string().optional(),
    defaultSlug: t.string().optional(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string().optional(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string().optional(),
      deviceId: t.string(),
    deviceLabel: t.string().optional(),
    devicePlatform: t.string().optional(),
      deviceEncryptionPublicKey: t.string(),
      deviceEncryptionKeyVersion: t.string(),
      deviceEncryptionAlgorithm: t.string().optional(),
    },
  (
    ctx,
    {
      displayName,
      defaultSlug,
        encryptionPublicKey,
        encryptionKeyVersion,
        encryptionAlgorithm,
        signingPublicKey,
        signingKeyVersion,
        signingAlgorithm,
        deviceId,
      deviceLabel,
      devicePlatform,
        deviceEncryptionPublicKey,
        deviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm,
      }
  ) => {
    const oidcClaims = requireOidcIdentityClaims(ctx);
    const normalizedDisplayName =
      normalizeOptionalDisplayName(displayName) ??
      normalizeOptionalDisplayName(oidcClaims.displayName) ??
      undefined;
    const normalizedDefaultSlug = defaultSlug?.trim()
      ? normalizeExplicitDefaultInboxSlug(defaultSlug)
      : undefined;
    const normalizedEncryptionKey = normalizePublicKey(
      encryptionPublicKey,
      'encryptionPublicKey'
    );
      const normalizedEncryptionVersion = requireNonEmpty(
        encryptionKeyVersion,
        'encryptionKeyVersion'
      );
      const normalizedEncryptionAlgorithm = normalizeOptionalAlgorithm(
        encryptionAlgorithm,
        DEFAULT_AGENT_ENCRYPTION_ALGORITHM,
        'encryptionAlgorithm'
      );
      const normalizedSigningKey = normalizePublicKey(signingPublicKey, 'signingPublicKey');
      const normalizedSigningVersion = requireNonEmpty(
        signingKeyVersion,
        'signingKeyVersion'
      );
      const normalizedSigningAlgorithm = normalizeOptionalAlgorithm(
        signingAlgorithm,
        DEFAULT_AGENT_SIGNING_ALGORITHM,
        'signingAlgorithm'
      );

    const existingByEmail = getInboxByNormalizedEmail(
      ctx,
      oidcClaims.normalizedEmail
    );
    const existingByOwner = getInboxByOwnerIdentity(ctx);

    if (
      existingByEmail &&
      existingByEmail.ownerIdentity.toHexString() !== ctx.sender.toHexString()
    ) {
      throw new SenderError('This email inbox is already owned by another identity');
    }
    if (
      existingByEmail &&
      (existingByEmail.authIssuer !== oidcClaims.issuer ||
        existingByEmail.authSubject !== oidcClaims.subject)
    ) {
      throw new SenderError('This email inbox is already bound to a different OIDC identity');
    }
    if (
      existingByOwner &&
      existingByOwner.normalizedEmail !== oidcClaims.normalizedEmail
    ) {
      throw new SenderError(
        'This OIDC identity is already bound to a different email namespace'
      );
    }
    if (
      existingByOwner &&
      (existingByOwner.authIssuer !== oidcClaims.issuer ||
        existingByOwner.authSubject !== oidcClaims.subject)
    ) {
      throw new SenderError('This Spacetime identity is already bound to a different OIDC identity');
    }

    const inbox =
      existingByEmail ??
      (existingByOwner
        ? existingByOwner
        : ctx.db.inbox.insert({
            id: 0n,
            normalizedEmail: oidcClaims.normalizedEmail,
            displayEmail: oidcClaims.displayEmail,
            ownerIdentity: ctx.sender,
            authSubject: oidcClaims.subject,
            authIssuer: oidcClaims.issuer,
            authIdentityKey: buildInboxAuthIdentityKey(oidcClaims.issuer, oidcClaims.subject),
            authVerified: true,
            emailAttested: true,
            authVerifiedAt: ctx.timestamp,
            authExpiresAt: oidcClaims.expiresAt,
            createdAt: ctx.timestamp,
            updatedAt: ctx.timestamp,
          }));

    if (existingByEmail || existingByOwner) {
      ctx.db.inbox.id.update({
        ...inbox,
        displayEmail: oidcClaims.displayEmail,
        authSubject: oidcClaims.subject,
        authIssuer: oidcClaims.issuer,
        authIdentityKey: buildInboxAuthIdentityKey(oidcClaims.issuer, oidcClaims.subject),
        authVerified: true,
        emailAttested: true,
        authVerifiedAt: ctx.timestamp,
        authExpiresAt: oidcClaims.expiresAt,
        updatedAt: ctx.timestamp,
      });
    }

    upsertInboxAuthLease(ctx, getRequiredInboxById(ctx, inbox.id), oidcClaims);

    const defaultInboxActor = getDefaultInboxIdentity(ctx, inbox.id);
    const inboxActor = defaultInboxActor;
    if (!inboxActor) {
      const slug = requireAvailableSlug(
        ctx,
        normalizedDefaultSlug ?? buildDefaultSlug(ctx, oidcClaims.normalizedEmail)
      );
      const createdInboxActor = ctx.db.agent.insert({
        id: 0n,
        inboxId: inbox.id,
        normalizedEmail: oidcClaims.normalizedEmail,
        slug,
        inboxIdentifier: undefined,
        isDefault: true,
        publicIdentity: buildPublicIdentity(slug),
        displayName: normalizedDisplayName,
        publicLinkedEmailEnabled: true,
        publicDescription: undefined,
        allowAllMessageContentTypes: true,
        allowAllMessageHeaders: true,
        supportedMessageContentTypes: [],
        supportedMessageHeaderNames: [],
          currentEncryptionPublicKey: normalizedEncryptionKey,
          currentEncryptionKeyVersion: normalizedEncryptionVersion,
          currentEncryptionAlgorithm: normalizedEncryptionAlgorithm,
          currentSigningPublicKey: normalizedSigningKey,
          currentSigningKeyVersion: normalizedSigningVersion,
          currentSigningAlgorithm: normalizedSigningAlgorithm,
        masumiRegistrationNetwork: undefined,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: undefined,
        masumiRegistrationState: undefined,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });

      ctx.db.agentKeyBundle.insert({
        id: 0n,
        agentDbId: createdInboxActor.id,
        publicIdentity: createdInboxActor.publicIdentity,
        uniqueKey: buildAgentKeyBundleKey(
          createdInboxActor.id,
          normalizedEncryptionVersion,
          normalizedSigningVersion
        ),
          encryptionPublicKey: normalizedEncryptionKey,
          encryptionKeyVersion: normalizedEncryptionVersion,
          encryptionAlgorithm: normalizedEncryptionAlgorithm,
          signingPublicKey: normalizedSigningKey,
          signingKeyVersion: normalizedSigningVersion,
          signingAlgorithm: normalizedSigningAlgorithm,
          createdAt: ctx.timestamp,
      });

      upsertInboxDevice(
        ctx,
        inbox.id,
        {
          deviceId,
          label: deviceLabel,
          platform: devicePlatform,
            deviceEncryptionPublicKey,
            deviceEncryptionKeyVersion,
            deviceEncryptionAlgorithm,
          },
        { autoApprove: true }
      );
      return;
    }

    if (
        inboxActor.currentEncryptionPublicKey !== normalizedEncryptionKey ||
        inboxActor.currentEncryptionKeyVersion !== normalizedEncryptionVersion ||
        inboxActor.currentEncryptionAlgorithm !== normalizedEncryptionAlgorithm ||
        inboxActor.currentSigningPublicKey !== normalizedSigningKey ||
        inboxActor.currentSigningKeyVersion !== normalizedSigningVersion ||
        inboxActor.currentSigningAlgorithm !== normalizedSigningAlgorithm
    ) {
      throw new SenderError(
        'Inbox actor keys do not match the currently registered keys; rotate them explicitly instead'
      );
    }

    if (
      (normalizedDisplayName && normalizedDisplayName !== inboxActor.displayName) ||
      inboxActor.inboxIdentifier !== undefined ||
      !inboxActor.isDefault
    ) {
      ctx.db.agent.id.update({
        ...inboxActor,
        inboxIdentifier: undefined,
        isDefault: true,
        displayName: normalizedDisplayName ?? inboxActor.displayName,
        updatedAt: ctx.timestamp,
      });
    }

    upsertInboxDevice(
      ctx,
      inbox.id,
      {
        deviceId,
        label: deviceLabel,
        platform: devicePlatform,
          deviceEncryptionPublicKey,
          deviceEncryptionKeyVersion,
          deviceEncryptionAlgorithm,
        },
      { autoApprove: true }
    );
  }
);

export const createInboxIdentity = spacetimedb.reducer(
  {
    slug: t.string(),
      displayName: t.string().optional(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string().optional(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string().optional(),
    },
  (
    ctx,
    {
      slug,
        displayName,
        encryptionPublicKey,
        encryptionKeyVersion,
        encryptionAlgorithm,
        signingPublicKey,
        signingKeyVersion,
        signingAlgorithm,
      }
  ) => {
    const inbox = getOwnedInbox(ctx);
    refreshInboxAuthLeaseForInbox(ctx, inbox);
    const normalizedSlug = requireAvailableSlug(
      ctx,
      normalizeCustomInboxSlug(slug, inbox.normalizedEmail)
    );
    const normalizedDisplayName = normalizeOptionalDisplayName(displayName);
    const normalizedEncryptionKey = normalizePublicKey(
      encryptionPublicKey,
      'encryptionPublicKey'
    );
      const normalizedEncryptionVersion = requireNonEmpty(
        encryptionKeyVersion,
        'encryptionKeyVersion'
      );
      const normalizedEncryptionAlgorithm = normalizeOptionalAlgorithm(
        encryptionAlgorithm,
        DEFAULT_AGENT_ENCRYPTION_ALGORITHM,
        'encryptionAlgorithm'
      );
      const normalizedSigningKey = normalizePublicKey(signingPublicKey, 'signingPublicKey');
      const normalizedSigningVersion = requireNonEmpty(
        signingKeyVersion,
        'signingKeyVersion'
      );
      const normalizedSigningAlgorithm = normalizeOptionalAlgorithm(
        signingAlgorithm,
        DEFAULT_AGENT_SIGNING_ALGORITHM,
        'signingAlgorithm'
      );

    const createdAgent = ctx.db.agent.insert({
      id: 0n,
      inboxId: inbox.id,
      normalizedEmail: inbox.normalizedEmail,
      slug: normalizedSlug,
      inboxIdentifier: normalizedSlug,
      isDefault: false,
      publicIdentity: buildPublicIdentity(normalizedSlug),
      displayName: normalizedDisplayName,
      publicLinkedEmailEnabled: true,
      publicDescription: undefined,
      allowAllMessageContentTypes: true,
      allowAllMessageHeaders: true,
      supportedMessageContentTypes: [],
      supportedMessageHeaderNames: [],
        currentEncryptionPublicKey: normalizedEncryptionKey,
        currentEncryptionKeyVersion: normalizedEncryptionVersion,
        currentEncryptionAlgorithm: normalizedEncryptionAlgorithm,
        currentSigningPublicKey: normalizedSigningKey,
        currentSigningKeyVersion: normalizedSigningVersion,
        currentSigningAlgorithm: normalizedSigningAlgorithm,
      masumiRegistrationNetwork: undefined,
      masumiInboxAgentId: undefined,
      masumiAgentIdentifier: undefined,
      masumiRegistrationState: undefined,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });

    ctx.db.agentKeyBundle.insert({
      id: 0n,
      agentDbId: createdAgent.id,
      publicIdentity: createdAgent.publicIdentity,
      uniqueKey: buildAgentKeyBundleKey(
        createdAgent.id,
        normalizedEncryptionVersion,
        normalizedSigningVersion
      ),
        encryptionPublicKey: normalizedEncryptionKey,
        encryptionKeyVersion: normalizedEncryptionVersion,
        encryptionAlgorithm: normalizedEncryptionAlgorithm,
        signingPublicKey: normalizedSigningKey,
        signingKeyVersion: normalizedSigningVersion,
        signingAlgorithm: normalizedSigningAlgorithm,
        createdAt: ctx.timestamp,
    });
  }
);

export const rotateAgentKeys = spacetimedb.reducer(
  {
      agentDbId: t.u64(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string().optional(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string().optional(),
      deviceKeyBundles: t.array(DeviceKeyBundleAttachment).optional(),
      revokeDeviceIds: t.array(t.string()).optional(),
  },
  (
    ctx,
    {
        agentDbId,
        encryptionPublicKey,
        encryptionKeyVersion,
        encryptionAlgorithm,
        signingPublicKey,
        signingKeyVersion,
        signingAlgorithm,
        deviceKeyBundles,
        revokeDeviceIds,
    }
  ) => {
    requireMaxArrayLength(deviceKeyBundles ?? [], MAX_THREAD_FANOUT, 'deviceKeyBundles');
    requireMaxArrayLength(revokeDeviceIds ?? [], MAX_THREAD_FANOUT, 'revokeDeviceIds');

    const { actor, inbox } = getOwnedActorWithInbox(ctx, agentDbId);
    refreshInboxAuthLeaseForInbox(ctx, inbox);
    const normalizedEncryptionKey = normalizePublicKey(
      encryptionPublicKey,
      'encryptionPublicKey'
    );
      const normalizedEncryptionVersion = requireNonEmpty(
        encryptionKeyVersion,
        'encryptionKeyVersion'
      );
      const normalizedEncryptionAlgorithm = normalizeOptionalAlgorithm(
        encryptionAlgorithm,
        DEFAULT_AGENT_ENCRYPTION_ALGORITHM,
        'encryptionAlgorithm'
      );
      const normalizedSigningKey = normalizePublicKey(signingPublicKey, 'signingPublicKey');
      const normalizedSigningVersion = requireNonEmpty(
        signingKeyVersion,
        'signingKeyVersion'
      );
      const normalizedSigningAlgorithm = normalizeOptionalAlgorithm(
        signingAlgorithm,
        DEFAULT_AGENT_SIGNING_ALGORITHM,
        'signingAlgorithm'
      );

    if (
      normalizedEncryptionVersion === actor.currentEncryptionKeyVersion &&
      normalizedSigningVersion === actor.currentSigningKeyVersion
    ) {
      throw new SenderError('New key versions must differ from the current key versions');
    }

    const encryptionMaterialChanged =
      actor.currentEncryptionPublicKey !== normalizedEncryptionKey ||
      actor.currentEncryptionAlgorithm !== normalizedEncryptionAlgorithm;
    const signingMaterialChanged =
      actor.currentSigningPublicKey !== normalizedSigningKey ||
      actor.currentSigningAlgorithm !== normalizedSigningAlgorithm;
    const encryptionVersionChanged =
      normalizedEncryptionVersion !== actor.currentEncryptionKeyVersion;
    const signingVersionChanged =
      normalizedSigningVersion !== actor.currentSigningKeyVersion;

    if (encryptionMaterialChanged && !encryptionVersionChanged) {
      throw new SenderError(
        'encryptionKeyVersion must change when encryption key material or algorithm changes'
      );
    }
    if (signingMaterialChanged && !signingVersionChanged) {
      throw new SenderError(
        'signingKeyVersion must change when signing key material or algorithm changes'
      );
    }

    const existingKeyBundles = Array.from(
      ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id.filter(actor.id)
    ).filter(bundle => bundle.agentDbId === actor.id);

    const hasSameKeyBundle = existingKeyBundles.some(bundle => {
      return (
        bundle.encryptionKeyVersion === normalizedEncryptionVersion &&
        bundle.encryptionAlgorithm === normalizedEncryptionAlgorithm &&
        bundle.signingKeyVersion === normalizedSigningVersion &&
        bundle.signingAlgorithm === normalizedSigningAlgorithm &&
        bundle.encryptionPublicKey === normalizedEncryptionKey &&
        bundle.signingPublicKey === normalizedSigningKey
      );
    });

    if (hasSameKeyBundle) {
      throw new SenderError('This key bundle is already registered for the actor');
    }

    const conflictingEncryptionVersion = existingKeyBundles.find(bundle => {
      return (
        bundle.encryptionKeyVersion === normalizedEncryptionVersion &&
        (bundle.encryptionPublicKey !== normalizedEncryptionKey ||
          bundle.encryptionAlgorithm !== normalizedEncryptionAlgorithm)
      );
    });
    if (conflictingEncryptionVersion) {
      throw new SenderError(
        'encryptionKeyVersion is already registered with different encryption key material'
      );
    }

    const conflictingSigningVersion = existingKeyBundles.find(bundle => {
      return (
        bundle.signingKeyVersion === normalizedSigningVersion &&
        (bundle.signingPublicKey !== normalizedSigningKey ||
          bundle.signingAlgorithm !== normalizedSigningAlgorithm)
      );
    });
    if (conflictingSigningVersion) {
      throw new SenderError(
        'signingKeyVersion is already registered with different signing key material'
      );
    }

    const normalizedRevokeDeviceIds = Array.from(
      new Set((revokeDeviceIds ?? []).map(deviceId => normalizeDeviceId(deviceId)))
    );

    ctx.db.agent.id.update({
        ...actor,
        currentEncryptionPublicKey: normalizedEncryptionKey,
        currentEncryptionKeyVersion: normalizedEncryptionVersion,
        currentEncryptionAlgorithm: normalizedEncryptionAlgorithm,
        currentSigningPublicKey: normalizedSigningKey,
        currentSigningKeyVersion: normalizedSigningVersion,
        currentSigningAlgorithm: normalizedSigningAlgorithm,
        updatedAt: ctx.timestamp,
    });

    ctx.db.agentKeyBundle.insert({
      id: 0n,
      agentDbId: actor.id,
        publicIdentity: actor.publicIdentity,
        uniqueKey: buildAgentKeyBundleKey(
          actor.id,
          normalizedEncryptionVersion,
          normalizedSigningVersion
        ),
        encryptionPublicKey: normalizedEncryptionKey,
        encryptionKeyVersion: normalizedEncryptionVersion,
        encryptionAlgorithm: normalizedEncryptionAlgorithm,
        signingPublicKey: normalizedSigningKey,
        signingKeyVersion: normalizedSigningVersion,
        signingAlgorithm: normalizedSigningAlgorithm,
        createdAt: ctx.timestamp,
    });

    for (const deviceId of normalizedRevokeDeviceIds) {
      const device = getOwnedDevice(ctx, deviceId);
      invalidatePendingDeviceShareRequests(ctx, device.inboxId, device.deviceId);
      invalidatePendingDeviceKeyBundles(ctx, device.inboxId, device.deviceId);
      ctx.db.device.id.update({
        ...device,
        status: normalizeDeviceStatus('revoked'),
        revokedAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
        lastSeenAt: ctx.timestamp,
      });
    }

      for (const attachment of deviceKeyBundles ?? []) {
      const normalizedTargetDeviceId = normalizeDeviceId(attachment.deviceId);
      if (normalizedRevokeDeviceIds.includes(normalizedTargetDeviceId)) {
        throw new SenderError(`Cannot share rotated keys to revoked device ${normalizedTargetDeviceId}`);
      }

      insertDeviceKeyBundle(ctx, {
        deviceId: normalizedTargetDeviceId,
          sourceDeviceId: attachment.sourceDeviceId,
          sourceEncryptionPublicKey: attachment.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: attachment.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: attachment.sourceEncryptionAlgorithm,
          bundleCiphertext: attachment.bundleCiphertext,
        bundleIv: attachment.bundleIv,
        bundleAlgorithm: attachment.bundleAlgorithm,
        sharedAgentCount: attachment.sharedAgentCount,
        sharedKeyVersionCount: attachment.sharedKeyVersionCount,
        expiresAt: attachment.expiresAt,
        expiryMode: attachment.expiryMode,
      });
    }
  }
);

export const createDirectThread = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    otherAgentPublicIdentity: t.string(),
    membershipLocked: t.bool().optional(),
    title: t.string().optional(),
  },
  (ctx, { agentDbId, otherAgentPublicIdentity, membershipLocked, title }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const otherActor = getRequiredActorByPublicIdentity(ctx, otherAgentPublicIdentity);

    if (actor.id === otherActor.id) {
      throw new SenderError('Direct threads require a second actor');
    }
    if (!isDirectContactAllowed(ctx, actor, otherActor)) {
      throw new SenderError(
        'Direct contact requires approval for first contact. Send a first message to create a contact request.'
      );
    }

    createDirectThreadRecord(ctx, actor, otherActor, {
      membershipLocked,
      title,
    });
  }
);

export const createPendingDirectContactRequest = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    otherAgentPublicIdentity: t.string(),
    membershipLocked: t.bool().optional(),
    title: t.string().optional(),
  },
  (ctx, { agentDbId, otherAgentPublicIdentity, membershipLocked, title }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const otherActor = getRequiredActorByPublicIdentity(ctx, otherAgentPublicIdentity);

    if (actor.id === otherActor.id) {
      throw new SenderError('Direct threads require a second actor');
    }
    if (isDirectContactAllowed(ctx, actor, otherActor)) {
      throw new SenderError('Direct contact is already allowed for this actor pair');
    }
    if (findPendingContactRequestForActors(ctx, actor, otherActor)) {
      throw new SenderError('A pending contact request already exists for this actor pair');
    }

    const requesterInbox = getRequiredInboxById(ctx, actor.inboxId);
    const thread = createDirectThreadRecord(ctx, actor, otherActor, {
      membershipLocked,
      title,
    });

    ctx.db.contactRequest.insert({
      id: 0n,
      threadId: thread.id,
      requesterAgentDbId: actor.id,
      requesterPublicIdentity: actor.publicIdentity,
      requesterSlug: actor.slug,
      requesterDisplayName: actor.displayName,
      requesterNormalizedEmail: requesterInbox.normalizedEmail,
      requesterDisplayEmail: requesterInbox.displayEmail,
      targetAgentDbId: otherActor.id,
      targetPublicIdentity: otherActor.publicIdentity,
      targetSlug: otherActor.slug,
      targetDisplayName: otherActor.displayName,
      status: normalizeContactRequestStatus('pending'),
      hiddenMessageCount: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolvedByAgentDbId: undefined,
    });
  }
);

export const requestDirectContactWithFirstMessage = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    otherAgentPublicIdentity: t.string(),
    threadId: t.u64(),
    membershipLocked: t.bool().optional(),
    title: t.string().optional(),
    secretVersion: t.string(),
    signingKeyVersion: t.string(),
    senderSeq: t.u64(),
    ciphertext: t.string(),
    iv: t.string(),
    cipherAlgorithm: t.string(),
    signature: t.string(),
    replyToMessageId: t.u64().optional(),
    attachedSecretEnvelopes: t.array(SecretEnvelopeAttachment),
  },
  (
    ctx,
    {
      agentDbId,
      otherAgentPublicIdentity,
      threadId,
      membershipLocked,
      title,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
    }
  ) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const otherActor = getRequiredActorByPublicIdentity(ctx, otherAgentPublicIdentity);

    if (actor.id === otherActor.id) {
      throw new SenderError('Direct threads require a second actor');
    }
    if (isDirectContactAllowed(ctx, actor, otherActor)) {
      throw new SenderError('Direct contact is already allowed for this actor pair');
    }
    if (findPendingContactRequestForActors(ctx, actor, otherActor)) {
      throw new SenderError('A pending contact request already exists for this actor pair');
    }

    const requesterInbox = getRequiredInboxById(ctx, actor.inboxId);
    const thread = createDirectThreadRecord(ctx, actor, otherActor, {
      threadId,
      membershipLocked,
      title,
    });

    insertEncryptedMessageIntoThread(ctx, {
      senderActor: actor,
      threadId: thread.id,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
    });

    ctx.db.contactRequest.insert({
      id: 0n,
      threadId: thread.id,
      requesterAgentDbId: actor.id,
      requesterPublicIdentity: actor.publicIdentity,
      requesterSlug: actor.slug,
      requesterDisplayName: actor.displayName,
      requesterNormalizedEmail: requesterInbox.normalizedEmail,
      requesterDisplayEmail: requesterInbox.displayEmail,
      targetAgentDbId: otherActor.id,
      targetPublicIdentity: otherActor.publicIdentity,
      targetSlug: otherActor.slug,
      targetDisplayName: otherActor.displayName,
      status: normalizeContactRequestStatus('pending'),
      hiddenMessageCount: 1n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolvedByAgentDbId: undefined,
    });
  }
);

export const createGroupThread = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    participantPublicIdentities: t.array(t.string()),
    membershipLocked: t.bool().optional(),
    title: t.string().optional(),
  },
  (ctx, { agentDbId, participantPublicIdentities, membershipLocked, title }) => {
    requireMaxArrayLength(
      participantPublicIdentities,
      MAX_THREAD_FANOUT,
      'participantPublicIdentities'
    );

    const actor = getOwnedActor(ctx, agentDbId);

    const allParticipantPublicIdentities = Array.from(
      new Set([actor.publicIdentity, ...participantPublicIdentities.map(normalizePublicIdentity)])
    );
    if (allParticipantPublicIdentities.length < 2) {
      throw new SenderError('Group threads require at least one participant besides the creator');
    }
    if (allParticipantPublicIdentities.length > MAX_THREAD_FANOUT) {
      throw new SenderError(
        `Threads may include at most ${MAX_THREAD_FANOUT.toString()} active or pending participants`
      );
    }

    const participants = allParticipantPublicIdentities.map(participantPublicIdentity =>
      getRequiredActorByPublicIdentity(ctx, participantPublicIdentity)
    );

    const groupKey = buildGroupKey(actor, ctx.timestamp.microsSinceUnixEpoch);
    const thread = ctx.db.thread.insert({
        id: 0n,
        dedupeKey: groupKey,
        kind: 'group',
        membershipLocked: membershipLocked ?? false,
        title: normalizeOptionalThreadTitle(title),
        creatorAgentDbId: actor.id,
        membershipVersion: 1n,
        nextThreadSeq: 1n,
      lastMessageSeq: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      lastMessageAt: ctx.timestamp,
    });

    for (const participant of participants) {
      if (participant.id === actor.id) {
        ensureThreadParticipant(ctx, thread.id, participant, { isAdmin: true });
      } else if (isDirectContactAllowed(ctx, actor, participant)) {
        ensureThreadParticipant(ctx, thread.id, participant);
      } else {
        ensureThreadInvite(ctx, thread.id, actor, participant);
      }
    }
  }
);

export const addThreadParticipant = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    participantPublicIdentity: t.string(),
  },
  (ctx, { agentDbId, threadId, participantPublicIdentity }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');
    if (thread.membershipLocked) {
      throw new SenderError('Locked threads cannot add new participants');
    }
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);

    requireAdminThreadParticipant(ctx, threadId, actor.id);
    const participantActor = getRequiredActorByPublicIdentity(ctx, participantPublicIdentity);
    if (participantActor.id === actor.id) {
      return;
    }

    const existingParticipant = getThreadParticipants(ctx, threadId).find(participant => {
      return participant.agentDbId === participantActor.id;
    });
    const existingInvite = ctx.db.threadInvite.uniqueKey.find(
      buildThreadInviteKey(threadId, participantActor.id)
    );
    const directContactAllowed = isDirectContactAllowed(ctx, actor, participantActor);

    let membershipChanged = false;
    let inviteChanged = false;
    if (directContactAllowed) {
      if (!existingParticipant?.active && !existingInvite) {
        requireThreadFanoutCapacity(ctx, threadId);
      }
      membershipChanged = ensureThreadParticipant(ctx, threadId, participantActor);
      if (existingInvite?.status === 'pending') {
        resolveThreadInvite(ctx, existingInvite, 'accepted', actor.id);
      }
    } else {
      inviteChanged = ensureThreadInvite(ctx, threadId, actor, participantActor);
    }

    const activeParticipantCount = getActiveThreadParticipants(ctx, threadId).length;
    const kindTransition =
      thread.kind !== 'group' && (activeParticipantCount > 2 || inviteChanged);
    if (membershipChanged || kindTransition) {
      ctx.db.thread.id.update({
        ...thread,
        kind: kindTransition ? 'group' : thread.kind,
        membershipVersion: membershipChanged
          ? thread.membershipVersion + 1n
          : thread.membershipVersion,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const acceptThreadInvite = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    inviteId: t.u64(),
  },
  (ctx, { agentDbId, inviteId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const invite = getRequiredThreadInviteByRowId(ctx, inviteId);
    if (invite.inviteeAgentDbId !== actor.id) {
      throw new SenderError('Only the invited agent may accept this thread invite');
    }
    if (invite.status !== 'pending') {
      throw new SenderError('Only pending thread invites can be accepted');
    }

    const thread = ctx.db.thread.id.find(invite.threadId);
    if (!thread) throw new SenderError('Thread not found');

    const membershipChanged = ensureThreadParticipant(ctx, thread.id, actor);
    resolveThreadInvite(ctx, invite, 'accepted', actor.id);

    if (membershipChanged) {
      ctx.db.thread.id.update({
        ...thread,
        membershipVersion: thread.membershipVersion + 1n,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const rejectThreadInvite = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    inviteId: t.u64(),
  },
  (ctx, { agentDbId, inviteId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const invite = getRequiredThreadInviteByRowId(ctx, inviteId);
    if (invite.inviteeAgentDbId !== actor.id) {
      throw new SenderError('Only the invited agent may reject this thread invite');
    }
    if (invite.status !== 'pending') {
      throw new SenderError('Only pending thread invites can be rejected');
    }

    resolveThreadInvite(ctx, invite, 'rejected', actor.id);
  }
);

export const removeThreadParticipant = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    participantAgentDbId: t.u64(),
  },
  (ctx, { agentDbId, threadId, participantAgentDbId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);
    const participant = getThreadParticipants(ctx, threadId).find(row => {
      return row.agentDbId === participantAgentDbId;
    });
    if (!participant || !participant.active) {
      throw new SenderError('Participant is not active in this thread');
    }

    if (thread.membershipLocked && actor.id !== participantAgentDbId) {
      throw new SenderError('Locked threads only allow participants to leave themselves');
    }

    if (actor.id !== participantAgentDbId) {
      requireAdminThreadParticipant(ctx, threadId, actor.id);
    } else {
      requireActiveThreadParticipant(ctx, threadId, actor.id);
    }

    ctx.db.threadParticipant.id.update({
      ...participant,
      active: false,
      isAdmin: false,
    });

      promoteReplacementAdmin(ctx, threadId);
      ctx.db.thread.id.update({
        ...thread,
        membershipVersion: thread.membershipVersion + 1n,
        updatedAt: ctx.timestamp,
      });
    }
);

export const setThreadParticipantAdmin = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    participantAgentDbId: t.u64(),
    isAdmin: t.bool(),
  },
  (ctx, { agentDbId, threadId, participantAgentDbId, isAdmin }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);
    requireAdminThreadParticipant(ctx, threadId, actor.id);

    const participant = getActiveThreadParticipants(ctx, threadId).find(row => {
      return row.agentDbId === participantAgentDbId;
    });
    if (!participant) {
      throw new SenderError('Participant is not active in this thread');
    }

    ctx.db.threadParticipant.id.update({
      ...participant,
      isAdmin,
    });

    promoteReplacementAdmin(ctx, threadId);
  }
);

function insertEncryptedMessageIntoThread(
  ctx: ModuleCtx,
  params: {
    senderActor: ReturnType<typeof getRequiredActorByDbId>;
    threadId: bigint;
    secretVersion: string;
    signingKeyVersion: string;
    senderSeq: bigint;
    ciphertext: string;
    iv: string;
    cipherAlgorithm: string;
    signature: string;
    replyToMessageId?: bigint;
    attachedSecretEnvelopes: Array<{
      recipientPublicIdentity: string;
      recipientEncryptionKeyVersion: string;
      senderEncryptionKeyVersion: string;
      signingKeyVersion: string;
      wrappedSecretCiphertext: string;
      wrappedSecretIv: string;
      wrapAlgorithm: string;
      signature: string;
    }>;
  }
) {
  const thread = ctx.db.thread.id.find(params.threadId);
  if (!thread) throw new SenderError('Thread not found');
  requireMaxArrayLength(
    params.attachedSecretEnvelopes,
    MAX_THREAD_FANOUT,
    'attachedSecretEnvelopes'
  );

  const normalizedSecretVersion = requireNonEmpty(params.secretVersion, 'secretVersion');
  const normalizedSigningVersion = requireNonEmpty(
    params.signingKeyVersion,
    'signingKeyVersion'
  );
  const normalizedCiphertext = requireHexMaxLength(
    params.ciphertext,
    MAX_MESSAGE_CIPHERTEXT_HEX_CHARS,
    'ciphertext'
  );
  const normalizedIv = requireHexMaxLength(params.iv, MAX_MESSAGE_IV_HEX_CHARS, 'iv');
  const normalizedAlgorithm = requireNonEmpty(params.cipherAlgorithm, 'cipherAlgorithm');
  const normalizedSignature = requireHexMaxLength(
    params.signature,
    MAX_MESSAGE_SIGNATURE_HEX_CHARS,
    'signature'
  );
  requireMaxLength(normalizedSecretVersion, MAX_MESSAGE_VERSION_CHARS, 'secretVersion');
  requireMaxLength(normalizedSigningVersion, MAX_MESSAGE_VERSION_CHARS, 'signingKeyVersion');
  requireMaxLength(normalizedAlgorithm, MAX_MESSAGE_ALGORITHM_CHARS, 'cipherAlgorithm');

  const activeParticipants = getActiveThreadParticipants(ctx, params.threadId);
  const senderParticipant = requireActiveThreadParticipant(ctx, params.threadId, params.senderActor.id);
  const contactRequest = getContactRequestByThreadId(ctx, params.threadId);
  const contactRequestAllowed = contactRequest
    ? isDirectContactAllowed(
        ctx,
        getRequiredActorByDbId(ctx, contactRequest.requesterAgentDbId),
        getRequiredActorByDbId(ctx, contactRequest.targetAgentDbId)
      )
    : false;

  if (contactRequest?.status.tag === 'pending' && !contactRequestAllowed) {
    if (contactRequest.requesterAgentDbId !== params.senderActor.id) {
      throw new SenderError('Only the requester may send before direct-contact approval');
    }

    if (contactRequest.hiddenMessageCount > 0n) {
      throw new SenderError(
        'Pending direct-contact threads allow only one hidden pre-approval message'
      );
    }
  } else if (contactRequest && contactRequest.status.tag !== 'approved' && !contactRequestAllowed) {
    throw new SenderError('Direct contact has not been approved for this thread');
  }

  if (normalizedSigningVersion !== params.senderActor.currentSigningKeyVersion) {
    throw new SenderError('signingKeyVersion must match the sender current signing key version');
  }

  const expectedSenderSeq = senderParticipant.lastSentSeq + 1n;
  if (params.senderSeq !== expectedSenderSeq) {
    throw new SenderError(`senderSeq must be ${expectedSenderSeq.toString()} for this sender`);
  }

  if (params.replyToMessageId !== undefined) {
    const replied = ctx.db.message.id.find(params.replyToMessageId);
    if (!replied || replied.threadId !== params.threadId) {
      throw new SenderError('replyToMessageId is invalid for this thread');
    }
    if (!canAgentReadMessage(ctx, params.senderActor.id, replied)) {
      throw new SenderError('replyToMessageId is not visible to the sender');
    }
  }

  const secretVersionStart = params.attachedSecretEnvelopes.length > 0;
  const latestSenderState = getSenderLastSentState(senderParticipant);

  if (!latestSenderState && !secretVersionStart) {
    throw new SenderError('The first message for a sender in this thread must publish a secretVersion');
  }
  if (
    latestSenderState &&
    latestSenderState.membershipVersion !== thread.membershipVersion &&
    !secretVersionStart
  ) {
    throw new SenderError(
      'Thread membership changed; the next message must start a new sender secretVersion'
    );
  }
  if (
    latestSenderState &&
    !secretVersionStart &&
    latestSenderState.secretVersion !== normalizedSecretVersion
  ) {
    throw new SenderError('Non-rotation messages must reuse the current sender secretVersion');
  }
  if (
    latestSenderState &&
    secretVersionStart &&
    latestSenderState.secretVersion === normalizedSecretVersion
  ) {
    throw new SenderError('Rotation messages must start a new secretVersion');
  }
  if (
    secretVersionStart &&
    senderHasMessageWithSecretVersion(
      ctx,
      params.threadId,
      params.senderActor.id,
      normalizedSecretVersion
    )
  ) {
    throw new SenderError('Rotation messages must use a never-before-used secretVersion');
  }

  if (secretVersionStart) {
    validateAttachedSecretEnvelopes({
      ctx,
      threadId: params.threadId,
      membershipVersion: thread.membershipVersion,
      senderAgent: params.senderActor,
      secretVersion: normalizedSecretVersion,
      activeParticipants,
      attachedSecretEnvelopes: params.attachedSecretEnvelopes,
    });
    insertAttachedSecretEnvelopes({
      ctx,
      threadId: params.threadId,
      membershipVersion: thread.membershipVersion,
      senderAgent: params.senderActor,
      secretVersion: normalizedSecretVersion,
      attachedSecretEnvelopes: params.attachedSecretEnvelopes,
    });
  } else {
    requireExactEnvelopeCoverageForVersion({
      ctx,
      threadId: params.threadId,
      membershipVersion: thread.membershipVersion,
      senderAgent: params.senderActor,
      secretVersion: normalizedSecretVersion,
      activeParticipants,
    });
  }

  const threadSeq = thread.nextThreadSeq;
  if (threadSeq <= thread.lastMessageSeq && thread.lastMessageSeq !== 0n) {
    throw new SenderError('Thread sequence state is inconsistent');
  }
  ctx.db.message.insert({
    id: 0n,
    threadId: params.threadId,
    threadSeq,
    threadSeqKey: buildMessageThreadSeqKey(params.threadId, threadSeq),
    membershipVersion: thread.membershipVersion,
    senderAgentDbId: params.senderActor.id,
    senderSeq: params.senderSeq,
    secretVersion: normalizedSecretVersion,
    secretVersionStart,
    signingKeyVersion: normalizedSigningVersion,
    ciphertext: normalizedCiphertext,
    iv: normalizedIv,
    cipherAlgorithm: normalizedAlgorithm,
    signature: normalizedSignature,
    replyToMessageId: params.replyToMessageId,
    createdAt: ctx.timestamp,
  });

  ctx.db.thread.id.update({
    ...thread,
    nextThreadSeq: threadSeq + 1n,
    lastMessageSeq: threadSeq,
    updatedAt: ctx.timestamp,
    lastMessageAt: ctx.timestamp,
  });

  ctx.db.threadParticipant.id.update({
    ...senderParticipant,
    lastSentSeq: params.senderSeq,
    lastSentMembershipVersion: thread.membershipVersion,
    lastSentSecretVersion: normalizedSecretVersion,
  });

  if (contactRequest?.status.tag === 'pending' && !contactRequestAllowed) {
    ctx.db.contactRequest.id.update({
      ...contactRequest,
      hiddenMessageCount: contactRequest.hiddenMessageCount + 1n,
      updatedAt: ctx.timestamp,
    });
  }
}

export const sendEncryptedMessage = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    secretVersion: t.string(),
    signingKeyVersion: t.string(),
    senderSeq: t.u64(),
    ciphertext: t.string(),
    iv: t.string(),
    cipherAlgorithm: t.string(),
    signature: t.string(),
    replyToMessageId: t.u64().optional(),
    attachedSecretEnvelopes: t.array(SecretEnvelopeAttachment),
  },
  (
    ctx,
    {
      agentDbId,
      threadId,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
    }
  ) => {
    const senderActor = getOwnedActor(ctx, agentDbId);
    insertEncryptedMessageIntoThread(ctx, {
      senderActor,
      threadId,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
    });
  }
);

export const backfillThreadSecretEnvelopes = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    membershipVersion: t.u64(),
    secretVersion: t.string(),
    attachedSecretEnvelopes: t.array(SecretEnvelopeAttachment),
  },
  (
    ctx,
    {
      agentDbId,
      threadId,
      membershipVersion,
      secretVersion,
      attachedSecretEnvelopes,
    }
  ) => {
    const senderActor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');
    if (membershipVersion === 0n || membershipVersion >= thread.membershipVersion) {
      throw new SenderError('Backfill membershipVersion must reference a prior thread membership');
    }

    requireActiveThreadParticipant(ctx, threadId, senderActor.id);
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);

    const normalizedSecretVersion = requireNonEmpty(secretVersion, 'secretVersion');
    requireMaxLength(normalizedSecretVersion, MAX_MESSAGE_VERSION_CHARS, 'secretVersion');
    if (
      !senderHasMessageForMembershipSecretVersion(
        ctx,
        threadId,
        membershipVersion,
        senderActor.id,
        normalizedSecretVersion
      )
    ) {
      throw new SenderError('No historical message exists for this sender secretVersion');
    }

    validateBackfillSecretEnvelopes({
      ctx,
      threadId,
      membershipVersion,
      senderAgent: senderActor,
      secretVersion: normalizedSecretVersion,
      activeParticipants: getActiveThreadParticipants(ctx, threadId),
      attachedSecretEnvelopes,
    });

    insertAttachedSecretEnvelopes({
      ctx,
      threadId,
      membershipVersion,
      senderAgent: senderActor,
      secretVersion: normalizedSecretVersion,
      attachedSecretEnvelopes,
    });
  }
);

export const markThreadRead = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    upToThreadSeq: t.u64().optional(),
  },
  (ctx, { agentDbId, threadId, upToThreadSeq }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');

    requireVisibleThreadParticipant(ctx, threadId, actor.id);

    const nextLastReadThreadSeq = upToThreadSeq ?? thread.lastMessageSeq;
    if (nextLastReadThreadSeq > thread.lastMessageSeq) {
      throw new SenderError('upToThreadSeq exceeds the current thread sequence');
    }

    let readState = getThreadReadStateForActor(ctx, threadId, actor.id);
    if (!readState) {
      readState = ctx.db.threadReadState.insert({
        id: 0n,
        threadId,
        agentDbId: actor.id,
        uniqueKey: buildThreadReadStateKey(threadId, actor.id),
        lastReadThreadSeq: undefined,
        archived: false,
        updatedAt: ctx.timestamp,
      });
    }

    if (
      readState.lastReadThreadSeq !== undefined &&
      nextLastReadThreadSeq <= readState.lastReadThreadSeq
    ) {
      return;
    }

    ctx.db.threadReadState.id.update({
      ...readState,
      lastReadThreadSeq: nextLastReadThreadSeq,
      updatedAt: ctx.timestamp,
    });
  }
);

export const setThreadArchived = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    archived: t.bool(),
  },
  (ctx, { agentDbId, threadId, archived }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    if (!ctx.db.thread.id.find(threadId)) throw new SenderError('Thread not found');
    requireVisibleThreadParticipant(ctx, threadId, actor.id);

    const existingReadState = getThreadReadStateForActor(ctx, threadId, actor.id);

    if (!existingReadState) {
      ctx.db.threadReadState.insert({
        id: 0n,
        threadId,
        agentDbId: actor.id,
        uniqueKey: buildThreadReadStateKey(threadId, actor.id),
        lastReadThreadSeq: undefined,
        archived,
        updatedAt: ctx.timestamp,
      });
      return;
    }

    ctx.db.threadReadState.id.update({
      ...existingReadState,
      archived,
      updatedAt: ctx.timestamp,
    });
  }
);

export const deleteThread = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
  },
  (ctx, { agentDbId, threadId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');

    requireAdminThreadParticipant(ctx, threadId, actor.id);

    const request = getContactRequestByThreadId(ctx, threadId);
    if (request && request.status.tag === 'pending') {
      throw new SenderError('Cannot delete a thread with a pending contact request — reject it first');
    }

    deleteThreadAndDependents(ctx, threadId);
  }
);
