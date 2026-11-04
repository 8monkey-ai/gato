# gato

gato is a conversation harness. An AI agent and human operators use it to serve the same customers. It receives
customer messages from respond.io and Telegram, keeps a lasting record of each chat, decides when the agent
answers, and sends the replies. It also sends follow-up messages ("nudges"), expires inactive chats, and hands
chats to human operators. `SPECS.md` gives the full required behavior.

The harness is one Bun process. It keeps all state in a data folder, reads instructions from a mounted skills
checkout, and calls models through OpenRouter.

## Run with Docker

```sh
docker build -t gato .
docker run -d --name gato \
  -p 3000:3000 \
  -v /srv/gato/data:/data \
  -v /srv/gato/skills:/skills:ro \
  -e GATO_SKILLS_DIR=/skills \
  -e GATO_COUNTRY=MY \
  -e OPENROUTER_API_KEY=... \
  -e GATO_MODEL=openai/gpt-4o \
  -e GATO_CONNECTIONS=support \
  -e GATO_CONNECTION_SUPPORT_TYPE=telegram \
  -e GATO_CONNECTION_SUPPORT_BOT_TOKEN=... \
  gato
```

The image sets `GATO_DATA_DIR=/data` but has no `/data` folder and no volume. Mount a data folder at `/data`.
Without a mount the harness stops with "Data folder does not exist", so it never writes chats to a folder
that is lost with the container.

The process runs as user `bun` (uid 1000), so that user must be able to write the mounted folder. Give the
folder to uid 1000 (`chown -R 1000:1000 /srv/gato/data`), or run the container as the owner of the folder
with `--user "$(id -u):$(id -g)"`. Only one process can use a data folder at a time: the harness keeps a lock
file `.gato.lock` in it. Run one container for each country.

At startup the harness checks the configuration, the data folder, the instructions, the summary prompt, the
model ids, and the MCP servers. If a check fails, it writes one error line to standard output and stops with
exit code 1. An invalid configuration gives one error that names every bad variable and the accepted values.

On `SIGTERM` or `SIGINT` the harness stops new work, lets running turns finish within `GATO_SHUTDOWN_GRACE`,
and then stops. Unfinished work stays in the chat folders and continues after the next start.

To run without Docker: `bun install`, then `bun src/main.ts` with the same environment variables.

## Environment variables

Durations use the forms `750ms`, `2s`, `5m`, `12h35m`. Lists are separated by commas. `<ID>` is a connection or
server id in upper case, with `-` changed to `_` (connection `my-shop` uses `GATO_CONNECTION_MY_SHOP_...`).

### Core

| Variable              | Default  | Description                                                           |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `PORT`                | `3000`   | HTTP port.                                                            |
| `GATO_DATA_DIR`       | required | Data folder. Must exist and be writable. The image sets `/data`.      |
| `GATO_SKILLS_DIR`     | required | Skills checkout (see "Skills checkout").                              |
| `GATO_COUNTRY`        | required | `MY` or `PH`. Selects the country content of the instructions.        |
| `GATO_TIMEZONE`       | `UTC`    | IANA time zone for dates, summaries, history windows and nudge hours. |
| `GATO_SHUTDOWN_GRACE` | `10s`    | Time that running turns get to finish at shutdown.                    |

### Models and limits

