# AI Call Consent Gate

A fail-closed state machine that blocks recording, transcription, AI streaming, and data
collection on an inbound call until the caller has heard a notice and affirmatively
consented.

No vendor SDKs. No network calls. Pure functions and a state machine, so the rule is
testable and the same in every environment.

```
npm install
npm test
```

12 tests, all passing.

---

## The problem

If you build an AI phone system, you have a compliance requirement that usually lives in a
runbook: *play the notice, get consent, then start recording.*

Runbooks are not controls. Nothing stops a misconfigured call flow, a new adapter, or a
tired developer at 11pm from starting the recorder first. The requirement is real, the
enforcement is a promise, and the gap between them is where this goes wrong.

This module moves that requirement into the runtime. Protected work is not permitted by
policy. It is unavailable until the state machine says otherwise.

```ts
assertReceptionistActionAllowed(session, "start-recording");
// throws: Receptionist action "start-recording" is blocked
//         while consent is consent-required
```

---

## The state machine

```text
notice-required
   |  completeReceptionistNotice()      canonical text + timing verified
   v
consent-required
   |  DTMF 1  -> granted                all protected actions unlock
   |  DTMF 2  -> declined               unrecorded alternative offered
   |  other   -> stays consent-required logged, never treated as consent
   |  timeout -> timed-out              unrecorded alternative offered
   v
granted
   |  DTMF 9  -> consent-revoked        protected actions re-block immediately
   v
consent-revoked
```

**Protected actions**, unavailable unless status is `granted`:

`start-recording` · `start-transcription` · `stream-to-ai` · `collect-caller-details` ·
`automated-routing` · `summarize-call` · `persist-call-content`

**Always available:** `play-notice`, `collect-dtmf-consent`, `offer-unrecorded-alternative`,
`end-call`.

---

## Usage

```ts
import {
  createInboundConsentSession,
  completeReceptionistNotice,
  submitReceptionistConsentDigit,
  assertReceptionistActionAllowed,
} from "./src/ReceptionistConsent";

// 1. A call arrives. Recording and media streaming are OFF.
let session = createInboundConsentSession("provider-call-id", "Example Business", now());

// 2. Play session.notice.text in full, then record that it completed.
session = completeReceptionistNotice(session, {
  version: session.notice.version,
  locale: session.notice.locale,
  text: session.notice.text,      // must match exactly
  startedAt: t0,
  completedAt: t1,
});

// 3. The caller presses a key.
session = submitReceptionistConsentDigit(session, "1", t2);

// 4. Your vendor adapter asks before doing anything protected.
assertReceptionistActionAllowed(session, "start-recording"); // throws unless granted
startTwilioRecording();
```

The session is immutable. Every transition returns a new object, so an adapter cannot
mutate its way past the gate.

---

## Design decisions worth explaining

### DTMF, not speech recognition

Listening for the caller to say "yes" requires running speech recognition on their voice.
**Speech recognition is transcription.** Doing it to collect consent means transcribing
someone before they consented to being transcribed.

A keypress is inert. It also makes the boundary observable and testable, which "the model
thought it heard yes" never is.

### One rule everywhere, no geolocation

Consent requirements vary by jurisdiction, and a single call can involve more than one. The
gate applies the strictest practical rule to every call rather than branching on a caller's
location.

This is a deliberate trade: it is stricter than some jurisdictions require. It also removes
a class of bug where a geolocation lookup fails and the system silently falls through to the
weaker path.

### Silence is not consent

Continuing the call, saying nothing, pressing an unrecognized key, or letting the timer
expire all leave protected actions blocked. Invalid input is recorded as an event, never
treated as agreement.

### The notice text is verified, not trusted

`completeReceptionistNotice` rejects evidence whose text or locale does not match exactly
what the session generated. An adapter cannot claim it played the notice while playing a
shortened one.

Timing is checked too: the notice cannot start before the session existed, cannot complete
before it started, and consent cannot be recorded before the notice finished.

### Consent is revocable mid-call

`DTMF 9` moves a granted session to `consent-revoked` and re-blocks every protected action
immediately. Consent that cannot be withdrawn is not meaningful consent, and a caller who
changes their mind halfway through a call is not an edge case.

### The audit trail holds evidence, not content

Sessions record the notice version, exact text, locale, provider call ID, start and
completion times, the response, and the response time. **No audio and no transcript.** One
test asserts the event log contains neither.

You can prove what a caller was told and what they chose, without retaining what they said.

---

## What this is not

- **Not legal advice.** It implements one conservative operational rule. Whether that rule
  satisfies your obligations in your jurisdiction is a question for a qualified lawyer.
- **Not a telephony integration.** There is no Twilio, no ElevenLabs, no model provider. You
  wire it into your own adapters.
- **Not sufficient on its own.** The gate is application-layer. It cannot stop a provider
  from recording if account-level recording is enabled, and it does not remove carrier
  metadata or connection logs, which exist regardless. Configure the provider correctly too.
- **Not multilingual yet.** The notice generator produces English. The locale is carried
  through the session and verified, so translations slot in, but none ship here.

---

## Testing

```
npm test          # vitest
npm run typecheck # tsc --noEmit
```

The tests cover the paths that matter: fail-closed at creation, no unlock merely because
the notice finished, rejection of non-canonical notice text and impossible timing, replay
rejection, revocation, invalid input, timeout, and the absence of audio or transcripts in
the audit trail.

---

## Related

The governance thinking behind this lives at
[matthewferrill/runa-governance](https://github.com/matthewferrill/runa-governance). That
repository is honest that most of its principles are not enforced in code.

This is one that is.

---

## Licence

MIT. Use it, change it, ship it.

If you find a way past the gate, please open an issue. That is the most useful thing anyone
could do with this.
