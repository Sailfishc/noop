// Signing in: an invite link (name and @handle), a one-time login code or link from a signed-in device, or asking
// to join (an admin approves; this device keeps the application's token and signs in with it then).
import { cleanup, Image, Scroll, signal, Storage, Text, View, windowSize } from "nsh";
import { L } from "../i18n";
import { LOGO } from "./logo";
import { colors } from "../ui";
import { call, errorOf, type Reply, loginServer, normalizeServer, parseInvite, type Session, TEAM_KEYS } from "./api";
import { Btn, Choice, ErrorNote, Field, unreachable } from "./ui";

/** Sign in with email + the authenticator's 6 digits, or join with an invite (bind an authenticator first). */
export function SignIn(props: { url: string; email: string; notice: string; onSession: (s: Session, email: string) => void }) {
  const mode = signal<"login" | "invite" | "ask">("login");
  const url = signal(props.url);
  const code = signal("");
  const error = signal(props.notice);
  const busy = signal(false);
  // invite
  const link = signal("");
  const invite = signal<{ server: string; code: string; email: string } | null>(null);
  const name = signal("");
  const handle = signal("");

  // asking to join
  const email = signal("");
  const note = signal("");
  /** The application this device sent and waits on (kept across launches). */
  const asked = signal<{ server: string; token: string; email: string; team: string } | null>(null);
  const status = signal<"pending" | "rejected">("pending");
  void Storage.getItem(TEAM_KEYS.signup).then((v) => {
    try {
      const a = v ? JSON.parse(v) : null;
      if (a?.server && a?.token) { asked.set(a); mode.set("ask"); void check(); }
    } catch { /* a stale value: ask again */ }
  });
  const poll = setInterval(() => { if (asked() && status() === "pending") void check(); }, 10_000);
  cleanup(() => clearInterval(poll));

  async function ask() {
    const server = normalizeServer(url());
    if (!server) return error.set(L("Enter the server address", "请填写服务器地址"));
    if (busy()) return;
    busy.set(true);
    error.set("");
    const ws = await call(server, "GET", "/api/v1/workspace");
    const r = ws.ok && ws.data.signup === false
      ? ws
      : await call(server, "POST", "/api/v1/signup", "", { email: email().trim(), name: name().trim(), handle: handle().trim().toLowerCase(), note: note().trim() });
    busy.set(false);
    if (r === ws) return error.set(L("This team doesn’t take requests to join. Ask an admin for an invite link.", "这个团队没有开放申请加入，请找管理员要邀请链接"));
    if (!r.ok || typeof r.data.token !== "string") return fail(r, server, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
    const a = { server, token: r.data.token as string, email: email().trim(), team: String(ws.data?.name ?? "") };
    await Storage.setItem(TEAM_KEYS.signup, JSON.stringify(a));
    status.set("pending");
    asked.set(a);
  }

  /** Approved: sign in with the token (once). Rejected: say so. Still pending: nothing. */
  async function check() {
    const a = asked();
    if (!a) return;
    const r = await call(a.server, "GET", `/api/v1/signup/${a.token}`);
    if (r.status === 404) return forgetAsk(L("This request is gone (replaced by a newer one, or already used). Ask again or sign in.", "这个申请已经不在了（被新的申请替换，或已经用过）。请重新申请或直接登录。"));
    if (!r.ok) return;
    if (r.data.state === "rejected") return status.set("rejected");
    if (r.data.state !== "approved") return;
    const s = await call(a.server, "POST", `/api/v1/signup/${a.token}/session`);
    if (!s.ok || typeof s.data.session !== "string") return error.set(errorOf(s, L(`The server returned ${s.status}`, `服务器返回 ${s.status}`)));
    await Storage.removeItem(TEAM_KEYS.signup);
    props.onSession({ url: a.server, session: s.data.session }, a.email);
  }

  async function forgetAsk(message = "") {
    await Storage.removeItem(TEAM_KEYS.signup);
    asked.set(null);
    status.set("pending");
    error.set(message);
  }

  const fail = (r: Reply, server: string, fallback: string) =>
    error.set(r.status === 0 ? unreachable(server, r.error) : errorOf(r, fallback));

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
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text }}>Remi</Text>
            <Text style={{ fontSize: 15, lineHeight: 22, color: colors.muted, textAlign: "center" }}>
              {mode() === "login" ? L("Sign in with a login code from a device you’re already signed in on, or a login link from your admin.", "用已登录设备上生成的登录码，或管理员发给你的登录链接登录。") : mode() === "invite" ? L("Join your team with the invite link an admin sent you.", "用管理员发给你的邀请链接加入团队。") : L("Ask to join your team. An admin approves, then this device signs you in.", "申请加入团队。管理员通过后，这台设备会自动登录。")}
            </Text>
          </View>
          <View style={{ gap: 16, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <Choice
              testID="signin-mode"
              options={[{ value: "login", label: L("Sign in", "登录") }, { value: "invite", label: L("I have an invite", "我有邀请") }, { value: "ask", label: L("Ask to join", "申请加入") }]}
              value={mode()}
              onChange={(m) => { mode.set(m); error.set(""); }}
            />
            <If when={mode() === "ask"}>
              <If
                when={asked()}
                else={
                  <>
                    <Field label={L("Server address", "服务器地址")} value={url()} onChange={(v) => url.set(v)} placeholder="http://remi.corp:8080" keyboardType="url" testID="ask-url" />
                    <Field label={L("Your name", "你的名字")} value={name()} onChange={(v) => name.set(v)} placeholder={L("Wang Lei", "王磊")} testID="ask-name" />
                    <Field label={L("Your @handle", "你的 @名")} value={handle()} onChange={(v) => handle.set(v)} placeholder="wanglei" testID="ask-handle" hint={L("How people and agents mention you: 2–32 lowercase letters, digits, - or _.", "大家和 Agent 用它 @你：2 到 32 位，小写字母开头，可含数字、- 和 _")} />
                    <Field label={L("Work email", "工作邮箱")} value={email()} onChange={(v) => email.set(v)} placeholder="wanglei@corp.com" keyboardType="email-address" testID="ask-email" />
                    <Field label={L("Note for the admin (optional)", "给管理员的话（可选）")} value={note()} onChange={(v) => note.set(v)} onSubmit={ask} placeholder={L("Who you are, which team", "你是谁、哪个组的")} testID="ask-note" />
                    <Btn testID="ask-send" kind="primary" grow label={L("Ask to join", "提交申请")} busy={busy()} disabled={!url().trim() || !name().trim() || !handle().trim() || !email().trim()} onPress={ask} />
                  </>
                }
              >
                {(a) => (
                  <View testID="ask-waiting" style={{ gap: 12 }}>
                    <Text style={{ fontSize: 15, lineHeight: 22, color: colors.text }}>
                      {status() === "rejected"
                        ? L(`An admin of ${a().team || a().server} didn’t approve this request. Ask them for an invite link, or ask again.`, `${a().team || a().server} 的管理员没有通过这个申请。可以找管理员要邀请链接，或重新申请。`)
                        : L(`Request sent to ${a().team || a().server} as ${a().email}. Waiting for an admin to approve; this device signs you in as soon as they do.`, `已用 ${a().email} 向 ${a().team || a().server} 提交申请，等管理员审批。通过后这台设备会自动登录。`)}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <If when={status() === "pending"}>
                        <Btn testID="ask-check" kind="primary" label={L("Check now", "现在查看")} onPress={() => void check()} />
                      </If>
                      <Btn testID="ask-again" label={status() === "rejected" ? L("Ask again", "重新申请") : L("Withdraw and edit", "撤回重填")} onPress={() => void forgetAsk()} />
                    </View>
                  </View>
                )}
              </If>
            </If>
            <If
              when={mode() === "invite"}
              else={
                <If when={mode() === "login"}>
                  <Field label={L("Server address", "服务器地址")} value={url()} onChange={(v) => url.set(v)} placeholder="http://remi.corp:8080" keyboardType="url" testID="team-url" />
                  <Field label={L("Login code or link", "登录码或登录链接")} value={code()} onChange={(v) => code.set(v)} onSubmit={login} placeholder="ABCD-EFGH" testID="team-code" hint={L("On a signed-in device: Settings › Account › Sign in on another device.", "在已登录的设备上：设置 › 账号 › 在其他设备登录。")} />
                  <Btn testID="team-login" kind="primary" grow label={busy() ? L("Signing in…", "登录中…") : L("Sign in", "登录")} busy={busy()} disabled={!code().trim()} onPress={login} />
                </If>
              }
            >
              <If
                when={invite()}
                else={
                  <>
                    <Field label={L("Invite link", "邀请链接")} value={link()} onChange={(v) => link.set(v)} onSubmit={openInvite} placeholder="http://remi.corp:8080/invite/…" keyboardType="url" testID="invite-link" autoFocus />
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


