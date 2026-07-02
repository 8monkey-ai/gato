# Gato — Development Guide

## Project Purpose

Pi harness powering "Gato", an AI sales assistant. This repo is a **pi-package**: prompts, skills, settings, and MCP config that Pi discovers at runtime (no build step). Runtime behavior comes from two installed Pi packages rather than local extensions.

## Architecture

```
.pi/
├── npm/                 ← project-local Pi package installs (gitignored)
├── prompts/
│   └── compact.md       ← summary prompt for pi-context-history
├── skills/              ← sales-domain skills (auto-discovered)
├── mcp.json             ← MCP servers for pi-mcp-adapter
├── settings.json        ← Pi runtime settings + `packages` list
└── SYSTEM.md            ← base system prompt
```

## Installed Pi packages (declared in `.pi/settings.json` → `packages`)

- **`@8monkey/pi-context-history`** — context management; four features behind `PI_` flags (on unless set to `false`/`0`):
  - `PI_TRIM_HISTORY` — drop messages older than `PI_HISTORY_DAYS`
  - `PI_STRIP_TOOL_HISTORY` — strip prior turns' tool calls/results
  - `PI_COMPACT` — rolling summary in `~/.pi/agent/compact.md`, regenerated on stale resume (`PI_COMPACT_STALENESS_DAYS`) and injected into the system prompt; `/compact-session` to force
  - `PI_APPEND_MESSAGE` — `/add-user-message` and `/add-assistant-message` commands
- **`pi-mcp-adapter`** — connects MCP servers from `.pi/mcp.json`; `directTools: true` registers server tools individually instead of behind the `mcp` proxy tool
- **`@8monkey/pi-session-gzip`** — gzips closed session files on shutdown; `/resume-compressed` restores and reopens one

Pi installs missing packages automatically on startup; `pi install -l npm:<pkg>` adds a new one.

## Conventions

- **Config from env**: `PI_`-prefixed variables, documented in `.env.template` (Pi does not auto-load `.env` — source it or use direnv)
- **Skills**: one folder per topic under `.pi/skills/<name>/SKILL.md`
- **Prompt override**: `prompts/compact.md` must keep the `{conversation_history}` placeholder

## Local Commands

```sh
bun install          # install dev deps (lefthook, oxfmt)
bun format           # oxfmt
bun clean            # git clean (keeps .env*)
```

## Change Workflow

1. Minimize changes — small, focused diffs
2. Format with `bun format` (lefthook does this on commit too)

## Key Technical Decisions

- **No local extensions**: context management and MCP support are installed Pi packages; custom extensions would go in `.pi/extensions/` if ever needed again
- **Project-local package installs**: `.pi/npm/` is gitignored; `settings.json` is the source of truth and Pi restores missing packages on startup
- **Oxfmt**: Rust-based formatter — no linter or typechecker since there's no local TS code
