/**
 * Unit tests for `POST /api/v1/telemetry/blackbox-sync` (task 6.1 — R8.4, R8.5,
 * R8.6, R19.3).
 *
 * Hermetic: a fake Prisma client records the created `EncryptedBlackBox` row
 * (with its nested `BlackBoxRecipientKey` rows) in memory. No live DB / Redis
 * needed. Bearer tokens are minted with the app's own `app.jwt` so the
 * `app.authenticate` guard passes.
 *
 * Coverage:
 *   - a sync persists ONE EncryptedBlackBox plus one recipient-key row per
 *     wrapped Observer key (R8.4, R8.5);
 *   - the ciphertext / iv / authTag are stored VERBATIM — the base64 fields
 *     round-trip byte-for-byte to the persisted Bytes buffers (R8.6, R19.3);
 *   - `released` is not set by the route (stays false — gated release is 6.2);
 *   - `anchorId` is taken from the bearer, not the body;
 *   - the route requires auth (401 without a bearer token, nothing persisted);
 *   - BELT-AND-SUSPENDERS: a source scan asserts the route module imports no
 *     decrypt capability (`@kshema/encryption/decrypt`) and references no
 *     `decrypt`/`unwrap` symbol — the server is decryption-blind (R8.6, R19.3).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadEnv } from "../config/env.js";

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

interface FakeRecipientRow {
  observerId: string;
  wrappedKey: Buffer;
}

interface FakeBoxRow {
  id: string;
  circleId: string;
  anchorId: string;
  encryptedPayload: Buffer;
  iv: Buffer;
  authTag: Buffer;
  capturedRangeStart: Date;
  capturedRangeEnd: Date;
  released: boolean;
  recipientKeys: FakeRecipientRow[];
}

/**
 * Fake Prisma covering exactly what the route uses: `encryptedBlackBox.create`
 * with a nested `recipientKeys.create` list and a `select: { id: true }`.
 * `released` defaults to false (mirroring the schema `@default(false)`) unless
 * the route explicitly sets it — which it must not.
 */
function makeFakePrisma() {
  const boxes: FakeBoxRow[] = [];
  let seq = 0;

  const prisma = {
    encryptedBlackBox: {
      create: vi.fn(
        async (args: {
          data: {
            circleId: string;
            anchorId: string;
            encryptedPayload: Buffer;
            iv: Buffer;
            authTag: Buffer;
            capturedRangeStart: Date;
            capturedRangeEnd: Date;
            released?: boolean;
            recipientKeys: { create: FakeRecipientRow[] };
          };
          select?: unknown;
        }) => {
          seq += 1;
          const row: FakeBoxRow = {
            id: `box_${seq}`,
            circleId: args.data.circleId,
            anchorId: args.data.anchorId,
            encryptedPayload: args.data.encryptedPayload,
            iv: args.data.iv,
            authTag: args.data.authTag,
            capturedRangeStart: args.data.capturedRangeStart,
            capturedRangeEnd: args.data.capturedRangeEnd,
            released: args.data.released ?? false,
            recipientKeys: args.data.recipientKeys.create.map((r) => ({
              observerId: r.observerId,
              wrappedKey: r.wrappedKey,
            })),
          };
          boxes.push(row);
          return { id: row.id };
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, boxes };
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

/** Random ciphertext-like blobs, encoded exactly as the device would send them. */
const payloadBytes = Buffer.from([0x00, 0xff, 0x10, 0x42, 0xde, 0xad, 0xbe, 0xef]);
const ivBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // 96-bit nonce
const tagBytes = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 7) % 256));
const wrappedA = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const wrappedB = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));

function syncPayload() {
  return {
    circleId: "circle_1",
    encryptedPayload: payloadBytes.toString("base64"),
    iv: ivBytes.toString("base64"),
    authTag: tagBytes.toString("base64"),
    recipientKeys: [
      { observerId: "observer_a", wrappedKey: wrappedA.toString("base64") },
      { observerId: "observer_b", wrappedKey: wrappedB.toString("base64") },
    ],
    capturedRange: {
      start: "2024-01-01T06:00:00.000Z",
      end: "2024-01-01T06:15:00.000Z",
    },
  };
}

