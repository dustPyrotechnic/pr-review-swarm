/**
 * 判定一条 Review / Issue Comment 是不是**发布身份自己**产出的。
 *
 * 设计文档「批量发布与 GitHub 对象」要求：对账时拉取该 PR 全部 Review 后，先"筛选出发布
 * 身份自己提交的记录"，再解析隐藏 marker。缺了这一步，隐藏 marker 就从"幂等键"退化成了
 * "任何人都能写的控制信道"：
 *
 * - 攻击者在自己的 PR 上发一条正文含 marker 的评论，publish 会认为该批次已发布而跳过
 *   —— 机器人被迫闭嘴；
 * - 只要 review_set_id 对上、digest 故意写错，就能触发"digest 不匹配 → incomplete 并停止
 *   发布"的保守分支 —— 拒绝服务；
 * - 人类 reviewer 引用机器人的 Review 正文时会把隐藏注释一起复制过去，于是机器人反过来把
 *   人家的 CHANGES_REQUESTED 给 dismiss 掉。
 *
 * 判定一律**失败关闭**：拿不准就当作"不是自己的"。三个调用点的失败方向都是安全的
 * —— 重复发布而不是静默不发、放着别人的 Review 不动、另起一条摘要评论而不是改写他人评论。
 */
export interface MaybeAuthored {
  user?: { login?: string | null; type?: string | null } | null;
}

/**
 * @param expectedLogin 指定时按 login 精确匹配；不指定时退回"必须是 Bot 账号"。
 *   GITHUB_TOKEN 产出的内容作者是 `github-actions[bot]`（`type: "Bot"`），而 PR 作者
 *   无论如何都伪造不出 `type: "Bot"`，所以这条退化规则已经完整覆盖了人类攻击者的威胁模型。
 */
export function isAuthoredByPublisher(item: MaybeAuthored, expectedLogin?: string): boolean {
  const user = item.user;
  if (!user) return false;
  if (expectedLogin) return user.login === expectedLogin;
  return user.type === 'Bot';
}
