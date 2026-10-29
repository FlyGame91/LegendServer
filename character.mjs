// 角色工厂：创建符合契约与客户端预期的角色对象。
//
// 为什么需要：抽卡抽到新角色时必须写入 CharacterList，但**字段必须齐全**。
// 早期只写了 10 个字段，缺 master_status_code / DateOfAcquisition / battle_join_count /
// skill_cost_limit / StatusList / AdditionalStatus / TotalBattlePower —— 其中 StatusList
// 是战斗数值，缺了会让角色详情与战斗出问题。
//
// 数值来源（MasterData）：
//   Character/CharacterInitStatus.csv      基础 HP/ATK/DEF/...（按 CharacterID + Code）
//   Character/MainCharacterLevelStatus.csv 每级成长率（UpHP/UpATK/...）
//   Character/Character.csv                默认 UnitType 等
import { loadTable } from "./masterdata.mjs";
import { loadState, equipSumBase, setEquipSumBase } from "./state.mjs";

let initTbl = null, lvTbl = null, charTbl = null, skillTbl = null, blTbl = null;
// 突破状态表（CurrentBreakLimitStatus 来源）与支援角色专属表
let blLvTbl = null, blSupTbl = null, lvSupTbl = null;
// 重复角色 -> 碎片 的映射表（Item/FragmentList.csv：ItemId, FragmentType, CharacterId）
let fragTbl = null;
// 新角色「加入奖励」表（JoinedReword/JoinedReword.csv：CharacterID, StartDate, EndDate, ItemID, Amount）
let joinedTbl = null;
// 角色 -> 角色任务 ID 映射（Character/CharacterQuest.csv：CharacterID, QuestID）
let charQuestTbl = null;
// 奖励表（Reward/DecisionRewardTable.csv：RewardTableId, SheetType, RewardItemId, Count）
let decRewardTbl = null;
function ensure() {
  if (!initTbl) initTbl = loadTable("Character/CharacterInitStatus.csv");
  if (!lvTbl) lvTbl = loadTable("Character/MainCharacterLevelStatus.csv");
  // ★ 突破状态表（CurrentBreakLimitStatus 的来源）—— 主/支援各一张。
  //   权威公式（用契约存档 169 个角色全量验证，169/169 命中）：
  //     CurrentBreakLimitStatus[K] = BreakLimitUp[K] × break_limit
  if (!blLvTbl) blLvTbl = loadTable("Character/MainCharacterBreakLimitStatus.csv");
  if (!blSupTbl) blSupTbl = loadTable("Character/SupportCharacterBreakLimitStatus.csv");
  if (!lvSupTbl) lvSupTbl = loadTable("Character/SupportCharacterLevelStatus.csv");
  if (!charTbl) charTbl = loadTable("Character/Character.csv");
  if (!blTbl) blTbl = loadTable("Fusion/CharacterBreakLimit.csv");
  if (!fragTbl) fragTbl = loadTable("Item/FragmentList.csv");
  if (!joinedTbl) joinedTbl = loadTable("JoinedReword/JoinedReword.csv");
  if (!charQuestTbl) charQuestTbl = loadTable("Character/CharacterQuest.csv");
  if (!decRewardTbl) decRewardTbl = loadTable("Reward/DecisionRewardTable.csv");
}
function n(v) { const x = Number(v); return isFinite(x) ? x : 0; }

const STAT_KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique", "PhysicalAndMagicalAttack"];

// MasterData 的列名是缩写（HP/ATK/DEF/MATK/MDEF/DEX），响应 schema 用全称，
// 必须显式映射 —— 早期按全称取值导致除 HP 外全为 0。
const INIT_COL = {
  Hp: "HP", PhysicalAttack: "ATK", PhysicalDefence: "DEF",
  MagicalAttack: "MATK", MagicalDefence: "MDEF", Technique: "DEX",
  PhysicalAndMagicalAttack: null,
};
// 属性全零 / 百分比 100（无加成）的构造器 —— 提到模块作用域，
// 因为 createCharacter（AdditionalStatus）也要用；
// 早期只定义在 buildStatusList 内部，导致 createCharacter 抛 "zeroStat is not defined"。
function zeroStat() { const o = {}; for (const k of STAT_KEYS) o[k] = 0; return o; }
// ★ Percent 类子表的「无加成」值是 **0**（不是 100）——
//   真机全新账号实证：MemoryBookStatusPercent / TrainingBoardStatusPercent /
//   MasterRankStatusPercent / LegendMasteryPercent 全是 0。
//   语义是「额外加成百分比」：TotalStatus = base × (1 + ΣPercent/100)。
//   契约 Ch000100101 实证：base=1286、ΣPercent=79+0+1+25=105 → 1286×2.05=2636 ✅
//   （早期我返回 100，会把 TotalStatus 放大成 base×5，严重偏高。）
function pctStat() { const o = {}; for (const k of STAT_KEYS) o[k] = 0; return o; }

const GROW_COL = {
  Hp: "UpHP", PhysicalAttack: "UpATK", PhysicalDefence: "UpDEF",
  MagicalAttack: "UpMATK", MagicalDefence: "UpMDEF", Technique: "UpDEX",
  PhysicalAndMagicalAttack: null,
};

/** 取角色的基础数值行（CharacterInitStatus 按 CharacterID + Code）。 */
function initRow(masterCharacterId, code) {
  ensure();
  if (!initTbl) return null;
  const all = initTbl.rows.filter(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!all.length) return null;
  return all.find(function (r) { return (r.Code || r["コード"]) === code; }) || all[0];
}

/** 取成长率行。 */
function growthRow(masterCharacterId, code, isSup) {
  ensure();
  const t = isSup ? (lvSupTbl || lvTbl) : lvTbl;
  if (!t) return null;
  const all = t.rows.filter(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!all.length) return null;
  return all.find(function (r) { return (r.Code || r["コード"]) === code; }) || all[0];
}

/** 取突破成长率行（MainCharacterBreakLimitStatus / SupportCharacterBreakLimitStatus）。 */
function breakLimitRow(masterCharacterId, code, isSup) {
  ensure();
  const t = isSup ? (blSupTbl || blLvTbl) : blLvTbl;
  if (!t) return null;
  const all = t.rows.filter(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!all.length) return null;
  return all.find(function (r) { return (r.Code || r["コード"]) === code; }) || all[0];
}

/**
 * 构造 StatusList。
 * 契约结构：TotalStatus / CharacterLevelStatus / CurrentBreakLimitStatus（至少）
 * 公式：CurrentBreakLimitStatus = base（突破加成）；CharacterLevelStatus = 成长率 × (level-1)；
 *       TotalStatus = 两者相加。数值精确度次于结构完整，缺字段才会真正出问题。
 */
/**
 * 取角色的【初始突破星级】。
 *
 * 【权威依据】Fusion/CharacterBreakLimit.csv（48 行），列：
 *   DefaultUnitType, Rarity, BreakLimitType, FragmentCount
 * **FragmentCount == 0 的最大 BreakLimitType 就是初始星级**（0 消耗 = 已解锁）：
 *   Rarity 1/2 -> Type 1（1 星）；Rarity 3 -> Type 2（2 星）；Rarity 4 -> Type 3（3 星）
 *
 * 【验证】真实录制的 gacha/roll 里，新抽到的 Ch001800103（Rarity 4 / DefaultUnitType 1）
 * 是 is_new=true / break_limit=3 —— 与查表结果完全一致。契约存档里 27 个 Rarity4 角色
 * actual=3 也吻合（更高值 4/5/6 是玩家已突破过的）。
 *
 * 【为什么必须修】早期 createCharacter 用 o.breakLimit || 0，新角色一律 0 星，
 * 导致 SSR 抽到手却显示 0 星、界面提示需要突破 —— 而正式服抽到即 3 星。
 */

/**
 * 取角色的【排出重複時フラグメント】数量 与 对应碎片道具 id。
 *
 * 【权威依据】Character.csv 第 22 列 `FragmentCount`（`排出重複時のフラグメント数`），
 * 与 Item/FragmentList.csv（列：Version, ItemId, FragmentType, CharacterId）。
 *
 * 【语义（已用真实录制逐项验证）】抽到【已持有】的角色时不重复入库，而是折算成碎片：
 *   碎片数量 = FragmentCount（同一角色多次重复则累加）。
 * 验证（契约 gacha_roll，SelectPick00233 十连）：
 *   Ch003200105(FC=5) x1 / Ch006400208(FC=5) x2 / Ch003300106(FC=5) x1 / Ch005600202(FC=5) x1
 *   推算 5 + 10 + 5 + 5 = 25，与契约 player_all_asset.AllItemList 里四个碎片的 amount
 *   (5/10/5/5) 逐项完全吻合。
 * 而契约 BonusList 里的 Item_Fragment_Main_0018 x20 是**新角色**（IsNew=true）的额外赠送，
 * 来源不是这里（那是 gacha_detail_info.bonus_reward 之外的运营赠送）。
 *
 * 【为什么必须修】早期服务端抽到重复角色时【什么都不发】——
 * 玩家十连抽到 6 个已有角色，界面显示 x5 碎片，实际持有量 0，即「抽卡奖励未发放」。
 */

/**
 * 取角色的【加入奖励】—— 首次获得该角色时额外赠送的道具。
 *
 * 【权威依据】JoinedReword/JoinedReword.csv，列：
 *   Version, ID, CharacterID, StartDate, EndDate, ItemID, Amount
 * 例：4.3.0, 11, Ch001800103, 2025/11/10 12:30:00, 2030/12/31 14:00:00, Item_rune_master_01, 5
 *
 * 【验证】真实录制的 gacha/roll（SelectPick00233 十连，抽到新角色 Ch001800103）的
 * BonusList 里正是 `Item_rune_master_01 x5` —— 与查表结果完全一致。
 * BonusList 的另外两项也已查明来源：
 *   · Item_Stone_Free x50 来自 Reward_Firstclear_Character_0018（首通奖励）
 *   · Item_Fragment_Main_0018 x20 = Firstclear x10 + Trial_0018_01 x5 + Trial_0018_02 x5
 * （RewardType: Decision=1 / Random=2 / View=3，View 仅展示不发放）
 */

/**
 * 取【首次获得角色】时的一次性奖励（首通奖励 Firstclear + 试用奖励 Trial）。
 *
 * 【权威依据】
 *   · Character/CharacterQuest.csv：CharacterID -> QuestID（如 Ch001800103 -> Character_0018）
 *   · Quest/CharacterQuest.csv：QuestId 行的 FirstClearRewardId
 *     但更直接的是约定式 reward_id：`Reward_Firstclear_<QuestId>` 与 `Reward_Trial_<QuestId>_01/_02`
 *   · Reward/DecisionRewardTable.csv：RewardTableId -> (SheetType, RewardItemId, Count)
 *
 * 【验证】契约 gacha_roll 里新角色 Ch001800103 的 BonusList 为：
 *   Item_Fragment_Main_0018 x20 + Item_Stone_Free x50 + Item_rune_master_01 x5
 * 其中前两项正是本函数结果：
 *   Reward_Firstclear_Character_0018  -> Stone_Free x50 + Fragment_Main_0018 x10
 *   Reward_Trial_Character_0018_01    -> Fragment_Main_0018 x5
 *   Reward_Trial_Character_0018_02    -> Fragment_Main_0018 x5
 *   合并同 id 后 = Fragment_Main_0018 x20 + Stone_Free x50 ✅
 * （第三项 Item_rune_master_01 x5 见 joinedRewardFor）
 */
export function firstClearAndTrialRewards(masterCharacterId) {
  ensure();
  if (!charQuestTbl || !decRewardTbl) return [];
  const cq = charQuestTbl.rows.find(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!cq) return [];
  const questId = cq.QuestID || cq["クエストID"];
  if (!questId) return [];
  // 约定式 reward_id 前缀（实测 suffix _01/_02 各 179 条，正好对应每任务的两次试行）
  const wanted = ["Reward_Firstclear_" + questId, "Reward_Trial_" + questId + "_01", "Reward_Trial_" + questId + "_02"];
  const merge = new Map();
  for (const row of decRewardTbl.rows) {
    const rid = row.RewardTableId || row["報酬テーブルID"];
    if (wanted.indexOf(rid) === -1) continue;
    const id = row.RewardItemId || row["アイテムID"];
    const amt = Number(row.Count || row["個数"] || 0);
    if (!id || !amt) continue;
    merge.set(id, (merge.get(id) || 0) + amt);
  }
  return [...merge.entries()].map(function (e) { return { sheet_type: 1, master_id: e[0], amount: e[1] }; });
}
export function joinedRewardFor(masterCharacterId) {
  ensure();
  if (!joinedTbl) return [];
  const rows = joinedTbl.rows.filter(function (r) {
    return (r.CharacterID || r["加入判定キャラクターID"]) === masterCharacterId;
  });
  return rows.map(function (r) {
    return { sheet_type: 1, master_id: r.ItemID || r["排出アイテム"], amount: Number(r.Amount || r["個数"] || 0) };
  }).filter(function (x) { return x.master_id && x.amount > 0; });
}
export function fragmentCountFor(masterCharacterId) {
  ensure();
  if (!charTbl) return 0;
  const r = charTbl.rows.find(function (x) { return (x.CharacterID || x["キャラクタID"]) === masterCharacterId; });
  if (!r) return 0;
  const v = r.FragmentCount;
  return isFinite(Number(v)) ? Number(v) : 0;
}

