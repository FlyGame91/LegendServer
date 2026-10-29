// invariants.mjs —— 【业务不变量】检查层（2026-10-14 建立）
//
// 为什么需要（来自 offline-client-revival skill 的五层检查器）：
//   我已经有 4 层（静态契约 / 真值回放 / 运行时探测 / 交付闸），
//   唯独缺「业务不变量」——即【关键数值关系】必须成立，而不只是字段形状对。
//
// 判据（skill 原文）：「关键数值关系（实体值 = 各分项之和）→ 0 违反」
//
// ★ 本层的设计原则：
//   ① **纯读**：只读 state/契约，不发写请求、不改任何状态；
//      （skill 提醒「并发跑检查器会污染」，所以本层刻意无副作用，可随时跑）
//   ② **断言的是关系而非具体值** —— 具体值会随游玩变化，关系不会；
//   ③ 每条不变量都注明【它由哪个系统的哪些表决定】，便于回归时定位。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

const { getState, missionNeed } = await import("./state.mjs");
const ch = await import("./character.mjs");
const { loadTable } = await import("./masterdata.mjs");

let pass = 0, fail = 0;
const bad = [];
let skipped = 0;
// ★ checkList：当「被检查的集合为空」时【跳过】而不是失败（2026-10-18 修正）
//   起因：新号档（0 装备 / 0 支援 / 0 护符）跑出 7 个 ❌，但 detail 全写着「0 件全部合规」——
//   因为原写法是 `列表.length > 0 && 无违规`，把「没有数据可检」判成了「违规」。
//   ★ 这与「判据没有区分力」是同一类错误的镜像：那种是恒过，这种是恒红。
//     正确语义：空集合 ⇒ 跳过（计入 skipped，不影响退出码）。
function checkList(name, list, ok, detail) {
  if (!list || !list.length) { skipped++; console.log("  ∅ " + name + "  （无数据可检，跳过）"); return; }
  check(name, ok, detail);
}
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name + (detail ? "  " + detail : "")); }
  else { fail++; console.log("  ❌ " + name + (detail ? "  " + detail : "")); if (bad.length < 12) bad.push(name + " | " + detail); }
}

const s = getState();
// JST 日期串（与 state.mjs 的 todayKey 同口径）
function todayJst() {
  const j = new Date(Date.now() + 9 * 3600 * 1000);
  return j.getUTCFullYear() + "-" + (j.getUTCMonth() + 1) + "-" + j.getUTCDate();
}
const STAT_KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
const all = [...((s.CharacterList || {}).mainCharacterList || []), ...((s.CharacterList || {}).supportCharacterList || [])];

// ============ 1. 属性关系：TotalStatus = ΣValue × (1 + ΣPercent/100) ============
// 由 character.mjs 的 computeTotalStatus 决定；涉及 9 个养成系统（等级/突破/好感/
// class_up/天命/训练板/记忆之书/大师位阶/レジェンド强化）。
// ★ 反算：从契约的子表推出 TotalStatus，必须等于实际值。
{
  let n = 0, ok = 0; const samples = [];
  for (const c of all) {
    const L = c.StatusList; if (!L || !L.TotalStatus) continue;
    const isSup = ch.isSupportCharacter(c.master_character_id);
    const calc = ch.computeTotalStatus(L, isSup);
    n++;
    const same = STAT_KEYS.every(function (k) { return Number(calc[k]) === Number(L.TotalStatus[k]); });
    if (same) ok++; else if (samples.length < 3) samples.push(c.master_character_id);
  }
  check("TotalStatus = base×(1+ΣPercent/100)（全部角色）", n > 0 && ok === n,
        ok + "/" + n + (samples.length ? "  例: " + samples.join(",") : ""));
}

// ============ 2. レジェンド强化：ATK 与 MATK 必须相等 ============
// 由 LegendMasteryEffect 的 BasicStatusType=8（アタック＆マジック）决定。
// ★ 这条不变量的由来：用户报「写的是加双攻，但只加物理」——
//   当时 86 个角色 ATK≠MATK。8 同时覆盖 ATK+MATK 是硬约束（界面文案即证据）。
{
  let n = 0, ok = 0; const samples = [];
  for (const c of all) {
    const p = c.StatusList && c.StatusList.LegendMasteryPercent;
    const q = c.StatusList && c.StatusList.LegendMasteryStatusPercent;
    const v = p || q; if (!v) continue;
    n++;
    if (Number(v.PhysicalAttack) === Number(v.MagicalAttack)) ok++;
    else if (samples.length < 3) samples.push(c.master_character_id + "(" + v.PhysicalAttack + "/" + v.MagicalAttack + ")");
  }
  check("レジェンド强化：ATK === MATK（双攻同时生效）", n > 0 && ok === n,
        ok + "/" + n + (samples.length ? "  例: " + samples.join(",") : ""));
}

