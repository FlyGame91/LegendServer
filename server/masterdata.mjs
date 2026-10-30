// MasterData 加载器：把 410 张 CSV 解析成可查询的表。
//
// CSV 格式特点（实测）：表头是日文；字段可能含引号包裹的逗号与换行；
// 数据行可能省略尾部默认值（行尾 ,,,,）。故必须用完整的 CSV 解析器，
// 不能按逗号 split。
import fs from "node:fs";
import path from "node:path";

// ★★★ 主数据表根目录（2026-10-16 修正：4.24.0 → 5.0.0）★★★
//
// 根因：客户端已升到 5.0.0（10-14 更新 lab），而这里读的还是 4.24.0 的表 ——
//   于是服务端从 5.0.0 的 `master_load_master_data` 里抽到 4.24.0 表里不存在的 id
//   （实证：`Item_Gacha_Medal_0524`），客户端查表失败 → 整次 load_user_data 崩。
// 三方版本必须一致：客户端本体 / master zip / load_master_data / CSV 表。
const MD_ROOT = "game_data/masterdata";

/** 完整 CSV 解析：处理引号、转义引号、引号内换行/逗号。 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const cache = new Map();

/** 读取一张表：返回 { header, rows }；rows 为对象数组（键=表头）。 */
export function loadTable(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const p = path.join(MD_ROOT, relPath);
  if (!fs.existsSync(p)) { cache.set(relPath, null); return null; }
  const raw = parseCsv(fs.readFileSync(p, "utf8"));
  if (!raw.length) { cache.set(relPath, null); return null; }
  // ★ 关键：CSV 有两行表头 ——
  //   行 0 = 日文显示名（给人看的）
  //   行 1 = 英文字段名（客户端代码实际使用的键）
  //   行 2+ = 数据
  // 用行 1 作键；若它不像字段名（含空/非 ASCII），退回行 0。
  const jpHeader = raw[0];
  const enHeader = raw.length > 1 ? raw[1] : raw[0];
  const useEn = enHeader && enHeader.length === jpHeader.length && enHeader.every((h) => h === "" || /^[\x20-\x7e]+$/.test(h));
  const header = useEn ? enHeader : jpHeader;
  const dataStart = useEn ? 2 : 1;
  const rows = [];
  for (let i = dataStart; i < raw.length; i++) {
    const r = raw[i];
    if (!r.length || (r.length === 1 && r[0] === "")) continue;
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = r[k] !== undefined ? r[k] : "";
    rows.push(o);
  }
  const t = { header, jpHeader, rows };
  cache.set(relPath, t);
  return t;
}

const rawCache = new Map();

/** 读取一张表的【原始行数组】（未按表头转对象）——给「格网」类表格用：
 *  Battle/*.csv 除了列式数据，还会用 dummy 行按 25 列画一张地图格网
 *  （A01< / E07> 这类标记），必须保留列位置才能解析。 */
export function loadRaw(relPath) {
  if (rawCache.has(relPath)) return rawCache.get(relPath);
  const p = path.join(MD_ROOT, relPath);
  if (!fs.existsSync(p)) { rawCache.set(relPath, null); return null; }
  const raw = parseCsv(fs.readFileSync(p, "utf8"));
  rawCache.set(relPath, raw);
  return raw;
}

/** 列出 MasterData 全部表（相对路径）。 */
export function listTables(dir = "", out = []) {
  const abs = path.join(MD_ROOT, dir);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dir ? dir + "/" + e.name : e.name;
    if (e.isDirectory()) listTables(rel, out);
    else if (e.name.endsWith(".csv")) out.push(rel);
  }
  return out;
}

/** 按首列建索引（多数表首列是版本号，第二列才是业务 ID——故支持指定列）。 */
export function indexBy(table, colName) {
  const m = new Map();
  if (!table) return m;
  for (const r of table.rows) { const k = r[colName]; if (k !== undefined && k !== "") m.set(k, r); }
  return m;
}