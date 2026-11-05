# gato

## Checks

Run `bun check` before you report work done and before each commit.

## Tests

- Unit tests are next to the code as `*.test.ts`.
- End-to-end tests are in the top-level `e2e/` folder. A test starts the application as a process with environment variables and a temporary data folder. It uses only the HTTP routes, the data folder, and the network calls of the application.
- Fake HTTP servers replace the channel platforms, the model gateway, and the MCP servers. Each fake records the calls it receives.
