/**
 * Local-development seed for the Kshema Ambient Safety Platform.
 *
 * Creates a demo Circle with:
 *   - one Anchor (the protected person),
 *   - one Observer (a family member who watches over them),
 *   - a Sentinel policy (default Elderly_Care persona) + adaptive rhythm profile,
 *   - a 14-day TRIAL subscription and a fresh vitality streak.
 *
 * Privacy note: the seed stores only PEM *public* keys — no private key ever
 * touches the database (R8.6 / R19.3). The public-key strings below are inert
 * placeholders purely for local development.
 *
 * Idempotent: safe to run repeatedly (keyed on the demo users' phone numbers).
 */
import { PrismaClient, CircleRole, SentinelMode, SubscriptionTier } from "@prisma/client";

const prisma = new PrismaClient();

// Inert placeholder PEM public keys for local dev only (never real keys).
const ANCHOR_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nDEMO-ANCHOR-PUBLIC-KEY-DO-NOT-USE-IN-PRODUCTION\n-----END PUBLIC KEY-----";
const OBSERVER_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nDEMO-OBSERVER-PUBLIC-KEY-DO-NOT-USE-IN-PRODUCTION\n-----END PUBLIC KEY-----";

const ANCHOR_PHONE = "+919000000001";
const OBSERVER_PHONE = "+919000000002";

async function main(): Promise<void> {
  // --- Demo users (upsert by unique phone so re-runs are idempotent) ---
  const anchor = await prisma.user.upsert({
    where: { phone: ANCHOR_PHONE },
    update: { publicKeyPem: ANCHOR_PUBLIC_KEY_PEM, preferredName: "Amma" },
    create: {
      phone: ANCHOR_PHONE,
      publicKeyPem: ANCHOR_PUBLIC_KEY_PEM,
      preferredName: "Amma",
      timezone: "Asia/Kolkata",
    },
  });

  const observer = await prisma.user.upsert({
    where: { phone: OBSERVER_PHONE },
    update: { publicKeyPem: OBSERVER_PUBLIC_KEY_PEM, preferredName: "Ravi" },
    create: {
      phone: OBSERVER_PHONE,
      publicKeyPem: OBSERVER_PUBLIC_KEY_PEM,
      preferredName: "Ravi",
      timezone: "Asia/Kolkata",
    },
  });

  // --- Demo circle (reuse if the anchor is already a member of one) ---
  const existingMembership = await prisma.circleMember.findFirst({
    where: { userId: anchor.id, role: CircleRole.ANCHOR },
    include: { circle: true },
  });

  const circle =
    existingMembership?.circle ??
    (await prisma.circle.create({ data: { name: "Demo Family Circle" } }));

  // --- Members: Anchor + Observer ---
  await prisma.circleMember.upsert({
    where: { circleId_userId: { circleId: circle.id, userId: anchor.id } },
    update: { role: CircleRole.ANCHOR },
    create: {
      circleId: circle.id,
      userId: anchor.id,
      role: CircleRole.ANCHOR,
    },
  });

  await prisma.circleMember.upsert({
    where: { circleId_userId: { circleId: circle.id, userId: observer.id } },
    update: {
      role: CircleRole.OBSERVER,
      canTriggerIVR: true,
      canAccessBlackBox: true,
      observerPublicKeyPem: OBSERVER_PUBLIC_KEY_PEM, // recorded for black-box key wrapping (R2.8)
    },
    create: {
      circleId: circle.id,
      userId: observer.id,
      role: CircleRole.OBSERVER,
      canTriggerIVR: true,
      canAccessBlackBox: true,
      observerPublicKeyPem: OBSERVER_PUBLIC_KEY_PEM,
    },
  });

  // --- Sentinel policy (default Elderly_Care persona; R3.2) + rhythm profile ---
  const policy = await prisma.sentinelPolicy.upsert({
    where: { circleId: circle.id },
    update: { anchorId: anchor.id, modes: [SentinelMode.ELDERLY_CARE] },
    create: {
      circleId: circle.id,
      anchorId: anchor.id,
      modes: [SentinelMode.ELDERLY_CARE],
      wakeConfig: {
        transitDeadlineMin: null,
        recoveryThresholdMin: null,
        activeHours: { start: "06:00", end: "22:00" },
      },
    },
  });

  await prisma.adaptiveRhythmProfile.upsert({
    where: { policyId: policy.id },
    update: {},
    create: {
      policyId: policy.id,
      // A modest partial baseline: wake between ~06:20 and ~06:50 (minute-of-day).
      wakeSamples: [380, 395, 410, 402, 388, 415, 400],
      meanWakeMinute: 398.57,
      stdDevWakeMinute: 11.6,
      avgStep30d: 4200,
    },
  });

  // --- 14-day TRIAL subscription (R20.1) ---
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 14);
  await prisma.subscription.upsert({
    where: { circleId: circle.id },
    update: {},
    create: {
      circleId: circle.id,
      tier: SubscriptionTier.TRIAL,
      trialEndsAt,
    },
  });

  // --- Fresh vitality streak ---
  await prisma.vitalityStreak.upsert({
    where: { circleId: circle.id },
    update: {},
    create: { circleId: circle.id, count: 0 },
  });

  console.log("Seed complete:");
  console.log(`  Circle:   ${circle.id} (${circle.name})`);
  console.log(`  Anchor:   ${anchor.id} (${anchor.preferredName}, ${anchor.phone})`);
  console.log(`  Observer: ${observer.id} (${observer.preferredName}, ${observer.phone})`);
  console.log(`  Policy:   ${policy.id} [${SentinelMode.ELDERLY_CARE}]`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
