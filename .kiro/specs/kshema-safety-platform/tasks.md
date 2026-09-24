# Implementation Plan: Kshema Ambient Safety Platform

## Overview

This plan converts the approved design into a series of incremental TypeScript coding tasks for a Turborepo + pnpm monorepo comprising `apps/api` (Fastify), `apps/worker` (BullMQ), `apps/mobile` (Expo/React Native), `apps/admin` (Next.js), `apps/web` (Next.js), and shared `packages/*` (config, types, database, encryption, ui).

Tasks are ordered so each builds on the previous and ends by wiring things together, following the design's build order and the six-milestone roadmap intent:

1. Monorepo scaffolding, infra, and shared packages
2. Fastify API core (auth, circles, telemetry, blackbox-sync, webhooks)
3. `packages/encryption` (AES-256-GCM + RSA-OAEP, black-box round-trip and tamper)
4. Sentinel worker (rhythm engine, escalation FSM, resolution, SOS, sanctuary, co-living, telephony/AMD)
5. Subscription lifecycle and tier gating
6. Hyperlocal dispatch, emergency access token, ephemeral responder portal, medical dossier
7. Mobile foundation and background/ambient agents
8. Mobile UI (Observer/Anchor surfaces, vitality, i18n)
9. `apps/web` (public portal, observer web portal, billing)
10. `apps/admin` console
11. Cross-cutting quality gates

Property-based tests use `fast-check` at a minimum of 100 iterations each and are tagged `// Feature: kshema-safety-platform, Property {n}`. Test sub-tasks are marked optional with `*`. All 27 correctness properties are covered.

## Tasks

- [x] 1. Monorepo scaffolding, infrastructure, and shared package skeletons
  - [x] 1.1 Initialize Turborepo + pnpm workspace and root tooling
    - Create root `package.json`, `pnpm-workspace.yaml`, `turbo.json` with `build`/`lint`/`test`/`typecheck` pipelines, and the `apps/*` + `packages/*` folder layout from the design's monorepo layout
    - Add `docker-compose.yml` provisioning PostgreSQL 16, Redis 7, and MinIO (S3-compatible) for local development
    - Add shared TypeScript base config and Vitest test-runner config wired through Turborepo
    - _Requirements: 19.1, 27.5_

  - [x] 1.2 Create `packages/config` (ESLint/Prettier/TS presets)
    - Export shared ESLint, Prettier, and `tsconfig` base presets consumed by every app/package
    - Scaffold the custom `no-banned-terms` ESLint rule module (rule wiring only; banned-term list + full enforcement completed in task 25)
    - _Requirements: 16.1, 16.4_

  - [x] 1.3 Create `packages/database` Prisma schema, client, migrations, and seed
    - Author `schema.prisma` with all enums and models from the design (User, Circle, CircleMember, SentinelPolicy, AdaptiveRhythmProfile, TelemetryLog, GhostSignalLog, VitalityPulseLog, EncryptedBlackBox, BlackBoxRecipientKey, SafetyIncident, HyperlocalContactProfile, Subscription, AdminUser, AdminAuditLog, VitalityStreak, SparshInteraction, PanchangaAlmanac, DeviceConfig, WebAuthnCredential, EmergencyAccessToken, EmergencyMedicalDossier, SanctuarySchedule, BatteryWarningLog, HouseholdProfile, CarrierGatewayMetric)
    - Generate the initial migration and export a typed Prisma client
    - Write a `seed.ts` creating a demo circle, anchor, observer, and policy for local dev
    - _Requirements: 2.7, 2.8, 5.3, 5.5, 8.6, 12.6, 19.1_

  - [x] 1.4 Create `packages/types` shared DTOs and Zod schemas
    - Define Zod request/response schemas for auth, circles, telemetry, blackbox-sync, incidents, vitality, sanctuary, dossier, admin, and web routes
    - Structurally exclude any private-key field from every request DTO (private keys never transit); exclude location-trace/financial/chat fields from responder/dashboard DTOs
    - _Requirements: 1.8, 5.5, 15.5, 19.1, 28.2, 29.7_

  - [x] 1.5 Create `packages/ui` brand design tokens
    - Define palette tokens: Sandalwood Cream `#FDFBF7`, Terracotta `#C85A32`, Deep Charcoal `#1F2421`, Muted Sage Green `#3D6B52`, Soft Amber `#D9822B`, Temple Brass `#D4A359`; exclude clinical red `#FF0000` and hospital blue `#0066FF`
    - Expose tokens for both NativeWind (mobile) and Tailwind (web/admin) consumption
    - _Requirements: 16.2, 16.3, 16.4, 22.19_

