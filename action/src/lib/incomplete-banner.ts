export function buildIncompleteBanner(reasons: string[]): string {
  return [
    '⚠️ 本次审核未完整覆盖，结论可能不完整。',
    '',
    '未完成的阶段/范围：',
    ...reasons.map((reason) => `- ${reason}`),
  ].join('\n');
}
