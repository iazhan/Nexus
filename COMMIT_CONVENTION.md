# 提交信息规范

## 格式

```text
<type>(<scope>): <subject>
```

**单行，英文，不加句号。** 默认不写 body。

## 必要内容

| 部分 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | 这次改动的性质，见下表 |
| `scope` | 推荐 | 受影响的包或区域 |
| `subject` | 是 | 做了什么，英文祈使句，小写开头 |

## type

| type | 用于 | 版本影响 |
| --- | --- | --- |
| `feat` | 新增能力 | minor |
| `fix` | 修缺陷 | patch |
| `perf` | 性能优化 | patch |
| `refactor` | 重构，行为不变 | 不推进 |
| `chore` | 工具链、构建、仓库配置 | 不推进 |
| `docs` | 文档 | 不推进 |
| `test` | 测试 | 不推进 |
| `style` | 格式 | 不推进 |

版本推进规则见 `VERSIONING.md`。

## scope

包名或区域，小写：

```text
core · editor · markdown · theme · i18n · command · math · mermaid · desktop · repo
```

多个用逗号：`fix(editor,desktop): ...`

## 长度

- **整行 ≤ 72 字符**（硬上限，保证 `git log --oneline` 不折行）
- `subject` 部分建议 ≤ 50 字符

## 例子

```text
feat(core): add workspace launch mode
fix(editor): stop click hit area drifting below tables
perf(desktop): minify the renderer bundle
refactor(editor,markdown): split oversized modules into facades
chore(repo): add commit message convention and hook
```

## 反例

```text
fix(editor): 修掉表格下方点击命中区下移
```
subject 必须英文。

```text
fix: bug
```
没说是什么 bug。

```text
feat(desktop): add workspace mode

- allowedRoots 目录级授权
- realpath 校验
- 9 条测试
```
超过一行。改动细节属于提交内容本身 —— `git show` / `git diff` 就能看到，
提交信息里复述一遍只会让 `git log` 变得难读，而且两份描述迟早会不一致。

## 强制

`.githooks/commit-msg` 会校验格式、长度与英文。绕过：`git commit --no-verify`（不建议）。

安装 hook（换 checkout 后需重跑，`core.hooksPath` 是本机配置）：

```bash
pnpm hooks:install
```

## 例外

破坏性变更或需要迁移说明时，可以在标题下空一行写 body —— 但这是例外，
不是默认。默认就是一行。
