/**
 * 本机已安装的字体家族名。设置页那个字体输入框的**兜底候选**。
 *
 * **为什么用 `queryLocalFonts()`**：它是 Chromium 的标准 API，Electron 直接继承 ——
 * 零权限提示、零 CSP、零自定义协议（2026-10-01 在真机上量过：返回 490 条记录 / 217 个
 * 唯一家族，`isSecureContext` 为真，全仓没有一处 `setPermission` 覆写）。
 * 只返回**元数据**，不读字体文件本身。
 *
 * **它回答不了的问题：哪个字体有中文字形。** `document.fonts.check('12px "某字体"', '中')`
 * 对系统字体**恒为真**（连不存在的字体名也是），所以「筛出一份含中文的清单」做不到。
 * 因此这里只做枚举，过滤交给用户 —— 输入框 + 候选表（`FieldRow` 的 `FontControl`）。
 *
 * **取不到就当没有**：API 不存在（更老的 Chromium）、被策略禁掉、用户拒绝授权 —— 三种都
 * 返回空数组，而不是抛错。候选表少一截不影响这一项能用：输入框本来就能自由填家族名。
 */
export interface LocalFontData {
  /** 家族名。同一个家族的粗体 / 斜体是**多条记录、同一个 family**。 */
  family: string;
}

/** 只声明用到的那一个成员 —— 别把整份 API 的猜测写进全局类型。 */
interface FontQueryHost {
  queryLocalFonts?: () => Promise<readonly LocalFontData[]>;
}

/**
 * 同一个窗口只问一次。设置窗口是短命窗口，字体列表在它开着的期间不会变
 * （装了新字体要重启才认得）。
 */
let pending: Promise<readonly string[]> | null = null;

/**
 * 家族名去重并排序。**大小写不敏感去重**：Windows 上同一个家族可能同时以
 * `Microsoft YaHei` 与 `微软雅黑` 出现，而大小写变体（`Arial` / `ARIAL`）也会各来一条。
 * 保留**第一次出现的写法**，因为那是系统报出来的名字。
 */
export function normalizeFamilies(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of names) {
    const name = raw.trim();
    if (name === '') continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 本机字体家族名。**失败即清空缓存**，与懒加载扩展同一条纪律：一次失败被永久记住的话，
 * 用户把权限放开之后也永远看不到候选表了。缓存清空后下一次调用会重新问。
 */
export function localFontFamilies(): Promise<readonly string[]> {
  if (pending) return pending;

  const host = typeof window === 'undefined' ? null : (window as unknown as FontQueryHost);
  const query = host?.queryLocalFonts;
  if (typeof query !== 'function') return Promise.resolve([]);

  pending = query.call(host).then(
    (fonts) => normalizeFamilies(fonts.map((font) => font.family)),
    () => {
      pending = null;
      return [];
    }
  );

  return pending;
}

/** 只给测试用：把缓存清掉，让下一条用例能从「没有缓存」开始。 */
export function resetLocalFontCache(): void {
  pending = null;
}
