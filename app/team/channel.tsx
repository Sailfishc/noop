// A channel: its conversation, the members panel, the default repository, a thread with its task's facts, and a new channel.
import { effect, List, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { L } from "../i18n";
import { alpha, Avatar, Btn, colors, Dot, ErrorNote, Field, hovered, Icon, Noted, radius, Spinner, Tabs, Tag, TextArea, Toggle, Txt } from "../ui";
import { agentHost, errorOf, machineNow, isMember, mayBringAgent, repoLabel, type Agent, type Member, type Message, type Task, type Team } from "./api";
import { LayoutSwitch, rememberedLayout, TaskBoard, trackedTasks } from "./tasks";
import { agentState, authorOf, failed, Header, RuntimeBadge, time, unreachable } from "./ui";
import { RepoPicker } from "./taskfacts";
import { ChannelTriggers } from "./duties";
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
  /** A private chat: its agent (null once deleted), and why it takes no more messages ("" = it does). */
  const dmAgent = () => { const id = channel()?.dm_agent; return id ? t.agents().find((a) => a.id === id) ?? null : null; };
  const dmClosed = () => {
    const c = channel();
    if (!c?.dm_agent) return "";
    const a = dmAgent();
    if (!a) return L("This agent was deleted. The chat keeps its history.", "这个 Agent 已经删除，私聊只能看历史。");
    return mayBringAgent(a, t.me()) ? "" : L(`@${a.handle} no longer takes your work. The chat keeps its history.`, `@${a.handle} 不再接你的活，私聊只能看历史。`);
  };
  const joining = signal(false);
  /** Conversation | Tasks (as in Raft: the channel's tasks as a board or a list). */
  const tab = signal<"chat" | "tasks">("chat");
  const layout = rememberedLayout("channel");
  effect(() => { if (tab() === "tasks") void t.loadTasks(props.id); });
  const channelTasks = () => trackedTasks(t).filter((x) => x.channel_id === props.id);
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={channel()?.dm_agent ? dmAgent()?.name ?? `@${channel()!.name}` : channel()?.private ? channel()!.name : `# ${channel()?.name ?? ""}`}
        icon={channel()?.dm_agent ? "bubble" : channel()?.private ? "lock" : undefined}
        iconLabel={channel()?.dm_agent ? L("Private chat", "私聊") : L("Private channel", "私有频道")}
        subtitle={channel()?.dm_agent ? dmSubtitle(t, dmAgent()) : [channel()?.topic, channel()?.repo ? repoLabel(channel()!.repo!) : ""].filter(Boolean).join(" · ") || undefined}
        back={props.back}
        onBack={props.onBack}
        right={channel()?.dm_agent ? undefined : 
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
        <Tabs
          testID="channel-tab"
          value={tab()}
          onChange={tab.set}
          tabs={[
            { value: "chat", label: L("Conversation", "对话") },
            { value: "tasks", label: L("Tasks", "任务"), count: channelTasks().filter((x) => !["done", "closed"].includes(x.state)).length },
          ]}
        />
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
          empty={<Text style={{ padding: 24, fontSize: 14.5, color: colors.muted, textAlign: "center" }}>{channel()?.dm_agent ? L("No messages yet. Say what you need; no @ needed.", "还没有消息。直接说要它做什么，不用 @。") : L("No messages yet. Say hello, or @ an agent to give it work.", "还没有消息。打个招呼，或者 @ 一个 Agent 给它派活。")}</Text>}
          style={{ flex: 1 }}
        >
          {(m) => <MessageRow team={t} m={m()} onThread={() => props.onThread(m().id)} />}
        </List>
        <If
          when={member()}
          else={
            // a private channel takes no joining (its members bring people in), and one sees it only when in it
            <If when={!channel()?.private}>
              <View style={{ padding: 14, gap: 8, alignItems: "center", borderTopWidth: 1, borderTopColor: colors.border }}>
                <Text style={{ fontSize: 14, color: colors.muted }}>{L("You’re not in this channel.", "你还不在这个频道里。")}</Text>
                <Btn testID="join" kind="primary" label={L("Join channel", "加入频道")} busy={joining()} onPress={async () => { joining.set(true); await t.join(props.id); joining.set(false); }} />
              </View>
            </If>
          }
        >
          <If when={!dmClosed()} else={<View style={{ padding: 12, borderTopWidth: 1, borderTopColor: colors.border }}><Txt testID="dm-closed" tone="muted" center>{dmClosed()}</Txt></View>}>
            <Composer
              team={t}
              channelId={props.id}
              testID="team-composer"
              placeholder={channel()?.dm_agent ? L(`Message ${dmAgent()?.name ?? ""}, no @ needed`, `直接跟 ${dmAgent()?.name ?? ""} 说，不用 @`) : L(`Message #${channel()?.name ?? ""}, @ an agent to hand it work`, `发到 #${channel()?.name ?? ""}，@Agent 给它派活`)}
              asTask
              agent={dmAgent()?.handle}
              onSend={(text, files, asTask) => t.send(props.id, text, null, files, asTask)}
            />
          </If>
        </If>
      </If>
    </View>
  );
}

