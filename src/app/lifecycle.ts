import { duration, type Env, readEnv } from "../config/env.ts";
import type { Logger } from "../log/logger.ts";

export interface Startable {
  start(): void | Promise<void>;
  stop(): Promise<void>;
}

export function readShutdownTimeout(env: Env = process.env): number {
  return readEnv("GATO_SHUTDOWN_TIMEOUT", duration.default(30_000), env);
}

/**
 * Starts the parts in order. When one fails, stops the started parts and throws.
 * Resolves to a function that stops the parts in reverse order.
 */
export async function startAll(
  parts: readonly Startable[],
  logger: Logger,
): Promise<() => Promise<void>> {
  const started: Startable[] = [];
  const stopAll = async () => {
    for (const part of started.toReversed()) {
      try {
        await part.stop();
      } catch (error) {
        logger.error({ err: error }, "a part did not stop cleanly");
      }
    }
  };
  try {
    for (const part of parts) {
      await part.start();
      started.push(part);
    }
  } catch (error) {
    await stopAll();
    throw error;
  }
  return stopAll;
}

/** True when `stop` finished within `ms`. */
export async function stopWithin(
  stop: () => Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: Timer | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });
  try {
    return await Promise.race([stop().then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts the parts, then on SIGTERM or SIGINT stops them within the bound and ends the process. A second signal waits for the same stop. */
export async function run(
  parts: readonly Startable[],
  options: { logger: Logger; shutdownTimeoutMs: number },
): Promise<void> {
  const { logger, shutdownTimeoutMs } = options;
  const stop = await startAll(parts, logger);
  let stopping: Promise<void> | undefined;
  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, "stopping");
    const stopped = await stopWithin(stop, shutdownTimeoutMs);
    if (!stopped) {
      logger.error(
        { shutdownTimeoutMs },
        "stopped at the shutdown bound with work unfinished",
      );
    }
    process.exit(stopped ? 0 : 1);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    stopping ??= shutdown(signal);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
