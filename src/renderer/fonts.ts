import "@fontsource/cascadia-mono/400.css";
import "@fontsource/cascadia-mono/700.css";
import "@fontsource/cascadia-code/400.css";
import "@fontsource/cascadia-code/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./fonts/fonts.css";

const loading = new Map<string, Promise<void>>();
export function loadTerminalFont(family: string, bold = false) {
  const key = `${family}:${bold}`;
  if (!loading.has(key))
    loading.set(
      key,
      Promise.all([
        document.fonts.load(
          `${bold ? 700 : 400} 14px ${JSON.stringify(family)}`,
          "MWil01 ┌─┐ 한글",
        ),
        document.fonts.load(`${bold ? 700 : 400} 14px "D2Coding"`, "한글 ┌─┐"),
      ])
        .then(() => {})
        .catch((error) => {
          loading.delete(key);
          throw error;
        }),
    );
  return loading.get(key)!;
}
