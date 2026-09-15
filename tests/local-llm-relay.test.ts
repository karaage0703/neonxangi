import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalLlmRelay } from "../src/local-llm-relay.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

describe("Local LLM relay", () => {
  it("forwards only the inference API to its fixed target", async () => {
    const upstream = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Buffer | string>)
          chunks.push(Buffer.from(chunk));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            path: request.url,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          }),
        );
      })();
    });
    const upstreamPort = await listen(upstream);
    const relay = createLocalLlmRelay({
      target: new URL(`http://127.0.0.1:${upstreamPort}`),
    });
    const relayPort = await listen(relay);

    const forwarded = await fetch(
      `http://127.0.0.1:${relayPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen" }),
      },
    );
    expect(await forwarded.json()).toEqual({
      path: "/v1/chat/completions",
      body: { model: "qwen" },
    });

    const blocked = await fetch(`http://127.0.0.1:${relayPort}/admin`);
    expect(blocked.status).toBe(404);
  });
});