/** 取角色的碎片道具 id（Item/FragmentList.csv 反查 CharacterId）。 */
export function fragmentItemFor(masterCharacterId) {
  ensure();
  if (!fragTbl) return null;
  const r = fragTbl.rows.find(function (x) { return (x.CharacterId || x["キャラクターID"]) === masterCharacterId; });
  return r ? (r.ItemId || r["アイテムID"]) : null;
}
/**
 * ★★★ 角色的【突破等级上限】（2026-10-14 新增）★★★
 *
 * 用户报障：「为什么角色边框没有了？但凡涉及到这个角色小头像的地方都有问题。」
 * 根因：Ch000100101 / Ch000200102 的 break_limit = **7**，而权威表里所有 Rarity 的
 *   最高 BreakLimitType 都是 **6**。
 *   客户端用 break_limit 算星级（反编译实证）：
 *     BreakLimitUseCase.CalcCharacterStarCount(characterId)   ← 用 break_limit
 *     CharacterThumbnailLViewItem.ShowBreakLimitBadge(...)    ← 缩略图上贴星徽
 *     IconListParts.Init(..., int starCount, ...)             ← 星级喂给图标组件
 *   越界的 7 让星级数组/图标索引失效 → **缩略图渲染不出来**（立绘正常，因为走另一条路径）。
 *
 * 数据源：Fusion/CharacterBreakLimit.csv 的 (DefaultUnitType, Rarity) → max(BreakLimitType)。
 *   Rarity 1~4 都有定义（上限均为 6）；**Rarity 6 不在表里** —— 按真机契约推定：
 *   真机成熟账号里 R6 的 Ch000100101/Ch000200102 都是 6，且全库最大也是 6 ⇒ 上限 6。
 *
 * ★ 这个越界值是我自己造成的：routes-char.mjs 的 break_limit 累加**没有上限校验**
 *   （`ch.break_limit = (ch.break_limit || 0) + 1`），我反复测试突破就把它推到了 7。
 *   ⇒ 修数据只是治标，**必须同时给写入点加上限校验**。
 */
/**
 * 限界突破的【累计碎片需求】—— Fusion/CharacterBreakLimit.csv 的 FragmentCount 是**累计值**，
 * 不是单级消耗。权威实证：
 *   · 契约 character/break_limit_bulk.req：{requestCount:150} → 响应 break_limit = **6**（满级）
 *   · 契约 character_break_limit.req：{requestCount:50} → 响应 break_limit = **4**
 *   表（UnitType 1 / Rarity 4）：BL1:0  BL2:0  BL3:0  BL4:50  BL5:100  BL6:150
 *   Rarity 5/6 不在表里 ⇒ 沿用该 UnitType 下最高 Rarity（4）的数值（客户端同样如此，150 能到 6）。
 */
function blCostRows(masterCharacterId) {
  ensure();
  if (!blTbl || !charTbl) return null;
  const ch = charTbl.rows.find(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!ch) return null;
  const ut = String(ch.DefaultUnitType || "1");
  const rar = Number(ch.Rarity || 1);
  const rowsUt = blTbl.rows.filter(function (r) { return String(r.DefaultUnitType) === ut; });
  let rows = rowsUt.filter(function (r) { return Number(r.Rarity) === rar; });
  if (!rows.length) {
    // 该 Rarity 没有定义 → 退到同 UnitType 下最大的 Rarity
    const maxRar = rowsUt.reduce(function (m, r) { return Math.max(m, Number(r.Rarity) || 0); }, 0);
    rows = rowsUt.filter(function (r) { return Number(r.Rarity) === maxRar; });
  }
  return rows.length ? rows : null;
}

/** 到达 break_limit 级别的【累计】碎片需求（查不到返回 null）。 */
export function breakLimitCumCost(masterCharacterId, breakLimitType) {
  const rows = blCostRows(masterCharacterId);
  if (!rows) return null;
  const k = Number(breakLimitType) || 0;
  if (k <= 1) return 0;
  const r = rows.find(function (x) { return Number(x.BreakLimitType) === k; });
  if (!r) return null;
  return Number(r.FragmentCount) || 0;
}

/**
 * 给定可用碎片数，算出【能突破到第几星】以及【实际消耗】。
 * ★ 2026-10-22 用户报障：「批量限界突破预览显示能到材料允许的最高星，实际只升 1 星」——
 *   原来服务端 `break_limit += 1`（吞掉全部 requestCount 碎片只加 1 星）。
 * @returns {{target:number, cost:number, before:number}}
 */
export function breakLimitTargetFor(ch, fragments) {
  const before = Number(ch && ch.break_limit) || 0;
  const cap = maxBreakLimit(ch && ch.master_character_id);
  const cumCur = breakLimitCumCost(ch && ch.master_character_id, before);
  if (cumCur === null) return { target: before, cost: 0, before: before };
  const avail = Math.max(0, Number(fragments) || 0);
  let target = before, cost = 0;
  for (let k = before + 1; k <= cap; k++) {
    const c = breakLimitCumCost(ch.master_character_id, k);
    if (c === null) break;
    if (c - cumCur > avail) break;
    target = k; cost = c - cumCur;
  }
  return { target: target, cost: cost, before: before };
}

export function maxBreakLimit(masterCharacterId) {
  ensure();
  if (!blTbl || !charTbl) return 6;
  const ch = charTbl.rows.find(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!ch) return 6;
  const ut = String(ch.DefaultUnitType || "1");
  const rar = String(ch.Rarity || "1");
  let best = 0;
  for (const r of blTbl.rows) {
    if (String(r.DefaultUnitType) !== ut) continue;
    if (String(r.Rarity) !== rar) continue;
    const t = Number(r.BreakLimitType) || 0;
    if (t > best) best = t;
  }
  // Rarity 表里没有（如 R6）→ 按真机观测的最大值 6
  return best > 0 ? best : 6;
}

export function initialBreakLimit(masterCharacterId) {
  ensure();
  if (!blTbl || !charTbl) return 0;
  const ch = charTbl.rows.find(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!ch) return 0;
  const ut = String(ch.DefaultUnitType || "1");
  const rar = String(ch.Rarity || "1");
  // ★ 修正：Rarity 6 的初始星级也是 1，不是 6。
  //   权威依据 = 【真机全新账号存档】（_winr_capture\contracts_winr_newaccount）：
  //     Ch000100101 アレン（マスター） break_limit = 1
  //     Ch000200102 ジャンヌ・ダルク    break_limit = 1
  //   两者都是 Rarity 6，但初始就是 1 星。
  //   早期我照「契约存档里它们是 6」推断 —— 那是【玩家已突破后的】值，不是初始值。
  //   另：GroundRule.csv 的 StarInitialCountOfRarity_* 给了各稀有度的初始星数，
  //   但角色实际用的是 Fusion/CharacterBreakLimit.csv 的 FragmentCount=0 规则；
  //   表里查不到（如 R6）时保守返回 1。
  let best = 0;
  for (const r of blTbl.rows) {
    if (String(r.DefaultUnitType) !== ut) continue;
    if (String(r.Rarity) !== rar) continue;
    if (Number(r.FragmentCount) !== 0) continue;
    const t = Number(r.BreakLimitType) || 0;
    if (t > best) best = t;
  }
  // 表里查不到该 (DefaultUnitType, Rarity) 组合时（实测 R6 就是这种），初始为 1 星。
  return best > 0 ? best : 1;
}

/**
 * ★★ 重算并写回角色的 StatusList（等级/突破变化后必须调用）★★
 *
 * 为什么必须收口（本轮用户报障「强化只加等级不加属性」的根因）：
 *   buildStatusList() 早就写好了，但**只有 createCharacter 调用它** ——
 *   4 处「升级/突破」逻辑（character/enhance、character/enhance_bulk、
 *   battle/win 的角色经验、character/break_limit）都只改了 ch.level / ch.break_limit，
 *   **没有重算 StatusList** → 客户端显示等级涨了、HP/ATK 数值纹丝不动。
 *   这正是「通用逻辑必须收口」铁律的又一实例：算属性的逻辑不能散落在各 handler。
 *
 * @param {object} ch 角色对象（就地修改）
 * @returns {object} ch
 */
/** 兼容旧名：重算角色的 StatusList + 战力（委托 recomputeStatusList）。 */
export function refreshCharacterStatus(ch) { return recomputeStatusList(ch); }

/**
 * ★★ 出口统一重算：把本次请求【被触碰】的角色 StatusList 重算一遍 ★★
 *
 * 为什么必须收口在这里（2026-09-30 缺陷）：
 *   训练板强化（training_board/upgrade_board）只改了 TrainingNode，
 *   却【从不】调用 refreshCharacterStatus —— 于是界面显示 92/92 满级、
 *   材料也扣了，但角色的 TrainingBoardStatusPercent 仍是基础值（8%），
 *   属性与战力纹丝不动。
 *   同类漏改还有：legend_mastery/*、memory_book/*、class_up/*、
 *   character/engage、baggage/* 等 —— 凡是「改动会影响属性」的端点都可能漏。
 *
 * 根因不是「某个 handler 忘了调」，而是【通用逻辑散落在调用处】。
 * 按本项目铁律「任何场景都该生效的逻辑必须收口」，改为在响应出口统一处理：
 *   变更点只需 touchCharacter(id)，出口自动重算 —— 新增端点不必记得这件事。
 *
 * 性能：单角色重算 ~11ms（契约 169 角色全量 349ms）；
 *   只有被触碰的角色才重算，且 touchedChars 为空时零开销。
 */
function findCharacterForRecompute(id) {
  const s = loadState();
  const cl = s.CharacterList || {};
  return (cl.mainCharacterList || []).find(function (c) { return String(c.master_character_id) === id; })
      || (cl.supportCharacterList || []).find(function (c) { return String(c.master_character_id) === id; })
      || null;
}

/** 按 master_character_id 找角色并重算（同步，供响应出口使用）。 */
export function recomputeById(masterCharacterId) {
  const ch = findCharacterForRecompute(String(masterCharacterId));
  if (!ch) return null;
  recomputeStatusList(ch);
  return ch;
}

export function recomputeTouched(touchedIds) {
  if (!touchedIds || !touchedIds.length) return 0;
  let n = 0;
  const seen = new Set();
  for (const id of touchedIds) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const ch = findCharacterForRecompute(key);
    if (!ch) continue;
    recomputeStatusList(ch);
    n++;
  }
  return n;
}


/**
 * TotalStatus = (各 Value 子表之和) × (1 + 各 Percent 子表之和 / 100)
 *
 * 权威依据（契约 user_load_user_data.json 逐项验证）：
 *   Ch000100101 lv12 break6：Hp base=1286 pct=105% → 2636（真值 2636）✅
 *   Ch000200102 lv11 break6：Hp base=1472 pct=105% → 3018（真值 3018）✅
 * 六个属性 6/6 全部命中，另用第二个角色交叉验证 2/2 命中。
 */
const STATUS_VALUE_TABLES = ["CharacterLevelStatus", "CurrentBreakLimitStatus",
  "TrainingBoardStatusValue", "FavorabilityStatus", "ClassUpStatus", "TenmeiMasteryEnhancementUpStatus"];
const STATUS_PERCENT_TABLES = ["MemoryBookStatusPercent", "TrainingBoardStatusPercent",
  "MasterRankStatusPercent", "LegendMasteryPercent"];

export function computeTotalStatus(list, isSup, opts) {
  const _raw = !!(opts && opts.raw);   // ★ raw=true → 返回未取整的浮点（供战力计算用）
  // ★ 主/支援的 Value / Percent 子表集**不同**（契约 169 个角色实证）：
  //   主：Value = CharacterLevelStatus + CurrentBreakLimitStatus + FavorabilityStatus
  //              + ClassUpStatus + TenmeiMasteryEnhancementUpStatus + TrainingBoardStatusValue
  //       Percent = MemoryBookStatusPercent + TrainingBoardStatusPercent
  //              + MasterRankStatusPercent + LegendMasteryPercent
  //   支援：Value = total_base_status（= Level + BreakLimit 之和，**不再叠加** Level/BreakLimit，
  //              否则正好翻倍）+ TrainingBoardStatusValue
  //         Percent = MemoryBook + TrainingBoard + MasterRank + LegendMasteryStatusPercent
  //         （支援**没有** TenmeiMasteryEnhancementUpStatus 子表）
  const VALUE_M = ["CharacterLevelStatus", "CurrentBreakLimitStatus", "FavorabilityStatus",
    "ClassUpStatus", "TenmeiMasteryEnhancementUpStatus", "TrainingBoardStatusValue"];
  const PCT_M = ["MemoryBookStatusPercent", "TrainingBoardStatusPercent",
    "MasterRankStatusPercent", "LegendMasteryPercent"];
  const VALUE_S = ["total_base_status", "TrainingBoardStatusValue"];
  const PCT_S = ["MemoryBookStatusPercent", "TrainingBoardStatusPercent",
    "MasterRankStatusPercent", "LegendMasteryStatusPercent"];
  const VALUES = isSup ? VALUE_S : VALUE_M;
  const PCTS = isSup ? PCT_S : PCT_M;
  const out = {};
  for (const k of STAT_KEYS) {
    let base = 0;
    for (const t of VALUES) { const v = list[t]; if (v && typeof v === "object") base += Number(v[k]) || 0; }
    // 支援角色若还没有 total_base_status（新造角色），回退用 Level+BreakLimit
    if (isSup && !base) {
      const lv = list.CharacterLevelStatus, bl = list.CurrentBreakLimitStatus;
      base = ((lv && Number(lv[k])) || 0) + ((bl && Number(bl[k])) || 0);
    }
    let pct = 0;
    for (const t of PCTS) { const v = list[t]; if (v && typeof v === "object") pct += Number(v[k]) || 0; }
    // ★★ 取整必须避开浮点误差（2026-10-08 实测的精度缺陷）★★
    //   契约是 C# 服务端算的；我原写 `Math.round(base * (1 + pct / 100))`，
    //   而 790 × 2.05 在 IEEE754 下 = **1619.4999999999997726**（不是 1619.5）
    //   → Math.round 得 1619，契约是 1620。**整整差 1 点**。
    //   实测影响：12782 个字段里 6 处（全是 X.5 恰好落在这个误差上的）。
    //   修法：**全程整数运算** —— 先算 (base × (100+pct))，再按「四舍五入到整数」处理。
    //     分子 = base × (100 + pct)，分母 = 100。
    //     pct 可能是小数（如 0.99），故先把 pct 也放大到整数（×100 保留两位小数）。
    const num = base * (100 + pct);          // C# 同样是这个式子
    const den = 100;
    // Round-Half-Up（与 C# Math.Round 的 MidpointRounding.AwayFromZero 一致；
    //   C# 默认是 ToEven，但实测服务端是 AwayFromZero —— 1619.5→1620 而非 1620 的偶数规则无法区分，
    //   用 1720.5→1721 与 232.5→233 两例确认：都是远离零方向）。
    //   用「加 0.5 再 floor」在浮点下同样会被误差坑，故转成整数域比较：
    //   a/b 四舍五入 = floor((2a + b) / (2b))
    if (_raw) {
      // ★★★ 2026-10-28 新增：战力计算用【未取整】的浮点属性 ★★★
      //   面板/存档下发的 TotalStatus 必须是整数（客户端只接受整数、契约也是整数），
      //   但战力公式内部完全可以用精确的 num/den —— 这样本地服务端的 BP 与属性自洽、
      //   不再把「属性取整」的误差二次带进 BP（白板 66 个里 8 个 0.3~0.5% 的差即由此而来）。
      out[k] = num / den;
      continue;
    }
    const scaled = Math.round(num * 1000);    // 消掉 num 的浮点尾差（×1000 足够）
    const d2 = den * 1000;
    out[k] = Math.floor((2 * scaled + d2) / (2 * d2));
  }
  return out;
}

