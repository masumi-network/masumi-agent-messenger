//! `visible_account_change_signal` — one live row containing procedure refresh versions.

use spacetimedb::ViewContext;

use crate::operations::views::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::view(accessor = visible_account_change_signal, public)]
pub fn visible_account_change_signal(ctx: &ViewContext) -> Vec<AccountChangeSignal> {
    let Some(account_id) = caller_account_id(ctx) else {
        return Vec::new();
    };
    ctx.db
        .account_change_signal()
        .account_id()
        .find(&account_id)
        .into_iter()
        .collect()
}
