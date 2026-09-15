import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const ALLOWED_ROUTES = new Map([
  ["GET /v1/models", true],
  ["POST /v1/chat/completions", true],
  ["GET /api/tags", true],
  ["POST /api/chat", true],
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface LocalLlmRelayOptions {
  target: URL;
}

function forwardedHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase()))
      continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  result.delete("host");
  result.delete("content-length");
  result.set("accept-encoding", "identity");
  return result;
}

async function readBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(String(rawChunk));
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createLocalLlmRelay(options: LocalLlmRelayOptions) {
  if (options.target.protocol !== "http:")
    throw new Error("Local LLM relay target must use HTTP");
  const target = new URL(options.target.toString());
  target.pathname = "/";
  target.search = "";
  target.hash = "";

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://relay.local");
      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      const route = `${request.method ?? ""} ${requestUrl.pathname}`;
      if (!ALLOWED_ROUTES.has(route)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"route not allowed"}');
        return;
      }
      const upstream = new URL(requestUrl.pathname + requestUrl.search, target);
      const body =
        request.method === "GET" ? undefined : await readBody(request);
      const requestInit: RequestInit = {
        method: request.method ?? "GET",
        headers: forwardedHeaders(request.headers),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      };
      if (body) requestInit.body = body.toString("utf8");
      const upstreamResponse = await fetch(upstream, requestInit);
      const headers = Object.fromEntries(
        [...upstreamResponse.headers.entries()].filter(
          ([name]) =>
            !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
            !["content-encoding", "content-length"].includes(
              name.toLowerCase(),
            ),
        ),
      );
      response.writeHead(upstreamResponse.status, headers);
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!response.write(Buffer.from(value))) await once(response, "drain");
      }
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status =
        error instanceof Error && error.message === "request body too large"
          ? 413
          : 502;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Local LLM relay request failed" }));
    }
  };
  return createServer((request, response) => {
    void handle(request, response);
  });
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error("Local LLM relay target is required");
  const port = Number(process.argv[3] ?? "18793");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Local LLM relay port is invalid");
  const server = createLocalLlmRelay({ target: new URL(target) });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[local-llm-relay] listening on 127.0.0.1:${port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