- [x] 2. Zero-knowledge encryption package
  - [x] 2.1 Implement `packages/encryption` envelope crypto primitives
    - Implement `encryptBlackBox(buffer, observerPublicKeys[])`: gzip+JSON serialize, generate a random 256-bit AES key + 96-bit IV, AES-256-GCM encrypt, and RSA-OAEP(SHA-256) fan-out-wrap the symmetric key once per `{ observerId, publicKey }`
    - Implement `decryptBlackBox(record, observerId, privateKey)`: select the matching recipient key row, RSA-OAEP unwrap, AES-256-GCM decrypt, and raise a decryption-integrity error on GCM tag mismatch
    - Implement the Argon2id-based recovery-key derivation helper and the emergency-dossier envelope helper (wrap to circle emergency key)
    - Export nothing from this package into `apps/api` that can decrypt black-box payloads
    - _Requirements: 8.4, 8.5, 8.9, 9.2, 23.1, 33.1_

  - [x] 2.2 Write property test: black-box round-trip reproduces snapshots
    - **Property 1: Black-box round-trip reproduces snapshots**
    - **Validates: Requirements 8.10, 9.1**

  - [x] 2.3 Write property test: tampered payload fails integrity verification
    - **Property 2: Tampered payload fails integrity verification**
    - **Validates: Requirements 9.2**

- [x] 3. Fastify API core: bootstrap, auth, and identity
  - [x] 3.1 Bootstrap the Fastify app skeleton
    - Create `apps/api` Fastify v4 server with `/api/v1` prefix, Zod validation wiring from `packages/types`, JWT bearer auth plugin, Prisma client injection, and a Redis/BullMQ producer connection for emitting events
    - Add CORS config permitting the `apps/web` origin for the SSE dashboard stream
    - _Requirements: 1.2_

  - [x] 3.2 Implement OTP auth and identity routes
    - `POST /auth/otp/request` (hashed OTP + expiry, SMS dispatch, returns challengeId); `POST /auth/otp/verify` (validates code, upserts User, persists `publicKeyPem`/timezone/preferredName/pushToken, issues JWT access+refresh)
    - Reject wrong/expired codes with a descriptive 401; accept only `clientPublicKeyPem` (never a private key)
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.8_

  - [x] 3.3 Write unit tests for OTP and private-key-absence contract
    - OTP happy/wrong/expired paths; assert no request schema in `packages/types` accepts a private-key field
    - _Requirements: 1.1, 1.2, 1.3, 1.8_

- [x] 4. Circles, roles, and permissions
  - [x] 4.1 Implement circle creation, invitation, and join routes
    - `POST /circles` (creates Circle + first CircleMember, initializes TRIAL Subscription for 14 days, returns first invitation); `POST /circles/:id/invitations` (expiring redeemable token); `POST /circles/join` (validates token, adds member with role ANCHOR|OBSERVER|MUTUAL, records `observerPublicKeyPem` for key wrapping); invalid/expired token → descriptive 400
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 20.1_

  - [x] 4.2 Implement member permission management route
    - `PATCH /circles/:id/members/:memberId` to set `canTriggerIVR` and `canAccessBlackBox` (SUPER member only)
    - _Requirements: 2.7_

  - [x] 4.3 Write unit tests for circle lifecycle and invitation validation
    - Cover role assignment, mutual-role dual treatment, and invalid/expired invitation rejection
    - _Requirements: 2.3, 2.4, 2.6_

- [x] 5. Telemetry, ghost signals, and offline reconciliation
  - [x] 5.1 Implement heartbeat and ghost-signal ingestion routes
    - `POST /telemetry/heartbeat` (append TelemetryLog, emit `telemetry.received`); `POST /telemetry/ghost-signal` (append GhostSignalLog, emit `ghost.received`); exclude any continuous-location column
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.2, 6.3_

  - [x] 5.2 Implement bulk-sync with idempotent dedup and clock-skew guard
    - `POST /telemetry/bulk-sync`: idempotent bulk insert keyed on `(deviceId, capturedAt)`; update `lastTelemetrySyncAt`; validate each heartbeat against server `receivedAt` (admit to rhythm baseline iff `capturedAt <= receivedAt + 2m` AND `capturedAt >= receivedAt - 7d`), persist out-of-window heartbeats flagged with a clock-skew warning and excluded from the baseline
    - _Requirements: 24.2, 24.3, 4.1_

  - [x] 5.3 Write property test: bulk-sync reconciliation is idempotent
    - **Property 11: Bulk-sync reconciliation is idempotent**
    - **Validates: Requirements 24.2, 24.3**

  - [x] 5.4 Write property test: clock-skew heartbeats are excluded from the rhythm baseline
    - **Property 27: Clock-skew heartbeats are excluded from the rhythm baseline**
    - **Validates: Requirements 24.2, 24.3, 4.1**

