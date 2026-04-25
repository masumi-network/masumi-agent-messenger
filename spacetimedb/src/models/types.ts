import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import type { Timestamp } from 'spacetimedb';
import type spacetimedb from '../schema';

export type OidcIdentityClaims = {
  normalizedEmail: string;
  displayEmail: string;
  subject: string;
  issuer: string;
  sessionId?: string;
  jwtId?: string;
  displayName?: string;
  expiresAt?: Timestamp;
};

export type ModuleCtx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type InboxRow = NonNullable<ReturnType<ModuleCtx['db']['inbox']['id']['find']>>;
export type ActorRow = NonNullable<ReturnType<ModuleCtx['db']['agent']['id']['find']>>;
export type DeviceRow = NonNullable<ReturnType<ModuleCtx['db']['device']['id']['find']>>;
export type DeviceShareRequestRow = NonNullable<
  ReturnType<ModuleCtx['db']['deviceShareRequest']['id']['find']>
>;
export type DeviceKeyBundleRow = NonNullable<
  ReturnType<ModuleCtx['db']['deviceKeyBundle']['id']['find']>
>;
export type AgentKeyBundleRow = NonNullable<
  ReturnType<ModuleCtx['db']['agentKeyBundle']['id']['find']>
>;
export type InboxAuthLeaseRow = NonNullable<ReturnType<ModuleCtx['db']['inboxAuthLease']['id']['find']>>;
export type RateLimitRow = NonNullable<ReturnType<ModuleCtx['db']['rateLimit']['id']['find']>>;
export type RateLimitReportRow = NonNullable<ReturnType<ModuleCtx['db']['rateLimitReport']['id']['find']>>;
export type ThreadRow = NonNullable<ReturnType<ModuleCtx['db']['thread']['id']['find']>>;
export type InboxThreadRow = NonNullable<
  ReturnType<ModuleCtx['db']['inboxThread']['id']['find']>
>;
export type InboxThreadBackfillRow = NonNullable<
  ReturnType<ModuleCtx['db']['inboxThreadBackfill']['id']['find']>
>;
export type DirectThreadIndexRow = NonNullable<
  ReturnType<ModuleCtx['db']['directThreadIndex']['id']['find']>
>;
export type ThreadParticipantRow = NonNullable<
  ReturnType<ModuleCtx['db']['threadParticipant']['id']['find']>
>;
export type ThreadSecretEnvelopeRow = NonNullable<
  ReturnType<ModuleCtx['db']['threadSecretEnvelope']['id']['find']>
>;
export type MessageRow = NonNullable<ReturnType<ModuleCtx['db']['message']['id']['find']>>;
export type ThreadReadStateRow = NonNullable<ReturnType<ModuleCtx['db']['threadReadState']['id']['find']>>;
export type ChannelRow = NonNullable<ReturnType<ModuleCtx['db']['channel']['id']['find']>>;
export type ChannelMemberRow = NonNullable<ReturnType<ModuleCtx['db']['channelMember']['id']['find']>>;
export type ChannelMemberListResultRow = {
  id: bigint;
  channelId: bigint;
  agentDbId: bigint;
  agentPublicIdentity: string;
  agentSlug: string;
  agentDisplayName: string | undefined;
  agentCurrentEncryptionPublicKey: string;
  agentCurrentEncryptionKeyVersion: string;
  permission: string;
  active: boolean;
  lastSentSeq: bigint;
  joinedAt: Timestamp;
  updatedAt: Timestamp;
};
export type ChannelJoinRequestRow = NonNullable<
  ReturnType<ModuleCtx['db']['channelJoinRequest']['id']['find']>
>;
export type ChannelMessageRecordRow = NonNullable<
  ReturnType<ModuleCtx['db']['channelMessage']['id']['find']>
>;
export type PublicChannelTableRow = NonNullable<ReturnType<ModuleCtx['db']['publicChannel']['id']['find']>>;
export type PublicRecentChannelMessageRecordRow = NonNullable<
  ReturnType<ModuleCtx['db']['publicRecentChannelMessage']['id']['find']>
>;
export type ThreadInviteRow = NonNullable<ReturnType<ModuleCtx['db']['threadInvite']['id']['find']>>;
export type ContactRequestRow = NonNullable<
  ReturnType<ModuleCtx['db']['contactRequest']['id']['find']>
>;
export type ContactAllowlistEntryRow = NonNullable<
  ReturnType<ModuleCtx['db']['contactAllowlistEntry']['id']['find']>
>;
export type StripMutators<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? {
        [K in keyof T as K extends 'insert' | 'update' | 'delete' ? never : K]: StripMutators<
          T[K]
        >;
      }
    : T;
export type ReadDbCtx = {
  sender: ModuleCtx['sender'];
  db: {
    [K in keyof ModuleCtx['db']]: StripMutators<ModuleCtx['db'][K]>;
  };
};
export type ReadAuthCtx = ReadDbCtx & Pick<ModuleCtx, 'senderAuth' | 'timestamp'>;
export type MaybeReadAuthCtx = ReadDbCtx & Partial<Pick<ModuleCtx, 'senderAuth'>>;
export type DeviceReadDbCtx = ReadDbCtx;
export type DeviceReadAuthCtx = ReadAuthCtx;
