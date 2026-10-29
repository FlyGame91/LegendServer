// verify_vs_live.mjs —— 【算法正确性】验证（与输入数据解耦）（2026-10-08 建立）
//
// 与 verify_status.mjs 的分工（★ 两者必须都跑，缺一不可）：
//   · verify_status  = 「我的输入 + 我的算法」 vs 契约  → 日常回归（输入会随游玩变化）
//   · verify_vs_live = 「契约的输入 + 我的算法」 vs 契约  → ★ 把差异【只能】归因于算法
//
// 为什么需要它（关键教训）：
//   只对一份契约验证会获得【假安全感】。我曾只比本地契约（恰好 0 差异），
//   换成真机契约就冒出 78 处差异 —— 逐层收窄后确认【全部源于输入不同】
//   （真机那份是更晚的进度：legend/tenmei 等级更高、TrainingNode 多 44 个）：
//       78 处 →（换成契约的 legend/tenmei/TrainingNode）→ 6 处
//             →（再同步 class_level / favorability）      → 0 处 ✅
//   只有「用契约的输入」才能把差异唯一归因到算法上。
//
// 做法：临时把 state 里所有【影响属性的输入】替换为契约的值 ——
//   legend_mastery_list（含 tenmei）/ TrainingNode / master_rank_data / memory_book /
//   class_level / favorability_level —— 然后重算并与契约比对；finally 恢复。
//
// ★ 纯内存操作：全程不调 markDirty/flushNow，不落盘（进程结束即丢弃）。
//
// 用法：node verify_vs_live.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

const state = await import("./state.mjs");
const ch = await import("./character.mjs");

// ★ 2026-10-22：原来的路径 contracts_winr/user_load_user_data.json 已经不存在
//   （只剩 .bak2），导致本套件一直在 ENOENT 静默失效 —— 现在按候选路径依次找。
const W = [
  "game_data/capture/winr/user_load_user_data_winr.json",
  "game_data/capture/winr/contracts_winr/user_load_user_data.json",
  "contracts/user_load_user_data.json",
].find(function (p) { return fs.existsSync(p); });
const C = JSON.parse(fs.readFileSync(W, "utf8")); const R = C.result || C;
const ref = [...(R.CharacterList?.mainCharacterList || []), ...(R.CharacterList?.supportCharacterList || [])];
const s = state.getState();

// 备份全部【影响属性的输入】→ 换成契约的 → 比对 → finally 恢复
const bk = {
  lm: JSON.parse(JSON.stringify(s.legend_mastery_list || {})),
  tn: JSON.parse(JSON.stringify(s.TrainingNode || [])),
  mr: JSON.parse(JSON.stringify(s.master_rank_data || {})),
  mb: JSON.parse(JSON.stringify(s.memory_book || {})),
  cls: ref.map(function (r) { const m = [...(s.CharacterList?.mainCharacterList || []), ...(s.CharacterList?.supportCharacterList || [])].find(function (x) { return x.master_character_id === r.master_character_id; }); return m ? { m: m, cl: m.class_level, fv: m.favorability_level } : null; }).filter(Boolean),
};
let cmp = 0, diff = 0; const bad = [];
try {
  s.legend_mastery_list = JSON.parse(JSON.stringify(R.legend_mastery_list || {}));
  s.TrainingNode = JSON.parse(JSON.stringify(R.TrainingNode || []));
  if (R.master_rank_data) s.master_rank_data = JSON.parse(JSON.stringify(R.master_rank_data));
  if (R.memory_book) s.memory_book = JSON.parse(JSON.stringify(R.memory_book));

  const K = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique", "PhysicalAndMagicalAttack"];
  const SUB = ["CharacterLevelStatus", "CurrentBreakLimitStatus", "TotalStatus", "TrainingBoardStatusValue",
    "MemoryBookStatusPercent", "TrainingBoardStatusPercent", "MasterRankStatusPercent", "LegendMasteryPercent",
    "FavorabilityStatus", "ClassUpStatus", "TenmeiMasteryEnhancementUpStatus", "LegendMasteryStatusPercent", "total_base_status"];

  for (const r of ref) {
    const mine = [...(s.CharacterList?.mainCharacterList || []), ...(s.CharacterList?.supportCharacterList || [])]
      .find(function (x) { return x.master_character_id === r.master_character_id; });
    if (!mine) continue;
    mine.class_level = r.class_level;
    mine.favorability_level = r.favorability_level;
    if (Number(mine.level) !== Number(r.level) || Number(mine.break_limit) !== Number(r.break_limit)) continue;
    ch.recomputeStatusList(mine);
    for (const sub of SUB) {
      const b = r.StatusList?.[sub]; if (!b) continue;
      for (const k of K) {
        if (b[k] === undefined) continue;
        cmp++;
        const va = mine.StatusList?.[sub]?.[k];
        if (Number(va) !== Number(b[k])) { diff++; if (bad.length < 15) bad.push({ cid: r.master_character_id, sub: sub, k: k, mine: va, ref: b[k] }); }
      }
    }
  }
  console.log("  ═══ 用【契约的全部输入】+ 我的算法 ═══");
  console.log("    比对 " + cmp + "  不同 " + diff);
  if (bad.length) { console.log("    差异（最多 15 条）:"); bad.forEach(function (x) { console.log("      " + JSON.stringify(x)); }); }
  if (!diff) console.log("    ✅ 算法与真机服务端完全一致");
  console.log("  总计: 通过 " + (cmp - diff) + " / 失败 " + diff);
} finally {
  s.legend_mastery_list = bk.lm; s.TrainingNode = bk.tn;
  s.master_rank_data = bk.mr; s.memory_book = bk.mb;
  bk.cls.forEach(function (e) { e.m.class_level = e.cl; e.m.favorability_level = e.fv; });
}
process.exit(diff ? 1 : 0);
