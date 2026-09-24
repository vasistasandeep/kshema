/**
 * Unit tests for subscription checkout, provider webhooks, and tier
 * transitions (task 15.1 — R20.1, R20.4, R20.8, R20.9, R20.10).
 *
 * Hermetic: a fake Prisma client backs the Subscription/CircleMember reads and
 * writes, a fake event emitter captures `subscription.changed`, and the webhook
 * signature verifier + admin error queue + checkout provider are injected.
 * Bearer tokens are minted with the app's own `app.jwt` so `app.authenticate`
 * passes.
 *
 * Coverage:
 *   - checkout returns a session URL for a circle member;
 *   - a valid apple/google/upi webhook transitions TRIAL->PRO, sets proSince,
 *     and emits `subscription.changed` (resume) (R20.8, R20.10);
 *   - an invalid-signature webhook is rejected (401) and routed to the admin
 *     error queue (R21.20), with no tier change and no event;
 *   - an illegal transition (already PRO) is rejected and queued;
 *   - trial expiry transitions TRIAL->SHIELD_PAUSED and emits (R20.4);
 *   - pure guard rejects illegal transitions;
 *   - `computeDueTrialReminder` is due at 4 days and 1 day (R20.9).
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { EventEmitter, SentinelEventName } from "../plugins/events.js";
import {
  transitionTier,
  canTransition,
  computeDueTrialReminder,
  applyTrialExpiry,
  InMemoryAdminErrorQueue,
  HmacSubscriptionWebhookVerifier,
  type CheckoutProvider,
  type SubscriptionStore,
  type SubscriptionEventEmitter,
} from "../services/subscriptions.js";

const WEBHOOK_SECRET = "test-subscription-webhook-secret";

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    OTP_SECRET: "test-otp-secret",
    WEB_ORIGIN: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:0",
    SUBSCRIPTION_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PORT: "0",
  });
}

/** Fake emitter capturing every emitted event for assertions. */
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

// --------------------------------------------------------------------------
// Fake Prisma fixtures.
// --------------------------------------------------------------------------

interface SubscriptionRow {
  id: string;
  circleId: string;
  tier: string;
  interval?: string | null;
  proSince?: Date | null;
  externalRef?: string | null;
  trialEndsAt: Date;
}

interface MemberRow {
  circleId: string;
  userId: string;
  role: string;
  canTriggerIVR?: boolean;
}

interface Fixtures {
  subscriptions?: SubscriptionRow[];
  members?: MemberRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const subscriptions = fixtures.subscriptions ?? [];
  const members = fixtures.members ?? [];

  const matchesWhere = (
    row: object,
    where: Record<string, unknown>,
  ): boolean => {
    const rec = row as Record<string, unknown>;
    return Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === "object" && "in" in (v as object)) {
        return (v as { in: unknown[] }).in.includes(rec[k]);
      }
      return rec[k] === v;
    });
  };

  const prisma = {
    subscription: {
      findUnique: vi.fn(
        async (args: { where: { circleId: string } }) =>
          subscriptions.find((s) => s.circleId === args.where.circleId) ?? null,
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = subscriptions.find((s) => s.id === args.where.id);
          if (!row) throw new Error("subscription not found");
          Object.assign(row, args.data);
          return { ...row };
        },
      ),
    },
    circleMember: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        return members.find((m) => matchesWhere(m, args.where)) ?? null;
      }),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, subscriptions, members };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(), loggerEnabled: false, ...overrides });
}

function bearer(app: FastifyInstance, userId: string): string {
  const token = app.jwt.sign({ sub: userId, channel: "MOBILE" });
  return `Bearer ${token}`;
}

/** Sign a webhook body the way the default HMAC verifier expects. */
function signBody(body: unknown): { payload: string; signature: string } {
  const payload = JSON.stringify(body);
  const sig = createHmac("sha256", WEBHOOK_SECRET)
    .update(Buffer.from(payload, "utf8"))
    .digest("hex");
  return { payload, signature: `sha256=${sig}` };
}

function sub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "subscription_1",
    circleId: "circle_1",
    tier: "TRIAL",
    interval: null,
    proSince: null,
    externalRef: null,
    trialEndsAt: new Date("2024-01-15T00:00:00.000Z"),
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Pure tier state machine (no I/O).
// --------------------------------------------------------------------------

