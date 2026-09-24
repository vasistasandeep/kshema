/**
 * Emergency responder-portal API-client integration tests (R29.5, R29.6,
 * R29.11, R29.12, task 24.3 / 25.4).
 *
 * `loadTriage`/`confirmSafe` wrap the two zero-login, token-gated routes and
 * fold every outcome into a discriminated union so the edge page never has to
 * branch on raw status codes. These tests exercise that folding against a
 * stubbed `fetch` (no server, no browser): a valid 200 → `triage`; a 410
 * "concluded" body → `concluded`; network/parse failures → `concluded`; and a
 * 200 that violates the strict exclusion contract (location/financial/chat) is
 * rejected rather than rendered. `confirmSafe` treats both 200 and 410 as a
 * completed check and only a transport failure as not-ok.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponderTriagePayload, TokenConcluded } from "@kshema/types";
import { confirmSafe, loadTriage } from "./emergency-api";

const TOKEN = "tok_abc.def.ghi";

/** A minimal, schema-valid triage payload (Stage-4, with a dossier). */
const VALID_TRIAGE: ResponderTriagePayload = {
  preferredName: "Amma",
  society: "Sunrise Residency",
  building: "B",
  flat: "402",
  doorAccessInstructions: "Lift to 4th floor, door on the left.",
  smartLockBackupCodes: ["4821", "0097"],
  primaryObserverDialer: "+919876543210",
  incidentStage: "STAGE_4_HYPERLOCAL_DISPATCH",
  dossier: {
    bloodGroup: "O+",
    allergies: ["Penicillin"],
    chronicConditions: ["Hypertension"],
    criticalMedications: ["Amlodipine"],
  },
};

const CONCLUDED: TokenConcluded = {
  concluded: true,
  message: "This safety check has concluded.",
};

/** Build a `Response`-like stub `fetch` returns. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  process.env.KSHEMA_API_BASE_URL = "https://api.kshema.test/";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.KSHEMA_API_BASE_URL;
});

describe("loadTriage — discriminated union (R29.6, R29.11)", () => {
  it("folds a valid 200 into a 'triage' result and never caches", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        preferredName: "Amma",
        flat: "402",
        smartLockBackupCodes: ["4821"],
        primaryObserverDialer: "+919876543210",
        incidentStage: "STAGE_4_HYPERLOCAL_DISPATCH",
      }),
    );

    const result = await loadTriage(TOKEN);

    expect(result.kind).toBe("triage");
    if (result.kind !== "triage") throw new Error("expected triage");
    expect(result.payload.preferredName).toBe("Amma");
    // The single credential is the token, carried in the URL (R29.4).
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/emergency/");
    expect(url).toContain(encodeURIComponent(TOKEN));
    expect((init as RequestInit).cache).toBe("no-store");
  });

  it("folds a 410 'concluded' body into a 'concluded' result (R29.11)", async () => {
    stubFetch(async () => jsonResponse(410, CONCLUDED));

    const result = await loadTriage(TOKEN);

    expect(result.kind).toBe("concluded");
    if (result.kind !== "concluded") throw new Error("expected concluded");
    expect(result.body.message).toBe(CONCLUDED.message);
    expect(result.reason).toBe("expired-or-invalid");
  });

  it("folds a network failure into 'concluded' (never throws)", async () => {
    stubFetch(async () => {
      throw new TypeError("network down");
    });

    const result = await loadTriage(TOKEN);

    expect(result.kind).toBe("concluded");
    if (result.kind !== "concluded") throw new Error("expected concluded");
    expect(result.reason).toBe("network");
  });

  it("folds a malformed (non-JSON) body into 'concluded'", async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON");
          },
        }) as unknown as Response,
    );

    const result = await loadTriage(TOKEN);

    expect(result.kind).toBe("concluded");
    if (result.kind !== "concluded") throw new Error("expected concluded");
    expect(result.reason).toBe("unexpected");
  });

  it("rejects a 200 that violates the strict exclusion contract (R29.7)", async () => {
    // A 200 that smuggles a location trace must NOT be rendered as triage —
    // `.strict()` fails the parse and the client falls back to 'concluded'.
    stubFetch(async () =>
      jsonResponse(200, {
        preferredName: "Amma",
        incidentStage: "STAGE_4_HYPERLOCAL_DISPATCH",
        smartLockBackupCodes: [],
        locationTrace: [{ lat: 12.9, lng: 77.5 }],
      }),
    );

    const result = await loadTriage(TOKEN);

    expect(result.kind).toBe("concluded");
    if (result.kind !== "concluded") throw new Error("expected concluded");
    expect(result.reason).toBe("unexpected");
  });

  it("accepts a full Stage-4 payload with a dossier", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        preferredName: VALID_TRIAGE.preferredName,
        society: VALID_TRIAGE.society,
        building: VALID_TRIAGE.building,
        flat: VALID_TRIAGE.flat,
        doorAccessInstructions: VALID_TRIAGE.doorAccessInstructions,
        smartLockBackupCodes: VALID_TRIAGE.smartLockBackupCodes,
        primaryObserverDialer: VALID_TRIAGE.primaryObserverDialer,
        incidentStage: VALID_TRIAGE.incidentStage,
        dossier: {
          bloodGroup: "O+",
          allergies: ["Penicillin"],
          chronicConditions: ["Hypertension"],
          criticalMedications: ["Amlodipine"],
        },
      }),
    );

    const result = await loadTriage(TOKEN);

    expect(result.kind).toBe("triage");
    if (result.kind !== "triage") throw new Error("expected triage");
    expect(result.payload.dossier?.bloodGroup).toBe("O+");
  });
});

describe("confirmSafe — responder confirmation (R29.8, R29.9, R29.12)", () => {
  it("returns ok with the API message on a fresh 200 confirm", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        concluded: true,
        message: "Thank you. The Circle has been notified.",
      }),
    );

    const result = await confirmSafe(TOKEN, "Officer Rao");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("notified");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/confirm");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      responderName: "Officer Rao",
    });
  });

  it("treats a 410 (already concluded) as a completed check (ok=true)", async () => {
    stubFetch(async () => jsonResponse(410, CONCLUDED));

    const result = await confirmSafe(TOKEN, "Officer Rao");

    expect(result.ok).toBe(true);
    expect(result.message).toBe(CONCLUDED.message);
  });

  it("reports not-ok on a genuine transport failure so the UI can retry", async () => {
    stubFetch(async () => {
      throw new TypeError("network down");
    });

    const result = await confirmSafe(TOKEN, "Officer Rao");

    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain("try again");
  });

  it("uses a safe fallback message when the body is unparsable", async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("bad json");
          },
        }) as unknown as Response,
    );

    const result = await confirmSafe(TOKEN, "Officer Rao");

    expect(result.ok).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
