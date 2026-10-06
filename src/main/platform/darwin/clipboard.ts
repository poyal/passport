import type { ClipboardPlatform } from "../contracts";
import {
  clipboardBlob,
  clipboardEntries,
  rawClipboardEntries,
  readFileURLItems,
  validateFilePaths,
  clipboardCommand as command,
} from "../shared/clipboard";
// Chromium can expose only Finder's display-name text. Read the file URLs
// from AppKit itself instead of trying to reconstruct a path from that text.
export const macFileClipboardScript = `
function run(argv) {
  ObjC.import('AppKit');
  const pb = argv.length ? $.NSPasteboard.pasteboardWithName(argv[0]) : $.NSPasteboard.generalPasteboard;
  const generation = Number(pb.changeCount);
  const options = $.NSMutableDictionary.dictionary;
  options.setObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
  const urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), options);
  const paths = [];
  if (urls) for (let i = 0; i < urls.count; i++) {
    const url = urls.objectAtIndex(i);
    if (url.isFileURL) paths.push(ObjC.unwrap(url.path));
  }
  if (!paths.length) {
    const legacy = ObjC.deepUnwrap(pb.propertyListForType('NSFilenamesPboardType'));
    if (Array.isArray(legacy)) paths.push(...legacy);
  }
  if (Number(pb.changeCount) !== generation) throw new Error('Clipboard changed while reading files');
  return JSON.stringify(paths);
}`;

// A named pasteboard lets tests exercise AppKit without touching the user's
// general clipboard. Production calls never supply a name.
export async function readMacClipboardFiles(
  pasteboardName?: string,
): Promise<string[]> {
  const result = await command("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    macFileClipboardScript,
    ...(pasteboardName ? [pasteboardName] : []),
  ]);
  return validateFilePaths(JSON.parse(result), "darwin");
}

export function createDarwinClipboard(run = command): ClipboardPlatform {
  return {
    readNativeFiles: readMacClipboardFiles,
    async readFiles(items) {
      const entries = clipboardEntries(items);
      const legacy = rawClipboardEntries(entries, "NSFilenamesPboardType")[0];
      if (!legacy) return readFileURLItems(entries, "darwin");
      const bytes = Buffer.from(
        await (
          await clipboardBlob(legacy.item, legacy.type, 4 * 1024 * 1024)
        ).arrayBuffer(),
      );
      return validateFilePaths(
        JSON.parse(
          await run(
            "/usr/bin/plutil",
            ["-convert", "json", "-o", "-", "--", "-"],
            bytes,
          ),
        ),
        "darwin",
      );
    },
  };
}
