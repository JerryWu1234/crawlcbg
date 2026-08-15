import fs from "node:fs";
import path from "node:path";
import { LOCAL_DIR } from "../config/runtime-paths.js";

export interface PinnedTab {
  id: string;
  title: string;
  url: string;
  scriptFilename?: string;
  created_at?: string;
}

// JSON file path for pinned resident tabs (gitignored local storage inside scripts/.local/).
const PINNED_TABS_FILE = path.resolve(LOCAL_DIR, "pinned_tabs.json");

export function loadPinnedTabsJSON(): PinnedTab[] {
  try {
    if (fs.existsSync(PINNED_TABS_FILE)) {
      const data = fs.readFileSync(PINNED_TABS_FILE, "utf-8");
      return JSON.parse(data) || [];
    }
  } catch (err) {
    console.error("Read pinned_tabs.json error:", err);
  }
  return [];
}

export function savePinnedTabsJSON(tabs: PinnedTab[]): void {
  try {
    fs.writeFileSync(PINNED_TABS_FILE, JSON.stringify(tabs, null, 2), "utf-8");
  } catch (err) {
    console.error("Save pinned_tabs.json error:", err);
  }
}
