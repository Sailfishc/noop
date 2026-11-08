// TeamAgent: several people and their agents in shared channels, against the Go server's /api/v1.
// Screens: sign in (an invite, or email + authenticator code), the channel list, a channel, a thread, and
// "Agents & machines" (your machines and their tokens, your agents and how they take work, inviting people).
// Wide windows show the list, the channel and an open thread side by side; narrow ones one at a time.
import { cleanup, Clipboard, computed, effect, Image, List, openUrl, Scroll, signal, Storage, Text, untracked, View, windowSize, type JSX, type ViewStyle } from "nsh";
import { Input } from "nsh/base";
import { L, lang, LANG_KEY } from "../i18n";
import { LOGO } from "./logo";
import { alpha, colors, hovered, Icon, type IconName, radius, Spinner, tints } from "../ui";
import {
  call, createTeam, errorOf, type Reply, isMember, isParty, normalizeServer, parseInvite, TEAM_KEYS, textParts,
  type Agent, type Autonomy, type Channel, type Dispatch, type Machine, type Member, type Message, type Session, type Task, type TaskState, type Team,
} from "./api";

const WIDE = 720;
const unreachable = (url: string) => L(`Can’t reach ${url}. Check the address and your network.`, `连不上服务器 ${url}，请检查地址和网络`);

// ---------------------------------------------------------------- small pieces

function Btn(props: { label: string; onPress: () => void; kind?: "primary" | "plain" | "ghost" | "danger"; testID?: string; busy?: boolean; disabled?: boolean; icon?: IconName; grow?: boolean; small?: boolean }) {
  const kind = () => props.kind ?? "plain";
  const fg = () => (kind() === "primary" ? colors.onAccent : kind() === "danger" ? colors.danger : kind() === "ghost" ? colors.muted : colors.text);
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      onPress={() => !props.disabled && !props.busy && props.onPress()}
      hoverStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.92 } : hovered()}
      style={{
        minHeight: props.small ? 30 : 40,
        flexGrow: props.grow ? 1 : 0,
        flexShrink: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: props.small ? 10 : 14,
        borderRadius: radius.control,
        borderWidth: kind() === "plain" ? 0.5 : 0,
        borderColor: colors.fieldBorder,
        backgroundColor: kind() === "primary" ? colors.accentFill : kind() === "danger" ? tints.danger : kind() === "plain" ? colors.surface : "transparent",
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      <If when={props.busy}>
        <Spinner size={14} tint={fg()} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg()} />
      </If>
      <Text style={{ fontSize: props.small ? 13.5 : 15, fontWeight: kind() === "primary" ? "600" : "500", color: fg() }}>{props.label}</Text>
    </View>
  );
}

