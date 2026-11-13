// Right-hand workspace panel ("工作面板", Spec §8): opens one item's conversation, plan checklist, and outputs.
import { effect, Image, openUrl, Scroll, signal, View } from "nsh";
import { L } from "../i18n";
import { Btn, Card, Choice, colors, Divider, DocView, Empty, ErrorNote, FoldLine, IconBtn, OutputRow, PlanList, Spinner, Tabs, Txt } from "../ui";
import { isMember, type Message, type Output, type Reminder, type Team } from "./api";
import { Composer } from "./composer";
import { MessageRow } from "./messages";
import { outputMeta, outputsOf, shownAsTask, TaskCard, TEXTISH } from "./taskcard";
import { Header, time } from "./ui";

export type WorkTab = "chat" | "plan" | "outputs";

const isMarkdown = (o: Output) =>
  (o.mime ?? "").startsWith("text/markdown") || /\.(md|markdown)$/i.test(o.name ?? o.title);

const isTextSource = (o: Output) =>
  TEXTISH.test(o.mime ?? "") || /\.(txt|json|ya?ml|csv|toml|ts|tsx|js|jsx|go|py|sh|html?|css|sql|xml)$/i.test(o.name ?? "");

const isPicture = (o: Output) =>
  (o.kind === "file" && (o.mime ?? "").startsWith("image/")) || !!o.preview;

/** One output's viewer inside the workspace panel: Markdown doc, code/HTML source, zoomable image, version switcher. */
function OutputViewer(props: { team: Team; output: Output }) {
  const t = props.team;
  const o = () => props.output;
  const latestVersion = () => Math.max(o().version ?? 1, ...(o().versions ?? []).map((v) => v.version));
  const versionNums = () => {
    const n = o().kind === "file" ? latestVersion() : 1;
    return n > 1 ? Array.from({ length: n }, (_, i) => i + 1) : [];
  };
  const pickedVersion = signal(0);
  const zoomed = signal(false);
  const loading = signal(false);
  const error = signal("");
  const textBody = signal<string | null>(null);
  const pictureUrl = signal<string | null>(null);

  let loadSeq = 0;
  async function load(out: Output, ver: number) {
    const mySeq = ++loadSeq;
    error.set("");
    textBody.set(null);
    pictureUrl.set(null);
    const wantVer = ver > 0 && ver !== (out.version ?? 1) ? ver : undefined;
    if (out.kind === "file" && (isMarkdown(out) || isTextSource(out))) {
      loading.set(true);
      const url = await t.outputLink(out.id, wantVer ? { version: wantVer } : {});
      const r = url ? await fetch(url).catch(() => null) : null;
      if (mySeq !== loadSeq) return;
      loading.set(false);
      if (!r?.ok) {
        error.set(L("Couldn’t load it.", "加载失败。"));
        return;
      }
      const raw = await r.text();
      if (mySeq !== loadSeq) return;
      textBody.set(raw.length > 40000 ? raw.slice(0, 40000) + "\n…" : raw);
      return;
    }
    if (isPicture(out)) {
      loading.set(true);
      const url = await t.outputLink(out.id, out.kind === "file" ? (wantVer ? { version: wantVer } : {}) : { preview: true });
      if (mySeq !== loadSeq) return;
      loading.set(false);
      if (!url) {
        error.set(L("Couldn’t load it.", "加载失败。"));
        return;
      }
      pictureUrl.set(url);
    }
  }

  effect(() => {
    const out = o();
    const ver = pickedVersion() || (out.version ?? 1);
    void load(out, ver);
  });

  // Reset version & zoom whenever switching to another output id.
  let prevId = "";
  effect(() => {
    const id = o().id;
    if (id !== prevId) {
      prevId = id;
      pickedVersion.set(o().version ?? 1);
      zoomed.set(false);
    }
  });

  async function openExternal() {
    const out = o();
    if (out.kind !== "file") {
      if (out.url) void openUrl(out.url);
      return;
    }
    const ver = pickedVersion();
    const wantVer = ver > 0 && ver !== (out.version ?? 1) ? ver : undefined;
    const url = await t.outputLink(out.id, wantVer ? { version: wantVer } : {});
    if (url) void openUrl(url);
    else error.set(L("Couldn’t make a link.", "没能生成链接。"));
  }

  const activeVer = () => String(pickedVersion() || latestVersion());

  return (
    <View testID={`work-viewer-${o().id}`} style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Txt weight="semibold" lines={1} grow>{o().title}</Txt>
        <If when={versionNums().length > 1}>
          <Choice
            testID="work-output-version"
            value={activeVer()}
            onChange={(v) => pickedVersion.set(Number(v))}
            options={versionNums().map((v) => ({ value: String(v), label: `v${v}` }))}
          />
        </If>
        <If when={isPicture(o())}>
          <Btn
            small
            kind="ghost"
            testID="work-output-zoom"
            label={zoomed() ? L("Fit", "适应窗口") : L("Zoom in", "放大")}
            onPress={() => zoomed.update((z) => !z)}
          />
        </If>
        <If when={o().kind === "file" || !!o().url}>
          <Btn
            small
            kind="ghost"
            testID="work-output-open"
            label={o().kind === "file" ? L("Download", "下载") : L("Open", "打开")}
            onPress={() => void openExternal()}
          />
        </If>
      </View>
      <ErrorNote text={error()} testID="work-output-error" />
      <If when={loading()}>
        <View style={{ padding: 16, alignItems: "center" }}>
          <Spinner size={16} tint={colors.fg2} />
        </View>
      </If>
      <If when={!loading() && textBody() !== null}>
        <If when={isMarkdown(o())} else={
          <Card testID="work-output-code-card">
            <Txt testID="work-output-code" mono>{textBody() ?? ""}</Txt>
          </Card>
        }>
          <DocView testID="work-output-doc" text={textBody() ?? ""} />
        </If>
      </If>
      <If when={!loading() ? pictureUrl() : null}>
        {(src) => (
          <Card tight>
            <Image
              testID="work-output-image"
              src={src()}
              accessibilityLabel={o().title}
              style={{ width: "100%", height: zoomed() ? 520 : 240, objectFit: "contain" }}
            />
          </Card>
        )}
      </If>
    </View>
  );
}

