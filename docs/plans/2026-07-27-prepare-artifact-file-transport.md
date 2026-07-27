# Prepare Artifact File Transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop the `review / prepare` job from failing with "Job outputs exceed 1,048,576 bytes" by moving the `PrepareArtifact` payload off GitHub Actions job outputs and onto a file transported via `actions/upload-artifact`/`actions/download-artifact`, and clear the Node 20 deprecation warning on the action runtime.

**Architecture:** `prepare.ts` currently serializes the full `PrepareArtifact` (up to ~4MB+ of diff hunks and embedded context file contents) into `core.setOutput('prepare_artifact', ...)`, which `reusable-pr-review.yml` forwards cross-job via `needs.prepare.outputs.prepare_artifact`. GitHub Actions caps total job outputs at 1MB — this is the exact root cause of the reported failure, not a "content too large, truncate it" problem (analyze needs the full artifact to review correctly). The fix: `prepare` writes the artifact JSON to a file on disk instead of a job output; the workflow uploads that file as a run-scoped artifact; `analyze`'s job downloads it and reads the file directly. `stale`/`incomplete` remain tiny job outputs (booleans) since they're nowhere near the limit. This does not require expanding `analyze`'s `permissions: {}` — `actions/download-artifact` uses the internal Actions Runtime token, not the job's `GITHUB_TOKEN`/`permissions:` scope (see `docs/AGENTS.md` rule 3, which only forbids GitHub REST API access).

**Tech Stack:** TypeScript (`@actions/core`, `node:fs`), Vitest, GitHub Actions composite/reusable workflows (`actions/upload-artifact@v4`, `actions/download-artifact@v4`), esbuild bundling into `action/dist/index.js`.

---

## Repo conventions you need to know before starting

- `action/dist/index.js` is a **committed, pre-built bundle** — GitHub Actions runs `dist/index.js` directly (`action/action.yml` → `runs.main`). Any change to `action/src/**` requires `cd action && npm run build` before committing, or the workflow will run stale code.
- `action/action.yml`'s `inputs`/`outputs` are the action's public contract. This repo owns both the action and its only real caller (`.github/workflows/reusable-pr-review.yml`), so contract changes are safe as long as both are updated in the same commit.
- Workflow files pin the action by commit SHA (`dustPyrotechnic/pr-review-swarm/action@<sha>`), never by branch/tag. This repo's convention (see `git log --oneline`) is: one commit with the actual fix + rebuilt `dist/`, followed by a second `chore: re-pin action reference to <description> commit` commit that updates **every** `uses: dustPyrotechnic/pr-review-swarm/action@...` line (there are 6 across `reusable-pr-review.yml` and `reusable-pr-review-watchdog.yml`) plus `cli/VERSION` to the fix commit's own SHA. You won't know the fix commit's SHA until after you make it — that's why it's always two commits, never one.
- `docs/AGENTS.md` lists hard-ban rules referencing `docs/plans/2026-07-13-pr-review-swarm-design.md`. Rule 3 ("禁止让 analyze Job 获得任何可写 GitHub 凭据或 `contents: read`") and rule 6 ("禁止绕开 permissions: {} 去临时扩大某个 Job 的权限") are the ones this change brushes up against. Neither is violated: no new `permissions:` entries are added anywhere in this plan.

---

## Task 1: Add a testable file-write helper to `prepare.ts`

**Files:**
- Modify: `action/src/entrypoints/prepare.ts`
- Test: `action/src/entrypoints/prepare.test.ts`

**Step 1: Write the failing test**

