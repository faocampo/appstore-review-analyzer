/**
 * Mints a local HS256 token for AUTH_MODE=dev.
 * Usage: npx tsx scripts/dev-token.ts --publisher pub-demo [--role publisher|service|x3m_admin] [--hours 8]
 */
import { parseArgs } from "node:util";

import { SignJWT } from "jose";

const { values } = parseArgs({
  options: {
    publisher: { type: "string" },
    role: { type: "string", default: "publisher" },
    hours: { type: "string", default: "8" },
    sub: { type: "string", default: "dev-user" },
  },
});

const secret = process.env.DEV_JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error("Set DEV_JWT_SECRET (at least 32 characters) to the API's value.");
  process.exit(2);
}

const token = await new SignJWT({
  ...(values.publisher ? { loomit_publisher_id: values.publisher } : {}),
  roles: [values.role],
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuer("reviewsignal-dev")
  .setAudience("reviewsignal")
  .setSubject(values.sub ?? "dev-user")
  .setIssuedAt()
  .setExpirationTime(`${Number(values.hours)}h`)
  .sign(new TextEncoder().encode(secret));

console.log(token);
