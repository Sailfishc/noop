// A task's card: status, what it waits for, outputs, PR, and the buttons for whoever has to act.
import { Image, openUrl, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { L } from "../i18n";
import { alpha, colors, hovered, Icon, type IconName, radius, Spinner } from "../ui";
import { errorOf, isParty, openQuestions, type Output, type Task, type Team } from "./api";
import { STATUS, statusOf } from "./status";
import { taskRef, waitsOn } from "./taskpeople";
import { Btn, ErrorNote, RuntimeBadge, StateDot, time } from "./ui";
import { TaskFacts } from "./taskfacts";


/** A run shows as a task card when people track it, or while it needs a person (an owner's OK, a decision, …). A
 * request the agent only answered stays a conversation: its reply is in the thread, its emoji on the message. */
export function shownAsTask(task: Task): boolean {
  return task.tracked !== false || statusOf(task.state).needs !== "" || openQuestions(task).length > 0;
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
  answer: () => L("woken by the answer", "等人回答"),
};

/** What a waiting task waits for, in one short line (its card). */
export function waitShort(task: Task): string {
  const w = task.wait;
  if (!w) return "";
  const until = w.expect ? L(`expected ${time(w.expect)}`, `预计 ${time(w.expect)}`) : L(`until ${time(w.deadline)}`, `最晚 ${time(w.deadline)}`);
  return [w.what || (w.how === "answer" ? L("an answer", "回答") : L("an outside result", "外部结果")), until].join(" · ");
}

/** The details: how it is watched, when it gives up, the last check and its note. */
export function waitLines(task: Task): string[] {
  const w = task.wait;
  if (!w) return [];
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

const TEXTISH = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|toml))/;
const sizeLabel = (n = 0) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

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

export function TaskCard(props: { team: Team; task: Task; channelName?: string; onOpen?: () => void; detail?: boolean }) {
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
    if (s === "queued" && agent()?.paused) return L(`Waiting: the agent is paused (${agent()!.paused!.text}); reply here once it is fixed`, `排队中：Agent 已暂停（${agent()!.paused!.text}），处理好后在这里回复一句`);
    if (s === "queued") return !machine() ? L("The agent has no machine", "这个 Agent 还没有机器") : machine()!.online ? L(`${machine()!.name} will pick it up`, `${machine()!.name} 马上认领`) : L(`${machine()!.name} is offline; it starts when it’s back`, `${machine()!.name} 离线，上线后开工`);
    if (s === "running") return task().step || L("Working…", "干活中…");
    if (s === "waiting") return waitShort(task());
    return "";
  };
  return (
    <View testID={`task-${task().id}`} style={{ marginTop: 6, gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, maxWidth: 560 }}>
      <If when={props.detail} else={
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
      }>
        <Text testID={`task-${task().id}-ref`} style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{taskRef(t, task())}</Text>
        <If when={renaming()} else={
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <Text testID={`task-${task().id}-title`} style={{ flex: 1, fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.text, numberOfLines: 3 }}>{task().title}</Text>
            <If when={party()}>
              <Btn small kind="ghost" testID={`task-${task().id}-rename`} label={L("Rename", "改标题")} onPress={() => { draft.set(task().title); renaming.set(true); }} />
            </If>
          </View>
        }>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Input
              testID={`task-${task().id}-title-input`}
              value={draft()}
              autoFocus
              onChange={({ value }) => draft.set(value)}
              onSubmit={() => void rename()}
              style={{ flex: 1, height: 34, paddingHorizontal: 10, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.field, fontSize: 14.5, color: colors.text }}
            />
            <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => renaming.set(false)} />
            <Btn small kind="primary" testID={`task-${task().id}-title-save`} label={L("Save", "保存")} busy={busy() === "rename"} disabled={!draft().trim()} onPress={() => void rename()} />
          </View>
        </If>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View testID={`task-${task().id}-state`} style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 5, backgroundColor: alpha(toneOf(label().tone), 0.12) }}>
            <If when={task().state === "running"}><Spinner size={10} tint={colors.accent} /></If>
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(label().tone) }}>{label().label()}</Text>
          </View>
          <If when={!needs() && waiting()}>
            <Text style={{ flex: 1, fontSize: 12.5, color: colors.muted, numberOfLines: 1 }}>{waiting()}</Text>
          </If>
        </View>
      </If>
      <If when={needs()}>
        {(n) => (
          <View testID={`task-${task().id}-needs`} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: alpha(toneOf(n().tone), 0.12) }}>
            <StateDot tone={n().tone} />
            <Text style={{ fontSize: 12.5, fontWeight: "600", color: toneOf(n().tone) }}>{n().label}</Text>
          </View>
        )}
      </If>
      <Each of={openQuestions(task())} key={(q) => q.message}>
        {(q) => {
          const who = () => t.users().find((u) => u.id === q().user);
          const mine = () => q().user === me()?.id;
          return (
            <View testID={`task-${task().id}-asked-${q().user}`} style={{ gap: 3, padding: 9, borderRadius: 8, backgroundColor: alpha(colors.accent, 0.08) }}>
              <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.accent }}>
                {mine() ? L(`@${agent()?.handle ?? "?"} asks you`, `@${agent()?.handle ?? "?"} 问你`) : L(`@${agent()?.handle ?? "?"} asks @${who()?.handle ?? "?"}`, `@${agent()?.handle ?? "?"} 在问 @${who()?.handle ?? "?"}`)}
              </Text>
              <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.text, numberOfLines: 3 }}>{q().question}</Text>
              <If when={mine()}>
                <Text style={{ fontSize: 12, color: colors.faint }}>{L("Reply in the thread; it keeps working meanwhile.", "在线程里回复就行，它会边做边等你的回答。")}</Text>
              </If>
            </View>
          );
        }}
      </Each>
      <If when={!props.detail}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <RuntimeBadge runtime={agent()?.runtime ?? "codex"} />
          <Text style={{ flex: 1, fontSize: 12.5, color: colors.muted }}>
            {[`@${agent()?.handle ?? "?"}`, props.channelName ? `#${props.channelName}` : "", waiting()].filter(Boolean).join(" · ")}
          </Text>
        </View>
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
      <If when={props.detail}>
        <TaskFacts team={t} task={task()} />
      </If>
    </View>
  );
}
