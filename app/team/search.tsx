// Search: messages and tasks with all the words, in every channel (the server's full-text index; Chinese works with
// any three characters, shorter words too). A result opens its channel with its thread.
import { cleanup, Scroll, signal, Text, View } from "nsh";
import { L } from "../i18n";
import { colors, hovered, Icon, Spinner } from "../ui";
import { channelLabel, type Message, type Task, type Team } from "./api";
import { STATUS, statusOf } from "./status";
import { authorOf, Avatar, Field, Header, time } from "./ui";

export function SearchPage(props: { team: Team; back: boolean; onBack: () => void; onOpen: (channelId: string, threadId: string | null) => void }) {
  const t = props.team;
  const q = signal("");
  const busy = signal(false);
  const found = signal<{ messages: Message[]; tasks: Task[] } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined, asked = 0;
  cleanup(() => clearTimeout(timer));
  function look(v: string) {
    q.set(v);
    clearTimeout(timer);
    if (!v.trim()) { found.set(null); return; }
    timer = setTimeout(async () => {
      const n = ++asked;
      busy.set(true);
      const r = await t.search(v.trim());
      if (n !== asked) return; // a later search is on its way
      busy.set(false);
      found.set(r ?? { messages: [], tasks: [] });
    }, 300);
  }
  const channelName = (id: string) => { const c = t.channels().find((x) => x.id === id); return c ? channelLabel(c) : ""; };
  const nothing = () => !!found() && !found()!.messages.length && !found()!.tasks.length;
  return (
    <View style={{ flex: 1 }}>
      <Header title={L("Search", "搜索")} back={props.back} onBack={props.onBack} />
      <View style={{ paddingHorizontal: 16, paddingTop: 14, maxWidth: 640 }}>
        <Field value={q()} onChange={look} placeholder={L("Words in messages, tasks, file names", "消息、任务、文件名里的词")} testID="search-input" autoFocus />
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 6, maxWidth: 640 }}>
        <If when={busy()}>
          <Spinner size={16} tint={colors.muted} />
        </If>
        <If when={nothing()}>
          <Text testID="search-empty" style={{ padding: 24, fontSize: 14.5, color: colors.muted, textAlign: "center" }}>{L("Nothing found.", "没有找到。")}</Text>
        </If>
        <If when={found()?.tasks.length}>
          <Text style={{ paddingTop: 4, fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("TASKS", "任务")}</Text>
          <Each of={found()!.tasks} key={(x) => x.id}>
            {(x) => (
              <View
                role="button"
                testID={`search-task-${x().id}`}
                onPress={() => props.onOpen(x().channel_id, x().thread_id)}
                hoverStyle={hovered()}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8 }}
              >
                <Icon name="lists" size={15} tint={colors.muted} />
                <Text style={{ fontSize: 13, color: colors.faint }}>{x().id}</Text>
                <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{x().title}</Text>
                <Text style={{ fontSize: 12.5, color: colors.muted }}>{STATUS[statusOf(x().state).status].label()} · {channelName(x().channel_id)}</Text>
              </View>
            )}
          </Each>
        </If>
        <If when={found()?.messages.length}>
          <Text style={{ paddingTop: 10, fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{L("MESSAGES", "消息")}</Text>
          <Each of={found()!.messages} key={(m) => m.id}>
            {(m) => {
              const a = () => authorOf(t, m().author);
              return (
                <View
                  role="button"
                  testID={`search-msg-${m().id}`}
                  onPress={() => props.onOpen(m().channel_id, m().thread_id ?? (m().reply_count ? m().id : null))}
                  hoverStyle={hovered()}
                  style={{ flexDirection: "row", gap: 10, padding: 10, borderRadius: 8 }}
                >
                  <Avatar name={a().name} agent={a().agent} size={28} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={{ fontSize: 12.5, color: colors.faint }}>
                      {`${channelName(m().channel_id)}${m().thread_id ? L(" · in a thread", " · 线程里") : ""} · ${a().name} · ${time(m().created)}`}
                    </Text>
                    <Text style={{ fontSize: 14.5, lineHeight: 21, color: colors.text, numberOfLines: 3 }}>{m().text || L("(a file)", "（文件）")}</Text>
                  </View>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>
    </View>
  );
}
