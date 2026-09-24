import { Text, View } from "react-native";
import { Body, Card, Screen, Title } from "../../src/components/primitives";
import {
  BRAND_LEXICON,
  toAnchorDashboardView,
  type AnchorDashboardView,
} from "../../src/domain/ui-presentation";
import { useDashboardStore } from "../../src/stores/hooks";

/**
 * Observer dashboard (R15).
 *
 * Renders per-Anchor well-being using the approved state colors — Muted Sage
 * Green for All Well (R15.2), Soft Amber for an escalating stage (R12.7), and a
 * neutral grey with a disclosure for Shield Paused (R20.6, R20.7). Every string
 * comes from the Brand_Lexicon (R15.4) and no location trace is shown (R15.5).
 * All presentation decisions live in the pure `ui-presentation` domain module
 * so they are verified under Node; this surface just paints them.
 */
export default function ObserverDashboard() {
  const anchors = useDashboardStore((s) => s.anchors);

  return (
    <Screen>
      <Title>{BRAND_LEXICON.observerTitle}</Title>
      {anchors.length === 0 ? (
        <Body>{BRAND_LEXICON.observerEmpty}</Body>
      ) : (
        anchors
          .map(toAnchorDashboardView)
          .map((view) => <AnchorRow key={view.anchorId} view={view} />)
      )}
    </Screen>
  );
}

function AnchorRow({ view }: { view: AnchorDashboardView }) {
  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <View
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: view.color }}
          accessibilityLabel={view.label}
        />
        <Text className="text-base font-semibold text-typography">
          {view.preferredName}
        </Text>
      </View>
      <Body>{view.label}</Body>
      {view.stageLabel ? <Body>{view.stageLabel}</Body> : null}
      {view.disclosure ? (
        <Text className="text-sm leading-5 text-typography/70">
          {view.disclosure}
        </Text>
      ) : null}
    </Card>
  );
}