- [x] 6. Black-box sync and incident access API
  - [x] 6.1 Implement blackbox-sync storage route (server-blind)
    - `POST /telemetry/blackbox-sync`: store `EncryptedBlackBox` verbatim plus one `BlackBoxRecipientKey` row per wrapped Observer key; perform no decryption anywhere in the API
    - _Requirements: 8.4, 8.5, 8.6, 19.3_

  - [x] 6.2 Implement incident black-box fetch with authorization gating
    - `POST /incidents/:id/blackbox`: grant iff member holds `canAccessBlackBox` AND box is released (Stage-4 or Shadow_SOS); otherwise deny with authorization error; record access in incident audit trail
    - _Requirements: 8.7, 8.8, 9.3, 19.6_

  - [x] 6.3 Write property test: black-box access authorization
    - **Property 3: Black-box access authorization**
    - **Validates: Requirements 8.7, 8.8, 9.3**

- [x] 7. Incident lifecycle API and WhatsApp webhooks
  - [x] 7.1 Implement incident resolve, trigger-sos, and sanctuary/dossier routes
    - `POST /incidents/:id/resolve` (Anchor dismissal / authorized Observer override, emits resolution); `POST /incidents/trigger-sos` (Anchor-only Shadow_SOS: create/handoff incident, release black boxes, include decrypted location); `POST /sanctuary`, `DELETE /sanctuary/:id`, `GET /sanctuary/active`; `PUT /medical-dossier` (ciphertext-only upsert, no GET on admin/observer surfaces)
    - _Requirements: 11.4, 11.5, 11.6, 13.6, 13.7, 13.9, 34.1, 34.3, 33.1, 33.2_

  - [x] 7.2 Implement WhatsApp inbound + delivery-status webhook
    - `POST /webhooks/whatsapp`: signature-verified; inbound Anchor replies emit incident resolution; delivery-status callbacks feed carrier health metrics
    - _Requirements: 13.5, 21.11, 21.13_

- [x] 8. Sentinel worker foundation and adaptive rhythm engine
  - [x] 8.1 Bootstrap the BullMQ worker with queues and job registry
    - Create `apps/worker` with `rhythm-eval`, `escalation`, `dispatch`, `resolution`, and `vitality` queues on Redis 7; deterministic `jobId` scheme (`incident:<id>:stageN`); shared Prisma client and event consumers for `telemetry.received` / `ghost.received`
    - _Requirements: 12.6_

  - [x] 8.2 Implement the adaptive Bayesian rhythm engine
    - Maintain a rolling 14-day wake-time baseline; compute mean and std-dev as minute-of-day; derive `Grace_Deadline = mean + 2*stdDev` + weekend offset (+45m Sat/Sun) + fatigue offset (+30m when prior-day steps > 180% of 30-day avg); exclude any statically configured wake time; handle <14-day partial samples; update profile on verified wake events
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 8.3 Write property test: grace-deadline formula with offsets
    - **Property 4: Grace-deadline formula with offsets**
    - **Validates: Requirements 4.3, 4.4, 4.5, 4.6**

  - [x] 8.4 Write property test: rhythm estimator over partial samples
    - **Property 5: Rhythm estimator over partial samples**
    - **Validates: Requirements 4.1, 4.2, 4.7**

- [x] 9. Routine confirmation, persona evaluators, and ghost-signal handling
  - [x] 9.1 Implement routine-confirmation and persona-mode evaluators
    - `rhythm-eval` schedules a nightly per-Anchor `grace-check`; confirming signals (screen unlock, positive step delta, charger unplug, Ghost_Signal) before the deadline mark the check confirmed and prevent any incident; implement the five persona-mode evaluators (Elderly_Care rhythm, Solo_Living inactivity, Active_Session immobility, Journey_Watch transit deadline, Post_Op_Recovery daytime inactivity) with Elderly_Care default and concurrent modes
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 5.6, 6.4, 6.5_

  - [x] 9.2 Write property test: confirming signal prevents escalation
    - **Property 9: Confirming signal prevents escalation**
    - **Validates: Requirements 5.6, 6.4, 6.5**

