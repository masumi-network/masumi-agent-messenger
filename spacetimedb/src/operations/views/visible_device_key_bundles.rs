use spacetimedb::ViewContext;

use crate::constants::MAX_VISIBLE_DEVICE_KEY_BUNDLE_ROWS;
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::operations::views::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::view(accessor = visible_device_key_bundles, public)]
pub fn visible_device_key_bundles(ctx: &ViewContext) -> Vec<DeviceKeyBundle> {
    let Some(account_id) = caller_account_id(ctx) else {
        return Vec::new();
    };
    ctx.db
        .device_key_bundle()
        .device_key_bundle_account_id_pending_sort_key()
        .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
        .take(MAX_VISIBLE_DEVICE_KEY_BUNDLE_ROWS as usize)
        .collect()
}
