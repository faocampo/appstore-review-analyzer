import type { ReactElement, ReactNode } from "react";

import "./panels.css";

/** Shared shell for the publisher panels (evolution, guardrails, onboarding). */
export default function PanelsLayout({ children }: Readonly<{ children: ReactNode }>): ReactElement {
  return <div className="app-shell panels">{children}</div>;
}
