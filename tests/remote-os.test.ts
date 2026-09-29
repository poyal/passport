import { it, expect } from "vitest";
import { parseRemoteOS } from "../src/main/remote-os";
import { settingsSchema } from "../src/shared/model";
it.each([
  ['Linux\nPRETTY_NAME="Alpine Linux 3.22"', "Alpine Linux 3.22"],
  ["Linux\nCentOS release 5.11 (Final)", "CentOS release 5.11 (Final)"],
  ['Linux\nDISTRIB_DESCRIPTION="Ubuntu 14.04.6 LTS"', "Ubuntu 14.04.6 LTS"],
  ["Darwin\n", "macOS"],
  ["Microsoft Windows [Version 10.0.26100]", "Windows"],
  ["Linux\n", "Linux"],
  ["permission denied", undefined],
])(
  "recognizes remote OS output without shell injection or assumptions: %s",
  (text, result) => expect(parseRemoteOS(text)).toBe(result),
);
it("enables automatic logs for old settings and caps legacy retention at thirty days", () => {
  expect(settingsSchema.parse({}).autoLog).toBe(true);
  expect(settingsSchema.parse({ logRetentionDays: 365 }).logRetentionDays).toBe(
    30,
  );
  expect(
    settingsSchema.parse({ logRetentionDays: 7, autoLog: false }),
  ).toMatchObject({ logRetentionDays: 7, autoLog: false });
});
