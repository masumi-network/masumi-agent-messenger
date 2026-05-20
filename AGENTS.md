# masumi-agent-messenger Agent Guide

`masumi-agent-messenger` is an agent-to-agent encrypted inbox built with TanStack Start and SpacetimeDB.

## Repo Shape

- Root pnpm workspace: repo root
- Frontend package: `webapp/`
- Frontend application: `webapp/src/`
- SpacetimeDB module: `spacetimedb/`
- CLI scaffold: `cli/`
- Generated client bindings: `webapp/src/module_bindings/`
- Generated route tree: `webapp/src/routeTree.gen.ts`

Read the nearest nested `AGENTS.md` before changing files in a subdirectory.

## Product Intent

Build a durable realtime inbox for software agents, not a social thread clone.

Core product goals:

- register agents with long-term public encryption and signing keys
- create direct threads between agents
- send encrypted messages with signatures
- rotate sender-owned thread secrets over time
- keep inbox state synchronized through SpacetimeDB subscriptions

## Architecture Rules

- Treat SpacetimeDB as the source of truth for durable inbox metadata.
- Treat encryption, decryption, key wrapping, unwrapping, and signing as client-only concerns.
- Never put private keys, decrypted sender secrets, or private thread plaintext on the server.
- Channels are the intentional exception to thread-style secrecy: they are signed plaintext shared feeds, not end-to-end-private threads. Do not use channel messages for confidential payloads.
- Keep naming aligned with the encrypted inbox domain: `agent`, `agentKeyBundle`, `thread`, `threadParticipant`, `threadSecretEnvelope`, `message`, and thread read-state fields.
- Preserve type safety. Never introduce `any`; use `unknown` only when a type truly cannot be modeled yet.

## Cross-Stack Workflow

When a feature touches both backend and frontend:

1. Update the SpacetimeDB schema and reducers first.
2. Regenerate bindings after contract changes.
3. Update TanStack Start UI and client crypto code to match the new bindings.
4. Verify the realtime flow end to end with two different agent sessions.

Do not patch only one side of the app when the contract clearly changed.

## SpacetimeDB Rules

- Reducers are transactional and deterministic.
- Reducers do not return data to callers.
- Trust `ctx.sender`, not client-provided identity arguments.
- Use object parameters for reducers.
- Put indexes in the first `table()` argument.
- Keep index accessors globally unique across the module.
- Use `0n` placeholders for auto-increment `u64` primary keys, except direct-thread first-message flows where the client-generated thread id is intentionally signed before the reducer runs.
- Do not hand-edit `webapp/src/module_bindings/`; regenerate them.

## Encryption Rules

- Keep a stable thread identifier. Replace `context` naming, but do not remove the concept of a stable conversation id.
- Version sender-owned thread secrets independently.
- Agent encryption and signing keys are published as one coupled `agentKeyBundle` tuple and rotate together unless the schema is intentionally changed.
- Messages use their auto-increment `message.id` for total order in a thread and carry `senderMessageId` for replay protection; sender-local send counters live on participant/member rows rather than message rows.
- If a message carries attached secret envelopes, that message is the first message for the new `secretVersion`.
- Sign routing metadata and ciphertext metadata, not just ciphertext blobs.

## Files To Treat Carefully

- `webapp/src/module_bindings/`: generated, never hand-edit
- `webapp/src/routeTree.gen.ts`: generated, never hand-edit
- `spacetimedb/dist/`: build output

## Useful Commands

```bash
pnpm run dev
pnpm run spacetime:publish:dev
pnpm run spacetime:generate
pnpm run build
```

## Read Next

- `webapp/AGENTS.md` for package-level frontend guidance
- `webapp/src/AGENTS.md` for TanStack Start and client crypto rules
- `spacetimedb/AGENTS.md` for schema, reducers, and contract rules
