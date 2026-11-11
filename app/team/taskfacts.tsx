// A task's facts beside its thread: who does it, who asked, time spent; folded: acceptance criteria, repository, mandate, run log.
import { type JSX, openUrl, signal, Text, View } from "nsh";
import { L } from "../i18n";
import { alpha, Btn, colors, ErrorNote, Field, hovered, Icon, TextArea } from "../ui";
import { isParty, EXTERNAL_TRIES, repoLabel, type Repo, type Task, type Team } from "./api";
import { AUTONOMY, DISPATCH } from "./settings";
import { failed, RuntimeBadge, time } from "./ui";
import { OutputCard, externalTries, outputsOf, waitLines } from "./taskcard";

const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? L(`${m} min`, `${m} 分钟`) : L(`${Math.floor(m / 60)} h ${m % 60} min`, `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`);
};

/** The facts under a task's head in its thread, slim (design "Remi 任务视图 v2"): who does it on what, who asked,
 * how long; what it waits for; the first outputs. The rest (acceptance criteria, repository and branch, mandate, run
 * log) sits behind one row of folds, one open at a time. */
export function TaskFacts(props: { team: Team; task: Task }) {
  const t = props.team;
  const task = () => props.task;
  const agent = () => t.agents().find((a) => a.id === task().agent_id);
  const owner = () => t.users().find((u) => u.id === agent()?.owner_id);
  const creator = () => t.users().find((u) => u.id === task().created_by);
  const handler = () => t.users().find((u) => u.id === task().handler);
  const machine = () => t.machines().find((m) => m.id === agent()?.machine_id);
  const fold = signal<"" | "acceptance" | "repo" | "mandate" | "log">("");
  const allOutputs = signal(false);
  const live = () => ["running", "queued", "pending", "needs_decision"].includes(task().state);
  const fact = (label: string, value: JSX.Element) => (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "center", minHeight: 22 }}>
      <Text style={{ width: 52, fontSize: 12.5, color: colors.faint }}>{label}</Text>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>{value}</View>
    </View>
  );
  const plain = (s: string, testID?: string) => <Text testID={testID} style={{ fontSize: 13, color: colors.text }}>{s}</Text>;
  const outputs = () => outputsOf(task());
  const lines = (s?: string) => (s ?? "").split("\n").filter((x) => x.trim()).length;
  const foldChip = (k: "acceptance" | "repo" | "mandate" | "log", label: string) => (
    <View role="button" testID={`task-${task().id}-fold-${k}`} accessibilityState={{ expanded: fold() === k }} onPress={() => fold.set(fold() === k ? "" : k)} hoverStyle={hovered()}
      style={{ height: 26, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, borderRadius: 7, backgroundColor: fold() === k ? alpha(colors.text, 0.08) : alpha(colors.text, 0.04) }}>
      <Text style={{ fontSize: 12.5, color: fold() === k ? colors.text : colors.muted }}>{label}</Text>
      <Icon name={fold() === k ? "chevron-down" : "chevron"} size={11} tint={colors.faint} />
    </View>
  );
  return (
    <View testID={`task-${task().id}-facts`} style={{ gap: 6, paddingTop: 2 }}>
      {fact(L("Done by", "执行"), <>
        {plain(`@${agent()?.handle ?? "?"}${owner() ? L(` (${owner()!.name}’s agent)`, `（${owner()!.name}的 Agent）`) : ""}`)}
        <RuntimeBadge runtime={agent()?.runtime ?? "codex"} />
        <Text testID={`task-${task().id}-machine`} style={{ fontSize: 12.5, color: colors.muted }}>{[agent()?.model, machine()?.name ?? L("no machine", "没有机器")].filter(Boolean).join(" · ")}</Text>
      </>)}
      {fact(L("Asked by", "发起人"), plain(`${creator()?.name ?? "?"} · ${time(task().created)}`))}
      <If when={handler()}>
        {fact(L("Taken by", "处理人"), plain(L(`${handler()!.name} (accepts and decides)`, `${handler()!.name}（验收与决定）`), `task-${task().id}-handler`))}
      </If>
      {fact(live() ? L("Time", "用时") : L("Updated", "更新"), <>
        {plain(live() ? minutes(Date.now() - task().created) : time(task().updated))}
        <If when={task().result}>
          <Text testID={`task-${task().id}-result`} style={{ fontSize: 12.5, fontWeight: "600", color: task().result === "confirmed" ? colors.up : colors.warn }}>
            {task().result === "confirmed" ? L("result confirmed", "结果已确认") : L("submitted, result not confirmed", "已提交，结果未确认")}
          </Text>
        </If>
      </>)}
      <If when={task().state === "waiting" && task().wait}>
        {fact(L("Waiting", "等待"), <View testID={`task-${task().id}-wait`} style={{ flex: 1, gap: 2 }}>
          <Each of={waitLines(task())} key="index">{(l) => <Text style={{ fontSize: 13, lineHeight: 19, color: colors.text }}>{l()}</Text>}</Each>
          <Text style={{ fontSize: 12, color: colors.faint }}>{L("Nobody is notified while it waits.", "等待期间不打扰任何人。")}</Text>
        </View>)}
      </If>
      <If when={outputs().length}>
        <View style={{ gap: 6, paddingTop: 2 }}>
          <Each of={allOutputs() ? outputs() : outputs().slice(0, 2)} key={(o) => o.id}>
            {(o) => <OutputCard team={t} task={task()} output={o()} />}
          </Each>
          <If when={outputs().length > 2}>
            <View role="button" testID={`task-${task().id}-outputs-all`} onPress={() => allOutputs.update((v) => !v)} hoverStyle={hovered()} style={{ alignSelf: "flex-start", height: 24, justifyContent: "center", paddingHorizontal: 6, marginLeft: -6, borderRadius: 6 }}>
              <Text style={{ fontSize: 12.5, color: colors.accent }}>{allOutputs() ? L("Fewer", "收起") : L(`All ${outputs().length} outputs`, `全部 ${outputs().length} 个产出`)}</Text>
            </View>
          </If>
        </View>
      </If>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 2 }}>
        {foldChip("acceptance", lines(task().acceptance) ? L(`Acceptance (${lines(task().acceptance)})`, `验收标准 (${lines(task().acceptance)})`) : L("Acceptance", "验收标准"))}
        {foldChip("repo", L("Repository & branch", "仓库与分支"))}
        <If when={task().mandate}>{foldChip("mandate", L("Mandate", "授权"))}</If>
        {foldChip("log", L(`Run log (${task().runs})`, `运行记录 (${task().runs})`))}
        <If when={externalTries(task())}>
          <Text testID={`task-${task().id}-tries`} style={{ alignSelf: "center", fontSize: 12, color: colors.faint }}>{L(`outside ${externalTries(task())}/${EXTERNAL_TRIES}`, `外部提交 ${externalTries(task())}/${EXTERNAL_TRIES}`)}</Text>
        </If>
      </View>
      <If when={fold() === "acceptance"}><Acceptance team={t} task={task()} /></If>
      <If when={fold() === "repo"}>
        <View style={{ gap: 6 }}>
          <TaskRepo team={t} task={task()} />
          <If when={task().repo || agent()?.repo}>
            {fact(L("Branch", "分支"), plain(`${task().branch || "agent/" + task().id} → ${L("main branch", "主分支")}`))}
          </If>
        </View>
      </If>
      <If when={fold() === "mandate"}>
        <Text testID={`task-${task().id}-mandate`} style={{ fontSize: 13, lineHeight: 19, color: colors.text }}>{mandateLine(t, task())}</Text>
      </If>
      <If when={fold() === "log"}>
        <View testID={`task-${task().id}-runlog`} style={{ gap: 4 }}>
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
      <Field
        small
        testID={`${props.testID}-input`}
        value={draft()}
        autoFocus
        placeholder={L("https://github.com/owner/name, or pick one below", "https://github.com/owner/name，或从下面选")}
        onChange={draft.set}
        onSubmit={() => void pick(draft().trim())}
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
  const declared = () => props.task.repos ?? [];
  const label = () => props.task.repo
    ? repoLabel(props.task.repo)
    : declared().length ? L(`${declared().map(repoLabel).join(", ")} (the agent checked it out)`, `${declared().map(repoLabel).join("、")}（Agent 自己检出的）`)
    : agent()?.repo ? L(`the agent’s checkout ${agent()!.repo}`, `Agent 的本地仓库 ${agent()!.repo}`) : L("none yet: the agent checks one out if the work needs it", "暂时没有：要改代码时 Agent 自己检出");
  return (
    <View testID={`task-${props.task.id}-repo`} style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 22 }}>
        <Text style={{ width: 68, fontSize: 12.5, color: colors.faint }}>{L("Repository", "仓库")}</Text>
        <If when={props.task.repo} else={<Text testID={`task-${props.task.id}-repo-label`} style={{ flex: 1, fontSize: 13, color: declared().length || agent()?.repo ? colors.text : colors.muted }}>{label()}</Text>}>
          <View role="link" style={{ flex: 1 }} onPress={() => void openUrl(`https://${props.task.repo}`)} hoverStyle={hovered()}>
            <Text testID={`task-${props.task.id}-repo-label`} style={{ fontSize: 13, color: colors.accent }}>{[label(), ...declared().map(repoLabel)].join(" + ")}</Text>
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
          <TextArea
            testID={`task-${props.task.id}-acceptance-input`}
            value={draft()}
            min={64}
            max={160}
            autoFocus
            placeholder={L("One per line, e.g. P99 under 200 ms; no table locks", "一行一条，比如：P99 低于 200ms；上线不锁表")}
            onChange={draft.set}
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

