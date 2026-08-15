const tabFaviconPalette = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#d97706", "#dc2626"];

export function createTabFaviconDataUri(url: string): string {
  let identity = url.trim() || "tab";
  try {
    const parsedUrl = new URL(url);
    identity = parsedUrl.hostname || parsedUrl.protocol.replace(/:$/, "") || identity;
  } catch {
    // Keep the raw URL as a stable fallback identity.
  }

  let hash = 0;
  for (const character of identity) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }

  const label = identity.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? "•";
  const background = tabFaviconPalette[hash % tabFaviconPalette.length] || "#475569";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${background}"/><text x="16" y="21" text-anchor="middle" fill="white" font-family="system-ui,-apple-system,sans-serif" font-size="16" font-weight="700">${label}</text></svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
