/**
 * 粘贴附件的命名与落点（`files` 分组）。
 *
 * 三件事分成三个纯函数，各自有单测：**叫什么**（`expandAttachmentName`）、
 * **扩展名是什么**（`attachmentExtension`）、**放在哪个子目录**（`normalizeAttachmentDirectory`）。
 * 拼起来只是「文档目录 + 子目录 + 名字 + 扩展名」，那一步留给宿主 —— 因为它要碰文件系统。
 *
 * 这个模块**不认识剪贴板，也不认识 IPC**：输入是「模板串 + 时间 + 原文件名 + MIME」，
 * 输出是「名字片段」。于是这三条规则可以在普通 Node 下测完，不必冷启动 Electron，
 * 也不必造一个 `File` 对象。
 *
 * ## 为什么名字必须由模板算，而不是直接用原文件名
 *
 * 剪贴板里的图片叫 `image.png`（Chromium 给的名字），同一个目录连粘两张就是重名；
 * 而截图本来就没有有意义的文件名 —— 时间戳反而是唯一可检索的信息。所以默认模板是
 * `pasted-{timestamp}`，用户想改成 `图-{date}` 也可以。
 *
 * **模板不含扩展名**：扩展名来自实际内容（`attachmentExtension`），让用户填
 * 是给他一个必然填错的机会（改了模板却忘了改扩展名 → 文件被当成别的类型）。
 */

/** 默认子目录名。`attachmentLocation` 选「子目录」而目录名留空时用它。 */
export const DEFAULT_ATTACHMENT_DIRECTORY = 'assets';

/** 默认命名模板。`{timestamp}` 到秒，连粘两张也能区分。 */
export const DEFAULT_ATTACHMENT_NAME_TEMPLATE = 'pasted-{timestamp}';

/**
 * 文件名片段的上限。留足余量给「目录 + 扩展名 + 去重后缀」，同时不逼近
 * Windows 的 260 字符总路径上限 —— 真实工作区里目录本来就不浅。
 */
const MAX_NAME_LENGTH = 100;

/**
 * MIME → 扩展名。只列**剪贴板里真的会出现**的那几种图片类型。
 *
 * 不做「任意 MIME 猜扩展名」：猜错比猜不出更糟 —— `image/x-canon-cr2` 猜成 `.cr2`
 * 还算走运，猜成 `.bin` 就是一个扩展名与内容不符的文件，而用户不会去核对。
 * 认不出来时 `attachmentExtension` 返回空串，调用方据此**不拦截这次粘贴**
 * （与「剪贴板里只有图片、没有文本」时的现状一致，不是新的退化）。
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/tiff': '.tif'
};

/** 模板里认得的占位符。写错的花括号原样保留，不报错也不吞掉。 */
const PLACEHOLDER_PATTERN = /\{(timestamp|date|time)\}/g;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * 时间占位符的取值。
 *
 * `timestamp` 里那个 `-` 是刻意的：`pasted-20260930-183000` 里两段时间一眼能分开，
 * 而 `pasted-20260930183000` 是一串 14 位数字，看不出年月日在哪断。
 */
function placeholderValues(now: Date): Record<string, string> {
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  const date = `${year}${month}${day}`;
  const time = `${hours}${minutes}${seconds}`;
  return { timestamp: `${date}-${time}`, date, time };
}

/**
 * 展开命名模板，得到**不含扩展名**的文件名片段。
 *
 * 净化规则是「Windows 上会被拒绝或被静默改掉的东西」：非法字符换成 `-`，
 * 尾部的点与空格去掉（`a.` 存进去会变成 `a`，扩展名就没了），控制字符丢掉，
 * 连续空白折成一个空格，最后截到 `MAX_NAME_LENGTH`。
 *
 * **净化后一个字母或数字都不剩时退回默认模板的结果。** 判据是「还有没有可辨认的内容」，
 * 而不是「是不是空串」—— `///` 净化成 `---`、`...` 净化成空串，两者都合法却都不是用户
 * 的意思（那是清空输入框、或误把路径粘进来的形态）。落一个 `---` 比落 `pasted-…`
 * 难排查得多：前者看着像是「程序出错了」。
 */
export function expandAttachmentName(template: string, now: Date): string {
  const values = placeholderValues(now);
  const expanded = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => values[key] ?? '');
  const sanitized = sanitizeFileNameSegment(expanded);
  if (MEANINGFUL_CHARACTER_PATTERN.test(sanitized)) return sanitized;

  return sanitizeFileNameSegment(
    DEFAULT_ATTACHMENT_NAME_TEMPLATE.replace(
      PLACEHOLDER_PATTERN,
      (_match, key: string) => values[key] ?? ''
    )
  );
}

/**
 * 「这个名字里还有可辨认的内容」。用 `\p{L}` / `\p{N}` 而不是 `[A-Za-z0-9]`：
 * 模板里写中文（`图-{date}`）是完全正常的用法。
 */
const MEANINGFUL_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;

