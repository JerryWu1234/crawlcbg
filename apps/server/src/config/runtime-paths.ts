import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

// Load .env from root directory or current directory.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

export const SCRIPTS_DIR = path.resolve(process.cwd(), "scripts");
export const HISTORY_DIR = path.resolve(SCRIPTS_DIR, ".history");
export const TRACES_DIR = path.resolve(process.cwd(), "traces");

if (!fs.existsSync(SCRIPTS_DIR)) {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}
if (!fs.existsSync(TRACES_DIR)) {
  fs.mkdirSync(TRACES_DIR, { recursive: true });
}

export const LOCAL_DIR = path.resolve(SCRIPTS_DIR, ".local");
if (!fs.existsSync(LOCAL_DIR)) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
}
