/**
 * ★★ 契约事实库自动推导器（derive.mjs）★★
 *
 * 为什么需要（本项目反复踩的坑）：
 *   我一直在【手工枚举】—— QUEST_TABLES 漏 MasterQuest、MISSION_KINDS 漏 15 种、
 *   字段名白名单漏 camelCase、同族端点字段名不同（mission_progress_list vs MissionProgressList）、
 *   类型多态（player_all_asset 数组/对象、排行榜 7 键 vs 9 键）……
 *   而**录制数据本身就是完整真相**，只是分散在多个目录里，且我又只看单份契约。
 *
 * 本工具做一件事：**扫遍所有录制源，为每个端点产出可机读的事实**，
 * 让我们（人/agent）从「查表」而不是「猜」开始。
 *
 * 产出 _derived/facts.json：
 *   {
 *     "<endpoint>": {
 *       sources: ["winr成熟","winr新号",...],
 *       respKeys: { "<key>": { types: ["object","array"], samples: N, paths: [...] } },
 *       reqKeys:  { "<key>": { types: [...], samples: N } },
 *       arrayShapes: { "<path>": { len: [min,max], elemKeys: [...] } },
 *       polymorphic: [ "<path>: array|object" ],
 *       reqFieldNames: [ ... ],   // 请求里出现过的全部字段名（含 camelCase）
 *     }
 *   }
 *
 * 用法：node derive.mjs [--out DIR]
 */
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 所有录制源（label → 目录）
const SOURCES = [
  ["server", path.join(HERE, "contracts")],
  ["winr成熟", "game_data/capture/winr/contracts_winr"],
  ["winr新号", "game_data/capture/winr/contracts_winr_newaccount"],
  ["web", "game_data/capture/web/api_full"],
];
// 权威清单（端点路径）
const AUTH = JSON.parse(fs.readFileSync("game_data/capture/endpoints_authoritative.json", "utf8"));

const norm = (p) => p.replace(/[?&=]/g, "_").replace(/\//g, "_").replace(/[^A-Za-z0-9_.-]/g, "_");

/** 判断 JSON 值的类型标签（数组/对象分别标注）。 */
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** 递归收集某对象下的所有路径 → 类型集合。 */
function walkPaths(v, prefix, out, depth) {
  if (depth > 6) return;
  if (Array.isArray(v)) {
    if (!out.has(prefix)) out.set(prefix, new Set());
    out.get(prefix).add("array");
    // 只取首元素作为元素形状样本（大数组全部遍历代价高）
    if (v.length && typeof v[0] === "object" && v[0] !== null) walkPaths(v[0], prefix + "[]", out, depth + 1);
    return;
  }
  if (v !== null && typeof v === "object") {
    if (!out.has(prefix)) out.set(prefix, new Set());
    out.get(prefix).add("object");
    for (const k of Object.keys(v)) {
      const p = prefix ? prefix + "." + k : k;
      if (!out.has(p)) out.set(p, new Set());
      out.get(p).add(typeOf(v[k]));
      if (typeof v[k] === "object" && v[k] !== null) walkPaths(v[k], p, out, depth + 1);
    }
  }
}

/** 递归收集请求体里出现过的全部字段名（含大小写变体）。 */
function collectFieldNames(v, out, depth) {
  if (depth > 6 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 3)) collectFieldNames(x, out, depth + 1); return; }
  for (const k of Object.keys(v)) {
    out.add(k);
    if (typeof v[k] === "object" && v[k] !== null) collectFieldNames(v[k], out, depth + 1);
  }
}

// ---------- 主流程 ----------
const facts = {};
for (const ep of AUTH) facts[ep] = { sources: [], respKeys: {}, reqKeys: {}, arrayShapes: {}, polymorphic: [], reqFieldNames: [], respCount: 0, reqCount: 0 };

