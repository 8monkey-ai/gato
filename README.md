# Gato

An AI sales agent harness built on [Pi](https://pi.dev).

## 🐒 Overview

Gato turns Pi into a conversational sales representative for a messaging channel: it keeps context across sessions, personalizes each conversation from your contact data, and acts on your business systems through MCP tools. Everything that shapes the agent — its prompt, tools, and behavior — is plain files you can read and edit.

## 🍌 Features

- 💬 **Memory across sessions** — carries a rolling, language-aware summary of past interactions into every conversation, so returning customers are met with full context.
- 🎯 **Focused context** — keeps only recent conversation in view (configurable, default 60 days) and strips stale tool chatter from earlier turns, so replies stay fast and on-topic even in long-running relationships. Each part can be toggled independently.
- 🔌 **Connects to your systems** — exposes your business tools over MCP, so the agent can look things up and take action — orders, inventory, records — as part of the conversation.
- 🧩 **Drop-in skills** — add a skill (a folder of instructions) to your skills directory and the agent discovers it automatically, pulling it in whenever a conversation calls for it — no wiring or code.
- 💾 **Persistent conversations** — every conversation is saved automatically and can be resumed, so each customer's thread is preserved and you pick up exactly where you left off. Closed sessions are gzipped to keep disk usage low; `/resume-compressed` reopens one.

## 📦 Requirements

- [Pi](https://pi.dev) installed
- Credentials for your model provider (Gato defaults to the `hebo` provider; change it in `.pi/settings.json`)

## 🚀 Quick Start

```bash
git clone https://github.com/8monkey-ai/gato
cd gato
cp .env.template .env   # set your values, then `source .env` (or use direnv)
pi -c                   # start — continues the most recent conversation
```

> [!TIP]
> Run `pi -c` from the repo so Pi picks up the project `.pi/` — the system prompt, settings, packages, and prompts that make up Gato. Pi installs the declared packages automatically on first startup.

## 🗂️ Your Content

Gato ships the agent; you provide the business context.

| What                | Where                                                 |
| ------------------- | ----------------------------------------------------- |
| Business guidelines | `AGENTS.md` in the repo root                          |
| Skills              | `.pi/skills/`                                         |
| Tool servers        | `.pi/mcp.json`                                        |
| Sessions            | `~/.pi/agent/sessions/` (auto-managed by Pi)          |
| Summary             | `~/.pi/agent/compact.md` (auto-generated, don't edit) |

`mcp.json` format:

```json
{
  "mcpServers": {
    "crm": {
      "url": "https://your-mcp-server/endpoint",
      "lifecycle": "eager",
      "directTools": ["check_inventory", "create_order"]
    }
  }
}
```

> [!NOTE]
> Set `directTools` to `true` to register everything the server exposes. See the [pi-mcp-adapter docs](https://www.npmjs.com/package/pi-mcp-adapter) for all options.

## ⚙️ Configuration

Set via environment variables (Pi does not auto-load `.env` — `source` it or use direnv):

| Variable                    | Default | Effect                                             |
| --------------------------- | ------- | -------------------------------------------------- |
| `PI_HISTORY_DAYS`           | `60`    | Days of chat history kept in context               |
| `PI_COMPACT_STALENESS_DAYS` | `3`     | Age before the conversation summary is regenerated |

Context management comes from the [`@8monkey/pi-context-history`](https://www.npmjs.com/package/@8monkey/pi-context-history) package. Each feature is on by default and can be switched off by setting its flag to `false` or `0`:

| Flag                    | Default | Feature                                                   |
| ----------------------- | ------- | --------------------------------------------------------- |
| `PI_TRIM_HISTORY`       | on      | Drop messages older than `PI_HISTORY_DAYS`                |
| `PI_STRIP_TOOL_HISTORY` | on      | Strip prior turns' tool calls and results                 |
| `PI_COMPACT`            | on      | Keep a rolling summary and fold it into the system prompt |
| `PI_APPEND_MESSAGE`     | on      | `/add-user-message` and `/add-assistant-message` commands |

Model provider, thinking level, and other defaults live in `.pi/settings.json`.

## 🧪 Customizing

Gato's behavior comes from three Pi packages declared in `.pi/settings.json` — [`@8monkey/pi-context-history`](https://www.npmjs.com/package/@8monkey/pi-context-history) for cross-session memory and context trimming, [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) for MCP tools, and [`@8monkey/pi-session-gzip`](https://www.npmjs.com/package/@8monkey/pi-session-gzip) for compressing closed sessions — plus the summary prompt in `.pi/prompts/compact.md`. Pi installs missing packages automatically on startup; edit the prompt, swap packages, or add your own extensions under `.pi/extensions/`.
