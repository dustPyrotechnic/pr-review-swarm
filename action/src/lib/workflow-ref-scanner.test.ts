import { describe, expect, it } from 'vitest';
import { scanWorkflowForPrHeadRefs } from './workflow-ref-scanner.js';

/**
 * 每条都是一种「绕过单条正则 `ref:\s*.*github\.event\.pull_request\.head`」的写法。
 * 硬禁令 1/2：任何 workflow 都不得把 PR head 的代码落到 runner 磁盘上。
 */
const MALICIOUS: Array<[string, string]> = [
  [
    '直接引用 head.sha',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ github.event.pull_request.head.sha }}`,
  ],
  [
    '引用 head.ref',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ github.event.pull_request.head.ref }}`,
  ],
  [
    '引用 github.head_ref',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ github.head_ref }}`,
  ],
  [
    'format 拼接',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ format('{0}', github.event.pull_request.head.sha) }}`,
  ],
  [
    'env 中转（污点传播）',
    `env:\n  TARGET: \${{ github.event.pull_request.head.sha }}\nsteps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ env.TARGET }}`,
  ],
  [
    'job 级 env 中转',
    `jobs:\n  build:\n    env:\n      T: \${{ github.head_ref }}\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ env.T }}`,
  ],
  [
    'step 级 env 中转',
    `steps:\n  - uses: actions/checkout@v4\n    env:\n      T: \${{ github.event.pull_request.head.sha }}\n    with:\n      ref: \${{ env.T }}`,
  ],
  [
    'fromJSON 间接',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ fromJSON(toJSON(github.event)).pull_request.head.sha }}`,
  ],
  [
    'ref 与值分行',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref:\n        \${{ github.event.pull_request.head.sha }}`,
  ],
  [
    '表达式内部加空白',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ github . event . pull_request . head . sha }}`,
  ],
  [
    'checkout pin 到 SHA 而非 @v4',
    `steps:\n  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n    with:\n      ref: \${{ github.head_ref }}`,
  ],
  [
    'gh cli 手动拉取 FETCH_HEAD',
    `steps:\n  - run: git fetch origin pull/\${{ github.event.pull_request.number }}/head && git checkout FETCH_HEAD`,
  ],
  ['gh pr checkout', `steps:\n  - run: gh pr checkout \${{ github.event.pull_request.number }}`],
  [
    '畸形 YAML（解析失败）里藏 checkout ref',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n\t\tref: \${{ github.event.pull_request.head.sha }}\n  : : :`,
  ],
  [
    'YAML 锚点别名',
    `x: &bad \${{ github.event.pull_request.head.sha }}\nsteps:\n  - uses: actions/checkout@v4\n    with:\n      ref: *bad`,
  ],
];

const BENIGN: Array<[string, string]> = [
  [
    'ref 指向 base.sha',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ github.event.pull_request.base.sha }}`,
  ],
  ['不带 ref 的 checkout（默认分支）', `steps:\n  - uses: actions/checkout@v4`],
  [
    'head_sha 作为数据传给自己的 action',
    `steps:\n  - uses: ./action\n    with:\n      head_sha: \${{ github.event.pull_request.head.sha }}`,
  ],
  [
    'head_ref 作为数据写进 action input',
    `steps:\n  - uses: ./action\n    with:\n      branch: \${{ github.head_ref }}`,
  ],
  [
    'run 里把 head_sha 当字符串用（不落盘）',
    `steps:\n  - run: echo "reviewing \${{ github.event.pull_request.head.sha }}"`,
  ],
  [
    'checkout 到 base_ref',
    `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ github.event.pull_request.base.ref }}`,
  ],
  ['env 里有 head_sha 但没被 checkout 用', `env:\n  H: \${{ github.head_ref }}\nsteps:\n  - run: echo ok`],
];

describe('scanWorkflowForPrHeadRefs', () => {
  it.each(MALICIOUS)('拦截：%s', (_name, yamlText) => {
    const violations = scanWorkflowForPrHeadRefs(yamlText);
    expect(violations.length).toBeGreaterThan(0);
  });

  it.each(BENIGN)('不误报：%s', (_name, yamlText) => {
    expect(scanWorkflowForPrHeadRefs(yamlText)).toEqual([]);
  });

  it('violation 带上可定位的行号、规则名与片段', () => {
    const text = `steps:\n  - uses: actions/checkout@v4\n    with:\n      ref: \${{ github.head_ref }}`;
    const violations = scanWorkflowForPrHeadRefs(text);
    expect(violations).toHaveLength(1);
    const v = violations[0]!;
    expect(v.line).toBe(4);
    expect(v.rule).toBe('checkout-ref-pr-head');
    expect(v.snippet).toContain('github.head_ref');
  });

  it('对空输入与非 YAML 输入不抛异常', () => {
    expect(() => scanWorkflowForPrHeadRefs('')).not.toThrow();
    expect(() => scanWorkflowForPrHeadRefs(']]][[[not yaml at all')).not.toThrow();
  });
});
