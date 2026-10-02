import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className = "",
  ...rest
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  [key: string]: unknown;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      data-tooltip={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}
export function SettingsTabs<T extends string>({
  label,
  value,
  onChange,
  items,
  children,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: { id: T; label: string }[];
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="settings-tabs">
      <div className="settings-tab-list" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            type="button"
            role="tab"
            key={item.id}
            id={`${id}-${item.id}`}
            aria-controls={`${id}-panel`}
            aria-selected={value === item.id}
            tabIndex={value === item.id ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % items.length
                  : event.key === "ArrowLeft"
                    ? (index + items.length - 1) % items.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              onChange(items[next].id);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>("button")
                [next]?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${value}`}
        className="settings-tab-panel"
      >
        {children}
      </div>
    </div>
  );
}
export function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="toggle-field">
      <span id={id}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        className="switch-control"
        onClick={() => onChange(!checked)}
      >
        <span className="switch-track" aria-hidden="true">
          <span />
        </span>
        <span aria-hidden="true">{checked ? "ON" : "OFF"}</span>
      </button>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first =
      ref.current?.querySelector<HTMLElement>(
        "input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
      ) ?? ref.current?.querySelector<HTMLElement>("button:not(:disabled)");
    first?.focus();
    window.dispatchEvent(new Event("passport-view-changed"));
    return () => {
      previous?.focus();
      // React's effect cleanup can run before the dialog leaves the DOM.
      requestAnimationFrame(() =>
        window.dispatchEvent(new Event("passport-view-changed")),
      );
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""} ${className}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const elements = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
              ),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <IconButton label="닫기" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
export const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(
    null,
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const hide = () => {
      clearTimeout(timer);
      setTip(null);
    };
    const show = (event: Event) => {
      hide();
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-tooltip],[title]")
          : null;
      const text = target?.dataset.tooltip || target?.title;
      if (!target || !text) return;
      timer = setTimeout(() => {
        const r = target.getBoundingClientRect();
        setTip({
          text,
          x: Math.max(140, Math.min(innerWidth - 140, r.left + r.width / 2)),
          y: r.bottom + 8 > innerHeight - 50 ? r.top - 42 : r.bottom + 8,
        });
      }, 300);
    };
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    for (const event of [
      "pointerout",
      "focusout",
      "pointerdown",
      "keydown",
      "scroll",
    ])
      document.addEventListener(event, hide, true);
    return () => {
      hide();
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      for (const event of [
        "pointerout",
        "focusout",
        "pointerdown",
        "keydown",
        "scroll",
      ])
        document.removeEventListener(event, hide, true);
    };
  }, []);
  return tip
    ? createPortal(
        <div
          role="tooltip"
          className="tooltip"
          style={{ left: tip.x, top: tip.y }}
        >
          {tip.text}
        </div>,
        document.body,
      )
    : null;
}

export function NumberField({
  value,
  onChange,
  ...props
}: Omit<
  import("react").InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
> & { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      {...props}
      type="number"
      required
      value={draft}
      onChange={(event) => {
        event.currentTarget.setCustomValidity("");
        setDraft(event.target.value);
      }}
      onBlur={(event) => {
        const input = event.currentTarget;
        if (!input.checkValidity()) {
          input.setCustomValidity(
            `${props.min ?? "최솟값"}~${props.max ?? "최댓값"} 범위의 숫자를 입력하세요.`,
          );
          input.reportValidity();
          return;
        }
        if (Number(draft) !== value) onChange(Number(draft));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
