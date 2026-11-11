// A channel's triggers, grouped by duty (design step 6 「长期职责」): work that starts by itself (a schedule, a new PR, a
// push), each firing a task for its agent in the name of who set it up. Triggers of one duty name and one agent are
// one group: how its last seven days went, one switch to pause them all, and its history. New triggers are read-only
// patrols by default: they look and speak, and say nothing when there is nothing to tell.
import { signal, View } from "nsh";
import { L } from "../i18n";
import { Btn, Card, Choice, ErrorNote, Field, Label, Noted, Tag, Toggle, Txt } from "../ui";
import { repoLabel, type Agent, type Team, type Trigger, type TriggerOutcome, type TriggerRun } from "./api";
import { failed, time } from "./ui";

const REPEAT: Record<string, () => string> = { daily: () => L("every day", "每天"), weekdays: () => L("weekdays", "每个工作日"), weekly: () => L("every week", "每周") };
/** "每个工作日 09:00" / "acme/pay 有新 PR" / "推送到 ledger main". */
export function triggerLabel(x: Trigger): string {
  if (x.kind === "schedule") {
    const d = x.due ? new Date(x.due) : null;
    return `${REPEAT[x.repeat ?? ""]?.() ?? ""} ${d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : ""}`.trim();
  }
  if (x.kind === "pr") return L(`new PR in ${repoLabel(x.repo ?? "")}${x.branch ? ` into ${x.branch}` : ""}`, `${repoLabel(x.repo ?? "")} 有新 PR${x.branch ? `（合入 ${x.branch}）` : ""}`);
  return L(`push to ${repoLabel(x.repo ?? "")}${x.branch ? ` ${x.branch}` : ""}`, `推送到 ${repoLabel(x.repo ?? "")}${x.branch ? ` ${x.branch}` : ""}`);
}

/** The outcomes in the order the summary names them. */
const OUTCOMES: TriggerOutcome[] = ["nochange", "nothing", "spoke", "proposed", "failed", "skipped", "running"];
const OUTCOME: Record<TriggerOutcome, () => string> = {
  nochange: () => L("no change", "没变化"), nothing: () => L("nothing found", "没发现"), spoke: () => L("spoke", "说了话"),
  proposed: () => L("proposed", "提了案"), failed: () => L("failed", "失败"), skipped: () => L("skipped", "跳过"), running: () => L("running", "进行中"),
};

/** "近 7 天：31 次没变化，9 次没发现，2 次提了案" from the triggers' counts. */
export function recentLine(ts: Trigger[]): string {
  const sum: Partial<Record<TriggerOutcome, number>> = {};
  for (const x of ts) for (const [k, n] of Object.entries(x.recent ?? {})) sum[k as TriggerOutcome] = (sum[k as TriggerOutcome] ?? 0) + (n ?? 0);
  const parts = OUTCOMES.filter((k) => sum[k]).map((k) => L(`${sum[k]} ${OUTCOME[k]()}`, `${sum[k]} 次${OUTCOME[k]()}`));
  return parts.length ? L(`Last 7 days: ${parts.join(", ")}`, `近 7 天：${parts.join("，")}`) : L("Nothing in the last 7 days", "近 7 天没有运行");
}

/** A duty: the triggers of one name and agent. A trigger with no duty name is a group of its own. */
type Group = { key: string; duty: string; agentId: string; triggers: Trigger[] };
export function groupTriggers(list: Trigger[]): Group[] {
  const named = new Map<string, Group>(), single: Group[] = [];
  for (const x of list) {
    if (!x.duty) { single.push({ key: x.id, duty: "", agentId: x.agent_id, triggers: [x] }); continue; }
    const key = `${x.agent_id}:${x.duty}`;
    const g = named.get(key) ?? { key, duty: x.duty, agentId: x.agent_id, triggers: [] };
    g.triggers.push(x);
    named.set(key, g);
  }
  return [...named.values(), ...single];
}

