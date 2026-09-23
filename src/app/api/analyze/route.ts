import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { analyzeReviews } from "@/lib/analyze";
import { analyzeInputSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
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

    const message =
      error instanceof Error ? error.message : "The analysis could not be completed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
