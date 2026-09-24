import { palette } from "@kshema/ui";

/**
 * Inlined critical CSS for the ephemeral responder portal (R29.5).
 *
 * The portal must complete its first render within 1.5s on a constrained 3G
 * link, so it MUST NOT block on an external stylesheet. We ship a tiny,
 * self-contained sheet inlined into the edge-rendered `<head>` via a
 * `<style>` tag. It is intentionally small (single-purpose, high-contrast,
 * mobile-first) and draws every color from the shared `@kshema/ui` brand
 * palette (no clinical red / hospital blue — R16.4).
 *
 * High-contrast + large tap targets: the responder is often outdoors, in poor
 * light, on a locked phone. Buttons are ≥56px tall, text is large, and the
 * card uses Deep Charcoal on Sandalwood Cream for maximum legibility.
 */
export const CRITICAL_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:${palette.sandalwoodCream};
  color:${palette.deepCharcoal};
  line-height:1.4;
  padding:16px;
  min-height:100vh;
}
.wrap{max-width:520px;margin:0 auto}
.card{
  background:#fff;
  border:2px solid ${palette.terracotta};
  border-radius:14px;
  padding:20px;
  box-shadow:0 2px 10px rgba(31,36,33,.08);
}
.banner{
  background:${palette.terracotta};
  color:#fff;
  font-weight:700;
  font-size:15px;
  letter-spacing:.04em;
  text-transform:uppercase;
  text-align:center;
  padding:10px 12px;
  border-radius:10px;
  margin-bottom:16px;
}
.name{font-size:26px;font-weight:800;margin-bottom:4px}
.sub{font-size:15px;color:${palette.mutedSageGreen};margin-bottom:16px}
.row{padding:12px 0;border-top:1px solid #eee}
.row:first-of-type{border-top:0}
.label{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b6b6b;margin-bottom:4px}
.value{font-size:18px;font-weight:600;word-break:break-word}
.codes{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.code{background:${palette.sandalwoodCream};border:1px solid ${palette.templeBrass};border-radius:6px;padding:4px 10px;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.dossier{margin-top:16px;border:2px solid ${palette.softAmber};border-radius:12px;padding:14px;background:#fffaf2}
.dossier h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:${palette.softAmber};margin-bottom:8px}
.dossier .row{border-top-color:#f0e2c8}
.btn{
  display:block;width:100%;text-align:center;text-decoration:none;
  font-size:19px;font-weight:800;
  padding:18px 16px;min-height:56px;border-radius:12px;border:0;cursor:pointer;
}
.btn-call{background:${palette.mutedSageGreen};color:#fff;margin-top:16px}
.btn-primary{background:${palette.terracotta};color:#fff;margin-top:12px}
.btn-primary:disabled{opacity:.6;cursor:not-allowed}
.confirm{margin-top:16px}
.confirm label{display:block;font-size:13px;font-weight:700;margin-bottom:6px}
.confirm input{
  width:100%;font-size:18px;padding:14px;border:2px solid ${palette.deepCharcoal};
  border-radius:10px;background:#fff;color:${palette.deepCharcoal};
}
.note{font-size:13px;color:#6b6b6b;margin-top:12px;text-align:center}
.done{text-align:center;padding:40px 8px}
.done .mark{font-size:40px;margin-bottom:12px}
.done h1{font-size:22px;font-weight:800;margin-bottom:8px}
.done p{font-size:16px;color:#4a4a4a}
`.trim();