describe("POST /api/v1/telemetry/blackbox-sync", () => {
  it("persists one EncryptedBlackBox plus one recipient-key row per Observer, ciphertext stored verbatim, released=false (R8.4, R8.5, R8.6)", async () => {
    const { prisma, boxes } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/blackbox-sync",
        headers: { authorization: bearer(app, "anchor_1") },
        payload: syncPayload(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.boxId).toBe("box_1");
      expect(body.storedRecipients).toBe(2);

      // Exactly one box persisted.
      expect(boxes).toHaveLength(1);
      const box = boxes[0]!;

      // anchorId comes from the bearer, not the body.
      expect(box.anchorId).toBe("anchor_1");
      expect(box.circleId).toBe("circle_1");

      // Ciphertext / iv / authTag stored VERBATIM: base64 -> Bytes round-trips
      // byte-for-byte back to the original request fields.
      expect(box.encryptedPayload.equals(payloadBytes)).toBe(true);
      expect(box.iv.equals(ivBytes)).toBe(true);
      expect(box.authTag.equals(tagBytes)).toBe(true);
      expect(box.encryptedPayload.toString("base64")).toBe(
        payloadBytes.toString("base64"),
      );

      // One recipient-key row per wrapped Observer key, wrappedKey verbatim.
      expect(box.recipientKeys).toHaveLength(2);
      const byObserver = new Map(
        box.recipientKeys.map((r) => [r.observerId, r.wrappedKey]),
      );
      expect(byObserver.get("observer_a")?.equals(wrappedA)).toBe(true);
      expect(byObserver.get("observer_b")?.equals(wrappedB)).toBe(true);

      // Captured range preserved.
      expect(box.capturedRangeStart.toISOString()).toBe(
        "2024-01-01T06:00:00.000Z",
      );
      expect(box.capturedRangeEnd.toISOString()).toBe(
        "2024-01-01T06:15:00.000Z",
      );

      // Gate stays closed — release is task 6.2.
      expect(box.released).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("stores a single recipient key when only one Observer is authorized (R8.5)", async () => {
    const { prisma, boxes } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const payload = syncPayload();
      payload.recipientKeys = [
        { observerId: "observer_solo", wrappedKey: wrappedA.toString("base64") },
      ];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/blackbox-sync",
        headers: { authorization: bearer(app, "anchor_1") },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().storedRecipients).toBe(1);
      expect(boxes[0]!.recipientKeys).toHaveLength(1);
      expect(boxes[0]!.recipientKeys[0]!.observerId).toBe("observer_solo");
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated sync with 401 and persists nothing", async () => {
    const { prisma, boxes } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/blackbox-sync",
        payload: syncPayload(),
      });

      expect(res.statusCode).toBe(401);
      expect(boxes).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a body carrying no recipient keys (fan-out wrap requires ≥1 Observer, R8.5)", async () => {
    const { prisma, boxes } = makeFakePrisma();
    const app = await buildTestApp({ prisma });

    try {
      const payload = syncPayload();
      // Schema enforces `recipientKeys` min(1); an empty array must be rejected
      // before any persistence.
      (payload as { recipientKeys: unknown[] }).recipientKeys = [];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/telemetry/blackbox-sync",
        headers: { authorization: bearer(app, "anchor_1") },
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(boxes).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("is server-blind by construction: the route source imports no decrypt capability (R8.6, R19.3)", () => {
    // Belt-and-suspenders guard: read the route module's own source and assert
    // it never imports a decrypt entrypoint nor references a decrypt/unwrap
    // symbol. The API stores ciphertext verbatim and can never decrypt it.
    const routeSource = readFileSync(
      fileURLToPath(new URL("./blackbox.ts", import.meta.url)),
      "utf8",
    );

    // Strip block/line comments first — the docstring legitimately DISCUSSES
    // decryption (explaining why the API can't do it), so the guard must scan
    // only executable code, not prose.
    const code = routeSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // No import of any decrypt capability from the encryption package, and no
    // decrypt/unwrap symbol referenced anywhere in the executable code.
    expect(code).not.toMatch(/@kshema\/encryption\/decrypt/);
    expect(code).not.toMatch(/decryptBlackBox/);
    expect(code).not.toMatch(/\bdecrypt/i);
    expect(code).not.toMatch(/\bunwrap/i);
  });
});

/**
 * Unit tests for `POST /api/v1/incidents/:id/blackbox` (task 6.2 — R8.7, R8.8,
 * R9.3, R19.6).
 *
 * Hermetic: a fake Prisma exposes `safetyIncident.findUnique/update`,
 * `circleMember.findFirst`, and `encryptedBlackBox.findFirst` over in-memory
 * fixtures. The route grants ONLY when the caller is a black-box-authorized
 * member of the incident's circle AND the box is released (Stage-4 or
 * Shadow_SOS), returns ciphertext-only for THAT observer, and appends a
 * BLACK_BOX_ACCESS event to the incident audit trail.
 *
 * Coverage:
 *   - authorized member + released box -> 200 ciphertext for that observer,
 *     with the observer's own wrapped key; access appended to the audit trail;
 *   - member WITHOUT canAccessBlackBox -> 403 (no box read, no audit write);
 *   - unreleased box (incident not Stage-4 / not Shadow_SOS) -> 403;
 *   - authorized member whose key is not wrapped on the box -> 403;
 *   - Shadow_SOS (HANDED_OFF_SOS) release path also grants;
 *   - the fetch route source imports no decrypt capability (R8.6, R19.3).
 */

interface FetchRecipientRow {
  observerId: string;
  wrappedKey: Buffer;
}

interface FetchBoxRow {
  id: string;
  circleId: string;
  anchorId: string;
  encryptedPayload: Buffer;
  iv: Buffer;
  authTag: Buffer;
  capturedRangeStart: Date;
  capturedRangeEnd: Date;
  released: boolean;
  recipientKeys: FetchRecipientRow[];
}

interface FetchIncidentRow {
  id: string;
  circleId: string;
  anchorId: string;
  stage: string;
  status: string;
  auditTrail: unknown[];
}

interface FetchMemberRow {
  circleId: string;
  userId: string;
  canAccessBlackBox: boolean;
}

interface FetchFixtures {
  incidents?: FetchIncidentRow[];
  members?: FetchMemberRow[];
  boxes?: FetchBoxRow[];
}

/** Fake Prisma covering exactly the reads/writes the fetch route performs. */
function makeFetchPrisma(fixtures: FetchFixtures) {
  const incidents = fixtures.incidents ?? [];
  const members = fixtures.members ?? [];
  const boxes = fixtures.boxes ?? [];

  const prisma = {
    safetyIncident: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const found = incidents.find((i) => i.id === args.where.id);
        return found ?? null;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: { auditTrail: unknown[] };
        }) => {
          const found = incidents.find((i) => i.id === args.where.id);
          if (found) found.auditTrail = args.data.auditTrail;
          return found ?? null;
        },
      ),
    },
    circleMember: {
      findFirst: vi.fn(
        async (args: { where: { circleId: string; userId: string } }) => {
          const found = members.find(
            (m) =>
              m.circleId === args.where.circleId &&
              m.userId === args.where.userId,
          );
          return found ? { canAccessBlackBox: found.canAccessBlackBox } : null;
        },
      ),
    },
    encryptedBlackBox: {
      findFirst: vi.fn(
        async (args: {
          where: { circleId: string; anchorId: string; released: boolean };
          orderBy?: unknown;
          select?: {
            recipientKeys?: { where?: { observerId: string } };
          };
        }) => {
          const matches = boxes.filter(
            (b) =>
              b.circleId === args.where.circleId &&
              b.anchorId === args.where.anchorId &&
              b.released === args.where.released,
          );
          // Mirror the route's ordering: most recent captured range first.
          matches.sort(
            (a, b) =>
              b.capturedRangeEnd.getTime() - a.capturedRangeEnd.getTime(),
          );
          const box = matches[0];
          if (!box) return null;

          const observerFilter =
            args.select?.recipientKeys?.where?.observerId;
          const recipientKeys = (
            observerFilter === undefined
              ? box.recipientKeys
              : box.recipientKeys.filter((r) => r.observerId === observerFilter)
          ).map((r) => ({ wrappedKey: r.wrappedKey }));

          return {
            id: box.id,
            encryptedPayload: box.encryptedPayload,
            iv: box.iv,
            authTag: box.authTag,
            capturedRangeStart: box.capturedRangeStart,
            capturedRangeEnd: box.capturedRangeEnd,
            recipientKeys,
          };
        },
      ),
    },
    $disconnect: vi.fn(async () => undefined),
  } as unknown as BuildAppOptions["prisma"];

  return { prisma, incidents, members, boxes };
}

