import type { Metadata } from "next";
import type { ReactElement } from "react";

import { ConnectFlow } from "@/app/_components/connect/ConnectFlow";
import { isFixtureMode } from "@/app/_lib/api-client";

export const metadata: Metadata = {
  title: "Connect stores · ReviewSignal",
};

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const query = await searchParams;
  const appId = typeof query.appId === "string" && query.appId ? query.appId : null;
  return <ConnectFlow fixture={isFixtureMode(query)} initialAppId={appId} />;
}
