import type { Metadata, Viewport } from "next";
import "./globals.css";
import ApiKeyGate from "@/components/ApiKeyGate";

export const metadata: Metadata = {
  title: "Token Tracker",
  description: "LLM Token Usage Dashboard",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Token Tracker",
  },
  icons: {
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#111827",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900">
        <ApiKeyGate>{children}</ApiKeyGate>
      </body>
    </html>
  );
}
