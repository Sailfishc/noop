// TeamAgent: several people and their agents in shared channels, against the Go server's /api/v1.
// Screens: sign in (an invite link, or a login code), the workspace (待你决定, channels, my agents; a channel with its
// thread or members beside it), and Settings, a page of its own (settings.tsx). Wide windows show the sidebar, the
// channel and a thread or the members side by side; narrow ones one pane at a time.
import { cleanup, computed, effect, Image, keymap, List, openUrl, Picker, Scroll, signal, Storage, Text, untracked, View, windowSize, type InputRef, type JSX, type ViewStyle } from "nsh";
import fs from "fs/promises";
import { filePath } from "../hub";
import { Input, Menu, MenuItem, MenuSeparator, TextView, type MarkdownExtension } from "nsh/base";
import { L, lang } from "../i18n";
import { LOGO } from "./logo";
import { alpha, colors, hovered, Icon, type IconName, radius, Spinner } from "../ui";
import {
  blockedReason, call, createTeam, dispatchFor, errorOf, type Reply, isMember, isParty, loginServer, mentionAt, normalizeServer, parseInvite, runtimeLabel, TEAM_KEYS,
  EXTERNAL_TRIES, repoLabel, type Agent, type Attachment, type Member, type Mention, type Message, type Output, type Repo, type Session, type Task, type TaskState, type Team,
} from "./api";
import { NEEDS, STATUS, statusOf, type Needs } from "./status";
import { LayoutSwitch, TaskBoard, TasksPage, trackedTasks, type TaskLayout } from "./tasks";
import { AUTONOMY, DISPATCH, SettingsPage, type SettingsTab } from "./settings";
import { agentState, authorOf, Avatar, chrome, Btn, Choice, Dot, ErrorNote, failed, Field, Header, RuntimeBadge, StateDot, Tag, time, unreachable, WIDE } from "./ui";

// ---------------------------------------------------------------- sign in

/** Sign in with email + the authenticator's 6 digits, or join with an invite (bind an authenticator first). */
function SignIn(props: { url: string; email: string; notice: string; onSession: (s: Session, email: string) => void }) {
  const mode = signal<"login" | "invite">("login");
  const url = signal(props.url);
  const code = signal("");
  const error = signal(props.notice);
  const busy = signal(false);
  // invite
  const link = signal("");
  const invite = signal<{ server: string; code: string; email: string } | null>(null);
  const name = signal("");
  const handle = signal("");

  const fail = (r: Reply, server: string, fallback: string) =>
    error.set(r.status === 0 ? unreachable(server) : errorOf(r, fallback));

  async function login() {
    const server = loginServer(code()) || normalizeServer(url());
    if (!server) return error.set(L("Enter the server address", "请填写服务器地址"));
    if (!code().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const r = await call(server, "POST", "/api/v1/login", "", { code: code().trim() });
    busy.set(false);
    if (!r.ok || typeof r.data.session !== "string") return fail(r, server, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
    props.onSession({ url: server, session: r.data.session }, String(r.data.user?.email ?? props.email));
  }

  async function openInvite() {
    const p = parseInvite(link(), url());
    if (!p) return error.set(L("Paste the invite link you were sent (…/invite/…)", "粘贴收到的邀请链接（…/invite/…）"));
    busy.set(true);
    error.set("");
    const r = await call(p.server, "GET", `/api/v1/invites/${p.code}`);
    busy.set(false);
    if (!r.ok) return fail(r, p.server, L("This invite link is invalid or expired", "邀请链接无效或已过期"));
    url.set(p.server);
    invite.set({ ...p, email: r.data.email });
    if (!handle()) handle.set(String(r.data.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, ""));
  }

  async function join() {
    const iv = invite();
    if (!iv || busy()) return;
    busy.set(true);
    error.set("");
    const r = await call(iv.server, "POST", `/api/v1/invites/${iv.code}/accept`, "", { name: name().trim(), handle: handle().trim().toLowerCase() });
    busy.set(false);
    if (!r.ok || typeof r.data.session !== "string") return fail(r, iv.server, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
    props.onSession({ url: iv.server, session: r.data.session }, iv.email);
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }} keyboardShouldPersistTaps="handled">
      <View testID="team-signin" style={{ minHeight: windowSize().height, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingVertical: 48 }}>
        <View style={{ width: "100%", maxWidth: 440, gap: 22 }}>
          <View style={{ alignItems: "center", gap: 10 }}>
            <Image testID="team-logo" src={LOGO} accessibilityLabel="" style={{ width: 72, height: 72 }} />
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text }}>TeamAgent</Text>
            <Text style={{ fontSize: 15, lineHeight: 22, color: colors.muted, textAlign: "center" }}>
              {mode() === "login" ? L("Sign in with a login code from a device you’re already signed in on, or a login link from your admin.", "用已登录设备上生成的登录码，或管理员发给你的登录链接登录。") : L("Join your team with the invite link an admin sent you.", "用管理员发给你的邀请链接加入团队。")}
            </Text>
          </View>
          <View style={{ gap: 16, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <Choice
              testID="signin-mode"
              options={[{ value: "login", label: L("Sign in", "登录") }, { value: "invite", label: L("I have an invite", "我有邀请") }]}
              value={mode()}
              onChange={(m) => { mode.set(m); error.set(""); }}
            />
            <If
              when={mode() === "invite"}
              else={
                <>
                  <Field label={L("Server address", "服务器地址")} value={url()} onChange={(v) => url.set(v)} placeholder="http://teamagent.corp:8080" keyboardType="url" testID="team-url" />
                  <Field label={L("Login code or link", "登录码或登录链接")} value={code()} onChange={(v) => code.set(v)} onSubmit={login} placeholder="ABCD-EFGH" testID="team-code" hint={L("On a signed-in device: Settings › Account › Sign in on another device.", "在已登录的设备上：设置 › 账号 › 在其他设备登录。")} />
                  <Btn testID="team-login" kind="primary" grow label={busy() ? L("Signing in…", "登录中…") : L("Sign in", "登录")} busy={busy()} disabled={!code().trim()} onPress={login} />
                </>
              }
            >
              <If
                when={invite()}
                else={
                  <>
                    <Field label={L("Invite link", "邀请链接")} value={link()} onChange={(v) => link.set(v)} onSubmit={openInvite} placeholder="http://teamagent.corp:8080/invite/…" keyboardType="url" testID="invite-link" autoFocus />
                    <Btn testID="invite-open" kind="primary" grow label={L("Continue", "继续")} busy={busy()} onPress={openInvite} />
                  </>
                }
              >
                {(iv) => (
                  <>
                    <Text style={{ fontSize: 14, color: colors.muted }}>{L(`Joining as ${iv().email}`, `以 ${iv().email} 加入`)}</Text>
                    <Field label={L("Your name", "你的名字")} value={name()} onChange={(v) => name.set(v)} placeholder={L("Wang Lei", "王磊")} testID="invite-name" autoFocus />
                    <Field label={L("Your @handle", "你的 @名")} value={handle()} onChange={(v) => handle.set(v)} onSubmit={join} placeholder="wanglei" testID="invite-handle" hint={L("How people and agents mention you: 2–32 lowercase letters, digits, - or _.", "大家和 Agent 用它 @你：2 到 32 位，小写字母开头，可含数字、- 和 _")} />
                    <Btn testID="invite-join" kind="primary" grow label={L("Join", "加入")} busy={busy()} disabled={!name().trim() || !handle().trim()} onPress={join} />
                  </>
                )}
              </If>
            </If>
            <ErrorNote text={error()} testID="signin-error" />
          </View>
        </View>
      </View>
    </Scroll>
  );
}


// ---------------------------------------------------------------- workspace

type Page = { kind: "channel"; id: string } | { kind: "new-channel" } | { kind: "inbox" } | { kind: "tasks" } | { kind: "home" };
/** What the right column shows beside a channel: a thread, or the channel's members. */
type Side = { kind: "thread"; id: string } | { kind: "members" } | null;
type SettingsOpen = { tab: SettingsTab | null; agent?: string };

function Workspace(props: { team: Team; onSignOut: () => void }) {
  const t = props.team;
  const wide = computed(() => windowSize().width >= WIDE);
  const page = signal<Page>({ kind: "home" });
  const side = signal<Side>(null);
  const settings = signal<SettingsOpen | null>(null);
  /** Narrow windows: the list shows until a page is picked. */
  const showList = signal(true);
  const thread = () => { const s = side(); return s?.kind === "thread" ? s.id : null; };

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
  keymap.bind("mod+,", () => openSettings(), { when: "always" });

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
    if (p.kind === "tasks") return <TasksPage team={t} back={!wide()} onBack={() => showList.set(true)} onOpen={(task) => open({ kind: "channel", id: task.channel_id }, task.thread_id)} />;
    if (p.kind === "inbox") return <Inbox team={t} back={!wide()} onBack={() => showList.set(true)} onOpen={(task) => open({ kind: "channel", id: task.channel_id }, task.thread_id)} />;
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
                <If when={showList() || page().kind === "home"} else={<If when={sidePane(true)} else={main()}>{(pane) => pane()}</If>}>
                  {sidebar()}
                </If>
              </View>
            }
          >
            <View style={{ width: 248, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.sidebar }}>{sidebar()}</View>
            <View style={{ flex: 1 }}>{main()}</View>
            <If when={sidePane(false)}>
              {(pane) => <View style={{ width: 380, borderLeftWidth: 1, borderLeftColor: colors.border }}>{pane()}</View>}
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
        {/* no logo or name for now: the bar stays as the window's drag area and the traffic lights' room */}
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 8, gap: 2, paddingBottom: 16 }}>
        <Row testID="open-inbox" icon="bell" label={L("Waiting for you", "待你决定")} badge={t.inbox().length} active={props.page.kind === "inbox"} onPress={() => props.onOpen({ kind: "inbox" })} />
        <Row testID="open-tasks" icon="lists" label={L("Tasks", "任务")} active={props.page.kind === "tasks"} onPress={() => props.onOpen({ kind: "tasks" })} />
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
              icon="chat"
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
      <View style={{ padding: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
        <UserMenu team={t} onSettings={props.onSettings} onSignOut={props.onSignOut} />
      </View>
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
      {sep()}
      {item("menu-sign-out", "external", L("Sign out", "退出登录"), props.onSignOut, undefined, true)}
    </Menu>
  );
}

