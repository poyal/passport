import { describe, expect, it, vi } from "vitest";
import { bindTerminalMouse } from "../src/renderer/terminal-mouse";

function fixture() {
  const view = new EventTarget();
  const document = Object.assign(new EventTarget(), { defaultView: view });
  const element = Object.assign(new EventTarget(), { ownerDocument: document });
  let tracking = true;
  const menu = vi.fn();
  const dispose = bindTerminalMouse(
    element as unknown as HTMLElement,
    () => tracking,
    menu,
  );
  const received: string[] = [];
  for (const type of ["mousedown", "contextmenu"])
    element.addEventListener(type, () => received.push(type));
  document.addEventListener("mouseup", () => received.push("mouseup"));
  const send = (type: string, props: Partial<MouseEvent> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button: 2,
      shiftKey: false,
      clientX: 10,
      clientY: 20,
      ...props,
    });
    (type === "mouseup" ? document : element).dispatchEvent(event);
    return event;
  };
  return {
    view,
    menu,
    dispose,
    received,
    send,
    mode: (value: boolean) => {
      tracking = value;
    },
  };
}

describe("terminal mouse ownership", () => {
  it("keeps a TUI press and release together when modifiers or tracking change", () => {
    const f = fixture();
    f.send("mousedown");
    f.mode(false);
    f.send("contextmenu", { shiftKey: true });
    f.send("mouseup", { shiftKey: true });
    expect(f.received).toEqual(["mousedown", "mouseup"]);
    expect(f.menu).not.toHaveBeenCalled();
    f.dispose();
  });

  for (const contextAfterRelease of [false, true]) {
    it(`keeps an app gesture out of the TUI with contextmenu ${contextAfterRelease ? "after" : "before"} release`, () => {
      const f = fixture();
      f.send("mousedown", { shiftKey: true });
      if (contextAfterRelease) f.send("mouseup");
      f.send("contextmenu");
      if (!contextAfterRelease) f.send("mouseup");
      f.send("contextmenu");
      expect(f.received).toEqual([]);
      expect(f.menu).toHaveBeenCalledExactlyOnceWith(10, 20);
      f.send("mousedown");
      f.send("mouseup");
      expect(f.received).toEqual(["mousedown", "mouseup"]);
      f.dispose();
    });
  }

  it("retains the normal shell menu and avoids duplicate keyboard menus", () => {
    const f = fixture();
    f.mode(false);
    f.send("contextmenu", { button: 0, clientX: 0, clientY: 0 });
    expect(f.menu).not.toHaveBeenCalled();
    f.send("mousedown");
    f.mode(true);
    f.send("contextmenu");
    f.send("mouseup");
    expect(f.menu).toHaveBeenCalledOnce();
    expect(f.received).toEqual([]);
    f.dispose();
  });

  it("does not consume left drags and clears global handlers when disposed", () => {
    const f = fixture();
    f.send("mousedown", { button: 0 });
    f.send("mouseup", { button: 0 });
    f.send("mousedown", { shiftKey: true });
    f.view.dispatchEvent(new Event("blur"));
    f.send("mouseup");
    f.send("mousedown", { shiftKey: true });
    f.dispose();
    f.send("mouseup");
    f.send("contextmenu");
    expect(f.received).toEqual([
      "mousedown",
      "mouseup",
      "mouseup",
      "mouseup",
      "contextmenu",
    ]);
    expect(f.menu).not.toHaveBeenCalled();
  });
});
