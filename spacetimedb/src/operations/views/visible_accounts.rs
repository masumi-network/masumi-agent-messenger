//! `visible_accounts` — caller's own account row (1 row max).

use spacetimedb::ViewContext;

use crate::operations::views::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::view(accessor = visible_accounts, public)]
pub fn visible_accounts(ctx: &ViewContext) -> Vec<Account> {
    let Some(account_id) = caller_account_id(ctx) else {
        return Vec::new();
    };
    ctx.db
        .account()
        .id()
        .find(&account_id)
        .into_iter()
        .collect()
}
