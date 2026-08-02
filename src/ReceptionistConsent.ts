/**
 * Vendor-neutral, nationwide consent gate for an AI Receptionist.
 *
 * This module deliberately uses the strictest operational baseline everywhere:
 * no recording, transcription, AI streaming, automated intake, or persistence
 * until the caller affirmatively presses 1 after the complete notice. It does
 * not geolocate callers or relax the gate in one-party-consent states.
 *
 * The gate contains no Twilio, ElevenLabs, or LLM code. Vendor adapters must ask
 * this contract before starting any protected action. That keeps compliance in
 * the runtime boundary instead of in a launch checklist.
 */

export const RECEPTIONIST_NOTICE_VERSION = "2026-07-31.1";

export type ReceptionistConsentStatus =
  | "notice-required"
  | "consent-required"
  | "granted"
  | "declined"
  | "timed-out"
  | "consent-revoked";

export type ReceptionistCallAction =
  | "play-notice"
  | "collect-dtmf-consent"
  | "offer-unrecorded-alternative"
  | "end-call"
  | "start-recording"
  | "start-transcription"
  | "stream-to-ai"
  | "collect-caller-details"
  | "automated-routing"
  | "summarize-call"
  | "persist-call-content";

export type ReceptionistNoticeEvidence = {
  version: string;
  locale: string;
  text: string;
  startedAt: string;
  completedAt: string;
};

export type ReceptionistConsentEvent =
  | { type: "notice-completed"; evidence: ReceptionistNoticeEvidence }
  | { type: "invalid-dtmf"; digit: string; occurredAt: string }
  | { type: "consent-granted"; method: "dtmf-1"; occurredAt: string }
  | { type: "consent-declined"; method: "dtmf-2"; occurredAt: string }
  | { type: "consent-timed-out"; occurredAt: string }
  | { type: "consent-revoked"; method: "dtmf-9"; occurredAt: string };

export type ReceptionistConsentSession = {
  callId: string;
  direction: "inbound";
  status: ReceptionistConsentStatus;
  createdAt: string;
  notice: {
    version: string;
    locale: string;
    text: string;
  };
  events: readonly ReceptionistConsentEvent[];
};

const PROTECTED_ACTIONS = new Set<ReceptionistCallAction>([
  "start-recording",
  "start-transcription",
  "stream-to-ai",
  "collect-caller-details",
  "automated-routing",
  "summarize-call",
  "persist-call-content",
]);

export function buildNationwideReceptionistNotice(businessName: string): string {
  const name = businessName.trim();
  if (!name) {
    throw new Error("A business name is required in the call notice.");
  }

  return (
    `You've reached ${name}. Before we continue: I am an AI receptionist. ` +
    "If you press 1, this call will be recorded, transcribed, and processed by our service providers " +
    "to handle your request. Press 1 to consent and continue. Press 2 for a non-recorded alternative, " +
    "or hang up. After consenting, press 9 at any time to stop recording and automated processing."
  );
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return parsed;
}

function completedNoticeEvidence(session: ReceptionistConsentSession): ReceptionistNoticeEvidence {
  const event = session.events.find(
    (candidate): candidate is Extract<ReceptionistConsentEvent, { type: "notice-completed" }> =>
      candidate.type === "notice-completed",
  );
  if (!event) {
    throw new Error("Consent cannot be recorded without completed notice evidence.");
  }
  return event.evidence;
}

export function createInboundConsentSession(
  callId: string,
  businessName: string,
  createdAt: string,
  locale = "en-US",
): ReceptionistConsentSession {
  if (!callId.trim()) {
    throw new Error("A provider call ID is required.");
  }
  if (!locale.trim()) {
    throw new Error("A notice locale is required.");
  }
  timestamp(createdAt, "Session creation time");

  return {
    callId,
    direction: "inbound",
    status: "notice-required",
    createdAt,
    notice: {
      version: RECEPTIONIST_NOTICE_VERSION,
      locale,
      text: buildNationwideReceptionistNotice(businessName),
    },
    events: [],
  };
}

