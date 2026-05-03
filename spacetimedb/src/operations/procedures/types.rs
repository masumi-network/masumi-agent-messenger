//! Shared return types for procedures. These mirror the row shapes the webapp + CLI consumers
//! expect (`procedures-stub.ts`); the original "published actor lookup" / "public route" shapes
//! synthesized fields that aren't directly stored on `agent` (algorithms, contact policy
//! placeholders, derived `linkedEmail` based on `public_linked_email_enabled`).

use spacetimedb::{SpacetimeType, Timestamp};

use crate::constants::MasumiRegistrationState;
use crate::tables::{Agent, ThreadParticipant};

#[derive(SpacetimeType, Debug, Clone)]
pub struct VisibleAgentRow {
    pub id: u64,
    pub account_id: u64,
    pub slug: String,
    pub public_identity: String,
    pub email: String,
    pub display_name: Option<String>,
    pub public_description: Option<String>,
    pub is_default: bool,
    pub public_linked_email_enabled: bool,
    pub allow_all_message_content_types: bool,
    pub allow_all_message_headers: bool,
    pub supported_message_content_types: Vec<String>,
    pub supported_message_header_names: Vec<String>,
    pub masumi_registration_network: Option<String>,
    pub masumi_inbox_agent_id: Option<String>,
    pub masumi_agent_identifier: Option<String>,
    pub masumi_registration_state: Option<MasumiRegistrationState>,
    pub current_key_bundle_version: u32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

pub fn visible_agent_row_for_account(agent: &Agent, caller_account_id: u64) -> VisibleAgentRow {
    let owned_by_caller = agent.account_id == caller_account_id;
    VisibleAgentRow {
        id: agent.id,
        account_id: if owned_by_caller { agent.account_id } else { 0 },
        slug: agent.slug.clone(),
        public_identity: agent.public_identity.clone(),
        email: if owned_by_caller || agent.public_linked_email_enabled {
            agent.email.clone()
        } else {
            String::new()
        },
        display_name: agent.display_name.clone(),
        public_description: agent.public_description.clone(),
        is_default: owned_by_caller && agent.is_default,
        public_linked_email_enabled: agent.public_linked_email_enabled,
        allow_all_message_content_types: agent.allow_all_message_content_types,
        allow_all_message_headers: agent.allow_all_message_headers,
        supported_message_content_types: agent.supported_message_content_types.clone(),
        supported_message_header_names: agent.supported_message_header_names.clone(),
        masumi_registration_network: owned_by_caller
            .then(|| agent.masumi_registration_network.clone())
            .flatten(),
        masumi_inbox_agent_id: owned_by_caller
            .then(|| agent.masumi_inbox_agent_id.clone())
            .flatten(),
        masumi_agent_identifier: agent.masumi_agent_identifier.clone(),
        masumi_registration_state: owned_by_caller
            .then_some(agent.masumi_registration_state)
            .flatten(),
        current_key_bundle_version: agent.current_key_bundle_version,
        created_at: agent.created_at,
        updated_at: agent.updated_at,
    }
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct ThreadParticipantPreview {
    pub id: u64,
    pub thread_id: u64,
    pub agent_db_id: u64,
    pub account_id: u64,
    pub membership_version: Option<u64>,
    pub last_sent_seq: Option<u64>,
    pub last_sent_secret_version: Option<u32>,
    pub last_read_message_id: Option<u64>,
    pub archived: Option<bool>,
    pub is_admin: bool,
    pub active: bool,
    pub created_at: Timestamp,
}

pub fn thread_participant_preview(
    participant: &ThreadParticipant,
    include_private_state: bool,
) -> ThreadParticipantPreview {
    ThreadParticipantPreview {
        id: participant.id,
        thread_id: participant.thread_id,
        agent_db_id: participant.agent_db_id,
        account_id: if include_private_state {
            participant.account_id
        } else {
            0
        },
        membership_version: include_private_state.then_some(participant.membership_version),
        last_sent_seq: include_private_state.then_some(participant.last_sent_seq),
        last_sent_secret_version: include_private_state
            .then_some(participant.last_sent_secret_version),
        last_read_message_id: include_private_state.then_some(participant.last_read_message_id),
        archived: include_private_state.then_some(participant.archived),
        is_admin: participant.is_admin,
        active: participant.active,
        created_at: participant.created_at,
    }
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct PublishedAgentLookupRow {
    pub agent_db_id: u64,
    pub slug: String,
    pub public_identity: String,
    pub display_name: Option<String>,
    pub is_default: bool,
    pub linked_email: Option<String>,
    pub agent_identifier: Option<String>,
    pub encryption_key_version: u32,
    pub encryption_algorithm: String,
    pub encryption_public_key: String,
    pub signing_key_version: u32,
    pub signing_algorithm: String,
    pub signing_public_key: String,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct PublishedPublicRouteHeaderCapability {
    pub name: String,
    pub required: Option<bool>,
    pub allow_multiple: Option<bool>,
    pub sensitive: Option<bool>,
    pub allowed_prefixes: Option<Vec<String>>,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct PublishedPublicRouteContactPolicy {
    pub mode: String,
    pub allowlist_scope: String,
    pub allowlist_kinds: Vec<String>,
    pub message_preview_visible_before_approval: bool,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct PublishedPublicRouteRow {
    pub slug: String,
    pub public_identity: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub public_linked_email_enabled: bool,
    pub linked_email: Option<String>,
    pub agent_identifier: Option<String>,
    pub encryption_key_version: u32,
    pub encryption_algorithm: String,
    pub encryption_public_key: String,
    pub signing_key_version: u32,
    pub signing_algorithm: String,
    pub signing_public_key: String,
    pub allow_all_content_types: bool,
    pub allow_all_headers: bool,
    pub supported_content_types: Vec<String>,
    pub supported_headers: Vec<PublishedPublicRouteHeaderCapability>,
    pub contact_policy: PublishedPublicRouteContactPolicy,
}

#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPublicKeyKind {
    Encryption,
    Signing,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct AgentPublicKeyLookupRow {
    pub agent_db_id: u64,
    pub key_kind: AgentPublicKeyKind,
    pub key_version: u32,
    pub public_key: String,
    pub algorithm: String,
    pub created_at: Timestamp,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct PublishedAgentSigningKeyLookupRow {
    pub agent_db_id: u64,
    pub signing_key_version: u32,
    pub signing_public_key: String,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct AgentPublicKeyLookupRequest {
    pub agent_db_id: u64,
    pub key_kind: AgentPublicKeyKind,
    pub key_version: u32,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct PublishedAgentSigningKeyLookupRequest {
    pub agent_db_id: u64,
    pub signing_key_version: u32,
}

#[derive(SpacetimeType, Debug, Clone)]
pub struct ResolvedDeviceShareRequestRow {
    pub request_id: u64,
    pub device_id: String,
    pub label: Option<String>,
    pub platform: Option<String>,
    pub device_encryption_public_key: String,
    pub device_encryption_key_version: u32,
    pub device_encryption_algorithm: String,
    pub client_created_at: Timestamp,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
}