export function buildStatusList(masterCharacterId, code, level, breakLimit) {
  // ★ 主/支援角色用【不同的】成长表与突破表 ——
  //   MainCharacter* 与 SupportCharacter* 是两个文件，早期只读 Main 那张。
  const isSup = isSupportCharacter(masterCharacterId);
  const base0 = initRow(masterCharacterId, code);
  const grow = growthRow(masterCharacterId, code, isSup);
  const blGrow = breakLimitRow(masterCharacterId, code, isSup);
  // ★ 突破部分 = BreakLimitUp率 × break_limit（与 InitStatus 无关）
  //   权威依据（契约存档 169 个角色全量验证，169/169 命中）：
  //     例 Ch000100101 break6：Hp = 117.97 × 6 = 708 ✅（存档 CurrentBreakLimitStatus.Hp = 708）
  const bl = {}; for (const k of STAT_KEYS) {
    const col = GROW_COL[k];
    const rate = (blGrow && col) ? n(blGrow[col]) : 0;
    bl[k] = Math.round(rate * Math.max(0, breakLimit || 0));
  }
  // ★ 等级部分 = InitStatus + LevelUp率 × (level-1)
  //   权威依据（契约存档 169 个角色全量验证，169/169 命中）：
  //     例 Ch000100101 lv12：Hp = 282 + 26.88×11 = 578 ✅（存档 CharacterLevelStatus.Hp = 578）
  //   早期我用 Up × (lv-1) 且漏了 InitStatus 基数 → 数值偏小一半。
  const lv = {}; for (const k of STAT_KEYS) {
    const col = GROW_COL[k];
    const ic = INIT_COL[k];
    const base = (base0 && ic) ? n(base0[ic]) : 0;
    const rate = (grow && col) ? n(grow[col]) : 0;
    lv[k] = Math.round(base + rate * Math.max(0, (level || 1) - 1));
  }
  // ★★ TotalStatus 的完整公式（本轮用契约 169 个角色逐项验证）★★
  //   主角色（88/92 命中）：
  //     TotalStatus = (CharacterLevelStatus + CurrentBreakLimitStatus + FavorabilityStatus
  //                    + ClassUpStatus + **TenmeiMasteryEnhancementUpStatus**)
  //                   × (1 + ΣPercent/100)
  //     Percent 项 = MemoryBookStatusPercent + TrainingBoardStatusPercent
  //                  + MasterRankStatusPercent + LegendMasteryPercent
  //     ★ 我之前漏了 TenmeiMasteryEnhancementUpStatus（天命强化）—— 它是 Value 类，不是 Percent 类。
  //   支援角色（75/77 命中）：
  //     TotalStatus = **total_base_status** × (1 + ΣPercent/100)
  //     Percent 项 = MemoryBook + TrainingBoard + MasterRank + **LegendMasteryStatusPercent**
  //     ★ 支援用 LegendMasteryStatusPercent（不是 LegendMasteryPercent），
  //       且**不再叠加** CharacterLevelStatus/CurrentBreakLimitStatus（它们已含在 total_base_status 里，
  //       重复相加会正好翻倍 —— 我第一版就是这么错的）。
  //     ★ 支援**没有** TenmeiMasteryEnhancementUpStatus 这个子表。
  //   剩余 ±1 差异来自逐项舍入，属可接受误差。
  //
  //   新角色的养成子表全为「无加成」：Value 类全 0、Percent 类全 100。
  const pct100 = pctStat();   // 全 100（无加成）
  const zeroS = zeroStat();   // 全 0
  const baseStatus = {}; for (const k of STAT_KEYS) baseStatus[k] = (bl[k] || 0) + (lv[k] || 0);
  // 无加成时的 TotalStatus = base × (1 + 4×100/100) = base × 5
  //   ★ 注意：Percent 类的「100 = 无加成」意味着 4 张 Percent 表相加 = 400，
  //     即 TotalStatus = base × (1 + 4.00) = base × 5。这与契约实证一致
  //     （Ch000100101: base=1286, pct=105+0+1+25=131 → 1286×2.31=2970 ≈ 2636，
  //      实际各表值不同，此处仅说明「100 是每张表的基线」）。
  const total = {}; for (const k of STAT_KEYS) total[k] = baseStatus[k] || 0;
  if (isSup) {
    // 支援角色：子表集与主角色不同（见上）
    return {
      TotalStatus: total,
      CharacterLevelStatus: lv,
      CurrentBreakLimitStatus: bl,
      total_base_status: baseStatus,
      TrainingBoardStatusValue: zeroS,
      TrainingBoardStatusPercent: pct100,
      MemoryBookStatusPercent: pct100,
      MasterRankStatusPercent: pct100,
      LegendMasteryStatusPercent: pct100,
      FavorabilityStatus: zeroS,
      ClassUpStatus: zeroS,
    };
  }
  return {
    TotalStatus: total,
    CharacterLevelStatus: lv,
    CurrentBreakLimitStatus: bl,
    TrainingBoardStatusValue: zeroS,
    TrainingBoardStatusPercent: pct100,
    MemoryBookStatusPercent: pct100,
    MasterRankStatusPercent: pct100,
    LegendMasteryPercent: pct100,
    FavorabilityStatus: zeroS,
    ClassUpStatus: zeroS,
    TenmeiMasteryEnhancementUpStatus: zeroS,
  };
}

/** 计算总战力（粗略：各项加权求和，保证是数字供客户端排序）。 */
/**
 * 属性综合值 —— 仅用于【按比例缩放战力】，不代表官方战力公式。
 * 系数取自 CombatPower/CombatPowerCalculation.csv 的前四项（HP 0.05 / ATKorMAGIC 2 /
 * DEF 2 / RESIST 2 / DEX 2）。因为缩放是比值，系数只要【同量级一致】即可，
 * 不必是官方的完整公式。
 */
export /** 两个属性对象逐项相加。 */
function addStat(a, b) {
  const o = zeroStat();
  for (const k of STAT_KEYS) o[k] = (Number(a && a[k]) || 0) + (Number(b && b[k]) || 0);
  return o;
}

/**
 * ★★★ 装备与护符的属性贡献 → `AdditionalStatus`（2026-10-16 用户报障后实现）★★★
 *
 * 用户报障：「**装备对战斗力及属性完全 0 影响**」（附截图：装 4 件 / 卸下后，
 *   HP 18774、アタック 1521、防御 443、战斗力 26371 **一模一样**）。
 *
 * ★ 我此前**完全没有维护 `AdditionalStatus`** —— 角色的属性只由 `TotalStatus` 决定，
 *   而 `TotalStatus` 的公式里**不含装备**（真机契约 169 个角色 × 11 子表 1859/1859 验证过）。
 *   ⇒ 装备穿上/卸下时，**没有任何字段变化** → 属性与战力都不动。
 *
 * ★★ 真机契约的决定性证据（`AdditionalStatus` 才是装备的载体）★★
 * ```
 *   Ch013500108（装 4 件）: 装备 statusList 累加 == AdditionalStatus（差 0，逐项完全一致）✅
 *   146 个【没装装备】的角色: AdditionalStatus **全部为 0** ✅
 *   ⇒ AdditionalStatus 的基础就是「已装备的 statusList 累加」，无其它常驻来源。
 *     （少数角色有额外差值 —— 来自技能/天赋等，那部分我没有数据源，如实标注。）
 * ```
 * ★ 装备的 `statusList` 有 type 1/2/3 三条（1=基础、2=附魔平值、3=附魔百分比），
 *   **三条都要累加**（真机验证：type1+2+3 之和才等于 AdditionalStatus）。
 * ★ 护符同理（`amulet_list[].status_list`，owner 字段是 `owner_character_id`）。
 */
export function equipSumOf(masterCharacterId, stateArg) {
  const s = stateArg || loadState();
  const out = zeroStat();
  const id = String(masterCharacterId || "");
  if (!id) return out;
  const IL = (s.ItemList || {});
  // ① 装备（owner 字段是 OwnerCharacterId）
  for (const e of (IL.EquipmentList || [])) {
    if (String(e.OwnerCharacterId || e.owner_character_id || "") !== id) continue;
    for (const st of (e.statusList || [])) {
      for (const k of STAT_KEYS) out[k] += Number(st[k]) || 0;
    }
  }
  // ★★★ 2026-10-26：PMA（PhysicalAndMagicalAttack，「攻击&魔法」）必须并入 ATK/MATK ★★★
  //   用户报障（截图证据）：卸下武器 ATK 1825 → 装上 2206（+381），而武器是
  //   「攻击&魔法 +141」+ 附魔「攻击+26 / 攻击15%」⇒ 381 = 141 + 26 + 214(=15%×基础1426)
  //   ⇒ PMA 是【并入面板攻击/魔法】的，不是独立字段（但 PMA 字段本身要保留，装备详情要显示）。
  //   契约档交叉验证：Ch008502106 的 AdditionalStatus.ATK=776，而 4 件装备的 ATK 合计只有 100
  //   （776 = 100 + PMA 141 + 附魔/天赋 535）⇒ 契约里的 ATK 已含 PMA。
  // ② 护符（owner 字段是 owner_character_id）
  for (const a of (IL.amulet_list || [])) {
    if (String(a.owner_character_id || a.OwnerCharacterId || "") !== id) continue;
    for (const st of (a.status_list || [])) {
      for (const k of STAT_KEYS) out[k] += Number(st[k]) || 0;
    }
  }
  // ★ PMA 并入 ATK / MATK（见上方注释；PMA 字段保留供装备详情展示）
  out.PhysicalAttack += out.PhysicalAndMagicalAttack;
  out.MagicalAttack += out.PhysicalAndMagicalAttack;
  // ★★★ 附魔套装（2 件套）的百分比 —— 由调用方折算成平值并入
  try { out.__setPct = enchantSetPct(s, id); } catch (e) { out.__setPct = {}; }
  return out;
}

/**
 * ★★★ 附魔套装（2026-10-27 实现）★★★
 * 用户报障闭环：4 件装备的 currentEnchantId 全是 Enchant_04（= Enchantgroup_04「迅击。」= 游戏内「クィック」），
 * 2 件套 = 攻击/魔法 +5% → 1422 × 5% = 71，正好补上此前算不出的 71 点攻击差。
 *
 * 数据源（EquipmentEnchant/，全部在 CSV 里，无需 prefa b）：
 *   Enchant.csv            EnchantID → EnchantgroupID（+ Name 显示名）
 *   DoubleEnchantEffect.csv EnchantgroupID → ApplyUp* / Up*Per（2 件套，百分比）
 *   QuatroEnchantEffect.csv EnchantID → SkillGroupId（4 件套，非面板属性：技能冷却等）
 */
let _enchantGroupMap = null, _doubleEffectMap = null;
function ensureEnchantSetTables() {
  if (_enchantGroupMap && _doubleEffectMap) return;
  _enchantGroupMap = new Map();
  _doubleEffectMap = new Map();
  try {
    const en = gTbl("EquipmentEnchant/Enchant.csv");
    for (const r of ((en && en.rows) || [])) {
      const id = String(r.EnchantID || "").trim();
      const g = String(r.EnchantgroupID || "").trim();
      if (id && g) _enchantGroupMap.set(id, g);
    }
  } catch (e) {}
  try {
    const de = gTbl("EquipmentEnchant/DoubleEnchantEffect.csv");
    const KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
    const APS = ["ApplyUpHP", "ApplyUpATK", "ApplyUpDEF", "ApplyUpMATK", "ApplyUpMDEF", "ApplyUpDEX"];
    const PER = ["UpHPPer", "UpATKPer", "UpDEFPer", "UpMATKPer", "UpMDEFPer", "UpDEXPer"];
    for (const r of ((de && de.rows) || [])) {
      const g = String(r.EnchantgroupID || "").trim();
      if (!g) continue;
      const eff = {};
      for (let i = 0; i < KEYS.length; i++) {
        if (String(r[APS[i]] || "") === "True") {
          const v = Number(r[PER[i]]) || 0;
          if (v) eff[KEYS[i]] = v;
        }
      }
      if (Object.keys(eff).length) _doubleEffectMap.set(g, eff);
    }
  } catch (e) {}
}
/** 统计该角色「同附魔系列」的件数 → 激活 2 件套 → 返回百分比 {Hp:.., PhysicalAttack:..} */
export function enchantSetPct(s, masterCharacterId) {
  ensureEnchantSetTables();
  const out = {};
  const eqs = ((s.ItemList || {}).EquipmentList || []).filter(function (e) {
    return String(e.OwnerCharacterId || e.owner_character_id || "") === String(masterCharacterId);
  });
  const groups = {};
  for (const e of eqs) {
    const en = String(e.currentEnchantId || "").trim();
    if (!en) continue;
    const g = _enchantGroupMap.get(en);
    if (!g) continue;
    groups[g] = (groups[g] || 0) + 1;
  }
  for (const g of Object.keys(groups)) {
    if (groups[g] < 2) continue;
    const eff = _doubleEffectMap.get(g);
    if (!eff) continue;
    for (const k of Object.keys(eff)) out[k] = (out[k] || 0) + eff[k];
  }
  return out;
}

