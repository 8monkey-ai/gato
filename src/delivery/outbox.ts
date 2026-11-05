import type { OutgoingPart } from "../channels/channel.ts";

export type DeliverOutcome = "sent" | "stop";

export interface OutboxOptions {
  deliver: (part: OutgoingPart) => Promise<DeliverOutcome>;
  delayFor: (part: OutgoingPart, index: number) => number;
  beforeDelay?: () => void;
  signal: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createOutbox({
  deliver,
  delayFor,
  beforeDelay,
  signal,
}: OutboxOptions) {
  const queue: OutgoingPart[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const nudge = () => wake?.();
  signal.addEventListener("abort", nudge, { once: true });

  async function nextPart() {
    while (queue.length === 0 && !closed && !signal.aborted) {
      await new Promise<void>((resolve) => (wake = resolve));
    }
    return signal.aborted ? undefined : queue.shift();
  }

  async function run() {
    let sent = 0;
    for (let part = await nextPart(); part; part = await nextPart()) {
      const delay = delayFor(part, sent);
      if (delay > 0) beforeDelay?.();
      if (!(await sleep(delay, signal))) {
        queue.unshift(part);
        break;
      }
      if ((await deliver(part)) === "stop") break;
      sent++;
    }
    return { sent, undelivered: queue.splice(0) };
  }

  const done = run();
  return {
    push(...parts: OutgoingPart[]) {
      queue.push(...parts);
      nudge();
    },
    close() {
      closed = true;
      nudge();
    },
    done,
  };
}
