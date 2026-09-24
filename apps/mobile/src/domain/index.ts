/**
 * @kshema/mobile domain layer — framework-agnostic identity, recovery, and
 * routing logic. Everything here is pure TypeScript with no React Native
 * dependency, so it is typechecked and unit-tested under Node in CI.
 */
export * from "./secure-enclave.js";
export * from "./platform-key-store.js";
export * from "./keygen.js";
export * from "./identity.js";
export * from "./key-recovery.js";
export * from "./disclaimer.js";
export * from "./preferred-name.js";
export * from "./roles.js";
// Ambient agents (task 22.3): Flight Recorder, acoustic classifier gate,
// Shadow SOS + Blackout Mode, and the on-device bedtime battery evaluator.
export * from "./flight-recorder.js";
export * from "./acoustic.js";
export * from "./shadow-sos.js";
export * from "./bedtime-guardian.js";
export * from "./offline-queue.js";
export * from "./signals.js";
export * from "./background-agent.js";
// Multi-language i18n catalogs (task 23.2): en/hi/kn/ta/te locale catalogs
// backing all UI strings, plus the Banned_Term guards enforcing Property 14.
export * from "./i18n/index.js";
// UI presentation logic for the Observer/Anchor surfaces (task 23.1).
export * from "./ui-presentation.js";
