import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ATTACHMENT_DIRECTORY,
  DEFAULT_ATTACHMENT_NAME_TEMPLATE,
  attachmentExtension,
  expandAttachmentName,
  formatAttachmentReference,
  normalizeAttachmentDirectory,
  sanitizeFileNameSegment
} from '../src/index.js';

/** 固定时刻，避免用例依赖运行时的钟。 */
const NOW = new Date(2026, 8, 30, 18, 30, 5);

describe('expandAttachmentName', () => {
  it('默认模板展开成「前缀 + 日期-时间」', () => {
    expect(expandAttachmentName(DEFAULT_ATTACHMENT_NAME_TEMPLATE, NOW)).toBe(
      'pasted-20260930-183005'
    );
  });

  it('三个占位符各自展开，且同串里可以重复用', () => {
    expect(expandAttachmentName('{date}_{time}_{date}', NOW)).toBe('20260930_183005_20260930');
    expect(expandAttachmentName('{timestamp}', NOW)).toBe('20260930-183005');
  });

  it('不认识的占位符原样保留，不报错也不吞掉', () => {
    expect(expandAttachmentName('shot-{nope}-{date}', NOW)).toBe('shot-{nope}-20260930');
  });

  it('净化非法字符：路径分隔符与 Windows 保留字符换成 -', () => {
    expect(expandAttachmentName('a/b\\c:d*e?f"g<h>i|j', NOW)).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('去掉尾部的点与空格 —— 它们会被 Windows 静默吃掉，扩展名随之丢失', () => {
    expect(expandAttachmentName('shot.  ', NOW)).toBe('shot');
  });

  it('折叠连续空白，并去掉首尾空白', () => {
    expect(expandAttachmentName('  两  个   空格  ', NOW)).toBe('两 个 空格');
  });

  it('截到 100 字符上限', () => {
    const name = expandAttachmentName('x'.repeat(300), NOW);
    expect(name).toHaveLength(100);
  });

  it('展开后没有可辨认内容时退回默认模板的结果，而不是留一个空名字', () => {
    // 空名字 + 扩展名 = `.png`，那是个隐藏文件 —— 比「用回默认」难排查得多。
    expect(expandAttachmentName('', NOW)).toBe('pasted-20260930-183005');
    expect(expandAttachmentName('///', NOW)).toBe('pasted-20260930-183005');
    expect(expandAttachmentName('...', NOW)).toBe('pasted-20260930-183005');
    expect(expandAttachmentName('___', NOW)).toBe('pasted-20260930-183005');
  });

  it('中文模板算「有可辨认内容」，不会被退回默认', () => {
    expect(expandAttachmentName('图-{date}', NOW)).toBe('图-20260930');
  });
});

describe('sanitizeFileNameSegment', () => {
  it('控制字符被丢掉，不是换成 -', () => {
    expect(sanitizeFileNameSegment('a\u0000b\u001fc')).toBe('abc');
  });

  it('中段合法的点保留（扩展名不会被误伤）', () => {
    expect(sanitizeFileNameSegment('shot.v2')).toBe('shot.v2');
  });

  it('`#` 也换掉 —— 它在 Markdown 链接目标里是片段分隔符，留着会让图片永远空白', () => {
    expect(sanitizeFileNameSegment('a#b.png')).toBe('a-b.png');
    expect(expandAttachmentName('图#{date}', NOW)).toBe('图-20260930');
  });
});

describe('attachmentExtension', () => {
  it('原文件名的扩展名优先于 MIME', () => {
    // `image/svg+xml` 也可能是 `.svgz`，磁盘上的名字更权威。
    expect(attachmentExtension('logo.svgz', 'image/svg+xml')).toBe('.svgz');
  });

  it('剪贴板给的 image.png 直接可用', () => {
    expect(attachmentExtension('image.png', 'image/png')).toBe('.png');
  });

  it('原文件名没有扩展名时回落到 MIME 表', () => {
    expect(attachmentExtension('image', 'image/jpeg')).toBe('.jpg');
    expect(attachmentExtension('', 'image/webp')).toBe('.webp');
    expect(attachmentExtension('  ', 'image/avif')).toBe('.avif');
  });

  it('MIME 带大小写与空白也能认出', () => {
    expect(attachmentExtension('', '  IMAGE/PNG ')).toBe('.png');
  });

  it('过长的「扩展名」不算扩展名', () => {
    // `archive.tar.gz` 的 `.gz` 是扩展名，而整段 `tar.gz` 不是 —— 上界 8 拦掉后者。
    expect(attachmentExtension('a.verylongextension', 'image/png')).toBe('.png');
  });

  it('认不出来的类型返回空串，调用方据此不拦截这次粘贴', () => {
    expect(attachmentExtension('', 'image/x-canon-cr2')).toBe('');
    expect(attachmentExtension('image', 'application/octet-stream')).toBe('');
  });
});

describe('normalizeAttachmentDirectory', () => {
  it('原样保留一段普通目录名', () => {
    expect(normalizeAttachmentDirectory('assets')).toBe('assets');
  });

  it('保留多级相对目录', () => {
    expect(normalizeAttachmentDirectory('media/images')).toBe('media/images');
  });

  it('丢掉绝对前缀与盘符 —— 用户的意图明显是相对的那一段', () => {
    expect(normalizeAttachmentDirectory('D:/Note/assets')).toBe('Note/assets');
    expect(normalizeAttachmentDirectory('/var/assets')).toBe('var/assets');
    expect(normalizeAttachmentDirectory('\\\\host\\share\\assets')).toBe('host/share/assets');
  });

  it('丢掉 . 与 .. 段 —— 附件落在文档目录之外是越界写，不是可配置项', () => {
    expect(normalizeAttachmentDirectory('../secrets')).toBe('secrets');
    expect(normalizeAttachmentDirectory('./assets/../media')).toBe('assets/media');
  });

  it('反斜杠归一化成正斜杠', () => {
    expect(normalizeAttachmentDirectory('media\\images')).toBe('media/images');
  });

  it('空串 / 全是被丢掉的段 → 退回默认目录，而不是「与文档同目录」', () => {
    // 空串的语义是「与文档同目录」，那会和 attachmentLocation 选的「子目录」矛盾。
    expect(normalizeAttachmentDirectory('')).toBe(DEFAULT_ATTACHMENT_DIRECTORY);
    expect(normalizeAttachmentDirectory(null)).toBe(DEFAULT_ATTACHMENT_DIRECTORY);
    expect(normalizeAttachmentDirectory('..')).toBe(DEFAULT_ATTACHMENT_DIRECTORY);
    expect(normalizeAttachmentDirectory('  /  ')).toBe(DEFAULT_ATTACHMENT_DIRECTORY);
  });

  it('目录名里的非法字符同样净化', () => {
    expect(normalizeAttachmentDirectory('a:b/c*d')).toBe('a-b/c-d');
  });
});

describe('formatAttachmentReference', () => {
  it('普通路径裸写，不额外加尖括号', () => {
    expect(formatAttachmentReference('assets/pasted-20260930-183005.png', 'pasted-20260930-183005')).toBe(
      '![pasted-20260930-183005](assets/pasted-20260930-183005.png)'
    );
  });

  it('含空格或圆括号时用 <...> 包裹 —— 裸写会截断或提前收尾', () => {
    expect(formatAttachmentReference('my assets/a b.png', 'a b')).toBe(
      '![a b](<my assets/a b.png>)'
    );
    expect(formatAttachmentReference('shots/a(1).png', 'a(1)')).toBe('![a(1)](<shots/a(1).png>)');
  });

  it('alt 里的方括号转义 —— 不转义会把引用写坏', () => {
    expect(formatAttachmentReference('assets/a[1].png', 'a[1]')).toBe(
      '![a\\[1\\]](assets/a[1].png)'
    );
  });
});
