import type { Metadata } from "next";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "ReviewSignal · loomit",
  description:
    "Review intelligence for loomit publishers: sentiment and reasons across Google Play and the App Store.",
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