- [x] 10. Four-stage escalation state machine and auto-resolution
  - [x] 10.1 Implement the escalation FSM with delayed jobs
    - Open incident at STAGE_1 on grace-deadline miss (send WhatsApp check-in via `dispatch`); each `advance` job re-reads status, exits if RESOLVED/HANDED_OFF_SOS, else advances one stage strictly in order (STAGE_1→2→3→4 at +20m each), performs the side-effect (device chime, observer silent push, hyperlocal dispatch), and appends `{stage, at, cause}` to the audit trail
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 10.2 Write property test: escalation advances strictly in order
    - **Property 6: Escalation advances strictly in order** (use `fast-check` `fc.commands` model-based testing)
    - **Validates: Requirements 12.2, 12.3, 12.4, 12.5**

  - [x] 10.3 Implement auto-resolution and Shadow_SOS handoff in the resolution worker
    - On any Auto_Resolution_Source event, atomically transition `OPEN→RESOLVED` via conditional update (`WHERE status='OPEN'`), record the source, and cancel the pending delayed job by deterministic `jobId` (idempotent); on Shadow_SOS trigger set `HANDED_OFF_SOS`, cancel timed jobs, release authorized black boxes, and bypass timed advancement
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 11.4_

  - [x] 10.4 Write property test: auto-resolution is idempotent and halts escalation
    - **Property 7: Auto-resolution is idempotent and halts escalation**
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8**

  - [x] 10.5 Write property test: Shadow SOS handoff supersedes timed advancement
    - **Property 8: Shadow SOS handoff supersedes timed advancement**
    - **Validates: Requirements 13.9, 11.4**

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Carrier abstraction, telephony dispatch, and AMD/DTMF handshake
  - [x] 12.1 Implement the CarrierAdapter interface and MockCarrierAdapter
    - Define `CarrierAdapter` (`sendWhatsApp`, `sendSms`, `placeVoiceWithHandshake`) and `VoiceHandshakeResult`; implement `MockCarrierAdapter` (console logging) for tests and Simulation_Mode plus a live adapter stub (Twilio/Exotel/Meta Cloud API)
    - _Requirements: 25.2, 31.1_

  - [x] 12.2 Implement the dispatch worker with retry/failover and AMD handshake
    - `dispatch` queue with exponential-backoff retry; `placeVoiceWithHandshake` requires DTMF `1` within 15s and AMD; acknowledged iff DTMF `1` received ≤15s, else voicemail/silence/timeout → unacknowledged → retry/failover to next contact; append DTMF timestamp + AMD diagnostic code to incident audit trail
    - _Requirements: 31.1, 31.2, 31.3, 31.4, 21.12_

  - [x] 12.3 Write property test: AMD & DTMF acknowledgment
    - **Property 21: AMD & DTMF acknowledgment**
    - **Validates: Requirements 31.1, 31.2, 31.3**

  - [x] 12.4 Write integration tests for carrier dispatch (mock carrier)
    - Inbound WhatsApp reply resolution; AMD handshake recording DTMF timestamp + AMD code to the audit trail
    - _Requirements: 13.5, 31.4_

- [x] 13. Hyperlocal dispatch, emergency access token, medical dossier, and acoustic gating
  - [x] 13.1 Implement hyperlocal dispatch and emergency access token generation
    - At STAGE_4: place simultaneous priority voice calls to Primary Observer, gate contact, and neighbor from `HyperlocalContactProfile`; send priority SMS; generate a message dynamically including building/flat/society/door-access; exclude members lacking `canTriggerIVR` from manual dispatch; record dispatch in audit trail; mint a signed, ≤60m, single-incident `EmergencyAccessToken` (store hash only) delivered via SMS + WhatsApp
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 29.1, 29.2, 29.3_

  - [x] 13.2 Write property test: hyperlocal dispatch message completeness
    - **Property 15: Hyperlocal dispatch message completeness**
    - **Validates: Requirements 14.2, 14.4**

  - [x] 13.3 Implement emergency responder API routes with token gating and dossier release
    - `GET /emergency/:token` (verify signature/expiry/binding/non-invalidation; return read-only triage payload — name, society/building/flat, door codes, Primary Observer dialer, dossier iff bound incident at STAGE_4; exclude location/financial/chat; audit visit with IP + user-agent); `POST /emergency/:token/confirm` (resolve with `RESPONDER_CONFIRMED`, notify Observers, invalidate token, revoke dossier); invalidate token on any resolution
    - _Requirements: 29.6, 29.7, 29.9, 29.10, 29.11, 29.12, 33.3, 33.4_

  - [x] 13.4 Write property test: emergency access token validity and invalidation
    - **Property 19: Emergency access token validity and invalidation**
    - **Validates: Requirements 29.1, 29.2, 29.9, 29.10, 29.11**

  - [x] 13.5 Write property test: responder payload completeness and exclusion
    - **Property 20: Responder payload completeness and exclusion**
    - **Validates: Requirements 29.6, 29.7, 33.3**

  - [x] 13.6 Write property test: emergency medical dossier access gating
    - **Property 23: Emergency medical dossier access gating**
    - **Validates: Requirements 33.2, 33.3, 33.4**

  - [x] 13.7 Implement acoustic-distress incident raise in the worker
    - Raise a Safety_Incident at STAGE_2 iff confidence > 0.82 AND sustained > 1.5s AND motionless ≥ 30s; exclude classifications at or below 0.82
    - _Requirements: 10.3, 10.4_

  - [x] 13.8 Write property test: acoustic distress gating
    - **Property 13: Acoustic distress gating**
    - **Validates: Requirements 10.3, 10.4**

