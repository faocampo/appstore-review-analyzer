import type { Metadata } from "next";
import type { ReactElement } from "react";

import { GuardrailReadout } from "@/app/_components/guardrails/GuardrailReadout";
import { isFixtureMode } from "@/app/_lib/api-client";

export const metadata: Metadata = {
  title: "Guardrail readout · ReviewSignal",
};

export default async function ExperimentGuardrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ experimentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const { experimentId } = await params;
  const fixture = isFixtureMode(await searchParams);
  return <GuardrailReadout key={experimentId} experimentId={experimentId} fixture={fixture} />;
}
