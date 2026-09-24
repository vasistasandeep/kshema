import type { Translator } from "../../../content/catalog";
import { ESCALATION_LADDER } from "../../../content/escalation";

/**
 * Interactive four-stage escalation-ladder explainer (R30.2).
 *
 * Renders the ladder strictly in `order` with a per-stage palette role mapped
 * onto the shared brand semantic tokens (healthy → escalating → primaryAction).
 * `<details>`/`<summary>` provides progressive-disclosure interactivity without
 * client JavaScript, keeping the page statically generated. No raw hex or
 * clinical color is used here.
 *
 * Requirements: 30.2, 30.8.
 */

/** Maps a stage palette role to the Tailwind classes from the @kshema/ui preset. */
const ROLE_CLASSES: Record<string, { dot: string; ring: string }> = {
  healthy: { dot: "bg-healthy", ring: "ring-healthy/30" },
  escalating: { dot: "bg-escalating", ring: "ring-escalating/30" },
  primaryAction: { dot: "bg-primary-action", ring: "ring-primary-action/30" },
};

export function EscalationLadder({ t }: { t: Translator }): JSX.Element {
  return (
    <ol className="relative space-y-4 border-l border-deep-charcoal/10 pl-6">
      {[...ESCALATION_LADDER]
        .sort((a, b) => a.order - b.order)
        .map((stage) => {
          const cls = ROLE_CLASSES[stage.paletteRole] ?? ROLE_CLASSES.healthy!;
          return (
            <li key={stage.id} className="relative">
              <span
                aria-hidden
                className={`absolute -left-[31px] top-1.5 h-3 w-3 rounded-full ring-4 ${cls.dot} ${cls.ring}`}
              />
              <details className="group rounded-xl bg-white/60 p-4 shadow-sm">
                <summary className="flex cursor-pointer items-center justify-between gap-3 font-medium text-typography">
                  <span>
                    <span className="mr-2 text-sm text-typography/60">
                      {stage.order}
                    </span>
                    {t(stage.titleKey)}
                  </span>
                  <span
                    aria-hidden
                    className="text-typography/40 transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                </summary>
                <p className="mt-2 text-sm leading-relaxed text-typography/80">
                  {t(stage.descriptionKey)}
                </p>
              </details>
            </li>
          );
        })}
    </ol>
  );
}
