export const defaultShortcuts = {
  copy: "Platform+C",
  paste: "Platform+V",
  search: "Mod+Shift+F",
  nextPane: "Alt+ArrowRight",
  previousPane: "Alt+ArrowLeft",
  newTab: "Mod+N",
  newWindow: "Mod+Shift+N",
  activity: "Mod+Shift+I",
  recentActivity: "Mod+Shift+U",
};
function equivalent(a: string, b: string) {
  return [true, false].some((mac) => {
    const normalize = (binding: string) => {
      const parts = binding.split("+");
      const key = parts.pop()?.toLowerCase();
      const modifiers = parts.flatMap((part) =>
        part === "Mod"
          ? [mac ? "Meta" : "Ctrl"]
          : part === "Platform"
            ? mac
              ? ["Meta"]
              : ["Ctrl", "Shift"]
            : [part],
      );
      return [...new Set(modifiers)].sort().join("+") + ":" + key;
    };
    return normalize(a) === normalize(b);
  });
}
export function migrateShortcuts(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const bindings = { ...(raw as Record<string, string>) };
  const taken = (value: string, except?: string) =>
    Object.entries(bindings).some(
      ([key, binding]) =>
        key !== except &&
        typeof binding === "string" &&
        binding &&
        equivalent(binding, value),
    );
  if (
    !("newWindow" in bindings) &&
    bindings.newTab === "Mod+Shift+T" &&
    !taken(defaultShortcuts.newTab, "newTab")
  )
    bindings.newTab = defaultShortcuts.newTab;
  for (const key of ["newWindow", "activity", "recentActivity"] as const)
    if (!(key in bindings))
      bindings[key] = taken(defaultShortcuts[key]) ? "" : defaultShortcuts[key];
  return bindings;
}
