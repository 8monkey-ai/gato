import { setTimeout } from "node:timers/promises";

import type { Settings } from "../config/settings.ts";
import type { Logger } from "../log.ts";
import { createSender, type DeliveryJob, type SenderDeps } from "./sender.ts";
import { createSplitter } from "./split.ts";
import { planParts } from "./transform.ts";

export type DeliveryResult = {
  sentParts: number;
  failed: boolean;
  interrupted: boolean;
  uncertain: boolean;
};

export function createDelivery({
  store,
  settings,
  log,
  sleep = (ms, signal) => setTimeout(ms, undefined, { signal }),
  now = () => new Date(),
}: {
  store: SenderDeps["store"];
  settings: Settings["delivery"];
  log: Logger;
  sleep?: SenderDeps["sleep"];
  now?: () => Date;
}) {
  const { pacing: mode, pauseMs, perWordMs } = settings;
  const deps = { store, log, sleep, now, pacing: { mode, pauseMs, perWordMs } };
  return {
    start(job: DeliveryJob) {
      const sender = createSender(deps, job);
      const splitter = createSplitter(settings.boundary);
      const options = {
        stripFinalStop: settings.stripFinalStop,
        videoPrefixes: settings.video.linkPrefixes,
        videoMode: settings.video.mode,
        surroundingText: settings.video.surroundingText,
        supportsVideo: job.connection.supportsVideo,
        maxTextLength: job.connection.maxTextLength,
      };
      const held: string[] = [];
      const enqueue = (texts: string[]) => {
        for (const text of texts)
          for (const part of planParts(text, options)) sender.enqueue(part);
      };
      return {
        push(delta: string) {
          const texts = splitter.push(delta);
          if (settings.timing === "stream") enqueue(texts);
          else held.push(...texts);
        },
        end(): Promise<DeliveryResult> {
          enqueue([...held, ...splitter.end()]);
          return sender.finish();
        },
      };
    },
  };
}
