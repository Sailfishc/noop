// Remi: several people and their agents in shared channels, against the Go server's /api/v1. This file is the frame:
// sign in, then the workspace (sidebar, the page in the middle, a thread or the members beside it). Wide windows show
// them side by side; narrow ones one pane at a time. The screens live next to it: signin, channel (with taskfacts),
// composer, messages, taskcard, inbox, tasks, search, reminders, settings.
import { cleanup, computed, effect, type JSX, keyboardFrame, keymap, platform, safeArea, Scroll, signal, Storage, Text, untracked, UrlScheme, View, windowSize } from "nsh";
import { CLIENT_VERSION } from "../version";
import { L } from "../i18n";
import { AccountRow, Avatar, colors, CommandPalette, Count, Dot, Icon, IconBtn, type IconName, Keys, ListHeading, ListRow, MenuHeading, MenuLine, MenuRow, PageStack, PopMenu, RowMenu, createPageStack, Spinner, StateMark, TabBar, titleBarHeight, toast, Txt } from "../ui";
import { reminderUp, createTeam, isMember, mayBringAgent, parseLoginLink, runtimeLabel, TEAM_KEYS, type Agent, type Session, type Team } from "./api";
import { TasksPage } from "./tasks";
import { SettingsPage, type SettingsTab } from "./settings";
import { SearchPage } from "./search";
import { canCheckUpdates, checkNow, UpdateRow } from "./updates";
import { agentState, chrome, FOOTER, WIDE } from "./ui";
import { agentCommands, bindShortcuts, channelCommands, paletteCommands, type Cmd, type Nav } from "./commands";
import { composeInto } from "./composer";
import { concernsMe } from "./taskpeople";
import { ChannelView, DMDraft, MembersPanel, NewChannel, ThreadView, type Side } from "./channel";
import { Inbox } from "./inbox";
import { watchNotifications } from "./notify";
import { SignIn } from "./signin";

// ---------------------------------------------------------------- workspace

