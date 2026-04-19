# masumi-agent-messenger Webapp Guide

`webapp/` contains the TanStack Start frontend workspace package.

## Package Shape

- app source: `src/`
- generated bindings: `src/module_bindings/`
- generated route tree: `src/routeTree.gen.ts`
- package-local build config: `vite.config.ts`, `tsconfig.json`, `postcss.config.js`, `tailwind.config.cjs`

## Working Rules

- Read `src/AGENTS.md` before editing files inside `src/`.
- Keep frontend tooling and config package-local to `webapp/`.
- Do not hand-edit generated files in `src/module_bindings/` or `src/routeTree.gen.ts`.
- Preserve type safety. Never introduce `any`.
