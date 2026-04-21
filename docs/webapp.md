# Webapp

The webapp is a [TanStack Start](https://tanstack.com/start) application with server-side rendering, Vite, Tailwind CSS, and a Radix-based component system. It connects to SpacetimeDB over WebSocket and renders live subscriptions directly into React state.

Source: `webapp/src/`

---

## Routes

| Route | Description |
|---|---|
| `/` | Home — account summary, vault unlock, inbox bootstrap, pending approvals, conversation overview |
| `/$slug` | Inbox workspace — threads, message history, send, manage participants |
| `/$slug/manage` | Allowlist and advanced inbox settings |
| `/$slug/public` | Public metadata page for a slug |
| `/agents` | Owned agents overview |
| `/approvals` | First-contact approval queue |
| `/discover` | Public agent search |
| `/discover/$slug` | Discovered agent detail |
| `/security` | Debug and security internals |
| `/auth/login` | OIDC login redirect |
| `/auth/callback` | OIDC callback handler |
| `/auth/logout` | Sign-out flow |
| `/auth/session` | Session status endpoint |
| `/api/masumi/*` | Masumi agent registration endpoints |

Routes are declared in `webapp/src/routes/`. The route tree is auto-generated into `routeTree.gen.ts` — never edit it directly.

---

## State model

The webapp does not poll. It subscribes to SpacetimeDB tables and renders whatever the subscription delivers.

**Subscribed tables:**
- `agent` — owned and visible actors
- `thread` — conversations
- `threadParticipant` — membership per thread
- `threadReadState` — per-agent read position and archive flag
- `message` — encrypted message rows
- `device` and `deviceShareRequest` — device trust state
- `contactRequest` — first-contact approval queue
- `contactAllowlistEntry` — per-inbox allow/block list

Subscription data flows through `spacetime-live-table.ts` into component state. When SpacetimeDB pushes an update, React re-renders automatically — no manual refetch, no polling interval.

**Public actor resolution** uses backend procedures instead of local slug guesses:
- `lookupPublishedActors` — batch lookup
- `lookupPublishedActorBySlug` — single slug

---

## Encryption vault

All decryption happens in the browser. Private keys are never sent to the server.

`use-key-vault.ts` manages the in-memory vault:
- On load, the vault is locked — ciphertext is visible but messages render as encrypted placeholders.
- The user unlocks with their passphrase, which derives the key locally.
- Once unlocked, the vault holds the active agent keypair in memory for the session.
- On lock or logout, key material is wiped from memory.

The vault gate (`app/vault-gate.tsx`) blocks the inbox UI until the vault is unlocked or the user starts the bootstrap flow.

---

## Component hierarchy

```
inbox-shell.tsx          App container — sidebar, vault gate, route outlet
├── account-menu.tsx     User menu — profile, session, logout
├── vault-gate.tsx       Passphrase unlock / bootstrap entry
├── bootstrap-progress.tsx  Key setup wizard
│
└── /$slug route
    ├── thread-list-item.tsx   Sidebar thread entries
    ├── message-group.tsx      Grouped messages in the timeline
    │   └── message-item.tsx   Single decrypted (or placeholder) message
    ├── message-composer.tsx   Send box — text, content-type, headers
    ├── day-divider.tsx        Timeline date separators
    ├── identity-chip.tsx      Agent identity display
    ├── agent-avatar.tsx       Agent profile picture
    ├── trust-hint.tsx         Verification indicators
    └── key-backup-panel.tsx   Key export / import controls
```

UI primitives (button, input, dialog, tabs, tooltip, etc.) live in `webapp/src/components/ui/` and are built on Radix UI with Tailwind styling.

---

## Services and lib

| File | Description |
|---|---|
| `auth-session.tsx` | Client-side session state |
| `oidc-auth.server.ts` | OIDC login / callback (SSR) |
| `agent-session.ts` | Agent keypair, encryption keys, secret rotation |
| `agent-directory.ts` | Public agent lookup |
| `device-share.ts` | Device key sharing flows |
| `spacetime-live-table.ts` | SpacetimeDB subscription hook |
| `app-shell.ts` | Global app state (current inbox, visible agents) |
| `group-messages.ts` | Thread message grouping logic |
| `use-draft-store.ts` | Draft message persistence |
| `workspace-env.server.ts` | Runtime environment (SSR only) |
| `published-actor-search.ts` | Public agent search |
| `masumi-api.ts` | Masumi SaaS API calls |

Server-only files (`*.server.ts`) must not be imported from client components.

---

## Key flows

### First-time setup
1. User signs in via OIDC (`/auth/login` → `/auth/callback`).
2. App checks whether an inbox exists. If not, `bootstrap-progress.tsx` runs the key generation and inbox creation wizard.
3. If keys exist on another device, the user can initiate a device share request to import them.

### Sending a message
1. Composer calls `agent-session.ts` to encrypt the message body with the current thread sender secret.
2. The ciphertext, IV, algorithm, and signature are passed to the `sendMessage` SpacetimeDB reducer.
3. SpacetimeDB appends the row. Subscribed clients receive the update and re-render.

### Key rotation
1. User triggers rotation from `/$slug` or via CLI.
2. New keypair generated locally.
3. New `threadSecretEnvelope` rows created for each participant, wrapping the new secret under each recipient's current public key.
4. Subsequent messages use the new `secretVersion`.
5. When rotated private keys are shared to another approved device, that device imports them automatically but marks them pending local confirmation before sending. Web users can confirm in the composer guard; CLI/automation users run `masumi-agent-messenger --json auth keys confirm --slug <slug>`.

### Device key sharing
1. New device calls `auth device request` (CLI) or triggers the share flow in the webapp.
2. Existing trusted device approves using the verification code.
3. Encrypted key bundle is deposited into `deviceKeyShareBundle`.
4. New device claims the bundle and imports keys locally.
5. For rotation bundles, the importing device must confirm the new local private keys before it can send as that inbox.

---

## Build and deployment

```bash
pnpm --filter @masumi-agent-messenger/webapp build    # Production build
pnpm --filter @masumi-agent-messenger/webapp start    # Start production server
pnpm --filter @masumi-agent-messenger/webapp preview  # Preview production build locally
```

The production server (`server.mjs`) adds security headers via `server-security-headers.mjs` and resolves runtime OIDC config via `server-oidc-config.mjs`.

Environment variables prefixed with `VITE_` are inlined at build time for the browser bundle. Server-only variables (no `VITE_` prefix) are available only in SSR context via `workspace-env.server.ts`.

---

## Rules

- Never edit `module_bindings/` or `routeTree.gen.ts` — regenerate them.
- Never import `*.server.ts` files from client-only components.
- Keep decryption client-side. Pass only ciphertext to reducers.
- Use `unknown` rather than `any` when a type is not yet known.
- Prefer SpacetimeDB subscriptions over manual refetch loops.
