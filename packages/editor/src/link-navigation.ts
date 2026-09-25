/**
 * 普通链接的导航手势（Ctrl/Cmd + 左键）。
 *
 * 为什么导航必须挂在修饰键上：Visual 模式下普通链接的链接文字是**真实文档文本**，
 * 只由 `cm-visual-link` mark 装饰承载，没有原生 `<a>`（见 visual-projection 的
 * link 分支）。浏览器因此不提供任何导航行为——点击的语义只能是"落光标、准备编辑"。
 * 把导航降级成一个需要修饰键的动作，"点击即编辑"与"跳转"才能共存且互不打扰。
 *
 * 分层：编辑器只负责**识别**（命中哪个链接、href 是什么），决定权交给宿主。
 * 打开系统浏览器、按当前文档目录解析相对路径、跳转文档内锚点都属于宿主策略，
 * 不下沉到编辑器包——否则编辑器就得知道 `window.nexus` 的存在。
 */
import { Facet, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

export interface LinkNavigationRequest {
  /**
   * 装饰上携带的、已净化的 href。相对路径与 `#anchor` 保持**未解析**状态——
   * 只有宿主知道当前文档目录，编辑器不该替它猜。
   *
   * `kind === 'wikilink'` 时这里是 `[[...]]` 里的**目标名**（同样未解析）：
   * 宿主应该拿它去工作区索引里找，而不是当文件路径处理。
   */
  href: string;
  /** 被点击链接文字在文档中的位置；仅用于日志与降级提示，不可作为导航目标。 */
  pos: number;
  /** 省略即视为普通链接（保持向后兼容）。 */
  kind?: 'link' | 'wikilink';
}

/**
 * 返回 `false` 表示宿主不处理，编辑器把事件交回浏览器（保持默认的落光标行为）。
 * 其余返回值（含 `undefined`）都视为已处理。
 */
export type LinkNavigator = (request: LinkNavigationRequest) => boolean | void;

export const linkNavigatorFacet = Facet.define<LinkNavigator, LinkNavigator | undefined>({
  combine: (values) => values[0]
});

/**
 * 同时覆盖 mark 装饰与 raw 结构畸形时降级出的 LinkWidget——两者都带 `cm-visual-link`。
 * wikilink 的 widget 也走同一条路径（它带 `cm-visual-wikilink`）：
 * 编辑器只负责把**目标名**递出去，解析成哪篇文档是宿主的策略。
 */
const LINK_SELECTOR = '.cm-visual-link, .cm-visual-wikilink';

export function createLinkNavigationExtension(navigator: LinkNavigator): Extension {
  return ViewPlugin.fromClass(
    class {
      public constructor(private readonly view: EditorView) {
        this.handleMouseDown = this.handleMouseDown.bind(this);
        // 挂在捕获阶段：CodeMirror 自己的选区/落光标逻辑注册在 contentDOM 上、走冒泡，
        // 只有先在 view.dom 捕获到，Ctrl+左键才不会把光标先挪走再跳转。
        this.view.dom.addEventListener('mousedown', this.handleMouseDown, true);
      }

      private handleMouseDown(event: MouseEvent): void {
        // 只认左键 + 修饰键。macOS 上 Ctrl+左键是系统级次要点击，所以那边用 Meta。
        if (event.button !== 0) return;
        if (!event.ctrlKey && !event.metaKey) return;
        // Shift/Alt 是选区扩展修饰键，按下说明用户在拖选，不介入。
        if (event.shiftKey || event.altKey) return;

        const target = event.target as HTMLElement | null;
        const linkEl = (target?.closest?.(LINK_SELECTOR) ?? null) as HTMLElement | null;
        if (!linkEl) return;

        // 被拦截的协议（javascript:/data:/file: 等）没有任何可导航目标。
        // 既不做任何事，也不吞事件——保持"点击即落光标"的默认行为。
        if (linkEl.classList.contains('cm-visual-link-blocked')) return;

        const isWikiLink = linkEl.classList.contains('cm-visual-wikilink');

        // 普通链接：mark 装饰走 data-safe-href，降级的 LinkWidget 才有真正的 href 属性。
        // wikilink：widget 上没有 href，目标名在 data-wikilink-target 上。
        const href = (
          isWikiLink
            ? (linkEl.dataset.wikilinkTarget ?? '')
            : (linkEl.dataset.safeHref ?? linkEl.getAttribute('href') ?? '')
        ).trim();
        if (!href) return;

        const request: LinkNavigationRequest = {
          href,
          pos: resolvePos(this.view, linkEl),
          ...(isWikiLink ? { kind: 'wikilink' as const } : {})
        };

        if (navigator(request) === false) return;

        event.preventDefault();
        event.stopPropagation();
      }

      public destroy(): void {
        this.view.dom.removeEventListener('mousedown', this.handleMouseDown, true);
      }
    }
  );
}

/** `posAtDOM` 在节点已脱离文档时会抛错，降级为 -1，不让一次点击炸掉整个编辑器。 */
function resolvePos(view: EditorView, element: HTMLElement): number {
  try {
    return view.posAtDOM(element, 0);
  } catch {
    return -1;
  }
}

/**
 * 把文档内相对链接解析成绝对路径（**纯字符串运算，不碰文件系统**）。
 *
 * 只处理 `./`、`../`、裸相对路径三类；`#fragment` 与 `?query` 在文件系统路径里没有意义，
 * 先剥掉。前导 `/` 按"相对当前文档目录"解释——本编辑器没有仓库根的概念，这是最贴近
 * 用户预期的一种，且明确优于静默失败。
 *
 * 回溯越过根目录、或剥完什么都不剩时返回 `null`：宁可不动，也不打开一个猜出来的越界路径。
 * 分隔符跟随 `directory`：Windows 路径还原成 `\`，POSIX 路径保留前导 `/`。
 */
export function resolveRelativePath(directory: string, href: string): string | null {
  const withoutFragment = href.split('#')[0] ?? '';
  const pathPart = withoutFragment.split('?')[0] ?? '';
  if (!pathPart) return null;

  const normalizedDir = directory.replace(/\\/g, '/');
  const isPosixAbsolute = normalizedDir.startsWith('/');
  const segments = normalizedDir.split('/').filter(Boolean);

  for (const segment of pathPart.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return null;

  const joined = segments.join(directory.includes('\\') && !isPosixAbsolute ? '\\' : '/');
  return isPosixAbsolute ? `/${joined}` : joined;
}