export function ChannelTriggers(props: { team: Team; channelId: string; agents: Agent[] }) {
  const t = props.team;
  const list = signal<Trigger[]>([]);
  const adding = signal(false);
  const error = signal("");
  const busy = signal(false);
  const agent = signal("");
  const kind = signal<Trigger["kind"]>("schedule");
  const text = signal("");
  const when = signal("9:00");
  const repeat = signal("weekdays");
  const repo = signal("");
  const branch = signal("");
  const perDay = signal("10");
  const duty = signal("");
  const readonly = signal(true);
  const check = signal("");
  const load = async () => { const r = await t.triggers(props.channelId); if (r.ok) list.set(r.data.triggers as Trigger[]); };
  void load();
  async function run(p: Promise<{ ok: boolean; status: number; data: any }>) {
    error.set("");
    const r = await p;
    if (!r.ok) error.set(failed(r as any));
    await load();
    return r.ok;
  }
  async function add() {
    busy.set(true);
    const ok = await run(t.createTrigger({ channel_id: props.channelId, agent: agent() || props.agents[0]?.id || "", kind: kind(), text: text().trim(),
      ...(kind() === "schedule" ? { when: when().trim(), repeat: repeat(), ...(check().trim() ? { check_cmd: check().trim() } : {}) } : { repo: repo().trim(), branch: branch().trim() }),
      ...(perDay().trim() && perDay().trim() !== "10" ? { max_per_day: Number(perDay().trim()) } : {}),
      ...(duty().trim() ? { duty: duty().trim() } : {}), readonly: readonly() }));
    busy.set(false);
    if (ok) { adding.set(false); text.set(""); check.set(""); }
  }
  return (
    <View testID="channel-triggers" style={{ gap: 6, paddingTop: 12 }}>
      <Label
        testID="channel-triggers-about"
        text={L("Triggers", "触发器")}
        note={L("A trigger asks an agent here by itself: on a schedule, when a PR is opened, or on a push. Triggers with one duty name are seen and paused together.",
          "触发器会自己去找这里的 Agent 干活：定时、有人开 PR、或者有推送时。同一个职责名下的触发器一起看、一起暂停。")}
        right={<If when={props.agents.length && !adding()}>
          <Btn small kind="ghost" testID="trigger-add" icon="plus" label={L("Add", "添加")} onPress={() => { agent.set(props.agents[0]?.id ?? ""); adding.set(true); }} />
        </If>}
      />
      <If when={!list().length && !adding()}>
        <Txt variant="caption" tone="faint">{L("None", "没有")}</Txt>
      </If>
      <Each of={groupTriggers(list())} key={(g) => g.key}>
        {(g) => <DutyCard team={t} group={g()} run={run} />}
      </Each>
      <If when={adding()}>
        <Card tight flat>
          <Choice testID="trigger-agent" options={props.agents.map((a) => ({ value: a.id, label: "@" + a.handle }))} value={agent()} onChange={(v) => agent.set(v)} />
          <Choice testID="trigger-kind" options={[{ value: "schedule", label: L("On a schedule", "定时") }, { value: "pr", label: L("New PR", "有新 PR") }, { value: "push", label: L("Push", "有推送") }]} value={kind()} onChange={(v) => kind.set(v as Trigger["kind"])} />
          <If when={kind() === "schedule"} else={
            <>
              <Field label={L("Repository", "仓库")} value={repo()} onChange={(v) => repo.set(v)} placeholder="https://github.com/acme/pay" testID="trigger-repo" />
              <Field label={kind() === "push" ? L("Branch (empty: any)", "分支（空：任意）") : L("Into branch (empty: any)", "合入的分支（空：任意）")} value={branch()} onChange={(v) => branch.set(v)} placeholder="main" testID="trigger-branch" />
            </>
          }>
            <Choice testID="trigger-repeat" options={Object.keys(REPEAT).map((k) => ({ value: k, label: REPEAT[k]!() }))} value={repeat()} onChange={(v) => repeat.set(v)} />
            <Field label={L("At", "时间")} value={when()} onChange={(v) => when.set(v)} placeholder="9:00" testID="trigger-when" />
            <Noted
              testID="trigger-check-about"
              label={<Txt weight="semibold">{L("Check first (optional)", "先跑检查命令（可选）")}</Txt>}
              note={L("A command run on the agent's computer before each firing. If it prints the same as last time, nothing happens; if it changed or failed, the agent gets its output. Leave times and dates out of what it prints. The agent's owner confirms it, again whenever it changes.",
                "每次触发前先在 Agent 的电脑上跑这条命令（最多 60 秒）。输出和上次一样就什么都不做；变了或出错，才把输出交给 Agent。输出里不要带时间、日期这类每次都变的东西。要 Agent 的主人确认，改了要再确认。")}
            />
            <Field value={check()} onChange={(v) => check.set(v)} placeholder="gh run list -b main -s failure -L 5" testID="trigger-check" />
          </If>
          <Field label={L("At most a day", "每天最多触发（次）")} value={perDay()} onChange={(v) => perDay.set(v)} placeholder="10" testID="trigger-max" />
          <Field label={L("What to ask", "让它做什么")} value={text()} onChange={(v) => text.set(v)} placeholder={L("Summarize last night’s alerts", "汇总一下昨晚的告警")} testID="trigger-text" />
          <Field label={L("Duty (optional)", "职责名（可选）")} value={duty()} onChange={(v) => duty.set(v)} placeholder={L("Watch main", "看住主干")} testID="trigger-duty" />
          <Noted
            testID="trigger-readonly"
            label={<Txt>{L("Read-only", "只读")}</Txt>}
            note={L("Its runs only look and speak: no changes to repositories, no PR, no handing work on. When there is nothing to tell, nothing is posted.",
              "它的运行只看和说：不改仓库、不开 PR、不转交。没有需要人知道的事时，频道里什么都不出现。")}
            right={<Toggle testID="trigger-readonly-toggle" label={L("Read-only", "只读")} value={readonly()} onChange={(v) => readonly.set(v)} />}
          />
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Btn small kind="primary" testID="trigger-save" label={L("Add", "添加")} busy={busy()} disabled={!text().trim()} onPress={() => void add()} />
            <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => adding.set(false)} />
          </View>
        </Card>
      </If>
      <ErrorNote text={error()} />
    </View>
  );
}