- [x] 14. Vitality Pulse, family engagement, and Sparsh/Panchanga API
  - [x] 14.1 Implement Vitality Pulse emission and streak increment
    - On confirmed morning routine, emit a Vitality_Pulse per Observer (preferred name, confirmation time in Anchor timezone, step/weather context), record `VitalityPulseLog`, increment the Circle Vitality_Streak; preserve streak on delayed/no-crisis resolution; apply Streak_Freeze up to 3 days on Traveling/battery-maintenance; never let streak reset/freeze trigger escalation
    - _Requirements: 7.1, 7.2, 7.5, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6_

  - [x] 14.2 Write property test: Vitality Pulse field completeness
    - **Property 16: Vitality Pulse field completeness**
    - **Validates: Requirements 7.2**

  - [x] 14.3 Write property test: vitality streak never triggers escalation
    - **Property 18: Vitality streak never triggers escalation**
    - **Validates: Requirements 22.2, 22.4, 22.5, 22.6**

  - [x] 14.4 Implement Sparsh, connection rhythm, voice-note, and Panchanga routes
    - `POST /vitality/voice-note` (≤10s reply); `POST /sparsh`; `GET /sparsh/rhythm?days=30`; `GET /panchanga` (sunrise/sunset, Tithi/Nakshatra/Masa, festivals, proverb for Anchor location + language); enforce one morning engagement push per day per User
    - _Requirements: 7.4, 22.7, 22.8, 22.9, 22.10, 22.11, 22.12, 22.13, 22.14, 22.18_

- [x] 15. Subscription lifecycle, tier gating, and webhooks
  - [x] 15.1 Implement subscription checkout, webhooks, and tier transitions
    - `POST /subscriptions/checkout`; `POST /subscriptions/webhooks/apple|google|upi` (signature-verified StoreKit/Play/UPI Autopay validation → PRO and resume worker routines; failures → admin error queue); enforce transitions TRIAL→PRO, TRIAL→SHIELD_PAUSED, SHIELD_PAUSED→PRO, SHIELD_PAUSED→TRIAL; transition to SHIELD_PAUSED on trial expiry; deliver 4-day and 1-day trial reminders
    - _Requirements: 20.1, 20.4, 20.8, 20.9, 20.10_

  - [x] 15.2 Implement Shield_Paused suspension gate in the worker
    - Suspend all scheduled checks, WhatsApp pings, delayed escalation queues, and IVR dispatch iff tier is SHIELD_PAUSED; preserve trial-period full capabilities including emergency escalation, acoustic classification, and hardware duress
    - _Requirements: 20.2, 20.3, 20.5_

  - [x] 15.3 Write property test: subscription tier transitions
    - **Property 10: Subscription tier transitions**
    - **Validates: Requirements 20.1, 20.4, 20.5, 20.8, 21.19**

- [x] 16. Sanctuary Mode and co-living household worker logic
  - [x] 16.1 Implement the Sanctuary Mode suspension gate and auto-resume
    - Before opening any incident, consult the active `SanctuarySchedule` (suspend routine eval, WhatsApp pings, all stages while `startsAt ≤ now < resumesAt`); auto-resume idempotently at `now ≥ resumesAt` with no manual reactivation; validate `resumesAt ≤ startsAt + 14d`; preserve Vitality_Streak across the window
    - _Requirements: 34.1, 34.2, 34.4, 34.5_

  - [x] 16.2 Write property test: Sanctuary Mode suppression, auto-resume, and streak preservation
    - **Property 24: Sanctuary Mode suppression, auto-resume, and streak preservation**
    - **Validates: Requirements 34.2, 34.4, 34.5**

  - [x] 16.3 Implement co-living shared-signal attribution and partner check-in
    - Attribute shared media-device / shared-Wi-Fi Ghost_Signals as "household activity confirmed"; for any co-living Anchor requiring independent confirmation, still require an individual screen-unlock or step-delta; on escalation, deliver a quiet high-priority STAGE_1 check-in to the co-living partner before any external dispatch; resolve with `CO_LIVING_PARTNER_CONFIRMED` when the partner confirms
    - _Requirements: 35.1, 35.2, 35.3, 35.4_

  - [x] 16.4 Write property test: co-living shared-signal attribution requires individual confirmation
    - **Property 25: Co-living shared-signal attribution requires individual confirmation**
    - **Validates: Requirements 35.2**

  - [x] 16.5 Write property test: co-living partner confirmation resolves before external dispatch
    - **Property 26: Co-living partner confirmation resolves before external dispatch**
    - **Validates: Requirements 35.3, 35.4**

