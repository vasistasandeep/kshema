"use client";
import { useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

interface Granted {
  boxId: string;
  encryptedPayload: string;
  iv: string;
  authTag: string;
  wrappedKey: string;
  capturedRange: { start: string; end: string };
}

/**
 * Flight Recorder (Encrypted_Black_Box) card. When the anchor has a released
 * incident (Stage-4 Hyperlocal_Dispatch), the Observer can request the
 * ciphertext through the gated endpoint. Access control is enforced server-side
 * (CircleMember + canAccessBlackBox + released); this surface just reflects the
 * gate decision. It shows ciphertext metadata only — real decryption happens in
 * the Web_Crypto_Vault with the Observer's private key (not wired in this demo).
 */
export function BlackBoxCard({ anchorId, released }: { anchorId: string; released: boolean }) {
  const [busy, setBusy] = useState(false);
  const [granted, setGranted] = useState<Granted | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  async function fetchBox() {
    setBusy(true); setGranted(null); setDenied(null);
    try {
      const res = await fetch("/api/anchor/blackbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchorId }),
      });
      const j = await res.json();
      if (res.ok) {
        setGranted(j as Granted);
      } else {
        setDenied((j && (j.message || j.error)) ? (j.message || j.error) : ("Request failed (" + res.status + ")"));
      }
    } catch (e) {
      setDenied(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <div className="label">Flight Recorder</div>
        <p className="mt-2 text-sm text-typography/65">
          Encrypted black box is {released ? "released for emergency triage" : "sealed"}. Only you can decrypt it, and only during a real emergency — our servers never can.
        </p>
        <button
          onClick={fetchBox}
          disabled={!released || busy}
          className={cn("btn mt-3", released ? "btn-primary" : "btn-outline opacity-60", busy && "opacity-60")}
        >
          {!released ? "Sealed 🔒" : busy ? "Requesting…" : "Decrypt in browser"}
        </button>

        {granted && (
          <div className="mt-3 rounded-xl border border-healthy/30 bg-healthy/[0.06] p-3 text-sm">
            <div className="font-medium text-healthy">Access granted — ciphertext released to you</div>
            <div className="mt-2 space-y-1 font-mono text-xs text-typography/70">
              <div>box: {granted.boxId}</div>
              <div>range: {new Date(granted.capturedRange.start).toLocaleString()} → {new Date(granted.capturedRange.end).toLocaleString()}</div>
              <div className="truncate">payload: {granted.encryptedPayload.slice(0, 44)}…</div>
              <div className="truncate">your wrapped key: {granted.wrappedKey.slice(0, 44)}…</div>
            </div>
            <p className="mt-2 text-xs text-typography/55">The server returned ciphertext only. Decryption would happen here in the Web Crypto vault using your private key.</p>
          </div>
        )}

        {denied && (
          <div className="mt-3 rounded-xl border border-escalating/30 bg-escalating/[0.06] p-3 text-sm">
            <div className="font-medium text-escalating">Access denied</div>
            <p className="mt-1 text-xs text-typography/70">{denied}</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
