import { z } from "zod";

const fields: Record<string, string> = {
  name: "이름",
  address: "주소",
  username: "계정",
  port: "포트",
  bindPort: "수신 포트",
  targetPort: "대상 포트",
  password: "비밀번호",
  privateKey: "개인 키",
  passphrase: "키 암호",
  cwd: "시작 폴더",
  cols: "열 수",
  rows: "행 수",
  fontSize: "글자 크기",
  lineHeight: "줄 간격",
  letterSpacing: "글자 간격",
  command: "명령",
  text: "내용",
  path: "경로",
};

export function errorMessage(error: unknown): string {
  if (!(error instanceof z.ZodError))
    return error instanceof Error ? error.message : "작업에 실패했습니다.";
  const issue = error.issues[0];
  if (!issue) return "입력값을 확인하세요.";
  // Custom Korean domain errors already explain the required action. Never
  // display Zod's JSON dump or echo an invalid password/key/value in the UI.
  if (issue.code === "custom" && /[가-힣]/.test(issue.message))
    return issue.message;
  if (issue.path.at(-1) === "version" && issue.code === "invalid_value")
    return "지원하지 않는 데이터 버전입니다. 최신 앱인지 확인하고, 필요한 경우 호환되는 백업으로 복원하세요.";
  const field = [...issue.path].reverse().find((key) => fields[String(key)]);
  const label = field === undefined ? "입력값" : fields[String(field)];
  if (issue.code === "too_small")
    return `${label}: ${issue.minimum}${issue.origin === "string" ? "자" : ""} ${issue.inclusive === false ? "초과" : "이상"}${issue.origin === "string" ? " 입력하세요." : "의 값을 입력하세요."}`;
  if (issue.code === "too_big")
    return `${label}: ${issue.maximum}${issue.origin === "string" ? "자" : ""} ${issue.inclusive === false ? "미만" : "이하"}${issue.origin === "string" ? "로 입력하세요." : "의 값을 입력하세요."}`;
  if (issue.code === "invalid_type")
    return `${label}: ${issue.expected === "number" || issue.expected === "int" ? "올바른 숫자를 입력하세요." : "올바른 형식으로 입력하세요."}`;
  if (issue.code === "invalid_value")
    return `${label}: 지원하는 값 중에서 선택하세요.`;
  return `${label}: 형식을 확인한 뒤 다시 시도하세요.`;
}
