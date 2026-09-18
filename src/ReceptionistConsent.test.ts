import { describe, expect, it } from "vitest";
import {
  RECEPTIONIST_NOTICE_VERSION,
  assertReceptionistActionAllowed,
  buildNationwideReceptionistNotice,
  canPerformReceptionistAction,
  completeReceptionistNotice,
  createInboundConsentSession,
  revokeReceptionistConsent,
  submitReceptionistConsentDigit,
  timeOutReceptionistConsent,
  type ReceptionistCallAction,
} from "./ReceptionistConsent";

const CREATED_AT = "2026-07-31T12:00:00.000Z";
const NOTICE_STARTED_AT = "2026-07-31T12:00:01.000Z";
const NOTICE_COMPLETED_AT = "2026-07-31T12:00:10.000Z";
const RESPONSE_AT = "2026-07-31T12:00:12.000Z";

const protectedActions: ReceptionistCallAction[] = [
  "start-recording",
  "start-transcription",
  "stream-to-ai",
  "collect-caller-details",
  "automated-routing",
  "summarize-call",
  "persist-call-content",
];

function sessionAfterNotice() {
  const session = createInboundConsentSession("CA-test-1", "Example Business", CREATED_AT);
  return completeReceptionistNotice(session, {
    version: RECEPTIONIST_NOTICE_VERSION,
    locale: "en-US",
    text: session.notice.text,
    startedAt: NOTICE_STARTED_AT,
    completedAt: NOTICE_COMPLETED_AT,
  });
}

describe("nationwide AI Receptionist notice", () => {
  it("identifies the AI and requires an affirmative keypress before recorded processing", () => {
    const notice = buildNationwideReceptionistNotice("Example Business");

    expect(notice).toContain("Example Business");
    expect(notice).toMatch(/AI receptionist/i);
    expect(notice).toMatch(/recorded/i);
    expect(notice).toMatch(/transcribed/i);
    expect(notice).toMatch(/Press 1 to consent/i);
    expect(notice).toMatch(/Press 2 for a non-recorded alternative/i);
    expect(notice).toMatch(/press 9 at any time to stop recording/i);
    expect(notice).toMatch(/Go ahead and make your selection now\.$/);
  });

  it("refuses an unnamed business", () => {
    expect(() => buildNationwideReceptionistNotice("  ")).toThrow(/business name/i);
  });
});

