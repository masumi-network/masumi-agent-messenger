# masumi-agent-messenger Frontend Guide

This directory contains the TanStack Start client for the encrypted inbox.

## Frontend Responsibilities

The client owns:

- agent keypair generation and local persistence
- key export and backup UX
- sender-secret creation, wrapping, unwrapping, and caching
- message encryption, signing, signature verification, and decryption
- signed plaintext channel serialization and verification
- rendering subscribed inbox state from SpacetimeDB

## Hard Crypto Boundary

- Never send private keys to SpacetimeDB.
- Never render private thread plaintext that has not been signature-verified and successfully decrypted.
- Never render channel plaintext that has not been signature-verified.
- Never replace private thread encrypted flows with mock plaintext storage.
- Keep decrypted sender secrets in memory or tightly scoped local persistence only when necessary.
- If an SSR path needs inbox data, keep it metadata-only. Decryption must stay client-only.

## UI And Data Rules

- Use generated bindings from `src/module_bindings/`; never edit them directly.
- Keep provider and connection setup centralized in `src/router.tsx`.
- Prefer subscription-driven UI over duplicated local state or ad hoc refetching.
- Sort thread timelines by `threadSeq`, not timestamps.
- Show disconnected, loading, empty, decrypting, and verification-failed states explicitly.
- Preserve type safety. Never introduce `any`.

## Naming Rules

- Prefer `thread`, `participant`, `secret envelope`, and `read state`.
- Do not introduce new `context` terminology in client code.
- Keep frontend labels aligned with the encrypted inbox product rather than starter-template wording.
# Frontend Agent Guide

This directory contains the TanStack Start frontend for the inbox application.

## Frontend Purpose

The frontend should present live inbox state from SpacetimeDB:

- inbox lists
- thread views
- message composer flows
- connection and sync state
- agent identity or presence details when useful

Do not let the UI drift into a mock-only demo once real SpacetimeDB data exists.

## Current Structure

- `router.tsx`: router, query client, and SpacetimeDB provider setup
- `routes/`: route files
- `lib/spacetimedb-server.ts`: server-side bootstrap or SSR fetch helpers
- `module_bindings/`: generated bindings, types, tables, reducers

## Client Data Rules

- Use generated types and bindings from `src/module_bindings/`.
- Do not edit generated files by hand.
- Prefer subscription-driven data with SpacetimeDB hooks over duplicated local caches.
- Keep reducer calls typed and object-shaped.
- Preserve type safety. Never use `any`.
- If the UI needs derived view state, compute it from subscribed rows instead of inventing parallel sources of truth.

## TanStack Start Guidance

- Keep the router and provider wiring centralized in `router.tsx`.
- Use route loaders and server functions for SSR-friendly prefetching when it improves first render.
- Keep page components focused on rendering and user actions.
- Extract reusable inbox UI into components only when duplication becomes real.
- Avoid introducing global client state for data that already lives in SpacetimeDB.

## SpacetimeDB Frontend Guidance

- Keep the connection builder stable and configured in one place.
- Keep database name and host settings aligned with `spacetime.json` and publish scripts.
- Prefer live subscriptions for inbox and thread state.
- Avoid optimistic updates unless a prompt specifically calls for them and the consistency model is clear.
- If a reducer or schema changes, regenerate bindings before wiring the UI.

## Implementation Preferences

- Use stable ids from the schema for React keys. Do not keep starter-template index keys once real entities exist.
- Model loading, empty, error, and disconnected states explicitly.
- Keep forms minimal and typed.
- Prefer simple CSS or inline styles unless a styling system is intentionally introduced.

## Files To Avoid Editing

- `routeTree.gen.ts`
- anything under `module_bindings/`

## Typical Frontend Workflow

1. Confirm the backend schema or reducer you need already exists.
2. Regenerate bindings if backend contracts changed.
3. Add or update a route, component, or helper.
4. Subscribe to the needed table or view.
5. Call reducers from typed UI handlers.
6. Verify loading, empty, connected, and disconnected behavior.
