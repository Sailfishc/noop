// A task's card: status, what it waits for, outputs, PR, and the buttons for whoever has to act.
import { Image, openUrl, Scroll, signal, Text, View } from "nsh";
import { L, lang } from "../i18n";
import { AskCard, Btn, Card, CardHead, feelDone, Link, colors, Dot, ErrorNote, Field, hovered, Icon, type IconName, Noted, Spinner, tone, type Tone, Txt } from "../ui";
import { blockedReason, errorOf, isParty, machinesOf, planSummary, taskMachine, taskRuntime, openHandoffs, openQuestions, runtimeTrouble, type Holder, type Output, type Task, type Team, type Wait } from "./api";
import { STATUS, statusOf } from "./status";
import { taskRef, waitsOn } from "./taskpeople";
import { RuntimeBadge, time } from "./ui";
import { TaskFacts } from "./taskfacts";
import { AlignCard } from "./aligncard";
import { composeInto } from "./composer";
import { EvidenceLine, EvidenceList } from "./evidence";
import { Delegates, waitingFor } from "./delegates";
import { MoveCard } from "./movecard";
import { EngineCard } from "./enginecard";
import { ReminderTag } from "./reminders";


/** A run shows as a task card when people track it, or while it needs a person (an owner's OK, a decision, …). A
 * request the agent only answered stays a conversation: its reply is in the thread, its emoji on the message. */
export function shownAsTask(task: Task): boolean {
  return task.tracked !== false || statusOf(task.state).needs !== "" || openQuestions(task).length > 0 || openHandoffs(task).length > 0;
}

/** Under a request the agent took up without tracking it: "convert to task", for its asker or the agent's owner. */
export function TrackLink(props: { team: Team; task: Task }) {
  const t = props.team;
  const agent = () => t.agents().find((a) => a.id === props.task.agent_id);
  const busy = signal(false);
  return (
    <If when={isParty(props.task, t.me(), agent()) && props.task.state !== "closed"}>
      <View role="button" testID={`track-${props.task.id}`} onPress={async () => { busy.set(true); await t.act(props.task.id, "track"); busy.set(false); }} hoverStyle={hovered()}
        style={{ alignSelf: "flex-start", height: 24, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6, marginLeft: -6, borderRadius: 6, opacity: busy() ? 0.5 : 1 }}>
        <Icon name="plus" size={13} tint={colors.fg3} />
        <Text style={{ fontSize: 12.5, color: colors.fg3 }}>{L("Convert to task", "转为任务")}</Text>
      </View>
    </If>
  );
}

const toneOf = (t: Tone) => tone(t).fg;

const HOW: Record<string, () => string> = {
  callback: () => L("woken by a callback", "等回调"),
  poll: () => L("checked now and then", "定时查询"),
  timer: () => L("looks again at a set time", "到点再看"),
  answer: () => L("woken by the answer", "等人回答"),
  quota: () => L("its runtime’s usage limit", "运行时的额度"),
};

/** A task waiting for its runtime's usage limit: when it goes on by itself. */
function quotaShort(w: Wait): string {
  if (w.expect) return L(`Waiting for quota, goes on about ${time(w.expect)}`, `等额度恢复，预计 ${time(w.expect)} 自动继续`);
  return L(`Waiting for quota, tries again ${time(w.next_at ?? 0)}`, `等额度恢复，${time(w.next_at ?? 0)} 再试`);
}

/** What a waiting task waits for, in one short line (its card). */
export function waitShort(task: Task): string {
  const w = task.wait;
  if (!w) return "";
  if (w.how === "quota") return quotaShort(w);
  if (w.how === "delegates") return L("what it delegated", "委派出去的部分");
  const until = w.expect ? L(`expected ${time(w.expect)}`, `预计 ${time(w.expect)}`) : L(`until ${time(w.deadline)}`, `最晚 ${time(w.deadline)}`);
  return [w.what || (w.how === "answer" ? L("an answer", "回答") : L("an outside result", "外部结果")), until].join(" · ");
}

