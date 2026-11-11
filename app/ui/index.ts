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
export { Btn } from "./button";
export { Field, growing } from "./field";
export { ErrorNote } from "./error-note";
export { Choice } from "./choice";
export { Avatar } from "./avatar";
export { Dot, StateDot } from "./dot";
export { Label, Noted } from "./noted";
export { Panel } from "./panel";
export { Tag } from "./tag";
export { PickCard } from "./pick-card";
