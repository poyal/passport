import { expect, it } from "vitest";
import { z } from "zod";
import { errorMessage } from "../src/shared/errors";

it("names the invalid field and bound without exposing secret values or schema JSON", () => {
  const schema = z.object({
    hosts: z.array(z.object({ port: z.number().int().min(1).max(65535) })),
  });
  for (const port of [0, 65536, "secret-do-not-display"]) {
    const result = schema.safeParse({ hosts: [{ port }] });
    expect(result.success).toBe(false);
    const message = errorMessage(result.error);
    expect(message).toContain("포트:");
    expect(message).not.toMatch(/secret-do-not-display|invalid_type|"path"/);
    expect(message).toMatch(
      port === 0 ? /1 이상/ : port === 65536 ? /65535 이하/ : /숫자/,
    );
  }
  const invalid = z
    .object({ password: z.string().min(10) })
    .safeParse({ password: "private" });
  expect(errorMessage(invalid.error)).toBe("비밀번호: 10자 이상 입력하세요.");
  const unknownKey = z
    .object({})
    .strict()
    .safeParse({ "한글-secret-value": "private" });
  expect(errorMessage(unknownKey.error)).toBe(
    "입력값: 형식을 확인한 뒤 다시 시도하세요.",
  );
});

it("preserves domain guidance and safely handles non-Error failures", () => {
  const incompatible = z
    .object({ version: z.literal(2) })
    .safeParse({ version: 999 });
  expect(errorMessage(incompatible.error)).toContain(
    "지원하지 않는 데이터 버전입니다",
  );
  const result = z
    .string()
    .refine(() => false, "그룹 기본 인증을 먼저 해제하세요.")
    .safeParse("private");
  expect(errorMessage(result.error)).toBe("그룹 기본 인증을 먼저 해제하세요.");
  expect(errorMessage(new Error("디스크 공간을 확인하세요."))).toBe(
    "디스크 공간을 확인하세요.",
  );
  expect(errorMessage({ password: "private" })).toBe("작업에 실패했습니다.");
});
