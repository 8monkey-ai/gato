# Gato

An AI sales agent harness built on [Pi](https://pi.dev).

## 🐒 Overview

Gato turns Pi into a conversational sales representative for a messaging channel: it keeps
context across sessions, personalizes each conversation from your contact data, and acts on
your business systems through MCP tools. Everything that shapes the agent — its prompt, tools,
and behavior — is plain files you can read and edit.

## 🍌 Features

- 🧠 **Personalized conversations** — reads your contact data and tailors each conversation to
  the person, passing the right identifiers to your tools while keeping them hidden from the
  customer.
- 💬 **Memory across sessions** — carries a rolling, language-aware summary of past interactions
  into every conversation, so returning customers are met with full context.
- 🎯 **Focused context** — keeps only recent conversation in view (configurable, default 60 days),
  so replies stay fast and on-topic even in long-running relationships.
- 🔌 **Connects to your systems** — exposes your business tools over MCP, so the agent can look
  things up and take action — orders, inventory, records — as part of the conversation.
- 🧩 **Drop-in skills** — add a skill (a folder of instructions) to your skills directory and the
  agent discovers it automatically, pulling it in whenever a conversation calls for it — no
  wiring or code.
- 💾 **Persistent conversations** — every conversation is saved automatically and can be resumed,
  so each customer's thread is preserved and you pick up exactly where you left off.

## 📦 Requirements

- [Pi](https://pi.dev) installed
- Credentials for your model provider (Gato defaults to the `hebo` provider; change it in
  `.pi/settings.json`)

## 🚀 Quick Start

```bash
git clone https://github.com/8monkey-ai/gato
cd gato
cp .env.template .env   # set your values, then `source .env` (or use direnv)
pi -c                   # start — continues the most recent conversation
```

> [!TIP]
> Run `pi -c` from the repo so Pi picks up the project `.pi/` — the system prompt, settings,
> extensions, and prompts that make up Gato.

## 🗂️ Your Content

Gato ships the agent; you provide the business context.

| What | Where |
|------|-------|
| Business guidelines | `AGENTS.md` in the repo root |
| Skills | `.pi/skills/` |
| Contact data | `.pi/agent/user.json` |
| Tool servers | `.pi/agent/mcp.json` |
| Sessions | `~/.pi/agent/sessions/` (auto-managed by Pi) |
| Summary | `~/.pi/agent/summary.md` (auto-generated, don't edit) |

`mcp.json` format:

```json
{
  "mcpServers": {
    "crm": {
      "directTools": true,
      "url": "https://your-mcp-server/endpoint",
      "tools": ["check_inventory", "create_order"]
    }
  }
}
```

> [!NOTE]
> Omit `tools` to register everything the server exposes.

## ⚙️ Configuration

Set via environment variables (Pi does not auto-load `.env` — `source` it or use direnv):

| Variable | Default | Effect |
|----------|---------|--------|
| `GATO_HISTORY_DAYS` | `60` | Days of chat history kept in context |
| `GATO_SUMMARY_STALENESS_DAYS` | `3` | Age before the conversation summary is regenerated |

Model provider, thinking level, and other defaults live in `.pi/settings.json`.

## 🧪 Customizing

Every feature is a readable TypeScript file in `.pi/extensions/`, and the summary prompt is in
`.pi/prompts/`. Edit them, add your own, or remove what you don't need — Pi auto-discovers
extensions in the project `.pi/`.

