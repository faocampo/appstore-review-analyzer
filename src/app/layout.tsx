import type { Metadata } from "next";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "ReviewSignal — App Review Intelligence",
  description:
    "Cross-platform sentiment analysis for owned Google Play and App Store apps.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
