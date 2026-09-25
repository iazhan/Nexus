# 版本管理

## 单一版本源

Nexus 的所有包与桌面应用**共用同一个版本号**，落在各自 `package.json` 的顶层 `version` 字段。

提交信息的格式与长度要求见 `COMMIT_CONVENTION.md`。

为什么不是每包独立：10 个包全部 `private: true`、彼此以 `workspace:*` 互链、不单独发布到 npm。
独立版本号只会制造 10 个互相漂移的机会，换不来任何收益。

**当前版本：0.1.0**（基线，尚未打 tag）

## 推进规则

| 改动类型 | 版本推进 | 提交前缀 | 示例 |
| --- | --- | --- | --- |
| 修缺陷、修回归 | **patch** | `fix:` | 0.1.0 → 0.1.1 |
| 新增向后兼容的能力 | **minor** | `feat:` | 0.1.1 → 0.2.0 |
| 破坏性变更、架构重写 | **major** | `feat!:` / `refactor!:` | 0.2.0 → 1.0.0 |
| 文档、注释、测试补齐、格式化、工具脚本 | **不推进** | `docs:` / `test:` / `style:` / `chore:` | — |

判断口径是「**有没有改变产品行为**」，不是「有没有改文件」。补一个只跑测试的用例、改注释、调格式，
都不推进版本 —— 否则版本号会被通胀成无意义的计数器。

## 标准流程

```bash
# 1. 改代码
# 2. 推进版本（与代码改动同一批）
pnpm version:bump patch

# 3. 确认版本变更与代码变更一致
git add -A
pnpm version:check:staged

# 4. 版本改动与代码改动放进同一个提交
git commit -m "fix(editor): stop click hit area drifting below tables"

# 5. 打 tag
git tag v0.1.1
```

**版本号的调整必须与提交内容在同一个提交里** —— 单独一个 `chore: bump version` 提交会让
「哪个版本对应哪份代码」这件事断链。

## 命令

| 命令 | 作用 | 失败退出码 |
| --- | --- | --- |
| `pnpm version:show` | 打印 10 个清单的版本与一致性 | 不一致时 1 |
| `pnpm version:check` | 校验全仓版本一致；已打 tag 则提示需要 bump | 不一致或已发布时 1 |
| `pnpm version:check:staged` | 校验**暂存区**：有行为变更就必须有版本变更 | 缺版本变更时 1 |
| `pnpm version:bump <patch\|minor\|major>` | 推进全部清单的版本 | 参数非法或版本不一致时 1 |
| `node scripts/version.mjs set <x.y.z>` | 直接设定版本（仅用于首次对齐） | 格式非法时 1 |

`version:check:staged` 是「确保版本号与提交内容一致」的可执行版本：

- 暂存区有 `apps/` / `packages/` 下的 `.ts` / `.tsx` / `.css`（**排除** `test/` 与 `*.test.ts(x)`）
  但没有 `package.json` 的 version 变更 → **拦截**；
- 只改了版本号、没有行为变更 → 提醒（放行）；
- 只改了文档 / 测试 / 工具 → 放行。

## 提交时自动校验

仓库带一个 pre-commit hook，提交时自动跑 `check --staged`：有行为变更却没有版本变更就**拒绝提交**。

```bash
pnpm hooks:install        # 等价于 git config core.hooksPath .githooks
```

> `core.hooksPath` 是本机 git 配置，**不在版本库里** —— 换 checkout 或换机器后要重跑一次。
> hook 找不到 node 时会跳过校验并放行，不会因为环境问题卡死提交。

`.gitattributes` 里有一条 `.githooks/** -text`：本机 `core.autocrlf=true` 会把文本文件检出成 CRLF，
那样 hook 的 shebang 变成 `#!/bin/sh\r`，sh 找不到解释器 → **hook 静默失效**。这一条只锁 hook 目录。

## 实现约定

- 版本号由 `scripts/version.mjs` 统一改写，**只替换顶层 `version` 那一行**，不整体重写 JSON。
  整体重写会重排字段、丢格式、丢行尾风格。
- 清单列表是**动态扫描** `package.json` + `apps/*/package.json` + `packages/*/package.json`，
  新增包不需要回来改脚本。
- 脚本对 CRLF / LF 都安全（只替换字段值，不动行尾）。

## 已知环境风险：`core.autocrlf=true`

本机 `core.autocrlf=true`，git 会在检出时把文本文件转成 CRLF。`scripts/version.mjs` 对此免疫
（只替换字段值、不动行尾），但**任何按行尾做精确匹配的工具都可能被它坑**。

`.gitattributes` 目前**只锁了 `.githooks/**`**，其他文件不受保护。`App.css`、`App.tsx`、
`apps/desktop/test/desktop-smoke.test.ts` 是 CRLF，改动时不要用会规范化行尾的编辑工具。

> 加 `.gitattributes` 统一行尾是更彻底的解法，但会让上述文件在下次检出时整体变化、产生巨型 diff，
> 属于独立的改动，不在这里顺手做。
