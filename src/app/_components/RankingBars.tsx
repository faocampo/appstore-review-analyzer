import type { ReactElement } from "react";

import { formatCount, formatShare } from "@/app/_lib/numbers";

export interface RankingItem {
  key: string;
  label: string;
  count: number;
  share: number;
}

/** Ranking bars: the top bar in brand, the rest in bar-grey. */
export function RankingBars({ items, emptyCopy }: { items: RankingItem[]; emptyCopy: string }): ReactElement {
  if (!items.length) return <p className="body muted">{emptyCopy}</p>;
  return (
    <ol className="ranking">
      {items.map((item, index) => (
        <li key={item.key}>
          <div className="ranking__label">
            <span>{item.label}</span>
            <span className="mono">
              {formatCount(item.count)} · {formatShare(item.share)}
            </span>
          </div>
          <div className="ranking__track">
            <span
              className={index === 0 ? "ranking__bar is-top" : "ranking__bar"}
              style={{ width: formatShare(Math.min(1, item.share), 1) }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
