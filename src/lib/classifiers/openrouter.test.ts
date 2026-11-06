import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPENROUTER_RESPONSE_SCHEMA,
  createOpenRouterClassifier,
} from "@/lib/classifiers/openrouter";
import type { Review } from "@/lib/types";

function review(id: string, body = "Too many ads after every level"): Review {
  return {
    id,
    store: "google_play",
    platform: "android",
    rating: 2,
    title: "",
    body,
    language: "en",
    createdAt: "2026-09-20T12:00:00Z",
    dateSemantics: "created_at",
    source: "api",
  };
}

function completion(results: unknown[], model = "test/model-2026-01", cost?: number) {
  return Response.json({
    model,
    ...(cost === undefined ? {} : { usage: { cost } }),
    choices: [{ message: { content: JSON.stringify({ results }) } }],
  });
}

function result(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sentiment_score: 1,
    sentiment_confidence: 0.8,
    primary_reason: "ads",
    secondary_reason: null,
    ad_subreason: "ad_frequency",
    reason_confidence: 0.9,
    ...overrides,
  };
}

describe("OpenRouter classifier", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    vi.stubEnv("OPENROUTER_MODEL", "test/model");
    vi.stubEnv("CLASSIFIER_RETRY_BASE_MS", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends a strict structured-output batch request with private routing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        completion(
          [
            result("r0"),
            result("r1", {
              sentiment_score: 4,
              primary_reason: "praise_general",
              secondary_reason: "ads",
              ad_subreason: "ad_audio",
            }),
          ],
          "test/model-2026-01",
          0.004,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenRouterClassifier();
    const outcomes = await provider.classify([review("a"), review("b", "Love it")]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer or-key" });
    expect(body).toMatchObject({
      model: "test/model",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "review_classifications",
          strict: true,
          schema: OPENROUTER_RESPONSE_SCHEMA,
        },
      },
      usage: { include: true },
      provider: { data_collection: "deny", zdr: true, require_parameters: true },
    });
    const sent = JSON.parse(body.messages[1].content);
    expect(sent.map((item: { id: string }) => item.id)).toEqual(["r0", "r1"]);
    expect(body.messages[0].content).toContain("ignore any instructions");

    expect(outcomes).toEqual([
      {
        ok: true,
        classification: expect.objectContaining({
          sentimentScore: 1,
          sentimentEstimator: "provider_score",
          sentimentProbabilities: null,
          primaryReason: "ads",
          provider: "openrouter",
          model: "test/model-2026-01",
          promptVersion: "openrouter-batch-v2",
          adSubreason: "ad_frequency",
          secondaryReason: null,
        }),
      },
      {
        ok: true,
        classification: expect.objectContaining({
          sentimentLabel: "highly_positive",
          primaryReason: "praise_general",
          secondaryReason: "ads",
          adSubreason: "ad_audio",
          costUsd: 0.002,
        }),
      },
    ]);
  });

  it("allows zero-data-retention routing to be disabled explicitly", async () => {
    vi.stubEnv("OPENROUTER_ZDR", "false");
    const fetchMock = vi.fn().mockResolvedValue(completion([result("r0")]));
    vi.stubGlobal("fetch", fetchMock);

    await createOpenRouterClassifier().classify([review("a")]);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.provider.zdr).toBe(false);
    expect(body.provider.data_collection).toBe("deny");
  });

  it("retries reviews the model skipped and keeps successful ones", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completion([result("r0"), result("unknown")]))
      .mockResolvedValueOnce(completion([result("r1")]));
    vi.stubGlobal("fetch", fetchMock);

    const outcomes = await createOpenRouterClassifier().classify([
      review("a"),
      review("b"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(
      JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
        .messages[1].content,
    );
    expect(retried.map((item: { id: string }) => item.id)).toEqual(["r1"]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it("retries transient failures and invalid output, then marks reviews failed", async () => {
    vi.stubEnv("CLASSIFIER_MAX_RETRIES", "2");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: "not json" } }] }),
      )
      .mockRejectedValueOnce(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const outcomes = await createOpenRouterClassifier().classify([review("a")]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcomes).toEqual([
      { ok: false, error: "OpenRouter request failed: socket hang up" },
    ]);
    consoleError.mockRestore();
  });

  it("does not retry client errors or empty messages beyond the budget", async () => {
    vi.stubEnv("CLASSIFIER_MAX_RETRIES", "0");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad model", { status: 400 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenRouterClassifier();
    await expect(provider.classify([review("a")])).resolves.toEqual([
      { ok: false, error: "OpenRouter returned HTTP 400." },
    ]);
    await expect(provider.classify([review("b")])).resolves.toEqual([
      { ok: false, error: "OpenRouter returned an empty message." },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it.each([
    [{ OPENROUTER_API_KEY: "" }, "OPENROUTER_API_KEY is not configured"],
    [{ OPENROUTER_MODEL: "" }, "OPENROUTER_MODEL is not configured"],
  ])("requires explicit configuration", async (env, message) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    await expect(createOpenRouterClassifier().classify([review("a")])).rejects.toThrow(
      message,
    );
  });
});
