//! Channel member access checks and bounded channel-recency fan-out.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    ChannelAccessMode, ChannelJoinRequestStatus, ChannelPermission, ScheduledExpiryKind,
    CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_BATCH_SIZE,
    CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_RETRY_DELAY_MS, CHANNEL_RECENCY_FANOUT_BATCH_SIZE,
    CHANNEL_RECENCY_FANOUT_RETRY_DELAY_MS,
};
use crate::helpers::account_signals::bump_channel_join_requests_signal;
use crate::helpers::scheduling::{cancel_expiry_for, schedule_expiry};
use crate::helpers::time::{
    descending_timestamp_key, timestamp_plus_ms, EXCLUDED_DESCENDING_TIMESTAMP_KEY,
};
use crate::tables::*;

pub const NON_DISCOVERABLE_CHANNEL_SORT_KEY: i64 = EXCLUDED_DESCENDING_TIMESTAMP_KEY;
pub const NON_DISCOVERABLE_CHANNEL_ID_DESC_SORT_KEY: u64 = u64::MAX;
pub const NON_DISCOVERABLE_CHANNEL_PAGE_SORT_KEY: &str =
    "18446744073709551615:18446744073709551615";
pub const INACTIVE_CHANNEL_MEMBER_SORT_KEY: i64 = EXCLUDED_DESCENDING_TIMESTAMP_KEY;

fn signed_i64_lex_key(value: i64) -> u64 {
    (value as u64) ^ (1u64 << 63)
}

pub fn public_discoverable_channel_sort_key(
    access_mode: ChannelAccessMode,
    discoverable: bool,
    last_message_at: spacetimedb::Timestamp,
) -> i64 {
    if matches!(access_mode, ChannelAccessMode::Public) && discoverable {
        descending_timestamp_key(last_message_at)
    } else {
        NON_DISCOVERABLE_CHANNEL_SORT_KEY
    }
}

pub fn public_discoverable_channel_id_desc_sort_key(
    access_mode: ChannelAccessMode,
    discoverable: bool,
    channel_id: u64,
) -> u64 {
    if matches!(access_mode, ChannelAccessMode::Public) && discoverable {
        u64::MAX.saturating_sub(channel_id)
    } else {
        NON_DISCOVERABLE_CHANNEL_ID_DESC_SORT_KEY
    }
}

pub fn public_discoverable_channel_page_sort_key(
    access_mode: ChannelAccessMode,
    discoverable: bool,
    last_message_at: spacetimedb::Timestamp,
    channel_id: u64,
) -> String {
    if matches!(access_mode, ChannelAccessMode::Public) && discoverable {
        let timestamp_key = signed_i64_lex_key(public_discoverable_channel_sort_key(
            access_mode,
            discoverable,
            last_message_at,
        ));
        let id_key =
            public_discoverable_channel_id_desc_sort_key(access_mode, discoverable, channel_id);
        format!("{timestamp_key:020}:{id_key:020}")
    } else {
        NON_DISCOVERABLE_CHANNEL_PAGE_SORT_KEY.to_string()
    }
}

pub fn channel_member_recency_sort_key(
    active: bool,
    channel_last_message_at: spacetimedb::Timestamp,
) -> i64 {
    if active {
        descending_timestamp_key(channel_last_message_at)
    } else {
        INACTIVE_CHANNEL_MEMBER_SORT_KEY
    }
}

pub fn get_channel_account_membership(
    ctx: &ReducerContext,
    channel_id: u64,
    account_id: u64,
) -> Option<ChannelAccountMembership> {
    ctx.db
        .channel_account_membership()
        .channel_account_membership_channel_id_account_id()
        .filter((channel_id, account_id))
        .next()
}

