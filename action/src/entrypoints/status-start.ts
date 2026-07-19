import { context } from '@actions/github';

export async function run(): Promise<void> {
  if (!context.payload.pull_request) {
    throw new Error(
      'status-start: missing required GitHub Actions context (no pull_request in event payload)',
    );
  }
  throw new Error('status-start: not implemented yet (see Task 1.4)');
}
