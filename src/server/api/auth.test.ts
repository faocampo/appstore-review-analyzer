import { describe, expect, it } from "vitest";

import { actingPublisher, authenticate, type Principal } from "@/server/api/auth";
import { linkExperimentSchema, rangeQuerySchema, createAppSchema } from "@/server/api/contracts";

const claims = { tenant: "loomit_publisher_id", roles: "roles" };
const verifyWith = (payload: Record<string, unknown>) => async () => payload;

describe("authenticate", () => {
  it("parses roles from arrays or strings and defaults publisher tokens", async () => {
    await expect(authenticate("Bearer t", verifyWith({ sub: "s", roles: "service x3m_admin" }), claims)).resolves.toMatchObject({
      roles: new Set(["service", "x3m_admin"]),
    });
    const publisher = await authenticate("bearer t", verifyWith({ loomit_publisher_id: "p1" }), claims);
    expect(publisher).toMatchObject({ subject: "unknown", publisherId: "p1", roles: new Set(["publisher"]), publisherName: null });
    await expect(authenticate(undefined, verifyWith({}), claims)).rejects.toThrow("A bearer token is required.");
    await expect(authenticate("Bearer t", verifyWith({ roles: 42 }), claims)).rejects.toThrow("grants no ReviewSignal role");
  });

  it("resolves the acting publisher per role", () => {
    const principal = (roles: string[], publisherId: string | null = null) =>
      ({ subject: "s", roles: new Set(roles), publisherId, publisherName: null }) as Principal;
    expect(actingPublisher(principal(["service"]), " pub-x ")).toBe("pub-x");
    expect(actingPublisher(principal(["x3m_admin"], "own"), undefined)).toBe("own");
    expect(actingPublisher(principal(["publisher"], "p"), "ignored")).toBe("p");
    expect(() => actingPublisher(principal(["publisher"]), undefined)).toThrow("The token has no publisher.");
  });
});

describe("contracts", () => {
  const base = { loomitAppId: "a", name: "n", startAt: "2026-11-01T00:00:00Z" };

  it("validates attribution requirements", () => {
    const dimension = linkExperimentSchema.safeParse({ ...base, attributionMode: "dimension", arms: [{ key: "t", role: "test" }] });
    expect(dimension.success).toBe(false);
    expect(dimension.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "dimension is required for dimension attribution",
        "dimension attribution needs a test and a control arm",
        "every arm needs dimension values",
      ]),
    );
    const prePost = linkExperimentSchema.safeParse({ ...base, attributionMode: "pre_post", arms: [{ key: "t", role: "test" }] });
    expect(prePost.error?.issues[0].message).toBe("pre_post attribution needs a baseline window");
    expect(rangeQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success).toBe(false);
    expect(createAppSchema.safeParse({ loomitAppId: "a", name: "n" }).error?.issues[0].message).toBe("Provide an Android package or an Apple ID.");
  });
});