export function WorkPanel(props: {
  team: Team;
  rootId: string;
  initialTab?: WorkTab;
  initialOutputId?: string;
  openAt?: number;
  back?: boolean;
  onClose: () => void;
}) {
  const t = props.team;
  const root = signal<Message | null>(null);
  const tab = signal<WorkTab>(props.initialTab ?? "chat");
  const selectedOutputId = signal<string>(props.initialOutputId ?? "");

  effect(() => {
    const id = props.rootId;
    root.set(null);
    void t.openThread(id).then((m) => root.set(m));
  });

  effect(() => {
    // Re-sync tab and selected output whenever opened on a root, tab, or specific output card.
    void props.rootId;
    void props.openAt;
    tab.set(props.initialTab ?? "chat");
    selectedOutputId.set(props.initialOutputId ?? "");
  });

  const shown = () => {
    const r = root();
    return r ? (t.top()[r.channel_id] ?? []).find((m) => m.id === r.id) ?? r : null;
  };
  const replies = () => t.threads()[props.rootId] ?? [];
  const channel = () => {
    const r = root();
    return r ? t.channels().find((x) => x.id === r.channel_id) : undefined;
  };
  const member = () => {
    const c = channel(), me = t.me();
    return !!c && !!me && isMember(c, "user", me.id);
  };
  const tasks = () => t.taskOfThread(props.rootId);
  const planTask = () => tasks().find((x) => (x.plan?.length ?? 0) > 0) ?? tasks().find((x) => !!x.step) ?? null;
  const expandedMsgs = signal<Record<string, boolean>>({});
  const openChecks = signal<Record<string, boolean>>({});

  /** Deduplicated outputs across the root message, replies, and tasks in this thread. */
  const allOutputs = () => {
    const map = new Map<string, Output>();
    const put = (o: Output) => {
      const prev = map.get(o.id);
      if (!prev || (o.version ?? 0) >= (prev.version ?? 0)) map.set(o.id, o);
    };
    for (const o of shown()?.outputs ?? []) put(o);
    for (const m of replies()) for (const o of m.outputs ?? []) put(o);
    for (const tk of tasks()) for (const o of outputsOf(tk)) put(o);
    return [...map.values()];
  };

  const activeOutput = () => {
    const list = allOutputs();
    const id = selectedOutputId();
    return list.find((o) => o.id === id) ?? list[0] ?? null;
  };

  const openOutputInPanel = (o: Output) => {
    selectedOutputId.set(o.id);
    tab.set("outputs");
  };

  const checkedReminders = () => {
    const out: Reminder[] = [];
    const seen = new Set<string>();
    for (const x of tasks()) {
      for (const r of x.reminders ?? []) {
        if ((r.checks ?? 0) > 0 && !seen.has(r.id)) {
          seen.add(r.id);
          out.push(r);
        }
      }
    }
    return out;
  };

  const checkSummary = (r: Reminder) => {
    const n = r.checks ?? 0;
    const at = r.runs?.[0]?.at ?? r.fired ?? r.created;
    const last = r.last_outcome === "nothing" ? L("no change", "没有变化")
      : r.last_outcome === "failed" ? L("failed", "失败")
      : L("reported", "有变化");
    return L(`Checked ${n}×, last ${time(at)}, ${last}`, `已检查 ${n} 次，最近一次 ${time(at)}，${last}`);
  };

  return (
    <View testID="thread" style={{ flex: 1, backgroundColor: colors.page }}>
      <Header
        title={L("Workspace", "工作面板")}
        subtitle={channel() ? (channel()!.dm_agent ? `@${channel()!.name}` : `# ${channel()!.name}`) : undefined}
        back={props.back}
        onBack={props.onClose}
        right={props.back ? undefined : (
          <IconBtn testID="close-thread" label={L("Close workspace", "关闭工作面板")} icon="close" tone="muted" onPress={props.onClose} />
        )}
      />
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }}>
        <Tabs
          testID="work-tab"
          value={tab()}
          onChange={tab.set}
          tabs={[
            { value: "chat", label: L("Conversation", "对话") },
            { value: "plan", label: L("Plan", "计划"), count: planTask()?.plan?.length || undefined },
            { value: "outputs", label: L("Outputs", "产出"), count: allOutputs().length || undefined },
          ]}
        />
      </View>
      <Divider />
      <If when={shown()} else={<View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Spinner size={18} tint={colors.fg2} /></View>}>
        {(r) => (
          <>
            <If when={tab() === "chat"}>
              <Scroll style={{ flex: 1 }} contentStyle={{ paddingVertical: 8 }}>
                <Each of={tasks().filter(shownAsTask)} key={(x) => x.id}>
                  {(x) => (
                    <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
                      <TaskCard team={t} task={x()} detail />
                    </View>
                  )}
                </Each>
                <MessageRow
                  team={t}
                  m={r()}
                  noTask
                  foldable
                  expanded={!!expandedMsgs()[r().id]}
                  onToggleExpand={() => expandedMsgs.update((v) => ({ ...v, [r().id]: !v[r().id] }))}
                  onOpenOutput={openOutputInPanel}
                />
                <Divider inset spaced />
                <Each of={replies()} key={(m) => m.id}>
                  {(m) => (
                    <MessageRow
                      team={t}
                      m={m()}
                      foldable
                      expanded={!!expandedMsgs()[m().id]}
                      onToggleExpand={() => expandedMsgs.update((v) => ({ ...v, [m().id]: !v[m().id] }))}
                      onOpenOutput={openOutputInPanel}
                    />
                  )}
                </Each>
                <Each of={checkedReminders()} key={(rem) => rem.id}>
                  {(rem) => (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
                      <FoldLine
                        testID={`check-${rem().id}`}
                        icon="bell"
                        label={checkSummary(rem())}
                        open={!!openChecks()[rem().id]}
                        onToggle={() => openChecks.update((v) => ({ ...v, [rem().id]: !v[rem().id] }))}
                      >
                        <>
                          <Each of={rem().runs ?? []} key="index">
                            {(run) => (
                              <Txt variant="caption" tone="muted">
                                {[
                                  time(run().at),
                                  run().outcome === "nothing" ? L("no change", "没有变化") : run().outcome === "failed" ? L("failed", "失败") : L("reported", "已汇报"),
                                  run().note ?? "",
                                ].filter(Boolean).join(" · ")}
                              </Txt>
                            )}
                          </Each>
                        </>
                      </FoldLine>
                    </View>
                  )}
                </Each>
              </Scroll>
              <If when={member()}>
                <Composer team={t} channelId={r().channel_id} threadId={r().id} testID="thread-composer" placeholder={L("Reply…", "回复…")} onSend={(text, files) => t.send(r().channel_id, text, r().id, files)} />
              </If>
            </If>
            <If when={tab() === "plan"}>
              <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 12 }}>
                <If when={planTask()} else={
                  <View style={{ padding: 24, alignItems: "center" }}>
                    <Empty testID="work-plan-empty" />
                  </View>
                }>
                  {(pt) => (
                    <PlanList
                      testID="work-plan"
                      items={pt().plan ?? []}
                      step={pt().step || undefined}
                      running={pt().state === "running"}
                    />
                  )}
                </If>
              </Scroll>
            </If>
            <If when={tab() === "outputs"}>
              <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 12 }}>
                <If when={allOutputs().length} else={
                  <View style={{ padding: 24, alignItems: "center" }}>
                    <Empty testID="work-outputs-empty" />
                  </View>
                }>
                  <View style={{ gap: 6 }}>
                    <Each of={allOutputs()} key={(o) => o.id}>
                      {(o) => {
                        const meta = () => outputMeta(o());
                        return (
                          <OutputRow
                            testID={`work-output-${o().id}`}
                            icon={meta().icon}
                            title={o().title}
                            meta={meta().meta}
                            tone={meta().tone}
                            selected={activeOutput()?.id === o().id}
                            onPress={() => selectedOutputId.set(o().id)}
                          />
                        );
                      }}
                    </Each>
                  </View>
                  <If when={activeOutput()}>
                    {(out) => <OutputViewer team={t} output={out()} />}
                  </If>
                </If>
              </Scroll>
            </If>
          </>
        )}
      </If>
    </View>
  );
}