function statusScore(t) {
  if (!t) return 0;
  return (t.Hp || 0) * 0.05 + Math.max(t.PhysicalAttack || 0, t.MagicalAttack || 0) * 2 +
    (t.PhysicalDefence || 0) * 2 + (t.MagicalDefence || 0) * 2 + (t.Technique || 0) * 2;
}

/**
 * ★★ レジェンドマスタリー（LegendMastery）的百分比加成 —— 169/169 全量验证通过 ★★
 *
 * 数据链（三跳）：
 *   state.legend_mastery_list.legend_enhance_info_list[]
 *     [{legend_mastery_group_id, legend_mastery_node_id, legend_mastery_node_level}]
 *   → LegendMastery/LegendMastery.csv：(GroupID, NodeID) → LegendMasteryEffectID
 *   → LegendMastery/LegendMasteryEffect.csv：EffectID →
 *       (CharacterType, SoldierType, BasicStatusType, LegendMasteryEffectValueLv1..Lv5)
 *
 * 适用判定（实测）：
 *   · CharacterType：主角色取 {1,5}，支援角色取 {2,5}（5 = 通用）
 *   · SoldierType  ：等于该角色的 SoldierType 或 98（98 = 通用）
 *   · 取值：LegendMasteryEffectValueLv<节点等级>（上限 5）
 *
 * BasicStatusType → 属性 的映射（实测两套）：
 *   · 普通兵种：  1→Hp   8→ATK+DEF   9→MATK+MDEF
 *   · 魔法兵种(5)：1→Hp   8→ATK+MATK  9→DEF+MDEF
 *   ★ 第一版我按「B=8→ATK、B=9→MATK」单属性映射 → 130/169；
 *     补上「一个 B 覆盖两个属性」+ 魔法兵种特例后 → **169/169**。
 *
 * @param {string} masterCharacterId
 * @param {boolean} isSup
 * @returns {{Hp:number,PhysicalAttack:number,...}} 百分比（0 = 无加成）
 */


// ============================================================================
// ★★ 养成系统加成（本轮用契约 169 个角色逐项验证，全部 169/169 命中）★★
//
// 这些函数产出 StatusList 的各子表。逐系统的数据链见各自注释。
// 统一约定：Value 类（数值）直接相加；Percent 类（百分比）相加后
//           TotalStatus = base × (1 + ΣPercent/100)。
// ============================================================================

/** 缓存的表（惰性加载）。 */
const _gTbl = {};
function gTbl(name) {
  if (!(name in _gTbl)) { try { _gTbl[name] = loadTable(name); } catch (e) { _gTbl[name] = null; } }
  return _gTbl[name];
}

/**
 * レベルマスタリー（LegendMastery）百分比 —— **169/169 验证通过**。
 * 数据链：legend_mastery_list[] → LegendMastery.csv(EffectID) → LegendMasteryEffect.csv
 * 适用：CharacterType 主取{1,5}/支援取{2,5}；SoldierType 等于自身或 98(通用)
 * BasicStatusType 映射：普通兵种 1→Hp 8→ATK+DEF 9→MATK+MDEF；
 *                        魔法兵种(5) 1→Hp 8→ATK+MATK 9→DEF+MDEF
 */
/**
 * ★★ 記憶の書（MemoryBook）百分比加成 —— **169/169 全量验证通过** ★★
 *
 * 数据链（三跳）：
 *   state.memory_book.memory_book_node_list[]  [{master_node_id, level}]
 *   → MemoryBook/MemoryBookNode.csv  NodeId → (BookId, PageType)
 *   → MemoryBook/MemoryBookNodeUpStatus.csv  (NodeId, NodeLv) → ApplyUpHP/UpHPPer …
 *   每节点贡献 = 累加 Level 1..N 的 Up*Per。
 *   客户端实证（MemoryBookUseCase.cs:99-103）：遍历 NodeLevelMasterModelDictionary，
 *     if (kv.Key > level) break;  total += kv.Value.UpPercentStatus;
 *
 * ★ 参与累加的是【4 本书】的【该角色兵种对应的一页】：
 *     Memory_Book_Class_1 / Memory_Book_Class_2 / Memory_Book_Symbol_1 / Memory_Book_Supporttype_1
 *   （Symbol_2 / Supporttype_2 不计入面板属性）
 *   兵种 → PageType（页面名即兵种组合）：
 *     pt1 = ソルジャー＆ランサー → 兵种 1,2    pt2 = ライダー＆エアリアル → 兵种 3,7
 *     pt3 = セイント＆ソーサラー → 兵种 4,5    pt4 = シューター＆アサシン  → 兵种 6,8
 *   ★ 实测 **4,5,6,8 全部用 pt3**（不是 pt4）—— 用 pt4 会让兵种 6,8 少 40%
 *     （差恒定 [40,40,40,40,40]）；改为一律 pt3 后 169/169 命中。
 *     （诚实标注：此结论来自实测，未在反编译代码里找到明文依据。）
 *
 * 界面交叉验证：用户截图「Class_2 页1」左下角 HP+19%/ATK+16%/DEF+0%/MATK+16%/MDEF+0%
 *   与我算的 Class_2|1 = [19,16,0,16,0] **逐项一致**。
 */
/**
 * ★★ 天命強化（TenmeiMastery）数值加成 —— **92/92 全量验证通过** ★★
 *
 * 数据链（两跳）：
 *   state.legend_mastery_list.tenmei_enhance_info_list[]
 *     [{tenmei_mastery_group_id, tenmei_mastery_level}]
 *   → LegendMastery/TenmeiMasteryGroup.csv  (Group, Level) → PowerUpValue
 *
 * 适用判定：角色的 Character.csv 的 **TenmeiType** 与 **TenmeiType2**
 *   各查一次 PowerUpValue，**两者相加**（TenmeiType2 为空则只算前者）。
 *   ★ 92 个角色里只有 2 个有 TenmeiType2，但都必须累加
 *     （Ch019700106: 2+4 → 64+68=132；Ch020000107: 5+6 → 66+66=132）
 *
 * 结果落到：PhysicalAttack 与 MagicalAttack（两者同值），其余为 0。
 *
 * 界面交叉验证：用户截图「レジェンドマスタリー → 天命強化」显示 6 张卡
 *   Lv 49/49/52/51/50/50 → +64/+64/+70/+68/+66/+66，
 *   与 state 的 tenmei_enhance_info_list 及本表的 PowerUpValue **逐项一致**。
 */
export function tenmeiMasteryStatus(masterCharacterId) {
  const out = zeroStat();
  const grpTbl = gTbl("LegendMastery/TenmeiMasteryGroup.csv");
  const chTbl = gTbl("Character/Character.csv");
  if (!grpTbl || !chTbl) return out;
  const chRow = chTbl.rows.find(function (r) { return r.CharacterID === masterCharacterId; });
  if (!chRow) return out;
  const s = loadState();
  const ti = (s.legend_mastery_list && s.legend_mastery_list.tenmei_enhance_info_list) || [];
  if (!ti.length) return out;
  const lvOf = function (g) {
    const e = ti.find(function (x) { return Number(x.tenmei_mastery_group_id) === Number(g); });
    return e ? (Number(e.tenmei_mastery_level) || 0) : 0;
  };
  let v = 0;
  for (const col of ["TenmeiType", "TenmeiType2"]) {
    const t = Number(chRow[col]) || 0;
    if (!t) continue;
    const lv = lvOf(t);
    if (!lv) continue;
    const row = grpTbl.rows.find(function (r) {
      return Number(r.TenmeiMasteryGroup) === t && Number(r.TenmeiMasteryLevel) === lv;
    });
    if (row) v += Number(row.PowerUpValue) || 0;
  }
  out.PhysicalAttack = v;
  out.MagicalAttack = v;
  return out;
}
export function memoryBookPercent(masterCharacterId, isSup) {
  const out = pctStat();
  const nodeTbl = gTbl("MemoryBook/MemoryBookNode.csv");
  const upTbl = gTbl("MemoryBook/MemoryBookNodeUpStatus.csv");
  const chTbl = gTbl("Character/Character.csv");
  if (!nodeTbl || !upTbl || !chTbl) return out;
  const s = loadState();
  const list = (s.memory_book && s.memory_book.memory_book_node_list) || [];
  if (!list.length) return out;
  const chRow = chTbl.rows.find(function (r) { return r.CharacterID === masterCharacterId; });
  if (!chRow) return out;
  // ★★★ 2026-10-22 修正：页号必须【按书种分别判】★★★
  // 用户报障：「シンボル记忆之书的加成没有效果，强化前后战斗力都是 14317」。
  // 根因：原实现用【兵种】算出一个 wantPage，然后拿它去过滤【所有书】——
  //   リトリー SoldierType=7 → wantPage="2"，于是只统计各书的 PageType=2。
  //   但她看的是「ナディアのページⅠ」= Memory_Book_Symbol_1 的 **PageType 3**，
  //   ⇒ 这批节点全被跳过 ⇒ 强化前后属性/战力完全不变。
  // 正确映射（逐书种，已用官方契约 25/25 角色交叉验证）：
  //   Class_N            → 兵种：1/2→1、3/7→2、4/5→3、6/8→4（4 页）
  //   Symbol_N           → ForceType（1=ゼニス / 2=オリジン / 3=ナディア）
  //   Supporttype_N      → SupportType（1=支援 / 2=攻撃 / 3=妨害）
  //   Class_Attribute_1  → PageType 5..8（相性组合，暂不计算）
  const SOLDIER_PAGE = { "1": "1", "2": "1", "3": "2", "7": "2", "4": "3", "5": "3", "6": "4", "8": "4" };
  const pageForBook = function (bookId) {
    const b = String(bookId || "");
    if (/^Memory_Book_Class_[0-9]+$/.test(b)) return SOLDIER_PAGE[String(chRow.SoldierType || "")] || "1";
    if (/^Memory_Book_Symbol_[0-9]+$/.test(b)) return String(chRow.ForceType || "");
    if (/^Memory_Book_Supporttype_[0-9]+$/.test(b)) return String(chRow.SupportType || "");
    return "";   // Class_Attribute 等：不臆造
  };
  const KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
  const cols = ["UpHPPer", "UpATKPer", "UpDEFPer", "UpMATKPer", "UpMDEFPer", "UpDEXPer"];
  const aps = ["ApplyUpHP", "ApplyUpATK", "ApplyUpDEF", "ApplyUpMATK", "ApplyUpMDEF", "ApplyUpDEX"];
  for (const n of list) {
    const meta = nodeTbl.rows.find(function (r) { return String(r.NodeId) === String(n.master_node_id); });
    if (!meta) continue;
    const wantPage = pageForBook(meta.BookId);
    if (!wantPage) continue;
    if (String(meta.PageType) !== wantPage) continue;
    for (let lv = 1; lv <= (Number(n.level) || 0); lv++) {
      const row = upTbl.rows.find(function (x) {
        return String(x.NodeId) === String(n.master_node_id) && Number(x.NodeLv) === lv;
      });
      if (!row) continue;
      for (let i = 0; i < KEYS.length; i++) if (row[aps[i]] === "True") out[KEYS[i]] += Number(row[cols[i]]) || 0;
    }
  }
  return out;
}
export function legendMasteryPercent(masterCharacterId, isSup) {
  const out = zeroStat();
  const lmTbl = gTbl("LegendMastery/LegendMastery.csv");
  const effTbl = gTbl("LegendMastery/LegendMasteryEffect.csv");
  const chTbl = gTbl("Character/Character.csv");
  if (!lmTbl || !effTbl || !chTbl) return out;
  const chRow = chTbl.rows.find(function (r) { return r.CharacterID === masterCharacterId; });
  if (!chRow) return out;
  const soldier = String(chRow.SoldierType || "");
  // ★★★ BasicStatusType 的映射 —— 2026-10-14 修正（此前是错的）★★★
  //
  // 用户报障：「legend强化，写的是加双攻，但是测试只加物理攻击不加魔法攻击」。
  //
  // 我此前的映射（错）：
  //   MAP_STD = { 1:Hp, 8:ATK+DEF, 9:MATK+MDEF }   ← 普通兵种
  //   MAP_MAG = { 1:Hp, 8:ATK+MATK, 9:DEF+MDEF }   ← 只有 SoldierType=5 才用
  // 真值（本轮实证）：
  //   { 1:Hp, 8:**ATK+MATK**, 9:**DEF+MDEF** }  ← 所有兵种一致，无「魔法兵种」特例
  //
  // ★ 权威依据（两条独立证据链）：
  //  ① 用户界面截图（决定性）：节点 Group2 Node1 的文案是
  //       「メイン＆サポートキャラの**アタック＆マジック**を2%アップ」
  //     而该节点 LegendMasteryEffectID=705980801 的 **BasicStatusType = 8**
  //     ⇒ 8 = アタック＆マジック = ATK + MATK。同理 9 = ディフェンス＆レジスト = DEF + MDEF。
  //  ② 契约量化对比（用契约自己的 legend 输入，93 个角色）：
  //       现状 8=ATK+DEF / 9=MATK+MDEF  → **82/93**
  //       候选 8=ATK+MATK / 9=DEF+MDEF  → **93/93** ✅
  //     失配的 11 个全是 SoldierType=5：现状给 ATK=13/MATK=15，真值 ATK=15/MATK=15。
  //
  // ★★ 为什么我此前会误判为「169/169 验证通过」★★
  //   契约 93 个角色里有 **82 个**的 LegendMasteryPercent 四项（ATK/DEF/MATK/MDEF）恰好相等
  //   —— 对 ATK+DEF 与 ATK+MATK 两种映射**完全无法区分**。
  //   只有 11 个兵种 5 的角色有区分力，而我当时没有单独看它们。
  //   ⇒ **教训：验证数据若在关键维度上退化（此处 4 值相等），"全量通过"不代表算法正确。**
  //     必须确认「判据在待验证的那个维度上确实有区分力」。
  const MAP = { "1": ["Hp"], "8": ["PhysicalAttack", "MagicalAttack"], "9": ["PhysicalDefence", "MagicalDefence"] };
  const wantC = isSup ? ["2", "5"] : ["1", "5"];
  const list = (loadState().legend_mastery_list || {}).legend_enhance_info_list || [];
  for (const e of list) {
    const lr = lmTbl.rows.find(function (r) {
      return String(r.LegendMasteryGroupID) === String(e.legend_mastery_group_id) &&
             String(r.LegendMasteryNodeID) === String(e.legend_mastery_node_id);
    });
    if (!lr) continue;
    const eff = effTbl.rows.find(function (r) { return String(r.LegendMasteryEffectID) === String(lr.LegendMasteryEffectID); });
    if (!eff || wantC.indexOf(String(eff.CharacterType)) < 0) continue;
    const S = String(eff.SoldierType || "");
    if (S !== soldier && S !== "98") continue;
    const lv = Math.min(5, Math.max(1, Number(e.legend_mastery_node_level) || 0));
    const v = Number(eff["LegendMasteryEffectValueLv" + lv]) || 0;
    for (const k of (MAP[String(eff.BasicStatusType)] || [])) out[k] += v;
  }
  return out;
}

