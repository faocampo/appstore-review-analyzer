import { randomBytes } from "node:crypto";

import { exportPKCS8, generateKeyPair } from "jose";

import { SYSTEM, withScope, type Pool } from "@/server/db/pool";
import { upsertApp, upsertConnection } from "@/server/repo/apps";
import { ensureTenant } from "@/server/repo/tenants";
import { DatabaseSecretStore, secretRef } from "@/server/secrets/store";

export function testSecretStore(pool: Pool): DatabaseSecretStore {
  return new DatabaseSecretStore(pool, randomBytes(32).toString("base64"));
}

/** Creates a tenant, an app with both stores, and Apple + Google connections with stored credentials. */
export async function seedConnectedApp(
  pool: Pool,
  secrets: DatabaseSecretStore,
  publisher = `publisher-${randomBytes(3).toString("hex")}`,
) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return withScope(pool, SYSTEM, async (client) => {
    const tenant = await ensureTenant(client, publisher, `${publisher} Inc.`);
    const app = await upsertApp(client, tenant.id, {
      loomitAppId: `${publisher}-app`,
      name: "Puzzle Quest",
      androidPackage: "com.example.puzzle",
      appleAppId: "123456789",
    });
    const appleRef = secretRef(tenant.id, app.id, "apple_app_store");
    const googleRef = secretRef(tenant.id, app.id, "google_play");
    const apple = await upsertConnection(client, { tenantId: tenant.id, appId: app.id, store: "apple_app_store", secretRef: appleRef });
    const google = await upsertConnection(client, { tenantId: tenant.id, appId: app.id, store: "google_play", secretRef: googleRef });
    return { tenant, app, apple, google, appleRef, googleRef, applePrivateKey: await exportPKCS8(privateKey) };
  }).then(async (seed) => {
    await secrets.put(seed.tenant.id, seed.appleRef, {
      issuerId: "issuer-00000000",
      keyId: "KEY1234567",
      privateKey: seed.applePrivateKey,
    });
    await secrets.put(seed.tenant.id, seed.googleRef, {
      serviceAccountJson: JSON.stringify({ type: "service_account", client_email: "x@y.iam.gserviceaccount.com" }),
    });
    return seed;
  });
}

export function appleReviewPayload(
  reviews: Array<{ id: string; createdDate: string; rating?: number; body?: string; title?: string; territory?: string }>,
  next: string | null = null,
) {
  return {
    data: reviews.map((review) => ({
      id: review.id,
      attributes: {
        rating: review.rating ?? 2,
        title: review.title ?? "",
        body: review.body ?? "Too many ads after every level",
        createdDate: review.createdDate,
        territory: review.territory ?? "USA",
      },
    })),
    links: { next },
  };
}
