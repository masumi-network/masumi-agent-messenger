# masumi-agent-messenger Claude Guide

This repository is an encrypted agent-to-agent inbox built with TanStack Start and SpacetimeDB.

## Defaults

- Treat SpacetimeDB as the source of truth for durable inbox metadata.
- Treat encryption, decryption, signing, and key wrapping as client-only concerns.
- Never send private keys, decrypted sender secrets, or private thread plaintext to the server.
- Channels are the intentional exception to thread-style secrecy: they are signed plaintext shared feeds, not end-to-end-private threads. Do not use channel messages for confidential payloads.
- Prefer domain names such as `account`, `agent`, `agentKeyBundle`, `thread`, `threadParticipant`, `threadSecretEnvelope`, `message`. Read-state is part of `threadParticipant` (no separate `threadReadState`).
- `account` is the OIDC user row; `agent` is a published persona under it (1:N); "inbox" is a UX/product term only.
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
- Use explicit key-version fields and `secretVersion`. The first sender-secret published in a thread is `secretVersion = 1`; subsequent rotations strictly increase. The client uses `firstOrNextSecretVersion` in `shared/agent-crypto.ts` to compute this — do not call `nextKeyVersion(undefined)` for the first version (it returns 2).
- Order private thread messages by auto-increment `message.id`, not timestamps.
- Treat attached secret envelopes on a message as the rotation boundary for a new sender secret.
- `senderMessageId` is a random non-zero `u64`. Server rejects 0; client `randomSenderMessageId` rerolls if `getRandomValues` produces 0. Replay protection enforced server-side via the `(sender, sender_message_id)` unique check in `helpers/messages.rs::insert_thread_message`.
- Cryptographic byte caps live in `spacetimedb/src/constants.rs` and mirror in `shared/message-limits.ts`. Clients call `ensureCiphertextBytes` / `ensureMessageIvBytes` / `ensureSignatureBytes` / `ensureWrappedSecret*Bytes` / `ensureDeviceBundle*Bytes` in the prepare/encrypt path so a payload the reducer would refuse fails fast on the client. The static contract test "mirrors the cryptographic byte caps between client and server" locks the constants together.
- Do NOT add a `sender_seq` / `senderSeq` column to `message` or `channel_message`. Per-sender ordering lives on `thread_participant.last_sent_seq` and `channel_member.last_sent_seq` and is checked at insert time by the reducer (e.g. `last_sent_seq == 0 && !attaches_new_envelopes` is the first-message-must-rotate rule in `send_encrypted_message.rs`). It is intentionally NOT included in the signed payload built by `buildMessageSignaturePayload` in `shared/agent-crypto.ts` — the signed payload binds `senderMessageId` (random, replay-protection) plus `threadId`, `secretVersion`, and the ciphertext hash. The static contract tests "keeps sender-local counters off message rows and on membership rows" and "protects sender-secret rotation invariants in send_encrypted_message.rs" in `webapp/tests/security/static/generated-contracts.test.ts` lock this in. If you think you need a per-message sender seq, re-read those tests and the discussion of the rejected proposal before changing it.

## Peer Key Trust Rules

The trust model after the rework is **sender-gated**, not receiver-gated. Server-side rotation is permissive; the trust gates run on the sender's own machine.