- [x] 17. Simulation mode, offline grace, and bedtime battery guardian (worker)
  - [x] 17.1 Implement Simulation_Mode time compression and offline grace
    - Read compressed `stageInterval` and route dispatch to `MockCarrierAdapter` when `SIMULATION_MODE` is enabled (non-production, authorized admin only); flag resulting incidents/dispatches `simulated=true`; withhold heartbeat-silence-only escalation within the network-grace window until buffered telemetry reconciles
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 24.4_

  - [x] 17.2 Write property test: offline grace withholds heartbeat-only escalation
    - **Property 12: Offline grace withholds heartbeat-only escalation**
    - **Validates: Requirements 24.4**

  - [x] 17.3 Implement the Bedtime Battery Guardian worker backstop
    - Emit gentle bedtime chime iff `phase=BEDTIME_MINUS_60` AND battery < 25% AND unplugged; log `PRE_DAWN_BATTERY_EXHAUSTION_WARNING` + notify Observer dashboard iff `phase=POST_MIDNIGHT` AND battery < 15% AND unplugged; flag a morning STAGE_1 incident as "Likely Battery Depletion" when attributable to a documented pre-dawn warning
    - _Requirements: 32.1, 32.2, 32.3, 32.4_

  - [x] 17.4 Write property test: bedtime battery thresholds
    - **Property 22: Bedtime battery thresholds**
    - **Validates: Requirements 32.2, 32.3**

- [x] 18. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. Admin console API and RBAC
  - [x] 19.1 Implement admin routes with MFA/RBAC guard and audit ledger
    - `AdminAuthGuard` (MFA + single-role RBAC: SUPER_ADMIN/SUPPORT_AGENT/BILLING_OPS); every handler writes an `AdminAuditLog` row (timestamp, admin id, source IP, target entity, justification); out-of-role → 403 + SECURITY_VIOLATION audit; mask phone numbers to last 4 digits except active Stage-4 triage; expose no black-box decrypt or live GPS/audio path
    - Implement fleet pulse, carrier health, live incidents, retry-dispatch, subscriptions, trial extension (restores SHIELD_PAUSED→TRIAL), purge-request (30-day grace), device wakefulness-test, and webhook error-queue routes; flag telemetry-at-risk after 3 missed heartbeats; fire on-call alert when carrier error rate > 5% over 15m
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9, 21.10, 21.14, 21.16, 21.18, 21.19, 21.20, 21.21_

  - [x] 19.2 Write property test: admin RBAC and phone masking
    - **Property 17: Admin RBAC and phone masking**
    - **Validates: Requirements 21.2, 21.3, 21.4, 21.5, 21.8**

- [x] 20. Web API surface: web auth, WebAuthn, SSE, and billing
  - [x] 20.1 Implement web OTP + WebAuthn authentication routes
    - `POST /web/auth/otp/request|verify` (WEB login channel, accepts `clientPublicKeyPem` from Web_Crypto_Vault); WebAuthn register/authenticate options+verify storing `WebAuthnCredential` (COSE key + counter), rejecting non-increasing counters
    - _Requirements: 28.1, 28.2_

  - [x] 20.2 Implement web dashboard SSE stream, vitality, config, and billing routes
    - `GET /web/dashboard/stream` (SSE on the persistent Fastify service: per-Anchor well-being state, active stage, dual-timezone tick) + `/web/dashboard/ws` WebSocket fallback; `GET /web/vitality/rhythm|voice-notes`; reuse sentinel-policy / hyperlocal / member routes; `POST /web/billing/portal-session`, `GET /web/billing/summary|invoices|invoices/:id.pdf`, `POST /web/billing/interval`
    - _Requirements: 28.5, 28.8, 28.9, 28.10, 28.11, 28.12, 28.13, 28.14, 28.15, 28.16, 28.17_

- [x] 21. Observer dashboard API
  - [x] 21.1 Implement the mobile Observer dashboard route
    - `GET /observer/dashboard`: per-Anchor derived state (ALL_WELL | escalationStage | SHIELD_PAUSED), preferred name, last confirmation time; exclude any continuous location trace; draw strings from the Brand_Lexicon
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

