import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HISTORY_DIR } from "../config/runtime-paths.js";

// Helper to sanitize filename to .mjs.
export function getSanitizedFilename(name: string): string {
  const baseName = path.basename(name);
  if (!baseName.endsWith(".mjs") && !baseName.endsWith(".js")) {
    return `${baseName}.mjs`;
  }
  return baseName;
}

// Helper to save version history snapshot with MD5 content hash deduplication.
export function saveHistorySnapshot(
  filename: string,
  content: string,
  label: string,
  runId?: string,
): void {
  try {
    const safeName = getSanitizedFilename(filename);
    const fileHistoryDir = path.join(HISTORY_DIR, safeName);
    if (!fs.existsSync(fileHistoryDir)) {
      fs.mkdirSync(fileHistoryDir, { recursive: true });
    }

    // 1. Content MD5 Hash Deduplication Check
    const newHash = crypto.createHash("md5").update(content).digest("hex");
    const existingMetaFiles = fs
      .readdirSync(fileHistoryDir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => Number(b.replace(".json", "")) - Number(a.replace(".json", "")));

    if (existingMetaFiles.length > 0) {
      const latestMetaFile = existingMetaFiles[0];
      const latestSnapshotFile = path.join(fileHistoryDir, latestMetaFile.replace(".json", ".mjs"));
      if (fs.existsSync(latestSnapshotFile)) {
        const latestContent = fs.readFileSync(latestSnapshotFile, "utf-8");
        const latestHash = crypto.createHash("md5").update(latestContent).digest("hex");
        if (newHash === latestHash) {
          // Content is 100% identical to the latest snapshot, skip creating duplicate snapshot!
          return;
        }
      }
    }

    // 2. Save new version snapshot
    const timestamp = Date.now();
    const formattedTime = new Date().toLocaleString("zh-CN");
    const snapshotFile = path.join(fileHistoryDir, `${timestamp}.mjs`);
    const metaFile = path.join(fileHistoryDir, `${timestamp}.json`);

    fs.writeFileSync(snapshotFile, content, "utf-8");
    fs.writeFileSync(
      metaFile,
      JSON.stringify(
        {
          id: String(timestamp),
          filename: safeName,
          label,
          timestamp: formattedTime,
          runId: runId || null,
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch (err) {
    console.error("Save history snapshot error:", err);
  }
}
