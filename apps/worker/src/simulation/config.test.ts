import { describe, expect, it } from "vitest";

import { DEFAULT_STAGE_INTERVAL_MS } from "../escalation/processor.js";
import {
  MockCarrierAdapter,
  type CarrierAdapter,
  type DeliveryResult,
  type SmsMessage,
  type VoiceHandshakeCall,
  type VoiceHandshakeResult,
  type WhatsAppMessage,
} from "../carrier/index.js";
import {
  DEFAULT_SIMULATION_STAGE_INTERVAL_MS,
  MAX_SIMULATION_STAGE_INTERVAL_MS,
  resolveSimulationMode,
  selectCarrierAdapter,
} from "./config.js";

/** A live adapter double that throws if ever used — proves routing in tests. */
class ExplodingLiveAdapter implements CarrierAdapter {
  async sendWhatsApp(_msg: WhatsAppMessage): Promise<DeliveryResult> {
    throw new Error("live adapter must not be called under Simulation_Mode");
  }
  async sendSms(_msg: SmsMessage): Promise<DeliveryResult> {
    throw new Error("live adapter must not be called under Simulation_Mode");
  }
  async placeVoiceWithHandshake(
    _call: VoiceHandshakeCall,
  ): Promise<VoiceHandshakeResult> {
    throw new Error("live adapter must not be called under Simulation_Mode");
  }
}

describe("resolveSimulationMode", () => {
  const authorized = { adminAuthorized: true };

  it("enables and compresses the stage interval for an authorized admin in non-prod (R25.1)", () => {
    const decision = resolveSimulationMode(
      { NODE_ENV: "development", SIMULATION_MODE: "true" },
      authorized,
    );
    expect(decision.enabled).toBe(true);
    expect(decision.simulated).toBe(true);
    expect(decision.stageIntervalMs).toBe(DEFAULT_SIMULATION_STAGE_INTERVAL_MS);
    // Compression means strictly below the production 20-minute interval.
    expect(decision.stageIntervalMs).toBeLessThan(DEFAULT_STAGE_INTERVAL_MS);
    expect(decision.disabledReason).toBeUndefined();
  });

  it("honors an explicit compressed SIMULATION_STAGE_INTERVAL_MS (R25.1)", () => {
    const decision = resolveSimulationMode(
      {
        NODE_ENV: "test",
        SIMULATION_MODE: "1",
        SIMULATION_STAGE_INTERVAL_MS: "5000",
      },
      authorized,
    );
    expect(decision.enabled).toBe(true);
    expect(decision.stageIntervalMs).toBe(5000);
  });

  it("flags resulting incidents/dispatches simulated when enabled (R25.4)", () => {
    const decision = resolveSimulationMode(
      { NODE_ENV: "development", SIMULATION_MODE: "on" },
      authorized,
    );
    expect(decision.simulated).toBe(true);
  });

  it("refuses Simulation_Mode in production even when the flag + admin are set (R25.3)", () => {
    const decision = resolveSimulationMode(
      { NODE_ENV: "production", SIMULATION_MODE: "true" },
      authorized,
    );
    expect(decision.enabled).toBe(false);
    expect(decision.simulated).toBe(false);
    expect(decision.disabledReason).toBe("production-refused");
    // Falls back to the production interval so callers can use it unconditionally.
    expect(decision.stageIntervalMs).toBe(DEFAULT_STAGE_INTERVAL_MS);
  });

  it("stays off when the flag is set but the actor is not an authorized admin (R25.3)", () => {
    const decision = resolveSimulationMode(
      { NODE_ENV: "development", SIMULATION_MODE: "true" },
      { adminAuthorized: false },
    );
    expect(decision.enabled).toBe(false);
    expect(decision.disabledReason).toBe("admin-unauthorized");
  });

  it("defaults admin authorization to false (off unless explicitly enabled)", () => {
    const decision = resolveSimulationMode({
      NODE_ENV: "development",
      SIMULATION_MODE: "true",
    });
    expect(decision.enabled).toBe(false);
    expect(decision.disabledReason).toBe("admin-unauthorized");
  });

  it("stays off (flag-off) when SIMULATION_MODE is unset/false", () => {
    expect(
      resolveSimulationMode({ NODE_ENV: "development" }, { adminAuthorized: true })
        .disabledReason,
    ).toBe("flag-off");
    expect(
      resolveSimulationMode(
        { NODE_ENV: "development", SIMULATION_MODE: "false" },
        { adminAuthorized: true },
      ).enabled,
    ).toBe(false);
  });

  it("rejects a compressed interval that is not below the production interval", () => {
    expect(() =>
      resolveSimulationMode(
        {
          NODE_ENV: "development",
          SIMULATION_MODE: "true",
          SIMULATION_STAGE_INTERVAL_MS: String(DEFAULT_STAGE_INTERVAL_MS),
        },
        authorized,
      ),
    ).toThrow(/Invalid Simulation_Mode configuration/);
  });

  it("accepts the maximum allowed compressed interval boundary", () => {
    const decision = resolveSimulationMode(
      {
        NODE_ENV: "development",
        SIMULATION_MODE: "true",
        SIMULATION_STAGE_INTERVAL_MS: String(MAX_SIMULATION_STAGE_INTERVAL_MS),
      },
      authorized,
    );
    expect(decision.stageIntervalMs).toBe(MAX_SIMULATION_STAGE_INTERVAL_MS);
  });
});

describe("selectCarrierAdapter", () => {
  it("routes dispatch to the MockCarrierAdapter when Simulation_Mode is enabled (R25.2)", async () => {
    const decision = resolveSimulationMode(
      { NODE_ENV: "development", SIMULATION_MODE: "true" },
      { adminAuthorized: true },
    );
    const mock = new MockCarrierAdapter({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const adapter = selectCarrierAdapter(
      decision,
      new ExplodingLiveAdapter(),
      () => mock,
    );
    // Using the adapter must NOT hit the live gateway (which throws).
    await adapter.sendWhatsApp({ to: "+10000000000", template: "checkin", lang: "en" });
    expect(adapter).toBe(mock);
    expect(mock.sentMessages).toHaveLength(1);
  });

  it("uses the live adapter when Simulation_Mode is disabled", () => {
    const decision = resolveSimulationMode(
      { NODE_ENV: "production", SIMULATION_MODE: "true" },
      { adminAuthorized: true },
    );
    const live = new ExplodingLiveAdapter();
    const adapter = selectCarrierAdapter(decision, live);
    expect(adapter).toBe(live);
  });
});
