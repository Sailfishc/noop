import { safeArea, View, windowSize, type JSX } from "nsh";
import { Dialog } from "nsh/base";
import { colors, floatSurface, radius, space } from "./theme";

/**
 * A sheet that rises from the bottom of a phone's screen (nsh/base's `Dialog`, sliding in; Escape, back, the backdrop
 * and a swipe down close it): how a dialog, an ⓘ note and a menu present on touch screens, where the thumb is. Its top
 * corners are the floating radius; it keeps clear of the home indicator. `Modal` and `Noted` use it on phones.
 */
export function Sheet(props: { open: boolean; onClose: () => void; testID?: string; children: JSX.Element }) {
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation="slide"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      style={{ flex: 1, justifyContent: "flex-end", pointerEvents: "box-none" }}
    >
      <View
        style={[floatSurface(), {
          width: "100%",
          maxHeight: windowSize().height - safeArea().top - space.xxl,
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          borderTopLeftRadius: radius.float,
          borderTopRightRadius: radius.float,
          paddingBottom: safeArea().bottom,
          backgroundColor: colors.floatSolid,
          overflow: "hidden",
        }]}
      >
        {props.children}
      </View>
    </Dialog>
  );
}
