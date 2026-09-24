import type { Translator } from "../../../content/catalog";
import { FLIGHT_RECORDER_EXPLAINER } from "../../../content/escalation";

/**
 * Zero-knowledge Flight_Recorder explainer (R30.2). Presents the sealed
 * ring-buffer → device-encryption → server-blind → authorized-release story as
 * a simple, statically-rendered list. Copy is fully localized via the catalog.
 *
 * Requirements: 30.2, 30.8.
 */
export function FlightRecorderExplainer({ t }: { t: Translator }): JSX.Element {
  return (
    <div className="rounded-2xl bg-temple-brass/10 p-6">
      <h3 className="text-xl font-semibold text-typography">
        {t(FLIGHT_RECORDER_EXPLAINER.headingKey)}
      </h3>
      <ul className="mt-4 space-y-3">
        {FLIGHT_RECORDER_EXPLAINER.pointKeys.map((key) => (
          <li key={key} className="flex items-start gap-3 text-typography/85">
            <span
              aria-hidden
              className="mt-2 h-2 w-2 shrink-0 rounded-full bg-temple-brass"
            />
            <span className="text-sm leading-relaxed">{t(key)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
