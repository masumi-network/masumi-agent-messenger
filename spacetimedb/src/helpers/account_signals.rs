//! Account-scoped invalidation signals for procedure-backed snapshots.

use spacetimedb::{ReducerContext, Table};

use crate::tables::*;

fn next_version(value: u64) -> u64 {
    value.saturating_add(1).max(1)
}

pub fn ensure_account_change_signal(ctx: &ReducerContext, account_id: u64) -> AccountChangeSignal {
    let table = ctx.db.account_change_signal();
    if let Some(row) = table.account_id().find(&account_id) {
        return row;
    }
    table.insert(AccountChangeSignal {
        id: 0,
        account_id,
        owned_agents_version: 1,
        owned_devices_version: 1,
        contact_requests_version: 1,
        thread_invites_version: 1,
        contact_allowlist_version: 1,
        channel_join_requests_version: 1,
        thread_list_version: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    })
}

pub fn bump_owned_agents_signal(ctx: &ReducerContext, account_id: u64) {
    let existing = ensure_account_change_signal(ctx, account_id);
    ctx.db
        .account_change_signal()
        .id()
        .update(AccountChangeSignal {
            owned_agents_version: next_version(existing.owned_agents_version),
            updated_at: ctx.timestamp,
            ..existing
        });
}

pub fn bump_owned_devices_signal(ctx: &ReducerContext, account_id: u64) {
    let existing = ensure_account_change_signal(ctx, account_id);
    ctx.db
        .account_change_signal()
        .id()
        .update(AccountChangeSignal {
            owned_devices_version: next_version(existing.owned_devices_version),
            updated_at: ctx.timestamp,
            ..existing
        });
}

pub fn bump_contact_requests_signal(ctx: &ReducerContext, account_id: u64) {
    let existing = ensure_account_change_signal(ctx, account_id);
    ctx.db
        .account_change_signal()
        .id()
        .update(AccountChangeSignal {
            contact_requests_version: next_version(existing.contact_requests_version),
            updated_at: ctx.timestamp,
            ..existing
        });
}

pub fn bump_thread_invites_signal(ctx: &ReducerContext, account_id: u64) {
    let existing = ensure_account_change_signal(ctx, account_id);
    ctx.db
        .account_change_signal()
        .id()
        .update(AccountChangeSignal {
            thread_invites_version: next_version(existing.thread_invites_version),
            updated_at: ctx.timestamp,
            ..existing
        });
}

pub fn bump_contact_allowlist_signal(ctx: &ReducerContext, account_id: u64) {
    let existing = ensure_account_change_signal(ctx, account_id);
    ctx.db
        .account_change_signal()
        .id()
        .update(AccountChangeSignal {
            contact_allowlist_version: next_version(existing.contact_allowlist_version),
            updated_at: ctx.timestamp,
            ..existing
        });
}

pub fn bump_channel_join_requests_signal(ctx: &ReducerContext, account_id: u64) {
    let existing = ensure_account_change_signal(ctx, account_id);
    ctx.db
        .account_change_signal()
        .id()
        .update(AccountChangeSignal {
            channel_join_requests_version: next_version(existing.channel_join_requests_version),
            updated_at: ctx.timestamp,
            ..existing
        });
}

pub fn bump_thread_list_signal(ctx: &ReducerContext, account_id: u64) {
    let existing = ensure_account_change_signal(ctx, account_id);
    ctx.db
        .account_change_signal()
        .id()
        .update(AccountChangeSignal {
            thread_list_version: next_version(existing.thread_list_version),
            updated_at: ctx.timestamp,
            ..existing
        });
}