/** dm: a private chat with the agent not made yet (its first message makes it, and the page becomes the channel). */
type Page = { kind: "channel"; id: string } | { kind: "dm"; agent: string } | { kind: "new-channel" } | { kind: "inbox" } | { kind: "tasks" } | { kind: "search"; query?: string } | { kind: "home" };
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

  // phones open on 待你决定 when something waits there, once: until this person goes anywhere else first
  let launched = false;
  effect(() => {
    const n = waitingCount(t);
    if (launched || untracked(wide)) return;
    if (untracked(page).kind !== "home" || untracked(settings)) { launched = true; return; }
    if (n > 0) { launched = true; untracked(() => open({ kind: "inbox" })); }
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
    launched = true;
    if (x === "me") return settings.set({ tab: null });
    settings.set(null);
    if (x !== "chat") return open({ kind: x });
    if (untracked(page).kind === "channel") t.leaveView();
    showList.set(true);
  }
  // system notifications: a press opens what it is about
  watchNotifications(t, (channelId, threadId) => { settings.set(null); open({ kind: "channel", id: channelId }, threadId); });
  keymap.bind("mod+,", () => openSettings(), { when: "always" });

  // ⌘K: the command palette over everything, fed by the one command registry (commands.ts)
  const palette = signal(false);
  const query = signal("");
  const openPalette = (q = "") => { query.set(q); palette.set(true); };
  const openChat = (agentId: string) => {
    settings.set(null);
    const c = t.dmWith(agentId);
    open(c ? { kind: "channel", id: c.id } : { kind: "dm", agent: agentId });
  };
  const here = () => { const p = untracked(page); return p.kind === "channel" ? t.channels().find((c) => c.id === p.id) ?? null : null; };
  const nav: Nav = {
    team: t,
    inbox: () => { settings.set(null); open({ kind: "inbox" }); },
    tasks: () => { settings.set(null); open({ kind: "tasks" }); },
    channel: (id) => { settings.set(null); if (untracked(page).kind !== "channel" || (untracked(page) as { id: string }).id !== id) open({ kind: "channel", id }); },
    chat: openChat,
    newChannel: () => { settings.set(null); open({ kind: "new-channel" }); },
    settings: (tab) => openSettings(tab ?? undefined),
    search: (q) => { if (!q) return openPalette(); settings.set(null); open({ kind: "search", query: q }); },
    here,
    dispatch: (a) => {
      const c = here();
      // in the open channel when it can be asked there (a member, or one that takes the whole team's work)
      if (c && !c.dm_agent && (isMember(c, "agent", a.id) || a.dispatch === "team")) return composeInto.set({ channel: c.id, text: `@${a.handle} `, at: Date.now() });
      openChat(a.id);
    },
  };
  bindShortcuts({ palette: openPalette, inbox: nav.inbox, tasks: nav.tasks });
  keymap.bind("escape", () => { if (untracked(side)) side.set(null); }, { when: "notEditing", passThrough: true });
  const commands = () => paletteCommands(nav, query());
  const run = (id: string) => {
    const c = untracked(commands).find((x) => x.id === id);
    palette.set(false);
    c?.run();
  };

  const sidebar = () => (
    <Sidebar team={t} page={page()} inset={wide()} nav={nav} onOpen={open} onPalette={() => openPalette()} onSettings={openSettings} onSignOut={props.onSignOut} />
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
    if (p.kind === "search") return <SearchPage team={t} query={p.query} back={!wide()} onBack={() => showList.set(true)} onOpen={(id, threadId) => open({ kind: "channel", id }, threadId)} />;
    if (p.kind === "inbox") return <Inbox team={t} wide={wide()} back={false} onBack={() => showList.set(true)} onOpen={(channelId, threadId) => open({ kind: "channel", id: channelId }, threadId)} />;
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <If when={t.loaded()} else={<Spinner size={20} tint={colors.fg2} />}>
          <Text style={{ fontSize: 15, color: colors.fg2, textAlign: "center" }}>{L("Pick a channel, or create one.", "选一个频道，或者新建一个。")}</Text>
        </If>
      </View>
    );
  };
  // narrow windows: the pages as a stack (list, then a page, then a thread or the members), kept in step with the state
  type Pane = "list" | "main" | "side";
  const stack = createPageStack<Pane>(["list"]);
  const tabPage = () => !showList() && (page().kind === "inbox" || page().kind === "tasks");
  const panes = (): Pane[] => showList() || page().kind === "home" || tabPage() ? ["list"] : side() && page().kind === "channel" ? ["list", "main", "side"] : ["list", "main"];
  effect(() => {
    if (wide()) return;
    const want = panes();
    if (want.join() !== untracked(stack.routes).join()) stack.setRoutes(want);
  });
  /** The person went back by a swipe or the system's back: what is left of the stack says where they are now. */
  function backTo(routes: readonly Pane[]) {
    if (routes.length < 3 && untracked(side)) side.set(null);
    if (routes.length < 2 && !untracked(showList)) {
      if (untracked(page).kind === "channel") t.leaveView();
      showList.set(true);
    }
  }
  /** The thread or members page keeps showing while it slides away after a back. */
  let kept: JSX.Element | null = null;
  const keptSide = () => { const p = sidePane(true); if (p) kept = p; return kept; };
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
                {/* the list, the page over it, a thread or the members over that: a swipe from the left edge goes back */}
                {/* 待你决定 and 任务 are tabs of their own, beside the stack rather than pushed over the list */}
                <If when={tabPage()} else={
                  <PageStack testID="pages" state={stack} onBack={backTo}>
                    {(r) => r === "list" ? sidebar() : r === "main" ? <View style={{ flex: 1 }}>{main()}</View> : <View style={{ flex: 1 }}>{keptSide()}</View>}
                  </PageStack>
                }>
                  <View style={{ flex: 1 }}>{main()}</View>
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
      {(x) => <PhoneTabs team={t} active={x()} onTab={openTab} />}
    </If>
    <CommandPalette
      testID="palette"
      open={palette()}
      onClose={() => palette.set(false)}
      items={commands()}
      query={query()}
      onQuery={query.set}
      onSelect={run}
      label={L("Commands", "命令")}
      placeholder={L("Type a command, or search…", "输入命令，或搜索…")}
      empty={L("No command by that name", "没有这个命令")}
    />
    </View>
  );
}

