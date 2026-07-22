import type { Finding } from './arbiter.js';
import type { ParsedFileDiff } from './diff-parser.js';

function isPointLocatable(
  fileDiff: ParsedFileDiff | undefined,
  line: number,
  side: 'LEFT' | 'RIGHT',
): boolean {
  if (!fileDiff) return false;
  const key = side === 'RIGHT' ? 'newLine' : 'oldLine';
  return fileDiff.hunks.some((hunk) =>
    hunk.lines.some((diffLine) => {
      if (side === 'RIGHT' && diffLine.type === 'del') return false;
      if (side === 'LEFT' && diffLine.type === 'add') return false;
      return diffLine[key] === line;
    }),
  );
}

export function isFindingLocatable(finding: Finding, fileDiffs: ParsedFileDiff[]): boolean {
  const fileDiff = fileDiffs.find((f) => f.path === finding.path);
  if (!isPointLocatable(fileDiff, finding.line, finding.side)) return false;

  if (finding.start_line !== undefined || finding.start_side !== undefined) {
    if (finding.start_line === undefined || finding.start_side === undefined) return false;
    if (!isPointLocatable(fileDiff, finding.start_line, finding.start_side)) return false;
  }

  return true;
}
