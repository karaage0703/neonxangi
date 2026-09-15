export function sourceBuildHash(root: URL | string): Promise<string>;
export function writeSourceBuildState(root: URL | string): Promise<void>;
export function assertSourceBuildCurrent(root: URL | string): Promise<void>;