describe("transitionTier (pure guard)", () => {
  it("allows the four legal transitions (R20.1, R20.4, R20.8)", () => {
    expect(transitionTier("TRIAL", "PRO_PURCHASE")).toMatchObject({
      ok: true,
      to: "PRO",
    });
    expect(transitionTier("TRIAL", "TRIAL_EXPIRY")).toMatchObject({
      ok: true,
      to: "SHIELD_PAUSED",
    });
    expect(transitionTier("SHIELD_PAUSED", "PRO_PURCHASE")).toMatchObject({
      ok: true,
      to: "PRO",
    });
    expect(transitionTier("SHIELD_PAUSED", "TRIAL_EXTENSION")).toMatchObject({
      ok: true,
      to: "TRIAL",
    });
  });

  it("rejects illegal transitions", () => {
    // No edge out of PRO.
    expect(canTransition("PRO", "PRO_PURCHASE")).toBe(false);
    expect(canTransition("PRO", "TRIAL_EXPIRY")).toBe(false);
    expect(canTransition("PRO", "TRIAL_EXTENSION")).toBe(false);
    // TRIAL cannot be extended (only a lapsed SHIELD_PAUSED can).
    expect(canTransition("TRIAL", "TRIAL_EXTENSION")).toBe(false);
    // SHIELD_PAUSED cannot expire again.
    expect(canTransition("SHIELD_PAUSED", "TRIAL_EXPIRY")).toBe(false);

    const rejected = transitionTier("PRO", "TRIAL_EXPIRY");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toMatch(/Illegal/);
  });
});

// --------------------------------------------------------------------------
// POST /subscriptions/checkout
// --------------------------------------------------------------------------

