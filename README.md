# gato

A conversation harness. It lets an agent and human operators serve the same customer on respond.io and Telegram. `SPECS.md` gives the required behavior.

## Run

```sh
bun install
bun start
```

The application reads its configuration from environment variables. It writes all conversation data to `DATA_DIR`. The health route `GET /health` gives readiness (status 200 when ready, 503 when not ready), the number of damaged histories, skill problems and the time of the last nudge check. The logs name each damaged history.

## Configuration

### Core

| Variable                 | Default              | Description                                                                         |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `DATA_DIR`               | (required)           | Folder for the chat folders. Mount it outside the container.                        |
| `COUNTRY`                | (required)           | `MY` or `PH`.                                                                       |
| `TIMEZONE`               | `UTC`                | IANA timezone for dates, summaries, history windows and nudge hours.                |
| `PORT`                   | `3000`               | HTTP port for webhooks and `/health`.                                               |
| `OPENROUTER_API_KEY`     | (required)           | Key for the AI gateway.                                                             |
| `OPENROUTER_BASE_URL`    | OpenRouter           | Base URL of an OpenRouter-compatible gateway.                                       |
| `MODEL`                  | (required)           | Base conversation model.                                                            |
| `SUMMARY_MODEL`          | `MODEL`              | Optional model for contact summaries.                                               |
| `SUMMARY_PROMPT_FILE`    | `prompts/summary.md` | Replacement summary prompt.                                                         |
| `RECENT_CONTACT_HISTORY` | `false`              | `true` limits model context to the latest calendar month of the contact's messages. |
| `INCLUDE_TOOL_ACTIVITY`  | `true`               | `false` omits earlier tool activity and nudge prompts from model context.           |
| `IMAGE_MODEL`            | (none)               | Optional model that describes images. Without it, images go to the main call.       |
| `DOCUMENT_MODEL`         | (none)               | Optional model that reads documents. Without it, documents go to the main call.     |
| `AUDIO_MODEL`            | (none)               | Optional model that transcribes audio. Without it, audio goes to the main call.     |
| `OWNERSHIP_POLICY`       | `assigned`           | `assigned`, `shared` or `unrestricted`.                                             |
| `TURN_MAX_STEPS`         | `12`                 | Maximum model calls per turn, including summary and preparation calls.              |
| `TURN_MAX_DURATION`      | `2m`                 | Maximum response time per turn.                                                     |
| `SHUTDOWN_GRACE`         | `20s`                | Time that running turns get to finish at shutdown.                                  |

Durations use units `h`, `m`, `s` and `ms`, for example `12h35m` or `750ms`.

### Skills and instructions

| Variable     | Description                                               |
| ------------ | --------------------------------------------------------- |
| `SKILLS_DIR` | Mounted git checkout of the skills repository (required). |

