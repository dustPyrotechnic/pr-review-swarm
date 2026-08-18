/**
 * watchdog 扫描间隔 -> cron 表达式。
 *
 * watchdog 是兜底巡检：它清理的是「运行已经死了、Check 还卡在 in_progress」的孤儿。
 * 间隔选多大是个纯粹的取舍——扫得密，孤儿清得快，但空跑轮次成倍增长（既扩大与 GitHub
 * 抖动的碰撞面，又挤占该仓库 GITHUB_TOKEN 的速率配额）；扫得稀正好相反。合适的值取决
 * 于仓库有多活跃，所以交给使用方在 deploy 时定，而不是写死。
 */

export const DEFAULT_WATCHDOG_INTERVAL = '30m';

/** 下界：比 central-limits.json 的 watchdogStaleThresholdMinutes（10）更密没有意义，
 *  孤儿不到阈值不够格被终结，多出来的轮次纯属空跑。30m 已经留足余量。 */
const MIN_MINUTES = 30;
/** 上界：cron 的 `0 0 * * *` 就是一天一次，再稀就得动 day 字段，不值得为此扩语法。 */
const MAX_MINUTES = 24 * 60;

const SYNTAX = /^(\d+)([mh])$/;

// 步进式 cron 在每个周期开头重新起算，所以 N 不整除周期时会留下一个短间隙和一个满
// 间隙。真正决定清理延迟的是「最长」的那个间隙，不是标称值。
function maxGap(step, period) {
  const lastFire = Math.floor((period - 1) / step) * step;
  return Math.max(step, period - lastFire);
}

export function parseWatchdogInterval(raw) {
  const value = raw ?? DEFAULT_WATCHDOG_INTERVAL;

  const match = SYNTAX.exec(value);
  if (!match) {
    throw new Error(
      `--watchdog-interval must look like <number>m or <number>h (e.g. 30m, 2h, 10h), got: ${JSON.stringify(value)}`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const minutes = unit === 'h' ? amount * 60 : amount;

  if (minutes < MIN_MINUTES) {
    throw new Error(
      `--watchdog-interval must be at least 30m — scanning denser than that only adds empty runs (got ${value}).`,
    );
  }
  if (minutes > MAX_MINUTES) {
    throw new Error(`--watchdog-interval must be at most 24h (got ${value}).`);
  }

  if (unit === 'm') {
    return { label: value, minutes, cron: `*/${amount} * * * *`, maxGapMinutes: maxGap(amount, 60) };
  }
  if (amount === 24) {
    return { label: value, minutes, cron: '0 0 * * *', maxGapMinutes: MAX_MINUTES };
  }
  return {
    label: value,
    minutes,
    cron: `0 */${amount} * * *`,
    maxGapMinutes: maxGap(amount, 24) * 60,
  };
}
