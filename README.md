# self-scripts

个人脚本集合。按脚本类型分目录存放，每个目录内有独立的 README 说明其内容与用法。

## 目录结构

| 目录 | 内容 |
|---|---|
| [userscripts/](userscripts/) | 浏览器用户脚本（Tampermonkey / 油猴） |

## 目录规划

新增脚本时按类型放入对应目录；同一目标的多个文件（脚本本体、说明、辅助资源）放在该目录下以脚本名为前缀的子目录中。目录清单：

```
userscripts/            浏览器用户脚本
└── zhixingli/          职行力自动刷课助手
    （后续其它用户脚本与 userscripts/ 平级新增子目录）
```

预留（暂未创建，有内容时再建）：

- `automation/` — 桌面/系统自动化脚本（AutoHotkey、PowerShell 等）
- `tools/` — 一次性小工具与数据处理脚本
- `snippets/` — 可复用的代码片段

## 环境

- Windows 10/11 + Git Bash
- 油猴脚本基于 Tampermonkey（Chrome）

## 许可

各脚本文件头部单独标注（当前均为 MIT）。
