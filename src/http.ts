import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 1_048_576;

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

export async function readJson(
  request: IncomingMessage,
  maximum = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isInteger(declared) || declared < 1 || declared > maximum) {
    throw new Error("request body size is invalid");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximum) throw new Error("request body size is invalid");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization ?? "";
  if (!value.startsWith("Bearer "))
    throw new Error("Bearer capability is required");
  return value.slice(7);
}

export function safeEqual(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export interface SseEvent {
  event: string;
  [key: string]: unknown;
}

export async function* parseSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) throw new Error("stream response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) {
        const parsed = JSON.parse(data.join("\n")) as unknown;
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          throw new Error("stream event must be an object");
        }
        yield { ...(parsed as Record<string, unknown>), event };
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
}