export function completeReceptionistNotice(
  session: ReceptionistConsentSession,
  evidence: ReceptionistNoticeEvidence,
): ReceptionistConsentSession {
  if (session.status !== "notice-required") {
    throw new Error(`The notice cannot complete while consent is ${session.status}.`);
  }
  if (evidence.version !== session.notice.version) {
    throw new Error(`Unsupported receptionist notice version: ${evidence.version}.`);
  }
  if (evidence.text !== session.notice.text || evidence.locale !== session.notice.locale) {
    throw new Error("Notice evidence must match the canonical text and locale stored for the session.");
  }
  const createdAt = timestamp(session.createdAt, "Session creation time");
  const startedAt = timestamp(evidence.startedAt, "Notice start time");
  const completedAt = timestamp(evidence.completedAt, "Notice completion time");
  if (startedAt < createdAt) {
    throw new Error("The notice cannot start before the consent session was created.");
  }
  if (completedAt < startedAt) {
    throw new Error("The notice completion time cannot precede its start time.");
  }

  return {
    ...session,
    status: "consent-required",
    events: [...session.events, { type: "notice-completed", evidence }],
  };
}

export function submitReceptionistConsentDigit(
  session: ReceptionistConsentSession,
  digit: string,
  occurredAt: string,
): ReceptionistConsentSession {
  if (session.status !== "consent-required") {
    throw new Error(`A consent response cannot be accepted while consent is ${session.status}.`);
  }
  if (!/^[0-9*#]$/.test(digit)) {
    throw new Error("A consent response must be one DTMF digit.");
  }
  const notice = completedNoticeEvidence(session);
  if (timestamp(occurredAt, "Consent response time") < timestamp(notice.completedAt, "Notice completion time")) {
    throw new Error("A consent response cannot precede completion of the notice.");
  }

  if (digit === "1") {
    return {
      ...session,
      status: "granted",
      events: [...session.events, { type: "consent-granted", method: "dtmf-1", occurredAt }],
    };
  }

  if (digit === "2") {
    return {
      ...session,
      status: "declined",
      events: [...session.events, { type: "consent-declined", method: "dtmf-2", occurredAt }],
    };
  }

  return {
    ...session,
    events: [...session.events, { type: "invalid-dtmf", digit, occurredAt }],
  };
}

export function timeOutReceptionistConsent(
  session: ReceptionistConsentSession,
  occurredAt: string,
): ReceptionistConsentSession {
  if (session.status !== "consent-required") {
    throw new Error(`Consent cannot time out while consent is ${session.status}.`);
  }
  const notice = completedNoticeEvidence(session);
  if (timestamp(occurredAt, "Consent timeout time") < timestamp(notice.completedAt, "Notice completion time")) {
    throw new Error("Consent cannot time out before completion of the notice.");
  }

  return {
    ...session,
    status: "timed-out",
    events: [...session.events, { type: "consent-timed-out", occurredAt }],
  };
}

export function revokeReceptionistConsent(
  session: ReceptionistConsentSession,
  occurredAt: string,
): ReceptionistConsentSession {
  if (session.status !== "granted") {
    throw new Error(`Consent cannot be revoked while consent is ${session.status}.`);
  }
  const granted = session.events.find(
    (event): event is Extract<ReceptionistConsentEvent, { type: "consent-granted" }> =>
      event.type === "consent-granted",
  );
  if (!granted) {
    throw new Error("Consent cannot be revoked without a recorded grant event.");
  }
  if (timestamp(occurredAt, "Consent revocation time") < timestamp(granted.occurredAt, "Consent grant time")) {
    throw new Error("Consent revocation cannot precede the consent grant.");
  }

  return {
    ...session,
    status: "consent-revoked",
    events: [...session.events, { type: "consent-revoked", method: "dtmf-9", occurredAt }],
  };
}

export function canPerformReceptionistAction(
  session: ReceptionistConsentSession,
  action: ReceptionistCallAction,
): boolean {
  if (PROTECTED_ACTIONS.has(action)) {
    return session.status === "granted";
  }

  if (action === "play-notice") {
    return session.status === "notice-required";
  }

  if (action === "collect-dtmf-consent") {
    return session.status === "consent-required";
  }

  if (action === "offer-unrecorded-alternative") {
    return (
      session.status === "consent-required" ||
      session.status === "declined" ||
      session.status === "timed-out" ||
      session.status === "consent-revoked"
    );
  }

  return action === "end-call";
}

export function assertReceptionistActionAllowed(
  session: ReceptionistConsentSession,
  action: ReceptionistCallAction,
): void {
  if (!canPerformReceptionistAction(session, action)) {
    throw new Error(`Receptionist action "${action}" is blocked while consent is ${session.status}.`);
  }
}
