# masumi-agent-messenger Backend Guide

This directory contains the SpacetimeDB module for the encrypted agent inbox.

## Backend Responsibilities

The backend owns durable metadata and authorization checks for:

- agents and their published public-key bundles
- threads and participants
- wrapped sender-secret envelopes
- encrypted private-thread message metadata
- channel membership, join requests, signed plaintext channel rows, and private public-read channel mirrors
- per-agent read and archive state

The backend must not perform encryption, decryption, or private-key handling.

## Hard Crypto Boundary

- Never store private keys on the server.
- Never derive thread secrets inside reducers.
- Never decrypt message ciphertext inside reducers.
- Treat thread ciphertext, signatures, wrapped secrets, and public keys as opaque client-produced strings.
- Channel messages are signed plaintext server state; reducers validate structure, membership, ordering, and key versions but do not encrypt or decrypt them.
- Reducers should validate structure, ownership, membership, ordering, and version constraints only.

## Peer Key Trust Is a Client Responsibility

- The backend does NOT vouch for agent key rotations. `rotateAgentKeys` is callable by any OIDC-authenticated device bound to the inbox; a stolen OIDC session can publish attacker keys under an existing agent slug.
- Do not add server-side "trust" bits to the schema — the trust decision lives with the peer's client.
- When the CLI / webapp observes a peer's `currentEncryptionKeyVersion` or `currentSigningKeyVersion` changing, the client must pin-and-confirm before accepting the new tuple. Server reducers must keep making the rotation visible (via existing `agent` and `agentKeyBundle` rows) so clients can detect it.

## Preferred Schema

Unless the task explicitly changes the model, prefer:

- `agent`
- `agentKeyBundle`
- `thread`
- `threadParticipant`
- `threadSecretEnvelope`
- `message`
- `threadReadState`

Avoid reintroducing `context` terminology in new backend code.

## Ordering And Rotation Rules

- Every thread needs a stable `threadId`.
- Every thread message needs `threadSeq`, `senderSeq`, `secretVersion`, and `signingKeyVersion`.
- Every channel message needs `channelSeq`, `senderSeq`, `senderSigningKeyVersion`, `plaintext`, and `signature`.
- Every secret envelope needs `secretVersion`, `senderEncryptionKeyVersion`, and `recipientEncryptionKeyVersion`.
- A message may optionally attach a fresh envelope set; if it does, that message is the rotation boundary for the new `secretVersion`.
- Later messages must not reuse a rotated `secretVersion` until the matching envelope set exists for all active participants.
- Membership changes should force a new sender-secret version before future messages are accepted.

## Reducer Rules

- Reducers must be deterministic.
- Reducers do not return data.
- Use object params only.
- Validate inputs early and fail clearly with `SenderError`.
- Use `ctx.sender` as the trusted owner identity.
- When updating rows, read the current row and spread it into the update.
- Reject sends from agents that do not belong to the target thread.
- Reject reply targets that do not belong to the same thread.
- Reject invalid sequence numbers instead of silently normalizing them.

## Index Rules

- Add indexes for real access patterns such as:
  - agent lookup by `agentId`
  - participants by `threadId`
  - read state by `agentId`
  - envelopes by `threadId`, `recipientAgentId`, and `senderAgentId`
  - messages by `threadId`
- Keep all index accessors globally unique.
- Do not rely on multi-column `.filter()` access patterns; prefer single-column indexes plus code-level filtering.

## Contract Change Workflow

After changing exported tables, reducers, or row shapes:

1. publish or rebuild the module as needed
2. run `pnpm run spacetime:generate`
3. update the frontend to consume the new generated bindings

Never hand-edit generated bindings to compensate for stale backend contracts.
# SpacetimeDB Agent Guide

This directory contains the backend module for the inbox application.

## Backend Purpose

Use SpacetimeDB to model durable, real-time inbox data for agent-to-agent messaging.

The backend should own:

- inbox data model
- reducers for writes and workflow transitions
- optional views for filtered per-agent reads
- connection lifecycle behavior when needed

## Current State

The module still contains starter-template `person` demo code in `src/index.ts`.

When implementing inbox features, prefer replacing demo concepts with real inbox entities instead of layering hacks on top of `person`, `add`, and `sayHello`.

## Schema Guidance

- Keep table names domain-specific and explicit.
- Prefer a small core model first: `agent`, `thread`, `thread_participant`, `message`, and optionally `message_receipt`.
- Add indexes for the actual access patterns you need, especially thread and participant lookups.
- Index names must be globally unique across the whole module.
- Use `u64` ids with `0n` placeholders for auto-increment rows.
- Keep timestamps on entities that need ordering or unread tracking.

## Reducer Guidance

- Reducers must be deterministic.
- Reducers do not return data; clients should observe resulting table updates.
- Use object params and exported reducer names.
- Validate inputs early and fail clearly.
- When updating rows, read the existing row and spread it into the update instead of partial overwrites.
- Prefer reducers that express inbox workflows clearly, such as send message, mark read, archive thread, or rename agent.

## Views And Visibility

- Use views when per-agent filtered reads are needed.
- Prefer index-backed lookups in views.
- Avoid `.iter()` in views unless there is no better option and scale is known to be tiny.
- Be deliberate about `public: true`; it exposes rows to all clients.

## File Organization

- Keep `src/index.ts` small when the module grows.
- Split schema and reducer logic into multiple files when complexity warrants it.
- If you split files, keep exports clear and avoid circular imports.

## Binding Regeneration

After changing tables, reducers, or exported types:

1. publish or rebuild the module as needed
2. run `pnpm run spacetime:generate`
3. update the frontend to consume the new generated bindings

Never hand-edit generated bindings to compensate for stale backend contracts.

## Backend Checklist

Before considering a backend task done:

1. The schema matches the inbox feature.
2. Required indexes exist and use stable names.
3. Reducers cover the write path.
4. Client subscription shape is clear.
5. Frontend bindings have been regenerated if necessary.

## Useful Commands

```bash
pnpm run spacetime:publish:local
pnpm run spacetime:publish
pnpm run spacetime:generate
```
