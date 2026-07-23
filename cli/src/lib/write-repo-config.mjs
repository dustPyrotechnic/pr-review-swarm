const CONFIG_PATH = '.github/pr-review-swarm.yml';

const TEMPLATE = `# .github/pr-review-swarm.yml — pr-review-swarm repo config (see schemas/repo-config.schema.json)
enabled: true

# trusted_users:
#   - some-github-login   # authors whose PRs are reviewed even without OWNER/MEMBER/COLLABORATOR association

# default_mention: your-github-login   # mentioned in the summary comment when a PR is approved

# ignore_globs:
#   - "vendor/**"

# generated_globs:
#   - "**/*.generated.ts"
`;

export function writeRepoConfig({ fs, force }) {
  if (fs.exists(CONFIG_PATH) && !force) {
    return { written: [], skipped: [CONFIG_PATH] };
  }

  fs.writeFile(CONFIG_PATH, TEMPLATE);
  return { written: [CONFIG_PATH], skipped: [] };
}
