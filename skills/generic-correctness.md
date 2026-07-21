---
name: generic-correctness
version: 1
triggers:
  - "*"
category: correctness
---

## 触发条件
所有变更文件均适用。

## Checklist
- [ ] 逻辑分支是否覆盖所有预期输入，包括边界值和空值？
- [ ] 是否存在 off-by-one、越界访问或类型不匹配？
- [ ] 并发/异步代码是否存在竞态条件或未处理的 Promise/Future？
- [ ] 错误处理路径是否吞掉异常或返回不一致的错误状态？
- [ ] 修改是否破坏了已有的接口契约或调用方假设？
