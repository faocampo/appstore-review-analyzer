import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { authorizeRequest, checkRateLimit, clientKey } from "@/lib/access";
import { analyzeReviews } from "@/lib/analyze";
import { PublicError } from "@/lib/errors";
import { analyzeInputSchema } from "@/lib/schema";

export const runtime = "nodejs";

const GENERIC_ERROR = "The analysis could not be completed.";

export async function POST(request: Request): Promise<NextResponse> {
  const access = authorizeRequest(request);
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const rate = checkRateLimit(clientKey(request));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many analysis requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  try {
    const input = analyzeInputSchema.parse(await request.json());
    const result = await analyzeReviews(input);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: "Invalid analysis request.",
          details: error.issues.map((issue) => issue.message),
        },
        { status: 400 },
      );
    }

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "The request body must be valid JSON." },
        { status: 400 },
      );
    }

    if (error instanceof PublicError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error("[reviewsignal] analysis failed", error);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
