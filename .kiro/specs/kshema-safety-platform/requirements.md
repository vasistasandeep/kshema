# Requirements Document

## Introduction

Kshema (क्षेम — "well-being, security, peace") is an ambient personal safety, vitality, and routine assurance platform. It provides peace of mind to Observers (guardians, adult children, family) about the well-being of Anchors (protected individuals such as aging parents, solo dwellers, or people in active/transit/recovery situations) without resorting to intrusive surveillance.

The platform's guiding tenet is **Dignity Over Surveillance**: normal life stays private, and safety is inferred ambiently from passive signals rather than continuous location tracking, cameras, or mandatory check-in buttons. When ambient signals suggest a routine has been missed or a distress condition exists, Kshema follows a graduated four-stage escalation that begins with gentle, dignified check-ins and ends, only if necessary, with hyperlocal first-responder dispatch and controlled release of an encrypted evidence payload.

Kshema is delivered as a cross-platform mobile application backed by an API and background worker, supporting multiple personas (Elderly Care, Solo Living, Active Session, Journey Watch, Post-Op Recovery), a dual-role Circle model, five UI languages, and zero-knowledge encryption guarantees where the server cannot read the most sensitive data.

Beyond core ambient protection, the platform includes a commercial subscription lifecycle (a 14-day full-access trial transitioning to a paid Pro tier, with a Shield-Paused state on lapse), an administrative operations console for fleet reliability, carrier-gateway health, live incident triage, and subscription support (bounded by the same zero-knowledge privacy guarantees), and a family engagement engine (vitality streaks, one-tap non-verbal reactions, a daily Panchanga card, and cooperative movement milestones) that makes daily continuity a warm habit rather than a reaction to dread. Supporting capabilities include cryptographic key recovery, offline telemetry buffering, a developer simulation mode, a mandatory safety disclaimer, and app-store data-safety disclosures.

This document defines WHAT the system must do and WHY, expressed as user stories and EARS-compliant acceptance criteria. Implementation details (specific code, libraries, and infrastructure) are deferred to the design phase; where the blueprint names technologies they are treated as constraints, not implementation mandates.

## Glossary

- **Kshema_Platform**: The complete system comprising the mobile application, API service, background worker, and datastores.
- **Kshema_App**: The mobile application component running on an Anchor or Observer device.
- **Kshema_API**: The server-side service handling authentication, circles, telemetry ingestion, dashboards, and incident lifecycle.
- **Sentinel_Worker**: The background worker component that evaluates rhythms, advances escalation stages, and dispatches notifications on schedule.
- **User**: Any registered individual of the Kshema_Platform, identified by a public key, timezone, notification tokens, and a preferred display name.
- **Anchor**: A User in a Circle whose ambient telemetry is monitored for well-being. An Anchor is a protected individual, never labeled a "patient" or "monitored subject".
- **Observer**: A User in a Circle who receives well-being status and alerts about one or more Anchors.
- **Mutual**: A User who holds both Anchor and Observer roles within the same Circle.
- **Circle**: A named group linking Anchors and Observers with defined roles and permissions.
- **CircleMember**: The membership record binding a User to a Circle with a role and permission flags (canTriggerIVR, canAccessBlackBox).
- **Sentinel_Policy**: The configuration governing which persona modes are active for an Anchor and their associated parameters.
- **Persona_Mode**: One of the operating modes: Elderly_Care, Solo_Living, Active_Session, Journey_Watch, or Post_Op_Recovery.
- **Adaptive_Rhythm_Engine**: The subsystem computing an Anchor's expected wake time and grace deadline from a rolling behavioral baseline.
- **Adaptive_Rhythm_Profile**: The stored statistical baseline (mean and standard deviation of wake time and related deltas) for an Anchor.
- **Grace_Deadline**: The computed clock time by which a morning routine must be confirmed before escalation begins.
- **Ambient_Shield**: The overall passive protection state active for an Anchor.
- **Routine_Rhythm**: An Anchor's expected daily activity pattern used to detect missed routines.
- **Vitality_Pulse**: A warm, reassuring status update generated for Observers when an Anchor's routine is verified.
- **Ghost_Signal**: A passive indicator of household life activity detected without the Anchor touching the phone (e.g., smart TV waking, home Wi-Fi re-association).
- **Ghost_Signal_Log**: The record of detected Ghost_Signals.
- **Flight_Recorder**: The on-device zero-knowledge encrypted rolling black box of recent context snapshots.
- **Encrypted_Black_Box**: A serialized, compressed, encrypted Flight_Recorder payload synchronized to the server that only an authorized Observer can decrypt.
- **Telemetry_Log**: The record of passive well-being signals (screen unlocks, step deltas, battery/charger state, location coarse data as permitted).
- **Acoustic_Distress_Classifier**: The on-device audio classifier that detects distress sounds without recording or uploading audio.
- **Shadow_SOS**: A covert, silent duress trigger initiated by the Anchor via hardware gesture.
- **Blackout_Mode**: An app state that mimics a powered-off screen while silently dispatching an alert to Observers.
- **Safety_Incident**: A tracked escalation event with a current stage, audit trail, and resolution record.
- **Escalation_Stage**: One of STAGE_1_CONVERSATIONAL_WHATSAPP, STAGE_2_GENTLE_DEVICE_CHIME, STAGE_3_OBSERVER_SILENT_ALERT, or STAGE_4_HYPERLOCAL_DISPATCH.
- **Auto_Resolution_Source**: A passive or manual event that resolves a Safety_Incident (screen unlock, step delta, charger unplug, Ghost_Signal, WhatsApp response, Anchor dismissal, Observer override, Shadow_SOS handoff).
- **Hyperlocal_Dispatch**: The Stage 4 process contacting nearby human responders (primary Observer, society security gate, neighbor) via voice and text.
- **Hyperlocal_Contact_Profile**: The stored building, flat, society, and door-access details used in Hyperlocal_Dispatch.
- **Brand_Lexicon**: The approved vocabulary for user-facing text.
- **Banned_Term**: A user-facing string prohibited by the Brand_Lexicon (e.g., Monitoring, Surveillance, Tracking, Patient, Elderly Watch, Supervision, Fall Alarm, Panic Button).
- **Supported_Language**: One of English, Hindi, Kannada, Tamil, or Telugu.
- **Secure_Enclave**: The device hardware-backed key store (Keychain on iOS, Keystore on Android) holding private keys.
- **Subscription_Tier**: The commercial protection tier of a Circle, one of TRIAL, PRO, or SHIELD_PAUSED.
- **Trial_Period**: The 14-calendar-day full-access window granted to a newly created Circle.
- **Shield_Paused_State**: The state entered when a Circle subscription lapses, in which safety automation is suspended while manual dashboard visibility of the most recent signals remains.
- **Pro_Tier**: The paid, active Subscription_Tier (PRO) granting full protection capabilities.
- **Admin_User**: An authenticated operator of the Admin_Console who is not a Circle member User.
- **Admin_Role**: The single role assigned to an Admin_User, one of SUPER_ADMIN, SUPPORT_AGENT, or BILLING_OPS.
- **Admin_Console**: The administrative operations interface for fleet health, incident triage, and subscription support.
- **Fleet_Telemetry_Pulse**: The aggregated heartbeat-latency and device-health signal set across the Anchor device fleet.
- **Incident_Ops_Console**: The Admin_Console view presenting a real-time monitor of active Safety_Incidents.
- **Carrier_Gateway_Health**: The health metrics of upstream messaging and voice gateways, including WhatsApp delivery latency, Meta template rejections, India DLT registration status, and IVR connection success.
- **Admin_Audit_Ledger**: The append-only record of every Admin_User view, query, mutation, and export.
- **Vitality_Streak**: A per-Circle count of consecutive days of verified morning Routine_Rhythms.
- **Sparsh_Reaction**: A one-tap non-verbal reaction sent between CircleMembers, one of Morning Chai, Pranam/Blessing, Morning Sun, Marigold Flower, or Heart Blessing.
- **Daily_Panchanga_Card**: A personalized daily card showing local sunrise/sunset, regional lunar calendar (Tithi/Nakshatra/Masa), upcoming festivals, and a daily uplifting proverb.
- **Family_Movement_Milestone**: A cooperative, non-competitive weekly aggregation of Circle members' step totals visualized as a shared journey.
- **Streak_Freeze**: A grace mechanism preserving an active Vitality_Streak for up to 3 consecutive days during travel or device maintenance.
- **Offline_Telemetry_Queue**: The on-device queue of heartbeats and telemetry deltas buffered during network loss and flushed on reconnect.
- **Simulation_Mode**: A developer toggle that compresses escalation intervals and routes carrier dispatches to a mock console in non-production environments.
- **Key_Recovery**: The mechanism allowing an Observer to restore a cryptographic identity after device loss or replacement without exposing the private key to the Kshema_API.
- **Safety_Disclaimer**: The mandatory disclosure that Kshema is not a licensed medical device and not an official emergency service.
- **Data_Safety_Disclosure**: The app-store privacy labels declaring the platform's data collection behavior.
- **Observer_Web_Portal**: The browser-based desktop application for Observers providing ambient oversight, Circle configuration, routine orchestration, historical vitality review, and billing management.
- **Ephemeral_Responder_Portal**: The zero-login temporary web interface presented to nearby first responders during a STAGE_4_HYPERLOCAL_DISPATCH emergency, requiring no application install or account.
- **Emergency_Access_Token**: A cryptographically signed, short-lived, single-incident token that authorizes read-only access to the Ephemeral_Responder_Portal.
- **Web_Crypto_Vault**: The browser-side cryptography subsystem using the W3C Web Cryptography API and WebAuthn for client-side key storage and decryption within the Observer_Web_Portal.
- **Public_Brand_Portal**: The authoritative public web application presenting the platform philosophy, privacy architecture, subscription options, and legal disclosures.
- **Ambient_Desk_Mode**: A full-screen, low-distraction desktop viewport of the Observer_Web_Portal intended for a secondary monitor or pinned tab, showing a live well-being rhythm.
- **Interactive_Voice_Handshake**: A DTMF keypad confirmation, such as pressing digit 1, used to distinguish a human answer from carrier voicemail during an automated voice call.
- **Bedtime_Battery_Guardian**: A predictive evening routine that warns an Anchor when device battery charge is insufficient to survive the night and preserve the morning shield.
- **Emergency_Medical_Dossier**: An encrypted on-device In-Case-of-Emergency health card comprising blood group, allergies, chronic conditions, medications, physician contact, and insurance details, released only at STAGE_4_HYPERLOCAL_DISPATCH.
- **Sanctuary_Mode**: A user-scheduled suspension of Sentinel_Worker evaluations for a documented event, with automatic resumption at a defined return time.
- **Co_Living_Household**: A Circle configuration in which multiple Anchors share a single domicile and local network.

