// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { launchElectronApp, createTempDir, type ElectronAppInstance } from './smoke-harness.js';

/**
 * 粘贴图片落盘 + 插入引用（`files` 组的前置功能）。
 *
 * 为什么这条必须在真机上跑：整条链路有三段只有真机才连得起来 ——
 * 剪贴板的 `File` → `arrayBuffer()` → 一次真正的 IPC 写盘 → 引用最终写回文档。
 * 单测把「叫什么」「写进哪」「怎么拼引用」各自钉死了，但它们拼起来能不能用，
 * 只有这里能证明。
 *
 * **一次启动。** 四个用例共用同一个窗口，靠改设置切换形状（改设置是 `localStorage`
 * 写入 + 广播，不需要重开 Electron）。见 `memory/build-and-test.md` 的「同文件连续启动会卡死」。
 *
 * 用**轻量模式**（只打开一个文件）而不是工作区：那正是「资源根 = 文档所在目录」这条
 * 边界的情形 —— 工作区模式下 `workspaceRoots` 顺带覆盖了它，测不出这条路径。
 */

/** 一张最小合法 PNG（1×1）的前 33 字节。判「原样落盘」靠它。 */
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89
];

/** 读当前文档源码。`window.nexusSession` 是测试接缝。 */
const SOURCE_FN = `() => window.nexusSession?.getSnapshot().source ?? ''`;

/**
 * 在渲染进程里造一次真实的粘贴：`DataTransfer` 与 `ClipboardEvent` 都是浏览器原生对象，
 * 所以 `clipboardData.files` 与 `file.arrayBuffer()` 走的是真实现，不是替身。
 *
 * 派发目标是 `.cm-content`（CodeMirror 的 `contentDOM`）—— 剪贴板扩展挂在那里。
 */
function pasteFileExpression(fileName: string, mimeType: string, text = ''): string {
  return `(() => {
    const bytes = new Uint8Array(${JSON.stringify(PNG_BYTES)});
    const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });
    const data = new DataTransfer();
    data.items.add(file);
    ${text === '' ? '' : `data.setData('text/plain', ${JSON.stringify(text)});`}

    const target = document.querySelector('.cm-content');
    if (!target) return false;
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  })()`;
}

/** 目录里符合 `pattern` 的文件名。**不排序**：调用方只做集合断言。 */
function listMatching(directory: string, pattern: RegExp): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => pattern.test(name));
}

/** 本地时区的 `YYYYMMDD`。`toISOString()` 是 UTC，与模板的本地时间差 8 小时。 */
function localDateStamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 轮询磁盘上的文件内容，等自动保存把引用写回去。 */
async function waitForFileContent(
  filePath: string,
  needle: string,
  timeoutMs = 8000
): Promise<string> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    if (last.includes(needle)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`等待 ${filePath} 包含 ${needle} 超时，当前内容：${JSON.stringify(last)}`);
}