/** @handles in a message: a custom node, shown in the accent color when it names someone. */
const MENTION: MarkdownExtension[] = [{ name: "mention", pattern: "@[a-z][a-z0-9_-]{1,31}" }];

/** A message's text as Markdown (what the formatting buttons write), its @mentions highlighted. */
function MessageText(props: { text: string; mentions: readonly Mention[] | null }) {
  const known = () => new Set((props.mentions ?? []).map((m) => `@${m.handle}`));
  return (
    <TextView
      testID="message-text"
      document={TextView.parse(props.text, { math: false, html: false }, MENTION)}
      selectable
      onLinkPress={({ url }) => { if (/^(https?|mailto):/i.test(url)) void openUrl(url).catch(() => {}); }}
      renderCustom={(n) => <Text style={known().has(n.text ?? "") ? { color: colors.accent, fontWeight: "500" } : {}}>{n.text}</Text>}
      styles={{
        root: { gap: 6, fontSize: 15, lineHeight: 22, color: colors.text },
        code: { fontFamily: "monospace", fontSize: 13.5, color: colors.text, backgroundColor: alpha(colors.text, 0.07) },
        link: { color: colors.accent },
      }}
    />
  );
}

/** A message's files: pictures in place, other files as a row to open; links come from the server when shown. */
function MessageFiles(props: { team: Team; messageId: string }) {
  const list = signal<Attachment[]>([]);
  void props.team.attachments(props.messageId).then((a) => list.set(a));
  const pictures = () => list().filter((a) => a.mime.startsWith("image/") && a.url);
  const others = () => list().filter((a) => !a.mime.startsWith("image/") || !a.url);
  return (
    <View testID={`files-${props.messageId}`} style={{ gap: 6, marginTop: 2 }}>
      <If when={pictures().length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Each of={pictures()} key={(a) => a.path}>
            {(a) => (
              <View role="link" testID="message-picture" accessibilityLabel={a().name} onPress={() => void openUrl(a().url!).catch(() => {})} style={{ borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
                <Image src={a().url!} accessibilityLabel={a().name} style={{ width: 240, height: 160, objectFit: "cover" }} />
              </View>
            )}
          </Each>
        </View>
      </If>
      <Each of={others()} key={(a) => a.path}>
        {(a) => (
          <View role="link" testID="message-file" accessibilityLabel={a().name} onPress={() => { if (a().url) void openUrl(a().url!).catch(() => {}); }} hoverStyle={hovered()} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, maxWidth: 360 }}>
            <Icon name="file" size={16} tint={colors.muted} />
            <Text style={{ flexShrink: 1, fontSize: 13.5, color: colors.text, numberOfLines: 1 }}>{a().name}</Text>
            <Text style={{ fontSize: 12, color: colors.faint }}>{fileSize(a().size)}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** A message's reactions, one chip per emoji with who put it there. */
function reactionGroups(t: Team, m: Message): { emoji: string; names: string[] }[] {
  const out: { emoji: string; names: string[] }[] = [];
  for (const r of m.reactions ?? []) {
    let g = out.find((x) => x.emoji === r.emoji);
    if (!g) out.push((g = { emoji: r.emoji, names: [] }));
    g.names.push(authorOf(t, r.author).name);
  }
  return out;
}

function MessageRow(props: { team: Team; m: Message; onThread?: () => void; noTask?: boolean }) {
  const a = () => authorOf(props.team, props.m.author);
  const agent = () => (props.m.author.kind === "agent" ? props.team.agents().find((x) => x.id === props.m.author.id) : undefined);
  return (
    <View testID={`msg-${props.m.id}`} style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
      <Avatar name={a().name} agent={a().agent} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: 14.5, fontWeight: "600", color: colors.text }}>{a().name}</Text>
          <If when={agent()}>
            {(ag) => <RuntimeBadge runtime={ag().runtime} />}
          </If>
          <Text style={{ fontSize: 12, color: colors.faint }}>{time(props.m.created)}{props.m.edited ? L(" · edited", " · 已编辑") : ""}</Text>
        </View>
        <If when={props.m.text.trim()}>
          <MessageText text={props.m.text} mentions={props.m.mentions} />
        </If>
        <If when={props.m.attachments?.length ? props.m.id : null}>
          {(id) => <MessageFiles team={props.team} messageId={id()} />}
        </If>
        <If when={reactionGroups(props.team, props.m).length ? reactionGroups(props.team, props.m) : null}>
          {(groups) => (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 2 }}>
              <Each of={groups()} key={(g) => g.emoji}>
                {(g) => (
                  <View testID={`msg-${props.m.id}-reaction`} accessibilityLabel={`${g().emoji} ${g().names.join("、")}`} style={{ height: 24, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
                    <Text style={{ fontSize: 13 }}>{g().emoji}</Text>
                    <Text style={{ fontSize: 12, color: colors.muted }}>{g().names.length > 1 ? String(g().names.length) : g().names[0]}</Text>
                  </View>
                )}
              </Each>
            </View>
          )}
        </If>
        <If when={!props.noTask}>
          <Each of={props.team.taskOfThread(props.m.id)} key={(x) => x.id}>
            {(task) => <If when={shownAsTask(task())} else={<TrackLink team={props.team} task={task()} />}><TaskCard team={props.team} task={task()} /></If>}
          </Each>
        </If>
        <If when={props.onThread}>
          <View role="button" testID={`thread-${props.m.id}`} onPress={() => props.onThread!()} hoverStyle={hovered()} style={{ alignSelf: "flex-start", height: 26, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6, marginLeft: -6, borderRadius: 6 }}>
            <Icon name="reply" size={14} tint={props.m.reply_count ? colors.accent : colors.faint} />
            <Text style={{ fontSize: 13, color: props.m.reply_count ? colors.accent : colors.faint }}>
              {props.m.reply_count ? L(`${props.m.reply_count} replies`, `${props.m.reply_count} 条回复`) : L("Reply in thread", "在线程里回复")}
            </Text>
          </View>
        </If>
      </View>
    </View>
  );
}

/** Someone the @ picker offers. */
type Candidate = { kind: "agent" | "user"; id: string; handle: string; name: string; note: string; agent?: Agent };

/** What the people and agents of a channel the composer can @, best first: its agents, then its people, then everyone else. */
function candidates(t: Team, channelId: string, query: string): Candidate[] {
  const c = t.channels().find((x) => x.id === channelId);
  const meId = t.me()?.id;
  const q = query.toLowerCase();
  const hit = (handle: string, name: string) => !q || handle.toLowerCase().startsWith(q) || name.toLowerCase().includes(q);
  const ownerName = (id: string) => t.users().find((u) => u.id === id)?.name ?? "?";
  // the channel's agents, then team-wide ones from elsewhere (an @ brings them in)
  const here = (a: Agent) => !!c && isMember(c, "agent", a.id);
  const agents = t.agents()
    .filter((a) => (here(a) || a.dispatch === "team") && hit(a.handle, a.name))
    .sort((a, b) => Number(here(b)) - Number(here(a)))
    .map((a): Candidate => ({ kind: "agent", id: a.id, handle: a.handle, name: a.name, agent: a,
      note: [L(`${ownerName(a.owner_id)}’s agent`, `${ownerName(a.owner_id)}的 Agent`), here(a) ? a.description : L("joins this channel when called", "被 @ 时会加入这个频道")].filter(Boolean).join(" · ") }));
  const people = t.users()
    .filter((u) => !u.disabled && u.id !== meId && hit(u.handle, u.name))
    .sort((a, b) => Number(!!c && isMember(c, "user", b.id)) - Number(!!c && isMember(c, "user", a.id)))
    .map((u): Candidate => ({ kind: "user", id: u.id, handle: u.handle, name: u.name, note: c && isMember(c, "user", u.id) ? "" : L("not in this channel", "不在这个频道") }));
  return [...agents, ...people].slice(0, 8);
}

function MentionPicker(props: { team: Team; items: Candidate[]; index: number; onMove: (d: number) => void; onPick: (c: Candidate) => void; onClose: () => void }) {
  const t = props.team;
  keymap.bind(
    { up: () => props.onMove(-1), down: () => props.onMove(1), tab: () => props.items[props.index] && props.onPick(props.items[props.index]), escape: props.onClose },
    { when: "always", repeat: true },
  );
  const head = (s: string) => <Text style={{ fontSize: 11.5, fontWeight: "600", color: colors.faint, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 2 }}>{s}</Text>;
  const firstUser = () => props.items.findIndex((c) => c.kind === "user");
  return (
    <View testID="mention-picker" role="menu" style={{ gap: 1, padding: 4, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, boxShadow: "0 6px 24px rgba(0,0,0,0.12)" }}>
      <If when={props.items.length} else={<Text style={{ padding: 10, fontSize: 13, color: colors.muted }}>{L("No one by that name", "没有找到")}</Text>}>
        <Each of={props.items} key={(c) => `${c.kind}:${c.id}`}>
          {(c, i) => {
            const st = () => (c().agent ? agentState(t, c().agent!) : null);
            return (
              <>
                <If when={i() === 0 && c().kind === "agent"}>{head(L("AGENTS · THIS CHANNEL", "Agent · 本频道"))}</If>
                <If when={i() === firstUser()}>{head(L("PEOPLE", "人"))}</If>
                <View
                  role="menuitem"
                  testID={`mention-${c().handle}`}
                  accessibilityState={{ selected: i() === props.index }}
                  onPress={() => props.onPick(c())}
                  hoverStyle={hovered()}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: i() === props.index ? alpha(colors.text, 0.07) : "transparent", opacity: st()?.blocked ? 0.6 : 1 }}
                >
                  <Avatar name={c().name} agent={c().kind === "agent"} size={26} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ fontSize: 14, color: colors.text, numberOfLines: 1 }}>{c().name} <Text style={{ color: colors.muted }}>@{c().handle}</Text></Text>
                    <If when={c().note}><Text style={{ fontSize: 12, color: colors.faint, numberOfLines: 1 }}>{c().note}</Text></If>
                  </View>
                  <If when={c().agent}>
                    {(a) => (
                      <>
                        <RuntimeBadge runtime={a().runtime} />
                        <StateDot tone={st()!.tone} />
                        <Text style={{ maxWidth: 160, fontSize: 12, color: st()!.blocked ? colors.danger : colors.muted, numberOfLines: 1 }}>{st()!.label}</Text>
                      </>
                    )}
                  </If>
                </View>
              </>
            );
          }}
        </Each>
      </If>
      <Text style={{ fontSize: 11.5, color: colors.faint, paddingHorizontal: 10, paddingVertical: 4 }}>{L("↑↓ to choose · Enter to insert · Esc to close", "↑↓ 选择 · 回车插入 · Esc 关闭")}</Text>
    </View>
  );
}