## Requirements

### Requirement 1: User Identity and Cryptographic Onboarding

**User Story:** As a new user, I want to register and establish a cryptographic identity, so that my sensitive data can be protected end-to-end and I can join safety Circles.

#### Acceptance Criteria

1. WHEN a User initiates registration with a phone number, THE Kshema_API SHALL send a one-time passcode to that phone number.
2. WHEN a User submits a correct one-time passcode within the passcode validity window, THE Kshema_API SHALL create a User account and establish an authenticated session.
3. IF a User submits an incorrect or expired one-time passcode, THEN THE Kshema_API SHALL reject the authentication attempt and return a descriptive error.
4. WHEN a User account is created, THE Kshema_App SHALL generate an asymmetric key pair and store the private key in the Secure_Enclave.
5. WHEN a User account is created, THE Kshema_App SHALL register the User public key with the Kshema_API.
6. THE Kshema_API SHALL store for each User a preferred display name, a timezone, and platform notification tokens.
7. WHERE a User has not provided a preferred display name, THE Kshema_App SHALL prompt for a preferred display name before the User joins a Circle.
8. THE Kshema_App SHALL retain each User private key exclusively within the Secure_Enclave and SHALL exclude the private key from any data transmitted to the Kshema_API.

### Requirement 2: Dual-Role Circle Model

**User Story:** As a user, I want to form a Circle with the people I care about and assign safety roles, so that protection responsibilities and permissions are clearly defined.

#### Acceptance Criteria

1. WHEN a User requests creation of a Circle with a name, THE Kshema_API SHALL create a Circle and assign the requesting User as a CircleMember.
2. WHEN a User creates a Circle, THE Kshema_API SHALL generate a Circle invitation that another User can redeem to join the Circle.
3. WHEN a User redeems a valid Circle invitation, THE Kshema_API SHALL add that User to the Circle as a CircleMember.
4. IF a User attempts to redeem an invalid or expired Circle invitation, THEN THE Kshema_API SHALL reject the request and return a descriptive error.
5. THE Kshema_API SHALL assign each CircleMember one of the roles Anchor, Observer, or Mutual.
6. WHERE a CircleMember holds the Mutual role, THE Kshema_Platform SHALL treat that CircleMember as both an Anchor and an Observer within the Circle.
7. THE Kshema_API SHALL store per-CircleMember permission flags for authority to trigger Hyperlocal_Dispatch and authority to access the Encrypted_Black_Box.
8. WHEN an Observer CircleMember is added, THE Kshema_API SHALL record that Observer public key for use in Encrypted_Black_Box key wrapping.
9. WHILE a CircleMember holds the Anchor role, THE Kshema_App SHALL present that CircleMember using the Brand_Lexicon term "Anchor" and SHALL exclude any Banned_Term.

### Requirement 3: Persona Modes and Sentinel Policy

**User Story:** As an Anchor or Observer, I want to select the operating mode that fits the Anchor's situation, so that the platform's ambient protection matches real-life context.

#### Acceptance Criteria

1. THE Kshema_App SHALL offer the Persona_Modes Elderly_Care, Solo_Living, Active_Session, Journey_Watch, and Post_Op_Recovery.
2. WHERE no Persona_Mode has been selected for an Anchor, THE Kshema_App SHALL apply Elderly_Care as the default Persona_Mode.
3. WHEN an authorized CircleMember selects one or more Persona_Modes for an Anchor, THE Kshema_API SHALL persist the selection in the Anchor Sentinel_Policy.
4. WHERE the Elderly_Care Persona_Mode is active, THE Sentinel_Worker SHALL evaluate the morning Routine_Rhythm using the Adaptive_Rhythm_Engine.
5. WHERE the Solo_Living Persona_Mode is active, THE Sentinel_Worker SHALL evaluate for prolonged absence of passive activity signals indicating a domestic incident.
6. WHERE the Active_Session Persona_Mode is active, THE Sentinel_Worker SHALL evaluate real-time motion signals for immobility during the active session.
7. WHERE the Journey_Watch Persona_Mode is active, THE Sentinel_Worker SHALL evaluate arrival against a User-specified transit deadline.
8. WHERE the Post_Op_Recovery Persona_Mode is active, THE Sentinel_Worker SHALL evaluate for daytime inactivity exceeding a configured recovery threshold.
9. THE Kshema_App SHALL allow an authorized CircleMember to activate multiple Persona_Modes concurrently for one Anchor.

### Requirement 4: Adaptive Bayesian Rhythm Engine

**User Story:** As an Anchor, I want the platform to learn my natural wake pattern, so that reassurance checks respect my real routine instead of forcing a fixed schedule.

#### Acceptance Criteria

