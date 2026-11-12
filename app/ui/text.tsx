import { Text, type JSX } from "nsh";
import { size, tone, type Tone } from "./theme";

/** The five steps of the type scale, by what the text is. */
export type TextVariant = "caption" | "body" | "message" | "title" | "display";
/** The text's color, by role. */
export type TextTone = Tone;

const weights = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;

/**
 * Text, by what it is rather than by size: `caption` (a note, a time, meta), `body` (most text), `message` (messages,
 * what people type), `title` (a section or a panel), `display` (a page); each a step larger on touch screens. Titles
 * default to semibold. `tone` is the foreground at full strength (`default`), weaker (`muted`, `faint`), the attention
 * color (only for what waits on you) or a status. `lines` cuts it to that many lines; `grow` lets it take the rest of
 * a row; `tabular` lines figures up.
 */
export function Txt(props: {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: keyof typeof weights;
  lines?: number;
  grow?: boolean;
  tabular?: boolean;
  mono?: boolean;
  center?: boolean;
  testID?: string;
  children: JSX.Element;
}) {
  const v = () => props.variant ?? "body";
  const weight = () => props.weight ?? (v() === "title" || v() === "display" ? "semibold" : "regular");
  return (
    <Text
      testID={props.testID}
      style={{
        fontSize: size.text[v()],
        lineHeight: size.leading[v()],
        fontWeight: weights[weight()],
        color: tone(props.tone ?? "default").fg,
        numberOfLines: props.lines,
        flex: props.grow ? 1 : undefined,
        flexShrink: props.grow ? 1 : undefined,
        textAlign: props.center ? "center" : undefined,
        fontVariant: props.tabular ? ["tabular-nums"] : undefined,
        fontFamily: props.mono ? "monospace" : undefined,
      }}
    >
      {props.children}
    </Text>
  );
}
