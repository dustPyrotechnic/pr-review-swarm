import { describe, expect, it } from 'vitest';
import { parseArgs } from './parse-args.mjs';

describe('parseArgs', () => {
  it('parses the deploy command with no flags', () => {
    const result = parseArgs(['deploy']);
    expect(result).toEqual({
      command: 'deploy',
      help: false,
      deepseekKey: undefined,
      directPush: false,
      force: false,
    });
  });

  it('parses --deepseek-key=value', () => {
    const result = parseArgs(['deploy', '--deepseek-key=sk-abc123']);
    expect(result.deepseekKey).toBe('sk-abc123');
  });

  it('parses --direct-push and --force flags', () => {
    const result = parseArgs(['deploy', '--direct-push', '--force']);
    expect(result.directPush).toBe(true);
    expect(result.force).toBe(true);
  });

  it('parses --help without requiring a command', () => {
    const result = parseArgs(['--help']);
    expect(result.help).toBe(true);
  });

  it('parses "deploy --help"', () => {
    const result = parseArgs(['deploy', '--help']);
    expect(result.command).toBe('deploy');
    expect(result.help).toBe(true);
  });

  it('throws on an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/i);
  });

  it('throws when no command and no --help is given', () => {
    expect(() => parseArgs([])).toThrow(/no command/i);
  });
});
