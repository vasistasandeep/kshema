import { Stack } from "expo-router";

/** Onboarding funnel: welcome → verify → disclaimer → preferred-name → join-circle. */
export default function OnboardingLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
