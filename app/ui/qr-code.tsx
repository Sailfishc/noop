import { Canvas, View } from "nsh";
import { qrModules } from "./qr";
import { radius } from "./theme";

/**
 * `value` as a QR code, `size` points square. Always black on white with a quiet zone, in dark mode too: phone
 * cameras read dark-on-light codes, not inverted ones. Nothing shows when the text is too long for a code.
 */
export function QrCode(props: { value: string; size?: number; label?: string; testID?: string }) {
  const size = () => props.size ?? 160;
  const modules = () => qrModules(props.value);
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.label}
      style={{ width: size(), height: size(), borderRadius: radius.md, backgroundColor: "#ffffff", overflow: "hidden" }}
    >
      <Canvas
        style={{ pointerEvents: "none", width: size(), height: size() }}
        draw={(cx, { width }) => {
          const m = modules();
          if (!m) return;
          const quiet = 3; // modules of white around it (the white box adds the rest)
          const cell = width / (m.length + quiet * 2);
          cx.fillStyle = "#000000";
          for (let r = 0; r < m.length; r++) {
            for (let c = 0; c < m.length; c++) {
              // a hair wider than the cell, so neighbouring modules leave no seam
              if (m[r][c]) cx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell + 0.5, cell + 0.5);
            }
          }
        }}
      />
    </View>
  );
}
