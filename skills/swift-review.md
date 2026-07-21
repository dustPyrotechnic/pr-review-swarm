---
name: swift-review
version: 3
triggers:
  - "*.swift"
category: correctness
---

## 触发条件
变更文件包含 `.swift` 后缀。

## Checklist
- [ ] 是否存在强引用循环（闭包捕获 self 未加 `[weak self]`）？
- [ ] 是否正确处理 Swift Concurrency 的 actor 隔离与 Sendable？
- [ ] 是否遵循 4 空格缩进与 DocC 注释风格？
