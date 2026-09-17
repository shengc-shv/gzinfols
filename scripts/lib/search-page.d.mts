/** search-page.mjs 类型声明（测试用；与 history-retention.d.mts 同例）。 */
export interface SearchPageDay {
  date: string;
  hero?: string;
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