- The server is NOT a trust anchor for peer agent keys. `rotateAgentKeys` only requires a valid OIDC token plus account ownership. It does not check device-approval status. A compromised OIDC session can publish attacker-controlled keys under a legitimate agent slug.
- Clients still pin each peer's known `(encryptionKeyVersion, signingKeyVersion, encryptionPublicKey, signingPublicKey)` tuple locally on first observation. The pinned tuple is used to detect and surface rotation events.
- On detecting a new tuple for a pinned peer, the **receiver** auto-confirms the rotation in their local trust store and surfaces a "key rotated" notice to the user. Receivers do NOT block inbound or outbound messages on rotation. (See `confirmPeerKeyRotation` in `cli/src/services/peer-key-trust.ts` and `webapp/src/lib/peer-key-trust.ts`.)
- The **sender's own account** gate is `requireImportedRotationKeyConfirmed` — when a new signing/encryption key bundle is imported into a device (e.g. via the `deviceKeyBundle` claim flow on a different device), the receiving device marks the import as `pending` and refuses to send messages until the user explicitly confirms the imported keys. This is the "show on other devices, confirm before sending" gate.
- Per-message inbound signatures must still validate against the sender's resolved `(senderSigningKeyVersion, senderSigningPublicKey)` from `agentKeyBundle` history. Failed signatures are rejected regardless of trust-store state.

Do NOT re-introduce a hard "block outbound sends until user out-of-band confirms peer rotation" gate without first re-evaluating the device-import flow — they were designed together.

### Channels — same trust model, different surface

Channels share the same model: receivers auto-confirm rotation, signatures verify per-message against the bundled history.

- `rotateAgentKeys` does not require a device-approval check (server-side); the device-trust layer (device-share-request + claim flow) governs key material distribution among the sender's own devices, not server-side rotation gating.
- Device key-bundle source attribution is account-trusted. Once OIDC proves account ownership, reducers may infer the displayed source device from an approved device public-key tuple; do not add a per-device proof/signature gate unless the device trust model changes.
- Channel message rows carry a pinned `senderSigningKeyVersion`. Clients resolve the matching `senderSigningPublicKey` from `agentKeyBundle` history via the `lookupPublishedAgentSigningKeys` procedure, so historical messages always verify against the key that signed them.
- Anonymous viewers reach a public channel via direct slug link and read history through the `listPublicChannelMessages` procedure.

Accepted residual risk: a compromised OIDC session can register a fresh device, rotate keys, and sign new channel messages that will verify against the published bundle history. Mitigations are: device revocation on compromise, append-only key history (forensics), and the `imported-rotation-key-confirmation` gate on other devices of the same account.

### Masumi registry lookup is advisory for send-time chat guards

The `lookupMasumiInboxAgentBySlug` / `getMasumiNetworkAgentChatBlock` checks that gate direct-thread sends (see `cli/src/services/send-message.ts` and `webapp/src/lib/published-actor-search.ts`) query the Masumi registry to block sending to deregistered or failed-registration peers. These lookups are ADVISORY:

- Network, auth, or registry-availability failures do NOT block the send. The CLI surfaces them via `reporter.info`; the webapp surfaces them via `console.warn`. The send then proceeds against the locally-published public route.
- Accepted risk: an attacker who can degrade the registry query (DNS, connectivity, registry outage) can bypass the "deregistered peer" guard. This is intentional — the registry must not become a hard availability dependency for the core send path.
- The substantive trust posture still holds: peer key pinning, signature verification, and recipient-side contact policies are enforced regardless of the registry check. The registry guard is a convenience to fail fast on known-bad peers, not a security boundary.

Do not tighten these catches into hard failures without also re-evaluating how an offline or degraded registry should affect the send path.
# masumi-agent-messenger Claude Guide

This repository is an agent-to-agent messaging and inbox application.

## Project Shape

- Frontend: TanStack Start in `webapp/src/`
- Backend: SpacetimeDB module in `spacetimedb/` (Rust, post-rework)
- CLI: `cli/` (TypeScript)
- Shared TS: `shared/`
- Generated bindings: `webapp/src/module_bindings/` (regenerated via `pnpm run spacetime:generate`)

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
- Use object arguments for reducer calls (Rust uses positional args; the TS generated bindings expose them as a single object).
- Declare indexes in the `#[spacetimedb::table(...)]` attribute.
- Keep index accessor names globally unique across the module.
- Use `0` placeholder for auto-increment `u64` ids on insert (the runtime overwrites it). The intentional exception is direct-thread creation with an attached first message: the client supplies a stable high-bit thread id because that id is already bound into the signed message payload.
- Regenerate bindings after changing tables, reducers, or exported backend types.

