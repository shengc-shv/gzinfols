/** topics-page.mjs 类型声明（测试用；与 search-page.d.mts 同例）。 */
export interface TopicPageNode {
  date: string;
  i: string;
  t: string;
  s?: string;
  k: string;
  x?: string;
  repeat?: number;
}

export interface TopicPageTopic {
  id: string;
  label: string;
  tags: string[];
  dates: string[];
  spanDays: number;
  nodes: TopicPageNode[];
}

export declare function renderTopicsPage(opts: {
  topics: TopicPageTopic[];
  generatedAt?: string;
  latest: string;
}): string;