/**
 * 净化一个文件名片段。导出的目的是让「用户输入的模板」与「别处拼进来的名字」
 * 走同一条规则 —— 两条规则迟早分叉，而分叉的症状是「某个入口存出来的文件名带问号」。
 *
 * `#` 也在被换掉的那一类里，虽然它在 Windows 上是合法文件名字符。理由是**引用写不出来**：
 * Markdown 的链接目标是 `![](路径)`，`#` 在那里是片段分隔符（`a.png#page=1`），
 * 于是 `a#b.png` 会被解析成「文件 `a`、片段 `b.png`」—— 图片永远空白。
 * 转义成 `%23` 也救不回来：索引侧用 `decodeURIComponent`、渲染侧用 `decodeURI`，
 * 两边对 `%23` 的处理不一致（后者不还原保留字符）。与其在两处对齐，不如不让它出现。
 */
export function sanitizeFileNameSegment(raw: string): string {
  const replaced = raw
    // 非法字符：`< > : " / \ | ? *`，以及 `#`（见上）。
    // 换成 `-` 而不是删掉 —— `a/b` 删成 `ab` 是另一个名字，`a-b` 至少还看得出原来断开过。
    .replace(/[<>:"/\\|?*#]/g, '-')
    // 控制字符（含 0x00–0x1F）直接丢：它们在文件名里没有意义，且会让 stat 抛错。
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 尾部的点与空格：Windows 会静默去掉，`a.` 于是变成 `a`，扩展名被吃掉。
    .replace(/[. ]+$/, '');

  const capped = replaced.length > MAX_NAME_LENGTH ? replaced.slice(0, MAX_NAME_LENGTH) : replaced;
  return capped.replace(/[. ]+$/, '');
}

/**
 * 附件扩展名（含前导点）。**认不出来时返回空串**，见 `MIME_EXTENSIONS` 的注释。
 *
 * 原文件名优先于 MIME：用户从别处复制过来的文件带着自己的扩展名，那是更权威的信息
 * （例如 `image/svg+xml` 与 `.svgz` 是两种不同的东西）。但原文件名要**先过一遍
 * 合法性检查** —— 剪贴板给的名字是 `image` 这种没有扩展名的形式时，`lastIndexOf('.')`
 * 会返回 -1，不能顺手把整段当扩展名。
 */
export function attachmentExtension(originalName: string, mimeType: string): string {
  const normalizedName = originalName.trim().replace(/\\/g, '/');
  const baseName = normalizedName.slice(normalizedName.lastIndexOf('/') + 1);
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex > 0) {
    const candidate = baseName.slice(dotIndex);
    // 只接受 `.png` / `.jpeg` 这类短扩展名。上界 8 是常见最长值（`.markdown` 是 9，
    // 但它不是图片）；放宽会让 `archive.tar.gz` 的 `.gz` 被当成 `.tar.gz`。
    if (/^\.[A-Za-z0-9]{1,8}$/.test(candidate)) return candidate.toLowerCase();
  }

  return MIME_EXTENSIONS[mimeType.trim().toLowerCase()] ?? '';
}

/**
 * 把设置里的子目录串归一化成**相对文档目录的一段路径**。
 *
 * 绝对路径、盘符、UNC 前缀一律丢掉前导部分而不是拒绝整串：用户填
 * `D:/Note/assets` 的意图明显是 `assets`，报错只会让他再猜一次格式。
 * `..` 段整段丢弃 —— 附件落在文档目录之外是**越界写**，不是可配置项。
 *
 * 归一化后没有可辨认的内容（用户清空了输入框、或整串都是 `../`）时返回默认的 `assets`，
 * 而不是空串：空串的语义是「与文档同目录」，那会和 `attachmentLocation`
 * 选的「子目录」直接矛盾 —— 一个设置项不该被另一个设置项的内容反向推翻。
 */
export function normalizeAttachmentDirectory(raw: string | null | undefined): string {
  const segments = (raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    // 盘符段（`D:`）单独丢：它过一遍净化会变成 `D-`，那是个真实存在的目录名，
    // 于是「丢掉绝对前缀」这件事会在净化这一步被悄悄取消。
    .filter(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !/^[A-Za-z]:$/.test(segment)
    )
    .map((segment) => sanitizeFileNameSegment(segment))
    .filter(Boolean);

  return segments.length > 0 ? segments.join('/') : DEFAULT_ATTACHMENT_DIRECTORY;
}

/**
 * 拼出一条可直接插进 Markdown 的图片引用。
 *
 * 与 `formatDocumentCitation`（`citation.ts`）同形 —— 那边拼链接、这里拼图片，
 * 两处都出现过的坑不该各修一遍。三处细节各有理由：
 *
 * - **alt 里的 `[` `]` 转义**：不转义会把引用写坏，症状是「粘进去之后少了半截」。
 * - **路径含空格或圆括号时用 `<...>` 包裹**（CommonMark 允许）：裸写形式下空格直接
 *   结束目标（`![](my shot.png)` 只认到 `my`），而 `)` 会被当成目标的收尾。
 *   两种字符在 Windows 文件名里都合法，所以包裹而不是把它们从文件名里删掉。
 * - **alt 由调用方给（文件名去扩展名）**：图片被挡下时（越界、类型不在白名单），
 *   视觉投影显示的就是 alt —— 空 alt 会让用户看到一块什么都没有的占位。
 */
export function formatAttachmentReference(relativePath: string, alt: string): string {
  const label = alt.replace(/[[\]]/g, '\\$&');
  const destination = /[\s()]/.test(relativePath) ? `<${relativePath}>` : relativePath;
  return `![${label}](${destination})`;
}
