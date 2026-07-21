import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';
import { minimatch } from 'minimatch';

export interface SkillIndexEntry {
  name: string;
  version: number;
  triggers: string[];
  description: string;
}

export interface SkillMeta {
  name: string;
  version: number;
  triggers: string[];
  category: string;
}

export interface LoadedSkill {
  meta: SkillMeta;
  body: string;
}

const INDEX_LINE_RE = /^-\s*([a-z0-9-]+):\s*v(\d+)\s*\|\s*(.+?)\s*\|\s*(.+)$/;
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function skillsDir(): string {
  if (process.env.GITHUB_ACTION_PATH) {
    return path.join(process.env.GITHUB_ACTION_PATH, '..', 'skills');
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../skills');
}

export function readIndexMd(): string {
  return readFileSync(path.join(skillsDir(), 'index.md'), 'utf-8');
}

export function parseIndex(indexMd: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];

  for (const line of indexMd.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) continue;

    const match = INDEX_LINE_RE.exec(trimmed);
    if (!match) {
      throw new Error(`skill-loader: malformed index.md line: "${line}"`);
    }

    const [, name, version, triggersRaw, description] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];

    entries.push({
      name,
      version: Number(version),
      triggers: triggersRaw.split(',').map((t) => t.trim()),
      description: description.trim(),
    });
  }

  return entries;
}

export function loadSkill(name: string): LoadedSkill {
  const filePath = path.join(skillsDir(), `${name}.md`);
  const raw = readFileSync(filePath, 'utf-8');

  const match = FRONT_MATTER_RE.exec(raw);
  if (!match) {
    throw new Error(`skill-loader: ${name}.md is missing YAML front matter`);
  }

  const [, frontMatterYaml, body] = match as unknown as [string, string, string];
  const meta = yaml.load(frontMatterYaml) as SkillMeta;

  return { meta, body: body.trim() };
}

export function matchTriggeredSkills(
  files: string[],
  skills: SkillIndexEntry[],
): SkillIndexEntry[] {
  return skills.filter((skill) =>
    skill.triggers.some(
      (trigger) => trigger === '*' || files.some((file) => minimatch(file, trigger, { matchBase: true })),
    ),
  );
}

export function validateSkillRequests(
  requested: string[],
  indexSkills: SkillIndexEntry[],
  maxN: number,
): string[] {
  if (requested.length > maxN) {
    throw new Error(
      `skill-loader: requested ${requested.length} skills exceeds the max of ${maxN} per run`,
    );
  }

  const validNames = new Set(indexSkills.map((s) => s.name));
  for (const name of requested) {
    if (!validNames.has(name)) {
      throw new Error(`skill-loader: unknown skill requested: "${name}"`);
    }
  }

  return requested;
}
