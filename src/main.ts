import "./channels/telegram/telegram.ts";
import { startApp } from "./app.ts";
import { errorText, log } from "./log.ts";

let stopping: Promise<void> | undefined;
let app: Awaited<ReturnType<typeof startApp>> | undefined;

function shutdown(code: number) {
  stopping ??= (async () => {
    log("info", "app.stopping");
    await app?.stop();
    process.exit(code);
  })();
}

function fatal(error: unknown) {
  log("error", "app.failed", { error: errorText(error) });
  shutdown(1);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

try {
  app = await startApp(process.env, fatal);
} catch (error) {
  log("error", "app.start_failed", { error: errorText(error) });
  process.exit(1);
}
