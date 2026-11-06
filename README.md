# gato

Gato is the conversation harness of `SPECS.md`. It lets an agent and human operators serve the same customer on respond.io, Telegram, or both. It is a TypeScript application on Bun. It uses the Vercel AI SDK with OpenRouter as the model gateway, and MCP servers for tools.

## Run

```sh
bun install
bun start
```

The container image runs the same command:

```sh
docker build -t gato .
docker run --env-file gato.env -v /srv/gato-data:/data -v /srv/skills:/skills -p 3000:3000 gato
```

`GET /health` answers `200` when the harness is ready and `503` when it is not. The body shows the enabled channels, the number of damaged chat folders, the skill problems, and the nudge state. It shows no conversation data.

## Configuration

All settings are environment variables. An empty value counts as absent. An invalid value stops the startup with a message that names the setting.

### Harness

| Variable                           | Default                | Meaning                                                                       |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `DATA_DIR`                         | required               | Folder of the chat folders. It must exist and be writable.                    |
| `SKILLS_DIR`                       | required               | Mounted skills checkout.                                                      |
| `COUNTRY`                          | required               | `MY` or `PH`.                                                                 |
| `CHANNELS`                         | required               | Enabled channel adapters, comma-separated: `respondio`, `telegram`.           |
| `TIMEZONE`                         | `UTC`                  | IANA time zone for today's date, summaries, and nudge hours.                  |
| `PORT`                             | `3000`                 | HTTP port for webhooks and `/health`.                                         |
| `TURN_TIMEOUT_SECONDS`             | `120`                  | Maximum response time of one turn.                                            |
| `TURN_MAX_MODEL_CALLS`             | `12`                   | Maximum model calls of one turn, including summary, preparation, and retries. |
| `SHUTDOWN_TIMEOUT_SECONDS`         | `30`                   | Time that running turns get to finish at shutdown.                            |
| `DELIVERY_MESSAGE_BOUNDARY`        | `\n\n`                 | Text that ends one customer message. `\n` and `\t` are escapes.               |
| `DELIVERY_PACING`                  | `typing`               | `typing` or `none`.                                                           |
| `DELIVERY_TYPING_SECONDS_PER_WORD` | `1`                    | Typing pace. The first message of a turn has no delay.                        |
| `DELIVERY_APPROVED_VIDEO_URLS`     | empty                  | Comma-separated URL prefixes of approved company videos.                      |
| `DELIVERY_VIDEO_LINKS`             | `attachment`           | `attachment` sends approved links as videos, `text` keeps them as links.      |
| `DELIVERY_VIDEO_LINK_TEXT`         | `replace`              | `replace` sends only the video, `separate` also sends the surrounding text.   |
| `NUDGE_ENABLED`                    | `true`                 | `true` or `false`.                                                            |
| `NUDGE_CHECK_INTERVAL_SECONDS`     | `300`                  | Time between nudge checks.                                                    |
| `NUDGE_MILESTONES`                 | `5m,35m,12h35m,12h45m` | Times after the latest real customer message.                                 |
| `NUDGE_HOURS`                      | `00:00-24:00`          | Permitted hours, `HH:MM-HH:MM`. A range can pass midnight.                    |
| `MCP_SERVERS`                      | `[]`                   | Business MCP servers, see below.                                              |

### Models (OpenRouter)

| Variable                     | Default                        | Meaning                                                     |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `OPENROUTER_API_KEY`         | required                       | API key.                                                    |
| `OPENROUTER_BASE_URL`        | `https://openrouter.ai/api/v1` | Gateway address.                                            |
| `AGENT_MODEL`                | required                       | Base conversation model.                                    |
| `SUMMARY_MODEL`              | `AGENT_MODEL`                  | Model for contact summaries.                                |
| `IMAGE_PREPARATION_MODEL`    | none                           | Describes images. Without it, images go to the main call.   |
| `DOCUMENT_PREPARATION_MODEL` | none                           | Reads documents. Without it, files go to the main call.     |
| `AUDIO_PREPARATION_MODEL`    | none                           | Transcribes audio. Without it, audio goes to the main call. |

At startup the harness checks that the gateway lists every configured model.

### Telegram

| Variable                | Default                    | Meaning    |
| ----------------------- | -------------------------- | ---------- |
| `TELEGRAM_BOT_TOKEN`    | required                   | Bot token. |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | Bot API.   |

The adapter uses long polling for `message` updates, so it needs no public address. Do not set a webhook on the same bot.

### respond.io