| Variable                    | Default                             | Description                                                                                                      |
| --------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`        | required                            | OpenRouter API key.                                                                                              |
| `GATO_MODEL`                | required                            | Base model id, for example `openai/gpt-4o`.                                                                      |
| `GATO_SUMMARY_MODEL`        | the base model                      | Model for contact summaries.                                                                                     |
| `GATO_SUMMARY_PROMPT_FILE`  | `prompts/summary.md` of the harness | Summary prompt file. A file set here must exist.                                                                 |
| `GATO_IMAGE_MODEL`          | unset                               | Model that describes images. Unset: see "Attachments".                                                           |
| `GATO_DOCUMENT_MODEL`       | unset                               | Model that reads documents. Unset: see "Attachments".                                                            |
| `GATO_AUDIO_MODEL`          | unset                               | Model that transcribes audio. Unset: see "Attachments".                                                          |
| `GATO_TURN_TIMEOUT`         | `2m`                                | Maximum time of one turn, summary and preparation included.                                                      |
| `GATO_TURN_MAX_MODEL_CALLS` | `12`                                | Maximum model calls of one turn, summary and preparation included.                                               |
| `GATO_OWNERSHIP_POLICY`     | `assigned`                          | `assigned`: answer only chats assigned to the agent. `shared`: also unassigned chats. `unrestricted`: all chats. |

At startup the harness checks every configured model id against the OpenRouter model list. An unknown id stops
startup. If OpenRouter cannot be reached, startup continues and `/health` shows `"models": "unverified"`.

### Attachments

The harness keeps the original file of each image, document and audio attachment in the chat folder. For each
of the three categories, a preparation model (`GATO_IMAGE_MODEL`, `GATO_DOCUMENT_MODEL`, `GATO_AUDIO_MODEL`)
can turn the file into text. The text then replaces the file in the model input, and the harness saves it for
later turns.

Without a preparation model, a customer file goes directly to the base model. An operator or workflow file
cannot go directly: it is on the agent side of the conversation, and the OpenRouter provider drops files on
that side. A turn whose history holds an operator or workflow file of a category without a preparation model
fails with an error handoff, also when the file is from an earlier part of the chat. At startup the harness
logs one warning for each category without a preparation model. Set the preparation models for the categories
that your operators and workflows send.

### History

| Variable                     | Default | Description                                                                      |
| ---------------------------- | ------- | -------------------------------------------------------------------------------- |
| `GATO_HISTORY_SCOPE`         | `chat`  | `chat`: the whole chat. `recent-month`: the last calendar month of the contact.  |
| `GATO_INCLUDE_TOOL_ACTIVITY` | `true`  | Include earlier tool calls, tool results and nudge prompts in the model context. |

### Delivery

| Variable                         | Default      | Description                                                                                      |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `GATO_DELIVERY_BOUNDARY`         | `paragraph`  | Split a reply into messages at `paragraph`, `line`, or `whole` (no split).                       |
| `GATO_DELIVERY_TIMING`           | `stream`     | `stream`: send each part when it is complete. `complete`: send after the full reply.             |
| `GATO_DELIVERY_PACING`           | `fixed`      | `fixed`: pause before each message. `typing`: pause per word. `none`: no pause.                  |
| `GATO_DELIVERY_PAUSE`            | `750ms`      | Pause for `fixed` pacing.                                                                        |
| `GATO_DELIVERY_PER_WORD`         | `1s`         | Pause per word for `typing` pacing. The first message has no pause.                              |
| `GATO_DELIVERY_STRIP_FINAL_STOP` | `true`       | Remove one final full stop from each message.                                                    |
| `GATO_VIDEO_LINK_PREFIXES`       | empty        | URL prefixes of approved company videos.                                                         |
| `GATO_VIDEO_LINK_MODE`           | `attachment` | Send approved video links as `attachment` or as `text`.                                          |
| `GATO_VIDEO_SURROUNDING_TEXT`    | `replace`    | `replace`: the video replaces the message text. `separate`: send the text as a separate message. |

### Nudges and expiry

| Variable                    | Default                 | Description                                         |
| --------------------------- | ----------------------- | --------------------------------------------------- |
| `GATO_NUDGES_ENABLED`       | `true`                  | Send nudges.                                        |
| `GATO_EXPIRY_ENABLED`       | `true`                  | Expire inactive chats.                              |
| `GATO_NUDGE_CHECK_INTERVAL` | `5m`                    | Time between checks.                                |
| `GATO_NUDGE_CONCURRENCY`    | `4`                     | Most state fetches, nudges and expiries at once.    |
| `GATO_NUDGE_MILESTONES`     | `5m,35m,12h35m,12h45m`  | Nudge times after the latest customer message.      |
| `GATO_NUDGE_HOURS`          | `00:00-24:00`           | Hours in which nudges are permitted, `HH:MM-HH:MM`. |
| `GATO_NUDGE_PROMPT`         | `Nudge`                 | Internal prompt that asks the agent to continue.    |
| `GATO_EXPIRY_AFTER`         | `13h45m`                | Expiry time after the latest customer message.      |
| `GATO_EXPIRY_EXEMPT_LABEL`  | `out-of-scope-unsolved` | A chat with this label does not expire.             |

### Labels

| Variable                  | Default        | Applied on                  |
| ------------------------- | -------------- | --------------------------- |
| `GATO_LABEL_HANDOFF`      | `handoff`      | every handoff               |
| `GATO_LABEL_OUT_OF_SCOPE` | `out-of-scope` | a handoff by the agent tool |
| `GATO_LABEL_ERROR`        | `error`        | a handoff after an error    |
| `GATO_LABEL_EXPIRED`      | `expired`      | a handoff after expiry      |

### Connections

| Variable                    | Default  | Description                           |
| --------------------------- | -------- | ------------------------------------- |
| `GATO_CONNECTIONS`          | required | Connection ids, for example `rio,tg`. |
| `GATO_CONNECTION_<ID>_TYPE` | required | `telegram` or `respondio`.            |

Telegram (`GATO_CONNECTION_<ID>_...`):

| Variable             | Default  | Description                                             |
| -------------------- | -------- | ------------------------------------------------------- |
| `BOT_TOKEN`          | required | Bot token from BotFather.                               |
| `OPERATOR_CHAT_ID`   | unset    | Telegram chat that receives handoff notifications.      |
| `POLL_RESTART_DELAY` | `5s`     | Wait before polling starts again after a failed update. |

respond.io (`GATO_CONNECTION_<ID>_...`):

| Variable              | Default                                                      | Description                                                                           |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `API_TOKEN`           | required                                                     | Developer API access token.                                                           |
| `SIGNING_KEYS`        | required                                                     | Signing keys of the webhooks, one for each webhook.                                   |
| `AGENT_USER_ID`       | required                                                     | respond.io user id of the agent. Assignment to this user gives the chat to the agent. |
| `CHANNEL_ID`          | unset                                                        | Channel for replies. Unset: the channel that the contact used last.                   |
| `API_URL`             | `https://api.respond.io/v2`                                  | API base URL.                                                                         |
| `MAX_TEXT_LENGTH`     | `4096`                                                       | Longer messages are split.                                                            |
| `MCP_ENABLED`         | `false`                                                      | Give the agent the respond.io MCP contact tools.                                      |
| `MCP_URL`             | `https://mcp.respond.io/mcp`                                 | MCP server URL.                                                                       |
| `MCP_TOKEN`           | required when MCP is enabled                                 | Bearer token for the MCP server.                                                      |
| `MCP_TOOLS`           | `get_contact,create_comment,add_contact_tags,update_contact` | Permitted MCP tools. The agent sees them as `respondio_<name>`.                       |
| `MCP_EDITABLE_FIELDS` | `firstName,lastName,language`                                | Contact fields that `update_contact` can change.                                      |
| `MCP_EXTRA_LABELS`    | empty                                                        | Labels that the agent can add, in addition to the handoff and out-of-scope labels.    |
| `MCP_STATUS_CHANGES`  | empty                                                        | Permitted conversation status changes: `open`, `close`.                               |

