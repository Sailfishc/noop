// The box people write in: @ picker, files, "as task", /remind, and the line on where the work goes.
import { computed, effect, Image, type InputRef, keymap, Picker, signal, Text, untracked, View } from "nsh";
import fs from "fs/promises";
import { L, lang } from "../i18n";
import { Avatar, Btn, colors, Dot, ErrorNote, hovered, Icon, type IconName, TextArea } from "../ui";
import { blockedReason, dispatchFor, machineNow, isMember, mentionAt, runtimeLabel, type Agent, type Team } from "./api";
import { agentState, COMPOSER_GAP, COMPOSER_TEXT, COMPOSER_TOOLBAR, RuntimeBadge, time } from "./ui";
import { naturalRemind } from "./reminders";

/** A `file:` URL as a local path ("file:///Users/a/My%20Shot.png" → "/Users/a/My Shot.png"; Windows drive paths too). */
export function filePath(uri: string): string {
  const p = decodeURIComponent(uri.replace(/^file:\/\/[^/]*/i, ""));
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
}

/** Someone the @ picker offers. */
type Candidate = { kind: "agent" | "user"; id: string; handle: string; name: string; note: string; agent?: Agent; here?: boolean };

/**
 * Whom the composer can @ in a channel: its agents, then team-wide agents from elsewhere (an @ brings them in), then
 * its people. People outside it are left out: a message reaches only the channel's members, so an @ would never get
 * to them (and a private channel's words must not).
 */
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
    .map((a): Candidate => ({ kind: "agent", id: a.id, handle: a.handle, name: a.name, agent: a, here: here(a),
      note: [L(`${ownerName(a.owner_id)}’s agent`, `${ownerName(a.owner_id)}的 Agent`), here(a) ? a.description : ""].filter(Boolean).join(" · ") }));
  const people = t.users()
    .filter((u) => !u.disabled && u.id !== meId && !!c && isMember(c, "user", u.id) && hit(u.handle, u.name))
    .map((u): Candidate => ({ kind: "user", id: u.id, handle: u.handle, name: u.name, note: "" }));
  return [...agents, ...people].slice(0, 8);
}

function MentionPicker(props: { team: Team; items: Candidate[]; index: number; onMove: (d: number) => void; onPick: (c: Candidate) => void; onClose: () => void }) {
  const t = props.team;
  keymap.bind(
    { up: () => props.onMove(-1), down: () => props.onMove(1), tab: () => props.items[props.index] && props.onPick(props.items[props.index]), escape: props.onClose },
    { when: "always", repeat: true },
  );
  const head = (s: string) => <Text style={{ fontSize: 11.5, fontWeight: "600", color: colors.fg3, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 2 }}>{s}</Text>;
  const firstUser = () => props.items.findIndex((c) => c.kind === "user");
  const firstOther = () => props.items.findIndex((c) => c.kind === "agent" && !c.here);
  return (
    <View testID="mention-picker" role="menu" style={{ gap: 1, padding: 4, borderRadius: 12, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.raised, boxShadow: "0 6px 24px rgba(0,0,0,0.12)" }}>
      <If when={props.items.length} else={<Text style={{ padding: 10, fontSize: 13, color: colors.fg2 }}>{L("No one by that name", "没有找到")}</Text>}>
        <Each of={props.items} key={(c) => `${c.kind}:${c.id}`}>
          {(c, i) => {
            const st = () => (c().agent ? agentState(t, c().agent!) : null);
            return (
              <>
                <If when={i() === 0 && c().kind === "agent" && c().here}>{head(L("AGENTS · THIS CHANNEL", "Agent · 本频道"))}</If>
                <If when={i() === firstOther()}>{head(L("OTHER AGENTS · JOIN WHEN CALLED", "其他 Agent · 被 @ 时加入"))}</If>
                <If when={i() === firstUser()}>{head(L("PEOPLE", "人"))}</If>
                <View
                  role="menuitem"
                  testID={`mention-${c().handle}`}
                  accessibilityState={{ selected: i() === props.index }}
                  onPress={() => props.onPick(c())}
                  hoverStyle={hovered()}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: i() === props.index ? colors.selected : "transparent", opacity: st()?.blocked ? 0.6 : 1 }}
                >
                  <Avatar name={c().name} agent={c().kind === "agent"} size={26} />
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ fontSize: 14, color: colors.fg, numberOfLines: 1 }}>{c().name} <Text style={{ color: colors.fg2 }}>@{c().handle}</Text></Text>
                    <If when={c().note}><Text style={{ fontSize: 12, color: colors.fg3, numberOfLines: 1 }}>{c().note}</Text></If>
                  </View>
                  <If when={c().agent}>
                    {(a) => (
                      <>
                        <RuntimeBadge runtime={a().runtime} />
                        <Dot tone={st()!.tone} />
                        <Text style={{ maxWidth: 160, fontSize: 12, color: st()!.blocked ? colors.danger : colors.fg2, numberOfLines: 1 }}>{st()!.label}</Text>
                      </>
                    )}
                  </If>
                </View>
              </>
            );
          }}
        </Each>
      </If>
      <Text style={{ fontSize: 11.5, color: colors.fg3, paddingHorizontal: 10, paddingVertical: 4 }}>{L("↑↓ to choose · Enter to insert · Esc to close", "↑↓ 选择 · 回车插入 · Esc 关闭")}</Text>
    </View>
  );
}