/** Where a message would send work: each @agent of the channel it mentions, its runtime and machine, and who must confirm. */
function dispatchLine(t: Team, channelId: string, text: string): { text: string; warn: boolean } | null {
  const c = t.channels().find((x) => x.id === channelId);
  const handles = [...new Set([...text.matchAll(/(^|[^\w@])@([a-z][a-z0-9_-]{1,31})/g)].map((m) => m[2]))];
  const parts: string[] = [];
  let warn = false;
  const en = lang() !== "zh";
  for (const h of handles) {
    const a = t.agents().find((x) => x.handle === h);
    if (!a) continue;
    const joins = !!c && !isMember(c, "agent", a.id) && a.dispatch === "team";
    if (!c || (!isMember(c, "agent", a.id) && !joins)) {
      parts.push(L(`@${h} isn’t in this channel, so it gets no task`, `@${h} 不在这个频道，不会派活`));
      warn = true;
      continue;
    }
    const m = t.machines().find((x) => x.id === a.machine_id);
    const owner = t.users().find((u) => u.id === a.owner_id);
    const how = dispatchFor(a, t.me());
    if (how === "refused") {
      parts.push(L(`@${h} only takes work from ${owner?.name ?? "its owner"}`, `@${h} 只接 ${owner?.name ?? "主人"} 派的活`));
      warn = true;
      continue;
    }
    const why = blockedReason(a, m, en);
    const head = [a.name, runtimeLabel(a.runtime) + (a.model ? ` ${a.model}` : ""), m?.name].filter(Boolean).join(" · ");
    const confirm = how === "confirm" ? L(`${owner?.name ?? "its owner"} confirms before it starts`, `开工前需要 ${owner?.name ?? "主人"} 确认`) : L("starts without confirmation", "开工无需确认");
    const join = joins ? L(", and it joins this channel", "，它会加入这个频道") : "";
    parts.push(L(`To ${head}, ${confirm}${join}`, `将派给 ${head}，${confirm}${join}`) + (why ? L(` (can’t take work now: ${why}; the task waits)`, `（现在接不了活：${why}，任务会等着）`) : ""));
    if (why) warn = true;
  }
  return parts.length ? { text: parts.join("；"), warn } : null;
}

/** The message box: @ opens a picker of the channel's agents and people; the line under it says where the work goes. */
/** A file waiting in the composer to go with the next message. */
type Draft = { id: string; name: string; type: string; size: number; file: Blob; preview?: string };

const MAX_FILES = 10, MAX_FILE = 50 * 1024 * 1024;
export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);
const guessType = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json" } as Record<string, string>)[ext] ?? "";
};

function Composer(props: { team: Team; channelId: string; testID: string; placeholder: string; hint?: string; asTask?: boolean; onSend: (text: string, files: string[], asTask: boolean) => Promise<string | null> }) {
  const t = props.team;
  const text = signal("");
  /** "As task": track what this message hands an agent as a task from the start (only top-level, only with an @agent). */
  const asTask = signal(false);
  const error = signal("");
  const busy = signal(false);
  const pick = signal(0);
  const dismissed = signal<string | null>(null); // the text the picker was closed on
  const files = signal<Draft[]>([]);
  const dropping = signal(false);
  let caret = { start: 0, end: 0 };
  let seq = 0;
  let input: InputRef | undefined;
  const mention = () => (dismissed() === text() ? null : mentionAt(text()));
  const items = computed(() => { const m = mention(); return m ? candidates(t, props.channelId, m.query) : []; });
  const open = () => !!mention();
  effect(() => { items(); pick.set(0); });
  const preview = () => dispatchLine(t, props.channelId, text());
  function setText(v: string, at: number, to = at) {
    text.set(v);
    caret = { start: at, end: to };
    input?.focus();
    input?.setSelection(at, to);
  }
  function insert(c: Candidate) {
    const m = untracked(mention);
    if (!m) return;
    const v = untracked(text).slice(0, m.start) + `@${c.handle} `;
    setText(v, v.length);
  }
  function attach(file: Blob, name: string) {
    if (untracked(files).length >= MAX_FILES) return error.set(L(`At most ${MAX_FILES} files in one message`, `一条消息最多 ${MAX_FILES} 个文件`));
    if (file.size > MAX_FILE) return error.set(L(`${name} is over 50 MB`, `${name} 超过 50 MB`));
    if (!file.size) return error.set(L(`${name} is empty`, `${name} 是空文件`));
    error.set("");
    const type = file.type || guessType(name);
    const typed = type && file.type !== type ? new Blob([file], { type }) : file;
    let previewUrl: string | undefined;
    if (type.startsWith("image/")) try { previewUrl = URL.createObjectURL(typed); } catch {}
    files.update((list) => [...list, { id: `f${++seq}`, name: name || `file-${seq}`, type, size: file.size, file: typed, preview: previewUrl }]);
  }
  function unattach(id: string) {
    const f = untracked(files).find((x) => x.id === id);
    if (f?.preview) try { URL.revokeObjectURL(f.preview); } catch {}
    files.update((list) => list.filter((x) => x.id !== id));
  }
  /** Local files (`file:` URLs from a drop or a file manager's copy). */
  async function attachUris(uris: string[]) {
    for (const u of uris) {
      const path = filePath(u);
      const name = path.split(/[\\/]/).pop() ?? "file";
      try {
        attach(new Blob([(await fs.readFile(path)) as Uint8Array<ArrayBuffer>], { type: guessType(name) }), name);
      } catch {
        error.set(L(`Can’t read ${name}`, `读不到 ${name}`));
      }
    }
  }
  async function pickFiles() {
    try {
      for (const p of await Picker.pickFiles({ multiple: true, limit: MAX_FILES })) attach(p.file, p.file.name);
    } catch {
      error.set(L("Can’t pick files on this device", "这台设备上不能选择文件"));
    }
    input?.focus();
  }
  async function send() {
    if (untracked(open)) {
      const c = untracked(items)[untracked(pick)];
      if (c) return insert(c);
      dismissed.set(untracked(text));
    }
    const v = untracked(text).trim();
    const drafts = untracked(files);
    if ((!v && !drafts.length) || untracked(busy)) return;
    busy.set(true);
    const paths: string[] = [];
    for (const f of drafts) {
      const r = await t.upload(f.file, f.name);
      if ("error" in r) {
        busy.set(false);
        return error.set(r.error);
      }
      paths.push(r.path);
    }
    const err = await props.onSend(v, paths, !!props.asTask && untracked(asTask) && !!untracked(preview));
    busy.set(false);
    error.set(err ?? "");
    if (!err) {
      text.set("");
      asTask.set(false);
      for (const f of drafts) unattach(f.id);
    }
  }
  function addAt() {
    const v = untracked(text);
    const next = v && !/\s$/.test(v) ? `${v} @` : `${v}@`;
    dismissed.set(null);
    setText(next, next.length);
  }
  const tool = (testID: string, icon: IconName | null, label: string, onPress: () => void, glyph?: string, glyphStyle?: Record<string, unknown>) => (
    <View role="button" testID={testID} accessibilityLabel={label} tooltip={<Text>{label}</Text>} onPress={onPress} hoverStyle={hovered()} style={{ width: 28, height: 28, borderRadius: 7, alignItems: "center", justifyContent: "center" }}>
      <If when={icon} else={<Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted, ...glyphStyle }}>{glyph}</Text>}>
        <Icon name={icon!} size={16} tint={colors.muted} />
      </If>
    </View>
  );
  return (
    <View
      style={{ paddingHorizontal: 12, paddingBottom: 10, paddingTop: 6, gap: 6 }}
      onFileDragEnter={() => dropping.set(true)}
      onFileDragLeave={() => dropping.set(false)}
      onFileDrop={({ uris }) => { dropping.set(false); void attachUris(uris); }}
    >
      <ErrorNote text={error()} testID={`${props.testID}-error`} />
      <If when={open()}>
        <MentionPicker team={t} items={items()} index={pick()} onMove={(d) => pick.set(Math.max(0, Math.min(untracked(items).length - 1, untracked(pick) + d)))} onPick={insert} onClose={() => dismissed.set(untracked(text))} />
      </If>
      <View style={{ borderRadius: 12, borderWidth: 1, borderColor: dropping() ? colors.accent : colors.fieldBorder, backgroundColor: colors.field }}>
        <Input
          testID={props.testID}
          ref={(r) => (input = r)}
          value={text()}
          multiline
          submitBehavior="submit"
          placeholder={props.placeholder}
          class="placeholder:text-faint"
          onChange={({ value }) => text.set(value)}
          onSelectionChange={({ start, end }) => (caret = { start, end })}
          onPaste={({ files: pasted, uris }) => {
            for (const f of pasted) attach(f, f.name);
            if (uris.length) void attachUris(uris);
          }}
          onSubmit={send}
          style={{ minHeight: 44, maxHeight: 180, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4, fontSize: 15, lineHeight: 21, color: colors.text, backgroundColor: "transparent", borderWidth: 0 }}
        />
        <If when={files().length}>
          <View testID={`${props.testID}-files`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 10, paddingBottom: 6 }}>
            <Each of={files()} key={(f) => f.id}>
              {(f) => (
                <View testID={`${props.testID}-file`} style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingLeft: 4, paddingRight: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, maxWidth: 240 }}>
                  <If when={f().preview} else={<View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}><Icon name="file" size={16} tint={colors.muted} /></View>}>
                    <Image src={f().preview!} accessibilityLabel={f().name} style={{ width: 32, height: 32, borderRadius: 5, objectFit: "cover" }} />
                  </If>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={{ fontSize: 12.5, color: colors.text, numberOfLines: 1 }}>{f().name}</Text>
                    <Text style={{ fontSize: 11, color: colors.faint }}>{fileSize(f().size)}</Text>
                  </View>
                  <View role="button" testID={`${props.testID}-unattach`} accessibilityLabel={L(`Remove ${f().name}`, `移除 ${f().name}`)} onPress={() => unattach(f().id)} hoverStyle={hovered()} style={{ width: 22, height: 22, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="close" size={12} tint={colors.faint} />
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, paddingBottom: 6 }}>
          {tool(`${props.testID}-attach`, "plus", L("Attach files (or paste or drop them)", "添加文件（也可粘贴或拖入）"), () => void pickFiles())}
          {tool(`${props.testID}-at`, null, L("Mention someone", "@ 人或 Agent"), addAt, "@")}
          <View style={{ flex: 1 }} />
          <If when={props.asTask && preview()}>
            <View role="checkbox" testID={`${props.testID}-as-task`} accessibilityState={{ checked: asTask() }} accessibilityLabel={L("As task", "作为任务")}
              onPress={() => asTask.update((v) => !v)} hoverStyle={hovered()}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 8, marginRight: 4, borderRadius: 7 }}>
              <View style={{ width: 15, height: 15, borderRadius: 4, borderWidth: asTask() ? 0 : 1.5, borderColor: colors.fieldBorder, backgroundColor: asTask() ? colors.accentFill : "transparent", alignItems: "center", justifyContent: "center" }}>
                <If when={asTask()}><Icon name="check" size={11} tint={colors.onAccent} /></If>
              </View>
              <Text style={{ fontSize: 12.5, color: colors.muted }}>{L("As task", "作为任务")}</Text>
            </View>
          </If>
          <Btn small testID={`${props.testID}-send`} kind="primary" label={L("Send", "发送")} busy={busy()} disabled={!text().trim() && !files().length} onPress={send} />
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 4 }}>
        <Text testID={`${props.testID}-preview`} style={{ flex: 1, fontSize: 12, lineHeight: 17, color: preview()?.warn ? colors.warn : colors.muted }}>
          {preview()?.text ?? props.hint ?? ""}
        </Text>
        <Text style={{ fontSize: 12, color: colors.faint }}>{L("⏎ send · ⇧⏎ new line", "⏎ 发送 · ⇧⏎ 换行")}</Text>
      </View>
    </View>
  );
}

