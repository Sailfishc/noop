// The one registry of what a person can do from anywhere: the ⌘K palette lists it, the eight shortcuts run it, and
// the context menus (a right click, a held finger) show the commands about one thing. A command's name is the same
// in all three, and the verbs are the agent CLI's (`remi dispatch`, `delegate`, `ask`, `handoff`): 派任务 is
// dispatch. Shortcuts, eight only: ⌘K, G I, G T, J, K, Return, Escape, C (H in 待你决定 is remind later).
import { keymap, signal, untracked } from "nsh";
import { L } from "../i18n";
import type { IconName, PaletteItem } from "../ui";
import { isMember, mayBringAgent, type Agent, type Channel, type Team } from "./api";
import { APPEARANCES, appearance, pickAppearance, type Appearance } from "./appearance";

/** A command: an id, its name, its group in the palette, the words it also answers to, its keys, what it does. */
export type Cmd = PaletteItem & { run: () => void };

/** What the commands act on: the workspace's navigation. */
export type Nav = {
  team: Team;
  inbox: () => void;
  tasks: () => void;
  channel: (id: string) => void;
  chat: (agentId: string) => void;
  newChannel: () => void;
  settings: (tab?: "agents") => void;
  search: (query: string) => void;
  /** 派任务: write to `agent` in the open channel when it can be asked there, else in a private chat with it. */
  dispatch: (agent: Agent) => void;
  /** The channel open now, if any. */
  here: () => Channel | null;
};

const LOOK: Record<Appearance, () => string> = {
  system: () => L("Appearance: system", "外观：跟随系统"),
  light: () => L("Appearance: light", "外观：浅色"),
  dark: () => L("Appearance: dark", "外观：深色"),
  black: () => L("Appearance: black", "外观：纯黑"),
};

export const GROUP = { go: () => L("Go to", "前往"), act: () => L("Actions", "动作"), search: () => L("Search", "搜索") };

/** The agents a person may hand work to (the same as the @ picker's). */
const askable = (t: Team) => t.agents().filter((a) => mayBringAgent(a, t.me()));

/** 派任务给 @x: one command per agent. */
export function dispatchCmd(nav: Nav, a: Agent): Cmd {
  return { id: `dispatch-${a.handle}`, group: GROUP.act(), icon: "spark", label: L(`Dispatch to @${a.handle}`, `派任务给 @${a.handle}`), keywords: ["dispatch", "remi dispatch", "@", a.name, a.handle], run: () => nav.dispatch(a) };
}

/** Every command of the palette, in its groups: go to, actions, then the search of what was typed. */
export function paletteCommands(nav: Nav, query: string): Cmd[] {
  const t = nav.team;
  const me = t.me();
  const go: Cmd[] = [
    { id: "go-inbox", group: GROUP.go(), icon: "bell", label: L("Waiting for you", "待你决定"), keys: "G I", keywords: ["inbox", "triage"], run: nav.inbox },
    { id: "go-tasks", group: GROUP.go(), icon: "lists", label: L("My tasks", "我的任务"), keys: "G T", keywords: ["tasks"], run: nav.tasks },
    ...t.channels().filter((c) => !c.archived && !c.dm_agent && (!c.private || (!!me && isMember(c, "user", me.id))))
      .map((c): Cmd => ({ id: `go-channel-${c.slug}`, group: GROUP.go(), icon: c.private ? "lock" : "chat", label: `#${c.name}`, keywords: [c.slug], run: () => nav.channel(c.id) })),
    ...askable(t).filter((a) => a.owner_id === me?.id || !!t.dmWith(a.id))
      .map((a): Cmd => ({ id: `go-chat-${a.handle}`, group: GROUP.go(), icon: "bubble", label: L(`Chat with ${a.name}`, `和 ${a.name} 私聊`), keywords: [a.handle], run: () => nav.chat(a.id) })),
    { id: "go-settings", group: GROUP.go(), icon: "settings", label: L("Settings", "设置"), keys: keymap.label("mod+,"), run: () => nav.settings() },
  ];
  const act: Cmd[] = [
    ...askable(t).map((a) => dispatchCmd(nav, a)),
    { id: "new-channel", group: GROUP.act(), icon: "plus", label: L("New channel", "新建频道"), keywords: ["channel"], run: nav.newChannel },
    ...APPEARANCES.map((a): Cmd => ({ id: `look-${a}`, group: GROUP.act(), icon: "sun", label: LOOK[a](), keywords: ["appearance", "theme", "dark", "light"], checked: untracked(appearance) === a, run: () => pickAppearance(a) })),
  ];
  const q = query.trim();
  // the search is one group of results: what was typed, in messages and tasks
  const search: Cmd[] = q ? [{ id: "search", group: GROUP.search(), icon: "search", label: L(`Search messages for “${q}”`, `搜索消息：“${q}”`), keywords: [q], run: () => nav.search(q) }] : [];
  return [...go, ...act, ...search];
}

/** The commands about a channel (its row's context menu). */
export function channelCommands(nav: Nav, c: Channel): Cmd[] {
  return [
    { id: "open", group: "", icon: "chat", label: L("Open", "打开"), keys: "↵", run: () => nav.channel(c.id) },
    ...nav.team.agents().filter((a) => isMember(c, "agent", a.id) && mayBringAgent(a, nav.team.me())).slice(0, 4)
      .map((a): Cmd => ({ ...dispatchCmd(nav, a), run: () => { nav.channel(c.id); nav.dispatch(a); } })),
    { id: "search", group: "", icon: "search", label: L("Search…", "搜索…"), keys: keymap.label("mod+k"), run: () => nav.search("") },
  ];
}

/** The commands about an agent (its row's context menu). */
export function agentCommands(nav: Nav, a: Agent): Cmd[] {
  const mine = a.owner_id === nav.team.me()?.id;
  return [
    { id: "chat", group: "", icon: "bubble", label: L("Chat", "私聊"), keys: "↵", run: () => nav.chat(a.id) },
    dispatchCmd(nav, a),
    ...(mine ? [{ id: "settings", group: "", icon: "settings" as IconName, label: L("Agent settings", "Agent 设置"), run: () => nav.settings("agents") }] : []),
  ];
}

/**
 * The global shortcuts: ⌘K the palette, G then I 待你决定, G then T 我的任务, C 派任务 (the palette at its dispatch
 * commands). J, K, Return and Escape belong to the list that has the keys (待你决定). Not while typing.
 */
export function bindShortcuts(o: { palette: (query?: string) => void; inbox: () => void; tasks: () => void }) {
  const g = signal(0); // when G was pressed: the next key within a second finishes the pair
  const after = (f: () => void) => () => { if (Date.now() - untracked(g) < 1000) { g.set(0); f(); } };
  keymap.bind("mod+k", () => o.palette(), { when: "always" });
  keymap.bind({ g: () => g.set(Date.now()), i: after(o.inbox), t: after(o.tasks), c: () => o.palette("@") }, { when: "notEditing" });
}
