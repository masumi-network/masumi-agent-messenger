//! Status-filtered: only pending rows. Expiry is applied by `expire_scheduled`, which marks stale
//! requests consumed; completed share requests fetched via procedure for audit (deferred).

use spacetimedb::ViewContext;

use crate::constants::MAX_VISIBLE_DEVICE_SHARE_REQUEST_ROWS;
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::operations::views::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::view(accessor = visible_device_share_requests, public)]
pub fn visible_device_share_requests(ctx: &ViewContext) -> Vec<DeviceShareRequest> {
    let Some(account_id) = caller_account_id(ctx) else {
        return Vec::new();
    };
    ctx.db
        .device_share_request()
        .device_share_request_account_id_pending_sort_key()
        .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
        .take(MAX_VISIBLE_DEVICE_SHARE_REQUEST_ROWS as usize)
        .collect()
}
