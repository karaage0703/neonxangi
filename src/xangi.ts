import { parseSse, type SseEvent } from "./http.js";

export class XangiError extends Error {}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(url.hostname)
  ) {
    throw new XangiError("xangi URL must be loopback HTTP");
  }
  return url;
}

export class XangiClient {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly remoteToken: string;

  constructor(
    baseUrl: string,
    timeout = 900_000,
    remoteToken = process.env.XANGI_REMOTE_PLATFORM_TOKEN ?? "",
  ) {
    this.baseUrl = loopbackUrl(baseUrl).toString().replace(/\/$/u, "");
    this.timeout = timeout;
    this.remoteToken = remoteToken;
  }

  private async json(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      const request: RequestInit = {
        method: body ? "POST" : "GET",
        signal: AbortSignal.timeout(this.timeout),
      };
      if (body) {
        request.headers = { "Content-Type": "application/json" };
        request.body = JSON.stringify(body);
      }
      response = await fetch(`${this.baseUrl}${path}`, request);
    } catch (error) {
      throw new XangiError(`xangi request failed: ${String(error)}`);
    }
    if (!response.ok)
      throw new XangiError(`xangi request failed: HTTP ${response.status}`);
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new XangiError("xangi returned an invalid response");
    }
    return value as Record<string, unknown>;
  }

  async createSession(): Promise<string> {
    const value = await this.json("/api/sessions", {});
    const sessionId = String(value.sessionId ?? "");
    if (!sessionId) throw new XangiError("xangi did not return a session ID");
    return sessionId;
  }

  async turn(sessionId: string, message: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ appSessionId: sessionId, message }),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok)
      throw new XangiError(
        `xangi streaming request failed: HTTP ${response.status}`,
      );
    for await (const event of parseSse(response)) {
      if (event.event === "error")
        throw new XangiError(String(event.message ?? "xangi turn failed"));
      if (event.event === "done") return String(event.response ?? "");
    }
    throw new XangiError("xangi stream ended without a done event");
  }

  async *remoteTurn(body: Record<string, unknown>): AsyncGenerator<SseEvent> {
    if (!this.remoteToken)
      throw new XangiError("XANGI_REMOTE_PLATFORM_TOKEN is not configured");
    const response = await fetch(`${this.baseUrl}/api/remote-platform/turn`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.remoteToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) {
      throw new XangiError(
        `xangi remote platform request failed (${response.status}): ${await response.text()}`,
      );
    }
    let terminal = false;
    try {
      for await (const event of parseSse(response)) {
        terminal = ["done", "error"].includes(event.event);
        yield event;
        if (terminal) return;
      }
    } catch (error) {
      throw new XangiError(
        `xangi remote platform stream failed: ${String(error)}`,
      );
    }
    if (!terminal)
      throw new XangiError(
        "xangi remote platform stream ended without a done event",
      );
  }
}
