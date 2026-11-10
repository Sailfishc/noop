// TeamAgent settings: a page of its own (bottom-left menu, or ⌘,), in three groups:
//   个人: 账号 (profile, sign in on another device, signed-in devices, sign out), 通用 (language)
//   Agent 工作: 我的 Agent (list + detail; New agent picks a machine, then a runtime on it), 我的机器 (runtimes, Git credentials, agents)
//   团队·管理员: 成员与邀请, Git 平台 (the team's platforms, the GitLab webhook, each machine's credentials)
// An agent = one machine + one runtime on it + who can hand it work + its memory. A machine hosts many agents; the
// repository follows the task (a channel's default, or one named in the message), not the agent.
import { Clipboard, computed, effect, Scroll, signal, Storage, Text, untracked, View, windowSize, type JSX } from "nsh";
import { Dialog, Input } from "nsh/base";
import { L, lang, LANG_KEY } from "../i18n";
import { appearance, type Appearance, pickAppearance } from "./appearance";
import { notifyOn, notifyPermission, setNotify } from "./notify";
import { alpha, colors, hovered, Icon, type IconName, radius, Spinner, tints, Toggle } from "../ui";
import {
  installCommand, isLoopback, modelsOn, repoLabel, RUNTIMES, runtimeLabel, runtimeOn,
  type Agent, type Autonomy, type Device, type Dispatch, type DurationStats, type GitCred, type GitPlatform, type GitSettings, type Machine, type Metrics, type Team,
} from "./api";
import { SignupSection } from "./signups";
import { agentState, Avatar, chrome, Btn, Choice, Dot, ErrorNote, failed, Field, Label, mono, Panel, PickCard, RuntimeBadge, StateDot, Tag, time, WIDE } from "./ui";

export type SettingsTab = "account" | "general" | "agents" | "machines" | "people" | "git" | "metrics";

export const DISPATCH: { value: Dispatch; label: () => string; note: () => string }[] = [
  { value: "owner", label: () => L("Only me", "只有我"), note: () => L("Only you can hand it work.", "只有你能给它派活。") },
  { value: "channel", label: () => L("Members of its channels", "所在频道的成员"), note: () => L("Anyone in a channel it is in can @ it.", "它所在频道里的人都能 @它派活。") },
  { value: "team", label: () => L("The whole team", "整个团队"), note: () => L("Anyone can @ it, in any channel; it joins a channel it isn’t in yet when called there.", "团队里任何人都能 @它；在它还没加入的频道被 @ 时，它会自动加入。") },
];
const confirmNote = () => L("Work from anyone else waits for your “Start it”. What you hand it yourself starts at once.", "别人派的活，开工前要你点「确认开工」；你自己派的直接开工。");

/** Who may hand it work, and whether others' work waits for the owner: the scope, then the confirm switch. */
function DispatchControls(props: { dispatch: Dispatch; confirm: boolean; onDispatch: (v: Dispatch) => void; onConfirm: (v: boolean) => void; testID: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Choice testID={props.testID} options={DISPATCH.map((d) => ({ value: d.value, label: d.label() }))} value={props.dispatch} onChange={props.onDispatch} />
      <Text style={{ fontSize: 12.5, color: colors.faint }}>{DISPATCH.find((d) => d.value === props.dispatch)?.note() ?? ""}</Text>
      <If when={props.dispatch !== "owner"}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 4 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{L("Needs my confirmation", "需要我确认")}</Text>
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.faint }}>{confirmNote()}</Text>
          </View>
          <Toggle testID={`${props.testID}-confirm`} value={props.confirm} label={L("Needs my confirmation", "需要我确认")} onChange={props.onConfirm} />
        </View>
      </If>
    </View>
  );
}

/** The model of an agent's runtime: the runtime's default, one its machine reported, or any name typed in. */
export function ModelPicker(props: { models: string[]; value: string; onChange: (v: string) => void; testID: string }) {
  const query = signal("");
  const shown = () => {
    const q = query().trim().toLowerCase();
    const list = q ? props.models.filter((m) => m.toLowerCase().includes(q)) : props.models;
    return list.slice(0, 12);
  };
  const custom = () => {
    const q = query().trim();
    return q && !props.models.includes(q) ? q : "";
  };
  const chip = (value: string, label: string, testID: string) => (
    <View
      role="button"
      testID={testID}
      accessibilityState={{ selected: props.value === value }}
      onPress={() => { props.onChange(value); query.set(""); }}
      hoverStyle={hovered()}
      style={{
        height: 28, paddingHorizontal: 10, justifyContent: "center", borderRadius: 8, borderWidth: 1,
        borderColor: props.value === value ? colors.accentFill : colors.fieldBorder, backgroundColor: props.value === value ? tints.accent : "transparent",
      }}
    >
      <Text style={{ fontSize: 13, color: colors.text, ...(value ? mono : {}) }}>{label}</Text>
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {chip("", L("Runtime default", "Runtime 默认"), `${props.testID}-default`)}
        <If when={props.value && !props.models.includes(props.value)}>
          {chip(props.value, props.value, `${props.testID}-current`)}
        </If>
        <Each of={shown()}>{(m) => chip(m(), m(), `${props.testID}-${m()}`)}</Each>
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Field value={query()} onChange={(v) => query.set(v)} onSubmit={() => custom() && (props.onChange(custom()), query.set(""))}
            placeholder={props.models.length > 12 ? L(`Search ${props.models.length} models, or type another`, `在 ${props.models.length} 个模型里搜，或填别的模型名`) : L("Another model name", "填别的模型名")} testID={`${props.testID}-input`} />
        </View>
        <If when={custom()}>
          <Btn small testID={`${props.testID}-use`} label={L(`Use “${custom()}”`, `用「${custom()}」`)} onPress={() => { props.onChange(custom()); query.set(""); }} />
        </If>
      </View>
    </View>
  );
}
export const AUTONOMY: { value: Autonomy; label: () => string; note: () => string }[] = [
  { value: "cautious", label: () => L("Cautious", "谨慎"), note: () => L("Asks before anything that matters.", "要紧的事都先问。") },
  { value: "assist", label: () => L("Assist", "协助"), note: () => L("Decides small things, asks on real choices.", "小事自己定，真正的选择问人。") },
  { value: "auto", label: () => L("Autonomous", "自主"), note: () => L("Decides alone and says what it chose.", "自己拍板，事后说明。") },
];

const NAV: { group: () => string; items: { tab: SettingsTab; icon: IconName; label: () => string; admin?: boolean }[] }[] = [
  { group: () => L("Personal", "个人"), items: [
    { tab: "account", icon: "lock", label: () => L("Account", "账号") },
    { tab: "general", icon: "settings", label: () => L("General", "通用") },
  ] },
  { group: () => L("Agent work", "Agent 工作"), items: [
    { tab: "agents", icon: "spark", label: () => L("My agents", "我的 Agent") },
    { tab: "machines", icon: "terminal", label: () => L("My machines", "我的机器") },
  ] },
  { group: () => L("Team · admin", "团队 · 管理员"), items: [
    { tab: "people", icon: "mail", label: () => L("Members & invites", "成员与邀请") },
    { tab: "git", icon: "merge", label: () => L("Git platforms", "Git 平台") },
    { tab: "metrics", icon: "sliders", label: () => L("How we work", "协作数据") },
  ] },
];

const TITLES: Record<SettingsTab, () => string> = {
  account: () => L("Account", "账号"), general: () => L("General", "通用"), agents: () => L("My agents", "我的 Agent"),
  machines: () => L("My machines", "我的机器"), people: () => L("Members & invites", "成员与邀请"), git: () => L("Git platforms", "Git 平台"),
  metrics: () => L("How we work", "协作数据"),
};

