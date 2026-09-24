// Feature: kshema-safety-platform, Property 3: Black-box access authorization.
// For all CircleMembers with arbitrary permission flags and Encrypted_Black_Boxes
// with arbitrary release state, a fetch of the payload SHALL be granted if and
// only if the member holds `canAccessBlackBox` AND the box has been released
// (via Stage-4 or Shadow_SOS); otherwise it SHALL be denied with an
// authorization error.
/**
 * Property-based test for `POST /api/v1/incidents/:id/blackbox` (task 6.3).
 *
 * Validates: Requirements 8.7, 8.8, 9.3
 *
 * Uses the same hermetic fake-Prisma + `app.inject` harness style as the unit
 * tests in `blackbox.test.ts` (copied here so this property test is
 * self-contained and does not depend on that file's non-exported helpers). The
 * fake Prisma exposes `safetyIncident.findUnique/update`,
 * `circleMember.findFirst`, and `encryptedBlackBox.findFirst` over in-memory
 * fixtures, and records any audit-trail write so the property can assert
 * whether a BLACK_BOX_ACCESS entry was appended.
 *
 * The property draws arbitrary combinations of five independent facts:
 *   - the caller is a member of the incident's circle (bool)
 *   - that member holds `canAccessBlackBox` (bool)
 *   - the incident's stage (any IncidentStage)
 *   - the incident's status (any IncidentStatus)
 *   - a released box carrying a wrapped key for THIS observer exists (bool)
 *
 * and asserts the grant law:
 *   200 (grant) IFF isMember AND canAccessBlackBox AND released AND recipientKeyPresent
 *   where released = stage === STAGE_4_HYPERLOCAL_DISPATCH OR status === HANDED_OFF_SOS.
 *
 * On any deny it further asserts NO ciphertext is returned and NO audit entry
 * is appended. In the main property a released box always exists for the
 * incident, so every denial is an authorization failure (403): non-member,
 * missing permission, unreleased incident, or (route step 5) an authorized
 * member with no wrapped key on the box. A sibling property drives the
 * unknown-incident 404 path. On grant it asserts exactly the requesting
 * observer's wrapped key is returned and exactly one BLACK_BOX_ACCESS entry is
 * appended to the pre-existing audit trail.
 */
import fc from "fast-check";
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

const RELEASED_STAGE = "STAGE_4_HYPERLOCAL_DISPATCH" as const;
const RELEASED_STATUS = "HANDED_OFF_SOS" as const;

const ALL_STAGES = [
  "STAGE_1_CONVERSATIONAL_WHATSAPP",
  "STAGE_2_GENTLE_DEVICE_CHIME",
  "STAGE_3_OBSERVER_SILENT_ALERT",
  "STAGE_4_HYPERLOCAL_DISPATCH",
] as const;

const ALL_STATUSES = ["OPEN", "RESOLVED", "HANDED_OFF_SOS"] as const;

// -- Fake Prisma (copied from blackbox.test.ts, trimmed to the fetch route) --

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
          matches.sort(
            (a, b) =>
              b.capturedRangeEnd.getTime() - a.capturedRangeEnd.getTime(),
          );
          const box = matches[0];
          if (!box) return null;

          const observerFilter = args.select?.recipientKeys?.where?.observerId;
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

async function buildTestApp(
  overrides: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(), loggerEnabled: false, ...overrides });
}

function bearer(app: FastifyInstance, userId: string): string {
  const token = app.jwt.sign({ sub: userId, channel: "MOBILE" });
  return `Bearer ${token}`;
}

// Fixed ciphertext material — arbitrary but constant so grants are checkable.
const CIPHERTEXT = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
const IV = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]);
const TAG = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 3) % 256));
const WRAPPED_FOR_OBSERVER = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i + 1),
);
// A DIFFERENT observer's key, present on the box but never for the caller.
const WRAPPED_FOR_OTHER = Buffer.from(
  Array.from({ length: 32 }, (_, i) => 200 - i),
);

const CIRCLE_ID = "circle_1";
const ANCHOR_ID = "anchor_1";
const INCIDENT_ID = "incident_1";
const OBSERVER_ID = "observer_a";
const OTHER_OBSERVER_ID = "observer_b";

// -- The scenario the property varies over ----------------------------------

interface Scenario {
  isMember: boolean;
  canAccessBlackBox: boolean;
  stage: string;
  status: string;
  // A released box wrapped for THIS observer exists in the store.
  recipientKeyPresent: boolean;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  isMember: fc.boolean(),
  canAccessBlackBox: fc.boolean(),
  stage: fc.constantFrom(...ALL_STAGES),
  status: fc.constantFrom(...ALL_STATUSES),
  recipientKeyPresent: fc.boolean(),
});