The harness reads committed files at `HEAD`, so each turn keeps the revision it started with. The external deployment process updates the checkout. The repository must have `AGENTS.md` at its root (the repository instructions) and skill folders that each hold a `SKILL.md` in the [Agent Skills](https://agentskills.io/specification) format. The agent reads skills with the built-in `read_skill` tool. It can read only files inside skill folders. `/health` lists skill problems (invalid, duplicate or blocked skills).

Country markup: `my[...]` and `ph[...]` for short text, and `:::my` / `:::ph` blocks that end with `:::`. Only the `COUNTRY` content and common content reach the agent.

### Handoff

The agent hands off with the built-in `handoff_to_colleague` tool. The harness hands off by itself when a turn fails or times out while the agent owns the conversation. Both write an internal note and apply the labels `handoff` and `out-of-scope` (tool) or `handoff` and `error` (harness). On respond.io, workflows then pick the operator. On Telegram, the conversation pauses until `/resume`.

### Delivery

| Variable                      | Default      | Alternatives                                                       |
| ----------------------------- | ------------ | ------------------------------------------------------------------ |
| `DELIVERY_BOUNDARY`           | `paragraph`  | `line`, `whole`                                                    |
| `DELIVERY_TIMING`             | `stream`     | `complete` (send after the full answer is ready)                   |
| `DELIVERY_PACING`             | `fixed`      | `typing`, `none`                                                   |
| `DELIVERY_PAUSE`              | `750ms`      | Pause before each message for `fixed` pacing.                      |
| `DELIVERY_TYPING_PER_WORD`    | `1s`         | Pace per word for `typing` pacing. The first message has no delay. |
| `DELIVERY_STRIP_FINAL_PERIOD` | `true`       | `false` keeps the original punctuation.                            |
| `VIDEO_LINK_PREFIXES`         | (none)       | Comma-separated URL prefixes of approved company videos.           |
| `VIDEO_LINKS_AS`              | `attachment` | `text`                                                             |
| `VIDEO_SURROUNDING_TEXT`      | `replace`    | `separate` (send the text as its own message)                      |

### Nudges and expiry

| Variable               | Default                 | Description                                                                  |
| ---------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `NUDGES_ENABLED`       | `true`                  | Automatic nudges.                                                            |
| `EXPIRY_ENABLED`       | `true`                  | Automatic expiry.                                                            |
| `NUDGE_CHECK_INTERVAL` | `5m`                    | Time between checks.                                                         |
| `NUDGE_MILESTONES`     | `5m,35m,12h35m,12h45m`  | Times after the latest real customer message.                                |
| `NUDGE_HOURS`          | `0-24`                  | Permitted local hours for nudges, `<from>-<to>`.                             |
| `EXPIRY_AFTER`         | `13h45m`                | Expiry threshold after the latest real customer message.                     |
| `EXPIRY_EXEMPT_LABEL`  | `out-of-scope-unsolved` | Label that prevents expiry. It does not stop nudges.                         |
| `NUDGE_INSTRUCTION`    | `Nudge`                 | Text of the internal note and of the prompt that asks the agent to continue. |

Each check makes at most one attempt per conversation. Before an action, the harness gets the current ownership from the channel when the channel can give it (respond.io). `/health` shows the time of the last check.

### Channel connections

`CONNECTIONS` is a comma-separated list of connection names (lowercase letters, digits and `_`). Each connection has variables with the prefix `CONNECTION_<NAME>_`, for example `CONNECTION_MAIN_TYPE`. A connection that is not in the list needs no credentials.

#### respond.io (`TYPE=respondio`)

| Variable               | Description                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `API_TOKEN`            | Developer API access token (required).                                                                          |
| `API_URL`              | API base URL. Default `https://api.respond.io/v2`.                                                              |
| `AGENT_USER_ID`        | The respond.io user that represents the agent (required). Assignment to this user gives ownership to the agent. |
| `CHANNEL_ID`           | Optional respond.io channel for all replies. Without it, respond.io selects the messaging route.                |
| `WEBHOOK_SIGNING_KEYS` | Comma-separated signing keys, one for each respond.io webhook that points to the harness (required).            |

The base respond.io MCP connection (optional) belongs to the same connection:

| Variable       | Default                                                      | Description                                                                             |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `MCP_URL`      | (none)                                                       | HTTP address of the self-hosted respond.io MCP server. Set it to enable the connection. |
| `MCP_TOKEN`    | (required with `MCP_URL`)                                    | Static bearer token for the MCP server.                                                 |
| `MCP_TOOLS`    | `get_contact,create_comment,add_contact_tags,update_contact` | Permitted provider tools.                                                               |
| `MCP_LABELS`   | `handoff,out-of-scope`                                       | Labels that the agent can add or remove.                                                |
| `MCP_FIELDS`   | `firstName,lastName,language`                                | Contact fields that the agent can edit.                                                 |
| `MCP_STATUSES` | (none)                                                       | Conversation status changes that the agent can make, for example `close`.               |

The tools act only on the current contact: the harness removes the `identifier` argument from each tool and fills in the current contact. Tools without an `identifier` argument, and `send_message`, are refused at startup. Disallowed labels, fields and status changes are rejected without a call to the server. The harness tells the agent to edit profile fields only with values that the customer supplied or confirmed. It cannot verify this.

In respond.io, add webhooks to `https://<host>/webhooks/<name>` for the events New Incoming Message, New Outgoing Message, Contact Assignee Updated, Conversation Opened and Conversation Closed. The harness rejects notifications with a wrong `X-Webhook-Signature`. Replies use the messaging route that respond.io selects. Internal notes become respond.io comments, and labels become contact tags.

#### Telegram (`TYPE=telegram`)

| Variable           | Description                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| `BOT_TOKEN`        | Bot token (required).                                                         |
| `API_ROOT`         | Bot API root. Default `https://api.telegram.org`.                             |
| `OPERATOR_CHAT_ID` | Optional chat that gets handoff notifications and can send operator commands. |

The adapter uses long polling, so it needs no public URL. Telegram has no assignment, notes or labels. The harness keeps these in the chat folder. In the operator chat, operators can send:

- `/pause <chat>` and `/resume <chat>`: give the conversation to a human or back to the agent.
- `/close <chat>` and `/open <chat>`: close or reopen the conversation.
- `/label <chat> <label>` and `/unlabel <chat> <label>`: add or remove a local label.

### MCP servers

`MCP_SERVERS` is a comma-separated list of server names. Each server has the variables `MCP_<NAME>_URL` (HTTP transport), `MCP_<NAME>_TOKEN` (optional bearer token) and `MCP_<NAME>_TOOLS` (required list of permitted tools). The agent sees a tool as `<name>__<tool>`. A server name must not be the name of a channel connection. The harness connects at startup and does not start when a server or a permitted tool is not available.

## Chat folder format

`DATA_DIR/<connection>/<chat>/` holds one conversation:

- `chat.txt`: the record, one JSON object per line, in sent-time order.
- `state.json`: ownership, open state, local labels and pending work. When it is missing, the conversation is open and agent-owned.
- `summary.txt`: the latest dated summary.
- `attachments/`: the original files.

External migration tools can write folders in this format. The harness reads them at startup and does not treat their messages as new requests.

## Platform limits

- The respond.io API gives no reliable message history for reconciliation. After a restart, the harness gets the current ownership of a conversation before it nudges or expires it, and uses its own record for activity. respond.io retries webhooks for some minutes; messages from a longer outage are not imported.
- Chat completion APIs do not accept files in assistant messages. When an operator or workflow file goes directly to the main call, the harness keeps the operator message on the assistant side and sends the file in a user-side message that names the original sender.
- Telegram gives message times with second precision. When a message arrives in the same second as its time, the harness uses the receive time, so that the order stays correct.

## Checks

Run `bun check` before you report work done and before each commit. It runs the formatter check, the linter (with type checks) and all tests.

## Tests

- Unit tests are next to the code as `*.test.ts`.
- End-to-end tests are in the top-level `e2e/` folder. A test starts the application as a process with environment variables and a temporary data folder. It uses only the HTTP routes, the data folder, and the network calls of the application.
- Fake HTTP servers replace the channel platforms, the model gateway, and the MCP servers. Each fake records the calls it receives.
- Set `E2E_VERBOSE=1` to print the application logs during end-to-end tests.
