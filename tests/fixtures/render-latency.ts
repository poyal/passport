import type { Page } from "@playwright/test";

// The echo server writes the input literally. Reserve row 1 with DECSTBM so
// sustained scrolling cannot erase a probe before xterm's next DOM refresh.
// This measures IPC receipt separately from DOM refresh + a paint opportunity.
export async function renderLatency(page: Page, id: string, marker: string) {
  return page.evaluate(
    ({ id, marker }) =>
      new Promise<{ ipc: number; rendered: number }>((resolve, reject) => {
        const started = performance.now();
        let ipc: number | undefined,
          rendered: number | undefined,
          tail = "",
          frame = 0;
        const surface = document.querySelector(
          `[data-pane-id="${id}"] .xterm-rows`,
        );
        if (!surface) {
          reject(new Error(`Missing rendered pane ${id}`));
          return;
        }
        const finish = () => {
          if (ipc === undefined || rendered === undefined) return;
          cleanup();
          resolve({ ipc, rendered });
        };
        const observer = new MutationObserver(() => {
          if (
            frame ||
            rendered !== undefined ||
            !surface.textContent?.includes(marker)
          )
            return;
          frame = requestAnimationFrame(() => {
            rendered = performance.now() - started;
            finish();
          });
        });
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(`Input was not rendered within 3 seconds (${marker})`),
          );
        }, 3000);
        const off = window.passport.onEvent((e) => {
          if (e.kind !== "output" || e.id !== id) return;
          tail += e.data;
          if (tail.includes(marker) && ipc === undefined) {
            ipc = performance.now() - started;
            finish();
          }
          tail = tail.slice(-4096);
        });
        function cleanup() {
          clearTimeout(timeout);
          cancelAnimationFrame(frame);
          observer.disconnect();
          off();
        }
        observer.observe(surface, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        void window.passport
          .call("session.input", {
            id,
            // A resize resets DECSTBM. Re-establish the reserved row for every
            // probe and leave subsequent synthetic log output below it.
            data: `\x1b[2;r\x1b[1;1H\x1b[2K${marker}\x1b[2;1H`,
          })
          .catch((error) => {
            cleanup();
            reject(error);
          });
      }),
    { id, marker },
  );
}
