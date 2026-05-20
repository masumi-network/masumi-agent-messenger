# masumi-agent-messenger Backend Guide (Rust)

This directory contains the SpacetimeDB module for the encrypted agent inbox. The module is **written in Rust** (replaced the prior TypeScript implementation per the rework plan); webapp and CLI remain TypeScript and consume regenerated bindings via `spacetime generate --lang typescript`.

## Backend Responsibilities

The backend owns durable metadata and authorization checks for:

- accounts (OIDC users) and the agents they publish under those accounts
- agent key bundles (append-only coupled encryption/signing public-key tuples)
- threads, participants (with merged read-state), and `thread_invite` rows
- wrapped sender-secret envelopes (`thread_secret_envelope`)
- encrypted private-thread message metadata (`message`)
- channel membership (with merged read-state), join requests, and signed-plaintext channel rows
- contact requests + allowlist entries
- per-account auth lease (drives auth-gated views)
- a unified `scheduled_expiry` table dispatching device-bundle / lease / rate-limit cleanup

The backend must not perform encryption, decryption, or private-key handling.

## Hard Crypto Boundary

- Never store private keys on the server.
- Never derive thread secrets inside reducers.
- Never decrypt message ciphertext inside reducers.
- Treat thread ciphertext, signatures, wrapped secrets, and public keys as opaque client-produced strings.
- Channel messages are signed plaintext server state; reducers validate structure, membership, ordering, and key versions but do not encrypt or decrypt them.
- Reducers should validate structure, ownership, membership, ordering, and version constraints only.

## Sender-Local Sequence Lives On Membership Rows, Not Messages

`message` and `channel_message` rows do NOT carry a `sender_seq` column. The per-sender monotonic counter lives on `thread_participant.last_sent_seq` and `channel_member.last_sent_seq`; the send reducer increments it as part of the same transaction that inserts the message and uses it to enforce the rules at insert time (e.g. `last_sent_seq == 0 && !attaches_new_envelopes` is the first-message-must-rotate gate in `send_encrypted_message.rs`). The signed payload built by `buildMessageSignaturePayload` in `shared/agent-crypto.ts` binds `senderMessageId` (a random per-sender id used for replay protection) plus `threadId`, `secretVersion`, and the ciphertext hash — it does NOT bind the sender seq. The static contract test at `webapp/tests/security/static/generated-contracts.test.ts` ("keeps sender-local counters off message rows and on membership rows") locks this in. Don't add `sender_seq` to either table without explicitly relitigating that rule.

## Peer Key Trust Is a Client Responsibility

- The backend does NOT vouch for agent key rotations. `rotate_agent_keys` is callable by any OIDC-authenticated device bound to the account; a stolen OIDC session can publish attacker keys under an existing agent slug.
- Do not add server-side "trust" bits to the schema — the trust decision lives with the peer's client.
- Agent encryption and signing keys intentionally rotate together as one `agent_key_bundle` tuple. When the CLI / webapp observes a peer key rotation, inbound signatures still verify against `agent_key_bundle` history and the receiver auto-confirms the observed tuple locally; sender-owned imported key material is gated separately before sending. Server reducers must keep making the rotation visible (via `agent` and `agent_key_bundle` rows) so clients can detect it.
- Device source attribution is account-trusted after OIDC succeeds. Device-share reducers infer the displayed source from an approved device public-key tuple, but they intentionally do not require per-device proof/signature material.
- Channels are the documented exception — see `CLAUDE.md` "Channel exception: trust is enforced device-side."

## Schema (28 tables)

Domains:
- **Identity** (6): `account`, `account_auth_lease`, `account_change_signal`, `device`, `device_share_request`, `device_key_bundle`
- **Agent** (2): `agent`, `agent_key_bundle`
- **Thread** (6): `thread`, `thread_participant`, `message`, `thread_secret_envelope`, `thread_secret_coverage`, `thread_invite`
- **Channel** (10): `channel`, `channel_member`, `channel_message`, `channel_account_membership`, `channel_recency_fanout`, `channel_join_request`, `channel_join_request_admin_visibility`, `channel_join_request_admin_visibility_fanout`, `channel_join_request_resolved_admin_visibility`, `channel_join_request_resolved_admin_visibility_fanout`
- **Contact** (2): `contact_request`, `contact_allowlist_entry`
- **System** (2): `rate_limit`, `scheduled_expiry`

