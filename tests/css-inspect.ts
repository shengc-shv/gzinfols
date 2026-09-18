/**
 * 产物 CSS 检查工具（2026-09-18）。
 *
 * 为什么需要：2026-09-18 的移动端审查发现一类**产物级静默缺陷**——
 * `.must-card` 的规则体在 `display: flex` 后被提前闭合，尾部 5 条声明落到规则体外
 * 成了「顶层裸声明」，被浏览器整块丢弃（卡片没了内边距/边框/圆角/白底/阴影）。
 * 没有报错、没有告警，连「N 段拼接 == 原串」的指纹测试也照样通过（拼接确实逐字节相等，
 * 是源串本身坏了）。
 *
 * 结论：**要守卫的是「产物 CSS 的解析结果」，不是「源码字符串长什么样」**。
 * 本模块提供按规则解析（而非按选择器拼写匹配）的最小工具，
 * 让断言写成「某选择器最后生效的声明是什么」，这样即使换了写法（换选择器组合、
 * 挪到媒体查询里、改成分行书写）也拦得住。
 *
 * 非 .test.ts 命名 —— 不会被测试 glob 当作用例执行。
 */

/** 取出产物 HTML 里 <style> 的内容（若有多个，拼接）。 */
export function styleOf(html: string): string {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

/**
 * 剥掉 CSS 块注释。
 * 注意：产物里只有经 stripCssComments 处理过的段落没有注释，
 * full.ts 内联的段落仍带注释，扫描前必须统一剥掉（否则注释里的 `;` 会被误判）。
 */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

export interface CssRule {
  /** 该块自身的选择器 / at 规则前奏 */
  prelude: string;
  /** 块体内容 */
  body: string;
  /** 嵌套深度：1 = 顶层规则，≥2 = 位于 @media 等块内的规则 */
  depth: number;
  /**
   * 外层 at 规则前奏链（外层在前）。用于区分「桌面增强」与「移动端覆盖」：
   * 本项目允许 `min-width: 720px` 下把横滑容器改成网格，但不允许窄视口下取消横滑。
   */
  ancestors: string[];
}

/**
 * 把样式表解析成规则列表（只保留带 `{}` 体的块）。
 * 不追求完整 CSS 语法支持，但对本项目的产物（无字符串字面量、无嵌套选择器）足够。
 */
export function rulesOf(css: string): CssRule[] {
  const out: CssRule[] = [];
  const stack: Array<{ prelude: string; start: number }> = [];
  let buf = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      stack.push({ prelude: buf.trim(), start: i });
      buf = "";
    } else if (ch === "}") {
      const top = stack.pop();
      if (top) {
        out.push({
          prelude: top.prelude,
          body: css.slice(top.start + 1, i),
          depth: stack.length + 1,
          ancestors: stack.map((s) => s.prelude),
        });
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

/**
 * 找出「顶层裸声明」：花括号深度为 0 时出现的 `;` 之前那段文本。
 *
 * 这些声明没有选择器宿主，按 CSS 规范会被解析器连同其后内容一起丢弃 ——
 * 静默失效，正是本次 P0 缺陷的形态。**正常产物应恒为空数组。**
 */
export function topLevelDeclarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of css) {
    if (ch === "{") {
      depth++;
      buf = "";
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      buf = "";
    } else if (ch === ";") {
      if (depth === 0 && buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

/**
 * 取「命中某选择器」的规则，按源码顺序返回（所以最后一条就是最终生效的那条）。
 * 选择器用正则匹配整段前奏 —— 比字符串包含更稳，不会因为多写一个空格就漏掉。
 */
export function rulesMatching(css: string, selector: RegExp): CssRule[] {
  return rulesOf(css).filter((r) => selector.test(r.prelude));
}

/** 取某属性在某段声明里的值（取最后一次出现）。 */
export function declValue(body: string, prop: string): string | null {
  const re = new RegExp(`${prop}\\s*:\\s*([^;]+);`, "g");
  const all = [...body.matchAll(re)].map((m) => m[1].trim());
  return all.length ? all[all.length - 1] : null;
}
