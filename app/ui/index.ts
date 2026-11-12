// Remi's component library: the one place that decides how things look. Pages (app/team) lay these out and add
// logic; they don't set font sizes, radii or colors themselves, and they don't import nsh/base directly.
// Each component is one file; see AGENTS.md ("Client components") and app/ui/README.md for the tiers, the checks and
// the showcase screen.
//
// What pages may still read of the tokens is listed here and nothing more: `colors`, `radius`, `hovered` and `tone`
// are the old pages' debt (they still draw some things themselves), `blackTheme` the appearance setting,
// `scrollbarTheme` the app's root. New page code uses components.
export { blackTheme, colors, hovered, radius, tone, type Tone } from "./theme";
export { scrollbarTheme } from "./scrollbar-theme";
export { AppFrame, titleBarHeight } from "./frame";
export { Icon, type IconName } from "./icons";
export { Spinner } from "./spinner";
export { Toggle } from "./switch";
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
export { MenuHeading, MenuIcon, MenuLine, MenuRow, PopMenu, RowMenu } from "./menu";
export { CommandPalette, Keys, type PaletteItem } from "./palette";
export { AskCard } from "./ask-card";
export { StateDot, StateMark, type AgentStateKind } from "./agent-state";
export { ListHeading, ListRow } from "./list-row";
export { Split } from "./split";
export { AccountRow } from "./account-row";
export { Tabs } from "./tabs";
export { TabBar } from "./tab-bar";
export { Sheet } from "./sheet";
export { Link } from "./link";
export { createPageStack, PageStack, type PageStackState } from "./page-stack";
export { feelDone } from "./haptics";
export { Empty } from "./empty";
export { Count } from "./count";
export { collapseNext, DoneMark } from "./motion";
export { QrCode } from "./qr-code";
export { canScan, QrScanner } from "./qr-scanner";
