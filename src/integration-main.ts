import { parseArgs } from "node:util";
import { createIntegrationFromPaths, serveIntegration } from "./integration.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        bind: { type: "string", default: "0.0.0.0" },
        port: { type: "string", default: "18790" },
        "sandbox-id": { type: "string" },
        "workspace-id": { type: "string" },
        "public-key": { type: "string" },
        "state-dir": { type: "string", default: "/var/lib/neonxangi" },
        "xangi-url": { type: "string", default: "http://127.0.0.1:18789" },
      },
    });
    for (const name of ["sandbox-id", "workspace-id", "public-key"] as const) {
      if (!values[name]) throw new Error(`--${name} is required`);
    }
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("--port must be a valid TCP port");
    const integration = createIntegrationFromPaths({
      sandboxId: values["sandbox-id"]!,
      workspaceId: values["workspace-id"]!,
      publicKeyPath: values["public-key"]!,
      stateDir: values["state-dir"]!,
      xangiUrl: values["xangi-url"]!,
    });
    serveIntegration(integration, values.bind!, port);
    console.log(`Neon Xangi Integration listening on ${values.bind}:${port}`);
  } catch (error) {
    console.error(
      `neonxangi-integration: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
