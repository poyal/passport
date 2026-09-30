import type { Host } from "./model";

export type HostIconKind = Exclude<Host["icon"], "auto">;
export const hostIconNames: Record<Host["icon"], string> = {
  auto: "자동 · 이름 추정 / 접속 후 감지",
  server: "서버",
  alpine: "Alpine Linux",
  centos: "CentOS",
  redhat: "Red Hat / RHEL",
  rocky: "Rocky Linux",
  ubuntu: "Ubuntu",
  debian: "Debian",
  fedora: "Fedora",
  linux: "Linux",
  apple: "macOS",
  windows: "Windows",
};
const specificKind = (text: string): HostIconKind | undefined => {
  const value = text.toLowerCase();
  for (const [kind, pattern] of [
    ["windows", /\bwindows(?:\b|(?=\d))|\bwindows_nt\b/],
    ["apple", /\bdarwin\b|\bmacos\b|\bmac os\b/],
    ["alpine", /\balpine(?:\b|(?=\d))/],
    ["centos", /\bcentos(?:\b|(?=\d))/],
    ["redhat", /\bred\s*hat\b|\brhel(?:\b|(?=\d))/],
    ["rocky", /\brocky(?:\b|(?=\d))/],
    ["ubuntu", /\bubuntu(?:\b|(?=\d))/],
    ["debian", /\bdebian(?:\b|(?=\d))/],
    ["fedora", /\bfedora(?:\b|(?=\d))/],
  ] as const) {
    if (pattern.test(value)) return kind;
  }
};

export function hostOS(
  host: Pick<Host, "icon" | "name" | "detectedOS"> &
    Partial<Pick<Host, "iconPinned">>,
): {
  kind: HostIconKind;
  source: "selected" | "detected" | "inferred" | "unknown";
  label: string;
} {
  // A generic Linux tile can be refined to its distribution. Specific manual choices remain fixed.
  if (host.icon !== "auto" && (host.iconPinned || host.icon !== "linux"))
    return {
      kind: host.icon,
      source: "selected",
      label: hostIconNames[host.icon],
    };
  const detected = host.detectedOS?.trim();
  const actual = detected && specificKind(detected);
  if (
    actual &&
    (host.icon === "auto" || (actual !== "windows" && actual !== "apple"))
  )
    return { kind: actual, source: "detected", label: detected! };
  // Do not turn an identified non-Linux OS into Linux based on its old asset name.
  const genericLinux = detected && /^linux$/i.test(detected);
  const inferred = (!detected || genericLinux) && specificKind(host.name);
  if (
    inferred &&
    ((!genericLinux && host.icon === "auto") ||
      (inferred !== "windows" && inferred !== "apple"))
  )
    return {
      kind: inferred,
      source: "inferred",
      label: `${hostIconNames[inferred]} · 이름에서 추정${genericLinux ? " (접속 감지: Linux)" : " (접속 후 확인)"}`,
    };
  if (detected)
    return {
      kind:
        host.icon === "linux" || /\blinux\b/i.test(detected)
          ? "linux"
          : "server",
      source: "detected",
      label: detected,
    };
  return {
    kind: host.icon === "linux" ? "linux" : "server",
    source: "unknown",
    label:
      host.icon === "linux"
        ? "Linux · 연결 후 배포판 감지"
        : "서버 · 연결 후 운영체제 감지",
  };
}
