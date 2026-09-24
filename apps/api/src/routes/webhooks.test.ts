/**
 * Unit tests for the WhatsApp inbound + delivery-status webhook (task 7.2 —
 * R13.5, R21.11, R21.13).
 *
 * Hermetic: a fake Prisma client backs the user/incident lookup and the
 * CarrierGatewayMetric writes, and a fake event emitter captures every emitted
 * domain event. No live DB / Redis is needed. Signatures are computed with the
 * same HMAC the route verifies, over the EXACT bytes we inject, so the raw-body
 * path is exercised end to end.
 *
 * Coverage:
 *   - a valid-signature inbound Anchor reply emits `incident.resolved` with
 *     `WHATSAPP_RESPONSE` (R13.5);
 *   - an invalid signature -> 403 (well-formed) / 401 (malformed), nothing
 *     emitted and no metric recorded;
 *   - a delivery-status callback records a CarrierGatewayMetric for the
 *     WHATSAPP gateway (R21.11, R21.13);
 *   - the HMAC is computed over the raw body: two byte-identical-JSON-but-
 *     differently-serialised bodies produce different signatures, and only the
 *     signature matching the exact bytes sent is accepted.
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";

const APP_SECRET = "test-whatsapp-app-secret";

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    OTP_SECRET: "test-otp-secret",
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    WEB_ORIGIN: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:0",
    PORT: "0",
  });
}

function makeFakeEmitter() {
  const events: Array<{ name: SentinelEventName; payload: unknown }> = [];
  const emitter: EventEmitter = {
    emit: vi.fn(async (name, payload) => {
      events.push({ name, payload });
    }),
    close: vi.fn(async () => undefined),
  };
  return { emitter, events };
}

interface UserRow {
  id: string;
  phone: string;
}

interface IncidentRow {
  id: string;
  anchorId: string;
  status: string;
}

interface MetricRow {
  id: string;
  gateway: string;
  deliveryLatencyMs: number | null;
  templateRejections: number;
  dltStatus: string | null;
  errorRate: number | null;
  windowStart: Date;
}

interface Fixtures {
  users?: UserRow[];
  incidents?: IncidentRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const users = fixtures.users ?? [];
  const incidents = fixtures.incidents ?? [];
  const metrics: MetricRow[] = [];
  let seq = 0;

  const prisma = {
    user: {
      findFirst: vi.fn(
        async (args: { where: { phone: { in: string[] } } }) => {
          const wanted = args.where.phone.in;
          return users.find((u) => wanted.includes(u.phone)) ?? null;
        },
      ),
    },
    safetyIncident: {
      findFirst: vi.fn(
        async (args: { where: { anchorId: string; status: string } }) => {
          return (
            incidents.find(
              (i) =>
                i.anchorId === args.where.anchorId &&
                i.status === args.where.status,
            ) ?? null
          );
        },
      ),
    },
    carrierGatewayMetric: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: MetricRow = {
          id: `metric_${seq}`,
          gateway: args.data.gateway as string,
          deliveryLatencyMs: (args.data.deliveryLatencyMs as number) ?? null,
          templateRejections: (args.data.templateRejections as number) ?? 0,
          dltStatus: (args.data.dltStatus as string) ?? null,
          errorRate: (args.data.errorRate as number) ?? null,
          windowStart: args.data.windowStart as Date,
        };
        metrics.push(row);
        return { ...row };
      }),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, users, incidents, metrics };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(), loggerEnabled: false, ...overrides });
}

/** Sign a raw body exactly as Meta does: sha256=<hex> over the bytes. */
function sign(rawBody: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function inboundReplyBody(from: string, timestampSec: number): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              messages: [
                {
                  from,
                  id: "wamid.ABC",
                  timestamp: String(timestampSec),
                  type: "text",
                  text: { body: "I am fine, good morning" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function deliveryStatusBody(
  status: string,
  timestampSec: number,
  withError = false,
): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              statuses: [
                {
                  id: "wamid.OUT",
                  status,
                  timestamp: String(timestampSec),
                  recipient_id: "919000000000",
                  ...(withError
                    ? {
                        errors: [
                          { code: 131047, title: "Re-engagement message" },
                        ],
                      }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

// --------------------------------------------------------------------------
// Inbound Anchor reply -> incident.resolved (R13.5)
// --------------------------------------------------------------------------

describe("POST /api/v1/webhooks/whatsapp — inbound Anchor reply (R13.5)", () => {
  it("emits incident.resolved with WHATSAPP_RESPONSE for a valid-signature reply", async () => {
    const { prisma } = makeFakePrisma({
      users: [{ id: "anchor_1", phone: "+919812345678" }],
      incidents: [{ id: "incident_1", anchorId: "anchor_1", status: "OPEN" }],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      // Meta sends the phone without a leading '+'.
      const body = inboundReplyBody("919812345678", 1_700_000_000);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, resolved: 1 });

      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe("incident.resolved");
      expect(events[0]!.payload).toMatchObject({
        incidentId: "incident_1",
        source: "WHATSAPP_RESPONSE",
      });
    } finally {
      await app.close();
    }
  });

  it("emits nothing when the Anchor has no OPEN incident", async () => {
    const { prisma } = makeFakePrisma({
      users: [{ id: "anchor_1", phone: "919812345678" }],
      incidents: [
        { id: "incident_1", anchorId: "anchor_1", status: "RESOLVED" },
      ],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const body = inboundReplyBody("919812345678", 1_700_000_000);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ resolved: 0 });
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// Signature verification (R signature contract)
// --------------------------------------------------------------------------

describe("POST /api/v1/webhooks/whatsapp — signature verification", () => {
  it("rejects a well-formed but wrong signature with 403 and emits nothing", async () => {
    const { prisma, metrics } = makeFakePrisma({
      users: [{ id: "anchor_1", phone: "919812345678" }],
      incidents: [{ id: "incident_1", anchorId: "anchor_1", status: "OPEN" }],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const body = inboundReplyBody("919812345678", 1_700_000_000);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          // Signed with the WRONG secret -> valid shape, wrong digest.
          "x-hub-signature-256": sign(body, "attacker-secret"),
        },
        payload: body,
      });

      expect(res.statusCode).toBe(403);
      expect(events).toHaveLength(0);
      expect(metrics).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a missing signature with 401 and emits nothing", async () => {
    const { prisma } = makeFakePrisma({
      users: [{ id: "anchor_1", phone: "919812345678" }],
      incidents: [{ id: "incident_1", anchorId: "anchor_1", status: "OPEN" }],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const body = inboundReplyBody("919812345678", 1_700_000_000);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: { "content-type": "application/json" },
        payload: body,
      });

      expect(res.statusCode).toBe(401);
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("computes the HMAC over the RAW bytes: a signature for different bytes is rejected", async () => {
    const { prisma } = makeFakePrisma({
      users: [{ id: "anchor_1", phone: "919812345678" }],
      incidents: [{ id: "incident_1", anchorId: "anchor_1", status: "OPEN" }],
    });
    const { emitter, events } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      // Two payloads with identical semantic JSON but different byte layout
      // (extra whitespace). A signature computed over one must not validate the
      // other — proving verification is byte-exact, not over re-parsed JSON.
      const sent = inboundReplyBody("919812345678", 1_700_000_000);
      const otherBytes = `  ${sent}`; // leading whitespace -> different bytes

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          // Signature is for `otherBytes`, but we send `sent`.
          "x-hub-signature-256": sign(otherBytes),
        },
        payload: sent,
      });

      expect(res.statusCode).toBe(403);
      expect(events).toHaveLength(0);

      // Sanity: the correct signature for the exact bytes IS accepted.
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(sent),
        },
        payload: sent,
      });
      expect(ok.statusCode).toBe(200);
      expect(events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// Delivery-status callback -> CarrierGatewayMetric (R21.11, R21.13)
// --------------------------------------------------------------------------

describe("POST /api/v1/webhooks/whatsapp — delivery status (R21.11, R21.13)", () => {
  it("records a CarrierGatewayMetric for the WHATSAPP gateway on a delivered status", async () => {
    const { prisma, metrics } = makeFakePrisma();
    const { emitter, events } = makeFakeEmitter();
    // Fixed clock 100s after the status timestamp -> deterministic latency.
    const statusTsSec = 1_700_000_000;
    const now = () => (statusTsSec + 100) * 1000;
    const app = await buildTestApp({ prisma, eventEmitter: emitter, now });

    try {
      const body = deliveryStatusBody("delivered", statusTsSec);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ metricsRecorded: 1 });

      expect(metrics).toHaveLength(1);
      const m = metrics[0]!;
      expect(m.gateway).toBe("WHATSAPP");
      expect(m.dltStatus).toBe("delivered");
      expect(m.errorRate).toBe(0);
      expect(m.templateRejections).toBe(0);
      expect(m.deliveryLatencyMs).toBe(100_000);
      // A delivery status is not an incident resolution.
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("marks a failed status with errorRate=1 and counts a template rejection", async () => {
    const { prisma, metrics } = makeFakePrisma();
    const { emitter } = makeFakeEmitter();
    const app = await buildTestApp({ prisma, eventEmitter: emitter });

    try {
      const body = deliveryStatusBody("failed", 1_700_000_000, true);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(metrics).toHaveLength(1);
      const m = metrics[0]!;
      expect(m.gateway).toBe("WHATSAPP");
      expect(m.dltStatus).toBe("failed");
      expect(m.errorRate).toBe(1);
      expect(m.templateRejections).toBe(1);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// GET verification handshake (optional)
// --------------------------------------------------------------------------

describe("GET /api/v1/webhooks/whatsapp — verification handshake", () => {
  it("echoes hub.challenge when mode+token match", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42",
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("42");
    } finally {
      await app.close();
    }
  });

  it("rejects (403) a wrong verify token", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42",
      });

      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
