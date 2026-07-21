export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ParsedFileDiff {
  path: string;
  hunks: DiffHunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(path: string, patch: string): ParsedFileDiff {
  const hunks: DiffHunk[] = [];
  if (!patch) {
    return { path, hunks };
  }

  let currentHunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of patch.split('\n')) {
    const headerMatch = HUNK_HEADER_RE.exec(rawLine);
    if (headerMatch) {
      const oldStart = Number(headerMatch[1]);
      const oldLines = headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1;
      const newStart = Number(headerMatch[3]);
      const newLines = headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1;
      currentHunk = { oldStart, oldLines, newStart, newLines, lines: [] };
      hunks.push(currentHunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (rawLine.startsWith('\\')) {
      // "\ No newline at end of file" marker — not a real diff line.
      continue;
    }

    if (rawLine.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', newLine, content: rawLine.slice(1) });
      newLine += 1;
    } else if (rawLine.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', oldLine, content: rawLine.slice(1) });
      oldLine += 1;
    } else {
      currentHunk.lines.push({
        type: 'context',
        oldLine,
        newLine,
        content: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return { path, hunks };
}