// ============ 3. 天赋 Rarity 与初始突破等级的关系 ============
// 由 Fusion/CharacterBreakLimit.csv 决定（FragmentCount==0 的最大 BreakLimitType）。
// ★ 不变量：抽到的新角色 break_limit 必须 > 0（曾全是 0 星）。
{
  const zero = all.filter(function (c) { return !(Number(c.break_limit) > 0); });
  checkList("所有角色 break_limit > 0（无 0 星角色）", all, zero.length === 0,
        "0 星 " + zero.length + "/" + all.length + (zero.length ? "  例: " + zero.slice(0,3).map(function (c) { return c.master_character_id; }).join(",") : ""));
}

// ============ 4. 支援角色必须有 additional_link_soldier_type_list（且是数组）============
// ★ 这条是【崩溃级】约束：客户端 .ToList() 遇 null 会抛 ArgumentNullException，
//   使整次 load_user_data 失败（表现为「进不去游戏」）。
{
  const sups = (s.CharacterList || {}).supportCharacterList || [];
  const badOnes = sups.filter(function (c) { return !Array.isArray(c.additional_link_soldier_type_list); });
  checkList("支援角色 additional_link_soldier_type_list 是数组（非 null）", sups, badOnes.length === 0,
        badOnes.length ? "违规 " + badOnes.length + " 个: " + badOnes.slice(0,3).map(function (c) { return c.master_character_id; }).join(",") : sups.length + " 个支援角色全部合规");
}

// ============ 5. 装备归属：OwnerCharacterId 是权威字段 ============
// ★ 由 UserEquipment.ownerCharacterId 决定（客户端关联角色↔装备的唯一字段）。
//   曾用自造的 equipped_character_id → 一键脱装/自动装备失效。
{
  const eqs = (s.ItemList || {}).EquipmentList || [];
  const owned = eqs.filter(function (e) { return e.OwnerCharacterId; });
  // ① 字段名必须是 OwnerCharacterId / OwnerCharacterCategory（不能有自造字段）
  const selfMade = eqs.filter(function (e) { return e.equipped_character_id !== undefined; });
  checkList("装备无自造字段 equipped_character_id", eqs, selfMade.length === 0,
        selfMade.length ? "违规 " + selfMade.length + " 件" : eqs.length + " 件装备字段干净");
  // ② ★ 角色对象不得含自造字段 `equipment_id_list`（2026-10-16 新增）——
  //   真机契约 0/170、本地契约 0/169 都没有它；它是客户端自己算的索引
  //   （`UserMainCharacterEquipmentIndex.get_EquipmentIdList()`）。
  //   我此前把它写进角色对象 ⇒ 审计报「键集不符」。
  {
    const chars = ((s.CharacterList || {}).mainCharacterList || []).concat((s.CharacterList || {}).supportCharacterList || []);
    const bad = chars.filter(function (c) { return c.equipment_id_list !== undefined; });
    check("角色对象不含自造字段 equipment_id_list", bad.length === 0,
          bad.length ? ("违规 " + bad.length + " 个: " + bad.slice(0,3).map(function (c) { return c.master_character_id; }).join(","))
                     : (chars.length + " 个角色字段干净（装备归属走 OwnerCharacterId）"));
  }
  // ③ OwnerCharacterCategory 只能是 1（主）或 2（支援）
  const badCat = owned.filter(function (e) { return [1, 2].indexOf(Number(e.OwnerCharacterCategory)) < 0; });
  check("装备 OwnerCharacterCategory ∈ {1,2}", badCat.length === 0,
        badCat.length ? "违规 " + badCat.length + " 件" : owned.length + " 件已装备，分类全部合法");
}

// ============ 6. 材料持有量不为负 =============
// 由「消耗 > 持有」类 bug 决定（曾出现扣成负数）。
{
  const items = (s.ItemList || {}).AllItemList || [];
  const neg = items.filter(function (x) { return Number(x.amount) < 0; });
  checkList("所有道具持有量 >= 0", items, neg.length === 0,
        neg.length ? "负数 " + neg.length + " 项: " + neg.slice(0,3).map(function (x) { return x.master_item_id + "=" + x.amount; }).join(",") : items.length + " 项全部非负");
}