fn ensure_channel_join_request_admin_visibility(
    ctx: &ReducerContext,
    request: &ChannelJoinRequest,
    admin_account_id: u64,
) {
    if !matches!(request.status, ChannelJoinRequestStatus::Pending)
        || request.channel_pending_sort_key == EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        return;
    }
    let table = ctx.db.channel_join_request_admin_visibility();
    if table
        .channel_join_request_admin_visibility_request_id_admin_account_id()
        .filter((request.id, admin_account_id))
        .next()
        .is_some()
    {
        return;
    }
    table.insert(ChannelJoinRequestAdminVisibility {
        id: 0,
        request_id: request.id,
        channel_id: request.channel_id,
        admin_account_id,
        pending_sort_key: request.channel_pending_sort_key,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    bump_channel_join_requests_signal(ctx, admin_account_id);
}

fn ensure_channel_join_request_resolved_admin_visibility(
    ctx: &ReducerContext,
    request: &ChannelJoinRequest,
    admin_account_id: u64,
) {
    if matches!(request.status, ChannelJoinRequestStatus::Pending)
        || request.channel_resolved_sort_key == EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        return;
    }
    let table = ctx.db.channel_join_request_resolved_admin_visibility();
    if table
        .channel_join_request_resolved_admin_visibility_request_id_admin_account_id()
        .filter((request.id, admin_account_id))
        .next()
        .is_some()
    {
        return;
    }
    table.insert(ChannelJoinRequestResolvedAdminVisibility {
        id: 0,
        request_id: request.id,
        channel_id: request.channel_id,
        admin_account_id,
        resolved_sort_key: request.channel_resolved_sort_key,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    bump_channel_join_requests_signal(ctx, admin_account_id);
}

pub fn sync_channel_join_request_admin_visibility_for_request(
    ctx: &ReducerContext,
    request: &ChannelJoinRequest,
) {
    if !matches!(request.status, ChannelJoinRequestStatus::Pending)
        || request.channel_pending_sort_key == EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        return;
    }
    let table = ctx.db.channel_join_request_admin_visibility_fanout();
    let fanout = if let Some(existing) = table.request_id().find(&request.id) {
        table.id().update(ChannelJoinRequestAdminVisibilityFanout {
            channel_id: request.channel_id,
            updated_at: ctx.timestamp,
            ..existing
        })
    } else {
        table.insert(ChannelJoinRequestAdminVisibilityFanout {
            id: 0,
            request_id: request.id,
            channel_id: request.channel_id,
            next_account_membership_id: 0,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        })
    };
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::ChannelJoinRequestAdminVisibilityFanout,
        fanout.id,
        ctx.timestamp,
    );
}

pub fn sync_channel_join_request_resolved_admin_visibility_for_request(
    ctx: &ReducerContext,
    request: &ChannelJoinRequest,
) {
    if matches!(request.status, ChannelJoinRequestStatus::Pending)
        || request.channel_resolved_sort_key == EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        return;
    }
    let table = ctx
        .db
        .channel_join_request_resolved_admin_visibility_fanout();
    let fanout = if let Some(existing) = table.request_id().find(&request.id) {
        table
            .id()
            .update(ChannelJoinRequestResolvedAdminVisibilityFanout {
                channel_id: request.channel_id,
                resolved_sort_key: request.channel_resolved_sort_key,
                updated_at: ctx.timestamp,
                ..existing
            })
    } else {
        table.insert(ChannelJoinRequestResolvedAdminVisibilityFanout {
            id: 0,
            request_id: request.id,
            channel_id: request.channel_id,
            resolved_sort_key: request.channel_resolved_sort_key,
            next_account_membership_id: 0,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        })
    };
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::ChannelJoinRequestResolvedAdminVisibilityFanout,
        fanout.id,
        ctx.timestamp,
    );
}

pub fn delete_channel_join_request_admin_visibility(ctx: &ReducerContext, request_id: u64) {
    if let Some(fanout) = ctx
        .db
        .channel_join_request_admin_visibility_fanout()
        .request_id()
        .find(&request_id)
    {
        cancel_expiry_for(
            ctx,
            ScheduledExpiryKind::ChannelJoinRequestAdminVisibilityFanout,
            fanout.id,
        );
        ctx.db
            .channel_join_request_admin_visibility_fanout()
            .id()
            .delete(&fanout.id);
    }
    let visibility_ids: Vec<(u64, u64)> = ctx
        .db
        .channel_join_request_admin_visibility()
        .channel_join_request_admin_visibility_request_id()
        .filter(request_id)
        .map(|row| (row.id, row.admin_account_id))
        .collect();
    for (visibility_id, admin_account_id) in visibility_ids {
        ctx.db
            .channel_join_request_admin_visibility()
            .id()
            .delete(&visibility_id);
        bump_channel_join_requests_signal(ctx, admin_account_id);
    }
}

