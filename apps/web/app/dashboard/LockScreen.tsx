"use client";

/**
 * Idle-lock overlay (R28.4). Shown after 30 idle minutes; requires re-auth
 * before the portal is usable again. Re-auth here is a passcode/biometric
 * gesture — the JWT session and the Web_Crypto_Vault key are untouched, so no
 * re-download of keys is needed, only a local unlock.
 */
export function LockScreen({ onUnlock }: { onUnlock: () => void }): JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Session locked"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-canvas/95 backdrop-blur"
    >
      <h2 className="text-2xl font-semibold text-typography">
        Your portal is resting
      </h2>
      <p className="max-w-sm text-center text-typography/70">
        For your Circle&apos;s privacy, we paused this view after a quiet spell.
        Confirm it&apos;s you to continue.
      </p>
      <button
        type="button"
        onClick={onUnlock}
        className="rounded-full bg-primary-action px-6 py-3 font-medium text-white"
      >
        Confirm and continue
      </button>
    </div>
  );
}
