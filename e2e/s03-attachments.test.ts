import { expect, test } from "bun:test";
import { join } from "node:path";

import { waitFor } from "./support/app.ts";
import { useHarness } from "./support/fixture.ts";
import type { ModelRequest } from "./support/gateway.ts";
import {
  contentTypes,
  conversation,
  mainRequests,
  preparationRequests,
} from "./support/gateway.ts";
import { deliver, incoming, outgoingEvent } from "./support/respondio.ts";
import { readChat } from "./support/setup.ts";

const f = useHarness(["tg", "rio"]);
const photo = {
  photo: [
    {
      file_id: "photo1",
      file_unique_id: "u1",
      width: 1,
      height: 1,
      file_size: 4,
    },
  ],
};
const voice = {
  voice: {
    file_id: "voice1",
    file_unique_id: "u2",
    duration: 1,
    mime_type: "audio/ogg",
  },
};
const pdf = {
  document: {
    file_id: "doc1",
    file_unique_id: "u3",
    file_name: "invoice.pdf",
    mime_type: "application/pdf",
  },
};
const bytes = new Uint8Array([137, 80, 78, 71]);

function byModel(request: ModelRequest) {
  if (request.model === "test/vision") return { text: "A red car" };
  if (request.model === "test/ears") return { text: "I want a refund" };
  return { text: "Thanks" };
}

async function stored(chat: string, type = "outcome") {
  return await waitFor(async () => {
    const entries = await readChat(f.app.dataDir, "tg", chat);
    return entries.some((entry) => entry.type === type) && entries;
  });
}

