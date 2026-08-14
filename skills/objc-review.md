---
name: objc-review
version: 1
triggers:
  - "*.m"
  - "*.mm"
  - "*.h"
category: correctness
---

## 触发条件
变更文件包含 `.m`、`.mm` 或 `.h` 后缀。

## Checklist

### 强引用循环
- [ ] block 内直接使用了 `self` 或 `self.xxx`，而该 block 被 self 持有的对象保留（属性、集合、注册的回调）？这是最常见的形态——判据是「block 的持有者能否经由 self 到达」，不是「block 里有没有 self」。系统 API 的一次性回调（如 `dispatch_after`、`NSURLSession` 的 completion）通常不构成循环。
- [ ] 已用 `__weak typeof(self) weakSelf = self;`，但 block 内又出现了裸 `self`？部分改造比不改造更难发现。
- [ ] `delegate` / `dataSource` / 回调对象属性用了 `strong` 而非 `weak` 或 `assign`？委托方持有委托者即成环。
- [ ] `NSTimer` 的 target 是 self 且未在 `dealloc` 前 `invalidate`？timer 会强引用 target。
- [ ] 注册了 KVO 或 `NSNotificationCenter` 观察者，但没有对应的移除？

### 内存与生命周期
- [ ] 对象在 `dealloc` 里访问了可能已释放的资源？
- [ ] `copy` 语义该用而未用（`NSString`/`NSArray`/block 属性）？

### 空值与类型
- [ ] 从 JSON / 字典取值后直接当具体类型使用，没有 `isKindOfClass:` 校验？
- [ ] 可能为 `nil` 的对象被放进不接受 nil 的容器或 API？

### 规范
- [ ] 2 空格缩进？
- [ ] `///` DocC 风格注释，使用 `@param` / `@return` 标签？
