---
name: generic-security
version: 1
triggers:
  - "*"
category: security
---

## 触发条件
所有变更文件均适用。

## Checklist
- [ ] 是否存在硬编码的凭据、密钥或 Token？
- [ ] 用户输入是否在进入 SQL/Shell/HTML/模板前正确转义或参数化？
- [ ] 权限检查是否在每个可写操作的入口都执行，而非仅在 UI 层？
- [ ] 新增依赖是否来自可信来源，版本是否锁定？
- [ ] 是否引入了可被利用的路径穿越、SSRF 或反序列化风险？
