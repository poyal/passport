import { it, expect } from "vitest";
import {
  testWindowMode,
  testWindowOptions,
  presentWindow,
} from "../src/main/test-window";

it("keeps normal launches unchanged and requires an isolated profile for E2E modes", () => {
  expect(testWindowMode({})).toBeUndefined();
  expect(testWindowOptions(undefined)).toEqual({});
  expect(() => testWindowMode({ PASSPORT_E2E_WINDOW_MODE: "hidden" })).toThrow(
    "isolated",
  );
  expect(() =>
    testWindowMode({
      PASSPORT_E2E_WINDOW_MODE: "typo",
      PASSPORT_DATA_DIR: "/test",
    }),
  ).toThrow("Unknown");
  expect(
    testWindowMode({
      PASSPORT_E2E_WINDOW_MODE: "passive",
      PASSPORT_DATA_DIR: "/test",
    }),
  ).toBe("passive");
});

it("prevents window activation in hidden and passive modes while preserving normal activation", () => {
  const calls: string[] = [];
  const window = {
    isMinimized: () => true,
    restore: () => {
      calls.push("restore");
    },
    show: () => {
      calls.push("show");
    },
    showInactive: () => {
      calls.push("showInactive");
    },
    focus: () => {
      calls.push("focus");
    },
  };
  presentWindow(window, "hidden");
  expect(calls).toEqual([]);
  presentWindow(window, "passive");
  expect(calls).toEqual(["showInactive"]);
  calls.length = 0;
  presentWindow(window, undefined);
  expect(calls).toEqual(["restore", "show", "focus"]);
  for (const mode of ["hidden", "passive"] as const)
    expect(testWindowOptions(mode)).toEqual({
      show: false,
      focusable: false,
      skipTaskbar: true,
    });
});
