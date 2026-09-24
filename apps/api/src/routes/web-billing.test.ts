/**
 * Unit tests for the web self-service billing routes (task 20.2 — R28.16,
 * R28.17). Hermetic: a fake Prisma client backs Subscription/CircleMember
 * reads + the interval update; the portal provider and invoice store are
 * injected; tokens are minted with `app.jwt`.
 *
 * Coverage:
 *   - portal-session returns the provider redirect URL (R28.16);
 *   - summary returns tier + trial countdown + interval (R28.17);
 *   - interval switch flips MONTHLY<->ANNUAL for PRO and persists (R28.17);
 *   - interval switch is 400 for a non-Pro tier and for a no-op switch;
 *   - invoices lists seeded invoices and downloads a PDF; unknown id is 404;
 *   - a caller with no Circle is 403;
 *   - all routes require authentication.
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";
import {
  InMemoryInvoiceStore,
  type BillingPortalProvider,
} from "../services/billing.js";

function testEnv() {
  return loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret",
    OTP_SECRET: "test-otp-secret",
    WEB_ORIGIN: "http://localhost:3000",
    REDIS_URL: "redis://127.0.0.1:0",
    PORT: "0",
  });
}

interface MemberRow {
  circleId: string;
  userId: string;
  role: "ANCHOR" | "OBSERVER" | "MUTUAL";
}
interface SubscriptionRow {
  id: string;
  circleId: string;
  tier: "TRIAL" | "PRO" | "SHIELD_PAUSED";
  interval: "MONTHLY" | "ANNUAL" | null;
  trialEndsAt: Date;
}

interface Fixtures {
  members?: MemberRow[];
  subscriptions?: SubscriptionRow[];
}

function makeFakePrisma(fixtures: Fixtures = {}) {
  const members = fixtures.members ?? [];
  const subscriptions = fixtures.subscriptions ?? [];

  const prisma = {
    circleMember: {
      findFirst: vi.fn(
        async (args: { where: { userId: string; role?: { in: string[] } } }) => {
          const hit = members.find(
            (m) =>
              m.userId === args.where.userId &&
              (!args.where.role?.in || args.where.role.in.includes(m.role)),
          );
          return hit ? { circleId: hit.circleId } : null;
        },
      ),
    },
    subscription: {
      findUnique: vi.fn(async (args: { where: { circleId: string } }) => {
        const s = subscriptions.find((r) => r.circleId === args.where.circleId);
        return s
          ? {
              id: s.id,
              tier: s.tier,
              interval: s.interval,
              trialEndsAt: s.trialEndsAt,
            }
          : null;
      }),
      update: vi.fn(
        async (args: { where: { id: string }; data: { interval?: string } }) => {
          const s = subscriptions.find((r) => r.id === args.where.id);
          if (s && args.data.interval) {
            s.interval = args.data.interval as "MONTHLY" | "ANNUAL";
          }
          return s;
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma };
}

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(), loggerEnabled: false, ...overrides });
}

function bearer(app: FastifyInstance, userId: string): string {
  return `Bearer ${app.jwt.sign({ sub: userId, channel: "WEB" })}`;
}

const NOW = Date.parse("2024-03-15T00:00:00.000Z");

const MEMBER: MemberRow = { circleId: "c1", userId: "observer_1", role: "OBSERVER" };

describe("POST /api/v1/web/billing/portal-session", () => {
  it("returns the provider redirect URL (R28.16)", async () => {
    const { prisma } = makeFakePrisma({ members: [MEMBER] });
    const provider: BillingPortalProvider = {
      createSession: vi.fn(async () => ({ redirectUrl: "https://portal.test/session/xyz" })),
    };
    const app = await buildTestApp({ prisma, billingPortalProvider: provider });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/web/billing/portal-session",
        headers: { authorization: bearer(app, "observer_1") },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().redirectUrl).toBe("https://portal.test/session/xyz");
    } finally {
      await app.close();
    }
  });

  it("is 403 for a caller with no Circle", async () => {
    const { prisma } = makeFakePrisma();
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/web/billing/portal-session",
        headers: { authorization: bearer(app, "nobody") },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/v1/web/billing/summary", () => {
  it("returns tier + trial countdown + interval (R28.17)", async () => {
    const { prisma } = makeFakePrisma({
      members: [MEMBER],
      subscriptions: [
        {
          id: "s1",
          circleId: "c1",
          tier: "PRO",
          interval: "MONTHLY",
          trialEndsAt: new Date("2024-03-20T00:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/billing/summary",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tier).toBe("PRO");
      expect(body.interval).toBe("MONTHLY");
      expect(body.trialEndsAt).toBe("2024-03-20T00:00:00.000Z");
      expect(body.trialDaysRemaining).toBe(5);
    } finally {
      await app.close();
    }
  });

  it("floors the trial countdown at 0 after expiry", async () => {
    const { prisma } = makeFakePrisma({
      members: [MEMBER],
      subscriptions: [
        {
          id: "s1",
          circleId: "c1",
          tier: "SHIELD_PAUSED",
          interval: null,
          trialEndsAt: new Date("2024-03-10T00:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/billing/summary",
        headers: { authorization: bearer(app, "observer_1") },
      });
      const body = res.json();
      expect(body.tier).toBe("SHIELD_PAUSED");
      expect(body.interval).toBeUndefined();
      expect(body.trialDaysRemaining).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/web/billing/interval", () => {
  it("switches MONTHLY -> ANNUAL for PRO and persists (R28.17)", async () => {
    const subs: SubscriptionRow[] = [
      {
        id: "s1",
        circleId: "c1",
        tier: "PRO",
        interval: "MONTHLY",
        trialEndsAt: new Date("2024-03-20T00:00:00.000Z"),
      },
    ];
    const { prisma } = makeFakePrisma({ members: [MEMBER], subscriptions: subs });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/web/billing/interval",
        headers: { authorization: bearer(app, "observer_1") },
        payload: { interval: "ANNUAL" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().interval).toBe("ANNUAL");
      expect(subs[0]!.interval).toBe("ANNUAL");
    } finally {
      await app.close();
    }
  });

  it("is 400 for a non-Pro tier", async () => {
    const { prisma } = makeFakePrisma({
      members: [MEMBER],
      subscriptions: [
        {
          id: "s1",
          circleId: "c1",
          tier: "TRIAL",
          interval: null,
          trialEndsAt: new Date("2024-03-20T00:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/web/billing/interval",
        headers: { authorization: bearer(app, "observer_1") },
        payload: { interval: "ANNUAL" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("is 400 for a no-op switch to the same interval", async () => {
    const { prisma } = makeFakePrisma({
      members: [MEMBER],
      subscriptions: [
        {
          id: "s1",
          circleId: "c1",
          tier: "PRO",
          interval: "ANNUAL",
          trialEndsAt: new Date("2024-03-20T00:00:00.000Z"),
        },
      ],
    });
    const app = await buildTestApp({ prisma, now: () => NOW });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/web/billing/interval",
        headers: { authorization: bearer(app, "observer_1") },
        payload: { interval: "ANNUAL" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("invoices (R28.17)", () => {
  it("lists seeded invoices and downloads a PDF; unknown id is 404", async () => {
    const { prisma } = makeFakePrisma({ members: [MEMBER] });
    const invoiceStore = new InMemoryInvoiceStore({
      invoices: {
        c1: [
          {
            id: "inv1",
            issuedAt: "2024-02-01T00:00:00.000Z",
            amountMinor: 49900,
            currency: "INR",
            pdfUrl: "/api/v1/web/billing/invoices/inv1.pdf",
          },
        ],
      },
      pdfs: { inv1: Buffer.from("%PDF-1.4 test invoice") },
    });
    const app = await buildTestApp({ prisma, invoiceStore });
    try {
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/web/billing/invoices",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().invoices).toHaveLength(1);
      expect(list.json().invoices[0].id).toBe("inv1");

      const pdf = await app.inject({
        method: "GET",
        url: "/api/v1/web/billing/invoices/inv1.pdf",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      expect(pdf.headers["content-disposition"]).toContain("kshema-invoice-inv1.pdf");
      expect(pdf.rawPayload.toString("utf8")).toContain("%PDF-1.4");

      const missing = await app.inject({
        method: "GET",
        url: "/api/v1/web/billing/invoices/nope.pdf",
        headers: { authorization: bearer(app, "observer_1") },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("requires authentication (401)", async () => {
    const { prisma } = makeFakePrisma({ members: [MEMBER] });
    const app = await buildTestApp({ prisma });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web/billing/invoices",
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
