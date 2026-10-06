import type { ShellId, ShellInfo } from "../../../shared/terminal-config";
import type { PtyBehavior } from "../contracts";

export const bashPromptMarkers = (instance: string) => ({
  prompt: `\x1b]133;A;passport=${instance}\x07`,
  command: `\x1b]133;C;passport=${instance}\x07`,
});
export function describeShells(
  entries: [ShellId, string, string][],
  exists: (file: string) => boolean,
  architecture: (file: string) => string,
): ShellInfo[] {
  return entries.map(([id, name, executable]) => {
    const available = exists(executable);
    return {
      id,
      name,
      path: executable,
      architecture: architecture(executable),
      available,
      ...(!available
        ? {
            reason:
              id === "passport-bash"
                ? "내장 런타임이 없습니다. 런타임 준비 후 다시 빌드하세요."
                : "이 기기에 설치되어 있지 않습니다.",
          }
        : {}),
    };
  });
}
export function plainPtyBehavior(): PtyBehavior {
  return {
    observeOutput() {},
    input: (data) => data,
    resized() {},
    terminate: (pty) => pty.kill(),
    dispose() {},
  };
}
