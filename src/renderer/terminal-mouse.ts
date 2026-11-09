// DOM context menus and terminal mouse reports are separate events. In mouse
// mode the application owns the reports; Shift explicitly requests our menu.
export function bindTerminalMouse(
  element: HTMLElement,
  mouseTracking: () => boolean,
  openMenu: (x: number, y: number) => void,
) {
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };
  let gesture:
    { app: boolean; released: boolean; menuOpened: boolean } | undefined;
  const appMenu = (event: MouseEvent) => event.shiftKey || !mouseTracking();
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  element.addEventListener(
    "mousedown",
    (event) => {
      gesture =
        event.button === 2
          ? { app: appMenu(event), released: false, menuOpened: false }
          : undefined;
      if (gesture?.app) stop(event);
    },
    options,
  );
  // The menu can take focus before mouseup, and a drag can end outside xterm.
  // Preserve the route through the release, even if Shift or the mode changes.
  element.ownerDocument.addEventListener(
    "mouseup",
    (event) => {
      if (event.button !== 2 || !gesture || gesture.released) return;
      gesture.released = true;
      if (gesture.app) stop(event);
      // Keep the decision for Windows, where contextmenu follows mouseup.
    },
    options,
  );
  element.addEventListener(
    "contextmenu",
    (event) => {
      // Also suppress xterm's clipboard fallback: it moves its textarea under
      // the pointer and can interfere with subsequent TUI clicks and drags.
      stop(event);
      if (event.button !== 2 && event.clientX === 0 && event.clientY === 0)
        return;
      if (!(gesture?.app ?? appMenu(event)) || gesture?.menuOpened) return;
      if (gesture) gesture.menuOpened = true;
      openMenu(event.clientX, event.clientY);
    },
    options,
  );
  element.ownerDocument.defaultView?.addEventListener(
    "blur",
    () => {
      gesture = undefined;
    },
    { signal: controller.signal },
  );
  return () => {
    gesture = undefined;
    controller.abort();
  };
}
