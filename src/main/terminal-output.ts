// Every event is separately encoded as UTF-8 by logs and byte accounting.
// Keep a surrogate pair together even when xterm could join split JS strings.
export function terminalOutputChunk(text: string) {
  let end = Math.min(text.length, 32768);
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  )
    end--;
  return text.slice(0, end);
}
