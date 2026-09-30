// Incremental ECMA-48 control filtering for text logs. Recording keeps the original stream.
export class LogTextDecoder {
  private state: "text" | "escape" | "csi" | "string" = "text";
  private osc = false;
  private stringEscape = false;
  private carriageReturn = false;
  constructor(
    private from: number,
    private trackOffsets: boolean,
  ) {}
  write(text: string, start: number) {
    const visible: string[] = [],
      offsets: number[] = [];
    let position = start;
    for (const character of text) {
      const at = position,
        code = character.codePointAt(0)!;
      position += Buffer.byteLength(character);
      if (this.state === "string") {
        if (
          code === 0x9c ||
          (this.osc && code === 7) ||
          (this.stringEscape && character === "\\")
        ) {
          this.state = "text";
          this.stringEscape = false;
        } else this.stringEscape = code === 0x1b;
        continue;
      }
      if (code === 0x1b) {
        this.state = "escape";
        continue;
      }
      if (this.state === "escape") {
        if (character === "[") this.state = "csi";
        else if ("]PX^_".includes(character)) {
          this.state = "string";
          this.osc = character === "]";
          this.stringEscape = false;
        } else if (code < 0x20 || code > 0x2f) this.state = "text";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (code === 0x9b) {
        this.state = "csi";
        continue;
      }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.state = "string";
        this.osc = code === 0x9d;
        this.stringEscape = false;
        continue;
      }
      if (character === "\n" && this.carriageReturn) {
        this.carriageReturn = false;
        continue;
      }
      this.carriageReturn = character === "\r";
      if (
        character !== "\t" &&
        character !== "\n" &&
        character !== "\r" &&
        (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      )
        continue;
      if (at < this.from) continue;
      visible.push(character === "\r" ? "\n" : character);
      if (this.trackOffsets)
        for (let i = 0; i < character.length; i++) offsets.push(at);
    }
    return { text: visible.join(""), offsets };
  }
}
