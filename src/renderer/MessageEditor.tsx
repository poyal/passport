import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  Bold,
  Italic,
  Heading1,
  List,
  ListOrdered,
  Quote,
  Code2,
  Undo2,
  Redo2,
  Pilcrow,
} from "lucide-react";

export function MessageEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  const [source, setSource] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(value);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false,
        underline: false,
        heading: { levels: [1, 2, 3] },
      }),
      Markdown,
    ],
    content: "",
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "메시지",
        "aria-multiline": "true",
        "data-placeholder": "전달할 내용을 입력하세요…",
      },
      // Pasted web HTML and dropped files never create embedded resources.
      // Attachments are selected explicitly below the editor.
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain");
        if (text !== undefined) view.dispatch(view.state.tr.insertText(text));
        return true;
      },
      handleDrop(_view, event) {
        return !!event.dataTransfer?.files.length;
      },
    },
    onUpdate({ editor }) {
      if (source) return;
      const markdown = editor.isEmpty ? "" : editor.getMarkdown();
      current.current = markdown;
      onChange(markdown);
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  useEffect(() => {
    if (!editor || value === current.current) return;
    current.current = value;
    // Parent clears the draft only after send succeeds. Restore drafts on mount.
    if (!value) editor.commands.clearContent(false);
    else if (!source) setSource(true);
  }, [editor, value, source]);
  // Remounting the compose tab preserves exact source (including unsupported MD).
  useEffect(() => {
    if (value) setSource(true);
  }, []);
  const showEditor = () => {
    if (!editor) return;
    const lines = value.split(/\r?\n/);
    // Keep complex or unsupported source intact instead of silently losing it.
    if (
      value.length > 65536 ||
      lines.length > 2048 ||
      lines.some(
        (line) => line.length > 8192 || /^(?: {0,3}>[ \t]*){33}/.test(line),
      ) ||
      /<[^>]*>|!\[|\[[^\]]*\]\(|^\s*\|/m.test(value)
    ) {
      setError(
        "이 내용은 원문 모드로 편집해 주세요. HTML·이미지·링크·표 또는 복잡한 문법을 그대로 유지합니다.",
      );
      return;
    }
    try {
      editor.commands.setContent(value, {
        contentType: "markdown",
        emitUpdate: false,
      });
      current.current = value;
      setSource(false);
      setError("");
    } catch {
      setError(
        "서식으로 바꿀 수 없는 내용입니다. 원문에서 계속 편집할 수 있습니다.",
      );
    }
  };
  const actions = editor
    ? [
        {
          label: "본문",
          Icon: Pilcrow,
          active: editor.isActive("paragraph"),
          run: () => editor.chain().focus().setParagraph().run(),
        },
        {
          label: "제목",
          Icon: Heading1,
          active: editor.isActive("heading", { level: 1 }),
          run: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        },
        {
          label: "굵게",
          Icon: Bold,
          active: editor.isActive("bold"),
          run: () => editor.chain().focus().toggleBold().run(),
        },
        {
          label: "기울임",
          Icon: Italic,
          active: editor.isActive("italic"),
          run: () => editor.chain().focus().toggleItalic().run(),
        },
        {
          label: "글머리 목록",
          Icon: List,
          active: editor.isActive("bulletList"),
          run: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          label: "번호 목록",
          Icon: ListOrdered,
          active: editor.isActive("orderedList"),
          run: () => editor.chain().focus().toggleOrderedList().run(),
        },
        {
          label: "인용",
          Icon: Quote,
          active: editor.isActive("blockquote"),
          run: () => editor.chain().focus().toggleBlockquote().run(),
        },
        {
          label: "코드 블록",
          Icon: Code2,
          active: editor.isActive("codeBlock"),
          run: () => editor.chain().focus().toggleCodeBlock().run(),
        },
      ]
    : [];
  return (
    <div className="share-editor">
      <div className="share-editor-heading">
        <span>메시지</span>
        <div
          className="share-editor-mode"
          role="group"
          aria-label="메시지 편집 모드"
        >
          <button type="button" aria-pressed={!source} onClick={showEditor}>
            서식 편집
          </button>
          <button
            type="button"
            aria-pressed={source}
            onClick={() => {
              setSource(true);
              setError("");
            }}
          >
            Markdown 원문
          </button>
        </div>
      </div>
      <div className="share-editor-surface">
        {!source && (
          <div
            className="share-format-toolbar"
            role="group"
            aria-label="메시지 서식"
          >
            {actions.map(({ label, Icon, active, run }) => (
              <button
                type="button"
                key={label}
                title={label}
                aria-label={label}
                aria-pressed={active}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={run}
              >
                <Icon size={16} />
              </button>
            ))}
            <span className="share-toolbar-divider" />
            <button
              type="button"
              title="실행 취소"
              aria-label="실행 취소"
              disabled={disabled || !editor?.can().undo()}
              onClick={() => editor?.chain().focus().undo().run()}
            >
              <Undo2 size={16} />
            </button>
            <button
              type="button"
              title="다시 실행"
              aria-label="다시 실행"
              disabled={disabled || !editor?.can().redo()}
              onClick={() => editor?.chain().focus().redo().run()}
            >
              <Redo2 size={16} />
            </button>
          </div>
        )}
        {source ? (
          <textarea
            aria-label="Markdown 메시지"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Markdown 원문을 입력하세요…"
          />
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
      {error && (
        <p className="hint" role="status">
          {error}
        </p>
      )}
      <div className="share-editor-caption">
        <span>{value.length.toLocaleString()}자</span>
      </div>
    </div>
  );
}
