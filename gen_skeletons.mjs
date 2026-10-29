// 从客户端 C# 类声明生成响应骨架 —— 用于【没有录制样本】的端点。
//
// 背景：审计只覆盖有录制的 99 个端点，而权威清单有 175 个。剩下 75 个是盲区，
// 客户端一旦调用就得到 9998（如 master/load_gacha_providing_ratio_master_data）。
// 好在 _endpoint_class_map.json 给了全部 172 个端点的客户端类，而类里的
// TemporaryResponse/TemporaryResult 结构就是权威契约 —— 可据此生成正确形状。
//
// 输出：endpoint-skeletons.json = { 端点: 骨架对象 }（值为零值/null/空数组）
import fs from "node:fs";
import path from "node:path";

const CS_ROOT = "game_data/il2cpp/Assembly-CSharp";
const MAP_FILE = "game_data/capture/_endpoint_class_map.json";
const OUT = path.join(path.dirname(process.argv[1] || "."), "endpoint-skeletons.json");

const classMap = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));

/** 递归找 .cs 文件。 */
function findCs(dir, name, depth) {
  if (depth > 8) return null;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findCs(p, name, depth + 1); if (r) return r; }
    else if (e.name === name + ".cs") return p;
  }
  return null;
}

/** 解析 C# 默认值：类型名 -> 零值。 */
function zeroFor(type) {
  if (/^string$/i.test(type) || /String/.test(type)) return "";
  if (/^bool$/i.test(type) || /Boolean/.test(type)) return false;
  if (/^int$/i.test(type) || /Int32/.test(type)) return 0;
  if (/^long$/i.test(type) || /Int64/.test(type)) return 0;
  if (/^float$/i.test(type) || /Single/.test(type)) return 0;
  if (/^double$/i.test(type)) return 0;
  if (/\[\]$/.test(type)) return [];
  return null;
}

/**
 * 从类源码里取 TemporaryResult 的字段列表。
 * 返回 [{ name, type }]；type 形如 string / int / TemporaryXxx / TemporaryXxx[]
 */
/** 从源码里取继承的基类名。 */
function baseClassOf(src) {
  const m = src.match(/public class \w+\s*:\s*(\w+)/);
  return m ? m[1] : null;
}

/**
 * 取 Result 结构的字段。支持三种客户端模式：
 *   1) TemporaryResponse { TemporaryResult { ... } }   （新式）
 *   2) Response { Result { ... } }                      （旧式）
 *   3) 自身无 Response —— 沿基类链查找
 */
function parseResultFieldsIn(src) {
  // 找任意名为 TemporaryResult 或 Result 的嵌套结构体，取其 public 字段
  const cands = ["TemporaryResult", "Result"];
  for (const name of cands) {
    const idx = src.indexOf(name);
    if (idx < 0) continue;
    // 必须形如 "struct Xxx" 或 "class Xxx"
    if (!new RegExp("(?:struct|class)\\s+" + name + "\\b").test(src)) continue;
    const braceStart = src.indexOf("{", idx);
    if (braceStart < 0) continue;
    let braces = 0, body = "";
    for (let k = braceStart; k < src.length; k++) {
      if (src[k] === "{") braces++;
      else if (src[k] === "}") { braces--; if (braces === 0) { body = src.slice(braceStart + 1, k); break; } }
    }
    if (!body) continue;
    const fields = [];
    const re = /public\s+([\w.<>,\[\]]+)\s+(\w+);/g;
    let m;
    while ((m = re.exec(body)) !== null) fields.push({ name: m[2], type: m[1] });
    if (fields.length) return fields;
  }
  return null;
}

/** 沿继承链找 Result 字段（最多 4 层）。 */
function parseResultFields(src, depth) {
  if (depth > 4) return null;
  const own = parseResultFieldsIn(src);
  if (own) return own;
  const base = baseClassOf(src);
  if (!base) return null;
  const p = findCs(CS_ROOT, base, 0);
  if (!p) return null;
  return parseResultFields(fs.readFileSync(p, "utf8"), (depth || 0) + 1);
}

function parseResultFieldsOld(src) {
  // 定位 internal struct TemporaryResponse 里的 TemporaryResult
  const i = src.indexOf("TemporaryResult");
  if (i < 0) return null;
  // 从这里向后找该结构体的大括号范围
  let braces = 0, started = false, body = "";
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === "{") { braces++; started = true; }
    else if (ch === "}") { braces--; if (started && braces === 0) { body = src.slice(src.indexOf("{", i) + 1, k); break; } }
  }
  if (!body) return null;
  const fields = [];
  const re = /public\s+([\w.<>,\[\]]+)\s+(\w+);/g;
  let m;
  while ((m = re.exec(body)) !== null) fields.push({ name: m[2], type: m[1] });
  return fields;
}

/** 递归求某 C# 类型对应的骨架值。 */
function skeletonForType(type, depth) {
  if (depth > 4) return null;
  const isArray = /\[\]$/.test(type);
  const base = type.replace(/\[\]$/, "");
  const simple = zeroFor(base);
  if (simple !== null || /^(string|bool|int|long|float|double)$/i.test(base)) return isArray ? [] : simple;
  // 复合类型：找它的类定义
  const name = base.replace(/^.*\./, "");
  const p = findCs(CS_ROOT, name, 0);
  if (!p) return isArray ? [] : null;
  const src = fs.readFileSync(p, "utf8");
  const obj = {};
  const re = /public\s+([\w.<>,\[\]]+)\s+(\w+);/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    obj[m[2]] = skeletonForType(m[1], depth + 1);
  }
  return isArray ? [obj] : obj;
}

const out = {};
let ok = 0, skipped = 0;
for (const [api, clsRaw] of Object.entries(classMap)) {
  const cls = String(clsRaw).split("+")[0];
  const p = findCs(CS_ROOT, cls, 0);
  if (!p) { skipped++; continue; }
  const src = fs.readFileSync(p, "utf8");
  let fields = parseResultFields(src, 0);
  if (!fields || !fields.length) {
    // 无强类型 Response 结构（如继承 GamePostApi/GenericApi 的平台类）。
    // 客户端不会按结构反序列化，但也不能返回 9998（那会弹通信错误）。
    // 统一给空对象，并从类名推断一个合理的最小字段（若有明显语义）。
    fields = [];
  }
  const obj = {};
  for (const f of fields) obj[f.name] = skeletonForType(f.type, 0);
  // 无字段结构时给空对象（客户端不强类型反序列化，空对象是可接受的中性响应）
  // 同时用两种 key 存：原始路径 + 归一化（server.mjs 的 contractName 会把 / 换成 _）
  out[api] = obj;
  const norm = api.replace(/[?&=]/g, "_").replace(/\//g, "_").replace(/[^A-Za-z0-9_.-]/g, "_");
  if (norm !== api) out[norm] = obj;
  ok++;
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
console.log("[gen] 生成 " + ok + " 个端点骨架, 跳过 " + skipped + " 个 -> " + OUT);
// 抽样展示
for (const k of Object.keys(out).slice(0, 5)) console.log("  " + k + ": " + JSON.stringify(out[k]).slice(0, 120));