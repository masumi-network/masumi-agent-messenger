# Security Audit

Date: 2026-04-12

## Summary

This audit covers the `masumi-agent-messenger` repo plus Masumi OIDC (default issuer: `https://masumi-saas-dev-exyyd.ondigitalocean.app` when `MASUMI_OIDC_ISSUER` is unset; optional local IdP such as `http://localhost:2999`) and local SpacetimeDB at `ws://localhost:3000`.

Primary security goals:

- no anonymous access to private inbox/thread/message state
- no cross-inbox reads
- no foreign-actor writes
- no normal-mode disclosure of OIDC session or decrypted symmetric keys
- no implicit dev session secret fallback outside explicit local-test mode

## 2026-04-14 Status Update

- `F1` fixed in code: private key persistence now relies on the encrypted IndexedDB vault only, and the legacy `localStorage` private-key fallback was removed.
- `F2` intentionally deferred: the browser-visible OIDC token flow remains unchanged in this pass.
- `F3` fixed in code: the inbox debug/token panels were removed entirely.
- `F4` fixed in code: the production server now applies an app-wide security-header baseline, sends CSP as a real response header for HTML, and emits HSTS only on secure transport.
- `F5` reclassified as intended behavior: duplicate direct threads for the same actor pair are supported product behavior and now covered by tests/documentation.
- `F6` fixed in code: the scan-heavy visibility and reducer paths called out in the audit now use index-backed lookups.
- `F7` intentionally deferred: no dependency upgrade landed in this pass, so the `h3` advisory remains tracked as accepted/deferred risk.
- `F8` fixed in code: OIDC issuer, client, and audiences are now config-driven, with explicit local-only defaults and startup validation for the production server.

## Asset Inventory

High-value assets:

- OIDC `id_token` used for live SpacetimeDB connections
- encrypted OIDC refresh token stored in an `HttpOnly` cookie
- local agent private encryption/signing keys
- archived local private keys
- decrypted sender secret cache
- inbox ownership binding: `ownerIdentity` + OIDC `iss` + OIDC `sub` + normalized email
- encrypted message bodies and wrapped sender secret envelopes

Publicly intended assets:

- `/$slug/public-key` published key discovery by known slug

## Exposure Map

HTTP routes:

- `GET /auth/login`: public, starts PKCE flow
- `GET /auth/callback`: public, completes PKCE flow
- `GET /auth/session`: same-origin browser session read
- `POST /auth/logout`: same-origin logout only
- `GET /$slug/public-key`: public key discovery for known slugs

Spacetime public surfaces:

- `visibleInboxes`
- `visibleActors`
- `visibleAgentKeyBundles`
- `visibleThreads`
- `visibleThreadParticipants`
- `visibleThreadReadStates`
- `visibleThreadSecretEnvelopes`
- `visibleMessages`
- `lookupPublishedActorBySlug`

Read-side note:

- `visible*` surfaces remain public at the Spacetime schema level because the client subscribes to them directly, but they now fail closed to empty unless the connection resolves to a verified, bound inbox owner identity.

## Permission Matrix

- Anonymous:
  - Allowed: `/$slug/public-key`, `lookupPublishedActorBySlug`
  - Denied: private `visible*` data and all reducers
- Authenticated but not inbox-bound:
  - Allowed: none beyond bootstrap attempt
  - Denied: `visible*` data and inbox-owned reducers
- Inbox owner:
  - Allowed: bootstrap own inbox, create sibling slugs, rotate own keys, create threads as owned actor, send as owned actor, read visible threads reachable from owned actors
- Thread participant:
  - Allowed: read thread state/messages/envelopes for reachable threads, send as owned actor in reachable threads, mark read/archive, leave self
- Thread admin:
  - Allowed: participant management where thread rules permit it
- Nobody:
  - Allowed: cross-inbox reads, cross-inbox writes, foreign-actor writes, foreign read-state writes, foreign key rotation, foreign secret-envelope publication

## Findings

### Fixed

1. High: normal-mode debug disclosure
   - Risk: the inbox route rendered OIDC session internals and decrypted symmetric keys in normal operation
   - Impact: token disclosure and plaintext-key disclosure to anyone with DOM/script access
   - Fix: debug UI and debug-state computation are now gated behind `VITE_ENABLE_SECURITY_DEBUG=true` and dev mode
   - Regression:
     - `webapp/tests/security/static/generated-contracts.test.ts`
     - `webapp/tests/security/static/security-helpers.test.ts`

