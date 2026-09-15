import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class AuditError extends Error {}

export interface AuditEvent {
  correlation_id: string;
  timestamp: string;
  component: string;
  action: string;
  outcome: string;
  subject: Record<string, string>;
  resource: string;
  details: Record<string, unknown>;
}

export interface AuditWrite {
  component: string;
  action: string;
  outcome: string;
  subject?: Record<string, string>;
  resource?: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

export class AuditLog {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  write(input: AuditWrite): AuditEvent {
    const event: AuditEvent = {
      correlation_id:
        input.correlationId ?? `nx-${randomUUID().replaceAll("-", "")}`,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      component: input.component,
      action: input.action,
      outcome: input.outcome,
      subject: input.subject ?? {},
      resource: input.resource ?? "",
      details: input.details ?? {},
    };
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "a", 0o600);
      writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
      fsyncSync(fd);
    } catch (error) {
      throw new AuditError(
        `audit write failed; refusing the operation: ${String(error)}`,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return event;
  }

  tail(limit = 100): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .trimEnd()
      .split(/\r?\n/u)
      .slice(-Math.max(1, Math.min(limit, 1000)))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent);
  }
}
