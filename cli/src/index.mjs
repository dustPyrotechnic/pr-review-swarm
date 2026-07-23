#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { password } from '@inquirer/prompts';
import { parseArgs } from './lib/parse-args.mjs';
import { checkGhCli } from './lib/check-gh-cli.mjs';
import { detectRepo } from './lib/detect-repo.mjs';
import { resolveDeepseekKey } from './lib/resolve-deepseek-key.mjs';
import { writeWorkflows } from './lib/write-workflows.mjs';
import { writeRepoConfig } from './lib/write-repo-config.mjs';
import { setSecret } from './lib/set-secret.mjs';
import { checkActionsPermissions } from './lib/check-actions-permissions.mjs';
import { deployChanges } from './lib/deploy-changes.mjs';
import { runDeploy } from './lib/run-deploy.mjs';

const HELP_TEXT = `pr-review-swarm — install the PR Review Swarm review bot into this repo

Usage:
  npx github:dustPyrotechnic/pr-review-swarm#<tag> deploy [options]

Options:
  --deepseek-key=<key>   DeepSeek API key (else reads DEEPSEEK_API_KEY env var, else prompts)
  --direct-push          Commit and push directly instead of opening a PR
  --force                Overwrite existing workflow/config files instead of erroring
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

function readPinnedSha() {
  const versionPath = new URL('../VERSION', import.meta.url);
  return readFileSync(fileURLToPath(versionPath), 'utf-8').trim();
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
  const pinnedSha = readPinnedSha();

  const summary = await runDeploy(
    { deepseekKeyFlag: args.deepseekKey, directPush: args.directPush, force: args.force },
    {
      checkGhCli,
      detectRepo,
      resolveDeepseekKey: (opts) =>
        resolveDeepseekKey({ ...opts, env: process.env, prompt: () => password({ message: 'DeepSeek API key:' }) }),
      writeWorkflows: (opts) => writeWorkflows({ ...opts, fs }),
      writeRepoConfig: (opts) => writeRepoConfig({ ...opts, fs }),
      setSecret,
      checkActionsPermissions,
      deployChanges,
      pinnedSha,
    },
  );

  console.log('\n✅ PR Review Swarm installed:');
  console.log(`  Workflow files: ${summary.workflowFiles.join(', ') || '(none written)'}`);
  console.log(`  Repo config: ${summary.repoConfigFile.join(', ') || '(already existed, left untouched)'}`);
  console.log(`  DEEPSEEK_API_KEY secret: set on ${summary.owner}/${summary.repo}`);
  console.log(
    summary.actionsPermissionsOk
      ? '  Actions permissions: ok'
      : `  Actions permissions: ⚠️ ${summary.actionsPermissionsHint}`,
  );
  if (summary.deployResult.mode === 'pr') {
    console.log(`  Pull request: ${summary.deployResult.prUrl}`);
    console.log('\nNext steps: review and merge the PR above.');
  } else {
    console.log(`  ${summary.deployResult.warning}`);
  }
  console.log(
    'After merging, the bot reviews new PRs automatically. It never has merge permission — see Phase 1-4 in ' +
      'docs/plans for how to progress from shadow mode to a required check, if you want one.',
  );
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exitCode = 1;
});
