/**
 * domains-page.mjs 类型声明（测试用；与 topics-page.d.mts / focus-page.d.mts 同例）。
 *
 * 只声明页面真正读取的字段（生产契约见 lib/services/vocab/domains-index.ts）。
 */
export interface DomainsPageItem {
  id: string;
  date: string;
  title: string;
  url: string;
  source: string;
  section: string;
  subtopic: string | null;
  tags?: string[];
  itemDate?: string;
}

export interface DomainsPageDomain {
  id: string;
  name: string;
  short: string;
  count: number;
  subtopics: Array<{ name: string; count: number }>;
  segments?: string[];
  products?: string[];
  eventTypes?: string[];
  items: DomainsPageItem[];
}

export interface DomainsPageIndex {
  version?: 1;
  generatedAt?: string;
  windowRuns?: number;
  total?: number;
  classified?: number;
  domains: DomainsPageDomain[];
}

export declare function renderDomainsPage(opts: {
  index?: DomainsPageIndex | null;
  generatedAt?: string;
  latest?: string;
}): string;
