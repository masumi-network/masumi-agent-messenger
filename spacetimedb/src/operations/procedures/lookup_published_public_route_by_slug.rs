//! `lookup_published_public_route_by_slug` — anonymous slug → full public route surface.
//!
//! Returns capability info (content types, headers), the published key tuple, and the agent's
//! real contact policy derived from its `contact_allowlist_entry` rows. The schema gates followup
//! sends through `request_direct_contact` (the recipient must approve after reading the first
//! message), so the policy `mode` is always `approval_required`. The `allowlist_kinds` field
//! surfaces only the categorical kinds present (`agent` and/or `email`) — not the individual
//! entries.

use std::collections::BTreeSet;

use spacetimedb::ProcedureContext;

use crate::constants::{
    ContactAllowlistKind, RateLimitAction, PUBLIC_ROUTE_LOOKUP_RATE_MAX_PER_WINDOW,
    PUBLIC_ROUTE_LOOKUP_RATE_WINDOW_MS,
};
use crate::helpers::rate_limit::{bucket_key, enforce_in_tx, EnforceParams};
use crate::helpers::validate::normalize_slug_string;
use crate::operations::procedures::lookup_published_agent_by_slug::build_published_agent_lookup_row;
use crate::operations::procedures::types::{
    PublishedPublicRouteContactPolicy, PublishedPublicRouteRow,
};
use crate::tables::*;

#[spacetimedb::procedure]
pub fn lookup_published_public_route_by_slug(
    ctx: &mut ProcedureContext,
    slug: String,
) -> Vec<PublishedPublicRouteRow> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let bk = bucket_key(RateLimitAction::PublicRouteLookup, sender, None);
        if !enforce_in_tx(
            tx,
            timestamp,
            EnforceParams {
                bucket_key: &bk,
                action: RateLimitAction::PublicRouteLookup,
                owner_identity: sender,
                window_ms: PUBLIC_ROUTE_LOOKUP_RATE_WINDOW_MS as i64,
                max_count: PUBLIC_ROUTE_LOOKUP_RATE_MAX_PER_WINDOW,
            },
        ) {
            return Vec::new();
        }
        let Ok(normalized_slug) = normalize_slug_string(&slug, "slug") else {
            return Vec::new();
        };
        let Some(agent) = tx.db.agent().slug().find(&normalized_slug) else {
            return Vec::new();
        };
        let Some(lookup) = build_published_agent_lookup_row(tx, &agent) else {
            return Vec::new();
        };

        // Collect the categorical kinds present in this agent's account allowlist. Surfaces the
        // shape of the policy (`['agent']`, `['email']`, both, or none) without leaking the
        // specific entries.
        let mut kinds: BTreeSet<&'static str> = BTreeSet::new();
        if tx
            .db
            .contact_allowlist_entry()
            .contact_allowlist_entry_account_id_kind()
            .filter((agent.account_id, ContactAllowlistKind::Agent))
            .next()
            .is_some()
        {
            kinds.insert("agent");
        }
        if tx
            .db
            .contact_allowlist_entry()
            .contact_allowlist_entry_account_id_kind()
            .filter((agent.account_id, ContactAllowlistKind::Email))
            .next()
            .is_some()
        {
            kinds.insert("email");
        }
        let allowlist_kinds: Vec<String> = kinds.into_iter().map(|s| s.to_string()).collect();

        let row = PublishedPublicRouteRow {
            slug: lookup.slug,
            public_identity: lookup.public_identity,
            display_name: lookup.display_name,
            description: agent.public_description.clone(),
            public_linked_email_enabled: agent.public_linked_email_enabled,
            linked_email: lookup.linked_email,
            agent_identifier: lookup.agent_identifier,
            encryption_key_version: lookup.encryption_key_version,
            encryption_algorithm: lookup.encryption_algorithm,
            encryption_public_key: lookup.encryption_public_key,
            signing_key_version: lookup.signing_key_version,
            signing_algorithm: lookup.signing_algorithm,
            signing_public_key: lookup.signing_public_key,
            allow_all_content_types: agent.allow_all_message_content_types,
            allow_all_headers: agent.allow_all_message_headers,
            supported_content_types: agent.supported_message_content_types.clone(),
            // Header capability metadata moved off the agent row in the new schema; expose only
            // header names. Webapp consumers fall back to defaults for `required` etc.
            supported_headers: agent
                .supported_message_header_names
                .iter()
                .map(|name| {
                    crate::operations::procedures::types::PublishedPublicRouteHeaderCapability {
                        name: name.clone(),
                        required: None,
                        allow_multiple: None,
                        sensitive: None,
                        allowed_prefixes: None,
                    }
                })
                .collect(),
            contact_policy: PublishedPublicRouteContactPolicy {
                // First sends always go through `request_direct_contact`; the initial message is
                // stored before approval, but the recipient cannot read the pending thread until
                // approval creates their participant row. Allowlist entries grant fast-path
                // approval but do not create an open / public mode in this schema.
                mode: "approval_required".into(),
                allowlist_scope: "agent".into(),
                allowlist_kinds,
                message_preview_visible_before_approval: false,
            },
        };
        vec![row]
    })
}
