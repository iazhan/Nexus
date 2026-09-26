import { describe, it, expect } from 'vitest';
import {
  documentTypeForPath,
  getPathExtension,
  isMarkdownPath,
  supportedDocumentExtensions,
  type DocumentType
} from '../src/index.js';

describe('Document extension whitelist', () => {
  describe('getPathExtension', () => {
    it('returns the lowercased extension including the leading dot', () => {
      expect(getPathExtension('notes.md')).toBe('.md');
      expect(getPathExtension('CHANGELOG.MD')).toBe('.md');
      expect(getPathExtension('report.Pdf')).toBe('.pdf');
    });

    it('reads the extension from the file name, not from a directory in the path', () => {
      expect(getPathExtension('docs.v2/readme')).toBe('');
      expect(getPathExtension('D:\\Notes.v2\\README.md')).toBe('.md');
      expect(getPathExtension('/home/me/notes.markdown')).toBe('.markdown');
    });

    it('handles multi-dot file names by taking the last dot', () => {
      expect(getPathExtension('archive.tar.gz')).toBe('.gz');
      expect(getPathExtension('v1.2.3.md')).toBe('.md');
    });

    it('returns an empty string for paths without an extension', () => {
      expect(getPathExtension('LICENSE')).toBe('');
      expect(getPathExtension('Makefile')).toBe('');
      expect(getPathExtension('')).toBe('');
      expect(getPathExtension('dir/')).toBe('');
      expect(getPathExtension('file.')).toBe('.');
    });

    it('treats dotfiles as extensionless', () => {
      // `.gitignore` 的最后一个点在下标 0 —— 若不用 `lastDot <= 0` 兜住，
      // 它会被当成「扩展名是 .gitignore 的文件」。
      expect(getPathExtension('.gitignore')).toBe('');
      expect(getPathExtension('.env.local')).toBe('.local');
      expect(getPathExtension('dir/.gitignore')).toBe('');
    });
  });

  describe('documentTypeForPath', () => {
    it('maps every whitelisted extension back to its registered type', () => {
      // 这条断言的作用是「白名单自洽」：登记了某个扩展名，
      // 就一定能被解析回同一个类型，不会出现「登记了却打不开」。
      const expected: Record<string, DocumentType> = {
        '.md': 'markdown',
        '.markdown': 'markdown',
        '.pdf': 'pdf',
        '.docx': 'docx',
        '.png': 'image',
        '.jpg': 'image',
        '.jpeg': 'image',
        '.gif': 'image',
        '.webp': 'image',
        '.bmp': 'image',
        '.svg': 'image'
      };

      expect([...supportedDocumentExtensions()].sort()).toEqual(
        Object.keys(expected).sort()
      );

      for (const [extension, type] of Object.entries(expected)) {
        expect(documentTypeForPath(`file${extension}`)).toBe(type);
        expect(documentTypeForPath(`file${extension.toUpperCase()}`)).toBe(type);
      }
    });

    it('returns null for extensions outside the whitelist', () => {
      // 白名单而不是黑名单：没登记的一律不认，包括「看起来像文档」的那些。
      expect(documentTypeForPath('notes.txt')).toBeNull();
      expect(documentTypeForPath('script.ts')).toBeNull();
      expect(documentTypeForPath('sheet.xlsx')).toBeNull();
      expect(documentTypeForPath('deck.pptx')).toBeNull();
      expect(documentTypeForPath('archive.doc')).toBeNull();
      expect(documentTypeForPath('LICENSE')).toBeNull();
      expect(documentTypeForPath('.gitignore')).toBeNull();
      expect(documentTypeForPath('dir/')).toBeNull();
    });
  });

  describe('isMarkdownPath', () => {
    it('is true only for the markdown extensions', () => {
      expect(isMarkdownPath('README.md')).toBe(true);
      expect(isMarkdownPath('D:\\Notes\\a.MARKDOWN')).toBe(true);
      expect(isMarkdownPath('report.pdf')).toBe(false);
      expect(isMarkdownPath('photo.png')).toBe(false);
      expect(isMarkdownPath('notes.txt')).toBe(false);
      expect(isMarkdownPath('LICENSE')).toBe(false);
    });
  });

  describe('supportedDocumentExtensions', () => {
    it('is frozen so callers cannot mutate the shared whitelist', () => {
      const extensions = supportedDocumentExtensions();
      expect(Object.isFrozen(extensions)).toBe(true);
    });
  });
});
