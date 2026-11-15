# ADR 0020: CI cost rule: e2e on pull requests only, images only for public repositories

- Status: proposed (added in the consistency-pass review, 16 Nov 2026)
- Date: 16 Nov 2026
- Covers: PLAN "CI", "CD"; B-86; conventions §9 (adds a project-level trigger rule on top of it)

## Context

The repository is private until Marina makes it public herself. Private repositories pay for GitHub Actions minutes
and GHCR storage. The heaviest CI job is `e2e`: it builds both production images, starts the isolated compose
project and runs Playwright on three projects. Running it again on the push to `main` after a squash-merge repeats
the run the PR already passed. `release.yml` pushes two images (with provenance and SBOM) to GHCR after every green
CI run on `main`. Nobody pulls them while the repository is private and there is no deploy target. The deploy job is
already disabled by `vars.DEPLOY_ENABLED` (PLAN "CD").

## Decision

Marina decided this cost rule:

1. **`ci.yml` job `e2e` runs on `pull_request` only**:
   `if: github.event_name == 'pull_request'`. On `push` to `main` and on `workflow_dispatch` it is skipped. A
   workflow run with skipped jobs still concludes `success`, so `release.yml` still triggers. All other CI jobs
   (`lint` incl. schema drift, `typecheck`, `unit`, `integration`, `build`, `dev-setup-smoke`, `gitleaks`) keep the
   template triggers (`pull_request`, `push` to `main`, `workflow_dispatch`).
2. **`release.yml` job `images` runs only when the repository is public**:

   ```yaml
   if: >-
     github.event.repository.private == false &&
     ((github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
      (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'))
   ```

   `repository` is a required top-level property of both the `workflow_run` and the `workflow_dispatch` webhook
   payloads (octokit webhook schemas, checked 16 Nov 2026), so the expression never evaluates against a missing
   object.
3. **`deploy` is gated by both rules**: `needs: images` and
   `if: github.event.repository.private == false && vars.DEPLOY_ENABLED == 'true'` plus the `production`
   environment.
4. **The released commit is the CI commit**, not the branch head when the workflow starts. Set
   `RELEASE_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}` once at workflow level. Use it for
   `actions/checkout` `ref`, for the tags (`type=raw,value=sha-${{ env.RELEASE_SHA }}` and `type=raw,value=latest`)
   and for the OCI `org.opencontainers.image.revision` label (a metadata-action `labels:` override). Also use it for
   the deploy job's `IMAGE_TAG`. Do not use the template's `type=sha` and `IMAGE_TAG: sha-${{ github.sha }}`
   lines: in a `workflow_run` workflow, `github.sha` is the head of `main` when the workflow starts, which can be a
   newer commit than the one CI tested. `workflow_dispatch` is allowed only on `main` (`latest` would otherwise point
   at a branch build), which is the `github.ref` clause in item 2.

## Alternatives

- **e2e on every event**: about twice the e2e minutes for no new information. The squash-merge commit has the same
  tree as the PR merge ref that `pull_request` tested, as long as `main` did not move in between. With one PR per
  phase and sequential phases, `main` does not move. Rejected.
- **Nightly e2e on `main`** instead of per PR: the quality gate needs the e2e result **on the PR**
  (`gh pr checks --watch`). Rejected.
- **Build images on `main` but do not push them** while private: the PR's e2e job already builds both Dockerfiles
  from the same tree, so a second build proves nothing. Rejected.
- **Delete `release.yml` until the repository is public**: PLAN requires the CD workflow to exist (prepared, not
  active). The visibility gate makes it a no-op without deleting it. Rejected.

## Consequences

- While the repository is private, every run of `release.yml` shows the `images` and `deploy` jobs as **skipped**.
  The scaffold's "Done when" (BUILD-ORDER 1a.3) checks this instead of "images pushed". The PR's e2e job is the proof
  that both production Dockerfiles build.
- After Marina makes the repository public, the next green CI run on `main` publishes images. To publish at once,
  start the workflow by hand on `main` (`gh workflow run release.yml --ref main`). This is part of the hand-over note
  in the Presentation phase, not an autonomous step.
- `pnpm verify` still runs `test:e2e` locally at every quality gate, so local runs do not change.
- A deployment from the private repository is impossible by design. Deploying before the repository is public needs
  a new ADR that supersedes item 3. That is a deliberate stop, not a missing feature.
- Dependabot PRs (weekly, grouped) also run e2e. That is intended, because dependency updates are what e2e must
  catch. They are the main recurring cost.
- The rule is not yet in `project-scaffold/references/conventions.md` §9. Petition and social-network need the same
  lines (flagged for Marina; this ADR does not change the shared file).
