// Remi's component library: the one place that decides how things look. Pages (app/team) lay these out and add
// logic; they don't set font sizes, radii or colors themselves, and they don't import nsh/base directly.
// Each component is one file; see AGENTS.md ("Client components") for the rules and the showcase screen.
export * from "./theme";
export * from "./popup";
export * from "./scrollbar-theme";
export { Icon, CheckMark, type IconName } from "./icons";
export { Spinner } from "./spinner";
export { follow, switchLook, Toggle } from "./switch";
export { Tip } from "./tip";
export { Txt, type TextTone, type TextVariant } from "./text";
export { Btn, IconBtn, type ButtonKind } from "./button";
export { Field, growing, TextArea } from "./field";
export { ErrorNote } from "./error-note";
export { Choice } from "./choice";
export { Avatar } from "./avatar";
export { Dot } from "./dot";
export { Label, Noted } from "./noted";
export { Card, Panel } from "./panel";
export { Tag } from "./tag";
export { TagMenu } from "./tag-menu";
export { PickCard } from "./pick-card";
export { confirm, Modal } from "./dialog";
export { toast, Toaster } from "./toast";
export { Dropdown } from "./select";
export { MenuHeading, MenuLine, MenuRow, PopMenu } from "./menu";
export { ListRow } from "./list-row";
export { AccountRow } from "./account-row";
export { Tabs } from "./tabs";
export { Empty } from "./empty";
export { Count } from "./count";
export { QrCode } from "./qr-code";
export { canScan, QrScanner } from "./qr-scanner";
