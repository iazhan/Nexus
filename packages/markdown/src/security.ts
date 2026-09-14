export interface UrlSanitizeResult {
  safeUrl: string | null;
  isBlocked: boolean;
  reason?: string;
}

const BLOCKED_PROTOCOLS = new Set([
  'javascript:',
  'vbscript:',
  'data:',
  'file:'
]);

const ALLOWED_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:'
]);

/**
 * Strips ASCII and Unicode whitespace and control characters from URL strings
 * to prevent evasion techniques (e.g. "java\tscript:").
 */
function cleanUrlString(url: string): string {
  // eslint-disable-next-line no-control-regex
  return url.replace(/[\u0000-\u001F\u007F\s]+/g, '');
}

/**
 * Sanitizes URLs for links and images to prevent script injection (XSS)
 * and dangerous protocol execution.
 */
export function sanitizeUrl(rawUrl: string | null | undefined): UrlSanitizeResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return {
      safeUrl: null,
      isBlocked: false,
      reason: 'Empty or invalid URL'
    };
  }

  const cleaned = cleanUrlString(rawUrl);

  // Relative URLs, anchors, or relative path references are permitted
  if (
    cleaned.startsWith('/') ||
    cleaned.startsWith('./') ||
    cleaned.startsWith('../') ||
    cleaned.startsWith('#') ||
    cleaned.startsWith('?')
  ) {
    return {
      safeUrl: rawUrl,
      isBlocked: false
    };
  }

  // Extract scheme if present (e.g. "https:", "javascript:")
  const colonIdx = cleaned.indexOf(':');
  if (colonIdx !== -1) {
    const slashIdx = cleaned.indexOf('/');
    const questionIdx = cleaned.indexOf('?');
    const hashIdx = cleaned.indexOf('#');

    // If colon occurs before any path/query separator, it indicates a protocol scheme
    const isScheme =
      (slashIdx === -1 || colonIdx < slashIdx) &&
      (questionIdx === -1 || colonIdx < questionIdx) &&
      (hashIdx === -1 || colonIdx < hashIdx);

    if (isScheme) {
      const scheme = cleaned.slice(0, colonIdx + 1).toLowerCase();

      if (BLOCKED_PROTOCOLS.has(scheme)) {
        return {
          safeUrl: null,
          isBlocked: true,
          reason: `Blocked dangerous URL protocol: ${scheme}`
        };
      }

      if (!ALLOWED_PROTOCOLS.has(scheme)) {
        return {
          safeUrl: null,
          isBlocked: true,
          reason: `Unsupported URL protocol: ${scheme}`
        };
      }

      return {
        safeUrl: rawUrl,
        isBlocked: false
      };
    }
  }

  // URLs without a protocol scheme are considered relative paths (e.g. "images/sample.png")
  return {
    safeUrl: rawUrl,
    isBlocked: false
  };
}
