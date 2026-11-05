# Conversation harness

## Purpose

The harness lets an agent and human operators serve the same customer, with a shared, lasting record of the conversation. It receives messages, decides when the agent should respond, supplies the right history and instructions, and delivers replies. Operators can take over and later return the conversation to the agent without losing context where the channel supports it. Supported channels are respond.io and Telegram, independently or at the same time.

The harness is a single TypeScript application running on Bun, using the Vercel AI SDK and a stateless AI gateway such as OpenRouter. Conversation management, channel adapters, history, skills, agent execution, delivery, and nudges are distinct internal responsibilities. External tools connect through configurable MCP servers.

Channel adapters handle their platform's accounts, incoming messages, the platform state that the harness needs, attachments, delivery, and handoff where the platform supports it. Platform-specific behavior, including respond.io behavior, belongs within its adapter. An additional or replacement channel requires its own adapter, without rewriting history, skills, agent execution, or nudge logic. Operators enable one or more available channel adapters and their account connections through configuration; disabled connections require no credentials or running services.

This specification is the source of truth for required product behavior and architecture, and the reference for development, acceptance, and future changes. Integration details follow the upstream [respond.io documentation](https://developers.respond.io/), [Telegram Bot API documentation](https://core.telegram.org/bots/api), and [MCP documentation](https://modelcontextprotocol.io/docs/getting-started/intro).

## 1. Channels and conversation records

A conversation belongs to a configured channel connection and account. Contacts with matching identifiers on different connections remain isolated. Within a respond.io connection, a contact has one continuing conversation even when messages arrive through different physical messaging channels.

Telegram connects through a configured bot, with each chat keeping its own history and reply destination. Both channels use the same history, attachment preparation, skills, generation, interruption, and nudge rules. Enabling Telegram does not require respond.io or its MCP connection.

The conversation record includes incoming customer messages and everything sent by human operators, workflows, and the agent. In particular, messages sent directly by an operator in respond.io—including captions, images, documents, audio, video, and other attachments—are available to future agent turns. Recording continues whoever owns the conversation, preserving sender attribution and attachment references.

Each enabled adapter receives messages, authenticates its notifications, and presents them to the shared conversation service. An adapter subscribes only to the platform notifications without which a requirement in this specification cannot be met. Platform state that arrives with those notifications is read from them. When the harness needs platform state at another time, it asks the platform. For respond.io, message notifications are sufficient. Accepted work is saved before acknowledging receipt. Repeated notifications must not duplicate messages or actions, and outgoing messages must not trigger another answer. Malformed notifications are logged without running the agent; irrelevant notifications are ignored.

History follows original sent-time order. A delayed message belongs at its original place in the conversation, without moving the latest activity backwards. Uncertain sender identity remains explicit in the record.

### Channel capabilities and fallbacks

Each adapter declares which features it supports. Missing platform features must not prevent ordinary conversations or be mistaken for integration failures. The following fallbacks apply, including for a standard Telegram bot connection:

| Unavailable channel feature         | Behavior                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator or workflow message events | The record includes all messages the adapter can observe and its own sends, without waiting for or inventing unavailable events. Telegram does not require an operator inbox or operator-message listener |
| Internal notes                      | These remain private in the chat folder, including nudge activity; they are never sent to the customer                                                                                                    |

Native channel capabilities take precedence when available. A supported feature that fails still follows its failure policy; it is not silently treated as unsupported. On a channel with no assignment, nudge readiness does not wait for remote state.

### Message classification

Message type, sender attribution, delivery state, and role in model context are distinct. In respond.io, classification follows this order: incoming traffic is customer content; outgoing workflow traffic is workflow content; other outgoing traffic from an API or the configured bot user is agent content; remaining outgoing traffic is operator content. An unidentified outgoing sender retains unknown attribution within the operator category. In Telegram, customer messages are user-side and the harness bot's confirmed sends are agent-side; unavailable operator or workflow contributions are never fabricated. Each adapter classifies only what its platform information establishes.

| Message type                            | What it represents                                                        | Use in model context                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Customer / user                         | Incoming content from the contact, including attachments                  | User-side content; may trigger a reply when ownership permits                                                          |
| Human operator                          | Outgoing content from a person in the team inbox                          | Assistant-side history, explicitly attributed to a human colleague; never triggers a reply                             |
| Workflow                                | Outgoing content from a platform workflow                                 | Assistant-side history with workflow attribution; never triggers a reply                                               |
| Agent                                   | Generated agent output, or outgoing traffic classified as agent-origin    | Assistant-side conversation only for content known to have been sent; channel echoes reconcile to the original message |
| Tool request                            | An action the agent asks a tool to perform                                | Assistant-side and private, linked to its result, and used only in the turn that makes it                              |
| Tool result                             | A tool's answer or execution error                                        | Tool-side context linked to its request, used only in the turn that makes it; not a customer or operator message       |
| Internal note, error, or handoff record | Harness notes such as nudge notes, diagnostics, and handoff reasons/state | Internal record, excluded from ordinary conversation history supplied to the model                                     |
| Instructions                            | System, profile, and skill instructions                                   | Private instruction context, not a participant's conversation message                                                  |
| Summary                                 | Dated contact memory                                                      | Private assistant-side context supplied before the selected conversation, not a delivered agent message                |

A nudge's artificial prompt uses user-side input to request continuation, but is marked as an internal trigger: it is not a real customer message or customer activity. Tool failures remain tool results unless the conversation ultimately fails; they are not automatically error handoffs. If a handoff acknowledgement is deliberately delivered to the customer, that delivered text is an agent message, separate from the private handoff record.

## 2. Ownership and response eligibility

Ownership determines whether a conversation is recorded only or also answered. The agent answers when the conversation is assigned to the configured agent user or to no one. This specification calls such a conversation agent-owned. A conversation assigned to a human operator is human-owned and is history only. On a channel with no assignment, every conversation counts as assigned to no one.

When the conversation returns to the agent, the agent answers at the next eligible customer message; the return itself sends no reply.

Two events have deliberately different effects on a reply already in progress:

- **A human takes ownership:** the current reply finishes, including its remaining parts. No further replies or nudges start until the conversation is agent-owned again. Recording of the human's contributions continues.
- **A new customer message arrives:** the reply is interrupted and its remaining parts stop, including messages waiting for a pacing delay. Superseded generation and pending actions stop where possible. A send already in progress may still arrive; its outcome remains recorded.

After an interruption, the next eligible turn uses the messages already delivered together with all newly received customer input. It must not replay delivered parts or continue the obsolete unsent remainder. Further customer input follows the same interruption rule.

The conversation the agent sees matches the conversation the customer sees: what the customer sees last is also the last visible conversation content in the agent's context. Context includes all received customer messages and known sent agent, operator, and workflow messages in the channel-visible order where available, using original sent times otherwise. Generation time alone does not establish that a message was sent. Customer messages are not moved artificially to the end, and unsent drafts are not included to make the sequence convenient for generation. Private instructions, summaries, and tool activity do not count as visible conversation messages.

Small timing differences are acceptable while a send is already on its way. Later channel information confirming what was sent updates the record and the view used for subsequent turns. Original event times and the distinction between confirmed and uncertain delivery remain preserved.

Only one turn runs per conversation at a time. Other conversations can progress independently.

## 3. Messages and attachment preparation

Ordinary message text, captions, and supplied descriptions stay with the message. For each supported attachment category, deployment can independently configure a preparation model:

| Category                         | Optional model's task                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| Images, including image stickers | Read the image and describe it as text                             |
| Documents, including PDFs        | Read the document and return its textual content or interpretation |
| Audio, including voice notes     | Transcribe the audio as text                                       |

The same rule applies to all three categories:

- **No preparation model configured for that category:** the original file is attached to the main generation call, with no extra model call for that attachment.
- **Preparation model configured:** the attachment goes to that model first. Its actual text response replaces the file in the original message within the main prompt. Accompanying text, original attribution, time, and the stored attachment reference remain intact. This is a representation of the same message, not a new user or assistant message.

These choices are independent: an operator can, for example, transcribe audio separately while passing images and documents directly to the main model. They apply to customer, operator, and workflow attachments while preserving the original participant's role. Preparation calls count toward the turn's response/work limits.

Original files remain stored in either mode. Preparation results are saved with their source attachments for reuse in later turns, distinguishing original participant text from model-produced interpretation. A preparation failure, unusable response, or main model unable to handle a directly attached file is a processing failure; content is never invented and the processing path does not silently change.

Other customer content, including video, remains recorded and is identified to the agent as unsupported. Every operator attachment remains in history even when it cannot be interpreted, with available file information and that limitation visible. Recording outgoing content never triggers a reply.

Files remain in persistent storage after their download links expire. Derived text or resized model inputs never replace the originals. Invalid parts may be omitted from a model request when usable content remains, but remain represented in the saved record. Failed retrieval never removes a message or attachment reference and remains visible to operators and future agent turns.

## 4. History and memory

### The lasting conversation record

Conversation data resides in a dedicated folder that can be mounted outside the container. Each continuing chat has its own folder containing a readable, chronological chat.txt, its attachment files, and a summary.txt once a summary has been generated. summary.txt holds the latest dated summary for future turns. All durable state for that chat resides within its folder.

The harness stores only facts that it cannot learn again: the record itself, delivery outcomes, attachment preparation results, summaries, and state that no platform holds. It derives other values, such as pending work and the latest customer and agent activity, from the record. It reads state that a platform holds from that platform when needed, and does not store a copy of it. Each stored fact is stored once.

History and attachments remain stored indefinitely. Deletion requires an explicit operator request. Reassignment, interruption, and summarization never delete the record. Generated, delivered, and uncertain output remain distinguishable.

The harness loads existing chat folders on startup. Storage must be available and writable before work is accepted; a storage problem must not cause a silent switch to an empty history elsewhere. Concurrent activity must not lose records. Damaged or incomplete histories are reported while unaffected conversations continue.

Migrating existing data is a separate concern. The harness defines the chat-folder format; external migration tools write folders in that format. The harness reads compatible chat folders prepared externally, without treating migrated messages as new requests or performing a launch-time channel-history import. With no migrated history, recording begins with newly arriving messages. Checking current ownership and nudge activity at startup is separate from migration.

### What the agent sees

Model context uses the continuing chat's eligible messages in chronological order. The latest dated contact summary from summary.txt provides private context when available.

Customer, operator, and workflow contributions retain their attribution. Internal operating notes and undelivered failed or superseded output stay out of ordinary conversational context but remain available for investigation. Delivered messages remain part of the conversation even if their turn later failed or was interrupted; unsent drafts must never be presented as delivered.

Tool activity from earlier turns never reaches the model, and neither do earlier nudge prompts or internal agent instructions. The current request and relevant media always do. Tool activity stays in the record for investigation.

### Contact summaries

Summary preparation occurs as part of an eligible agent turn, under these rules:

| Situation                                        | Behavior                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Summary is less than three days old              | The saved summary is reused                                                                                 |
| No summary exists                                | Generation occurs only when the oldest available message within the recent month is at least three days old |
| Summary is three days old or older               | A refresh is attempted from the latest one calendar month of history                                        |
| No usable source history or empty summary output | The previous summary is retained if available; otherwise the reply proceeds without one                     |
| Summary generation fails                         | The failure is logged, this reply proceeds without summary context, and any saved summary remains intact    |

Summary input consists of dated customer, operator, and delivered agent content, using the configured timezone. It includes saved attachment interpretations or transcripts where available; otherwise it identifies the attachment without inventing its contents. Internal comments, tool results, undelivered failed/superseded work, and artificial nudge prompts are excluded.

Summarization uses a separate model call. Deployment can select a dedicated summary model; otherwise it uses the base conversation model. The standard summary prompt is a file in the harness repository and is the harness's built-in default; deployment configuration can supply a replacement. The default starts with “Primary Language used in this conversation:” and asks for concise, structured English continuation notes, including the customer's needs, concerns, anxieties, and unresolved work, while ignoring artificial nudges.

A successful result and its date are saved in summary.txt for reuse under the rules above; an empty or failed refresh must not overwrite the saved summary. A configured prompt or summary-model change applies when the next summary is generated and does not change refresh timing. The summary remains private, and replies maintain the customer's language and tone. Summarization leaves chat.txt and attachments complete; it does not introduce a separate length-triggered compaction policy.

## 5. Instructions and skills

Deployment identifies a mounted GitHub skills checkout. The external deployment process owns its updates; the harness reads the mounted material. Repository-level instructions and a skill catalogue are loaded, and the agent reads relevant skills before answering. The [Agent Skills specification](https://agentskills.io/specification) is the upstream format reference.

Each turn keeps the instruction revision it started with, including references read later. New turns use an updated revision. Missing, invalid, or duplicate skills are reported. Unusable required instructions cause a visible failure rather than an answer without them. Reading a skill grants access only to approved repository material, not unrelated files or program execution.

### Country-specific content

Deployment must explicitly select Malaysia (MY) or the Philippines (PH). Missing or unsupported selection prevents agent startup. That country applies to every turn and skill read; it is never inferred from the customer's phone number, language, or location. Country controls business instructions, not the language of the reply.

Authors leave common material unmarked. Short country-only text uses inline `my[...]` or `ph[...]`; longer material uses blocks:

```markdown
Common instructions for both countries.

:::my
Instructions for Malaysia only.
:::

:::ph
Instructions for the Philippines only.
:::
```

Before content reaches the agent, filtering retains common material and the selected country's content, removing other-country content and all markers. This applies to repository instructions, skill descriptions, bodies, and supporting references. A skill with an empty filtered description is hidden. Country sections cannot nest or overlap; malformed or ambiguous markup blocks use of the affected instructions.

## 6. Reply generation and delivery

A turn uses current instructions, selected history and summary, relevant skills, permitted tools, today's date, and private contact context. Internal contact identifiers must not appear in customer replies.

Deployment selects the base model, optional summary model, optional preparation models for images/documents/audio, maximum response time, and maximum work per turn, such as the number of model/tool rounds. Summary generation, preparation calls, and retries count toward the overall limits. Reaching a limit stops the turn and records the outcome. A deliberately skipped response is not a failure.

Delivery is configurable without application changes. The customer-service defaults are:

| Option                                  | Default                                                                   | Alternatives                          |
| --------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| Message boundary                        | Two newlines (`\n\n`), so each paragraph is one message                   | Another configured character sequence |
| Pacing                                  | Typing-style pacing                                                       | No added delay                        |
| Typing-style pace                       | First message immediate; later messages approximately one second per word | Another configured pace               |
| Approved company video links            | Video attachments                                                         | Text links                            |
| Text surrounding a converted video link | Replaced by the video                                                     | Separate text message                 |

Each part is sent as soon as it is complete. Delivery never waits for the full answer. Parts keep their original punctuation.

Delivery preserves message order, omits empty parts, and sends each part once. Pacing must not block generation or customer-message interruption. Failure stops remaining delivery and records which parts reached the customer. One delivery policy applies throughout a turn; changing configuration cannot replay delivered messages. Invalid settings are rejected with an actionable explanation.

Replies use the conversation's channel connection and its configured routing policy. For respond.io, the platform's selected messaging route is the default. An uncertain send outcome is logged without automatic resending, including after restart. Where the channel later reports the send, that report updates the original record without creating another send. Temporary failures are retried only when an accepted action cannot be duplicated; permanent failures must not be retried repeatedly.

Delivery adapts to the channel's capabilities without losing content or changing its order. Messages split further when platform limits require it, unsupported formatting falls back to readable text, and unsupported typing indicators are omitted while configured pacing remains. If a channel cannot send an approved video as an attachment, its original link remains as text. These capability fallbacks are chosen before sending; an uncertain send never triggers an alternative duplicate delivery.

Tools, reasoning, operating notes, and skipped-answer explanations remain private under every delivery policy. An ordinary sentence cannot itself trigger handoff. Unrelated video links remain text.

## 7. Human handoff and failure handling

There are two handoff paths:

| Reason                                                                   | Who initiates it                          | Outcome                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Knowledge or skill instructions require human help                       | The agent calls the built-in handoff tool | An English reason is saved internally; handoff and out-of-scope labels are applied |
| An unrecoverable conversation error prevents an answer while agent-owned | The harness acts directly                 | An internal explanation is saved; handoff and error labels are applied             |

Handoff exists only on channels that support it. For respond.io, the labels start workflows that select the human operator. On a channel without handoff, the agent gets no handoff tool, and the error path saves and logs its internal explanation. A handoff never stops agent replies by itself. Only the ownership rule in §2 does. The error path must work without another model call or agent-invoked tool. Skills provide any customer-facing handoff wording. A handoff tool acknowledgement is context for the agent, not an automatic customer message.

A recoverable tool error can be returned to the agent for correction within its limits. Missing essential instructions, unusable configuration, or exhausted response/work limits stop the turn. Raw errors stay out of customer messages. Failure of handoff reporting is logged without recursively attempting more handoffs.

The following have their own outcomes rather than automatic error handoff:

| Situation                    | Outcome                                             |
| ---------------------------- | --------------------------------------------------- |
| Deliberate skip              | Internal explanation, no out-of-scope handoff       |
| Summary failure              | The reply continues under the summary rules         |
| Nudge failure                | Internal failure note                               |
| Uncertain message acceptance | The uncertainty is logged, without automatic resend |

The record distinguishes completed, skipped, superseded, failed, timed-out, and interrupted turns. Abandoned work must not permanently block a conversation after restart.

## 8. Nudges

Operators can configure nudges without application changes. Defaults are:

| Setting                                                 | Default                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Automatic nudges                                        | Enabled; can be switched off                                                                                 |
| Check frequency                                         | Approximately every five minutes                                                                             |
| Nudge milestones after the latest real customer message | 5 minutes, 35 minutes, 12 hours 35 minutes, 12 hours 45 minutes                                              |
| Permitted hours                                         | All hours, including outside office hours                                                                    |
| Attempts per conversation per check                     | At most one                                                                                                  |
| Qualifying agent activity                               | Agent messages and agent-authored internal notes, including the initial nudge note even if the attempt fails |
| Nudge instruction                                       | “Nudge” asks the agent to continue                                                                           |
| Failed nudge                                            | Internal “Nudge failed” explanation, no automatic error handoff                                              |

Only agent-owned conversations with reconciled activity are eligible. Nudges resume after startup or a gap only once the latest customer and agent activity is established; incomplete reconciliation prevents premature nudges. Ownership and activity are checked again before any action.

The policy runs in this order:

1. **Nudge selection:** the earliest milestone that has passed without qualifying agent activity at or beyond it is selected, subject to the per-check limit. Milestones are measured from the customer message, not from the previous nudge.
2. **Execution:** an internal “Nudge” note is written before the agent is asked to continue. With the default nudge settings, that note advances agent activity even if the attempt fails. The artificial prompt never advances customer activity.

Without customer activity, no nudges occur. Individual failures remain isolated and unfinished work is deferred. Restart and policy changes must not reset activity or repeat committed attempts.

## 9. Agent tools and permissions

The built-in tools are **read skills and references**, restricted to approved repository material, and **hand off to a colleague**, with the behavior above, on channels that support handoff. They remain available independently of external MCP connections.

Operators can connect MCP servers, configure authentication, and choose permitted tools. Naming conflicts must not make tool selection ambiguous. A valid negative business result differs from an unavailable or failed tool. Failed access must never produce invented results or a claim that an action succeeded.

### Base respond.io MCP connection

The respond.io MCP connection belongs to base harness configuration, alongside the respond.io channel adapter. It connects over HTTP to a self-hosted respond.io MCP server at a configured address. The harness authenticates to that server with a static bearer token from deployment configuration; no interactive sign-in is required. Running and updating the server is outside the harness. Configuration controls its enabled state, server address, bearer token, permitted tools, editable fields, and labels independently of any business-specific servers. Its contact-specific tools are available only to conversations on the corresponding respond.io connection, not Telegram conversations. The defaults below apply when the connection is enabled.

| Agent action                   | Default permission                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Read contact information       | Current contact's details and labels                                                    |
| Add internal notes             | Current conversation                                                                    |
| Add labels                     | Handoff and out-of-scope; additional labels require configuration                       |
| Edit contact fields            | Name and preferred language, only when explicitly supplied or confirmed by the customer |
| Other fields or provider tools | Disabled until explicitly enabled, including phone/email and custom-field edits         |

Profile changes require explicit customer input or confirmation, never inference. Permissions can expand the allowed actions but never their scope beyond the current account/contact or the connected account's own authority. Disallowed actions are rejected without being applied. Harness-managed handoff and error paths follow their own policies, including system-applied error labels.

These are provider-supplied tools; the harness owns the connection and permissions. Incoming messages and customer reply delivery remain direct channel responsibilities.

## 10. Configuration and operations

Each instance serves one configured country and may enable several channel/account connections, with exclusive access to its persistent conversation storage. The application runs as a container on any suitable service. Hosting, releases, credentials, network setup, backups, and restoration belong to the external container/storage platform. The harness reads restored chat folders when storage is reattached and needs no built-in backup service or dedicated administration interface.

Deployment configuration covers enabled channel adapters and accounts, their capability fallbacks, MCP connections, the skills mount, country, base and optional summary models, attachment preparation models, summary prompt, response/work limits, persistent storage, delivery, and nudge policy. Dates and schedules default to UTC, with a configurable timezone applied consistently to today's date, summaries, and operating hours. Country does not implicitly select timezone; timezone changes do not rewrite event times or reset inactivity.

Readiness requires validation of enabled integrations, instructions, country, configured models, limits, and writable storage. An omitted summary model is valid and selects the base model. Omitted attachment-preparation models are valid and select direct file input for their categories. Disabled channels or MCP connections require neither credentials nor availability; a deployment can replace respond.io entirely. Unavailable dependencies, incomplete history recovery, and nudge readiness are visible to operators. Logs connect the customer message, agent work, tool action, and delivery while protecting credentials and personal information.

Shutdown stops new work, allows safe completion within a configured bound, and preserves unfinished or uncertain work. External hosting reattaches the data folder on restart. Operators can inspect conversation records and nudge state. Tests use isolated data/configuration and do not expose test facilities to customers or affect live conversations.

## Acceptance journeys

1. **Shared service and classification:** a customer writes, a human takes over and shares text/media, and the conversation returns to the agent. Every contribution remains attributed and available. Incoming content is user-side; operator/workflow content is attributed assistant-side; agent echoes appear once. Tool activity and internal records remain distinct and outgoing events never create reply loops.
2. **Different interruptions:** reassignment to a human lets the current reply finish. New customer input stops unsent parts, including paced messages. The next eligible turn sees the latest known customer-visible conversation in the same order, including any already-in-flight message later confirmed as sent. Cancelled drafts do not appear as delivered, and earlier output is not replayed; minor transmission timing differences are tolerated and reconciled.
3. **Lasting history:** restart and external restoration preserve the complete chat.txt, summary.txt when generated, attachments, preparation results, and unfinished work. Delayed messages retain original chronology. Migration remains external; prepared history is not treated as new work and no automatic launch-time channel-history import occurs.
4. **Useful memory:** summary reuse, first generation, refresh, empty output, and failure follow the three-day/recent-month rules. Successful summaries persist in summary.txt. An omitted summary model uses the base model; a configured summary model is used only for summarization. The repository's summary prompt is the default. Prompt or summary-model changes apply to the next generation without forcing a refresh or deleting history. Country filtering and instruction revision remain consistent throughout a turn.
5. **Attachment paths:** for each of images, documents, and audio, an omitted preparation model sends the file to the main call. Configuring a model makes a separate preparation call and replaces that file with its actual text response inside the original attributed message. Categories can use different choices; originals stay stored, results are reused, and all calls count toward turn limits.
6. **Controlled actions:** base respond.io permissions apply without business-specific tools. Knowledge-driven handoff uses the tool; unrecoverable execution errors use the harness path. Denied actions, private diagnostics, uncertain sends, and other exceptions follow their specified outcomes.
7. **Configurable service:** model/work limits, delivery options, timezone, and nudge settings change through deployment configuration. Defaults produce no nudge at minute 34 after agent activity at minute 6, but allow one at minute 35. Configuration changes never duplicate committed actions.
8. **Channel independence:** respond.io and Telegram each work alone or simultaneously through configuration. Histories, routing, ownership, and provider-specific tools remain isolated by connection. Telegram handles messages, attachments, interruptions, summaries, and nudges without requiring operator-message events or respond.io services. Missing notes and handoff use the defined fallbacks; unsupported delivery features degrade without losing content or duplicating sends. Disabled connections require no credentials or service availability. Further adapters can be added without changing shared conversation, history, skill, or agent policies.
