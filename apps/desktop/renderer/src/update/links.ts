/**
 * 项目地址。**渲染进程里唯一的一份** —— 与主进程 `changelog.ts` 的 `CHANGELOG_REMOTE_URL`、
 * `electron-builder.yml` 的 `publish.repo` 同源（`iazhan/Nexus`）。换仓要一起改三处；
 * 这条注释是那三处之间唯一的连线。
 */
export const REPOSITORY_URL = 'https://github.com/iazhan/Nexus';

/** 发布页。三层回落全失败、或用户想看某个版本的完整说明时，这是唯一的出口。 */
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

export const ISSUES_URL = `${REPOSITORY_URL}/issues`;
