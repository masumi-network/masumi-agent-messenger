import { schema } from 'spacetimedb/server';
import { inboxTable } from './tables/inbox';
import { inboxAuthLeaseTable } from './tables/inbox-auth-lease';
import { inboxAuthLeaseExpiryTable } from './tables/inbox-auth-lease-expiry';
import { agentTable } from './tables/agent';
import { agentKeyBundleTable } from './tables/agent-key-bundle';
import { deviceTable } from './tables/device';
import { deviceShareRequestTable } from './tables/device-share-request';
import { deviceKeyBundleTable } from './tables/device-key-bundle';
import { deviceKeyBundleExpiryTable } from './tables/device-key-bundle-expiry';
import { threadTable } from './tables/thread';
import { directThreadIndexTable } from './tables/direct-thread-index';
import { threadParticipantTable } from './tables/thread-participant';
import { threadSecretEnvelopeTable } from './tables/thread-secret-envelope';
import { messageTable } from './tables/message';
import { threadReadStateTable } from './tables/thread-read-state';
import { channelTable } from './tables/channel';
import { channelMemberTable } from './tables/channel-member';
import { channelJoinRequestTable } from './tables/channel-join-request';
import { channelMessageTable } from './tables/channel-message';
import { publicChannelTable } from './tables/public-channel';
import { publicRecentChannelMessageTable } from './tables/public-recent-channel-message';
import { threadInviteTable } from './tables/thread-invite';
import { contactRequestTable } from './tables/contact-request';
import { rateLimitTable } from './tables/rate-limit';
import { rateLimitCleanupTable } from './tables/rate-limit-cleanup';
import { rateLimitReportTable } from './tables/rate-limit-report';
import { rateLimitReportCleanupTable } from './tables/rate-limit-report-cleanup';
import { contactAllowlistEntryTable } from './tables/contact-allowlist-entry';

const spacetimedb = schema({
  inbox: inboxTable,
  inboxAuthLease: inboxAuthLeaseTable,
  inboxAuthLeaseExpiry: inboxAuthLeaseExpiryTable,
  agent: agentTable,
  agentKeyBundle: agentKeyBundleTable,
  device: deviceTable,
  deviceShareRequest: deviceShareRequestTable,
  deviceKeyBundle: deviceKeyBundleTable,
  deviceKeyBundleExpiry: deviceKeyBundleExpiryTable,
  thread: threadTable,
  directThreadIndex: directThreadIndexTable,
  threadParticipant: threadParticipantTable,
  threadSecretEnvelope: threadSecretEnvelopeTable,
  message: messageTable,
  threadReadState: threadReadStateTable,
  channel: channelTable,
  channelMember: channelMemberTable,
  channelJoinRequest: channelJoinRequestTable,
  channelMessage: channelMessageTable,
  publicChannel: publicChannelTable,
  publicRecentChannelMessage: publicRecentChannelMessageTable,
  threadInvite: threadInviteTable,
  contactRequest: contactRequestTable,
  rateLimit: rateLimitTable,
  rateLimitCleanup: rateLimitCleanupTable,
  rateLimitReport: rateLimitReportTable,
  rateLimitReportCleanup: rateLimitReportCleanupTable,
  contactAllowlistEntry: contactAllowlistEntryTable,
});

export default spacetimedb;
