import type { CandidateFinding } from './expert-runner.js';

/**
 * 丢弃「模型自己论证了不构成缺陷、却仍然作为 finding 交上来」的候选。
 *
 * 依据 2026-08-30 的 ios-source-learning#9 实测：62 条 inline finding 里 12 条
 * （19.4%）属于这一类，其中 3 条被标成 [high] 并直接驱动了 REQUEST_CHANGES。
 * 典型样本的 suggestion 字段就是字符串「无。」，正文末尾写着「不构成缺陷。」。
 *
 * 放在 arbiter 里而不是 prompt 里，是因为 prompt 已经被证明拦不住它：模型先给出
 * severity 再写正文，写完否定结论也不会回头改 severity。这里做的是一次确定性的
 * 事后核对 —— 「这条 finding 到底要求对方做什么」。
 *
 * 刻意保守，宁可漏杀不可误杀：这道门的输出直接决定 verdict，误杀到底就变成
 * 「审完说没问题」，比放过几条噪声严重得多。
 */

// 规则 1：suggestion 是空操作。归一化后**全等**匹配，不做包含匹配 ——
// 「无需改动这一处的命名，但要修边界判断」包含「无需改动」，却是真建议。
const NO_OP_SUGGESTIONS = new Set([
  '无',
  '无。',
  'none',
  'none.',
  'n/a',
  'na',
  '不适用',
  '不适用。',
  '无需修改',
  '无需修改。',
  '无需改动',
  '无需改动。',
  '无需变更',
  '无需变更。',
  '无问题',
  '无问题。',
  '不需要修改',
  '不需要修改。',
  'no change needed',
  'no change needed.',
  'no changes needed',
  'no changes needed.',
  'nothing to change',
  'nothing to change.',
]);

// 规则 2：**最后一个句子**是否定式结论。
//
// 词表刻意只收「不会出现在让步从句里」的短语。「逻辑正确」「无问题」「无需修改」
// 这类必须排除：它们是让步从句的标准开头 ——「计数逻辑正确，但 dry-run 分支漏了
// 自增」正是实测里唯一那条真阳性的写法，收进词表就会把真缺陷吃掉。它们作为
// **整个 suggestion** 出现时已由规则 1 的全等匹配覆盖。
const NEGATION_CONCLUSIONS = [
  '不构成缺陷',
  '不构成问题',
  '无实际缺陷',
  '无实际问题',
  '并非缺陷',
  '不是缺陷',
  'not a defect',
  'not an actual defect',
  'no actual defect',
  'not an issue',
];

// 末句里出现转折词，说明否定只是让步的前半截，后面还有真正的主张。
const CONCESSIVE_MARKERS = ['但', '不过', '然而', '可是', '只是', 'however', 'but ', 'except'];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function lastSentence(text: string): string {
  const parts = normalize(text)
    .split(/[。；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) ?? '';
}

function concludesNoDefect(text: string): boolean {
  const sentence = lastSentence(text);
  if (CONCESSIVE_MARKERS.some((marker) => sentence.includes(marker))) return false;
  return NEGATION_CONCLUSIONS.some((phrase) => sentence.includes(phrase));
}

export function isSelfRefuting(finding: CandidateFinding): boolean {
  if (NO_OP_SUGGESTIONS.has(normalize(finding.suggestion))) return true;
  return concludesNoDefect(finding.evidence) || concludesNoDefect(finding.impact);
}
