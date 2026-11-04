import "./channels/telegram/index.ts";
import "./channels/respondio/index.ts";

import { createApp } from "./app.ts";
import { createLogger } from "./log.ts";

const log = createLogger();

async function main() {
  const app = await createApp({ env: process.env, log });
  const server = Bun.serve({ port: app.port, fetch: app.fetch });
  try {
    await app.start();
  } catch (error) {
    await server.stop();
    await app.stop();
    throw error;
  }
  log.info("server.listening", { port: server.port });
  const shutdown = async (signal: string) => {
    log.info("app.stopping", { signal });
    await server.stop();
    await app.stop();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      shutdown(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          log.error("app.stop_failed", { error });
          process.exit(1);
        },
      );
    });
}

main().catch((error: unknown) => {
  log.error("app.start_failed", { error });
  process.exit(1);
});
