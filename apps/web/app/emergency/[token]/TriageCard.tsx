import type { ResponderTriagePayload } from "@kshema/types";
import { ConfirmAction } from "./ConfirmAction";

/**
 * The read-only emergency triage card (R29.6, R29.7).
 *
 * High-contrast, single-purpose layout showing exactly what an on-scene
 * responder needs:
 *   - Anchor preferred display name
 *   - society / building / flat identifiers
 *   - door-access instructions + smart-lock backup codes
 *   - a single-tap `tel:` dialer to the Primary Observer
 *   - the Emergency_Medical_Dossier ONLY when the API released it (bound
 *     incident at STAGE_4 — R33.3); otherwise the block is absent
 *
 * The component renders ONLY fields present on the strict
 * `ResponderTriagePayload` DTO. Location history, financial, and chat data are
 * structurally excluded upstream (R29.7) — there is no field here that could
 * display them. The confirm control is delegated to the client
 * `ConfirmAction`.
 *
 * Pure server component apart from the embedded client confirm island.
 */
export function TriageCard({
  token,
  payload,
}: {
  token: string;
  payload: ResponderTriagePayload;
}): JSX.Element {
  const location = [payload.society, payload.building, payload.flat]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const dossier = payload.dossier;
  const hasDossier =
    dossier !== undefined &&
    (Boolean(dossier.bloodGroup) ||
      dossier.allergies.length > 0 ||
      dossier.chronicConditions.length > 0 ||
      dossier.criticalMedications.length > 0 ||
      Boolean(dossier.attendingDoctorName) ||
      Boolean(dossier.attendingDoctorPhone) ||
      Boolean(dossier.healthInsurancePolicy));

  return (
    <main className="wrap">
      <div className="card">
        <div className="banner">Someone may need your help</div>

        <div className="name">{payload.preferredName}</div>
        {location ? <div className="sub">{location}</div> : null}

        {payload.flat ? (
          <div className="row">
            <div className="label">Flat</div>
            <div className="value">{payload.flat}</div>
          </div>
        ) : null}

        {payload.doorAccessInstructions ? (
          <div className="row">
            <div className="label">Door access</div>
            <div className="value">{payload.doorAccessInstructions}</div>
          </div>
        ) : null}

        {payload.smartLockBackupCodes.length > 0 ? (
          <div className="row">
            <div className="label">Smart-lock backup codes</div>
            <div className="codes">
              {payload.smartLockBackupCodes.map((code, i) => (
                <span className="code" key={`${code}-${i}`}>
                  {code}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {payload.primaryObserverDialer ? (
          <a
            className="btn btn-call"
            href={`tel:${payload.primaryObserverDialer}`}
          >
            Call the family contact
          </a>
        ) : null}

        {hasDossier && dossier ? (
          <section className="dossier" aria-label="Medical information">
            <h2>Medical information</h2>
            {dossier.bloodGroup ? (
              <div className="row">
                <div className="label">Blood group</div>
                <div className="value">{dossier.bloodGroup}</div>
              </div>
            ) : null}
            {dossier.allergies.length > 0 ? (
              <div className="row">
                <div className="label">Allergies</div>
                <div className="value">{dossier.allergies.join(", ")}</div>
              </div>
            ) : null}
            {dossier.chronicConditions.length > 0 ? (
              <div className="row">
                <div className="label">Conditions</div>
                <div className="value">
                  {dossier.chronicConditions.join(", ")}
                </div>
              </div>
            ) : null}
            {dossier.criticalMedications.length > 0 ? (
              <div className="row">
                <div className="label">Critical medications</div>
                <div className="value">
                  {dossier.criticalMedications.join(", ")}
                </div>
              </div>
            ) : null}
            {dossier.attendingDoctorName ? (
              <div className="row">
                <div className="label">Doctor</div>
                <div className="value">
                  {dossier.attendingDoctorName}
                  {dossier.attendingDoctorPhone
                    ? ` · ${dossier.attendingDoctorPhone}`
                    : ""}
                </div>
              </div>
            ) : null}
            {dossier.healthInsurancePolicy ? (
              <div className="row">
                <div className="label">Insurance</div>
                <div className="value">{dossier.healthInsurancePolicy}</div>
              </div>
            ) : null}
          </section>
        ) : null}

        <ConfirmAction token={token} />

        <p className="note">
          Tapping confirm lets the family know their loved one is safe.
        </p>
      </div>
    </main>
  );
}
