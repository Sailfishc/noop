// The composer's formatting buttons: Markdown around the selection, or at the caret.

export type Format = "bold" | "italic" | "strike" | "code" | "codeblock" | "quote" | "list" | "numbered" | "link";

/** Markdown the formatting buttons put around the selection (or at the caret). */
export function formatText(text: string, sel: { start: number; end: number }, kind: Format): { text: string; start: number; end: number } {
  const { start, end } = sel, picked = text.slice(start, end);
  const wrap = (open: string, close = open) => {
    const inner = picked;
    const next = text.slice(0, start) + open + inner + close + text.slice(end);
    return { text: next, start: start + open.length, end: start + open.length + inner.length };
  };
  switch (kind) {
    case "bold": return wrap("**");
    case "italic": return wrap("_");
    case "strike": return wrap("~~");
    case "code": return wrap("`");
    case "codeblock": {
      const before = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
      return wrap(`${before}\`\`\`\n`, "\n```\n");
    }
    case "link": {
      const label = picked || "link";
      const next = text.slice(0, start) + `[${label}](https://)` + text.slice(end);
      const at = start + label.length + 3 + "https://".length;
      return { text: next, start: at, end: at };
    }
    default: {
      const from = text.lastIndexOf("\n", start - 1) + 1;
      const to = (() => { const i = text.indexOf("\n", Math.max(end - (end > start && text[end - 1] === "\n" ? 1 : 0), start)); return i < 0 ? text.length : i; })();
      const lines = text.slice(from, to).split("\n");
      const marked = lines.map((l, i) => (kind === "quote" ? "> " : kind === "list" ? "- " : `${i + 1}. `) + l).join("\n");
      const next = text.slice(0, from) + marked + text.slice(to);
      return { text: next, start: from + marked.length, end: from + marked.length };
    }
  }
}

