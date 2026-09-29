import { Server } from "lucide-react";
import type { Host } from "../shared/model";
import alpine from "./assets/os/alpinelinux.svg";
import centos from "./assets/os/centos.svg";
import redhat from "./assets/os/redhat.svg";
import rocky from "./assets/os/rockylinux.svg";
import ubuntu from "./assets/os/ubuntu.svg";
import debian from "./assets/os/debian.svg";
import fedora from "./assets/os/fedora.svg";
import linux from "./assets/os/linux.svg";
import apple from "./assets/os/apple.svg";

const logos = {
  alpine,
  centos,
  redhat,
  rocky,
  ubuntu,
  debian,
  fedora,
  linux,
  apple,
};
export const hostIconNames = {
  auto: "자동 · 접속 시 운영체제 감지",
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

export function HostIcon({ host }: { host: Host }) {
  const os =
    host.icon === "auto"
      ? host.detectedOS?.toLowerCase() || "server"
      : host.icon;
  const kind = /windows/.test(os)
    ? "windows"
    : /darwin|macos|apple/.test(os)
      ? "apple"
      : /alpine/.test(os)
        ? "alpine"
        : /centos/.test(os)
          ? "centos"
          : /red hat|redhat|rhel/.test(os)
            ? "redhat"
            : /rocky/.test(os)
              ? "rocky"
              : /ubuntu/.test(os)
                ? "ubuntu"
                : /debian/.test(os)
                  ? "debian"
                  : /fedora/.test(os)
                    ? "fedora"
                    : /linux/.test(os)
                      ? "linux"
                      : "server";
  const label =
    host.icon === "auto"
      ? host.detectedOS || "서버 · 연결 후 운영체제 감지"
      : hostIconNames[kind];
  return (
    <div
      className={`host-icon ${kind}`}
      data-tooltip={label}
      role="img"
      aria-label={label}
    >
      {kind === "server" ? (
        <Server size={21} aria-hidden="true" />
      ) : kind === "windows" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M2 2h9v9H2zm11 0h9v9h-9zM2 13h9v9H2zm11 0h9v9h-9z"
          />
        </svg>
      ) : (
        <img src={logos[kind]} alt="" aria-hidden="true" draggable={false} />
      )}
    </div>
  );
}