### MCP servers

| Variable                  | Default                       | Description                                                                 |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `GATO_MCP_SERVERS`        | empty                         | MCP server ids.                                                             |
| `GATO_MCP_<ID>_TRANSPORT` | `http`                        | `http` (Streamable HTTP), `sse`, or `stdio`.                                |
| `GATO_MCP_<ID>_URL`       | required for `http` and `sse` | Server URL.                                                                 |
| `GATO_MCP_<ID>_TOKEN_ENV` | unset                         | Name of a variable that holds a bearer token. Not permitted for `stdio`.    |
| `GATO_MCP_<ID>_COMMAND`   | required for `stdio`          | Command that starts the server. It must exist in the container.             |
| `GATO_MCP_<ID>_ARGS`      | empty                         | Command arguments.                                                          |
| `GATO_MCP_<ID>_TOOLS`     | required                      | Permitted tool names, or `*` for all. The agent sees them as `<id>_<name>`. |

A server that is not available, or that does not offer a permitted tool, stops startup.

### Operations

| Variable         | Default | Description                                                    |
| ---------------- | ------- | -------------------------------------------------------------- |
| `GATO_OPS_TOKEN` | unset   | Bearer token of the `/ops/...` endpoints. Unset: no endpoints. |

## respond.io setup

1. In Settings > Integrations > Developer API, add an access token. Set it as `API_TOKEN`.
2. In Settings > Integrations > Webhooks, add one webhook for each of these five events. Use the URL
   `https://<your host>/respondio/<connection id>` for all of them:
   - New Incoming Message (`message.received`)
   - New Outgoing Message (`message.sent`)
   - Contact Assignee Updated (`contact.assignee.updated`)
   - Conversation Opened (`conversation.opened`)
   - Conversation Closed (`conversation.closed`)
3. Each webhook has its own signing key. Put all five keys in `SIGNING_KEYS`, separated by commas. A request
   with no valid signature gets status 401.
4. Create or select the respond.io user that represents the agent. Set its user id as `AGENT_USER_ID`. The agent
   answers a chat when the chat is assigned to this user (with the default ownership policy). Use respond.io
   workflows to assign chats to the agent and to route handoffs to human operators.

The harness saves each event before it answers the webhook. A repeated event (same event id) has no effect.

## Telegram setup

1. Create a bot with BotFather and set its token as `BOT_TOKEN`.
2. Optional: add the bot to an operator group and set the group's chat id as `OPERATOR_CHAT_ID`. Handoff
   notifications go to this chat. The bot ignores messages in this chat.

The bot uses long polling; it needs no public URL. Telegram has no assignment, notes or labels, so the harness
keeps them in the chat folder (see "Operator actions").

## Skills checkout

```
<GATO_SKILLS_DIR>/
  AGENTS.md                  instructions for every turn (required)
  skills/<name>/SKILL.md     one skill: front matter with name and description, then the body
  skills/<name>/...          references of the skill, read on demand
```