describe('粘贴图片：落盘 + 插入相对引用', () => {
  let tempDir: string;
  let documentPath: string;
  let app: ElectronAppInstance | null = null;

  beforeAll(async () => {
    tempDir = createTempDir('nexus-attach-');
    documentPath = path.join(tempDir, 'note.md');
    fs.writeFileSync(documentPath, '', 'utf-8');

    app = await launchElectronApp({ filePath: documentPath });
    await app.waitForSelector('.cm-content', 20000);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  beforeEach(async () => {
    if (!app) return;
    // 每个用例从干净状态开始：文档清空、三项设置回到默认。
    await app.setSource('');
    await app.evaluate(`(() => {
      window.nexusSettings.set('files.attachmentLocation', 'document');
      window.nexusSettings.set('files.attachmentDirectory', 'assets');
      window.nexusSettings.set('files.attachmentNameTemplate', 'pasted-{timestamp}');
      return true;
    })()`);
  });

  it('默认落在文档同目录，引用是相对路径，字节原样落盘', async () => {
    if (!app) throw new Error('app 未启动');

    const prevented = await app.evaluate<boolean>(pasteFileExpression('image.png', 'image/png'));
    expect(prevented).toBe(true);

    await app.waitForFunction(`(${SOURCE_FN})().includes('![')`, 10000);
    const source = await app.evaluate<string>(`(${SOURCE_FN})()`);

    const names = listMatching(tempDir, /^pasted-\d{8}-\d{6}\.png$/);
    expect(names).toHaveLength(1);
    const savedName = names[0] as string;

    // 引用指向刚落的那个文件，且是**相对**的（绝对路径换个机器就断）。
    expect(source).toBe(`![${savedName.slice(0, -4)}](${savedName})`);
    expect(source).not.toContain(tempDir);

    // 图片必须原样落盘：过一遍 utf-8 解码再编码会把 PNG 改坏。
    const written = fs.readFileSync(path.join(tempDir, savedName));
    expect([...written]).toEqual(PNG_BYTES);

    // 引用最终写回磁盘（自动保存）。
    const onDisk = await waitForFileContent(documentPath, savedName);
    expect(onDisk).toContain(`](${savedName})`);
  });

  it('改成子目录后，文件与引用都跟着进子目录', async () => {
    if (!app) throw new Error('app 未启动');

    await app.evaluate(`(() => {
      window.nexusSettings.set('files.attachmentLocation', 'directory');
      window.nexusSettings.set('files.attachmentDirectory', 'imgs');
      return true;
    })()`);

    await app.evaluate<boolean>(pasteFileExpression('image.png', 'image/png'));
    await app.waitForFunction(`(${SOURCE_FN})().includes('imgs/')`, 10000);

    const source = await app.evaluate<string>(`(${SOURCE_FN})()`);
    const names = listMatching(path.join(tempDir, 'imgs'), /^pasted-\d{8}-\d{6}\.png$/);
    expect(names).toHaveLength(1);
    const savedName = names[0] as string;

    expect(source).toBe(`![${savedName.slice(0, -4)}](imgs/${savedName})`);
  });

  it('模板决定名字；同名时由主进程加后缀而不是覆盖', async () => {
    if (!app) throw new Error('app 未启动');

    // 模板里只有日期，没有秒 —— 同一天粘两张必然同名，重名去重只有主进程做得了。
    await app.evaluate(`(() => {
      window.nexusSettings.set('files.attachmentNameTemplate', '图-{date}');
      return true;
    })()`);

    await app.evaluate<boolean>(pasteFileExpression('image.png', 'image/png'));
    await app.waitForFunction(`(${SOURCE_FN})().includes('图-')`, 10000);
    await app.evaluate<boolean>(pasteFileExpression('image.png', 'image/png'));
    await app.waitForFunction(`(${SOURCE_FN})().split('![').length === 3`, 10000);

    const source = await app.evaluate<string>(`(${SOURCE_FN})()`);
    const stamp = localDateStamp();
    const names = listMatching(tempDir, /^图-\d{8}(-\d+)?\.png$/);

    expect(names).toHaveLength(2);
    expect(names).toContain(`图-${stamp}.png`);
    expect(names).toContain(`图-${stamp}-1.png`);

    // 两条引用各指一个文件 —— 第二条没有把第一条覆盖掉。
    expect(source).toContain(`](图-${stamp}.png)`);
    expect(source).toContain(`](图-${stamp}-1.png)`);
  });

  it('类型认不出来时不落盘，并退回剪贴板里的文本', async () => {
    if (!app) throw new Error('app 未启动');

    const before = listMatching(tempDir, /\.(png|jpg|tif)$/);

    // `image/x-canon-cr2` 不在 MIME 表里，文件名也没有扩展名 —— 落盘没有意义，
    // 猜一个 `.bin` 出来只会得到一个扩展名与内容不符的文件。
    await app.evaluate<boolean>(
      pasteFileExpression('image', 'image/x-canon-cr2', 'C:\\shots\\a.cr2')
    );
    await app.waitForFunction(`(${SOURCE_FN})().includes('a.cr2')`, 10000);

    const source = await app.evaluate<string>(`(${SOURCE_FN})()`);
    // 退回文本而不是静默空操作 —— 否则用户看得见剪贴板里有东西，粘下去什么都没发生。
    expect(source).toBe('C:\\shots\\a.cr2');
    expect(listMatching(tempDir, /\.(png|jpg|tif)$/)).toEqual(before);
  });
});
