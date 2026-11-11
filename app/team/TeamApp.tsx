// Remi: several people and their agents in shared channels, against the Go server's /api/v1. This file is the frame:
// sign in, then the workspace (sidebar, the page in the middle, a thread or the members beside it). Wide windows show
// them side by side; narrow ones one pane at a time. The screens live next to it: signin, channel (with taskfacts),
// composer, messages, taskcard, inbox, tasks, search, reminders, settings.
import { cleanup, computed, effect, keyboardFrame, keymap, safeArea, Scroll, signal, Storage, Text, untracked, View, windowSize, type JSX, type ViewStyle } from "nsh";
import { CLIENT_VERSION } from "../version";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";
import { L } from "../i18n";
import { alpha, colors, hovered, Icon, type IconName, radius, Spinner } from "../ui";
import { reminderUp, createTeam, isMember, runtimeLabel, TEAM_KEYS, type Session, type Team } from "./api";
import { TasksPage } from "./tasks";
import { SettingsPage, type SettingsTab } from "./settings";
import { SearchPage } from "./search";
import { canCheckUpdates, checkNow, UpdateRow } from "./updates";
import { agentState, Avatar, chrome, Dot, FOOTER, StateDot, WIDE } from "./ui";
import { ChannelView, MembersPanel, NewChannel, ThreadView, type Side } from "./channel";
import { Inbox } from "./inbox";
import { watchNotifications } from "./notify";
import { SignIn } from "./signin";

// ---------------------------------------------------------------- workspace

type Page = { kind: "channel"; id: string } | { kind: "new-channel" } | { kind: "inbox" } | { kind: "tasks" } | { kind: "search" } | { kind: "home" };
type SettingsOpen = { tab: SettingsTab | null; agent?: string };
/** Narrow windows (phones): the tabs along the bottom. */
type Tab = "chat" | "inbox" | "tasks" | "me";

const SIDE_WIDTH = 380, SIDE_MIN = 320, MAIN_MIN = 360, SIDE_WIDTH_KEY = "team.sideWidth";

/** The grip on the right column's left edge: drag it to widen or narrow the column, double-click it to reset. */
function ResizeHandle(props: { width: () => number; onResize: (w: number) => void; onDone: () => void; onReset: () => void }) {
  let from = 0, x0 = 0;
  const active = signal(false);
  return (
    <View
      testID="side-resize"
      accessibilityLabel={L("Drag to resize, double-click to reset", "拖动调整宽度，双击复位")}
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => { from = props.width(); x0 = e.pageX; active.set(true); }}
      onResponderMove={(e) => props.onResize(from - (e.pageX - x0))}
      onResponderRelease={() => { active.set(false); props.onDone(); }}
      onResponderTerminate={() => { active.set(false); props.onDone(); }}
      onPress={(e) => { if (e.clickCount === 2) props.onReset(); }}
      hoverStyle={{ backgroundColor: alpha(colors.accent, 0.35) }}
      style={{ position: "absolute", left: -3, top: 0, bottom: 0, width: 6, cursor: "col-resize", backgroundColor: active() ? alpha(colors.accent, 0.5) : "transparent" }}
    />
  );
}

