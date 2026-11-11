import { platform, View, WebView } from "nsh";
import { L } from "../i18n";
import { scannerPage } from "./qr-scanner-page";
import { scale } from "./theme";

/**
 * Whether this platform can show the scanner: a web view whose page may use the camera (`capabilities.webview.media`)
 * at a secure origin (inline HTML at `baseUrl`). iOS, Android and macOS; not the web (the client is served over plain
 * http, and its iframe gets no camera) and not Windows (its web view takes no `baseUrl` for inline HTML).
 */
export const canScan = () => platform.os === "ios" || platform.os === "android" || platform.os === "macos";

/** Inline HTML gets this origin: https makes the page a secure context, which `getUserMedia` needs. Nothing loads from it. */
const ORIGIN = "https://localhost/";

/**
 * The camera, reading QR codes: a web view whose page shows the back camera and decodes each frame with jsQR. Every
 * code it reads is `onScan(text)` (the same code again only after 2 s); the caller decides whether it is one it wants.
 * Without a live camera (refused, none, or a web view that won't give one) the page offers to take a photo instead,
 * through the system's camera, and reads that. Test id: `<testID>` the web view.
 */
export function QrScanner(props: { onScan: (text: string) => void; height?: number; testID?: string }) {
  const text = {
    aim: L("Point the camera at the QR code", "把二维码放进框里"),
    starting: L("Starting the camera…", "正在打开摄像头…"),
    denied: L("Camera access is off. Allow it in the system settings, or take a photo instead.", "没有摄像头权限，可以在系统设置里打开，或者拍照识别"),
    none: L("No camera here. Take a photo instead.", "打不开摄像头，可以拍照识别"),
    photo: L("Take a photo", "拍照识别"),
    missed: L("No QR code in that photo. Try again closer.", "照片里没认出二维码，靠近一点再试"),
  };
  return (
    <View style={{ height: props.height ?? 320, borderRadius: scale.radius.md, overflow: "hidden", backgroundColor: "#000000" }}>
      <WebView
        testID={props.testID}
        html={scannerPage(text)}
        baseUrl={ORIGIN}
        scrollable={false}
        incognito
        style={{ flex: 1 }}
        onMessage={({ data }) => {
          try {
            const m = JSON.parse(data);
            if (m?.type === "code" && typeof m.text === "string") props.onScan(m.text);
          } catch { /* not the page's */ }
        }}
      />
    </View>
  );
}