/**
 * 親愛度（Favorability）数值加成 —— **169/169 验证通过**。
 * 数据链：角色 favorability_level → 解锁 ReleaseTagCondition/FavoriteCondition.csv 里
 *         Lv ≤ 当前好感的 ReleaseTag → FavoriteStatus/FavoriteStatusSetting.csv 的 Up*
 * 前缀：主角色 Favorite_Main_StatusUp / 支援角色 Favorite_Support_StatusUp
 */
export function favorabilityStatus(masterCharacterId, isSup, favLevel) {
  const out = zeroStat();
  const fkTbl = gTbl("ReleaseTagCondition/FavoriteCondition.csv");
  const fsTbl = gTbl("FavoriteStatus/FavoriteStatusSetting.csv");
  if (!fkTbl || !fsTbl) return out;
  const lv = Number(favLevel) || 0;
  const pref = isSup ? "Favorite_Support_StatusUp" : "Favorite_Main_StatusUp";
  // ① 该 Tag 的解锁门槛：FavoriteCondition 里 ReleaseTag → 最小 Lv
  const tagLv = {};
  for (const r of fkTbl.rows) {
    const t = r.ReleaseTag; if (!t) continue;
    const v = Number(r.Lv) || 0;
    if (!(t in tagLv) || v < tagLv[t]) tagLv[t] = v;
  }
  // ② 累加已解锁 Tag 的加成
  const KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
  const cols = ["UpHP", "UpATK", "UpDEF", "UpMATK", "UpMDEF", "UpDEX"];
  const aps = ["ApplyUpHP", "ApplyUpATK", "ApplyUpDEF", "ApplyUpMATK", "ApplyUpMDEF", "ApplyUpDEX"];
  for (const r of fsTbl.rows) {
    const t = r.ReleaseTag;
    if (!t || t.indexOf(pref) < 0) continue;
    if (lv < (tagLv[t] || 999)) continue;
    for (let i = 0; i < KEYS.length; i++) {
      if (r[aps[i]] === "True") out[KEYS[i]] += Number(r[cols[i]]) || 0;
    }
  }
  return out;
}

/**
 * クラスアップ（ClassUp）数值加成 —— **169/169 验证通过**。
 * 数据链：ClassUp/ClassUpLevelParameter.csv 的 (CharacterType, SoldierType, Level)
 *         → ApplyUp* / Up* 列；累加 Level 1..class_level。
 * CharacterType：主 1 / 支援 2。
 */
export function classUpStatus(masterCharacterId, isSup, classLevel) {
  const out = zeroStat();
  const tbl = gTbl("ClassUp/ClassUpLevelParameter.csv");
  const chTbl = gTbl("Character/Character.csv");
  if (!tbl || !chTbl) return out;
  const chRow = chTbl.rows.find(function (r) { return r.CharacterID === masterCharacterId; });
  if (!chRow) return out;
  const soldier = String(chRow.SoldierType || "");
  const ctype = isSup ? "2" : "1";
  const KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
  const cols = ["UpHP", "UpATK", "UpDEF", "UpMATK", "UpMDEF", "UpDEX"];
  const aps = ["ApplyUpHP", "ApplyUpATK", "ApplyUpDEF", "ApplyUpMATK", "ApplyUpMDEF", "ApplyUpDEX"];
  for (let lv = 1; lv <= (Number(classLevel) || 0); lv++) {
    const r = tbl.rows.find(function (x) {
      return String(x.CharacterType) === ctype && String(x.SoldierType) === soldier && Number(x.Level) === lv;
    });
    if (!r) continue;
    for (let i = 0; i < KEYS.length; i++) if (r[aps[i]] === "True") out[KEYS[i]] += Number(r[cols[i]]) || 0;
  }
  return out;
}

/** マスターランク（MasterRank）百分比 —— **169/169 验证通过**。 */
export function masterRankPercent() {
  const out = pctStat();
  const tbl = gTbl("MasterRank/MasterRankBonus.csv");
  if (!tbl) return out;
  const rank = Number((loadState().master_rank_data || {}).master_rank) || 0;
  const r = tbl.rows.find(function (x) { return Number(x.MasterRank) === rank; });
  const v = r ? (Number(r.AllStatsBoost) || 0) : 0;
  for (const k of STAT_KEYS) out[k] = v;
  return out;
}

/**
 * トレーニングボード（训练板）百分比 —— **169/169 验证通过**。
 * 数据链（两跳）：
 *   TrainingNode[]（角色的已解锁节点）→ TrainingBoard/TrainingNode.csv 取 NodeType
 *   → TrainingBoard/{Main|Support}ParameterUp.csv 的 (CharacterID, NodeType) 取 Up*Per
 *   按节点 Level 累加 Level 次。
 * ★ 主/支援用**不同的表**（MainParameterUp / SupportParameterUp）——
 *   只查 Main 会漏掉全部支援角色（实测 152/169）。
 */
/**
 * 按【档位】返回训练板百分比（初級=1 / 中級=2 / 上級=3 / 特級=4）。
 * 用途：战力公式里每一档的加成系数不同（用户定义的 1.05 / 1.10 / 1.15 / 1.20）。
 */
export function trainingBoardPercentByTier(masterCharacterId, isSup) {
  const out = { 1: pctStat(), 2: pctStat(), 3: pctStat(), 4: pctStat() };
  const tnTbl = gTbl("TrainingBoard/TrainingNode.csv");
  const puTbl = gTbl(isSup ? "TrainingBoard/SupportParameterUp.csv" : "TrainingBoard/MainParameterUp.csv");
  if (!tnTbl || !puTbl) return out;
  const KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
  const cols = ["UpHPPer", "UpATKPer", "UpDEFPer", "UpMATKPer", "UpMDEFPer", "UpDEXPer"];
  const aps = ["ApplyUpHP", "ApplyUpATK", "ApplyUpDEF", "ApplyUpMATK", "ApplyUpMDEF", "ApplyUpDEX"];
  const nodes = (loadState().TrainingNode || []).filter(function (n) { return n.MasterCharacterId === masterCharacterId; });
  for (const n of nodes) {
    const meta = tnTbl.rows.find(function (r) { return String(r.NodeId) === String(n.NodeId); });
    if (!meta) continue;
    const bt = Number(n.BoardType || meta.BoardType) || 1;
    const tier = out[bt] ? bt : 1;
    const pr = puTbl.rows.find(function (r) {
      return String(r.CharacterID) === masterCharacterId && String(r.NodeType) === String(meta.NodeType);
    });
    if (!pr) continue;
    for (let i = 0; i < (Number(n.Level) || 0); i++) {
      for (let j = 0; j < KEYS.length; j++) if (pr[aps[j]] === "True") out[tier][KEYS[j]] += Number(pr[cols[j]]) || 0;
    }
  }
  return out;
}

export function trainingBoardPercent(masterCharacterId, isSup) {
  const out = pctStat();
  const tnTbl = gTbl("TrainingBoard/TrainingNode.csv");
  const puTbl = gTbl(isSup ? "TrainingBoard/SupportParameterUp.csv" : "TrainingBoard/MainParameterUp.csv");
  if (!tnTbl || !puTbl) return out;
  const KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
  const cols = ["UpHPPer", "UpATKPer", "UpDEFPer", "UpMATKPer", "UpMDEFPer", "UpDEXPer"];
  const aps = ["ApplyUpHP", "ApplyUpATK", "ApplyUpDEF", "ApplyUpMATK", "ApplyUpMDEF", "ApplyUpDEX"];
  const nodes = (loadState().TrainingNode || []).filter(function (n) { return n.MasterCharacterId === masterCharacterId; });
  for (const n of nodes) {
    const meta = tnTbl.rows.find(function (r) { return String(r.NodeId) === String(n.NodeId); });
    if (!meta) continue;
    const pr = puTbl.rows.find(function (r) {
      return String(r.CharacterID) === masterCharacterId && String(r.NodeType) === String(meta.NodeType);
    });
    if (!pr) continue;
    for (let i = 0; i < (Number(n.Level) || 0); i++) {
      for (let j = 0; j < KEYS.length; j++) if (pr[aps[j]] === "True") out[KEYS[j]] += Number(pr[cols[j]]) || 0;
    }
  }
  return out;
}

/**
 * ★★ 重算角色的全部 StatusList（收口）★★
 * 用当前 state 的养成数据重算所有子表，并算出 TotalStatus。
 */
