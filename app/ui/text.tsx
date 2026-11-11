import { Text, type JSX } from "nsh";
import { colors, scale } from "./theme";

/** The five sizes of `app/theme.json`'s type scale, by what the text is. */
export type TextVariant = "caption" | "body" | "message" | "title" | "display";
/** The text's color, by role. */
export type TextTone = "default" | "muted" | "faint" | "accent" | "danger" | "warn" | "up";

const weights = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;
const lineHeights: Record<TextVariant, number> = { caption: 17, body: 19, message: 20, title: 22, display: 28 };
const toneColor = (t: TextTone) =>
  ({ default: colors.text, muted: colors.muted, faint: colors.faint, accent: colors.accent, danger: colors.danger, warn: colors.warn, up: colors.up })[t];

/**
 * Text, by what it is rather than by size: `caption` 12 (a note, a time, meta), `body` 13 (most text), `message` 14
 * (messages, what people type), `title` 16 (a section or a panel), `display` 22 (a page). Titles default to semibold.
 * `lines` cuts it to that many lines; `grow` lets it take the rest of a row; `tabular` lines figures up.
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
        fontSize: scale.text[v()],
        lineHeight: lineHeights[v()],
        fontWeight: weights[weight()],
        color: toneColor(props.tone ?? "default"),
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
