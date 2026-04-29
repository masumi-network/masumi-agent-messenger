import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEBAPP_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const BACKEND_SRC_ROOT = resolve(WEBAPP_ROOT, '../spacetimedb/src');

function readRelativeFile(relativePath: string): string {
  return readFileSync(resolve(WEBAPP_ROOT, relativePath), 'utf8');
}

function readBackendFile(relativePath: string): string {
  return readFileSync(resolve(BACKEND_SRC_ROOT, relativePath), 'utf8');
}

function readBackendSourceDirectory(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return readBackendSourceDirectory(fullPath);
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) {
        return '';
      }
      return `\n// ${fullPath.slice(BACKEND_SRC_ROOT.length + 1)}\n${readFileSync(fullPath, 'utf8')}`;
    })
    .join('\n');
}

function readBackendSource(): string {
  return readBackendSourceDirectory(BACKEND_SRC_ROOT);
}

function sourceBetween(source: string, startNeedle: string, endNeedle?: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) {
    throw new Error(`Source marker was not found: ${startNeedle}`);
  }
  if (!endNeedle) {
    return source.slice(start);
  }
  const end = source.indexOf(endNeedle, start);
  if (end < 0) {
    throw new Error(`Source marker was not found: ${endNeedle}`);
  }
  return source.slice(start, end);
}

function extractGeneratedObject(source: string, name: string): string {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) {
    throw new Error(`Generated object ${name} was not found`);
  }
  const end = source.indexOf(`export type ${name}`, start);
  if (end < 0) {
    throw new Error(`Generated type ${name} was not found`);
  }
  return source.slice(start, end);
}

