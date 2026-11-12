// Remi: several people and their agents in shared channels, against the Go server's /api/v1. This file is the frame:
// sign in, then the workspace (sidebar, the page in the middle, a thread or the members beside it). Wide windows show
// them side by side; narrow ones one pane at a time. The screens live next to it: signin, channel (with taskfacts),
// composer, messages, taskcard, inbox, tasks, search, reminders, settings.
import { cleanup, computed, effect, type JSX, keyboardFrame, keymap, platform, safeArea, Scroll, signal, Storage, Text, untracked, UrlScheme, View, windowSize } from "nsh";
import { CLIENT_VERSION } from "../version";
import { L } from "../i18n";
import { AccountRow, Avatar, colors, Count, Dot, hovered, Icon, IconBtn, type IconName, MenuHeading, MenuLine, MenuRow, PopMenu, radius, Spinner, toast, Txt } from "../ui";
import { reminderUp, createTeam, isMember, mayBringAgent, parseLoginLink, runtimeLabel, TEAM_KEYS, type Agent, type Session, type Team } from "./api";
import { TasksPage } from "./tasks";
import { SettingsPage, type SettingsTab } from "./settings";
import { SearchPage } from "./search";
import { canCheckUpdates, checkNow, UpdateRow } from "./updates";
import { agentState, chrome, FOOTER, WIDE } from "./ui";
import { ChannelView, DMDraft, MembersPanel, NewChannel, ThreadView, type Side } from "./channel";
import { Inbox } from "./inbox";
import { watchNotifications } from "./notify";
import { SignIn } from "./signin";

// ---------------------------------------------------------------- workspace

