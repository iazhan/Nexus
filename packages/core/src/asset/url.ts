/**
 * `nexus-asset://` 的 URL 形状 —— **三方共享的契约**。
 *
 * 这个模块住在 core，是因为同一个形状有三处需要，而它们在三个不同的构建产物里：
 *
 * | 谁 | 在哪 | 用途 |
 * | --- | --- | --- |
 * | 主进程 | `apps/desktop/electron/asset-protocol.ts` | 注册协议、从 URL 取回路径 |
 * | 渲染器 Viewer | `apps/desktop/renderer/src/viewer/**` | 图片与 PDF 的 `src` |
 * | 编辑器预览 | `packages/editor/src/visual/source-analysis.ts` | Markdown 内嵌图片的 `src` |
 *
 * 三处各写一份常量的后果不是「多几行代码」，而是**改一处忘两处**，而症状是
 * 「图片在某些入口能显示、在另一些入口是空白」—— 这类问题几乎查不出来。
 * core 已经是 main / preload / renderer 共享的契约层（`documentTypeForPath`
 * 就在这），editor 也在 renderer 里跑，所以它是这条契约的天然归属。
 *
 * ## 为什么是自定义协议而不是 `file://`（2026-09-27 实测推翻了原方案）
 *
 * 原方案（plan §10.4 定案 A）让图片走 `file://` 换「零协议代码」。它在**打包产物**
 * 下工作正常（页面本身就是 `file://`），但 `pnpm dev` 的页面来自
 * `http://localhost:6200` —— 而 **Chromium 不允许 http 来源的页面加载 `file://` 子资源**，
 * 控制台报 `Not allowed to load local resource`，于是 dev 下图片**全部**打不开。
 *
 * **这不是 CSP 能修的**：CSP 是「允许什么」的上限，管不了浏览器自身的本地资源策略。
 * 而 P3-06 的验收测试跑的是打包产物，所以这个缺口一直到拿真实工作区
 * （`D:\Note\Note`，407 张图片）在 dev 下试才暴露。
 *
 * 换成 `nexus-asset://` 之后：dev 与打包行为一致，图片路径开始过主进程的
 * `checkBoundary` + symlink 逃逸检查（定案 A 里「图片没有工作区边界」的缺口顺带补上），
 * CSP 里的 `file:` 也整条去掉了。
 */

/** 自定义协议名。主进程用它注册 privileged scheme。 */
export const ASSET_SCHEME = 'nexus-asset';

/**
 * 固定 host。
 *
 * `standard: true` 会把 URL 的第一段当作 host 并**小写化**，所以不能把路径写在那里 ——
 * 大小写敏感的文件名会被悄悄改掉。用一个固定 host、把真正的内容放进查询参数。
 */
export const ASSET_HOST = 'ws';

/**
 * 承载目标路径的查询参数名。
 *
 * **用查询参数而不是路径分段，是为了绕开整整一类转义坑。** 手写 `file://` 编码器时
 * 踩了三个，每个都会「静默加载不出来」：
 * - `encodeURI` **不转义** `#` 与 `?`，而这两个在 Windows 文件名里合法 ——
 *   `图#1.png` 会被读成「路径 `图` + 锚点 `1.png`」。
 * - 整串 `encodeURIComponent` 会把分隔用的 `/` 变成 `%2F`，整条路径塌成一段。
 * - 盘符的冒号转义成 `%3A` 后，浏览器会把它当成相对路径。
 *
 * 这里路径是**查询参数的值**，上面三条一条都不成立：`/` 没有结构含义，整串编码
 * 才是对的，盘符只是数据。`URLSearchParams` 自己完成解码，不需要第二个编码器。
 */
export const ASSET_PATH_PARAM = 'path';

/**
 * 绝对路径 → `nexus-asset://` URL。
 *
 * 形状：`nexus-asset://ws/?path=<encodeURIComponent(路径)>`
 *
 * **反斜杠先归一化。** 主进程的 `path.resolve` 在 Windows 下两种都吃，但
 * **同一份路径必须只产生一种 URL** —— 否则索引来的 `D:\a.png` 与拖放来的
 * `D:/a.png` 会变成两个不同的资源地址，缓存与 Range 请求各自为政。
 *
 * 真实工作区的路径特征决定了这不是理论问题：`D:\Note\Note` 的 407 张图片里
 * **398 个含中文、316 个含空格、246 个含方括号 `[ ]`**（Obsidian 的常见命名）。
 */
export function toAssetUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  return `${ASSET_SCHEME}://${ASSET_HOST}/?${ASSET_PATH_PARAM}=${encodeURIComponent(normalized)}`;
}

/**
 * 从请求 URL 取出目标路径；拿不到就返回 `null`（主进程 handler 据此回 400）。
 *
 * **不做规范化，也不做任何校验** —— 原样返回它拿到的字符串。
 * 归一化与边界判定都是 `FileService` 的职责（`checkBoundary` 会 `path.resolve`），
 * 在这一层顺手「清理」路径，只会让「协议层改了路径」变成难查的意外。
 */
export function assetPathFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const value = parsed.searchParams.get(ASSET_PATH_PARAM);
  if (value === null || value === '') return null;
  return value;
}
