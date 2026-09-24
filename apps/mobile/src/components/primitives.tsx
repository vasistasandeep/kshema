import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

/**
 * Small NativeWind primitives shared across screens. Colors reference the
 * shared brand tokens through Tailwind classes generated from `@kshema/ui`'s
 * `kshemaPreset` (e.g. `bg-canvas`, `text-typography`, `bg-primary-action`,
 * `text-healthy`, `text-escalating`). Clinical red / hospital blue never appear
 * (R16.4).
 */

export function Screen({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      className="flex-1 bg-canvas"
      contentContainerClassName="px-6 py-8 gap-5"
    >
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text className="text-2xl font-semibold text-typography">{children}</Text>
  );
}

export function Body({ children }: { children: ReactNode }) {
  return <Text className="text-base leading-6 text-typography">{children}</Text>;
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-2xl px-5 py-4 ${
        disabled ? "bg-temple-brass/40" : "bg-primary-action"
      }`}
    >
      <Text className="text-center text-base font-semibold text-sandalwood-cream">
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <View className="rounded-2xl bg-sandalwood-cream p-5 shadow-sm gap-3">
      {children}
    </View>
  );
}

/**
 * A card with a left accent bar in a caller-supplied brand color. Used for the
 * healthy Vitality Pulse card (Sage) and the Sanctuary Shield banner (Temple
 * Brass). The color always comes from a `@kshema/ui` token, never a raw hex at
 * the call site.
 */
export function AccentCard({
  accent,
  children,
}: {
  accent: string;
  children: ReactNode;
}) {
  return (
    <View className="flex-row rounded-2xl bg-sandalwood-cream shadow-sm overflow-hidden">
      <View style={{ width: 6, backgroundColor: accent }} />
      <View className="flex-1 p-5 gap-3">{children}</View>
    </View>
  );
}

/**
 * A soft, tappable pill for one-tap non-verbal reactions (Sparsh). No typing,
 * no alarm styling — just a warm glyph + label (R22.10, R22.20).
 */
export function TapPill({
  label,
  glyph,
  onPress,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="items-center rounded-2xl border border-temple-brass/40 px-4 py-3"
    >
      <Text className="text-2xl">{glyph}</Text>
      <Text className="mt-1 text-xs text-typography">{label}</Text>
    </Pressable>
  );
}
