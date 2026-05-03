import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEBAPP_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const REPO_ROOT = resolve(WEBAPP_ROOT, '..');
const BACKEND_SRC_ROOT = resolve(REPO_ROOT, 'spacetimedb/src');

function readRelativeFile(relativePath: string): string {
  return readFileSync(resolve(WEBAPP_ROOT, relativePath), 'utf8');
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function readBackendSourceDirectory(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return readBackendSourceDirectory(fullPath);
      }
      if (!entry.isFile() || !entry.name.endsWith('.rs')) {
        return '';
      }
      return `\n// ${fullPath.slice(BACKEND_SRC_ROOT.length + 1)}\n${readFileSync(fullPath, 'utf8')}`;
    })
    .join('\n');
}

function readBackendSource(): string {
  return readBackendSourceDirectory(BACKEND_SRC_ROOT);
}

function extractGeneratedObject(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} =`);
  if (start < 0) {
    throw new Error(`Generated object ${name} was not found`);
  }
  const end = source.indexOf(`export type ${name}`, start);
  if (end < 0) {
    throw new Error(`Generated type ${name} was not found`);
  }
  return source.slice(start, end);
}

describe('generated and source security contracts (post-rework)', () => {
  it('drops anonymous channel discovery; only direct-slug procedures remain', () => {
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');
    const backend = readBackendSource();

    // Dropped per the rework plan
    expect(backend).not.toContain('readPublicChannel');
    expect(backend).not.toContain('listPublicChannels');
    expect(generatedIndex).not.toContain('lookup_published_contact_target_by_slug');
    expect(
      existsSync(
        resolve(
          WEBAPP_ROOT,
          'src/module_bindings/lookup_published_contact_target_by_slug_procedure.ts'
        )
      )
    ).toBe(false);

    // Replacements that DO ship: anonymous-callable procedures gated to public channels.
    expect(generatedIndex).toContain('lookup_public_channel_by_slug');
    expect(generatedIndex).toContain('list_public_channel_messages');
  });

  it('keeps zero `public = true` tables in the Rust module', () => {
    const backend = readBackendSource();
    expect(backend).not.toMatch(/public\s*=\s*true/);
  });

  it('drops the dropped tables and replaces them with the unified scheduler', () => {
    const backend = readBackendSource();
    const tableDefs = readBackendSourceDirectory(resolve(BACKEND_SRC_ROOT, 'tables'));

    // Dropped tables
    for (const droppedTable of [
      'thread_read_state',
      'public_channel',
      'public_recent_channel_message',
      'inbox_thread',
      'inbox_thread_backfill',
      'direct_thread_index',
      'rate_limit_report',
      'rate_limit_cleanup',
      'inbox_auth_lease_expiry',
      'device_key_bundle_expiry',
    ]) {
      expect(tableDefs).not.toContain(`accessor = ${droppedTable}`);
    }

    // Unified scheduler is in place
    expect(tableDefs).toContain('accessor = scheduled_expiry');
    expect(backend).toContain('pub fn expire_scheduled');
  });

  it('removes the dropped visible_* view tables from the generated bindings', () => {
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');

    for (const droppedView of [
      'visible_inboxes',
      'visible_agents',
      'visible_devices',
      'visible_threads',
      'visible_thread_participants',
      'visible_thread_read_states',
      'visible_thread_secret_envelopes',
      'visible_thread_invites',
      'visible_contact_requests',
      'visible_contact_allowlist_entries',
      'visible_channel_join_requests',
      'visible_messages',
      'visible_channel_messages',
    ]) {
      expect(generatedIndex).not.toContain(`from "./${droppedView}_table"`);
      expect(generatedIndex).not.toContain(`name: '${droppedView}'`);
      expect(
        existsSync(
          resolve(WEBAPP_ROOT, `src/module_bindings/${droppedView}_table.ts`)
        )
      ).toBe(false);
    }
  });

  it('keeps reducer names aligned with the rework rename table', () => {
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');

    // Renamed / replaced reducers — old names must be gone
    for (const droppedReducer of [
      'upsert_inbox_from_oidc_identity',
      'create_inbox_identity',
      'refresh_inbox_auth_lease',
      'expire_inbox_auth_lease',
      'expire_device_key_bundle',
      'expire_rate_limit_bucket',
      'expire_rate_limit_report',
      'repair_own_sender_read_states',
      'upsert_masumi_inbox_agent_registration',
      'set_agent_public_linked_email_visibility',
      'set_agent_public_description',
      'set_agent_public_message_capabilities',
      'create_direct_thread',
      'create_group_thread',
      'mark_thread_read',
      'set_thread_archived',
      'reject_thread_invite',
      'request_direct_contact_with_first_message',
      'set_channel_member_permission',
      'approve_device_share',
    ]) {
      expect(generatedIndex).not.toContain(`__reducerSchema("${droppedReducer}"`);
    }

    // New / renamed reducers must be present (excludes the scheduled `expire_scheduled` —
    // SpacetimeDB fires it internally; it is not exposed in the client reducer registry).
    for (const reducer of [
      'upsert_account_from_oidc_identity',
      'create_agent',
      'refresh_account_auth_lease',
      'rotate_agent_keys',
      'upsert_masumi_registration',
      'update_agent_profile',
      'register_device',
      'revoke_device',
      'create_device_share_request',
      'approve_device_share_request',
      'create_thread',
      'delete_thread',
      'add_thread_participant',
      'remove_thread_participant',
      'set_thread_participant_admin',
      'accept_thread_invite',
      'decline_thread_invite',
      'update_thread_read_state',
      'request_direct_contact',
      'send_encrypted_message',
      'create_channel',
      'update_channel_settings',
      'send_channel_message',
      'join_public_channel',
      'request_channel_join',
      'approve_channel_join',
      'reject_channel_join',
      'update_channel_member_permission',
      'update_channel_member_read_state',
      'remove_channel_member',
      'approve_contact_request',
      'cancel_contact_request',
      'reject_contact_request',
      'add_contact_allowlist_entry',
      'remove_contact_allowlist_entry',
    ]) {
      expect(generatedIndex).toContain(`__reducerSchema("${reducer}"`);
    }
  });

  it('keeps procedures aligned with the rework registry', () => {
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');

    // Cross-account public reads (anonymous-callable)
    expect(generatedIndex).toContain('lookup_published_agent_by_slug');
    expect(generatedIndex).not.toContain('__procedureSchema("lookup_published_agents_by_email"');
    expect(generatedIndex).toContain('__procedureSchema("lookup_published_agents_by_email_page"');
    expect(generatedIndex).toContain('lookup_published_public_route_by_slug');
    expect(generatedIndex).toContain('lookup_agent_public_keys');
    expect(generatedIndex).toContain('lookup_published_agent_signing_keys');
    expect(generatedIndex).toContain('list_public_channel_messages');
    expect(generatedIndex).toContain('lookup_public_channel_by_slug');

    // Authenticated paginated reads
    expect(generatedIndex).toContain('list_thread_messages');
    expect(generatedIndex).toContain('list_channel_messages');
    expect(generatedIndex).toContain('list_channel_members');
    expect(generatedIndex).toContain('list_thread_participants');
    expect(generatedIndex).not.toContain('__procedureSchema("list_owned_agents"');
    expect(generatedIndex).toContain('__procedureSchema("list_owned_agents_page"');
    expect(
      existsSync(resolve(WEBAPP_ROOT, 'src/module_bindings/list_owned_agents_procedure.ts'))
    ).toBe(false);
    expect(generatedIndex).toContain('list_owned_devices');
    expect(generatedIndex).toContain('list_contact_allowlist_entries');
    expect(generatedIndex).toContain('list_visible_threads');
    expect(generatedIndex).not.toContain('__procedureSchema("list_visible_channels"');
    expect(generatedIndex).toContain('__procedureSchema("list_visible_channel_page"');
    expect(generatedIndex).toContain('list_discoverable_channels');
    expect(generatedIndex).toContain('read_visible_thread');
    expect(generatedIndex).toContain('read_owned_agent');
    expect(generatedIndex).toContain('read_visible_channel_state');
    expect(generatedIndex).toContain('read_contact_request');
    expect(generatedIndex).toContain('list_thread_secret_envelopes');

    // Resolved-history readers (status-filtered view companions)
    expect(generatedIndex).toContain('list_resolved_thread_invites');
    expect(generatedIndex).toContain('list_resolved_contact_requests');
    expect(generatedIndex).toContain('list_resolved_channel_join_requests');

    // Reducer-equivalent reads that must return data
    expect(generatedIndex).toContain('claim_device_key_bundle');
    expect(generatedIndex).toContain('resolve_device_share_request_by_code');
  });

  it('keeps visible thread pages preview-only for participants', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const visibleThreadsProcedure = readRepoFile(
      'spacetimedb/src/operations/procedures/list_visible_threads.rs'
    );
    const threadParticipantsProcedure = readRepoFile(
      'spacetimedb/src/operations/procedures/list_thread_participants.rs'
    );

    expect(generatedTypes).toContain('ThreadParticipantPreview');
    expect(generatedTypes).toContain('VisibleAgentRow');
    expect(generatedTypes).toContain('participantPreviews');
    expect(generatedTypes).toMatch(/actors[\s\S]{0,80}VisibleAgentRow/);
    expect(generatedTypes).not.toMatch(/participants[\s\S]{0,80}ThreadParticipant;/);
    expect(visibleThreadsProcedure).toContain('participant_previews');
    expect(visibleThreadsProcedure).toContain('visible_agent_row_for_account');
    expect(visibleThreadsProcedure).not.toContain('pub participants: Vec<ThreadParticipant>');
    expect(threadParticipantsProcedure).toContain('pub participants: Vec<ThreadParticipantPreview>');
    expect(threadParticipantsProcedure).not.toContain('pub participants: Vec<ThreadParticipant>');
  });

  it('does not let public email lookup confirm hidden linked emails', () => {
    const lookupSource = readRepoFile(
      'spacetimedb/src/operations/procedures/lookup_published_agents_by_email.rs'
    );

    expect(lookupSource).toContain('.agent_email_public_linked_enabled_id()');
    expect(lookupSource).toContain('require_valid_email(&email, "email")');
    expect(lookupSource).toContain('let start_id = after_id.unwrap_or(0).saturating_add(1);');
    expect(lookupSource).toMatch(/\.filter\(\(&normalized_email\[\.\.\],\s*true,\s*start_id\.\.\)\)/);
  });

  it('keeps rotate_agent_keys account-owned and free of device approval gates', () => {
    const rotateReducerSource = readRepoFile(
      'spacetimedb/src/operations/identity/rotate_agent_keys.rs'
    );

    expect(rotateReducerSource).toContain('get_owned_account');
    expect(rotateReducerSource).toContain('require_oidc_claims');
    expect(rotateReducerSource).not.toMatch(/device_id:\s*String/);
    expect(rotateReducerSource).not.toContain('DeviceStatus::Approved');

    const rotateReducerBindings = readRelativeFile(
      'src/module_bindings/rotate_agent_keys_reducer.ts'
    );
    expect(rotateReducerBindings).not.toContain('deviceId');
  });

  it('keeps device-share source attribution account-trusted and non-free-form', () => {
    const approveReducerSource = readRepoFile(
      'spacetimedb/src/operations/identity/approve_device_share_request.rs'
    );
    const shareReducerSource = readRepoFile(
      'spacetimedb/src/operations/identity/share_device_key_bundle.rs'
    );

    expect(approveReducerSource).toContain('Device attribution is account-trusted');
    expect(shareReducerSource).toContain('Device attribution is account-trusted');
    expect(approveReducerSource).toContain('find_approved_device_by_public_key_tuple');
    expect(shareReducerSource).toContain('find_approved_device_by_public_key_tuple');
    expect(approveReducerSource).not.toContain('source_device_proof');
    expect(shareReducerSource).not.toContain('source_device_proof');

    const approveReducerBindings = readRelativeFile(
      'src/module_bindings/approve_device_share_request_reducer.ts'
    );
    const shareReducerBindings = readRelativeFile(
      'src/module_bindings/share_device_key_bundle_reducer.ts'
    );
    expect(approveReducerBindings).not.toContain('sourceDeviceId');
    expect(shareReducerBindings).not.toContain('sourceDeviceId');
    expect(approveReducerBindings).not.toContain('sourceDeviceProof');
    expect(shareReducerBindings).not.toContain('sourceDeviceProof');
  });

  it('drops legacy sentinels and synthetic compound keys from the schema', () => {
    const backend = readBackendSource();

    // No legacy default-value sentinels
    expect(backend).not.toMatch(/'LEGACY'/);
    expect(backend).not.toMatch(/sortKey:\s*'pending'/);
    expect(backend).not.toContain('updatedAtSortKey');

    // No synthetic compound-uniqueness columns
    expect(backend).not.toMatch(/\bpub\s+unique_key:\s*String/);
    expect(backend).not.toMatch(/\bpub\s+thread_seq_key:\s*String/);
    expect(backend).not.toMatch(/\bpub\s+channel_seq_key:\s*String/);
  });

  it('keeps sender-local counters off message rows and on membership rows', () => {
    const messageTable = readRepoFile('spacetimedb/src/tables/message_def.rs');
    const channelMessageTable = readRepoFile('spacetimedb/src/tables/channel_message_def.rs');
    const threadParticipantTable = readRepoFile(
      'spacetimedb/src/tables/thread_participant_def.rs'
    );
    const channelMemberTable = readRepoFile('spacetimedb/src/tables/channel_member_def.rs');

    expect(messageTable).not.toMatch(/^\s*pub\s+sender_seq:\s*u64,/m);
    expect(channelMessageTable).not.toMatch(/^\s*pub\s+sender_seq:\s*u64,/m);
    expect(threadParticipantTable).toMatch(/^\s*pub\s+last_sent_seq:\s*u64,/m);
    expect(channelMemberTable).toMatch(/^\s*pub\s+last_sent_seq:\s*u64,/m);
  });

  it('protects sender-secret rotation invariants in send_encrypted_message.rs', () => {
    const reducer = readRepoFile(
      'spacetimedb/src/operations/threads/send_encrypted_message.rs'
    );

    // First-message-must-rotate gate.
    expect(reducer).toMatch(/last_sent_seq\s*==\s*0\s*&&\s*!attaches_new_envelopes/);
    expect(reducer).toContain(
      'The first message for a sender in this thread must publish a secretVersion'
    );

    // Non-rotation messages must reuse the current sender secret.
    expect(reducer).toMatch(/last_sent_seq\s*>\s*0\s*&&\s*!attaches_new_envelopes/);
    expect(reducer).toContain(
      'Non-rotation messages must reuse the current sender secretVersion'
    );

    // Rotation messages must increase the per-sender secret version (no replay).
    expect(reducer).toMatch(
      /attaches_new_envelopes\s*&&\s*secret_version\s*<=\s*last_sent_secret/
    );
    expect(reducer).toContain('Rotation messages must use a greater secretVersion');
  });

  it('protects per-message replay and signing-version pinning in insert_thread_message', () => {
    const helpers = readRepoFile('spacetimedb/src/helpers/messages.rs');

    // Replay protection: server rejects reuse of (sender, sender_message_id).
    expect(helpers).toContain('senderMessageId has already been used by this sender');
    expect(helpers).toMatch(
      /message_sender_agent_db_id_sender_message_id\(\)[\s\S]{0,200}\.is_some\(\)/
    );

    // signing_key_version must match the sender's currently-published bundle.
    expect(helpers).toMatch(
      /signing_key_version\s*!=\s*params\.sender\.current_key_bundle_version/
    );
    expect(helpers).toContain(
      "signingKeyVersion must match the sender's current signing key version"
    );

    // sender_message_id == 0 is rejected (mirrors `randomSenderMessageId`'s reroll).
    expect(helpers).toMatch(/sender_message_id\s*==\s*0/);
  });

  it('mirrors the cryptographic byte caps between client and server', () => {
    const constants = readRepoFile('spacetimedb/src/constants.rs');
    const sharedLimits = readRepoFile('shared/message-limits.ts');

    expect(constants).toMatch(/MAX_MESSAGE_CIPHERTEXT_BYTES.*=\s*144\s*\*\s*1024/);
    expect(sharedLimits).toMatch(/MAX_MESSAGE_CIPHERTEXT_BYTES\s*=\s*144\s*\*\s*1024/);
    expect(constants).toMatch(/AES_GCM_IV_BYTES.*=\s*12/);
    expect(sharedLimits).toMatch(/AES_GCM_IV_BYTES\s*=\s*12/);
    expect(constants).toMatch(/SIGNATURE_BYTES.*=\s*64/);
    expect(sharedLimits).toMatch(/SIGNATURE_BYTES\s*=\s*64/);
    expect(constants).toMatch(
      /MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES.*=\s*3\s*\*\s*1024\s*\*\s*1024/
    );
    expect(sharedLimits).toMatch(
      /MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES\s*=\s*3\s*\*\s*1024\s*\*\s*1024/
    );
  });

  it('drops last_message_seq from thread and channel rows', () => {
    const threadTable = readRepoFile('spacetimedb/src/tables/thread_def.rs');
    const channelTable = readRepoFile('spacetimedb/src/tables/channel_def.rs');

    expect(threadTable).not.toMatch(/^\s*pub\s+last_message_seq:/m);
    expect(channelTable).not.toMatch(/^\s*pub\s+last_message_seq:/m);
  });

  it('keeps the rename: account / accountId / accountAuthLease (not inbox)', () => {
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');
    const tableDefs = readBackendSourceDirectory(resolve(BACKEND_SRC_ROOT, 'tables'));

    // Old table names gone
    expect(tableDefs).not.toMatch(/accessor\s*=\s*inbox\b/);
    expect(tableDefs).not.toMatch(/accessor\s*=\s*inbox_auth_lease\b/);

    // New table names present
    expect(tableDefs).toMatch(/accessor\s*=\s*account\b/);
    expect(tableDefs).toMatch(/accessor\s*=\s*account_auth_lease\b/);

    // No `inboxId` column accessor in generated bindings
    expect(generatedIndex).not.toContain('inbox_id_eq');
  });

  it('exposes resolver actor ids for resolved requests and invites', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const threadInviteRow = extractGeneratedObject(generatedTypes, 'ThreadInvite');
    const channelJoinRequestRow = extractGeneratedObject(generatedTypes, 'ChannelJoinRequest');
    const contactRequestRow = extractGeneratedObject(generatedTypes, 'ContactRequest');

    for (const row of [threadInviteRow, channelJoinRequestRow, contactRequestRow]) {
      expect(row).toContain('resolvedAt: __t.option(__t.timestamp())');
      expect(row).toContain('resolvedByAgentDbId: __t.option(__t.u64())');
    }
  });

  it('drops public-key/algorithm columns from agent in favor of agent_key_bundle', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const agentRow = extractGeneratedObject(generatedTypes, 'Agent');

    expect(agentRow).not.toContain('currentEncryptionPublicKey');
    expect(agentRow).not.toContain('currentSigningPublicKey');
    expect(agentRow).not.toContain('currentEncryptionAlgorithm');
    expect(agentRow).not.toContain('currentSigningAlgorithm');

    // The current coupled key-bundle pointer stays on agent.
    expect(agentRow).toContain('currentKeyBundleVersion: __t.u32()');

    // Material lives on agent_key_bundle
    const keyBundleRow = extractGeneratedObject(generatedTypes, 'AgentKeyBundle');
    expect(keyBundleRow).toContain('keyBundleVersion: __t.u32()');
    expect(keyBundleRow).toContain('encryptionPublicKey: __t.string()');
    expect(keyBundleRow).toContain('signingPublicKey: __t.string()');
  });

  it('uses tagged enums for status, kind, permission, access mode, and algorithm fields', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');

    for (const enumName of [
      'ThreadKind',
      'ChannelAccessMode',
      'ChannelPermission',
      'ChannelJoinRequestStatus',
      'ThreadInviteStatus',
      'ContactRequestStatus',
      'ContactAllowlistKind',
      'DeviceStatus',
      'DeviceKeyBundlePurpose',
      'MasumiRegistrationState',
      'RateLimitAction',
      'EncryptionAlgorithm',
      'SigningAlgorithm',
      'DeviceEncryptionAlgorithm',
      'DeviceBundleAlgorithm',
      'MessageCipherAlgorithm',
      'ThreadSecretWrapAlgorithm',
      'ScheduledExpiryKind',
    ]) {
      expect(generatedTypes).toContain(`export const ${enumName} = __t.enum`);
    }
  });

  it('removes the dropped Masumi `Unregistered` enum variant in favor of Option::None', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const constants = readRepoFile('spacetimedb/src/constants.rs');

    expect(generatedTypes).not.toContain('Unregistered: __t.unit()');
    expect(constants).not.toMatch(/^\s*Unregistered,\s*$/m);
  });

  it('uses numeric u32 key versions throughout the generated bindings', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const agentRow = extractGeneratedObject(generatedTypes, 'Agent');
    const agentKeyBundleRow = extractGeneratedObject(generatedTypes, 'AgentKeyBundle');
    const messageRow = extractGeneratedObject(generatedTypes, 'Message');
    const channelMessageRow = extractGeneratedObject(generatedTypes, 'ChannelMessage');

    expect(agentRow).toContain('currentKeyBundleVersion: __t.u32()');
    expect(agentKeyBundleRow).toContain('keyBundleVersion: __t.u32()');
    expect(agentKeyBundleRow).not.toContain('encryptionKeyVersion: __t.u32()');
    expect(agentKeyBundleRow).not.toContain('signingKeyVersion: __t.u32()');
    expect(messageRow).toContain('signingKeyVersion: __t.u32()');
    expect(messageRow).toContain('secretVersion: __t.u32()');
    expect(channelMessageRow).toContain('senderSigningKeyVersion: __t.u32()');
  });

  it('keeps webapp logout on POST and removes debug token panels from the inbox route', () => {
    const logoutRoute = readRelativeFile('src/routes/auth.logout.ts');
    const slugRoute = readRelativeFile('src/routes/$slug.tsx');
    const authSession = readRelativeFile('src/lib/auth-session.tsx');

    expect(logoutRoute).toContain('POST');
    expect(logoutRoute).toContain('status: 405');
    expect(slugRoute).not.toContain('OIDC Debug');
    expect(slugRoute).not.toContain('Message Debug');
    expect(slugRoute).not.toContain('ID Token Preview');
    expect(authSession).not.toContain('accessToken: string | null');
  });

  it('does not leak the dropped public-actor resolve route', () => {
    const routeTree = readRelativeFile('src/routeTree.gen.ts');

    expect(routeTree).not.toContain('/api/actors/resolve');
    expect(existsSync(resolve(WEBAPP_ROOT, 'src/routes/api.actors.resolve.ts'))).toBe(false);
  });

  it('keeps webapp masumi-registration metadata scalar-only and routes through the right endpoints', () => {
    const registrationClient = readRelativeFile('src/lib/inbox-agent-registration.ts');
    const registerRoute = readRelativeFile('src/routes/api.masumi.inbox-agent.register.ts');
    const syncRoute = readRelativeFile('src/routes/api.masumi.inbox-agent.sync.ts');
    const deregisterRoute = readRelativeFile('src/routes/api.masumi.inbox-agent.deregister.ts');
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');

    expect(registrationClient).not.toContain('Timestamp.fromDate(');
    expect(registrationClient).toContain('fetchBrowserRegistrationApiResponse');
    expect(generatedTypes).not.toContain('masumiVerified');
    expect(generatedTypes).toContain('agentIdentifier: __t.option(__t.string())');

    for (const route of [registerRoute, syncRoute, deregisterRoute]) {
      expect(route).toContain('masumiRegistrationOutcomeToHttpStatus');
      expect(route).toContain('resolveTrustedOwnedRegistrationSubjectForSession');
    }
    for (const route of [registerRoute, syncRoute]) {
      expect(route).toContain('createMasumiRegistrationOperationalFailureResponse');
    }
  });

  it('threads clientCreatedAt through the device-share generated contracts', () => {
    const createDeviceShareRequestReducer = readRelativeFile(
      'src/module_bindings/create_device_share_request_reducer.ts'
    );
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');

    expect(createDeviceShareRequestReducer).toContain('clientCreatedAt: __t.timestamp()');
    expect(createDeviceShareRequestReducer).not.toContain('expiresAt: __t.timestamp()');
    expect(generatedTypes).toContain('clientCreatedAt: __t.timestamp()');
  });

  it('limits device-key-bundle lifetime to a known constant', () => {
    const constants = readRepoFile('spacetimedb/src/constants.rs');

    expect(constants).toContain('DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS');
  });

  it('rate-limits channel admin operations through the unified bucket', () => {
    const constants = readRepoFile('spacetimedb/src/constants.rs');
    const helpers = readBackendSource();

    expect(constants).toContain('CHANNEL_ADMIN_RATE_WINDOW_MS');
    expect(constants).toContain('CHANNEL_ADMIN_RATE_MAX_PER_WINDOW');
    expect(helpers).toContain('RateLimitAction::ChannelAdmin');
  });

  it('keeps RateLimit observability fields generated', () => {
    const generatedTypes = readRelativeFile('src/module_bindings/types.ts');
    const rateLimitRow = extractGeneratedObject(generatedTypes, 'RateLimit');

    expect(rateLimitRow).toContain('expiresAt: __t.timestamp()');
    expect(rateLimitRow).toContain('limitedCount: __t.u64()');
  });

  it('caps thread fan-out and exposes it as a constant', () => {
    const constants = readRepoFile('spacetimedb/src/constants.rs');

    expect(constants).toMatch(/MAX_THREAD_FANOUT.*=\s*50/);
  });

  it('caps live subscription pages in the bounded views', () => {
    const constants = readRepoFile('spacetimedb/src/constants.rs');

    expect(constants).toContain('MAX_VISIBLE_THREAD_PAGE_SIZE');
    expect(constants).toContain('MAX_VISIBLE_MESSAGES_PER_THREAD');
    expect(constants).toContain('MAX_CHANNEL_MEMBER_PAGE_SIZE');
    expect(constants).toContain('MAX_CHANNEL_MESSAGE_PAGE_SIZE');
  });

  it('keeps device-share expiry client-derived in the visible view (no Timestamp.now in views)', () => {
    const view = readRepoFile('spacetimedb/src/operations/views/visible_device_share_requests.rs');

    expect(view).not.toContain('ctx.timestamp');
    expect(view).not.toContain('Timestamp::now');
  });

  it('blocks anonymous channel-message reads on private channels', () => {
    const procedure = readRepoFile(
      'spacetimedb/src/operations/procedures/list_public_channel_messages.rs'
    );

    expect(procedure).toContain('ChannelAccessMode::Public');
  });

  it('does not require a per-peer pinned trust store for channel signers', () => {
    const channelSigningKeys = readRelativeFile('src/lib/channel-signing-keys.ts');

    // Channel signature trust is enforced by resolving the published key per (agentDbId, signingKeyVersion);
    // not by walking a local pinned store.
    expect(channelSigningKeys).toContain('lookupPublishedAgentSigningKeys');
    expect(channelSigningKeys).not.toContain('comparePinnedPeer');
  });

  it('resolves device-share verification codes against a hashed bucket, not plaintext', () => {
    const procedure = readRepoFile(
      'spacetimedb/src/operations/procedures/resolve_device_share_request_by_code.rs'
    );

    expect(procedure).toContain('verification_code_hash');
    expect(procedure).not.toMatch(/\bverification_code:\s*String/);
  });

  it('drops the dropped procedures and adds the new resolved-history readers', () => {
    const generatedIndex = readRelativeFile('src/module_bindings/index.ts');

    // Dropped per the rework
    expect(generatedIndex).not.toContain('read_public_channel');
    expect(generatedIndex).not.toContain('list_public_channels');

    // Added per the rework
    expect(generatedIndex).toContain('list_visible_channel_page');
    expect(generatedIndex).toContain('list_thread_participants');
    expect(generatedIndex).toContain('list_resolved_thread_invites');
    expect(generatedIndex).toContain('list_resolved_contact_requests');
    expect(generatedIndex).toContain('list_resolved_channel_join_requests');
  });
});
