import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface InstallerResult {
  error?: Error;
  status: number | null;
}

export type InstallerRunner = (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) => InstallerResult;

const runInstaller: InstallerRunner = (command, args, environment) => {
  const result = spawnSync(command, args, {
    env: environment,
    stdio: "inherit",
  });
  return result.error
    ? { error: result.error, status: result.status }
    : { status: result.status };
};

export function updateInstallation(
  root: string,
  runner: InstallerRunner = runInstaller,
): void {
  const installer = join(root, "install.sh");
  if (!existsSync(installer))
    throw new Error(`managed installer is missing: ${installer}`);
  const result = runner("sh", [installer], {
    ...process.env,
    NEONXANGI_INSTALL_MODE: "update",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`update installer exited with status ${result.status}`);
}
