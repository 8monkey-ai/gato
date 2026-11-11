# gato

Gato is a conversation harness. An agent and human operators serve the same customer. Gato receives messages from respond.io and Telegram, keeps a lasting record of each conversation, decides when the agent replies, and delivers the replies. `SPECS.md` gives the required behavior.

## Commands

| Command       | What it does                                               |
| ------------- | ---------------------------------------------------------- |
| `bun install` | Installs the dependencies.                                 |
| `bun start`   | Starts the harness. It reads environment variables.        |
| `bun check`   | Checks the format, lints, type-checks, and runs all tests. |
| `bun test`    | Runs the unit tests and the end-to-end tests.              |

Run `bun check` before you report work done and before each commit.

## Tests

- Unit tests are next to the code as `*.test.ts`.
- End-to-end tests are in the top-level `e2e/` folder. A test starts the application as a process with environment variables and a temporary data folder. It uses only the HTTP routes, the data folder, and the network calls of the application.
- Fake HTTP servers replace the channel platforms, the model gateway, and the MCP servers (`e2e/support/`). Each fake records the calls it receives.
- Each test name starts with the `SPECS.md` section that it checks. `e2e/journeys.test.ts` checks the acceptance journeys.

## Code layout

| Folder              | Responsibility                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `src/main.ts`       | Assembles the system, validates readiness, and owns startup and shutdown.       |
| `src/channels/`     | The channel abstraction and one folder for each adapter (Telegram, respond.io). |
| `src/conversation/` | Receives messages, removes duplicates, reconciles echoes, and queues turns.     |
| `src/record/`       | The chat folder format and the store.                                           |
| `src/agent/`        | One turn: instructions, summary, attachment preparation, context, generation.   |
| `src/delivery/`     | Message parts, media URLs, pacing, and sends.                                   |
| `src/skills/`       | The skills checkout and the country filter.                                     |
| `src/tools/`        | MCP connections.                                                                |
| `src/nudges/`       | The nudge policy and the periodic check.                                        |
| `prompts/`          | Every instruction that the harness gives to a model.                            |

To add a channel, add a folder in `src/channels/` with a `ChannelFactory`, and add the factory to the list in `src/main.ts`. The adapter reads its own environment variables.

## Configuration

All configuration is in environment variables. Invalid values stop the startup with a message that names the variable.

### Harness

| Variable                           | Default                        | Meaning                                                                                                                       |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `CONVERSATIONS_DIR`                | (required)                     | The data folder. It must exist and be writable.                                                                               |
| `SKILLS_DIR`                       | (required)                     | The mounted skills checkout.                                                                                                  |
| `AGENT_COUNTRY`                    | (required)                     | `MY` or `PH`.                                                                                                                 |
| `AGENT_TIMEZONE`                   | `UTC`                          | IANA timezone for today's date, summaries, and nudge hours.                                                                   |
| `HTTP_PORT`                        | `3000`                         | Port for webhooks and `/health`.                                                                                              |
| `OPENROUTER_API_KEY`               | (required)                     | OpenRouter key.                                                                                                               |
| `OPENROUTER_BASE_URL`              | `https://openrouter.ai/api/v1` | OpenRouter API address.                                                                                                       |
| `AGENT_MODEL`                      | (required)                     | Base conversation model.                                                                                                      |
| `SUMMARY_MODEL`                    | `AGENT_MODEL`                  | Model for contact summaries.                                                                                                  |
| `IMAGE_PREPARATION_MODEL`          | (none)                         | Model that describes images. Without it, images go to the main call.                                                          |
| `DOCUMENT_PREPARATION_MODEL`       | (none)                         | Model that reads documents. Without it, documents go to the main call.                                                        |
| `AUDIO_PREPARATION_MODEL`          | (none)                         | Model that transcribes audio. Without it, audio goes to the main call.                                                        |
| `TURN_TIMEOUT_SECONDS`             | `120`                          | Maximum time of one turn.                                                                                                     |
| `TURN_MAX_MODEL_CALLS`             | `12`                           | Maximum model calls of one turn, including summary, preparation, tool rounds, and retries.                                    |
| `DELIVERY_MESSAGE_BOUNDARY`        | `\n\n`                         | Text that separates two messages, for example three vertical bars. `\n` and `\t` are escapes. The agent instructions name it. |
| `DELIVERY_PACING`                  | `typing`                       | `typing` or `none`.                                                                                                           |
| `DELIVERY_TYPING_SECONDS_PER_WORD` | `1`                            | Typing pace.                                                                                                                  |
| `NUDGES_ENABLED`                   | `true`                         | Switches automatic nudges on or off.                                                                                          |
| `NUDGES_CHECK_INTERVAL_SECONDS`    | `300`                          | Time between two nudge checks.                                                                                                |
| `NUDGES_MILESTONES_MINUTES`        | `5,35,755,765`                 | Nudge times after the latest real customer message.                                                                           |
| `NUDGES_PERMITTED_HOURS`           | (all hours)                    | For example `09:00-18:00` in `AGENT_TIMEZONE`. Ranges past midnight are permitted.                                            |
| `SHUTDOWN_TIMEOUT_SECONDS`         | `30`                           | Time that running turns get to finish after `SIGTERM`.                                                                        |
| `MCP_SERVERS`                      | (none)                         | Names of business MCP servers, for example `crm,stock`.                                                                       |
| `MCP_<NAME>_URL`                   | (required for each server)     | Streamable HTTP address of the server.                                                                                        |
| `MCP_<NAME>_BEARER_TOKEN`          | (none)                         | Static bearer token for the server.                                                                                           |
| `MCP_<NAME>_TOOLS`                 | (none)                         | Permitted tools. The agent sees them by their own names.                                                                      |