for (const [label, dir] of SOURCES) {
  if (!fs.existsSync(dir)) continue;
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { continue; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const isReq = f.endsWith(".req.json");
    const base = f.replace(/\.req\.json$/, "").replace(/\.json$/, "");
    // 找到匹配的权威端点（精确或前缀）
    let ep = AUTH.find((a) => norm(a) === base);
    if (!ep) ep = AUTH.find((a) => base.startsWith(norm(a) + "_") || norm(a) === base);
    if (!ep) continue;
    const F = facts[ep];
    if (!F.sources.includes(label)) F.sources.push(label);
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
    if (isReq) {
      F.reqCount++;
      collectFieldNames(j, new Set(F.reqFieldNames), 0);
      const paths = new Map();
      walkPaths(j, "", paths, 0);
      for (const [p, ts] of paths) {
        if (!p) continue;
        const e2 = F.reqKeys[p] || (F.reqKeys[p] = { types: [], samples: 0 });
        for (const t of ts) if (!e2.types.includes(t)) e2.types.push(t);
        e2.samples++;
      }
    } else {
      F.respCount++;
      const root = (j && j.result !== undefined) ? j.result : j;
      const paths = new Map();
      walkPaths(root, "", paths, 0);
      for (const [p, ts] of paths) {
        const e2 = F.respKeys[p] || (F.respKeys[p] = { types: [], samples: 0 });
        for (const t of ts) if (!e2.types.includes(t)) e2.types.push(t);
        e2.samples++;
      }
      // 数组形状（长度范围 + 元素键集）
      const arrs = new Map();
      const walkArr = (v, p, d) => {
        if (d > 5 || v === null || typeof v !== "object") return;
        if (Array.isArray(v)) {
          const a = arrs.get(p) || (arrs.set(p, { min: v.length, max: v.length, elemKeys: [] }), arrs.get(p));
          a.min = Math.min(a.min, v.length); a.max = Math.max(a.max, v.length);
          if (v.length && typeof v[0] === "object" && v[0] !== null) a.elemKeys = Object.keys(v[0]).sort();
          for (const x of v.slice(0, 3)) walkArr(x, p + "[]", d + 1);
          return;
        }
        for (const k of Object.keys(v)) walkArr(v[k], p ? p + "." + k : k, d + 1);
      };
      walkArr(root, "", 0);
      for (const [p, a] of arrs) {
        const e2 = F.arrayShapes[p] || (F.arrayShapes[p] = { min: a.min, max: a.max, elemKeys: a.elemKeys, sources: [] });
        e2.min = Math.min(e2.min, a.min); e2.max = Math.max(e2.max, a.max);
        if (a.elemKeys.length) e2.elemKeys = a.elemKeys;
        if (!e2.sources.includes(label)) e2.sources.push(label);
      }
    }
  }
}

// 标记多态字段（同一路径在不同来源/样本里出现不同类型）
for (const ep of Object.keys(facts)) {
  const F = facts[ep];
  for (const [p, e] of Object.entries(F.respKeys)) {
    if (e.types.length > 1) F.polymorphic.push(p + " : " + e.types.join("|"));
  }
  F.reqFieldNames = F.reqFieldNames.sort();
}

const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : path.join(HERE, "_derived");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "facts.json"), JSON.stringify(facts, null, 1), "utf8");

// ---------- 人读摘要 ----------
const eps = Object.keys(facts);
const noData = eps.filter((e) => facts[e].respCount === 0 && facts[e].reqCount === 0);
const multiSrc = eps.filter((e) => facts[e].sources.length >= 2);
const poly = eps.filter((e) => facts[e].polymorphic.length);
console.log("=== 契约事实库已生成 ===");
console.log("  端点总数:", eps.length);
console.log("  有响应契约:", eps.filter((e) => facts[e].respCount > 0).length);
console.log("  有请求契约:", eps.filter((e) => facts[e].reqCount > 0).length);
console.log("  ★ 完全无录制:", noData.length);
console.log("  多来源可互证:", multiSrc.length);
console.log("  ★ 含多态字段:", poly.length);
console.log("  输出:", path.join(outDir, "facts.json"));
