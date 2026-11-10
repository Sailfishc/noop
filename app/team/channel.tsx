// A channel: its conversation, the members panel, the default repository, a thread with its task's facts, and a new channel.
import { effect, List, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { L } from "../i18n";
import { alpha, colors, hovered, Icon, radius, Spinner } from "../ui";
import { errorOf, isMember, repoLabel, type Agent, type Member, type Message, type Task, type Team } from "./api";
import { LayoutSwitch, rememberedLayout, TaskBoard, trackedTasks } from "./tasks";
import { agentState, authorOf, Avatar, Btn, ErrorNote, failed, Field, Header, RuntimeBadge, StateDot, Tag, time, unreachable } from "./ui";
import { RepoPicker } from "./taskfacts";
import { Composer } from "./composer";
import { MessageRow } from "./messages";
import { TaskCard, shownAsTask } from "./taskcard";
import { NEEDS, STATUS, type Needs } from "./status";

/** What the right column shows beside a channel: a thread, or the channel's members. */
export type Side = { kind: "thread"; id: string } | { kind: "members" } | null;

export function ChannelView(props: { team: Team; id: string; back: boolean; onBack: () => void; side: Side; onThread: (id: string) => void; onMembers: () => void }) {
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
  const layout = rememberedLayout("channel");
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
          <LayoutSwitch value={layout.get()} onChange={layout.set} />
        </If>
      </View>
      <If when={tab() === "chat"} else={<TaskBoard team={t} tasks={channelTasks()} layout={layout.get()} onOpen={(x) => props.onThread(x.thread_id)}
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

/** The channel's usual repository: a hint its agents get. A task starts in a general directory unless the message
 * names a repository; the agent declares one (`remi repo`) when the work needs changes there. */
function ChannelRepo(props: { team: Team; channelId: string }) {
  const t = props.team;
  const editing = signal(false);
  const channel = () => t.channels().find((c) => c.id === props.channelId);
  const repo = () => channel()?.repo ?? "";
  return (
    <View testID="channel-repo" style={{ gap: 6, paddingTop: 10 }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("USUAL REPOSITORY", "常用仓库")}</Text>
      <If when={!editing()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text testID="channel-repo-label" style={{ flex: 1, fontSize: 13.5, color: repo() ? colors.text : colors.muted }}>
            {repo() ? repoLabel(repo()) : L("None: agents pick a repository when the work needs one.", "没有：需要改代码时，Agent 自己判断用哪个仓库。")}
          </Text>
          <Btn small kind="ghost" testID="channel-repo-edit" label={repo() ? L("Change", "更换") : L("Set", "设置")} onPress={() => editing.set(true)} />
        </View>
        <Text style={{ fontSize: 12, lineHeight: 17, color: colors.faint }}>{L("A hint for agents: tasks start without a repository, and the agent checks one out when the work needs changes there. A repository named in the message is used from the start.", "给 Agent 的提示：任务开始时不带仓库，Agent 判断要改代码时再检出。消息里写了仓库地址的，一开始就用那个。")}</Text>
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

/** How the channel works ("PR 标题用中文", "发布前在 #ops 说一声"): its members write it, every agent working here
 * reads it with its task (before the team's AGENTS.md). */
function ChannelConventions(props: { team: Team; channelId: string }) {
  const t = props.team;
  const channel = () => t.channels().find((c) => c.id === props.channelId);
  const now = () => channel()?.conventions ?? "";
  const value = signal(untracked(now));
  const busy = signal(false);
  const error = signal("");
  const changed = () => value().trim() !== now();
  effect(() => { const n = now(); if (!untracked(changed)) value.set(n); });
  async function save() {
    busy.set(true);
    error.set("");
    const r = await t.patchChannel(props.channelId, { conventions: value().trim() });
    busy.set(false);
    if (!r.ok) error.set(failed(r));
  }
  return (
    <View testID="channel-conventions" style={{ gap: 6, paddingTop: 10 }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("HOW WE WORK HERE", "频道约定")}</Text>
      <Input
        testID="channel-conventions-input"
        value={value()}
        multiline
        placeholder={L("- PR titles in Chinese\n- Say so in #ops before a release", "- PR 标题用中文\n- 发布前在 #ops 说一声")}
        class="placeholder:text-faint"
        onChange={({ value: v }) => value.set(v)}
        style={{ minHeight: 64, maxHeight: 200, padding: 8, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.field, fontSize: 13, lineHeight: 19, color: colors.text }}
      />
      <ErrorNote text={error()} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: colors.faint }}>{L("Every agent working in this channel reads this with its task.", "在这个频道干活的 Agent 每次开工都会读。")}</Text>
        <If when={changed()}>
          <Btn small testID="channel-conventions-save" label={L("Save", "保存")} busy={busy()} onPress={() => void save()} />
        </If>
      </View>
    </View>
  );
}

/** The channel's people, and its agents by owner (with runtime and state); add or remove members. */
export function MembersPanel(props: { team: Team; channelId: string; back?: boolean; onClose: () => void; onAgent: (handle: string) => void }) {
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
        <ChannelConventions team={t} channelId={props.channelId} />
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

export function ThreadView(props: { team: Team; rootId: string; back?: boolean; onClose: () => void }) {
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
  /** The replies, with where its tracked tasks went between them (as in Raft, a status change shows in the thread). */
  const flow = () => {
    const items: { key: string; at: number; m?: Message; line?: string }[] = replies().map((m) => ({ key: m.id, at: m.created, m }));
    for (const x of tasks().filter(shownAsTask)) {
      (x.events ?? []).forEach((e, i) => {
        if (i === 0 && e.at - x.created < 2000) return; // its first status is on its card
        const needs = e.needs && e.needs in NEEDS ? NEEDS[e.needs as Exclude<Needs, "">].label() : "";
        items.push({ key: `${x.id}-ev-${i}`, at: e.at, line: [`${x.id} → ${STATUS[e.status]?.label() ?? e.status}`, needs].filter(Boolean).join(" · ") });
      });
    }
    return items.sort((a, b) => a.at - b.at);
  };
  const task = () => tasks()[tasks().length - 1];
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
              <Each of={flow()} key={(x) => x.key}>
                {(x) => <If when={x().m} else={<StatusLine text={x().line!} at={x().at} testID={x().key} />}>{(m) => <MessageRow team={t} m={m()} />}</If>}
              </Each>
            </Scroll>
            <If when={member()}>
              <Composer team={t} channelId={r().channel_id} threadId={r().id} testID="thread-composer" placeholder={L("Reply…", "回复…")} onSend={(text, files) => t.send(r().channel_id, text, r().id, files)} />
            </If>
          </>
        )}
      </If>
    </View>
  );
}

export function NewChannel(props: { team: Team; back: boolean; onBack: () => void; onCreated: (id: string) => void }) {
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
    if (!r.ok) return error.set(r.status === 0 ? unreachable(t.url, r.error) : errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`)));
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

/** A task's status change between a thread's replies: one quiet centred line. */
function StatusLine(props: { text: string; at: number; testID: string }) {
  return (
    <Text testID={props.testID} style={{ paddingVertical: 4, paddingHorizontal: 16, fontSize: 12, color: colors.faint, textAlign: "center" }}>{`${props.text} · ${time(props.at)}`}</Text>
  );
}
