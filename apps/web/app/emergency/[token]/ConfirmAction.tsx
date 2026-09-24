"use client";

import { useState } from "react";
import { confirmSafe } from "../../../lib/emergency-api";

/**
 * The single-tap "Reached / Confirm Safe" triage control (R29.8, R29.9).
 *
 * Flow (a client component because it drives the tap → name → confirm
 * interaction and the network call):
 *   1. A prominent single-tap button reveals a name field (R29.8).
 *   2. The responder enters their name and confirms.
 *   3. We POST to `/api/v1/emergency/:token/confirm`, which resolves the
 *      incident with `RESPONDER_CONFIRMED`, notifies Observers, and invalidates
 *      the token (R29.9, R29.10).
 *   4. On success we swap to the calm "concluded" acknowledgement in place so
 *      the responder sees clear confirmation without a full reload.
 *
 * The token is passed from the server component; this component never sees any
 * private key or bearer credential.
 */
type Phase = "idle" | "naming" | "submitting" | "done" | "error";

export function ConfirmAction({ token }: { token: string }): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  if (phase === "done") {
    return (
      <div className="confirm" role="status" aria-live="polite">
        <p className="note" style={{ fontSize: 16 }}>
          {message}
        </p>
      </div>
    );
  }

  async function submit(): Promise<void> {
    const responderName = name.trim();
    if (responderName.length === 0) {
      return;
    }
    setPhase("submitting");
    const result = await confirmSafe(token, responderName);
    if (result.ok) {
      setMessage(result.message);
      setPhase("done");
    } else {
      setMessage(result.message);
      setPhase("error");
    }
  }

  if (phase === "idle") {
    return (
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setPhase("naming")}
      >
        Reached / Confirm Safe
      </button>
    );
  }

  return (
    <div className="confirm">
      <label htmlFor="responderName">Your name</label>
      <input
        id="responderName"
        name="responderName"
        type="text"
        autoComplete="name"
        inputMode="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Ramesh (Gate Security)"
        disabled={phase === "submitting"}
      />
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void submit()}
        disabled={phase === "submitting" || name.trim().length === 0}
      >
        {phase === "submitting" ? "Sending…" : "Confirm resident is safe"}
      </button>
      {phase === "error" ? (
        <p className="note" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
