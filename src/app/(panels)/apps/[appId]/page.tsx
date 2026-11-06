import type { Metadata } from "next";
import type { ReactElement } from "react";

import { EvolutionPanel } from "@/app/_components/evolution/EvolutionPanel";
import { isFixtureMode } from "@/app/_lib/api-client";
import { utcToday } from "@/app/_lib/dates";

export const metadata: Metadata = {
  title: "Review evolution · ReviewSignal",
};

export default async function AppEvolutionPage({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const { appId } = await params;
  const fixture = isFixtureMode(await searchParams);
  return <EvolutionPanel key={appId} appId={appId} fixture={fixture} today={utcToday()} />;
}