/** The details: how it is watched, when it gives up, the last check and its note. */
export function waitLines(task: Task): string[] {
  const w = task.wait;
  if (!w) return [];
  if (w.how === "quota") return [quotaShort(w), ...(w.note ? [w.note] : [])];
  if (w.how === "delegates") return [L("What it delegated: woken once, when all of it is back", "委派出去的部分：全部交回时叫醒一次")];
  const lines = [
    [w.what || (w.how === "answer" ? L("an answer", "回答") : L("an outside result", "外部结果")), HOW[w.how]?.() ?? w.how].join(" · "),
    [w.expect ? L(`expected ${time(w.expect)}`, `预计 ${time(w.expect)}`) : "", L(`wakes the agent anyway at ${time(w.deadline)}`, `最晚 ${time(w.deadline)} 叫醒 Agent`)].filter(Boolean).join(" · "),
  ];
  if (w.how === "poll" && w.checks) lines.push(L(`checked ${w.checks}×, last ${time(w.checked ?? 0)}`, `已查 ${w.checks} 次，上次 ${time(w.checked ?? 0)}`) + (w.errors ? L(` (${w.errors} failed)`, `（${w.errors} 次没查到）`) : ""));
  if (w.note) lines.push(w.note);
  return lines;
}

/** Outside submissions so far, of the few a task may make before a person decides. */
export const externalTries = (task: Task) => outputsOf(task).filter((o) => o.kind === "external").length;

/** The task's outputs; a task from an older server has only its PR. */
export function outputsOf(task: Task): Output[] {
  if (task.outputs) return task.outputs;
  const pr = task.pr;
  return pr ? [{ id: `${task.id}-pr`, kind: "pr", title: pr.title || `PR #${pr.number}`, status: pr.state, url: pr.url, note: pr.checks, updated: task.updated }] : [];
}

