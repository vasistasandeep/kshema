import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kshema — Operations Console",
  description:
    "Kshema admin console: fleet reliability, carrier health, live incident triage, and subscription support — bounded by the same zero-knowledge privacy guarantees.",
  applicationName: "Kshema Ops",
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FDFBF7",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-typography antialiased">
        {children}
      </body>
    </html>
  );
}