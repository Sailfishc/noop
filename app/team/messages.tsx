// A message: its text with @mentions, its files (thumbnails, text previews), reactions and task card.
import { Clipboard, Image, openUrl, signal, Text, View } from "nsh";
import { TextView, type MarkdownExtension } from "nsh/base";
import { L } from "../i18n";
import { alpha, Avatar, colors, hovered, Icon } from "../ui";
import { type Attachment, type Mention, type Message, type Team } from "./api";
import { RemindMenu } from "./reminders";
import { authorOf, RuntimeBadge, time } from "./ui";
import { fileSize } from "./composer";
import { TaskCard, TrackLink, shownAsTask } from "./taskcard";

/** @handles in a message: a custom node, shown in the accent color when it names someone. */
const MENTION: MarkdownExtension[] = [{ name: "mention", pattern: "@[a-z][a-z0-9_-]{1,31}" }];

/**
 * A document's mention nodes as spans of its own text: a known one is a `highlight` (styled as a mention below),
 * any other `@word` plain text. Not `renderCustom`: that makes each mention an inline attachment, a view of its own
 * on the line, which the macOS app sometimes left blank (the thread panel showed a gap where "@cindy" was, the text
 * after it pushed right of the reactions under it). Spans are drawn with the line.
 */
function withMentions(node: any, known: Set<string>): any {
  if (Array.isArray(node)) return node.map((n) => withMentions(n, known));
  if (!node || typeof node !== "object") return node;
  if (node.type === "custom" && node.name === "mention") {
    const text = node.text ?? "";
    return known.has(text) ? { type: "highlight", content: [{ type: "text", text }] } : { type: "text", text };
  }
  const out: any = {};
  for (const k of Object.keys(node)) out[k] = withMentions(node[k], known);
  return out;
}

/** A message's text as Markdown (what the formatting buttons write), its @mentions highlighted. */
function MessageText(props: { text: string; mentions: readonly Mention[] | null }) {
  const known = () => new Set((props.mentions ?? []).map((m) => `@${m.handle}`));
  return (
    <TextView
      testID="message-text"
      document={withMentions(TextView.parse(props.text, { math: false, html: false }, MENTION), known())}
      selectable
      onLinkPress={({ url }) => { if (/^(https?|mailto):/i.test(url)) void openUrl(url).catch(() => {}); }}
      styles={{
        root: { gap: 6, fontSize: 15, lineHeight: 22, color: colors.text },
        code: { fontFamily: "monospace", fontSize: 13.5, color: colors.text, backgroundColor: alpha(colors.text, 0.07) },
        link: { color: colors.accent },
        highlight: { color: colors.accent, fontWeight: "500", backgroundColor: "transparent" },
      }}
    />
  );
}

