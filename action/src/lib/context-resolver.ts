import path from 'node:path';

export interface RepoTreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree';
}

export type ContextReason =
  | 'same_file_full_content'
  | 'same_directory_import'
  | 'matching_test_file';

export interface ContextFileRef {
  path: string;
  reason: ContextReason;
  sha: string;
}

const IMPORT_SPECIFIER_RE = /(?:from\s+|require\()\s*['"](\.\.?\/[^'"]*)['"]/g;
const RESOLVABLE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// GitHub API paths are always forward-slash, regardless of the runner OS, so
// path.posix (not the platform-dependent `path` default export) is required.
function withoutExtension(filePath: string): string {
  const ext = path.posix.extname(filePath);
  return ext ? filePath.slice(0, -ext.length) : filePath;
}

function extractRelativeImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelativeImport(
  dir: string,
  specifier: string,
  byPath: Map<string, RepoTreeEntry>,
): string | undefined {
  const base = path.posix.join(dir, specifier);
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (byPath.has(candidate)) return candidate;
  }
  return undefined;
}

function testFileCandidatesFor(filePath: string): string[] {
  const stem = withoutExtension(filePath);
  const ext = path.posix.extname(filePath) || '.ts';
  return [`${stem}.test${ext}`, `${stem}.spec${ext}`];
}

export function resolveContext(input: {
  changedFilePaths: string[];
  changedFileContents: Record<string, string>;
  tree: RepoTreeEntry[];
}): ContextFileRef[] {
  const byPath = new Map(
    input.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry]),
  );
  const changedSet = new Set(input.changedFilePaths);
  const results: ContextFileRef[] = [];
  const seen = new Set<string>();

  function add(path: string, reason: ContextReason): void {
    const key = `${path} ${reason}`;
    if (seen.has(key)) return;
    const entry = byPath.get(path);
    if (!entry) return;
    seen.add(key);
    results.push({ path, reason, sha: entry.sha });
  }

  for (const changedPath of input.changedFilePaths) {
    add(changedPath, 'same_file_full_content');

    const dir = path.posix.dirname(changedPath);
    const content = input.changedFileContents[changedPath];
    if (content) {
      for (const specifier of extractRelativeImportSpecifiers(content)) {
        const resolved = resolveRelativeImport(dir, specifier, byPath);
        if (resolved && !changedSet.has(resolved)) {
          add(resolved, 'same_directory_import');
        }
      }
    }

    for (const candidate of testFileCandidatesFor(changedPath)) {
      if (!changedSet.has(candidate)) {
        add(candidate, 'matching_test_file');
      }
    }
  }

  return results;
}
