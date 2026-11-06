import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import { SYSTEM, withScope, type Pool } from "@/server/db/pool";

/**
 * Per-tenant credential storage. Callers only ever hold a `ref`; the secret
 * value is read at use time and never returned by the API.
 */
export interface SecretStore {
  put(tenantId: string, ref: string, value: Record<string, unknown>): Promise<void>;
  get(tenantId: string, ref: string): Promise<Record<string, unknown> | null>;
  delete(tenantId: string, ref: string): Promise<void>;
}

export function secretRef(tenantId: string, appId: string, store: string): string {
  return `tenant/${tenantId}/app/${appId}/${store}`;
}

/** AES-256-GCM in Postgres. For local and staging only (config forbids it in production). */
export class DatabaseSecretStore implements SecretStore {
  private readonly key: Buffer;

  constructor(
    private readonly pool: Pool,
    base64Key: string,
  ) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes");
  }

  async put(tenantId: string, ref: string, value: Record<string, unknown>): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(ref));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    await withScope(this.pool, { tenantId }, (client) =>
      client.query(
        `insert into secret (ref, tenant_id, ciphertext, iv, auth_tag)
         values ($1, $2, $3, $4, $5)
         on conflict (ref) do update set ciphertext = excluded.ciphertext, iv = excluded.iv,
           auth_tag = excluded.auth_tag, updated_at = now()`,
        [ref, tenantId, ciphertext, iv, cipher.getAuthTag()],
      ),
    );
  }

  async get(tenantId: string, ref: string): Promise<Record<string, unknown> | null> {
    const { rows } = await withScope(this.pool, { tenantId }, (client) =>
      client.query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
        "select ciphertext, iv, auth_tag from secret where ref = $1",
        [ref],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv);
    decipher.setAAD(Buffer.from(ref));
    decipher.setAuthTag(row.auth_tag);
    const plain = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
  }

  async delete(tenantId: string, ref: string): Promise<void> {
    await withScope(this.pool, { tenantId }, (client) =>
      client.query("delete from secret where ref = $1", [ref]),
    );
  }

  /** Removes every secret of a tenant (offboarding). */
  async purgeTenant(tenantId: string): Promise<void> {
    await withScope(this.pool, SYSTEM, (client) =>
      client.query("delete from secret where tenant_id = $1", [tenantId]),
    );
  }
}

/** AWS Secrets Manager, KMS-encrypted. Names are `<prefix><ref>`. */
export class AwsSecretStore implements SecretStore {
  constructor(
    private readonly client: Pick<SecretsManagerClient, "send">,
    private readonly prefix: string,
  ) {}

  private name(ref: string, tenantId: string): string {
    // Defence in depth: a tenant can only ever address its own secrets.
    if (!ref.startsWith(`tenant/${tenantId}/`)) throw new Error("secret ref does not belong to the tenant");
    return `${this.prefix}${ref}`;
  }

  async put(tenantId: string, ref: string, value: Record<string, unknown>): Promise<void> {
    const SecretString = JSON.stringify(value);
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: this.name(ref, tenantId), SecretString }));
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
      await this.client.send(
        new CreateSecretCommand({
          Name: this.name(ref, tenantId),
          SecretString,
          Tags: [
            { Key: "app", Value: "reviewsignal" },
            { Key: "tenant", Value: tenantId },
          ],
        }),
      );
    }
  }

  async get(tenantId: string, ref: string): Promise<Record<string, unknown> | null> {
    const name = this.name(ref, tenantId);
    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return result.SecretString ? (JSON.parse(result.SecretString) as Record<string, unknown>) : null;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }

  async delete(tenantId: string, ref: string): Promise<void> {
    const name = this.name(ref, tenantId);
    try {
      await this.client.send(
        new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
      );
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
  }
}

export function createSecretStore(
  config: { SECRET_STORE: "aws" | "database"; SECRETS_ENCRYPTION_KEY?: string; SECRETS_PREFIX: string; AWS_REGION?: string },
  pool: Pool,
): SecretStore {
  if (config.SECRET_STORE === "aws") {
    return new AwsSecretStore(new SecretsManagerClient({ region: config.AWS_REGION }), config.SECRETS_PREFIX);
  }
  return new DatabaseSecretStore(pool, config.SECRETS_ENCRYPTION_KEY ?? "");
}