// ============ 7. 任务：IsAchieved 与 Progress 的关系 ============
// ★ 由 missionNeed（MissionContentType 决定阈值在 V1 还是 V2）决定。
//   曾把 TotalLogin_09~29（阈值 270~2000 天）算成 need=1 → 21 条误标已达成 → 反复弹窗。
{
  const mp = s.MissionProgressList || [];
  // 只查「未领取但已达成」的——这是弹窗来源，也最容易暴露误标
  const pend = mp.filter(function (m) { return m.IsAchieved && !m.IsReceived; });
  // ★★ 判据修正（2026-10-16）★★
  //   旧判据是「「已达成未领取」数量 <= 10」—— **阈值是我拍的，没有依据**。
    //   实测你的档有 14 条，但逐条核对 **每条的 Prog 都等于 need**（3 条永久成就 + 11 条今日任务），
    //   都是「玩家真达成了但还没领奖」⇒ 数量取决于【玩家领没领】，与实现正确性无关。
    //   真正能抓 bug 的判据是：**「已达成」与「Progress >= need」必须等价** ——
    //   误标的形态就是「need 算错（如把阈值当 1）→ Progress 远小于 need 却已达成」。
    //   （历史实例：`TotalLogin_09~29` 的阈值在 V1(270~2000)，被算成 need=1 → 21 条误标。）
    const mislabeled = pend.filter(function (m) {
      const need = missionNeed(m);
      return (Number(m.Progress) || 0) < need;
    });
    check("不存在「已达成但进度不足」的误标任务（Progress >= need）", mislabeled.length === 0,
          mislabeled.length
            ? ("误标 " + mislabeled.length + " 条: " + mislabeled.slice(0,3).map(function (m) { return m.MissionId + "(" + m.Progress + "<" + missionNeed(m) + ")"; }).join(", "))
            : ("未领取 " + pend.length + " 条，全部满足 Progress >= need"));
}

// ============ 7b. 时段类任务：当前时刻在区间内则必须已达成 ============
// ★ 这条不变量的由来：用户报「时间型任务未生效」（16:05 JST，两个时段都在区间内，
//   但界面显示 0/1 未达成）。
//   根因：我用【一个】日内幂等标记 `__loginMissionDay` 拦住整个 advanceLoginMissions()，
//   导致早上首次登录时未命中的 LoginTime_02 再也无法在 12:00 后达成。
//
// 判据：CT=1 的任务，其 V1~V2 是时间段；**当前 JST 落在区间内 ⇒ 必须 IsAchieved**。
//   这是「机制性」不变量 —— 不依赖具体数值，只看时段与状态是否自洽。
{
  const N = loadTable("Mission/NormalMissionContent.csv");
  const rows = (N && N.rows) || [];
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const cur = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const toSec = function (t) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t == null ? "" : t).trim());
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
  };
  const mp = s.MissionProgressList || [];
  let n = 0, ok = 0; const viol = [];
  for (const m of mp) {
    const r = rows.find(function (x) { return x.MissionId === m.MissionId; });
    if (!r || Number(r.MissionContentType) !== 1) continue;
    const a = toSec(r.MissionValue1), b = toSec(r.MissionValue2);
    if (a === null || b === null) continue;
    if (cur < a || cur > b) continue;         // 当前不在区间内 → 不约束
    n++;
    // ★ 判据修正（2026-10-14）：不变量层是【纯读】的，不能依赖「客户端走过登录流程」。
    //   原来断言「必须已达成」会因「测试档未走过 load_user_data」而假失败。
    //   正确判据：**存储状态不能比「应有的状态」更差** ——
    //     即「当前在区间内 且 该任务曾达成过（或应达成）」时，存储也必须是达成。
    //   更要紧的是检出【永久卡死】：若某任务在区间内却长期未达成，那是幂等标记类 bug。
    //   ⇒ 判据改为：落在区间内时，IsAchieved 必须为 true **或** 该任务从未被判定过
    //     （用 Progress=0 且当天无判定痕迹区分「尚未登录」与「判定过却失败」）。
    //   实测中「真 bug」的形态是：Progress=0 / IsAchieved=false 且 __loginMissionDay=今天
    //     （= 判定过了但没成功）。
    const judged = s.__loginMissionDay === todayJst();
    if (m.IsAchieved) ok++;
    else if (!judged) ok++;   // 今天还没走过登录判定 → 状态待定，不算违规
    else if (viol.length < 3) viol.push(m.MissionId);
  }
  check("时段任务：当前在区间内则必须已达成", n === 0 || ok === n,
        n === 0 ? "当前无落在区间内的时段任务" : ok + "/" + n + (viol.length ? "  未达成: " + viol.join(",") : ""));
}

// ============ 7c. 所有「有上限的数值」都不得越界 ============
// ★ 这条不变量的由来：用户报「为什么角色边框没有了？」——
//   Ch000100101 / Ch000200102 的 break_limit = **7**，而权威表
//   Fusion/CharacterBreakLimit.csv 里所有 Rarity 的最高 BreakLimitType 都是 **6**。
//   客户端用 break_limit 算星级（BreakLimitUseCase.CalcCharacterStarCount →
//   CharacterThumbnailLViewItem.ShowBreakLimitBadge → IconListParts.Init(starCount)），
//   越界值让星级数组/图标索引失效 → **缩略图渲染不出来**（立绘正常，走另一条路径）。
//
// ★ 这类 bug 的共性：**数值本身没有「语法错误」，形状完全合法**，
//   前 4 层检查器（字段名/类型/形状）全都发现不了；
//   只有「与权威表的取值范围对照」才能发现 ⇒ 正是不变量层该管的。
//
// 判据：对每个「有定义域」的字段，取其权威上限（不是硬编码），逐个比对。
{
  let n = 0, ok = 0; const viol = [];
  for (const c of all) {
    if (!c.master_character_id) continue;
    const cap = ch.maxBreakLimit(c.master_character_id);
    if (!(cap > 0)) continue;
    n++;
    if (Number(c.break_limit || 0) <= cap) ok++;
    else if (viol.length < 3) viol.push(c.master_character_id + "=" + c.break_limit + ">" + cap);
  }
  check("角色 break_limit 不越界（<= 权威表上限）", n > 0 && ok === n,
        ok + "/" + n + (viol.length ? "  越界: " + viol.join(",") : ""));
}

