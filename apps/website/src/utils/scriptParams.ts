import type { ScriptParamField, ScriptParamValue } from "../types/automation";

export const parseJSDocParams = (code: string): ScriptParamField[] => {
  const fields: ScriptParamField[] = [];
  if (!code) return fields;

  const regex =
    /@param\s+\{(string|number|boolean|select)\}\s+\[(\w+)(?:=(.*?))?\]\s*([^|\n]*)(?:\|\s*(.*))?/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(code)) !== null) {
    const [, type, name, rawDefault, label, extra] = match;
    let defaultValue: ScriptParamValue = rawDefault
      ? rawDefault.trim().replace(/^["']|["']$/g, "")
      : "";

    if (type === "number") {
      defaultValue = rawDefault ? Number(defaultValue) : 0;
      if (isNaN(defaultValue)) defaultValue = 0;
    } else if (type === "boolean") {
      defaultValue = defaultValue === "true";
    }

    let options: Record<string, string> | undefined;
    if (type === "select" && extra && extra.includes("选项:")) {
      try {
        const jsonStr = extra.split("选项:")[1].trim();
        options = JSON.parse(jsonStr);
      } catch (error) {
        console.warn("Failed to parse JSDoc select options:", error);
      }
    }

    fields.push({
      name,
      type: type as ScriptParamField["type"],
      default: defaultValue,
      label: (label || "").trim() || name,
      options,
    });
  }

  return fields;
};