export const TEXTISH = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|toml))/;
export const sizeLabel = (n = 0) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Compact icon + status/version summary for 1-line `<OutputRow>` cards on messages, workspace panel, and channel files. */
export function outputMeta(o: Output): { icon: IconName; meta: string; tone?: "muted" | "attention" | "danger" | "ok" } {
  const icon: IconName = o.kind === "pr"
    ? "merge"
    : o.kind === "file"
    ? ((o.mime ?? "").startsWith("image/") ? "image" : /\.(md|markdown|txt)$/i.test(o.name ?? o.title) ? "document" : "code")
    : "spark";
  const rowTone = o.status === "failed" || (o.kind === "pr" && o.note === "failure")
    ? "danger"
    : o.status === "pending"
    ? "attention"
    : undefined;
  if (o.kind === "pr") {
    const meta = prLine({ provider: "github", url: o.url ?? "", number: 0, title: o.title, state: o.status as any, checks: (o.note ?? "none") as any }).replace(/^PR #0( · )?/, "") || L("open", "进行中");
    return { icon, meta, tone: rowTone };
  }
  if (o.kind === "file") {
    return { icon, meta: [o.version && o.version > 1 ? `v${o.version}` : "", o.size !== undefined ? sizeLabel(o.size) : ""].filter(Boolean).join(" · "), tone: rowTone };
  }
  const st = o.status === "ready" ? L("ready", "已就绪") : o.status === "failed" ? L("failed", "失败") : L("in progress", "进行中");
  return { icon, meta: [o.service, st, o.note].filter(Boolean).join(" · "), tone: rowTone };
}

/** One output: a PR, a file (preview a text or picture in place, open it in the browser), or an outside result. */
export function OutputCard(props: { team: Team; task: Task; output: Output }) {
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
  const outTone = () => (o().status === "failed" || (o().kind === "pr" && o().note === "failure") ? colors.danger : o().status === "pending" ? colors.attention : colors.fg2);
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
    <View testID={`output-${o().id}`} style={{ gap: 6, padding: 8, borderRadius: 9, borderWidth: 1, borderColor: colors.hairline }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={icon()} size={14} tint={colors.fg2} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ fontSize: 13.5, fontWeight: "500", color: colors.fg, numberOfLines: 1 }}>{o().title}</Text>
          <Text testID={`output-${o().id}-status`} style={{ fontSize: 12, color: outTone(), numberOfLines: 1 }}>{statusText()}</Text>
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
        <Scroll style={{ maxHeight: 320 }} contentStyle={{ padding: 8, borderRadius: 7, backgroundColor: colors.hover }}>
          <Text testID={`output-${o().id}-text`} style={{ fontSize: 12.5, lineHeight: 18, color: colors.fg, fontFamily: "Menlo" }}>{text() ?? ""}</Text>
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

const WHY: Record<Holder["why"], () => string> = {
  confirm: () => L("to say yes", "确认开工"), handoff_card: () => L("to decide a handoff", "决定要不要交接"), answer: () => L("to answer", "回答问题"),
  handoff: () => L("to do their part", "做交给他的事"), align: () => L("to align on what done means", "对齐做完意味着什么"), decide: () => L("to decide", "做决定"), accept: () => L("to accept it", "验收"),
  unblock: () => L("to unblock it", "解决卡住的地方"), retry: () => L("to retry or close it", "决定重试还是关闭"),
  work: () => L("working on it", "在做"), wait: () => L("waiting for an outside result", "在等外部结果"),
  receipt: () => L("to check what came back", "检查交回的结果"),
  move: () => L("to decide whether it goes on on another computer", "决定换不换电脑"),
  engine: () => L("to decide whether it goes on with another runtime", "决定换不换引擎"),
};
/** "Ball: 张伟 · to accept it" / "Ball: you · …" / "Ball: @acha · working on it". */
function holderText(t: Team, hd: Holder, me: string | undefined, task?: Task): string {
  if (hd.why === "wait" && task?.wait?.how === "delegates") {
    const a = "@" + (t.agents().find((x) => x.id === hd.id)?.handle ?? "?");
    return L(`Ball: ${a} · waiting for what it delegated`, `球在 ${a} 手里 · 等委派的交回`);
  }
  const who = hd.kind === "agent" ? "@" + (t.agents().find((a) => a.id === hd.id)?.handle ?? "?") : hd.id === me ? L("you", "你") : t.users().find((u) => u.id === hd.id)?.name ?? "?";
  return L(`Ball: ${who} · ${WHY[hd.why]?.() ?? hd.why}`, `球在 ${who} 手里 · ${WHY[hd.why]?.() ?? hd.why}`);
}

export function TaskCard(props: { team: Team; task: Task; channelName?: string; onOpen?: () => void; onCardPress?: () => void; detail?: boolean }) {
  const t = props.team;
  const task = () => props.task;
  const agent = () => t.agents().find((a) => a.id === task().agent_id);
  const owner = () => t.users().find((u) => u.id === agent()?.owner_id);
  const machine = () => taskMachine(t, task(), agent());
  const me = () => t.me();
  const isOwner = () => !!me() && (me()!.id === agent()?.owner_id || me()!.role === "admin");
  const party = () => isParty(task(), me(), agent());
  const busy = signal("");
  const error = signal("");
  /** Someone else in the channel can take it over (its asker is away): it goes on in their name. */
  const lastTakeover = () => task().mandate?.takeovers?.at(-1);
  /** Taking it over is asking the agent in one's own name: an owner-only agent's work can't be; one that needs its
   * owner's yes waits for it (pendingTakeover). */
  const canTakeOver = () => !!me() && me()!.id !== task().created_by && !["done", "closed"].includes(task().state) &&
    (me()!.id === agent()?.owner_id || agent()?.dispatch !== "owner") && !(lastTakeover()?.pending && lastTakeover()!.to === me()!.id) &&
    (me()!.role === "admin" || !!t.channels().find((c) => c.id === task().channel_id)?.members.some((m) => m.kind === "user" && m.id === me()!.id));
  const pendingTakeover = () => (lastTakeover()?.pending && !["done", "closed"].includes(task().state) ? lastTakeover()! : null);
  const st = () => statusOf(task().state);
  const label = () => STATUS[st().status];
  const needs = () => waitsOn(t, task());
  const renaming = signal(false);
  const draft = signal("");
  async function rename() {
    const title = draft().trim();
    if (!title || title === task().title) return renaming.set(false);
    busy.set("rename");
    error.set("");
    const r = await t.setTaskTitle(task().id, title);
    busy.set("");
    if (!r.ok) return error.set(errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
    renaming.set(false);
  }
  /** Only the agent's owner answers the 换电脑 card (not an admin: it is their computers). */
  const mayMove = () => !!me() && me()!.id === agent()?.owner_id;
  async function act(action: "confirm" | "decline" | "cancel" | "accept" | "decide" | "reopen" | "takeover" | "handoff" | "retry" | "move" | "engine", body: unknown = {}) {
    busy.set(action);
    error.set("");
    const r = await t.act(task().id, action, body);
    busy.set("");
    if (!r.ok) error.set(errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
    // accepting a result or deciding what was asked: felt once, as it lands (phones)
    else if (action === "accept" || action === "decide") feelDone();
  }
  /** 回复…: the thread's box, with the focus, for what the buttons don't say. */
  const reply = () => {
    props.onOpen?.();
    composeInto.set({ channel: task().channel_id, thread: task().thread_id ?? undefined, text: "", at: Date.now() });
  };
  const waiting = () => {
    const s = task().state;
    if (s === "pending" && !isOwner()) return L(`Waiting for @${owner()?.handle ?? "?"} to confirm`, `等 @${owner()?.handle ?? "?"} 确认`);
    // several computers and none can take it now (as the server picks): it goes to whichever comes back first
    if (s === "queued" && !task().claimed_by && agent() && machinesOf(t, agent()!).length > 1 && blockedReason(agent()!, machine(), false)) {
      return L("Waiting for one of its computers to free up", "等一台能接活的电脑");
    }
    const trouble = s === "queued" ? machine()?.runtime_status?.[taskRuntime(task(), agent())] : undefined;
    if (trouble) return `${machine()!.name}${L(": ", "：")}${runtimeTrouble(trouble, lang() !== "zh")}`;
    if (s === "queued") return !machine() ? L("The agent has no machine", "这个 Agent 还没有机器") : machine()!.online ? L(`${machine()!.name} will pick it up`, `${machine()!.name} 马上认领`) : L(`${machine()!.name} is offline; it starts when it’s back`, `${machine()!.name} 离线，上线后开工`);
    // its computer went away mid-run: it goes on when it's back (or on another, if the agent's owner says so)
    if (s === "running" && task().claimed_by && machine() && !machine()!.online) return L(`${machine()!.name} is offline; it goes on when it’s back`, `${machine()!.name} 离线，等它上线`);
    if (s === "running") {
      const p = planSummary(task());
      if (p) return [p.ratio, p.current || task().step].filter(Boolean).join(" · ");
      return task().step || L("Working…", "干活中…");
    }
    if (s === "waiting" && task().wait?.how === "delegates") {
      const who = waitingFor(t, task());
      return who ? L(`Waiting for ${who}`, `等 ${who}`) : L("Everything delegated is back", "委派的都交回了");
    }
    if (s === "waiting") return waitShort(task());
    return "";
  };
  return (
    <View testID={`task-${task().id}`} style={{ marginTop: 6, gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.raised, maxWidth: 560 }}>
      <If when={props.detail} else={
        <If when={props.onCardPress && !task().redacted} else={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.fg3, fontVariant: ["tabular-nums"] }}>{task().id}</Text>
            <Text testID={`task-${task().id}-heading`} style={{ flex: 1, fontSize: 14.5, fontWeight: "600", color: task().redacted ? colors.fg2 : colors.fg, numberOfLines: 1 }}>
              {task().redacted ? L("A task in a private channel", "私有频道里的任务") : task().title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <If when={task().state === "running"}>
                <Spinner size={11} tint={colors.fg} />
              </If>
              <Text testID={`task-${task().id}-state`} style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(label().tone) }}>{label().label()}</Text>
            </View>
          </View>
        }>
          <CardHead testID={`task-${task().id}-card`} label={`${task().id} ${task().title}`} onPress={() => props.onCardPress!()}>
            <Txt variant="caption" tone="faint" weight="semibold" tabular>{task().id}</Txt>
            <Txt testID={`task-${task().id}-heading`} weight="semibold" grow lines={1}>{task().title}</Txt>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <If when={task().state === "running"}>
                <Spinner size={11} tint={colors.fg} />
              </If>
              <Txt testID={`task-${task().id}-state`} variant="caption" weight="semibold" tone={label().tone}>{label().label()}</Txt>
            </View>
          </CardHead>
        </If>
      }>
        <Text testID={`task-${task().id}-ref`} style={{ fontSize: 12, color: colors.fg3, fontVariant: ["tabular-nums"] }}>{taskRef(t, task())}</Text>
        <If when={renaming()} else={
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <Text testID={`task-${task().id}-title`} style={{ flex: 1, fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.fg, numberOfLines: 3 }}>{task().title}</Text>
            <If when={party()}>
              <Btn small kind="ghost" testID={`task-${task().id}-rename`} label={L("Rename", "改标题")} onPress={() => { draft.set(task().title); renaming.set(true); }} />
            </If>
          </View>
        }>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Field
              small
              grow
              testID={`task-${task().id}-title-input`}
              value={draft()}
              autoFocus
              onChange={draft.set}
              onSubmit={() => void rename()}
            />
            <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => renaming.set(false)} />
            <Btn small kind="primary" testID={`task-${task().id}-title-save`} label={L("Save", "保存")} busy={busy() === "rename"} disabled={!draft().trim()} onPress={() => void rename()} />
          </View>
        </If>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View testID={`task-${task().id}-state`} style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 5, backgroundColor: tone(label().tone).tint }}>
            <If when={task().state === "running"}><Spinner size={10} tint={colors.fg} /></If>
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(label().tone) }}>{label().label()}</Text>
          </View>
          <If when={!needs() && waiting()}>
            <Text style={{ flex: 1, fontSize: 12.5, color: colors.fg2, numberOfLines: 1 }}>{waiting()}</Text>
          </If>
        </View>
      </If>
      <If when={task().state === "needs_decision" || task().state === "review" ? null : needs()}>
        {(n) => (
          <View testID={`task-${task().id}-needs`} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: tone(n().tone).tint }}>
            <Dot tone={n().tone} />
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(n().tone) }}>{n().label}</Text>
          </View>
        )}
      </If>
      <Each of={openQuestions(task())} key={(q) => q.message}>
        {(q) => {
          const who = () => t.users().find((u) => u.id === q().user);
          const mine = () => q().user === me()?.id;
          return (
            <View testID={`task-${task().id}-asked-${q().user}`} style={{ gap: 3, padding: 9, borderRadius: 8, backgroundColor: colors.selected }}>
              <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.fg }}>
                {q().kind === "handoff"
                  ? (mine() ? L(`@${agent()?.handle ?? "?"} handed this to you`, `@${agent()?.handle ?? "?"} 交给你`) : L(`@${agent()?.handle ?? "?"} handed this to @${who()?.handle ?? "?"}`, `@${agent()?.handle ?? "?"} 交给了 @${who()?.handle ?? "?"}`))
                  : mine() ? L(`@${agent()?.handle ?? "?"} asks you`, `@${agent()?.handle ?? "?"} 问你`) : L(`@${agent()?.handle ?? "?"} asks @${who()?.handle ?? "?"}`, `@${agent()?.handle ?? "?"} 在问 @${who()?.handle ?? "?"}`)}
              </Text>
              <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.fg, numberOfLines: 3 }}>{q().question}</Text>
              <If when={mine()}>
                <Text style={{ fontSize: 12, color: colors.fg3 }}>{q().kind === "handoff" ? L("Reply in the thread when it’s done; the agent hears it.", "做完在线程里回复一句，Agent 会收到。") : L("Reply in the thread; it keeps working meanwhile.", "在线程里回复就行，它会边做边等你的回答。")}</Text>
              </If>
            </View>
          );
        }}
      </Each>
      <Each of={openHandoffs(task())} key={(x) => x.id}>
        {(x) => {
          const to = () => t.agents().find((a) => a.id === x().to);
          const toOwner = () => t.users().find((u) => u.id === to()?.owner_id);
          // the card is there because @B's owner says yes first: only they hand it over; the task's people may say no
          const mayAccept = () => !!me() && me()!.id === to()?.owner_id;
          const mayDecline = () => mayAccept() || party();
          return (
            <AskCard
              testID={`task-${task().id}-handoff-${x().id}`}
              quiet={!mayDecline()}
              kind={x().kind === "delegate"
                ? L(`@${agent()?.handle ?? "?"} suggests delegating a part to @${to()?.handle ?? "?"}`, `@${agent()?.handle ?? "?"} 建议委派给 @${to()?.handle ?? "?"}`)
                : L(`@${agent()?.handle ?? "?"} suggests handing this to @${to()?.handle ?? "?"}`, `@${agent()?.handle ?? "?"} 建议交给 @${to()?.handle ?? "?"}`)}
              note={mayAccept() ? undefined : L(`@${toOwner()?.handle ?? "?"} decides: @${to()?.handle ?? "?"} takes work from the asker only with its owner’s yes.`, `由 @${toOwner()?.handle ?? "?"} 决定：@${to()?.handle ?? "?"} 接发起人的活要它的主人同意。`)}
              onReply={mayDecline() ? reply : undefined}
              actions={
                <If when={mayDecline()}>
                  <If when={mayAccept()}>
                    <Btn small kind="primary" testID={`task-${task().id}-handoff-${x().id}-accept`} label={L(`Hand to @${to()?.handle ?? "?"}`, `交给 @${to()?.handle ?? "?"}`)} busy={busy() === "handoff"} onPress={() => act("handoff", { id: x().id, accept: true })} />
                  </If>
                  <Btn small kind="plain" testID={`task-${task().id}-handoff-${x().id}-decline`} label={L("No need", "不用")} onPress={() => act("handoff", { id: x().id, accept: false })} />
                </If>
              }
            >
              <If when={x().what}>
                <Txt lines={3}>{x().what}</Txt>
              </If>
            </AskCard>
          );
        }}
      </Each>
      <If when={task().move?.state === "proposed" && mayMove() ? task().move : null}>
        {(mv) => <MoveCard team={t} task={task()} move={mv()} busy={busy() === "move"} onMove={(to) => act("move", { to })} onWait={() => act("move", { wait: true })} />}
      </If>
      <If when={task().engine?.state === "proposed" && mayMove() ? task().engine : null}>
        {(en) => <EngineCard team={t} task={task()} engine={en()} busy={busy() === "engine"} onSwitch={(to) => act("engine", { to })} onKeep={() => act("engine", { keep: true })} />}
      </If>
      <Delegates team={t} task={task()} />
      <If when={props.detail ? task().holder : null}>
        {(hd) => <Text testID={`task-${task().id}-holder`} style={{ fontSize: 12.5, color: colors.fg2 }}>{holderText(t, hd(), me()?.id, task())}</Text>}
      </If>
      <If when={props.detail && (task().mandate?.via?.length || task().mandate?.trigger || task().submits?.length)}>
        <Text testID={`task-${task().id}-origin`} style={{ fontSize: 12.5, color: colors.fg3 }}>
          {[
            task().mandate?.delegated && task().mandate?.via?.length ? L(`Delegated by @${t.agents().find((a) => a.id === task().mandate!.via!.at(-1))?.handle ?? "?"}; its result goes back to it`, `@${t.agents().find((a) => a.id === task().mandate!.via!.at(-1))?.handle ?? "?"} 委派的，结果交回给它`)
            : task().mandate?.via?.length ? L(`Handed on via ${task().mandate!.via!.map((id) => "@" + (t.agents().find((a) => a.id === id)?.handle ?? "?")).join(" → ")}`, `经 ${task().mandate!.via!.map((id) => "@" + (t.agents().find((a) => a.id === id)?.handle ?? "?")).join(" → ")} 交接而来`) : "",
            task().mandate?.trigger ? L("Started by a trigger", "由触发器发起") : "",
            task().submits?.length ? L(`Outside submissions ${task().submits!.length}/3`, `外部提交 ${task().submits!.length}/3`) : "",
          ].filter(Boolean).join(" · ")}
        </Text>
      </If>
      <If when={!props.detail}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <RuntimeBadge runtime={taskRuntime(task(), agent())} />
          <Text testID={`task-${task().id}-where`} style={{ flex: 1, fontSize: 12.5, color: colors.fg2 }}>
            {(task().redacted
              // its agent's owner is not in that private channel: who asked and which agent, nothing of what it says
              ? [`@${agent()?.handle ?? "?"}`, L("in a private channel", "在一个私有频道里"), L(`asked by ${t.users().find((u) => u.id === task().created_by)?.name ?? "?"}`, `发起人 ${t.users().find((u) => u.id === task().created_by)?.name ?? "?"}`)]
              : [`@${agent()?.handle ?? "?"}`, props.channelName ? `#${props.channelName}` : "", task().state !== "running" ? planSummary(task())?.ratio ?? "" : "", waiting()]).filter(Boolean).join(" · ")}
          </Text>
        </View>
      </If>
      <If when={!task().redacted && (task().reminders ?? []).filter((r) => !r.done && !!r.repeat).length ? (task().reminders ?? []).filter((r) => !r.done && !!r.repeat) : null}>
        {(rs) => (
          <View testID={`task-${task().id}-reminders`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Each of={rs()} key={(r) => r.id}>
              {(r) => <ReminderTag team={t} r={r()} onError={(e) => error.set(e)} />}
            </Each>
          </View>
        )}
      </If>
      <If when={props.detail ? "" : conclusion(task())}>
        {(line) => <Text testID={`task-${task().id}-summary`} style={{ fontSize: 13.5, lineHeight: 20, color: colors.fg, numberOfLines: 2 }}>{line()}</Text>}
      </If>
      <If when={props.detail ? null : task().pr}>
        {(pr) => (
          <Link testID={`task-${task().id}-pr`} icon="merge" tone={pr().checks === "failure" ? "danger" : "default"} label={prLine(pr())} onPress={() => void openUrl(pr().url)} />
        )}
      </If>
      <If when={task().state === "needs_decision" && task().decision?.kind === "align" ? task().decision : null}>
        {(d) => <AlignCard task={task()} decision={d()} party={party()} busy={busy() === "decide"} onReply={reply} onGo={(acceptance) => act("decide", acceptance === undefined ? {} : { acceptance })} />}
      </If>
      <If when={task().state === "needs_decision" && task().decision?.kind !== "align" ? task().decision : null}>
        {(d) => (
          <AskCard
            testID={`task-${task().id}-ask`}
            quiet={!party()}
            kind={needs()?.label ?? L("Needs a decision", "等你决定")}
            note={party() ? undefined : L("Its creator or the agent’s owner decides.", "由发起人或 Agent 的主人决定。")}
            onReply={party() ? reply : undefined}
            actions={
              <If when={party()}>
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
              </If>
            }
          >
            <Txt weight="semibold">{d().question}</Txt>
          </AskCard>
        )}
      </If>
      <If when={task().state === "review"}>
        <AskCard
          testID={`task-${task().id}-review`}
          quiet={!party()}
          kind={needs()?.label ?? L("Waits for acceptance", "等验收")}
          onReply={party() ? reply : undefined}
          actions={
            <If when={party()}>
              <Btn small kind="primary" testID={`task-${task().id}-accept`} label={L("Accept", "验收通过")} busy={busy() === "accept"} onPress={() => act("accept")} />
            </If>
          }
        >
          <If when={task().evidence?.length}>
            <EvidenceLine task={task()} />
            <If when={props.detail}><EvidenceList team={t} task={task()} /></If>
          </If>
        </AskCard>
      </If>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <If when={task().state === "pending" && isOwner()}>
          <Btn small kind="primary" testID={`task-${task().id}-confirm`} label={L("Start it", "确认开工")} busy={busy() === "confirm"} onPress={() => act("confirm")} />
          <Btn small testID={`task-${task().id}-decline`} label={L("Decline", "不接")} busy={busy() === "decline"} onPress={() => act("decline")} />
        </If>
        <If when={task().state === "waiting" && task().wait?.how === "quota" && party()}>
          <Btn small kind="primary" testID={`task-${task().id}-retry`} label={L("Try now", "现在就试")} busy={busy() === "retry"} onPress={() => act("retry")} />
        </If>
        <If when={party() && !["done", "closed"].includes(task().state) && !(task().state === "pending" && isOwner())}>
          <Btn small kind="ghost" testID={`task-${task().id}-cancel`} label={task().state === "running" ? L("Stop", "停止") : task().state === "waiting" ? L("Cancel", "取消") : L("Close", "关闭")} busy={busy() === "cancel"} onPress={() => act("cancel")} />
        </If>
        <If when={party() && ["review", "needs_decision", "blocked", "failed"].includes(task().state)}>
          <If when={task().state !== "review"}>
            <Btn small kind="ghost" testID={`task-${task().id}-done`} label={L("Mark done", "标为完成")} busy={busy() === "accept"} onPress={() => act("accept")} />
          </If>
        </If>
        <If when={props.detail && canTakeOver()}>
          <Btn small kind="ghost" testID={`task-${task().id}-takeover`} label={L("Take it over", "接手")} busy={busy() === "takeover"} onPress={() => act("takeover")} />
        </If>
        <If when={props.detail && pendingTakeover() && isOwner()}>
          <Btn small testID={`task-${task().id}-takeover-approve`} label={L("Let them take it over", "同意接手")} busy={busy() === "takeover"} onPress={() => act("takeover", { approve: true })} />
          <Btn small kind="ghost" testID={`task-${task().id}-takeover-reject`} label={L("Don’t", "不同意")} onPress={() => act("takeover", { approve: false })} />
        </If>
        <If when={party() && ["done", "closed"].includes(task().state)}>
          <Btn small kind="ghost" testID={`task-${task().id}-reopen`} label={L("Reopen", "重新打开")} busy={busy() === "reopen"} onPress={() => act("reopen")} />
        </If>
        <If when={props.onOpen}>
          <Btn small kind="ghost" testID={`task-${task().id}-open`} label={L("Open thread", "打开线程")} onPress={() => props.onOpen!()} />
        </If>
      </View>
      <ErrorNote text={error()} testID={`task-${task().id}-error`} />
      <If when={props.detail ? lastTakeover() : null}>
        {(x) => (
          <Text testID={`task-${task().id}-takeover-note`} style={{ fontSize: 12.5, color: colors.fg2 }}>
            {x().pending
              ? L(`${t.users().find((u) => u.id === x().to)?.name ?? "?"} asked to take it over ${time(x().at)}; waiting for @${owner()?.handle ?? "?"} to say yes`,
                `${t.users().find((u) => u.id === x().to)?.name ?? "?"} 在 ${time(x().at)} 想接手，等 @${owner()?.handle ?? "?"} 同意`)
              : L(`${t.users().find((u) => u.id === x().to)?.name ?? "?"} took it over from ${t.users().find((u) => u.id === x().from)?.name ?? "?"} ${time(x().at)}`,
                `${t.users().find((u) => u.id === x().to)?.name ?? "?"} 在 ${time(x().at)} 从 ${t.users().find((u) => u.id === x().from)?.name ?? "?"} 手里接手`)}
          </Text>
        )}
      </If>
      <If when={props.detail}>
        <TaskFacts team={t} task={task()} />
      </If>
    </View>
  );
}