/** The settings page. Wide: the nav beside the content. Narrow: the nav, then one section with a back button. */
export function SettingsPage(props: { team: Team; tab: SettingsTab | null; agent?: string; onTab: (tab: SettingsTab | null, agent?: string) => void; onClose: () => void; onSignOut: () => void }) {
  const t = props.team;
  const wide = computed(() => windowSize().width >= WIDE);
  const me = () => t.me();
  const mineCount = (tab: SettingsTab) =>
    tab === "agents" ? t.agents().filter((a) => a.owner_id === me()?.id).length : tab === "machines" ? t.machines().filter((m) => m.owner_id === me()?.id).length : 0;
  // a New agent dialog asked from elsewhere (a machine's "New agent on this machine")
  /** Narrow windows: the agent whose own page is open (list, then one agent). */
  const openAgent = () => (!wide() && props.tab === "agents" && props.agent ? t.agents().find((a) => a.handle === props.agent && a.owner_id === me()?.id) : undefined);
  const creating = signal<{ machine?: string } | null>(null);

  const nav = () => (
    <View style={{ flex: 1 }}>
      {/* the back button shares the title bar's row, right of the window's controls */}
      <View desktop={{ windowDrag: true }} style={{ height: Math.max(52, chrome().height), justifyContent: "center", paddingLeft: wide() && chrome().left ? chrome().left : 10, paddingRight: 10 }}>
        {/* phones: this is the Me tab, the tab bar leads back */}
        <If when={wide()} else={<Text style={{ paddingHorizontal: 6, fontSize: 22, fontWeight: "700", color: colors.text }}>{L("Me", "我")}</Text>}>
          <View role="button" testID="settings-back" onPress={props.onClose} hoverStyle={hovered()} style={{ alignSelf: "flex-start", height: 32, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: 8 }}>
            <Icon name="back" size={15} tint={colors.muted} />
            <Text style={{ fontSize: 14, color: colors.muted }}>{L("Back to workspace", "返回工作区")}</Text>
          </View>
        </If>
      </View>
    <Scroll testID="settings-nav" style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 10, paddingBottom: 10, gap: 2 }}>
      <Each of={NAV}>
        {(g) => (
          <View style={{ gap: 2, paddingBottom: 10 }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.faint, paddingHorizontal: 10, paddingVertical: 4 }}>{g().group()}</Text>
            <Each of={g().items}>
              {(it) => (
                <View
                  role="button"
                  testID={`settings-nav-${it().tab}`}
                  accessibilityState={{ selected: props.tab === it().tab }}
                  onPress={() => props.onTab(it().tab)}
                  hoverStyle={hovered()}
                  style={{ height: 34, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: props.tab === it().tab ? alpha(colors.text, 0.08) : "transparent" }}
                >
                  <Icon name={it().icon} size={15} tint={colors.muted} />
                  <Text style={{ flex: 1, fontSize: 14.5, color: colors.text }}>{it().label()}</Text>
                  <If when={mineCount(it().tab)}>
                    <Text style={{ fontSize: 12.5, color: colors.faint }}>{String(mineCount(it().tab))}</Text>
                  </If>
                  <If when={!wide()}><Icon name="chevron" size={12} tint={colors.faint} /></If>
                </View>
              )}
            </Each>
          </View>
        )}
      </Each>
    </Scroll>
    </View>
  );

  const content = (tab: SettingsTab) => {
    switch (tab) {
      case "account": return <AccountSection team={t} onSignOut={props.onSignOut} />;
      case "general": return <GeneralSection />;
      case "agents": return <AgentsSection team={t} selected={props.agent} onSelect={(h) => props.onTab("agents", h)} onNew={() => creating.set({})} onMachines={() => props.onTab("machines")} />;
      case "machines": return <MachinesSection team={t} onNewAgent={(id) => creating.set({ machine: id })} onAgent={(h) => props.onTab("agents", h)} />;
      case "people": return <PeopleSection team={t} />;
      case "git": return <GitSection team={t} />;
      case "metrics": return <MetricsSection team={t} />;
    }
  };

  return (
    <View testID="settings" style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}>
      <If
        when={wide()}
        else={
          <If when={props.tab} else={<View style={{ flex: 1, backgroundColor: colors.sidebar, paddingTop: chrome().left ? chrome().height : 0 }}>{nav()}</View>}>
            {(tab) => (
              <View style={{ flex: 1, paddingTop: chrome().left ? chrome().height : 0 }}>
                <View style={{ height: 52, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  {/* an agent's page goes back to the list of agents, a section to the Me tab */}
                  <View role="button" testID="back" accessibilityLabel={L("Back", "返回")} onPress={() => props.onTab(openAgent() ? "agents" : null)} hoverStyle={hovered()} style={{ width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="back" size={18} tint={colors.text} />
                  </View>
                  <Text style={{ fontSize: 16.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{openAgent()?.name ?? TITLES[tab()]()}</Text>
                </View>
                <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 16 }}>{content(tab())}</Scroll>
              </View>
            )}
          </If>
        }
      >
        <View style={{ width: 232, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.sidebar }}>{nav()}</View>
        <Scroll style={{ flex: 1 }} contentStyle={{ padding: 28, gap: 18, maxWidth: 920 }}>
          <Text style={{ fontSize: 22, fontWeight: "600", color: colors.text }}>{TITLES[props.tab ?? "account"]()}</Text>
          {content(props.tab ?? "account")}
        </Scroll>
      </If>
      <NewAgentDialog team={t} open={!!creating()} machine={creating()?.machine} onClose={() => creating.set(null)} onCreated={(h) => { creating.set(null); props.onTab("agents", h); }} />
    </View>
  );
}

// ---------------------------------------------------------------- 账号

function AccountSection(props: { team: Team; onSignOut: () => void }) {
  const t = props.team;
  const me = () => t.me();
  return (
    <>
      <Panel title={L("Profile", "个人资料")}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <Avatar name={me()?.name ?? "?"} size={48} />
          <View style={{ flex: 1, gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text testID="profile-name" style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{me()?.name ?? ""}</Text>
              <Tag label={me()?.role === "admin" ? L("Admin", "管理员") : L("Member", "成员")} tone={me()?.role === "admin" ? "accent" : "muted"} />
            </View>
            <Text style={{ fontSize: 13.5, color: colors.muted }}>{`@${me()?.handle ?? ""} · ${me()?.email ?? ""}`}</Text>
          </View>
        </View>
      </Panel>
      <LoginCodePanel team={t} />
      <DevicesPanel team={t} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 4 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 13, color: colors.muted }}>{L("Server", "服务器")}</Text>
          <Text testID="server-url" style={{ fontSize: 13.5, color: colors.text, ...mono }}>{t.shareUrl()}</Text>
          <If when={t.shareUrl() !== t.url}>
            <Text testID="server-connected" style={{ fontSize: 12.5, color: colors.faint }}>{L(`This device connects through ${t.url}`, `这台设备通过 ${t.url} 连接`)}</Text>
          </If>
          <LoopbackNote team={t} testID="server-loopback" />
        </View>
        <Btn testID="sign-out" kind="danger" label={L("Sign out", "退出登录")} onPress={props.onSignOut} />
      </View>
    </>
  );
}

/** Sign in on another device: a one-time code to type (or the link to open) there, valid 15 minutes. */
function LoginCodePanel(props: { team: Team }) {
  const t = props.team;
  const code = signal<{ code: string; link: string } | null>(null);
  const error = signal("");
  const busy = signal(false);
  async function make() {
    if (busy()) return;
    busy.set(true);
    error.set("");
    const r = await t.loginCode();
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    code.set({ code: r.data.code, link: `${t.shareUrl()}${r.data.path}` });
  }
  return (
    <Panel title={L("Sign in on another device", "在其他设备登录")}>
      <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>
        {L("On the other device choose Sign in, then enter this code with the server address, or paste the link.", "在另一台设备上选「登录」，填服务器地址和这个登录码，或者直接粘贴链接。")}
      </Text>
      <If when={code()}>
        {(c) => (
          <View style={{ gap: 6, padding: 12, borderRadius: radius.control, backgroundColor: tints.accent }}>
            <Text testID="login-code" style={{ fontSize: 24, letterSpacing: 3, color: colors.text, ...mono }}>{c().code}</Text>
            <Text testID="login-code-url" style={{ fontSize: 12.5, color: colors.muted, ...mono }}>{c().link}</Text>
            <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Valid for 15 minutes, works once.", "15 分钟内有效，只能用一次。")}</Text>
            <LoopbackNote team={t} testID="login-code-loopback" />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn small icon="copy" label={L("Copy link", "复制链接")} onPress={() => void Clipboard.writeText(c().link)} />
            </View>
          </View>
        )}
      </If>
      <ErrorNote text={error()} testID="login-code-error" />
      <View style={{ flexDirection: "row" }}>
        <Btn testID="login-code-create" label={code() ? L("New code", "重新生成") : L("Get a login code", "生成登录码")} busy={busy()} onPress={make} />
      </View>
    </Panel>
  );
}

/** "Chrome on macOS" from a user agent, roughly; enough to tell devices apart. */
function deviceName(ua: string) {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const app = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua ? "Remi" : L("Unknown device", "未知设备");
  return os ? `${app} · ${os}` : app;
}

function DevicesPanel(props: { team: Team }) {
  const t = props.team;
  const list = signal<Device[] | null>(null);
  const error = signal("");
  const load = async () => {
    const r = await t.devices();
    if (r.ok) list.set(r.data.sessions as Device[]);
    else error.set(failed(r));
  };
  void load();
  async function remove(id: string) {
    error.set("");
    const r = await t.removeDevice(id);
    if (!r.ok) return error.set(failed(r));
    list.update((l) => (l ?? []).filter((d) => d.id !== id));
  }
  return (
    <Panel title={L("Signed-in devices", "已登录的设备")}>
      <If when={list()} else={<Spinner size={16} tint={colors.muted} />}>
        {(l) => (
          <Each of={l()} key={(d) => d.id}>
            {(d) => (
              <View testID={`device-${d().id}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
                <Icon name={/iPhone|Android/.test(d().ua) ? "mobile" : "terminal"} size={18} tint={colors.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14.5, color: colors.text }}>{deviceName(d().ua)}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.muted }}>{L(`Signed in ${time(d().created)} · last seen ${time(d().last_seen)}`, `${time(d().created)} 登录 · 最近 ${time(d().last_seen)}`)}</Text>
                </View>
                <If when={!d().current} else={<Tag label={L("This device", "当前设备")} tone="up" />}>
                  <Btn small kind="ghost" testID={`device-remove-${d().id}`} label={L("Remove", "移除")} onPress={() => void remove(d().id)} />
                </If>
              </View>
            )}
          </Each>
        )}
      </If>
      <ErrorNote text={error()} />
    </Panel>
  );
}

// ---------------------------------------------------------------- 通用

const LOOKS: { value: Appearance; label: () => string }[] = [
  { value: "system", label: () => L("System", "跟随系统") },
  { value: "light", label: () => L("Light", "浅色") },
  { value: "dark", label: () => L("Dark", "深色") },
  { value: "black", label: () => L("Black", "黑色") },
];

function GeneralSection() {
  return (
    <>
      <Panel title={L("Appearance", "外观")}>
        <Choice testID="appearance" options={LOOKS.map((l) => ({ value: l.value, label: l.label() }))} value={appearance()} onChange={pickAppearance} />
        <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Dark is graphite; black is true black, easier on OLED screens. Kept on this device.", "深色是石墨灰，黑色是纯黑，适合 OLED 屏幕和暗光环境。只对这台设备生效。")}</Text>
      </Panel>
      <NotifyPanel />
      <Panel title={L("Language", "语言")}>
        <Choice
          testID="lang"
          options={[{ value: "zh", label: "中文" }, { value: "en", label: "English" }]}
          value={lang() === "zh" ? "zh" : "en"}
          onChange={(v) => { lang.set(v); void Storage.setItem(LANG_KEY, v); }}
        />
      </Panel>
    </>
  );
}

/** System notifications: the switch, and what the system lets the app do. */
function NotifyPanel() {
  const note = () => {
    const p = notifyPermission();
    if (!notifyOn()) return L("Off: only Waiting for you lists them.", "已关闭：只在「待你决定」里显示。");
    if (p === "denied") return L("The system blocks Remi’s notifications: allow them in System Settings › Notifications.", "系统禁止了 Remi 的通知：到「系统设置 › 通知」里打开。");
    if (p === "unavailable") return L("This build can’t show system notifications (on macOS, only the signed Remi.app can).", "当前版本发不了系统通知（macOS 上要用签名的 Remi.app）。");
    return L("Reminders that go off for you, tasks that come to Waiting for you, and @mentions of you. Kept on this device.", "到点的提醒、进入「待你决定」的任务、@你的消息。只对这台设备生效。");
  };
  return (
    <Panel title={L("Notifications", "通知")}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{L("System notifications", "系统通知")}</Text>
          <Text testID="notify-note" style={{ fontSize: 12.5, lineHeight: 18, color: colors.faint }}>{note()}</Text>
          <If when={notifyOn() && notifyPermission() === "default"}>
            <View style={{ flexDirection: "row", paddingTop: 6 }}>
              <Btn testID="notify-allow" small label={L("Allow notifications", "允许通知")} onPress={() => void setNotify(true)} />
            </View>
          </If>
        </View>
        <Toggle testID="notify" value={notifyOn()} label={L("System notifications", "系统通知")} onChange={(v) => void setNotify(v)} />
      </View>
    </Panel>
  );
}

// ---------------------------------------------------------------- 我的 Agent

function AgentsSection(props: { team: Team; selected?: string; onSelect: (handle: string) => void; onNew: () => void; onMachines: () => void }) {
  const t = props.team;
  const mine = () => t.agents().filter((a) => a.owner_id === t.me()?.id);
  const current = () => mine().find((a) => a.handle === props.selected) ?? mine()[0];
  const split = () => windowSize().width >= 1080;
  /** Phones: the list, or one agent's page (never both). */
  const narrow = () => windowSize().width < WIDE;
  const machineOf = (a: Agent) => t.machines().find((m) => m.id === a.machine_id);
  const list = () => (
    <View style={{ gap: 4, ...(split() ? { width: 280 } : {}) }}>
      <Each of={mine()} key={(a) => a.id}>
        {(a) => {
          const st = () => agentState(t, a());
          return (
            <View
              role="button"
              testID={`agent-${a().handle}`}
              accessibilityState={{ selected: current()?.id === a().id }}
              onPress={() => props.onSelect(a().handle)}
              hoverStyle={hovered()}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: current()?.id === a().id ? colors.accentFill : colors.border, backgroundColor: current()?.id === a().id ? tints.accent : colors.surface }}
            >
              <Avatar name={a().name} agent size={34} />
              <View style={{ flex: 1, gap: 3 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ fontSize: 14.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{a().name}</Text>
                  <Text style={{ fontSize: 13, color: colors.muted }}>@{a().handle}</Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <RuntimeBadge runtime={a().runtime} />
                  <Text style={{ flex: 1, fontSize: 12.5, color: colors.muted, numberOfLines: 1 }}>{machineOf(a())?.name ?? L("no machine", "没有机器")}</Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <StateDot tone={st().tone} />
                  <Text testID={`agent-${a().handle}-state`} style={{ fontSize: 12.5, color: st().blocked ? colors.danger : colors.muted, numberOfLines: 1 }}>{st().label}</Text>
                </View>
              </View>
              <If when={narrow()}><Icon name="chevron" size={13} tint={colors.faint} /></If>
            </View>
          );
        }}
      </Each>
    </View>
  );
  const picked = () => mine().find((a) => a.handle === props.selected);
  return (
    <If when={narrow() ? picked() : undefined} else={
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ flex: 1, fontSize: 13.5, lineHeight: 20, color: colors.muted }}>
          {L("An agent is one runtime on one of your machines. People @ it in channels to hand it work; the repository comes with the task.", "一个 Agent = 你某台机器上的一个 Runtime。大家在频道里 @它派活，仓库跟着任务走。")}
        </Text>
        <Btn small kind="primary" testID="agent-add" icon="plus" label={L("New agent", "新建 Agent")} onPress={props.onNew} />
      </View>
      <If when={mine().length} else={
        <Panel title={L("No agents yet", "还没有 Agent")}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{L("Create one: pick the machine it runs on, then the runtime there.", "新建一个：先选它跑在哪台机器上，再选那台机器上的 Runtime。")}</Text>
        </Panel>
      }>
        <If when={!narrow()} else={list()}>
        <View style={{ flexDirection: split() ? "row" : "column", alignItems: "flex-start", gap: 16 }}>
          {list()}
          <If when={current()}>
            {(a) => <AgentDetail team={t} agent={a()} onMachines={props.onMachines} />}
          </If>
        </View>
        </If>
      </If>
    </>
    }>
      {(a) => <AgentDetail team={t} agent={a()} onMachines={props.onMachines} />}
    </If>
  );
}

function AgentDetail(props: { team: Team; agent: Agent; onMachines: () => void }) {
  const t = props.team;
  const a = () => props.agent;
  const myMachines = () => t.machines().filter((m) => m.owner_id === t.me()?.id);
  const machine = () => t.machines().find((m) => m.id === a().machine_id);
  const st = () => agentState(t, a());
  const error = signal("");
  const moving = signal(false);
  const removing = signal(false);
  async function patch(p: Partial<Agent>) {
    error.set("");
    const r = await t.patchAgent(a().id, p);
    if (!r.ok) error.set(failed(r));
    return r.ok;
  }
  const runtimeNote = (name: string) => {
    const info = runtimeOn(machine(), name);
    if (!machine()) return "";
    if (!info) return machine()!.runtime_info?.length || machine()!.runtimes.length ? L("Not installed on this machine", "这台机器上没装") : L("The machine hasn’t reported yet", "机器还没上报");
    return [info.version ? `v${info.version}` : "", info.logged_in === true ? L("logged in", "已登录") : info.logged_in === false ? L("not logged in", "未登录") : ""].filter(Boolean).join(" · ");
  };
  return (
    <View testID={`agent-detail-${a().handle}`} style={{ flex: 1, alignSelf: "stretch", gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Avatar name={a().name} agent size={44} />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 18, fontWeight: "600", color: colors.text }}>{a().name}</Text>
            <Text style={{ fontSize: 14, color: colors.muted }}>@{a().handle}</Text>
            <RuntimeBadge runtime={a().runtime} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <StateDot tone={st().tone} />
            <Text style={{ fontSize: 13, color: st().blocked ? colors.danger : colors.muted }}>{st().label}</Text>
          </View>
        </View>
      </View>
      <AgentText team={t} agent={a()} field="description" label={L("What it does", "职责")} placeholder={L("e.g. writes and fixes tests for the payments backend", "比如：给支付后端补测试、修测试")} />

      <Panel title={L("Runs on", "运行在")}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Dot on={!!machine()?.online} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14.5, fontWeight: "500", color: colors.text }}>{machine()?.name ?? L("No machine", "没有机器")}</Text>
            <Text style={{ fontSize: 12.5, color: colors.muted }}>{machine() ? [machine()!.online ? L("online", "在线") : L("offline", "离线"), machine()!.os, L(`${machine()!.max_sessions} at a time`, `同时 ${machine()!.max_sessions} 个`)].filter(Boolean).join(" · ") : L("Pick one of your machines.", "选一台你的机器。")}</Text>
          </View>
          <If when={myMachines().length} else={<Btn small label={L("Add a machine", "添加机器")} onPress={props.onMachines} />}>
            <Btn small testID={`agent-move-${a().handle}`} label={L("Change machine", "换机器")} onPress={() => moving.update((v) => !v)} />
          </If>
        </View>
        <If when={moving()}>
          <Choice testID={`agent-machine-${a().handle}`} options={myMachines().map((m) => ({ value: m.id, label: m.name }))} value={a().machine_id ?? ""} onChange={async (v) => { if (await patch({ machine_id: v })) moving.set(false); }} />
        </If>
        <Label text="Runtime" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Each of={[...RUNTIMES]}>
            {(r) => (
              <PickCard
                testID={`agent-runtime-${a().handle}-${r().name}`}
                title={r().label}
                note={runtimeNote(r().name)}
                picked={a().runtime === r().name}
                disabled={!r().ready}
                onPress={() => a().runtime !== r().name && void patch({ runtime: r().name, model: "" })}
              />
            )}
          </Each>
        </View>
        <Label text={L("Model", "模型")} note={modelsOn(machine(), a().runtime).length ? L(`What ${machine()?.name ?? "its machine"} offers for ${runtimeLabel(a().runtime)}, or any name it accepts.`, `${machine()?.name ?? "机器"} 上 ${runtimeLabel(a().runtime)} 可用的模型，也可以填它认的其他名字。`) : L("Its machine listed none; the runtime’s default, or a name it accepts.", "机器没有列出模型：用 Runtime 默认，或填它认的模型名。")} />
        <ModelPicker testID={`agent-model-${a().handle}`} models={modelsOn(machine(), a().runtime)} value={a().model ?? ""} onChange={(v) => void patch({ model: v })} />
        <AgentRepo team={t} agent={a()} />
        <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Changes apply to new tasks; running ones finish where they started.", "改动只影响新任务，正在跑的任务在原来的地方跑完。")}</Text>
      </Panel>

      <Panel title={L("Memory (memory.md)", "记忆（memory.md）")}>
        <AgentMemory team={t} agent={a()} />
      </Panel>

      <Panel title={L("Who can use it", "谁能用它")}>
        <Label text={L("Who can hand it work", "谁能派活")} />
        <DispatchControls testID={`agent-dispatch-${a().handle}`} dispatch={a().dispatch} confirm={a().confirm} onDispatch={(v) => void patch({ dispatch: v })} onConfirm={(v) => void patch({ confirm: v })} />
        <Label text={L("How much it decides alone", "自主程度")} />
        <Choice testID={`agent-autonomy-${a().handle}`} options={AUTONOMY.map((d) => ({ value: d.value, label: d.label() }))} value={a().autonomy} onChange={(v) => void patch({ autonomy: v })} />
        <Text style={{ fontSize: 12.5, color: colors.faint }}>{AUTONOMY.find((d) => d.value === a().autonomy)?.note() ?? ""}</Text>
      </Panel>
      <ErrorNote text={error()} testID="agent-error" />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <If when={removing()} else={<Btn kind="danger" testID={`agent-remove-${a().handle}`} label={L("Delete agent", "删除 Agent")} onPress={() => removing.set(true)} />}>
          <Text style={{ flex: 1, fontSize: 13.5, color: colors.danger }}>{L(`Delete @${a().handle}? It leaves its channels; its tasks stay.`, `删除 @${a().handle}？它会离开所在频道，已有的任务保留。`)}</Text>
          <Btn kind="danger" testID={`agent-remove-confirm-${a().handle}`} label={L("Delete", "删除")} onPress={() => void t.deleteAgent(a().id)} />
          <Btn kind="ghost" label={L("Cancel", "取消")} onPress={() => removing.set(false)} />
        </If>
      </View>
    </View>
  );
}

/** One text setting of an agent, saved by a button (its role). */
function AgentText(props: { team: Team; agent: Agent; field: "description"; label: string; placeholder: string }) {
  const value = signal(props.agent[props.field] ?? "");
  const busy = signal(false);
  const changed = () => value().trim() !== (props.agent[props.field] ?? "");
  async function save() {
    busy.set(true);
    await props.team.patchAgent(props.agent.id, { [props.field]: value().trim() });
    busy.set(false);
  }
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
      <View style={{ flex: 1 }}>
        <Field label={props.label} value={value()} onChange={(v) => value.set(v)} onSubmit={save} placeholder={props.placeholder} testID={`agent-${props.field}-${props.agent.handle}`} />
      </View>
      <If when={changed()}>
        <Btn small testID={`agent-${props.field}-save-${props.agent.handle}`} label={L("Save", "保存")} busy={busy()} onPress={save} />
      </If>
    </View>
  );
}

/** What it keeps between tasks. Its owner edits it; the agent rewrites it when it learns something lasting. */
function AgentMemory(props: { team: Team; agent: Agent }) {
  const value = signal(props.agent.memory ?? "");
  const busy = signal(false);
  const saved = signal(false);
  const changed = () => value().trim() !== (props.agent.memory ?? "");
  // the agent rewrote it while it was open here and nothing was typed: show the new text
  effect(() => {
    const m = props.agent.memory ?? "";
    if (!untracked(changed) || untracked(saved)) value.set(m);
  });
  async function save() {
    busy.set(true);
    const r = await props.team.patchAgent(props.agent.id, { memory: value().trim() });
    busy.set(false);
    saved.set(r.ok);
  }
  return (
    <View style={{ gap: 6 }}>
      <Input
        testID={`agent-memory-${props.agent.handle}`}
        value={value()}
        multiline
        placeholder={L("- The pay service is Go 1.24; run make test\n- Ask Wang Lei before touching the orders table", "- 支付服务是 Go 1.24，测试用 make test\n- 动 orders 表前先问王磊")}
        class="placeholder:text-faint"
        onChange={({ value: v }) => { value.set(v); saved.set(false); }}
        style={{ minHeight: 96, maxHeight: 260, padding: 10, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.field, fontSize: 13.5, lineHeight: 20, color: colors.text }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: colors.faint }}>{L("It reads this at the start of every task and rewrites it when it learns something that will matter later.", "它每次开工前都会读，学到以后用得上的东西时会自己改写。")}</Text>
        <Btn small testID={`agent-memory-save-${props.agent.handle}`} label={saved() && !changed() ? L("Saved", "已保存") : L("Save", "保存")} busy={busy()} disabled={!changed()} onPress={save} />
      </View>
    </View>
  );
}

/** A checkout on its machine for tasks that name no repository (the task's own repository comes first). */
function AgentRepo(props: { team: Team; agent: Agent }) {
  const value = signal(props.agent.repo ?? "");
  const busy = signal(false);
  const saved = signal(false);
  const changed = () => value().trim() !== (props.agent.repo ?? "");
  async function save() {
    busy.set(true);
    const r = await props.team.patchAgent(props.agent.id, { repo: value().trim() });
    busy.set(false);
    saved.set(r.ok);
  }
  return (
    <View style={{ gap: 6 }}>
      <Label text={L("Fallback checkout on its machine (optional)", "本机默认仓库（可选）")} />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Field value={value()} onChange={(v) => { value.set(v); saved.set(false); }} onSubmit={save} placeholder="~/work/orders" testID={`agent-repo-${props.agent.handle}`} />
        </View>
        <Btn small testID={`agent-repo-save-${props.agent.handle}`} label={saved() && !changed() ? L("Saved", "已保存") : L("Save", "保存")} busy={busy()} disabled={!changed()} onPress={save} />
      </View>
      <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.faint }}>{L("Usually empty: the repository comes with the task (an address in the message, or one the agent checks out when the work needs it) and the machine finds or clones it. This path is used only when a task names none.", "一般不用填：仓库跟着任务走（消息里写的地址，或者 Agent 判断要改代码时自己检出的），机器会自己找到或克隆。只有任务没指定仓库时才用这里的路径。")}</Text>
    </View>
  );
}

/** New agent: who it is, where it runs (a machine, then a runtime on it), who can use it. */
function NewAgentDialog(props: { team: Team; open: boolean; machine?: string; onClose: () => void; onCreated: (handle: string) => void }) {
  const t = props.team;
  const name = signal("");
  const handle = signal("");
  const desc = signal("");
  const machine = signal("");
  const runtime = signal("codex");
  const repo = signal("");
  const dispatch = signal<Dispatch>("channel");
  const confirm = signal(true);
  const model = signal("");
  const error = signal("");
  const busy = signal(false);
  const mine = () => t.machines().filter((m) => m.owner_id === t.me()?.id);
  // each opening starts fresh, on the machine it was opened for (or the first online one)
  effect(() => {
    if (!props.open) return;
    const ms = untracked(mine);
    name.set(""); handle.set(""); desc.set(""); repo.set(""); runtime.set("codex"); dispatch.set("channel"); confirm.set(true); model.set(""); error.set("");
    machine.set(props.machine ?? (ms.find((m) => m.online) ?? ms[0])?.id ?? "");
  });
  const picked = () => mine().find((m) => m.id === machine());
  const agentsOn = (m: Machine) => t.agents().filter((a) => a.machine_id === m.id);
  /** Can this runtime be picked on the picked machine, and what to say about it. */
  const rt = (name: string): { ok: boolean; note: string; warn: boolean } => {
    const r = RUNTIMES.find((x) => x.name === name)!;
    const m = picked();
    const info = runtimeOn(m, name);
    const reported = !!m && (!!m.runtime_info?.length || !!m.runtimes.length);
    if (!r.ready) return { ok: false, note: "", warn: false };
    if (!m) return { ok: true, note: "", warn: false };
    if (!reported) return { ok: true, note: L("The machine hasn’t reported yet; it’s checked when it connects.", "机器还没上报，连上后会检查。"), warn: true };
    if (!info?.installed) return { ok: false, note: L(`Not installed on ${m.name}`, `${m.name} 上没装`), warn: true };
    if (info.logged_in === false) return { ok: true, note: L(`Installed${info.version ? ` v${info.version}` : ""}, not logged in: run ${name} login there`, `已安装${info.version ? ` v${info.version}` : ""}，未登录：在那台电脑上运行 ${name} login`), warn: true };
    return { ok: true, note: `✓ ${L("Installed", "已安装")}${info.version ? ` v${info.version}` : ""}${info.logged_in ? L(", logged in", "，已登录") : ""}`, warn: false };
  };
  const cleanHandle = () => handle().trim().toLowerCase().replace(/^@/, "");
  const summary = () => [name().trim() || (cleanHandle() ? `@${cleanHandle()}` : ""), runtimeLabel(runtime()) + (model() ? ` ${model()}` : ""), picked()?.name ?? ""].filter(Boolean).join(" · ");
  async function create() {
    if (!cleanHandle() || busy()) return;
    busy.set(true);
    error.set("");
    const r = await t.createAgent({
      handle: cleanHandle(), name: name().trim() || cleanHandle(), description: desc().trim(), machine_id: machine() || null,
      runtime: runtime(), model: model(), repo: repo().trim(), dispatch: dispatch(), confirm: confirm(),
    });
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    props.onCreated(r.data.handle);
  }
  const step = (n: string, title: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: tints.accent }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: colors.accent }}>{n}</Text>
      </View>
      <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{title}</Text>
    </View>
  );
  return (
    <Dialog
      testID="new-agent"
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 640, maxHeight: windowSize().height - 32, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 54, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{L("New agent", "新建 Agent")}</Text>
          <View role="button" testID="new-agent-close" accessibilityLabel={L("Close", "关闭")} onPress={props.onClose} hoverStyle={hovered()} style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={16} tint={colors.muted} />
          </View>
        </View>
        <Scroll style={{ flexShrink: 1 }} contentStyle={{ padding: 20, gap: 14 }}>
          {step("1", L("Who it is", "它是谁"))}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}><Field label={L("Name", "名字")} value={name()} onChange={(v) => name.set(v)} placeholder={L("Tester", "阿测")} testID="agent-name" autoFocus /></View>
            <View style={{ flex: 1 }}><Field label={L("@handle", "@名")} value={handle()} onChange={(v) => handle.set(v)} placeholder="ace" testID="agent-handle" /></View>
          </View>
          <Field label={L("What it does (optional)", "职责（可选）")} value={desc()} onChange={(v) => desc.set(v)} placeholder={L("e.g. writes tests for the payments backend", "比如：给支付后端补测试")} testID="agent-desc" hint={L("Shown when people @ it, so they pick the right one.", "大家 @ 的时候能看到，好选对 Agent。")} />

          {step("2", L("Where it runs", "运行在哪里"))}
          <If when={mine().length} else={
            <Text testID="new-agent-no-machine" style={{ fontSize: 13.5, lineHeight: 20, color: colors.warn }}>{L("Add a machine first (My machines), or the agent can’t run anything. You can still create it and pick a machine later.", "先在「我的机器」里添加一台机器，不然 Agent 跑不了任务。也可以先建好，之后再选机器。")}</Text>
          }>
            <Label text={L("Machine", "机器")} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Each of={mine()} key={(m) => m.id}>
                {(m) => (
                  <PickCard
                    testID={`new-agent-machine-${m().id}`}
                    title={m().name}
                    note={[m().online ? L("online", "在线") : L("offline", "离线"), L(`${m().max_sessions} at a time`, `同时 ${m().max_sessions} 个`), agentsOn(m()).length ? L(`${agentsOn(m()).length} agents`, `已有 ${agentsOn(m()).length} 个 Agent`) : ""].filter(Boolean).join(" · ")}
                    picked={machine() === m().id}
                    right={<Dot on={m().online} />}
                    onPress={() => machine.set(m().id)}
                  />
                )}
              </Each>
            </View>
            <Label text={L(`Runtime on ${picked()?.name ?? "it"}`, `${picked()?.name ?? "这台机器"} 上的 Runtime`)} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Each of={[...RUNTIMES]}>
                {(r) => (
                  <PickCard
                    testID={`new-agent-runtime-${r().name}`}
                    title={r().label}
                    note={rt(r().name).note}
                    picked={runtime() === r().name}
                    disabled={!rt(r().name).ok}
                    onPress={() => { if (runtime() !== r().name) { runtime.set(r().name); model.set(""); } }}
                  />
                )}
              </Each>
            </View>
            <Label text={L("Model", "模型")} />
            <ModelPicker testID="new-agent-model" models={modelsOn(picked(), runtime())} value={model()} onChange={(v) => model.set(v)} />
          </If>
          <Field label={L("Fallback checkout on that machine (optional)", "本机默认仓库（可选，一般不用填）")} value={repo()} onChange={(v) => repo.set(v)} placeholder="~/work/orders" testID="agent-repo-new" />

          {step("3", L("Who can use it", "谁能用它"))}
          <DispatchControls testID="new-agent-dispatch" dispatch={dispatch()} confirm={confirm()} onDispatch={(v) => dispatch.set(v)} onConfirm={(v) => confirm.set(v)} />
          <ErrorNote text={error()} testID="agent-create-error" />
        </Scroll>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
          <Text testID="new-agent-summary" style={{ flex: 1, fontSize: 13.5, color: colors.muted, numberOfLines: 1 }}>{summary()}</Text>
          <Btn kind="ghost" label={L("Cancel", "取消")} onPress={props.onClose} />
          <Btn testID="agent-create" kind="primary" label={L("Create agent", "创建 Agent")} busy={busy()} disabled={!cleanHandle() || !rt(runtime()).ok} onPress={create} />
        </View>
      </View>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 我的机器

function MachinesSection(props: { team: Team; onNewAgent: (machineId: string) => void; onAgent: (handle: string) => void }) {
  const t = props.team;
  const mine = () => t.machines().filter((m) => m.owner_id === t.me()?.id);
  /** The command that adds my computers: they report in by themselves. */
  const code = signal("");
  const adding = () => !!code() || manual();
  const manual = signal(false);
  const name = signal("");
  const error = signal("");
  const busy = signal(false);
  const issued = signal<{ name: string; token: string } | null>(null);
  async function enroll() {
    busy.set(true);
    error.set("");
    issued.set(null);
    const r = await t.enrollMachine();
    busy.set(false);
    if (!r.ok) {
      manual.set(r.status === 404 || r.status === 405); // an older server: name it and paste its token
      return r.status === 404 || r.status === 405 ? undefined : error.set(failed(r));
    }
    code.set(r.data.join);
  }
  async function add() {
    if (!name().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const r = await t.createMachine(name().trim());
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    issued.set({ name: r.data.machine.name, token: r.data.token });
    manual.set(false);
    code.set("");
    name.set("");
  }
  const close = () => { code.set(""); manual.set(false); error.set(""); };
  const snippet = (token: string) => `[cloud]\nurl = "${t.shareUrl()}"\n\n[server]\ntoken = "${token}"`;
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ flex: 1, fontSize: 13.5, lineHeight: 20, color: colors.muted }}>
          {L("A machine is a computer of yours running the Remi daemon. It reports which runtimes it has; one machine can host many agents.", "机器是你一台跑着 Remi 守护进程的电脑。它会上报装了哪些 Runtime；一台机器上可以有多个 Agent。")}
        </Text>
        <Btn small kind="primary" testID="machine-add" icon="plus" label={L("Add machine", "添加机器")} busy={busy() && !manual()} onPress={() => void enroll()} />
      </View>
      <ErrorNote text={code() || manual() ? "" : error()} />
      <If when={code()}>
        <View style={{ gap: 10, padding: 14, borderRadius: 12, backgroundColor: tints.accent }}>
          <InstallCommand team={t} name={L("that computer", "那台电脑")} code={code()} />
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>
            {L("The computer shows up below by itself once it connects, named after its hostname (rename it there). The same command works on more of your computers within the hour; running it again on one reconnects it.", "电脑连上后会自动出现在下面，名字用它的主机名（可以改）。一小时内这条命令可以在你的多台电脑上用；同一台电脑再运行一次，就是重新接入。")}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn small kind="ghost" testID="machine-manual" label={L("Set it up by hand", "手动配置")} onPress={() => { code.set(""); manual.set(true); }} />
            <Btn small kind="ghost" label={L("Done", "完成")} onPress={close} />
          </View>
        </View>
      </If>
      <If when={manual()}>
        <Panel title={L("Set up a machine by hand", "手动配置机器")}>
          <Field label={L("Machine name", "机器名称")} value={name()} onChange={(v) => name.set(v)} onSubmit={add} placeholder={L("Wang Lei’s Mac", "王磊的 Mac")} testID="machine-name" autoFocus />
          <ErrorNote text={error()} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn testID="machine-create" kind="primary" label={L("Create token", "生成令牌")} busy={busy()} disabled={!name().trim()} onPress={add} />
            <Btn kind="ghost" label={L("Cancel", "取消")} onPress={close} />
          </View>
        </Panel>
      </If>
      <If when={issued()}>
        {(i) => (
          <View style={{ gap: 8, padding: 14, borderRadius: 12, backgroundColor: tints.accent }}>
            <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text }}>
              {L(`Token for ${i().name}. It’s shown only once: put this in ~/.noop/data/config.local.toml on that computer, then start its daemon (bun run daemon).`, `${i().name} 的令牌只显示这一次：把下面几行写进那台电脑的 ~/.noop/data/config.local.toml，然后启动那里的守护进程（bun run daemon）。`)}
            </Text>
            <Text testID="machine-token" style={{ fontSize: 13, lineHeight: 19, color: colors.text, ...mono }}>{snippet(i().token)}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn small icon="copy" label={L("Copy", "复制")} onPress={() => void Clipboard.writeText(snippet(i().token))} />
              <Btn small kind="ghost" label={L("Done", "完成")} onPress={() => issued.set(null)} />
            </View>
          </View>
        )}
      </If>
      <If when={!mine().length && !adding() && !issued()}>
        <Panel title={L("No machines yet", "还没有机器")}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{L("Press Add machine and run the command it gives in a terminal on that computer.", "点「添加机器」，在那台电脑的终端里运行给出的命令。")}</Text>
        </Panel>
      </If>
      <Each of={mine()} key={(m) => m.id}>
        {(m) => <MachineCard team={t} machine={m()} onNewAgent={() => props.onNewAgent(m().id)} onAgent={props.onAgent} />}
      </Each>
    </>
  );
}

/** When links and commands would carry an address only the server's own computer (or this one) can reach: how to set the real one. */
function LoopbackNote(props: { team: Team; testID: string }) {
  return (
    <If when={isLoopback(props.team.shareUrl())}>
      <Text testID={props.testID} style={{ fontSize: 12.5, lineHeight: 18, color: colors.warn }}>
        {L(`${props.team.shareUrl()} only works on this computer, so links and install commands for others won’t reach the server. Start the server with -public-url http://<its address>:<port> (or TEAMAGENT_PUBLIC_URL), or sign in here with that address.`,
          `${props.team.shareUrl()} 只在本机能用，发给别人的链接和安装命令会连不上。启动服务端时加上 -public-url http://<服务器地址>:<端口>（或设环境变量 TEAMAGENT_PUBLIC_URL），或者在这里用那个地址重新登录。`)}
      </Text>
    </If>
  );
}

/** The one line to run on the computer, with a copy button, and a warning when the address only works on the server itself. */
function InstallCommand(props: { team: Team; name: string; code: string }) {
  const cmd = () => installCommand(props.team.shareUrl(), props.code);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text }}>
        {L(`Run this in a terminal on ${props.name}. It installs the daemon, connects it and keeps it running in the background. The code works once, within an hour.`, `在 ${props.name} 的终端里运行这一行：它会装好守护进程、接入并在后台常驻。接入码一小时内有效，只能用一次。`)}
      </Text>
      <Text testID="machine-command" style={{ fontSize: 13, lineHeight: 19, color: colors.text, ...mono }}>{cmd()}</Text>
      <LoopbackNote team={props.team} testID="machine-loopback" />
      <View style={{ flexDirection: "row" }}>
        <Btn small icon="copy" testID="machine-command-copy" label={L("Copy", "复制")} onPress={() => void Clipboard.writeText(cmd())} />
      </View>
    </View>
  );
}

function MachineCard(props: { team: Team; machine: Machine; onNewAgent: () => void; onAgent: (handle: string) => void }) {
  const t = props.team;
  const m = () => props.machine;
  const agents = () => t.agents().filter((a) => a.machine_id === m().id);
  const confirming = signal(false);
  const join = signal("");
  const joinError = signal("");
  const renaming = signal(false);
  const newName = signal("");
  async function rename() {
    if (!newName().trim()) return;
    const r = await t.renameMachine(m().id, newName().trim());
    if (!r.ok) return joinError.set(failed(r));
    renaming.set(false);
  }
  async function newCode() {
    joinError.set("");
    const r = await t.machineJoinCode(m().id);
    if (!r.ok) return joinError.set(failed(r));
    join.set(r.data.join);
  }
  const reported = () => !!m().runtime_info?.length || !!m().runtimes.length || m().last_seen !== null;
  const cell = (s: string, flex = 1, color: string = colors.text) => <Text style={{ flex, fontSize: 13, color, numberOfLines: 1 }}>{s}</Text>;
  return (
    <View testID={`machine-${m().id}`} style={{ gap: 12, padding: 18, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name="terminal" size={22} tint={colors.muted} />
        <View style={{ flex: 1 }}>
          <If when={renaming()} else={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text testID={`machine-name-${m().id}`} style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{m().name}</Text>
              <Btn small kind="ghost" testID={`machine-rename-${m().id}`} label={L("Rename", "改名")} onPress={() => { newName.set(m().name); renaming.set(true); }} />
            </View>
          }>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ flex: 1 }}>
                <Field label="" value={newName()} onChange={(v) => newName.set(v)} onSubmit={rename} testID={`machine-rename-input-${m().id}`} autoFocus />
              </View>
              <Btn small kind="primary" testID={`machine-rename-save-${m().id}`} label={L("Save", "保存")} disabled={!newName().trim()} onPress={() => void rename()} />
              <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => renaming.set(false)} />
            </View>
          </If>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot on={m().online} />
            <Text style={{ fontSize: 12.5, color: colors.muted }}>
              {[m().online ? L("online", "在线") : m().last_seen ? L(`offline · last seen ${time(m().last_seen!)}`, `离线 · 最后在线 ${time(m().last_seen!)}`) : L("never connected", "还没连上过"), [m().os, m().arch].filter(Boolean).join(" "), L(`${m().max_sessions} at a time`, `同时 ${m().max_sessions} 个`)].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
        <If when={!m().online && !join()}>
          <Btn small kind="ghost" testID={`machine-join-${m().id}`} label={L("Install command", "接入命令")} onPress={() => void newCode()} />
        </If>
        <If when={!confirming()}>
          <Btn small kind="ghost" testID={`machine-remove-${m().id}`} label={L("Remove", "移除")} onPress={() => confirming.set(true)} />
        </If>
      </View>
      <ErrorNote text={joinError()} />
      <If when={join() && !m().online}>
        <View style={{ gap: 8, padding: 12, borderRadius: radius.control, backgroundColor: tints.accent }}>
          <InstallCommand team={t} name={m().name} code={join()} />
          <Text style={{ fontSize: 12.5, color: colors.muted }}>{L("Running it gives this machine a new token; the old one stops working.", "运行后这台机器会换一个新令牌，旧令牌失效。")}</Text>
        </View>
      </If>
      <If when={confirming()}>
        <View style={{ gap: 8, padding: 12, borderRadius: radius.control, backgroundColor: tints.danger }}>
          <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.text }}>
            {agents().length
              ? L(`Remove ${m().name}? These agents will have no machine and can’t take work until you move them: ${agents().map((a) => "@" + a.handle).join(" ")}`, `移除 ${m().name}？这些 Agent 会没有机器，换到别的机器前接不了活：${agents().map((a) => "@" + a.handle).join(" ")}`)
              : L(`Remove ${m().name}? Its token stops working.`, `移除 ${m().name}？它的令牌会失效。`)}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn small kind="danger" testID={`machine-remove-confirm-${m().id}`} label={L("Remove", "移除")} onPress={() => void t.deleteMachine(m().id)} />
            <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => confirming.set(false)} />
          </View>
        </View>
      </If>

      <Label text="Runtime" />
      <If when={reported()} else={<Text style={{ fontSize: 13, color: colors.faint }}>{L("Start the daemon on that computer; it reports its runtimes when it connects.", "在那台电脑上启动守护进程，连上后会上报它的 Runtime。")}</Text>}>
        <View style={{ borderRadius: 10, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: alpha(colors.text, 0.04) }}>
            {cell("Runtime", 1.2, colors.muted)}{cell(L("Version", "版本"), 0.8, colors.muted)}{cell(L("Login", "登录"), 0.8, colors.muted)}{cell(L("Used by", "在用的 Agent"), 1.4, colors.muted)}
          </View>
          <Each of={[...RUNTIMES]}>
            {(r) => {
              const info = () => runtimeOn(m(), r().name);
              const users = () => agents().filter((a) => a.runtime === r().name);
              return (
                <View testID={`machine-${m().id}-runtime-${r().name}`} style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
                  <View style={{ flex: 1.2, flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text }}>{r().label}</Text>
                    <If when={!r().ready}><Tag label={L("phase 2", "第二阶段")} /></If>
                  </View>
                  {cell(info()?.installed ? (info()!.version ? `v${info()!.version}` : L("installed", "已安装")) : L("not installed", "未安装"), 0.8, info()?.installed ? colors.text : colors.faint)}
                  {cell(!info()?.installed ? "—" : info()!.logged_in === true ? L("✓ logged in", "✓ 已登录") : info()!.logged_in === false ? L("not logged in", "未登录") : L("unknown", "未知"), 0.8, info()?.logged_in === false ? colors.warn : colors.text)}
                  {cell(users().map((a) => "@" + a.handle).join(" ") || "—", 1.4, colors.muted)}
                </View>
              );
            }}
          </Each>
        </View>
      </If>

      <Label text={L("Repositories", "仓库")} note={L("Checkouts it found (under ~/code, ~/work and the like, or [teamagent] roots in its config), by remote. Tasks in other repositories get cloned.", "它找到的本地仓库（~/code、~/work 等目录，或配置里 [teamagent] roots 指定的目录），按远端地址识别。其他仓库的任务会自动克隆。")} />
      <If when={(m().repos ?? []).length} else={<Text testID={`machine-${m().id}-repos-none`} style={{ fontSize: 13, color: colors.faint }}>{reported() ? L("None found yet.", "还没找到。") : L("Reported when the daemon connects.", "守护进程连上后上报。")}</Text>}>
        <View testID={`machine-${m().id}-repos`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Each of={m().repos ?? []} key={(r) => r.remote}>
            {(r) => <Tag label={repoLabel(r().remote)} />}
          </Each>
        </View>
      </If>

      <Label text={L("Agents on this machine", "跑在这台机器上的 Agent")} />
      <Each of={agents()} key={(a) => a.id}>
        {(a) => {
          const st = () => agentState(t, a());
          return (
            <View role="button" testID={`machine-${m().id}-agent-${a().handle}`} onPress={() => props.onAgent(a().handle)} hoverStyle={hovered()} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 8 }}>
              <Avatar name={a().name} agent size={26} />
              <Text style={{ fontSize: 14, color: colors.text }}>{a().name} <Text style={{ color: colors.muted }}>@{a().handle}</Text></Text>
              <RuntimeBadge runtime={a().runtime} />
              <View style={{ flex: 1 }} />
              <StateDot tone={st().tone} />
              <Text style={{ fontSize: 12.5, color: st().blocked ? colors.danger : colors.muted, numberOfLines: 1 }}>{st().label}</Text>
            </View>
          );
        }}
      </Each>
      <View style={{ flexDirection: "row" }}>
        <Btn small testID={`machine-new-agent-${m().id}`} icon="plus" label={L("New agent on this machine", "在这台机器上新建 Agent")} onPress={props.onNewAgent} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- 成员与邀请