type Run = (p: Promise<{ ok: boolean; status: number; data: any }>) => Promise<boolean>;

/** One duty (or one trigger with no duty name): its triggers, how it went, a switch for all of it, its history. */
function DutyCard(props: { team: Team; group: Group; run: Run }) {
  const t = props.team;
  const g = () => props.group;
  const a = () => t.agents().find((x) => x.id === g().agentId);
  const history = signal<TriggerRun[] | null>(null);
  const testKey = () => g().duty ? `duty-${g().triggers[0]!.id}` : `trigger-${g().triggers[0]!.id}`;
  async function toggleHistory() {
    if (history()) return history.set(null);
    const r = await t.triggerRuns(g().duty ? { channel: g().triggers[0]!.channel_id, agent: g().agentId, duty: g().duty } : { trigger: g().triggers[0]!.id });
    history.set(r.ok ? (r.data.runs as TriggerRun[]) : []);
  }
  const on = () => g().triggers.every((x) => x.enabled);
  const historyBtn = () => <Btn small kind="ghost" testID={`${testKey()}-history`} label={history() ? L("Hide history", "收起历史") : L("History", "历史")} onPress={() => void toggleHistory()} />;
  const mayPause = () => g().triggers.every((x) => x.confirmed_by);
  return (
    <Card tight flat testID={g().duty ? testKey() : undefined}>
      <If when={g().duty}>
        <Noted
          label={<View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Txt weight="semibold" lines={1}>{g().duty}</Txt>
            <Txt tone="faint">@{a()?.handle ?? "?"}</Txt>
          </View>}
          right={<View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {historyBtn()}
            <If when={mayPause()}>
              <Toggle testID={`${testKey()}-toggle`} label={on() ? L("Pause this duty", "暂停这个职责") : L("Resume this duty", "恢复这个职责")} value={on()}
                onChange={(v) => void props.run(t.pauseDuty({ channel_id: g().triggers[0]!.channel_id, agent_id: g().agentId, duty: g().duty, enabled: v }))} />
            </If>
          </View>}
        />
        <Txt variant="caption" tone="faint" lines={1} testID={`${testKey()}-recent`}>{on() ? recentLine(g().triggers) : L("Paused", "已暂停")}</Txt>
      </If>
      <Each of={g().triggers} key={(x) => x.id}>
        {(x) => <TriggerRow team={t} trigger={x()} grouped={!!g().duty} run={props.run} />}
      </Each>
      <If when={!g().duty}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Txt variant="caption" tone="faint" grow lines={1} testID={`${testKey()}-recent`}>{recentLine(g().triggers)}</Txt>
          {historyBtn()}
        </View>
      </If>
      <If when={history()}>
        <View testID={`${testKey()}-runs`} style={{ gap: 2 }}>
          <If when={history()!.length} else={<Txt variant="caption" tone="faint">{L("None", "没有")}</Txt>}>
            <Each of={history()!} key={(r) => `${r.trigger_id}-${r.at}-${r.outcome}`}>
              {(r) => (
                <Txt variant="caption" tone={r().outcome === "failed" ? "warn" : "muted"} lines={1}>
                  {`${time(r().at)} · ${OUTCOME[r().outcome]?.() ?? r().outcome}${r().note ? ` · ${r().note}` : ""}${r().task_id ? ` · ${r().task_id}` : ""}`}
                </Txt>
              )}
            </Each>
          </If>
        </View>
      </If>
    </Card>
  );
}

