# Gato — Development Guide

## Project Purpose

Pi extension harness powering "Gato", an AI sales assistant. This repo is a **pi-package** — a collection of extensions, prompts, and settings that Pi discovers at runtime via jiti (no build step).

## Architecture

```
.pi/
├── extensions/          ← TypeScript extensions (auto-loaded by Pi via jiti)
│   ├── lib/helpers.ts   ← shared utils (not auto-loaded — no index.ts)
│   ├── filter-history.ts
│   ├── generate-summary.ts
│   ├── inject-system-prompt.ts
│   └── register-mcp-tools.ts
├── prompts/
│   └── generate-summary.md
├── settings.json        ← Pi runtime settings
└── SYSTEM.md            ← base system prompt
```

## Extension Lifecycle (event order)

1. `session_start` — fires at Pi startup (generate-summary hooks here)
2. `before_agent_start` — fires after user submits a prompt (inject-system-prompt, register-mcp-tools)
3. `context` — fires before each LLM call (filter-history)

## Conventions

- **Naming**: verb-first for extensions (file and export match: `filter-history.ts` → `filterHistory`)
- **Helpers**: live in `extensions/lib/` — subdirs without `index.ts` are invisible to Pi's auto-discovery
- **Types**: import from `@earendil-works/pi-coding-agent`; use minimal typing, prefer inference, avoid `any`
- **Modules**: ESM only (`"type": "module"`), use `.ts` extension in imports
- **Config from env**: use `process.env["VAR_NAME"]` (bracket notation — strict tsconfig requires it), prefixed `GATO_`

## Local Commands

```sh
bun install          # install deps
bun check            # lint + typecheck (CI gate)
bun fix              # auto-fix lint + format
bun lint             # oxlint only
bun format           # oxfmt only
bun typecheck        # tsc --noEmit
bun clean            # git clean (keeps .env*)
```

## Change Workflow

1. Read the relevant extension(s) before editing
2. Minimize changes — small, focused diffs
3. Run `bun check` before considering work done
4. Format with `bun format` (lefthook does this on commit too)

## Key Technical Decisions

- **No build step**: jiti transpiles TypeScript at runtime
- **readPiFile()**: reads from project `.pi/` first, falls back to `~/.pi/` (project wins)
- **No `_` prefix convention**: Pi has no file exclusion pattern — use subdirectories instead
- **Strict TypeScript**: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals`
- **Oxlint + Oxfmt**: Rust-based, fast — replaces ESLint/Prettier

## Guardrails

- Extensions must export a default function matching `ExtensionFactory` signature
- Keep extensions independent — no cross-extension imports (only `lib/helpers.ts` is shared)
