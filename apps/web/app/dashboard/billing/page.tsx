import { getDashboard, getInvoices } from "@/lib/data";
import { Topbar } from "@/components/dashboard/Topbar";
import { Card, CardBody } from "@/components/ui/Card";
import { BillingActions } from "@/components/dashboard/BillingActions";
import { cn } from "@/lib/cn";

export default async function BillingPage() {
  const [dash, invoices] = await Promise.all([getDashboard(), getInvoices()]);
  const sub = dash.circle.subscription;
  const daysLeft = sub.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 86400000)) : 0;

  return (
    <div>
      <Topbar title="Billing" subtitle="Your Circle's protection plan" />
      <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8">
        <Card className="bg-gradient-to-br from-celebration/10 to-primary-action/5">
          <CardBody>
            <div className="flex items-start justify-between">
              <div>
                <span className="chip bg-celebration/15 text-celebration">{sub.tier}</span>
                <h2 className="mt-3 text-2xl font-semibold">{sub.tier === "TRIAL" ? `${daysLeft} days left in trial` : sub.tier === "PRO" ? "Pro protection active" : "Shield paused"}</h2>
                <p className="mt-1 text-typography/65">Full protection for your whole Circle — ₹{sub.amount}/{sub.interval === "MONTHLY" ? "month" : "year"}.</p>
              </div>
            </div>
            <BillingActions interval={sub.interval} />
          </CardBody>
        </Card>

        <Card className="mt-4"><CardBody>
          <div className="label mb-3">Invoices</div>
          <div className="divide-y divide-black/5">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between py-3 text-sm">
                <span className="text-typography/70">{new Date(inv.date).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
                <div className="flex items-center gap-3">
                  <span className="font-medium">₹{inv.amount}</span>
                  <span className={cn("chip", inv.status === "PAID" ? "bg-healthy/10 text-healthy" : "bg-escalating/10 text-escalating")}>{inv.status.toLowerCase()}</span>
                  <button className="text-primary-action font-semibold">PDF</button>
                </div>
              </div>
            ))}
          </div>
        </CardBody></Card>
      </div>
    </div>
  );
}
