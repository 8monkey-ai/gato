import "./channels/index.ts";

import { createAdapters } from "./app/channels.ts";
import { httpServer, readPort } from "./app/http.ts";
import { readShutdownTimeout, run } from "./app/lifecycle.ts";
import { listChannels } from "./channel/registry.ts";
import { inboundService } from "./conversation/service.ts";
import { localChatStart } from "./conversation/state.ts";
import { createLogger } from "./log/logger.ts";
import { readDataDir } from "./storage/data-dir.ts";
import { openFsStore } from "./storage/fs-store.ts";
import { readTimeZone } from "./time/zone.ts";

const logger = createLogger();
try {
  const port = readPort();
  const shutdownTimeoutMs = readShutdownTimeout();
  const dataDir = readDataDir();
  const timeZone = readTimeZone();
  const adapters = createAdapters(listChannels(), process.env, logger);
  const store = await openFsStore({
    dataDir,
    timeZone,
    now: Date.now,
    logger,
    // shortcut: every chat uses the local start; give the adapter a start member when a channel with native state exists.
    chatStart: () => localChatStart,
  });
  const inbound = inboundService({ store, logger });
  await run(
    [
      httpServer(adapters, port, logger),
      ...adapters.map((adapter) => ({
        start: () => adapter.start(inbound.sinkFor(adapter)),
        stop: () => adapter.stop(),
      })),
    ],
    { logger, shutdownTimeoutMs },
  );
} catch (error) {
  logger.fatal({ err: error }, "startup failed");
  process.exit(1);
}