const fetchPayload = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
const fetchIv = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]);
const fetchTag = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 3) % 256));
const fetchWrappedForA = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const fetchWrappedForB = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i));

function releasedBox(overrides: Partial<FetchBoxRow> = {}): FetchBoxRow {
  return {
    id: "box_rel",
    circleId: "circle_1",
    anchorId: "anchor_1",
    encryptedPayload: fetchPayload,
    iv: fetchIv,
    authTag: fetchTag,
    capturedRangeStart: new Date("2024-01-01T06:00:00.000Z"),
    capturedRangeEnd: new Date("2024-01-01T06:15:00.000Z"),
    released: true,
    recipientKeys: [
      { observerId: "observer_a", wrappedKey: fetchWrappedForA },
      { observerId: "observer_b", wrappedKey: fetchWrappedForB },
    ],
    ...overrides,
  };
}

function stage4Incident(overrides: Partial<FetchIncidentRow> = {}): FetchIncidentRow {
  return {
    id: "incident_1",
    circleId: "circle_1",
    anchorId: "anchor_1",
    stage: "STAGE_4_HYPERLOCAL_DISPATCH",
    status: "OPEN",
    auditTrail: [{ stage: "STAGE_1_CONVERSATIONAL_WHATSAPP", at: "t0", cause: "raise" }],
    ...overrides,
  };
}