function Field(props: { label?: string; value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder?: string; testID?: string; hint?: string; autoFocus?: boolean; big?: boolean; keyboardType?: "email-address" | "number-pad" | "url" }) {
  return (
    <View style={{ gap: 6 }}>
      <If when={props.label}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      </If>
      <Input
        testID={props.testID}
        value={props.value}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        style={{
          height: props.big ? 52 : 40,
          paddingHorizontal: 12,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: props.big ? 24 : 15,
          color: colors.text,
          ...(props.big ? { letterSpacing: 8, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.hint}</Text>
      </If>
    </View>
  );
}

function ErrorNote(props: { text: string; testID?: string }) {
  return (
    <If when={props.text}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.control, backgroundColor: tints.danger }}>
        <Text testID={props.testID} style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{props.text}</Text>
      </View>
    </If>
  );
}

/** A row of choices, one picked. */
function Choice<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      <Each of={props.options}>
        {(o) => (
          <View
            role="button"
            testID={props.testID ? `${props.testID}-${o().value}` : undefined}
            accessibilityState={{ selected: props.value === o().value }}
            onPress={() => props.onChange(o().value)}
            hoverStyle={hovered()}
            style={{
              height: 30, paddingHorizontal: 10, justifyContent: "center", borderRadius: 8, borderWidth: 1,
              borderColor: props.value === o().value ? colors.accentFill : colors.fieldBorder,
              backgroundColor: props.value === o().value ? tints.accent : "transparent",
            }}
          >
            <Text style={{ fontSize: 13.5, color: colors.text }}>{o().label}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

function Avatar(props: { name: string; agent?: boolean; size?: number }) {
  const s = () => props.size ?? 32;
  return (
    <View style={{ width: s(), height: s(), borderRadius: props.agent ? 8 : s() / 2, alignItems: "center", justifyContent: "center", backgroundColor: props.agent ? tints.accent : alpha(colors.text, 0.08) }}>
      <Text style={{ fontSize: s() * 0.42, fontWeight: "600", color: props.agent ? colors.accent : colors.text }}>{(props.name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

function Dot(props: { on: boolean }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: props.on ? colors.up : colors.faint }} />;
}

function Panel(props: { title: string; children: JSX.Element; right?: JSX.Element; style?: ViewStyle }) {
  return (
    <View style={[{ gap: 12, padding: 18, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, props.style ?? null]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.right}
      </View>
      {props.children}
    </View>
  );
}

const time = (ms: number) => {
  const d = new Date(ms), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

// ---------------------------------------------------------------- sign in

/** Sign in with email + the authenticator's 6 digits, or join with an invite (bind an authenticator first). */
function SignIn(props: { url: string; email: string; notice: string; onSession: (s: Session, email: string) => void }) {
  const mode = signal<"login" | "invite">("login");
  const url = signal(props.url);
  const email = signal(props.email);
  const totp = signal("");
  const error = signal(props.notice);
  const busy = signal(false);
  // invite
  const link = signal("");
  const invite = signal<{ server: string; code: string; email: string } | null>(null);
  const name = signal("");
  const handle = signal("");
  const secret = signal<{ secret: string; uri: string } | null>(null);

  const fail = (r: Reply, server: string, fallback: string) =>
    error.set(r.status === 0 ? unreachable(server) : errorOf(r, fallback));

  async function login() {
    const server = normalizeServer(url());
    const t = totp().replace(/\D/g, "");
    if (!server) return error.set(L("Enter the server address", "请填写服务器地址"));
    if (!/^[^\s@]+@[^\s@]+$/.test(email().trim())) return error.set(L("Enter a valid email address", "请填写有效的邮箱地址"));
    if (t.length !== 6 || busy()) return;
    busy.set(true);
    error.set("");
    const r = await call(server, "POST", "/api/v1/login", "", { email: email().trim(), totp: t });
    busy.set(false);
    if (!r.ok || typeof r.data.session !== "string") {
      totp.set("");
      return fail(r, server, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
    }
    props.onSession({ url: server, session: r.data.session }, email().trim());
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

  async function bind() {
    const iv = invite();
    if (!iv || busy()) return;
    busy.set(true);
    error.set("");
    const r = await call(iv.server, "POST", `/api/v1/invites/${iv.code}/accept`, "", { name: name().trim(), handle: handle().trim().toLowerCase() });
    busy.set(false);
    if (!r.ok) return fail(r, iv.server, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
    secret.set({ secret: r.data.secret, uri: r.data.uri });
  }

  async function confirm() {
    const iv = invite();
    const t = totp().replace(/\D/g, "");
    if (!iv || t.length !== 6 || busy()) return;
    busy.set(true);
    error.set("");
    const r = await call(iv.server, "POST", `/api/v1/invites/${iv.code}/accept`, "", { name: name().trim(), handle: handle().trim().toLowerCase(), totp: t });
    busy.set(false);
    if (!r.ok || typeof r.data.session !== "string") {
      totp.set("");
      return fail(r, iv.server, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
    }
    props.onSession({ url: iv.server, session: r.data.session }, iv.email);
  }

  const onTotp = (v: string, done: () => void) => {
    const t = v.replace(/\D/g, "").slice(0, 6);
    totp.set(t);
    if (t.length === 6) done();
  };

  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }} keyboardShouldPersistTaps="handled">
      <View testID="team-signin" style={{ minHeight: windowSize().height, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingVertical: 48 }}>
        <View style={{ width: "100%", maxWidth: 440, gap: 22 }}>
          <View style={{ alignItems: "center", gap: 10 }}>
            <Image testID="team-logo" src={LOGO} accessibilityLabel="" style={{ width: 72, height: 72 }} />
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text }}>TeamAgent</Text>
            <Text style={{ fontSize: 15, lineHeight: 22, color: colors.muted, textAlign: "center" }}>
              {mode() === "login" ? L("Sign in with your email and the 6 digits in your authenticator app.", "用邮箱和验证器 App 上的 6 位数字登录。") : L("Join your team with the invite link an admin sent you.", "用管理员发给你的邀请链接加入团队。")}
            </Text>
          </View>
          <View style={{ gap: 16, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <Choice
              testID="signin-mode"
              options={[{ value: "login", label: L("Sign in", "登录") }, { value: "invite", label: L("I have an invite", "我有邀请") }]}
              value={mode()}
              onChange={(m) => { mode.set(m); error.set(""); totp.set(""); }}
            />
            <If
              when={mode() === "invite"}
              else={
                <>
                  <Field label={L("Server address", "服务器地址")} value={url()} onChange={(v) => url.set(v)} placeholder="http://teamagent.corp:8080" keyboardType="url" testID="team-url" />
                  <Field label={L("Email", "邮箱")} value={email()} onChange={(v) => email.set(v)} placeholder="you@corp.com" keyboardType="email-address" testID="team-email" />
                  <Field label={L("Authenticator code", "验证器上的 6 位数字")} value={totp()} onChange={(v) => onTotp(v, login)} onSubmit={login} placeholder="······" keyboardType="number-pad" big testID="team-totp" />
                  <Btn testID="team-login" kind="primary" grow label={busy() ? L("Signing in…", "登录中…") : L("Sign in", "登录")} busy={busy()} disabled={totp().length !== 6} onPress={login} />
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
                  <If
                    when={secret()}
                    else={
                      <>
                        <Text style={{ fontSize: 14, color: colors.muted }}>{L(`Joining as ${iv().email}`, `以 ${iv().email} 加入`)}</Text>
                        <Field label={L("Your name", "你的名字")} value={name()} onChange={(v) => name.set(v)} placeholder={L("Wang Lei", "王磊")} testID="invite-name" autoFocus />
                        <Field label={L("Your @handle", "你的 @名")} value={handle()} onChange={(v) => handle.set(v)} onSubmit={bind} placeholder="wanglei" testID="invite-handle" hint={L("How people and agents mention you: 2–32 lowercase letters, digits, - or _.", "大家和 Agent 用它 @你：2 到 32 位，小写字母开头，可含数字、- 和 _")} />
                        <Btn testID="invite-next" kind="primary" grow label={L("Next", "下一步")} busy={busy()} disabled={!name().trim() || !handle().trim()} onPress={bind} />
                      </>
                    }
                  >
                    {(s) => (
                      <>
                        <Text style={{ fontSize: 14.5, lineHeight: 22, color: colors.text }}>
                          {L("Add this key to your authenticator app (Google Authenticator, 1Password, …), then enter the 6 digits it shows. You’ll sign in with them from now on.", "把下面的密钥加到验证器 App（Google Authenticator、1Password 等）里，再输入它显示的 6 位数字。以后登录都用它。")}
                        </Text>
                        <View style={{ gap: 6, padding: 12, borderRadius: radius.control, backgroundColor: colors.inset }}>
                          <Text testID="invite-secret" style={{ fontSize: 17, fontFamily: "monospace", letterSpacing: 1.5, color: colors.text }}>{s().secret.replace(/(.{4})/g, "$1 ").trim()}</Text>
                          <Text style={{ fontSize: 12, color: colors.faint }}>{s().uri}</Text>
                        </View>
                        <Btn small label={L("Copy key", "复制密钥")} icon="copy" onPress={() => void Clipboard.writeText(s().secret)} />
                        <Field label={L("Authenticator code", "验证器上的 6 位数字")} value={totp()} onChange={(v) => onTotp(v, confirm)} onSubmit={confirm} placeholder="······" keyboardType="number-pad" big testID="invite-totp" />
                        <Btn testID="invite-join" kind="primary" grow label={L("Join", "加入")} busy={busy()} disabled={totp().length !== 6} onPress={confirm} />
                      </>
                    )}
                  </If>
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

type Page = { kind: "channel"; id: string } | { kind: "new-channel" } | { kind: "settings" } | { kind: "inbox" } | { kind: "home" };

function Workspace(props: { team: Team; onSignOut: () => void }) {
  const t = props.team;
  const wide = computed(() => windowSize().width >= WIDE);
  const page = signal<Page>({ kind: "home" });
  const thread = signal<string | null>(null); // the open thread's root id
  /** Narrow windows: the list shows until a page is picked. */
  const showList = signal(true);

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
    thread.set(threadId);
    showList.set(false);
  }

  const sidebar = () => (
    <Sidebar
      team={t}
      page={page()}
      onOpen={open}
      onSignOut={props.onSignOut}
    />
  );
  const main = () => {
    const p = page();
    if (p.kind === "channel") return <ChannelView team={t} id={p.id} back={!wide()} onBack={() => { t.leaveView(); showList.set(true); }} thread={thread()} onThread={(id) => thread.set(id)} />;
    if (p.kind === "new-channel") return <NewChannel team={t} back={!wide()} onBack={() => showList.set(true)} onCreated={(id) => open({ kind: "channel", id })} />;
    if (p.kind === "settings") return <Settings team={t} back={!wide()} onBack={() => showList.set(true)} />;
    if (p.kind === "inbox") return <Inbox team={t} back={!wide()} onBack={() => showList.set(true)} onOpen={(task) => open({ kind: "channel", id: task.channel_id }, task.thread_id)} />;
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <If when={t.loaded()} else={<Spinner size={20} tint={colors.muted} />}>
          <Text style={{ fontSize: 15, color: colors.muted, textAlign: "center" }}>{L("Pick a channel, or create one.", "选一个频道，或者新建一个。")}</Text>
        </If>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}>
      <If
        when={wide()}
        else={
          <If when={showList() || page().kind === "home"} else={
            <If when={thread() && page().kind === "channel" ? thread() : null} else={main()}>
              {(id) => <ThreadView team={t} rootId={id()} back onClose={() => thread.set(null)} />}
            </If>
          }>
            {sidebar()}
          </If>
        }
      >
        <View style={{ width: 248, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.sidebar }}>{sidebar()}</View>
        <View style={{ flex: 1 }}>{main()}</View>
        <If when={thread() && page().kind === "channel"}>
          <View style={{ width: 380, borderLeftWidth: 1, borderLeftColor: colors.border }}>
            <ThreadView team={t} rootId={thread()!} onClose={() => thread.set(null)} />
          </View>
        </If>
      </If>
    </View>
  );
}

function Sidebar(props: { team: Team; page: Page; onOpen: (p: Page) => void; onSignOut: () => void }) {
  const t = props.team;
  const mine = computed(() => {
    const me = t.me();
    return t.channels().filter((c) => !c.archived).map((c) => ({ c, member: !!me && isMember(c, "user", me.id) }));
  });
  const Row = (p: { id: string; testID: string; icon: IconName; label: string; active: boolean; badge?: number; dim?: boolean; onPress: () => void }) => (
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
  return (
    <View style={{ flex: 1, paddingTop: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingBottom: 12 }}>
        <Avatar name={t.me()?.name ?? "?"} size={30} />
        <View style={{ flex: 1 }}>
          <Text testID="me-name" style={{ fontSize: 15, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{t.me()?.name ?? ""}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Dot on={t.conn() === "live"} />
            <Text testID="conn" style={{ fontSize: 12, color: colors.muted }}>{t.conn() === "live" ? L("Live", "实时") : t.conn() === "offline" ? L("Offline, retrying", "离线，正在重连") : L("Connecting…", "连接中…")}</Text>
          </View>
        </View>
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 8, gap: 2, paddingBottom: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 }}>
          <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("CHANNELS", "频道")}</Text>
          <View role="button" testID="new-channel" accessibilityLabel={L("New channel", "新建频道")} onPress={() => props.onOpen({ kind: "new-channel" })} hoverStyle={hovered()} style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
            <Icon name="plus" size={15} tint={colors.muted} />
          </View>
        </View>
        <Each of={mine()} key={(x) => x.c.id}>
          {(x) => (
            <Row
              id={x().c.id}
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
        <View style={{ height: 14 }} />
        <Row id="inbox" testID="open-inbox" icon="bell" label={L("Waiting for you", "待你决定")} badge={t.inbox().length} active={props.page.kind === "inbox"} onPress={() => props.onOpen({ kind: "inbox" })} />
        <Row id="settings" testID="open-settings" icon="settings" label={L("Agents & machines", "Agent 与机器")} active={props.page.kind === "settings"} onPress={() => props.onOpen({ kind: "settings" })} />
        <Row id="lang" testID="toggle-lang" icon="globe" label={lang() === "zh" ? "English" : "中文"} active={false} onPress={() => { const next = lang() === "zh" ? "en" : "zh"; lang.set(next); void Storage.setItem(LANG_KEY, next); }} />
        <Row id="signout" testID="sign-out" icon="external" label={L("Sign out", "退出登录")} active={false} onPress={props.onSignOut} />
      </Scroll>
    </View>
  );
}

function Header(props: { title: string; subtitle?: string; back?: boolean; onBack?: () => void; right?: JSX.Element; backLabel?: string }) {
  return (
    <View style={{ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <If when={props.back}>
        <View role="button" testID="back" accessibilityLabel={props.backLabel ?? L("Back", "返回")} onPress={() => props.onBack?.()} hoverStyle={hovered()} style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" }}>
          <Icon name="back" size={18} tint={colors.text} />
        </View>
      </If>
      <View style={{ flex: 1, paddingVertical: 8 }}>
        <Text style={{ fontSize: 16.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.title}</Text>
        <If when={props.subtitle}>
          <Text style={{ fontSize: 13, color: colors.muted, numberOfLines: 1 }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.right}
    </View>
  );
}

/** Who wrote it, as people read it. */
function authorOf(t: Team, m: { kind: "user" | "agent"; id: string }) {
  if (m.kind === "agent") {
    const a = t.agents().find((x) => x.id === m.id);
    return { name: a?.name || a?.handle || L("Agent", "Agent"), handle: a?.handle ?? "", agent: true };
  }
  const u = t.users().find((x) => x.id === m.id);
  return { name: u?.name || u?.handle || "?", handle: u?.handle ?? "", agent: false };
}

function MessageRow(props: { team: Team; m: Message; onThread?: () => void }) {
  const a = () => authorOf(props.team, props.m.author);
  return (
    <View testID={`msg-${props.m.id}`} style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
      <Avatar name={a().name} agent={a().agent} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: 14.5, fontWeight: "600", color: colors.text }}>{a().name}</Text>
          <If when={a().agent}>
            <View style={{ paddingHorizontal: 5, height: 17, borderRadius: 4, justifyContent: "center", backgroundColor: tints.accent }}>
              <Text style={{ fontSize: 10.5, fontWeight: "600", color: colors.accent }}>AGENT</Text>
            </View>
          </If>
          <Text style={{ fontSize: 12, color: colors.faint }}>{time(props.m.created)}{props.m.edited ? L(" · edited", " · 已编辑") : ""}</Text>
        </View>
        <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text }}>
          <Each of={textParts(props.m.text, props.m.mentions)} key="index">
            {(p) => (p().mention ? <Text style={{ color: colors.accent, fontWeight: "500" }}>{p().text}</Text> : <Text>{p().text}</Text>)}
          </Each>
        </Text>
        <Each of={props.team.taskOfThread(props.m.id)} key={(x) => x.id}>
          {(task) => <TaskCard team={props.team} task={task()} />}
        </Each>
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

function Composer(props: { testID: string; placeholder: string; onSend: (text: string) => Promise<string | null>; disabled?: boolean }) {
  const text = signal("");
  const error = signal("");
  const busy = signal(false);
  async function send() {
    const v = untracked(text).trim();
    if (!v || untracked(busy)) return;
    busy.set(true);
    const err = await props.onSend(v);
    busy.set(false);
    error.set(err ?? "");
    if (!err) text.set("");
  }
  return (
    <View style={{ padding: 12, gap: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
      <ErrorNote text={error()} testID={`${props.testID}-error`} />
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <Input
          testID={props.testID}
          value={text()}
          multiline
          submitBehavior="submit"
          placeholder={props.placeholder}
          class="placeholder:text-faint"
          onChange={({ value }) => text.set(value)}
          onSubmit={send}
          style={{ flex: 1, minHeight: 40, maxHeight: 160, paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.field, fontSize: 15, lineHeight: 21, color: colors.text }}
        />
        <Btn testID={`${props.testID}-send`} kind="primary" label={L("Send", "发送")} busy={busy()} disabled={!text().trim()} onPress={send} />
      </View>
    </View>
  );
}

function ChannelView(props: { team: Team; id: string; back: boolean; onBack: () => void; thread: string | null; onThread: (id: string) => void }) {
  const t = props.team;
  const channel = () => t.channels().find((c) => c.id === props.id);
  const messages = () => t.top()[props.id] ?? [];
  const member = () => {
    const c = channel(), me = t.me();
    return !!c && !!me && isMember(c, "user", me.id);
  };
  const agentsIn = () => (channel()?.members ?? []).filter((m) => m.kind === "agent").map((m) => authorOf(t, m).handle).filter(Boolean);
  const subtitle = () => {
    const c = channel();
    if (!c) return "";
    const people = c.members.filter((m) => m.kind === "user").length;
    const parts = [c.topic, L(`${people} people`, `${people} 人`)];
    if (agentsIn().length) parts.push(agentsIn().map((h) => `@${h}`).join(" "));
    return parts.filter(Boolean).join(" · ");
  };
  const joining = signal(false);
  return (
    <View style={{ flex: 1 }}>
      <Header title={`# ${channel()?.name ?? ""}`} subtitle={subtitle()} back={props.back} onBack={props.onBack} />
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
        <Composer testID="team-composer" placeholder={L(`Message #${channel()?.name ?? ""}, @ an agent to hand it work`, `发到 #${channel()?.name ?? ""}，@Agent 给它派活`)} onSend={(text) => t.send(props.id, text)} />
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
  const member = () => {
    const r = root(), me = t.me();
    const c = r && t.channels().find((x) => x.id === r.channel_id);
    return !!c && !!me && isMember(c, "user", me.id);
  };
  return (
    <View testID="thread" style={{ flex: 1, backgroundColor: colors.background }}>
      <Header
        title={L("Thread", "线程")}
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
              <MessageRow team={t} m={r()} />
              <View style={{ marginHorizontal: 16, marginVertical: 6, height: 1, backgroundColor: colors.border }} />
              <Each of={replies()} key={(m) => m.id}>
                {(m) => <MessageRow team={t} m={m()} />}
              </Each>
            </Scroll>
            <If when={member()}>
              <Composer testID="thread-composer" placeholder={L("Reply…", "回复…")} onSend={(text) => t.send(r().channel_id, text, r().id)} />
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

const STATE: Record<TaskState, { label: () => string; tone: "accent" | "warn" | "danger" | "up" | "muted" }> = {
  pending: { label: () => L("Waiting for its owner", "等主人确认"), tone: "warn" },
  queued: { label: () => L("Waiting for its machine", "等机器认领"), tone: "muted" },
  running: { label: () => L("Working", "进行中"), tone: "accent" },
  needs_decision: { label: () => L("Needs a decision", "等人决定"), tone: "warn" },
  review: { label: () => L("Ready for review", "待验收"), tone: "accent" },
  blocked: { label: () => L("Blocked", "受阻"), tone: "danger" },
  failed: { label: () => L("Failed", "失败"), tone: "danger" },
  done: { label: () => L("Done", "已完成"), tone: "up" },
  closed: { label: () => L("Closed", "已关闭"), tone: "muted" },
};
const toneOf = (tone: string) => (tone === "accent" ? colors.accent : tone === "warn" ? colors.warn : tone === "danger" ? colors.danger : tone === "up" ? colors.up : colors.muted);

function prLine(pr: NonNullable<Task["pr"]>) {
  const state = pr.state === "merged" ? L("merged", "已合并") : pr.state === "closed" ? L("closed", "已关闭") : "";
  const checks = pr.checks === "success" ? L("checks passed", "CI 通过") : pr.checks === "failure" ? L("checks failed", "CI 失败") : pr.checks === "pending" ? L("checks running", "CI 运行中") : "";
  return [`PR #${pr.number}`, state, checks].filter(Boolean).join(" · ");
}

/** A task on its request message (and in the inbox): its state, what it does now, and what this person can do. */
function TaskCard(props: { team: Team; task: Task; channelName?: string; onOpen?: () => void }) {
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
  const st = () => STATE[task().state] ?? STATE.queued;
  async function act(action: "confirm" | "decline" | "cancel" | "accept" | "decide", body: unknown = {}) {
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
          <Text testID={`task-${task().id}-state`} style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(st().tone) }}>{st().label()}</Text>
        </View>
      </View>
      <Text style={{ fontSize: 12.5, color: colors.muted }}>
        {[`@${agent()?.handle ?? "?"}`, props.channelName ? `#${props.channelName}` : "", waiting()].filter(Boolean).join(" · ")}
      </Text>
      <If when={task().pr}>
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
      </Scroll>
    </View>
  );
}

// ---------------------------------------------------------------- agents & machines

const DISPATCH: { value: Dispatch; label: () => string; note: () => string }[] = [
  { value: "owner", label: () => L("Only me", "只有我"), note: () => L("Only you can hand it work.", "只有你能给它派活。") },
  { value: "confirm", label: () => L("Anyone, I confirm", "任何人，我确认"), note: () => L("Anyone can @ it; you confirm before it starts.", "谁都能 @它，开工前由你确认。") },
  { value: "open", label: () => L("Anyone", "任何人"), note: () => L("Anyone in its channels can hand it work.", "它所在频道的人都能直接派活。") },
];
const AUTONOMY: { value: Autonomy; label: () => string }[] = [
  { value: "cautious", label: () => L("Cautious", "谨慎") },
  { value: "assist", label: () => L("Assist", "协助") },
  { value: "auto", label: () => L("Autonomous", "自主") },
];

function Settings(props: { team: Team; back: boolean; onBack: () => void }) {
  const t = props.team;
  const me = () => t.me();
  const myMachines = () => t.machines().filter((m) => m.owner_id === me()?.id);
  const myAgents = () => t.agents().filter((a) => a.owner_id === me()?.id);
  return (
    <View style={{ flex: 1 }}>
      <Header title={L("Agents & machines", "Agent 与机器")} back={props.back} onBack={props.onBack} />
      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 20, gap: 18, maxWidth: 720 }}>
        <MachinesPanel team={t} machines={myMachines()} />
        <AgentsPanel team={t} agents={myAgents()} machines={myMachines()} />
        <PeoplePanel team={t} />
      </Scroll>
    </View>
  );
}

function MachinesPanel(props: { team: Team; machines: Machine[] }) {
  const t = props.team;
  const adding = signal(false);
  const name = signal("");
  const error = signal("");
  const busy = signal(false);
  const issued = signal<{ name: string; token: string } | null>(null);
  async function add() {
    if (!name().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const r = await t.createMachine(name().trim());
    busy.set(false);
    if (!r.ok) return error.set(errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
    issued.set({ name: r.data.machine.name, token: r.data.token });
    adding.set(false);
    name.set("");
  }
  const snippet = (token: string) => `[cloud]\nurl = "${t.url}"\n\n[server]\ntoken = "${token}"`;
  return (
    <Panel title={L("My machines", "我的机器")} right={<Btn small testID="machine-add" icon="plus" label={L("Add machine", "添加机器")} onPress={() => { adding.set(true); issued.set(null); }} />}>
      <If when={!props.machines.length && !adding() && !issued()}>
        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{L("A machine runs your agents (Codex) on your computer. Add one, then put its token in that computer’s config.", "机器在你的电脑上运行你的 Agent（Codex）。添加一台，再把令牌写进那台电脑的配置。")}</Text>
      </If>
      <Each of={props.machines} key={(m) => m.id}>
        {(m) => (
          <View testID={`machine-${m().id}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
            <Dot on={m().online} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14.5, fontWeight: "500", color: colors.text }}>{m().name}</Text>
              <Text style={{ fontSize: 12.5, color: colors.muted }}>
                {[m().online ? L("online", "在线") : L("offline", "离线"), m().runtimes.join(", ") || L("no runtime reported", "还没上报运行时"), L(`${m().max_sessions} at a time`, `同时 ${m().max_sessions} 个`)].join(" · ")}
              </Text>
            </View>
            <Btn small kind="ghost" testID={`machine-remove-${m().id}`} label={L("Remove", "移除")} onPress={() => t.deleteMachine(m().id)} />
          </View>
        )}
      </Each>
      <If when={adding()}>
        <Field label={L("Machine name", "机器名称")} value={name()} onChange={(v) => name.set(v)} onSubmit={add} placeholder={L("Wang Lei’s Mac", "王磊的 Mac")} testID="machine-name" autoFocus />
        <ErrorNote text={error()} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn testID="machine-create" kind="primary" label={L("Create token", "生成令牌")} busy={busy()} disabled={!name().trim()} onPress={add} />
          <Btn kind="ghost" label={L("Cancel", "取消")} onPress={() => adding.set(false)} />
        </View>
      </If>
      <If when={issued()}>
        {(i) => (
          <View style={{ gap: 8, padding: 12, borderRadius: radius.control, backgroundColor: tints.accent }}>
            <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text }}>
              {L(`Token for ${i().name}. It’s shown only once: put this in ~/.noop/data/config.local.toml on that computer, then restart its daemon (bun run daemon).`, `${i().name} 的令牌只显示这一次：把下面几行写进那台电脑的 ~/.noop/data/config.local.toml，然后重启那里的守护进程（bun run daemon）。`)}
            </Text>
            <Text testID="machine-token" style={{ fontSize: 13, lineHeight: 19, fontFamily: "monospace", color: colors.text }}>{snippet(i().token)}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn small icon="copy" label={L("Copy", "复制")} onPress={() => void Clipboard.writeText(snippet(i().token))} />
              <Btn small kind="ghost" label={L("Done", "完成")} onPress={() => issued.set(null)} />
            </View>
          </View>
        )}
      </If>
    </Panel>
  );
}

function AgentsPanel(props: { team: Team; agents: Agent[]; machines: Machine[] }) {
  const t = props.team;
  const adding = signal(false);
  const handle = signal("");
  const name = signal("");
  const machine = signal("");
  const error = signal("");
  const busy = signal(false);
  async function add() {
    if (!handle().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const mid = machine() || props.machines[0]?.id || null;
    const r = await t.createAgent({ handle: handle().trim().toLowerCase(), name: name().trim() || handle().trim(), machine_id: mid, runtime: "codex" });
    busy.set(false);
    if (!r.ok) return error.set(errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
    adding.set(false);
    handle.set("");
    name.set("");
  }
  return (
    <Panel title={L("My agents", "我的 Agent")} right={<Btn small testID="agent-add" icon="plus" label={L("New agent", "新建 Agent")} onPress={() => adding.set(true)} />}>
      <If when={!props.agents.length && !adding()}>
        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{L("An agent has an @handle people use to hand it work, and runs on one of your machines.", "Agent 有一个 @名，大家用它派活；它运行在你的某台机器上。")}</Text>
      </If>
      <Each of={props.agents} key={(a) => a.id}>
        {(a) => (
          <View testID={`agent-${a().handle}`} style={{ gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Avatar name={a().name} agent />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{a().name} <Text style={{ fontWeight: "400", color: colors.muted }}>@{a().handle}</Text></Text>
                <Text style={{ fontSize: 12.5, color: colors.muted }}>
                  {`${a().runtime} · ${props.machines.find((m) => m.id === a().machine_id)?.name ?? L("no machine", "没有机器")}`}
                </Text>
              </View>
              <Btn small kind="ghost" testID={`agent-remove-${a().handle}`} label={L("Remove", "移除")} onPress={() => t.deleteAgent(a().id)} />
            </View>
            <If when={props.machines.length > 1}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{L("Runs on", "运行在")}</Text>
              <Choice testID={`agent-machine-${a().handle}`} options={props.machines.map((m) => ({ value: m.id, label: m.name }))} value={a().machine_id ?? ""} onChange={(v) => t.patchAgent(a().id, { machine_id: v })} />
            </If>
            <AgentRepo team={t} agent={a()} />
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{L("Who can hand it work", "谁能派活")}</Text>
            <Choice testID={`agent-dispatch-${a().handle}`} options={DISPATCH.map((d) => ({ value: d.value, label: d.label() }))} value={a().dispatch} onChange={(v) => t.patchAgent(a().id, { dispatch: v })} />
            <Text style={{ fontSize: 12.5, color: colors.faint }}>{DISPATCH.find((d) => d.value === a().dispatch)?.note() ?? ""}</Text>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{L("How much it decides alone", "自主程度")}</Text>
            <Choice testID={`agent-autonomy-${a().handle}`} options={AUTONOMY.map((d) => ({ value: d.value, label: d.label() }))} value={a().autonomy} onChange={(v) => t.patchAgent(a().id, { autonomy: v })} />
          </View>
        )}
      </Each>
      <If when={adding()}>
        <Field label={L("@handle", "@名")} value={handle()} onChange={(v) => handle.set(v)} placeholder="acha" testID="agent-handle" autoFocus />
        <Field label={L("Display name", "显示名")} value={name()} onChange={(v) => name.set(v)} onSubmit={add} placeholder={L("Acha", "阿查")} testID="agent-name" />
        <If when={props.machines.length > 1}>
          <Choice options={props.machines.map((m) => ({ value: m.id, label: m.name }))} value={machine() || props.machines[0].id} onChange={(v) => machine.set(v)} />
        </If>
        <If when={!props.machines.length}>
          <Text style={{ fontSize: 13, color: colors.warn }}>{L("Add a machine first, or the agent can’t run anything yet.", "先添加一台机器，不然 Agent 还跑不了任务。")}</Text>
        </If>
        <ErrorNote text={error()} testID="agent-error" />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn testID="agent-create" kind="primary" label={L("Create agent", "创建 Agent")} busy={busy()} disabled={!handle().trim()} onPress={add} />
          <Btn kind="ghost" label={L("Cancel", "取消")} onPress={() => adding.set(false)} />
        </View>
      </If>
    </Panel>
  );
}

/** The repository its tasks run in: a checkout on its machine; each task gets a worktree of it on agent/T-xxxx. */
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
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{L("Repository on its machine", "它在机器上用的代码仓库")}</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Field value={value()} onChange={(v) => { value.set(v); saved.set(false); }} onSubmit={save} placeholder="~/work/orders" testID={`agent-repo-${props.agent.handle}`} />
        </View>
        <Btn small testID={`agent-repo-save-${props.agent.handle}`} label={saved() && !changed() ? L("Saved", "已保存") : L("Save", "保存")} busy={busy()} disabled={!changed()} onPress={save} />
      </View>
      <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("A git checkout path. Each task works in its own worktree on branch agent/T-xxxx; the machine pushes it and opens the PR. Empty: tasks get an empty folder.", "填本机上 git 仓库的路径。每个任务在自己的 worktree 里干活（分支 agent/T-xxxx），由机器推送并开 PR；留空则每个任务一个空目录。")}</Text>
    </View>
  );
}

function PeoplePanel(props: { team: Team }) {
  const t = props.team;
  const admin = () => t.me()?.role === "admin";
  const email = signal("");
  const role = signal<"member" | "admin">("member");
  const error = signal("");
  const busy = signal(false);
  const link = signal("");
  async function invite() {
    if (!email().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const r = await t.invite(email().trim(), role());
    busy.set(false);
    if (!r.ok) return error.set(errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
    link.set(`${t.url}${r.data.path}`);
    email.set("");
  }
  return (
    <Panel title={L("People", "成员")}>
      <Each of={t.users().filter((u) => !u.disabled)} key={(u) => u.id}>
        {(u) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Avatar name={u().name} size={26} />
            <Text style={{ flex: 1, fontSize: 14.5, color: colors.text }}>{u().name} <Text style={{ color: colors.muted }}>@{u().handle}</Text></Text>
            <Text style={{ fontSize: 12.5, color: colors.faint }}>{u().role === "admin" ? L("admin", "管理员") : u().email}</Text>
          </View>
        )}
      </Each>
      <If when={admin()}>
        <View style={{ gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
          <Field label={L("Invite by email", "用邮箱邀请")} value={email()} onChange={(v) => email.set(v)} onSubmit={invite} placeholder="colleague@corp.com" keyboardType="email-address" testID="invite-email" />
          <Choice testID="invite-role" options={[{ value: "member", label: L("Member", "成员") }, { value: "admin", label: L("Admin", "管理员") }]} value={role()} onChange={(v) => role.set(v)} />
          <ErrorNote text={error()} testID="invite-error" />
          <Btn testID="invite-create" kind="primary" label={L("Create invite link", "生成邀请链接")} busy={busy()} disabled={!email().trim()} onPress={invite} />
          <If when={link()}>
            <View style={{ gap: 6, padding: 12, borderRadius: radius.control, backgroundColor: tints.accent }}>
              <Text style={{ fontSize: 13.5, color: colors.text }}>{L("Send this link to them (valid for 7 days, works once):", "把这个链接发给对方（7 天内有效，只能用一次）：")}</Text>
              <Text testID="invite-url" style={{ fontSize: 13, fontFamily: "monospace", color: colors.text }}>{link()}</Text>
              <Btn small icon="copy" label={L("Copy", "复制")} onPress={() => void Clipboard.writeText(link())} />
            </View>
          </If>
        </View>
      </If>
    </Panel>
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
