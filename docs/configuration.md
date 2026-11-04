# Configuration

Gato reads its configuration from environment variables at startup. A value that is not valid stops startup. The error names the variable and, for JSON values, the path of the problem, for example `GATO_TELEGRAM_CONNECTIONS.main.botToken: Required`. Errors do not show the rejected value.

An empty value counts as unset.

## Value formats

| Format   | Example                | Notes                                                                                |
| -------- | ---------------------- | ------------------------------------------------------------------------------------ |
| Integer  | `30000`                | Whole number from -9007199254740991 to 9007199254740991.                             |
| Boolean  | `true`, `false`        | Also `1`/`0`, `yes`/`no`, `on`/`off`, `y`/`n`, `enabled`/`disabled`.                 |
| Duration | `30s`, `5m`, `12h35m`  | Units `d`, `h`, `m`, `s`, `ms`, in that order. A number without a unit is not valid. |
| List     | `a, b, c`              | Comma-separated. Spaces around entries and empty entries are removed.                |
| JSON     | `{"main":{"key":"v"}}` | One JSON value, usually an object keyed by connection name.                          |

Timeouts and other time spans use the duration format. Their names do not have a unit suffix such as `_MS`.

## Variables

| Variable         | Default | Description                                                                                                                                                                                                                                                              |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GATO_LOG_LEVEL` | `info`  | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.                                                                                                                                                                                                     |
| `GATO_TIMEZONE`  | `UTC`   | IANA time zone name, for example `Asia/Kuala_Lumpur`. Offsets such as `+08:00` are not valid. Case does not matter: `asia/kuala_lumpur` gives `Asia/Kuala_Lumpur`. Sets today's date, calendar-month windows and operating hours. It does not change stored event times. |

## Logs

Logs are JSON lines. Gato replaces the value of these fields with `[redacted]`, at any depth, including fields of logged errors:

- Credentials: field names that end with `token`, `secret`, `password`, `authorization`, `apikey`/`api_key` or `signingkey`/`signing_key`/`signingkeys`/`signing_keys`, in any case. For example `botToken` and `webhookSigningKeys` are redacted, `inputTokens` is not.
- Personal data: fields named `text`, `caption`, `phone` or `email`.

A circular reference shows as `[Circular]`. The log message itself is not redacted, so it must not contain credentials or personal data.