// ============ 7d. 突破等级不得为负 / 非整数 ============
{
  const bad = all.filter(function (c) {
    const v = Number(c.break_limit);
    return !Number.isInteger(v) || v < 0;
  });
  checkList("角色 break_limit 是非负整数", all, bad.length === 0,
        bad.length ? "违规 " + bad.length + " 个" : all.length + " 个角色全部合规");
}

// ============ 7e. 装备 statusList 必须与 (主数据, CurrentLevel) 一致 ============
// ★ 这条不变量的由来：用户报「升级没加属性，你在角色升级那边犯过一次，现在装备这边又来了」——
//   我的 createEquipment 只在【创建时】算一次 statusList，enhanceEquipmentByExp 只改等级、
//   不重算属性 → 强化后 HP/ATK 纹丝不动。**与角色升级是同一类缺陷**。
//
// 公式（真机 962/962 命中，0 不符）：
//   statusList[type=1][属性] = InitStatus + UpStatus × (CurrentLevel - 1)
//   例：SSR_0104 lv20 → Hp = 51+8×19 = 203 ✓  MagicalDefence = 10+0.99×19 = 29 ✓
//
// ★ 判据要点：statusList 只由 (主数据, CurrentLevel) 决定，**装备突破不影响它**
//   （突破只抬 MaxLevel）—— 这已被 962 条真机记录验证。
{
  const eqTable = loadTable("Item/EquipmentList.csv");
  const rows = (eqTable && eqTable.rows) || [];
  const KEY = { 1: "Hp", 2: "PhysicalAttack", 3: "PhysicalDefence", 4: "MagicalAttack", 5: "MagicalDefence", 6: "Technique" };
  const items = ((s.ItemList || {}).EquipmentList) || [];
  let n = 0, ok = 0; const viol = [];
  for (const e of items) {
    if (!e || e.MasterEquipmentId === undefined) continue;
    const def = rows.find(function (r) { return r.ItemId === e.MasterEquipmentId; });
    if (!def) continue;
    const row1 = (e.statusList || []).find(function (x) { return Number(x.type) === 1; });
    if (!row1) { if (viol.length < 3) viol.push((e.Id || "?") + ":缺type1"); n++; continue; }
    const lv = Number(e.CurrentLevel) || 1;
    n++;
    let good = true;
    for (const slot of [1, 2]) {
      const t = Number(def["StatusType" + slot]);
      const key = KEY[t];
      if (!t || !key) continue;
      const init = Number(def["InitStatus" + slot]) || 0;
      const up = Number(def["UpStatus" + slot]) || 0;
      const want = Math.round(init + up * (lv - 1));
      if ((Number(row1[key]) || 0) !== want) {
        good = false;
        if (viol.length < 3) viol.push((e.Id || "?") + "." + key + "=" + (row1[key] || 0) + "≠" + want);
        break;
      }
    }
    if (good) ok++;
  }
  check("装备 statusList 与 (主数据 + 当前等级) 一致", n === 0 || ok === n,
        n === 0 ? "无装备" : ok + "/" + n + (viol.length ? "  例: " + viol.join(", ") : ""));
}

// ============ 7f. 装备 statusList 必须有 type 1/2/3 三条 ============
// 客户端 UserEquipmentStatusList.New 做 dict[1]/dict[2]/dict[3] 直取，
// 缺任何一条都抛 KeyNotFoundException（表现为「通信エラー」）。
{
  const items = ((s.ItemList || {}).EquipmentList) || [];
  const bad = items.filter(function (e) {
    const ts = new Set((e.statusList || []).map(function (x) { return Number(x.type); }));
    return !(ts.has(1) && ts.has(2) && ts.has(3));
  });
  checkList("装备 statusList 含 type 1/2/3（防 KeyNotFound）", items, bad.length === 0,
        bad.length ? "违规 " + bad.length + " 件，例 id=" + bad.slice(0, 3).map(function (e) { return e.Id; }).join(",") : items.length + " 件全部合规");
}