1. THE Adaptive_Rhythm_Engine SHALL maintain a rolling baseline of the Anchor wake time using the most recent 14 days of observed wake events.
2. THE Adaptive_Rhythm_Engine SHALL compute the mean and standard deviation of the Anchor wake time expressed as minute-of-day.
3. WHEN computing a daily Grace_Deadline, THE Adaptive_Rhythm_Engine SHALL set the Grace_Deadline to the wake-time mean plus two standard deviations plus applicable adjustment offsets.
4. WHERE the current day is Saturday or Sunday, THE Adaptive_Rhythm_Engine SHALL add a weekend offset of 45 minutes to the Grace_Deadline.
5. WHERE the prior day step count exceeded 180 percent of the Anchor 30-day average step count, THE Adaptive_Rhythm_Engine SHALL add a fatigue offset of 30 minutes to the Grace_Deadline.
6. THE Adaptive_Rhythm_Engine SHALL derive the Grace_Deadline exclusively from the Adaptive_Rhythm_Profile and SHALL exclude any statically configured wake time.
7. WHILE the Adaptive_Rhythm_Profile contains fewer than 14 days of observed wake events, THE Adaptive_Rhythm_Engine SHALL compute the Grace_Deadline from the available observed wake events.
8. WHEN a verified wake event occurs, THE Adaptive_Rhythm_Engine SHALL update the Adaptive_Rhythm_Profile with that wake event.

### Requirement 5: Passive Telemetry Ingestion

**User Story:** As an Anchor, I want the platform to infer that I am well from passive signals my phone already produces, so that I never have to press an "I am alive" button.

#### Acceptance Criteria

1. THE Kshema_App SHALL collect passive well-being signals comprising screen-unlock events, step-count deltas, and battery and charger state.
2. WHEN passive well-being signals are collected, THE Kshema_App SHALL transmit the signals to the Kshema_API as a telemetry heartbeat.
3. WHEN the Kshema_API receives a telemetry heartbeat, THE Kshema_API SHALL record the signals in the Telemetry_Log.
4. THE Kshema_Platform SHALL infer Anchor well-being from passive signals and SHALL NOT require the Anchor to perform a manual liveness confirmation as a condition of normal operation.
5. THE Kshema_Platform SHALL exclude continuous location trace history from the Telemetry_Log during normal operation.
6. WHEN a passive well-being signal satisfies a pending Routine_Rhythm check, THE Sentinel_Worker SHALL mark the Routine_Rhythm as confirmed for that period.

### Requirement 6: Ghost Signals and Ambient Household Discovery

**User Story:** As an Anchor, I want the platform to recognize that I am up and about from ordinary household activity, so that my morning routine is confirmed even when I have not touched my phone.

#### Acceptance Criteria

1. THE Kshema_App SHALL discover household media devices on the local network including Samsung Tizen televisions, Chromecast, FireTV, and Roku devices.
2. WHEN a discovered household media device transitions from standby to active, THE Kshema_App SHALL record a Ghost_Signal in the Ghost_Signal_Log.
3. WHEN the Anchor device re-associates with the home Wi-Fi network identifier after 5:00 AM local time, THE Kshema_App SHALL record a Ghost_Signal in the Ghost_Signal_Log.
4. WHEN any Ghost_Signal is recorded during a pending morning Routine_Rhythm check, THE Sentinel_Worker SHALL mark the morning Routine_Rhythm as confirmed.
5. THE Sentinel_Worker SHALL treat a confirmed Ghost_Signal as sufficient to prevent escalation for the associated morning Routine_Rhythm check.

### Requirement 7: Vitality Pulse Emotional Loop

**User Story:** As an Observer, I want a warm daily confirmation that my Anchor is up and active, so that I feel reassured without intruding on their privacy.

#### Acceptance Criteria