function Workspace(props: { team: Team; onSignOut: () => void }) {
  const t = props.team;
  const wide = computed(() => windowSize().width >= WIDE);
  const page = signal<Page>({ kind: "home" });
  const side = signal<Side>(null);
  const settings = signal<SettingsOpen | null>(null);
  /** Narrow windows: the list shows until a page is picked. */
  const showList = signal(true);
  /** The right column's width: dragged at its left edge, remembered, reset by a double click. */
  const sideWidth = signal(SIDE_WIDTH);
  void Storage.getItem(SIDE_WIDTH_KEY).then((v) => { const n = Number(v); if (v && n > 0) sideWidth.set(n); });
  const fitSide = (w: number) => Math.round(Math.max(SIDE_MIN, Math.min(w, windowSize().width - 248 - MAIN_MIN)));
  const setSide = (w: number) => { sideWidth.set(w); void Storage.setItem(SIDE_WIDTH_KEY, String(w)); };

  // the first channel this person is in opens by itself on a wide window
  effect(() => {
    const cs = t.channels(), me = t.me();
    if (untracked(page).kind !== "home" || !me || !cs.length || !untracked(wide)) return;
    const first = cs.find((c) => isMember(c, "user", me.id)) ?? cs[0];
    open({ kind: "channel", id: first.id });
  });

  function open(p: Page, threadId: string | null = null) {
    if (p.kind === "channel") t.openChannel(p.id);
    else t.leaveView();
    page.set(p);
    side.set(threadId ? { kind: "thread", id: threadId } : null);
    showList.set(false);
  }
  const openSettings = (tab: SettingsTab | null = untracked(wide) ? "account" : null, agent?: string) => settings.set({ tab, agent });
  /** Narrow windows: the tab shown, or none when a page above the tabs is open (a channel, a thread, a setting). */
  const tab = (): Tab | null => {
    if (wide()) return null;
    const s = settings(), p = page();
    if (s) return s.tab ? null : "me";
    if (showList() || p.kind === "home") return "chat";
    return p.kind === "inbox" || p.kind === "tasks" ? p.kind : null;
  };
  function openTab(x: Tab) {
    if (x === "me") return settings.set({ tab: null });
    settings.set(null);
    if (x !== "chat") return open({ kind: x });
    if (untracked(page).kind === "channel") t.leaveView();
    showList.set(true);
  }
  // system notifications: a press opens what it is about
  watchNotifications(t, (channelId, threadId) => { settings.set(null); open({ kind: "channel", id: channelId }, threadId); });
  keymap.bind("mod+,", () => openSettings(), { when: "always" });
  keymap.bind("mod+k", () => open({ kind: "search" }), { when: "always" });

  const sidebar = () => (
    <Sidebar team={t} page={page()} inset={wide()} onOpen={open} onSettings={openSettings} onSignOut={props.onSignOut} />
  );
  const main = () => {
    const p = page();
    if (p.kind === "channel") {
      return (
        <ChannelView
          team={t} id={p.id} back={!wide()} onBack={() => { t.leaveView(); showList.set(true); }}
          side={side()} onThread={(id) => side.set({ kind: "thread", id })} onMembers={() => side.set(side()?.kind === "members" ? null : { kind: "members" })}
        />
      );
    }
    if (p.kind === "new-channel") return <NewChannel team={t} back={!wide()} onBack={() => showList.set(true)} onCreated={(id) => open({ kind: "channel", id })} />;
    if (p.kind === "tasks") return <TasksPage team={t} back={false} onBack={() => showList.set(true)} onOpen={(task) => open({ kind: "channel", id: task.channel_id }, task.thread_id)} />;
    if (p.kind === "search") return <SearchPage team={t} back={!wide()} onBack={() => showList.set(true)} onOpen={(id, threadId) => open({ kind: "channel", id }, threadId)} />;
    if (p.kind === "inbox") return <Inbox team={t} back={false} onBack={() => showList.set(true)} onOpen={(channelId, threadId) => open({ kind: "channel", id: channelId }, threadId)} />;
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <If when={t.loaded()} else={<Spinner size={20} tint={colors.muted} />}>
          <Text style={{ fontSize: 15, color: colors.muted, textAlign: "center" }}>{L("Pick a channel, or create one.", "选一个频道，或者新建一个。")}</Text>
        </If>
      </View>
    );
  };
  const sidePane = (back: boolean) => {
    const s = side(), p = page();
    if (!s || p.kind !== "channel") return null;
    if (s.kind === "thread") return <ThreadView team={t} rootId={s.id} back={back} onClose={() => side.set(null)} />;
    return <MembersPanel team={t} channelId={p.id} back={back} onClose={() => side.set(null)} onAgent={(h) => openSettings("agents", h)} />;
  };

  return (
    // phones: the keyboard pushes the page up; pages above the tabs keep clear of the home indicator
    <View style={{ flex: 1, paddingBottom: wide() ? 0 : keyboardFrame().height || (tab() ? 0 : safeArea().bottom) }}>
    <If
      when={settings()}
      else={
        <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}>
          <If
            when={wide()}
            else={
              <View style={{ flex: 1 }}>
                {/* one pane at a time: the window's title bar gets its own strip above it */}
                <If when={chrome().left}>
                  <View desktop={{ windowDrag: true }} style={{ height: chrome().height }} />
                </If>
                <If when={showList() || page().kind === "home"} else={<If when={sidePane(true)} else={<View style={{ flex: 1 }}>{main()}</View>}>{(pane) => pane()}</If>}>
                  {sidebar()}
                </If>
              </View>
            }
          >
            <View style={{ width: 248, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.sidebar }}>{sidebar()}</View>
            <View style={{ flex: 1 }}>{main()}</View>
            <If when={sidePane(false)}>
              {(pane) => (
                <View testID="side-pane" style={{ width: fitSide(sideWidth()), borderLeftWidth: 1, borderLeftColor: colors.border }}>
                  {pane()}
                  <ResizeHandle width={() => fitSide(untracked(sideWidth))} onResize={(w) => sideWidth.set(fitSide(w))} onDone={() => setSide(fitSide(untracked(sideWidth)))} onReset={() => setSide(SIDE_WIDTH)} />
                </View>
              )}
            </If>
          </If>
        </View>
      }
    >
      {(s) => (
        <SettingsPage
          team={t} tab={s().tab} agent={s().agent}
          onTab={(tab, agent) => settings.set({ tab, agent })}
          onClose={() => settings.set(null)}
          onSignOut={props.onSignOut}
        />
      )}
    </If>
    <If when={keyboardFrame().height ? null : tab()}>
      {(x) => <TabBar team={t} active={x()} onTab={openTab} />}
    </If>
    </View>
  );
}

