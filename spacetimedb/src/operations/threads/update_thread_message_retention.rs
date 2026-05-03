//! `update_thread_message_retention` — admin-owned message TTL setting.

use spacetimedb::ReducerContext;

use crate::constants::{
    RateLimitAction, MAX_THREAD_MESSAGE_RETENTION_MS, THREAD_ADMIN_RATE_MAX_PER_WINDOW,
    THREAD_ADMIN_RATE_WINDOW_MS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::retention::schedule_next_message_expiry;
use crate::helpers::threads::require_admin_thread_participant;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn update_thread_message_retention(
    ctx: &ReducerContext,
    agent_db_id: u64,
    thread_id: u64,
    message_retention_ms: Option<u64>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;
    require_admin_thread_participant(ctx, thread_id, actor.id)?;

    let bk = bucket_key(
        RateLimitAction::ThreadAdmin,
        ctx.sender(),
        Some(&thread_id.to_string()),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ThreadAdmin,
            owner_identity: ctx.sender(),
            window_ms: THREAD_ADMIN_RATE_WINDOW_MS as i64,
            max_count: THREAD_ADMIN_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Thread admin rate limit exceeded; try again later".to_string());
    }

    if let Some(value) = message_retention_ms {
        if value == 0 || value > MAX_THREAD_MESSAGE_RETENTION_MS {
            return Err(format!(
                "messageRetentionMs must be between 1 and {MAX_THREAD_MESSAGE_RETENTION_MS}"
            ));
        }
    }

    let thread = ctx
        .db
        .thread()
        .id()
        .find(&thread_id)
        .ok_or_else(|| "Thread not found".to_string())?;
    ctx.db.thread().id().update(Thread {
        message_retention_ms,
        updated_at: ctx.timestamp,
        ..thread
    });
    schedule_next_message_expiry(ctx, thread_id);
    Ok(())
}
