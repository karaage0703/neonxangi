import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class ApprovalError extends Error {}

export interface Approval {
  id: string;
  correlation_id: string;
  subject: string;
  capability: string;
  action: string;
  resource: string;
  summary: string;
  status: string;
  created_at: number;
  decided_at: number | null;
}

export class ApprovalStore {
  private approvals: Approval[];

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.approvals = this.load();
  }

  private load(): Approval[] {
    if (!existsSync(this.path)) return [];
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!Array.isArray(value)) throw new Error("root must be an array");
      return value as Approval[];
    } catch (error) {
      throw new ApprovalError(`invalid approval store: ${String(error)}`);
    }
  }

  private save(): void {
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.approvals, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }

  create(
    input: Omit<Approval, "id" | "status" | "created_at" | "decided_at">,
  ): Approval {
    const approval: Approval = {
      id: `apr-${randomUUID().replaceAll("-", "")}`,
      ...input,
      status: "pending",
      created_at: Math.floor(Date.now() / 1000),
      decided_at: null,
    };
    this.approvals.push(approval);
    this.save();
    return { ...approval };
  }

  decide(approvalId: string, decision: "approved" | "denied"): Approval {
    const approval = this.find(approvalId);
    if (approval.status !== "pending")
      throw new ApprovalError("approval has already been decided");
    approval.status = decision;
    approval.decided_at = Math.floor(Date.now() / 1000);
    this.save();
    return { ...approval };
  }

  get(approvalId: string): Approval {
    return { ...this.find(approvalId) };
  }

  private find(approvalId: string): Approval {
    const approval = this.approvals.find((item) => item.id === approvalId);
    if (!approval) throw new ApprovalError("approval not found");
    return approval;
  }

  list(status?: string, limit = 100): Approval[] {
    return this.approvals
      .filter((item) => !status || item.status === status)
      .toSorted((left, right) => right.created_at - left.created_at)
      .slice(0, limit)
      .map((item) => ({ ...item }));
  }

  consumeApproved(
    approvalId: string,
    expected: Pick<Approval, "capability" | "action" | "resource">,
  ): void {
    const approval = this.find(approvalId);
    if (approval.status !== "approved")
      throw new ApprovalError("operation is not approved");
    if (
      approval.capability !== expected.capability ||
      approval.action !== expected.action ||
      approval.resource !== expected.resource
    ) {
      throw new ApprovalError("approval is bound to another operation");
    }
    approval.status = "consumed";
    approval.decided_at = Math.floor(Date.now() / 1000);
    this.save();
  }

  close(): void {}
}
