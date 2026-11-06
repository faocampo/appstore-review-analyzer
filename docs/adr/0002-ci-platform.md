# ADR 0002: CI platform (GitHub Actions or GitLab CI)

- **Status:** Proposed
- **Date:** 2026-11-06
- **Deciders:** Loomit platform lead, ReviewSignal developer, engineering manager
- **Related:** productization plan §3.6, §9 item 2; [security review §4](../operations/security-review.md#4-dependency-and-supply-chain-scanning)

## Context

The repository is on GitHub. CI runs on GitHub Actions
(`.github/workflows/ci.yml`: token freshness, lint, typecheck, tests with a
90% coverage gate, build; `codeql.yml`: CodeQL). The rest of Loomit lives on
GitLab with GitLab CI. Deployment is Argo CD on EKS, reading Helm values from
Git; images go to Amazon ECR.

Whatever the platform, the pipeline must do:

1. lint, typecheck, unit tests with the coverage gate, `next build`, `build:server`;
2. `docker build` (Dockerfile at the root), image scan, SBOM, push to ECR with
   an immutable git-SHA tag;
3. `helm lint`/`helm template` for both overlays plus schema validation
   (kubeconform), `promtool check rules`, `deploy/scripts/sync-alerts.sh --check`;
4. dependency audit, SAST, secret scanning;
5. update the staging image tag (commit to `values-staging.yaml` or Argo CD
   Image Updater); production promotion by merge request or pull request.

## Options

### A. Stay on GitHub Actions

- **Pros.** Already working; CodeQL and Dependabot built in; no migration
  work; AWS access through GitHub OIDC federation (no long-lived keys).
- **Cons.** A separate platform from the rest of Loomit: separate access
  management, audit, runners and on-call knowledge; Argo CD and ECR
  integration set up once just for this repository; code review and issues
  away from the Loomit teams that review the integration (Kotlin backend,
  frontend).

### B. Move to GitLab CI with the rest of Loomit

- **Pros.** One platform for Loomit teams; shared runners, templates
  (image build, scan, Helm checks, Argo CD promotion) and AWS credentials
  that platform already maintains; reviews from Loomit engineers happen
  where they work; compliance and audit in one place.
- **Cons.** Migration work (about 1–2 days: pipeline port, CodeQL replaced by
  GitLab SAST or a CodeQL job, Dependabot replaced by Renovate or GitLab
  dependency scanning); history and open pull requests move; the repository
  URL in the Argo CD Applications changes.

## Recommendation

**Option B, move to GitLab before M3 goes to production**, provided the
Loomit platform team confirms its shared pipeline templates cover image
build, ECR push, scanning and Argo CD promotion. Production deployment is the
point where platform consistency matters most (access, audit, incident
response), and the migration cost is small while the pipeline is still
short. Until then, keep GitHub Actions and extend it with the image build and
deploy checks so the pipeline is complete on either side.

If the platform team prefers GitHub for new services, stay on option A and
add GitHub OIDC to AWS for ECR pushes.

## Consequences

- If B: port `ci.yml`, replace CodeQL and Dependabot with GitLab equivalents,
  update `deploy/argocd/application.yaml` (`repoURL`), the runbook links in
  `deploy/prometheus/alerts.yaml` (`runbook_url`) and the chart `home`/`sources`.
- If A: add OIDC trust for GitHub in the X3M AWS account, and give Loomit
  reviewers access to the repository.
- Either way, CI gains the image, Helm and rules checks listed above before GA.