/** Phones: messages, what waits for me, tasks, me. */
function TabBar(props: { team: Team; active: Tab; onTab: (x: Tab) => void }) {
  const t = props.team;
  const waiting = () => t.inbox().length + t.signups().length + t.reminders().filter((r) => reminderUp(r, t.me()?.id)).length;
  const unread = () => Object.values(t.unread()).reduce((n, x) => n + (x || 0), 0);
  const Item = (p: { tab: Tab; icon: IconName; label: string; badge: number }) => {
    const on = () => props.active === p.tab;
    return (
      <View role="tab" testID={`tab-${p.tab}`} accessibilityLabel={p.label} accessibilityState={{ selected: on() }} onPress={() => props.onTab(p.tab)}
        style={{ flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 3 }}>
        <View style={{ width: 56, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: on() ? alpha(colors.text, 0.08) : "transparent" }}>
          <Icon name={p.icon} size={22} tint={on() ? colors.text : colors.muted} weight={on() ? 1.8 : 1.5} />
          <If when={p.badge}>
            <View style={{ position: "absolute", top: -3, left: 33, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, borderWidth: 2, borderColor: colors.background, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
              <Text testID={`tab-${p.tab}-badge`} style={{ fontSize: 10.5, fontWeight: "600", color: colors.onAccent }}>{String(p.badge)}</Text>
            </View>
          </If>
        </View>
        <Text style={{ fontSize: 11, fontWeight: on() ? "600" : "400", color: on() ? colors.text : colors.muted }}>{p.label}</Text>
      </View>
    );
  };
  return (
    <View testID="tabbar" style={{ flexDirection: "row", paddingTop: 6, paddingBottom: Math.max(6, safeArea().bottom), borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>
      <Item tab="chat" icon="bubble" label={L("Messages", "消息")} badge={unread()} />
      <Item tab="inbox" icon="bell" label={L("Waiting", "待你决定")} badge={waiting()} />
      <Item tab="tasks" icon="task" label={L("Tasks", "任务")} badge={0} />
      <Item tab="me" icon="user" label={L("Me", "我")} badge={0} />
    </View>
  );
}

function Sidebar(props: { team: Team; page: Page; inset: boolean; onOpen: (p: Page) => void; onSettings: (tab?: SettingsTab | null, agent?: string) => void; onSignOut: () => void }) {
  const t = props.team;
  const mine = computed(() => {
    const me = t.me();
    return t.channels().filter((c) => !c.archived).map((c) => ({ c, member: !!me && isMember(c, "user", me.id) }));
  });
  const myAgents = () => t.agents().filter((a) => a.owner_id === t.me()?.id);
  const Row = (p: { testID: string; icon: IconName; label: string; active: boolean; badge?: number; dim?: boolean; onPress: () => void }) => (
    <View
      role="button"
      testID={p.testID}
      onPress={p.onPress}
      hoverStyle={hovered()}
      style={{ height: 34, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: p.active ? alpha(colors.text, 0.08) : "transparent" }}
    >
      <Icon name={p.icon} size={15} tint={p.dim ? colors.faint : colors.muted} />
      <Text style={{ flex: 1, fontSize: 14.5, fontWeight: p.badge ? "600" : "400", color: p.dim ? colors.muted : colors.text, numberOfLines: 1 }}>{p.label}</Text>
      <If when={p.badge}>
        <View style={{ minWidth: 20, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
          <Text testID={`${p.testID}-unread`} style={{ fontSize: 11.5, fontWeight: "600", color: colors.onAccent }}>{String(p.badge)}</Text>
        </View>
      </If>
    </View>
  );
  const Section = (p: { label: string; right?: JSX.Element }) => (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingTop: 14, paddingBottom: 4 }}>
      <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{p.label}</Text>
      {p.right}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <View desktop={{ windowDrag: true }} style={{ height: Math.max(52, chrome().height), flexDirection: "row", alignItems: "center", gap: 9, paddingLeft: props.inset && chrome().left ? chrome().left + 4 : 16, paddingRight: 16 }}>
        {/* wide: no logo or name for now, the bar stays as the window's drag area and the traffic lights' room */}
        <If when={!props.inset}>
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: colors.text }}>{L("Messages", "消息")}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Dot on={t.conn() === "live"} />
              <Text testID="conn-top" style={{ fontSize: 12, color: colors.muted }}>{t.conn() === "live" ? L("Live", "实时") : t.conn() === "offline" ? L("Offline, retrying", "离线，正在重连") : L("Connecting…", "连接中…")}</Text>
            </View>
          </View>
        </If>
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 8, gap: 2, paddingBottom: 16 }}>
        <Row testID="open-search" icon="search" label={L("Search", "搜索")} active={props.page.kind === "search"} onPress={() => props.onOpen({ kind: "search" })} />
        {/* phones have these as tabs */}
        <If when={props.inset}>
          <Row testID="open-inbox" icon="bell" label={L("Waiting for you", "待你决定")} badge={t.inbox().length + t.signups().length + t.reminders().filter((r) => reminderUp(r, t.me()?.id)).length} active={props.page.kind === "inbox"} onPress={() => props.onOpen({ kind: "inbox" })} />
          <Row testID="open-tasks" icon="lists" label={L("Tasks", "任务")} active={props.page.kind === "tasks"} onPress={() => props.onOpen({ kind: "tasks" })} />
        </If>
        <Section
          label={L("CHANNELS", "频道")}
          right={
            <View role="button" testID="new-channel" accessibilityLabel={L("New channel", "新建频道")} onPress={() => props.onOpen({ kind: "new-channel" })} hoverStyle={hovered()} style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
              <Icon name="plus" size={15} tint={colors.muted} />
            </View>
          }
        />
        <Each of={mine()} key={(x) => x.c.id}>
          {(x) => (
            <Row
              testID={`channel-${x().c.slug}`}
              icon={x().c.private ? "lock" : "chat"}
              label={x().c.name}
              dim={!x().member}
              badge={t.unread()[x().c.id] || 0}
              active={props.page.kind === "channel" && props.page.id === x().c.id}
              onPress={() => props.onOpen({ kind: "channel", id: x().c.id })}
            />
          )}
        </Each>
        <Section
          label={L("MY AGENTS", "我的 Agent")}
          right={
            <View role="button" testID="side-agents" accessibilityLabel={L("Manage agents", "管理 Agent")} onPress={() => props.onSettings("agents")} hoverStyle={hovered()} style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
              <Icon name="settings" size={14} tint={colors.muted} />
            </View>
          }
        />
        <If when={myAgents().length} else={
          <View role="button" testID="side-agent-new" onPress={() => props.onSettings("agents")} hoverStyle={hovered()} style={{ height: 30, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 8 }}>
            <Icon name="plus" size={14} tint={colors.faint} />
            <Text style={{ fontSize: 13.5, color: colors.muted }}>{L("Create your first agent", "新建你的第一个 Agent")}</Text>
          </View>
        }>
          <Each of={myAgents()} key={(a) => a.id}>
            {(a) => {
              const st = () => agentState(t, a());
              return (
                <View role="button" testID={`side-agent-${a().handle}`} onPress={() => props.onSettings("agents", a().handle)} hoverStyle={hovered()} style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}>
                  <Avatar name={a().name} agent size={22} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ fontSize: 14, color: colors.text, numberOfLines: 1 }}>{a().name}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                      <StateDot tone={st().tone} />
                      <Text testID={`side-agent-${a().handle}-state`} style={{ flex: 1, fontSize: 11.5, color: st().blocked ? colors.danger : colors.muted, numberOfLines: 1 }}>{`${runtimeLabel(a().runtime)} · ${st().label}`}</Text>
                    </View>
                  </View>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>
      {/* phones: me and settings are the Me tab */}
      <If when={props.inset} else={<UpdateRow />}>
        <View testID="side-footer" style={{ minHeight: FOOTER, justifyContent: "center", paddingHorizontal: 8, paddingVertical: 6, gap: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
          <UpdateRow />
          <UserMenu team={t} onSettings={props.onSettings} onSignOut={props.onSignOut} />
        </View>
      </If>
    </View>
  );
}

/** Bottom left: me and a gear; opens Settings (⌘,), my agents & machines, sign in on another device, sign out. */
function UserMenu(props: { team: Team; onSettings: (tab?: SettingsTab | null, agent?: string) => void; onSignOut: () => void }) {
  const t = props.team;
  const row = (): ViewStyle => ({ flexDirection: "row", alignItems: "center", gap: 10, height: 32, paddingHorizontal: 8, borderRadius: 7 });
  const item = (testID: string, icon: IconName, label: string, onSelect: () => void, right?: string, danger?: boolean) => (
    <MenuItem testID={testID} onSelect={onSelect} hoverStyle={hovered()} activeStyle={hovered()} style={row()}>
      <Icon name={icon} size={15} tint={danger ? colors.danger : colors.muted} />
      <Text style={{ flex: 1, fontSize: 13.5, color: danger ? colors.danger : colors.text, numberOfLines: 1 }}>{label}</Text>
      <If when={right}><Text style={{ fontSize: 12, color: colors.faint }}>{right}</Text></If>
    </MenuItem>
  );
  const sep = () => <MenuSeparator style={{ height: 1, marginVertical: 4, marginHorizontal: 8, backgroundColor: alpha(colors.text, 0.07) }} />;
  return (
    <Menu
      align="start"
      placement="top"
      offset={6}
      margin={8}
      popupStyle={{ minWidth: 240, padding: 5, borderRadius: 12, borderWidth: 1, borderColor: alpha(colors.text, 0.1), backgroundColor: colors.surface, boxShadow: "0 8px 28px rgba(0,0,0,0.14)" }}
      backdropClass="bg-scrim"
      trigger={
        <View role="button" testID="user-menu" accessibilityLabel={L("Account menu", "用户菜单")} hoverStyle={hovered()} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 8, borderRadius: radius.control }}>
          <Avatar name={t.me()?.name ?? "?"} size={28} />
          <View style={{ flex: 1 }}>
            <Text testID="me-name" style={{ fontSize: 14, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{t.me()?.name ?? ""}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Dot on={t.conn() === "live"} />
              <Text testID="conn" style={{ fontSize: 11.5, color: colors.muted }}>{t.conn() === "live" ? L("Live", "实时") : t.conn() === "offline" ? L("Offline, retrying", "离线，正在重连") : L("Connecting…", "连接中…")}</Text>
            </View>
          </View>
          <Icon name="settings" size={16} tint={colors.muted} />
        </View>
      }
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 7 }}>
        <Avatar name={t.me()?.name ?? "?"} size={30} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{t.me()?.name ?? ""}</Text>
          <Text style={{ fontSize: 12, color: colors.muted, numberOfLines: 1 }}>{t.me()?.email ?? ""}</Text>
        </View>
      </View>
      {sep()}
      {item("menu-settings", "settings", L("Settings", "设置"), () => props.onSettings(), keymap.label("mod+,"))}
      {item("menu-agents", "spark", L("My agents & machines", "我的 Agent 与机器"), () => props.onSettings("agents"))}
      {item("menu-login-code", "mobile", L("Sign in on another device", "在其他设备登录"), () => props.onSettings("account"))}
      <If when={canCheckUpdates}>
        {item("menu-check-updates", "download", L("Check for updates", "检查更新"), () => void checkNow())}
      </If>
      {sep()}
      {item("menu-sign-out", "external", L("Sign out", "退出登录"), props.onSignOut, undefined, true)}
      <Text testID="menu-version" style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: 3, fontSize: 11.5, color: colors.faint }}>Remi {CLIENT_VERSION}</Text>
    </Menu>
  );
}