function ChannelView(props: { team: Team; id: string; back: boolean; onBack: () => void; side: Side; onThread: (id: string) => void; onMembers: () => void }) {
  const t = props.team;
  const channel = () => t.channels().find((c) => c.id === props.id);
  const messages = () => t.top()[props.id] ?? [];
  const member = () => {
    const c = channel(), me = t.me();
    return !!c && !!me && isMember(c, "user", me.id);
  };
  const people = () => (channel()?.members ?? []).filter((m) => m.kind === "user");
  const agents = () => (channel()?.members ?? []).filter((m) => m.kind === "agent");
  const faces = () => [...people(), ...agents()].slice(0, 4);
  const joining = signal(false);
  /** Conversation | Tasks (as in Raft: the channel's tasks as a board or a list). */
  const tab = signal<"chat" | "tasks">("chat");
  const layout = signal<TaskLayout>("board");
  effect(() => { if (tab() === "tasks") void t.loadTasks(props.id); });
  const channelTasks = () => trackedTasks(t).filter((x) => x.channel_id === props.id);
  const tabItem = (v: "chat" | "tasks", label: string, count?: number) => (
    <View role="tab" testID={`channel-tab-${v}`} accessibilityState={{ selected: tab() === v }} onPress={() => tab.set(v)} hoverStyle={hovered()}
      style={{ height: 34, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, borderBottomWidth: 2, borderBottomColor: tab() === v ? colors.accent : "transparent" }}>
      <Text style={{ fontSize: 13.5, fontWeight: tab() === v ? "600" : "400", color: tab() === v ? colors.text : colors.muted }}>{label}</Text>
      <If when={count}>
        <Text style={{ fontSize: 12, color: colors.faint }}>{String(count)}</Text>
      </If>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={`# ${channel()?.name ?? ""}`}
        subtitle={[channel()?.topic, channel()?.repo ? repoLabel(channel()!.repo!) : ""].filter(Boolean).join(" · ") || undefined}
        back={props.back}
        onBack={props.onBack}
        right={
          <View
            role="button"
            testID="channel-members"
            accessibilityState={{ selected: props.side?.kind === "members" }}
            onPress={props.onMembers}
            hoverStyle={hovered()}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 32, paddingHorizontal: 8, borderRadius: 8, backgroundColor: props.side?.kind === "members" ? alpha(colors.text, 0.08) : "transparent" }}
          >
            <View style={{ flexDirection: "row" }}>
              <Each of={faces()} key={(m) => `${m.kind}:${m.id}`}>
                {(m, i) => (
                  <View style={{ marginLeft: i() ? -6 : 0, borderRadius: m().kind === "agent" ? 7 : 12, borderWidth: 2, borderColor: colors.background }}>
                    <Avatar name={authorOf(t, m()).name} agent={m().kind === "agent"} size={22} />
                  </View>
                )}
              </Each>
            </View>
            <Text testID="channel-counts" style={{ fontSize: 13, color: colors.muted }}>{L(`${people().length} people · ${agents().length} agents`, `${people().length} 人 · ${agents().length} Agent`)}</Text>
          </View>
        }
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {tabItem("chat", L("Conversation", "对话"))}
        {tabItem("tasks", L("Tasks", "任务"), channelTasks().filter((x) => !["done", "closed"].includes(x.state)).length)}
        <View style={{ flex: 1 }} />
        <If when={tab() === "tasks"}>
          <LayoutSwitch value={layout()} onChange={layout.set} />
        </If>
      </View>
      <If when={tab() === "chat"} else={<TaskBoard team={t} tasks={channelTasks()} layout={layout()} onOpen={(x) => props.onThread(x.thread_id)}
        empty={L("No tasks in this channel yet. Tick “As task” when you @ an agent, or let it claim the work.", "这个频道还没有任务。@Agent 时勾选「作为任务」，或者让它自己认领。")} />}>
        <List
          testID="messages"
          each={messages()}
          keyExtractor={(m) => m.id}
          alignment="bottom"
          maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 80 }}
          estimatedItemSize={72}
          onLoadMoreAtStart={() => t.loadOlder(props.id)}
          contentStyle={{ paddingVertical: 12 }}
          empty={<Text style={{ padding: 24, fontSize: 14.5, color: colors.muted, textAlign: "center" }}>{L("No messages yet. Say hello, or @ an agent to give it work.", "还没有消息。打个招呼，或者 @ 一个 Agent 给它派活。")}</Text>}
          style={{ flex: 1 }}
        >
          {(m) => <MessageRow team={t} m={m()} onThread={() => props.onThread(m().id)} />}
        </List>
        <If
          when={member()}
          else={
            <View style={{ padding: 14, gap: 8, alignItems: "center", borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={{ fontSize: 14, color: colors.muted }}>{L("You’re not in this channel.", "你还不在这个频道里。")}</Text>
              <Btn testID="join" kind="primary" label={L("Join channel", "加入频道")} busy={joining()} onPress={async () => { joining.set(true); await t.join(props.id); joining.set(false); }} />
            </View>
          }
        >
          <Composer
            team={t}
            channelId={props.id}
            testID="team-composer"
            placeholder={L(`Message #${channel()?.name ?? ""}, @ an agent to hand it work`, `发到 #${channel()?.name ?? ""}，@Agent 给它派活`)}
            asTask
            onSend={(text, files, asTask) => t.send(props.id, text, null, files, asTask)}
          />
        </If>
      </If>
    </View>
  );
}

