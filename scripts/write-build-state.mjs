import { writeSourceBuildState } from "../bin/build-state.js";

await writeSourceBuildState(new URL("../", import.meta.url));