/** One trigger: when it fires, what it asks, where it stands (its limits behind the ⓘ), and its buttons. */
function TriggerRow(props: { team: Team; trigger: Trigger; grouped: boolean; run: Run }) {
  const t = props.team;
  const x = () => props.trigger;
  const a = () => t.agents().find((g) => g.id === x().agent_id);
  const owner = () => t.users().find((u) => u.id === a()?.owner_id)?.handle ?? "?";
  // a check command runs on the owner's computer: only the owner confirms it (and again when it changes)
  const canConfirm = () => (!x().confirmed_by || x().check_waits) && (t.me()?.id === a()?.owner_id || (t.me()?.role === "admin" && !x().check_cmd));
  const limits = () => L(`At most ${x().max_per_day} a day${x().kind === "schedule" ? "; skipped while its last task is queued or running" : ""}`,
    `每天最多 ${x().max_per_day} 次${x().kind === "schedule" ? "；上一个任务还在排队或运行时跳过" : ""}`) +
    (x().skipped ? L(` · skipped ${x().skipped} times`, ` · 跳过过 ${x().skipped} 次`) : "");
  return (
    <View testID={`trigger-${x().id}`} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Txt lines={1}>⚡ {triggerLabel(x())}{props.grouped ? "" : ` · @${a()?.handle ?? "?"}`}</Txt>
        <If when={x().readonly}><Tag testID={`trigger-readonly-${x().id}`} label={L("read-only", "只读")} /></If>
      </View>
      <Txt tone="muted" lines={2}>{x().text}</Txt>
      <If when={x().check_cmd}>
        <Txt variant="caption" tone="muted" mono lines={2} testID={`trigger-check-${x().id}`}>$ {x().check_cmd}</Txt>
      </If>
      <Noted
        testID={`trigger-limits-${x().id}`}
        note={x().max_per_day ? limits() : undefined}
        label={<Txt variant="caption" tone={!x().confirmed_by || x().check_waits ? "warn" : "faint"}>
          {!x().confirmed_by ? L(`Waits for @${owner()} to confirm once`, `等 @${owner()} 确认一次`)
            : x().check_waits ? L(`Its check command changed: waits for @${owner()} to confirm`, `检查命令改了，等 @${owner()} 确认`)
            : !x().enabled ? L("Paused", "已暂停") : x().fires ? L(`Fired ${x().fires} times, last ${time(x().fired!)}`, `触发过 ${x().fires} 次，上次 ${time(x().fired!)}`) : L("Not fired yet", "还没触发过")}
        </Txt>}
      />
      <If when={x().skipped_run}>
        <Txt variant="caption" tone="warn" testID={`trigger-stuck-${x().id}`}>
          {x().skip_reason === "limit"
            ? L(`Skipped ${x().skipped_run} times in a row: it reached today’s limit`, `已连续跳过 ${x().skipped_run} 次：今天的次数到上限了`)
            : L(`Skipped ${x().skipped_run} times in a row: ${x().last_task ?? "its last task"} is still queued or running`, `已连续跳过 ${x().skipped_run} 次，因为 ${x().last_task ?? "上一个任务"} 还在排队或运行`)}
        </Txt>
      </If>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <If when={canConfirm()}><Btn small kind="primary" testID={`trigger-confirm-${x().id}`} label={L("Confirm", "确认")} onPress={() => void props.run(t.confirmTrigger(x().id))} /></If>
        <If when={x().confirmed_by && !props.grouped}><Btn small kind="ghost" testID={`trigger-toggle-${x().id}`} label={x().enabled ? L("Pause", "暂停") : L("Resume", "恢复")} onPress={() => void props.run(t.patchTrigger(x().id, { enabled: !x().enabled }))} /></If>
        <Btn small kind="ghost" testID={`trigger-remove-${x().id}`} label={L("Remove", "删除")} onPress={() => void props.run(t.deleteTrigger(x().id))} />
      </View>
    </View>
  );
}