/** A private chat's subtitle: where its agent runs, when that is someone else's computer (what is said goes there). */
function dmSubtitle(t: Team, a: Agent | null): string {
  if (!a) return L("Private chat", "私聊");
  return a.owner_id === t.me()?.id ? L("Private chat", "私聊") : L(`Private chat · runs on ${agentHost(t, a)}`, `私聊 · 运行在${agentHost(t, a)}上`);
}

/** A private chat not made yet: the agent's name, an empty page and a box. The first message makes it on the server. */
export function DMDraft(props: { team: Team; agent: Agent; back: boolean; onBack: () => void; onMade: (channelId: string) => void }) {
  const t = props.team;
  return (
    <View testID={`dm-draft-${props.agent.handle}`} style={{ flex: 1 }}>
      <Header title={props.agent.name} icon="bubble" iconLabel={L("Private chat", "私聊")} subtitle={dmSubtitle(t, props.agent)} back={props.back} onBack={props.onBack} />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
        <Avatar name={props.agent.name} agent size={44} />
        <Txt variant="message" tone="muted" center>{L(`Only you and @${props.agent.handle} see this chat. Say what you need; no @ needed.`, `这个私聊只有你和 @${props.agent.handle} 看得到。直接说要它做什么，不用 @。`)}</Txt>
      </View>
      <Composer
        team={t}
        channelId=""
        testID="team-composer"
        placeholder={L(`Message ${props.agent.name}, no @ needed`, `直接跟 ${props.agent.name} 说，不用 @`)}
        asTask
        agent={props.agent.handle}
        onSend={async (text, files, asTask) => {
          const r = await t.openDM(props.agent.id);
          if (!r.ok) return errorOf(r, L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
          const err = await t.send(r.data.id, text, null, files, asTask);
          if (!err) props.onMade(r.data.id);
          return err;
        }}
      />
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
      <Noted
        testID="channel-repo-head"
        label={<Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("USUAL REPOSITORY", "常用仓库")}</Text>}
        note={L("A hint for agents: tasks start without a repository, and the agent checks one out when the work needs changes there. A repository named in the message is used from the start.", "给 Agent 的提示：任务开始时不带仓库，Agent 判断要改代码时再检出。消息里写了仓库地址的，一开始就用那个。")}
      />
      <If when={!editing()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text testID="channel-repo-label" style={{ flex: 1, fontSize: 13.5, color: repo() ? colors.text : colors.muted }}>
            {repo() ? repoLabel(repo()) : L("None", "没有")}
          </Text>
          <Btn small kind="ghost" testID="channel-repo-edit" label={repo() ? L("Change", "更换") : L("Set", "设置")} onPress={() => editing.set(true)} />
        </View>
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
 * reads it with its task (before the team's AGENTS.md).
 *
 * Shown as text in a box; a press on the box opens the editor, focused, as the acceptance criteria do. On the Mac an
 * always-mounted multiline Input here took no clicks (2026-11-10/11, never seen on the web): the press now goes to a
 * plain view, and the input that appears takes the focus by itself. While it is open, live updates of the channel do
 * not touch what is being typed. */
function ChannelConventions(props: { team: Team; channelId: string }) {
  const t = props.team;
  const channel = () => t.channels().find((c) => c.id === props.channelId);
  const now = () => (channel()?.conventions ?? "").trim();
  const editing = signal(false);
  const draft = signal("");
  const busy = signal(false);
  const error = signal("");
  const box = { padding: 8, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.field } as const;
  function edit() {
    draft.set(untracked(now));
    error.set("");
    editing.set(true);
  }
  async function save() {
    busy.set(true);
    error.set("");
    const r = await t.patchChannel(props.channelId, { conventions: draft().trim() });
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    editing.set(false);
  }
  return (
    <View testID="channel-conventions" style={{ gap: 6, paddingTop: 10 }}>
      <Noted
        testID="channel-conventions-head"
        label={<Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("HOW WE WORK HERE", "频道约定")}</Text>}
        note={L("Every agent working in this channel reads this with its task.", "在这个频道干活的 Agent 每次开工都会读。")}
      />
      <If when={!editing()}>
        <View
          role="button"
          testID="channel-conventions-box"
          accessibilityLabel={L("Edit how we work here", "编辑频道约定")}
          onPress={edit}
          hoverStyle={{ borderColor: colors.faint }}
          style={{ ...box, minHeight: 64 }}
        >
          <Text testID="channel-conventions-text" style={{ fontSize: 13, lineHeight: 19, color: now() ? colors.text : colors.faint }}>
            {now() || L("- PR titles in Chinese\n- Say so in #ops before a release", "- PR 标题用中文\n- 发布前在 #ops 说一声")}
          </Text>
        </View>
      </If>
      <If when={editing()}>
        <View style={{ gap: 6 }}>
          <TextArea
            testID="channel-conventions-input"
            value={draft()}
            min={64}
            max={200}
            autoFocus
            placeholder={L("- PR titles in Chinese\n- Say so in #ops before a release", "- PR 标题用中文\n- 发布前在 #ops 说一声")}
            onChange={draft.set}
          />
          <ErrorNote text={error()} />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Btn small kind="ghost" testID="channel-conventions-cancel" label={L("Cancel", "取消")} onPress={() => editing.set(false)} />
            <Btn small kind="primary" testID="channel-conventions-save" label={L("Save", "保存")} busy={busy()} disabled={draft().trim() === now()} onPress={() => void save()} />
          </View>
        </View>
      </If>
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
  /** Another person's agent waiting to be brought into a private channel, once its host is said. */
  const confirming = signal<Agent | null>(null);
  /** Making it public: asked once more, as everyone will read its history. */
  const publishing = signal(false);
  const busy = signal(false);
  const priv = () => !!channel()?.private;
  const mayBring = (a?: Agent) => !a || !priv() || mayBringAgent(a, t.me());
  async function add(m: Member) {
    error.set("");
    const a = m.kind === "agent" ? t.agents().find((x) => x.id === m.id) : undefined;
    if (a && priv() && a.owner_id !== t.me()?.id && confirming()?.id !== a.id) return confirming.set(a);
    confirming.set(null);
    const r = await t.addMember(props.channelId, m);
    if (!r.ok) error.set(failed(r));
  }
  async function publish() {
    busy.set(true);
    error.set("");
    const r = await t.patchChannel(props.channelId, { private: false });
    busy.set(false);
    if (!r.ok) return error.set(failed(r));
    publishing.set(false);
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
        subtitle={channel()?.private ? L(`${channel()!.name} (private)`, `${channel()!.name}（私有）`) : `# ${channel()?.name ?? ""}`}
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
        <ChannelTriggers team={t} channelId={props.channelId} agents={agents()} />
        <If when={adding()}>
          <View style={{ gap: 2, marginTop: 10, padding: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}>
            <If when={outside().length} else={<Text style={{ padding: 8, fontSize: 13, color: colors.muted }}>{L("Everyone is already here.", "大家都在这个频道里了。")}</Text>}>
              <Each of={outside()} key={(o) => `${o.m.kind}:${o.m.id}`}>
                {(o) => (
                  <If when={mayBring(o().agent)} else={
                    // a private channel: someone else's agent that takes only its channels' work stays out
                    <View testID={`members-add-${o().handle}`} accessibilityState={{ disabled: true }} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 8, opacity: 0.55 }}>
                      <Avatar name={o().name} agent size={22} />
                      <View style={{ flex: 1 }}>
                        <Noted
                          testID={`members-add-${o().handle}-why`}
                          label={<Text style={{ flexShrink: 1, fontSize: 14, color: colors.text, numberOfLines: 1 }}>{o().name} <Text style={{ color: colors.muted }}>@{o().handle}</Text></Text>}
                          note={L("Only its owner can bring it into a private channel.", "只有它的主人能拉进私有频道。")}
                        />
                      </View>
                    </View>
                  }>
                    <View role="button" testID={`members-add-${o().handle}`} onPress={() => void add(o().m)} hoverStyle={hovered()} style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 8, borderRadius: 8 }}>
                      <Avatar name={o().name} agent={!!o().agent} size={22} />
                      <Text style={{ flex: 1, fontSize: 14, color: colors.text, numberOfLines: 1 }}>{o().name} <Text style={{ color: colors.muted }}>@{o().handle}</Text></Text>
                      <If when={o().agent}>{(a) => <RuntimeBadge runtime={a().runtime} />}</If>
                      <Icon name="plus" size={14} tint={colors.accent} />
                    </View>
                  </If>
                )}
              </Each>
              <If when={confirming()}>
                {(a) => (
                  <View testID="members-host-warning" style={{ gap: 8, margin: 4, padding: 10, borderRadius: 8, backgroundColor: alpha(colors.warn, 0.1) }}>
                    <Text style={{ fontSize: 13, lineHeight: 19, color: colors.text }}>
                      {L(`@${a().handle} runs on ${agentHost(t, a())}; this channel's messages go there.`, `@${a().handle} 运行在${agentHost(t, a())}上，频道内容会发到那里。`)}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Btn small kind="primary" testID="members-host-ok" label={L("Bring it in", "拉进来")} onPress={() => void add({ kind: "agent", id: a().id })} />
                      <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => confirming.set(null)} />
                    </View>
                  </View>
                )}
              </If>
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
                            <Dot tone={st().tone} />
                            <Text testID={`member-${a().handle}-state`} style={{ flex: 1, fontSize: 12, color: st().blocked ? colors.danger : colors.muted, numberOfLines: 1 }}>
                              {st().blocked ? st().label : [machineNow(t, a())?.name, st().label].filter(Boolean).join(" · ")}
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
        <If when={priv() && channel()?.created_by === t.me()?.id}>
          <View testID="channel-publish" style={{ gap: 6, paddingTop: 16 }}>
            <Noted
              testID="channel-publish-about"
              label={<Text style={{ fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("PRIVATE CHANNEL", "私有频道")}</Text>}
              note={L("Only its members see it, admins included. When the team should, make it public; its history comes along.", "只有成员看得到，管理员也一样。该给团队看时转为公开，历史都在。")}
              right={<If when={!publishing()}><Btn small testID="channel-publish-start" label={L("Make public", "转为公开")} onPress={() => publishing.set(true)} /></If>}
            />
            <If when={publishing()}>
              <View style={{ gap: 8, padding: 10, borderRadius: 8, backgroundColor: alpha(colors.warn, 0.1) }}>
                <Text testID="channel-publish-warning" style={{ fontSize: 13, lineHeight: 19, color: colors.text }}>
                  {L("Its whole history becomes visible to the team, for good.", "所有历史消息都会对全队可见，不能再转回私有。")}
                </Text>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  <Btn small kind="danger" testID="channel-publish-ok" label={L("Make it public", "确认转为公开")} busy={busy()} onPress={() => void publish()} />
                  <Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => publishing.set(false)} />
                </View>
              </View>
            </If>
          </View>
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
  /** Private: only its members see it. Then only agents one may bring (one's own, or the team's) are offered, and
   * another person's says where it runs: what is said there goes to that computer. */
  const priv = signal(false);
  const error = signal("");
  const busy = signal(false);
  const others = () => {
    const me = t.me();
    return [
      ...t.users().filter((u) => !u.disabled && u.id !== me?.id).map((u) => ({ m: { kind: "user", id: u.id } as Member, label: `${u.name} @${u.handle}`, note: "", agent: false })),
      ...t.agents().filter((a) => !priv() || mayBringAgent(a, me)).map((a) => ({ m: { kind: "agent", id: a.id } as Member, label: `${a.name} @${a.handle}`,
        note: priv() && a.owner_id !== me?.id ? L(`runs on ${agentHost(t, a)}`, `运行在${agentHost(t, a)}上`) : "", agent: true })),
    ];
  };
  const has = (m: Member) => picked().some((x) => x.kind === m.kind && x.id === m.id);
  async function create() {
    if (!name().trim() || busy()) return;
    busy.set(true);
    error.set("");
    const offered = new Set(others().map((o) => `${o.m.kind}:${o.m.id}`));
    const r = await t.createChannel(name().trim(), topic().trim(), picked().filter((m) => offered.has(`${m.kind}:${m.id}`)), priv());
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
        <Noted
          testID="channel-private"
          label={<Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{L("Private", "私有频道")}</Text>}
          note={L("Only its members see it in Remi, admins included; whoever runs the server can still get at the database file. It can be made public later, never private again.",
            "只有成员能在 Remi 里看到，管理员也一样；服务器管理员仍能接触数据库文件。以后可以转为公开，公开后不能再转回私有。")}
          right={<Toggle testID="channel-private-toggle" value={priv()} label={L("Private channel", "私有频道")} onChange={(v) => priv.set(v)} />}
        />
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
                <If when={o().note}>
                  <Text testID={`pick-${o().m.id}-host`} style={{ flex: 1, fontSize: 12.5, color: colors.warn, numberOfLines: 1 }}>{o().note}</Text>
                </If>
              </View>
            )}
          </Each>
        </View>
        <ErrorNote text={error()} testID="channel-error" />
        <Btn testID="channel-create" kind="primary" label={priv() ? L("Create private channel", "创建私有频道") : L("Create channel", "创建频道")} busy={busy()} disabled={!name().trim()} onPress={create} />
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
