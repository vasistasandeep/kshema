-- CreateEnum
CREATE TYPE "CircleRole" AS ENUM ('ANCHOR', 'OBSERVER', 'MUTUAL');

-- CreateEnum
CREATE TYPE "SentinelMode" AS ENUM ('ELDERLY_CARE', 'SOLO_LIVING', 'ACTIVE_SESSION', 'JOURNEY_WATCH', 'POST_OP_RECOVERY');

-- CreateEnum
CREATE TYPE "IncidentStage" AS ENUM ('STAGE_1_CONVERSATIONAL_WHATSAPP', 'STAGE_2_GENTLE_DEVICE_CHIME', 'STAGE_3_OBSERVER_SILENT_ALERT', 'STAGE_4_HYPERLOCAL_DISPATCH');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED', 'HANDED_OFF_SOS');

-- CreateEnum
CREATE TYPE "ResolutionSource" AS ENUM ('SCREEN_UNLOCK', 'STEP_DELTA', 'CHARGER_UNPLUG', 'GHOST_SIGNAL', 'WHATSAPP_RESPONSE', 'ANCHOR_DISMISSAL', 'OBSERVER_OVERRIDE', 'SHADOW_SOS_HANDOFF', 'CO_LIVING_PARTNER_CONFIRMED', 'RESPONDER_CONFIRMED');

-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('TRIAL', 'PRO', 'SHIELD_PAUSED');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT_AGENT', 'BILLING_OPS');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('VIEW', 'QUERY', 'MUTATION', 'EXPORT', 'SECURITY_VIOLATION');

-- CreateEnum
CREATE TYPE "SparshType" AS ENUM ('MORNING_CHAI', 'PRANAM_BLESSING', 'MORNING_SUN', 'MARIGOLD_FLOWER', 'HEART_BLESSING');

-- CreateEnum
CREATE TYPE "GhostSignalType" AS ENUM ('MEDIA_DEVICE_WAKE', 'HOME_WIFI_REASSOCIATION');