### Telegram

| Variable              | Default                    | Meaning                                                 |
| --------------------- | -------------------------- | ------------------------------------------------------- |
| `TELEGRAM_BOT_TOKENS` | (none: Telegram is off)    | Comma-separated bot tokens. Each bot is one connection. |
| `TELEGRAM_API_URL`    | `https://api.telegram.org` | Bot API address.                                        |

### respond.io

| Variable                                | Default                                                      | Meaning                                             |
| --------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `RESPONDIO_WORKSPACES`                  | (none: respond.io is off)                                    | Names of workspace connections, for example `main`. |
| `RESPONDIO_API_URL`                     | `https://api.respond.io/v2`                                  | Developer API address.                              |
| `RESPONDIO_<NAME>_API_TOKEN`            | (required)                                                   | Developer API token.                                |
| `RESPONDIO_<NAME>_WEBHOOK_SIGNING_KEYS` | (required)                                                   | Comma-separated signing keys of the webhooks.       |
| `RESPONDIO_<NAME>_AGENT_USER_ID`        | (none)                                                       | The respond.io user of the agent.                   |
| `RESPONDIO_<NAME>_REPLY_CHANNEL_ID`     | (none: the platform selects the route)                       | A fixed messaging channel for replies.              |
| `RESPONDIO_<NAME>_HANDOFF_LABEL`        | `handoff`                                                    | Label for each handoff.                             |
| `RESPONDIO_<NAME>_OUT_OF_SCOPE_LABEL`   | `out-of-scope`                                               | Label for a handoff by the agent.                   |
| `RESPONDIO_<NAME>_ERROR_LABEL`          | `error`                                                      | Label for a handoff after an error.                 |
| `RESPONDIO_<NAME>_MCP_URL`              | (none: the MCP connection is off)                            | Address of the self-hosted respond.io MCP server.   |
| `RESPONDIO_<NAME>_MCP_BEARER_TOKEN`     | (required with the URL)                                      | Static bearer token for the MCP server.             |
| `RESPONDIO_<NAME>_MCP_TOOLS`            | `get_contact,create_comment,add_contact_tags,update_contact` | Permitted tools.                                    |
| `RESPONDIO_<NAME>_MCP_EDITABLE_FIELDS`  | `firstName,lastName,language`                                | Contact fields that the agent can change.           |
| `RESPONDIO_<NAME>_MCP_LABELS`           | the handoff and out-of-scope labels                          | Labels that the agent can add.                      |

In respond.io, add two webhooks, "New Incoming Message" and "New Outgoing Message", to `https://<host>/respondio/<name>/webhook`. Put both signing keys in `RESPONDIO_<NAME>_WEBHOOK_SIGNING_KEYS`.

The harness always sets the identifier of respond.io MCP tools to the current contact and hides it from the agent. It refuses `list_contacts`, `merge_contacts`, `create_contact`, and `send_message`, because they reach other contacts or bypass delivery.

## Data folder

Each conversation has the folder `<CONVERSATIONS_DIR>/<connection>/<contact>/`, for example `telegram-123456/987654/` or `respondio-main/42/`.

