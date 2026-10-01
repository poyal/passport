import { documentSchema, type PassportDocument } from "./model";
import { defaultTerminalSettings } from "./terminal-config";

// Read the source version before Zod strips unknown fields. The old app rejects
// database v4 and document v2, so a downgrade cannot silently erase new settings.
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
  return documentSchema.parse(value);
}