// ============ 7g. 角色经验：本级进度必须落在 [0, 升下一级所需) ============
// ★ 这条不变量的由来：契约 character_exp_info_list 的 beforeExp 是【本级内进度】，
//   而存档的 ch.exp 是【累计】—— 我此前直接把累计值填进去，
//   客户端进度条会显示成 7621365/300000。
//   实证：Ch011102101 lv114 存档 exp=7621365，累计(114)=7620724 → 进度=641 ✓
{
  const lvT = loadTable("Fusion/CharacterLevelUp.csv");
  const rows = (lvT && lvT.rows) || [];
  let n = 0, ok = 0; const viol = [];
  for (const c of all) {
    const lv = Number(c.level) || 1;
    const total = Number(c.exp) || 0;
    const ut = ch.unitTypeOf(c.master_character_id);
    const cum = function (L) {
      let s = 0;
      for (const r of rows) {
        if (Number(r.DefaultUnitType || 0) !== ut) continue;
        if (Number(r.Lv || 0) > L) continue;
        s += Number(r.NeedExp || 0);
      }
      return s;
    };
    const base = cum(lv);
    const need = cum(lv + 1) - base;
    if (need <= 0) continue;   // 满级无下一级
    n++;
    const prog = total - base;
    // 判据：累计经验必须落在本级的区间内（progress ∈ [0, need)）
    if (prog >= 0 && prog < need) ok++;
    else if (viol.length < 3) viol.push(c.master_character_id + " lv" + lv + " exp-" + base + "=" + prog + " ∉ [0," + need + ")");
  }
  check("角色累计经验落在本级区间内", n === 0 || ok === n,
        n === 0 ? "无可判定角色" : ok + "/" + n + (viol.length ? "  例: " + viol.join(", ") : ""));
}

// ============ 7h. 附魔的两阶段语义：Start 不能覆盖 current ============
// ★ 这条不变量的由来：用户报「结果我没有保存，为什么自动给我保存覆盖了？」——
//   Start（预览）阶段我把【已保存的 current】也用新预览覆盖了 →
//   界面上「元のステータス」与「新しいステータス」显示成一样，像是自动保存了。
//
// 权威依据（真机 3415 件装备里唯一的「已有 current 且有 preview」样本）：
//   3980152562  cur=Enchant_04  prev=Enchant_04
//      [0] cur=9/4   alter=8/1     ← current 与 alter **不同**
//      [1] cur=4/11  alter=9/7
//      [2] cur=7/7   alter=4/20
// 另：57 件「有 current 无 preview」的装备，其 alter 全部为 0 ✓
// ⇒ 判据：**已有 currentEnchantId 的装备，其 with-value 行不应与 alter 完全相同**
//   （完全相同 = 被预览覆盖过的脏数据）
{
  const items = ((s.ItemList || {}).EquipmentList) || [];
  const dirty = items.filter(function (e) {
    if (!e.currentEnchantId) return false;
    return (e.enchantList || []).some(function (x) {
      return Number(x.currentType) !== 0 && Number(x.currentType) === Number(x.alterType) &&
             Number(x.currentValue) === Number(x.alterValue);
    });
  });
  checkList("附魔：Start 未覆盖已保存的 current", items, dirty.length === 0,
        dirty.length ? "脏数据 " + dirty.length + " 件: " + dirty.slice(0, 3).map(function (e) { return e.Id; }).join(",") : "已附魔装备 " + items.filter(function (e) { return e.currentEnchantId; }).length + " 件全部正常");
}

// ============ 7i. 附魔 current 值必须落在该行的上限内 ============
{
  const items = ((s.ItemList || {}).EquipmentList) || [];
  let n = 0, ok = 0; const viol = [];
  for (const e of items) {
    for (const x of (e.enchantList || [])) {
      if (!Number(x.currentType)) continue;
      n++;
      if (Number(x.currentValue) >= 0 && Number(x.currentValue) <= Number(x.currentMaxValue)) ok++;
      else if (viol.length < 3) viol.push(e.Id + " t" + x.currentType + "=" + x.currentValue + ">" + x.currentMaxValue);
    }
  }
  check("附魔 current 值 ≤ 上限", n === 0 || ok === n,
        n === 0 ? "无附魔行" : ok + "/" + n + (viol.length ? "  例: " + viol.join(", ") : ""));
}

// ============ 8. 角色总数与主/支援分类的守恒 =============
// 抽卡入库必须按 SupportType 分流（曾把支援角色塞进 mainCharacterList）。
{
  const mains = (s.CharacterList || {}).mainCharacterList || [];
  const sups = (s.CharacterList || {}).supportCharacterList || [];
  const chTbl = loadTable("Character/Character.csv");
  const rows = (chTbl && chTbl.rows) || [];
  const misclassified = sups.filter(function (c) {
    const r = rows.find(function (x) { return x.CharacterID === c.master_character_id; });
    return r && Number(r.SupportType) === 0;   // SupportType=0 是主角色 → 不该在 support 列表
  });
  checkList("支援列表中无主角色（SupportType=0）", sups, misclassified.length === 0,
        misclassified.length ? "错放 " + misclassified.length + " 个" : "主 " + mains.length + " / 支援 " + sups.length + " 分类正确");
}

