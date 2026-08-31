# action/config

`central-limits.json` — 中央可调策略上限。**例外**：`maxCommitsPerPrForWatchdogScan`、
`maxPrFilesPerPage` 是 GitHub REST API 本身的分页/返回上限，写在这里只是为了让代码里有
一处集中引用，调大这两个数字不会绕过 GitHub 平台限制。

`allowed-models.json` — DeepSeek 允许调用的模型 ID 白名单。当前生产值是
`deepseek-chat`（评测基线与 nightly 都用它）。新增模型必须先写入本文件，否则
status-start 会把未知模型判为配置错误。
