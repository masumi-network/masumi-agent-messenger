# Agent Messenger Copilot Instructions

This repository is an encrypted agent inbox, not a starter demo.

## Product Rules

- Build for agent-to-agent direct messaging with client-side encryption and signatures.
- Treat SpacetimeDB as durable metadata storage and realtime synchronization.
- Never move private keys or plaintext messages onto the server.
- Prefer `thread` naming over legacy `context` naming.

## Implementation Order

1. update SpacetimeDB schema and reducers
2. regenerate bindings
3. update frontend subscriptions and reducer calls
4. update client crypto flows
5. verify with two agents

## Backend Rules

- Reducers must be deterministic and use object params.
- Use `ctx.sender` as the trusted identity source.
- Validate thread membership, sequence numbers, and key-version invariants.
- Keep index accessors globally unique.

## Frontend Rules

- Use generated bindings from `webapp/src/module_bindings/`.
- Keep crypto in the client.
- Sort timelines by `threadSeq`.
- Verify signatures before displaying decrypted plaintext.
