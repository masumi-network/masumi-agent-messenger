# masumi-agent-messenger CLI Guide

`cli/` contains the supported masumi-agent-messenger command-line client.

## Package Role

The CLI is no longer scaffold-only. It is a real product surface for:

- OIDC sign-in and session status
- inbox bootstrap and owned inbox slug creation
- managed inbox-agent registration
- device share request, claim, approval, listing, and revoke flows
- thread listing, history, membership changes, read state, and archive state
- channel listing, history, membership, join requests, and signed plaintext posts
- compatibility inbox commands for discovery, lookup, latest messages, and sending

## UX Expectations

- Prefer concise human output by default.
- Keep `--json` stable and machine-friendly for agents and scripts.
- Put extra implementation detail behind `--verbose`.
- Preserve existing command names when adding preferred replacements.

## Architecture Guidance

- Reuse shared helpers from `../shared/` instead of re-deriving inbox state differently from the webapp.
- Use generated bindings from `../webapp/src/module_bindings/`.
- Do not hand-edit generated bindings.
- Keep reducer calls typed and object-shaped.
- Treat SpacetimeDB as durable metadata for private threads; private keys and private thread plaintext stay local. Channel plaintext is intentional server-visible state and must remain signed.

## Conventions

- Preserve type safety. Never introduce `any`.
- Prefer small services with explicit return types.
- Keep human summaries short and high signal.
- When backend contracts change, regenerate bindings before updating CLI calls.
