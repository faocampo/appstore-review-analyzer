# ADR 0001: Embedding ReviewSignal in the Loomit console

- **Status:** Proposed
- **Date:** 2026-11-06
- **Deciders:** Product owner, Loomit frontend lead, ReviewSignal developer, Loomit platform engineer
- **Related:** productization plan §2 (Fastify decision), §3.7, §9 item 1; [ADR 0006](0006-row-level-security.md)

## Context

Publishers will see ReviewSignal inside the Loomit console (Phantom): the
evolution panel per app, the guardrail panel in the experiment readout,
onboarding (store connections) and an X3M admin view. The service exposes an
OpenAPI v1 API (`reviewsignal-api`, Fastify) that authenticates the Loomit
OIDC JWT. The Next.js app in this repository is a dev/demo harness that
renders the same panels standalone and calls the API at `NEXT_PUBLIC_API_URL`.

The plan's default is a React package that uses the console's components and
tokens, but it depends on how the console can host third-party UI. That is
not known yet.

Constraints:

- One full-time developer, about 1.5 weeks of Loomit frontend time in M3.
- The UI must follow the Loomit design system (Calm Glass) and look native.
- Tenant scope comes from the Loomit token; the plugin must not run its own login.
- The panels must work standalone for development, demos and screenshots.

## Options

### A. Micro-frontend: a React package rendered by the console

ReviewSignal publishes a package (for example `@loomit/reviewsignal-ui`)
with panel components. The console mounts them in its routes and passes an
access-token provider and context (publisher, app, experiment). The
components call the ReviewSignal API directly (CORS limited to the console
origin) or through the console gateway.

Variants: a build-time dependency (npm package, the console redeploys to take
a new version) or runtime loading (Module Federation or import maps, so
ReviewSignal can deploy the UI independently).

- **Pros.** Native look and feel; shares the console's components, tokens,
  routing, i18n and auth session; no second login; accessibility and
  responsiveness follow the console; the design review in M3 is simpler.
- **Cons.** Couples to the console's React version and build toolchain;
  build-time variant ties ReviewSignal UI releases to console releases;
  runtime federation needs shared-dependency management and a CDN or asset
  route; a ReviewSignal UI bug runs in the console's page (blast radius).

### B. Iframe with SSO

The console embeds the ReviewSignal web app (`next start`) in an iframe per
panel. Authentication either by passing a short-lived token through
`postMessage` from the console to the frame, or by the frame performing its
own OIDC redirect against the Loomit identity provider (silent SSO).

- **Pros.** Strong isolation (separate origin, CSP, crash containment);
  independent deploys; no dependency on the console's stack; the existing
  Next harness already renders the panels.
- **Cons.** Looks and behaves less native (scrolling, sizing, modals, focus,
  deep links, browser history); duplicated design-system implementation;
  third-party-cookie restrictions can break silent SSO, so `postMessage`
  token passing is likely required and must be designed carefully (origin
  checks, token lifetime); the web app must be deployed and operated (the
  Helm chart does not deploy it today); performance cost of a second app
  boot per panel.

## Recommendation

**Option A, build-time React package**, unless the Loomit frontend team
answers the open questions below in a way that rules it out. It matches the
plan default and the design-system requirement, and avoids operating a second
web app and an SSO flow with one developer. Move to runtime federation later
only if release coupling becomes a measured problem.

**Fallback:** option B with `postMessage` token passing, if the console
cannot take a package (incompatible React major version, no plugin routes)
in the M3 window. In that case the Helm chart gains a `web` Deployment,
`frame-ancestors` CSP and a gateway route.

In both options the API contract stays the same: OIDC JWT, tenant from the
token, CORS limited to console origins.

## Open questions for the Loomit frontend team

1. Which React and bundler versions does the console use, and does it already
   load plugins or third-party packages? Is Module Federation in use?
2. Does the console expose its design-system components (cards, charts,
   tables, pills) to plugins, or should ReviewSignal ship its own
   token-based implementation (plan §9 item 7)?
3. How can an embedded component obtain the user's access token (a token
   provider hook, a fetch wrapper, cookies at the gateway)? Can it request a
   token with the ReviewSignal audience?
4. Will the browser call the ReviewSignal API directly (CORS) or through the
   console gateway under the console's origin?
5. What are the console's CSP, routing and release cadence, and how are
   plugin versions pinned and rolled back?
6. Where do the experiment readout and the app pages live in the console, and
   which context (publisher id, Loomit app id, experiment id) is available there?

## Consequences

- If A: the repository publishes a UI package (new build target and CI step);
  the Next app remains a harness; the chart stays API + worker only.
- If B: the chart adds a `web` Deployment with its own probes and Istio
  policy; security review adds iframe and `postMessage` checks.
- Either way, the M3 frontend estimate (about 1.5 weeks) must be re-checked
  once the answers are in.
