export const bundledFonts = [
  "JetBrains Mono",
  "Cascadia Mono",
  "Cascadia Code",
  "Fira Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "D2Coding",
] as const;
export type FontOption = {
  family: string;
  group: "OS 추천" | "앱 내장" | "설치 글꼴";
};
const recommended: Record<string, string[]> = {
  darwin: [
    "Menlo",
    "Monaco",
    "SF Mono",
    "Courier",
    "Courier New",
    "Andale Mono",
  ],
  win32: [
    "Consolas",
    "Lucida Console",
    "Courier New",
    "Cascadia Mono",
    "Cascadia Code",
  ],
};
export function fontCatalog(
  installed: string[],
  platform: string,
): FontOption[] {
  const names = new Map<string, string>();
  for (const name of installed) {
    const family = name.trim().replace(/^["']|["']$/g, "");
    if (family && !family.startsWith("@"))
      names.set(family.toLowerCase(), family);
  }
  // Bundled faces have known spelling and are available without OS installation.
  for (const family of bundledFonts) names.set(family.toLowerCase(), family);
  const bundled = new Set<string>(bundledFonts);
  const result: FontOption[] = [];
  for (const name of recommended[platform] || []) {
    const family = names.get(name.toLowerCase());
    if (family && !bundled.has(family)) {
      result.push({ family, group: "OS 추천" });
      names.delete(name.toLowerCase());
    }
  }
  for (const family of bundledFonts) {
    result.push({ family, group: "앱 내장" });
    names.delete(family.toLowerCase());
  }
  return result.concat(
    [...names.values()]
      .sort((a, b) => a.localeCompare(b))
      .map((family) => ({ family, group: "설치 글꼴" as const })),
  );
}
export function availableFont(name: string, installed: string[]) {
  return (
    [...bundledFonts, ...installed].find(
      (family) => family.toLowerCase() === name.toLowerCase(),
    ) || "JetBrains Mono"
  );
}
export function terminalFontFamily(family: string) {
  return (
    [...new Set([family, "D2Coding", "JetBrains Mono"])]
      .map((name) => JSON.stringify(name))
      .join(", ") + ", monospace"
  );
}
