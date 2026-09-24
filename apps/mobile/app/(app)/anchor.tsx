import { useState } from "react";
import { Text, View } from "react-native";
import {
  AccentCard,
  Body,
  Card,
  Screen,
  TapPill,
  Title,
} from "../../src/components/primitives";
import {
  BRAND_LEXICON,
  SPARSH_OPTIONS,
  SPARSH_REPLY_OPTIONS,
  buildMovementJourney,
  buildSanctuaryBanner,
  toPanchangaCardView,
  toVitalityPulseCard,
  type MemberSteps,
  type MovementJourneyView,
  type PanchangaCardView,
  type SanctuaryBannerView,
  type VitalityPulseCardView,
} from "../../src/domain/ui-presentation";
import type { PanchangaCard, SparshType, VitalityPulse } from "@kshema/types";
import { useSessionStore } from "../../src/stores/hooks";

/**
 * Anchor sanctuary home (R7, R22, R34).
 *
 * A calm, warm home surface — never clinical, never alarm-styled (R16.5,
 * R22.20). It presents, when the data is available:
 *   • the Sanctuary Shield banner in Temple Brass while Sanctuary_Mode is
 *     active (R34.3),
 *   • the daily Vitality Pulse card in healthy Sage (R7.3, R7.6),
 *   • the one-tap Sparsh widget with a blessing/heart reply requiring no
 *     typing (R22.8, R22.10),
 *   • the Daily Panchanga card that refreshes at 04:00 Anchor-local (R22.14),
 *   • the cooperative Family Movement journey with a milestone postcard
 *     (R22.15–R22.17).
 *
 * All presentation decisions come from the pure `ui-presentation` domain module
 * (verified under Node); the live data hooks that feed `vitalityPulse`,
 * `panchanga`, `movement`, and `sanctuary` land with the Vitality/Sparsh/
 * Panchanga API (tasks 14, 21). Until then each section renders its empty state.
 */
export default function AnchorHome() {
  const name = useSessionStore((s) => s.preferredName) ?? "friend";

  // Data seams — populated by the vitality/panchanga/movement/sanctuary hooks
  // (tasks 14/21). Held as local state so the surface is complete and
  // typechecked today and simply lights up when the data arrives.
  const [vitalityPulse] = useState<VitalityPulse | null>(null);
  const [panchanga] = useState<PanchangaCard | null>(null);
  const [members] = useState<MemberSteps[]>([]);
  const [sanctuaryResumesAt] = useState<string | null>(null);

  const pulseCard: VitalityPulseCardView | null = vitalityPulse
    ? toVitalityPulseCard(vitalityPulse)
    : null;
  const panchangaCard: PanchangaCardView | null = panchanga
    ? toPanchangaCardView(panchanga)
    : null;
  const journey: MovementJourneyView | null =
    members.length > 0 ? buildMovementJourney(members) : null;
  const sanctuary: SanctuaryBannerView | null = sanctuaryResumesAt
    ? buildSanctuaryBanner(sanctuaryResumesAt)
    : null;

  function sendReply(type: SparshType) {
    // Wired to POST /sparsh by the Sparsh data hook (task 14); no-op shell here.
    void type;
  }

  return (
    <Screen>
      <Title>
        {BRAND_LEXICON.anchorGreeting}, {name}
      </Title>

      {sanctuary ? (
        <AccentCard accent={sanctuary.color}>
          <Body>{sanctuary.message}</Body>
        </AccentCard>
      ) : (
        <Card>
          <Body>Your Ambient Shield is looking after your daily rhythm.</Body>
        </Card>
      )}

      <VitalityPulseSection card={pulseCard} />
      <SparshSection onReply={sendReply} />
      <PanchangaSection card={panchangaCard} />
      <MovementSection journey={journey} />
    </Screen>
  );
}

function VitalityPulseSection({ card }: { card: VitalityPulseCardView | null }) {
  if (!card) return null;
  return (
    <AccentCard accent={card.color}>
      <Text className="text-base font-semibold text-typography">
        {card.heading}
      </Text>
      <Body>
        {card.preferredName} started the day well
        {card.stepContext !== undefined ? ` — ${card.stepContext} steps so far` : ""}
        {card.weatherContext ? `, ${card.weatherContext}` : ""}.
      </Body>
    </AccentCard>
  );
}

function SparshSection({ onReply }: { onReply: (type: SparshType) => void }) {
  return (
    <Card>
      <Text className="text-base font-semibold text-typography">
        {BRAND_LEXICON.sparshHeading}
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {SPARSH_OPTIONS.map((o) => (
          <TapPill
            key={o.type}
            label={o.label}
            glyph={o.glyph}
            onPress={() => onReply(o.type)}
          />
        ))}
      </View>
      <Body>{BRAND_LEXICON.sparshReply}</Body>
      <View className="flex-row flex-wrap gap-3">
        {SPARSH_REPLY_OPTIONS.map((o) => (
          <TapPill
            key={o.type}
            label={o.label}
            glyph={o.glyph}
            onPress={() => onReply(o.type)}
          />
        ))}
      </View>
    </Card>
  );
}

function PanchangaSection({ card }: { card: PanchangaCardView | null }) {
  if (!card) return null;
  const c = card.card;
  return (
    <Card>
      <Text className="text-base font-semibold text-typography">
        {card.heading}
      </Text>
      <Body>
        Sunrise {c.sunrise} · Sunset {c.sunset}
      </Body>
      <Body>
        {c.tithi} · {c.nakshatra} · {c.masa}
      </Body>
      {c.festivals.length > 0 ? <Body>{c.festivals.join(", ")}</Body> : null}
      <Body>{c.proverb}</Body>
    </Card>
  );
}

function MovementSection({ journey }: { journey: MovementJourneyView | null }) {
  if (!journey) return null;
  return (
    <Card>
      <Text className="text-base font-semibold text-typography">
        {journey.heading}
      </Text>
      <Body>
        {journey.contributorCount} in your Circle have walked{" "}
        {journey.totalSteps.toLocaleString()} steps together this week.
      </Body>
      <View className="h-2 rounded-full bg-temple-brass/20 overflow-hidden">
        <View
          style={{
            width: `${Math.round(journey.progress * 100)}%`,
            backgroundColor: journey.celebrationColor,
          }}
          className="h-2"
        />
      </View>
      {journey.milestoneReached ? (
        <Text
          className="text-sm font-semibold"
          style={{ color: journey.celebrationColor }}
        >
          A shared journey milestone — here's your postcard.
        </Text>
      ) : null}
    </Card>
  );
}
