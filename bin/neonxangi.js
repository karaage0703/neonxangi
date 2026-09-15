#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { assertSourceBuildCurrent } from "./build-state.js";

try {
  await assertSourceBuildCurrent(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const { main } = await import("../dist/cli.js");
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
