import { describe, expect, it } from 'vitest';
import { DEFAULT_WATCHDOG_INTERVAL, humanMinutes, parseWatchdogInterval } from './watchdog-schedule.mjs';

describe('humanMinutes', () => {
  it('never makes the reader divide by 60 themselves', () => {
    expect(humanMinutes(40)).toBe('40m');
    expect(humanMinutes(600)).toBe('10h');
    expect(humanMinutes(610)).toBe('10h 10m');
    expect(humanMinutes(1450)).toBe('24h 10m');
  });
});

describe('parseWatchdogInterval', () => {
  it('defaults to 30 minutes', () => {
    const parsed = parseWatchdogInterval(undefined);
    expect(parsed.label).toBe(DEFAULT_WATCHDOG_INTERVAL);
    expect(parsed.cron).toBe('*/30 * * * *');
    expect(parsed.maxGapMinutes).toBe(30);
  });

  it('renders a sub-hour interval into the cron minute field', () => {
    expect(parseWatchdogInterval('30m').cron).toBe('*/30 * * * *');
    expect(parseWatchdogInterval('45m').cron).toBe('*/45 * * * *');
  });

  it('renders an hour interval into the cron hour field', () => {
    // `*/600 * * * *` is not valid cron — anything >= 1h has to move to the hour field.
    expect(parseWatchdogInterval('1h').cron).toBe('0 */1 * * *');
    expect(parseWatchdogInterval('10h').cron).toBe('0 */10 * * *');
  });

  it('renders a 24-hour interval as a single daily fire', () => {
    expect(parseWatchdogInterval('24h').cron).toBe('0 0 * * *');
    expect(parseWatchdogInterval('24h').maxGapMinutes).toBe(24 * 60);
  });

  // `*/N` restarts at the top of each hour/day, so an N that doesn't divide the
  // period evenly leaves one short gap and one full-length gap. The real cleanup
  // latency is driven by the *longest* gap, and that is what gets reported.
  it('reports the longest real gap, not the nominal interval', () => {
    // 0:00, 10:00, 20:00, then back to 0:00 — gaps of 10h, 10h, 4h.
    expect(parseWatchdogInterval('10h').maxGapMinutes).toBe(600);
    // :00 and :45 — gaps of 45min and 15min.
    expect(parseWatchdogInterval('45m').maxGapMinutes).toBe(45);
  });

  it('reports the worst-case cleanup delay, threshold included', () => {
    expect(parseWatchdogInterval('30m').worstCaseLabel).toBe('40m');
    expect(parseWatchdogInterval('10h').worstCaseLabel).toBe('10h 10m');
    expect(parseWatchdogInterval('10h').maxGapLabel).toBe('10h');
  });

  it('rejects an interval below the 30-minute floor', () => {
    expect(() => parseWatchdogInterval('10m')).toThrow(/at least 30m/);
    expect(() => parseWatchdogInterval('1m')).toThrow(/at least 30m/);
  });

  it('rejects an interval above 24 hours', () => {
    expect(() => parseWatchdogInterval('25h')).toThrow(/at most 24h/);
  });

  it('rejects a malformed interval', () => {
    for (const bad of ['30', 'h', '30s', 'abc', '', '1.5h', '-2h']) {
      expect(() => parseWatchdogInterval(bad), `should reject ${JSON.stringify(bad)}`).toThrow(
        /--watchdog-interval/,
      );
    }
  });
});
