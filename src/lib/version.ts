/** 把带构建后缀的版本(<基数>-<品牌>-<时间戳>)拆成友好展示的基版本 + 构建时间。 */
export interface FriendlyVersion {
  /** 基版本,如 0.1.46 */
  version: string;
  /** 完整版本(不含 v 前缀),如 0.1.46-xbuddy-202609220945 */
  full: string;
  /** 构建时间,如 2026-09-22 09:45;无后缀或解析不出则为 undefined */
  buildTime?: string;
}

export function friendlyVersion(raw: string | null | undefined): FriendlyVersion {
  const full = (raw ?? "").trim().replace(/^v/, "");
  const dash = full.indexOf("-");
  if (dash < 0) return { version: full, full };
  const version = full.slice(0, dash);
  const ts = full.slice(dash + 1).match(/(\d{8,14})$/)?.[1];
  if (!ts) return { version, full };
  const time = ts.length >= 12 ? ` ${ts.slice(8, 10)}:${ts.slice(10, 12)}` : "";
  return { version, full, buildTime: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}${time}` };
}
