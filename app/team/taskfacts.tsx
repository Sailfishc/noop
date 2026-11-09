// A task's facts beside its thread: who asked, the mandate, the repository, acceptance criteria, time spent.
import { openUrl, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { L } from "../i18n";
import { alpha, colors, hovered, Icon, radius } from "../ui";
import { isParty, EXTERNAL_TRIES, repoLabel, type Repo, type Task, type Team } from "./api";
import { AUTONOMY, DISPATCH } from "./settings";
import { Btn, ErrorNote, failed, RuntimeBadge, time } from "./ui";
import { OutputCard, externalTries, outputsOf, waitLines } from "./taskcard";

const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? L(`${m} min`, `${m} 分钟`) : L(`${Math.floor(m / 60)} h ${m % 60} min`, `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`);
};

/** The facts of a thread's task at its top: who does it on what, where its code goes, what came out; and its run log. */
export function TaskFacts(props: { team: Team; task: Task }) {
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
export function RepoPicker(props: { team: Team; value: string; testID: string; onPick: (remote: string) => Promise<string | null>; onCancel: () => void; noneLabel: string }) {
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

