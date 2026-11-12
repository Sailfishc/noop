import { openUrl, View } from "nsh";
import { TextView } from "nsh/base";
import { colors, radius, size, space, stroke } from "./theme";

/**
 * Renders a Markdown document (a report, design doc or note in the workspace panel) with `html: false` so embedded HTML
 * is shown as plain text and never executed (Q27).
 */
export function DocView(props: { text: string; testID?: string }) {
  return (
    <View testID={props.testID} style={{ padding: space.lg, borderRadius: radius.lg, borderWidth: stroke.hairline, borderColor: colors.hairline, backgroundColor: colors.raised }}>
      <TextView
        document={TextView.parse(props.text, { math: false, html: false })}
        selectable
        onLinkPress={({ url }) => {
          if (/^(https?|mailto):/i.test(url)) void openUrl(url).catch(() => {});
        }}
        styles={{
          root: { gap: space.md, fontSize: size.text.message, lineHeight: size.leading.message, color: colors.fg },
          heading1: { fontSize: size.text.display, lineHeight: size.leading.display, fontWeight: "600", color: colors.fg },
          heading2: { fontSize: size.text.title, lineHeight: size.leading.title, fontWeight: "600", color: colors.fg },
          heading3: { fontSize: size.text.message, lineHeight: size.leading.message, fontWeight: "600", color: colors.fg },
          code: { fontFamily: "monospace", fontSize: size.text.body, color: colors.fg, backgroundColor: colors.selected },
          codeBlock: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.hover },
          codeBlockCode: { fontFamily: "monospace", fontSize: size.text.caption, lineHeight: size.leading.caption, color: colors.fg },
          blockquote: { paddingLeft: space.md, color: colors.fg2 },
          link: { color: colors.fg },
        }}
      />
    </View>
  );
}