describe("POST /api/v1/incidents/:id/blackbox", () => {
  it("grants ciphertext to an authorized member when the box is released (Stage-4), returning only that observer's wrapped key (R8.8, R9.3)", async () => {
    const { prisma, incidents } = makeFetchPrisma({
      incidents: [stage4Incident()],
      members: [
        { circleId: "circle_1", userId: "observer_a", canAccessBlackBox: true },
      ],
      boxes: [releasedBox()],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
        headers: { authorization: bearer(app, "observer_a") },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.boxId).toBe("box_rel");
      // Ciphertext returned verbatim, base64-encoded.
      expect(body.encryptedPayload).toBe(fetchPayload.toString("base64"));
      expect(body.iv).toBe(fetchIv.toString("base64"));
      expect(body.authTag).toBe(fetchTag.toString("base64"));
      // ONLY observer_a's wrapped key — not observer_b's.
      expect(body.wrappedKey).toBe(fetchWrappedForA.toString("base64"));
      expect(body.wrappedKey).not.toBe(fetchWrappedForB.toString("base64"));
      expect(body.capturedRange).toEqual({
        start: "2024-01-01T06:00:00.000Z",
        end: "2024-01-01T06:15:00.000Z",
      });

      // Access recorded in the incident audit trail (R19.6): the prior entry is
      // preserved and a BLACK_BOX_ACCESS event is appended.
      const trail = incidents[0]!.auditTrail as Array<Record<string, unknown>>;
      expect(trail).toHaveLength(2);
      const access = trail[1]!;
      expect(access.type).toBe("BLACK_BOX_ACCESS");
      expect(access.observerId).toBe("observer_a");
      expect(access.boxId).toBe("box_rel");
      expect(typeof access.at).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("grants when the box is released via Shadow_SOS handoff (HANDED_OFF_SOS), even below Stage-4 (R8.8)", async () => {
    const { prisma, incidents } = makeFetchPrisma({
      incidents: [
        stage4Incident({
          stage: "STAGE_1_CONVERSATIONAL_WHATSAPP",
          status: "HANDED_OFF_SOS",
        }),
      ],
      members: [
        { circleId: "circle_1", userId: "observer_a", canAccessBlackBox: true },
      ],
      boxes: [releasedBox()],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
        headers: { authorization: bearer(app, "observer_a") },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().wrappedKey).toBe(fetchWrappedForA.toString("base64"));
      // Audit still records the access.
      const trail = incidents[0]!.auditTrail as Array<Record<string, unknown>>;
      expect(trail.at(-1)!.type).toBe("BLACK_BOX_ACCESS");
    } finally {
      await app.close();
    }
  });

  it("denies (403) a member who lacks canAccessBlackBox and writes no audit entry (R8.8)", async () => {
    const { prisma, incidents } = makeFetchPrisma({
      incidents: [stage4Incident()],
      members: [
        { circleId: "circle_1", userId: "observer_a", canAccessBlackBox: false },
      ],
      boxes: [releasedBox()],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
        headers: { authorization: bearer(app, "observer_a") },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Forbidden");
      // No BLACK_BOX_ACCESS appended.
      const trail = incidents[0]!.auditTrail as Array<Record<string, unknown>>;
      expect(trail).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("denies (403) a non-member of the incident's circle (R8.8)", async () => {
    const { prisma } = makeFetchPrisma({
      incidents: [stage4Incident()],
      members: [],
      boxes: [releasedBox()],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
        headers: { authorization: bearer(app, "stranger") },
      });

      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("denies (403) when the black box has NOT been released (incident below Stage-4, not Shadow_SOS) (R8.7, R9.3)", async () => {
    const { prisma, incidents } = makeFetchPrisma({
      incidents: [
        stage4Incident({
          stage: "STAGE_3_OBSERVER_SILENT_ALERT",
          status: "OPEN",
        }),
      ],
      members: [
        { circleId: "circle_1", userId: "observer_a", canAccessBlackBox: true },
      ],
      // Even if an unreleased box exists, the gate is closed by incident state.
      boxes: [releasedBox({ released: false })],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
        headers: { authorization: bearer(app, "observer_a") },
      });

      expect(res.statusCode).toBe(403);
      const trail = incidents[0]!.auditTrail as Array<Record<string, unknown>>;
      expect(trail).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("denies (403) an authorized member whose key is not wrapped on the released box", async () => {
    const { prisma } = makeFetchPrisma({
      incidents: [stage4Incident()],
      members: [
        { circleId: "circle_1", userId: "observer_c", canAccessBlackBox: true },
      ],
      // Box wraps keys only for observer_a and observer_b.
      boxes: [releasedBox()],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
        headers: { authorization: bearer(app, "observer_c") },
      });

      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for an unknown incident id", async () => {
    const { prisma } = makeFetchPrisma({
      incidents: [],
      members: [],
      boxes: [],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/nope/blackbox",
        headers: { authorization: bearer(app, "observer_a") },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("Not Found");
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the incident is released but no released box exists for its anchor/circle", async () => {
    const { prisma } = makeFetchPrisma({
      incidents: [stage4Incident()],
      members: [
        { circleId: "circle_1", userId: "observer_a", canAccessBlackBox: true },
      ],
      boxes: [],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
        headers: { authorization: bearer(app, "observer_a") },
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated fetch with 401", async () => {
    const { prisma } = makeFetchPrisma({
      incidents: [stage4Incident()],
      members: [
        { circleId: "circle_1", userId: "observer_a", canAccessBlackBox: true },
      ],
      boxes: [releasedBox()],
    });
    const app = await buildTestApp({ prisma });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/incidents/incident_1/blackbox",
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
