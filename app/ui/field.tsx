import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { colors, radius } from "./theme";

export function Field(props: { label?: string; value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder?: string; testID?: string; hint?: string; autoFocus?: boolean; big?: boolean; keyboardType?: "email-address" | "number-pad" | "url" }) {
  return (
    <View style={{ gap: 6 }}>
      <If when={props.label}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      </If>
      <Input
        testID={props.testID}
        value={props.value}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        style={{
          height: props.big ? 52 : 40,
          paddingHorizontal: 12,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: props.big ? 24 : 15,
          color: colors.text,
          ...(props.big ? { letterSpacing: 8, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.hint}</Text>
      </If>
    </View>
  );
}

/**
 * The height of a multiline `Input` that grows with its text, from `min` up to `max` (it scrolls past that), from the
 * text's size its `onContentSizeChange` reports (NSH's `Input` docs: "grow a multiline input with it"). It keeps one
 * `line` to spare under the text: on the Mac the native text view can wrap or space the text a line taller than NSH
 * measured it, and a box sized exactly hid the last line with nothing to scroll (the composer, 2026-11-10). `pad` is
 * the input's vertical padding and borders.
 */
export function growing(o: { min: number; max: number; pad: number; line: number }) {
  const text = signal(0);
  return {
    height: () => Math.min(o.max, Math.max(o.min, Math.ceil(text() + o.pad + o.line))),
    onContentSizeChange: ({ size }: { size: { height: number } }) => text.set(size.height),
  };
}
