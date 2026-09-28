/**
 * renderer 测试的全局 setup。
 *
 * ## 为什么需要它 —— 一个本机环境事实
 *
 * 本机（Windows + pnpm + vitest 3.2.7 + React 19.3）下 `react` 会被加载**两份**：
 * vite-node 用自己那张模块图加载一份，而 `react-dom`（走 Node 的 `require`）拿到另一份。
 * 两份各有自己的 `ReactSharedInternals`（`__CLIENT_INTERNALS_...`），于是：
 *
 * - 组件里的 `useState` 读到 `null` dispatcher → `Invalid hook call`；
 * - `act()` 把队列建在自己那份 internals 上，`react-dom` 不认它 →
 *   `root.render()` 之后 DOM **不会**在 `act` 退出时提交，要等一个宏任务
 *   （`MessageChannel` 调度的那次渲染）才出现。
 *
 * 实测证据：`act` 内部 `internals.actQueue` 是 `[]`（act 生效了），
 * 但 `require('react')` 那份的 `actQueue` 是 `null`（react-dom 用的正是它）；
 * 容器 `innerHTML` 在 `act` 后是 `""`，50ms 后是 `<div class="probe">hello</div>`。
 *
 * ## 为什么对齐 internals 而不是包装 act
 *
 * 包装 `act`（在里面多等一个宏任务）是治标：每个 `act` 调用都要多等一次，
 * 而且「更新发生在 act 之外」的警告照样会打。对齐 internals 是治本 ——
 * `react-dom` 在**模块加载时**读一次 `React.__CLIENT_INTERNALS_...`，
 * 只要在那个时刻之前把它换成 vite 那份，两边就是同一个调度器。
 *
 * setup 文件先于测试文件执行，而 `react-dom` 通常到测试文件 import 时才加载，
 * 所以这个替换来得及。
 *
 * 一旦上游修好（或换掉 pnpm 的布局），`cjsReact[KEY]` 本来就等于 `viteInternals`，
 * 这段代码退化成一次比较，无副作用。
 */
import * as React from 'react';
import { createRequire } from 'node:module';

const INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

const require = createRequire(import.meta.url);
const cjsReact = require('react') as Record<string, unknown>;
const viteInternals = (React as unknown as Record<string, unknown>)[INTERNALS_KEY];

if (viteInternals !== undefined && cjsReact[INTERNALS_KEY] !== viteInternals) {
  try {
    cjsReact[INTERNALS_KEY] = viteInternals;
  } catch {
    // 写不进去就保持原样 —— 用例会退回「act 后 DOM 未提交」的行为，
    // 失败信息里看得见，不至于静默。
  }
}
