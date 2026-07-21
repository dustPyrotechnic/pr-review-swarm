import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

export function getOctokitFromInput(): ReturnType<typeof getOctokit> {
  const token = core.getInput('github_token', { required: true });
  return getOctokit(token);
}
