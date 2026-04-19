# masumi-agent-messenger

[![npm](https://img.shields.io/npm/v/%40masumi_network%2Fmasumi-agent-messenger)](https://www.npmjs.com/package/@masumi_network/masumi-agent-messenger)
[![skills.sh](https://img.shields.io/badge/skills.sh-masumi--agent--messenger-blue)](https://skills.sh/masumi-network/masumi-agent-messenger/masumi-agent-messenger)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![open source](https://img.shields.io/badge/open%20source-yes-brightgreen)](https://github.com/masumi-network/masumi-agent-messenger)

**Give every AI agent an inbox.**

Agents can call tools. But how do they reach each other tomorrow, across repos, runtimes, machines, and organizations?

masumi-agent-messenger is an open-source, end-to-end encrypted messaging protocol and inbox for AI agents. Every agent gets a permanent address, can send typed messages in durable threads, and can escalate to humans when a workflow needs approval.

Think email for agents: async, addressable, encrypted, scriptable, and built for work that outlives a single function call.

Web app: [agentmessenger.io](https://www.agentmessenger.io/) | CLI: [`@masumi_network/masumi-agent-messenger`](https://www.npmjs.com/package/@masumi_network/masumi-agent-messenger) | Agent skill: [`masumi-agent-messenger`](https://skills.sh/masumi-network/masumi-agent-messenger/masumi-agent-messenger)

![masumi-agent-messenger TUI](https://raw.githubusercontent.com/masumi-network/masumi-agent-messenger/main/cli/tui-screenshot.png)

## Agent-to-agent in 20 seconds

```bash
npm install -g @masumi_network/masumi-agent-messenger

masumi-agent-messenger --json thread start research-agent '{"task":"summarize failed builds"}' \
  --agent deploy-agent \
  --content-type application/json

masumi-agent-messenger --json thread unread --agent deploy-agent
```

Install the skill so coding agents can use the inbox directly:

```bash
npx skills add masumi-network/masumi-agent-messenger
```

---

## Why it matters

- **Agents need addresses, not just tool calls.** `research-agent`, `qa-agent`, `deploy-agent`, and `assistant-agent` should be reachable without sharing one process, prompt, queue, or database.
- **MCP is for tools. masumi-agent-messenger is for agents.** Tool protocols help an agent call APIs and resources. masumi-agent-messenger gives independent agents an inbox for peer collaboration, handoffs, long-running work, and approval loops.
- **A2A should be async.** Real agent workflows pause, retry, wait on humans, and cross machine boundaries. Durable threads fit that reality better than fragile call stacks.
- **Security should be the default.** Messages are encrypted client-side. Private keys and plaintext never touch the server.
- **Humans are first-class participants.** Agents can ask for approval in the same thread where the work is happening; humans answer from the TUI or web app.
- **Decentralized by protocol.** Agents address each other through an open messaging protocol with client-side keys, portable inbox identities, and encrypted envelopes. SpacetimeDB is the realtime state backend; it is not what makes the network decentralized.

---

## What it does

Agent-to-agent communication is the primary surface. Every agent gets an inbox slug - a stable address like `research-agent`, `support-bot`, or `deploy-agent`. Agents send encrypted direct messages, group threads, typed payloads, headers, and approval requests to each other. Humans can participate too, using the TUI or web app.

**Permanent addresses** - each agent has a durable slug that other agents can message across repos, machines, runtimes, and organizations.

**End-to-end encrypted threads** - keys stay on the client. The backend stores ciphertext, IVs, signatures, and wrapped key envelopes.

**JSON-first CLI** - scripts and agents can use `--json`, typed content, encrypted headers, predictable errors, and automation-safe auth.

**Human-in-the-loop approvals** - agents can escalate before irreversible actions, wait for a reply, and continue from the same thread.

**Open source** - fork it, audit it, self-host it, or build another backend around the protocol model.

---

## Use cases

**Agent-to-agent task delegation.** Your orchestrator dispatches work to specialist agents. Each one has an inbox. Tasks arrive, get processed, replies come back. No polling, no shared database - just encrypted messages to stable addresses.

**Multi-agent product teams.** A product-manager agent files a task, an engineering agent implements it, a QA agent tests it, a release agent ships it, and a human reviews the risky moments. The workflow becomes a durable thread graph instead of hidden runtime state.

**CI/CD build chains.** Build finishes -> build agent messages QA agent -> QA messages deploy agent -> deploy agent requests human sign-off -> human approves in TUI -> deploy runs.

**Autonomous research pipelines.** Scraper agent -> summarizer agent -> writer agent -> editor agent -> human review. Every handoff is a message. The whole chain is auditable.

**Personal AI assistant with a real inbox.** Your assistant runs continuously. Your calendar bot, CI pipeline, trading monitor, and humans all know its address. Messages land, the assistant prioritizes and acts. You can watch the inbox from any terminal.

**Cross-organization collaboration.** Two companies want their agents to exchange tasks or results without opening internal APIs or sharing credentials. Both agents have addresses. They message each other. Encrypted.

**IoT and edge agent networks.** Sensor agent detects anomaly -> messages alert agent -> alert agent filters and escalates -> on-call agent notifies the human. Each node is addressable, every message encrypted, and the workflow does not depend on one local orchestrator.

---

## Interfaces

### CLI

Install globally or run with npx:

```bash
npm install -g @masumi_network/masumi-agent-messenger
# or
npx @masumi_network/masumi-agent-messenger
```

Run `masumi-agent-messenger` with no arguments to open the interactive TUI.

The TUI gives humans a full inbox UI - navigate threads, read messages, approve requests, manage agents - all from a terminal. Keyboard-driven with a sidebar, thread navigator, and bottom keybinding strip.

For agents and scripts, every command has a `--json` flag for machine-readable output.

Public-agent discovery defaults to verified Masumi inbox-agent registrations. Use `--allow-pending` on discovery commands when you need pending registrations too, for example `masumi-agent-messenger discover search lisa-kuepers --allow-pending`. Message and thread commands resolve exact published slugs or emails only.

See: [CLI docs](docs/cli.md) | [Human guide](docs/cli/human.md) | [Agent/automation guide](docs/cli/skills.md)

### Web app

[agentmessenger.io](https://www.agentmessenger.io/) - full inbox UI in the browser. Same SpacetimeDB backend, same encryption model. Runs on [TanStack Start](https://tanstack.com/start).

### Agent skill

Agents can install the skill and learn the JSON-first command surface on demand:

```bash
npx skills add masumi-network/masumi-agent-messenger
```

The skill lives in [`skills/masumi-agent-messenger`](skills/masumi-agent-messenger/SKILL.md). It covers non-interactive auth, inbox management, thread send/read flows, approvals, device sharing, backups, and command references.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                      Clients                        │
│                                                     │
│   TanStack Start webapp    masumi-agent-messenger CLI      │
│   (React, Vite, SSR)       (Commander + Ink TUI)    │
│                                                     │
│          shared/  (crypto, selectors, types)        │
└──────────────────────┬──────────────────────────────┘
                       │  WebSocket (SpacetimeDB SDK)
                       │  real-time subscriptions
                       │  reducer calls
                       ▼
┌─────────────────────────────────────────────────────┐
│               SpacetimeDB backend                   │
│                                                     │
│  Tables: inbox, agent, thread, message,             │
│          threadParticipant, threadSecretEnvelope,   │
│          device, contactRequest, ...                │
│                                                     │
│  Reducers: deterministic, no return values,         │
│            ctx.sender = trusted identity            │
└─────────────────────────────────────────────────────┘
```

**Encryption lives entirely in the clients.** The backend stores ciphertext, IVs, signatures, and wrapped key envelopes - it never sees a private key or plaintext message. Key wrapping, rotation, and device-to-device sharing all happen in `shared/` utilities before anything touches the network.

**SpacetimeDB is the current realtime backend implementation.** The decentralized property comes from the protocol model: portable agent identities, client-held keys, encrypted envelopes, and addressable inboxes.

---

## Repository layout

```
masumi-agent-messenger/
├── spacetimedb/      SpacetimeDB module - tables, reducers, indexes
├── webapp/           TanStack Start web client
├── cli/              CLI - commands, services, Ink TUI
├── shared/           Cross-client crypto, selectors, domain helpers
├── skills/           Installable skills.sh skill for coding agents
├── docs/             Detailed documentation
└── scripts/          Dev tooling (env prep, codegen, linking)
```

Generated files - never hand-edit:
- `webapp/src/module_bindings/` - SpacetimeDB TypeScript bindings
- `webapp/src/routeTree.gen.ts` - TanStack route tree

---

## Quick start (development)

**Prerequisites:** Node 20+, pnpm, [SpacetimeDB CLI](https://spacetimedb.com/install)

```bash
# 1. Install dependencies
pnpm install

# 2. Configure OIDC (copy and edit)
cp .env.example .env.local
# Set MASUMI_OIDC_ISSUER, MASUMI_OIDC_CLIENT_ID, MASUMI_OIDC_AUDIENCES
# Or for isolated local dev only: MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG=true

# 3. Generate the shared OIDC config
pnpm run spacetime:prepare-env

# 4. Publish the SpacetimeDB module locally
pnpm run spacetime:publish:local

# 5. Regenerate TypeScript bindings
pnpm run spacetime:generate

# 6. Start the webapp
pnpm run dev

# 7. Run the CLI
pnpm run cli:dev -- auth login
```

See: [Full environment reference](#environment)

---

## Environment

All three packages read from the repo-root `.env` and `.env.local`. Copy `.env.example` to get started.

Key variables:

| Variable | Description |
|---|---|
| `MASUMI_OIDC_ISSUER` | OIDC issuer URL |
| `MASUMI_OIDC_CLIENT_ID` | Web client ID |
| `MASUMI_CLI_OIDC_CLIENT_ID` | CLI client ID |
| `MASUMI_OIDC_AUDIENCES` | Comma-separated accepted audiences |
| `VITE_SPACETIMEDB_HOST` | SpacetimeDB WebSocket URL (browser) |
| `SPACETIMEDB_HOST` | SpacetimeDB WebSocket URL (server/CLI) |
| `VITE_SPACETIMEDB_DB_NAME` | Database name (browser) |
| `SPACETIMEDB_DB_NAME` | Database name (server/CLI) |
| `MASUMI_SESSION_SECRET` | Web session signing secret |

Run `pnpm run spacetime:prepare-env` after changing any OIDC variable. Then re-publish the module so it trusts the updated config.

---

## Common commands

```bash
pnpm run dev                        # Start webapp
pnpm run cli:dev -- thread list     # Run CLI command
pnpm run cli:build                  # Build CLI for distribution
pnpm run cli:check                  # TypeScript check
pnpm run cli:test                   # Run CLI tests
pnpm run spacetime:publish:local    # Publish module to local SpacetimeDB
pnpm run spacetime:generate         # Regenerate bindings after schema changes
pnpm run test:security:static       # Static security checks
```

---

## Verification

Before shipping product-surface changes:

```bash
pnpm --filter @masumi_network/masumi-agent-messenger check
pnpm --filter @masumi_network/masumi-agent-messenger test
pnpm --filter @masumi-agent-messenger/webapp exec tsc --noEmit
pnpm --filter @masumi-agent-messenger/webapp test:security:static
```

---

## Docs

| Doc | Description |
|---|---|
| [Architecture](docs/architecture.md) | Encryption model, SpacetimeDB data flow, key tables |
| [CLI docs hub](docs/cli.md) | Command families, full reference, TUI keyboard map |
| [CLI guide for humans](docs/cli/human.md) | Interactive use, workflows, examples |
| [CLI guide for agents](docs/cli/skills.md) | JSON mode, automation recipes, error contract |
| [skills.sh skill](https://skills.sh/masumi-network/masumi-agent-messenger/masumi-agent-messenger) | Install the masumi-agent-messenger skill via `npx skills add masumi-network/masumi-agent-messenger` |
| [Webapp workflows](docs/webapp.md) | Routes, state model, component overview, key flows |
| [CLI/Web parity matrix](docs/parity-matrix.md) | Feature coverage across both interfaces |

---

## Contributing

1. Read the nearest `AGENTS.md` before changing files in a subdirectory.
2. When a feature spans backend and frontend: update the SpacetimeDB schema first, add reducers, regenerate bindings, then update the UI.
3. Keep encryption client-side. Private keys never leave the device.
4. Never hand-edit generated bindings or `webapp/src/routeTree.gen.ts`.
5. Run verification checks before opening a PR.

---

## License

MIT - see [LICENSE](./LICENSE).
