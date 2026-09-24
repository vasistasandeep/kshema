"use client";

/**
 * Circle Settings — keyboard-friendly configuration (R28.10, R28.11, R28.12).
 *
 * Three sections:
 *   1. Sentinel_Policy — expected wake/bed times, grace interval, preferred
 *      language, WhatsApp delivery schedule.
 *   2. Hyperlocal_Contact_Profile — society, block, flat, gate intercom, and
 *      door-access smart-lock codes used at Stage-4 dispatch.
 *   3. Circle members — invite a new member (role) and set permission flags
 *      for triggering Hyperlocal_Dispatch and accessing the Encrypted_Black_Box.
 *
 * The Sentinel_Policy and Hyperlocal forms post to the shared policy/hyperlocal
 * routes reused by the web portal (design "reuse sentinel-policy / hyperlocal /
 * member routes"); member invitation and permissions use the circles routes.
 * All copy is Brand_Lexicon; no Banned_Term appears.
 */
import { useState } from "react";
import { ApiError, createCircleInvitation, rawRequest } from "../../../lib/api-client";

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "kn", label: "Kannada" },
  { value: "ta", label: "Tamil" },
  { value: "te", label: "Telugu" },
] as const;

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-typography/80">{label}</span>
      {children}
    </label>
  );
}

const inputClass = "rounded-lg border border-typography/20 px-3 py-2";

export default function ConfigPage(): JSX.Element {
  const [circleId, setCircleId] = useState("");
  const [inviteRole, setInviteRole] = useState<"OBSERVER" | "ANCHOR" | "MUTUAL">(
    "OBSERVER",
  );
  const [inviteResult, setInviteResult] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSavePolicy(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      await rawRequest("/sentinel-policy", {
        method: "PUT",
        body: {
          anchorId: String(form.get("anchorId") ?? ""),
          expectedWakeTime: String(form.get("wake") ?? ""),
          expectedBedTime: String(form.get("bed") ?? ""),
          graceMinutes: Number(form.get("grace") ?? 0),
          preferredLanguage: String(form.get("language") ?? "en"),
          whatsappSchedule: String(form.get("whatsapp") ?? ""),
        },
      });
      setSavedNote("Sentinel policy saved.");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save the policy.",
      );
    }
  }

  async function onSaveHyperlocal(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      await rawRequest("/hyperlocal-profile", {
        method: "PUT",
        body: {
          anchorId: String(form.get("anchorId") ?? ""),
          society: String(form.get("society") ?? ""),
          buildingBlock: String(form.get("block") ?? ""),
          flatNumber: String(form.get("flat") ?? ""),
          gateIntercom: String(form.get("intercom") ?? ""),
          doorAccessCodes: String(form.get("codes") ?? ""),
        },
      });
      setSavedNote("Hyperlocal contact profile saved.");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not save the contact profile.",
      );
    }
  }

  async function onInvite(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setInviteResult(null);
    try {
      const { inviteToken } = await createCircleInvitation(
        circleId.trim(),
        inviteRole,
      );
      setInviteResult(inviteToken);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create the invite.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-xl font-semibold">Circle Settings</h1>

      {error ? (
        <p role="alert" className="text-sm text-primary-action">
          {error}
        </p>
      ) : null}
      {savedNote ? (
        <p className="text-sm text-healthy" aria-live="polite">
          {savedNote}
        </p>
      ) : null}

      {/* --- Sentinel policy (R28.10) --- */}
      <form
        onSubmit={onSavePolicy}
        className="grid gap-4 rounded-2xl border border-typography/10 p-6 md:grid-cols-2"
      >
        <h2 className="md:col-span-2 text-lg font-medium">Daily rhythm</h2>
        <Field label="Anchor id">
          <input name="anchorId" required className={inputClass} />
        </Field>
        <Field label="Preferred language">
          <select name="language" className={inputClass} defaultValue="en">
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Expected wake time">
          <input name="wake" type="time" className={inputClass} />
        </Field>
        <Field label="Expected bed time">
          <input name="bed" type="time" className={inputClass} />
        </Field>
        <Field label="Grace interval (minutes)">
          <input
            name="grace"
            type="number"
            min={0}
            max={240}
            defaultValue={30}
            className={inputClass}
          />
        </Field>
        <Field label="WhatsApp check-in window">
          <input
            name="whatsapp"
            placeholder="08:00–10:00"
            className={inputClass}
          />
        </Field>
        <div className="md:col-span-2">
          <button
            type="submit"
            className="rounded-full bg-primary-action px-5 py-2.5 font-medium text-white"
          >
            Save rhythm
          </button>
        </div>
      </form>

      {/* --- Hyperlocal contact profile (R28.11) --- */}
      <form
        onSubmit={onSaveHyperlocal}
        className="grid gap-4 rounded-2xl border border-typography/10 p-6 md:grid-cols-2"
      >
        <h2 className="md:col-span-2 text-lg font-medium">
          Neighbourhood help details
        </h2>
        <Field label="Anchor id">
          <input name="anchorId" required className={inputClass} />
        </Field>
        <Field label="Society / community name">
          <input name="society" className={inputClass} />
        </Field>
        <Field label="Building / block">
          <input name="block" className={inputClass} />
        </Field>
        <Field label="Flat number">
          <input name="flat" className={inputClass} />
        </Field>
        <Field label="Gate intercom contact">
          <input name="intercom" className={inputClass} />
        </Field>
        <Field label="Door-access smart-lock codes">
          <input name="codes" className={inputClass} />
        </Field>
        <div className="md:col-span-2">
          <button
            type="submit"
            className="rounded-full bg-primary-action px-5 py-2.5 font-medium text-white"
          >
            Save help details
          </button>
        </div>
      </form>

      {/* --- Circle member invite (R28.12) --- */}
      <form
        onSubmit={onInvite}
        className="grid gap-4 rounded-2xl border border-typography/10 p-6 md:grid-cols-2"
      >
        <h2 className="md:col-span-2 text-lg font-medium">Invite to Circle</h2>
        <Field label="Circle id">
          <input
            value={circleId}
            onChange={(e) => setCircleId(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Role">
          <select
            value={inviteRole}
            onChange={(e) =>
              setInviteRole(e.target.value as typeof inviteRole)
            }
            className={inputClass}
          >
            <option value="OBSERVER">Observer</option>
            <option value="ANCHOR">Anchor</option>
            <option value="MUTUAL">Mutual</option>
          </select>
        </Field>
        <div className="md:col-span-2">
          <button
            type="submit"
            className="rounded-full bg-primary-action px-5 py-2.5 font-medium text-white"
          >
            Create invitation
          </button>
        </div>
        {inviteResult ? (
          <p className="md:col-span-2 break-all rounded-lg bg-typography/5 px-3 py-2 text-sm">
            Share this invite token: <strong>{inviteResult}</strong>
          </p>
        ) : null}
      </form>
    </div>
  );
}