describe("POST /api/v1/incidents/:id/blackbox — Property 3 (R8.7, R8.8, R9.3)", () => {
  it("grants (200) IFF member+permission+released+recipient-key; else denies (403 authz / 404 missing box) with no ciphertext and no audit write", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const priorTrail = [
          { stage: "STAGE_1_CONVERSATIONAL_WHATSAPP", at: "t0", cause: "raise" },
        ];

        // Build fixtures reflecting the scenario.
        const members: FetchMemberRow[] = s.isMember
          ? [
              {
                circleId: CIRCLE_ID,
                userId: OBSERVER_ID,
                canAccessBlackBox: s.canAccessBlackBox,
              },
            ]
          : [];

        // A released box always carries the OTHER observer's key. It carries
        // THIS observer's key only when recipientKeyPresent. Note the store
        // only ever holds a `released: true` box, so when the incident state is
        // NOT released the route's box lookup (scoped to released boxes) yields
        // nothing — but the release gate denies first regardless.
        const recipientKeys: FetchRecipientRow[] = [
          { observerId: OTHER_OBSERVER_ID, wrappedKey: WRAPPED_FOR_OTHER },
        ];
        if (s.recipientKeyPresent) {
          recipientKeys.push({
            observerId: OBSERVER_ID,
            wrappedKey: WRAPPED_FOR_OBSERVER,
          });
        }
        const boxes: FetchBoxRow[] = [
          {
            id: "box_rel",
            circleId: CIRCLE_ID,
            anchorId: ANCHOR_ID,
            encryptedPayload: CIPHERTEXT,
            iv: IV,
            authTag: TAG,
            capturedRangeStart: new Date("2024-01-01T06:00:00.000Z"),
            capturedRangeEnd: new Date("2024-01-01T06:15:00.000Z"),
            released: true,
            recipientKeys,
          },
        ];

        const incidents: FetchIncidentRow[] = [
          {
            id: INCIDENT_ID,
            circleId: CIRCLE_ID,
            anchorId: ANCHOR_ID,
            stage: s.stage,
            status: s.status,
            auditTrail: [...priorTrail],
          },
        ];

        const { prisma } = makeFetchPrisma({ incidents, members, boxes });
        const app = await buildTestApp({ prisma });
        try {
          const res = await app.inject({
            method: "POST",
            url: `/api/v1/incidents/${INCIDENT_ID}/blackbox`,
            headers: { authorization: bearer(app, OBSERVER_ID) },
          });

          const released =
            s.stage === RELEASED_STAGE || s.status === RELEASED_STATUS;
          const shouldGrant =
            s.isMember &&
            s.canAccessBlackBox &&
            released &&
            s.recipientKeyPresent;

          const trail = incidents[0]!.auditTrail as Array<
            Record<string, unknown>
          >;

          if (shouldGrant) {
            // ---- GRANT LAW ----
            expect(res.statusCode).toBe(200);
            const body = res.json();
            // Ciphertext returned verbatim (base64).
            expect(body.encryptedPayload).toBe(CIPHERTEXT.toString("base64"));
            expect(body.iv).toBe(IV.toString("base64"));
            expect(body.authTag).toBe(TAG.toString("base64"));
            // EXACTLY the requesting observer's wrapped key — never the other's.
            expect(body.wrappedKey).toBe(
              WRAPPED_FOR_OBSERVER.toString("base64"),
            );
            expect(body.wrappedKey).not.toBe(
              WRAPPED_FOR_OTHER.toString("base64"),
            );
            // Exactly one BLACK_BOX_ACCESS entry appended to the prior trail.
            expect(trail).toHaveLength(priorTrail.length + 1);
            const access = trail.at(-1)!;
            expect(access.type).toBe("BLACK_BOX_ACCESS");
            expect(access.observerId).toBe(OBSERVER_ID);
            expect(access.boxId).toBe("box_rel");
            const accessCount = trail.filter(
              (e) => e.type === "BLACK_BOX_ACCESS",
            ).length;
            expect(accessCount).toBe(1);
          } else {
            // ---- DENY LAW ----
            // In this fixture a released box (id "box_rel") ALWAYS exists for
            // the incident's circle+anchor, so the route never hits its "no
            // released box" 404. Every denial here is therefore an
            // authorization failure returning 403: a non-member, a member
            // without `canAccessBlackBox`, an unreleased incident, or (step 5
            // of the route) an authorized member whose key is not wrapped on
            // the box. Unknown-incident 404 is exercised by the sibling test.
            expect(res.statusCode).toBe(403);

            const body = res.json();
            // No ciphertext leaked on any deny.
            expect(body.encryptedPayload).toBeUndefined();
            expect(body.iv).toBeUndefined();
            expect(body.authTag).toBeUndefined();
            expect(body.wrappedKey).toBeUndefined();
            expect(body.error).toBeDefined();

            // No audit entry appended: trail is untouched.
            expect(trail).toHaveLength(priorTrail.length);
            const accessCount = trail.filter(
              (e) => (e as Record<string, unknown>).type === "BLACK_BOX_ACCESS",
            ).length;
            expect(accessCount).toBe(0);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it("returns 404 for an unknown incident and leaves no ciphertext / audit trace", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 24 }),
        async (unknownId) => {
          // Never collide with the real incident id.
          fc.pre(unknownId !== INCIDENT_ID);

          const { prisma, incidents } = makeFetchPrisma({
            incidents: [
              {
                id: INCIDENT_ID,
                circleId: CIRCLE_ID,
                anchorId: ANCHOR_ID,
                stage: RELEASED_STAGE,
                status: "OPEN",
                auditTrail: [],
              },
            ],
            members: [
              {
                circleId: CIRCLE_ID,
                userId: OBSERVER_ID,
                canAccessBlackBox: true,
              },
            ],
            boxes: [],
          });
          const app = await buildTestApp({ prisma });
          try {
            const res = await app.inject({
              method: "POST",
              url: `/api/v1/incidents/${encodeURIComponent(unknownId)}/blackbox`,
              headers: { authorization: bearer(app, OBSERVER_ID) },
            });

            expect(res.statusCode).toBe(404);
            const body = res.json();
            expect(body.error).toBe("Not Found");
            expect(body.encryptedPayload).toBeUndefined();
            // The known incident's trail is untouched.
            expect(incidents[0]!.auditTrail).toHaveLength(0);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);
});
