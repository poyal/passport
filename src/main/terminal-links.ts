// Terminal output can supply arbitrary OSC 8 destinations. Only web URLs may
// reach the operating system; never pass file paths or custom protocols through.
export function terminalLinkURL(value: string, platform = process.platform) {
  if (
    value.length > 8192 ||
    !/^https?:\/\//i.test(value) ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  )
    throw new Error("올바른 HTTP 또는 HTTPS 링크만 열 수 있습니다.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("올바른 HTTP 또는 HTTPS 링크만 열 수 있습니다.");
  }
  if (url.username || url.password)
    throw new Error("사용자 정보가 포함된 링크는 열 수 없습니다.");
  if (url.href.length > (platform === "win32" ? 2081 : 8192))
    throw new Error("링크 주소가 너무 깁니다.");
  return url.href;
}
