/**
 * pdfjs 的运行时配置：worker、cmap、标准字体。
 *
 * **必须是一个独立模块，而不是写进 `PdfRenderer.tsx` 的顶层。** 阅读器的页面、缩略图、
 * 大纲三个子组件都要用 pdfjs，从主组件往下传 `pdfjsLib` 会让每个子组件多一个只为
 * 「拿库」而存在的 prop，而漏传一处就是运行期 `undefined`。这里 re-export 一份，
 * 子组件直接 import —— worker 也因此只被配置一次（重复配置会把 URL 覆盖成最后一个
 * 模块的求值顺序，那是随打包器而变的）。
 *
 * ## worker 用 `?url` 而不是 `new URL(..., import.meta.url)`
 *
 * `?url` 让 Vite 把 worker **当作静态资源**复制出去并给出 URL，而不是把它当模块打进 JS：
 * worker 自己会 `importScripts` / 再 import 一堆东西，被卷进主 chunk 既撑大体积又可能
 * 破坏它的 ESM 形态。dev 下 URL 指向 `node_modules`，打包后指向 `assets/` 里的独立文件 ——
 * 两种情况 pdfjs 都能 `new Worker(url)`。
 *
 * 页面在打包后是 `file://`，**`file://` 页面创建 `file://` worker 是可行的**（实测过，
 * 不是推理），所以 worker 不需要内联成 blob。
 *
 * ## cmap 与标准字体必须拼成绝对 URL
 *
 * 这两个目录由 `scripts/copy-pdfjs-assets.mjs` 从 `pdfjs-dist` 复制到
 * `renderer/public/pdfjs/`，于是 dev（`http://localhost:6200/pdfjs/`）与打包后
 * （`file:///.../out/renderer/pdfjs/`）都成立。
 *
 * **不能传相对路径**：它们会被传给 worker，而 worker 里的相对 URL 是相对 **worker 脚本**
 * 解析的，不是相对页面 —— 传相对路径会得到 `assets/pdfjs/cmaps/...` 这种不存在的地址，
 * 症状是**中文 PDF 静默变成空白**（cmap 取不到，字体映射缺失）。缺了 cmaps 就是空白
 * 而不是报错，所以这里没有「看起来能用就行」的余地。
 */
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { pdfjsLib };

/** `getDocument` 的固定参数。散在调用点会让「缩略图少传 cmap」变成中文缩略图空白。 */
export const PDF_DOCUMENT_OPTIONS = {
  cMapUrl: new URL('./pdfjs/cmaps/', document.baseURI).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./pdfjs/standard_fonts/', document.baseURI).href
} as const;