export function recomputeStatusList(ch) {
  if (!ch) return ch;
  const id = ch.master_character_id;
  const code = ch.master_status_code || "";
  const isSup = isSupportCharacter(id);
  const fresh = buildStatusList(id, code, ch.level, ch.break_limit);
  const prev = (ch.StatusList && typeof ch.StatusList === "object") ? ch.StatusList : {};
  // ★ 旧综合分 = TotalStatus + AdditionalStatus（装备加成的旧值）
  const oldAdd = isSup ? (ch.additional_status || {}) : (ch.AdditionalStatus || {});
  const oldScore = statusScore(prev.TotalStatus) + statusScore(oldAdd);
  const next = Object.assign({}, prev);
  next.CharacterLevelStatus = fresh.CharacterLevelStatus;
  next.CurrentBreakLimitStatus = fresh.CurrentBreakLimitStatus;
  // 养成系统的实时值（这些会随玩家操作变化）
  next.FavorabilityStatus = favorabilityStatus(id, isSup, ch.favorability_level);
  next.ClassUpStatus = classUpStatus(id, isSup, ch.class_level);
  next.MasterRankStatusPercent = masterRankPercent();
  next.TrainingBoardStatusPercent = trainingBoardPercent(id, isSup);
  if (isSup) next.LegendMasteryStatusPercent = legendMasteryPercent(id, true);
  else next.LegendMasteryPercent = legendMasteryPercent(id, false);
  // 记忆之书（已破解，169/169）
  next.MemoryBookStatusPercent = memoryBookPercent(id, isSup);
  // 天命强化（已破解，92/92）
  next.TenmeiMasteryEnhancementUpStatus = tenmeiMasteryStatus(id);
  for (const k of Object.keys(fresh)) if (!(k in next)) next[k] = fresh[k];
  // ★★★ 2026-10-22：支援角色的 total_base_status 必须【每次重算】★★★
  //   缺陷实证（verify_vs_live 抓到）：Ch005700203 存档里 total_base_status=662，
  //   而真机契约是 914 —— 它是【造角色时】算的，之后升级/突破/class 都不更新，
  //   而 computeTotalStatus(支援) 恰恰以它为基数 ⇒ 该角色全属性偏低 ~27%，
  //   CharaBattlePower 也跟着错。
  //   构成（4 个样本逐字段验证）：Level + BreakLimit + Favorability + ClassUp
  //                              + Tenmei + TrainingBoardStatusValue
  if (isSup) {
    const _b = {};
    const _parts = ["CharacterLevelStatus","CurrentBreakLimitStatus","FavorabilityStatus","ClassUpStatus","TenmeiMasteryEnhancementUpStatus","TrainingBoardStatusValue"];
    for (const k of ["Hp","PhysicalAttack","PhysicalDefence","MagicalAttack","MagicalDefence","Technique","PhysicalAndMagicalAttack"]) {
      let v = 0;
      for (const t2 of _parts) { const o = next[t2]; if (o && typeof o === "object") v += Number(o[k]) || 0; }
      _b[k] = v;
    }
    next.total_base_status = _b;
  }
  next.TotalStatus = computeTotalStatus(next, isSup);
  // ★★★ 2026-10-28：同时保留【未取整】的浮点版本，供战力计算用 ★★★
  //   下发给客户端的 StatusList.TotalStatus 必须是整数（契约如此），
  //   但战力公式内部用精确浮点 ⇒ 本地服务端的 BP 与自己的属性完全自洽，
  //   不会把「属性取整」的误差二次带进 BP。
  //   存在【顶层】__totalStatusRaw（绝不挂到角色对象上 —— 那会污染契约键集，已踩过 5 次）。
  try {
    const _s = loadState();
    if (_s) {
      _s.__totalStatusRaw = _s.__totalStatusRaw || {};
      _s.__totalStatusRaw[String(id)] = computeTotalStatus(next, isSup, { raw: true });
    }
  } catch (e) { console.error("[bp] rawStatus: " + e.message); }
  ch.StatusList = next;
  // ★★★ 装备/护符 → AdditionalStatus（差量调整，2026-10-16 二次修正）★★★
  //
  // ★ 第一版（错）：`newAdd = 装备和` —— 把整个 AdditionalStatus 重写成「装备和」。
  //   反编译证据（`Assembly-CSharp__89.cpp:11800`，源 CharacterUseCase.cs:430-447）：
  //     `GetCharacterAdditionalStatusByCharacterId` **只是直接读服务端下发的值**（零计算），
  //     即面板的「加算值」完全由服务端决定 ⇒ 服务端写多少，界面就显示多少。
  //   而**真机契约里它 ≠ 装备和**（15 个已装备角色里 14 个有差值，且各不相同）：
  //     Ch016802106: 实际 {Hp:483,PATK:412,PDEF:89,MATK:201,MDEF:68,Tech:46,PMA:141}
  //                  装备和 {Hp:483,PATK:21, PDEF:50,MATK:7,  MDEF:61,Tech:46,PMA:141}
  //                  差     {        PATK:391,PDEF:39,MATK:194,MDEF:7}
  //     Ch013500108 恰好无差（唯一）—— 我此前就是拿它当样本得出「等于装备和」的错误结论。
  //   ★ 那部分差值（天赋技能等）的**输入不在契约里**（无 TalentSkillLevel 字段）⇒ 无法算出。
  //     ⇒ 正确做法是【差量调整】：保留服务端原有的非装备部分，只按装备变化量增减。
  //
  //   ★ 主角色用 `AdditionalStatus`（大写）、支援用 `additional_status`（小写）—— 两套字段名。
  const equipSum = equipSumOf(id);
  // ★★★ 附魔套装百分比 → 折算成平值（TotalStatus × pct%），并入 equipSum
  //   这样差量调整、__equipSums 基准都自动包含套装，不会重复加。
  try {
    const _setPct = equipSum.__setPct || {};
    const _ts = next.TotalStatus || {};
    for (const _k of STAT_KEYS) {
      const _p = Number(_setPct[_k]) || 0;
      if (!_p) continue;
      equipSum[_k] = (Number(equipSum[_k]) || 0) + Math.round((Number(_ts[_k]) || 0) * _p / 100);
    }
    delete equipSum.__setPct;
  } catch (e) {}
  const curAdd = (isSup ? ch.additional_status : ch.AdditionalStatus) || {};
  const prevEquip = equipSumBase(loadState(), id);
  const sumOf = function (o) { return STAT_KEYS.reduce(function (s, k) { return s + (Number(o && o[k]) || 0); }, 0); };
  let nextAdd;
  if (prevEquip) {
    // 已有基准 → 只把「装备和的变化量」叠加到现值上（非装备部分原样保留）
    nextAdd = {};
    for (const k of STAT_KEYS) nextAdd[k] = (Number(curAdd[k]) || 0) + (Number(equipSum[k]) || 0) - (Number(prevEquip[k]) || 0);
  } else if (sumOf(curAdd) === 0) {
    // 首次且当前为 0（新造角色 / 从未装备）→ 就是装备本身
    nextAdd = equipSum;
  } else {
    // 首次且当前非 0（契约播种的真机值，含非装备部分）→ **不动**，避免抹掉算不出的那部分
    nextAdd = curAdd;
  }
  for (const k of STAT_KEYS) if (nextAdd[k] < 0) nextAdd[k] = 0;
  if (isSup) ch.additional_status = nextAdd; else ch.AdditionalStatus = nextAdd;
  // ★ 记录本次的「装备和」作为下次差量调整的基准（放顶层 __equipSums，不污染角色对象）
  setEquipSumBase(loadState(), id, equipSum);
  // ★ 支援角色：公式已精确破解（5 级号 10/10，误差<0.2%）→ 直接按公式算
  // ★ 主角色：B 里还有未解出的项（タレントLv/強化ボード等级不在 API 里），
  //   采用「保持原值 × 属性变化比例」—— 方向正确、绝对值近似。
  if (isSup) {
    // ★ 2026-10-22：支援与主角色【同一套公式】（A 用 属性+装备加成；乘数含 ★/技能/class/engage/板子）
    const _st = loadState();
    ch.StatusList = next;                       // 让 characterBattlePower 读到最新属性
    if (ch.CharaBattlePower !== undefined) ch.CharaBattlePower = characterBattlePower(ch, [], _st);
  } else {
    const newScore = statusScore(next.TotalStatus) + statusScore(nextAdd);
    const ratio = (oldScore > 0 && newScore > 0) ? (newScore / oldScore) : 1;
    // ★★★ 2026-10-22：link 合计 与 「按属性比例缩放」必须分开处理 ★★★
    //   TotalBattlePower = 自身战力(__ownBP) + Σ(挂在该 main 上的支援战力)。
    //   如果对整个 TotalBattlePower 乘 ratio，支援那部分会被反复放大；
    //   所以这里只缩放【自身那部分】，支援部分原样保留（由 state.syncLinkBattlePower 维护）。
    if (ch.TotalBattlePower !== undefined) {
      const _st = loadState();
      const _key = String(ch.master_character_id);
      const _linked = (((_st.CharacterList || {}).supportCharacterList) || []).filter(function (sp) {
        return String(sp.LinkedCharacterId || "") === _key;
      });
      ch.TotalBattlePower = characterBattlePower(ch, _linked, _st);
    }
    if (ch.CharaBattlePower !== undefined) ch.CharaBattlePower = Math.max(1, Math.round((ch.CharaBattlePower || 0) * ratio));
  }
  return ch;
}

/**
 * 战力（TotalBattlePower / CharaBattlePower）。
 *
 * ★★ 支援角色：公式已精确破解（10/10 命中，误差 <0.2%）★★
 *
 *   BP(支援) = rawBase(TotalStatus) × (1 + break_limit × 0.1)
 *
 *   验证来源：**5 级号（什么都没练的干净样本）** 的 10 个支援角色，
 *   rawBase 用 TotalStatus（支援的 TotalStatus 已含 total_base_status）。
 *   例：Ch004500201 brk=2 raw=323.3 → 算 388.0 / 实际 388（误差 0.01%）。
 *
 * ★★ 主角色：只做到近似（如实说明）★★
 *
 *   已知结构（wiki 原文 + 实测）：
 *     `戦闘力 = A(ステータスに基づく基礎値) × B(☆やマスターレベルなどによる倍率)`
 *   已确认：
 *     · A 的系数 = HP×0.05 + max(ATK,MATK)×2 + DEF×2 + MDEF×2
 *       （与支援同源，取自 CombatPower/CombatPowerCalculation.csv）
 *     · B 含 (1 + break_limit × 0.1) —— 支援角色验证精确
 *   未解出：B 里还有一项（倍数 ÷ (1+brk×0.1) 的中位数 ≈ 1.03~1.06，
 *     但离散度到 4.3）。用 92 个主角色拟合线性/乘法模型全部不收敛：
 *     · 线性回归出现负系数（-70.9），物理上不可能
 *     · 5 个精确状态（同一角色逐步卸装）解 5 未知必定完美 → 过拟合，无意义
 *     · 8 个「什么都没练」的主角色解 7 未知 → 第 8 个偏 1055，证明缺变量
 *   缺的输入：**タレントLv（= 星级，最大 6）** 与 **強化ボード能力等级**
 *     —— 这两个在 `user_load_user_data` 的 47 个顶层键里**完全不存在**
 *     （搜 talent/star 关键字零命中），需要逆向服务端才能拿到。
 *
 * 因此主角色采用：**保持服务端给的原值，按属性变化比例缩放**
 *   —— 保证「强化后战力立即变化」且方向正确，绝对值不追求精确。
 *
 * ★ 重要：战力只用于界面显示，客户端不做任何战斗计算
 *   （反编译确认：BattleFormula.GetMainBattlePowerForOutGame 直接返回
 *    字段值，没有任何公式）。真正决定战斗结果的是 TotalStatus。
 */
/**
 * ★★ 战力公式的「A 项」（属性基础值）★★
 *
 * 权威系数来自 CombatPower/CombatPowerCalculation.csv（Type=1 为线性项）：
 *   HP ×0.05 / ATKorMAGIC ×2 / DEF ×2 / RESIST ×2 ；DEX（テクニック）是 Type=2 无系数，
 *   用 437 条 all_character_max_status_list + 92 个主角色拟合，得 ≈0.8（0.5~1.0 之间误差都 <2%）。
 *
 * 用契约实证（contracts/user_load_user_data.json）：
 *   70 个「没练过強化ボード」的角色，BP = (A_main + A_support) × (1 + 0.1×(★main + ★support))
 *   平均误差 1.2%（最好 0.1%）。
 */
// ★ 角色的攻击类型（Character.csv 的 CharacterAttackType）：1=物理 2=魔法
let _atkTypeMap = null;
function atkTypeOf(masterCharacterId) {
  if (!_atkTypeMap) {
    _atkTypeMap = new Map();
    try {
      const tbl = loadTable("Character/Character.csv");
      for (const r of ((tbl && tbl.rows) || [])) {
        const id = String(r.CharacterID || "");
        if (id) _atkTypeMap.set(id, String(r.CharacterAttackType || "1"));
      }
    } catch (e) { console.error("[bp] atkTypeOf: " + e.message); }
  }
  return _atkTypeMap.get(String(masterCharacterId)) || "1";
}
export { atkTypeOf };

// ★★★ 2026-10-28 新增：誓约技能（EngageSkill.csv 的 AfterSkillGroupID）集合 ★★★
//   誓约会把角色的部分技能替换成「♥」强化版（Before → After），
//   战力公式的 MainCharacterEngagedSetSkillAmount(0.05) 作用对象是【已装备的誓约技能个数】，不是「角色是否誓约」。
//   证据（游戏内 12 组实测）：同 cost 2 单技能，誓约版 12446 vs 非誓约版 12136，差 310 = 0.05×Am×lvF。
let _engSkillSet = null;
function engageSkillSet() {
  if (!_engSkillSet) {
    _engSkillSet = new Set();
    try {
      const tbl = loadTable("Engage/EngageSkill.csv");
      for (const r of ((tbl && tbl.rows) || [])) {
        const a = String(r.AfterSkillGroupID || "");
        if (a) _engSkillSet.add(a);
      }
    } catch (e) { console.error("[bp] engageSkillSet: " + e.message); }
  }
  return _engSkillSet;
}
export { engageSkillSet };

export function battlePowerBase(totalStatus, additional, atkType, withTech) {
  // ★ withTech=false → 不计 TECH 项（支援角色攻击不判暴击，TECH 对支援无意义）
  const t = Object.assign({}, totalStatus || {});
  if (additional) for (const k of Object.keys(additional)) t[k] = (Number(t[k]) || 0) + (Number(additional[k]) || 0);
  // ★★★ 2026-10-28 修正：ATKorMAGIC 不是取 max，而是【按 CharacterAttackType 选】
  //   1 = 物理攻击型 → 用 PhysicalAttack；2 = 魔法攻击型 → 用 MagicalAttack
  //   证据：66 个白板角色全量验证 —— 取 max 时有 1 个角色偏 +6.19%（Ch018900101，
  //         MATK 562 > ATK 514 但它是物理型），改为按类型取后 66/66 全部 <0.5%（max 0.40%）。
  //   注：默认 "1"（物理），因为 877 个角色里 625 个是物理型。
  const _atk = (String(atkType) === "2")
    ? (Number(t.MagicalAttack) || 0)
    : (Number(t.PhysicalAttack) || 0);
  // ★★★ 2026-10-28 最终修正：Technique（DEX）项是【幂函数】而不是线性 ★★★
  //   证据：12 个 Lv100 满级预览角色（class=0/5★/板全开/满好感/无装备无link，
  //        官方商店图鉴的「ステータス」页，TECH 范围 137~525）：
  //        拟合 Am = base + a×TECH^p 得 p=1.300、a=0.0638、mult=1.7239，
  //        12 点误差全部 ≤0.37%（RMSE 0.168%）。
  //   对照：线性 0.22×TECH 时 12 点 max 误差 0.42%，且白板 max 3.73%；幂函数时白板 max 1.98%。
  //   物理含义：TECH 低时（Lv1 角色 44~103）几乎等价于线性 0.22；TECH 高时（Lv100 约 300~500）放大 1.5~1.8 倍。
  // ★★★ 2026-10-29 定版：TECH 项 = 0.2154 × TECH（线性）★★★
  //   依据：12 个霍恩海姆实测点（TECH 39→88、星级 1→5，ATK 固定 359）联合反解，
  //   未知数 2 个（TECH 系数 k、装备星级系数 c）、方程 12 个 ⇒ 唯一解 k=0.2154 / c=0.0200，
  //   而 c 恰好等于表值 EquipAbilityLv=0.02（交叉验证），12/12 全部 round 命中。
  //   幂函数 0.0638×TECH^1.3 已废弃（那是只用 12 个高等级预览点拟合的，白板不需要）。
  const _tech = Number(t.Technique) || 0;
  const _techTerm = (withTech === false) ? 0 : 0.2154 * _tech;
  return (Number(t.Hp) || 0) * 0.05 +
         _atk * 2 +
         (Number(t.PhysicalDefence) || 0) * 2 +
         (Number(t.MagicalDefence) || 0) * 2 +
         _techTerm;
}

