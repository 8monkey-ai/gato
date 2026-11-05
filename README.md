# gato

A conversation harness. It lets an agent and human operators serve the same customer on respond.io and Telegram. `SPECS.md` gives the required behavior.

## Run

```sh
bun install
bun start
```

The application reads its configuration from environment variables. It writes all conversation data to `DATA_DIR`. The health route `GET /health` gives readiness (status 200 when ready, 503 when not ready) and lists damaged histories.

## Configuration

### Core

| Variable              | Default    | Description                                                            |
| --------------------- | ---------- | ---------------------------------------------------------------------- |
| `DATA_DIR`            | (required) | Folder for the chat folders. Mount it outside the container.           |
| `COUNTRY`             | (required) | `MY` or `PH`.                                                          |
| `TIMEZONE`            | `UTC`      | IANA timezone for dates, summaries, history windows and nudge hours.   |
| `PORT`                | `3000`     | HTTP port for webhooks and `/health`.                                  |
| `OPENROUTER_API_KEY`  | (required) | Key for the AI gateway.                                                |
| `OPENROUTER_BASE_URL` | OpenRouter | Base URL of an OpenRouter-compatible gateway.                          |
| `MODEL`               | (required) | Base conversation model.                                               |
| `OWNERSHIP_POLICY`    | `assigned` | `assigned`, `shared` or `unrestricted`.                                |
| `TURN_MAX_STEPS`      | `12`       | Maximum model calls per turn, including summary and preparation calls. |
| `TURN_MAX_DURATION`   | `2m`       | Maximum response time per turn.                                        |
| `SHUTDOWN_GRACE`      | `20s`      | Time that running turns get to finish at shutdown.                     |

Durations use units `h`, `m`, `s` and `ms`, for example `12h35m` or `750ms`.

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

### Channel connections

`CONNECTIONS` is a comma-separated list of connection names (lowercase letters, digits and `_`). Each connection has variables with the prefix `CONNECTION_<NAME>_`, for example `CONNECTION_MAIN_TYPE`. A connection that is not in the list needs no credentials.

#### respond.io (`TYPE=respondio`)

| Variable               | Description                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `API_TOKEN`            | Developer API access token (required).                                                                          |
| `API_URL`              | API base URL. Default `https://api.respond.io/v2`.                                                              |
| `AGENT_USER_ID`        | The respond.io user that represents the agent (required). Assignment to this user gives ownership to the agent. |
| `WEBHOOK_SIGNING_KEYS` | Comma-separated signing keys, one for each respond.io webhook that points to the harness (required).            |

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

## Chat folder format

`DATA_DIR/<connection>/<chat>/` holds one conversation:

- `chat.txt`: the record, one JSON object per line, in sent-time order.
- `state.json`: ownership, open state, local labels and pending work. When it is missing, the conversation is open and agent-owned.
- `summary.txt`: the latest dated summary.
- `attachments/`: the original files.

External migration tools can write folders in this format. The harness reads them at startup and does not treat their messages as new requests.

## Platform limits

- Telegram gives message times with second precision. When a message arrives in the same second as its time, the harness uses the receive time, so that the order stays correct.

## Checks

Run `bun check` before you report work done and before each commit. It runs the formatter check, the linter (with type checks) and all tests.

## Tests

- Unit tests are next to the code as `*.test.ts`.
- End-to-end tests are in the top-level `e2e/` folder. A test starts the application as a process with environment variables and a temporary data folder. It uses only the HTTP routes, the data folder, and the network calls of the application.
- Fake HTTP servers replace the channel platforms, the model gateway, and the MCP servers. Each fake records the calls it receives.
- Set `E2E_VERBOSE=1` to print the application logs during end-to-end tests.
