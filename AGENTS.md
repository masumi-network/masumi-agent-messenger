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
- Keep naming aligned with the encrypted inbox domain: `agent`, `agentKeyBundle`, `thread`, `threadParticipant`, `threadSecretEnvelope`, `message`, and `threadReadState`.
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
- Use `0n` placeholders for auto-increment `u64` primary keys.
- Do not hand-edit `webapp/src/module_bindings/`; regenerate them.

## Encryption Rules

- Keep a stable thread identifier. Replace `context` naming, but do not remove the concept of a stable conversation id.
- Version three independent key domains:
  - agent encryption keys
  - agent signing keys
  - sender-owned thread secrets
- Messages need explicit ordering metadata:
  - `threadSeq` for total order in a thread
  - `senderSeq` for monotonic sender-local order
- If a message carries attached secret envelopes, that message is the first message for the new `secretVersion`.
- Sign routing metadata and ciphertext metadata, not just ciphertext blobs.

## Files To Treat Carefully

- `webapp/src/module_bindings/`: generated, never hand-edit
- `webapp/src/routeTree.gen.ts`: generated, never hand-edit
- `spacetimedb/dist/`: build output

## Read Next

- `webapp/AGENTS.md` for package-level frontend guidance
- `webapp/src/AGENTS.md` for TanStack Start and client crypto rules
- `spacetimedb/AGENTS.md` for schema, reducers, and contract rules
# masumi-agent-messenger Agent Guide

This repository is for an agent-to-agent messaging and inbox application.

- Frontend: TanStack Start in `webapp/src/`
- Backend: SpacetimeDB module in `spacetimedb/`
- CLI scaffold: `cli/`
- Generated client bindings: `webapp/src/module_bindings/`
- Current codebase state: still close to the starter template and should be evolved toward inbox-specific tables, reducers, and UI

Read the nearest nested `AGENTS.md` before making changes in a subdirectory.

## Product Intent

Build a real-time inbox where software agents can:

- register or appear as participants
- send messages to other agents or shared threads
- view inbox state, unread state, and conversation history
- rely on SpacetimeDB subscriptions for live updates instead of polling

Prefer features that support durable messaging flows over demo-only interactions.

## Repo Workflow

When implementing a feature that touches both backend and frontend:

1. Add or update the SpacetimeDB schema first.
2. Add reducers or views needed to mutate or expose the data.
3. Publish or regenerate bindings when schema or reducer signatures change.
4. Update TanStack Start UI and data subscriptions to use the generated bindings.
5. Verify the end-to-end flow instead of changing only one half.

Common mistake: editing the UI without adding the matching reducer or editing the backend without wiring the frontend to subscribe and invoke it.

## Architecture Priorities

- Treat SpacetimeDB as the source of truth for inbox state.
- Prefer subscription-driven UI over manual refetch loops.
- Keep the frontend thin: render subscribed state and call reducers.
- Keep naming consistent across schema, generated bindings, and UI labels.
- Use explicit table and index names that match inbox concepts such as `agent`, `thread`, `message`, `message_receipt`, or `inbox_entry`.
- Preserve type safety. Never introduce `any`; use `unknown` when you truly cannot model a type yet.

## SpacetimeDB Rules

- Reducers are transactional and do not return data to callers.
- Reducers must be deterministic. Do not use timers, randomness, filesystem access, or network access in reducers.
- Read data via subscribed tables or views, not reducer return values.
- Trust `ctx.sender` for identity, not client-provided identity fields.
- Use `0n` placeholders for auto-increment `u64` primary keys.
- Use object arguments when calling reducers from the client.
- Put indexes in the first `table()` argument, not in the column object.
- Keep index names globally unique across the module.
- Use exact index names when querying from `ctx.db`.
- Do not edit generated files in `webapp/src/module_bindings/`; regenerate them instead.

## Project Conventions

- Keep changes small and focused.
- Do not replace working real-time flows with mock data unless explicitly asked.
- Avoid broad refactors while the app is still moving from starter-template code to inbox-domain code.
- If you rename the database, keep `spacetime.json`, publish scripts, and client connection defaults aligned.
- Document non-obvious architectural choices in `README.md` when they affect future agent work.

## Suggested Domain Model

Unless the prompt asks for a different shape, prefer modeling the inbox with a few composable entities:

- `agent`: identity, display name, status, metadata
- `thread` or `conversation`: shared container for messages
- `thread_participant`: which agents belong to which thread
- `message`: author, thread id, body, created timestamp, optional kind
- `message_receipt` or `inbox_entry`: delivery, read state, archived state, or per-agent inbox status

Start simple. Only add receipts, drafts, or presence tables when the feature requires them.

## Useful Commands

```bash
pnpm run dev
pnpm run spacetime:publish:local
pnpm run spacetime:generate
pnpm run build
```

## Files To Treat Carefully

- `webapp/src/module_bindings/`: generated output, never hand-edit
- `webapp/src/routeTree.gen.ts`: generated route tree, never hand-edit
- `spacetimedb/dist/`: build output

## Where To Read Next

- `webapp/AGENTS.md` for package-level frontend guidance
- `webapp/src/AGENTS.md` for TanStack Start and client-side conventions
- `spacetimedb/AGENTS.md` for schema, reducers, subscriptions, and publish flow