-- CreateEnum
CREATE TYPE "DossierAccessState" AS ENUM ('LOCKED', 'RELEASED_EMERGENCY', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LoginChannel" AS ENUM ('MOBILE', 'WEB');

-- CreateEnum
CREATE TYPE "BatteryWarningKind" AS ENUM ('BEDTIME_LOW', 'PRE_DAWN_BATTERY_EXHAUSTION_WARNING');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "publicKeyPem" TEXT NOT NULL,
    "preferredName" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "pushTokens" TEXT[],
    "disclaimerAcceptedAt" TIMESTAMP(3),
    "disclaimerVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Circle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Circle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleMember" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CircleRole" NOT NULL,
    "canTriggerIVR" BOOLEAN NOT NULL DEFAULT false,
    "canAccessBlackBox" BOOLEAN NOT NULL DEFAULT false,
    "observerPublicKeyPem" TEXT,

    CONSTRAINT "CircleMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentinelPolicy" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "modes" "SentinelMode"[] DEFAULT ARRAY['ELDERLY_CARE']::"SentinelMode"[],
    "wakeConfig" JSONB NOT NULL,

    CONSTRAINT "SentinelPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdaptiveRhythmProfile" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "wakeSamples" INTEGER[],
    "meanWakeMinute" DOUBLE PRECISION NOT NULL,
    "stdDevWakeMinute" DOUBLE PRECISION NOT NULL,
    "avgStep30d" DOUBLE PRECISION NOT NULL,
    "weekendOffsetMin" INTEGER NOT NULL DEFAULT 45,
    "fatigueOffsetMin" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdaptiveRhythmProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "screenUnlock" BOOLEAN NOT NULL DEFAULT false,
    "stepDelta" INTEGER NOT NULL DEFAULT 0,
    "batteryLevel" INTEGER,
    "chargerState" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GhostSignalLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signalType" "GhostSignalType" NOT NULL,
    "source" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhostSignalLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncryptedBlackBox" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "encryptedPayload" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "capturedRangeStart" TIMESTAMP(3) NOT NULL,
    "capturedRangeEnd" TIMESTAMP(3) NOT NULL,
    "released" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EncryptedBlackBox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlackBoxRecipientKey" (
    "id" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "observerId" TEXT NOT NULL,
    "wrappedKey" BYTEA NOT NULL,

    CONSTRAINT "BlackBoxRecipientKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyIncident" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "stage" "IncidentStage" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "batteryDepletionLikely" BOOLEAN NOT NULL DEFAULT false,
    "auditTrail" JSONB NOT NULL,
    "resolutionSource" "ResolutionSource",
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SafetyIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HyperlocalContactProfile" (
    "id" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "building" TEXT,
    "flat" TEXT,
    "society" TEXT,
    "doorAccess" TEXT,
    "primaryObserverPhone" TEXT,
    "gatePhone" TEXT,
    "neighborPhone" TEXT,

    CONSTRAINT "HyperlocalContactProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VitalityPulseLog" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VitalityPulseLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VitalityStreak" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastConfirmedDay" TEXT,
    "freezeUntil" TIMESTAMP(3),

    CONSTRAINT "VitalityStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SparshInteraction" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "type" "SparshType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SparshInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PanchangaAlmanac" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "locationKey" TEXT NOT NULL,
    "sunrise" TEXT NOT NULL,
    "sunset" TEXT NOT NULL,
    "tithi" TEXT NOT NULL,
    "nakshatra" TEXT NOT NULL,
    "masa" TEXT NOT NULL,
    "festivals" TEXT[],
    "proverbKey" TEXT NOT NULL,

    CONSTRAINT "PanchangaAlmanac_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "oem" TEXT,
    "batteryExempt" BOOLEAN NOT NULL DEFAULT false,
    "foregroundServiceActive" BOOLEAN NOT NULL DEFAULT false,
    "lastTelemetrySyncAt" TIMESTAMP(3),

    CONSTRAINT "DeviceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL DEFAULT 'TRIAL',
    "interval" "BillingInterval",
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "proSince" TIMESTAMP(3),
    "externalRef" TEXT,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "mfaEnrolled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "sourceIp" TEXT NOT NULL,
    "targetEntity" TEXT NOT NULL,
    "justification" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierGatewayMetric" (
    "id" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "deliveryLatencyMs" INTEGER,
    "templateRejections" INTEGER NOT NULL DEFAULT 0,
    "dltStatus" TEXT,
    "ivrSuccess" BOOLEAN,
    "errorRate" DOUBLE PRECISION,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierGatewayMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyAccessToken" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'EMERGENCY_TRIAGE_READ',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyMedicalDossier" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedPayload" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "encryptedEmergencyKey" BYTEA NOT NULL,
    "bloodGroup" TEXT,
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "chronicConditions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "criticalMedications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attendingDoctorName" TEXT,
    "attendingDoctorPhone" TEXT,
    "healthInsurancePolicy" TEXT,
    "accessState" "DossierAccessState" NOT NULL DEFAULT 'LOCKED',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyMedicalDossier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SanctuarySchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "resumesAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SanctuarySchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdProfile" (
    "id" TEXT NOT NULL,
    "householdName" TEXT NOT NULL,
    "anchorIds" TEXT[],
    "sharedWifiBssids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sharedMediaDeviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatteryWarningLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "BatteryWarningKind" NOT NULL,
    "batteryLevel" INTEGER NOT NULL,
    "chargerState" TEXT NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatteryWarningLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "CircleMember_circleId_userId_key" ON "CircleMember"("circleId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "SentinelPolicy_circleId_key" ON "SentinelPolicy"("circleId");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptiveRhythmProfile_policyId_key" ON "AdaptiveRhythmProfile"("policyId");

-- CreateIndex
CREATE INDEX "TelemetryLog_userId_capturedAt_idx" ON "TelemetryLog"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "GhostSignalLog_userId_detectedAt_idx" ON "GhostSignalLog"("userId", "detectedAt");

-- CreateIndex
CREATE INDEX "EncryptedBlackBox_anchorId_createdAt_idx" ON "EncryptedBlackBox"("anchorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlackBoxRecipientKey_boxId_observerId_key" ON "BlackBoxRecipientKey"("boxId", "observerId");

-- CreateIndex
CREATE INDEX "SafetyIncident_circleId_status_idx" ON "SafetyIncident"("circleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HyperlocalContactProfile_anchorId_key" ON "HyperlocalContactProfile"("anchorId");

-- CreateIndex
CREATE UNIQUE INDEX "VitalityStreak_circleId_key" ON "VitalityStreak"("circleId");

-- CreateIndex
CREATE INDEX "SparshInteraction_circleId_createdAt_idx" ON "SparshInteraction"("circleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PanchangaAlmanac_date_locationKey_key" ON "PanchangaAlmanac"("date", "locationKey");

-- CreateIndex
CREATE INDEX "DeviceConfig_userId_idx" ON "DeviceConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_circleId_key" ON "Subscription"("circleId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminUserId_createdAt_idx" ON "AdminAuditLog"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CarrierGatewayMetric_gateway_windowStart_idx" ON "CarrierGatewayMetric"("gateway", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_userId_idx" ON "WebAuthnCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyAccessToken_incidentId_key" ON "EmergencyAccessToken"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyAccessToken_tokenHash_key" ON "EmergencyAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmergencyAccessToken_incidentId_expiresAt_idx" ON "EmergencyAccessToken"("incidentId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyMedicalDossier_userId_key" ON "EmergencyMedicalDossier"("userId");

-- CreateIndex
CREATE INDEX "SanctuarySchedule_userId_isActive_resumesAt_idx" ON "SanctuarySchedule"("userId", "isActive", "resumesAt");

-- CreateIndex
CREATE INDEX "HouseholdProfile_householdName_idx" ON "HouseholdProfile"("householdName");

-- CreateIndex
CREATE INDEX "BatteryWarningLog_userId_loggedAt_idx" ON "BatteryWarningLog"("userId", "loggedAt");

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SentinelPolicy" ADD CONSTRAINT "SentinelPolicy_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdaptiveRhythmProfile" ADD CONSTRAINT "AdaptiveRhythmProfile_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "SentinelPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryLog" ADD CONSTRAINT "TelemetryLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GhostSignalLog" ADD CONSTRAINT "GhostSignalLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlackBoxRecipientKey" ADD CONSTRAINT "BlackBoxRecipientKey_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "EncryptedBlackBox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyIncident" ADD CONSTRAINT "SafetyIncident_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VitalityStreak" ADD CONSTRAINT "VitalityStreak_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyMedicalDossier" ADD CONSTRAINT "EmergencyMedicalDossier_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SanctuarySchedule" ADD CONSTRAINT "SanctuarySchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatteryWarningLog" ADD CONSTRAINT "BatteryWarningLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
