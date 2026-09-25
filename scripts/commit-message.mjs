#!/usr/bin/env node
/**
 * 校验提交信息格式与长度（commit-msg hook）。
 *
 * 规范见 COMMIT_CONVENTION.md。由 .githooks/commit-msg 调用，
 * 参数是 git 传入的 COMMIT_EDITMSG 路径。
 *
 * 只校验标题行：格式、长度、英文。body 允许但非必需（规范里默认不写）。
 */

import { readFile } from 'node:fs/promises';

/** 整行硬上限，保证 git log --oneline 不折行。 */
const MAX_SUBJECT_LINE = 72;
/** subject 部分的建议长度，超过只提示不拦。 */
const SOFT_SUBJECT_LENGTH = 50;

const TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'chore',
  'docs',
  'test',
  'style'
];

const SCOPE_PATTERN = /^[a-z0-9]+(?:[,-][a-z0-9]+)*$/;
const SUBJECT_PATTERN = new RegExp(`^(${TYPES.join('|')})(?:\\(([^)]*)\\))?: (.+)$`);

/** git 自己生成的信息不适用本规范，直接放行。 */
const EXEMPT_PREFIXES = ['Merge ', 'Revert ', 'fixup! ', 'squash! ', 'amend! '];

const messageFile = process.argv[2];

if (!messageFile) {
  console.error('用法: node scripts/commit-message.mjs <COMMIT_EDITMSG 路径>');
  process.exit(1);
}

const raw = await readFile(messageFile, 'utf8');

// 去掉注释行与尾随空行，留下真正的信息内容
const lines = raw.split(/\r?\n/).filter((line) => !line.startsWith('#'));
while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
  lines.pop();
}

// 空信息由 git 自己拒绝（除非 --allow-empty-message），不在这里重复报错
if (lines.length === 0) {
  process.exit(0);
}

const subject = lines[0];

if (EXEMPT_PREFIXES.some((prefix) => subject.startsWith(prefix))) {
  process.exit(0);
}

const errors = [];

if (/[\u4e00-\u9fff]/.test(subject)) {
  errors.push('必须用英文');
}

if (subject.length > MAX_SUBJECT_LINE) {
  errors.push(`标题 ${subject.length} 字符，超过上限 ${MAX_SUBJECT_LINE}`);
}

const match = SUBJECT_PATTERN.exec(subject);

if (!match) {
  errors.push('格式必须是 <type>(<scope>): <subject>');
} else {
  const [, , scope, text] = match;

  if (scope !== undefined && !SCOPE_PATTERN.test(scope)) {
    errors.push(`scope "${scope}" 只能是逗号分隔的小写标识（如 editor,desktop）`);
  }

  if (/^[A-Z]/.test(text)) {
    errors.push('subject 用小写开头（祈使句）');
  }

  if (text.trimEnd().endsWith('.')) {
    errors.push('subject 结尾不要句号');
  }

  if (text.length > SOFT_SUBJECT_LENGTH) {
    console.warn(
      `commit-msg: 提示 —— subject ${text.length} 字符，建议不超过 ${SOFT_SUBJECT_LENGTH}`
    );
  }
}

if (errors.length > 0) {
  console.error('提交信息不符合规范（见 COMMIT_CONVENTION.md）：\n');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  console.error(`\n  当前: ${subject}`);
  console.error('  要求: <type>(<scope>): <subject>，单行英文，≤ 72 字符');
  console.error(`  例:   fix(editor): stop click hit area drifting below tables`);
  process.exit(1);
}