1. WHEN an Anchor morning Routine_Rhythm is confirmed, THE Kshema_Platform SHALL generate a Vitality_Pulse notification for each Observer in the Circle.
2. THE Vitality_Pulse notification SHALL include the Anchor preferred display name, the verified confirmation time in the Anchor timezone, and available context such as step count and local weather.
3. THE Vitality_Pulse notification SHALL use the Brand_Lexicon and SHALL exclude any Banned_Term.
4. WHEN an Observer records a micro-voice reply of up to 10 seconds, THE Kshema_Platform SHALL deliver the reply to the Anchor.
5. WHEN a Vitality_Pulse is generated, THE Kshema_API SHALL record the event in the Vitality_Pulse_Log.
6. THE Kshema_App SHALL present the Vitality_Pulse using the healthy-state color Muted Sage Green (#3D6B52).

### Requirement 8: Zero-Knowledge Ephemeral Flight Recorder

**User Story:** As an Anchor, I want my recent context to be captured only in an encrypted form the server cannot read, so that responders get evidence during a real emergency while my everyday privacy is preserved.

#### Acceptance Criteria

1. THE Kshema_App SHALL capture a context snapshot comprising coarse location, Wi-Fi association, and battery state at 3-minute intervals into an on-device rolling buffer.
2. THE Kshema_App SHALL bound the on-device rolling buffer to a maximum of 20 context snapshots representing at most 60 minutes of history.
3. WHEN the on-device rolling buffer reaches its maximum size, THE Kshema_App SHALL discard the oldest context snapshot as each new snapshot is added.
4. THE Kshema_App SHALL serialize, compress, and encrypt the rolling buffer into an Encrypted_Black_Box at 15-minute intervals.
5. WHEN encrypting the rolling buffer, THE Kshema_App SHALL generate a random 256-bit symmetric key, encrypt the payload with that symmetric key using authenticated encryption, and encrypt the symmetric key with the Observer Circle public key.
6. THE Kshema_API SHALL store the Encrypted_Black_Box and SHALL exclude any capability to decrypt the Encrypted_Black_Box payload.
7. WHILE no Safety_Incident has reached STAGE_4_HYPERLOCAL_DISPATCH and no Shadow_SOS is active, THE Kshema_Platform SHALL withhold the Encrypted_Black_Box decryption key material from all Observers.
8. WHEN a Safety_Incident reaches STAGE_4_HYPERLOCAL_DISPATCH or a Shadow_SOS is triggered, THE Kshema_Platform SHALL release the Encrypted_Black_Box to Observers holding the Encrypted_Black_Box access permission.
9. WHERE an Observer holds the Encrypted_Black_Box access permission and the Encrypted_Black_Box has been released, THE Kshema_App SHALL decrypt the Encrypted_Black_Box using the Observer private key held in the Secure_Enclave.
10. THE round trip of serializing, compressing, and encrypting a rolling buffer and then decrypting it with the authorized Observer private key SHALL reproduce the original context snapshots.

### Requirement 9: Black Box Payload Round-Trip Integrity

**User Story:** As an Observer responding to an emergency, I want the decrypted Flight Recorder to exactly reflect what was captured, so that I can trust the evidence I act on.

#### Acceptance Criteria

1. FOR ALL valid rolling buffers, encrypting a rolling buffer into an Encrypted_Black_Box and then decrypting the Encrypted_Black_Box with the authorized Observer private key SHALL yield context snapshots equivalent to the original rolling buffer.
2. IF an Encrypted_Black_Box payload fails authenticated-encryption integrity verification during decryption, THEN THE Kshema_App SHALL reject the payload and report a decryption-integrity error.
3. IF a User without the Encrypted_Black_Box access permission attempts to obtain the Encrypted_Black_Box, THEN THE Kshema_API SHALL deny the request and return an authorization error.

### Requirement 10: Edge Acoustic Distress Detection

**User Story:** As an Anchor, I want my phone to recognize distress sounds on-device, so that a serious incident can be detected without any audio ever leaving my phone.

#### Acceptance Criteria

1. THE Acoustic_Distress_Classifier SHALL classify audio on-device for distress categories including heavy impacts, glass breakage, and vocal distress cues.
2. THE Acoustic_Distress_Classifier SHALL process audio in memory only and SHALL exclude any writing of audio to persistent storage and any transmission of audio off the device.
3. WHEN the Acoustic_Distress_Classifier detects a distress category with confidence greater than 0.82 sustained for more than 1.5 seconds AND the Anchor device reports motionlessness for at least 30 seconds, THE Sentinel_Worker SHALL raise a Safety_Incident at STAGE_2_GENTLE_DEVICE_CHIME.
4. IF a distress classification confidence is 0.82 or lower, THEN THE Sentinel_Worker SHALL exclude the classification from triggering a Safety_Incident.

### Requirement 11: Silent Hardware Shadow SOS and Blackout Mode

**User Story:** As an Anchor in danger, I want to silently and covertly summon help using a hardware gesture, so that I can call for aid without alerting a nearby threat.

#### Acceptance Criteria

1. WHEN an Anchor presses the device power button 4 times within 2.5 seconds on a supported Android device, THE Kshema_App SHALL trigger a Shadow_SOS.
2. WHEN an Anchor invokes the registered duress action on a supported iOS device, THE Kshema_App SHALL trigger a Shadow_SOS.
3. WHEN a Shadow_SOS is triggered, THE Kshema_App SHALL enter Blackout_Mode presenting a screen that mimics a powered-off device.
4. WHILE Blackout_Mode is active, THE Kshema_Platform SHALL silently dispatch a high-priority alert to the Circle Observers.
5. WHEN a Shadow_SOS is triggered, THE Kshema_Platform SHALL include the Anchor decrypted location in the Observer alert.
6. WHEN a Shadow_SOS is triggered, THE Kshema_Platform SHALL release the Encrypted_Black_Box to Observers holding the Encrypted_Black_Box access permission.
7. WHILE Blackout_Mode is active, THE Kshema_App SHALL suppress audible and visible alert indicators on the Anchor device.

### Requirement 12: Four-Stage Escalation State Machine

**User Story:** As an Observer, I want escalation to proceed gently and only intensify when signals continue to indicate a problem, so that my Anchor is protected without unnecessary alarm.

#### Acceptance Criteria

1. WHEN a Grace_Deadline passes without a confirmed Routine_Rhythm, THE Sentinel_Worker SHALL open a Safety_Incident at STAGE_1_CONVERSATIONAL_WHATSAPP and send a conversational WhatsApp check-in to the Anchor.
2. WHILE a Safety_Incident remains unresolved for 20 minutes after entering STAGE_1_CONVERSATIONAL_WHATSAPP, THE Sentinel_Worker SHALL advance the Safety_Incident to STAGE_2_GENTLE_DEVICE_CHIME and emit an audible chime on the Anchor device.
3. WHILE a Safety_Incident remains unresolved for 20 minutes after entering STAGE_2_GENTLE_DEVICE_CHIME, THE Sentinel_Worker SHALL advance the Safety_Incident to STAGE_3_OBSERVER_SILENT_ALERT and send a high-priority push notification to the Circle Observers.
4. WHILE a Safety_Incident remains unresolved for 20 minutes after entering STAGE_3_OBSERVER_SILENT_ALERT, THE Sentinel_Worker SHALL advance the Safety_Incident to STAGE_4_HYPERLOCAL_DISPATCH and initiate Hyperlocal_Dispatch.
5. THE Sentinel_Worker SHALL advance a Safety_Incident through the Escalation_Stages strictly in the order STAGE_1_CONVERSATIONAL_WHATSAPP, STAGE_2_GENTLE_DEVICE_CHIME, STAGE_3_OBSERVER_SILENT_ALERT, STAGE_4_HYPERLOCAL_DISPATCH.
6. THE Kshema_API SHALL record each Escalation_Stage transition of a Safety_Incident in an audit trail with a timestamp and the transition cause.
7. WHEN a Safety_Incident is displayed at STAGE_1_CONVERSATIONAL_WHATSAPP or STAGE_2_GENTLE_DEVICE_CHIME, THE Kshema_App SHALL present the incident using the escalating-stage color Soft Amber (#D9822B).

### Requirement 13: Incident Auto-Resolution

**User Story:** As an Anchor, I want a false alarm to clear itself the moment I show any sign of normal life, so that my Circle is not disturbed unnecessarily.

#### Acceptance Criteria

1. WHEN a passive screen-unlock event is received for an Anchor with an unresolved Safety_Incident, THE Sentinel_Worker SHALL resolve the Safety_Incident and record the Auto_Resolution_Source.
2. WHEN a positive step-count delta is received for an Anchor with an unresolved Safety_Incident, THE Sentinel_Worker SHALL resolve the Safety_Incident and record the Auto_Resolution_Source.
3. WHEN a charger-unplug event is received for an Anchor with an unresolved Safety_Incident, THE Sentinel_Worker SHALL resolve the Safety_Incident and record the Auto_Resolution_Source.
4. WHEN a Ghost_Signal is recorded for an Anchor with an unresolved Safety_Incident, THE Sentinel_Worker SHALL resolve the Safety_Incident and record the Auto_Resolution_Source.
5. WHEN the Anchor responds to the conversational WhatsApp check-in, THE Sentinel_Worker SHALL resolve the Safety_Incident and record the Auto_Resolution_Source.
6. WHEN the Anchor manually dismisses an unresolved Safety_Incident, THE Sentinel_Worker SHALL resolve the Safety_Incident and record the Auto_Resolution_Source.
7. WHEN an authorized Observer manually overrides an unresolved Safety_Incident, THE Sentinel_Worker SHALL resolve the Safety_Incident and record the Auto_Resolution_Source.
8. WHEN a Safety_Incident is resolved, THE Sentinel_Worker SHALL halt all pending Escalation_Stage advancements for that Safety_Incident.
9. IF a Shadow_SOS is triggered while a Safety_Incident is unresolved, THEN THE Sentinel_Worker SHALL hand the Safety_Incident off to Shadow_SOS dispatch rather than continue timed stage advancement.

### Requirement 14: Hyperlocal 100-Meter First Responder Dispatch

**User Story:** As an Observer who cannot physically reach my Anchor in time, I want nearby humans contacted immediately at the final stage, so that help arrives faster than distant emergency services.

#### Acceptance Criteria

1. WHEN a Safety_Incident reaches STAGE_4_HYPERLOCAL_DISPATCH, THE Kshema_Platform SHALL place priority interactive voice calls simultaneously to the Primary Observer, the society security gate contact, and the immediate neighbor contact recorded in the Hyperlocal_Contact_Profile.
2. THE Hyperlocal_Dispatch voice message SHALL include the Anchor building, flat, society, and door-access details from the Hyperlocal_Contact_Profile.
3. WHEN a Safety_Incident reaches STAGE_4_HYPERLOCAL_DISPATCH, THE Kshema_Platform SHALL send a priority text message to the Hyperlocal_Contact_Profile contacts.
4. THE Kshema_Platform SHALL generate the Hyperlocal_Dispatch voice message text dynamically from the Hyperlocal_Contact_Profile and incident context.
5. WHERE a CircleMember lacks the authority to trigger Hyperlocal_Dispatch, THE Kshema_API SHALL exclude that CircleMember from manually initiating Hyperlocal_Dispatch.
6. WHEN Hyperlocal_Dispatch is initiated, THE Kshema_API SHALL record the dispatch actions in the Safety_Incident audit trail.

### Requirement 15: Observer Dashboard

**User Story:** As an Observer, I want a calm dashboard of my Anchors' current well-being, so that I can see at a glance that all is well.

#### Acceptance Criteria

1. THE Kshema_App SHALL present each Observer a dashboard listing each Anchor in the Observer Circles with a current well-being state.
2. WHILE an Anchor has no unresolved Safety_Incident and a confirmed current Routine_Rhythm, THE Kshema_App SHALL present the Anchor well-being state as "All Well" using Muted Sage Green (#3D6B52).
3. WHILE an Anchor has an unresolved Safety_Incident, THE Kshema_App SHALL present the Anchor current Escalation_Stage on the dashboard.
4. THE Kshema_App SHALL present the dashboard using the Brand_Lexicon and SHALL exclude any Banned_Term.
5. THE Kshema_App SHALL exclude any continuous location trace of an Anchor from the Observer dashboard during normal operation.

### Requirement 16: Brand Design Lexicon and Visual Constraints

**User Story:** As a user, I want the experience to feel dignified and reassuring rather than clinical, so that using Kshema never feels like being surveilled or treated as a patient.

#### Acceptance Criteria

1. THE Kshema_App SHALL render user-facing text exclusively from the Brand_Lexicon and SHALL exclude every Banned_Term including Monitoring, Surveillance, Tracking, Patient, Elderly Watch, Supervision, Fall Alarm, and Panic Button.
2. THE Kshema_App SHALL use Sandalwood Cream (#FDFBF7) as the primary canvas color, Terracotta (#C85A32) as the primary action color, and Deep Charcoal (#1F2421) as the typography color.
3. THE Kshema_App SHALL represent healthy well-being states using Muted Sage Green (#3D6B52) and delayed or escalating stages using Soft Amber (#D9822B).
4. THE Kshema_App SHALL exclude the clinical red color (#FF0000) and the hospital blue color (#0066FF) from the user interface.
5. THE Kshema_App SHALL refer to protected individuals as Anchors and to guardians as Observers throughout the user interface.

### Requirement 17: Multi-Language Support

**User Story:** As a user in India, I want to use Kshema in my own language, so that safety communication is clear to me and my Anchor.

#### Acceptance Criteria

1. THE Kshema_App SHALL provide the user interface in each Supported_Language: English, Hindi, Kannada, Tamil, and Telugu.
2. WHEN a User selects a Supported_Language, THE Kshema_App SHALL render all user-facing text in the selected Supported_Language.
3. THE Kshema_Platform SHALL generate conversational WhatsApp check-in messages in the Anchor selected Supported_Language.
4. THE Kshema_Platform SHALL preserve Brand_Lexicon meaning and exclude Banned_Terms across every Supported_Language.

### Requirement 18: Background Reliability and Battery Survival

**User Story:** As an Anchor, I want ambient protection to keep running reliably in the background, so that my Circle is not falsely alarmed by the app being killed by the operating system.

#### Acceptance Criteria

1. WHILE ambient protection is active on a supported Android device, THE Kshema_App SHALL run a minimum-priority foreground service to sustain background operation.
2. WHEN onboarding an Anchor on a supported Android device, THE Kshema_App SHALL guide the Anchor to grant a battery optimization exemption.
3. THE Kshema_App SHALL register device presence and power-state broadcast receivers to detect passive well-being signals while backgrounded.
4. IF the Kshema_App loses background execution capability, THEN THE Kshema_App SHALL notify the Anchor to restore ambient protection.
5. THE Kshema_App SHALL store device background-execution configuration in the DeviceConfig record.

### Requirement 19: Privacy and Data Protection Guarantees

**User Story:** As a privacy-conscious user, I want strong guarantees that Kshema does not surveil me, so that I can trust the platform with my safety.

#### Acceptance Criteria

1. THE Kshema_Platform SHALL exclude continuous GPS trace collection during normal operation.
2. THE Kshema_Platform SHALL exclude indoor camera capture from all operation.
3. THE Kshema_Platform SHALL exclude any decryption capability for the Encrypted_Black_Box payload from the Kshema_API.
4. THE Acoustic_Distress_Classifier SHALL exclude any persistence or transmission of raw audio.
5. WHERE Anchor location is disclosed to Observers, THE Kshema_Platform SHALL restrict disclosure to STAGE_4_HYPERLOCAL_DISPATCH incidents and active Shadow_SOS events.
6. THE Kshema_API SHALL record access to the Encrypted_Black_Box in the Safety_Incident audit trail.

### Requirement 20: Subscription Lifecycle, Trial, and Tiered Protection

**User Story:** As an Observer or Anchor, I want the complete safety system during a 14-day free trial and a seamless transition to paid Pro, so that the Circle shield stays continuous while telephony and messaging costs are managed.

#### Acceptance Criteria

1. WHEN a User creates a new Circle, THE Kshema_API SHALL initialize the Circle in TRIAL Subscription_Tier for exactly 14 calendar days.
2. WHILE a Circle is in TRIAL Subscription_Tier, THE Kshema_Platform SHALL grant full Pro_Tier capabilities including morning routine evaluation, WhatsApp check-ins, the four-stage escalation, Hyperlocal_Dispatch, and Vitality_Pulses.
3. WHILE a Circle is in TRIAL Subscription_Tier, THE Kshema_Platform SHALL preserve full emergency escalation, acoustic distress classification, and hardware duress capability.
4. WHEN the Trial_Period expires without an active paid subscription, THE Kshema_Platform SHALL transition the Circle into Shield_Paused_State.
5. WHILE a Circle is in Shield_Paused_State, THE Sentinel_Worker SHALL suspend all scheduled routine checks, automated WhatsApp pings, delayed escalation queues, and automated IVR dispatch for that Circle.
6. WHILE a Circle is in Shield_Paused_State, THE Kshema_App SHALL present the Circle status as "Shield Paused" using a neutral grey indicator, display the most recent on-demand battery and step signals, and SHALL exclude presenting the status as "All Well".
7. WHILE a Circle is in Shield_Paused_State, THE Kshema_App SHALL display a disclosure that automated routine verification and emergency dispatch are inactive.
8. WHEN an authorized CircleMember completes purchase of a monthly or annual Pro subscription, THE Kshema_API SHALL update the Circle to PRO Subscription_Tier and resume all active Sentinel_Worker routines for that Circle.
9. WHEN 4 days remain and again when 1 day remains before Trial_Period expiration, THE Kshema_Platform SHALL deliver a non-intrusive trial status update to each Observer in the Circle.
10. WHEN validating a subscription, THE Kshema_API SHALL verify Apple StoreKit receipts, Google Play Billing receipts, and localized recurring payment webhooks including UPI Autopay recurring tokens.
11. THE Kshema_App SHALL present all subscription terms, the trial countdown, and upgrade prompts using the Brand_Lexicon and SHALL exclude every Banned_Term.

### Requirement 21: Administrative Operations, Fleet Health, and Security Console

**User Story:** As an operations engineer or support agent, I want an admin console to monitor fleet background-agent reliability, triage carrier failures, manage subscription exceptions, and support families during live escalations, so that reliability and support are maintained while zero-knowledge privacy is upheld.

#### Acceptance Criteria

_RBAC and Identity_

1. THE Admin_Console SHALL authenticate each Admin_User with multi-factor authentication and assign each Admin_User exactly one Admin_Role: SUPER_ADMIN, SUPPORT_AGENT, or BILLING_OPS.
2. WHERE an Admin_User holds the SUPPORT_AGENT Admin_Role, THE Admin_Console SHALL restrict permissions to reading User metadata, searching Circles, inspecting delivery logs, and triggering manual WhatsApp and IVR retries.
3. WHERE an Admin_User holds the BILLING_OPS Admin_Role, THE Admin_Console SHALL restrict permissions to viewing subscription statuses, modifying Trial_Periods, issuing manual Pro overrides, and inspecting payment webhooks.
4. WHERE an Admin_User holds the SUPER_ADMIN Admin_Role, THE Admin_Console SHALL grant access to system configuration, third-party credentials, and admin user management.
5. IF an Admin_User attempts an action outside the assigned Admin_Role, THEN THE Kshema_API SHALL reject the request, return an authorization error, and record a security violation in the Admin_Audit_Ledger.

_Privacy Inviolability_

6. THE Admin_Console and Kshema_API SHALL exclude any capability for any Admin_User, regardless of Admin_Role, to decrypt or view Encrypted_Black_Box contents.
7. THE Admin_Console SHALL exclude any capability to initiate live GPS polling, continuous location traces, or raw audio monitoring of any Anchor.
8. WHEN displaying a User or Circle record, THE Admin_Console SHALL mask each phone number to the last 4 digits, except during an active STAGE_4_HYPERLOCAL_DISPATCH emergency triage session opened by an authorized SUPPORT_AGENT.
9. WHEN an Admin_User performs a view, query, mutation, or export, THE Kshema_API SHALL record the action in the append-only Admin_Audit_Ledger with a timestamp, the Admin_User identifier, the source IP address, the target entity, and a justification note.

_Live Incident Operations_

10. THE Incident_Ops_Console SHALL present a real-time monitor of all active Safety_Incidents across all four Escalation_Stages.
11. WHEN an upstream gateway returns a delivery failure or timeout for an active Safety_Incident, THE Incident_Ops_Console SHALL raise a visual alarm and highlight the failed dispatch.
12. WHERE an automated WhatsApp or IVR dispatch fails during an active Safety_Incident, THE Admin_Console SHALL allow an authorized SUPPORT_AGENT to manually trigger an alternate carrier fallback dispatch.
13. THE Admin_Console SHALL present Carrier_Gateway_Health including WhatsApp delivery latency, Meta template rejections, India DLT registration status, and IVR connection success.
14. IF a carrier gateway error rate exceeds 5 percent over a 15-minute rolling window, THEN THE Kshema_API SHALL trigger a high-priority alert to the on-call engineering team.

_Fleet Device Health_

15. THE Admin_Console SHALL aggregate Fleet_Telemetry_Pulse heartbeat latency across device manufacturers including Xiaomi, Samsung, OnePlus, Vivo, and Apple.
16. WHEN an Anchor device misses 3 consecutive scheduled telemetry heartbeats representing 45 minutes of silence during configured active hours, THE Kshema_API SHALL flag the Anchor device as "Telemetry At Risk".
17. THE Admin_Console SHALL present the percentage of Anchor devices with battery optimization disabled compared to the percentage with battery optimization OEM-suppressed.
18. WHEN a support staff member requests a device wakefulness test, THE Admin_Console SHALL send a silent high-priority push ping to the target Anchor device.

_Subscription and Support Overrides_

19. WHEN an authorized BILLING_OPS or SUPER_ADMIN Admin_User grants a trial extension to a Circle, THE Kshema_API SHALL update the Circle trial expiration time, record the reason, and restore the Circle from Shield_Paused_State to TRIAL Subscription_Tier.
20. WHEN an Apple StoreKit, Google Play Billing, or recurring-payment webhook fails to process automatically, THE Admin_Console SHALL present the failed payload in an error queue with inspect, edit, and re-drive options.
21. WHEN a User submits an account deletion request under the DPDP Act or GDPR, THE Admin_Console SHALL allow an authorized Admin_User to schedule a cryptographic purge that permanently deletes personal profile information, telemetry logs, and public keys after a 30-day grace period.

### Requirement 22: Family Vitality Streaks, Ambient Connection Loops, and Micro-Interactions

**User Story:** As an Observer and Anchor, I want the Circle to celebrate daily morning continuity through streaks, one-tap emotional greetings, and shared milestones, so that opening Kshema is a heartwarming habit rather than a reaction to dread.

#### Acceptance Criteria

_Vitality Streaks_

1. THE Kshema_Platform SHALL maintain a Vitality_Streak per Circle counting consecutive days of verified morning Routine_Rhythms.
2. WHEN an Anchor morning Routine_Rhythm is confirmed, THE Kshema_Platform SHALL increment the Circle Vitality_Streak by one.
3. THE Kshema_Platform SHALL treat Vitality_Streaks as cooperative achievements and SHALL exclude any competitive or shaming presentation when a Vitality_Streak resets.
4. WHERE a routine check is delayed or a Safety_Incident resolves without crisis, THE Kshema_Platform SHALL preserve the active Vitality_Streak.
5. WHEN an Anchor sets status to "Traveling" or the Kshema_App detects battery maintenance, THE Kshema_Platform SHALL apply a Streak_Freeze preserving the Vitality_Streak for up to 3 consecutive days.
6. THE Sentinel_Worker SHALL exclude the loss or reset of a Vitality_Streak from triggering any Safety_Incident or escalation.

_Sparsh Micro-Interactions_

7. THE Kshema_App SHALL present each Observer a one-tap Sparsh_Reaction widget on the morning dashboard and on the lock-screen push.
8. THE Sparsh_Reaction options SHALL comprise Morning Chai, Pranam/Blessing, Morning Sun, and Marigold Flower.
9. WHEN an Observer sends a Sparsh_Reaction, THE Kshema_App on the Anchor device SHALL present a non-intrusive animated card with a soft warm chime.
10. WHEN an Anchor views a Sparsh_Reaction, THE Kshema_App SHALL allow a one-tap blessing or heart response requiring no typing.
11. WHEN a Sparsh_Reaction interaction occurs, THE Kshema_API SHALL record the interaction and SHALL present a 30-day connection rhythm on request.

_Daily Panchanga Card_

12. THE Kshema_App SHALL present a personalized Daily_Panchanga_Card on the Anchor home screen based on Anchor location and selected Supported_Language.
13. THE Daily_Panchanga_Card SHALL display local sunrise and sunset times, the regional lunar calendar values Tithi, Nakshatra, and Masa, upcoming festivals, and one uplifting proverb in the selected Supported_Language.
14. WHEN the local clock reaches 04:00 in the Anchor timezone, THE Kshema_App SHALL update the Daily_Panchanga_Card.

_Cooperative Movement Milestones_

15. WHERE the Family_Movement_Milestone feature is enabled, THE Kshema_Platform SHALL aggregate the weekly step totals of the Anchor and Observers into a shared Family_Movement_Milestone journey.
16. WHEN a Family_Movement_Milestone is reached, THE Kshema_App SHALL visualize the collective distance as a tranquil journey and present a shareable illustrated postcard.
17. THE Kshema_Platform SHALL exclude individual rankings, competitive leaderboards, and public comparison between CircleMembers.

_Notification Restraint_

18. THE Kshema_Platform SHALL limit engagement push notifications to at most one morning delivery per day per User.
19. THE Kshema_App SHALL render streak celebrations and milestone badges using Temple Brass (#D4A359), Terracotta (#C85A32), and Muted Sage Green (#3D6B52).
20. THE Kshema_App SHALL exclude alarm-style notifications, countdown timers, and red alert indicators from every engagement feature.

### Requirement 23: Cryptographic Key Recovery

**User Story:** As an Observer, I want to recover my decryption identity after losing or replacing my device, so that I never permanently lose the ability to decrypt emergency Flight Recorder payloads.

#### Acceptance Criteria

1. WHEN an Observer sets up a cryptographic identity, THE Kshema_App SHALL provision a Key_Recovery mechanism comprising a recovery passphrase and an encrypted key backup to the platform key store such as iCloud Keychain or Google Password Manager.
2. WHEN an Observer reinstalls the Kshema_App or activates a new device, THE Kshema_App SHALL restore the private key via the Key_Recovery mechanism without exposing the private key to the Kshema_API.
3. WHERE the Key_Recovery mechanism is unavailable, THE Kshema_Platform SHALL allow a Circle admin to re-invite the Observer with a freshly generated public key.
4. IF a private key cannot be recovered, THEN THE Kshema_App SHALL notify the Observer that historical Encrypted_Black_Box payloads encrypted to the prior key are unrecoverable and SHALL re-establish encryption to the new key for future payloads.

### Requirement 24: Offline Telemetry Buffering and Network Resiliency

**User Story:** As an Anchor with intermittent connectivity, I want telemetry buffered locally and reconciled on reconnect, so that a network outage never causes a false escalation.

#### Acceptance Criteria

1. WHILE the Anchor device has no network connectivity, THE Kshema_App SHALL queue heartbeats and telemetry deltas into the on-device Offline_Telemetry_Queue.
2. WHEN network connectivity is restored, THE Kshema_App SHALL flush the Offline_Telemetry_Queue to the Kshema_API as a bulk synchronization.
3. WHEN evaluating routine confirmation, THE Sentinel_Worker SHALL use the last successful telemetry synchronization time and buffered timestamps rather than wall-clock silence alone.
4. WHERE an Anchor device has been offline within the configured network-grace window, THE Sentinel_Worker SHALL withhold escalation attributable solely to missing heartbeats until buffered telemetry is reconciled.

### Requirement 25: Developer Simulation and Time-Warp Mode

**User Story:** As a developer, I want to exercise the full escalation pipeline without incurring carrier costs or triggering real emergencies, so that I can test safely and cheaply.

#### Acceptance Criteria

1. WHERE Simulation_Mode is enabled, THE Kshema_Platform SHALL compress escalation stage intervals to a configured short test cycle instead of the production 20-minute intervals.
2. WHERE Simulation_Mode is enabled, THE Kshema_Platform SHALL route WhatsApp, SMS, and IVR dispatches to an internal mock logging console instead of live carrier providers.
3. THE Kshema_Platform SHALL restrict Simulation_Mode to non-production environments and authorized Admin_Users.
4. WHILE Simulation_Mode is active, THE Kshema_Platform SHALL label all resulting Safety_Incidents and dispatches as simulated in the Admin_Audit_Ledger and incident records.

### Requirement 26: Safety Disclaimer and Terms Acceptance Gate

**User Story:** As a user, I want clear disclosure of what Kshema is and is not, so that my expectations are correct and the platform's limits are transparent.

#### Acceptance Criteria

1. WHEN a User onboards, THE Kshema_App SHALL present a mandatory Safety_Disclaimer stating that Kshema is an ambient routine assurance and software notification utility, that Kshema is not a licensed medical device, security company, or official emergency service, and that Kshema depends on cellular networks, push delivery, and third-party gateways.
2. THE Kshema_App SHALL require explicit acceptance of the Safety_Disclaimer and terms before activating Ambient_Shield for an Anchor.
3. WHEN a User accepts the Safety_Disclaimer, THE Kshema_API SHALL record the acceptance with a timestamp and version.
4. THE Kshema_App SHALL present the Safety_Disclaimer using the Brand_Lexicon and SHALL exclude every Banned_Term.

### Requirement 27: App Store Data Safety and Privacy Disclosures

**User Story:** As the platform operator, I want data collection disclosures to accurately match runtime behavior, so that app store reviews pass and users are correctly informed.

#### Acceptance Criteria

1. THE Data_Safety_Disclosure SHALL declare collection of device identifiers and push notification tokens for notification delivery.
2. THE Data_Safety_Disclosure SHALL declare collection of diagnostic activity data comprising step-count deltas for routine verification.
3. THE Data_Safety_Disclosure SHALL declare that the Kshema_Platform does not sell user data and does not track users across third-party apps.
4. THE Data_Safety_Disclosure SHALL declare that plaintext continuous location traces are not stored on servers during normal operation.
5. THE Data_Safety_Disclosure SHALL remain consistent with the actual runtime data collection behavior of the Kshema_App and Kshema_API.

### Requirement 28: Observer Web Portal and Ambient Desktop Experience

**User Story:** As an Observer working at a computer, I want a desktop web portal for continuous ambient oversight across time zones, keyboard-friendly Circle configuration, historical vitality review, and subscription management, so that I can care for my Anchors without depending solely on a mobile device.

#### Acceptance Criteria

_Authentication and Web Cryptography_

1. THE Observer_Web_Portal SHALL authenticate Users via a one-time passcode sent to the registered phone number and SHALL offer optional WebAuthn passkey registration using FIDO2, TouchID, or Windows Hello for subsequent logins.
2. WHEN an Observer logs in, THE Web_Crypto_Vault SHALL generate or restore the Observer asymmetric key pair using client-side Web Cryptography APIs and SHALL exclude the Observer private key from any data transmitted to the Kshema_API.
3. WHERE an Observer accesses an Encrypted_Black_Box in the browser during an authorized STAGE_4_HYPERLOCAL_DISPATCH emergency, THE Web_Crypto_Vault SHALL decrypt the payload within the local browser session and SHALL exclude any transmission of decrypted data to the Kshema_API.
4. WHILE an Observer_Web_Portal session remains idle for 30 minutes, THE Observer_Web_Portal SHALL lock the interface and require biometric or passcode re-authentication before further use.

_Ambient Desk Mode_

5. THE Observer_Web_Portal SHALL provide an Ambient_Desk_Mode for persistent display in pinned browser tabs or secondary monitors.
6. THE Ambient_Desk_Mode SHALL display a synchronized dual-timezone clock contrasting the Observer local time with the Anchor local time.
7. WHILE an Anchor is in a confirmed healthy state, THE Ambient_Desk_Mode SHALL render the status hero card using Muted Sage Green (#3D6B52) with the label "All Well" and the verified morning wakefulness timestamp.
8. WHILE an Anchor is in an escalating Safety_Incident, THE Ambient_Desk_Mode SHALL update via a real-time connection, shift the canvas to Soft Amber (#D9822B), and display the active Escalation_Stage with direct-action controls to place a voice call and to mark the Anchor confirmed safe.
9. THE Ambient_Desk_Mode SHALL refresh telemetry silently in the background and SHALL exclude any requirement for a manual page reload.

_Circle, Routine, and Hyperlocal Configuration_

10. THE Observer_Web_Portal SHALL provide management forms for Anchor Sentinel_Policies including expected wake times, expected bed times, grace intervals, preferred Supported_Languages, and WhatsApp delivery schedules.
11. THE Observer_Web_Portal SHALL allow configuring the Hyperlocal_Contact_Profile including society name, building block, flat number, gate intercom contact, and door-access smart lock codes.
12. THE Observer_Web_Portal SHALL allow inviting new Circle members, assigning CircleRoles, and configuring permission flags for triggering Hyperlocal_Dispatch and accessing the Encrypted_Black_Box.

_Vitality History_

13. THE Observer_Web_Portal SHALL present an interactive 30-day connection rhythm calendar of morning confirmation times, Sparsh_Reaction interactions, and step progression.
14. THE Observer_Web_Portal SHALL allow listening to archived micro-voice replies of up to 10 seconds and viewing Vitality_Pulse cards.
15. THE Observer_Web_Portal SHALL exclude continuous location breadcrumbs and historical location traces from all dashboard views.

_Billing_

16. THE Observer_Web_Portal SHALL provide self-service billing supporting international payment cards and recurring regional payment mechanisms.
17. THE Observer_Web_Portal SHALL allow viewing the active Subscription_Tier, viewing the trial expiration countdown, downloading tax-compliant PDF invoices, and switching between monthly and annual Pro_Tier billing intervals.
18. THE Observer_Web_Portal SHALL render all user-facing text using the Brand_Lexicon and SHALL exclude every Banned_Term.

### Requirement 29: Ephemeral First-Responder Emergency Web Portal

**User Story:** As an apartment security guard or neighbor contacted during a STAGE_4_HYPERLOCAL_DISPATCH emergency, I want an instant zero-login mobile web view via an SMS link to see the flat location, read door-access instructions, and confirm the resident's safety, so that I can help without installing an app.

#### Acceptance Criteria

_Token Generation_

1. WHEN a Safety_Incident reaches STAGE_4_HYPERLOCAL_DISPATCH, THE Kshema_API SHALL generate an Emergency_Access_Token bound exclusively to that Safety_Incident identifier.
2. THE Emergency_Access_Token SHALL be cryptographically signed, valid for at most 60 minutes, and restricted to read-only emergency triage attributes.
3. WHEN an Emergency_Access_Token is generated, THE Kshema_Platform SHALL embed the Emergency_Access_Token in a shortened HTTPS URL delivered via priority SMS and WhatsApp to the gate guard and neighbor contacts recorded in the Hyperlocal_Contact_Profile.

_Zero-Login Delivery and Performance_

4. WHEN a recipient taps the emergency link, THE Ephemeral_Responder_Portal SHALL load in any mobile browser without registration, login, or application installation.
5. THE Ephemeral_Responder_Portal SHALL complete initial page render within 1.5 seconds under a constrained 3G connection.

_Emergency Payload_

6. THE Ephemeral_Responder_Portal SHALL display a high-contrast emergency card containing the Anchor preferred display name, the society, building, and flat identifiers, the door-access instructions and smart lock backup codes, and a single-tap dialer to the Primary Observer.
7. THE Ephemeral_Responder_Portal SHALL exclude historical location traces, financial data, and personal chat history from the interface.

_Acknowledgment and Triage_

8. THE Ephemeral_Responder_Portal SHALL provide a prominent single-tap confirmation control indicating the responder has reached the flat and the Anchor is safe.
9. WHEN a first responder taps the confirmation control, THE Ephemeral_Responder_Portal SHALL prompt for the responder name, transmit the resolution to the Kshema_API, resolve the active Safety_Incident with an Observer-override resolution source, and notify all Circle Observers.
10. WHEN the active Safety_Incident is resolved by any Auto_Resolution_Source, THE Kshema_API SHALL immediately invalidate the associated Emergency_Access_Token.
11. IF an invalid or expired Emergency_Access_Token is accessed, THEN THE Ephemeral_Responder_Portal SHALL display an informational screen stating the safety check has concluded.
12. WHEN a visit, button click, or page load occurs on the Ephemeral_Responder_Portal, THE Kshema_API SHALL record the event, source IP address, and user-agent in the Safety_Incident audit trail.

### Requirement 30: Public Brand, Trust, and Privacy Portal

**User Story:** As a prospective family member or privacy researcher, I want an authoritative public web portal explaining the platform philosophy, zero-knowledge architecture, and subscription tiers, so that I can make an informed decision before registering.

#### Acceptance Criteria

_Philosophy and Architecture_

1. THE Public_Brand_Portal SHALL articulate the "Dignity Over Surveillance" tenet explaining why ambient passive telemetry replaces cameras, tracking, and manual buttons.
2. THE Public_Brand_Portal SHALL present an interactive visual explanation of the four-stage escalation ladder and the zero-knowledge Flight_Recorder.

_Localization and Pricing_

3. THE Public_Brand_Portal SHALL present subscription terms for the 14-day Trial_Period, the monthly and annual Pro_Tier plans, and the Shield_Paused_State.
4. THE Public_Brand_Portal SHALL display pricing localized in INR, USD, GBP, AED, and SGD with automatic currency detection based on visitor geography.
5. THE Public_Brand_Portal SHALL provide content in every Supported_Language: English, Hindi, Kannada, Tamil, and Telugu.

_Legal and Privacy_

6. THE Public_Brand_Portal SHALL host the Terms of Service, the mandatory Safety_Disclaimer, and a Privacy Policy compliant with the DPDP Act and GDPR.
7. THE Public_Brand_Portal SHALL host the public Data_Safety_Disclosure detailing collected data elements and affirming that data is never sold or traded.
8. THE Public_Brand_Portal SHALL adhere to the Brand_Lexicon and the visual palette Sandalwood Cream (#FDFBF7), Terracotta (#C85A32), and Deep Charcoal (#1F2421), and SHALL exclude every Banned_Term across all public pages.

### Requirement 31: Answering Machine Detection and Interactive DTMF Handshake

**User Story:** As an Observer relying on automated Stage 4 voice calls, I want verification that a real human answered rather than voicemail, so that emergency dispatch is never falsely marked successful.

#### Acceptance Criteria

1. WHEN placing an automated priority voice call during STAGE_4_HYPERLOCAL_DISPATCH, THE Kshema_Platform SHALL execute Answering Machine Detection via the telephony carrier gateway.
2. THE Kshema_Platform SHALL require an Interactive_Voice_Handshake in which the recipient presses digit 1 within 15 seconds of connection to confirm human presence.
3. IF an automated voicemail greeting or silence is detected OR the recipient fails to transmit the required tone within 15 seconds, THEN THE Kshema_Platform SHALL treat the attempt as unacknowledged and immediately initiate a carrier retry or failover to the next contact.
4. WHEN an Interactive_Voice_Handshake occurs, THE Kshema_Platform SHALL record the DTMF confirmation timestamp and the telephony detection diagnostic code in the Safety_Incident audit trail.

### Requirement 32: Bedtime Battery Guardian

**User Story:** As an Anchor and Observer, I want the platform to ensure the phone has enough charge before sleep, so that a dead battery does not cause a false morning panic.

#### Acceptance Criteria

1. WHEN the local time reaches 60 minutes before the Anchor configured expected bed time, THE Kshema_App SHALL evaluate the device battery level and charging state.
2. WHERE the battery level is below 25 percent AND the device is not connected to a charger, THE Kshema_App SHALL emit a gentle audible bedtime chime prompting the Anchor to connect the charger to keep the morning shield active.
3. IF the device remains disconnected from a charger and drops below 15 percent after midnight, THEN THE Kshema_Platform SHALL log a pre-dawn battery exhaustion warning and notify the Observer dashboard.
4. WHERE a morning Routine_Rhythm evaluation fails solely due to a documented pre-dawn battery exhaustion, THE Sentinel_Worker SHALL flag the initial STAGE_1_CONVERSATIONAL_WHATSAPP alert as likely battery depletion rather than an unverified routine anomaly.

### Requirement 33: Encrypted Emergency Medical Dossier

**User Story:** As an Observer, I want first responders reaching my Anchor during a STAGE_4_HYPERLOCAL_DISPATCH emergency to immediately know critical health details, so that proper care is administered without delay.

#### Acceptance Criteria

1. THE Kshema_App SHALL allow an Anchor or authorized Observer to store an Emergency_Medical_Dossier comprising blood group, critical drug allergies, chronic conditions, ongoing medications, attending physician contact, and hospital insurance details.
2. THE Emergency_Medical_Dossier SHALL be stored encrypted and SHALL exclude visibility to Admin_Users and ordinary Observers during normal operation.
3. WHEN a Safety_Incident reaches STAGE_4_HYPERLOCAL_DISPATCH, THE Kshema_Platform SHALL make the Emergency_Medical_Dossier available for display within the Ephemeral_Responder_Portal accessed by on-site responders.
4. WHEN a Safety_Incident is resolved, THE Kshema_Platform SHALL immediately revoke access to the Emergency_Medical_Dossier on the Ephemeral_Responder_Portal.

### Requirement 34: Sanctuary, Travel, and Medical Procedure Mode

**User Story:** As an Anchor undergoing treatment, flying across time zones, or on a retreat, I want to schedule a temporary pause of routine evaluations, so that expected absences do not trigger false alarms.

#### Acceptance Criteria

1. THE Kshema_App and Observer_Web_Portal SHALL allow an authorized User to activate Sanctuary_Mode with a start time, an expected return timestamp of up to 14 days, and an optional reason.
2. WHILE Sanctuary_Mode is active, THE Sentinel_Worker SHALL suspend morning Routine_Rhythm evaluations, automated WhatsApp pings, and all Escalation_Stages for that Anchor.
3. WHILE Sanctuary_Mode is active, THE Kshema_App SHALL display a calm banner indicating the Sanctuary Shield is active until the resumption time, using Temple Brass (#D4A359).
4. WHEN the scheduled return timestamp is reached, THE Sentinel_Worker SHALL automatically resume standard Sentinel_Policy evaluations without manual reactivation.
5. WHILE Sanctuary_Mode is active, THE Kshema_Platform SHALL preserve the Circle Vitality_Streak.

### Requirement 35: Co-Living Anchors and Shared Household Signal Attribution

**User Story:** As an Observer with two aging parents in the same home, I want the platform to understand shared household dynamics, so that activity from one parent does not create confusion about the other.

#### Acceptance Criteria

1. THE Kshema_Platform SHALL support configuring multiple Anchors within a shared Co_Living_Household.
2. WHERE a Ghost_Signal is detected from a shared household media device, THE Kshema_Platform SHALL attribute the signal as household activity confirmed and SHALL require individual phone telemetry comprising a screen unlock or a step delta to confirm independent wakefulness for each Anchor whose Sentinel_Policy requires it.
3. WHEN a Safety_Incident escalates for one co-living Anchor, THE Sentinel_Worker SHALL deliver a quiet high-priority STAGE_1_CONVERSATIONAL_WHATSAPP check-in to the co-living partner device before dispatching external alerts.
4. WHERE the co-living partner acknowledges the check-in and confirms the spouse is safe, THE Sentinel_Worker SHALL resolve the Safety_Incident immediately with a co-living-partner-confirmed resolution source.