No `public: true` tables; client reads go through auth-gated `#[view(public)]` functions or request/response procedures.

## Conventions

- Every row carries `created_at` and `updated_at: Timestamp`. Append-only rows set `updated_at == created_at` at insert.
- `thread_participant.updated_at` doubles as the inbox recency key. Read/archive-only mutations preserve it so old threads do not jump to the top.
- Identity-side FKs use `account_id` (renamed from `inbox_id` in the rework). Agent-side FKs use `agent_db_id`.
- No synthetic compound-uniqueness columns (`unique_key`, `*_seq_key`). Reducers enforce uniqueness via indexed lookup pre-insert.
- No legacy default sentinels (`sender_message_id=1`, `sort_key='pending'`, `LEGACY` keys). Fresh DB.
- String columns that were really enums (status, mode, kind, permission, algorithm) are native Rust enums in `crate::constants`.
- String columns that were really monotonic counters (`*_key_version`, `secret_version`) are `u32`.

## Rust Idioms

- Tables: `#[spacetimedb::table(accessor = <ident>, index(accessor = ..., btree(columns = [...])))]`
- Field attributes: `#[primary_key]`, `#[auto_inc]`, `#[unique]`, `#[index(btree)]`
- Native types: `String`, `Option<T>`, `Vec<T>`, `u32`/`u64`/`i64`, `bool`, `Timestamp`, `Identity`
- Enums: `#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)] pub enum Foo { ... }`
- Reducers: `#[spacetimedb::reducer] fn foo(ctx: &ReducerContext, arg: T) -> Result<(), String>`
- Lifecycle: `#[spacetimedb::reducer(client_connected)] fn ...`
- Views: `#[view(accessor = visible_x, public)] fn visible_x(ctx: &ViewContext) -> Vec<X>`
- 0u64 placeholder for auto-inc PK (was `0n` in TS), except direct-thread first-message flows whose client-generated id is already bound into the signed payload.

## Module Layout (one file per item)

```
src/
├── lib.rs               # entry; declares modules + crate-level allow lints
├── constants.rs         # 16 enums + length/lifetime/rate-limit/page-size constants
├── tables/
│   ├── mod.rs           # `mod <name>_def;` + `pub use <name>_def::*;` for all 28 tables
│   └── <table>_def.rs   # one per table; `_def` suffix avoids module/trait name collision
├── helpers/
│   ├── mod.rs
│   ├── time.rs
│   ├── slug.rs
│   ├── validate.rs
│   ├── oidc.rs
│   ├── auth_lease.rs
│   ├── scheduling.rs
│   ├── rate_limit.rs
│   ├── thread_fanout.rs
│   ├── threads.rs
│   ├── channels.rs
│   ├── contacts.rs
│   ├── envelopes.rs
│   ├── accounts.rs
│   ├── agents.rs
│   └── devices.rs
└── operations/
    ├── identity/        # 10 reducers + client_connected lifecycle
    ├── threads/         # 10 reducers (5 fan-out, 2 caller-only, 3 other)
    ├── channels/        # 9 reducers (no fan-out)
    ├── contacts/        # 4 reducers
    ├── system/          # expire_scheduled dispatcher
    ├── views/           # 15 views + auth.rs gate helper
    └── procedures/      # request/response reads, enabled via Rust SDK `unstable`
```

## Reducer Rules

