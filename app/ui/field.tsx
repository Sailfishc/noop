import { signal, Text, View, type InputRef } from "nsh";
import { Input } from "nsh/base";
import { colors, measure, radius, size, space, stroke } from "./theme";

/**
 * A one-line input with an optional label above and one line of hint below. Control height `md`, `small` the `sm` one
 * (inline editors: a title, a repository); `big` is a code (wide letter spacing, centered); `grow` takes the rest of a
 * row.
 */
export function Field(props: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  testID?: string;
  hint?: string;
  autoFocus?: boolean;
  big?: boolean;
  small?: boolean;
  grow?: boolean;
  keyboardType?: "email-address" | "number-pad" | "url";
}) {
  return (
    <View style={{ gap: space.sm, flex: props.grow ? 1 : undefined }}>
      <If when={props.label}>
        <Text style={{ fontSize: size.text.message, fontWeight: "600", color: colors.fg }}>{props.label}</Text>
      </If>
      <Input
        testID={props.testID}
        value={props.value}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-fg-3"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        style={{
          minHeight: props.big ? measure.code : props.small ? size.control.sm : size.control.md,
          paddingHorizontal: props.small ? space.md : space.lg,
          borderRadius: radius.md,
          borderWidth: stroke.edge,
          borderColor: colors.edge,
          backgroundColor: colors.field,
          fontSize: props.big ? size.text.display : props.small ? size.text.body : size.text.message,
          color: colors.fg,
          ...(props.big ? { letterSpacing: space.md, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: size.text.body, lineHeight: size.leading.body, color: colors.fg2 }}>{props.hint}</Text>
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

/**
 * A multiline input that grows with its text from `min` to `max` points tall (see `growing`), in the message size.
 * Boxed like a `Field` by default; `bare` draws no box, for an input inside a box of its own (the composer). Return
 * sends `onSubmit` when it is given (Shift+Return breaks the line), and breaks the line otherwise.
 */
export function TextArea(props: {
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  placeholder?: string;
  testID?: string;
  autoFocus?: boolean;
  bare?: boolean;
  onSubmit?: () => void;
  ref?: (r: InputRef) => void;
  onSelectionChange?: (e: { start: number; end: number }) => void;
  onPaste?: (e: { files: File[]; uris: string[] }) => void;
}) {
  const padTop = space.md, padBottom = props.bare ? space.xs : space.md, border = props.bare ? 0 : 2 * stroke.edge;
  const grow = growing({ min: props.min, max: props.max, pad: padTop + padBottom + border, line: size.leading.message });
  return (
    <Input
      testID={props.testID}
      ref={props.ref}
      value={props.value}
      multiline
      autoFocus={props.autoFocus}
      submitBehavior={props.onSubmit ? "submit" : undefined}
      placeholder={props.placeholder}
      class="placeholder:text-fg-3"
      onChange={({ value }) => props.onChange(value)}
      onSubmit={() => props.onSubmit?.()}
      onSelectionChange={props.onSelectionChange ? ({ start, end }) => props.onSelectionChange!({ start, end }) : undefined}
      onPaste={props.onPaste ? ({ files, uris }) => props.onPaste!({ files, uris }) : undefined}
      onContentSizeChange={grow.onContentSizeChange}
      style={{
        height: grow.height(),
        paddingHorizontal: space.lg,
        paddingTop: padTop,
        paddingBottom: padBottom,
        fontSize: size.text.message,
        lineHeight: size.leading.message,
        color: colors.fg,
        ...(props.bare
          ? { backgroundColor: "transparent", borderWidth: 0 }
          : { borderRadius: radius.md, borderWidth: stroke.edge, borderColor: colors.edge, backgroundColor: colors.field }),
      }}
    />
  );
}
