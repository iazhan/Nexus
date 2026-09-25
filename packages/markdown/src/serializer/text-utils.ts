/**
 * 序列化层的纯文本工具：按换行切分并保留原换行符、转义表格单元格里的裸 `|`。
 */

export function splitLinesWithBreaks(str: string): { text: string; break: string }[] {
  const lines: { text: string; break: string }[] = [];
  let start = 0;
  while (start < str.length) {
    const nextNl = str.indexOf('\n', start);
    if (nextNl === -1) {
      lines.push({ text: str.slice(start), break: '' });
      break;
    }
    if (nextNl > start && str[nextNl - 1] === '\r') {
      lines.push({ text: str.slice(start, nextNl - 1), break: '\r\n' });
    } else {
      lines.push({ text: str.slice(start, nextNl), break: '\n' });
    }
    start = nextNl + 1;
  }
  return lines;
}

/**
 * Escapes unescaped pipe characters in table cell text to prevent breaking table structure.
 * Preserves already-escaped pipes (\|) and correctly handles escaped backslashes (\\| -> \\\|).
 */
export function escapeTableCellPipes(cellText: string): string {
  let result = '';
  let i = 0;
  while (i < cellText.length) {
    if (cellText[i] === '|') {
      let backslashes = 0;
      let k = i - 1;
      while (k >= 0 && cellText[k] === '\\') {
        backslashes++;
        k--;
      }
      if (backslashes % 2 === 0) {
        result += '\\';
      }
      result += '|';
      i++;
    } else {
      result += cellText[i];
      i++;
    }
  }
  return result;
}

