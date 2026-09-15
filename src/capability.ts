import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export class CapabilityError extends Error {}

export interface Subject {
  platform: string;
  user_id: string;
  channel_id: string;
}

export interface Grant {
  capability: string;
  actions: string[];
  resources: string[];
}

export interface Claims {
  issuer: string;
  audience: string;
  sandbox_id: string;
  xangi_session_id: string;
  subject: Subject;
  workspace_id: string;
  allow: Grant[];
  issued_at: number;
  expires_at: number;
  nonce: string;
}

function encode(raw: Buffer | string): string {
  return Buffer.from(raw).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function exclusiveWrite(path: string, data: Buffer, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function generateKeypair(directory: string): [string, string] {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const privatePath = join(directory, "capability-private.pem");
  const publicPath = join(directory, "capability-public.pem");
  if (existsSync(privatePath) || existsSync(publicPath)) {
    throw new CapabilityError(
      "refusing to overwrite an existing capability keypair",
    );
  }
  const pair = generateKeyPairSync("ed25519");
  exclusiveWrite(
    privatePath,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }) as Buffer,
    0o600,
  );
  exclusiveWrite(
    publicPath,
    pair.publicKey.export({ type: "spki", format: "pem" }) as Buffer,
    0o644,
  );
  return [privatePath, publicPath];
}

export function loadPrivateKey(path: string): KeyObject {
  try {
    const key = createPrivateKey(readFileSync(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    return key;
  } catch (error) {
    throw new CapabilityError(
      `capability private key is not Ed25519: ${String(error)}`,
    );
  }
}

export function loadPublicKey(path: string): KeyObject {
  try {
    const key = createPublicKey(readFileSync(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    return key;
  } catch (error) {
    throw new CapabilityError(
      `capability public key is not Ed25519: ${String(error)}`,
    );
  }
}

export interface IssueOptions {
  audience: string;
  sandboxId: string;
  sessionId: string;
  subject: Subject;
  workspaceId: string;
  grants: Grant[];
  ttlSeconds?: number;
  now?: number;
}

export function issue(privateKey: KeyObject, options: IssueOptions): string {
  const ttl = options.ttlSeconds ?? 60;
  if (ttl < 1 || ttl > 300) {
    throw new CapabilityError(
      "capability TTL must be between 1 and 300 seconds",
    );
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: Claims = {
    issuer: "neonxangi-controller",
    audience: options.audience,
    sandbox_id: options.sandboxId,
    xangi_session_id: options.sessionId,
    subject: options.subject,
    workspace_id: options.workspaceId,
    allow: options.grants,
    issued_at: now,
    expires_at: now + ttl,
    nonce: randomUUID().replaceAll("-", ""),
  };
  const payload = encode(JSON.stringify(claims));
  const signature = sign(
    null,
    Buffer.from(payload, "ascii"),
    privateKey,
  ).toString("base64url");
  return `nx1.${payload}.${signature}`;
}

function parseClaims(value: unknown): Claims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("malformed capability");
  }
  const raw = value as Record<string, unknown>;
  const subject = raw.subject as Record<string, unknown>;
  const allow = raw.allow;
  if (
    typeof raw.issuer !== "string" ||
    typeof raw.audience !== "string" ||
    typeof raw.sandbox_id !== "string" ||
    typeof raw.xangi_session_id !== "string" ||
    typeof raw.workspace_id !== "string" ||
    typeof raw.issued_at !== "number" ||
    typeof raw.expires_at !== "number" ||
    typeof raw.nonce !== "string" ||
    subject === null ||
    typeof subject !== "object" ||
    typeof subject.platform !== "string" ||
    typeof subject.user_id !== "string" ||
    typeof subject.channel_id !== "string" ||
    !Array.isArray(allow)
  ) {
    throw new CapabilityError("malformed capability");
  }
  const grants: Grant[] = allow.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CapabilityError("malformed capability");
    }
    const grant = entry as Record<string, unknown>;
    if (
      typeof grant.capability !== "string" ||
      !Array.isArray(grant.actions) ||
      !grant.actions.every((item) => typeof item === "string") ||
      (grant.resources !== undefined &&
        (!Array.isArray(grant.resources) ||
          !grant.resources.every((item) => typeof item === "string")))
    ) {
      throw new CapabilityError("malformed capability");
    }
    return {
      capability: grant.capability,
      actions: grant.actions as string[],
      resources: (grant.resources as string[] | undefined) ?? [],
    };
  });
  return {
    issuer: raw.issuer,
    audience: raw.audience,
    sandbox_id: raw.sandbox_id,
    xangi_session_id: raw.xangi_session_id,
    subject: subject as unknown as Subject,
    workspace_id: raw.workspace_id,
    allow: grants,
    issued_at: raw.issued_at,
    expires_at: raw.expires_at,
    nonce: raw.nonce,
  };
}

export interface VerifyOptions {
  expectedAudience: string;
  expectedSandbox: string;
  now?: number;
  clockSkewSeconds?: number;
}

export function verify(
  token: string,
  publicKey: KeyObject,
  options: VerifyOptions,
): Claims {
  if (token.length > 16_384)
    throw new CapabilityError("capability exceeds maximum size");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "nx1" || !parts[1] || !parts[2]) {
    throw new CapabilityError("malformed capability");
  }
  if (
    !verifySignature(
      null,
      Buffer.from(parts[1], "ascii"),
      publicKey,
      decode(parts[2]),
    )
  ) {
    throw new CapabilityError("invalid capability signature");
  }
  let claims: Claims;
  try {
    claims = parseClaims(
      JSON.parse(decode(parts[1]).toString("utf8")) as unknown,
    );
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("malformed capability");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 5;
  if (claims.issuer !== "neonxangi-controller") {
    throw new CapabilityError("unexpected capability issuer");
  }
  if (claims.audience !== options.expectedAudience) {
    throw new CapabilityError("capability is intended for another service");
  }
  if (claims.sandbox_id !== options.expectedSandbox) {
    throw new CapabilityError("capability is bound to another sandbox");
  }
  if (claims.issued_at > now + skew)
    throw new CapabilityError("capability is not active yet");
  if (claims.expires_at < now - skew)
    throw new CapabilityError("capability has expired");
  if (claims.expires_at - claims.issued_at > 300) {
    throw new CapabilityError("capability lifetime exceeds maximum");
  }
  return claims;
}

export function authorize(
  claims: Claims,
  capability: string,
  action: string,
  resource = "",
): boolean {
  return claims.allow.some(
    (grant) =>
      grant.capability === capability &&
      grant.actions.includes(action) &&
      (grant.resources.length === 0 || grant.resources.includes(resource)),
  );
}

export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  consume(claims: Claims, now = Math.floor(Date.now() / 1000)): void {
    for (const [nonce, expiry] of this.seen) {
      if (expiry < now) this.seen.delete(nonce);
    }
    if (this.seen.has(claims.nonce)) {
      throw new CapabilityError("capability was already used");
    }
    this.seen.set(claims.nonce, claims.expires_at);
  }
}
