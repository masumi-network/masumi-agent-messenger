# masumi-agent-messenger Claude Guide

This repository is an encrypted agent-to-agent inbox built with TanStack Start and SpacetimeDB.

## Defaults

- Treat SpacetimeDB as the source of truth for durable inbox metadata.
- Treat encryption, decryption, signing, and key wrapping as client-only concerns.
- Never send private keys, decrypted sender secrets, or plaintext messages to the server.
- Prefer domain names such as `agent`, `agentKeyBundle`, `thread`, `threadParticipant`, `threadSecretEnvelope`, `message`, and `threadReadState`.
- Avoid new `context` terminology.

## Workflow

When backend and frontend both change:

1. update schema and reducers first
2. regenerate bindings
3. update the frontend and client crypto
4. verify the realtime flow across two agents

## SpacetimeDB Rules

- Reducers are deterministic and do not return data.
- Use `ctx.sender` as the trusted identity source.
- Use object params and `0n` placeholders for auto-increment ids.
- Keep index accessors globally unique.
- Never hand-edit generated bindings.

## Encryption Rules

- Keep a stable thread id.
- Use explicit key-version fields and `secretVersion`.
- Order messages by `threadSeq`, not timestamps.
- Treat attached secret envelopes on a message as the rotation boundary for a new sender secret.

## Peer Key Trust Rules

- The server is NOT a trust anchor for peer agent keys. Any OIDC-authenticated device can call `rotateAgentKeys`, which changes `currentEncryptionPublicKey` / `currentSigningPublicKey` for that agent. A compromised OIDC session can therefore publish attacker-controlled keys under a legitimate agent slug.
- Clients MUST pin each peer's known `(encryptionKeyVersion, signingKeyVersion, encryptionPublicKey, signingPublicKey)` tuple locally on first observation.
- On detecting a new version for a pinned peer, clients MUST keep outbound sends blocked until the user explicitly confirms the new tuple out-of-band and that confirmation is persisted to the local trust store.
- Inbound messages from rotated keys can be shown with a timeline/CLI notice, but they remain untrusted unless the message signature validates against a signing key already present in the local trust store history.
- Never auto-promote a rotated peer tuple just because SpacetimeDB currently publishes it. That would turn the server into a trust anchor and let a compromised peer OIDC session redirect future encrypted messages to attacker-controlled keys.
# masumi-agent-messenger Claude Guide

This repository is an agent-to-agent messaging and inbox application.

## Project Shape

- Frontend: TanStack Start in `webapp/src/`
- Backend: SpacetimeDB module in `spacetimedb/`
- CLI scaffold: `cli/`
- Generated bindings: `webapp/src/module_bindings/`
- Current state: the codebase is still close to the starter template and should be evolved toward inbox-specific data and UI

Read the nearest `AGENTS.md` before changing files in a subdirectory.

## Product Intent

Build a durable real-time inbox where agents can:

- appear as participants or identities
- send messages to other agents or shared threads
- view conversation history and unread state
- stay synchronized through SpacetimeDB subscriptions instead of polling

Prefer real inbox workflows over demo-only examples.

## Cross-Stack Workflow

When a feature spans backend and frontend:

1. Update the SpacetimeDB schema first.
2. Add reducers or views for the required write and read paths.
3. Publish locally or regenerate bindings when contracts change.
4. Update the TanStack Start UI to subscribe to the new data and call reducers.
5. Verify the end-to-end real-time flow.

Do not change only the UI or only the backend when the feature clearly requires both.

## Architecture Rules

- Treat SpacetimeDB as the source of truth for inbox state.
- Prefer subscription-driven UI over manual refetch loops.
- Keep the frontend thin and let subscribed data drive rendering.
- Preserve type safety. Never introduce `any`; use `unknown` if a type is not yet known.
- Do not edit generated files in `webapp/src/module_bindings/` or `webapp/src/routeTree.gen.ts`.

## SpacetimeDB Rules

- Reducers are transactional and do not return data.
- Reducers must be deterministic.
- Use `ctx.sender` as the trusted identity.
- Use object arguments for reducer calls.
- Put indexes in the first `table()` argument.
- Keep index names globally unique across the module.
- Use `0n` placeholders for auto-increment `u64` ids.
- Regenerate bindings after changing tables, reducers, or exported backend types.

## Preferred Inbox Model

Unless the task asks for a different design, prefer a small core domain:

- `agent`
- `thread` or `conversation`
- `thread_participant`
- `message`
- `message_receipt` or `inbox_entry`

Start simple and only add more entities when the feature needs them.

## Useful Commands

```bash
pnpm run dev
pnpm run spacetime:publish:local
pnpm run spacetime:generate
pnpm run build
```
