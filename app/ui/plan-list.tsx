import { View } from "nsh";
import { Dot } from "./dot";
import { Icon } from "./icons";
import { Card } from "./panel";
import { Spinner } from "./spinner";
import { colors, size, space } from "./theme";
import { Txt } from "./text";

export type PlanRowItem = { text: string; status: "pending" | "in_progress" | "done" };

/**
 * A runtime's live todo checklist inside the workspace panel ("计划", Spec §7): shows `done/total` at the top and
 * updates items in place without posting chat messages. Runtimes without a checklist fall back to `step`.
 */
export function PlanList(props: { items: readonly PlanRowItem[]; step?: string; running?: boolean; testID?: string }) {
  const doneCount = () => props.items.filter((x) => x.status === "done").length;
  return (
    <View testID={props.testID} style={{ gap: space.md }}>
      <If when={props.items.length} else={
        <If when={props.step}>
          <Card testID={props.testID ? `${props.testID}-step` : undefined}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <If when={props.running} else={<Dot on={false} />}>
                <Spinner size={size.icon.sm} tint={colors.fg} />
              </If>
              <Txt grow>{props.step ?? ""}</Txt>
            </View>
          </Card>
        </If>
      }>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Txt testID={props.testID ? `${props.testID}-ratio` : undefined} variant="caption" weight="semibold" tabular>
            {`${doneCount()}/${props.items.length}`}
          </Txt>
          <If when={props.step}>
            <Txt variant="caption" tone="muted" lines={1} grow>{props.step ?? ""}</Txt>
          </If>
        </View>
        <Card tight>
          <Each of={props.items} key="index">
            {(it, i) => (
              <View
                testID={props.testID ? `${props.testID}-item-${i()}` : undefined}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingVertical: space.xs }}
              >
                <View style={{ height: size.leading.body, justifyContent: "center" }}>
                  <If when={it().status === "done"} else={
                    <If when={it().status === "in_progress"} else={<Dot on={false} />}>
                      <If when={props.running} else={<Dot tone="default" />}>
                        <Spinner size={size.icon.sm} tint={colors.fg} />
                      </If>
                    </If>
                  }>
                    <Icon name="check" size={size.icon.sm} tint={colors.ok} />
                  </If>
                </View>
                <Txt
                  tone={it().status === "done" ? "muted" : it().status === "in_progress" ? "default" : "muted"}
                  weight={it().status === "in_progress" ? "medium" : "regular"}
                  grow
                >
                  {it().text}
                </Txt>
              </View>
            )}
          </Each>
        </Card>
      </If>
    </View>
  );
}
