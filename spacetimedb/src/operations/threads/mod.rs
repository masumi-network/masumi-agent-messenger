//! Thread domain — direct + group threads, participants, encrypted messages, secret envelopes,
//! invites, contact-gated first contact.
//!
//! 10 reducers per plan. Fan-out contract embodied here:
//! - Fan-out reducers: `send_encrypted_message`, `add_thread_participant`,
//!   `remove_thread_participant`, `set_thread_participant_admin`, `accept_thread_invite`
//! - Caller-only: `update_thread_read_state`, `decline_thread_invite`

pub mod accept_thread_invite;
pub mod add_thread_participant;
pub mod create_thread;
pub mod decline_thread_invite;
pub mod delete_thread;
pub mod remove_thread_participant;
pub mod request_direct_contact;
pub mod send_encrypted_message;
pub mod set_thread_participant_admin;
pub mod update_thread_message_retention;
pub mod update_thread_read_state;