- [x] 22. Mobile app foundation and background/ambient agents
  - [x] 22.1 Scaffold the Expo mobile app shell
    - Create `apps/mobile` (Expo SDK 51+, RN 0.74+, NativeWind wired to `packages/ui` tokens, Zustand stores for session/membership/policy/dashboard, Expo Router role-based Anchor/Observer/Mutual surfaces); implement RSA-2048 keygen into Secure_Enclave, disclaimer acceptance gate before Ambient_Shield, preferred-name prompt, and Key_Recovery (passphrase + platform key store backup, restore without exposing private key)
    - _Requirements: 1.4, 1.7, 1.8, 23.1, 23.2, 23.3, 23.4, 26.1, 26.2, 26.3, 26.4_

  - [x] 22.2 Implement the background telemetry, ghost-signal, and offline agents
    - Android minimum-priority foreground service + screen/power broadcast receivers, iOS background tasks, battery-optimization exemption onboarding, lost-execution notification, `DeviceConfig` capture; passive signal + ghost-signal (Tizen/Chromecast/FireTV/Roku discovery, post-5AM home-Wi-Fi re-association) collection; `Offline_Telemetry_Queue` buffering + bulk-sync flush
    - _Requirements: 5.1, 5.2, 6.1, 6.2, 6.3, 18.1, 18.2, 18.3, 18.4, 18.5, 24.1, 24.2_

  - [x] 22.3 Implement the Flight Recorder, acoustic classifier, Shadow SOS, and bedtime evaluator
    - 3-minute snapshot capture into a ≤20-snapshot/≤60-minute ring buffer (discard oldest), encrypt every 15m via `packages/encryption` and blackbox-sync; in-memory-only acoustic distress classifier (no audio persistence/transmission); Shadow_SOS hardware trigger (Android 4× power ≤2.5s, iOS duress action) + Blackout_Mode; on-device Bedtime Battery Guardian evaluator
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 10.1, 10.2, 11.1, 11.2, 11.3, 11.7, 19.4, 32.1, 32.2_

- [x] 23. Mobile UI: Observer, Anchor, vitality, and i18n
  - [x] 23.1 Implement Observer and Anchor UI surfaces
    - Observer dashboard (All Well in Sage `#3D6B52`, escalation stage in Amber `#D9822B`, Shield Paused neutral grey with disclosure, no location trace); Anchor sanctuary home with Vitality Pulse card, Sparsh widget + one-tap blessing/heart, Daily Panchanga card (04:00 refresh), Family Movement Milestone journey; render only Brand_Lexicon terms, exclude clinical red/hospital blue and alarm-style engagement UI
    - _Requirements: 7.3, 7.6, 12.7, 15.2, 15.3, 15.4, 16.5, 20.6, 20.7, 20.11, 22.15, 22.16, 22.17, 22.19, 22.20, 34.3_

  - [x] 23.2 Implement multi-language i18n catalogs
    - en/hi/kn/ta/te locale catalogs backing all UI strings; language selection re-renders all text; preserve Brand_Lexicon meaning and exclude Banned_Terms across every locale
    - _Requirements: 17.1, 17.2, 17.4_

- [x] 24. Web and admin front-end applications
  - [x] 24.1 Implement the public brand & trust portal (SSG)
    - `apps/web/(public)`: "Dignity Over Surveillance" philosophy, interactive escalation-ladder + Flight_Recorder explainer, localized pricing (INR/USD/GBP/AED/SGD with geo detection), five-language content, Terms/Safety_Disclaimer/DPDP+GDPR privacy/Data_Safety_Disclosure; palette locked to Sandalwood/Terracotta/Charcoal; exclude Banned_Terms
    - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.6, 30.7, 30.8_

  - [x] 24.2 Implement the Observer web portal, Web_Crypto_Vault, and Ambient Desk Mode
    - `apps/web/dashboard`: OTP + WebAuthn login, 30-minute idle lock; `Web_Crypto_Vault` (SubtleCrypto RSA-OAEP keygen/restore, non-extractable private key, in-browser black-box decrypt, never transmit private key/plaintext); Ambient Desk Mode (dual-timezone clock, Sage All-Well hero, Amber escalation with voice-call + mark-safe controls) via direct-to-Fastify SSE with no reload; config forms, 30-day vitality history without location breadcrumbs, self-service billing (Stripe/Razorpay, invoices, monthly/annual switch); exclude Banned_Terms
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8, 28.9, 28.10, 28.11, 28.12, 28.13, 28.14, 28.15, 28.16, 28.17, 28.18_

  - [x] 24.3 Implement the ephemeral first-responder portal (edge SSR)
    - `apps/web/emergency/[token]`: zero-login edge-rendered high-contrast triage card (name, flat, door codes, Primary Observer dialer, Stage-4 medical dossier), inlined critical CSS for <1.5s 3G render; single-tap "Reached / Confirm Safe" → responder name → confirm; informational "safety check has concluded" screen for expired/invalid tokens
    - _Requirements: 29.4, 29.5, 29.6, 29.7, 29.8, 29.11_

  - [x] 24.4 Implement the admin console front end
    - `apps/admin`: Next.js 14 with `AdminAuthGuard` + MFA session; `@tanstack/react-table` grids for fleet health, carrier health, live incident ops (SSE, visual alarm on dispatch failure), subscriptions, and webhook error queue; no UI affordance to decrypt black boxes or poll live location/audio
    - _Requirements: 21.1, 21.6, 21.7, 21.10, 21.11, 21.13, 21.15, 21.17, 21.20_