/**
 * ★★ 主角色战力（官方公式的完整实现）★★
 *
 *   BP = (A_main + A_support) × ( 1 + 0.1×(★main + ★support)
 *                                  + 0.03×已装技能数      (MainCharacterSetSkillCost)
 *                                  + 0.1×class_level      (MasterClass)
 *                                  + 0.05×engage          (MainCharacterEngagedSetSkillAmount)
 *                                  + boardExtra )         (TrainingBoardAbilityLv×0.05，见下)
 *
 * 拟合/验证（contracts/user_load_user_data.json）：
 *   70 只「没练过強化ボード」的主角色（含 10 组 link 对）平均误差 0.91%，63/70 在 2% 内。
 *   DEX 系数用 0.25 时误差最小（0.5/0.8 分别 1.6%/1.2%）。
 *
 * ★ 已知缺口：強化ボード能力Lv（×0.05）与タレントLv（×0.1）**不在 user_load_user_data 里**，
 *   只能按 extra 参数补；本档 0 条培训板记录 ⇒ extra 恒为 0，公式对当前存档是精确的。
 */
// ★ 2026-10-27：战力公式新增辅助（用户 6.5 小时实测校验）
//   ① 技能 cost：SkillListActive 的 SkillSettingType=7 行，MainSettingValue = 该技能的 cost
//   ② 训练板技能节点：TrainingBoard/SkillSetting.csv 的 NodeType 落在技能区间（1001~1005 / 2001~2003）
let _skillCostMap = null;
export function skillCostOf(skillGroupId) {
  if (!_skillCostMap) {
    _skillCostMap = new Map();
    // ★★★ 2026-10-28 实测定位：cost 在 SkillSettingType=10 的 FirstSettingValue，不在 type=7 ★★★
    //   type=7 看起来更像「行动消耗」，与战力无关：
    //     1100019 t7=2 t10=2 ；1100029 t7=2 t10=1  ← t7 相同但战力加成不同
    //     1200406 t7=0 t10=2  ← 用户指出的「cost 2 的被动技能」
    //   用 t10 重算 65 个 Lv1 干净样本：偏差 <0.5% 的有 64/65（中位 0.054%），
    //   而用 t7 只有 51/65（中位 0.5%+）。
    //   两张表都要查：Active 是主动技能、Passive 是被动技能（被动同样有 cost 1/2）。
    for (const rel of ["Skill/SkillListActive.csv", "Skill/SkillListPassive.csv"]) {
      try {
        const tbl = loadTable(rel);
        const rows = (tbl && tbl.rows) || [];
        for (const r of rows) {
          if (String(r.SkillSettingType) !== "10") continue;
          const id = String(r.SkillGroupId || "");
          const v = Number(r.FirstSettingValue);
          if (id && Number.isFinite(v)) _skillCostMap.set(id, v);
        }
      } catch (e) { console.error("[bp] skillCostOf(" + rel + "): " + e.message); }
    }
  }
  return _skillCostMap.get(String(skillGroupId)) || 0;
}

let _boardSkillNodeTypes = null;   // Set<NodeType>
let _nodeIdToType = null;          // Map<NodeId, NodeType>
export function countBoardSkillNodes(s, masterCharacterId) {
  if (!_boardSkillNodeTypes) {
    _boardSkillNodeTypes = new Set();
    _nodeIdToType = new Map();
    try {
      const tbl = loadTable("TrainingBoard/SkillSetting.csv");
      const rows = (tbl && tbl.rows) || [];
      for (const r of rows) {
        const nt = Number(r.NodeType);
        if ((nt >= 1001 && nt <= 1005) || (nt >= 2001 && nt <= 2003)) _boardSkillNodeTypes.add(nt);
      }
    } catch (e) { console.error("[bp] countBoardSkillNodes(SkillSetting): " + e.message); }
    try {
      // ★★★ 2026-10-28 修复「恒返回 0」的根因 ★★★
      //   存档的 TrainingNode 元素字段是 { TreeID, BoardType, NodeMass, NodeX, NodeType?, NodeId, ... }，
      //   **其中 NodeId 是节点标识、NodeType 只存在于 TrainingNode.csv 的映射表**。
      //   旧实现直接读 node.NodeType → Number(undefined)=NaN → has(NaN)=false → 恒 0。
      const tbl2 = loadTable("TrainingBoard/TrainingNode.csv");
      const rows2 = (tbl2 && tbl2.rows) || [];
      for (const r of rows2) {
        const id = String(r.NodeId || "");
        if (id) _nodeIdToType.set(id, Number(r.NodeType));
      }
    } catch (e) { console.error("[bp] countBoardSkillNodes(TrainingNode): " + e.message); }
  }
  let n = 0;
  for (const node of ((s.TrainingNode || []))) {
    if (String(node.MasterCharacterId) !== String(masterCharacterId)) continue;
    // 兼容两种形态：老数据可能直接带 NodeType，新数据只有 NodeId
    let nt = Number(node.NodeType);
    if (!Number.isFinite(nt)) nt = _nodeIdToType.get(String(node.NodeId || ""));
    if (_boardSkillNodeTypes.has(nt)) n++;
  }
  return n;
}

export function characterBattlePower(ch, linkedSupports, st) {
  if (!ch) return 0;
  const s = st || loadState();
  const key = String(ch.master_character_id);
  const isSup = isSupportCharacter(key);

  // ① 自身 rawBase（TotalStatus + AdditionalStatus，含 DEX×0.22）
  // ★ 优先用未取整的 TotalStatus（__totalStatusRaw），没有则回退到整数版
  const _rawAll = (s && s.__totalStatusRaw) || {};
  const _stForBp = _rawAll[key] || (ch.StatusList && ch.StatusList.TotalStatus);
  const Am = battlePowerBase(_stForBp,
                             ch.AdditionalStatus || ch.additional_status,
                             atkTypeOf(key));

  // ② 训练板：技能节点数 + 等级和
  const boardSkillNodes = countBoardSkillNodes(s, key);
  let boardLvSum = 0;
  try {
    for (const n of ((s.TrainingNode || []))) {
      if (String(n.MasterCharacterId) !== key) continue;
      boardLvSum += Number(n.Level) || 0;
    }
  } catch (e) {}

  // ③ link：支援 rawBase 直接相加，并按【主角色的训练板等级和】放大
  //    ★ 2026-10-27 用户提示 + 27 个「有 link」角色反推 k：
  //      板 0 → k≈1.0，板 92 → k≈1.4~1.7，拟合 k = 1 + 0.004×板等级和
  //      ⇒ 属性节点对战力【只作用于 link 部分】（无 link 的角色完全不受影响）
  let As = 0, sStars = 0;
  try {
    for (const sp of (linkedSupports || [])) {
      // ★ 2026-10-28：支援侧同样优先用未取整的浮点属性（与主角色一致）
      const _sKey = String(sp.master_character_id);
      const _sSt = _rawAll[_sKey] || (sp.StatusList && sp.StatusList.TotalStatus);
      As += battlePowerBase(_sSt,
                            sp.additional_status || sp.AdditionalStatus,
                            atkTypeOf(_sKey),
                            false);   // ★ 支援不计 TECH（不判暴击）
      sStars += Number(sp.break_limit) || 0;
    }
  } catch (e) { console.error("[bp] link: " + e.message); }
  // ★★★ 2026-10-28 修正：link 放大系数 0.004 → 0.0025 ★★★
  //   白板公式（lvFactor=0.000819×(Lv-1) + ATK 按类型取）精确定标后，重解 28 个 link 角色的真实 L：
  //     板等和=0 的 10 个 → L 中位 0.9983（≈1.0，与「板 0 不放大」一致）；
  //     板等和>0 的 18 个 → L 落在 0.90~1.42，最小二乘 L = 1 + 0.0024×板等和。
  //   改后全量 RMSE 3.61% → 2.27%，p90 7.1% → 3.7%，max 13.9% → 7.7%（97 个主角色）。
  //   ★ 注意：L 在同板等和（92）的 14 个角色上仍从 1.041 散到 1.416，说明 link 还有角色相关变量未解出，
  //     这个 0.0025 是【经验系数】而非官方值 —— 精确值需游戏内 link 开/关对照实测。
  const linkScale = 1 + 0.0025 * boardLvSum;

  // ④ 装备：星级和 + 「4 格全附魔」二值
  let eqStar = 0, eqSlots = 0, enchSlots = 0;
  try {
    for (const e of ((s.ItemList && s.ItemList.EquipmentList) || [])) {
      if (String(e.OwnerCharacterId || "") !== key) continue;
      eqSlots++;
      eqStar += Number(e.break_limit) || 0;
      if (e.currentEnchantId || e.previewEnchantId) enchSlots++;
    }
  } catch (e) {}
  const fullEnchant = (eqSlots >= 4 && enchSlots >= 4) ? 0.045 : 0;

  // ⑤ 已装技能 cost 总和（支援没有装备技能）
  let skillCost = 0;
  if (!isSup) {
    try {
      for (const x of ((s.SetSkillList || []))) {
        if (String(x.master_character_id) !== key) continue;
        if (!x.master_skill_id) continue;
        skillCost += skillCostOf(x.master_skill_id);
      }
    } catch (e) {}
  }

  // ⑤.5 誓约（CombatPowerCalculation: MainCharacterEngagedSetSkillCost = 0.05）
  //    ★ 2026-10-28 用网页端 97 个主角色全量验证：
  //      加这一项 RMSE 3.16% → 3.03%，max 11.7% → 10.2%，均值 -0.30% → -0.07%（几乎无偏）
  //      表里本来就有这一行，属于「补上漏掉的项」，不是拟合出来的系数。
  // ★ 誓约项：改为「已装备的誓约技能（After 版）个数」
  let engagedSkillCount = 0;
  try {
    const eset = engageSkillSet();
    for (const x of ((s.SetSkillList || []))) {
      if (String(x.master_character_id) !== key) continue;
      if (x.master_skill_id && eset.has(String(x.master_skill_id))) engagedSkillCount++;
    }
  } catch (e) {}

  // ⑥ 乘数 —— ★★★ 2026-10-28 改为【按 CombatPowerCalculation.csv 的 Type 列分组】★★★
  //   该表 20 行，Type 分布：1=属性系数(5行) / 2=DEX(1行,系数空) / 3=养成度(9行) / 4=装备附加(5行) / 无Type=MasterClass(1行)
  //   穷举 6 个乘数项的 203 种「组内加算/组间乘算」分组后，按 Type 分组排第 4（RMSE 2.53%），
  //   而「全加算」（原实现）为 2.85%、「全乘算」为 14.69%（最差）。
  //   MasterClass 是唯一无 Type 的行，实测归入 Type3 最好（归 Type4 或独立乘都会差到 5%）。
  const type3 = 0.1 * ((Number(ch.break_limit) || 0) + sStars)   // MainCharacterStarAmount / SupportCharacterStarAmount
              + 0.1 * (Number(ch.class_level) || 0)              // MasterClass（无 Type）★ 定版：回归表值 0.1
              + 0.03 * skillCost                                  // MainCharacterSetSkillCost
              + 0.02 * eqStar                                     // EquipAbilityLv
              + 0.05 * engagedSkillCount                          // MainCharacterEngagedSetSkillAmount（誓约技能个数）
              + 0.05 * (boardSkillNodes);                         // TrainingBoardAbilityLv ★ 定版：回归表值 0.05（节点计数 bug 已修）
    //   ★ 注意：只计【主角色自己】的技能节点，不含支援角色的 sNodes ——
    //     支援节点若也加进来，每个 link 支援会额外贡献 0.045×5=0.225（对 mult≈2.5 是 +11%），
    //     实测全量 RMSE 会从 ~1.7% 恶化到 4.38%、max 15.5%，故已移除。
  const type4 = fullEnchant;                                      // EquippedEnchant（+ 技能类别×4，未接上）
  const mult = (1 + type3) * (1 + type4);

  // ⑦ 等级项
  // ★★★ 2026-10-28 最终修正：lvFactor = 1 + 0.000254×(Lv-1) ★★★
  //   这是【游戏内实测】反解出来的，不是拟合：
  //     ① アルテミス（单天命 68、3★、无技能无装备无 link）Lv1~11 共 11 个点：
  //        Lv1 lvF=0.99921、Lv11 lvF=1.00175 → 每级 +0.0254%
  //     ② ジャンヌ＆ミカエル（双天命 142）Lv1/30/60 三点 → 每级 +0.0254%
  //   两个角色独立一致 ⇒ k = 0.000254。
  //   （旧值 0.000819 是从 Lv116 单个点反解的，那点 Am 本身有 +6.24 的缺口，把误差全推给了 lvF，虚高 3.2 倍。）
  // ★ 定版：lvFactor 已移除 —— 表里没有这一行，且实测加上反而更差（RMSE 4.50%→6.33%）

  // ★ 定版：linkScale 已移除 —— 表里没有这一行，实测加上反而更差（RMSE 4.50%→9.81%）
  return Math.max(1, Math.round((Am + As) * mult));
}

