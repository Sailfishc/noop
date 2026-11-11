// Remi's page-level helpers: the layout constants that line the columns up, the header, who wrote a message, an
// agent's state. Components that only draw (buttons, fields, tags...) are in app/ui.
import { type JSX, Text, View } from "nsh";
import { isAvailable as hasWindow, titleBar } from "nsh/desktop";
import { L, lang } from "../i18n";
import { colors, Icon, IconBtn, type IconName, Tag } from "../ui";
import { blockedReason, insecureRefused, runtimeLabel, type Agent, type Team } from "./api";

export const WIDE = 720;

// The three columns line up: every header is HEADER tall, and the sidebar's footer
// line sits level with the top of the channel and thread composers' boxes.
export const HEADER = 56;
/** The composer's button row under its text box. */
export const COMPOSER_TOOLBAR = 36;
/** Space under the composer's box. */
export const COMPOSER_GAP = 10;
/** The composer's text box while it is empty or short: two lines; it grows with longer text. */
export const COMPOSER_TEXT = 56;
/** The empty composer box: border, its text box, the button row, border. */
const COMPOSER_BOX = 1 + COMPOSER_TEXT + COMPOSER_TOOLBAR + 1;
/** The sidebar footer, as tall as the composer box and the space under it. */
export const FOOTER = COMPOSER_BOX + COMPOSER_GAP;
/** The window's own title bar area (its traffic lights on macOS): content at the window's top left keeps clear of it. */
export const chrome = () => (hasWindow ? titleBar() : { height: 0, left: 0, right: 0 });
/** Why a call to `url` got no response; `error` is the network stack's reason (Reply.error). */
export const unreachable = (url: string, error?: string) =>
  insecureRefused(error) && url.startsWith("http://")
    ? L(`This app may not use plain http to ${url}. Give the server an https address (see the server README), or use a build that allows http.`,
        `这个 App 不允许用不加密的 http 连接 ${url}。请给服务端配上 https 地址（见服务端 README），或换用允许 http 的版本。`)
    : L(`Can’t reach ${url}. Check the address and your network.`, `连不上服务器 ${url}，请检查地址和网络`);

export const time = (ms: number) => {
  const d = new Date(ms), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

export function Header(props: { title: string; subtitle?: string; back?: boolean; onBack?: () => void; right?: JSX.Element; backLabel?: string; icon?: IconName; iconLabel?: string }) {
  return (
    <View desktop={{ windowDrag: true }} style={{ height: HEADER, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <If when={props.back}>
        <IconBtn icon="back" testID="back" label={props.backLabel ?? L("Back", "返回")} onPress={() => props.onBack?.()} />
      </If>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <If when={props.icon}>
            {(icon) => <View testID="header-icon" accessibilityLabel={props.iconLabel}><Icon name={icon()} size={14} tint={colors.muted} /></View>}
          </If>
          <Text style={{ flex: 1, fontSize: 16.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.title}</Text>
        </View>
        <If when={props.subtitle}>
          <Text style={{ fontSize: 13, color: colors.muted, numberOfLines: 1 }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.right}
    </View>
  );
}

/** Who wrote it, as people read it. */
export function authorOf(t: Team, m: { kind: "user" | "agent"; id: string }) {
  if (m.kind === "agent") {
    const a = t.agents().find((x) => x.id === m.id);
    return { name: a?.name || a?.handle || L("Agent", "Agent"), handle: a?.handle ?? "", agent: true };
  }
  const u = t.users().find((x) => x.id === m.id);
  return { name: u?.name || u?.handle || "?", handle: u?.handle ?? "", agent: false };
}

export const failed = (r: { status: number; data: any }) =>
  typeof r.data?.error === "string" && r.data.error ? r.data.error : L(`The server returned ${r.status}`, `服务器返回 ${r.status}`);

/** Which runtime an agent runs: shown wherever an agent is (lists, the @ picker, members, task cards). */
export function RuntimeBadge(props: { runtime: string; testID?: string }) {
  return <Tag testID={props.testID} label={runtimeLabel(props.runtime)} tone={props.runtime === "codex" ? "accent" : "muted"} />;
}

/** An agent's status dot (as in Raft): grey offline (no machine, or it is off), orange an error it can't get past by
 * itself (its runtime missing or logged out, or its last run failed), yellow working, green ready. What a task needs
 * from people is on the task, not here. */
export function agentState(t: Team, a: Agent): { label: string; tone: "up" | "warn" | "danger" | "muted" | "accent"; blocked: boolean } {
  const m = t.machines().find((x) => x.id === a.machine_id);
  const why = blockedReason(a, m, lang() !== "zh");
  if (!a.machine_id || !m || !m.online) return { label: L(`Offline: ${why}`, `离线：${why}`), tone: "muted", blocked: true };
  if (why) return { label: L(`Error: ${why}`, `出错：${why}`), tone: "danger", blocked: true };
  const ts = Object.values(t.tasks()).filter((x) => x.agent_id === a.id);
  const working = ts.filter((x) => x.state === "running" || x.state === "queued").length;
  if (working) return { label: L(`Working · ${working} task${working > 1 ? "s" : ""}`, `工作中 · ${working} 个任务`), tone: "warn", blocked: false };
  const last = ts.filter((x) => x.state !== "closed").sort((x, y) => y.updated - x.updated)[0];
  if (last?.state === "failed") return { label: L("Error: its last run failed", "出错：上次运行失败"), tone: "danger", blocked: false };
  return { label: L("Ready", "空闲"), tone: "up", blocked: false };
}

export const mono = { fontFamily: "monospace" } as const;
