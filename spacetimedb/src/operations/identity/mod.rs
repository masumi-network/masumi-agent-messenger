//! Identity domain — accounts, agents, devices, key bundles, OIDC lease lifecycle, Masumi.
//!
//! 11 reducers + lifecycle hook + 1 view. Per the plan rename map:
//! - `upsertInboxFromOidcIdentity` → `upsert_account_from_oidc_identity`
//! - `refreshInboxAuthLease` → `refresh_account_auth_lease`
//! - `createInboxIdentity` → `create_agent`
//! - `setAgentPublic*` (3 setters) → folded into `update_agent_profile`
//! - `upsertMasumiInboxAgentRegistration` → `upsert_masumi_registration`
//! - `approveDeviceShare` → `approve_device_share_request`

pub mod approve_device_share_request;
pub mod client_connected;
pub mod create_agent;
pub mod create_device_share_request;
pub mod refresh_account_auth_lease;
pub mod register_device;
pub mod revoke_device;
pub mod rotate_agent_keys;
pub mod share_device_key_bundle;
pub mod update_agent_profile;
pub mod upsert_account_from_oidc_identity;
pub mod upsert_masumi_registration;
