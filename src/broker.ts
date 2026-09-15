import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { createServer, type Server } from "node:http";
import type { KeyObject } from "node:crypto";
import { ApprovalError, type ApprovalStore } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import {
  authorize,
  CapabilityError,
  ReplayGuard,
  verify,
} from "./capability.js";
import { bearerToken, readJson, sendJson } from "./http.js";

export class BrokerError extends Error {}

const READ_ACTIONS = new Set(["read", "search"]);
const MIB = 1024 * 1024;

export function safePath(
  workspaceValue: string,
  relativeValue: string,
): string {
  const workspace = realpathSync(workspaceValue);
  const target = resolve(workspace, relativeValue);
  const lexical = relative(workspace, target);
  if (lexical === ".." || lexical.startsWith(`..${sep}`)) {
    throw new BrokerError("path escapes the authorized workspace");
  }
  if (existsSync(target)) {
    const actual = realpathSync(target);
    const actualRelative = relative(workspace, actual);
    if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`)) {
      throw new BrokerError("path escapes the authorized workspace");
    }
    return actual;
  }
  return target;
}

function walk(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  const result: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const item = resolve(path, entry.name);
    if (entry.isDirectory()) result.push(...walk(item));
    else if (entry.isFile()) result.push(item);
  }
  return result;
}

export class Broker {
  private readonly replayGuard = new ReplayGuard();

  constructor(
    readonly input: {
      workspaceId: string;
      workspace: string;
      sandboxId: string;
      publicKey: KeyObject;
      audit: AuditLog;
      approvals: ApprovalStore;
    },
  ) {}

  execute(
    token: string,
    body: Record<string, unknown>,
  ): [number, Record<string, unknown>] {
    const correlationId = String(body.correlation_id ?? "") || undefined;
    const capability = String(body.capability ?? "");
    const action = String(body.action ?? "");
    const resource = String(body.resource ?? "");
    try {
      const claims = verify(token, this.input.publicKey, {
        expectedAudience: "broker",
        expectedSandbox: this.input.sandboxId,
      });
      if (claims.workspace_id !== this.input.workspaceId) {
        throw new CapabilityError("capability is bound to another workspace");
      }
      if (!authorize(claims, capability, action, resource)) {
        throw new CapabilityError(
          "operation is not present in capability grants",
        );
      }
      this.replayGuard.consume(claims);
      const event = this.input.audit.write({
        component: "broker",
        action: `${capability}.${action}`,
        outcome: "authorized",
        subject: { ...claims.subject },
        resource,
        ...(correlationId ? { correlationId } : {}),
      });
      if (!READ_ACTIONS.has(action)) {
        const approvalId = String(body.approval_id ?? "");
        if (!approvalId) {
          const approval = this.input.approvals.create({
            correlation_id: event.correlation_id,
            subject: `${claims.subject.platform}:${claims.subject.user_id}`,
            capability,
            action,
            resource,
            summary: String(
              body.summary ?? `${capability}.${action} on ${resource}`,
            ),
          });
          this.input.audit.write({
            component: "broker",
            action: "approval.request",
            outcome: "pending",
            subject: { ...claims.subject },
            resource,
            correlationId: event.correlation_id,
            details: { approval_id: approval.id },
          });
          return [
            202,
            {
              ok: false,
              approval_required: true,
              approval_id: approval.id,
              correlation_id: event.correlation_id,
            },
          ];
        }
        this.input.approvals.consumeApproved(approvalId, {
          capability,
          action,
          resource,
        });
      }
      const result = this.dispatch(capability, action, resource, body.input);
      this.input.audit.write({
        component: "broker",
        action: `${capability}.${action}`,
        outcome: "completed",
        subject: { ...claims.subject },
        resource,
        correlationId: event.correlation_id,
      });
      return [200, { ok: true, result, correlation_id: event.correlation_id }];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.input.audit.write({
        component: "broker",
        action: `${capability}.${action}`,
        outcome: "denied",
        resource,
        ...(correlationId ? { correlationId } : {}),
        details: { reason },
      });
      if (
        error instanceof CapabilityError ||
        error instanceof ApprovalError ||
        error instanceof BrokerError ||
        error instanceof Error
      ) {
        return [403, { ok: false, error: reason }];
      }
      throw error;
    }
  }

  private dispatch(
    capability: string,
    action: string,
    resource: string,
    input: unknown,
  ): Record<string, unknown> {
    if (capability !== "workspace") {
      throw new BrokerError("no handler is registered for this capability");
    }
    const target = safePath(this.input.workspace, resource);
    if (action === "read") {
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new BrokerError("resource is not a file");
      }
      const content = readFileSync(target);
      if (content.length > MIB)
        throw new BrokerError("file exceeds the 1 MiB response limit");
      return {
        path: resource,
        content: new TextDecoder("utf-8", { fatal: true }).decode(content),
      };
    }
    if (action === "search") {
      const query =
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? String((input as Record<string, unknown>).query ?? "")
          : "";
      if (!query || query.length > 256) {
        throw new BrokerError(
          "search query must be between 1 and 256 characters",
        );
      }
      if (!existsSync(target)) throw new BrokerError("resource does not exist");
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let scanned = 0;
      for (const candidate of walk(target)) {
        const actual = safePath(
          this.input.workspace,
          relative(this.input.workspace, candidate),
        );
        const size = statSync(actual).size;
        if (size > MIB) continue;
        scanned += size;
        if (scanned > 16 * MIB) break;
        let lines: string[];
        try {
          lines = new TextDecoder("utf-8", { fatal: true })
            .decode(readFileSync(actual))
            .split(/\r?\n/u);
        } catch {
          continue;
        }
        for (const [index, line] of lines.entries()) {
          if (line.includes(query)) {
            matches.push({
              path: relative(this.input.workspace, actual),
              line: index + 1,
              text: line,
            });
            if (matches.length === 50) return { matches };
          }
        }
      }
      return { matches };
    }
    throw new BrokerError("unsupported workspace action");
  }
}

export function serveBroker(
  broker: Broker,
  host: string,
  port: number,
): Server {
  return createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === "GET" && request.url === "/healthz") {
          sendJson(response, 200, { ok: true, component: "broker" });
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/execute") {
          sendJson(response, 404, { error: "not found" });
          return;
        }
        const [status, value] = broker.execute(
          bearerToken(request),
          await readJson(request),
        );
        sendJson(response, status, value);
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }).listen(port, host);
}
