/**
 * SMS dispatch abstraction (R1.1).
 *
 * OTP delivery is abstracted behind an injectable `SmsSender` so the auth
 * routes never depend on a concrete carrier. Tests inject a capturing mock,
 * local dev logs to the console, and a real carrier adapter (Twilio / Exotel /
 * Meta) lands in a later telephony task (task 12) — the interface stays stable.
 *
 * The transport intentionally knows nothing about OTP semantics: it just
 * delivers a message body to a phone number. Hashing, expiry, and challenge
 * bookkeeping live in the OTP store / route.
 */

/** A single outbound SMS. */
export interface SmsMessage {
  /** E.164-style destination phone number. */
  to: string;
  /** Plain-text message body. */
  body: string;
}

/** Injectable SMS transport. Real carrier integration arrives in task 12. */
export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/**
 * Default non-production sender: logs the message rather than contacting a
 * carrier. Never used in tests (which inject their own capturing mock) and
 * never appropriate for production, where a real `CarrierAdapter`-backed
 * sender replaces it.
 */
export class ConsoleSmsSender implements SmsSender {
  constructor(
    private readonly log: (msg: string) => void = (m) => {
      // eslint-disable-next-line no-console
      console.log(m);
    },
  ) {}

  async send(message: SmsMessage): Promise<void> {
    this.log(`[sms] to=${message.to} body=${message.body}`);
  }
}
