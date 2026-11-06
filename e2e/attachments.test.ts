import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { messages, readChat } from "./support/app.ts";
import type { ChatRequest } from "./support/fake-gateway.ts";
import { messageEvent, postWebhook } from "./support/fake-respondio.ts";
import { until } from "./support/recorder.ts";
import { agentModel, startHarness } from "./support/setup.ts";

const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const voice = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9, 9]);
const base64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
const visionModel = "test/vision";

function mainCalls(gateway: { callsFor(model: string): ChatRequest[] }) {
  return gateway
    .callsFor(agentModel)
    .map((request) => JSON.stringify(request.messages));
}

test("§3 attachments: without preparation models, files go to the main call with no extra model call", async () => {
  const { telegram, gateway, dataDir } = await startHarness();
  telegram.file("photo-1", image);
  telegram.file("voice-1", voice);
  telegram.push(50, {
    photo: [{ file_id: "photo-1", file_unique_id: "u1", width: 1, height: 1 }],
    caption: "see this",
  });
  await until(() => telegram.sent().length === 1);
  telegram.push(50, {
    voice: {
      file_id: "voice-1",
      file_unique_id: "u2",
      duration: 1,
      mime_type: "audio/ogg",
    },
  });
  await until(() => telegram.sent().length === 2);

  expect(gateway.requests).toHaveLength(2);
  const [first, second] = mainCalls(gateway);
  expect(first).toContain(base64(image));
  expect(first).toContain("see this");
  expect(second).toContain(base64(voice));
  const files = await readdir(join(dataDir, "telegram", "50", "attachments"));
  expect(files).toHaveLength(2);
});

test("§3 attachments: a configured model prepares the file, its text replaces the file, and the result is reused", async () => {
  const { telegram, gateway, dataDir } = await startHarness({
    env: { IMAGE_PREPARATION_MODEL: visionModel },
    models: [visionModel],
  });
  gateway.script((request) => ({
    text:
      request.model === visionModel ? "A red invoice for RM 50." : "Thanks.",
  }));
  telegram.file("photo-2", image);
  telegram.file("voice-2", voice);
  telegram.push(51, {
    photo: [{ file_id: "photo-2", file_unique_id: "u3", width: 1, height: 1 }],
    caption: "my bill",
  });
  await until(() => telegram.sent().length === 1);
  telegram.push(51, {
    voice: {
      file_id: "voice-2",
      file_unique_id: "u4",
      duration: 1,
      mime_type: "audio/ogg",
    },
  });
  await until(() => telegram.sent().length === 2);

  expect(gateway.callsFor(visionModel)).toHaveLength(1);
  expect(JSON.stringify(gateway.callsFor(visionModel)[0]?.messages)).toContain(
    base64(image),
  );
  const [first, second] = mainCalls(gateway);
  expect(first).toContain("A red invoice for RM 50.");
  expect(first).toContain("my bill");
  expect(first).not.toContain(base64(image));
  expect(second).toContain("A red invoice for RM 50.");
  expect(second).toContain(base64(voice));
  const customer = messages(await readChat(dataDir, "telegram", "51"))[0];
  expect(customer?.text).toBe("my bill");
  expect(customer?.meta.attachments).toMatchObject([
    {
      category: "image",
      prepared: { text: "A red invoice for RM 50.", model: visionModel },
    },
  ]);
});

test("§3 attachments: a preparation failure is a processing failure, nothing is invented, and later turns go on without the file", async () => {
  const { telegram, gateway, dataDir } = await startHarness({
    env: { IMAGE_PREPARATION_MODEL: visionModel },
    models: [visionModel],
  });
  gateway.script((request) =>
    request.model === visionModel
      ? { text: "  " }
      : { text: "Should not be sent." },
  );
  telegram.file("photo-3", image);
  telegram.push(52, {
    photo: [{ file_id: "photo-3", file_unique_id: "u5", width: 1, height: 1 }],
  });

  const record = await until(async () => {
    const entries = await readChat(dataDir, "telegram", "52");
    return entries.some((e) => e.meta.kind === "error") && entries;
  });
  expect(gateway.callsFor(agentModel)).toHaveLength(0);
  expect(telegram.sent()).toHaveLength(0);
  expect(record.find((e) => e.meta.type === "turn")?.meta.status).toBe(
    "failed",
  );
  expect(
    record.find((e) => e.meta.type === "message")?.meta.attachments,
  ).toMatchObject([
    { file: expect.stringMatching(/^attachments\//) as string },
  ]);

  telegram.push(52, { text: "hello?" });
  await until(() => telegram.sent().length === 1);
  expect(gateway.callsFor(visionModel)).toHaveLength(1);
  expect(mainCalls(gateway)[0]).toContain("the file could not be processed");
});

test("§3 attachments: video is recorded and identified as unsupported; failed retrieval stays visible", async () => {
  const { telegram, gateway, dataDir } = await startHarness();
  telegram.push(53, {
    video: {
      file_id: "missing-video",
      file_unique_id: "u6",
      width: 1,
      height: 1,
      duration: 1,
    },
    caption: "watch",
  });
  await until(() => telegram.sent().length === 1);

  const context = mainCalls(gateway)[0] ?? "";
  expect(context).toContain("watch");
  expect(context).toContain("video attachment");
  expect(context).toContain("content is not available");
  const customer = messages(await readChat(dataDir, "telegram", "53"))[0];
  expect(customer?.meta.attachments).toMatchObject([
    {
      category: "video",
      retrievalError: expect.stringContaining("404") as string,
    },
  ]);
});

test("§3 attachments: an operator file stays in history with its limitation visible and never triggers a reply", async () => {
  const { app, gateway, respondio } = await startHarness({
    channels: "respondio",
  });
  const files = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(image, { headers: { "content-type": "image/jpeg" } }),
  });
  try {
    const url = `http://localhost:${files.port}/a.jpg`;
    await postWebhook(
      app.url,
      messageEvent({
        contact: 54,
        traffic: "outgoing",
        source: "user",
        userId: 900,
        attachment: { type: "image", url, fileName: "map.jpg" },
      }),
    );
    await Bun.sleep(300);
    expect(gateway.requests).toHaveLength(0);
    await postWebhook(
      app.url,
      messageEvent({ contact: 54, text: "where is it?" }),
    );
    await until(() => respondio.sent().length === 1);

    const context = mainCalls(gateway)[0] ?? "";
    expect(context).toContain('image attachment \\"map.jpg\\"');
    expect(context).toContain(
      "files sent by colleagues cannot be given to the model",
    );
  } finally {
    await files.stop(true);
  }
});