Add to `action/src/entrypoints/prepare.test.ts` (new `describe` block, alongside the existing `buildPrepareArtifact` block — add these imports at the top of the file next to the existing ones):

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePrepareArtifactToFile } from './prepare.js';
```

```ts
describe('writePrepareArtifactToFile', () => {
  it('writes the artifact as JSON to the given path, byte-for-byte round-trippable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prepare-artifact-'));
    const filePath = path.join(dir, 'prepare-artifact.json');
    const artifact = {
      identity_tuple: {
        head_repo: 'octo/head-repo',
        head_sha: 'headsha123',
        base_repo: 'octo/repo',
        base_ref: 'main',
        base_sha: 'basesha456',
        merge_base_sha: 'mergebasesha789',
      },
      shards: [],
      coverage_manifest: {
        files: [],
        shards_complete: true,
        hard_limit_hit: false,
        pulls_files_pagination_truncated: false,
        missing_patch_files: [],
        token_usage: { prompt_tokens: 0, completion_tokens: 0 },
      },
    };

    writePrepareArtifactToFile(artifact, filePath);

    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written).toEqual(artifact);

    rmSync(dir, { recursive: true, force: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd action && npx vitest run src/entrypoints/prepare.test.ts`
Expected: FAIL — `writePrepareArtifactToFile` is not exported from `./prepare.js`.

**Step 3: Write minimal implementation**

In `action/src/entrypoints/prepare.ts`:

1. Add to the top-of-file imports (alongside the existing `import * as core from '@actions/core';` etc.):

```ts
import { writeFileSync } from 'node:fs';
```

2. Add this exported function right after `buildPrepareArtifact` (after its closing brace, before `async function fetchFullFileContent`):

```ts
export function writePrepareArtifactToFile(artifact: PrepareArtifact, filePath: string): void {
  writeFileSync(filePath, JSON.stringify(artifact));
}
```

**Step 4: Run test to verify it passes**

Run: `cd action && npx vitest run src/entrypoints/prepare.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

**Step 5: Commit**

Don't commit yet — Task 2 touches the same `run()` function this helper feeds into. Commit at the end of Task 2 instead.

---

## Task 2: Wire `prepare.ts`'s `run()` to write the file instead of `core.setOutput('prepare_artifact', ...)`

**Files:**
- Modify: `action/src/entrypoints/prepare.ts:293-296` (current `run()` tail)

**Step 1: Change the code**

Current tail of `run()`:

```ts
  core.setOutput('stale', 'false');
  core.setOutput('incomplete', String(incomplete));
  core.setOutput('prepare_artifact', JSON.stringify(artifact));
```

Replace with:

```ts
  const artifactPath = core.getInput('prepare_artifact_path', { required: true });
  writePrepareArtifactToFile(artifact, artifactPath);

  core.setOutput('stale', 'false');
  core.setOutput('incomplete', String(incomplete));
```

Note: this deliberately does **not** set a `prepare_artifact` output anymore — that output is being removed from the action's contract entirely in Task 4. Do not leave a redundant `core.setOutput('prepare_artifact', ...)` call; the whole point is that this data must never touch a job output again, including by accident in some later edit.

**Step 2: There is no new automated test for this exact wiring**

This matches the existing repo convention: `prepare.test.ts` tests the pure `buildPrepareArtifact` function and (after Task 1) the pure `writePrepareArtifactToFile` function, not the `core.getInput`/`run()` glue — there are no existing tests that mock `@actions/core` for `run()` in this codebase, so don't introduce a new pattern for just this change. Verification of the glue happens via the manual re-run in Task 8.

**Step 3: Typecheck**

Run: `cd action && npm run typecheck`
Expected: no errors.

**Step 4: Run full prepare test suite**

Run: `cd action && npx vitest run src/entrypoints/prepare.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add action/src/entrypoints/prepare.ts action/src/entrypoints/prepare.test.ts
git commit -m "$(cat <<'EOF'
fix: write prepare_artifact to a file instead of a job output

Job outputs are capped at 1MB total by GitHub Actions; the artifact
(diff hunks + embedded context file contents across up to 20 shards)
routinely exceeds that once forwarded cross-job via
needs.prepare.outputs.prepare_artifact, causing "Job outputs exceed
1,048,576 bytes" on the prepare job. Job outputs were never the right
transport for a multi-MB payload — write it to disk instead; the
workflow-level artifact upload/download wiring follows in a later
commit alongside the action.yml contract change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add a testable file-read helper to `analyze.ts` and wire `run()` to it

**Files:**
- Modify: `action/src/entrypoints/analyze.ts`
- Test: `action/src/entrypoints/analyze.test.ts`

**Step 1: Write the failing test**

Add to `action/src/entrypoints/analyze.test.ts`. It already imports `readFileSync` and `path`/`fileURLToPath` at the top — reuse those, add `mkdtempSync`/`rmSync`/`writeFileSync` and `tmpdir`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
```

(merge with the existing `import { readFileSync } from 'node:fs';` line rather than duplicating it)

Add a new `describe` block:

```ts
describe('readPrepareArtifactFromFile', () => {
  it('reads and parses the artifact JSON written to the given path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prepare-artifact-'));
    const filePath = path.join(dir, 'prepare-artifact.json');
    const artifact = makeArtifact();
    writeFileSync(filePath, JSON.stringify(artifact));

    const result = readPrepareArtifactFromFile(filePath);

    expect(result).toEqual(artifact);

    rmSync(dir, { recursive: true, force: true });
  });
});
```

Add `readPrepareArtifactFromFile` to the existing `import { runAnalysis } from './analyze.js';` line (making it `import { runAnalysis, readPrepareArtifactFromFile } from './analyze.js';`).

**Step 2: Run test to verify it fails**

Run: `cd action && npx vitest run src/entrypoints/analyze.test.ts`
Expected: FAIL — `readPrepareArtifactFromFile` is not exported from `./analyze.js`.

**Step 3: Write minimal implementation**

In `action/src/entrypoints/analyze.ts`:

1. Add to the top-of-file imports:

```ts
import { readFileSync } from 'node:fs';
```

2. Add this exported function near the top of the file, after the existing type imports and before `AGENT_NAMES` (or any convenient top-level spot before `run()`):

```ts
export function readPrepareArtifactFromFile(filePath: string): PrepareArtifact {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as PrepareArtifact;
}
```

3. In `run()`, replace:

```ts
  const prepareArtifactRaw = core.getInput('prepare_artifact', { required: true });
  const prepareArtifact = JSON.parse(prepareArtifactRaw) as PrepareArtifact;
```

with:

```ts
  const prepareArtifactPath = core.getInput('prepare_artifact_path', { required: true });
  const prepareArtifact = readPrepareArtifactFromFile(prepareArtifactPath);
```

**Step 4: Run test to verify it passes**

Run: `cd action && npx vitest run src/entrypoints/analyze.test.ts`
Expected: PASS (all tests, including the pre-existing "does not import @actions/github" guard — adding `node:fs` does not trip it, since that guard only checks for `@actions/github`/`getOctokit`).

**Step 5: Typecheck**

Run: `cd action && npm run typecheck`
Expected: no errors.

**Step 6: Commit**

```bash
git add action/src/entrypoints/analyze.ts action/src/entrypoints/analyze.test.ts
git commit -m "$(cat <<'EOF'
fix: read prepare_artifact from a file instead of an action input string

Companion to the prepare.ts change: analyze now reads the artifact
that prepare wrote to disk, rather than expecting it inlined as a
JSON string input (which is what was forcing it through the
job-output size limit one level up, in the caller workflow).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update `action/action.yml`'s public contract

**Files:**
- Modify: `action/action.yml`

**Step 1: Change the inputs block**

Replace:

```yaml
  prepare_artifact:
    description: 'JSON-encoded PrepareArtifact produced by prepare. Required by analyze.'
    required: false
```

with:

```yaml
  prepare_artifact_path:
    description: 'Filesystem path to the JSON-encoded PrepareArtifact. Required (as a write target) by prepare and (as a read source) by analyze.'
    required: false
```

**Step 2: Change the outputs block**

Remove this entry from `outputs:` entirely (it's now written straight to a file, never a job output):

```yaml
  prepare_artifact:
    description: 'prepare output: JSON-encoded PrepareArtifact'
```

**Step 3: Fix the Node 20 deprecation warning**

Change:

```yaml
runs:
  using: 'node20'
  main: 'dist/index.js'
```

to:

```yaml
runs:
  using: 'node24'
  main: 'dist/index.js'
```

**Step 4: Keep CI consistent with the new runtime**

Modify `.github/workflows/ci.yml`: all 4 occurrences of

```yaml
          node-version: '20'
```

to

```yaml
          node-version: '24'
```

Modify `action/package.json`'s `engines` field from `"node": ">=20"` to `"node": ">=24"`.

**Step 5: Rebuild the dist bundle**

Run: `cd action && npm run build`
Expected: `action/dist/index.js` (and any sourcemap it produces) is regenerated with no errors. This step is mandatory — GitHub Actions executes `dist/index.js`, not the TypeScript source, so skipping this leaves the fix inert.

**Step 6: Run the full test suite and typecheck once more**

Run: `cd action && npm run typecheck && npm test`
Expected: all pass.

**Step 7: Commit**

```bash
git add action/action.yml .github/workflows/ci.yml action/package.json action/dist
git commit -m "$(cat <<'EOF'
fix: replace prepare_artifact job-output contract with a file path input; bump action runtime to node24

- action.yml: prepare_artifact (string input/output) -> prepare_artifact_path
  (file path input only, no matching output — the payload never touches a
  job output again).
- action.yml: runs.using node20 -> node24, clearing the deprecated-runtime
  warning GitHub Actions was surfacing on every run.
- ci.yml / package.json: keep the local Node version consistent with the
  action runtime.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire the artifact upload/download into `reusable-pr-review.yml`

**Files:**
- Modify: `.github/workflows/reusable-pr-review.yml`

**Step 1: Update the `prepare` job**

Current (lines ~46-64):

```yaml
  prepare:
    needs: status-start
    if: needs.status-start.outputs.gate_passed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      stale: ${{ steps.run.outputs.stale }}
      incomplete: ${{ steps.run.outputs.incomplete }}
      prepare_artifact: ${{ steps.run.outputs.prepare_artifact }}
    steps:
      - uses: dustPyrotechnic/pr-review-swarm/action@0777a30932bf96b30f4d14532e789d578de8e6cb
        id: run
        with:
          entrypoint: prepare
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_number: ${{ inputs.pr_number }}
          identity_tuple: ${{ needs.status-start.outputs.identity_tuple }}
```

Replace with (note: `prepare_artifact` is dropped from `outputs:`, a `prepare_artifact_path` input is added, and the upload step is gated on `stale != 'true'` since `prepare.ts` returns before writing the file when stale):

```yaml
  prepare:
    needs: status-start
    if: needs.status-start.outputs.gate_passed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      stale: ${{ steps.run.outputs.stale }}
      incomplete: ${{ steps.run.outputs.incomplete }}
    steps:
      - uses: dustPyrotechnic/pr-review-swarm/action@<NEW_SHA>
        id: run
        with:
          entrypoint: prepare
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_number: ${{ inputs.pr_number }}
          identity_tuple: ${{ needs.status-start.outputs.identity_tuple }}
          prepare_artifact_path: ${{ runner.temp }}/prepare-artifact.json
      - uses: actions/upload-artifact@v4
        if: steps.run.outputs.stale != 'true'
        with:
          name: prepare-artifact-${{ inputs.pr_number }}
          path: ${{ runner.temp }}/prepare-artifact.json
          retention-days: 1
```

(`<NEW_SHA>` is a placeholder — see Task 6, it gets filled in during the re-pin commit, not this one. Leave the OLD sha in place for now and let Task 6 update all 6 occurrences together, OR see the note at the end of this task.)

**Step 2: Update the `analyze` job**

Current (lines ~66-87):

```yaml
  analyze:
    needs: prepare
    if: needs.prepare.outputs.stale != 'true'
    runs-on: ubuntu-latest
    permissions: {}
    outputs:
      hard_limit_hit: ${{ steps.run.outputs.hard_limit_hit }}
      any_required_stage_failed: ${{ steps.run.outputs.any_required_stage_failed }}
      findings: ${{ steps.run.outputs.findings }}
      coverage_manifest: ${{ steps.run.outputs.coverage_manifest }}
    steps:
      - uses: dustPyrotechnic/pr-review-swarm/action@0777a30932bf96b30f4d14532e789d578de8e6cb
        id: run
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        with:
          entrypoint: analyze
          prepare_artifact: ${{ needs.prepare.outputs.prepare_artifact }}
          model: ${{ inputs.model }}
```

Replace with:

```yaml
  analyze:
    needs: prepare
    if: needs.prepare.outputs.stale != 'true'
    runs-on: ubuntu-latest
    permissions: {}
    outputs:
      hard_limit_hit: ${{ steps.run.outputs.hard_limit_hit }}
      any_required_stage_failed: ${{ steps.run.outputs.any_required_stage_failed }}
      findings: ${{ steps.run.outputs.findings }}
      coverage_manifest: ${{ steps.run.outputs.coverage_manifest }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: prepare-artifact-${{ inputs.pr_number }}
          path: ${{ runner.temp }}
      - uses: dustPyrotechnic/pr-review-swarm/action@<NEW_SHA>
        id: run
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        with:
          entrypoint: analyze
          prepare_artifact_path: ${{ runner.temp }}/prepare-artifact.json
          model: ${{ inputs.model }}
```

`permissions: {}` is unchanged and still correct: `actions/download-artifact` authenticates with the Actions Runtime token for same-run artifacts, which is entirely separate from the job's `GITHUB_TOKEN`/`permissions:` scope. This does not violate `docs/AGENTS.md` rule 3 ("不获得可写 GitHub 凭据，也不获得 contents: read") — no GitHub REST/API credential is granted here at all.

**Step 3: No test to run for this file**

Workflow YAML has no unit test in this repo; verification happens by actually triggering the workflow (Task 8).

**Step 4: Do not commit yet**

Leave this staged/uncommitted — Task 6 needs to add the `<NEW_SHA>` values and cli/VERSION bump in the same "re-pin" commit per repo convention, but that SHA doesn't exist until *this* commit (Task 5's own commit) is made. So: commit Task 5 now with the OLD sha still in the two new `uses:` lines you just added (`actions/upload-artifact@v4` / `actions/download-artifact@v4` don't need pinning to this repo's SHA, only the two `dustPyrotechnic/pr-review-swarm/action@...` lines do) — then Task 6 is the re-pin commit that updates those two lines (plus the other 4 elsewhere) to Task 5's resulting SHA.

Concretely: in this commit, keep both `dustPyrotechnic/pr-review-swarm/action@0777a30932bf96b30f4d14532e789d578de8e6cb` lines as-is (still pointing at the old SHA) even though the workflow now sends/expects `prepare_artifact_path` instead of `prepare_artifact` — this is intentionally a transient, self-inconsistent state that Task 6 immediately fixes in the very next commit. If you'd rather not have a broken intermediate commit sit in history even momentarily, squash Tasks 5 and 6 into one commit instead — either is fine, but the re-pin SHA still can't be known until the tree (including this workflow change) is committed once.

**Step 5: Commit**

```bash
git add .github/workflows/reusable-pr-review.yml
git commit -m "$(cat <<'EOF'
fix: transport prepare_artifact via upload/download-artifact instead of job outputs

Completes the fix started in the prepare.ts/analyze.ts/action.yml
commits: the reusable workflow no longer forwards prepare_artifact
through needs.prepare.outputs (capped at 1MB total by GitHub Actions,
which is what was failing on real-sized PRs). prepare now uploads the
artifact file it wrote to disk; analyze downloads it before invoking
the action. permissions: {} on the analyze job is unaffected --
actions/download-artifact uses the internal Actions Runtime token,
not GITHUB_TOKEN.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Re-pin the action reference (repo convention)

**Files:**
- Modify: `.github/workflows/reusable-pr-review.yml` (all `uses: dustPyrotechnic/pr-review-swarm/action@...` lines — there are 5 in this file: status-start, prepare, analyze, publish, status-finalize)
- Modify: `.github/workflows/reusable-pr-review-watchdog.yml` (1 occurrence)
- Modify: `cli/VERSION`

**Step 1: Get the SHA of Task 5's commit**

Run: `git rev-parse HEAD`
Copy the resulting 40-character SHA — call it `<FIX_SHA>`.

**Step 2: Replace every pinned reference**

In both workflow files, replace every occurrence of

```
dustPyrotechnic/pr-review-swarm/action@0777a30932bf96b30f4d14532e789d578de8e6cb
```

with

```
dustPyrotechnic/pr-review-swarm/action@<FIX_SHA>
```

(6 occurrences total: 5 in `reusable-pr-review.yml`, 1 in `reusable-pr-review-watchdog.yml`.) A safe way to do this across both files at once:

```bash
git grep -l '0777a30932bf96b30f4d14532e789d578de8e6cb' -- '.github/workflows/*.yml' \
  | xargs sed -i '' "s/0777a30932bf96b30f4d14532e789d578de8e6cb/<FIX_SHA>/g"
```

(macOS `sed -i ''` — adjust if running elsewhere. Substitute the literal SHA for `<FIX_SHA>` before running.)

**Step 3: Update `cli/VERSION`**

Overwrite its single line with `<FIX_SHA>` (no trailing content beyond the newline, matching the existing file's format).

**Step 4: Verify no stale references remain**

Run: `git grep -n "0777a30932bf96b30f4d14532e789d578de8e6cb"`
Expected: no output (every reference updated).

**Step 5: Commit**

```bash
git add .github/workflows/reusable-pr-review.yml .github/workflows/reusable-pr-review-watchdog.yml cli/VERSION
git commit -m "$(cat <<'EOF'
chore: re-pin action reference to prepare-artifact-file-transport fix commit

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update stale docs

**Files:**
- Modify: `docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md:745`

**Step 1: Find and update the stale line**

Line 745 currently reads:

```
      prepare_artifact: ${{ steps.run.outputs.prepare_artifact }}
```

(inside a workflow-skeleton code sample in the original implementation plan.) Update it to reflect the new mechanism, e.g. replace that line with a short note that `prepare_artifact` is transported via `actions/upload-artifact`/`download-artifact` rather than a job output, pointing at `docs/plans/2026-07-27-prepare-artifact-file-transport.md` (this plan) for the concrete wiring. This file already carries a caveat at line 789 that exact output field names are "implementation-period polish items" — extend that same caveat to note the transport mechanism changed, so a future reader doesn't copy the stale `job outputs` example.

**Step 2: Commit**

```bash
git add docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md
git commit -m "$(cat <<'EOF'
docs: correct the original plan's prepare_artifact job-output example

The original implementation plan's workflow skeleton showed
prepare_artifact as a plain job output. That's what caused the 1MB
job-output overflow this fix addresses -- update the stale example so
it doesn't get copied again.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Verify end-to-end

**Step 1: Full local verification**

Run from repo root:

```bash
cd action && npm run typecheck && npm run lint && npm test && npm run build
```

Expected: all green, and `git status` shows no diff in `action/dist/` (i.e., the dist committed in Task 4 already reflects every source change from Tasks 1-4 — if it shows a diff here, `npm run build` wasn't re-run after some later edit; rebuild and amend into the relevant commit before proceeding).

**Step 2: Trigger a real workflow run**

Push the branch and open (or update) a real PR against a repo that calls `reusable-pr-review.yml` at the new pinned SHA (this repo's own `.github/pr-review-swarm.yml` caller works for a self-test PR). Confirm in the Actions tab:
- `review / prepare` succeeds (no "Job outputs exceed 1,048,576 bytes").
- The `prepare-artifact-<pr_number>` artifact appears in the run's artifact list.
- `review / analyze` succeeds and downloads that artifact.
- No Node 20 deprecation warning appears in any step's log.

**Step 3: Report back**

Once confirmed, this plan is complete — no further commits needed unless the live run surfaces something Tasks 1-7 didn't anticipate (e.g., artifact name collisions under concurrent runs), in which case treat that as a new bug and re-enter systematic-debugging Phase 1 rather than patching ad hoc.