/** A message's files: pictures in place, other files as a row to open; links come from the server when shown. */
function MessageFiles(props: { team: Team; messageId: string }) {
  const list = signal<Attachment[]>([]);
  void props.team.attachments(props.messageId).then((a) => list.set(a));
  const pictures = () => list().filter((a) => a.mime.startsWith("image/") && a.url);
  const texts = () => list().filter((a) => !a.mime.startsWith("image/") && a.preview);
  const others = () => list().filter((a) => (!a.mime.startsWith("image/") || !a.url) && !a.preview);
  const open = (a: Attachment) => { if (a.url) void openUrl(a.url).catch(() => {}); };
  /** A picture's box: its shape, at most 360×240 (one alone) or 240×160 (several). */
  const box = (a: Attachment) => {
    const [mw, mh] = pictures().length === 1 ? [360, 240] : [240, 160];
    if (!a.width || !a.height) return { width: mw, height: mh, fit: "cover" as const };
    const k = Math.min(mw / a.width, mh / a.height, 1);
    return { width: Math.max(48, Math.round(a.width * k)), height: Math.max(48, Math.round(a.height * k)), fit: "contain" as const };
  };
  return (
    <View testID={`files-${props.messageId}`} style={{ gap: 6, marginTop: 2 }}>
      <If when={pictures().length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Each of={pictures()} key={(a) => a.path}>
            {(a) => (
              <View role="link" testID="message-picture" accessibilityLabel={a().name} onPress={() => open(a())} style={{ borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
                <Image src={a().thumb ?? a().url!} accessibilityLabel={a().name} style={{ width: box(a()).width, height: box(a()).height, objectFit: box(a()).fit }} />
              </View>
            )}
          </Each>
        </View>
      </If>
      <Each of={texts()} key={(a) => a.path}>
        {(a) => <TextFile a={a()} onOpen={() => open(a())} />}
      </Each>
      <Each of={others()} key={(a) => a.path}>
        {(a) => (
          <View role="link" testID="message-file" accessibilityLabel={a().name} onPress={() => open(a())} hoverStyle={hovered()} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, maxWidth: 360 }}>
            <Icon name="file" size={16} tint={colors.muted} />
            <Text style={{ flexShrink: 1, fontSize: 13.5, color: colors.text, numberOfLines: 1 }}>{a().name}</Text>
            <Text style={{ fontSize: 11, fontWeight: "600", color: colors.muted }}>{fileKind(a())}</Text>
            <Text style={{ fontSize: 12, color: colors.faint }}>{fileSize(a().size)}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** "PDF", "ZIP", …: what kind of file, from its name (or type). */
function fileKind(a: Attachment): string {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(a.name)?.[1];
  return (ext ?? a.mime.split("/").pop() ?? "").toUpperCase();
}

/** A text file on a message: its first lines (8 until expanded, the server sends up to 40), and open for the rest. */
function TextFile(props: { a: Attachment; onOpen: () => void }) {
  const wide = signal(false);
  const lines = () => props.a.preview!.split("\n");
  const shown = () => (wide() ? lines() : lines().slice(0, 8)).join("\n");
  const cut = () => !wide() && lines().length > 8;
  return (
    <View testID="message-text-file" style={{ maxWidth: 560, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
      <View role="link" accessibilityLabel={props.a.name} onPress={props.onOpen} hoverStyle={hovered()} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Icon name="document" size={15} tint={colors.muted} />
        <Text style={{ flexShrink: 1, fontSize: 13.5, color: colors.text, numberOfLines: 1 }}>{props.a.name}</Text>
        <Text style={{ fontSize: 12, color: colors.faint }}>{fileSize(props.a.size)}</Text>
      </View>
      <Text testID="message-text-preview" style={{ paddingHorizontal: 10, paddingVertical: 8, fontFamily: "monospace", fontSize: 12.5, lineHeight: 18, color: colors.text }}>{shown()}</Text>
      <If when={cut() || props.a.more}>
        <View role="button" testID="message-text-more" onPress={() => (cut() ? wide.set(true) : props.onOpen())} hoverStyle={hovered()} style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text style={{ fontSize: 12.5, color: colors.accent }}>{cut() ? L(`Show ${lines().length} lines`, `展开 ${lines().length} 行`) : L("Open the whole file", "打开完整文件")}</Text>
        </View>
      </If>
    </View>
  );
}

/** A message's reactions, one chip per emoji with who put it there. */
function reactionGroups(t: Team, m: Message): { emoji: string; names: string[] }[] {
  const out: { emoji: string; names: string[] }[] = [];
  for (const r of m.reactions ?? []) {
    let g = out.find((x) => x.emoji === r.emoji);
    if (!g) out.push((g = { emoji: r.emoji, names: [] }));
    g.names.push(authorOf(t, r.author).name);
  }
  return out;
}

/** Copies a message's text (as written, Markdown and all); a check for a moment once it is on the clipboard. */
function CopyButton(props: { id: string; text: string }) {
  const done = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const copy = async () => {
    await Clipboard.writeText(props.text);
    done.set(true);
    clearTimeout(timer);
    timer = setTimeout(() => done.set(false), 1500);
  };
  const label = () => (done() ? L("Copied", "已复制") : L("Copy text", "复制文本"));
  return (
    <View role="button" testID={`copy-${props.id}`} accessibilityLabel={label()} tooltip={<Text>{label()}</Text>}
      onPress={() => void copy().catch(() => {})} hoverStyle={hovered()} style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
      <Icon name={done() ? "check" : "copy"} size={13} tint={done() ? colors.accent : colors.faint} />
    </View>
  );
}

export function MessageRow(props: { team: Team; m: Message; onThread?: () => void; noTask?: boolean }) {
  const a = () => authorOf(props.team, props.m.author);
  const agent = () => (props.m.author.kind === "agent" ? props.team.agents().find((x) => x.id === props.m.author.id) : undefined);
  const note = signal("");
  return (
    <View testID={`msg-${props.m.id}`} style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
      <Avatar name={a().name} agent={a().agent} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: 14.5, fontWeight: "600", color: colors.text }}>{a().name}</Text>
          <If when={agent()}>
            {(ag) => <RuntimeBadge runtime={ag().runtime} />}
          </If>
          <Text style={{ fontSize: 12, color: colors.faint }}>{time(props.m.created)}{props.m.edited ? L(" · edited", " · 已编辑") : ""}</Text>
          <View style={{ flex: 1 }} />
          <If when={props.m.text.trim()}>
            <CopyButton id={props.m.id} text={props.m.text} />
          </If>
          <RemindMenu team={props.team} messageId={props.m.id} onError={(e) => note.set(e)} />
        </View>
        <If when={note()}>
          <Text testID={`msg-${props.m.id}-note`} style={{ fontSize: 12.5, color: colors.danger }}>{note()}</Text>
        </If>
        <If when={props.m.text.trim()}>
          <MessageText text={props.m.text} mentions={props.m.mentions} />
        </If>
        <If when={props.m.attachments?.length ? props.m.id : null}>
          {(id) => <MessageFiles team={props.team} messageId={id()} />}
        </If>
        <If when={reactionGroups(props.team, props.m).length ? reactionGroups(props.team, props.m) : null}>
          {(groups) => (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 2 }}>
              <Each of={groups()} key={(g) => g.emoji}>
                {(g) => (
                  <View testID={`msg-${props.m.id}-reaction`} accessibilityLabel={`${g().emoji} ${g().names.join("、")}`} style={{ height: 24, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
                    <Text style={{ fontSize: 13 }}>{g().emoji}</Text>
                    <Text style={{ fontSize: 12, color: colors.muted }}>{g().names.length > 1 ? String(g().names.length) : g().names[0]}</Text>
                  </View>
                )}
              </Each>
            </View>
          )}
        </If>
        <If when={!props.noTask}>
          <Each of={props.team.taskOfThread(props.m.id)} key={(x) => x.id}>
            {(task) => <If when={shownAsTask(task())} else={<TrackLink team={props.team} task={task()} />}><TaskCard team={props.team} task={task()} /></If>}
          </Each>
        </If>
        <If when={props.onThread}>
          <View role="button" testID={`thread-${props.m.id}`} onPress={() => props.onThread!()} hoverStyle={hovered()} style={{ alignSelf: "flex-start", height: 26, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6, marginLeft: -6, borderRadius: 6 }}>
            <Icon name="reply" size={14} tint={props.m.reply_count ? colors.accent : colors.faint} />
            <Text style={{ fontSize: 13, color: props.m.reply_count ? colors.accent : colors.faint }}>
              {props.m.reply_count ? L(`${props.m.reply_count} replies`, `${props.m.reply_count} 条回复`) : L("Reply in thread", "在线程里回复")}
            </Text>
          </View>
        </If>
      </View>
    </View>
  );
}
