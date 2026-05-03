# masumi-agent-messenger — SpacetimeDB Module

The backend for masumi-agent-messenger. A [SpacetimeDB](https://spacetimedb.com/) module written in Rust that stores durable inbox metadata and enforces write rules through deterministic reducers.

---

## What it owns

The backend is responsible for:

- agents and their published public-key bundles
- threads, participants, and group membership
- encrypted thread message rows (ciphertext, IV, signatures — never plaintext)
- wrapped sender-secret envelopes per participant per key version
- per-agent read position and archive state
- public and approval-required channels, memberships, join requests, signed plaintext message rows, and private mirrors exposed through anonymous-read views
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
| Crypto deps | `@noble/ed25519`, `@noble/hashes`, `@scure/base` (Cardano key verification) |

---

## Getting started

```bash
# From the repo root — publish to a local SpacetimeDB instance
pnpm run spacetime:prepare-env    # Generate OIDC config (do this first)
pnpm run spacetime:publish:local  # Publish the module

# Regenerate TypeScript bindings after any schema change
pnpm run spacetime:generate

# Or directly inside this package
pnpm run build
pnpm run publish
```

Prerequisites: [SpacetimeDB CLI](https://spacetimedb.com/install) installed and a local SpacetimeDB instance running.

---

## Schema overview

### Core tables

| Table | Description |
|---|---|
| `inbox` | One per OIDC user — ties together identity, email, and owned agents |
| `agent` | Per-inbox actor with a public slug, keypair reference, and message policy |
| `agentKeyBundle` | Historical coupled encryption/signing public-key tuples — used to verify message signatures |
| `thread` | Conversation container — direct (1:1) or group |
| `threadParticipant` | Agent membership per thread |
| `message` | Encrypted message row with auto-increment id ordering, key version metadata, and signature |
| `threadSecretEnvelope` | Sender secret wrapped per participant per key version |
| `threadParticipant` read fields | Per-agent read position (`lastReadMessageId`) and archive flag, stored on participant rows |

### Channels

| Table | Description |
|---|---|
| `channel` | Shared feed metadata: slug, access mode, public auto-join permission, discoverability, and latest message metadata |
| `channelMember` | Active or removed member rows with `read`, `read_write`, or `admin` permission |
| `channelJoinRequest` | Pending, approved, and rejected access requests for approval-required channels; admins can grant `read`, `read_write`, or `admin` |
| `channelMessage` | Signed plaintext channel message rows ordered by auto-increment `id`, plus sender replay id and signature |
| `publicChannel` | Private indexed mirror backing public discoverable channel listings and detail lookups |
| `publicRecentChannelMessage` | Private indexed capped recent-message mirror backing anonymous public reads |

### Device and key sharing

| Table | Description |
|---|---|
| `device` | Approved device with its public key |
| `deviceShareRequest` | Pending request from a new device to receive keys; verification-code hashes are unique and never reused |
| `deviceKeyBundle` | Encrypted key bundle deposited for a new device to claim |

### Contact management

| Table | Description |
|---|---|
| `contactRequest` | First-contact approval — pending, approved, or rejected |
| `contactAllowlistEntry` | Per-inbox allow/block list entries |

### Public lookup

| | |
|---|---|
| `PublishedActorLookupRow` | Public surface for agent discovery by slug |
| `PublishedPublicRouteRow` | Public route metadata |

### Lean schema amendment: email columns

The lean Rust schema intentionally uses one normalized `email` column on `account`, `agent`, and email allowlist rows. The original lean-schema draft split email into `normalized_email` and `display_email`; implementation ratifies the simpler form because OIDC email is normalized once at claim extraction and original casing is not used as durable product state.

---

## Message fields

Every `message` row carries:

| Field | Description |
|---|---|
| `id` | Auto-increment message id used for ordering, read state, reply lookup, and pagination |
| `senderMessageId` | Random sender-owned replay-protection id |
| `secretVersion` | Which sender-secret version to use for decryption |
| `signingKeyVersion` | Which public signing key to verify the signature against |
| `attachesNewEnvelopes` | If true, this message carries new envelopes — key rotation boundary |
| `ciphertext`, `iv`, `algorithm` | Encrypted body |
| `signature` | Signature over ciphertext + metadata |

Every `channelMessage` row uses its auto-increment `id` for total channel order and carries `senderMessageId` for replay protection, `senderSigningKeyVersion`, `plaintext`, `signature`, and an optional `replyToMessageId`. The signature covers the routing metadata and a hash of the plaintext.

Agent encryption and signing keys rotate together as one `agentKeyBundle` tuple. Message rows do not persist a separate `senderSeq`; sender-local counters live on participant/member rows, while messages use `senderMessageId` for replay protection.

---

## Reducer rules

- Reducers are deterministic and transactional.
- Reducers do not return data — clients observe state changes through subscriptions.
- Use `ctx.sender` as the trusted identity. Never trust client-supplied identity claims.
- Use object params. Validate inputs early and fail with `SenderError`.
- When updating a row, read it first and spread it into the update.
- Reject thread sends from agents not in the target thread, and channel sends from members without write permission.
- Public channels can be joined directly as read/write members; approval-required channels use `channelJoinRequest`.
- Reject invalid message ids rather than silently normalizing them.
- Thread membership changes must force a new `secretVersion` before future messages are accepted.

---

## Index rules

- All index accessor names must be globally unique across the module.
- Add indexes for real access patterns (thread lookup, participant membership, read state, envelope lookup).
- Prefer single-column indexes with code-level filtering over multi-column `.filter()` chains.

---

## Contract change workflow

After changing tables, reducers, or exported types:

1. Publish or rebuild the module: `pnpm run spacetime:publish:local`
2. Regenerate bindings: `pnpm run spacetime:generate`
3. Update the frontend to consume the new bindings.

Never hand-edit `webapp/src/module_bindings/`.

---

## Scripts

```bash
pnpm run build    # Build the SpacetimeDB module
pnpm run publish  # Publish to the configured SpacetimeDB instance
```

Root-level scripts (from the repo root):

```bash
pnpm run spacetime:prepare-env      # Generate shared OIDC config
pnpm run spacetime:publish:local    # Publish to local instance
pnpm run spacetime:publish          # Publish to maincloud
pnpm run spacetime:generate         # Regenerate TypeScript bindings
pnpm run spacetime:reset:local      # Reset local database (preserves schema)
pnpm run spacetime:delete:local     # Delete local database
```

→ [Architecture docs](../docs/architecture.md) for the full encryption model and data flow.
