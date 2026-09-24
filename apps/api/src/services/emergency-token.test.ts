/**
 * Unit tests for the Emergency_Access_Token minting service (task 13.1 —
 * R29.1, R29.2, R29.3).
 *
 * All hermetic: the signer, store, link builder, and delivery are fakes/spies —
 * no live JWT plugin, no DB, no carrier. Verifies:
 *   - minting persists a row with ONLY a hash (the raw token is never stored);
 *   - expiry is at most 60 minutes from `now` (R29.2), including clamping a
 *     larger requested TTL;
 *   - the token is single-incident bound (R29.1);
 *   - the shortened URL is delivered over BOTH SMS and WhatsApp (R29.3).
 */
import { describe, expect, it, vi } from "vitest";

import {
  mintEmergencyAccessToken,
  hashEmergencyToken,
  createDefaultEmergencyLinkBuilder,
  EMERGENCY_TRIAGE_SCOPE,
  MAX_EMERGENCY_TOKEN_TTL_MS,
  type EmergencyTokenClaims,
  type EmergencyTokenStore,
  type EmergencyLinkDelivery,
} from "./emergency-token.js";

const NOW = 1_700_000_000_000;
const INCIDENT_ID = "inc-abc";

const RECIPIENTS = [
  { id: "society-gate", phone: "+912222222222" },
  { id: "neighbor", phone: "+913333333333" },
];

/** A capturing in-memory store recording exactly what was persisted. */
function makeStore() {
  const rows: Array<{
    incidentId: string;
    tokenHash: string;
    scope: string;
    expiresAt: Date;
  }> = [];
  const store: EmergencyTokenStore = {
    async persist(row) {
      rows.push(row);
    },
  };
  return { store, rows };
}

/** A capturing delivery seam recording SMS + WhatsApp sends. */
function makeDelivery() {
  const sms: Array<{ to: string; url: string; incidentId: string }> = [];
  const whatsapp: Array<{ to: string; url: string; incidentId: string }> = [];
  const delivery: EmergencyLinkDelivery = {
    sendSms: vi.fn(async (input) => {
      sms.push(input);
    }),
    sendWhatsApp: vi.fn(async (input) => {
      whatsapp.push(input);
    }),
  };
  return { delivery, sms, whatsapp };
}

/** A deterministic signer that serializes the claims (stands in for JWT). */
function fakeSigner(claims: EmergencyTokenClaims): string {
  return `signed.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
}

function makeDeps(overrides?: {
  ttlMs?: number;
}) {
  const { store, rows } = makeStore();
  const { delivery, sms, whatsapp } = makeDelivery();
  const buildLink = createDefaultEmergencyLinkBuilder({
    baseUrl: "https://k.sh/e",
  });
  const deps = {
    sign: fakeSigner,
    store,
    delivery,
    buildLink,
    now: () => NOW,
    ...(overrides?.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
  };
  return { deps, rows, sms, whatsapp };
}

describe("mintEmergencyAccessToken (R29.1 / R29.2 / R29.3)", () => {
  it("persists ONLY a hash — the raw signed token is never stored", async () => {
    const { deps, rows } = makeDeps();

    const result = await mintEmergencyAccessToken(deps, {
      incidentId: INCIDENT_ID,
      recipients: RECIPIENTS,
    });

    expect(rows).toHaveLength(1);
    const persisted = rows[0]!;

    // The persisted hash matches hash(rawToken)...
    expect(persisted.tokenHash).toBe(hashEmergencyToken(result.rawToken));
    // ...and is NOT the raw token itself (R29.2 — hash only).
    expect(persisted.tokenHash).not.toBe(result.rawToken);

    // Defense-in-depth: no persisted field contains the raw token substring.
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(result.rawToken);

    // The row carries the read-only triage scope (R29.2).
    expect(persisted.scope).toBe(EMERGENCY_TRIAGE_SCOPE);
  });

  it("mints a token valid for at most 60 minutes (R29.2)", async () => {
    const { deps, rows } = makeDeps();

    const result = await mintEmergencyAccessToken(deps, {
      incidentId: INCIDENT_ID,
      recipients: RECIPIENTS,
    });

    const ttl = result.expiresAt.getTime() - NOW;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(MAX_EMERGENCY_TOKEN_TTL_MS);
    expect(rows[0]!.expiresAt.getTime()).toBe(result.expiresAt.getTime());
  });

  it("clamps a requested TTL longer than 60 minutes down to 60 minutes (R29.2)", async () => {
    const { deps } = makeDeps({ ttlMs: 3 * 60 * 60 * 1000 }); // 3h requested

    const result = await mintEmergencyAccessToken(deps, {
      incidentId: INCIDENT_ID,
      recipients: RECIPIENTS,
    });

    expect(result.expiresAt.getTime() - NOW).toBe(MAX_EMERGENCY_TOKEN_TTL_MS);
  });

  it("binds the token to exactly one incident id (R29.1)", async () => {
    const { deps, rows } = makeDeps();

    const result = await mintEmergencyAccessToken(deps, {
      incidentId: INCIDENT_ID,
      recipients: RECIPIENTS,
    });

    expect(result.incidentId).toBe(INCIDENT_ID);
    expect(rows[0]!.incidentId).toBe(INCIDENT_ID);

    // The signed claims are bound to the same incident.
    const claimsB64 = result.rawToken.split(".")[1]!;
    const claims = JSON.parse(
      Buffer.from(claimsB64, "base64url").toString("utf8"),
    ) as EmergencyTokenClaims;
    expect(claims.incidentId).toBe(INCIDENT_ID);
    expect(claims.scope).toBe(EMERGENCY_TRIAGE_SCOPE);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60 * 60);
  });

  it("delivers the shortened URL over BOTH SMS and WhatsApp to every recipient (R29.3)", async () => {
    const { deps, sms, whatsapp } = makeDeps();

    const result = await mintEmergencyAccessToken(deps, {
      incidentId: INCIDENT_ID,
      recipients: RECIPIENTS,
    });

    // Both channels, both recipients.
    expect(sms).toHaveLength(2);
    expect(whatsapp).toHaveLength(2);
    expect(sms.map((m) => m.to)).toEqual([
      "+912222222222",
      "+913333333333",
    ]);
    expect(whatsapp.map((m) => m.to)).toEqual([
      "+912222222222",
      "+913333333333",
    ]);

    // The delivered URL carries the raw token and is the same one returned.
    expect(sms[0]!.url).toBe(result.url);
    expect(whatsapp[0]!.url).toBe(result.url);
    expect(result.url).toContain(encodeURIComponent(result.rawToken));

    expect(result.deliveredTo).toEqual(["society-gate", "neighbor"]);
  });
});
