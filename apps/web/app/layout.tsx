import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kshema — Ambient Shield",
  description:
    "Kshema keeps your Circle connected with calm, dignified ambient care.",
  applicationName: "Kshema",
  // Next auto-serves app/icon.svg + app/apple-icon.svg as the favicon / touch
  // icon; declaring them here keeps the references explicit for older crawlers.
  icons: {
    icon: "/icon.svg",
    apple: "/apple-icon.svg",
  },
};

// Mobile-responsive viewport + brand theme color for the browser chrome.
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