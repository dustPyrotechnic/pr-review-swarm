---
name: swift-review
version: 4
triggers:
  - "*.swift"
category: correctness
---

## 触发条件
变更文件包含 `.swift` 后缀。

## Checklist

### 强引用循环
- [ ] 逃逸闭包内捕获了 `self` 而未用 `[weak self]` / `[unowned self]`？注意只有**逃逸**闭包才需要——`map`、`filter`、`DispatchQueue.sync` 这类同步闭包不构成循环。
- [ ] `delegate` / 回调对象属性声明为 `var` 而非 `weak var`，且被赋值为某个持有它的对象？形如 `loader.delegate = self` 而 `DataLoader` 里写着 `var delegate: SomeDelegate?`——委托方强引用委托者即成环。**这不是闭包捕获，容易漏**。
- [ ] 父子对象互相持有（parent 持有 child、child 又用 `var parent` 指回来）？子对象指回父对象应当是 `weak`。
- [ ] `Timer` / `CADisplayLink` 的 target 是 self 且未在合适时机 `invalidate()`？
- [ ] `NotificationCenter` / KVO 观察者注册后没有对应移除（iOS 9 之前的 API 尤其）？

### 并发
- [ ] 跨 actor 边界传递了非 `Sendable` 类型？
- [ ] 用 `nonisolated` 绕过了 actor 隔离，而访问的状态并非只读？形如 `nonisolated func` 里写 `@MainActor` 类的可变属性。
- [ ] 在非主线程更新 UI？
- [ ] `Task` 里捕获 self 但没有考虑取消？

### 可选值与崩溃
- [ ] 强解包 `!` 用在了运行时可能为 nil 的值上？注释里明确说明「缺失即打包事故」的刻意崩溃属于合理写法，不必报。
- [ ] `as!` 强制转换来自外部数据（JSON、服务端响应）？

### 规范
- [ ] 4 空格缩进？
- [ ] `///` DocC 风格注释，使用 `- Parameters:` / `- Returns:` 标签？
