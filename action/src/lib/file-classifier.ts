import path from 'node:path';
import { minimatch } from 'minimatch';

export type FileTreatment =
  | 'reviewed'
  | 'skipped_binary'
  | 'skipped_generated'
  | 'skipped_vendor'
  | 'skipped_lockfile'
  | 'skipped_budget';

export interface FileClassification {
  treatment: FileTreatment;
  skipReason?: string;
}

export interface FileGlobConfig {
  ignore_globs: string[];
  generated_globs: string[];
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm',
  '.ico', '.icns',
]);

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Podfile.lock',
  'go.sum',
  'mix.lock',
]);

// GitHub API paths are always forward-slash, regardless of the runner OS, so
// path.posix (not the platform-dependent `path` default export) is required.
function extensionOf(filename: string): string {
  return path.posix.extname(filename).toLowerCase();
}

function basenameOf(filename: string): string {
  return path.posix.basename(filename);
}

export function classifyFile(
  file: { filename: string },
  config: FileGlobConfig,
): FileClassification {
  if (BINARY_EXTENSIONS.has(extensionOf(file.filename))) {
    return {
      treatment: 'skipped_binary',
      skipReason: `binary file extension: ${extensionOf(file.filename)}`,
    };
  }

  if (LOCKFILE_BASENAMES.has(basenameOf(file.filename))) {
    return { treatment: 'skipped_lockfile', skipReason: 'recognized dependency lockfile' };
  }

  const matchedIgnoreGlob = config.ignore_globs.find((glob) => minimatch(file.filename, glob));
  if (matchedIgnoreGlob) {
    return {
      treatment: 'skipped_vendor',
      skipReason: `matched repo-config ignore_globs: ${matchedIgnoreGlob}`,
    };
  }

  const matchedGeneratedGlob = config.generated_globs.find((glob) =>
    minimatch(file.filename, glob),
  );
  if (matchedGeneratedGlob) {
    return {
      treatment: 'skipped_generated',
      skipReason: `matched repo-config generated_globs: ${matchedGeneratedGlob}`,
    };
  }

  return { treatment: 'reviewed' };
}