test("§3 without a preparation model the original image goes to the main call, with no extra model call", async () => {
  f.telegram.files.set("photo1", bytes);
  f.gateway.reply(byModel);
  await f.start();
  f.telegram.customerMessage(1, { ...photo, caption: "Look" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(preparationRequests(f.gateway)).toHaveLength(0);
  const last = mainRequests(f.gateway)[0]!.messages.at(-1)!;
  expect(contentTypes(last)).toEqual(["text", "image_url"]);
});

test("§3 a configured image model replaces the file with its actual text inside the original message, and the result is reused", async () => {
  f.telegram.files.set("photo1", bytes);
  f.gateway.reply(byModel);
  await f.start({ IMAGE_MODEL: "test/vision" });
  f.telegram.customerMessage(1, { ...photo, caption: "Look" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(
    preparationRequests(f.gateway).map((request) => request.model),
  ).toEqual(["test/vision"]);
  expect(contentTypes(preparationRequests(f.gateway)[0]!.messages[0]!)).toEqual(
    ["text", "image_url"],
  );
  expect(conversation(mainRequests(f.gateway)[0]!)).toEqual([
    [
      "user",
      "Look [Attachment image (image/jpeg, 4 bytes), image description by a model: A red car]",
    ],
  ]);
  const message = (await stored("1")).find(
    (entry) => entry.role === "customer",
  )!;
  expect(message.text).toBe("Look");
  expect(message.attachments![0]!.prepared).toMatchObject({
    model: "test/vision",
    text: "A red car",
  });
  f.telegram.customerMessage(1, { text: "And?" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  expect(preparationRequests(f.gateway)).toHaveLength(1);
});

test("§3 categories are independent: audio is transcribed while images and documents go directly", async () => {
  f.telegram.files.set("photo1", bytes);
  f.telegram.files.set("voice1", bytes);
  f.telegram.files.set("doc1", new TextEncoder().encode("%PDF-1.4"));
  f.gateway.reply(byModel);
  await f.start({ AUDIO_MODEL: "test/ears" });
  f.telegram.customerMessage(1, voice);
  f.telegram.customerMessage(1, photo);
  f.telegram.customerMessage(1, pdf);
  await waitFor(() =>
    mainRequests(f.gateway).some((request) => request.messages.length >= 4),
  );
  expect(
    preparationRequests(f.gateway).map((request) => request.model),
  ).toEqual(["test/ears"]);
  const users = mainRequests(f.gateway)
    .at(-1)!
    .messages.filter((message) => message.role === "user");
  expect(users.map(contentTypes)).toEqual([["text"], ["image_url"], ["file"]]);
});

test("§3 an empty preparation response is a processing failure; content is never invented", async () => {
  f.telegram.files.set("photo1", bytes);
  f.gateway.reply((request) =>
    request.model === "test/vision" ? { text: "  " } : { text: "Invented" },
  );
  await f.start({ IMAGE_MODEL: "test/vision" });
  f.telegram.customerMessage(1, photo);
  const entries = await stored("1", "error");
  expect(mainRequests(f.gateway)).toHaveLength(0);
  expect(f.telegram.sentTexts(1)).toHaveLength(0);
  expect(entries.find((entry) => entry.type === "outcome")?.text).toContain(
    "no usable text",
  );
  expect(entries.some((entry) => entry.type === "error")).toBe(true);
});

test("§3 preparation calls count toward the turn's work limit", async () => {
  f.telegram.files.set("photo1", bytes);
  f.gateway.reply(byModel);
  await f.start({ IMAGE_MODEL: "test/vision", TURN_MAX_STEPS: "1" });
  f.telegram.customerMessage(1, photo);
  const entries = await stored("1");
  expect(mainRequests(f.gateway)).toHaveLength(0);
  expect(entries.find((entry) => entry.type === "outcome")?.text).toContain(
    "work limit",
  );
});

test("§3 video is recorded, stored and identified to the agent as unsupported", async () => {
  f.telegram.files.set("video1", bytes);
  f.gateway.reply(byModel);
  await f.start();
  f.telegram.customerMessage(1, {
    video: {
      file_id: "video1",
      file_unique_id: "u4",
      width: 1,
      height: 1,
      duration: 1,
      mime_type: "video/mp4",
      file_size: 4,
    },
  });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(conversation(mainRequests(f.gateway)[0]!)).toEqual([
    [
      "user",
      "[Unsupported attachment: video (video/mp4, 4 bytes). Its content is not available.]",
    ],
  ]);
  const attachment = (await stored("1")).find(
    (entry) => entry.role === "customer",
  )!.attachments![0]!;
  expect(
    await Bun.file(
      join(f.app.dataDir, "tg", "1", String(attachment.file)),
    ).bytes(),
  ).toEqual(bytes);
});

test("§3 failed retrieval keeps the message and attachment reference visible", async () => {
  f.gateway.reply(byModel);
  await f.start();
  f.telegram.customerMessage(1, { ...photo, caption: "See photo" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(conversation(mainRequests(f.gateway)[0]!)).toEqual([
    [
      "user",
      "See photo [Attachment image (image/jpeg, 4 bytes) could not be retrieved.]",
    ],
  ]);
  const attachment = (await stored("1")).find(
    (entry) => entry.role === "customer",
  )!.attachments![0]!;
  expect(attachment.source).toBe("photo1");
  expect(String(attachment.retrievalError)).toContain("404");
});

async function operatorImage(extra: Record<string, string>) {
  const files = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(bytes, { headers: { "content-type": "image/png" } }),
  });
  try {
    f.gateway.reply(byModel);
    const app = await f.start(extra);
    const attachment = {
      type: "image",
      url: `http://localhost:${files.port}/p.png`,
      fileName: "p.png",
      mimeType: "image/png",
    };
    const user = { id: 9, firstName: "Jane" };
    await deliver(
      app.url,
      outgoingEvent(
        "51",
        { type: "attachment", attachment },
        { source: "user", userId: 9 },
        { user },
      ),
    );
    await waitFor(
      async () =>
        (await readChat(app.dataDir, "rio", "51"))[0]?.attachments?.[0]?.file,
    );
    await deliver(
      app.url,
      incoming("51", { type: "text", text: "What is it?" }),
    );
    await waitFor(() => f.respond.sentTexts("51").length === 1);
    return mainRequests(f.gateway)[0]!;
  } finally {
    await files.stop(true);
  }
}

test("§3 a prepared operator attachment stays assistant-side text with attribution", async () => {
  const request = await operatorImage({ IMAGE_MODEL: "test/vision" });
  expect(conversation(request)).toEqual([
    [
      "assistant",
      '[Human colleague, Jane] [Attachment image "p.png" (image/png), image description by a model: A red car]',
    ],
    ["user", "What is it?"],
  ]);
});

test("§3 a direct operator attachment is carried with its attribution, because assistant messages cannot hold files", async () => {
  const request = await operatorImage({});
  const [operator, carrier] = request.messages.filter(
    (message) => message.role !== "system",
  );
  expect(operator!.role).toBe("assistant");
  expect(conversation(request)[0]).toEqual([
    "assistant",
    "[Human colleague, Jane]",
  ]);
  expect(carrier!.role).toBe("user");
  expect(contentTypes(carrier!)).toEqual(["text", "image_url"]);
  expect(conversation(request)[1]![1]).toBe(
    "[Files shared in the previous message by [Human colleague, Jane]]",
  );
});
