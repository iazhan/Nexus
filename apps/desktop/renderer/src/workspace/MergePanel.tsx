import React, { useCallback, useMemo, useState } from 'react';
import {
  alignThreeWay,
  joinMergedBlocks,
  topLevelBlockSlices,
  type ThreeWayRow,
  type ThreeWaySuggestion
} from '@nexus/markdown';
import { Dialog } from '../components/Dialog.js';
import { useLocale } from '../hooks.js';

export interface MergePanelProps {
  /** 共同祖先账本记的内容。`null` ＝ 没有祖先，只能两路，由调用方决定不开这一屏。 */
  base: string;
  /** 本地（缓冲区里未保存的）内容。 */
  mine: string;
  /** 磁盘上（外部改过的）内容。 */
  theirs: string;
  /** 用户点了「应用合并结果」。传回来的是**完整的合并后源文**。 */
  onApply: (merged: string) => void;
  onCancel: () => void;
}

/** 一块的最终处置。`drop` ＝ 这一块两边都不要。 */
type Pick = ThreeWaySuggestion | 'drop';

/**
 * 建议 → 默认处置。`conflict` 没有建议，默认**两边都不选**（`drop`）——
 * 这一格正是「必须由人判」的那一格，替用户预设成任意一边都是替他做决定。
 *
 * 于是「有冲突没处理」这件事在结果里是**看得见的**（那块没了，用户会发现少了东西），
 * 而不是悄悄按某一边落盘、等用户下次打开才发现内容不对。
 */
function defaultPick(row: ThreeWayRow): Pick {
  return row.suggestion === 'conflict' ? 'drop' : row.suggestion;
}

/**
 * 三路合并面板：把 base / 本地 / 磁盘三份摆在一起，逐块让用户选保留哪一侧。
 *
 * ## 它不写盘
 *
 * 面板只算出合并后的**源文**，交给 `onApply`。写回走调用方那条**正常保存路径**
 * （`writeFile` → 守卫链 → 原子替换），所以这里没有、也不该有任何文件系统操作。
 * 这与 Tine ADR 0020 的「只经正常保存路径解决」是同一条。
 *
 * ## 建议只是预选
 *
 * 每一行的初始处置来自 `alignThreeWay` 的建议，但用户随时能改。`conflict` 那些
 * **故意不预选** —— 见 `defaultPick`。
 *
 * ## 没有逐块建议时
 *
 * 调用方在 `base` 拿不到时**不开这一屏**（横幅那两个按钮已经覆盖两路的情形）。
 * 所以这里 `base` 是必填的字符串。
 */
export const MergePanel: React.FC<MergePanelProps> = ({ base, mine, theirs, onApply, onCancel }) => {
  const { t } = useLocale();

  const rows = useMemo(() => alignThreeWay(base, mine, theirs), [base, mine, theirs]);
  const mineSlices = useMemo(() => topLevelBlockSlices(mine), [mine]);
  const theirsSlices = useMemo(() => topLevelBlockSlices(theirs), [theirs]);

  // 处置表按行号存。行数一变（换了文档）就作废 —— 用 `rows` 的长度当身份够用，
  // 因为同一份内容重建出来的行数稳定。
  const [picks, setPicks] = useState<Record<number, Pick>>({});

  const pickOf = useCallback(
    (index: number): Pick => picks[index] ?? defaultPick(rows[index]!),
    [picks, rows]
  );

  const setPick = useCallback((index: number, pick: Pick) => {
    setPicks((prev) => ({ ...prev, [index]: pick }));
  }, []);

  const merged = useMemo(() => {
    const blocks: string[] = [];
    rows.forEach((row, index) => {
      const pick = picks[index] ?? defaultPick(row);
      if (pick === 'drop') return;
      if (pick === 'both') {
        if (row.mineIndex !== null) blocks.push(mineSlices[row.mineIndex]!.text);
        if (row.theirsIndex !== null) blocks.push(theirsSlices[row.theirsIndex]!.text);
      } else if (pick === 'mine') {
        if (row.mineIndex !== null) blocks.push(mineSlices[row.mineIndex]!.text);
      } else {
        if (row.theirsIndex !== null) blocks.push(theirsSlices[row.theirsIndex]!.text);
      }
    });
    // 换行风格沿用本地那份：用户在本地编辑器的观感不变。
    return joinMergedBlocks(blocks, mine);
  }, [rows, picks, mineSlices, theirsSlices, mine]);

  const conflictCount = useMemo(
    () => rows.filter((row, index) => pickOf(index) === 'drop' && row.suggestion === 'conflict').length,
    [rows, pickOf]
  );

  const pickOptions: Array<{ value: Pick; label: string }> = [
    { value: 'mine', label: t('merge.pick.mine') },
    { value: 'theirs', label: t('merge.pick.theirs') },
    { value: 'both', label: t('merge.pick.both') },
    { value: 'drop', label: t('merge.pick.drop') }
  ];

  return (
    <Dialog
      open
      onClose={onCancel}
      label={t('merge.title')}
      panelClassName="nexus-merge-dialog"
      panelId="nexus-merge-panel"
    >
      <h3 className="nexus-merge-title">{t('merge.title')}</h3>
      <p className="nexus-merge-subtitle">{t('merge.subtitle')}</p>

      {conflictCount > 0 && (
        <p className="nexus-merge-conflict-count" role="status" data-merge-conflict-count="">
          {t('merge.conflictCount', { count: String(conflictCount) })}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="nexus-merge-empty">{t('merge.empty')}</p>
      ) : (
        <ul className="nexus-merge-rows" data-merge-rows="">
          {rows.map((row, index) => {
            const pick = pickOf(index);
            return (
              <li
                key={index}
                className={`nexus-merge-row nexus-merge-row-${row.suggestion}`}
                data-merge-suggestion={row.suggestion}
              >
                <div className="nexus-merge-suggestion">
                  {t(`merge.suggestion.${row.suggestion}`)}
                </div>

                <div className="nexus-merge-sides">
                  <section className="nexus-merge-side">
                    <h4 className="nexus-merge-side-label">{t('merge.sectionMine')}</h4>
                    <pre className="nexus-merge-text">
                      {row.mine ?? t('merge.deletedNote')}
                    </pre>
                  </section>
                  <section className="nexus-merge-side">
                    <h4 className="nexus-merge-side-label">{t('merge.sectionTheirs')}</h4>
                    <pre className="nexus-merge-text">
                      {row.theirs ?? t('merge.deletedNote')}
                    </pre>
                  </section>
                </div>

                <div className="nexus-merge-picks" role="radiogroup">
                  {pickOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={pick === option.value}
                      className={`nexus-merge-pick${pick === option.value ? ' nexus-merge-pick-active' : ''}`}
                      data-merge-pick={option.value}
                      onClick={() => setPick(index, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="nexus-merge-actions">
        <button type="button" className="nexus-merge-button" onClick={onCancel}>
          {t('merge.cancel')}
        </button>
        <button
          type="button"
          className="nexus-merge-button nexus-merge-button-primary"
          data-merge-apply=""
          onClick={() => onApply(merged)}
        >
          {t('merge.apply')}
        </button>
      </div>
    </Dialog>
  );
};
