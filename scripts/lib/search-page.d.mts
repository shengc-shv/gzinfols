/** search-page.mjs 类型声明（测试用；与 history-retention.d.mts 同例）。 */
export interface SearchPageDay {
  date: string;
  hero?: string;
  /** 该期页面是否带条目锚点（A2 之前生成的老期次为 false → 只链到当期页，不拼 #itm-）。 */
  anchored?: boolean;
  items: {
    i: string;
    t: string;
    s?: string;
    d?: string;
    m?: number;
    k: string;
    g?: string[];
    x?: string;
    u?: string;
  }[];
}

export declare function renderSearchPage(opts: {
  days: SearchPageDay[];
  generatedAt?: string;
  latest: string;
}): string;