describe("POST /api/v1/subscriptions/checkout", () => {
  it("returns a checkout session URL for a circle member", async () => {
    const { prisma } = makeFakePrisma({
      members: [{ circleId: "circle_1", userId: "observer_1", role: "OBSERVER" }],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions/checkout",
        headers: { authorization: bearer(app, "observer_1") },
        payload: { interval: "MONTHLY" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { checkoutUrl: string };
      expect(body.checkoutUrl).toContain("circle_1");
      expect(body.checkoutUrl).toContain("monthly");
    } finally {
      await app.close();
    }
  });

  it("uses an injected checkout provider", async () => {
    const { prisma } = makeFakePrisma({
      members: [{ circleId: "circle_1", userId: "anchor_1", role: "ANCHOR" }],
    });
    const provider: CheckoutProvider = {
      createSession: vi.fn(async () => ({
        checkoutUrl: "https://pay.example/session/xyz",
        reference: "ref_xyz",
      })),
    };
    const app = await buildTestApp({ prisma, checkoutProvider: provider });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions/checkout",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: { interval: "ANNUAL" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().checkoutUrl).toBe("https://pay.example/session/xyz");
      expect(provider.createSession).toHaveBeenCalledWith({
        circleId: "circle_1",
        interval: "ANNUAL",
      });
    } finally {
      await app.close();
    }
  });

  it("denies (403) a caller who is not a circle member", async () => {
    const { prisma } = makeFakePrisma({ members: [] });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions/checkout",
        headers: { authorization: bearer(app, "stranger") },
        payload: { interval: "MONTHLY" },
      });

      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated checkout with 401", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions/checkout",
        payload: { interval: "MONTHLY" },
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// --------------------------------------------------------------------------
// POST /subscriptions/webhooks/{apple,google,upi}
// --------------------------------------------------------------------------

describe.each(["apple", "google", "upi"] as const)(
  "POST /api/v1/subscriptions/webhooks/%s",
  (provider) => {
    it("transitions TRIAL->PRO, sets proSince, and emits subscription.changed (R20.8, R20.10)", async () => {
      const proSince = Date.parse("2024-01-10T09:00:00.000Z");
      const { prisma, subscriptions } = makeFakePrisma({
        subscriptions: [sub({ tier: "TRIAL" })],
      });
      const { emitter, events } = makeFakeEmitter();
      const errorQueue = new InMemoryAdminErrorQueue();
      const app = await buildTestApp({
        prisma,
        eventEmitter: emitter,
        subscriptionErrorQueue: errorQueue,
        now: () => proSince,
      });

      try {
        const { payload, signature } = signBody({
          circleId: "circle_1",
          externalRef: "ext_123",
          active: true,
          interval: "ANNUAL",
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/v1/subscriptions/webhooks/${provider}`,
          headers: {
            "content-type": "application/json",
            "x-kshema-signature": signature,
          },
          payload,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ provider, processed: true });

        // Tier flipped to PRO, proSince/externalRef/interval persisted.
        const row = subscriptions[0]!;
        expect(row.tier).toBe("PRO");
        expect(row.proSince?.getTime()).toBe(proSince);
        expect(row.externalRef).toBe("ext_123");
        expect(row.interval).toBe("ANNUAL");

        // Resume event emitted; nothing routed to the error queue.
        expect(events).toHaveLength(1);
        expect(events[0]!.name).toBe("subscription.changed");
        expect(events[0]!.payload).toMatchObject({
          circleId: "circle_1",
          from: "TRIAL",
          to: "PRO",
          event: "PRO_PURCHASE",
          provider,
        });
        expect(errorQueue.items).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it("transitions SHIELD_PAUSED->PRO on a valid receipt", async () => {
      const { prisma, subscriptions } = makeFakePrisma({
        subscriptions: [sub({ tier: "SHIELD_PAUSED" })],
      });
      const { emitter, events } = makeFakeEmitter();
      const app = await buildTestApp({ prisma, eventEmitter: emitter });

      try {
        const { payload, signature } = signBody({
          circleId: "circle_1",
          externalRef: "ext_9",
          active: true,
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/subscriptions/webhooks/${provider}`,
          headers: {
            "content-type": "application/json",
            "x-kshema-signature": signature,
          },
          payload,
        });

        expect(res.statusCode).toBe(200);
        expect(subscriptions[0]!.tier).toBe("PRO");
        expect(events[0]!.payload).toMatchObject({ from: "SHIELD_PAUSED", to: "PRO" });
      } finally {
        await app.close();
      }
    });

    it("rejects an invalid-signature webhook (401) and routes it to the admin error queue (R21.20)", async () => {
      const { prisma, subscriptions } = makeFakePrisma({
        subscriptions: [sub({ tier: "TRIAL" })],
      });
      const { emitter, events } = makeFakeEmitter();
      const errorQueue = new InMemoryAdminErrorQueue();
      const app = await buildTestApp({
        prisma,
        eventEmitter: emitter,
        subscriptionErrorQueue: errorQueue,
      });

      try {
        const payload = JSON.stringify({
          circleId: "circle_1",
          active: true,
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/subscriptions/webhooks/${provider}`,
          headers: {
            "content-type": "application/json",
            "x-kshema-signature": "sha256=deadbeef",
          },
          payload,
        });

        expect(res.statusCode).toBe(401);
        // No tier change, no resume event.
        expect(subscriptions[0]!.tier).toBe("TRIAL");
        expect(events).toHaveLength(0);
        // Routed to the admin error queue for inspect/edit/re-drive.
        expect(errorQueue.items).toHaveLength(1);
        expect(errorQueue.items[0]!.provider).toBe(provider);
        expect(errorQueue.items[0]!.rawBodyBase64).toBe(
          Buffer.from(payload, "utf8").toString("base64"),
        );
      } finally {
        await app.close();
      }
    });

    it("rejects (400) an illegal transition (already PRO) and queues it", async () => {
      const { prisma, subscriptions } = makeFakePrisma({
        subscriptions: [sub({ tier: "PRO" })],
      });
      const { emitter, events } = makeFakeEmitter();
      const errorQueue = new InMemoryAdminErrorQueue();
      const app = await buildTestApp({
        prisma,
        eventEmitter: emitter,
        subscriptionErrorQueue: errorQueue,
      });

      try {
        const { payload, signature } = signBody({
          circleId: "circle_1",
          externalRef: "ext_dup",
          active: true,
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/subscriptions/webhooks/${provider}`,
          headers: {
            "content-type": "application/json",
            "x-kshema-signature": signature,
          },
          payload,
        });

        expect(res.statusCode).toBe(400);
        // Stays PRO, no event, failure queued.
        expect(subscriptions[0]!.tier).toBe("PRO");
        expect(events).toHaveLength(0);
        expect(errorQueue.items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });

    it("queues (400) a valid-signature but inactive receipt", async () => {
      const { prisma, subscriptions } = makeFakePrisma({
        subscriptions: [sub({ tier: "TRIAL" })],
      });
      const { emitter, events } = makeFakeEmitter();
      const errorQueue = new InMemoryAdminErrorQueue();
      const app = await buildTestApp({
        prisma,
        eventEmitter: emitter,
        subscriptionErrorQueue: errorQueue,
      });

      try {
        const { payload, signature } = signBody({
          circleId: "circle_1",
          active: false,
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/subscriptions/webhooks/${provider}`,
          headers: {
            "content-type": "application/json",
            "x-kshema-signature": signature,
          },
          payload,
        });

        expect(res.statusCode).toBe(400);
        expect(subscriptions[0]!.tier).toBe("TRIAL");
        expect(events).toHaveLength(0);
        expect(errorQueue.items).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  },
);

// --------------------------------------------------------------------------
// Trial expiry (R20.4) via the exposed app.applyTrialExpiry seam.
// --------------------------------------------------------------------------

describe("applyTrialExpiry (R20.4) — shared worker/cron helper", () => {
  /** Minimal store + emitter fakes matching the helper's narrow interfaces. */
  function makeStoreAndEmitter(rows: SubscriptionRow[]) {
    const events: Array<{ name: string; payload: unknown }> = [];
    const store: SubscriptionStore = {
      subscription: {
        findUnique: vi.fn(async (args: { where: { circleId: string } }) => {
          const row = rows.find((s) => s.circleId === args.where.circleId);
          return row ? { id: row.id, tier: row.tier as never } : null;
        }),
        update: vi.fn(
          async (args: {
            where: { id: string };
            data: Record<string, unknown>;
          }) => {
            const row = rows.find((s) => s.id === args.where.id);
            if (row) Object.assign(row, args.data);
            return row;
          },
        ),
      },
    };
    const emitter: SubscriptionEventEmitter = {
      emit: vi.fn(async (name, payload) => {
        events.push({ name, payload });
      }),
    };
    return { store, emitter, events };
  }

  it("transitions TRIAL->SHIELD_PAUSED and emits subscription.changed", async () => {
    const rows = [sub({ tier: "TRIAL" })];
    const { store, emitter, events } = makeStoreAndEmitter(rows);

    const result = await applyTrialExpiry(store, emitter, "circle_1");

    expect(result.applied).toBe(true);
    expect(rows[0]!.tier).toBe("SHIELD_PAUSED");
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("subscription.changed");
    expect(events[0]!.payload).toMatchObject({
      circleId: "circle_1",
      from: "TRIAL",
      to: "SHIELD_PAUSED",
      event: "TRIAL_EXPIRY",
    });
  });

  it("does not apply (illegal) trial expiry when already PRO", async () => {
    const rows = [sub({ tier: "PRO" })];
    const { store, emitter, events } = makeStoreAndEmitter(rows);

    const result = await applyTrialExpiry(store, emitter, "circle_1");

    expect(result.applied).toBe(false);
    expect(rows[0]!.tier).toBe("PRO");
    expect(events).toHaveLength(0);
  });

  it("does not apply when there is no subscription for the circle", async () => {
    const { store, emitter, events } = makeStoreAndEmitter([]);

    const result = await applyTrialExpiry(store, emitter, "unknown");

    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/No subscription/);
    expect(events).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Trial reminders (R20.9) — pure decision.
// --------------------------------------------------------------------------

describe("computeDueTrialReminder (R20.9)", () => {
  const trialEnds = new Date("2024-01-15T00:00:00.000Z");

  it("is due (FOUR_DAY) when 4 days remain", () => {
    const now = new Date("2024-01-11T00:00:00.000Z"); // exactly 4 days left
    expect(computeDueTrialReminder(trialEnds, now)).toBe("FOUR_DAY");
  });

  it("is due (ONE_DAY) when 1 day remains", () => {
    const now = new Date("2024-01-14T00:00:00.000Z"); // exactly 1 day left
    expect(computeDueTrialReminder(trialEnds, now)).toBe("ONE_DAY");
  });

  it("is not due between the two reminder windows", () => {
    const now = new Date("2024-01-12T12:00:00.000Z"); // ~2.5 days left
    expect(computeDueTrialReminder(trialEnds, now)).toBeNull();
  });

  it("is not due after expiry", () => {
    const now = new Date("2024-01-16T00:00:00.000Z");
    expect(computeDueTrialReminder(trialEnds, now)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Default HMAC verifier direct coverage.
// --------------------------------------------------------------------------

describe("HmacSubscriptionWebhookVerifier", () => {
  it("validates a correctly-signed body and parses the receipt", () => {
    const verifier = new HmacSubscriptionWebhookVerifier(WEBHOOK_SECRET);
    const { payload, signature } = signBody({
      circleId: "circle_1",
      externalRef: "ext_1",
      active: true,
      interval: "MONTHLY",
    });
    const receipt = verifier.verify("apple", Buffer.from(payload, "utf8"), {
      "x-kshema-signature": signature,
    });
    expect(receipt).toMatchObject({
      valid: true,
      active: true,
      circleId: "circle_1",
      externalRef: "ext_1",
      interval: "MONTHLY",
    });
  });

  it("rejects a wrong signature", () => {
    const verifier = new HmacSubscriptionWebhookVerifier(WEBHOOK_SECRET);
    const receipt = verifier.verify("google", Buffer.from("{}", "utf8"), {
      "x-kshema-signature": "sha256=00",
    });
    expect(receipt.valid).toBe(false);
  });
});
