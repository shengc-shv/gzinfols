/** 类型声明：guangdong.mjs（广东企业判断工具，无内建类型）。 */
export const GUANGDONG_KEYWORDS: string[];
export function normalizeCode(code: string): string;
export function isGuangdongEnterprise(text: string, opts?: Record<string, unknown>): boolean;
export function matchGuangdong(text: string, opts?: Record<string, unknown>): unknown;
export function lookupByCode(code: string): unknown;
export function registrySize(): number;