fn sync_channel_join_request_admin_visibility_for_account(
    ctx: &ReducerContext,
    channel_id: u64,
    admin_account_id: u64,
) {
    let pending_requests: Vec<ChannelJoinRequest> = ctx
        .db
        .channel_join_request()
        .channel_join_request_channel_id_pending_sort_key()
        .filter((channel_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
        .filter(|request| matches!(request.status, ChannelJoinRequestStatus::Pending))
        .collect();
    for request in pending_requests {
        ensure_channel_join_request_admin_visibility(ctx, &request, admin_account_id);
    }
}

fn delete_channel_join_request_admin_visibility_for_account(
    ctx: &ReducerContext,
    channel_id: u64,
    admin_account_id: u64,
) {
    let visibility_ids: Vec<u64> = ctx
        .db
        .channel_join_request_admin_visibility()
        .channel_join_request_admin_visibility_channel_id_admin_account_id()
        .filter((channel_id, admin_account_id))
        .map(|row| row.id)
        .collect();
    for visibility_id in visibility_ids {
        ctx.db
            .channel_join_request_admin_visibility()
            .id()
            .delete(&visibility_id);
    }
    bump_channel_join_requests_signal(ctx, admin_account_id);
}

fn increment_channel_account_membership(
    ctx: &ReducerContext,
    channel_id: u64,
    account_id: u64,
    permission: ChannelPermission,
    channel_last_message_at: spacetimedb::Timestamp,
) {
    let active_recency_sort_key = channel_member_recency_sort_key(true, channel_last_message_at);
    let admin_delta = if matches!(permission, ChannelPermission::Admin) {
        1
    } else {
        0
    };
    let table = ctx.db.channel_account_membership();
    if let Some(existing) = get_channel_account_membership(ctx, channel_id, account_id) {
        let had_admin_visibility = existing.active_admin_count > 0;
        let active_admin_count = existing.active_admin_count.saturating_add(admin_delta);
        table.id().update(ChannelAccountMembership {
            active_agent_count: existing.active_agent_count.saturating_add(1),
            active_admin_count,
            active_recency_sort_key,
            updated_at: ctx.timestamp,
            ..existing
        });
        if !had_admin_visibility && active_admin_count > 0 {
            sync_channel_join_request_admin_visibility_for_account(ctx, channel_id, account_id);
        }
        return;
    }

    table.insert(ChannelAccountMembership {
        id: 0,
        channel_id,
        account_id,
        active_agent_count: 1,
        active_admin_count: admin_delta,
        active_recency_sort_key,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    if admin_delta > 0 {
        sync_channel_join_request_admin_visibility_for_account(ctx, channel_id, account_id);
    }
}

pub fn decrement_channel_account_membership(
    ctx: &ReducerContext,
    channel_id: u64,
    account_id: u64,
    permission: ChannelPermission,
) {
    let Some(existing) = get_channel_account_membership(ctx, channel_id, account_id) else {
        return;
    };
    let active_agent_count = existing.active_agent_count.saturating_sub(1);
    let had_admin_visibility = existing.active_admin_count > 0;
    let active_admin_count = if matches!(permission, ChannelPermission::Admin) {
        existing.active_admin_count.saturating_sub(1)
    } else {
        existing.active_admin_count
    };
    let active_recency_sort_key = if active_agent_count == 0 {
        INACTIVE_CHANNEL_MEMBER_SORT_KEY
    } else {
        existing.active_recency_sort_key
    };
    ctx.db
        .channel_account_membership()
        .id()
        .update(ChannelAccountMembership {
            active_agent_count,
            active_admin_count,
            active_recency_sort_key,
            updated_at: ctx.timestamp,
            ..existing
        });
    if had_admin_visibility && active_admin_count == 0 {
        delete_channel_join_request_admin_visibility_for_account(ctx, channel_id, account_id);
    }
}

pub fn update_channel_account_admin_membership(
    ctx: &ReducerContext,
    channel_id: u64,
    account_id: u64,
    was_admin: bool,
    is_admin: bool,
) {
    if was_admin == is_admin {
        return;
    }
    let Some(existing) = get_channel_account_membership(ctx, channel_id, account_id) else {
        return;
    };
    let had_admin_visibility = existing.active_admin_count > 0;
    let active_admin_count = if is_admin {
        existing.active_admin_count.saturating_add(1)
    } else {
        existing.active_admin_count.saturating_sub(1)
    };
    ctx.db
        .channel_account_membership()
        .id()
        .update(ChannelAccountMembership {
            active_admin_count,
            updated_at: ctx.timestamp,
            ..existing
        });
    if !had_admin_visibility && active_admin_count > 0 {
        sync_channel_join_request_admin_visibility_for_account(ctx, channel_id, account_id);
    } else if had_admin_visibility && active_admin_count == 0 {
        delete_channel_join_request_admin_visibility_for_account(ctx, channel_id, account_id);
    }
}

pub fn bump_channel_account_recency(
    ctx: &ReducerContext,
    channel_id: u64,
    account_id: u64,
    last_message_at: spacetimedb::Timestamp,
) {
    let Some(existing) = get_channel_account_membership(ctx, channel_id, account_id) else {
        return;
    };
    if existing.active_agent_count == 0 {
        return;
    }
    ctx.db
        .channel_account_membership()
        .id()
        .update(ChannelAccountMembership {
            active_recency_sort_key: channel_member_recency_sort_key(true, last_message_at),
            updated_at: ctx.timestamp,
            ..existing
        });
}

pub fn get_channel_member(
    ctx: &ReducerContext,
    channel_id: u64,
    agent_db_id: u64,
) -> Option<ChannelMember> {
    ctx.db
        .channel_member()
        .channel_member_channel_id_agent_db_id()
        .filter((channel_id, agent_db_id))
        .next()
}

pub fn require_active_channel_member(
    ctx: &ReducerContext,
    channel_id: u64,
    agent_db_id: u64,
) -> Result<ChannelMember, String> {
    let m = get_channel_member(ctx, channel_id, agent_db_id)
        .ok_or_else(|| "Caller is not a member of this channel".to_string())?;
    if !m.active {
        return Err("Caller is not an active member of this channel".to_string());
    }
    Ok(m)
}

pub fn require_admin_channel_member(
    ctx: &ReducerContext,
    channel_id: u64,
    agent_db_id: u64,
) -> Result<ChannelMember, String> {
    let m = require_active_channel_member(ctx, channel_id, agent_db_id)?;
    if !matches!(m.permission, ChannelPermission::Admin) {
        return Err("Caller is not an admin of this channel".to_string());
    }
    Ok(m)
}

pub fn require_send_permission(
    ctx: &ReducerContext,
    channel_id: u64,
    agent_db_id: u64,
) -> Result<ChannelMember, String> {
    let m = require_active_channel_member(ctx, channel_id, agent_db_id)?;
    if matches!(m.permission, ChannelPermission::Read) {
        return Err("Caller does not have write permission in this channel".to_string());
    }
    Ok(m)
}

pub fn ensure_channel_member(
    ctx: &ReducerContext,
    channel_id: u64,
    agent: &Agent,
    permission: ChannelPermission,
) -> Result<ChannelMember, String> {
    let table = ctx.db.channel_member();
    let channel_last_message_at = ctx
        .db
        .channel()
        .id()
        .find(channel_id)
        .map(|channel| channel.last_message_at)
        .unwrap_or(ctx.timestamp);
    if let Some(existing) = get_channel_member(ctx, channel_id, agent.id) {
        let was_active = existing.active;
        let old_permission = existing.permission;
        let updated = ChannelMember {
            permission,
            active: true,
            active_recency_sort_key: channel_member_recency_sort_key(true, channel_last_message_at),
            updated_at: ctx.timestamp,
            ..existing
        };
        let member = table.id().update(updated);
        if !was_active {
            increment_channel_account_membership(
                ctx,
                channel_id,
                agent.account_id,
                permission,
                channel_last_message_at,
            );
        } else if old_permission != permission {
            update_channel_account_admin_membership(
                ctx,
                channel_id,
                agent.account_id,
                matches!(old_permission, ChannelPermission::Admin),
                matches!(permission, ChannelPermission::Admin),
            );
        }
        return Ok(member);
    }
    let member = table.insert(ChannelMember {
        id: 0,
        channel_id,
        agent_db_id: agent.id,
        account_id: agent.account_id,
        permission,
        active: true,
        active_recency_sort_key: channel_member_recency_sort_key(true, channel_last_message_at),
        last_sent_seq: 0,
        last_read_message_id: 0,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    increment_channel_account_membership(
        ctx,
        channel_id,
        agent.account_id,
        permission,
        channel_last_message_at,
    );
    Ok(member)
}

pub fn require_another_active_admin(
    ctx: &ReducerContext,
    channel_id: u64,
    excluding_agent_db_id: u64,
) -> Result<(), String> {
    let has_other = ctx
        .db
        .channel_member()
        .channel_member_channel_id_permission_active()
        .filter((channel_id, ChannelPermission::Admin, true))
        .any(|m| m.agent_db_id != excluding_agent_db_id);
    if !has_other {
        return Err("Cannot remove or demote the last active admin of this channel".to_string());
    }
    Ok(())
}

pub fn cleanup_channel_join_request_admin_visibility_fanout_batch(
    ctx: &ReducerContext,
    fanout_id: u64,
) {
    let Some(fanout) = ctx
        .db
        .channel_join_request_admin_visibility_fanout()
        .id()
        .find(&fanout_id)
    else {
        return;
    };
    let Some(request) = ctx.db.channel_join_request().id().find(&fanout.request_id) else {
        ctx.db
            .channel_join_request_admin_visibility_fanout()
            .id()
            .delete(&fanout_id);
        return;
    };
    if !matches!(request.status, ChannelJoinRequestStatus::Pending)
        || request.channel_pending_sort_key == EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        ctx.db
            .channel_join_request_admin_visibility_fanout()
            .id()
            .delete(&fanout_id);
        return;
    }

    let start_id = fanout.next_account_membership_id.saturating_add(1);
    let rows: Vec<ChannelAccountMembership> = ctx
        .db
        .channel_account_membership()
        .channel_account_membership_channel_id_id()
        .filter((fanout.channel_id, start_id..))
        .take(CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_BATCH_SIZE)
        .collect();

    let mut last_seen_account_membership_id = fanout.next_account_membership_id;
    for membership in &rows {
        last_seen_account_membership_id = membership.id;
        if membership.active_admin_count > 0 {
            ensure_channel_join_request_admin_visibility(ctx, &request, membership.account_id);
        }
    }

    if rows.len() == CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_BATCH_SIZE {
        ctx.db
            .channel_join_request_admin_visibility_fanout()
            .id()
            .update(ChannelJoinRequestAdminVisibilityFanout {
                next_account_membership_id: last_seen_account_membership_id,
                updated_at: ctx.timestamp,
                ..fanout
            });
        schedule_expiry(
            ctx,
            ScheduledExpiryKind::ChannelJoinRequestAdminVisibilityFanout,
            fanout_id,
            timestamp_plus_ms(
                ctx.timestamp,
                CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_RETRY_DELAY_MS as i64,
            ),
        );
    } else {
        ctx.db
            .channel_join_request_admin_visibility_fanout()
            .id()
            .delete(&fanout_id);
    }
}

pub fn cleanup_channel_join_request_resolved_admin_visibility_fanout_batch(
    ctx: &ReducerContext,
    fanout_id: u64,
) {
    let Some(fanout) = ctx
        .db
        .channel_join_request_resolved_admin_visibility_fanout()
        .id()
        .find(&fanout_id)
    else {
        return;
    };
    let Some(request) = ctx.db.channel_join_request().id().find(&fanout.request_id) else {
        ctx.db
            .channel_join_request_resolved_admin_visibility_fanout()
            .id()
            .delete(&fanout_id);
        return;
    };
    if matches!(request.status, ChannelJoinRequestStatus::Pending)
        || request.channel_resolved_sort_key == EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        ctx.db
            .channel_join_request_resolved_admin_visibility_fanout()
            .id()
            .delete(&fanout_id);
        return;
    }

    let start_id = fanout.next_account_membership_id.saturating_add(1);
    let rows: Vec<ChannelAccountMembership> = ctx
        .db
        .channel_account_membership()
        .channel_account_membership_channel_id_id()
        .filter((fanout.channel_id, start_id..))
        .take(CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_BATCH_SIZE)
        .collect();

    let mut last_seen_account_membership_id = fanout.next_account_membership_id;
    for membership in &rows {
        last_seen_account_membership_id = membership.id;
        if membership.active_admin_count > 0 {
            ensure_channel_join_request_resolved_admin_visibility(
                ctx,
                &request,
                membership.account_id,
            );
        }
    }

    if rows.len() == CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_BATCH_SIZE {
        ctx.db
            .channel_join_request_resolved_admin_visibility_fanout()
            .id()
            .update(ChannelJoinRequestResolvedAdminVisibilityFanout {
                resolved_sort_key: request.channel_resolved_sort_key,
                next_account_membership_id: last_seen_account_membership_id,
                updated_at: ctx.timestamp,
                ..fanout
            });
        schedule_expiry(
            ctx,
            ScheduledExpiryKind::ChannelJoinRequestResolvedAdminVisibilityFanout,
            fanout_id,
            timestamp_plus_ms(
                ctx.timestamp,
                CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_RETRY_DELAY_MS as i64,
            ),
        );
    } else {
        ctx.db
            .channel_join_request_resolved_admin_visibility_fanout()
            .id()
            .delete(&fanout_id);
    }
}

pub fn schedule_channel_recency_fanout(
    ctx: &ReducerContext,
    channel_id: u64,
    last_message_at: spacetimedb::Timestamp,
) {
    let target_recency_sort_key = channel_member_recency_sort_key(true, last_message_at);
    let table = ctx.db.channel_recency_fanout();
    let fanout = if let Some(existing) = table.channel_id().find(&channel_id) {
        let restart_requested =
            existing.restart_requested || existing.next_account_membership_id > 0;
        table.id().update(ChannelRecencyFanout {
            target_recency_sort_key,
            restart_requested,
            updated_at: ctx.timestamp,
            ..existing
        })
    } else {
        table.insert(ChannelRecencyFanout {
            id: 0,
            channel_id,
            target_recency_sort_key,
            next_account_membership_id: 0,
            restart_requested: false,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        })
    };
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::ChannelRecencyFanout,
        fanout.id,
        ctx.timestamp,
    );
}

pub fn cleanup_channel_recency_fanout_batch(ctx: &ReducerContext, fanout_id: u64) {
    let Some(fanout) = ctx.db.channel_recency_fanout().id().find(&fanout_id) else {
        return;
    };
    if ctx.db.channel().id().find(&fanout.channel_id).is_none() {
        ctx.db.channel_recency_fanout().id().delete(&fanout_id);
        return;
    }

    let start_id = fanout.next_account_membership_id.saturating_add(1);
    let rows: Vec<ChannelAccountMembership> = ctx
        .db
        .channel_account_membership()
        .channel_account_membership_channel_id_id()
        .filter((fanout.channel_id, start_id..))
        .take(CHANNEL_RECENCY_FANOUT_BATCH_SIZE)
        .collect();

    let mut last_seen_account_membership_id = fanout.next_account_membership_id;
    let account_membership_table = ctx.db.channel_account_membership();
    for membership in &rows {
        last_seen_account_membership_id = membership.id;
        if membership.active_agent_count > 0
            && membership.active_recency_sort_key != fanout.target_recency_sort_key
        {
            account_membership_table
                .id()
                .update(ChannelAccountMembership {
                    active_recency_sort_key: fanout.target_recency_sort_key,
                    updated_at: ctx.timestamp,
                    ..membership.clone()
                });
        }
    }

    if rows.len() == CHANNEL_RECENCY_FANOUT_BATCH_SIZE {
        ctx.db
            .channel_recency_fanout()
            .id()
            .update(ChannelRecencyFanout {
                next_account_membership_id: last_seen_account_membership_id,
                updated_at: ctx.timestamp,
                ..fanout
            });
        schedule_expiry(
            ctx,
            ScheduledExpiryKind::ChannelRecencyFanout,
            fanout_id,
            timestamp_plus_ms(ctx.timestamp, CHANNEL_RECENCY_FANOUT_RETRY_DELAY_MS as i64),
        );
    } else if fanout.restart_requested {
        ctx.db
            .channel_recency_fanout()
            .id()
            .update(ChannelRecencyFanout {
                next_account_membership_id: 0,
                restart_requested: false,
                updated_at: ctx.timestamp,
                ..fanout
            });
        schedule_expiry(
            ctx,
            ScheduledExpiryKind::ChannelRecencyFanout,
            fanout_id,
            timestamp_plus_ms(ctx.timestamp, CHANNEL_RECENCY_FANOUT_RETRY_DELAY_MS as i64),
        );
    } else {
        ctx.db.channel_recency_fanout().id().delete(&fanout_id);
    }
}