/** Where a message would send work: each @agent of the channel it mentions, its runtime and machine, and who must confirm. */
function dispatchLine(t: Team, channelId: string, text: string, implied?: string): { text: string; warn: boolean } | null {
  const c = t.channels().find((x) => x.id === channelId);
  const handles = [...new Set([...(implied && text.trim() ? [implied] : []), ...[...text.matchAll(/(^|[^\w@])@([a-z][a-z0-9_-]{1,31})/g)].map((m) => m[2])])];
  const parts: string[] = [];
  let warn = false;
  const en = lang() !== "zh";
  for (const h of handles) {
    const a = t.agents().find((x) => x.handle === h);
    if (!a) continue;
    const inIt = h === implied || (!!c && isMember(c, "agent", a.id));
    const joins = !!c && !inIt && a.dispatch === "team";
    if (!inIt && !joins) {
      parts.push(L(`@${h} isn’t in this channel, so it gets no task`, `@${h} 不在这个频道，不会派活`));
      warn = true;
      continue;
    }
    const m = machineNow(t, a);
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

export function Composer(props: { team: Team; channelId: string; threadId?: string; testID: string; placeholder: string; asTask?: boolean;
  /** A private chat's agent: a top-level message names it without an @. */
  agent?: string;
  onSend: (text: string, files: string[], asTask: boolean) => Promise<string | null> }) {
  const t = props.team;
  const text = signal("");
  // two lines at least, then it grows with the text (a line to spare) up to about ten and scrolls
  /** "As task": track what this message hands an agent as a task from the start (only top-level, only with an @agent). */
  const asTask = signal(false);
  const error = signal("");
  const sent = signal(""); // what /remind set
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
  const preview = () => dispatchLine(t, props.channelId, text(), props.threadId ? undefined : props.agent);
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
    // "/remind WHEN …", or the same said in words ("2分钟后提醒我…") when nothing is attached
    const said = drafts.length ? null : naturalRemind(v);
    const cmd = said ? [v, said] : /^\/remind(?:\s+([\s\S]*))?$/i.exec(v);
    if (cmd) { // /remind WHEN [@who] WHAT: a reminder, not a message
      busy.set(true);
      const err = cmd[1]?.trim()
        ? await t.remind({ command: cmd[1], channel_id: props.channelId, thread_id: props.threadId ?? null })
        : L("/remind [every day|weekdays|every week|every 30m] WHEN [@who] WHAT, e.g. /remind tomorrow 9:00 send the report", "/remind [每天|工作日|每周|每 30 分钟] 时间 [@谁] 内容，例如 /remind 明天 9:00 交周报");
      busy.set(false);
      error.set(err ?? "");
      if (!err) {
        const r = untracked(t.reminders).reduce<null | { due: number; created: number }>((a, b) => (!a || b.created > a.created ? b : a), null);
        sent.set(r ? L(`Reminder set for ${time(r.due)}`, `已设好提醒：${time(r.due)}`) : "");
        text.set("");
      }
      return;
    }
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
      <If when={icon} else={<Text style={{ fontSize: 14, fontWeight: "600", color: colors.fg2, ...glyphStyle }}>{glyph}</Text>}>
        <Icon name={icon!} size={16} tint={colors.fg2} />
      </If>
    </View>
  );
  return (
    <View
      style={{ paddingHorizontal: 12, paddingBottom: COMPOSER_GAP, paddingTop: 6, gap: 6 }}
      onFileDragEnter={() => dropping.set(true)}
      onFileDragLeave={() => dropping.set(false)}
      onFileDrop={({ uris }) => { dropping.set(false); void attachUris(uris); }}
    >
      <ErrorNote text={error()} testID={`${props.testID}-error`} />
      <If when={sent() && !text()}>
        <Text testID={`${props.testID}-sent`} style={{ paddingHorizontal: 4, fontSize: 12.5, color: colors.fg2 }}>{sent()}</Text>
      </If>
      <If when={preview()}>
        {(p) => <Text testID={`${props.testID}-preview`} style={{ paddingHorizontal: 4, fontSize: 12, lineHeight: 17, color: p().warn ? colors.attention : colors.fg2 }}>{p().text}</Text>}
      </If>
      <If when={open()}>
        <MentionPicker team={t} items={items()} index={pick()} onMove={(d) => pick.set(Math.max(0, Math.min(untracked(items).length - 1, untracked(pick) + d)))} onPick={insert} onClose={() => dismissed.set(untracked(text))} />
      </If>
      <View testID={`${props.testID}-box`} style={{ borderRadius: 12, borderWidth: 1, borderColor: dropping() ? colors.fg : colors.edge, backgroundColor: colors.field }}>
        <TextArea
          bare
          testID={props.testID}
          ref={(r) => (input = r)}
          value={text()}
          min={COMPOSER_TEXT}
          max={240}
          placeholder={props.placeholder}
          onChange={text.set}
          onSelectionChange={(c) => (caret = c)}
          onPaste={({ files: pasted, uris }) => {
            for (const f of pasted) attach(f, f.name);
            if (uris.length) void attachUris(uris);
          }}
          onSubmit={send}
        />
        <If when={files().length}>
          <View testID={`${props.testID}-files`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 10, paddingBottom: 6 }}>
            <Each of={files()} key={(f) => f.id}>
              {(f) => (
                <View testID={`${props.testID}-file`} style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingLeft: 4, paddingRight: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.raised, maxWidth: 240 }}>
                  <If when={f().preview} else={<View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}><Icon name="file" size={16} tint={colors.fg2} /></View>}>
                    <Image src={f().preview!} accessibilityLabel={f().name} style={{ width: 32, height: 32, borderRadius: 5, objectFit: "cover" }} />
                  </If>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={{ fontSize: 12.5, color: colors.fg, numberOfLines: 1 }}>{f().name}</Text>
                    <Text style={{ fontSize: 11, color: colors.fg3 }}>{fileSize(f().size)}</Text>
                  </View>
                  <View role="button" testID={`${props.testID}-unattach`} accessibilityLabel={L(`Remove ${f().name}`, `移除 ${f().name}`)} onPress={() => unattach(f().id)} hoverStyle={hovered()} style={{ width: 22, height: 22, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="close" size={12} tint={colors.fg3} />
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height: COMPOSER_TOOLBAR, paddingHorizontal: 6, paddingBottom: 6 }}>
          {tool(`${props.testID}-attach`, "plus", L("Attach files (or paste or drop them)", "添加文件（也可粘贴或拖入）"), () => void pickFiles())}
          {tool(`${props.testID}-at`, null, L("Mention someone", "@ 人或 Agent"), addAt, "@")}
          <View style={{ flex: 1 }} />
          <If when={props.asTask && preview()}>
            <View role="checkbox" testID={`${props.testID}-as-task`} accessibilityState={{ checked: asTask() }} accessibilityLabel={L("As task", "作为任务")}
              onPress={() => asTask.update((v) => !v)} hoverStyle={hovered()}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 8, marginRight: 4, borderRadius: 7 }}>
              <View style={{ width: 15, height: 15, borderRadius: 4, borderWidth: asTask() ? 0 : 1.5, borderColor: colors.edge, backgroundColor: asTask() ? colors.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                <If when={asTask()}><Icon name="check" size={11} tint={colors.onPrimary} /></If>
              </View>
              <Text style={{ fontSize: 12.5, color: colors.fg2 }}>{L("As task", "作为任务")}</Text>
            </View>
          </If>
          <Btn small testID={`${props.testID}-send`} kind="primary" label={L("Send", "发送")} busy={busy()} disabled={!text().trim() && !files().length} onPress={send} />
        </View>
      </View>
    </View>
  );
}