- Reducers must be deterministic.
- Reducers don't return data — return `Result<(), String>`. Errors propagate to the client as the `String` message.
- Use `ctx.sender()` as the trusted owner identity (Rust SDK exposes it via the method, not a public field).
- When updating rows, fetch the current row and use struct-update syntax: `Row { changed_field: ..., ..existing }`.
- Reject sends from agents that do not belong to the target thread.
- Reject reply targets that do not belong to the same thread.
- Reject invalid sequence numbers instead of silently normalizing them.
- Validate inputs early via `helpers::validate::*`.
- Caller authentication: every client-callable reducer should `let claims = require_oidc_claims(ctx)?; upsert_lease_for_account(ctx, &account, &claims)?;` before any business logic so the auth lease stays warm.

## Fan-out Contract (threads, NOT channels)

Some thread-activity reducers fan out by bumping `updated_at` on all active participant rows so the thread surfaces in everyone's recency list (driven by the `(account_id, updated_at)` index on `thread_participant`). Caller-only read/archive updates preserve `updated_at`:

- Fan-out: `send_encrypted_message`, `add_thread_participant`, `remove_thread_participant`, `set_thread_participant_admin`, `accept_thread_invite`
- Caller-only (NO fan-out): `update_thread_read_state`, `decline_thread_invite`

`MAX_THREAD_FANOUT = 50` caps the participant count, so the worst-case write count per send is bounded.

**Channels fan out only recency keys.** Channel sends update each active member's
`active_recency_sort_key` so caller channel lists can page from
`(account_id, active_recency_sort_key)` instead of scanning all memberships. Keep the write cost
visible when changing channel fanout behavior.

## Index Rules

- Prefer single-column or 2-column max btree indexes. The original schema's 4-/5-column compound indexes have been dropped.
- Keep all index accessors globally unique across the module.
- Do not rely on multi-column `.filter()` access patterns; prefer single-column indexes plus code-level filtering.
- Hot-path 2-col indexes that pay for themselves: `(thread_id, agent_db_id)` on `thread_participant`, `(account_id, updated_at)` on `thread_participant`, `(channel_id, agent_db_id)` on `channel_member`, `(channel_id, id)` on `channel_member`.

## Views And Visibility

- Use `#[view(accessor = ..., public)]` on a function taking `&ViewContext` (auth-aware) or `&AnonymousViewContext` (no caller).
- Caller auth in views: `caller_account_id(ctx)` (in `operations::views::auth`) returns `None` when the lease is missing or inactive — short-circuit by returning `Vec::new()`.
- Bound output. Live-subscribable views must cap (top-25 most recent threads, top-25 messages per thread). Older history goes through procedures.
- Avoid full `.iter()` in views unless the table is known to be small.
- Use procedures for paged/history reads or anonymous lookup flows that should not be live subscriptions. Keep public procedures bounded and rate-limited where possible.

## Module-Level Trait Imports

Each `tables/<name>_def.rs` defines a struct (e.g. `AccountAuthLease`) and the macro generates an accessor trait (e.g. `account_auth_lease`) plus a read-only counterpart (`account_auth_lease__view`) for `LocalReadOnly`. The `_def` suffix on the file/module name avoids the module name colliding with the trait name in the parent `mod.rs`. Star-export from each `_def` brings the struct + traits into `crate::tables::*`.

When writing a reducer, view, or helper that touches tables, import via `use crate::tables::*;` so the accessor traits resolve.

## Build / Publish

- Build is `cargo build --target wasm32-unknown-unknown --release` (driven by `spacetime publish`).
- `pnpm run spacetime:publish:dev` drives the Rust build/publish flow against the dev DB.
- `pnpm run spacetime:generate` regenerates TS bindings against the published Rust schema.

## Contract Change Workflow

After changing exported tables, reducers, or row shapes:

1. `cargo check --target wasm32-unknown-unknown` — module compiles cleanly
2. `pnpm run spacetime:publish:dev` — module publishes
3. `pnpm run spacetime:generate` — TS bindings regen
4. update the frontend / CLI to consume the new generated bindings

Never hand-edit generated bindings to compensate for stale backend contracts.

## Useful Commands

```bash
cargo check --target wasm32-unknown-unknown
pnpm run spacetime:publish:dev
pnpm run spacetime:generate
```