// ============ 9. 体力恢复：宝石恢复次数的合法范围（2026-10-15）============
// ★ 为什么需要：recoverGemDailyCount 是【每日】计数，上限 = StoneRecovery.csv 的行数（10）。
//   越界（>10）时客户端 UI「あとN回」显示异常，且宝石恢复永久不可用。
//   与「weekly skip 上限」同类 —— 都是「有限次数的计数器」。
//   ★ 权威字段名来自真机契约的 UserData.recoverGemDailyCount
//     （客户端对应 UserProfileModel.staminaRecoverGemDailyCount）。
{
  let lim = 10;
  try {
    const t = loadTable("GroundRule/StoneRecovery.csv");
    const rows = (t && t.rows) || [];
    if (rows.length) lim = Math.max.apply(null, rows.map(function (r) { return Number(r.UseCount) || 0; }));
  } catch (e) { /* 用兜底 10 */ }
  const cnt = Number(s.UserData && s.UserData.recoverGemDailyCount) || 0;
  check("宝石恢复次数在 [0, " + lim + "] 内", cnt >= 0 && cnt <= lim,
        cnt + "/" + lim + (cnt > lim ? "  ★ 越界 → 恢复永久不可用" : ""));
}

console.log("");
// ============ 10. 护符「アビリティ三件套」：有 skill_id 必须有合法 grade（2026-10-16）============
// ★ 由客户端 EquipmentEnchantDataStore.GetAmuletSkillInfo(grade, skillGroupId) 决定 ——
//   实现是 `AmuletSkillValueDictionary[grade][skillGroupId]`，**grade 查不到就
//   AlterLog.LogError + return NULL**（Assembly-CSharp__96.cpp:20953，源 .cs:726-734）；
//   而调用方 PathUtility.GetAmuletFirstSkillIconPath（.cs:485-487）对它做了 NullCheck
//   ⇒ **抛 NullReferenceException** ⇒ 炼成界面アミュレット列表【每一项都崩】
//   ⇒ 用户报障「列表完全空白 + 游戏卡死」。
//
// ★ 权威数据源 EquipmentEnchant/AmuletSkillValue.csv 只有 grade **1~5**（没有 0）
//   ⇒ grade=0 必然查不到 ⇒ 必崩。
// ★ 真机契约（3741 个护符）实证：「有 skill_id 但 grade=0」是 **0 个** —— 二者严格互斥。
//   我此前 createAmulet 只滚了 skill_id、把 grade/value 写死 0 ⇒ 造出 168 个非法组合。
{
  const amus = (s.ItemList || {}).amulet_list || [];
  const withSkill = amus.filter(function (a) { return !!a.skill_id; });
  const badG = withSkill.filter(function (a) {
    const g = Number(a.skill_effect_grade) || 0;
    return !(g >= 1 && g <= 5);
  });
  checkList("护符：有 skill_id 的必须有合法 skill_effect_grade(1~5)", withSkill, badG.length === 0,
        badG.length
          ? ("非法 " + badG.length + " 个（grade=0 会让客户端 GetAmuletSkillInfo 返回 NULL → NRE 崩界面）: "
             + badG.slice(0,3).map(function (a) { return a.id + " grade=" + a.skill_effect_grade; }).join(", "))
          : (withSkill.length + " 个有技能的护符，grade 全部合法"));
  const noSkill = amus.filter(function (a) { return !a.skill_id; });
  const badV = noSkill.filter(function (a) { return (Number(a.skill_effect_grade) || 0) || (Number(a.skill_effect_value) || 0); });
  check("护符：无 skill_id 的 grade/value 应为 0", badV.length === 0,
        badV.length ? ("违规 " + badV.length + " 个（无技能却有 grade/value）") : (noSkill.length + " 个无技能护符，grade/value 均为 0"));
}

// ============ 11. 实体键集不得超出契约（防自造字段，2026-10-16）============
// ★ 由来：本项目已 **5 次**因「自造字段写进契约对象」出问题 ——
//     `equipped_character_id`（一键脱装失效，客户端根本不读它）、
//     `equipment_id_list`（客户端自己算的索引，不该下发）、
//     `__equipSum`（我加的差量基准）、
//     `is_enchanting`（客户端靠 previewEnchantId 判断，契约里根本没这字段）、
//     `BreakLimitCount`（与 break_limit 重复）。
// ★ 判据方向：**state 的键集 ⊆ 契约的键集**（多了就是自造）；
//   反向不判 —— 契约可能含本次未下发的字段（「按需返回」是真实服务端的正常行为）。
// ★ 为什么放在不变量层：audit 也能抓到（MISSING），但它要跑 6~8 分钟；
//   不变量层秒级可跑，能在日常改动中当场发现。
{
  let contract = null;
  try { contract = JSON.parse(fs.readFileSync("contracts/user_load_user_data.json", "utf8")); } catch (e) { contract = null; }
  if (contract) {
    const cr = contract.result || contract;
    const kinds = [
      { name: "角色",
        state: ((s.CharacterList || {}).mainCharacterList || []).concat((s.CharacterList || {}).supportCharacterList || []),
        ref: ((cr.CharacterList || {}).mainCharacterList || []).concat((cr.CharacterList || {}).supportCharacterList || []) },
      { name: "装备", state: ((s.ItemList || {}).EquipmentList) || [], ref: ((cr.ItemList || {}).EquipmentList) || [] },
      { name: "护符", state: ((s.ItemList || {}).amulet_list) || [], ref: ((cr.ItemList || {}).amulet_list) || [] },
    ];
    for (const k of kinds) {
      if (!k.ref.length || !k.state.length) continue;
      const refKeys = new Set();
      k.ref.forEach(function (o) { Object.keys(o).forEach(function (x) { refKeys.add(x); }); });
      const extra = new Set();
      k.state.forEach(function (o) { Object.keys(o).forEach(function (x) { if (!refKeys.has(x)) extra.add(x); }); });
      check(k.name + "对象不含契约外的自造字段", extra.size === 0,
            extra.size ? ("★ 自造字段: " + [...extra].join(", ")) : (k.state.length + " 个对象，键集全部在契约内"));
    }
  }
}