export function battlePower(statusList, breakLimit, isSupport) {
  // ★ 2026-10-22：与 battlePowerBase 统一（含 DEX×0.25）——
  //   原先这里另写了一套 A（没有 DEX 项），导致主角与支援的 A 口径不一致。
  const A = battlePowerBase(statusList && statusList.TotalStatus, null);
  const B = 1 + (Number(breakLimit) || 0) * 0.1;
  return Math.round(A * B);
}


/**
 * 创建完整角色对象。
 * 字段清单参照存档里已有角色（17 个），确保与客户端预期一致。
 */
export function createCharacter(instanceId, accountId, masterCharacterId, opts) {
  const o = opts || {};
  // 默认按角色类型推导（支援角色必须用 ユーザ用サポート1）
  const code = o.code || statusCodeFor(masterCharacterId);
  const level = o.level || 1;
  // 初始星级：SSR 抽到手就是 3 星（见 initialBreakLimit 的说明）。
  // 早期写 o.breakLimit || 0，新角色全 0 星，界面才会提示「需要突破」。
  const breakLimit = (o.breakLimit === undefined || o.breakLimit === null)
    ? initialBreakLimit(masterCharacterId)
    : o.breakLimit;
  const status = buildStatusList(masterCharacterId, code, level, breakLimit);
  // 【关键】主角色与支援角色的字段名【完全不同】—— 必须分别构造。
  // 权威依据：契约 + 客户端类声明
  //   TemporaryMainCharacterDetail    : ... skill_cost_limit, StatusList, AdditionalStatus, TotalBattlePower
  //   TemporarySupportCharacterDetail : ... LinkedCharacterType, LinkedCharacterId, StatusList,
  //                                        additional_status, CharaBattlePower, additional_link_soldier_type_list
  // 早期我只生成「主角色」一套字段，支援角色也套用同一套 → 字段名全错：
  //   · additional_link_soldier_type_list 缺失 → 客户端 ImportDataStore 做 .ToList() 时
  //     抛 ArgumentNullException（source 为 null）→ 整次 load_user_data 失败 →
  //     客户端退回「新号」界面、所有功能上锁。
  const isSup = !!o.support;
  if (isSup) {
    return {
      id: instanceId,
      player_account_id: accountId,
      master_character_id: masterCharacterId,
      master_status_code: code,
      // 支援角色专属：链接对象。契约里恒为 0 / null。
      LinkedCharacterType: 0,
      LinkedCharacterId: null,
      level: level,
      exp: o.exp || 0,
      DateOfAcquisition: o.acquiredAt || 1700000000,
      break_limit: breakLimit,
      favorability_level: o.favorabilityLevel || 1,
      favorability_exp: 0,
      class_level: 0,
      is_new: o.isNew !== false,
      battle_join_count: 0,
      StatusList: status,
      // 注意小写 additional_status（主角色是大写 AdditionalStatus）
      additional_status: zeroStat(),
      // 注意 CharaBattlePower（主角色是 TotalBattlePower）
      CharaBattlePower: battlePower(status, breakLimit, true),
      // 【必须有值】客户端会对它做 .ToList()，null 会抛 ArgumentNullException
      additional_link_soldier_type_list: o.linkSoldierTypeList || [],
    };
  }
  const ch = {
    id: instanceId,
    player_account_id: accountId,
    master_character_id: masterCharacterId,
    master_status_code: code,
    level: level,
    exp: o.exp || 0,
    DateOfAcquisition: o.acquiredAt || 1700000000,
    break_limit: breakLimit,
    favorability_level: o.favorabilityLevel || 1,
    favorability_exp: 0,
    class_level: 0,
    is_new: o.isNew !== false,
    battle_join_count: 0,
    skill_cost_limit: o.skillCostLimit || 5,
    StatusList: status,
    // 契约里 AdditionalStatus 是【扁平】的属性对象（Hp/PhysicalAttack/...），
    // 早期写成嵌套的 { StatusList: {...} } —— 客户端读不到那 7 个字段。
    AdditionalStatus: zeroStat(),
    TotalBattlePower: battlePower(status, breakLimit, false),
  };
  return ch;
}

/**
 * 取角色的初始技能 id（Character.csv 的 InitialSkillId）。
 *
 * 为什么需要：契约的 MainCharacterSkill 里，第 1 条带【真实技能 id】（如 "1100002"），
 * 后 2 条是 null 占位。早期我把 3 条全写成 null，与契约类型不符。
 */
/**
 * 取角色的初始技能 id（Character.csv 的 InitialSkillId）。
 *
 * 契约的 MainCharacterSkill 第 1 条是【字符串】技能 id，后 2 条是 null。
 * 若该角色在 MasterData 里没有 InitialSkillId（支援角色常见），
 * 则回退到该角色技能组里的第一个技能 —— 保证类型是字符串而非 null。
 */
/**,
 * 取角色的初始技能 id。
 *
 * 权威来源：TrainingBoard/SkillSetting.csv（CharacterID -> SkillGroupID）。
 * 该表【同时覆盖主角与支援角色】：
 *   主角   Code=ユーザ用1        SkillGroupID 形如 1100002 / 1200001
 *   支援   Code=ユーザ用サポート1 SkillGroupID 形如 4100010
 * 早期只用 Character.csv 的 InitialSkillId —— 那只对主角有效，
 * 支援角色该字段为空，导致 MainCharacterSkill[0].master_skill_id 成了 null（契约要字符串）。
 */
export function initialSkillId(masterCharacterId) {
  ensure();
  if (!skillTbl) skillTbl = loadTable("TrainingBoard/SkillSetting.csv");
  // 优先 Character.csv 的 InitialSkillId —— 实测它与契约一致
  // （Ch001800103 -> "1100002"，契约正是 1100002）。
  if (charTbl) {
    const r = charTbl.rows.find(function (x) { return x.CharacterID === masterCharacterId; });
    if (r && r.InitialSkillId) return String(r.InitialSkillId);
  }
  // 回退：TrainingBoard/SkillSetting.csv（支援角色的 InitialSkillId 为空，
  // 该表按 CharacterID 给出 41xxxxx 的技能，取 NodeType 最小的那条）。
  if (skillTbl) {
    const rows = skillTbl.rows
      .filter(function (r) { return r.CharacterID === masterCharacterId && r.SkillGroupID; })
      .sort(function (a, b) { return (Number(a.NodeType) || 0) - (Number(b.NodeType) || 0); });
    if (rows.length) return String(rows[0].SkillGroupID);
  }
  return null;
}
/**
 * 取角色的 master_status_code。
 *
 * 权威规则（Character.csv + CharacterInitStatus.csv 实证）：
 *   SupportType == 0  -> 主角色   Code = "ユーザ用1"
 *   SupportType != 0  -> 支援角色 Code = "ユーザ用サポート1"
 *
 * 早期 createCharacter 一律用 "ユーザ用1"，导致抽到的支援角色 code 错误 ——
 * 客户端 CharacterUseCase.GetCharacterTalentSkillGroupId 用它查 CharacterCodeLinkedData
 * 查不到就抛 NullReferenceException，表现为抽卡结果页空白且按钮无响应。
 */
export function statusCodeFor(masterCharacterId) {
  ensure();
  if (!charTbl) return "ユーザ用1";
  const r = charTbl.rows.find(function (x) { return x.CharacterID === masterCharacterId; });
  if (!r) return "ユーザ用1";
  return (Number(r.SupportType) || 0) === 0 ? "ユーザ用1" : "ユーザ用サポート1";
}

/** 该角色是否支援角色（Character.csv 的 SupportType != 0）。 */
export function isSupportCharacter(masterCharacterId) {
  ensure();
  if (!charTbl) return false;
  const r = charTbl.rows.find(function (x) { return x.CharacterID === masterCharacterId; });
  return r ? (Number(r.SupportType) || 0) !== 0 : false;
}

// ---------- 等级 / 经验曲线 ----------
//
// 来源：Fusion/CharacterLevelUp.csv（Version, DefaultUnitType, Lv, NeedExp）。
// 累计 NeedExp 与角色总 exp 比较得出等级。
// 收口到本模块，供 character/enhance 与 battle/win 共用（避免两处各写一份）。
let lvTbl2 = null;
function ensureLv() { if (!lvTbl2) lvTbl2 = loadTable("Fusion/CharacterLevelUp.csv"); }

/** 角色所属的成长曲线类型（Character.csv 的 DefaultUnitType）。 */
export function unitTypeOf(masterCharacterId) {
  ensure();
  if (!charTbl) return 1;
  const r = charTbl.rows.find(function (x) { return x.CharacterID === masterCharacterId; });
  return r ? (Number(r.DefaultUnitType) || 1) : 1;
}

/** 角色兵种（Character.csv 的 SoldierType）。 */
export function soldierTypeOf(masterCharacterId) {
  ensure();
  if (!charTbl) return 0;
  const r = charTbl.rows.find(function (x) { return x.CharacterID === masterCharacterId; });
  return r ? (Number(r.SoldierType) || 0) : 0;
}

// ★★★ 2026-10-22：class up 的「技能费用 +N」权威来源 ★★★
//   用户口径：「第一级就加 skill cost 1 点，之后不再加，角色最大 skill cost = 6」。
//   数据实证（ClassUp/ClassUpLevelParameter.csv 的 SkillCost 列）：
//     CharacterType=1（主角色）Level 1 → SkillCost=1；Level 2/3/4 → 0
//     CharacterType=2（支援角色）Level 1 → 0
//   ⇒ 主角 class_level 0→1 时 skill_cost_limit 5→6，之后不再变。
let _classUpTbl = null;
export function classSkillCostFor(masterCharacterId, level) {
  if (!_classUpTbl) { try { _classUpTbl = loadTable("ClassUp/ClassUpLevelParameter.csv"); } catch (e) { _classUpTbl = { rows: [] }; } }
  const rows = (_classUpTbl && _classUpTbl.rows) || [];
  const ct = unitTypeOf(masterCharacterId);
  const st = soldierTypeOf(masterCharacterId);
  let r = rows.find(function (x) { return Number(x.CharacterType) === ct && Number(x.SoldierType) === st && Number(x.Level) === Number(level); });
  if (!r) r = rows.find(function (x) { return Number(x.CharacterType) === ct && Number(x.Level) === Number(level); });
  if (!r) r = rows.find(function (x) { return Number(x.Level) === Number(level); });
  return r ? (Number(r.SkillCost) || 0) : 0;
}

/** 按总经验换算等级。 */
export function levelForExp(unitType, totalExp) {
  ensureLv();
  if (!lvTbl2) return 1;
  let lv = 1, acc = 0;
  for (const r of lvTbl2.rows) {
    if (Number(r.DefaultUnitType || 0) !== unitType) continue;
    acc += Number(r.NeedExp || 0);
    if (totalExp >= acc) lv = Number(r.Lv || lv); else break;
  }
  return lv;
}

/** 升到【下一级】所需经验（用于契约的 before/afterRequiredExp）。 */
/**
 * ★★★ 角色的【本级内经验进度】与【升到下一级所需经验】（2026-10-14 新增）★★★
 *
 * ★ 关键陷阱：**同一个「经验」在两个端点里语义不同**（本项目已记录过此类陷阱）：
 *   · `user/load_user_data` 的 `CharacterList[].exp` = **累计经验**
 *     （实证：Ch011102101 lv114 exp=7621365，而 累计(114)=7620724 → 本级进度=641）
 *   · `battle/win` 响应的 `quest_result_temp.character_exp_info_list[].beforeExp`
 *     = **本级内的进度**（实证：同一角色该字段 = 641 = 7621365 - 7620724 ✓ 精确吻合）
 *   · 同理 `beforeRequiredExp` = **升到下一级所需的经验**（= 单级(beforeLevel+1)）
 *     而非「本级已消耗量」。
 *
 * 我此前把累计值直接填进 beforeExp → 客户端进度条会显示成一个巨大的数
 * （7621365 / 300000），与真机不符。
 */
export function currentLevelProgress(masterCharacterId, totalExp) {
  ensureLv();
  if (!lvTbl2) return 0;
  const ut = unitTypeOf(masterCharacterId);
  const lv = levelForExp(ut, totalExp);
  // 本级起点累计 = Σ(NeedExp over Lv=1..lv-1)
  //   注：NeedExp 是「升到该级所需」，故起点 = 到 lv-1 为止的和。
  // ★ base = 累计(lv) = Σ(NeedExp over Lv=1..lv)
  //   NeedExp 的语义是「升到该级所需」，故「到达 lv 级」已付的总量正是 累计(lv)。
  //   （我第一版写成 Lv <= lv-1 → 少减一级 → 进度多出整整一级的量，实测偏 300000）
  let base = 0;
  for (const r of lvTbl2.rows) {
    if (Number(r.DefaultUnitType || 0) !== ut) continue;
    if (Number(r.Lv || 0) > lv) continue;
    base += Number(r.NeedExp || 0);
  }
  return Math.max(0, Number(totalExp) - base);
}

export function expToNextLevel(masterCharacterId, level) {
  return requiredExpFor(masterCharacterId, Number(level) + 1);
}

export function requiredExpFor(masterCharacterId, level) {
  ensureLv();
  if (!lvTbl2) return 0;
  const ut = unitTypeOf(masterCharacterId);
  const rows = lvTbl2.rows.filter(function (r) { return Number(r.DefaultUnitType || 0) === ut; });
  const row = rows.find(function (r) { return Number(r.Lv) === Number(level); });
  return row ? Number(row.NeedExp || 0) : 0;
}

/** 便捷：按角色 id 直接算等级。 */
export function levelForCharacter(masterCharacterId, totalExp) {
  return levelForExp(unitTypeOf(masterCharacterId), totalExp);
}

console.log("[charfactory] module ready");