function PeopleSection(props: { team: Team }) {
  const t = props.team;
  const admin = () => t.me()?.role === "admin";
  const email = signal("");
  const role = signal<"member" | "admin">("member");
  const error = signal("");
  const busy = signal(false);
  const link = signal("");
  const note = signal("");
  async function invite() {
    if (!email().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const r = await t.invite(email().trim(), role());
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    note.set(L("Send this link to them (valid for 7 days, works once):", "把这个链接发给对方（7 天内有效，只能用一次）："));
    link.set(`${t.shareUrl()}${r.data.path}`);
    email.set("");
  }
  /** For a member who lost their device or signed out everywhere. */
  async function loginLink(id: string, who: string) {
    error.set("");
    const r = await t.loginCode(id);
    if (!r.ok) return error.set(failed(r));
    note.set(L(`Login link for ${who} (valid for a day, works once):`, `${who} 的登录链接（一天内有效，只能用一次）：`));
    link.set(`${t.shareUrl()}${r.data.path}`);
  }
  const agentsOf = (id: string) => t.agents().filter((a) => a.owner_id === id);
  return (
    <>
      <If when={admin() && t.signups().length}>
        <View style={{ gap: 10 }}><SignupSection team={t} /></View>
      </If>
      <Panel title={L(`Members · ${t.users().filter((u) => !u.disabled).length}`, `成员 · ${t.users().filter((u) => !u.disabled).length}`)}>
        <Each of={t.users().filter((u) => !u.disabled)} key={(u) => u.id}>
          {(u) => (
            <View testID={`person-${u().handle}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2 }}>
              <Avatar name={u().name} size={30} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, color: colors.text }}>{u().name} <Text style={{ color: colors.muted }}>@{u().handle}</Text></Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, numberOfLines: 1 }}>{[u().email, agentsOf(u().id).length ? L(`${agentsOf(u().id).length} agents`, `${agentsOf(u().id).length} 个 Agent`) : ""].filter(Boolean).join(" · ")}</Text>
              </View>
              <If when={u().role === "admin"}><Tag label={L("Admin", "管理员")} tone="accent" /></If>
              <If when={admin() && u().id !== t.me()?.id}>
                <Btn small testID={`login-link-${u().handle}`} label={L("Login link", "登录链接")} onPress={() => void loginLink(u().id, u().name)} />
              </If>
            </View>
          )}
        </Each>
      </Panel>
      <If when={admin()} else={<Text style={{ fontSize: 13, color: colors.faint }}>{L("Admins invite people.", "邀请同事由管理员来做。")}</Text>}>
        <Panel title={L("Invite", "邀请")}>
          <Field label={L("Email", "邮箱")} value={email()} onChange={(v) => email.set(v)} onSubmit={invite} placeholder="colleague@corp.com" keyboardType="email-address" testID="invite-email" />
          <Choice testID="invite-role" options={[{ value: "member", label: L("Member", "成员") }, { value: "admin", label: L("Admin", "管理员") }]} value={role()} onChange={(v) => role.set(v)} />
          <ErrorNote text={error()} testID="invite-error" />
          <View style={{ flexDirection: "row" }}>
            <Btn testID="invite-create" kind="primary" label={L("Create invite link", "生成邀请链接")} busy={busy()} disabled={!email().trim()} onPress={invite} />
          </View>
        </Panel>
      </If>
      <If when={link()}>
        <View style={{ gap: 6, padding: 12, borderRadius: radius.control, backgroundColor: tints.accent }}>
          <Text style={{ fontSize: 13.5, color: colors.text }}>{note()}</Text>
          <Text testID="invite-url" style={{ fontSize: 13, color: colors.text, ...mono }}>{link()}</Text>
          <LoopbackNote team={t} testID="invite-loopback" />
          <View style={{ flexDirection: "row" }}>
            <Btn small icon="copy" label={L("Copy", "复制")} onPress={() => void Clipboard.writeText(link())} />
          </View>
        </View>
      </If>
      <WorkspacePanel team={t} />
    </>
  );
}

/** This server's team: its name and id for everyone; admins rename it and open or close asking to join. */
function WorkspacePanel(props: { team: Team }) {
  const t = props.team;
  const admin = () => t.me()?.role === "admin";
  const name = signal(untracked(t.workspace)?.name ?? "");
  const error = signal("");
  const busy = signal(false);
  async function save(p: { name?: string; signup?: boolean }) {
    busy.set(true);
    error.set("");
    const r = await t.patchWorkspace(p);
    busy.set(false);
    if (!r.ok) error.set(failed(r));
  }
  return (
    <If when={t.workspace()}>
      {(ws) => (
        <Panel title={L("Team", "团队")}>
          <Text testID="workspace-id" style={{ fontSize: 13, color: colors.muted }}>
            {L("Team ID ", "团队 ID ")}<Text style={{ color: colors.text, ...mono }}>{ws().id}</Text>
          </Text>
          <If when={admin()} else={<Text style={{ fontSize: 14.5, color: colors.text }}>{ws().name || "Remi"}</Text>}>
            <Field label={L("Team name", "团队名字")} value={name()} onChange={(v) => name.set(v)} onSubmit={() => void save({ name: name() })} placeholder="Remi" testID="workspace-name" hint={L("Shown on the sign-in screen when people ask to join.", "申请加入的人会在登录页看到它。")} />
            <View style={{ flexDirection: "row" }}>
              <Btn small testID="workspace-save" label={L("Save name", "保存名字")} busy={busy()} disabled={name().trim() === ws().name} onPress={() => void save({ name: name() })} />
            </View>
            <Toggle testID="workspace-signup" value={ws().signup} label={L("Let people ask to join (an admin approves)", "允许自助申请加入（管理员审批）")} onChange={(v) => void save({ signup: v })} />
            <ErrorNote text={error()} testID="workspace-error" />
          </If>
        </Panel>
      )}
    </If>
  );
}

// ---------------------------------------------------------------- Git 平台

const gitSnippet = (p: { kind: string; host: string }) =>
  p.kind === "github"
    ? `[git.github]\ntoken = "…"   # 不填就用 gh auth token`
    : `[[git.gitlab]]\nhost = "${p.host}"\ntoken = "…"   # 你自己的 token，对仓库至少 Developer 权限`;

function credText(c: GitCred | undefined, reported: boolean): { text: string; ok: boolean } {
  if (!reported) return { text: L("not reported yet", "机器还没上报"), ok: false };
  if (!c?.configured) return { text: L("not set up", "未配置"), ok: false };
  const via = c.via === "gh" ? L("gh login", "gh 登录") : L("token", "令牌");
  if (!c.user) return { text: L(`${via} set, couldn’t verify`, `${via}已配置，没验证通过`), ok: false };
  return { text: `✓ ${via} · ${c.user}`, ok: true };
}

function GitSection(props: { team: Team }) {
  const t = props.team;
  const admin = () => t.me()?.role === "admin";
  const data = signal<GitSettings | null>(null);
  const error = signal("");
  const editing = signal<{ index: number; p: GitPlatform } | null>(null);
  const busy = signal(false);
  const how = signal("");
  void t.gitSettings().then((r) => (r.ok ? data.set(r.data as GitSettings) : error.set(failed(r))));
  const platforms = () => data()?.platforms ?? [];
  // GitHub always shows: machines push there with their own token or gh, configured or not
  const shown = () => (platforms().some((p) => p.kind === "github") ? platforms() : [...platforms(), { kind: "github", name: "GitHub", host: "github.com", api: "https://api.github.com" } as GitPlatform]);
  const myMachines = () => t.machines().filter((m) => m.owner_id === t.me()?.id);
  async function save(list: GitPlatform[]) {
    busy.set(true);
    error.set("");
    const r = await t.saveGitPlatforms(list);
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    data.update((d) => (d ? { ...d, platforms: r.data.platforms } : d));
    editing.set(null);
  }
  const hookUrl = () => `${t.shareUrl()}${data()?.webhook.path ?? "/api/v1/hooks/gitlab"}`;
  return (
    <If when={data()} else={<View style={{ gap: 8 }}><ErrorNote text={error()} /><If when={!error()}><Spinner size={16} tint={colors.muted} /></If></View>}>
      {(d) => (
        <>
          <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>
            {L("The team’s platforms are set once by an admin. Push credentials never leave the machines: each machine says only whether it has one.", "团队用的 Git 平台由管理员配一次。推送凭证不离开机器：每台机器只上报有没有配好。")}
          </Text>
          <Each of={shown()} key={(p) => `${p.kind}:${p.host}`}>
            {(p, i) => (
              <View testID={`git-platform-${p().host}`} style={{ gap: 10, padding: 18, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Icon name={p().kind === "github" ? "github" : "merge"} size={20} tint={colors.text} />
                  <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>{p().name}</Text>
                  <Tag label={p().kind === "github" ? "GitHub" : L("GitLab-based", "基于 GitLab")} />
                  <If when={admin() && i() < platforms().length}>
                    <Btn small kind="ghost" testID={`git-platform-edit-${i()}`} label={L("Edit", "修改")} onPress={() => editing.set({ index: i(), p: { ...p() } })} />
                  </If>
                </View>
                <Text style={{ fontSize: 13, color: colors.muted }}>{`${p().host} · API ${p().api}`}</Text>
                <If when={p().kind === "gitlab"} else={
                  <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{L("No webhook: each machine checks its PRs and CI every 2 minutes.", "不需要 webhook：机器每 2 分钟查一次 PR 和 CI。")}</Text>
                }>
                  <View style={{ gap: 6, padding: 12, borderRadius: radius.control, backgroundColor: alpha(colors.text, 0.04) }}>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>Webhook</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text testID="git-webhook-url" style={{ flex: 1, fontSize: 12.5, color: colors.text, ...mono }}>{hookUrl()}</Text>
                      <Btn small icon="copy" label={L("Copy", "复制")} onPress={() => void Clipboard.writeText(hookUrl())} />
                    </View>
                    <Text testID="git-webhook-secret" style={{ fontSize: 12.5, color: d().webhook.secret_set ? colors.up : colors.warn }}>
                      {d().webhook.secret_set ? L("✓ Secret set (TEAMAGENT_GIT_WEBHOOK_SECRET)", "✓ 密钥已设置（TEAMAGENT_GIT_WEBHOOK_SECRET）") : L("No secret: start the server with TEAMAGENT_GIT_WEBHOOK_SECRET, then put the same value in the webhook.", "没设密钥：启动服务端时设 TEAMAGENT_GIT_WEBHOOK_SECRET，再把同样的值填进 webhook。")}
                    </Text>
                    <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Events: PullRequest (merge request). Without it, machines still notice merges within 2 minutes.", "事件勾选 PullRequest（合并请求）。不配也行，机器 2 分钟内也会发现合并。")}</Text>
                  </View>
                  <Label text={L("Recent events", "最近收到的事件")} />
                  <If when={d().events.length} else={<Text style={{ fontSize: 13, color: colors.faint }}>{L("None yet.", "还没有。")}</Text>}>
                    <Each of={d().events.slice(0, 5)} key="index">
                      {(e) => (
                        <Text style={{ fontSize: 12.5, color: colors.muted }}>
                          {[time(e().at), e().project, e().number ? `!${e().number}` : "", e().branch, e().state, e().task ? `→ ${e().task}` : L("not a task", "不是任务分支")].filter(Boolean).join(" · ")}
                        </Text>
                      )}
                    </Each>
                  </If>
                </If>
              </View>
            )}
          </Each>
          <If when={!platforms().some((p) => p.kind === "gitlab")}>
            <Text style={{ fontSize: 13, color: colors.faint }}>{admin() ? L("Using a GitLab-based platform? Add it so people see its webhook and their machines’ credentials.", "用基于 GitLab 的平台？加上它，大家就能看到 webhook 和自己机器的凭证状态。") : L("An admin adds the team’s GitLab-based platforms.", "基于 GitLab 的平台由管理员添加。")}</Text>
          </If>
          <If when={admin() && !editing()}>
            <View style={{ flexDirection: "row" }}>
              <Btn small testID="git-platform-add" icon="plus" label={L("Add platform", "添加平台")} onPress={() => editing.set({ index: -1, p: { kind: "gitlab", name: "", host: "", api: "" } })} />
            </View>
          </If>
          <If when={editing()}>
            {(e) => <PlatformForm value={e().p} busy={busy()} isNew={e().index < 0}
              onCancel={() => editing.set(null)}
              onRemove={() => void save(platforms().filter((_, i) => i !== e().index))}
              onSave={(p) => void save(e().index < 0 ? [...platforms(), p] : platforms().map((x, i) => (i === e().index ? p : x)))} />}
          </If>
          <ErrorNote text={error()} testID="git-error" />

          <Panel title={L("Credentials on my machines", "我的机器上的凭证")}>
            <If when={myMachines().length} else={<Text style={{ fontSize: 13, color: colors.faint }}>{L("You have no machines.", "你还没有机器。")}</Text>}>
              <Each of={myMachines()} key={(m) => m.id}>
                {(m) => (
                  <View style={{ gap: 6, paddingVertical: 4 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{m().name}</Text>
                    <Each of={shown()} key={(p) => `${p.kind}:${p.host}`}>
                      {(p) => {
                        const c = () => credText(m().git?.find((g) => g.host === p().host), !!m().git);
                        const key = () => `${m().id}:${p().host}`;
                        return (
                          <View style={{ gap: 4 }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                              <Text style={{ width: 120, fontSize: 13, color: colors.muted }}>{p().name}</Text>
                              <Text testID={`git-cred-${m().id}-${p().host}`} style={{ flex: 1, fontSize: 13, color: c().ok ? colors.up : colors.warn }}>{c().text}</Text>
                              <If when={!c().ok}>
                                <Btn small kind="ghost" label={L("How to set up", "怎么配")} onPress={() => how.set(how() === key() ? "" : key())} />
                              </If>
                            </View>
                            <If when={how() === key()}>
                              <View style={{ gap: 4, padding: 10, borderRadius: radius.control, backgroundColor: alpha(colors.text, 0.04) }}>
                                <Text style={{ fontSize: 12.5, color: colors.muted }}>{L(`In ~/.noop/data/config.local.toml on ${m().name}:`, `写进 ${m().name} 的 ~/.noop/data/config.local.toml：`)}</Text>
                                <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.text, ...mono }}>{gitSnippet(p())}</Text>
                              </View>
                            </If>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                )}
              </Each>
            </If>
          </Panel>

          <Panel title={L("Fixed rules", "固定规则")}>
            <Text style={{ fontSize: 13, lineHeight: 20, color: colors.muted }}>
              {L("Machines push only branches named agent/T-xxxx, and only open PRs. Merging is always done by a person; a merged PR finishes its task.", "机器只推 agent/T-xxxx 分支，只开 PR。合并永远由人来做；PR 合并后任务自动完成。")}
            </Text>
          </Panel>
        </>
      )}
    </If>
  );
}

// ---------------------------------------------------------------- 协作数据

/** A wait as people say it: "4 分钟", "2.5 小时", "3 天". */
export function span(ms: number): string {
  const m = ms / 60_000;
  if (m < 1) return L("under a minute", "不到 1 分钟");
  if (m < 60) return L(`${Math.round(m)} min`, `${Math.round(m)} 分钟`);
  const h = m / 60;
  if (h < 24) return L(`${+h.toFixed(1)} h`, `${+h.toFixed(1)} 小时`);
  return L(`${+(h / 24).toFixed(1)} d`, `${+(h / 24).toFixed(1)} 天`);
}

const REPLY_KINDS: { key: keyof Metrics["reply_by"]; label: () => string }[] = [
  { key: "confirm", label: () => L("Start it", "确认开工") },
  { key: "decide", label: () => L("Decide", "做决定") },
  { key: "accept", label: () => L("Accept", "验收") },
  { key: "unblock", label: () => L("Unblock", "解除阻塞") },
  { key: "retry", label: () => L("Retry", "失败重试") },
];

/** The dogfood numbers: how fast people answer what waits for them, how many runs a task takes, how many tasks were
 * cancelled and asked again; and which agents people go to. */
function MetricsSection(props: { team: Team }) {
  const t = props.team;
  const days = signal<"7" | "30">("7");
  const data = signal<Metrics | null>(null);
  const error = signal("");
  effect(() => {
    const d = Number(days());
    void untracked(() => t.metrics(d)).then((r) => (r.ok ? data.set(r.data as Metrics) : error.set(failed(r))));
  });
  const waits = (s: DurationStats | undefined) =>
    !s || s.count === 0 ? L("none answered yet", "还没有") : L(`median ${span(s.median)} · 90% within ${span(s.p90)} · ${s.count} times`, `中位 ${span(s.median)} · 90% 在 ${span(s.p90)}内 · 共 ${s.count} 次`);
  const row = (label: string, value: string, testID?: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 3 }}>
      <Text style={{ width: 120, fontSize: 13.5, color: colors.muted }}>{label}</Text>
      <Text testID={testID} style={{ flex: 1, fontSize: 13.5, color: colors.text }}>{value}</Text>
    </View>
  );
  return (
    <>
      <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>
        {L("Three numbers to watch while the team tries working with agents. Everyone sees the same numbers; nothing here is about what anyone wrote.", "试用期间看这三个数。全队看到的是同一份数字，只统计时间和次数，不涉及谁说了什么。")}
      </Text>
      <Choice testID="metrics-days" options={[{ value: "7", label: L("Last 7 days", "最近 7 天") }, { value: "30", label: L("Last 30 days", "最近 30 天") }]} value={days()} onChange={(v) => days.set(v)} />
      <ErrorNote text={error()} />
      <If when={data()} else={<If when={!error()}><Spinner size={16} tint={colors.muted} /></If>}>
        {(d) => (
          <>
            <Panel title={L("How fast people answer", "人回复「待你处理」要多久")}>
              {row(L("All", "全部"), waits(d().reply), "metrics-reply")}
              <Each of={REPLY_KINDS.filter((k) => d().reply_by[k.key])} key={(k) => k.key}>
                {(k) => row(k().label(), waits(d().reply_by[k().key]))}
              </Each>
              <If when={d().reply.open}>
                <Text style={{ fontSize: 12.5, color: colors.warn }}>{L(`${d().reply.open} still waiting, the oldest for ${span(d().reply.oldest)}.`, `还有 ${d().reply.open} 件在等，最久的已经等了 ${span(d().reply.oldest)}。`)}</Text>
              </If>
            </Panel>
            <Panel title={L("Runs per task", "每个任务跑了几轮")}>
              {row(L("Tasks", "任务"), d().runs.tasks ? L(`${d().runs.tasks}, mean ${d().runs.mean.toFixed(1)} runs, median ${d().runs.median}, most ${d().runs.max}`, `${d().runs.tasks} 个，平均 ${d().runs.mean.toFixed(1)} 轮，中位 ${d().runs.median}，最多 ${d().runs.max}`) : L("none yet", "还没有"), "metrics-runs")}
              {row(L("3 runs or more", "3 轮及以上"), String(d().runs.three_plus))}
            </Panel>
            <Panel title={L("Cancelled and asked again", "取消后重来")}>
              {row(L("Cancelled", "被取消"), String(d().cancelled))}
              {row(L("Asked again", "其中重新派了"), String(d().redone), "metrics-redone")}
              <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Asked again: the same person asked in the same channel within a day.", "重新派：同一个人在同一个频道一天内又派了一次。")}</Text>
            </Panel>
            <Panel title={L("Which agents people go to", "大家找哪个 Agent")}>
              <Each of={d().agents.filter((a) => a.tasks > 0)} key={(a) => a.agent_id}>
                {(a) => {
                  const ag = () => t.agents().find((x) => x.id === a().agent_id);
                  return (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 }}>
                      <Text style={{ width: 120, fontSize: 13.5, color: colors.text, numberOfLines: 1 }}>{ag() ? `@${ag()!.handle}` : a().agent_id}</Text>
                      <If when={a().team}><Tag label={L("Team", "团队")} tone="accent" /></If>
                      <Text style={{ flex: 1, fontSize: 13.5, color: colors.muted }}>{L(`${a().tasks} tasks from ${a().people} people (${a().others} not its owner)`, `${a().tasks} 个任务，来自 ${a().people} 个人（${a().others} 个不是主人派的）`)}</Text>
                    </View>
                  );
                }}
              </Each>
              <If when={!d().agents.some((a) => a.tasks > 0)}><Text style={{ fontSize: 13, color: colors.faint }}>{L("No tasks yet.", "还没有任务。")}</Text></If>
            </Panel>
          </>
        )}
      </If>
    </>
  );
}

function PlatformForm(props: { value: GitPlatform; busy: boolean; isNew: boolean; onSave: (p: GitPlatform) => void; onCancel: () => void; onRemove: () => void }) {
  const kind = signal(props.value.kind);
  const name = signal(props.value.name);
  const host = signal(props.value.host);
  const api = signal(props.value.api);
  return (
    <Panel title={props.isNew ? L("Add platform", "添加平台") : L("Edit platform", "修改平台")}>
      <Choice testID="git-kind" options={[{ value: "gitlab", label: L("GitLab-based", "基于 GitLab") }, { value: "github", label: "GitHub" }]} value={kind()} onChange={(v) => kind.set(v)} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}><Field label={L("Name", "名称")} value={name()} onChange={(v) => name.set(v)} placeholder={L("e.g. Company GitLab", "比如：公司 GitLab")} testID="git-name" /></View>
        <View style={{ flex: 1 }}><Field label={L("Host", "域名")} value={host()} onChange={(v) => host.set(v)} placeholder="code.corp.com" testID="git-host" /></View>
      </View>
      <Field label={L("API (optional)", "API 地址（可选）")} value={api()} onChange={(v) => api.set(v)} placeholder={kind() === "github" ? "https://api.github.com" : `https://${host() || "code.corp.com"}/api/v4`} testID="git-api" />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn testID="git-platform-save" kind="primary" label={L("Save", "保存")} busy={props.busy} disabled={!host().trim()} onPress={() => props.onSave({ kind: kind(), name: name().trim(), host: host().trim(), api: api().trim() })} />
        <Btn kind="ghost" label={L("Cancel", "取消")} onPress={props.onCancel} />
        <View style={{ flex: 1 }} />
        <If when={!props.isNew}>
          <Btn kind="danger" testID="git-platform-remove" label={L("Remove", "移除")} onPress={props.onRemove} />
        </If>
      </View>
    </Panel>
  );
}

export type { JSX };
