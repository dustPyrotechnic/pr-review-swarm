import type { getOctokit } from '@actions/github';
import type { RequestError } from '@octokit/request-error';

type Octokit = ReturnType<typeof getOctokit>;

export async function fetchFileContent(
  octokit: Octokit,
  params: { owner: string; repo: string; path: string; ref: string },
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent(params);
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      return undefined;
    }
    return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? 'base64').toString('utf-8');
  } catch (err) {
    // A 404 means the file was deleted on head_sha (e.g. PR removes a file).
    // This is normal — return undefined so callers can handle it gracefully.
    if ((err as RequestError).status === 404) {
      return undefined;
    }
    throw err;
  }
}


