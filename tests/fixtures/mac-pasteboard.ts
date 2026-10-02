import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

// Uses a unique named board, never the user's general copy/paste buffer.
export async function writeMacPasteboard(name: string, files: string[]) {
  await execute(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `
    function run(argv) {
      ObjC.import('AppKit');
      const pb = $.NSPasteboard.pasteboardWithName(argv[0]);
      pb.clearContents;
      const urls = JSON.parse(argv[1]).map(file => $.NSURL.fileURLWithPath(file));
      if (urls.length && !pb.writeObjects($.NSArray.arrayWithArray($(urls)))) throw new Error('Cannot write fixture');
    }`,
      name,
      JSON.stringify(files),
    ],
    { timeout: 3000 },
  );
}

export async function releaseMacPasteboard(name: string) {
  await execute(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `
    function run(argv) {
      ObjC.import('AppKit');
      $.NSPasteboard.pasteboardWithName(argv[0]).releaseGlobally;
    }`,
      name,
    ],
    { timeout: 3000 },
  );
}