2. High: implicit dev session secret fallback
   - Risk: a predictable default session secret existed whenever `MASUMI_SESSION_SECRET` was unset
   - Impact: cookie encryption compromise and session forgery if accidentally used in shared environments
   - Fix: `MASUMI_SESSION_SECRET` is now mandatory unless `MASUMI_ALLOW_INSECURE_DEV_SESSION_SECRET=true` is set outside production
   - Regression:
     - `webapp/tests/security/static/security-helpers.test.ts`

3. Medium/High: public actor-id discovery
   - Risk: public lookup exposed internal actor row ids that were then accepted by write reducers
   - Impact: reduced work factor for targeted reducer abuse and enumeration
   - Fix:
     - removed `/api/actors/resolve`
     - public lookup no longer returns actor ids
     - thread creation and participant-add reducers now resolve by `publicIdentity`
   - Regression:
     - `webapp/tests/security/static/generated-contracts.test.ts`
     - `webapp/tests/security/live/spacetime-security.test.ts`

4. Medium: GET logout CSRF
   - Risk: cross-site top-level GET navigation could trigger signout under `SameSite=Lax`
   - Impact: forced logout
   - Fix: logout is now POST-only and protected by same-origin request validation
   - Regression:
     - `webapp/tests/security/static/generated-contracts.test.ts`
     - `webapp/tests/security/static/security-helpers.test.ts`

5. Medium: read-side trust relied too heavily on connection identity alone
   - Risk: `visible*` views previously filtered by `ownerIdentity` but did not require a current trusted OIDC session on the server side
   - Impact: weaker defense-in-depth around stale/misaligned auth state
   - Fix: `visible*` views now require a readable inbox bound to the current owner identity and verified inbox state
   - Regression:
     - `webapp/tests/security/live/spacetime-security.test.ts`

6. Medium: missing browser hardening
   - Risk: there was no visible CSP or standard security-header baseline
   - Impact: weaker defense-in-depth for XSS and clickjacking
   - Fix:
     - document CSP injected at root
     - standard security headers applied to custom auth/public responses
   - Regression:
     - `webapp/tests/security/static/security-helpers.test.ts`

### Open / Accepted Risk

1. High: private keys remain in `localStorage`
   - Risk: any XSS in the origin can exfiltrate local private keys plus the current `id_token`
   - Impact: durable identity theft and message decryption/signing abuse
   - Status: accepted for current MVP; needs a larger client-key storage redesign

2. Medium: public slug lookup still reveals slug existence and current public keys
   - Risk: enumeration by known slug and metadata scraping
   - Impact: discoverability and targeting
   - Status: accepted because public key discovery is a product requirement

3. Medium: live stale-tab/session-drift behavior still depends partly on frontend reconnect discipline
   - Risk: a tab with an already-open connection can continue to read until it reconnects
   - Impact: short-lived stale authorization window after account switching in the same browser profile
   - Status: partially mitigated by token-keyed reconnects and read-side view checks; full multi-tab session invalidation is still future work

## Attack Vectors And Tests

- Anonymous read of private state:
  - `webapp/tests/security/live/spacetime-security.test.ts`
- Cross-thread/cross-tenant read leakage:
  - `webapp/tests/security/live/spacetime-security.test.ts`
- Foreign-actor write escalation:
  - `webapp/tests/security/live/spacetime-security.test.ts`
- Public actor-id discovery:
  - `webapp/tests/security/static/generated-contracts.test.ts`
  - `webapp/tests/security/live/spacetime-security.test.ts`
- Logout CSRF:
  - `webapp/tests/security/static/security-helpers.test.ts`
  - `webapp/tests/security/static/generated-contracts.test.ts`
- Missing secret config / insecure fallback:
  - `webapp/tests/security/static/security-helpers.test.ts`
- Invalid token classes:
  - `webapp/tests/security/live/spacetime-security.test.ts`
  - requires optional env tokens for wrong issuer, wrong audience, expired, unverified-email, and mismatch cases

## Remediation Backlog

1. Replace `localStorage` private-key persistence with a harder-to-exfiltrate client keystore flow.
2. Add full multi-tab session invalidation or short-lived server-issued Spacetime session bridging.
3. Consider authenticated slug resolution or rate-limiting if slug enumeration becomes operationally sensitive.
4. Add CI-provided invalid-token fixtures so every optional live abuse test runs automatically.
