# Gato

**An AI sales agent harness built on [Pi](https://pi.dev).**

Gato turns Pi into a conversational sales representative for a messaging channel: it keeps
context across sessions, personalizes each conversation from your contact data, and acts on
your business systems through MCP tools. Everything that shapes the agent — its prompt, tools,
and behavior — is plain files you can read and edit.

## Features

Gato gives a sales agent what it needs to hold real customer relationships:

- **Personalized conversations** — reads your contact data and tailors each conversation to
  the person, passing the right identifiers to your tools while keeping them hidden from the
  customer.
- **Memory across sessions** — carries a rolling, language-aware summary of past interactions
  into every conversation, so returning customers are met with full context.
- **Focused context** — keeps only recent conversation in view (configurable, default 60 days),
  so replies stay fast and on-topic even in long-running relationships.
- **Connects to your systems** — exposes your business tools over MCP, so the agent can look
  things up and take action — orders, inventory, records — as part of the conversation.

## Requirements

- [Pi](https://pi.dev) installed
- Credentials for your model provider (Gato defaults to the `hebo` provider; change it in
  `.pi/settings.json`)

## Quick start

```bash
git clone https://github.com/8monkey-ai/gato
cd gato
cp .env.template .env   # set your values, then `source .env` (or use direnv)
pi -c                   # start — continues the most recent conversation
```

Run `pi -c` from the repo so Pi picks up the project `.pi/` — the system prompt, settings,
extensions, and prompts that make up Gato.

## Your content

Gato ships the agent; you provide the business context. Files in a project `.pi/` take
precedence over the global versions in `~/.pi/`.

| What | Where | Purpose |
|------|-------|---------|
| Business guidelines | `~/.pi/agent/AGENTS.md` | Your playbook, tone, and rules — appended to the system prompt |
| Skills | `~/.pi/agent/skills/<name>/SKILL.md` | On-demand capabilities the agent loads when relevant |
| Contact data | `~/.pi/user.json` | Free-form JSON about the person; used to personalize and to pass identifiers to tools |
| Tool servers | `~/.pi/agent/mcp.json` | MCP servers to expose as agent tools |
| Sessions | `~/.pi/agent/sessions/` | Conversation history — managed by Pi automatically |
| Summary | `~/.pi/summary.md` | Auto-generated and injected for continuity (don't edit by hand) |

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

Omit `tools` to register everything the server exposes.

## Configuration

Set via environment variables (Pi does not auto-load `.env` — `source` it or use direnv):

| Variable | Default | Effect |
|----------|---------|--------|
| `GATO_HISTORY_DAYS` | `60` | Days of chat history kept in context |
| `GATO_SUMMARY_STALENESS_DAYS` | `3` | Age before the conversation summary is regenerated |

Model provider, thinking level, and other defaults live in `.pi/settings.json`.

## Customizing

Every feature is a readable TypeScript file in `.pi/extensions/`, and the summary prompt is in
`.pi/prompts/`. Edit them, add your own, or remove what you don't need — Pi auto-discovers
extensions in the project `.pi/`.

