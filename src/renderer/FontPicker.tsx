import { useEffect, useId, useMemo, useState } from "react";
import {
  availableFont,
  fontCatalog,
  terminalFontFamily,
} from "../shared/fonts";
import { loadTerminalFont } from "./fonts";
import { useApp } from "./context";

export function FontPicker({
  value,
  onChange,
  inherit = false,
}: {
  value: string;
  onChange: (family: string) => void;
  inherit?: boolean;
}) {
  const app = useApp(),
    id = useId();
  const [query, setQuery] = useState(""),
    [loadError, setLoadError] = useState("");
  const options = useMemo(
    () => fontCatalog(app.boot.fonts, app.boot.platform),
    [app.boot.fonts, app.boot.platform],
  );
  const selected = options.find(
    (option) => option.family.toLowerCase() === value.toLowerCase(),
  );
  const family = availableFont(
    value || app.document.settings.appearance.font,
    app.boot.fonts,
  );
  // Keep the saved selection available when narrowing the list by search.
  const filtered = options.filter(
    (option) =>
      option === selected ||
      option.family.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => {
    let active = true;
    setLoadError("");
    void loadTerminalFont(family).catch(() => {
      if (active)
        setLoadError("글꼴을 불러오지 못했습니다. 기본 글꼴을 사용합니다.");
    });
    return () => {
      active = false;
    };
  }, [family]);
  return (
    <div className="font-picker">
      <label htmlFor={`${id}-search`}>글꼴 검색</label>
      <input
        id={`${id}-search`}
        type="search"
        value={query}
        placeholder="이름으로 검색"
        onChange={(event) => setQuery(event.target.value)}
      />
      <label htmlFor={`${id}-select`}>글꼴</label>
      <select
        id={`${id}-select`}
        value={selected?.family || (value ? value : "")}
        onChange={(event) => onChange(event.target.value)}
      >
        {inherit && <option value="">전체 설정 사용</option>}
        {value && !selected && (
          <option value={value}>{value} · 현재 PC에서 사용할 수 없음</option>
        )}
        {["OS 추천", "앱 내장", "설치 글꼴"].map((group) => {
          const items = filtered.filter((option) => option.group === group);
          return (
            items.length > 0 && (
              <optgroup label={group} key={group}>
                {items.map((option) => (
                  <option key={option.family} value={option.family}>
                    {option.family}
                  </option>
                ))}
              </optgroup>
            )
          );
        })}
      </select>
      {value && !selected && (
        <p className="hint" role="status">
          설치되지 않은 {value} 대신 JetBrains Mono를 사용합니다.
        </p>
      )}
      {loadError && (
        <p className="error-text" role="status">
          {loadError}
        </p>
      )}
      <pre
        className="font-preview"
        aria-label="터미널 글꼴 미리보기"
        style={{
          fontFamily: terminalFontFamily(loadError ? "JetBrains Mono" : family),
        }}
      >
        {
          "ABC abc 0123456789 0O 1lI\n한글 터미널 · cmd / PowerShell / SSH\n┌──────────┬──────────┐\n│ Passport │  123.45  │\n└──────────┴──────────┘"
        }
      </pre>
      <p className="hint">
        현재 PC의 터미널 글꼴과 앱 내장 글꼴입니다. 기타 설치 글꼴은 고정폭이
        아닐 수 있습니다.
      </p>
    </div>
  );
}
