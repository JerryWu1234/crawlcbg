/** Resolve evidence IDs exclusively through the immutable snapshot manifest. */

import fs from "node:fs";

import { getSnapshotFileForTable, type WorkspaceInfo } from "./workspace-manager.js";

export interface EvidenceRow {
  id: string;
  table: string;
  row: number;
  fields: Record<string, unknown>;
  schema: Array<{ name: string; type: string }>;
}

function readSnapshotFile(
  workspace: WorkspaceInfo,
  tableName: string,
): {
  schema?: { columns?: Array<{ name: string; type: string }> };
  rows?: Record<string, unknown>[];
} | null {
  try {
    const filePath = getSnapshotFileForTable(workspace, tableName);
    if (!filePath) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readEvidenceRow(
  workspace: WorkspaceInfo,
  tableName: string,
  rowIndex: number,
): EvidenceRow | null {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return null;
  const data = readSnapshotFile(workspace, tableName);
  if (!Array.isArray(data?.rows) || rowIndex >= data.rows.length) return null;
  const fields = data.rows[rowIndex];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;

  return {
    id: `${tableName}#${rowIndex}`,
    table: tableName,
    row: rowIndex,
    fields,
    schema: Array.isArray(data.schema?.columns) ? data.schema.columns : [],
  };
}

export function parseEvidenceId(
  evidenceId: string,
): { tableName: string; rowIndex: number } | null {
  const hashIndex = evidenceId.lastIndexOf("#");
  if (hashIndex <= 0) return null;
  const tableName = evidenceId.slice(0, hashIndex);
  const indexText = evidenceId.slice(hashIndex + 1);
  if (!/^\d+$/.test(indexText)) return null;
  const rowIndex = Number(indexText);
  return Number.isSafeInteger(rowIndex) ? { tableName, rowIndex } : null;
}

export function validateEvidenceId(workspace: WorkspaceInfo, evidenceId: string): boolean {
  const parsed = parseEvidenceId(evidenceId);
  return parsed !== null && readEvidenceRow(workspace, parsed.tableName, parsed.rowIndex) !== null;
}
