import { describe, it, expect } from 'vitest';
import {
  parseLaunchArgs,
  DEFAULT_LAUNCH_CONTEXT,
  type LaunchContext
} from '../src/index.js';

describe('Launch Arguments Parser and Context', () => {
  it('1. should parse empty arguments as lightweight empty state', () => {
    const empty1 = parseLaunchArgs([]);
    expect(empty1).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    const empty2 = parseLaunchArgs(['electron', '.']);
    expect(empty2).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    const empty3 = parseLaunchArgs([
      'C:\\tools\\electron.exe',
      'apps/desktop',
      '--no-sandbox',
      '--inspect=9229'
    ]);
    expect(empty3).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('2. should parse .md and .markdown file paths as lightweight mode and preserve original path', () => {
    const mdResult = parseLaunchArgs(['docs/readme.md']);
    expect(mdResult).toEqual({
      mode: 'lightweight',
      filePath: 'docs/readme.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });

    const winPath = 'D:\\Projects\\Codex\\Nexus\\docs\\notes.markdown';
    const markdownResult = parseLaunchArgs([
      'electron.exe',
      '.',
      '--enable-logging',
      winPath
    ]);
    expect(markdownResult).toEqual({
      mode: 'lightweight',
      filePath: winPath,
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });

    const upperResult = parseLaunchArgs(['CHANGELOG.MD']);
    expect(upperResult).toEqual({
      mode: 'lightweight',
      filePath: 'CHANGELOG.MD',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('3. should route whitelisted non-Markdown documents to viewer mode', () => {
    // Phase 3 起 PDF / DOCX / 图片进入白名单，不再是「不支持的文件」。
    // 它们的共同点是**严格只读** —— 有查看器，没有编辑与保存路径。
    const pdfResult = parseLaunchArgs(['document.pdf']);
    expect(pdfResult).toEqual({
      mode: 'viewer',
      filePath: 'document.pdf',
      documentType: 'pdf',
      workspaceRoot: null,
      unsupportedPath: null
    });

    const docxResult = parseLaunchArgs(['electron.exe', '.', 'report.docx']);
    expect(docxResult).toEqual({
      mode: 'viewer',
      filePath: 'report.docx',
      documentType: 'docx',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 图片扩展名各有各的写法，但都归到同一个 documentType
    const pngResult = parseLaunchArgs(['diagram.png']);
    expect(pngResult.documentType).toBe('image');
    expect(parseLaunchArgs(['photo.JPEG']).documentType).toBe('image');
    expect(parseLaunchArgs(['icon.svg']).documentType).toBe('image');
  });

  it('3b. should record unsupportedPath for extensions outside the whitelist', () => {
    const txtResult = parseLaunchArgs(['notes.txt']);
    expect(txtResult).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: 'notes.txt'
    });

    const noExtResult = parseLaunchArgs(['some_directory_or_binary']);
    expect(noExtResult).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: 'some_directory_or_binary'
    });
  });

  it('4. should ensure LaunchContext default value is stable and JSON-serializable', () => {
    expect(DEFAULT_LAUNCH_CONTEXT).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    // Object is frozen to prevent accidental mutation
    expect(Object.isFrozen(DEFAULT_LAUNCH_CONTEXT)).toBe(true);

    // Serialization test
    const serialized = JSON.stringify(DEFAULT_LAUNCH_CONTEXT);
    const parsed: LaunchContext = JSON.parse(serialized);

    expect(parsed).toEqual(DEFAULT_LAUNCH_CONTEXT);
    expect(parsed.mode).toBe('lightweight');
    expect(parsed.filePath).toBeNull();
    expect(parsed.workspaceRoot).toBeNull();
    expect(parsed.unsupportedPath).toBeNull();
    expect(parsed.documentType).toBeNull();
  });

  it('5. should correctly handle production packaged executables without mistaking them for files', () => {
    // 5.1 Packaged app launch without files
    const prodEmpty = parseLaunchArgs([
      'C:\\Program Files\\Nexus\\Nexus.exe'
    ]);
    expect(prodEmpty).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 5.2 Packaged app opening Markdown document
    const prodMd = parseLaunchArgs([
      'C:\\Program Files\\Nexus\\Nexus.exe',
      'D:\\Notes\\README.md'
    ]);
    expect(prodMd).toEqual({
      mode: 'lightweight',
      filePath: 'D:\\Notes\\README.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 5.3 Packaged app opening a whitelisted non-Markdown document
    const prodPdf = parseLaunchArgs([
      'C:\\Program Files\\Nexus\\Nexus.exe',
      'D:\\Notes\\report.pdf'
    ]);
    expect(prodPdf).toEqual({
      mode: 'viewer',
      filePath: 'D:\\Notes\\report.pdf',
      documentType: 'pdf',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 5.4 Packaged app with CLI flags and options.execPath
    const prodWithOpts = parseLaunchArgs(
      ['/opt/Nexus/nexus', '--no-sandbox', 'notes.md'],
      { execPath: '/opt/Nexus/nexus' }
    );
    expect(prodWithOpts).toEqual({
      mode: 'lightweight',
      filePath: 'notes.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('6. should correctly handle CLI flags with separate values without treating values as files', () => {
    // 6.1 ignores separate-value inspect flags
    expect(
      parseLaunchArgs(['electron.exe', '--inspect', '9229'])
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.2 inspect with host:port
    expect(
      parseLaunchArgs(['electron.exe', '--inspect', '127.0.0.1:9229'])
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.3 inspect followed by markdown file (not a port)
    expect(
      parseLaunchArgs(['electron.exe', '--inspect', 'README.md'])
    ).toEqual({
      mode: 'lightweight',
      filePath: 'README.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.4 ignores separate-value user-data-dir flags
    expect(
      parseLaunchArgs([
        'electron.exe',
        '--user-data-dir',
        'C:\\Temp\\Nexus'
      ])
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.5 preserves a markdown path after runtime flags with values
    expect(
      parseLaunchArgs([
        'Nexus.exe',
        '--user-data-dir',
        'C:\\Temp\\Nexus',
        'D:\\Notes\\README.md'
      ])
    ).toEqual({
      mode: 'lightweight',
      filePath: 'D:\\Notes\\README.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.6 preserves markdown path after boolean flag
    expect(
      parseLaunchArgs(['Nexus.exe', '--no-sandbox', 'README.md'])
    ).toEqual({
      mode: 'lightweight',
      filePath: 'README.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.7 whitelisted document after executable and flag：
    // filePath 是 report.pdf 而不是 debug.log，说明 flag 的值确实被跳过了
    expect(
      parseLaunchArgs([
        'Nexus.exe',
        '--log-file',
        'debug.log',
        'report.pdf'
      ])
    ).toEqual({
      mode: 'viewer',
      filePath: 'report.pdf',
      documentType: 'pdf',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.8 custom additionalValueFlags
    expect(
      parseLaunchArgs(
        ['Nexus.exe', '--custom-config', 'my-config.json', 'notes.md'],
        { additionalValueFlags: ['--custom-config'] }
      )
    ).toEqual({
      mode: 'lightweight',
      filePath: 'notes.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('7. does not discard a real extensionless user path without runtime context', () => {
    expect(parseLaunchArgs(['LICENSE'])).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: 'LICENSE'
    });

    expect(parseLaunchArgs(['Makefile'])).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: 'Makefile'
    });
  });

  it('8. should enter workspace mode when the target is a directory', () => {
    const classifyPath = (targetPath: string): 'directory' | 'file' | 'unknown' =>
      targetPath === 'D:\\Notes' || targetPath === '/home/me/notes' ? 'directory' : 'file';

    const winDir = parseLaunchArgs(
      ['C:\\Program Files\\Nexus\\Nexus.exe', 'D:\\Notes'],
      { classifyPath }
    );
    expect(winDir).toEqual({
      mode: 'workspace',
      filePath: null,
      documentType: null,
      workspaceRoot: 'D:\\Notes',
      unsupportedPath: null
    });

    const posixDir = parseLaunchArgs(['/opt/Nexus/nexus', '/home/me/notes'], {
      execPath: '/opt/Nexus/nexus',
      classifyPath
    });
    expect(posixDir).toEqual({
      mode: 'workspace',
      filePath: null,
      documentType: null,
      workspaceRoot: '/home/me/notes',
      unsupportedPath: null
    });

    // 目录也可以带空格
    const spacedDir = parseLaunchArgs(['Nexus.exe', 'D:\\My Notes'], {
      classifyPath: (p) => (p === 'D:\\My Notes' ? 'directory' : 'file')
    });
    expect(spacedDir.mode).toBe('workspace');
    expect(spacedDir.workspaceRoot).toBe('D:\\My Notes');
  });

  it('9. should keep non-whitelisted, non-directory targets unsupported even when classifyPath is provided', () => {
    expect(
      parseLaunchArgs(['notes.txt'], { classifyPath: () => 'file' })
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: 'notes.txt'
    });

    // unknown（路径不存在）同样不能进 workspace ——
    // 否则打错一个字就从"文件不存在"变成"打开一个空工作区"，错误被吞掉。
    expect(
      parseLaunchArgs(['D:\\Typo'], { classifyPath: () => 'unknown' })
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: 'D:\\Typo'
    });
  });

  it('10. should prefer the document whitelist over classifyPath', () => {
    // 扩展名先判：一个叫 notes.md 的目录不该被当成工作区，
    // 否则 workspaceRoot 会指向一个不是工作区的路径。
    expect(
      parseLaunchArgs(['notes.md'], { classifyPath: () => 'directory' })
    ).toEqual({
      mode: 'lightweight',
      filePath: 'notes.md',
      documentType: 'markdown',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 非 Markdown 的白名单文档同理。这一步不能交给 classifyPath ——
    // 它只回答「目录还是文件」，答不出文档类型，report.pdf 会被判成 workspace。
    expect(
      parseLaunchArgs(['report.pdf'], { classifyPath: () => 'directory' })
    ).toEqual({
      mode: 'viewer',
      filePath: 'report.pdf',
      documentType: 'pdf',
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('11. should not treat flag values as workspace roots', () => {
    // --user-data-dir 的值是目录，但它属于 flag 的值，不是用户要打开的工作区
    expect(
      parseLaunchArgs(
        ['Nexus.exe', '--user-data-dir', 'C:\\Temp\\Nexus'],
        { classifyPath: () => 'directory' }
      )
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      documentType: null,
      workspaceRoot: null,
      unsupportedPath: null
    });
  });
});
