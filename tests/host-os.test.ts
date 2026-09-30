import { expect, it } from "vitest";
import { hostOS } from "../src/shared/host-os";

it.each([
  ["[AG] CentOS 5.3@172.16.254.6", "centos"],
  ["[AG] CentOS 7.0.1406@172.16.254.15", "centos"],
  ["[AG] RHEL 8.5@172.16.254.28", "redhat"],
  ["[AG] Rocky 8.10@172.16.254.32", "rocky"],
  ["Ubuntu24.04", "ubuntu"],
  ["Windows Server 2022", "windows"],
])("infers the OS of an unconnected asset named %s", (name, kind) => {
  const result = hostOS({ icon: "auto", name });
  expect(result).toMatchObject({ kind, source: "inferred" });
  expect(result.label).toContain("추정");
});

it("refines saved generic Linux icons using detected OS or a recognizable name", () => {
  expect(hostOS({ icon: "linux", name: "[AG] RHEL 8.5" })).toMatchObject({
    kind: "redhat",
    source: "inferred",
  });
  expect(
    hostOS({
      icon: "linux",
      name: "old CentOS asset",
      detectedOS: "Rocky Linux 9.5 (Blue Onyx)",
    }),
  ).toMatchObject({ kind: "rocky", source: "detected" });
  expect(
    hostOS({ icon: "linux", name: "CentOS 5.3", detectedOS: "Linux" }),
  ).toMatchObject({ kind: "centos", source: "inferred" });
});

it("prefers the actual OS over an old name and preserves specific manual icons", () => {
  expect(
    hostOS({
      icon: "linux",
      iconPinned: true,
      name: "CentOS 5.3",
      detectedOS: "Rocky Linux 9.5",
    }),
  ).toMatchObject({ kind: "linux", source: "selected" });
  expect(
    hostOS({
      icon: "auto",
      name: "CentOS 5.3",
      detectedOS: "Microsoft Windows Server 2022",
    }),
  ).toMatchObject({ kind: "windows", source: "detected" });
  expect(
    hostOS({ icon: "auto", name: "Windows 2022", detectedOS: "Linux" }),
  ).toMatchObject({ kind: "linux", source: "detected" });
  expect(
    hostOS({
      icon: "ubuntu",
      name: "CentOS 5.3",
      detectedOS: "Rocky Linux 9.5",
    }),
  ).toMatchObject({ kind: "ubuntu", source: "selected" });
  expect(hostOS({ icon: "auto", name: "normal asset" })).toMatchObject({
    kind: "server",
    source: "unknown",
  });
});
