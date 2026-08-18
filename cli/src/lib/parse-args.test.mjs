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
      pinSha: false,
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

  it('defaults pinSha to false so deploys follow the moving major tag', () => {
    expect(parseArgs(['deploy']).pinSha).toBe(false);
  });

  it('parses --pin-sha', () => {
    expect(parseArgs(['deploy', '--pin-sha']).pinSha).toBe(true);
  });

  it('parses --watchdog-interval and leaves it undefined when absent', () => {
    expect(parseArgs(['deploy', '--watchdog-interval=10h']).watchdogInterval).toBe('10h');
    expect(parseArgs(['deploy']).watchdogInterval).toBeUndefined();
  });

  // 值的合法性由 watchdog-schedule.mjs 判定，但拼错的 flag 名必须在这里就炸，
  // 不能被当成位置参数悄悄吞掉（--pin-sha 那个坑就是这么来的）。
  it('rejects --watchdog-interval passed as a separate argument', () => {
    expect(() => parseArgs(['deploy', '--watchdog-interval', '10h'])).toThrow(/unknown flag/i);
  });

  it('throws on an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/i);
  });

  it('throws when no command and no --help is given', () => {
    expect(() => parseArgs([])).toThrow(/no command/i);
  });
});
