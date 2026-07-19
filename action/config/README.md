# action/config

`central-limits.json` — 中央可调策略上限。**例外**：`maxCommitsPerPrForWatchdogScan`、
`maxPrFilesPerPage` 是 GitHub REST API 本身的分页/返回上限，写在这里只是为了让代码里有
一处集中引用，调大这两个数字不会绕过 GitHub 平台限制。

`allowed-models.json` — DeepSeek 允许调用的模型 ID 白名单。当前是占位值
（`__PLACEHOLDER_DO_NOT_USE_IN_PRODUCTION__`），真实模型 ID 待确认后替换（设计文档待确认项 D）。
