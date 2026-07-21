---
name: generic-maintainability
version: 1
triggers:
  - "*"
category: maintainability
---

## 触发条件
所有变更文件均适用。

## Checklist
- [ ] 命名是否清晰表达意图，避免误导性缩写？
- [ ] 是否存在明显重复的逻辑本可以复用已有实现？
- [ ] 公开 API/接口变更是否有对应的文档或注释更新？
- [ ] 新增代码是否遵循目标仓库既有的风格与目录约定？
- [ ] 是否引入了不必要的复杂度或过早的抽象？
