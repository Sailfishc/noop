// Signing in: an invite link (name and @handle), or a one-time login code or link from a signed-in device.
import { Image, Scroll, signal, Text, View, windowSize } from "nsh";
import { L } from "../i18n";
import { LOGO } from "./logo";
import { colors } from "../ui";
import { call, errorOf, type Reply, loginServer, normalizeServer, parseInvite, type Session } from "./api";
import { Btn, Choice, ErrorNote, Field, unreachable } from "./ui";

/** Sign in with email + the authenticator's 6 digits, or join with an invite (bind an authenticator first). */
export function SignIn(props: { url: string; email: string; notice: string; onSession: (s: Session, email: string) => void }) {
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
                  <Field label={L("Server address", "服务器地址")} value={url()} onChange={(v) => url.set(v)} placeholder="http://remi.corp:8080" keyboardType="url" testID="team-url" />
                  <Field label={L("Login code or link", "登录码或登录链接")} value={code()} onChange={(v) => code.set(v)} onSubmit={login} placeholder="ABCD-EFGH" testID="team-code" hint={L("On a signed-in device: Settings › Account › Sign in on another device.", "在已登录的设备上：设置 › 账号 › 在其他设备登录。")} />
                  <Btn testID="team-login" kind="primary" grow label={busy() ? L("Signing in…", "登录中…") : L("Sign in", "登录")} busy={busy()} disabled={!code().trim()} onPress={login} />
                </>
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