// ============ 12. 装备：break_limit ≥ 1 且 MaxLevel = break_limit × 10（2026-10-16）============
// ★ 由来：用户报障「游戏进不去（通信エラー）」，真根因就是一批装备 break_limit=0 + MaxLevel=51。
//   客户端用 break_limit 算星级并索引图标数组 ⇒ 0 会【下界越界】（索引 -1）⇒ 每件都抛异常
//   ⇒ 整次 load_user_data 失败（契约档能进、用户档不能进，就是因为契约档没有这种装备）。
// ★ 权威对应（契约档 + 真机契约 2360 件实证）：MaxLevel = break_limit × 10，且 break_limit 最小 1。
// ★ 与第 3 条（角色 break_limit）同型 —— 那条第 11 项只覆盖了角色，本次补上装备侧。
{
  const eqs = ((s.ItemList || {}).EquipmentList) || [];
  const badB = eqs.filter(function (e) { return !(Number(e.break_limit) >= 1); });
  checkList("装备：break_limit >= 1（0 会让客户端图标索引下界越界）", eqs, badB.length === 0,
        badB.length ? ("★ 非法 " + badB.length + " 件: " + badB.slice(0,3).map(function (e) { return e.Id + " brk=" + e.break_limit; }).join(", "))
                    : (eqs.length + " 件装备 break_limit 全部 >= 1"));
  const badM = eqs.filter(function (e) { const b = Number(e.break_limit); return b > 0 && Number(e.MaxLevel) !== b * 10; });
  check("装备：MaxLevel === break_limit × 10", badM.length === 0,
        badM.length ? ("★ 不符 " + badM.length + " 件: " + badM.slice(0,3).map(function (e) { return e.Id + " brk=" + e.break_limit + " MaxLv=" + e.MaxLevel; }).join(", "))
                    : (eqs.length + " 件装备 MaxLevel 与 break_limit 一致"));
}

// ============ 13. 三类实例 id 不得跨列表重叠（2026-10-16）============
// ★ 由来：用户报障「进不去游戏（通信エラー）」，真根因就是 id 撞车 ——
//   角色 ∩ 装备 = 169、角色 ∩ 护符 = 11（两个独立缺陷叠加）：
//     ① routes-misc.mjs 抽卡入库硬编码 `300000000 + cl.length`（那是【护符段】）；
//     ② 旧 allocInstanceId 只避让装备+护符，【不避让角色】。
//   ★ 客户端用一个 int64 id 在【共用查询空间】里查实体（beforeUserEquipmentId），
//     撞车时按 id 查到错误类型的对象 → 该实体返回 null → NRE → 整次 load_user_data 失败。
// ★ 真机实证：三类实例 id 【完全不重叠】——
//     角色 143767356~184142795 / 装备 3884920937~4529974441 / 护符 1598182810~1934506047。
// ★ 判据：两两取交集必须为空（这是「共用查询空间」的硬约束，不是风格问题）。
{
  const _ci = ((s.CharacterList || {}).mainCharacterList || []).concat((s.CharacterList || {}).supportCharacterList || []).map(function (c) { return Number(c.id); });
  const _ei = (((s.ItemList || {}).EquipmentList) || []).map(function (e) { return Number(e.Id); });
  const _ai = (((s.ItemList || {}).amulet_list) || []).map(function (a) { return Number(a.id); });
  const _isect = function (x, y) { const t = {}; y.forEach(function (v) { t[v] = 1; }); return x.filter(function (v) { return t[v]; }); };
  const _ce = _isect(_ci, _ei), _ca = _isect(_ci, _ai), _ea = _isect(_ei, _ai);
  check("实例 id：角色 ∩ 装备 为空", _ce.length === 0,
        _ce.length ? ("★ 撞车 " + _ce.length + " 个: " + _ce.slice(0, 5).join(", ")) : (_ci.length + " 角色 / " + _ei.length + " 装备，无重叠"));
  check("实例 id：角色 ∩ 护符 为空", _ca.length === 0,
        _ca.length ? ("★ 撞车 " + _ca.length + " 个: " + _ca.slice(0, 5).join(", ")) : (_ci.length + " 角色 / " + _ai.length + " 护符，无重叠"));
  check("实例 id：装备 ∩ 护符 为空", _ea.length === 0,
        _ea.length ? ("★ 撞车 " + _ea.length + " 个: " + _ea.slice(0, 5).join(", ")) : (_ei.length + " 装备 / " + _ai.length + " 护符，无重叠"));
}


