import type { getOctokit } from '@actions/github';
import yaml from 'js-yaml';
import { validate } from './schema-validator.js';
import { fetchFileContent } from './github-content.js';

type Octokit = ReturnType<typeof getOctokit>;

const CONFIG_PATH = '.github/pr-review-swarm.yml';

export interface RepoConfig {
  enabled: boolean;
  trusted_users: string[];
  default_mention?: string;
  ignore_globs: string[];
  generated_globs: string[];
}

const DEFAULT_REPO_CONFIG: RepoConfig = {
  enabled: false,
  trusted_users: [],
  ignore_globs: [],
  generated_globs: [],
};

interface RawRepoConfig {
  enabled?: boolean;
  trusted_users?: string[];
  default_mention?: string;
  ignore_globs?: string[];
  generated_globs?: string[];
}

export async function loadRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
): Promise<RepoConfig> {
  const content = await fetchFileContent(octokit, {
    owner,
    repo,
    path: CONFIG_PATH,
    ref: baseSha,
  });

  // fetchFileContent returns undefined for non-existent files (404) and for
  // non-file paths. Both mean "no repo-level config" → return safe defaults.
  if (content === undefined) {
    return { ...DEFAULT_REPO_CONFIG };
  }

  const parsed = (yaml.load(content) ?? {}) as unknown;
  const result = validate<RawRepoConfig>(
    'https://pr-review-swarm/schemas/repo-config.schema.json',
    parsed,
  );
  if (!result.valid) {
    throw new Error(
      `repo-config: ${CONFIG_PATH} failed schema validation: ${result.errors.join('; ')}`,
    );
  }

  return {
    enabled: result.data.enabled ?? false,
    trusted_users: result.data.trusted_users ?? [],
    default_mention: result.data.default_mention,
    ignore_globs: result.data.ignore_globs ?? [],
    generated_globs: result.data.generated_globs ?? [],
  };
}
