/**
 * Dispatch worker barrel (task 12.2).
 *
 * The job registry (`jobs/registry.ts`) and production wiring (`app.ts`/
 * `server.ts`) import the dispatch processor + its deps from here; tests import
 * the pure logic for hermetic assertions.
 */
export {
  createDispatchProcessor,
  type DispatchJobData,
  type DispatchJobName,
  type DispatchProcessorDeps,
} from "./processor.js";

export {
  runVoiceHandshakeDispatch,
  backoffDelayMs,
  toBullMqRetryOptions,
  DEFAULT_RETRY_POLICY,
  type DispatchContact,
  type DispatchDeps,
  type RetryPolicy,
  type VoiceAttempt,
  type VoiceDispatchInput,
  type VoiceDispatchOutcome,
  type VoiceHandshakeAuditEntry,
} from "./dispatch.js";

export {
  assembleHyperlocalContacts,
  assembleHyperlocalMessage,
  assembleHyperlocalDispatch,
  eligibleManualDispatchers,
  canManuallyDispatch,
  buildHyperlocalDispatchAudit,
  HYPERLOCAL_CONTACT_IDS,
  HYPERLOCAL_CONTACT_LABELS,
  type HyperlocalProfileInput,
  type HyperlocalIncidentContext,
  type HyperlocalDispatchContent,
  type ManualDispatchMember,
  type HyperlocalDispatchAuditEntry,
  type BuildHyperlocalAuditInput,
} from "./hyperlocal.js";
