import { Server } from "lucide-react";
import type { Host } from "../shared/model";
import { hostOS } from "../shared/host-os";
export { hostIconNames } from "../shared/host-os";
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
export function HostIcon({ host }: { host: Host }) {
  const { kind, label } = hostOS(host);
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