/** dm: a private chat with the agent not made yet (its first message makes it, and the page becomes the channel). */
type Page = { kind: "channel"; id: string } | { kind: "dm"; agent: string } | { kind: "new-channel" } | { kind: "inbox" } | { kind: "tasks" } | { kind: "search" } | { kind: "home" };
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
      hoverStyle={{ backgroundColor: colors.focus }}
      style={{ position: "absolute", left: -3, top: 0, bottom: 0, width: 6, cursor: "col-resize", backgroundColor: active() ? colors.fg3 : "transparent" }}
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
    const first = cs.find((c) => !c.dm_agent && isMember(c, "user", me.id)) ?? cs.find((c) => !c.dm_agent);
    if (!first) return;
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
    if (p.kind === "dm") {
      const a = t.agents().find((x) => x.id === p.agent);
      if (a) return <DMDraft team={t} agent={a} back={!wide()} onBack={() => showList.set(true)} onMade={(id) => open({ kind: "channel", id })} />;
    }
    if (p.kind === "new-channel") return <NewChannel team={t} back={!wide()} onBack={() => showList.set(true)} onCreated={(id) => open({ kind: "channel", id })} />;
    if (p.kind === "tasks") return <TasksPage team={t} back={false} onBack={() => showList.set(true)} onOpen={(task) => open({ kind: "channel", id: task.channel_id }, task.thread_id)} />;
    if (p.kind === "search") return <SearchPage team={t} back={!wide()} onBack={() => showList.set(true)} onOpen={(id, threadId) => open({ kind: "channel", id }, threadId)} />;
    if (p.kind === "inbox") return <Inbox team={t} back={false} onBack={() => showList.set(true)} onOpen={(channelId, threadId) => open({ kind: "channel", id: channelId }, threadId)} />;
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <If when={t.loaded()} else={<Spinner size={20} tint={colors.fg2} />}>
          <Text style={{ fontSize: 15, color: colors.fg2, textAlign: "center" }}>{L("Pick a channel, or create one.", "选一个频道，或者新建一个。")}</Text>
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
        <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.page }}>
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
            <View style={{ width: 248, borderRightWidth: 1, borderRightColor: colors.hairline, backgroundColor: colors.sidebar }}>{sidebar()}</View>
            <View style={{ flex: 1 }}>{main()}</View>
            <If when={sidePane(false)}>
              {(pane) => (
                <View testID="side-pane" style={{ width: fitSide(sideWidth()), borderLeftWidth: 1, borderLeftColor: colors.hairline }}>
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
  const waiting = () => t.inbox().length + t.signups().length + t.proposals().length + t.reminders().filter((r) => reminderUp(r, t.me()?.id)).length;
  const unread = () => Object.values(t.unread()).reduce((n, x) => n + (x || 0), 0);
  const Item = (p: { tab: Tab; icon: IconName; label: string; badge: number }) => {
    const on = () => props.active === p.tab;
    return (
      <View role="tab" testID={`tab-${p.tab}`} accessibilityLabel={p.label} accessibilityState={{ selected: on() }} onPress={() => props.onTab(p.tab)}
        style={{ flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 3 }}>
        <View style={{ width: 56, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: on() ? colors.selected : "transparent" }}>
          <Icon name={p.icon} size={22} tint={on() ? colors.fg : colors.fg2} weight={on() ? 1.8 : 1.5} />
          <If when={p.badge}>
            <View style={{ position: "absolute", top: -3, left: 33, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, borderWidth: 2, borderColor: colors.page, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary }}>
              <Text testID={`tab-${p.tab}-badge`} style={{ fontSize: 10.5, fontWeight: "600", color: colors.onPrimary }}>{String(p.badge)}</Text>
            </View>
          </If>
        </View>
        <Text style={{ fontSize: 11, fontWeight: on() ? "600" : "400", color: on() ? colors.fg : colors.fg2 }}>{p.label}</Text>
      </View>
    );
  };
  return (
    <View testID="tabbar" style={{ flexDirection: "row", paddingTop: 6, paddingBottom: Math.max(6, safeArea().bottom), borderTopWidth: 1, borderTopColor: colors.hairline, backgroundColor: colors.page }}>
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
    return t.channels().filter((c) => !c.archived && !c.dm_agent).map((c) => ({ c, member: !!me && isMember(c, "user", me.id) }));
  });
  const myAgents = () => t.agents().filter((a) => a.owner_id === t.me()?.id);
  /**
   * 私聊: my agents, then others' agents I have a chat with, then my chats with agents that are gone or no longer take
   * my work. Others' team-wide agents I haven't talked to stay behind the + (listing them all would put every
   * teammate's agents and computers in my sidebar).
   */
  const chats = computed(() => {
    const me = t.me();
    const page = props.page;
    const started = (a: Agent) => (page.kind === "dm" && page.agent === a.id) || t.channels().some((c) => c.dm_agent === a.id && c.created_by === me?.id);
    const live = t.agents().filter((a) => mayBringAgent(a, me) && (a.owner_id === me?.id || started(a))).sort((a, b) => Number(b.owner_id === me?.id) - Number(a.owner_id === me?.id));
    const dead = t.channels().filter((c) => c.dm_agent && c.created_by === me?.id && !live.some((a) => a.id === c.dm_agent));
    return [...live.map((a) => ({ key: a.id, agent: a as Agent | null, handle: a.handle })), ...dead.map((c) => ({ key: c.dm_agent!, agent: null, handle: c.name }))];
  });
  /** Others' agents that take the whole team's work and I have no chat with yet: the + of 私聊 starts one. */
  const moreChats = computed(() => t.agents().filter((a) => a.owner_id !== t.me()?.id && mayBringAgent(a, t.me()) && !chats().some((x) => x.key === a.id)));
  const openChat = (agentId: string) => {
    const c = t.dmWith(agentId);
    props.onOpen(c ? { kind: "channel", id: c.id } : { kind: "dm", agent: agentId });
  };
  const chatActive = (agentId: string) => {
    const p = props.page;
    return (p.kind === "dm" && p.agent === agentId) || (p.kind === "channel" && t.dmWith(agentId)?.id === p.id);
  };
  const Row = (p: { testID: string; icon: IconName; label: string; active: boolean; badge?: number; dim?: boolean; onPress: () => void }) => (
    <View
      role="button"
      testID={p.testID}
      onPress={p.onPress}
      hoverStyle={hovered()}
      style={{ height: 34, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: p.active ? colors.selected : "transparent" }}
    >
      <Icon name={p.icon} size={15} tint={p.dim ? colors.fg3 : colors.fg2} />
      <Text style={{ flex: 1, fontSize: 14.5, fontWeight: p.badge ? "600" : "400", color: p.dim ? colors.fg2 : colors.fg, numberOfLines: 1 }}>{p.label}</Text>
      <Count n={p.badge ?? 0} testID={`${p.testID}-unread`} />
    </View>
  );
  const Section = (p: { label: string; right?: JSX.Element }) => (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingTop: 14, paddingBottom: 4 }}>
      <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "600", color: colors.fg3 }}>{p.label}</Text>
      {p.right}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <View desktop={{ windowDrag: true }} style={{ height: Math.max(52, chrome().height), flexDirection: "row", alignItems: "center", gap: 9, paddingLeft: props.inset && chrome().left ? chrome().left + 4 : 16, paddingRight: 16 }}>
        {/* wide: no logo or name for now, the bar stays as the window's drag area and the traffic lights' room */}
        <If when={!props.inset}>
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: colors.fg }}>{L("Messages", "消息")}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Dot on={t.conn() === "live"} />
              <Text testID="conn-top" style={{ fontSize: 12, color: colors.fg2 }}>{t.conn() === "live" ? L("Live", "实时") : t.conn() === "offline" ? L("Offline, retrying", "离线，正在重连") : L("Connecting…", "连接中…")}</Text>
            </View>
          </View>
        </If>
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 8, gap: 2, paddingBottom: 16 }}>
        <Row testID="open-search" icon="search" label={L("Search", "搜索")} active={props.page.kind === "search"} onPress={() => props.onOpen({ kind: "search" })} />
        {/* phones have these as tabs */}
        <If when={props.inset}>
          <Row testID="open-inbox" icon="bell" label={L("Waiting for you", "待你决定")} badge={t.inbox().length + t.signups().length + t.proposals().length + t.reminders().filter((r) => reminderUp(r, t.me()?.id)).length} active={props.page.kind === "inbox"} onPress={() => props.onOpen({ kind: "inbox" })} />
          <Row testID="open-tasks" icon="lists" label={L("Tasks", "任务")} active={props.page.kind === "tasks"} onPress={() => props.onOpen({ kind: "tasks" })} />
        </If>
        <Section
          label={L("CHANNELS", "频道")}
          right={
            <View role="button" testID="new-channel" accessibilityLabel={L("New channel", "新建频道")} onPress={() => props.onOpen({ kind: "new-channel" })} hoverStyle={hovered()} style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
              <Icon name="plus" size={15} tint={colors.fg2} />
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
          label={L("PRIVATE CHATS", "私聊")}
          right={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <If when={moreChats().length}>
                <PopMenu
                  align="end"
                  wide
                  maxHeight={360}
                  trigger={
                    <IconBtn testID="side-chat-new" icon="plus" label={L("Chat with another agent", "和其他 Agent 私聊")} size="sm" tone="muted" onPress={() => {}} />
                  }
                >
                  <MenuHeading text={L("Team agents", "团队的 Agent")} />
                  <Each of={moreChats()} key={(a) => a.id}>
                    {(a) => (
                      <MenuRow testID={`side-chat-new-${a().handle}`} icon="spark" label={a().name}
                        right={t.users().find((u) => u.id === a().owner_id)?.name ?? ""} onSelect={() => openChat(a().id)} />
                    )}
                  </Each>
                </PopMenu>
              </If>
              <IconBtn testID="side-agents" icon="settings" label={L("Manage agents", "管理 Agent")} size="sm" tone="muted" onPress={() => props.onSettings("agents")} />
            </View>
          }
        />
        <Each of={chats()} key={(x) => x.key}>
          {(x) => {
            const a = () => x().agent;
            const st = () => (a() ? agentState(t, a()!) : null);
            const mine = () => a()?.owner_id === t.me()?.id;
            const owner = () => t.users().find((u) => u.id === a()?.owner_id)?.name ?? "";
            const unread = () => { const c = t.dmWith(x().key); return c ? t.unread()[c.id] || 0 : 0; };
            return (
              <View role="button" testID={`side-agent-${x().handle}`} onPress={() => openChat(x().key)} hoverStyle={hovered()}
                style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: chatActive(x().key) ? colors.selected : "transparent" }}>
                <Avatar name={a()?.name ?? x().handle} agent size={22} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: unread() ? "600" : "400", color: a() ? colors.fg : colors.fg2, numberOfLines: 1 }}>{a()?.name ?? `@${x().handle}`}</Text>
                  <If when={st()} else={<Txt variant="caption" tone="faint">{L("history only", "只能看历史")}</Txt>}>
                    {(s) => (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                        <Dot tone={s().tone} />
                        <Text testID={`side-agent-${x().handle}-state`} style={{ flex: 1, fontSize: 11.5, color: s().blocked ? colors.danger : colors.fg2, numberOfLines: 1 }}>
                          {mine() ? `${runtimeLabel(a()!.runtime)} · ${s().label}` : L(`${owner()}’s · ${s().label}`, `${owner()}的 · ${s().label}`)}
                        </Text>
                      </View>
                    )}
                  </If>
                </View>
                <Count n={unread()} testID={`side-agent-${x().handle}-unread`} />
              </View>
            );
          }}
        </Each>
        <If when={!myAgents().length}>
          <View role="button" testID="side-agent-new" onPress={() => props.onSettings("agents")} hoverStyle={hovered()} style={{ height: 30, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 8 }}>
            <Icon name="plus" size={14} tint={colors.fg3} />
            <Text style={{ fontSize: 13.5, color: colors.fg2 }}>{L("Create your first agent", "新建你的第一个 Agent")}</Text>
          </View>
        </If>
      </Scroll>
      {/* phones: me and settings are the Me tab */}
      <If when={props.inset} else={<UpdateRow />}>
        <View testID="side-footer" style={{ minHeight: FOOTER, justifyContent: "center", paddingHorizontal: 8, paddingVertical: 6, gap: 6, borderTopWidth: 1, borderTopColor: colors.hairline }}>
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
  const item = (testID: string, icon: IconName, label: string, onSelect: () => void, right?: string, danger?: boolean) => (
    <MenuRow testID={testID} icon={icon} label={label} onSelect={onSelect} right={right} danger={danger} />
  );
  return (
    <PopMenu
      align="start"
      placement="top"
      wide
      trigger={
        <AccountRow
          testID="user-menu"
          nameTestID="me-name"
          statusTestID="conn"
          label={L("Account menu", "用户菜单")}
          name={t.me()?.name ?? ""}
          live={t.conn() === "live"}
          status={t.conn() === "live" ? L("Live", "实时") : t.conn() === "offline" ? L("Offline, retrying", "离线，正在重连") : L("Connecting…", "连接中…")}
        />
      }
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 7 }}>
        <Avatar name={t.me()?.name ?? "?"} size={30} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13.5, fontWeight: "600", color: colors.fg, numberOfLines: 1 }}>{t.me()?.name ?? ""}</Text>
          <Text style={{ fontSize: 12, color: colors.fg2, numberOfLines: 1 }}>{t.me()?.email ?? ""}</Text>
        </View>
      </View>
      <MenuLine />
      {item("menu-settings", "settings", L("Settings", "设置"), () => props.onSettings(), keymap.label("mod+,"))}
      {item("menu-agents", "spark", L("My agents & machines", "我的 Agent 与机器"), () => props.onSettings("agents"))}
      {item("menu-login-code", "mobile", L("Sign in on another device", "在其他设备登录"), () => props.onSettings("account"))}
      <If when={canCheckUpdates}>
        {item("menu-check-updates", "download", L("Check for updates", "检查更新"), () => void checkNow())}
      </If>
      <MenuLine />
      {item("menu-sign-out", "external", L("Sign out", "退出登录"), props.onSignOut, undefined, true)}
      <Text testID="menu-version" style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: 3, fontSize: 11.5, color: colors.fg3 }}>Remi {CLIENT_VERSION}</Text>
    </PopMenu>
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
  // A login link opened the app: the QR of 设置 › 账号 › 在其他设备登录 that a phone's camera scanned
  // (remi://login?…), or, on the web, the page …/login/CODE. Signed out, the sign-in screen uses it; signed in, it
  // is dropped with a word (switching accounts is signing out first).
  const loginLink = signal<{ server: string; code: string } | null>(null);
  const opened = (u: string) => {
    const l = parseLoginLink(u);
    if (l) loginLink.set(l);
  };
  cleanup(UrlScheme.on("open", ({ url: u }) => opened(u)));
  if (platform.os === "web") {
    const here = UrlScheme.url() ?? "";
    if (/\/login\/[A-Za-z0-9-]+\/?$/.test(here)) {
      opened(here);
      UrlScheme.setUrl(here.replace(/\/login\/[A-Za-z0-9-]+\/?$/, "/")); // a reload doesn't use the code again
    }
  }
  effect(() => {
    if (!ready() || !session() || !loginLink()) return;
    untracked(() => {
      loginLink.set(null);
      toast(L("This device is already signed in. Sign out first to switch accounts.", "这台设备已经登录了，要换账号请先退出登录"), "info");
    });
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
    <View style={{ flex: 1, backgroundColor: colors.page }}>
      <If when={ready()}>
        <If when={session()} else={<SignIn url={url()} email={email()} notice={notice()} link={loginLink()} onLinkUsed={() => loginLink.set(null)} onSession={signedIn} />}>
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
