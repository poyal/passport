import { expect, type Page } from "@playwright/test";

/** Check relationships that width-only overflow checks cannot detect. */
export async function expectReadableSpacing(page: Page) {
  const issues = await page.evaluate(() => {
    const issues: string[] = [];
    const visible = (el: Element) =>
      el.checkVisibility({ checkVisibilityCSS: true });
    const label = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || "")
        .trim()
        .slice(0, 45);
    const gap = (a: Element, b: Element, min: number, max: number) => {
      const distance =
        b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
      if (distance < min - 1 || distance > max + 1)
        issues.push(
          `${label(a)} → ${label(b)}: ${distance}px (expected ${min}–${max})`,
        );
    };
    for (const header of document.querySelectorAll(".settings-card-header")) {
      if (!visible(header)) continue;
      const title = header.querySelector("h3")!,
        button = header.querySelector("button")!;
      const a = title.getBoundingClientRect(),
        b = button.getBoundingClientRect();
      if (b.top >= a.bottom) gap(title, button, 8, 24);
      else if (Math.abs(a.top + a.height / 2 - b.top - b.height / 2) > 1)
        issues.push(`${label(title)}: heading and button are not centered`);
    }
    for (const hint of document.querySelectorAll(
      ".settings-card > .hint, .appearance-panel > .hint, .home-view > .hint, .profile-editor-form > .hint, .tunnel-card > p",
    )) {
      if (!visible(hint)) continue;
      const previous = hint.previousElementSibling;
      if (
        previous?.matches(
          "button, .row, .update-result, .theme-list, .settings-card-header",
        )
      )
        gap(previous, hint, 8, 24);
    }
    for (const picker of document.querySelectorAll(".font-picker")) {
      if (!visible(picker)) continue;
      for (const label of picker.querySelectorAll("label")) {
        const field = label.htmlFor
          ? document.getElementById(label.htmlFor)
          : null;
        if (field) gap(label, field, 6, 10);
      }
    }
    for (const shells of document.querySelectorAll(
      ".profile-editor-form > .profile-shells",
    ))
      if (visible(shells)) gap(shells.previousElementSibling!, shells, 12, 20);
    for (const row of document.querySelectorAll(".shortcut-row")) {
      if (!visible(row)) continue;
      const key = row.querySelector("kbd");
      if (key) {
        const style = getComputedStyle(key);
        if (
          key.closest("button, input") ||
          parseFloat(style.borderTopWidth) !== 0 ||
          style.backgroundColor !== "rgba(0, 0, 0, 0)"
        )
          issues.push(`${label(row)}: key display looks like a control`);
      }
      const buttons = [
        ...row.querySelectorAll<HTMLButtonElement>(
          ".shortcut-actions > button",
        ),
      ];
      for (let i = 0; i < buttons.length; i++) {
        const rect = buttons[i].getBoundingClientRect();
        if (Math.abs(rect.height - 34) > 1)
          issues.push(`${label(buttons[i])}: ${rect.height}px high`);
        if (i) {
          const prev = buttons[i - 1].getBoundingClientRect();
          if (Math.abs(prev.top - rect.top) < 1 && rect.left - prev.right < 7)
            issues.push(`${label(buttons[i])}: touching previous button`);
        }
      }
    }
    return issues;
  });
  expect(
    issues,
    "Control alignment and related text need consistent separation",
  ).toEqual([]);
}