// ---------------------------------------------------------------- root

/** The team client: signs in, then the workspace; a lost session (401) comes back to sign in. */
export function TeamApp() {
  const ready = signal(false);
  const session = signal<Session | null>(null);
  const url = signal("");
  const email = signal("");
  const notice = signal("");
  Promise.all([Storage.getItem(TEAM_KEYS.url), Storage.getItem(TEAM_KEYS.session), Storage.getItem(TEAM_KEYS.email)]).then(([u, s, e]) => {
    url.set(u ?? "");
    email.set(e ?? "");
    if (u && s) session.set({ url: u, session: s });
    ready.set(true);
  });
  async function signedIn(s: Session, e: string) {
    await Storage.setItem(TEAM_KEYS.url, s.url);
    await Storage.setItem(TEAM_KEYS.session, s.session);
    await Storage.setItem(TEAM_KEYS.email, e);
    url.set(s.url);
    email.set(e);
    notice.set("");
    session.set(s);
  }
  async function forget(message: string) {
    await Storage.removeItem(TEAM_KEYS.session);
    notice.set(message);
    session.set(null);
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <If when={ready()}>
        <If when={session()} else={<SignIn url={url()} email={email()} notice={notice()} onSession={signedIn} />}>
          {(s) => {
            const team = createTeam(s());
            cleanup(team.dispose);
            effect(() => {
              if (team.conn() === "unauthorized") forget(L("Your session expired. Please sign in again.", "登录已过期，请重新登录"));
            });
            return <Workspace team={team} onSignOut={async () => { await team.logout(); forget(""); }} />;
          }}
        </If>
      </If>
    </View>
  );
}