/** The channel's default repository: where its tasks run when the message names none. */
function ChannelRepo(props: { team: Team; channelId: string }) {
  const t = props.team;
  const editing = signal(false);
  const channel = () => t.channels().find((c) => c.id === props.channelId);
  const repo = () => channel()?.repo ?? "";
  return (
    <View testID="channel-repo" style={{ gap: 6, paddingTop: 10 }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("DEFAULT REPOSITORY", "默认仓库")}</Text>
      <If when={!editing()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text testID="channel-repo-label" style={{ flex: 1, fontSize: 13.5, color: repo() ? colors.text : colors.muted }}>
            {repo() ? repoLabel(repo()) : L("None: tasks run where the message says, or as general tasks.", "没有：任务按消息里写的仓库做，没写就是通用任务。")}
          </Text>
          <Btn small kind="ghost" testID="channel-repo-edit" label={repo() ? L("Change", "更换") : L("Set", "设置")} onPress={() => editing.set(true)} />
        </View>
        <Text style={{ fontSize: 12, lineHeight: 17, color: colors.faint }}>{L("A repository named in the message, or used earlier in the thread, comes first.", "消息里写了仓库地址、或者线程里之前用过仓库时，以那个为准。")}</Text>
      </If>
      <If when={editing()}>
        <RepoPicker
          team={t}
          value={repo()}
          testID="channel-repo-picker"
          noneLabel={L("Clear", "清除")}
          onCancel={() => editing.set(false)}
          onPick={async (remote) => {
            const r = await t.patchChannel(props.channelId, { repo: remote });
            if (!r.ok) return failed(r);
            editing.set(false);
            return null;
          }}
        />
      </If>
    </View>
  );
}

/** The channel's people, and its agents by owner (with runtime and state); add or remove members. */
function MembersPanel(props: { team: Team; channelId: string; back?: boolean; onClose: () => void; onAgent: (handle: string) => void }) {
  const t = props.team;
  const channel = () => t.channels().find((c) => c.id === props.channelId);
  const adding = signal(false);
  const error = signal("");
  const people = () => (channel()?.members ?? []).filter((m) => m.kind === "user").map((m) => t.users().find((u) => u.id === m.id)).filter((u): u is NonNullable<typeof u> => !!u);
  const agents = () => (channel()?.members ?? []).filter((m) => m.kind === "agent").map((m) => t.agents().find((a) => a.id === m.id)).filter((a): a is Agent => !!a);
  const owners = () => [...new Set(agents().map((a) => a.owner_id))];
  const outside = () => {
    const c = channel();
    if (!c) return [];
    return [
      ...t.users().filter((u) => !u.disabled && !isMember(c, "user", u.id)).map((u) => ({ m: { kind: "user", id: u.id } as Member, name: u.name, handle: u.handle, agent: undefined as Agent | undefined })),
      ...t.agents().filter((a) => !isMember(c, "agent", a.id)).map((a) => ({ m: { kind: "agent", id: a.id } as Member, name: a.name, handle: a.handle, agent: a })),
    ];
  };
  async function add(m: Member) {
    error.set("");
    const r = await t.addMember(props.channelId, m);
    if (!r.ok) error.set(failed(r));
  }
  async function remove(m: Member) {
    error.set("");
    const r = await t.removeMember(props.channelId, m);
    if (!r.ok) error.set(failed(r));
  }
  const head = (s: string) => <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint, paddingTop: 10, paddingBottom: 2 }}>{s}</Text>;
  const removeBtn = (m: Member, handle: string) => (
    <View role="button" testID={`members-remove-${handle}`} accessibilityLabel={L(`Remove @${handle} from the channel`, `把 @${handle} 移出频道`)} onPress={() => void remove(m)} hoverStyle={hovered()} style={{ width: 26, height: 26, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
      <Icon name="close" size={12} tint={colors.faint} />
    </View>
  );
  return (
    <View testID="members" style={{ flex: 1, backgroundColor: colors.background }}>
      <Header
        title={L("Members", "成员")}
        subtitle={`# ${channel()?.name ?? ""}`}
        back={props.back}
        onBack={props.onClose}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Btn small testID="members-add" icon="plus" label={L("Add", "添加")} onPress={() => adding.update((v) => !v)} />
            <If when={!props.back}>
              <View role="button" testID="close-members" accessibilityLabel={L("Close", "关闭")} onPress={props.onClose} hoverStyle={hovered()} style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" }}>
                <Icon name="close" size={16} tint={colors.muted} />
              </View>
            </If>
          </View>
        }
      />
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 4 }}>
        <ErrorNote text={error()} testID="members-error" />
        <ChannelRepo team={t} channelId={props.channelId} />
        <If when={adding()}>
          <View style={{ gap: 2, marginTop: 10, padding: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}>
            <If when={outside().length} else={<Text style={{ padding: 8, fontSize: 13, color: colors.muted }}>{L("Everyone is already here.", "大家都在这个频道里了。")}</Text>}>
              <Each of={outside()} key={(o) => `${o.m.kind}:${o.m.id}`}>
                {(o) => (
                  <View role="button" testID={`members-add-${o().handle}`} onPress={() => void add(o().m)} hoverStyle={hovered()} style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 8, borderRadius: 8 }}>
                    <Avatar name={o().name} agent={!!o().agent} size={22} />
                    <Text style={{ flex: 1, fontSize: 14, color: colors.text, numberOfLines: 1 }}>{o().name} <Text style={{ color: colors.muted }}>@{o().handle}</Text></Text>
                    <If when={o().agent}>{(a) => <RuntimeBadge runtime={a().runtime} />}</If>
                    <Icon name="plus" size={14} tint={colors.accent} />
                  </View>
                )}
              </Each>
            </If>
          </View>
        </If>
        {head(L(`PEOPLE · ${people().length}`, `人 · ${people().length}`))}
        <Each of={people()} key={(u) => u.id}>
          {(u) => (
            <View testID={`member-${u().handle}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 38 }}>
              <Avatar name={u().name} size={28} />
              <Text style={{ flex: 1, fontSize: 14, color: colors.text, numberOfLines: 1 }}>{u().name} <Text style={{ color: colors.muted }}>@{u().handle}</Text></Text>
              <If when={u().id === t.me()?.id}><Tag label={L("you", "你")} /></If>
              <If when={u().role === "admin"}><Tag label={L("admin", "管理员")} tone="accent" /></If>
              <If when={u().id !== t.me()?.id}>{removeBtn({ kind: "user", id: u().id }, u().handle)}</If>
            </View>
          )}
        </Each>
        {head(L(`AGENTS · ${agents().length}`, `Agent · ${agents().length}`))}
        <If when={agents().length} else={<Text style={{ fontSize: 13, color: colors.faint }}>{L("No agents here yet. Add one to hand it work in this channel.", "这里还没有 Agent。加一个进来，才能在这个频道给它派活。")}</Text>}>
          <Each of={owners()}>
            {(owner) => (
              <View style={{ gap: 2 }}>
                <Text style={{ fontSize: 12, color: colors.muted, paddingTop: 4 }}>{L(`${t.users().find((u) => u.id === owner())?.name ?? "?"}’s agents`, `${t.users().find((u) => u.id === owner())?.name ?? "?"}的 Agent`)}</Text>
                <Each of={agents().filter((a) => a.owner_id === owner())} key={(a) => a.id}>
                  {(a) => {
                    const st = () => agentState(t, a());
                    const mine = () => a().owner_id === t.me()?.id;
                    return (
                      <View testID={`member-${a().handle}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}>
                        <Avatar name={a().name} agent size={28} />
                        <View role={mine() ? "button" : undefined} onPress={mine() ? () => props.onAgent(a().handle) : undefined} style={{ flex: 1, gap: 2 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <Text style={{ fontSize: 14, color: colors.text, numberOfLines: 1 }}>{a().name} <Text style={{ color: colors.muted }}>@{a().handle}</Text></Text>
                            <RuntimeBadge runtime={a().runtime} />
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                            <StateDot tone={st().tone} />
                            <Text testID={`member-${a().handle}-state`} style={{ flex: 1, fontSize: 12, color: st().blocked ? colors.danger : colors.muted, numberOfLines: 1 }}>
                              {st().blocked ? st().label : [t.machines().find((m) => m.id === a().machine_id)?.name, st().label].filter(Boolean).join(" · ")}
                            </Text>
                          </View>
                        </View>
                        {removeBtn({ kind: "agent", id: a().id }, a().handle)}
                      </View>
                    );
                  }}
                </Each>
              </View>
            )}
          </Each>
        </If>
      </Scroll>
    </View>
  );
}

const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? L(`${m} min`, `${m} 分钟`) : L(`${Math.floor(m / 60)} h ${m % 60} min`, `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`);
};

/** The facts of a thread's task at its top: who does it on what, where its code goes, what came out; and its run log. */
function TaskFacts(props: { team: Team; task: Task }) {
  const t = props.team;
  const task = () => props.task;
  const agent = () => t.agents().find((a) => a.id === task().agent_id);
  const owner = () => t.users().find((u) => u.id === agent()?.owner_id);
  const machine = () => t.machines().find((m) => m.id === agent()?.machine_id);
  const log = signal(false);
  const live = () => ["running", "queued", "pending", "needs_decision"].includes(task().state);
  const fact = (label: string, value: JSX.Element) => (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "center", minHeight: 22 }}>
      <Text style={{ width: 68, fontSize: 12.5, color: colors.faint }}>{label}</Text>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>{value}</View>
    </View>
  );
  const plain = (s: string, testID?: string) => <Text testID={testID} style={{ fontSize: 13, color: colors.text }}>{s}</Text>;
  return (
    <View testID={`task-${task().id}-facts`} style={{ gap: 6, paddingTop: 4 }}>
      <Text style={{ fontSize: 12, color: colors.faint }}>
        {`${task().id} · ${live() ? L(`running for ${minutes(Date.now() - task().created)}`, `已运行 ${minutes(Date.now() - task().created)}`) : L(`updated ${time(task().updated)}`, `更新于 ${time(task().updated)}`)}`}
      </Text>
      {fact(L("Assignee", "负责人"), plain(`@${agent()?.handle ?? "?"}${owner() ? L(` (${owner()!.name}’s agent)`, `（${owner()!.name}的 Agent）`) : ""}`))}
      {fact(L("Runs on", "运行在"), <>
        <RuntimeBadge runtime={agent()?.runtime ?? "codex"} />
        <If when={agent()?.model}>{plain(agent()?.model ?? "")}</If>
        {plain(machine()?.name ?? L("no machine", "没有机器"), `task-${task().id}-machine`)}
      </>)}
      <TaskRepo team={t} task={task()} />
      <If when={task().repo || agent()?.repo}>
        {fact(L("Branch", "分支"), plain(`${task().branch || "agent/" + task().id} → ${L("main branch", "主分支")}`))}
      </If>
      <If when={task().mandate}>
        {fact(L("Mandate", "授权"), <Text testID={`task-${task().id}-mandate`} style={{ flex: 1, flexShrink: 1, fontSize: 13, lineHeight: 19, color: colors.text }}>{mandateLine(t, task())}</Text>)}
      </If>
      <Acceptance team={t} task={task()} />
      <If when={task().state === "waiting" && task().wait}>
        {fact(L("Waiting", "等待"), <View testID={`task-${task().id}-wait`} style={{ flex: 1, gap: 2 }}>
          <Each of={waitLines(task())} key="index">{(l) => <Text style={{ fontSize: 13, lineHeight: 19, color: colors.text }}>{l()}</Text>}</Each>
          <Text style={{ fontSize: 12, color: colors.faint }}>{L("Nobody is notified while it waits.", "等待期间不打扰任何人。")}</Text>
        </View>)}
      </If>
      <If when={task().result}>
        {fact(L("Result", "结果"), <Text testID={`task-${task().id}-result`} style={{ fontSize: 13, fontWeight: "600", color: task().result === "confirmed" ? colors.up : colors.warn }}>
          {task().result === "confirmed" ? L("Result confirmed", "结果已确认") : L("Submitted, result not confirmed", "已提交，结果未确认")}
        </Text>)}
      </If>
      <If when={externalTries(task())}>
        {fact(L("Outside", "外部提交"), plain(`${externalTries(task())}/${EXTERNAL_TRIES}`, `task-${task().id}-tries`))}
      </If>
      <If when={outputsOf(task()).length} else={fact(L("Output", "产出"), plain(task().state === "done" ? L("done, nothing to show", "完成，没有产出") : L("nothing yet", "还没有产出")))}>
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Output", "产出")}</Text>
          <Each of={outputsOf(task())} key={(o) => o.id}>
            {(o) => <OutputCard team={t} task={task()} output={o()} />}
          </Each>
        </View>
      </If>
      <View role="button" testID={`task-${task().id}-runlog`} onPress={() => log.update((v) => !v)} hoverStyle={hovered()} style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 8, marginTop: 2, borderRadius: 7, backgroundColor: alpha(colors.text, 0.04) }}>
        <Icon name={log() ? "chevron-down" : "chevron"} size={12} tint={colors.muted} />
        <Text style={{ flex: 1, fontSize: 12.5, color: colors.muted, numberOfLines: 1 }}>
          {[L("Run log", "运行记录"), L(`${task().runs} run${task().runs === 1 ? "" : "s"}`, `${task().runs} 次运行`), task().step].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <If when={log()}>
        <View style={{ gap: 4, paddingHorizontal: 8 }}>
          <Text style={{ fontSize: 12.5, color: colors.muted }}>{L(`Created ${time(task().created)} · last change ${time(task().updated)}`, `创建 ${time(task().created)} · 最近变化 ${time(task().updated)}`)}</Text>
          <If when={task().step}><Text style={{ fontSize: 12.5, color: colors.muted }}>{L(`Now: ${task().step}`, `当前：${task().step}`)}</Text></If>
          <If when={task().summary}><Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.text }}>{task().summary}</Text></If>
        </View>
      </If>
    </View>
  );
}

