//! Account / agent lookup helpers.
//!
//! Read-side: `find_account_by_owner_identity`, `find_account_by_email`,
//! `get_owned_account` (errors if caller has no account).
//! Slug allocation: `require_available_slug`, `build_default_slug_for_account`.

use spacetimedb::ReducerContext;

use crate::helpers::slug::{build_default_slug, is_reserved_slug};
use crate::tables::*;

pub fn find_account_by_owner(ctx: &ReducerContext) -> Option<Account> {
    ctx.db.account().owner_identity().find(&ctx.sender())
}

pub fn find_account_by_email(ctx: &ReducerContext, email: &str) -> Option<Account> {
    ctx.db.account().email().find(email.to_string())
}

pub fn get_owned_account(ctx: &ReducerContext) -> Result<Account, String> {
    find_account_by_owner(ctx).ok_or_else(|| "Caller has no account for this identity".to_string())
}

pub fn find_agent_by_slug(ctx: &ReducerContext, slug: &str) -> Option<Agent> {
    ctx.db.agent().slug().find(slug.to_string())
}

pub fn require_available_slug(
    ctx: &ReducerContext,
    slug: &str,
    allow_agent_id: Option<u64>,
) -> Result<(), String> {
    if let Some(existing) = find_agent_by_slug(ctx, slug) {
        if Some(existing.id) != allow_agent_id {
            return Err("slug is already registered".to_string());
        }
    }
    Ok(())
}

/// Walks `<base>-<hash>` and `<base>-<hash>-<n>` until it finds an unused slug. Bounded.
pub fn build_default_slug_for_account(ctx: &ReducerContext, email: &str) -> Result<String, String> {
    let base = crate::helpers::slug::email_slug_base(email);
    if !is_reserved_slug(&base) && find_agent_by_slug(ctx, &base).is_none() {
        return Ok(base);
    }
    let hashed = build_default_slug(email);
    if !is_reserved_slug(&hashed) && find_agent_by_slug(ctx, &hashed).is_none() {
        return Ok(hashed);
    }
    for attempt in 2..10_000u32 {
        let candidate = format!("{hashed}-{attempt}");
        if !is_reserved_slug(&candidate) && find_agent_by_slug(ctx, &candidate).is_none() {
            return Ok(candidate);
        }
    }
    Err("Unable to generate an available default slug".to_string())
}

pub fn get_default_agent(ctx: &ReducerContext, account_id: u64) -> Option<Agent> {
    ctx.db
        .agent()
        .agent_account_id_is_default()
        .filter((account_id, true))
        .next()
}
