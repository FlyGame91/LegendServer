// verify_status.mjs —— 【面板属性绝对精度】全量验证（2026-10-08 建立）
//
// 背景：面板属性（HP/ATK/DEF/MATK/MDEF/TECH）由【服务端】计算 ——
//   反编译实证 UserCharacterStatusList_New 只是把响应字段搬进 DataStore，
//   客户端 get_TotalStatus() 是纯字段直读（零计算）。
//   ⇒ 算错就是直接错，客户端不兜底 ⇒ 必须逐字段与契约一致。
//
// 验证什么：拿【我自己的 state】里的角色，用 my 算法重算 StatusList，
//   与 contracts/user_load_user_data.json（真实录制的成熟账号）逐字段比对。
//   ⇒ 这条检查「我的输入 + 我的算法」是否与真实服务端一致（日常回归用）。
//
// ★ 只比「等级/突破与契约相同」的角色：
//   测试会改 state 里个别角色的 lv/brk（突破、强化…），那类角色属性本就该不同，
//   跳过它们避免假阳性（跳过数会打印出来）。
//
// ★ 本脚本是【纯读】：不写任何状态、不碰 user.json（无 markDirty/flushNow）。
//
// 用法：node verify_status.mjs          （由 run-tests.mjs 自动调用）
//   环境变量 LEGECLOX_STATE / LEGECLOX_PORT 与其它套件一致（隔离测试档）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);   // state.mjs 用相对路径解析 state/ 与 contracts/

const { getState } = await import("./state.mjs");
const ch = await import("./character.mjs");

const C = JSON.parse(fs.readFileSync("./contracts/user_load_user_data.json", "utf8")).result;
const ref = [...(C.CharacterList?.mainCharacterList || []), ...(C.CharacterList?.supportCharacterList || [])];
const s = getState();
const all = [...(s.CharacterList?.mainCharacterList || []), ...(s.CharacterList?.supportCharacterList || [])];

const K = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique", "PhysicalAndMagicalAttack"];
const SUB = ["CharacterLevelStatus", "CurrentBreakLimitStatus", "TotalStatus", "TrainingBoardStatusValue",
  "MemoryBookStatusPercent", "TrainingBoardStatusPercent", "MasterRankStatusPercent", "LegendMasteryPercent",
  "FavorabilityStatus", "ClassUpStatus", "TenmeiMasteryEnhancementUpStatus", "LegendMasteryStatusPercent", "total_base_status"];

let cmp = 0, diff = 0, missing = 0, skip = 0;
const bad = [];
for (const r of ref) {
  const cid = r.master_character_id;
  const mine = all.find(function (x) { return x.master_character_id === cid; });
  if (!mine) { skip++; continue; }   // 我存档没有该角色 → 无法比（不是缺陷）
  if (Number(mine.level) !== Number(r.level) || Number(mine.break_limit) !== Number(r.break_limit)) { skip++; continue; }
  ch.recomputeStatusList(mine);
  const got = mine.StatusList || {};
  for (const sub of SUB) {
    const b = r.StatusList?.[sub]; if (!b) continue;
    const a = got[sub];
    for (const k of K) {
      if (b[k] === undefined) continue;
      cmp++;
      const va = a ? a[k] : undefined;
      if (va === undefined) { missing++; if (bad.length < 20) bad.push({ cid: cid, sub: sub, k: k, why: "缺失" }); continue; }
      if (Number(va) !== Number(b[k])) { diff++; if (bad.length < 20) bad.push({ cid: cid, sub: sub, k: k, mine: va, ref: b[k] }); }
    }
  }
}

const fail = diff + missing;
console.log("  比对字段: " + cmp + "  不同: " + diff + "  缺失: " + missing + "  跳过(lv/brk 不同或本地无此角色): " + skip);
if (bad.length) {
  console.log("  差异（最多 20 条）:");
  bad.forEach(function (x) { console.log("    " + JSON.stringify(x)); });
}
if (!fail) console.log("  ✅ 面板属性全部一致（绝对精度）");
console.log("  总计: 通过 " + (cmp - fail) + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