## Domain model (post-rework)

The schema lives in `spacetimedb/src/tables/*.rs` (28 tables). Core domain:

- `account` — OIDC-authenticated user row (was `inbox`)
- `agent` — published persona under an account (1:N)
- `agentKeyBundle` — append-only key history
- `thread`, `threadParticipant`, `message`, `threadSecretEnvelope`
- `channel`, `channelMember`, `channelMessage`
- `threadInvite`, `channelJoinRequest`, `contactRequest`, `contactAllowlistEntry`

Read-state is merged into `threadParticipant` and `channelMember`. There is no separate `threadReadState` or `inboxThread` projection — derive from participant rows.

## Useful Commands

```bash
pnpm run dev
pnpm run spacetime:publish:dev    # publishes to dev DB on maincloud
pnpm run spacetime:generate        # regenerates TS bindings
pnpm run build
```

## Post-rework wire-protocol notes

The rework changed several on-the-wire shapes in ways that are not backwards compatible. Pre-rework rows and signatures will not validate or deserialize against the new schema. Dev DB (`masumi-messenger-dev-hlq5a`) is the only target — there is no migration path from older data; wipe the DB before publishing.

- **Message signature payload**: `senderSeq` removed; `senderMessageId` is mandatory and always included in the signed payload. The earlier client-side rejection of the legacy `1n` sentinel was dropped — only `0n` is rejected (mirrors the server's `sender_message_id == 0` reject in `helpers/messages.rs`). See `shared/agent-crypto.ts:buildMessageSignaturePayload` and `randomSenderMessageId`.
- **Key version type**: `encryptionKeyVersion`, `signingKeyVersion`, `secretVersion` are `number` (was prefix-string `enc-vN`/`sig-vN`). See `shared/agent-crypto.ts:normalizeVersion`. The first sender secret in a thread is `secretVersion = 1`; use `firstOrNextSecretVersion` rather than `nextKeyVersion(undefined)` for the first publish.
- **Thread/channel ordering**: server-side `next_thread_seq` / `next_channel_seq` and derived `lastMessageSeq` were removed. Private thread and channel timelines sort by their auto-increment message `id`; sender-local counters stay on membership rows and are not persisted on messages.
- **Cryptographic byte caps**: `MAX_MESSAGE_CIPHERTEXT_BYTES = 144 KiB`, `AES_GCM_IV_BYTES = 12`, `SIGNATURE_BYTES = 64`, `MAX_WRAPPED_SECRET_CIPHERTEXT_BYTES = 48`, `MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES = 3 MiB`. Defined in `spacetimedb/src/constants.rs` and mirrored in `shared/message-limits.ts` via the `ensure*Bytes` helpers wired into the prepare/encrypt paths.
- **Channel access mode**: collapsed to a binary enum (`Public`, `ApprovalRequired`). The pre-rework per-permission `--public-join-permission read|read_write` flag is gone; permission is set per-member via `update_channel_member_permission` after the join.
- **SpacetimeDB live subscriptions**: SpacetimeDB 2.1 rejects `LIMIT` in subscription SQL, so `shared/spacetime-subscription-limits.ts` exposes `prepareSpacetimeSubscriptionQuery` which only validates the table is in the allowlist and strips trailing `;`/comments — it does NOT cap row counts. Per-table caps live on the server (bounded views + paged procedures).
- **Reducer/table renames** worth being aware of: `inbox*` → `account*`; `mark_thread_read` + `set_thread_archived` → `update_thread_read_state`; `set_channel_member_permission` → `update_channel_member_permission`; `request_direct_contact_with_first_message` → `request_direct_contact` (still atomic: it creates the direct thread, stores the first hidden message, and attaches the initial secret envelopes before approval). The CLI service shim formerly called `createInboxIdentity` is now `createAgent` in `cli/src/services/inbox-management.ts`.