// ============ 14. 神谕探索：同一角色不能同时编入多个 stage（2026-10-17）============
// ★ 由来：用户报障「一个角色只能在一个里面探索，怎么同时出现在了多个探索里」。
//   我的 start/restart 两个端点【没有校验】→ 批量测试时把同一批 6 个角色写进了 stage 1/2/3。
// ★ 权威依据（两份契约各 8 个 stage 的实测数据）：
//     真机契约 87 个角色槽位 / 唯一 87；本地契约 96 槽位 / 唯一 96
//     —— 两份的【跨 stage 重复都是 0】。
// ★ 归属：这是【服务端】的约束 —— 反编译 OracleLiberatorUseCase.GetExploreAdmissionModel
//   只是一段展示用的 Where 筛选；模型上也只有 UI 刷新标记 isExploreChanged，没有硬校验。
//   客户端表现为灰选 / 界面上的红色 ❗（用户截图中 Lv42 / Lv61 那两位）。
// ★ 修法：routes-rest.mjs 的 oracleConflictingCharacters()（收口），start/restart 共用。
{
  const _stages = (s.__oracle && s.__oracle.stages) || {};
  const _seen = {}; const _dup = [];
  for (const k of Object.keys(_stages)) {
    for (const id of (_stages[k].master_character_ids || [])) {
      if (_seen[id]) _dup.push(id + " → stage " + _seen[id] + " & " + k);
      else _seen[id] = k;
    }
  }
  check("神谕探索：同一角色不能同时编入多个 stage", _dup.length === 0,
        _dup.length ? ("★ 跨 stage 重复 " + _dup.length + " 个: " + _dup.slice(0, 3).join(", "))
                    : (Object.keys(_stages).length + " stage / " + Object.keys(_seen).length + " 角色，无重复"));
}
// ============ 15. 状态里不得出现「对象数组混入标量」（2026-10-18）============
// ★ 由来（代价十几轮的真 bug）：`story/read` 把【字符串】push 进 `adventure_read_list`
//   （那是对象数组 [{id, player_account_id, master_quest_group_id}]）⇒
//   客户端 JsonUtility 解析该元素失败得 null ⇒ 导入时拿它当字典 key ⇒
//   `ArgumentNullException: key` ⇒ **load_user_data 后半段导入全被跳过**
//   （含 contents_release_read_list）⇒ 首次进主页 IsContentRelease(MasterRank)=False
//   ⇒ 弹「MASTER RANK 開放」演出弹窗 ⇒ 卡在 state 9 ⇒ 右侧四个大按钮一起失效。
// ★ 判据：同一个数组不能既含对象/数组、又含字符串/数字/布尔。
//   纯标量数组（如 adventure_read_list 的 id 列表）与纯对象数组都合法，**混合即 bug**。
// ★ 这类缺陷「形状完全合法」（JSON 能解析、键都在），只有做元素类型的一致性统计才能发现 ——
//   正是不变量层的职责范围（前 4 层检查器都看不见）。
{
  const _mixed = [];
  const seg = [];
  const where = () => seg.join("");
  const walk = (node, depth) => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      let objN = 0, primN = 0;
      for (const x of node) {
        if (x === null) continue;                    // null 元素单独由实体检查覆盖
        if (typeof x === "object") objN++; else primN++;
      }
      if (objN > 0 && primN > 0) _mixed.push(where() + "（对象 " + objN + " / 标量 " + primN + "）");
      for (let i = 0; i < node.length; i++) {
        if (node[i] === null || typeof node[i] !== "object") continue;
        seg.push("[" + i + "]");
        walk(node[i], depth + 1);
        seg.pop();
      }
      return;
    }
    for (const k of Object.keys(node)) {
      seg.push("." + k);
      walk(node[k], depth + 1);
      seg.pop();
    }
  };
  walk(s, 0);
  check("状态里不存在「对象数组混入标量」", _mixed.length === 0,
        _mixed.length ? ("★ 混合数组 " + _mixed.length + " 处: " + _mixed.slice(0, 4).join("; "))
                      : "全部数组元素类型一致");
}

console.log("  总计: 通过 " + pass + " / 失败 " + fail + (skipped ? (" / 跳过 " + skipped) : ""));
process.exit(fail ? 1 : 0);