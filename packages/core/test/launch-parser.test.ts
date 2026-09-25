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
      workspaceRoot: null,
      unsupportedPath: null
    });

    const empty2 = parseLaunchArgs(['electron', '.']);
    expect(empty2).toEqual({
      mode: 'lightweight',
      filePath: null,
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
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('2. should parse .md and .markdown file paths as lightweight mode and preserve original path', () => {
    const mdResult = parseLaunchArgs(['docs/readme.md']);
    expect(mdResult).toEqual({
      mode: 'lightweight',
      filePath: 'docs/readme.md',
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
      workspaceRoot: null,
      unsupportedPath: null
    });

    const upperResult = parseLaunchArgs(['CHANGELOG.MD']);
    expect(upperResult).toEqual({
      mode: 'lightweight',
      filePath: 'CHANGELOG.MD',
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('3. should handle unsupported file types by not opening them as markdown and recording unsupportedPath', () => {
    const pdfResult = parseLaunchArgs(['document.pdf']);
    expect(pdfResult).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'document.pdf'
    });

    const docxResult = parseLaunchArgs(['electron.exe', '.', 'report.docx']);
    expect(docxResult).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'report.docx'
    });

    const txtResult = parseLaunchArgs(['notes.txt']);
    expect(txtResult).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'notes.txt'
    });

    const noExtResult = parseLaunchArgs(['some_directory_or_binary']);
    expect(noExtResult).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'some_directory_or_binary'
    });
  });

  it('4. should ensure LaunchContext default value is stable and JSON-serializable', () => {
    expect(DEFAULT_LAUNCH_CONTEXT).toEqual({
      mode: 'lightweight',
      filePath: null,
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
  });

  it('5. should correctly handle production packaged executables without mistaking them for files', () => {
    // 5.1 Packaged app launch without files
    const prodEmpty = parseLaunchArgs([
      'C:\\Program Files\\Nexus\\Nexus.exe'
    ]);
    expect(prodEmpty).toEqual({
      mode: 'lightweight',
      filePath: null,
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
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 5.3 Packaged app opening unsupported document
    const prodPdf = parseLaunchArgs([
      'C:\\Program Files\\Nexus\\Nexus.exe',
      'D:\\Notes\\report.pdf'
    ]);
    expect(prodPdf).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'D:\\Notes\\report.pdf'
    });

    // 5.4 Packaged app with CLI flags and options.execPath
    const prodWithOpts = parseLaunchArgs(
      ['/opt/Nexus/nexus', '--no-sandbox', 'notes.md'],
      { execPath: '/opt/Nexus/nexus' }
    );
    expect(prodWithOpts).toEqual({
      mode: 'lightweight',
      filePath: 'notes.md',
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
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.2 inspect with host:port
    expect(
      parseLaunchArgs(['electron.exe', '--inspect', '127.0.0.1:9229'])
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.3 inspect followed by markdown file (not a port)
    expect(
      parseLaunchArgs(['electron.exe', '--inspect', 'README.md'])
    ).toEqual({
      mode: 'lightweight',
      filePath: 'README.md',
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
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.6 preserves markdown path after boolean flag
    expect(
      parseLaunchArgs(['Nexus.exe', '--no-sandbox', 'README.md'])
    ).toEqual({
      mode: 'lightweight',
      filePath: 'README.md',
      workspaceRoot: null,
      unsupportedPath: null
    });

    // 6.7 unsupported path after executable and flag
    expect(
      parseLaunchArgs([
        'Nexus.exe',
        '--log-file',
        'debug.log',
        'report.pdf'
      ])
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'report.pdf'
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
      workspaceRoot: null,
      unsupportedPath: null
    });
  });

  it('7. does not discard a real extensionless user path without runtime context', () => {
    expect(parseLaunchArgs(['LICENSE'])).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'LICENSE'
    });

    expect(parseLaunchArgs(['Makefile'])).toEqual({
      mode: 'lightweight',
      filePath: null,
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

  it('9. should keep non-directory targets unsupported even when classifyPath is provided', () => {
    expect(
      parseLaunchArgs(['report.pdf'], { classifyPath: () => 'file' })
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'report.pdf'
    });

    // unknown（路径不存在）同样不能进 workspace ——
    // 否则打错一个字就从"文件不存在"变成"打开一个空工作区"，错误被吞掉。
    expect(
      parseLaunchArgs(['D:\\Typo'], { classifyPath: () => 'unknown' })
    ).toEqual({
      mode: 'lightweight',
      filePath: null,
      workspaceRoot: null,
      unsupportedPath: 'D:\\Typo'
    });
  });

  it('10. should prefer the markdown extension over classifyPath', () => {
    // 扩展名先判：一个叫 notes.md 的目录不该被当成工作区，
    // 否则 workspaceRoot 会指向一个不是工作区的路径。
    expect(
      parseLaunchArgs(['notes.md'], { classifyPath: () => 'directory' })
    ).toEqual({
      mode: 'lightweight',
      filePath: 'notes.md',
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
      workspaceRoot: null,
      unsupportedPath: null
    });
  });
});