describe('generated and source security contracts', () => {
  it('removes public actor-id discovery from generated reducer contracts', () => {
    const createDirectThreadReducer = readRelativeFile(
      'src/module_bindings/create_direct_thread_reducer.ts'
    );
    const createGroupThreadReducer = readRelativeFile(
      'src/module_bindings/create_group_thread_reducer.ts'
    );
    const addThreadParticipantReducer = readRelativeFile(
      'src/module_bindings/add_thread_participant_reducer.ts'
    );

    expect(createDirectThreadReducer).toContain('otherAgentPublicIdentity');
    expect(createDirectThreadReducer).not.toContain('otherActorId');
    expect(createDirectThreadReducer).not.toContain('otherActorPublicIdentity');

    expect(createGroupThreadReducer).toContain('participantPublicIdentities');
    expect(createGroupThreadReducer).not.toContain('participantActorIds');

    expect(addThreadParticipantReducer).toContain('participantPublicIdentity');
    expect(addThreadParticipantReducer).not.toContain('participantActorId');
  });

  it('removes internal actor ids from public lookup bindings', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');

    expect(generatedTypes).toContain('PublishedAgentLookupRow');
    expect(generatedTypes).not.toContain('PublishedAgentLookupRow = __t.object("PublishedAgentLookupRow", {\n  id:');
    expect(generatedIndex).not.toContain('LookupPublishedContactTargetBySlugProcedure');
    expect(generatedIndex).not.toContain('lookupPublishedContactTargetBySlug');
    expect(
      existsSync(
        resolve(WEBAPP_ROOT, 'src/module_bindings/lookup_published_contact_target_by_slug_procedure.ts')
      )
    ).toBe(false);
  });

  it('does not expose split owned/peer agent views', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');
    const backend = readBackendSource();

    expect(backend).not.toContain('visibleOwnedAgents');
    expect(backend).not.toContain('visiblePeerAgents');
    expect(generatedIndex).not.toContain('visibleOwnedAgents');
    expect(generatedIndex).not.toContain('visiblePeerAgents');
    expect(generatedTypes).not.toContain('VisiblePeerAgentRow');
    expect(
      existsSync(resolve(WEBAPP_ROOT, 'src/module_bindings/visible_owned_agents_table.ts'))
    ).toBe(false);
    expect(
      existsSync(resolve(WEBAPP_ROOT, 'src/module_bindings/visible_peer_agents_table.ts'))
    ).toBe(false);
  });

  it('uses recipient public identities in generated secret-envelope attachments', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');

    expect(generatedTypes).toContain('export const SecretEnvelopeAttachment');
    expect(generatedTypes).toContain('recipientPublicIdentity: __t.string()');
    expect(generatedTypes).not.toContain(
      'export const SecretEnvelopeAttachment = __t.object("SecretEnvelopeAttachment", {\n  recipientActorId: __t.u64()'
    );
  });

  it('keeps direct contact retries and duplicate direct threads on distinct thread ids', () => {
    const requestDirectContactReducer = readRelativeFile(
      'src/module_bindings/request_direct_contact_with_first_message_reducer.ts'
    );
    const slugRoute = readRelativeFile('src/routes/$slug.tsx');
    const cliSendMessage = readFileSync(
      resolve(WEBAPP_ROOT, '../cli/src/services/send-message.ts'),
      'utf8'
    );
    const inboxState = readFileSync(resolve(WEBAPP_ROOT, '../shared/inbox-state.ts'), 'utf8');
    const backend = readBackendSource();
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const contactRequestRow = extractGeneratedObject(generatedTypes, 'ContactRequest');

    expect(requestDirectContactReducer).toContain('threadId: __t.u64()');
    expect(inboxState).toContain('generateClientThreadId');
    expect(slugRoute).toContain('const pendingThreadId = generateClientThreadId();');
    expect(cliSendMessage).toContain('const pendingThreadId = generateClientThreadId();');
    expect(backend).toContain('const directThreadId = options?.threadId ?? 0n;');
    expect(backend).toContain('direct_thread_index_direct_key');
    expect(backend).not.toContain('A direct thread already exists for this actor pair');
    expect(backend).not.toContain('directKey: t.string().unique()');
    expect(backend).toContain('hiddenMessageCount: contactRequest.hiddenMessageCount + 1n');
    expect(backend).not.toContain(
      'Array.from(ctx.db.message.message_thread_id.filter(params.threadId)).length'
    );
    expect(contactRequestRow).toContain('hiddenMessageCount: __t.u64()');
  });

  it('forces sender-secret rotation after thread membership changes', () => {
    const cliSendMessage = readFileSync(
      resolve(WEBAPP_ROOT, '../cli/src/services/send-message.ts'),
      'utf8'
    );
    const slugRoute = readRelativeFile('src/routes/$slug.tsx');

    const rotationHelper = cliSendMessage.slice(
      cliSendMessage.indexOf('function senderSecretRotationRequired'),
      cliSendMessage.indexOf('function requireVisibleThread')
    );

    expect(rotationHelper).toContain(
      'latestSenderState.membershipVersion !== thread.membershipVersion'
    );
    expect(rotationHelper).toContain(
      'envelope.membershipVersion === latestSenderState.membershipVersion'
    );
    expect(cliSendMessage.match(/rotateSecret: requiresSecretRotation/g)).toHaveLength(2);
    expect(slugRoute).toContain('currentMembershipVersion: selectedThread?.membershipVersion');
    expect(slugRoute).toContain(
      'latestSenderState.membershipVersion !== currentMembershipVersion'
    );
    expect(slugRoute).toContain(
      'envelope.membershipVersion === latestSenderState.membershipVersion'
    );
  });

  it('protects backend key and sender-secret rotation invariants', () => {
    const backend = readBackendSource();
    const rotateAgentKeysReducer = sourceBetween(
      readBackendFile('operations/identity/agent-key-bundle.ts'),
      'export const rotateAgentKeys'
    );

    expect(backend).toContain(
      'encryptionKeyVersion must change when encryption key material or algorithm changes'
    );
    expect(backend).toContain(
      'signingKeyVersion must change when signing key material or algorithm changes'
    );
    expect(backend).toContain('conflictingEncryptionVersion');
    expect(backend).toContain('conflictingSigningVersion');
    expect(backend).toContain(
      'Thread membership changed; the next message must start a new sender secretVersion'
    );
    expect(backend).toContain(
      'The first message for a sender in this thread must publish a secretVersion'
    );
    expect(backend).toContain(
      'Rotation messages must start a new secretVersion'
    );
    expect(backend).toContain(
      'Rotation messages must use a never-before-used secretVersion'
    );
    expect(backend).not.toContain('publishThreadSecretEnvelopes');
    expect(backend).toContain('senderHasMessageWithSecretVersion');
    expect(backend).toContain('lastReadThreadSeq: nextLastReadThreadSeq');
    expect(backend).toContain('function getOwnedActorWithInbox');
    expect(rotateAgentKeysReducer).toContain(
      'const { actor, inbox } = getOwnedActorWithInbox(ctx, agentDbId);'
    );
    expect(rotateAgentKeysReducer).toContain('refreshInboxAuthLeaseForInbox(ctx, inbox);');
  });

  it('lets historical participants manage read and archive state without send access', () => {
    const backend = readBackendSource();
    const threadReadStateSource = readBackendFile('operations/threads/thread-read-state.ts');
    const markReadReducer = sourceBetween(
      threadReadStateSource,
      'export const markThreadRead',
      'export const setThreadArchived'
    );
    const archiveReducer = sourceBetween(
      threadReadStateSource,
      'export const setThreadArchived'
    );

    expect(backend).toContain('function requireVisibleThreadParticipant');
    expect(markReadReducer).toContain('requireVisibleThreadParticipant(ctx, threadId, actor.id);');
    expect(markReadReducer).not.toContain('requireActiveThreadParticipant(ctx, threadId, actor.id);');
    expect(archiveReducer).toContain('requireVisibleThreadParticipant(ctx, threadId, actor.id);');
    expect(archiveReducer).not.toContain('requireActiveThreadParticipant(ctx, threadId, actor.id);');
  });

  it('removes the extra public actor resolve route from the generated route tree', () => {
    const routeTree = readRelativeFile('src/routeTree.gen.ts');

    expect(routeTree).not.toContain('/api/actors/resolve');
    expect(existsSync(resolve(WEBAPP_ROOT, 'src/routes/api.actors.resolve.ts'))).toBe(false);
  });

  it('keeps logout on POST and removes the debug token panels from the inbox route', () => {
    const logoutRoute = readRelativeFile('src/routes/auth.logout.ts');
    const slugRoute = readRelativeFile('src/routes/$slug.tsx');
    const cliSendMessage = readFileSync(
      resolve(WEBAPP_ROOT, '../cli/src/services/send-message.ts'),
      'utf8'
    );
    const agentSession = readRelativeFile('src/lib/agent-session.ts');
    const authSession = readRelativeFile('src/lib/auth-session.tsx');
    const oidcAuth = readRelativeFile('src/lib/oidc-auth.server.ts');

    expect(logoutRoute).toContain('POST: async');
    expect(logoutRoute).toContain("status: 405");
    expect(slugRoute).not.toContain('OIDC Debug');
    expect(slugRoute).not.toContain('Message Debug');
    expect(slugRoute).not.toContain('ID Token Preview');
    expect(authSession).not.toContain('accessToken: string | null');
    expect(oidcAuth).not.toContain(
      "    idToken: session.idToken,\n    accessToken: session.accessToken ?? null,"
    );
    expect(slugRoute).toContain('requestDirectContactWithFirstMessageReducer');
    expect(slugRoute).not.toContain('createPendingDirectContactRequestReducer({');
    expect(cliSendMessage).toContain('requestDirectContactWithFirstMessage({');
    expect(cliSendMessage).not.toContain('createPendingDirectContactRequest({');
    expect(agentSession).not.toContain('actor-key-archive');
    expect(agentSession).not.toContain('getLegacyStoredAgentKeyPair');
    expect(agentSession).not.toContain('migrateLegacyMaterial');
  });

  it('always wraps the app in a Spacetime provider and keeps browser registration metadata scalar-only', () => {
    const routerSource = readRelativeFile('src/router.tsx');
    const registrationClient = readRelativeFile('src/lib/inbox-agent-registration.ts');
    const registrationServer = readRelativeFile('src/lib/inbox-agent-registration.server.ts');
    const registerRoute = readRelativeFile('src/routes/api.masumi.inbox-agent.register.ts');
    const syncRoute = readRelativeFile('src/routes/api.masumi.inbox-agent.sync.ts');
    const deregisterRoute = readRelativeFile('src/routes/api.masumi.inbox-agent.deregister.ts');
    const workspaceShell = readRelativeFile('src/features/workspace/use-workspace-shell.ts');
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const masumiReducer = readRelativeFile(
      'src/module_bindings/upsert_masumi_inbox_agent_registration_reducer.ts'
    );

    expect(routerSource).toContain('key={isServerRender ? \'ssr-shell\' : \'anonymous-shell\'}');
    expect(routerSource).not.toContain('return children;');
    expect(registrationClient).not.toContain('Timestamp.fromDate(');
    expect(registrationClient).toContain('fetchBrowserRegistrationApiResponse');
    expect(registrationServer).toContain("buildMasumiApiUrl(session.user.issuer, 'credits')");
    expect(registrationServer).not.toContain('agents/verify');
    expect(registrationServer).not.toContain('masumiVerified');
    expect(workspaceShell).toContain('syncBrowserInboxAgentRegistration');
    expect(workspaceShell).toContain('upsertMasumiInboxAgentRegistration');
    expect(workspaceShell).toContain('ownedInboxAgentRegistrationRefresh');
    expect(generatedTypes).not.toContain('masumiVerified');
    expect(masumiReducer).not.toContain('masumiVerified');
    expect(generatedTypes).toContain('agentIdentifier: __t.option(__t.string())');
    expect(registerRoute).toContain('masumiRegistrationOutcomeToHttpStatus');
    expect(registerRoute).toContain('resolveTrustedOwnedRegistrationSubjectForSession');
    expect(registerRoute).toContain('createMasumiRegistrationOperationalFailureResponse');
    expect(syncRoute).toContain('masumiRegistrationOutcomeToHttpStatus');
    expect(syncRoute).toContain('resolveTrustedOwnedRegistrationSubjectForSession');
    expect(syncRoute).toContain('createMasumiRegistrationOperationalFailureResponse');
    expect(deregisterRoute).toContain('resolveTrustedOwnedRegistrationSubjectForSession');
    expect(deregisterRoute).toContain('masumiRegistrationOutcomeToHttpStatus');
  });

  it('threads clientCreatedAt through the generated device-share contracts', () => {
    const createDeviceShareRequestReducer = readRelativeFile(
      'src/module_bindings/create_device_share_request_reducer.ts'
    );
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');

    expect(createDeviceShareRequestReducer).toContain('clientCreatedAt: __t.timestamp()');
    expect(createDeviceShareRequestReducer).not.toContain('expiresAt: __t.timestamp()');
    expect(generatedTypes).toContain('clientCreatedAt: __t.timestamp()');
    expect(generatedTypes).toContain('export const VisibleDeviceShareRequestRow');
  });

  it('keeps public device key bundle notifications metadata-only', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const visibleBundleRow = extractGeneratedObject(generatedTypes, 'VisibleDeviceKeyBundleRow');
    const claimedBundleRow = extractGeneratedObject(generatedTypes, 'ClaimedDeviceKeyBundleRow');

    expect(visibleBundleRow).toContain('targetDeviceId: __t.string()');
    expect(visibleBundleRow).toContain('sourceEncryptionPublicKey: __t.string()');
    expect(visibleBundleRow).not.toContain('bundleCiphertext');
    expect(visibleBundleRow).not.toContain('bundleIv');
    expect(claimedBundleRow).toContain('bundleCiphertext: __t.string()');
    expect(claimedBundleRow).toContain('bundleIv: __t.string()');
  });

  it('scopes device ids and share-code resolution to the owning inbox', () => {
    const backend = readBackendSource();
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const deviceRow = extractGeneratedObject(generatedTypes, 'Device');
    const shareRequestRow = extractGeneratedObject(generatedTypes, 'DeviceShareRequest');
    const keyBundleRow = extractGeneratedObject(generatedTypes, 'DeviceKeyBundle');

    expect(deviceRow).toContain('uniqueKey: __t.string()');
    expect(shareRequestRow).toContain('inboxId: __t.u64()');
    expect(keyBundleRow).toContain('inboxId: __t.u64()');
    expect(backend).toContain('function buildDeviceKey');
    expect(backend).toContain('candidate.inboxId !== inbox.id');
    expect(backend).toContain('request.inboxId !== device.inboxId');
    expect(backend).not.toContain('deviceId: t.string().unique()');
  });

  it('keeps reducer-only identifiers deterministic and reply targets readable', () => {
    const backend = readBackendSource();
    const slugHelpers = readFileSync(resolve(WEBAPP_ROOT, '../shared/inbox-slug.ts'), 'utf8');

    expect(slugHelpers).not.toContain('Date.now()');
    expect(slugHelpers).toContain('Unable to generate an available default inbox slug');
    expect(backend).toContain('function canAgentReadMessage');
    expect(backend).toContain('replyToMessageId is not visible to the sender');
  });

  it('matches public message visibility to exact sender membership secret envelopes', () => {
    const backend = readBackendSource();

    expect(backend).toContain('function buildSenderSecretVisibilityKey');
    expect(backend).toContain('envelope.membershipVersion');
    expect(backend).toContain('message.membershipVersion');
    expect(backend).not.toContain('function buildSenderSecretVersionKey');
  });

  it('expires stale inbox auth leases without waiting for a cooperating client', () => {
    const backend = readBackendSource();
    const clientConnected = sourceBetween(
      readBackendFile('operations/identity/inbox.ts'),
      'export const clientConnected',
      'export const refreshInboxAuthLease'
    );

    expect(backend).toContain("scheduled: (): any => getScheduledReducer('expireInboxAuthLease')");
    expect(backend).toContain('expireInboxAuthLease,');
    expect(backend).not.toContain('Timestamp.now()');
    expect(backend).toContain('!isTimestampExpired(lease.expiresAt, ctx.timestamp)');
    expect(backend).toContain('function isExpectedInboxAuthLeaseRefreshError');
    expect(backend).toContain('const EXPECTED_INBOX_AUTH_LEASE_REFRESH_ERRORS = new Set');
    expect(clientConnected).toContain('} catch (error) {');
    expect(clientConnected).toContain('if (isExpectedInboxAuthLeaseRefreshError(error))');
    expect(clientConnected).toContain('deactivateSenderInboxAuthLease(ctx);');
    expect(clientConnected).toContain('throw error;');
    expect(clientConnected).not.toContain('} catch {');
  });

  it('expires stale rate-limit buckets through the scheduler', () => {
    const backend = readBackendSource();
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const rateLimitRow = extractGeneratedObject(generatedTypes, 'RateLimit');
    const rateLimitReportRow = extractGeneratedObject(generatedTypes, 'RateLimitReport');

    expect(backend).toContain('const rateLimitCleanupTable = table(');
    expect(backend).toContain("name: 'rate_limit_cleanup'");
    expect(backend).toContain("scheduled: (): any => getScheduledReducer('expireRateLimitBucket')");
    expect(backend).toContain('expireRateLimitBucket,');
    expect(backend).toContain("name: 'rate_limit_report'");
    expect(backend).toContain("scheduled: (): any => getScheduledReducer('expireRateLimitReport')");
    expect(backend).toContain('expireRateLimitReport,');
    expect(backend).toContain('rateLimitCleanup: rateLimitCleanupTable');
    expect(backend).toContain('rateLimitReportCleanup: rateLimitReportCleanupTable');
    expect(backend).toContain('scheduleRateLimitCleanup(dbCtx, bucketKey, expiresAt, now);');
    expect(backend).toContain('function reportRateLimitBucket');
    expect(backend).toContain('limitedCount: existing.limitedCount + 1n');
    expect(backend).toContain('reportRateLimitBucket(ctx, bucket, ctx.timestamp);');
    expect(backend).toContain(
      'bucket.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch'
    );
    expect(backend).toContain('ctx.db.rateLimit.id.delete(bucket.id);');
    expect(rateLimitRow).toContain('expiresAt: __t.timestamp()');
    expect(rateLimitRow).toContain('limitedCount: __t.u64()');
    expect(rateLimitReportRow).toContain('allowedCount: __t.u64()');
    expect(rateLimitReportRow).toContain('limitedCount: __t.u64()');
  });

  it('rate-limits channel admin operations', () => {
    const backend = readBackendSource();
    const memberOperations = readBackendFile('operations/channels/channel-member.ts');
    const joinRequestOperations = readBackendFile('operations/channels/channel-join-request.ts');
    const setPermissionReducer = sourceBetween(
      memberOperations,
      'export const setChannelMemberPermission',
      'export const removeChannelMember'
    );
    const removeMemberReducer = sourceBetween(
      memberOperations,
      'export const removeChannelMember'
    );
    const approveJoinReducer = sourceBetween(
      joinRequestOperations,
      'export const approveChannelJoin',
      'export const rejectChannelJoin'
    );
    const rejectJoinReducer = sourceBetween(
      joinRequestOperations,
      'export const rejectChannelJoin'
    );

    expect(backend).toContain('const CHANNEL_ADMIN_RATE_WINDOW_MS = 60_000');
    expect(backend).toContain('const CHANNEL_ADMIN_RATE_MAX_PER_WINDOW = 30n');
    expect(backend).toContain(
      'bucketKey: `channel_admin:${ctx.sender.toHexString()}:${channelId.toString()}`'
    );
    expect(backend).toContain("action: 'channel_admin'");
    expect(setPermissionReducer).toContain('enforceChannelAdminRateLimit(ctx, channelId);');
    expect(removeMemberReducer).toContain('enforceChannelAdminRateLimit(ctx, channelId);');
    expect(approveJoinReducer).toContain('enforceChannelAdminRateLimit(ctx, channel.id);');
    expect(rejectJoinReducer).toContain('enforceChannelAdminRateLimit(ctx, request.channelId);');
  });

  it('uses thread invites and shared fanout caps for group membership', () => {
    const backend = readBackendSource();
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');

    expect(backend).toContain('const MAX_THREAD_FANOUT = 50');
    expect(backend).toContain('export const threadInviteTable = table(');
    expect(backend).toContain('threadInvite: threadInviteTable');
    expect(backend).toContain('export const visibleThreadInvites');
    expect(backend).toContain('export const acceptThreadInvite');
    expect(backend).toContain('export const rejectThreadInvite');
    expect(backend).not.toContain('export const backfillThreadSecretEnvelopes');
    expect(backend).toContain('isDirectContactAllowed(ctx, actor, participant)');
    expect(backend).toContain('ensureThreadInvite(ctx, thread.id, actor, participant)');
    expect(backend).toContain('requireMaxArrayLength(deviceKeyBundles ?? [], MAX_THREAD_FANOUT');
    expect(backend).toContain('requireMaxArrayLength(revokeDeviceIds ?? [], MAX_THREAD_FANOUT');
    expect(backend).toMatch(/requireMaxArrayLength\(\s*params\.attachedSecretEnvelopes/);
    expect(generatedIndex).toContain('visibleThreadInvites');
    expect(generatedIndex).toContain('__reducerSchema("accept_thread_invite"');
    expect(generatedIndex).toContain('__reducerSchema("reject_thread_invite"');
    expect(generatedIndex).not.toContain('__reducerSchema("backfill_thread_secret_envelopes"');
  });

  it('keeps device-share expiry client-derived in visible views', () => {
    const shareView = sourceBetween(
      readBackendFile('operations/identity/device-share-request.ts'),
      'export const visibleDeviceShareRequests'
    );
    const bundleView = sourceBetween(
      readBackendFile('operations/identity/device-key-bundle.ts'),
      'export const visibleDeviceKeyBundles'
    );
    const slugRoute = readRelativeFile('src/routes/$slug.tsx');
    const rootShellModel = readFileSync(
      resolve(WEBAPP_ROOT, '../cli/src/services/root-shell-model.ts'),
      'utf8'
    );

    expect(shareView).not.toContain('Timestamp.now()');
    expect(bundleView).not.toContain('Timestamp.now()');
    expect(shareView).toContain('expiresAt: request.expiresAt');
    expect(bundleView).toContain('expiresAt: bundle.expiresAt');
    expect(slugRoute).toContain('isTimestampInFuture(bundle.expiresAt)');
    expect(rootShellModel).toContain('isTimestampInFuture(request.expiresAt)');
  });

  it('rejects device key bundles that cannot be claimed', () => {
    const backend = readBackendSource();

    expect(backend).toContain('const DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS = 15 * 60_000');
    expect(backend).toContain('function requireClaimableDeviceKeyBundleExpiry');
    expect(backend).toContain('Device key bundle expiresAt must be in the future');
    expect(backend).toContain('Device key bundle expiresAt is too far in the future');
    expect(backend).toContain('requireClaimableDeviceKeyBundleExpiry(ctx.timestamp, attachment.expiresAt);');
  });
});
