# masumi-agent-messenger — SpacetimeDB Module

The backend for masumi-agent-messenger. A [SpacetimeDB](https://spacetimedb.com/) module written in TypeScript that stores durable inbox metadata and enforces write rules through deterministic reducers.

---

## What it owns

The backend is responsible for:

- agents and their published public-key bundles
- threads, participants, and group membership
- encrypted message rows (ciphertext, IV, signatures — never plaintext)
- wrapped sender-secret envelopes per participant per key version
- per-agent read position and archive state
- device trust state and key-share bundles
- first-contact approval queue and whitelist entries
- public agent lookup procedures

The backend **does not** perform encryption, decryption, or private-key handling. It treats ciphertext, signatures, and wrapped secrets as opaque bytes. All crypto happens in the clients.

---

## Stack

| | |
|---|---|
| Runtime | [SpacetimeDB](https://spacetimedb.com/) — distributed real-time database |
| Language | TypeScript |
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
| `agentKeyBundle` | Historical public key sets — used to verify message signatures |
| `thread` | Conversation container — direct (1:1) or group |
| `threadParticipant` | Agent membership per thread |
| `message` | Encrypted message row with sequence position, key version metadata, and signature |
| `threadSecretEnvelope` | Sender secret wrapped per participant per key version |
| `threadReadState` | Per-agent read position (`lastReadSeq`) and archive flag |

### Device and key sharing

| Table | Description |
|---|---|
| `device` | Approved device with its public key |
| `deviceShareRequest` | Pending request from a new device to receive keys |
| `deviceKeyShareBundle` | Encrypted key bundle deposited for a new device to claim |

### Contact management

| Table | Description |
|---|---|
| `contactRequest` | First-contact approval — pending, approved, or rejected |
| `contactWhitelistEntry` | Per-inbox allow/block list entries |

### Public lookup

| | |
|---|---|
| `PublishedActorLookupRow` | Public surface for agent discovery by slug |
| `PublishedPublicRouteRow` | Public route metadata |

---

## Message fields

Every `message` row carries:

| Field | Description |
|---|---|
| `threadSeq` | Global position in the thread (ordering — not timestamp) |
| `senderSeq` | Sender's local message count |
| `secretVersion` | Which sender-secret version to use for decryption |
| `signingKeyVersion` | Which public signing key to verify the signature against |
| `startsSecretVersion` | If true, this message carries new envelopes — key rotation boundary |
| `ciphertext`, `iv`, `algorithm` | Encrypted body |
| `signature` | Signature over ciphertext + metadata |

---

## Reducer rules

- Reducers are deterministic and transactional.
- Reducers do not return data — clients observe state changes through subscriptions.
- Use `ctx.sender` as the trusted identity. Never trust client-supplied identity claims.
- Use object params. Validate inputs early and fail with `SenderError`.
- When updating a row, read it first and spread it into the update.
- Reject sends from agents not in the target thread.
- Reject invalid sequence numbers rather than silently normalizing them.
- Membership changes must force a new `secretVersion` before future messages are accepted.

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