/** Who handed the task over, under which rule, who confirmed it, and how far the agent may go. */
export function mandateLine(t: Team, task: Task): string {
  const m = task.mandate;
  if (!m) return "";
  const name = (id: string | null | undefined) => (id ? t.users().find((u) => u.id === id)?.name ?? "?" : "");
  const rule = DISPATCH.find((d) => d.value === m.rule)?.label() ?? m.rule;
  const confirmed = m.confirm ? (task.confirmed_by ? L(`confirmed by ${name(task.confirmed_by)}`, `${name(task.confirmed_by)} 已确认`) : L("waits for its owner", "等主人确认")) : "";
  const autonomy = AUTONOMY.find((a) => a.value === m.autonomy)?.label() ?? m.autonomy;
  return [
    L(`asked by ${name(m.by)}`, `${name(m.by)} 派的活`),
    L(`rule: ${rule}`, `规则：${rule}`),
    confirmed,
    m.joined ? L("joined this channel for it", "为此加入了这个频道") : "",
    L(`autonomy: ${autonomy}`, `自主程度：${autonomy}`),
    L(`may only push ${m.branch} and open a PR`, `只能推 ${m.branch} 并开 PR`),
  ].filter(Boolean).join(" · ");
}

/** Pick a repository: one the team's machines have, or an address typed in. "" = none. */
function RepoPicker(props: { team: Team; value: string; testID: string; onPick: (remote: string) => Promise<string | null>; onCancel: () => void; noneLabel: string }) {
  const known = signal<Repo[]>([]);
  const draft = signal(props.value ? `https://${props.value}` : "");
  const busy = signal(false);
  const error = signal("");
  void props.team.repos().then((r) => known.set(r));
  const shown = () => {
    const q = draft().trim().toLowerCase().replace(/^https?:\/\//, "");
    return known().filter((r) => !q || r.remote.toLowerCase().includes(q)).slice(0, 8);
  };
  async function pick(remote: string) {
    busy.set(true);
    error.set("");
    const e = await props.onPick(remote);
    busy.set(false);
    if (e) error.set(e);
  }
  return (
    <View testID={props.testID} style={{ gap: 6, padding: 8, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}>
      <Input
        testID={`${props.testID}-input`}
        value={draft()}
        autoFocus
        placeholder={L("https://github.com/owner/name, or pick one below", "https://github.com/owner/name，或从下面选")}
        class="placeholder:text-faint"
        onChange={({ value }) => draft.set(value)}
        onSubmit={() => void pick(draft().trim())}
        style={{ height: 34, paddingHorizontal: 10, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.field, fontSize: 14, color: colors.text }}
      />
      <Each of={shown()} key={(r) => r.remote}>
        {(r) => (
          <View role="button" testID={`${props.testID}-${r().name}`} onPress={() => void pick(r().remote)} hoverStyle={hovered()} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 8, borderRadius: 7 }}>
            <Icon name="code" size={13} tint={colors.muted} />
            <Text style={{ flex: 1, fontSize: 13.5, color: colors.text, numberOfLines: 1 }}>{repoLabel(r().remote)}</Text>
            <Text style={{ fontSize: 12, color: colors.faint }}>{L(`${r().machines.length} machine${r().machines.length === 1 ? "" : "s"}`, `${r().machines.length} 台机器有`)}</Text>
          </View>
        )}
      </Each>
      <If when={!known().length}>
        <Text style={{ paddingHorizontal: 4, fontSize: 12.5, color: colors.faint }}>{L("No machine has reported a repository yet; type its address. A machine without it clones it.", "还没有机器上报仓库，直接填地址即可。没有这个仓库的机器会自己克隆。")}</Text>
      </If>
      <ErrorNote text={error()} />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <If when={props.value}><Btn small kind="ghost" testID={`${props.testID}-none`} label={props.noneLabel} onPress={() => void pick("")} /></If>
        <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={props.onCancel} />
        <Btn small kind="primary" testID={`${props.testID}-save`} label={L("Save", "保存")} busy={busy()} disabled={!draft().trim()} onPress={() => void pick(draft().trim())} />
      </View>
    </View>
  );
}

/** Where the task runs: its repository (changeable until it first ran), the agent's own checkout, or none. */
function TaskRepo(props: { team: Team; task: Task }) {
  const t = props.team;
  const editing = signal(false);
  const agent = () => t.agents().find((a) => a.id === props.task.agent_id);
  const can = () => isParty(props.task, t.me(), agent()) && props.task.runs === 0 && !["done", "closed"].includes(props.task.state);
  const label = () => props.task.repo
    ? repoLabel(props.task.repo)
    : agent()?.repo ? L(`the agent’s checkout ${agent()!.repo}`, `Agent 的本地仓库 ${agent()!.repo}`) : L("none: a general task in an empty folder", "没有：通用任务，在一个空目录里做");
  return (
    <View testID={`task-${props.task.id}-repo`} style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 22 }}>
        <Text style={{ width: 68, fontSize: 12.5, color: colors.faint }}>{L("Repository", "仓库")}</Text>
        <If when={props.task.repo} else={<Text testID={`task-${props.task.id}-repo-label`} style={{ flex: 1, fontSize: 13, color: props.task.repo || agent()?.repo ? colors.text : colors.muted }}>{label()}</Text>}>
          <View role="link" style={{ flex: 1 }} onPress={() => void openUrl(`https://${props.task.repo}`)} hoverStyle={hovered()}>
            <Text testID={`task-${props.task.id}-repo-label`} style={{ fontSize: 13, color: colors.accent }}>{label()}</Text>
          </View>
        </If>
        <If when={can() && !editing()}>
          <Btn small kind="ghost" testID={`task-${props.task.id}-repo-edit`} label={L("Change", "更换")} onPress={() => editing.set(true)} />
        </If>
      </View>
      <If when={editing()}>
        <RepoPicker
          team={t}
          value={props.task.repo ?? ""}
          testID={`task-${props.task.id}-repo-picker`}
          noneLabel={L("No repository", "不用仓库")}
          onCancel={() => editing.set(false)}
          onPick={async (remote) => {
            const r = await t.setTaskRepo(props.task.id, remote);
            if (!r.ok) return failed(r);
            editing.set(false);
            return null;
          }}
        />
      </If>
    </View>
  );
}

/** What "done" means for the task: people write it (the creator or the agent's owner), the agent proposes it when none. */
function Acceptance(props: { team: Team; task: Task }) {
  const t = props.team;
  const editing = signal(false);
  const draft = signal("");
  const busy = signal(false);
  const error = signal("");
  const agent = () => t.agents().find((a) => a.id === props.task.agent_id);
  const can = () => isParty(props.task, t.me(), agent()) && !["done", "closed"].includes(props.task.state);
  const text = () => (props.task.acceptance ?? "").trim();
  async function save() {
    busy.set(true);
    error.set("");
    const r = await t.setAcceptance(props.task.id, draft().trim());
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    editing.set(false);
  }
  return (
    <View testID={`task-${props.task.id}-acceptance`} style={{ gap: 6, paddingTop: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 22 }}>
        <Text style={{ width: 68, fontSize: 12.5, color: colors.faint }}>{L("Acceptance", "验收标准")}</Text>
        <Text style={{ flex: 1, fontSize: 13, color: text() ? colors.text : colors.faint }}>{text() ? "" : L("None yet: the agent proposes some when it reports.", "还没写：Agent 交付时会给出它采用的标准。")}</Text>
        <If when={can() && !editing()}>
          <Btn small kind="ghost" testID={`task-${props.task.id}-acceptance-edit`} label={text() ? L("Edit", "修改") : L("Write", "填写")} onPress={() => { draft.set(text()); editing.set(true); }} />
        </If>
      </View>
      <If when={text() && !editing()}>
        <Text style={{ marginLeft: 78, fontSize: 13, lineHeight: 19, color: colors.text }}>{text()}</Text>
      </If>
      <If when={editing()}>
        <View style={{ gap: 6 }}>
          <Input
            testID={`task-${props.task.id}-acceptance-input`}
            value={draft()}
            multiline
            autoFocus
            placeholder={L("One per line, e.g. P99 under 200 ms; no table locks", "一行一条，比如：P99 低于 200ms；上线不锁表")}
            class="placeholder:text-faint"
            onChange={({ value }) => draft.set(value)}
            style={{ minHeight: 64, maxHeight: 160, padding: 10, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.field, fontSize: 14, lineHeight: 20, color: colors.text }}
          />
          <ErrorNote text={error()} />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => editing.set(false)} />
            <Btn small kind="primary" testID={`task-${props.task.id}-acceptance-save`} label={L("Save", "保存")} busy={busy()} onPress={save} />
          </View>
        </View>
      </If>
    </View>
  );
}

function ThreadView(props: { team: Team; rootId: string; back?: boolean; onClose: () => void }) {
  const t = props.team;
  const root = signal<Message | null>(null);
  effect(() => {
    const id = props.rootId;
    root.set(null);
    t.openThread(id).then((m) => root.set(m));
  });
  // the root as the channel has it now (its reply count moves)
  const shown = () => {
    const r = root();
    return r ? (t.top()[r.channel_id] ?? []).find((m) => m.id === r.id) ?? r : null;
  };
  const replies = () => t.threads()[props.rootId] ?? [];
  const channel = () => { const r = root(); return r ? t.channels().find((x) => x.id === r.channel_id) : undefined; };
  const member = () => {
    const c = channel(), me = t.me();
    return !!c && !!me && isMember(c, "user", me.id);
  };
  const tasks = () => t.taskOfThread(props.rootId);
  const task = () => tasks()[tasks().length - 1];
  const agentOf = (x: Task) => t.agents().find((a) => a.id === x.agent_id);
  const hint = () => {
    const x = task();
    if (!x || ["done", "closed"].includes(x.state)) return L("Replies go to the thread. @ an agent to hand it work here.", "回复发到线程里。@Agent 可以在这里给它派活。");
    const name = agentOf(x)?.name ?? "Agent";
    return L(`Goes straight to ${name}’s session for this task; no need to @ it.`, `会直接送到${name}这个任务的 Session，不用再 @。`);
  };
  return (
    <View testID="thread" style={{ flex: 1, backgroundColor: colors.background }}>
      <Header
        title={L("Thread", "线程")}
        subtitle={channel() ? `# ${channel()!.name}` : undefined}
        back={props.back}
        onBack={props.onClose}
        right={props.back ? undefined : (
          <View role="button" testID="close-thread" accessibilityLabel={L("Close thread", "关闭线程")} onPress={props.onClose} hoverStyle={hovered()} style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={16} tint={colors.muted} />
          </View>
        )}
      />
      <If when={shown()} else={<View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Spinner size={18} tint={colors.muted} /></View>}>
        {(r) => (
          <>
            <Scroll style={{ flex: 1 }} contentStyle={{ paddingVertical: 10 }}>
              <Each of={tasks().filter(shownAsTask)} key={(x) => x.id}>
                {(x) => (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
                    <TaskCard team={t} task={x()} detail />
                  </View>
                )}
              </Each>
              <MessageRow team={t} m={r()} noTask />
              <View style={{ marginHorizontal: 16, marginVertical: 6, height: 1, backgroundColor: colors.border }} />
              <Each of={replies()} key={(m) => m.id}>
                {(m) => <MessageRow team={t} m={m()} />}
              </Each>
            </Scroll>
            <If when={member()}>
              <Composer team={t} channelId={r().channel_id} testID="thread-composer" placeholder={L("Reply…", "回复…")} hint={hint()} onSend={(text, files) => t.send(r().channel_id, text, r().id, files)} />
            </If>
          </>
        )}
      </If>
    </View>
  );
}