The `name` in `SKILL.md` must be 1 to 64 lowercase letters, digits and single hyphens, and must match the
directory name. The agent sees the name and description of each skill and reads skill files with the
`read_skill` tool. Files larger than 256 KiB are not loaded.

Country markup removes content for the other country before the agent sees it:

```markdown
Common text. my[Malaysia only text.] ph[Philippines only text.]

:::my
Malaysia only block.
:::

:::ph
Philippines only block.
:::
```

Country sections cannot be nested. A file with bad markup is not used, and the problem is logged. If
`AGENTS.md` is missing or bad, the harness does not start, and turns that find it bad fail with an error
handoff. Each turn reads the checkout again, so updates apply to the next turn.

## Chat folders

Each chat has the folder `<GATO_DATA_DIR>/<connection id>/<chat id>/`. A chat id contains only letters, digits,
`_` and `-` (1 to 128 characters). The adapters use the numeric respond.io contact id and the Telegram chat id.

| File            | Content                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.jsonl`  | The record: one JSON entry per line, append only. This is the source of truth.                                                                      |
| `chat.txt`      | Readable transcript, written again after each change.                                                                                               |
| `summary.txt`   | Latest contact summary: `Generated: <ISO time>`, a blank line, then the text.                                                                       |
| `attachments/`  | Original files of attachments.                                                                                                                      |
| `instructions/` | `<revision>.md`: repository instructions and skill catalogue of each revision that a turn used.                                                     |
| `paused`        | Operator file. If it exists, a human owns the chat and the agent does not answer or nudge it under any ownership policy. The content is the reason. |
| `closed`        | Operator file. If it exists, the chat is closed.                                                                                                    |
| `labels.txt`    | Labels, one per line. The harness adds lines; operators can edit it.                                                                                |
| `merged-into`   | Written by a merge. Contains the id of the chat that received the history. The chat is closed.                                                      |

`paused`, `closed` and `labels.txt` apply only to connections without native assignment and labels (Telegram).
respond.io keeps these in respond.io.

A damaged line in `events.jsonl` marks the chat as damaged. The harness reports it in the logs and in
`/health`, still shows the readable lines, and starts no agent work for the chat until an operator repairs the
file and restarts the harness.

Migration tools can write chat folders in the same format. They must write `events.jsonl` entries without
`eventId`. The harness then treats migrated customer messages as history and does not answer them.

## Operator actions

Pause a Telegram chat (the agent stops answering and nudging):

```sh
echo "Ana handles this" > /srv/gato/data/tg/123456/paused
```

Resume it: delete the `paused` file. Close and reopen work the same way with the `closed` file. The next nudge
check sees the change: the agent then answers a waiting customer message, or records a note that no request
waits.

Endpoints (only when `GATO_OPS_TOKEN` is set):

```sh
# Health: 200 when ready, else 503. No token needed.
curl http://localhost:3000/health

# State of every chat: owner, open, pending input, damaged, latest turn, failed/pending/uncertain parts.
curl -H "Authorization: Bearer $GATO_OPS_TOKEN" http://localhost:3000/ops/chats

# Failed nudges since a time.
curl -H "Authorization: Bearer $GATO_OPS_TOKEN" \
  "http://localhost:3000/ops/nudges/failed?since=2026-11-01T00:00:00Z"

# Retry the failed nudges that are still eligible.
curl -X POST -H "Authorization: Bearer $GATO_OPS_TOKEN" \
  -d '{"since":"2026-11-01T00:00:00Z"}' http://localhost:3000/ops/nudges/retry

# Merge the history of chat 111 into chat 222 of the same connection.
curl -X POST -H "Authorization: Bearer $GATO_OPS_TOKEN" \
  -d '{"connectionId":"rio","fromChatId":"111","intoChatId":"222"}' http://localhost:3000/ops/merge
```

The `/health` body contains `ready`, `storage`, `damagedChats`, `connections` (with `started` and
`healthy`), `mcpServers`,
`models` (`verified`, `unverified` or `not checked`) and `nudges` (reconciled and unreconciled chats, time of
the last check). A respond.io chat is reconciled after the harness has read its assignment from respond.io
once since startup. Nudges start only for reconciled chats.

Logs are JSON lines on standard output. Tokens, keys, message text, phone numbers and e-mail addresses are
redacted.

## Known limits

- respond.io sends no webhook for a contact merge. To merge two chats, call `POST /ops/merge`.
- The tool names of the hosted respond.io MCP server are not public. `MCP_TOOLS` defaults to the tool names of
  the legacy respond.io MCP server. Check the names that your server offers and set `MCP_TOOLS` to match.
- Telegram does not show messages that operators send from other clients, so the record of a Telegram chat has
  only customer messages and the bot's own messages.