describe("Receptionist consent gate", () => {
  it("starts fail-closed and permits only the notice or ending the call", () => {
    const session = createInboundConsentSession("CA-test-1", "Example Business", CREATED_AT);

    expect(session.status).toBe("notice-required");
    expect(canPerformReceptionistAction(session, "play-notice")).toBe(true);
    expect(canPerformReceptionistAction(session, "end-call")).toBe(true);
    expect(canPerformReceptionistAction(session, "collect-dtmf-consent")).toBe(false);
    for (const action of protectedActions) {
      expect(canPerformReceptionistAction(session, action), action).toBe(false);
    }
  });

  it("does not unlock processing merely because the notice finished", () => {
    const session = sessionAfterNotice();

    expect(session.status).toBe("consent-required");
    expect(canPerformReceptionistAction(session, "collect-dtmf-consent")).toBe(true);
    for (const action of protectedActions) {
      expect(canPerformReceptionistAction(session, action), action).toBe(false);
    }
  });

  it("rejects non-canonical notice evidence and impossible notice timing", () => {
    const session = createInboundConsentSession("CA-test-1", "Example Business", CREATED_AT);
    expect(() =>
      completeReceptionistNotice(session, {
        ...session.notice,
        text: `${session.notice.text} shortened`,
        startedAt: NOTICE_STARTED_AT,
        completedAt: NOTICE_COMPLETED_AT,
      }),
    ).toThrow(/canonical text and locale/i);

    expect(() =>
      completeReceptionistNotice(session, {
        ...session.notice,
        startedAt: NOTICE_COMPLETED_AT,
        completedAt: NOTICE_STARTED_AT,
      }),
    ).toThrow(/cannot precede/i);
  });

  it("unlocks every protected action only after DTMF 1", () => {
    const session = submitReceptionistConsentDigit(sessionAfterNotice(), "1", RESPONSE_AT);

    expect(session.status).toBe("granted");
    for (const action of protectedActions) {
      expect(canPerformReceptionistAction(session, action), action).toBe(true);
    }
    expect(session.events.at(-1)).toEqual({
      type: "consent-granted",
      method: "dtmf-1",
      occurredAt: RESPONSE_AT,
    });
  });

  it("rejects consent before the notice completes and rejects replay", () => {
    expect(() =>
      submitReceptionistConsentDigit(sessionAfterNotice(), "1", NOTICE_STARTED_AT),
    ).toThrow(/cannot precede completion/i);

    const granted = submitReceptionistConsentDigit(sessionAfterNotice(), "1", RESPONSE_AT);
    expect(() => submitReceptionistConsentDigit(granted, "1", RESPONSE_AT)).toThrow(
      /cannot be accepted/i,
    );
  });

  it("keeps processing blocked after DTMF 2 and permits the unrecorded alternative", () => {
    const session = submitReceptionistConsentDigit(sessionAfterNotice(), "2", RESPONSE_AT);

    expect(session.status).toBe("declined");
    expect(canPerformReceptionistAction(session, "offer-unrecorded-alternative")).toBe(true);
    for (const action of protectedActions) {
      expect(canPerformReceptionistAction(session, action), action).toBe(false);
    }
  });

  it("revokes consent with DTMF 9 and immediately re-blocks protected work", () => {
    const granted = submitReceptionistConsentDigit(sessionAfterNotice(), "1", RESPONSE_AT);
    const revoked = revokeReceptionistConsent(granted, "2026-07-31T12:00:15.000Z");

    expect(revoked.status).toBe("consent-revoked");
    expect(canPerformReceptionistAction(revoked, "offer-unrecorded-alternative")).toBe(true);
    for (const action of protectedActions) {
      expect(canPerformReceptionistAction(revoked, action), action).toBe(false);
    }
    expect(revoked.events.at(-1)).toEqual({
      type: "consent-revoked",
      method: "dtmf-9",
      occurredAt: "2026-07-31T12:00:15.000Z",
    });
  });

  it("does not interpret silence or an unrecognized key as consent", () => {
    const invalid = submitReceptionistConsentDigit(sessionAfterNotice(), "9", RESPONSE_AT);
    expect(invalid.status).toBe("consent-required");
    expect(canPerformReceptionistAction(invalid, "stream-to-ai")).toBe(false);

    const timedOut = timeOutReceptionistConsent(invalid, "2026-07-31T12:00:20.000Z");
    expect(timedOut.status).toBe("timed-out");
    expect(canPerformReceptionistAction(timedOut, "start-recording")).toBe(false);
    expect(canPerformReceptionistAction(timedOut, "offer-unrecorded-alternative")).toBe(true);
  });

  it("keeps exact notice evidence without storing caller audio", () => {
    const session = sessionAfterNotice();
    expect(session.events).toHaveLength(1);
    expect(session.events[0]).toMatchObject({
      type: "notice-completed",
      evidence: {
        version: RECEPTIONIST_NOTICE_VERSION,
        locale: "en-US",
        startedAt: NOTICE_STARTED_AT,
        completedAt: NOTICE_COMPLETED_AT,
      },
    });
    expect(JSON.stringify(session.events)).not.toMatch(/audio|transcript/i);
  });

  it("throws at the adapter boundary when protected work is attempted too early", () => {
    expect(() => assertReceptionistActionAllowed(sessionAfterNotice(), "start-transcription")).toThrow(
      /blocked while consent is consent-required/i,
    );
  });
});