| Variable                        | Default                                                      | Meaning                                                               |
| ------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `RESPONDIO_API_TOKEN`           | required                                                     | Developer API token.                                                  |
| `RESPONDIO_API_BASE_URL`        | `https://api.respond.io/v2`                                  | Developer API.                                                        |
| `RESPONDIO_WEBHOOK_SIGNING_KEY` | required                                                     | Signing key of the webhook.                                           |
| `RESPONDIO_AGENT_USER_ID`       | required                                                     | User that counts as the agent for assignment and sent messages.       |
| `RESPONDIO_REPLY_CHANNEL_ID`    | none                                                         | Fixed reply channel. Without it, respond.io selects the route.        |
| `RESPONDIO_HANDOFF_LABEL`       | `handoff`                                                    | Label of every handoff.                                               |
| `RESPONDIO_OUT_OF_SCOPE_LABEL`  | `out-of-scope`                                               | Label of a handoff by the agent.                                      |
| `RESPONDIO_ERROR_LABEL`         | `error`                                                      | Label of a handoff after an error.                                    |
| `RESPONDIO_MCP_URL`             | none                                                         | Self-hosted respond.io MCP server. Setting it enables the tools.      |
| `RESPONDIO_MCP_TOKEN`           | required with the URL                                        | Static bearer token for the MCP server.                               |
| `RESPONDIO_MCP_TOOLS`           | `get_contact,create_comment,add_contact_tags,update_contact` | Permitted tools.                                                      |
| `RESPONDIO_MCP_EDITABLE_FIELDS` | `firstName,lastName,language`                                | Contact fields that the agent can edit.                               |
| `RESPONDIO_MCP_LABELS`          | empty                                                        | Labels that the agent can add, in addition to the two handoff labels. |

In respond.io, send the `message.received` and `message.sent` webhook events to `POST /respondio/webhook`. The harness rejects requests without a valid `X-Webhook-Signature`.

The harness always sets the contact identifier of respond.io tools to the current contact. It refuses a permitted tool that has no contact identifier, because it cannot limit such a tool to the current contact.

### Business MCP servers

`MCP_SERVERS` is a JSON list:

```json
[
  {
    "name": "crm",
    "url": "https://crm.example.com/mcp",
    "headers": { "Authorization": "Bearer …" },
    "tools": ["lookup_order"]
  }
]
```

The agent sees each tool as `<name>_<tool>`, for example `crm_lookup_order`.

## Prompts and skills

The `prompts` folder holds every instruction that the harness gives a model: `agent.md`, `summary.md`, `image.md`, `document.md`, `audio.md`, and `nudge.md`.

The skills checkout must contain `AGENTS.md` with the repository instructions. Each skill is a folder with a `SKILL.md` file in the [Agent Skills](https://agentskills.io/specification) format. The `name` must be the folder name. The agent can read `AGENTS.md` and the text files (`.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`) inside valid skill folders. Country markup (`my[…]`, `ph[…]`, `:::my`, `:::ph`) is filtered before the agent sees a text.

## Chat folders

Each conversation has the folder `DATA_DIR/<channel>/<conversation>/`:

- `chat.txt`: the record in sent-time order. Each entry has one header line, `[<ISO time>] <label> <JSON metadata>`, and then its text lines, each starting with `> `. The label is for people. The harness reads only the time, the metadata, and the text.
- `summary.txt`: `Summary date: <ISO time>`, an empty line, and the summary.
- `attachments/`: the original files.

External migration tools can write folders in this format. A migrated customer message without `"trigger": true` is history, not new work. A chat folder that the harness cannot read is reported in the log and in `/health`, and the harness does not write to it.

## Platform limits

- Telegram: a standard bot does not see messages of other people in the chat, has no assignment, no internal notes, and no handoff. Every Telegram conversation is agent-owned, internal notes stay in the chat folder, and the agent gets no handoff tool.
- Telegram gives message times in whole seconds. The harness uses the receipt time inside that second to keep the order.
- respond.io has no typing indicator in the Developer API. Pacing still applies.
- The OpenRouter provider of the AI SDK drops files in assistant-side messages. Files from operators and workflows therefore reach the model only through a preparation model. Without one, the model sees the file information and this limit.
- One instance connects one account for each channel type.
- Each nudge check makes at most one attempt per conversation. Qualifying agent activity is agent messages and agent-authored notes, including the nudge note. These two nudge settings are fixed.
- A turn skips its reply when the answer starts with `NO_REPLY:`. The rest of the text is the private reason.

## Checks

Run `bun check` before you report work done and before each commit. It runs the formatter check, the linter with type checks, and all tests.

## Tests

- Unit tests are next to the code as `*.test.ts`.
- End-to-end tests are in the top-level `e2e/` folder. A test starts the application as a process with environment variables and a temporary data folder. It uses only the HTTP routes, the data folder, and the network calls of the application.
- Fake HTTP servers replace the channel platforms, the model gateway, and the MCP servers. Each fake records the calls it receives.
- Each test name starts with the `SPECS.md` section that it checks. `e2e/acceptance-journeys.test.ts` checks the acceptance journeys that need more than one section.
