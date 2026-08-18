#!/usr/bin/env node
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { password } from '@inquirer/prompts';
import { parseArgs } from './lib/parse-args.mjs';
import { checkGhCli } from './lib/check-gh-cli.mjs';
import { detectRepo } from './lib/detect-repo.mjs';
import { resolveDeepseekKey } from './lib/resolve-deepseek-key.mjs';
import { resolveRef } from './lib/resolve-ref.mjs';
import { writeWorkflows } from './lib/write-workflows.mjs';
import { writeRepoConfig } from './lib/write-repo-config.mjs';
import { setSecret } from './lib/set-secret.mjs';
import { deployChanges } from './lib/deploy-changes.mjs';
import { runDeploy } from './lib/run-deploy.mjs';

const HELP_TEXT = `pr-review-swarm — install the PR Review Swarm review bot into this repo

Usage:
  pr-agent deploy [options]
  npx github:dustPyrotechnic/pr-review-swarm#<tag> deploy [options]   (without a local link)

Options:
  --deepseek-key=<key>   DeepSeek API key (else reads DEEPSEEK_API_KEY env var, else prompts)
  --direct-push          Commit and push directly instead of opening a PR
  --force                Overwrite existing workflow/config files instead of erroring
  --pin-sha              Pin the installed workflows to an immutable commit SHA instead of
                         the moving v1 tag (upgrades then need a re-run of this command)
  --watchdog-interval=<N>m|<N>h
                         How often the watchdog sweeps for orphaned "in progress" checks
                         (default 30m, min 30m, max 24h). Bigger = fewer empty runs, but a
                         stuck check blocks its PR for longer. A quiet repo can go to 10h.
  --help                 Show this help text

Run from inside the target repo's working directory, with a GitHub "origin" remote
and the gh CLI installed and logged in (gh auth login).
`;

function realFs() {
  return {
    exists: (path) => existsSync(path),
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf-8');
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (args.command !== 'deploy') {
    throw new Error(`unsupported command: ${args.command}`);
  }

  const fs = realFs();

  const summary = await runDeploy(
    {
      deepseekKeyFlag: args.deepseekKey,
      directPush: args.directPush,
      force: args.force,
      pinSha: args.pinSha,
      watchdogInterval: args.watchdogInterval,
    },
    {
      checkGhCli,
      detectRepo,
      resolveDeepseekKey: (opts) =>
        resolveDeepseekKey({ ...opts, env: process.env, prompt: () => password({ message: 'DeepSeek API key:' }) }),
      writeWorkflows: (opts) => writeWorkflows({ ...opts, fs }),
      writeRepoConfig: (opts) => writeRepoConfig({ ...opts, fs }),
      resolveRef,
      setSecret,
      deployChanges,
    },
  );

  console.log('\n✅ PR Review Swarm installed:');
  console.log(`  Workflow files: ${summary.workflowFiles.join(', ') || '(none written)'}`);
  console.log(
    `  Pinned to: ${summary.ref}` +
      (summary.refMode === 'tag'
        ? ' (moving major tag — central releases roll out automatically)'
        : ' (immutable SHA — re-run with --force to upgrade)'),
  );
  console.log(
    `  Watchdog sweep: every ${summary.watchdogInterval.label}` +
      ` (a stuck check clears within ~${summary.watchdogInterval.maxGapMinutes + 10} min worst case)`,
  );
  console.log(`  Repo config: ${summary.repoConfigFile.join(', ') || '(already existed, left untouched)'}`);
  console.log(`  DEEPSEEK_API_KEY secret: set on ${summary.owner}/${summary.repo}`);
  if (summary.deployResult.mode === 'pr') {
    console.log(`  Pull request: ${summary.deployResult.prUrl}`);
    console.log('\nNext steps: review and merge the PR above.');
  } else {
    console.log(`  ${summary.deployResult.warning}`);
  }
  console.log(
    'After merging, the bot reviews new PRs automatically. It never approves or merges — a human always gives ' +
      'final confirmation. See Phase 1-4 in docs/plans for how to progress from shadow mode to a required check, ' +
      'if you want one.',
  );
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exitCode = 1;
});
