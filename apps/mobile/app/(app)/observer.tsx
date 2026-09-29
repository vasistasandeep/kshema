import { useState } from "react";
import { Text, View } from "react-native";
import { Body, Card, PrimaryButton, Screen, Title } from "../../src/components/primitives";
import {
  BRAND_LEXICON,
  toAnchorDashboardView,
  type AnchorDashboardView,
} from "../../src/domain/ui-presentation";
import { useDashboardStore } from "../../src/stores/hooks";
import { refreshDashboard } from "../../src/live-connect";

/**
 * Observer dashboard (R15). Renders per-Anchor well-being from the live store
 * using the approved state colors, and offers a pull-to-refresh action that
 * re-fetches the Observer dashboard from the API.
 */
export default function ObserverDashboard() {
  const anchors = useDashboardStore((s) => s.anchors);
  const lastRefreshedAt = useDashboardStore((s) => s.lastRefreshedAt);
  const [busy, setBusy] = useState(false);

  async function onRefresh() {
    setBusy(true);
    try { await refreshDashboard(); } catch { /* best-effort */ } finally { setBusy(false); }
  }

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
      <PrimaryButton label={busy ? "Refreshing…" : "Refresh"} onPress={onRefresh} disabled={busy} />
      {lastRefreshedAt ? (
        <Text className="text-xs text-typography/50">Updated {new Date(lastRefreshedAt).toLocaleTimeString()}</Text>
      ) : null}
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
