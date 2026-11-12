import { cleanup, platform, signal, View, WebView } from "nsh";
import { L } from "../i18n";
import { scannerPage } from "./qr-scanner-page";
import { Txt } from "./text";
import { radius, space } from "./theme";

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
 * through the system's camera, and reads that. When the page itself doesn't come up (no web view, the page refused,
 * or no word from it in 3 s) the box says so with the code, instead of staying black. Test ids: `<testID>` the web
 * view, `<testID>-problem` that note.
 */
export function QrScanner(props: { onScan: (text: string) => void; height?: number; testID?: string }) {
  const text = {
    aim: L("Point the camera at the QR code", "把二维码放进框里"),
    starting: L("Starting the camera…", "正在打开摄像头…"),
    denied: L("Camera access is off. Allow it in the system settings, or take a photo instead.", "没有摄像头权限，可以在系统设置里打开，或者拍照识别"),
    none: L("No camera here. Take a photo instead.", "打不开摄像头，可以拍照识别"),
    photo: L("Take a photo", "拍照识别"),
    missed: L("No QR code in that photo. Try again closer.", "照片里没认出二维码，靠近一点再试"),
    stalled: L("The camera opened but shows nothing. Take a photo instead.", "摄像头打开了但没有画面，可以拍照识别"),
  };
  /** What the web view reported failing (stays), and whether 3 s passed with no word from the page (clears when one comes late). */
  const failed = signal("");
  const heard = signal(false);
  const late = signal(false);
  const problem = () =>
    failed() || (late() && !heard() ? L("The scanner page didn't load (no answer in 3 s). Install a full build of the app (NSH 0.5).", "扫码页面没有加载出来（3 秒无响应）。请安装完整重新打包的 App（NSH 0.5）") : "");
  const wait = setTimeout(() => late.set(true), 3000);
  cleanup(() => clearTimeout(wait));
  return (
    <View style={{ height: props.height ?? 320, borderRadius: radius.md, overflow: "hidden", backgroundColor: "#000000" }}>
      <WebView
        testID={props.testID}
        html={scannerPage(text)}
        baseUrl={ORIGIN}
        scrollable={false}
        incognito
        style={{ flex: 1 }}
        onError={(e) => failed.set(L(`The scanner page didn't load: ${e.message}`, `扫码页面没有加载出来：${e.message}`) + (e.code ? ` (${e.code})` : ""))}
        onMessage={({ data }) => {
          heard.set(true);
          try {
            const m = JSON.parse(data);
            if (m?.type === "code" && typeof m.text === "string") props.onScan(m.text);
          } catch { /* not the page's */ }
        }}
      />
      <If when={problem()}>
        <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: space.xl, backgroundColor: "#000000" }}>
          <Txt testID={props.testID ? `${props.testID}-problem` : undefined} tone="faint">{problem()}</Txt>
        </View>
      </If>
    </View>
  );
}