- `chat.txt` is the record in sent-time order. Each entry is a header line and an indented body:

  ```text
  [2026-01-05T10:00:00.000Z] customer {"ref":"m1","attachments":[{"kind":"image","source":"…","file":"attachments/1a2b3c4d-photo.jpg"}]}
    Hello

  [2026-01-05T10:00:05.000Z] agent {"turn":"t1","delivery":"sent","ref":"m2"}
    Hi! How can I help?

  [2026-01-05T10:00:06.000Z] turn {"turn":"t1","trigger":"customer","outcome":"completed","started":"2026-01-05T10:00:01.000Z"}
  ```

  Entry types: `customer`, `operator`, `workflow`, `agent` (messages), `note` (internal notes such as "Nudge" and handoff reasons), `tool` (tool requests and results), and `turn` (turn outcomes). Delivery states are `sending`, `sent`, `confirmed`, `uncertain`, `failed`, and `unsent`. Saved preparation results are in the `prepared` field of their attachment.

- `attachments/` has the original files.
- `summary.txt` has `Summarized at: <time>`, an empty line, and the summary.

Migration tools write folders in this format. The harness reads them at startup and does not treat their messages as new requests. The harness keeps lines that it cannot read unchanged. `/health` gives the number of damaged conversations, and the log names them.

## Skills checkout

`SKILLS_DIR` must contain `AGENTS.md` with the repository instructions. Each skill is a folder with a `SKILL.md` file in the [Agent Skills format](https://agentskills.io/specification). The agent can read `SKILL.md` and the `.md`, `.txt`, `.json`, `.csv`, `.yaml`, and `.yml` files of the skill folder, except the files in `scripts/`. Each turn reads the checkout again and keeps that revision until it ends.

## Operations

- `GET /health` returns `200` when the harness is ready, with the connections, the number of damaged conversations, and the nudge state (`reconciling`, `ready`, or `disabled`).
- Each model call sends the request field `metadata` with `call_type` (`message`, `nudge`, `summary`, or `preparation`) and `contact_id`, so that the gateway can show them for observability.
- Logs are JSON lines on standard output. They contain identifiers of connections, contacts, messages, and turns, but no message text. Configured secrets are replaced with `[secret]`.
- On `SIGTERM`, the harness stops new work. respond.io notifications get `503`, so that respond.io sends them again later. Running turns can finish until `SHUTDOWN_TIMEOUT_SECONDS`. Then they stop, and the record keeps what was sent.
- `Dockerfile` compiles the harness and its prompts into one executable with bytecode, and runs it on `gcr.io/distroless/cc-debian12` as uid `1000`. The image has no shell and no Bun installation. Mount the data folder and the skills checkout.

## Platform limits and decisions

- Telegram bots cannot see messages that people send from other accounts. The Telegram record has the customer messages and the messages of the bot.
- Telegram uses long polling (`getUpdates`), so the harness needs no public address for Telegram. A Telegram update is confirmed only after the harness saved it. A bot that has a webhook cannot use long polling.
- Telegram has no assignment, no internal notes, and no labels. All Telegram conversations are agent-owned, nudge notes stay in `chat.txt`, and the agent gets no handoff tool.
- respond.io has no typing indicator. Pacing still applies.
- respond.io gives no assignment in a form that the harness can watch without more events, so the harness asks respond.io for the assignee before each turn and each nudge.
- The respond.io messaging channel can have a lower text limit than the harness knows. The harness splits respond.io text at 2000 characters and Telegram text at 4096 characters.
- Platform times in whole seconds are set to the end of that second, but not later than the time of receipt. This keeps the order of messages that arrive in the same second.
- OpenRouter drops files in assistant messages. Files that an operator, a workflow, or the agent sent go to the model in a user-side message directly after the message, with a note that names the sender.
- Markdown links to media files are sent as attachments without the link text. Formatting stays as plain text.
- At startup the model gateway must answer its model list. A configured model that is not in the list gives the warning `models.not_listed`, but the harness starts: gateways can resolve their own model names, for example agent aliases, only when they are called. A model that does not exist makes each turn fail visibly.
- Tools keep the names that their MCP servers give them. If two tools have the same name, the turn fails with an error that names the tool, so that the agent never uses the wrong one.
- Model gateways refuse a request that ends with an assistant message. When the visible history ends with messages from the agent or the team, for example because a customer message arrived late, the turn adds the private user-side note `prompts/continue.md` after them. The history keeps its order, and the note is not recorded as a customer message.
- A deliberate skip is a reply with no text. The turn outcome is `skipped` with an explanation.
- After a restart, the harness does not run turns that stopped before they ended. A send that was on its way becomes `uncertain`. The nudge policy continues the conversation if the customer does not write again.
- Nudges make at most one attempt for each conversation in each check, and agent messages and agent notes, including the "Nudge" note, are the agent activity. These rules are fixed.