/** Phones: what waits for me first, then messages, tasks, me. */
function PhoneTabs(props: { team: Team; active: Tab; onTab: (x: Tab) => void }) {
  const t = props.team;
  const unread = () => Object.values(t.unread()).reduce((n, x) => n + (x || 0), 0);
  return (
    <TabBar testID="tab" value={props.active} onChange={props.onTab} tabs={[
      { value: "inbox", icon: "bell", label: L("Waiting", "待你决定"), badge: waitingCount(t), tone: "attention" },
      { value: "chat", icon: "bubble", label: L("Messages", "消息"), badge: unread() },
      { value: "tasks", icon: "task", label: L("Tasks", "任务") },
      { value: "me", icon: "user", label: L("Me", "我") },
    ]} />
  );
}

function Sidebar(props: { team: Team; page: Page; inset: boolean; nav: Nav; onOpen: (p: Page) => void; onPalette: () => void; onSettings: (tab?: SettingsTab | null, agent?: string) => void; onSignOut: () => void }) {
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
  const chatActive = (agentId: string) => {
    const p = props.page;
    return (p.kind === "dm" && p.agent === agentId) || (p.kind === "channel" && t.dmWith(agentId)?.id === p.id);
  };
  /** My open tasks (what 我的任务 lists first). */
  const myTasks = () => Object.values(t.tasks()).filter((x) => !["done", "closed"].includes(x.state) && concernsMe(t, x)).length;
  const menu = (cmds: Cmd[]) => (
    <Each of={cmds} key={(c) => c.id}>
      {(c) => <MenuRow testID={`ctx-${c().id}`} icon={c().icon} label={c().label} right={c().keys} onSelect={c().run} />}
    </Each>
  );
  return (
    <View style={{ flex: 1 }}>
      <View desktop={{ windowDrag: true }} style={{ height: Math.max(titleBarHeight, chrome().height), flexDirection: "row", alignItems: "center", paddingLeft: props.inset && chrome().left ? chrome().left : 0 }}>
        {/* phones: the page's title and whether it is live */}
        <If when={!props.inset}>
          <View style={{ flex: 1, gap: 1, paddingHorizontal: 16 }}>
            <Txt variant="display" weight="bold">{L("Messages", "消息")}</Txt>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Dot on={t.conn() === "live"} />
              <Txt variant="caption" tone="muted" testID="conn-top">{t.conn() === "live" ? L("Live", "实时") : t.conn() === "offline" ? L("Offline, retrying", "离线，正在重连") : L("Connecting…", "连接中…")}</Txt>
            </View>
          </View>
        </If>
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 8, gap: 1, paddingBottom: 16 }}>
        {/* ⌘K: go anywhere, do anything, search */}
        <ListRow testID="open-search" title={L("Search", "搜索")} label={L("Search or run a command", "搜索或执行命令")}
          left={<Icon name="search" size={15} tint={colors.fg2} />} right={<If when={props.inset}><Keys keys={keymap.label("mod+k")} /></If>}
          selected={props.page.kind === "search"} onPress={props.onPalette} />
        {/* what needs me first; phones have these as tabs */}
        <If when={props.inset}>
          <ListRow testID="open-inbox" title={L("Waiting for you", "待你决定")} strong={!!waitingCount(t)} left={<Icon name="bell" size={15} tint={colors.fg2} />}
            right={<Count tone="attention" n={waitingCount(t)} testID="open-inbox-unread" />} selected={props.page.kind === "inbox"} onPress={() => props.onOpen({ kind: "inbox" })} />
          <ListRow testID="open-tasks" title={L("My tasks", "我的任务")} left={<Icon name="lists" size={15} tint={colors.fg2} />}
            right={<Count n={myTasks()} testID="open-tasks-count" />} selected={props.page.kind === "tasks"} onPress={() => props.onOpen({ kind: "tasks" })} />
        </If>
        <ListHeading text={L("Channels", "频道")} right={<IconBtn testID="new-channel" icon="plus" size="sm" tone="muted" label={L("New channel", "新建频道")} onPress={() => props.onOpen({ kind: "new-channel" })} />} />
        <Each of={mine()} key={(x) => x.c.id}>
          {(x) => (
            <RowMenu trigger={
              <ListRow
                testID={`channel-${x().c.slug}`}
                title={x().c.name}
                left={<Icon name={x().c.private ? "lock" : "chat"} size={15} tint={x().member ? colors.fg2 : colors.fg3} />}
                dim={!x().member}
                strong={!!t.unread()[x().c.id]}
                right={<Count n={t.unread()[x().c.id] || 0} testID={`channel-${x().c.slug}-unread`} />}
                selected={props.page.kind === "channel" && props.page.id === x().c.id}
                onPress={() => props.onOpen({ kind: "channel", id: x().c.id })}
              />
            }>{menu(channelCommands(props.nav, x().c))}</RowMenu>
          )}
        </Each>
        <ListHeading
          text={L("Private chats", "私聊")}
          right={
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <If when={moreChats().length}>
                <PopMenu align="end" wide maxHeight={360}
                  trigger={<IconBtn testID="side-chat-new" icon="plus" label={L("Chat with another agent", "和其他 Agent 私聊")} size="sm" tone="muted" onPress={() => {}} />}>
                  <MenuHeading text={L("Team agents", "团队的 Agent")} />
                  <Each of={moreChats()} key={(a) => a.id}>
                    {(a) => (
                      <MenuRow testID={`side-chat-new-${a().handle}`} icon="spark" label={a().name}
                        right={t.users().find((u) => u.id === a().owner_id)?.name ?? ""} onSelect={() => props.nav.chat(a().id)} />
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
            const row = () => (
              <ListRow
                testID={`side-agent-${x().handle}`}
                title={a()?.name ?? `@${x().handle}`}
                dim={!a()}
                strong={!!unread()}
                left={<Avatar name={a()?.name ?? x().handle} agent size="sm" />}
                below={
                  <If when={st()} else={<Txt variant="caption" tone="faint">{L("history only", "只能看历史")}</Txt>}>
                    {(s) => <StateMark testID={`side-agent-${x().handle}-state`} state={s().state} text={mine() ? `${runtimeLabel(a()!.runtime)} · ${s().word}` : L(`${owner()}’s · ${s().word}`, `${owner()}的 · ${s().word}`)} />}
                  </If>
                }
                right={<Count n={unread()} testID={`side-agent-${x().handle}-unread`} />}
                selected={chatActive(x().key)}
                onPress={() => props.nav.chat(x().key)}
              />
            );
            return <If when={a()} else={row()}>{(ag) => <RowMenu trigger={row()}>{menu(agentCommands(props.nav, ag()))}</RowMenu>}</If>;
          }}
        </Each>
        <If when={!myAgents().length}>
          <ListRow testID="side-agent-new" title={L("Create your first agent", "新建你的第一个 Agent")} dim left={<Icon name="plus" size={15} tint={colors.fg3} />} onPress={() => props.onSettings("agents")} />
        </If>
      </Scroll>
      {/* phones: me and settings are the Me tab */}
      <If when={props.inset} else={<UpdateRow />}>
        <View testID="side-footer" style={{ minHeight: FOOTER, justifyContent: "center", paddingHorizontal: 8, paddingVertical: 6, gap: 6, borderTopWidth: 0.5, borderTopColor: colors.hairline }}>
          <UpdateRow />
          <UserMenu team={t} onSettings={props.onSettings} onSignOut={props.onSignOut} />
        </View>
      </If>
    </View>
  );
}

/** What waits for me: the count on 待你决定 (its tab on phones). */
export const waitingCount = (t: Team) => t.inbox().length + t.signups().length + t.proposals().length + t.reminders().filter((r) => reminderUp(r, t.me()?.id)).length;

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
