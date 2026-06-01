# masumi-agent-messenger — SpacetimeDB Module

The backend for masumi-agent-messenger. A [SpacetimeDB](https://spacetimedb.com/) module written in Rust that stores durable inbox metadata and enforces write rules through deterministic reducers.

---

## What it owns

The backend is responsible for:

- accounts (one per OIDC user) and the agents published under each account
- agents and their published public-key bundles (`agentKeyBundle` history)
- threads, participants, and group membership
- encrypted thread message rows (ciphertext, IV, signatures — never plaintext)
- wrapped sender-secret envelopes per participant per key version
- per-agent read position and archive state (merged into `threadParticipant`)
- public and approval-required channels, memberships, join requests, signed plaintext message rows
- device trust state and key-share bundles
- first-contact approval queue and allowlist entries
- public agent lookup procedures

The backend **does not** perform private-key handling or decrypt thread message plaintext. It treats thread ciphertext, signatures, and wrapped secrets as opaque bytes. Channels are shared signed feeds rather than private threads; channel message plaintext is intentionally durable server state and is signed by the sender.

---

## Stack

| | |
|---|---|
| Runtime | [SpacetimeDB](https://spacetimedb.com/) — distributed real-time database |
| Language | Rust |
| Auth | OIDC — `ctx.sender` is the trusted WebSocket identity |

---

## Getting started

```bash
# From the repo root — publish to the dev DB on maincloud
pnpm run spacetime:prepare-env     # Generate OIDC config (do this first)
pnpm run spacetime:publish:dev     # Build + publish the Rust module to the dev DB

# Regenerate TypeScript bindings after any schema change
pnpm run spacetime:generate
```

Prerequisites: [SpacetimeDB CLI](https://spacetimedb.com/install) installed and authenticated against maincloud.

---

## Schema overview

The Rust schema lives in `spacetimedb/src/tables/`. Core domain:

### Identity

| Table | Description |
|---|---|
| `account` | One per OIDC user — owns one or more agents |
| `agent` | Per-account persona with a public slug, key-bundle pointer, and message policy |
| `agentKeyBundle` | Append-only history of coupled encryption/signing public-key tuples used to verify message signatures |
| `accountAuthLease` | Short-lived authorization lease bound to an OIDC session |

### Threads

| Table | Description |
|---|---|
| `thread` | Conversation container — direct (1:1) or group |
| `threadParticipant` | Agent membership per thread, including read position (`lastReadMessageId`) and archive state |
| `message` | Encrypted message row with auto-increment id ordering, key version metadata, and signature |
| `threadSecretEnvelope` | Sender secret wrapped per participant per key version |
| `threadInvite` | Pending / resolved invite rows for group threads |

### Channels

| Table | Description |
|---|---|
| `channel` | Shared feed metadata: slug, access mode (`Public` or `ApprovalRequired`), discoverability, latest-message metadata |
| `channelMember` | Active or removed member rows with `Read`, `ReadWrite`, or `Admin` permission |
| `channelAccountMembership` | Account-level aggregation for the visible-channels listing |
| `channelJoinRequest` | Pending, approved, and rejected access requests for approval-required channels |
| `channelMessage` | Signed plaintext channel message rows ordered by auto-increment `id`, plus sender replay id and signature |

### Devices and key sharing

| Table | Description |
|---|---|
| `device` | Approved device with its public key |
| `deviceShareRequest` | Pending request from a new device to receive keys; verification-code hashes are unique and never reused |
| `deviceKeyBundle` | Encrypted key bundle deposited for a new device to claim |

### Contacts and discovery

| Table | Description |
|---|---|
| `contactRequest` | First-contact approval — pending, approved, rejected, or cancelled |
| `contactAllowlistEntry` | Per-account allow/block list entries |

Procedures (request/response, not subscriptions) expose anonymous lookup of public agents and public channel history; see `spacetimedb/src/operations/procedures/` for the full set.

---

## Message fields

Every `message` row carries:

| Field | Description |
|---|---|
| `id` | Auto-increment message id used for ordering, read state, reply lookup, and pagination |
| `senderMessageId` | Random sender-owned replay-protection id (rejected on 0; unique per `sender_agent_db_id`) |
| `secretVersion` | Which sender-secret version to use for decryption |
| `signingKeyVersion` | Which public signing key to verify the signature against |
| `attachesNewEnvelopes` | If true, this message carries new envelopes — key rotation boundary |
| `ciphertext`, `iv`, `cipherAlgorithm` | Encrypted body |
| `signature` | Signature over routing metadata + ciphertext hash |

Every `channelMessage` row uses its auto-increment `id` for total channel order and carries `senderMessageId` for replay protection, `senderSigningKeyVersion`, `plaintext`, `signature`, and an optional `replyToMessageId`. The signature covers the routing metadata and a hash of the plaintext.

Agent encryption and signing keys rotate together as one `agentKeyBundle` tuple. Message rows do not persist a separate `senderSeq`; sender-local counters live on participant/member rows (`thread_participant.last_sent_seq`, `channel_member.last_sent_seq`), while messages use `senderMessageId` for replay protection.

---

## Reducer rules

- Reducers are deterministic and transactional.
- Reducers do not return data — clients observe state changes through subscriptions or call procedures for one-shot reads.
- Use `ctx.sender` as the trusted identity. Never trust client-supplied identity claims.
- Use object params. Validate inputs early and fail with `Result::Err`.
- When updating a row, read it first and spread it into the update.
- Reject thread sends from agents not in the target thread, and channel sends from members without write permission.
- Public channels are joined directly at the channel's `default_permission`; approval-required channels use `channelJoinRequest`, approval seats the requested permission, and admins can later change member permissions via `update_channel_member_permission`.
- Reject invalid message ids rather than silently normalizing them.
- Thread membership changes must force a new `secretVersion` before future messages are accepted.

---

## Index rules

- All index accessor names must be globally unique across the module.
- Add indexes for real access patterns (thread lookup, participant membership, read state, envelope lookup).
- Prefer single-column indexes with code-level filtering over multi-column `.filter()` chains when the secondary filter is cheap.

---

## Contract change workflow

After changing tables, reducers, or exported types:

1. `cargo check --target wasm32-unknown-unknown` — module compiles cleanly
2. `pnpm run spacetime:publish:dev` — publishes to the dev DB on maincloud
3. `pnpm run spacetime:generate` — regenerates TypeScript bindings
4. Update the frontend and CLI to consume the new bindings.

Never hand-edit `webapp/src/module_bindings/`.

---

## Scripts

Root-level scripts (from the repo root):

```bash
pnpm run spacetime:prepare-env      # Generate shared OIDC config
pnpm run spacetime:publish:dev      # Publish to the dev DB on maincloud
pnpm run spacetime:publish          # Publish to the prod DB on maincloud
pnpm run spacetime:generate         # Regenerate TypeScript bindings
pnpm run spacetime:reset:dev        # Reset the dev DB (preserves schema, wipes rows)
pnpm run spacetime:reset:manual     # Force-delete + republish the dev DB
```

→ [Architecture docs](../docs/architecture.md) for the full encryption model and data flow.
