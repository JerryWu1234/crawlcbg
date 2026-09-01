import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

// E2E supplies an isolated environment and must never inherit repository secrets.
const isE2E = process.env.CBG_E2E === "1";

if (!isE2E) {
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
}

const configuredRuntimeDir = process.env.CBG_RUNTIME_DIR?.trim();
if (isE2E && !configuredRuntimeDir) {
  throw new Error("CBG_RUNTIME_DIR is required when CBG_E2E=1.");
}

export const RUNTIME_DIR = configuredRuntimeDir
  ? path.resolve(configuredRuntimeDir)
  : process.cwd();
export const PUBLIC_API_URL = (
  process.env.CBG_PUBLIC_API_URL?.trim() || "http://localhost:3001"
).replace(/\/+$/, "");
export const SCRIPTS_DIR = path.join(RUNTIME_DIR, "scripts");
export const HISTORY_DIR = path.join(SCRIPTS_DIR, ".history");
export const TRACES_DIR = path.join(RUNTIME_DIR, "traces");
export const LOCAL_DIR = path.join(SCRIPTS_DIR, ".local");
export const DATA_DIR = path.join(RUNTIME_DIR, "data");

for (const directory of [SCRIPTS_DIR, HISTORY_DIR, TRACES_DIR, LOCAL_DIR, DATA_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}
