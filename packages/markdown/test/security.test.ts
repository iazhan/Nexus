import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from '../src/security.js';

describe('Security & URL Sanitization', () => {
  describe('Dangerous Protocols Rejection', () => {
    it('blocks javascript: URLs', () => {
      expect(sanitizeUrl('javascript:alert(1)').isBlocked).toBe(true);
      expect(sanitizeUrl('JAVASCRIPT:alert(1)').isBlocked).toBe(true);
      expect(sanitizeUrl('javascript:void(0)').isBlocked).toBe(true);
    });

    it('blocks vbscript: URLs', () => {
      expect(sanitizeUrl('vbscript:msgbox(1)').isBlocked).toBe(true);
    });

    it('blocks data: URLs', () => {
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>').isBlocked).toBe(true);
      expect(sanitizeUrl('data:image/svg+xml;utf8,<svg onload=alert(1)>').isBlocked).toBe(true);
    });

    it('blocks evasion attempts with control characters and whitespace', () => {
      expect(sanitizeUrl('java\0script:alert(1)').isBlocked).toBe(true);
      expect(sanitizeUrl('java\tscript:alert(1)').isBlocked).toBe(true);
      expect(sanitizeUrl('  javascript:alert(1)  ').isBlocked).toBe(true);
    });
  });

  describe('Safe Protocols and Paths Allowed', () => {
    it('allows https: and http: URLs', () => {
      expect(sanitizeUrl('https://github.com/google').isBlocked).toBe(false);
      expect(sanitizeUrl('http://example.com').isBlocked).toBe(false);
    });

    it('allows mailto: URLs', () => {
      expect(sanitizeUrl('mailto:admin@example.com').isBlocked).toBe(false);
    });

    it('allows relative paths and anchor links', () => {
      expect(sanitizeUrl('/docs/guide.md').isBlocked).toBe(false);
      expect(sanitizeUrl('./assets/logo.png').isBlocked).toBe(false);
      expect(sanitizeUrl('../sibling.md').isBlocked).toBe(false);
      expect(sanitizeUrl('#section-1').isBlocked).toBe(false);
      expect(sanitizeUrl('relative/path/image.jpg').isBlocked).toBe(false);
    });
  });
});
