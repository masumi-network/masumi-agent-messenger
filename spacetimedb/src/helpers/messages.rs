//! Shared message insertion path for normal sends and first-contact sends.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    MessageCipherAlgorithm, AES_GCM_IV_BYTES, MAX_MESSAGE_CIPHERTEXT_BYTES, SIGNATURE_BYTES,
};
use crate::helpers::retention::schedule_next_message_expiry;
use crate::helpers::validate::{ensure_byte_len, ensure_exact_byte_len};
use crate::tables::*;

pub struct InsertThreadMessageParams<'a> {
    pub thread: &'a Thread,
    pub sender: &'a Agent,
    pub secret_version: u32,
    pub signing_key_version: u32,
    pub sender_message_id: u64,
    pub ciphertext: &'a [u8],
    pub iv: &'a [u8],
    pub cipher_algorithm: MessageCipherAlgorithm,
    pub signature: &'a [u8],
    pub reply_to_message_id: Option<u64>,
    pub attaches_new_envelopes: bool,
}

pub fn insert_thread_message(
    ctx: &ReducerContext,
    params: InsertThreadMessageParams<'_>,
) -> Result<Message, String> {
    if params.secret_version == 0 {
        return Err("secretVersion must be > 0".to_string());
    }
    if params.signing_key_version == 0 {
        return Err("signingKeyVersion must be > 0".to_string());
    }
    if params.sender_message_id == 0 {
        return Err("senderMessageId must be > 0".to_string());
    }
    if params.signing_key_version != params.sender.current_key_bundle_version {
        return Err(
            "signingKeyVersion must match the sender's current signing key version".to_string(),
        );
    }

    let dup = ctx
        .db
        .message()
        .message_sender_agent_db_id_sender_message_id()
        .filter((params.sender.id, params.sender_message_id))
        .next()
        .is_some();
    if dup {
        return Err("senderMessageId has already been used by this sender".to_string());
    }

    if let Some(reply_id) = params.reply_to_message_id {
        let replied = ctx
            .db
            .message()
            .id()
            .find(&reply_id)
            .ok_or_else(|| "replyToMessageId not found".to_string())?;
        if replied.thread_id != params.thread.id {
            return Err("replyToMessageId is not in this thread".to_string());
        }
    }

    ensure_byte_len(
        params.ciphertext,
        MAX_MESSAGE_CIPHERTEXT_BYTES,
        "ciphertext",
    )?;
    ensure_exact_byte_len(params.iv, AES_GCM_IV_BYTES, "iv")?;
    ensure_exact_byte_len(params.signature, SIGNATURE_BYTES, "signature")?;
    let inserted = ctx.db.message().insert(Message {
        id: 0,
        thread_id: params.thread.id,
        id_desc_sort_key: u64::MAX,
        sender_agent_db_id: params.sender.id,
        sender_message_id: params.sender_message_id,
        secret_version: params.secret_version,
        attaches_new_envelopes: params.attaches_new_envelopes,
        membership_version: params.thread.membership_version,
        signing_key_version: params.signing_key_version,
        ciphertext: params.ciphertext.to_vec(),
        iv: params.iv.to_vec(),
        signature: params.signature.to_vec(),
        cipher_algorithm: params.cipher_algorithm,
        reply_to_message_id: params.reply_to_message_id,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    let message = ctx.db.message().id().update(Message {
        id_desc_sort_key: u64::MAX.saturating_sub(inserted.id),
        ..inserted
    });

    ctx.db.thread().id().update(Thread {
        last_message_id: message.id,
        message_count: params.thread.message_count.saturating_add(1),
        last_message_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        ..params.thread.clone()
    });
    schedule_next_message_expiry(ctx, params.thread.id);

    Ok(message)
}