function NewChannel(props: { team: Team; back: boolean; onBack: () => void; onCreated: (id: string) => void }) {
  const t = props.team;
  const name = signal("");
  const topic = signal("");
  const picked = signal<Member[]>([]);
  const error = signal("");
  const busy = signal(false);
  const others = () => {
    const me = t.me();
    return [
      ...t.users().filter((u) => !u.disabled && u.id !== me?.id).map((u) => ({ m: { kind: "user", id: u.id } as Member, label: `${u.name} @${u.handle}`, agent: false })),
      ...t.agents().map((a) => ({ m: { kind: "agent", id: a.id } as Member, label: `${a.name} @${a.handle}`, agent: true })),
    ];
  };
  const has = (m: Member) => picked().some((x) => x.kind === m.kind && x.id === m.id);
  async function create() {
    if (!name().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const r = await t.createChannel(name().trim(), topic().trim(), picked());
    busy.set(false);
    if (!r.ok) return error.set(r.status === 0 ? unreachable(t.url) : errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
    props.onCreated(r.data.id);
  }
  return (
    <View style={{ flex: 1 }}>
      <Header title={L("New channel", "新建频道")} back={props.back} onBack={props.onBack} />
      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 20, gap: 16, maxWidth: 560 }}>
        <Field label={L("Name", "名称")} value={name()} onChange={(v) => name.set(v)} placeholder={L("payments-backend", "支付后端")} testID="channel-name" autoFocus />
        <Field label={L("What it’s for (optional)", "做什么的（可选）")} value={topic()} onChange={(v) => topic.set(v)} testID="channel-topic" />
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{L("Members", "成员")}</Text>
        <View style={{ gap: 4 }}>
          <Each of={others()} key={(o) => `${o.m.kind}:${o.m.id}`}>
            {(o) => (
              <View
                role="button"
                testID={`pick-${o().m.id}`}
                accessibilityState={{ checked: has(o().m) }}
                onPress={() => picked.update((p) => (has(o().m) ? p.filter((x) => !(x.kind === o().m.kind && x.id === o().m.id)) : [...p, o().m]))}
                hoverStyle={hovered()}
                style={{ height: 38, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, borderRadius: 8 }}
              >
                <View style={{ width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: has(o().m) ? colors.accentFill : colors.fieldBorder, backgroundColor: has(o().m) ? colors.accentFill : "transparent", alignItems: "center", justifyContent: "center" }}>
                  <If when={has(o().m)}><Icon name="check" size={12} tint={colors.onAccent} /></If>
                </View>
                <Avatar name={o().label} agent={o().agent} size={24} />
                <Text style={{ fontSize: 14.5, color: colors.text }}>{o().label}</Text>
              </View>
            )}
          </Each>
        </View>
        <ErrorNote text={error()} testID="channel-error" />
        <Btn testID="channel-create" kind="primary" label={L("Create channel", "创建频道")} busy={busy()} disabled={!name().trim()} onPress={create} />
      </Scroll>
    </View>
  );
}

// ---------------------------------------------------------------- tasks

/** A run shows as a task card when people track it, or while it needs a person (an owner's OK, a decision, …). A
 * request the agent only answered stays a conversation: its reply is in the thread, its emoji on the message. */
export function shownAsTask(task: Task): boolean {
  return task.tracked !== false || statusOf(task.state).needs !== "";
}

/** Under a request the agent took up without tracking it: "convert to task", for its asker or the agent's owner. */
function TrackLink(props: { team: Team; task: Task }) {
  const t = props.team;
  const agent = () => t.agents().find((a) => a.id === props.task.agent_id);
  const busy = signal(false);
  return (
    <If when={isParty(props.task, t.me(), agent()) && props.task.state !== "closed"}>
      <View role="button" testID={`track-${props.task.id}`} onPress={async () => { busy.set(true); await t.act(props.task.id, "track"); busy.set(false); }} hoverStyle={hovered()}
        style={{ alignSelf: "flex-start", height: 24, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6, marginLeft: -6, borderRadius: 6, opacity: busy() ? 0.5 : 1 }}>
        <Icon name="plus" size={13} tint={colors.faint} />
        <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Convert to task", "转为任务")}</Text>
      </View>
    </If>
  );
}

const toneOf = (tone: string) => (tone === "accent" ? colors.accent : tone === "warn" ? colors.warn : tone === "danger" ? colors.danger : tone === "up" ? colors.up : colors.muted);

const HOW: Record<string, () => string> = {
  callback: () => L("woken by a callback", "等回调"),
  poll: () => L("checked now and then", "定时查询"),
  timer: () => L("looks again at a set time", "到点再看"),
};

/** What a waiting task waits for, in one short line (its card). */
export function waitShort(task: Task): string {
  const w = task.wait;
  if (!w) return "";
  const until = w.expect ? L(`expected ${time(w.expect)}`, `预计 ${time(w.expect)}`) : L(`until ${time(w.deadline)}`, `最晚 ${time(w.deadline)}`);
  return [w.what || L("an outside result", "外部结果"), until].join(" · ");
}

/** The details: how it is watched, when it gives up, the last check and its note. */
export function waitLines(task: Task): string[] {
  const w = task.wait;
  if (!w) return [];
  const lines = [
    [w.what || L("an outside result", "外部结果"), HOW[w.how]?.() ?? w.how].join(" · "),
    [w.expect ? L(`expected ${time(w.expect)}`, `预计 ${time(w.expect)}`) : "", L(`wakes the agent anyway at ${time(w.deadline)}`, `最晚 ${time(w.deadline)} 叫醒 Agent`)].filter(Boolean).join(" · "),
  ];
  if (w.how === "poll" && w.checks) lines.push(L(`checked ${w.checks}×, last ${time(w.checked ?? 0)}`, `已查 ${w.checks} 次，上次 ${time(w.checked ?? 0)}`) + (w.errors ? L(` (${w.errors} failed)`, `（${w.errors} 次没查到）`) : ""));
  if (w.note) lines.push(w.note);
  return lines;
}

/** Outside submissions so far, of the few a task may make before a person decides. */
export const externalTries = (task: Task) => outputsOf(task).filter((o) => o.kind === "external").length;

/** The task's outputs; a task from an older server has only its PR. */
function outputsOf(task: Task): Output[] {
  if (task.outputs) return task.outputs;
  const pr = task.pr;
  return pr ? [{ id: `${task.id}-pr`, kind: "pr", title: pr.title || `PR #${pr.number}`, status: pr.state, url: pr.url, note: pr.checks, updated: task.updated }] : [];
}