- [x] 25. Cross-cutting quality gates and final wiring
  - [x] 25.1 Complete the banned-term ESLint rule and enforce it repo-wide
    - Finalize the `no-banned-terms` rule with the full Banned_Term list + locale equivalents; wire it into `apps/mobile`, `apps/admin`, and `apps/web` (including public pages) lint/build; fail the build on any violation
    - _Requirements: 16.1, 17.4, 28.18, 30.8_

  - [x] 25.2 Write property test: brand lexicon excludes banned terms
    - **Property 14: Brand lexicon excludes banned terms** (run over the user-facing string catalog across en/hi/kn/ta/te)
    - **Validates: Requirements 16.1, 17.4**

  - [x] 25.3 Write the data-safety disclosure consistency test
    - Contract test asserting the app-store `Data_Safety_Disclosure` manifest matches the actual DTO fields (device identifiers, push tokens, step-delta diagnostics; no data sale / no cross-app tracking; no plaintext continuous location on servers)
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5_

  - [x] 25.4 Write web application integration tests
    - WebAuthn register/authenticate + non-increasing-counter rejection; private-key-absence web DTO contract; browser black-box decrypt reusing the Property 1 round-trip under `crypto.subtle`; 30-minute idle-lock fake-clock; Ambient Desk Mode sage/amber SSE render snapshots; billing portal-session + invoice download against mock Stripe/Razorpay; responder-portal zero-login load + <1.5s 3G perf smoke; public-portal per-locale + geo-currency snapshots
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.7, 28.8, 28.16, 28.17, 29.5, 29.12, 30.4_

- [x] 26. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses (and property numbers where applicable) for traceability.
- All 27 correctness properties are covered by property-based tests (`fast-check`, min. 100 iterations, tagged `// Feature: kshema-safety-platform, Property {n}`): Properties 1–3 (tasks 2.2, 2.3, 6.3), 4–5 (8.3, 8.4), 6–8 (10.2, 10.4, 10.5), 9 (9.2), 10 (15.3), 11 & 27 (5.3, 5.4), 12 (17.2), 13 (13.8), 14 (25.2), 15 (13.2), 16 & 18 (14.2, 14.3), 17 (19.2), 19–20 & 23 (13.4, 13.5, 13.6), 21 (12.3), 22 (17.4), 24 (16.2), 25–26 (16.4, 16.5).
- Integration tests use the `MockCarrierAdapter` behind the `CarrierAdapter` interface; Simulation_Mode reuses the same mock for safe end-to-end exercise.
- Checkpoints (tasks 11, 18, 26) provide incremental validation at reasonable breaks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.5"] },
    { "id": 1, "tasks": ["1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.1"] },
    { "id": 3, "tasks": ["3.2", "8.1"] },
    { "id": 4, "tasks": ["3.3", "4.1", "5.1", "8.2"] },
    { "id": 5, "tasks": ["4.2", "4.3", "5.2", "6.1", "8.3", "8.4", "9.1"] },
    { "id": 6, "tasks": ["5.3", "5.4", "6.2", "9.2", "10.1"] },
    { "id": 7, "tasks": ["6.3", "7.1", "10.2", "10.3"] },
    { "id": 8, "tasks": ["7.2", "10.4", "10.5", "12.1"] },
    { "id": 9, "tasks": ["12.2", "14.1", "15.1", "16.1", "17.1"] },
    { "id": 10, "tasks": ["12.3", "12.4", "13.1", "13.7", "14.2", "14.3", "14.4", "15.2", "15.3", "16.2", "16.3", "17.2", "17.3"] },
    { "id": 11, "tasks": ["13.2", "13.3", "13.8", "16.4", "16.5", "17.4", "19.1", "21.1"] },
    { "id": 12, "tasks": ["13.4", "13.5", "13.6", "19.2", "20.1", "22.1"] },
    { "id": 13, "tasks": ["20.2", "22.2", "22.3"] },
    { "id": 14, "tasks": ["23.1", "23.2", "24.1", "24.2", "24.3", "24.4"] },
    { "id": 15, "tasks": ["25.1"] },
    { "id": 16, "tasks": ["25.2", "25.3", "25.4"] }
  ]
}
```
