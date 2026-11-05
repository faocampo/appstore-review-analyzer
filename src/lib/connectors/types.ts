import type { Review, SourceCoverage } from "@/lib/types";

export interface ConnectorResult {
  reviews: Review[];
  coverage: SourceCoverage;
}
