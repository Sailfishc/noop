import { safeArea, View, type JSX } from "nsh";
import { colors, size, touch } from "./theme";

/** The window's title bar height on desktops (hidden title bar; the traffic lights sit in it). */
export const titleBarHeight = size.chrome.titleBar;

/** The app's root surface: the page color, and on touch screens the status bar's safe area kept clear. */
export function AppFrame(props: { children: JSX.Element }) {
  return <View style={{ flex: 1, backgroundColor: colors.page, paddingTop: touch ? safeArea().top : 0 }}>{props.children}</View>;
}