const TEXTISH = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|toml))/;
const sizeLabel = (n = 0) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One output: a PR, a file (preview a text or picture in place, open it in the browser), or an outside result. */
function OutputCard(props: { team: Team; task: Task; output: Output }) {
  const t = props.team;
  const o = () => props.output;
  const open = signal(false);
  const text = signal<string | null>(null);
  const picture = signal<string | null>(null);
  const error = signal("");
  const icon = (): IconName => (o().kind === "pr" ? "merge" : o().kind === "file" ? "code" : "spark");
  const statusText = () => {
    const x = o();
    if (x.kind === "pr") return prLine({ provider: "github", url: x.url ?? "", number: 0, title: x.title, state: x.status as any, checks: (x.note ?? "none") as any }).replace(/^PR #0( · )?/, "") || L("open", "进行中");
    if (x.kind === "file") return [x.version && x.version > 1 ? `v${x.version}` : "", sizeLabel(x.size)].filter(Boolean).join(" · ");
    const st = x.status === "ready" ? L("ready", "已就绪") : x.status === "failed" ? L("failed", "失败") : L("in progress", "进行中");
    return [x.service, st, x.note].filter(Boolean).join(" · ");
  };
  const tone = () => (o().status === "failed" || (o().kind === "pr" && o().note === "failure") ? colors.danger : o().status === "pending" ? colors.warn : colors.muted);
  const canPreview = () => (o().kind === "file" && (TEXTISH.test(o().mime ?? "") || (o().mime ?? "").startsWith("image/"))) || !!o().preview;
  async function toggle() {
    error.set("");
    if (open()) return open.set(false);
    open.set(true);
    const x = o();
    if (x.kind === "file" && TEXTISH.test(x.mime ?? "")) {
      const url = await t.outputLink(x.id);
      const r = url ? await fetch(url).catch(() => null) : null;
      if (!r?.ok) return error.set(L("Couldn’t load it.", "加载失败。"));
      const body = await r.text();
      text.set(body.length > 20000 ? body.slice(0, 20000) + "\n…" : body);
    } else {
      const url = await t.outputLink(x.id, x.kind === "file" ? {} : { preview: true });
      if (!url) return error.set(L("Couldn’t load it.", "加载失败。"));
      picture.set(url);
    }
  }
  async function go() {
    const x = o();
    if (x.kind !== "file") return x.url && void openUrl(x.url);
    const url = await t.outputLink(x.id);
    if (url) void openUrl(url);
    else error.set(L("Couldn’t make a link.", "没能生成链接。"));
  }
  return (
    <View testID={`output-${o().id}`} style={{ gap: 6, padding: 8, borderRadius: 9, borderWidth: 1, borderColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={icon()} size={14} tint={colors.muted} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ fontSize: 13.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>{o().title}</Text>
          <Text testID={`output-${o().id}-status`} style={{ fontSize: 12, color: tone(), numberOfLines: 1 }}>{statusText()}</Text>
        </View>
        <If when={canPreview()}>
          <Btn small kind="ghost" testID={`output-${o().id}-preview`} label={open() ? L("Hide", "收起") : L("Preview", "预览")} onPress={() => void toggle()} />
        </If>
        <If when={o().kind === "file" || o().url}>
          <Btn small kind="ghost" testID={`output-${o().id}-open`} label={o().kind === "file" ? L("Download", "下载") : L("Open", "打开")} onPress={() => void go()} />
        </If>
      </View>
      <ErrorNote text={error()} />
      <If when={open() && text() !== null}>
        <Scroll style={{ maxHeight: 320 }} contentStyle={{ padding: 8, borderRadius: 7, backgroundColor: alpha(colors.text, 0.04) }}>
          <Text testID={`output-${o().id}-text`} style={{ fontSize: 12.5, lineHeight: 18, color: colors.text, fontFamily: "Menlo" }}>{text() ?? ""}</Text>
        </Scroll>
      </If>
      <If when={open() && picture()}>
        <Image testID={`output-${o().id}-picture`} src={picture()!} accessibilityLabel={o().title} style={{ width: "100%", height: 220, objectFit: "contain", borderRadius: 7 }} />
      </If>
    </View>
  );
}

function prLine(pr: NonNullable<Task["pr"]>) {
  const state = pr.state === "merged" ? L("merged", "已合并") : pr.state === "closed" ? L("closed", "已关闭") : "";
  const checks = pr.checks === "success" ? L("checks passed", "CI 通过") : pr.checks === "failure" ? L("checks failed", "CI 失败") : pr.checks === "pending" ? L("checks running", "CI 运行中") : "";
  return [`PR #${pr.number}`, state, checks].filter(Boolean).join(" · ");
}

/** A task on its request message (and in the inbox): its state, what it does now, and what this person can do. */
/** The run's conclusion for the card in the channel: the first paragraph of the agent's summary, once it stopped. */
function conclusion(task: Task): string {
  if (!["review", "done", "blocked", "failed"].includes(task.state)) return "";
  return (task.summary ?? "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").slice(0, 300);
}

function TaskCard(props: { team: Team; task: Task; channelName?: string; onOpen?: () => void; detail?: boolean }) {
  const t = props.team;
  const task = () => props.task;
  const agent = () => t.agents().find((a) => a.id === task().agent_id);
  const owner = () => t.users().find((u) => u.id === agent()?.owner_id);
  const machine = () => t.machines().find((m) => m.id === agent()?.machine_id);
  const me = () => t.me();
  const isOwner = () => !!me() && (me()!.id === agent()?.owner_id || me()!.role === "admin");
  const party = () => isParty(task(), me(), agent());
  const busy = signal("");
  const error = signal("");
  const st = () => statusOf(task().state);
  const label = () => STATUS[st().status];
  const needs = () => (st().needs ? NEEDS[st().needs as Exclude<Needs, "">] : null);
  async function act(action: "confirm" | "decline" | "cancel" | "accept" | "decide" | "reopen", body: unknown = {}) {
    busy.set(action);
    error.set("");
    const r = await t.act(task().id, action, body);
    busy.set("");
    if (!r.ok) error.set(errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
  }
  const waiting = () => {
    const s = task().state;
    if (s === "pending" && !isOwner()) return L(`Waiting for @${owner()?.handle ?? "?"} to confirm`, `等 @${owner()?.handle ?? "?"} 确认`);
    if (s === "queued") return !machine() ? L("The agent has no machine", "这个 Agent 还没有机器") : machine()!.online ? L(`${machine()!.name} will pick it up`, `${machine()!.name} 马上认领`) : L(`${machine()!.name} is offline; it starts when it’s back`, `${machine()!.name} 离线，上线后开工`);
    if (s === "running") return task().step || L("Working…", "干活中…");
    if (s === "waiting") return waitShort(task());
    return "";
  };
  return (
    <View testID={`task-${task().id}`} style={{ marginTop: 6, gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, maxWidth: 560 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint, fontVariant: ["tabular-nums"] }}>{task().id}</Text>
        <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{task().title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <If when={task().state === "running"}>
            <Spinner size={11} tint={colors.accent} />
          </If>
          <Text testID={`task-${task().id}-state`} style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(label().tone) }}>{label().label()}</Text>
        </View>
      </View>
      <If when={needs()}>
        {(n) => (
          <View testID={`task-${task().id}-needs`} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: alpha(toneOf(n().tone), 0.12) }}>
            <StateDot tone={n().tone} />
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(n().tone) }}>{n().label()}</Text>
          </View>
        )}
      </If>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <RuntimeBadge runtime={agent()?.runtime ?? "codex"} />
        <Text style={{ flex: 1, fontSize: 12.5, color: colors.muted }}>
          {[`@${agent()?.handle ?? "?"}`, props.channelName ? `#${props.channelName}` : "", waiting()].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <If when={props.detail}>
        <TaskFacts team={t} task={task()} />
      </If>
      <If when={props.detail ? "" : conclusion(task())}>
        {(line) => <Text testID={`task-${task().id}-summary`} style={{ fontSize: 13.5, lineHeight: 20, color: colors.text, numberOfLines: 2 }}>{line()}</Text>}
      </If>
      <If when={props.detail ? null : task().pr}>
        {(pr) => (
          <View role="link" testID={`task-${task().id}-pr`} onPress={() => void openUrl(pr().url)} hoverStyle={hovered()} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2, borderRadius: 6 }}>
            <Icon name="merge" size={14} tint={pr().checks === "failure" ? colors.danger : colors.accent} />
            <Text style={{ fontSize: 13, color: pr().checks === "failure" ? colors.danger : colors.accent }}>{prLine(pr())}</Text>
          </View>
        )}
      </If>
      <If when={task().state === "needs_decision" ? task().decision : null}>
        {(d) => (
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{d().question}</Text>
            <If when={party()} else={<Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Its creator or the agent’s owner decides.", "由发起人或 Agent 的主人决定。")}</Text>}>
              <View style={{ gap: 6 }}>
                <Each of={d().options ?? []} key="index">
                  {(o, i) => (
                    <Btn
                      small
                      testID={`task-${task().id}-option-${i()}`}
                      kind={d().recommendation && o().startsWith(d().recommendation!) ? "primary" : "plain"}
                      label={o()}
                      busy={busy() === "decide"}
                      onPress={() => act("decide", { choice: o() })}
                    />
                  )}
                </Each>
              </View>
            </If>
          </View>
        )}
      </If>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <If when={task().state === "pending" && isOwner()}>
          <Btn small kind="primary" testID={`task-${task().id}-confirm`} label={L("Start it", "确认开工")} busy={busy() === "confirm"} onPress={() => act("confirm")} />
          <Btn small testID={`task-${task().id}-decline`} label={L("Decline", "不接")} busy={busy() === "decline"} onPress={() => act("decline")} />
        </If>
        <If when={task().state === "review" && party()}>
          <Btn small kind="primary" testID={`task-${task().id}-accept`} label={L("Accept", "验收通过")} busy={busy() === "accept"} onPress={() => act("accept")} />
        </If>
        <If when={party() && !["done", "closed"].includes(task().state) && !(task().state === "pending" && isOwner())}>
          <Btn small kind="ghost" testID={`task-${task().id}-cancel`} label={task().state === "running" ? L("Stop", "停止") : L("Close", "关闭")} busy={busy() === "cancel"} onPress={() => act("cancel")} />
        </If>
        <If when={party() && ["review", "needs_decision", "blocked", "failed"].includes(task().state)}>
          <If when={task().state !== "review"}>
            <Btn small kind="ghost" testID={`task-${task().id}-done`} label={L("Mark done", "标为完成")} busy={busy() === "accept"} onPress={() => act("accept")} />
          </If>
        </If>
        <If when={party() && ["done", "closed"].includes(task().state)}>
          <Btn small kind="ghost" testID={`task-${task().id}-reopen`} label={L("Reopen", "重新打开")} busy={busy() === "reopen"} onPress={() => act("reopen")} />
        </If>
        <If when={props.onOpen}>
          <Btn small kind="ghost" testID={`task-${task().id}-open`} label={L("Open thread", "打开线程")} onPress={() => props.onOpen!()} />
        </If>
      </View>
      <ErrorNote text={error()} testID={`task-${task().id}-error`} />
    </View>
  );
}

function Inbox(props: { team: Team; back: boolean; onBack: () => void; onOpen: (t: Task) => void }) {
  const t = props.team;
  const items = () => t.inbox().map((id) => t.tasks()[id]).filter(Boolean);
  const waits = () => t.waiting().map((id) => t.tasks()[id]).filter((x) => x?.state === "waiting");
  effect(() => void t.loadInbox());
  return (
    <View style={{ flex: 1 }}>
      <Header title={L("Waiting for you", "待你决定")} subtitle={L("Tasks to confirm, decisions to make, results to accept", "要你确认的活、要你做的决定、要你验收的结果")} back={props.back} onBack={props.onBack} />
      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 10, maxWidth: 640 }}>
        <If when={items().length} else={<Text testID="inbox-empty" style={{ padding: 24, fontSize: 14.5, color: colors.muted, textAlign: "center" }}>{L("Nothing waits for you.", "没有等你处理的事。")}</Text>}>
          <Each of={items()} key={(x) => x.id}>
            {(x) => <TaskCard team={t} task={x()} channelName={t.channels().find((c) => c.id === x().channel_id)?.name} onOpen={() => props.onOpen(x())} />}
          </Each>
        </If>
        <If when={waits().length}>
          <Text testID="inbox-waiting" style={{ paddingTop: 14, fontSize: 12.5, fontWeight: "600", color: colors.faint }}>
            {L("Waiting for outside results (the agent is woken, not you)", "等外部结果（到时叫醒 Agent，不打扰你）")}
          </Text>
          <Each of={waits()} key={(x) => x.id}>
            {(x) => <TaskCard team={t} task={x()} channelName={t.channels().find((c) => c.id === x().channel_id)?.name} onOpen={() => props.onOpen(x())} />}
          </Each>
        </If>
      </Scroll>
    </View>
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
