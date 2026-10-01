import { documentSchema, type PassportDocument } from "./model";
import { defaultTerminalSettings } from "./terminal-config";

// Read the source version before Zod strips unknown fields. The old app rejects
// database v5 and document v2, so a downgrade cannot silently erase new settings.
export function legacyTemplateCount(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const templates = (raw as Record<string, unknown>).workspaceTemplates;
  return Array.isArray(templates)
    ? templates.filter(isMultiTabTemplate).length
    : 0;
}
function isMultiTabTemplate(template: unknown): boolean {
  if (!template || typeof template !== "object") return false;
  const workspaces = (template as Record<string, unknown>).workspaces;
  return Array.isArray(workspaces) && workspaces.length > 1;
}
export function migrateDocument(
  raw: unknown,
  platform = process.platform,
): PassportDocument {
  if (!raw || typeof raw !== "object") return documentSchema.parse(raw);
  const value = structuredClone(raw) as Record<string, unknown>;
  if (value.version === 1) {
    value.version = 2;
    const settings = (value.settings ?? {}) as Record<string, unknown>;
    settings.terminal ??= defaultTerminalSettings(platform, true);
    value.settings = settings;
  }
  if (Array.isArray(value.workspaceTemplates))
    value.workspaceTemplates = value.workspaceTemplates.filter(
      (template) => !isMultiTabTemplate(template),
    );
  return documentSchema.parse(value);
}
