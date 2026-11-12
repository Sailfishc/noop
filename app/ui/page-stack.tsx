import { View, type JSX } from "nsh";
import { createNavStack, NavPage, NavStack, type NavStackState } from "nsh/base";
import { colors } from "./theme";

/** The pages of a `PageStack`, bottom to top: the app's own values (nsh/base's `createNavStack`). */
export const createPageStack = <R,>(routes: R[]) => createNavStack<R>(routes);
export type PageStackState<R> = NavStackState<R>;

/**
 * One page at a time, the next pushed over the last (phones): the system's own stack (nsh/base's `NavStack`:
 * UINavigationController on iOS, predictive back on Android), so a swipe from the left edge goes back, following the
 * finger. Pages draw their own header (Remi's `Header`, the same on every platform), so the system header stays
 * hidden. `onBack` hears the pages left after the person went back by a swipe or the system's back; the app keeps
 * its own state in step.
 */
export function PageStack<R>(props: { state: PageStackState<R>; testID?: string; onBack?: (routes: readonly R[]) => void; children: (route: R) => JSX.Element }) {
  return (
    <NavStack state={props.state} testID={props.testID} style={{ flex: 1 }} onChange={(e) => props.onBack?.(e.routes)}>
      {(route) => (
        <NavPage headerVisible={false}>
          <View style={{ flex: 1, backgroundColor: colors.page }}>{props.children(route)}</View>
        </NavPage>
      )}
    </NavStack>
  );
}
