"use client";

/**
 * Plan & Billing — self-service subscription management (R28.16, R28.17).
 *
 * Shows the active tier and trial countdown, opens the hosted billing portal
 * (Stripe international cards / Razorpay regional recurring) for card changes,
 * lists tax-compliant PDF invoices for download, and switches between monthly
 * and annual Pro billing intervals. Brand_Lexicon copy only.
 */
import { useEffect, useState } from "react";
import type { BillingSummary, InvoiceListResponse } from "@kshema/types";
import {
  fetchBillingSummary,
  fetchInvoices,
  openBillingPortal,
  switchBillingInterval,
} from "../../../lib/api-client";
import { API_BASE_URL } from "../../../lib/config";

const TIER_LABEL: Record<BillingSummary["tier"], string> = {
  TRIAL: "Trial",
  PRO: "Pro",
  SHIELD_PAUSED: "Ambient Shield paused",
};

export default function BillingPage(): JSX.Element {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload(): void {
    void fetchBillingSummary()
      .then(setSummary)
      .catch(() => setError("Could not load your plan."));
    void fetchInvoices().then(setInvoices).catch(() => undefined);
  }

  useEffect(reload, []);

  async function onPortal(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { redirectUrl } = await openBillingPortal();
      window.location.href = redirectUrl;
    } catch {
      setError("Could not open the billing portal.");
      setBusy(false);
    }
  }

  async function onSwitch(
    interval: "MONTHLY" | "ANNUAL",
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await switchBillingInterval(interval);
      reload();
    } catch {
      setError("Could not change your billing interval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Plan &amp; Billing</h1>

      {error ? (
        <p role="alert" className="text-sm text-primary-action">
          {error}
        </p>
      ) : null}

      <section className="rounded-2xl border border-typography/10 p-6">
        {summary ? (
          <>
            <p className="text-sm text-typography/60">Current plan</p>
            <p className="text-2xl font-semibold">
              {TIER_LABEL[summary.tier]}
              {summary.interval
                ? ` · ${summary.interval === "ANNUAL" ? "Annual" : "Monthly"}`
                : ""}
            </p>
            {summary.tier === "TRIAL" ? (
              <p className="mt-2 text-sm text-typography/70">
                {summary.trialDaysRemaining} day
                {summary.trialDaysRemaining === 1 ? "" : "s"} left in your trial.
              </p>
            ) : null}

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={onPortal}
                disabled={busy}
                className="rounded-full bg-primary-action px-5 py-2.5 font-medium text-white disabled:opacity-60"
              >
                Manage payment method
              </button>
              <button
                type="button"
                onClick={() => onSwitch("MONTHLY")}
                disabled={busy || summary.interval === "MONTHLY"}
                className="rounded-full border border-typography/20 px-5 py-2.5 disabled:opacity-50"
              >
                Switch to monthly
              </button>
              <button
                type="button"
                onClick={() => onSwitch("ANNUAL")}
                disabled={busy || summary.interval === "ANNUAL"}
                className="rounded-full border border-typography/20 px-5 py-2.5 disabled:opacity-50"
              >
                Switch to annual
              </button>
            </div>
          </>
        ) : (
          <p className="text-typography/60">Loading your plan…</p>
        )}
      </section>

      <section aria-label="Invoices">
        <h2 className="mb-3 text-sm font-medium text-typography/70">Invoices</h2>
        <ul className="flex flex-col gap-2">
          {(invoices?.invoices ?? []).map((inv) => (
            <li
              key={inv.id}
              className="flex items-center justify-between rounded-lg border border-typography/10 px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">
                  {new Date(inv.issuedAt).toLocaleDateString()}
                </p>
                <p className="text-xs text-typography/60">
                  {(inv.amountMinor / 100).toFixed(2)} {inv.currency}
                </p>
              </div>
              <a
                href={
                  inv.pdfUrl ??
                  `${API_BASE_URL}/web/billing/invoices/${inv.id}.pdf`
                }
                className="text-sm font-medium text-primary-action"
              >
                Download PDF
              </a>
            </li>
          ))}
          {invoices && invoices.invoices.length === 0 ? (
            <li className="text-sm text-typography/60">No invoices yet.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
