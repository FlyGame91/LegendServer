import fs from "node:fs";
// 剩余写接口：全部按入参修改状态。
//
// 覆盖：背包装备/护符养成、深渊迷宫、神谕解放者、传说mastery、记忆书、
//       大师等级、训练板、角色誓约/连结/职业碎片、好友、聊天、剧情、预设、支付。
import crypto from "node:crypto";
import path from "node:path";

// 运行目录（PC = server/，安卓 = files/lcserver/）
const HERE = path.dirname(process.argv[1] || ".");
import { route, ok, shapedForPath, okShaped, captured, err } from "./server.mjs";
import { providingRatio, roll, gachaGroups  } from "./gacha.mjs";
import { performGachaRoll } from "./routes-misc.mjs";
import { createCharacter, isSupportCharacter, initialBreakLimit, characterBattlePower } from "./character.mjs";
import { enhanceAmuletByExp, buildAmuletStatusList, amuletMaxLevel, amuletBreakLimitCost } from "./item.mjs";

// ★★★ 神谕探索加速倍率（2026-10-17）★★★
//   官方满编 12 小时/轮、累积上限 7 天；默认 720 倍 → 1 分钟/轮、上限 14 分钟。
//   环境变量 LEGECLOX_ORACLE_SPEED 可覆盖（1 = 官方速度）。
const ORACLE_SPEED = Math.max(1, Number(process.env.LEGECLOX_ORACLE_SPEED) || 720);
// ==================== 排行榜辅助 ====================
// 契约形状（从录制读取）：
//   ranking/load_ranking_data            { value_description, ranking_mater_id, self_ranking, ranking_list }
//   ranking/load_guild_quest_ex_*        { value_description, ranking_mater_id, self_ranking, ranking_list }
//   ranking/load_abyssal_maze_ranking_*  result 是【数组】，每项 { schedule_id, self_ranking, ranking_list }
//   ranking/load_event_score_attack_*    result 是【数组】，每项 { schedule_id, self_ranking, ranking_list }
//
// ranking_list 里是【其他玩家】的数据，本地单机不需要真实榜单 —— 但要给出合理数量的
// 占位条目，因为客户端会用它渲染列表（空列表会导致界面空白）。
// ★★ 排行榜行有【两种形状】（契约实证，必须逐端点区分）：
//   7 键：rank / before_rank / rank_value / player_account_id / player_name /
//         profile_character_master_id / profile_frame_master_id
//         → load_ranking_data（総合力ランキング）、load_guild_quest_ex_ranking_data
//   9 键：7 键 + master_rank + user_rank
//         → load_abyssal_maze_ranking_data、load_event_score_attack_ranking_data
//   早期一律给 9 键 → 前两者键集不符；删成 7 键 → 后两者又不符。
function makeRankRow(rank, value, extended) {
  const s = getState();
  const row = {
    rank: rank,
    before_rank: rank,
    rank_value: value,
    player_account_id: 900000000 + rank,
    player_name: "プレイヤー",
    profile_character_master_id: (s.UserData && s.UserData.profileCharacterMasterId) || "Ch000100101",
    profile_frame_master_id: (s.UserData && s.UserData.profileFrameMasterId) || "Item_PlayerIconFrame_0001",
  };
  if (extended) { row.master_rank = (s.UserData && s.UserData.master_rank) || 16; row.user_rank = (s.UserData && s.UserData.level) || 100; }
  return row;
}

/** 生成本地玩家的 self_ranking（用真实账号信息，排名给个合理值）。 */
function selfRanking(value, rank, extended) {
  const s = getState();
  const row = {
    rank: rank || 1,
    before_rank: rank || 1,
    rank_value: value,
    player_account_id: s.UserData.id,
    player_name: s.UserData.name,
    profile_character_master_id: s.UserData.profileCharacterMasterId,
    profile_frame_master_id: s.UserData.profileFrameMasterId,
  };
  if (extended) { row.master_rank = s.UserData.master_rank || 16; row.user_rank = s.UserData.level || 100; }
  return row;
}

/** 对象形式的排行榜响应。 */
function rankingObject(materId, desc, req, extended) {
  const rows = [];
  for (let i = 1; i <= 100; i++) rows.push(makeRankRow(i, 10000000 - i * 12345, extended));
  return {
    value_description: desc,
    ranking_mater_id: materId,
    self_ranking: selfRanking(807271, 101, extended),
    ranking_list: rows,
  };
}

/** 数组形式的排行榜响应（每项一个 schedule）。 */
function rankingArray(req, ids, extended) {
  const list = ids || [88];
  const out = [];
  for (const sid of list) {
    const rows = [];
    for (let i = 1; i <= 50; i++) rows.push(makeRankRow(i, 5000000 - i * 5432, extended));
    out.push({ schedule_id: String(sid), self_ranking: selfRanking(102148061, 51, extended), ranking_list: rows });
  }
  return out;
}

// 深渊迷宫排行：契约是【9 键】（含 master_rank/user_rank）
function abyssalRankingArray(req) { return rankingArray(req, [88], true); }
// 活动积分排行：契约同为【9 键】
function eventRankingArray(req) { return rankingArray(req, [14], true); }

import { loadTable, loadRaw } from "./masterdata.mjs";
import { breakLimitCost, applyEnchant, classUpMaterialFor, equipmentExpForItem, enhanceEquipmentByExp, isCharacterStoryId, goldCostForItem } from "./item.mjs";
import { rewardsForMissions, rewardsForRewardId, resolveRewardId, rollRewardId } from "./rewards.mjs";
import { dropsForQuest, buildQuestResultTemp, questRow, ensureUserQuest } from "./quest-result.mjs";
import {getState, markDirty, findCharacter, rememberLink, towerNextTarget, updateTowerQuestRecord, addItem, addStone, addStamina, addPlayerExp, applyRewards, toItemFormatList, playerAllAssetFor, itemsFromRequest, nowStamp, findMission, flushNow, guildInternal, healGuildInternal, purgeGuild, advanceMissions, touchCharacter, touchEquipment, touchAmulet, touchedPlayerAllAsset, touchedPlayerAssets, setPendingEnchant, getPendingEnchant, peekGachaCount, touchedAssetsOrEmpty, additionalLinkSoldierTypes, canReceiveMissionReward, findLimitedMission, canReceiveLimitedMission, limitedMissionRewardId, healMemoryBookPages, sanitizeMemoryBookNodes, currentItemCount, amuletIdsOf, allocInstanceId, consumeItems , applyTutorialEndState, syncLinkBattlePower, linkedSupportOfMain, beginnerMissionTotalRewardRows, beginnerMissionAchievedCount, refreshBeginnerTotalRewardState, healPresets } from "./state.mjs";

function parse(b) { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

/**
 * ★★★ 2026-10-22：装备/护符养成后，必须把【穿戴者】随响应回给客户端 ★★★
 *
 * 用户报障：「在角色的装备页面强化角色穿戴的装备，战斗力没有被重算，
 *            等到脱下装备才重算」。
 * 根因：真机契约（baggage_enhanceEquipmentByItem / breakLimitEquipment /
 *   enhance_amulet_by_item / break_limit_amulet / enchantEquipmentFix）的 result 里
 *   都带 main_character / support_character 两个字段 —— 客户端拿它整体替换角色对象，
 *   面板上的「加算值」与战斗力全部取自该对象（客户端零计算）。
 *   我们此前只回 targetEquipment：服务端其实一直在重算（日志里的
 *   [stat-sync] → [status.recompute]），但**没有把重算后的角色发出去**，
 *   客户端手里还是旧对象 ⇒ 数值不动；脱下装备时客户端自己会拉一次角色，才「看起来」恢复。
 */
function ownerCharacterFields(chId) {
  const ch = chId ? findCharacter(String(chId)) : null;
  if (!ch) return { main_character: null, support_character: null };
  const mains = (getState().CharacterList || {}).mainCharacterList || [];
  const isMain = mains.indexOf(ch) >= 0;
  return isMain ? { main_character: ch, support_character: null }
                : { main_character: null, support_character: ch };
}

/** 统一的"只有状态"响应：多数写接口客户端只关心状态回传。 */
/**
 * 以【契约形状】为基板、用状态值覆盖的响应。
 * 这样字段集永远与录制一致（避免客户端反序列化失败），而值来自真实状态。
 */
function stateOnly(ctx, extra) {
  // 用 okShaped（深度合并：契约给结构、状态给数值）。
  // 早期用 shapedForPath（浅覆盖），一旦我传空对象就会把契约的嵌套字段全部抹掉。
  //
  // ★★ 资产回执必须含【全部变动实体】+【本次所得流水】 ★★
  //   早期这里是 touchedPlayerAllAsset()（只含道具）且不给 item_format_list，于是：
  //     · 装备/护符/角色类的写端点（enhance_legend / equip_amulet / upgrade_board …）
  //       player_all_asset 只有 AllItemList，EquipmentList/MainCharacter 等恒空；
  //     · 所有用 stateOnly 的端点 item_format_list 恒空（玩家看不到「获得了什么」）。
  //   改为复数版 touchedPlayerAssets()，并从上下文取「本次所得」。
  //   所得流水由 handler 通过 opts.gained 传入（见 assetGained）；缺省则用
  //   「本次变动道具的当前持有量」兜底（结构对、语义为持有量）。
  const overrides = { player_all_asset: touchedPlayerAssets() };
  const gained = stateOnly.gained || null;
  stateOnly.gained = null;      // 用完即清，避免跨请求泄漏
  if (gained && gained.length) overrides.item_format_list = toItemFormatList(gained);
  if (extra) for (const k of Object.keys(extra)) overrides[k] = extra[k];
  return okShaped(ctx && ctx.path ? ctx.path : "", overrides);
}
/** handler 在调用 stateOnly 前用它登记「本次所得」，供回执生成 item_format_list。 */
function assetGained(items) { stateOnly.gained = items || []; }

// ==================== 装备/护符养成 ====================
let eqLvTbl = null, amLvTbl = null;
function eqRow(masterId) {
  if (!eqLvTbl) eqLvTbl = loadTable("Fusion/EquipmentLevelUp.csv");
  return null;
}

route("baggage/enhanceEquipmentByItem", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  let target = (s.ItemList.EquipmentList || []).find(function (e) { return String(e.Id) === String(req.targetEquipmentUserId); });
  if (!target) {
    target = (s.ItemList.EquipmentList || [])[0];
    if (target) console.log("[baggage] targetEquipmentUserId " + req.targetEquipmentUserId + " not found, fallback to " + target.Id);
  }
  // ★★★ 装备强化（2026-10-14 重写；用户报障「装备强化没反应」）★★★
  //
  // 旧实现有三个错，叠加起来就是「点了没反应」：
  //   ① **请求字段名读错**：真机是 `itemMasterId` + `itemCount`（见
  //      _winr_capture/contracts_winr/baggage_enhanceEquipmentByItem.req.json），
  //      我读的是 `itemId` / `requestCount` ⇒ 恒取不到 ⇒ 循环空转、经验 +0。
  //   ② **经验值硬编码** `gained += 100 * use`，而权威来源是
  //      Item/MaterialList.csv 的 EffectValue：N=30 / R=120 / SR=480 / SSR=2000。
  //   ③ **从不判断升级**：只加 CurrentExp，不推进 CurrentLevel、不管 MaxExp。
  //
  // 契约实证（同一次请求）：
  //   N×2 + R×2 + SR×0 + SSR×2 = 30×2+120×2+2000×2 = **4300**
  //   → 响应 targetEquipment.CurrentExp = **4300** ✓ 逐位吻合
  let gained = 0, usedList = [];
  // ★★★ 2026-10-22：强化手续费（金币）★★★ 见 item.mjs goldCostForItem 的注释
  const _goldOf = function (id) {
    const it = (s.ItemList.AllItemList.find(function (x) { return x.master_item_id === "Item_Currency_Gold"; }) || {});
    return Number(it.amount) || 0;
  };
  let goldLeft = _goldOf(), goldCost = 0;
  for (const set of (req.enhanceItemSettingList || [])) {
    // ★ 兼容三种拼写（真机 itemMasterId/itemCount；老契约 itemId/requestCount）
    const id = set.itemMasterId || set.itemId || set.item_id || set.item_master_id;
    const want = num(set.itemCount !== undefined ? set.itemCount : (set.requestCount !== undefined ? set.requestCount : set.count));
    if (!id || !want) continue;
    // ★★★ 实际用量受持有量限制（2026-10-17）★★★ 原实现直接 addItem(-want) → 不足时白嫖
    const have = (s.ItemList.AllItemList.find(function (x) { return x.master_item_id === id; }) || {}).amount || 0;
    // ★ 还要受【金币】限制：每个素材 20 金币/exp（GoldCost），钱不够就少用几个
    const unitGold = goldCostForItem(id);
    const byGold = unitGold > 0 ? Math.floor(goldLeft / unitGold) : Infinity;
    const use = Math.min(have, want, byGold);
    if (use <= 0) { if (unitGold > 0 && have > 0) console.log("[baggage] 强化金币不足: " + id + " 单价 " + unitGold + " 余额 " + goldLeft); continue; }
    addItem(id, -use);
    usedList.push(id);
    if (unitGold > 0) { goldCost += unitGold * use; goldLeft -= unitGold * use; }
    // ★ 经验值查表（MaterialList.EffectValue），不再硬编码
    gained += equipmentExpForItem(id) * use;
  }
  if (goldCost > 0) { addItem("Item_Currency_Gold", -goldCost); usedList.push("Item_Currency_Gold"); }
  let lvInfo = { levels: 0, beforeLv: target && target.CurrentLevel, afterLv: target && target.CurrentLevel };
  if (target && gained > 0) lvInfo = enhanceEquipmentByExp(target, gained);
  touchEquipment(target && target.Id);
  markDirty();
  // ★ 契约要求 flushNow 级的持久化（装备经验是玩家投入，不能丢）
  flushNow();
  console.log("[baggage] enhanceEquipment " + req.targetEquipmentUserId + " +" + gained + "exp" + (goldCost ? " 金币-" + goldCost : "") +
    (lvInfo.levels ? "  lv" + lvInfo.beforeLv + "→" + lvInfo.afterLv : "  (未升级)"));
  // ★ 契约的 items = 本次【消耗素材】的持有量（不是请求里提到的）
  return stateOnly(ctx, {
    ...ownerCharacterFields(target && target.OwnerCharacterId),
    items: playerAllAssetFor(usedList.length ? usedList : itemsFromRequest(req)),
    targetEquipment: target || undefined,
    MissionProgressList: [], limited_mission_progress_list: [] });
});
route("baggage/enhance_amulet_by_item", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  let target = (s.ItemList.amulet_list || []).find(function (a) { return String(a.id) === String(req.target_amulet_user_id); });
  if (!target) { target = (s.ItemList.amulet_list || [])[0]; }
  // ★★★ 2026-10-22 修正：字段名 + 经验值 + 升级 三处全错 ★★★
  //   契约 `baggage_enhance_amulet_by_item.req.json` 实证请求字段是
  //     { item_master_id, item_count }         ← 我此前读 item_id / request_count ⇒ 恒取不到 ⇒ 强化毫无反应
  //   且用的是**装备经验素材**（N/R/SR/SSR），经验值同装备：30/120/480/2000（不是写死的 50）。
  //   契约响应实证：2N+2R+2SSR = 30×2+120×2+2000×2 = 4300 → current_exp 4300 / current_level 20 / max_exp 4940。
  let gained = 0;
  for (const set of (req.enhance_item_setting_list || [])) {
    const id = set.item_master_id || set.item_id || set.itemId;
    const want = num(set.item_count || set.request_count || set.requestCount);
    if (!id || !want) continue;
    // ★★★ 实际用量受持有量限制（2026-10-17）★★★
    const have = (s.ItemList.AllItemList.find(function (x) { return x.master_item_id === id; }) || {}).amount || 0;
    const use = Math.min(have, want);
    if (use <= 0) continue;
    addItem(id, -use);
    gained += equipmentExpForItem(id) * use;
  }
  const lvInfo = enhanceAmuletByExp(target, gained);
  markDirty();
  flushNow();
  console.log("[baggage] enhanceAmulet " + req.target_amulet_user_id + " +" + gained + "exp" +
    (lvInfo.levels ? "  lv" + lvInfo.beforeLv + "→" + lvInfo.afterLv : "  (未升级)"));
  return stateOnly(ctx, {
    ...ownerCharacterFields(target && target.owner_character_id),
    items: playerAllAssetFor(itemsFromRequest(req)), target_amulet: target || undefined, MissionProgressList: [], limited_mission_progress_list: [] });
});
route("baggage/breakLimitEquipment", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // 按请求 id 查找；若该 id 不在本存档（录制请求来自原始存档），
  // 回退到玩家第一件实体 —— 绝不能返回空占位（会让客户端读到空 statusList）。
  let target = (s.ItemList.EquipmentList || []).find(function (e) { return String(e.Id) === String(req.targetEquipmentUserId); });
  if (!target) target = (s.ItemList.EquipmentList || [])[0];
  // 记录突破前等级，用于取「本次突破」对应的材料表项
  // ★ 只读契约字段 `break_limit`；不再读自造的 `BreakLimitCount`（2026-10-16 移除，它与 break_limit 重复且会不同步）。
  const beforeBL = target ? (Number(target.break_limit) || 0) : 0;
  const nextBL = beforeBL + 1;
  if (req.consumeEquipmentUserId) {
    s.ItemList.EquipmentList = (s.ItemList.EquipmentList || []).filter(function (e) { return String(e.Id) !== String(req.consumeEquipmentUserId); });
  }
  // ★★★ 替代材料校验（2026-10-17）★★★
  if (req.alternativeMaterialId) {
    const _chkBE0 = consumeItems(s, [[req.alternativeMaterialId, 1]]);
    if (!_chkBE0.ok) {
      console.log("[baggage] breakLimitEquipment 替代材料不足: " + _chkBE0.id);
      return okShaped(ctx.path, {});
    }
  }
  // 真实扣除限界突破材料（Gold + Limitbreak 系列）。
  // 契约的 items.AllItemList 正是这些【消耗材料】的当前持有量，不是装备自身。
  const cost = target ? breakLimitCost(target.MasterEquipmentId, nextBL) : [];
  // ★★★ 突破材料校验（2026-10-17）★★★
  const _chkBE = consumeItems(s, cost.map(function (c) { return [c.master_id, c.amount]; }));
  if (!_chkBE.ok) {
    console.log("[baggage] breakLimitEquipment 材料不足: " + _chkBE.id + " need=" + _chkBE.need + " have=" + _chkBE.have);
    return okShaped(ctx.path, {});
  }
  if (target) {
    target.break_limit = nextBL;
    target.MaxLevel = (target.MaxLevel || 0) + 10;   // 每级突破 +10 上限（见表 MaxLevel）
  }
  const mpChanged = advanceMissions("equipBreakLimit", 1, { questId: req.quest_id || req.questId });
  touchEquipment(target && target.Id);
  markDirty();
  flushNow();
  console.log("[baggage] breakLimitEquipment " + req.targetEquipmentUserId + " bl " + beforeBL + "->" + nextBL + " cost=" + cost.length);
  // items = 本次突破消耗的道具（按契约语义）
  const costIds = cost.map(function (c) { return c.master_id; });
  return stateOnly(ctx, {
    ...ownerCharacterFields(target && target.OwnerCharacterId),
    items: playerAllAssetFor(costIds),
    targetEquipment: target || undefined,
    MissionProgressList: mpChanged,
    limited_mission_progress_list: [],
  });
});
route("baggage/break_limit_amulet", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // 按请求 id 查找；若该 id 不在本存档（录制请求来自原始存档），
  // 回退到玩家第一件实体 —— 绝不能返回空占位（会让客户端读到空 statusList）。
  let target = (s.ItemList.amulet_list || []).find(function (a) { return String(a.id) === String(req.target_amulet_user_id); });
  if (!target) target = (s.ItemList.amulet_list || [])[0];
  if (req.consume_amulet_user_id) {
    s.ItemList.amulet_list = (s.ItemList.amulet_list || []).filter(function (a) { return a.id !== req.consume_amulet_user_id; });
  }
  // ★★★ 替代材料校验必须在改等级之前（2026-10-17）★★★
  if (req.alternative_material_id) {
    const _chkBA = consumeItems(s, [[req.alternative_material_id, 1]]);
    if (!_chkBA.ok) {
      console.log("[baggage] break_limit_amulet 材料不足: " + _chkBA.id);
      return okShaped(ctx.path, {});
    }
  }
  // ★★★ 2026-10-22 修正（契约 baggge_break_limit_amulet 实证）★★★
  //   契约里突破后是 `break_limit` 2→3、`max_level` 20→**30**；
  //   我此前写的是自造的 `break_limit_count`（客户端不认）⇒ 突破后等级上限永不提升，
  //   护符永远强化不到 30/50 级 —— 与「装备最大强化」那类缺陷同源。
  if (target) {
    const nextBl = Math.max(1, Number(target.break_limit) || 1) + 1;
    // 突破材料（AmuletBreakLimit.csv 的 Cost：霊宝 + 金币 + 星の粉）
    const cost = amuletBreakLimitCost(target.master_amulet_id, nextBl);
    const chk = consumeItems(s, cost.map(function (c) { return [c.master_id, c.amount]; }));
    if (!chk.ok) {
      console.log("[baggage] break_limit_amulet 材料不足: " + chk.id + " need=" + chk.need + " have=" + chk.have);
      return okShaped(ctx.path, {});
    }
    target.break_limit = nextBl;
    target.max_level = amuletMaxLevel(target.master_amulet_id, nextBl);
    target.status_list = buildAmuletStatusList(target.master_amulet_id, Number(target.current_level) || 1, target.status_type, target.status_effect_value);
  }
  const mpChanged = advanceMissions("amuletBreakLimit", 1, { questId: req.quest_id || req.questId });
  touchAmulet(target && (target.id || target.Id));
  markDirty();
  console.log("[baggage] breakLimitAmulet " + req.target_amulet_user_id);
  return stateOnly(ctx, {
    // ★ 契约字段名是 **mission_progress_list**（小写下划线），不是 MissionProgressList
    ...ownerCharacterFields(target && target.owner_character_id),
    items: playerAllAssetFor(itemsFromRequest(req)), target_amulet: target || undefined, mission_progress_list: mpChanged, limited_mission_progress_list: [] });
});
route("baggage/enchantEquipmentStart", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // 按请求 id 查找；若该 id 不在本存档（录制请求来自原始存档），
  // 回退到玩家第一件实体 —— 绝不能返回空占位（会让客户端读到空 statusList）。
  let target = (s.ItemList.EquipmentList || []).find(function (e) { return String(e.Id) === String(req.targetEquipmentUserId); });
  if (!target) target = (s.ItemList.EquipmentList || [])[0];
  // ★ cost_items 的权威形状（真机 baggage_enchantEquipmentStart.json）：
  //     { "<itemId>": {sheet_type:1, master_id:"<itemId>", amount:N}, ... }
  //   是【以 itemId 为键的 map】，值含真实的 sheet_type/master_id/amount。
  //   早期我只把 id 当键、值填 0（靠 okShaped 兜底）→ 审计报 type 不符。
  //   附魔成本 = 附魔石 x1 + 金币（金币量按 MasterData 的附魔成本表；取不到则为 0）。
  const costMap = {};
  // ★★★ 附魔成本校验（2026-10-17）★★★ 附魔石 + 金币一起原子校验
  const goldCost = 25000;
  const _costsES = [];
  if (req.enchantItemMasterId) _costsES.push([req.enchantItemMasterId, 1]);
  _costsES.push(["Item_Currency_Gold", goldCost]);
  const _chkES = consumeItems(s, _costsES);
  if (!_chkES.ok) {
    console.log("[baggage] enchantEquipmentStart 材料不足: " + _chkES.id + " need=" + _chkES.need + " have=" + _chkES.have);
    return okShaped(ctx.path, {});
  }
  if (req.enchantItemMasterId) {
    costMap[req.enchantItemMasterId] = { sheet_type: 1, master_id: req.enchantItemMasterId, amount: 1 };
  }
  costMap["Item_Currency_Gold"] = { sheet_type: 1, master_id: "Item_Currency_Gold", amount: goldCost };
  if (target) {
    // 开始附魔：写 previewEnchantId，并把结果放进 enchantList 的 alter* 列（契约实测语义）。
    applyEnchant(target, req.enchantItemMasterId, false);
    // 记住本次「进行中的附魔」——Fix 请求不含附魔石，须靠这份记录落成 current。
    setPendingEnchant(target.Id, target.previewEnchantId);
    // ★ 不再写 `is_enchanting`（2026-10-16 移除）—— 契约里没有这个字段，
    //   客户端判断「附魔进行中」用的是 `previewEnchantId`（契约字段）。
    //   我此前自造它 ⇒ 装备对象的键集比契约多一个 ⇒ audit 报 MISSING。
    touchEquipment(target.Id);
  }
  markDirty();
  console.log("[baggage] enchantStart " + req.targetEquipmentUserId + " -> preview " + (target && target.previewEnchantId));
return stateOnly(ctx, {
    cost_items: costMap,
    targetEquipment: target || undefined,
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});
route("baggage/enchantEquipmentFix", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // 按请求 id 查找；若该 id 不在本存档（录制请求来自原始存档），
  // 回退到玩家第一件实体 —— 绝不能返回空占位（会让客户端读到空 statusList）。
  let target = (s.ItemList.EquipmentList || []).find(function (e) { return String(e.Id) === String(req.targetEquipmentUserId); });
  if (!target) target = (s.ItemList.EquipmentList || [])[0];
  if (target) {
    // 收尾：把「进行中」的附魔结果落到 current（Fix 请求只带装备 id，附魔结果存于 pending）。
    const pend = getPendingEnchant(target.Id);
    if (pend) target.previewEnchantId = pend;
    applyEnchant(target, req.enchantItemMasterId, true);
    setPendingEnchant(target.Id, null);
    touchEquipment(target.Id);
  }
  markDirty();
  console.log("[baggage] enchantFix " + req.targetEquipmentUserId + " -> " + (target && target.currentEnchantId));
  // ★ 契约要求 main_character（附魔改变装备属性 → 需回传穿戴者供客户端刷新面板）。
  //   判据（contracts_winr/baggage_enchantEquipmentFix）：main_character.master_character_id
  //   恒等于该装备的 OwnerCharacterId。
  // ★ 2026-10-22：统一走 ownerCharacterFields（主/支援都能正确落到 main_character / support_character）
  return stateOnly(ctx, { targetEquipment: target || undefined, ...ownerCharacterFields(target && target.OwnerCharacterId), MissionProgressList: [], limited_mission_progress_list: [] });
});
// ★★ 护符合成（synthesis）—— 契约语义（实证 contracts/baggage_synthesis_amulet.json）：
//   请求 { target_amulet_user_id, consume_amulet_user_id, ability1_takeover_from, ability2_takeover_from }
//   响应键：target_amulet（合成后形态）/ removed_amulet_user_id（被消耗者）/
//           main_character / support_character / player_all_asset / preset_list
//   ★ 合成 = 把【consume 护符】吃掉，其能力按 takeover_from 传给【target 护符】。
//   早期实现：只把 consume 从列表删掉、target_amulet 恒 null、removed_amulet_user_id 恒 0 →
//   客户端拿不到合成结果（看起来「合成了但什么都没变」）。
route("baggage/synthesis_amulet", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const list = s.ItemList.amulet_list || [];
  const target = list.find(function (a) { return a.id === req.target_amulet_user_id; }) || null;
  const consumed = list.find(function (a) { return a.id === req.consume_amulet_user_id; }) || null;
  let removedId = 0;
  if (consumed) {
    // 能力继承：把 consume 的能力字段按 takeover_from 复制到 target（1=ability1, 2=ability2）
    if (target) {
      const t1 = Number(req.ability1_takeover_from) || 0;
      const t2 = Number(req.ability2_takeover_from) || 0;
      if (t1 === 2) { target.skill_id = consumed.skill_id; target.skill_effect_value = consumed.skill_effect_value; target.skill_effect_grade = consumed.skill_effect_grade; }
      if (t2 === 2) { target.status_type = consumed.status_type; target.status_effect_value = consumed.status_effect_value; target.status_effect_grade = consumed.status_effect_grade; }
      // ★ 2026-10-22：能力变了必须重算 status_list 的 type=3 行（否则界面上能力2 变了、属性却不动）
      target.status_list = buildAmuletStatusList(target.master_amulet_id, Number(target.current_level) || 1, target.status_type, target.status_effect_value);
    }
    removedId = consumed.id;
    s.ItemList.amulet_list = list.filter(function (a) { return a.id !== consumed.id; });
    touchAmulet(removedId);
  }
  if (target) touchAmulet(target.id);
  markDirty();
  flushNow();
  console.log("[baggage] synthesis_amulet target=" + req.target_amulet_user_id +
    " consume=" + req.consume_amulet_user_id + " → removed=" + removedId);
  return okShaped(ctx.path, {
    target_amulet: target,
    removed_amulet_user_id: removedId,
    main_character: null,
    support_character: null,
    player_all_asset: touchedPlayerAssets(),
    preset_list: s.preset_list || [],
  });
});

// ==================== 角色：誓约/连结/职业碎片/资料 ====================
// ★★ 誓约/Engage —— 权威数据链：Engage/Engage.csv 的 (CharacterID → Cost)。
//   Cost 形如 "item:Item_Engage_Material_01x825\nitem:..._02x825..."（多段换行分隔）。
//   契约实证：player_all_asset.AllItemList 有 6 项 Engage_Material（持有量），
//   即该端点是【消耗材料的写操作】—— 早期只往 engaged_character_id_list 里加个 id，
//   既不扣材料也不给 SkillIdList/preset_list，玩家看不到任何消耗与收益。
//   同一角色重复 engage 不应再扣（幂等）。
route("character/engage", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const id = req.master_main_character_id;
  if (!s.engaged_character_id_list) s.engaged_character_id_list = [];
  const already = id && s.engaged_character_id_list.indexOf(id) >= 0;
  let cost = [];
  if (id && !already) {
    // 真扣材料（权威表 Engage/Engage.csv 的 Cost 列）
    const tbl = loadTable("Engage/Engage.csv");
    const row = (tbl && tbl.rows || []).find(function (r) { return String(r.CharacterID) === String(id); });
    if (row && row.Cost) {
      for (const seg of String(row.Cost).split(/[\r\n]+/)) {
        const m = seg.trim().match(/^item:(.+?)x(\d+)$/i);
        if (!m) continue;
        cost.push({ sheet_type: 1, master_id: m[1], amount: Number(m[2]) });
      }
      // ★★★ 誓约材料校验（2026-10-17）★★★
      const _chkEG = consumeItems(s, cost.map(function (c) { return [c.master_id, c.amount]; }));
      if (!_chkEG.ok) {
        console.log("[char] engage 材料不足: " + _chkEG.id + " need=" + _chkEG.need + " have=" + _chkEG.have);
        return okShaped(ctx.path, {});
      }
    }
    s.engaged_character_id_list.push(id);
    touchCharacter(id);
  }
  // 誓约技能：Engage/EngageSkill.csv（CharacterID → 技能），契约 SkillIdList 3 条
  const skTbl = loadTable("Engage/EngageSkill.csv");
  const skillIds = ((skTbl && skTbl.rows) || [])
    .filter(function (r) { return String(r.CharacterID) === String(id); })
    // ★ 列名是 **AfterSkillGroupID**（契约 SkillIdList = ["1100697","1100698","1200200"]，
    //   正是该角色 3 行的 AfterSkillGroupID ✅）。早期读 SkillId/SkillID/master_skill_id ——
    //   这三个列名都不存在 → 恒空。
    .map(function (r) { return String(r.AfterSkillGroupID || ""); })
    .filter(Boolean);
  const mpChanged2 = advanceMissions("enhance", 1, {});
  markDirty();
  flushNow();
  console.log("[char] engage " + id + (already ? " (已誓约，跳过)" : " 耗 " + cost.map(function (c) { return c.master_id + "x" + c.amount; }).join("+")) +
    " 技能 " + skillIds.length + " 个 (total " + s.engaged_character_id_list.length + ")");
  const ch = findCharacter(id);
  return okShaped(ctx.path, {
    main_character: ch,
    engaged_character_id_list: s.engaged_character_id_list,
    player_all_asset: touchedPlayerAssets(),
    mission_progress_list: mpChanged2,
    limited_mission_progress_list: [],
    SkillIdList: skillIds,
    // ★ preset_list 的元素是 **{preset: [...]}**（嵌套一层），不是裸数组 ——
    //   契约实证：preset_list[0] = {preset: [{master_preset_id, …}, …]}。
    //   本机只有玩家自己的预设，故给一条含全部预设的条目。
    preset_list: (function () {
      const map = s.__presets || {};
      const all = [];
      for (const k of Object.keys(map)) if (Array.isArray(map[k])) for (const p of map[k]) all.push(p);
      return all.length ? [{ preset: all }] : [];
    })(),
  });
});
route("character/link", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 2026-10-21：解除 link 是【独立的一次请求】★★★
  //   真机实证（_fwd/run-2026-09-30-03-42-36 #62）：
  //     请求 {"mainCharacterMasterId":"", "supportCharacterMasterId":"Ch015202205"}
  //     响应 {"linkedMainCharacter":null, "forcedMainCharacter":<原main>,
  //           "linkedSupportCharacter":<该support, LinkedCharacterId:null>,
  //           "forcedSupportCharacter":null,
  //           "link_change_list":[{"main_character_id":<原main>,"support_character_id":""}]}
  //   早期我们完全没有这个分支 → 解除请求被当成"找不到 main"而空转，
  //   客户端也就收不到"已解除"的通知（列表里残留「リンク中」）。
  if (!String(req.mainCharacterMasterId || "") && String(req.supportCharacterMasterId || "")) {
    const sp = findCharacter(req.supportCharacterMasterId);
    const prevMainId = sp ? String(sp.LinkedCharacterId || "") : "";
    if (sp) {
      sp.LinkedCharacterType = 0; sp.LinkedCharacterId = null;
      // ★ 记录：这次是【用户主动解除】—— 自愈时不能把它补回来
      rememberLink(s, req.supportCharacterMasterId, null);
      markDirty();
    }
    // ★ 2026-10-22：解除 link 后 main 的战力要退回「自身战力」
    syncLinkBattlePower();
    console.log("[char] unlink " + req.supportCharacterMasterId + "（原 main=" + (prevMainId || "-") + "）");
    const _spOut = sp ? Object.assign({}, sp, { additional_link_soldier_type_list: additionalLinkSoldierTypes(sp.master_character_id) }) : null;
    return okShaped(ctx.path, {
      linkedMainCharacter: null,
      forcedMainCharacter: prevMainId ? findCharacter(prevMainId) : null,
      linkedSupportCharacter: _spOut,
      // ★ 同一个对象再放到 forcedSupportCharacter：客户端只要有一个走 Importer 就会刷新
      forcedSupportCharacter: _spOut,
      link_change_list: prevMainId ? [{ main_character_id: prevMainId, support_character_id: "" }] : [],
      MissionProgressList: [],
      limited_mission_progress_list: [],
    });
  }

  const main = findCharacter(req.mainCharacterMasterId);
  const sup = findCharacter(req.supportCharacterMasterId);
  // ★★★ 2026-10-21：一个 main 只能挂【一个】support ★★★
  //   缺陷实证（用户报障）：link 面板里同一个 main 显示了两个支援角色（甚至 3 个）。
  //   根因：本端点只给新的 support 打上 LinkedCharacterId，从不解除该 main 上【已有】的那些
  //   ⇒ 每次换 link 都会多挂一个，越积越多。
  //   修法：先把该 main 上所有旧 link 清干净，再挂新的。
  const allSups = ((s.CharacterList || {}).supportCharacterList || []);
  // ★ 该 support 原本挂在哪个 main 上（"抢走别人的支援"时要通知原 main 清空）
  const supPrevMainId = sup ? String(sup.LinkedCharacterId || "") : "";
  const unlinkedSups = [];
  let unlinked = 0;
  for (const sp of allSups) {
    if (!sp || sp === sup) continue;
    if (String(sp.LinkedCharacterId || "") === String(req.mainCharacterMasterId || "")) {
      sp.LinkedCharacterType = 0;
      sp.LinkedCharacterId = null;   // ★ 真机契约：角色对象用 null（link_change_list 里才用 ""）
      rememberLink(s, sp.master_character_id, null);
      unlinkedSups.push(sp);
      unlinked++;
    }
  }
  if (sup) {
    sup.LinkedCharacterType = 1;
    sup.LinkedCharacterId = req.mainCharacterMasterId;
    rememberLink(s, sup.master_character_id, req.mainCharacterMasterId);
  } else if (req.mainCharacterMasterId && !req.supportCharacterMasterId) {
    // 解除（请求只带 main、不带 support）→ 上面已清空该 main 的所有 link
    console.log("[char] unlink all supports from " + req.mainCharacterMasterId);
  }
  if (unlinked) console.log("[char] 解除 " + req.mainCharacterMasterId + " 上旧的 " + unlinked + " 个 link");
  // ★★★ 2026-10-22：被强制解除的旧支援必须【回给客户端】★★★
  //   缺陷实证（用户报障「link 解除不掉，卡片上一直挂 リンク中」）：
  //   换 link 时服务端把旧支援的 LinkedCharacterId 清成 null，但响应里只回
  //   linkedSupportCharacter=新支援 —— 客户端从没收到「旧支援已解除」，
  //   它本地的 SupportCharacter 对象里 LinkedCharacterId 还是旧值 → 卡片永远显示リンク中。
  //   契约里 forcedSupportCharacter 就是干这个的：被强制解除的支援。
  const forcedSup = unlinkedSups.length ? unlinkedSups[0] : null;
  // 「抢走别人的支援」时，原 main 也需要客户端清掉它的 link 索引
  const forcedMain = (supPrevMainId && supPrevMainId !== String(req.mainCharacterMasterId || ""))
    ? findCharacter(supPrevMainId) : null;
  if (unlinkedSups.length > 1) console.log("[char] 注意：本次解除了 " + unlinkedSups.length + " 个旧支援，只能回 1 个 forcedSupportCharacter");
  markDirty();
  // ★★★ 2026-10-22：link 后必须把 main 的战力重算成「自身 + 支援」★★★
  //   缺陷实证（用户报障）：link 上ヘルミィ(590) 后 ジャンヌ&ミカエル 的戦闘力仍是 1383 不变。
  //   客户端 BattleFormula.GetMainBattlePowerForOutGame 只是原样返回 TotalBattlePower，
  //   所以服务端不写就没有任何变化。这里同步后，响应里的 linkedMainCharacter 已是合计值。
  syncLinkBattlePower();
  console.log("[char] link " + req.supportCharacterMasterId + " -> " + req.mainCharacterMasterId);
  // ★ 真机语义（5 次实测，契约 contracts_winr_newaccount/character_link.json）：
  //   请求 {mainCharacterMasterId, supportCharacterMasterId}
  //   响应键【只有】linkedMainCharacter / forcedMainCharacter / linkedSupportCharacter
  //                / forcedSupportCharacter / link_change_list / MissionProgressList
  //                / limited_mission_progress_list
  //   —— 没有 main_character / support_character / player_all_asset（早期我多给了这 3 个）。
  //   linkedSupportCharacter 必须带 LinkedCharacterType=1 与 LinkedCharacterId=<主角色id>，
  //   且其 StatusList 里额外有 total_base_status、另有 additional_status / CharaBattlePower
  //   / additional_link_soldier_type_list（支援角色专属字段，见 character.mjs）。
  //   link_change_list 记录【本次变更】：[{main_character_id, support_character_id}]。
  // ★★ 2026-10-21：link_change_list 必须包含【被解除的旧 support】★★
  //   缺陷实证（用户报障）：手动换 link 后，旧 support 仍然显示「リンク中」——
  //   客户端是靠 link_change_list 增量更新本地 link 表的，而我们只回了"新挂上的那条"，
  //   没告诉它"旧的已经解除"，于是本地残留。
  //   修法：先为每个被解除的旧 support 回一条 {main_character_id, support_character_id: null}，
  //        再回新挂上的那一条。
  // ★★★ 2026-10-21：严格对齐真机 link 响应（#38 / #119~#122）★★★
  //   真机只回「新 link」这一条，【不】回任何"解除旧的"信息 ——
  //   客户端是靠自己记住的 main→support 索引在本地把旧支援改回未链接的。
  //   我此前额外塞 {main,""} 与 forcedSupportCharacter，反而扰乱了客户端的本地状态
  //   （表现：旧支援一直显示「リンク中」）。服务端这边仍然会自动解除旧 link（数据正确），
  //   只是响应保持与真机一致。
  const changeList = [];
  // ★ 若这个 support 原本属于另一个 main（"直接用别人的"），先通知客户端把原 main 的 link 清空，
  //   否则原 main 那边会一直显示这个支援（用户报障：重复 link）。
  if (main && sup && supPrevMainId && supPrevMainId !== String(req.mainCharacterMasterId || "")) {
    changeList.push({ main_character_id: supPrevMainId, support_character_id: "" });
    console.log("[char] 支援 " + req.supportCharacterMasterId + " 从 " + supPrevMainId + " 转给 " + req.mainCharacterMasterId);
  }
  if (main && sup) {
    changeList.push({ main_character_id: req.mainCharacterMasterId, support_character_id: req.supportCharacterMasterId });
  }
  const _supOut = function (x) {
    return x ? Object.assign({}, x, { additional_link_soldier_type_list: additionalLinkSoldierTypes(x.master_character_id) }) : null;
  };
  return okShaped(ctx.path, {
    linkedMainCharacter: main,
    linkedSupportCharacter: _supOut(sup),
    forcedMainCharacter: forcedMain,
    forcedSupportCharacter: _supOut(forcedSup),
    link_change_list: changeList,
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});
route("character/exchange_class_fragment", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const n = num(req.exchange_count) || 1;
  // ★ 语义：消耗职业碎片（master_item_id）换取【该职业的解放素材/装备】。
  //   契约 item_format_list 给的是【本次所得】（1 条），items.AllItemList 是变动后的持有量（2 条）。
  //   早期 item_format_list 恒空、items 只按请求里的 id 取（只有消耗项、缺所得项）。
  const gained = [];
  if (req.master_item_id) {
    // ★★★ 碎片校验（2026-10-17）★★★
    const _chkEC = consumeItems(s, [[req.master_item_id, n]]);
    if (!_chkEC.ok) {
      console.log("[char] exchange_class_fragment 碎片不足: " + _chkEC.id + " need=" + _chkEC.need + " have=" + _chkEC.have);
      return okShaped(ctx.path, {});
    }
    // ★ 所得：必须查【权威表】，不能用字符串推导。
    //   权威链：Item/FragmentList.csv (ItemId → CharacterId)
    //        → Character/Character.csv (CharacterId → SoldierType)
    //        → ClassUp/ClassUpCostTag.csv (CostTag = MAIN_<SOLDIER>_CLASS_01_Cost_Tag_01
    //           → ItemId = Item_Material_MasterClassUp_SSR_<N>)
    //   ★ 教训：早期写 `replace(/^Item_Fragment_/, "Item_Material_ClassUp_")` ——
    //     拼出的 Item_Material_ClassUp_Main_0267 **根本不存在**，
    //     正确的 id 是 Item_Material_MasterClassUp_SSR_XX（17 个，无 Main 系列）。
    //     这与「碎片 id 必须查 FragmentList」是同一类错误（字符串推导必然错）。
    const gainedId = classUpMaterialFor(req.master_item_id);
    const gainedList = [];
    if (gainedId) {
      for (let k2 = 0; k2 < n; k2++) gainedList.push({ sheet_type: 1, master_id: gainedId, amount: 1 });
      for (const g of gainedList) addItem(g.master_id, g.amount);
      for (const g of gainedList) gained.push(g);
    }
  }
  markDirty();
  console.log("[char] exchange_class_fragment " + req.master_item_id + " x" + n + " → " + gained.length + " 项");
  return okShaped(ctx.path, { item_format_list: toItemFormatList(gained), items: playerAllAssetFor(itemsFromRequest(req).concat(gained.map(function (g) { return g.master_id; }))), present_item_format_list: [], player_all_asset: touchedPlayerAssets() });
});
// ★★ 角色资料更新（台词/语音）—— 契约（contracts/character_update_profile.json）：
//   请求 { confirmCategory, confirmedValueList: [{characterType, characterId, valueId}] }
//   响应 { newProfileVoiceList: [{CharacterCategory, CharacterId, ReferenceId}], newTextStoryList }
//   ★ 字段名映射：请求用 characterType/characterId/valueId，
//     响应用 CharacterCategory/CharacterId/ReferenceId（首字母大小写不同，形状一致）。
//   ★ 语义：newProfileVoiceList = 本次【新解锁】的语音条目（就是请求里确认的那些）。
//   早期实现只把请求塞进私有字段、响应走 stateOnly({}) → newProfileVoiceList 恒空。
route("character/update_profile", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__charProfiles) s.__charProfiles = {};
  s.__charProfiles[req.confirmCategory] = req.confirmedValueList || [];
  // 本次确认的条目 → 即为新解锁的语音
  const newVoices = (req.confirmedValueList || []).map(function (v) {
    return {
      CharacterCategory: Number(v.characterType !== undefined ? v.characterType : v.CharacterCategory) || 0,
      CharacterId: v.characterId || v.CharacterId || "",
      ReferenceId: Number(v.valueId !== undefined ? v.valueId : v.ReferenceId) || 0,
    };
  });
  markDirty();
  console.log("[char] update_profile category=" + req.confirmCategory + " → 新语音 " + newVoices.length + " 条");
  return okShaped(ctx.path, { newProfileVoiceList: newVoices, newTextStoryList: [] });
});

route("character/equip_amulet", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ch = findCharacter(req.character_id);
  const attach = req.attaching_amulet_id_list || [];
  const detach = req.detaching_amulet_id_list || [];
  // ★★★ 不再维护 `ch.amulet_id_list`（2026-10-16 移除）★★★
  //   与 `equipment_id_list` 完全同型 —— 真机契约里角色身上没有这个字段，
  //   它是客户端自己算的索引；权威归属是**护符侧的 `owner_character_id`**（见下方赋值）。
  //   ★ 我上次修 `equipment_id_list` 时**没注意到护符有对称的同类代码** ⇒ 只修了一半。
  //   ⇒ 需要「某角色佩带的护符列表」时按 owner_character_id 反查（state.mjs 的 amuletIdsOf）。
  // ★ 护符的「谁装备着」字段是 **owner_character_id / owner_character_category**
  //   （实证 contracts/character_equip_amulet.json：owner_character_id="Ch015500206", category=2）
  //   早期写成 equipped_character_id —— 不是客户端认的字段。
  const amList = s.ItemList.amulet_list || [];
  for (const a of amList) {
    if (attach.indexOf(a.id) >= 0) { a.owner_character_id = req.character_id; a.owner_character_category = 2; touchAmulet(a.id); }
    if (detach.indexOf(a.id) >= 0) { a.owner_character_id = null; a.owner_character_category = 0; touchAmulet(a.id); }
  }
  markDirty();
  console.log("[char] equip_amulet " + req.character_id + " +" + attach.length + " -" + detach.length);
  // 契约 5 个列表的语义（实证）：
  //   invalidated_character_list        = 受影响的【主角色】自身（字段变化，需刷新）
  //   invalidated_linked_character_list = 受影响的【链接支援角色】（护符变更会波及 link 对象）
  //   attaching/detaching_amulet_list   = 装/卸的护符（带最新 owner_*）
  //   change_amulet_data_list           = [{support_character_id, amulet_id_list}]（该角色装完后的槽位）
  const attaching = attach.map(function (id) {
    const a = amList.find(function (x) { return String(x.id) === String(id); });
    return a ? Object.assign({}, a, {
      owner_character_id: a.owner_character_id || req.character_id || "",
      owner_character_category: a.owner_character_category !== undefined ? a.owner_character_category : 2,
    }) : null;
  }).filter(Boolean);
  const detaching = detach.map(function (id) {
    const a = amList.find(function (x) { return String(x.id) === String(id); });
    return a ? Object.assign({}, a, { owner_character_id: null, owner_character_category: 0 }) : null;
  }).filter(Boolean);
  // 被影响者：该角色自身 + 与它有 link 关系的支援角色
  const linkedSupport = (s.CharacterList.supportCharacterList || []).filter(function (c) {
    return String(c.LinkedCharacterId || "") === String(req.character_id || "");
  });
  const invalidatedLinked = [];
  for (const c of linkedSupport) invalidatedLinked.push(c);
  // 主角色若本身是 support（link 到别人）也要报给 invalidated_character_list
  const mains = [];
  if (ch) mains.push(ch);
  for (const c of linkedSupport) if (!mains.some(function (x) { return x.id === c.id; })) mains.push(c);
  return okShaped(ctx.path, {
    invalidated_character_list: mains,
    invalidated_linked_character_list: invalidatedLinked,
    attaching_amulet_list: attaching,
    detaching_amulet_list: detaching,
    // ★ 按护符侧的 owner_character_id 反查（不再读自造的 ch.amulet_id_list）
    change_amulet_data_list: ch ? [{ support_character_id: req.character_id, amulet_id_list: amuletIdsOf(s, req.character_id) }] : [],
    mission_progress_list: [],
    limited_mission_progress_list: [],
  });
});

// ==================== 传说 mastery / 记忆书 / 大师等级 / 训练板 ====================
// ★★ 传说精通强化 —— 契约（contracts/legend_mastery_enhance_legend.json）：
//   请求 { legend_enhance_list: [{legend_mastery_group_id, legend_mastery_node_id, update_level}] }
//   响应 { legend_enhance_info_list: [{legend_mastery_group_id, legend_mastery_node_id, legend_mastery_node_level}],
//          update_character_info: {mainCharacterList, supportCharacterList, characterProfileVoiceHistoryList, characterTextStoryHistoryList},
//          player_all_asset }
//   ★ 状态字段名必须是 legend_enhance_info_list（list 形），早期写成
//     s.legend_mastery_list[key]=数字 的 map —— 形状完全不符，客户端读不到。
// ★★ 传说精通强化 —— 权威数据链（真扣材料）：
//   LegendMastery/LegendMasteryRequestGroup.csv：(LegendMasteryRequestGroupID, LegendMasteryLv)
//     → **LegendRuneAmount（传说符文消耗）+ GoldAmount（金币消耗）**
//   契约实证：player_all_asset.AllItemList 有 2 项（Item_rune_legend_01 + Gold）
//     ⇒ 真扣「符文 + 金币」；早期只按请求里可选的 consume_item_id 扣（请求通常不传）→ 恒不扣。
route("legend_mastery/enhance_legend", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const list = req.legend_enhance_list || [];
  if (!s.legend_mastery_list) s.legend_mastery_list = {};
  if (!Array.isArray(s.legend_mastery_list.legend_enhance_info_list)) s.legend_mastery_list.legend_enhance_info_list = [];
  const arr = s.legend_mastery_list.legend_enhance_info_list;
  const changed = [];
  const reqGrp = loadTable("LegendMastery/LegendMasteryRequestGroup.csv");
  const grpRows = (reqGrp && reqGrp.rows) || [];
  for (const e of list) {
    const gid = Number(e.legend_mastery_group_id);
    const nid = Number(e.legend_mastery_node_id);
    const lv = Number(e.update_level) || 1;
    const hit = arr.find(function (x) { return Number(x.legend_mastery_group_id) === gid && Number(x.legend_mastery_node_id) === nid; });
    if (hit) hit.legend_mastery_node_level = Math.max(Number(hit.legend_mastery_node_level) || 0, lv);
    else arr.push({ legend_mastery_group_id: gid, legend_mastery_node_id: nid, legend_mastery_node_level: lv });
    changed.push({ legend_mastery_group_id: gid, legend_mastery_node_id: nid, legend_mastery_node_level: lv });
    // ★ 关键一跳（第一版漏了）：LegendMastery.csv 把 (GroupID, NodeID) 映射到
    //   **LegendMasteryRequestGroupID**，成本要用【那个 ID】去查，而不是请求里的 group_id。
    //   实证：请求 group=1 node=39 update_level=3；
    //     LegendMastery 里 (1,39) → LegendMasteryRequestGroupID=2，
    //     而 Group 1 只有 Lv1 一档（查 Lv3 必然落空）→ 这就是「材料扣不掉」的真因。
    const lmTbl = loadTable("LegendMastery/LegendMastery.csv");
    const lmRow = ((lmTbl && lmTbl.rows) || []).find(function (r) {
      return Number(r.LegendMasteryGroupID) === gid && Number(r.LegendMasteryNodeID) === nid;
    });
    const reqGroupId = lmRow ? Number(lmRow.LegendMasteryRequestGroupID) : gid;
    const g = grpRows.find(function (r) { return Number(r.LegendMasteryRequestGroupID) === reqGroupId && Number(r.LegendMasteryLv) === lv; });
    if (g) {
      const rune = Number(g.LegendRuneAmount) || 0;
      const gold = Number(g.GoldAmount) || 0;
      // ★★★ 材料校验（2026-10-17）★★★ 符文 + 金币 + 消耗素材一起原子校验
    const _costs4 = [];
    if (rune) _costs4.push(["Item_rune_legend_01", rune]);
    if (gold) _costs4.push(["Item_Currency_Gold", gold]);
    if (e.consume_item_id) _costs4.push([e.consume_item_id, num(e.consume_count || 1)]);
    const _chk4 = consumeItems(s, _costs4);
    if (!_chk4.ok) {
      console.log("[legend] enhance_legend 材料不足: " + _chk4.id + " need=" + _chk4.need + " have=" + _chk4.have);
      return okShaped(ctx.path, {});
    }
      // ★★★ 2026-10-21：删掉二次扣款（同 enhance_master 的同类缺陷）★★★
      //   consumeItems(s, _costs4) 已经把 rune / gold / consume_item 全部扣掉，
      //   这里再扣一次 = 双重扣除（金币会被夹到 0）。
    }
  }
  markDirty();
  // ★ 传说精通提升【全体角色】属性加成 → 全部 touch（由出口统一重算 StatusList）
  for (const c of (s.CharacterList.mainCharacterList || [])) touchCharacter(c.master_character_id);
  for (const c of (s.CharacterList.supportCharacterList || [])) touchCharacter(c.master_character_id);
  flushNow();
  console.log("[legend] enhance_legend x" + changed.length);
  return okShaped(ctx.path, {
    legend_enhance_info_list: changed,
    update_character_info: buildUpdateCharacterInfo(s),
    player_all_asset: touchedPlayerAssets(),
  });
});
/** update_character_info 的【唯一构造点】—— legend/tenmei 共用（收口）。 */
function buildUpdateCharacterInfo(s) {
  // ★ characterTextStoryHistoryList / characterProfileVoiceHistoryList 的形状（契约实证）：
  //     { CharacterCategory, CharacterId, ReferenceId }
  //   来源：存档的 **UserCharacterStoryList**（已读/已确认的角色剧情）——
  //     其字段是 {Id, PlayerAccountId, MasterCharacterId, StoryId, IsRead, IsConfirmed}，
  //     需映射成上面 3 键。CharacterCategory：主角色 1 / 支援 2（按角色所在列表判定）。
  const mainIds = new Set(((s.CharacterList && s.CharacterList.mainCharacterList) || []).map(function (c) { return c.master_character_id; }));
  const stories = s.UserCharacterStoryList || [];
  const textStory = [];
  for (let i = 0; i < stories.length; i++) {
    const st = stories[i];
    if (!st.IsRead && !st.IsConfirmed) continue;
    textStory.push({
      CharacterCategory: mainIds.has(st.MasterCharacterId) ? 1 : 2,
      CharacterId: st.MasterCharacterId,
      ReferenceId: i + 1,
    });
  }
  // 语音历史：存档里没有独立的表 → 由「已确认资料的语音条目」派生（__charProfiles 汇总）
  const voice = [];
  const prof = s.__charProfiles || {};
  for (const cat of Object.keys(prof)) {
    for (const v of (prof[cat] || [])) {
      voice.push({
        CharacterCategory: Number(v.characterType !== undefined ? v.characterType : (v.CharacterCategory || 0)) || 0,
        CharacterId: v.characterId || v.CharacterId || "",
        ReferenceId: Number(v.valueId !== undefined ? v.valueId : (v.ReferenceId || 0)) || 0,
      });
    }
  }
  return {
    mainCharacterList: (s.CharacterList && s.CharacterList.mainCharacterList) || [],
    supportCharacterList: (s.CharacterList && s.CharacterList.supportCharacterList) || [],
    characterProfileVoiceHistoryList: voice,
    characterTextStoryHistoryList: textStory,
  };
}
// ★★ 天命强化 —— 契约（contracts/legend_mastery_enhance_tenmei.json）：
//   请求 { tenmei_enhance_group_id, tenmei_enhance_level }
//   响应 { tenmei_enhance_info: {tenmei_mastery_group_id, tenmei_mastery_level},
//          update_character_info: {mainCharacterList, characterProfileVoiceHistoryList, characterTextStoryHistoryList},
//          player_all_asset }
//   ★ update_character_info 装的是【受该强化影响、属性变化的角色】——
//     天命强化提升全体角色的属性加成，故受影响的是玩家全部角色；
//     早期这里没有该字段（靠契约兜底成空对象），客户端便不会刷新角色面板。
// ★★ 天命强化 —— 数据链：LegendMastery/TenmeiMasteryGroup.csv（(GroupID, Lv) → 消耗）
//   契约响应含 tenmei_enhance_info + update_character_info（4 子列表）+ player_all_asset。
//   天命加成对【全体角色】生效，故 update_character_info 回传全部角色。
route("legend_mastery/enhance_tenmei", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.legend_mastery_list) s.legend_mastery_list = {};
  // ★★★ 键名必须是 tenmei_enhance_info_list（带 _list）★★★
  //
  // 用户报障：「天命强化还是不扣材料」（第 2 次报，第一次我只修了 item id）。
  //
  // 真根因：**handler 写的键与读取/契约的键不是同一个** ——
  //   handler 写：  legend_mastery_list.**tenmei_enhance_info**        ← 我自己造的键
  //   契约/客户端：  legend_mastery_list.**tenmei_enhance_info_list**   ← 真机契约的键名
  //   character.mjs 也读 tenmei_enhance_info_list（正确）
  // ⇒ handler 改的是另一个数组 → 等级永远不动 → 属性不涨、材料判定也用错 before。
  //
  // ★ 易混点（这是根因的成因）：**响应字段**叫 `tenmei_enhance_info`（对象，见契约），
  //   而**存档键**叫 `tenmei_enhance_info_list`（数组）。两者名字只差 _list，
  //   我写 handler 时把「响应字段名」误当成了「存档键名」。
  //   对照 enhance_legend：它写的就是 legend_enhance_info_list（正确）—— 同一族两个 handler
  //   一个对一个错，正是「逐端点核对」而非「照同类写」才能发现的。
  if (!Array.isArray(s.legend_mastery_list.tenmei_enhance_info_list)) s.legend_mastery_list.tenmei_enhance_info_list = [];
  const gid = Number(req.tenmei_enhance_group_id);
  const lv = Number(req.tenmei_enhance_level);
  const arr = s.legend_mastery_list.tenmei_enhance_info_list;
  const hit = arr.find(function (x) { return Number(x.tenmei_mastery_group_id) === gid; });
  // ★ 清理历史脏键：**直接删除，不做合并**。
  //
  // 为什么不能「取 max 后并入」：那个键存的是【我的错误写入】，其中包含
  //   **我调试时推进的假进度**（实测 group2 被推到 54，而玩家真实进度是 49）。
  //   若取 max 并入，会把调试污染固化成「玩家的等级」—— 宁可丢弃也不能污染。
  //   正确键 tenmei_enhance_info_list 一直是契约原值（未被写坏），是权威来源。
  if (s.legend_mastery_list.tenmei_enhance_info !== undefined) {
    delete s.legend_mastery_list.tenmei_enhance_info;
    console.log("[legend] 已清除历史脏键 tenmei_enhance_info（错误写入点，含调试污染）");
  }
  const before = hit ? Number(hit.tenmei_mastery_level) || 0 : 0;
  // ★★★ 材料校验必须在【改等级之前】（2026-10-17）★★★
  //
  // 由来：`addItem` 内部是 `Math.max(0, amount + delta)`（防负数），
  //   而本 handler 原先【先改等级、后无条件 addItem(-delta)】⇒
  //   持有不足时等级照涨、材料只扣到 0 —— 等于白嫖。
  //   实证：`1@lv50` 被请求 88 次，而玩家只有 132 个 tenmei_01，
  //     实际只扣了 130（第 1 次 66、第 2 次 66、其余 86 次扣 0），等级却全部"成功"。
  //
  // ★ 与 `master_rank/release_jewel` 那次同型：**服务端不能只信客户端的按钮状态**。
  //   客户端会把材料不足的按钮灰掉，但改包/重放即可绕过。
  const _tg0 = loadTable("LegendMastery/TenmeiMasteryGroup.csv");
  const _tgRows0 = (_tg0 && _tg0.rows) || [];
  const _amt0 = function (l) {
    const r = _tgRows0.find(function (x) { return Number(x.TenmeiMasteryGroup) === gid && Number(x.TenmeiMasteryLevel) === l; });
    return r ? Number(r.ItemAmount) || 0 : 0;
  };
  // ★ 材料 id 按 group 查表（TenmeiMastery.csv 的 TenmeiType/TenmeiMasteryGroup/itemID）
  const _tmm0 = loadTable("LegendMastery/TenmeiMastery.csv");
  const _tmmRow0 = ((_tmm0 && _tmm0.rows) || []).find(function (x) { return Number(x.TenmeiMasteryGroup) === gid; });
  const _itemId0 = _tmmRow0 ? String(_tmmRow0.itemID) : ("Item_rune_tenmei_0" + gid);
  const _need0 = _amt0(lv);
  const _have0 = currentItemCount(s, _itemId0);
  if (_need0 > 0 && _have0 < _need0) {
    console.log("[legend] enhance_tenmei 材料不足，拒绝: " + _itemId0 + " need=" + _need0 + " have=" + _have0 +
                " (group=" + gid + " lv=" + lv + ")");
    // 不改等级、不扣材料，回当前状态（客户端会提示材料不足）
    const _cur0 = (s.legend_mastery_list.tenmei_enhance_info_list || []).find(function (x) { return Number(x.tenmei_mastery_group_id) === gid; });
    return okShaped(ctx.path, {
      tenmei_enhance_info: { tenmei_mastery_group_id: gid, tenmei_mastery_level: _cur0 ? Number(_cur0.tenmei_mastery_level) : 0 },
      player_all_asset: touchedAssetsOrEmpty(),
      item_format_list: [],
    });
  }
  if (hit) hit.tenmei_mastery_level = Math.max(before, lv);
  else arr.push({ tenmei_mastery_group_id: gid, tenmei_mastery_level: lv });
  // 真扣材料：TenmeiMasteryGroup 表按 (GroupID, Lv) 给出消耗
  const tg = loadTable("LegendMastery/TenmeiMasteryGroup.csv");
  const tgRows = (tg && tg.rows) || [];
  const consumed = [];
  // ★ 列名陷阱（已踩）：TenmeiMasteryGroup.csv 的列是
  //     TenmeiMasteryGroup / TenmeiMasteryLevel / **ItemAmount**
  //   —— 没有 ID/Lv 后缀，且消耗列叫 ItemAmount（不是 *Amount 系列）。
  // ★★★ 语义修正（2026-10-14，用户第 2 次报「扣的数量不对」）★★★
  //
  // 我上一轮的判断【错了】—— 我把 ItemAmount 当成「累计量」，用差值扣：
  //     delta = amtAt(目标) - amtAt(当前)
  // 正确语义：**ItemAmount 就是【该级要付的单价】**，直接扣 amtAt(目标)。
  //
  // ★ 权威证据（真机契约，决定性）：
  //     legend_mastery_enhance_tenmei.json 的请求 {"group":5,"level":51}
  //       → 响应 player_all_asset 里 Item_rune_tenmei_05 = 131
  //       而该账号快照里是 199 → **实际消耗 68**
  //     查表：group5 lv50=66 / **lv51=68** ⇒ 68 = amtAt(51) ✅（不是 68-66=2）
  //
  // ★ 用户实测印证（完全吻合）：
  //     用户「lv54 强化到 lv55 应该扣 76」—— 查表 lv55 = **76** ✅
  //     用户「实际只扣 2」—— 我的差值算法 76-74 = **2** ✅
  //
  // ★ 为什么会被误判为「累计量」：
  //     曲线 lv1=1 / lv2=2 / … / lv10=10 看起来像「累计=N」，
  //     但那是【前 10 级每级恰好 +1】的巧合；后期 lv50=66 / lv100=199 / lv120=259
  //     明显非线性 ⇒ 它是单价曲线，不是累计。
  //     **判据：拿「真机一次强化的实际消耗」与表值比对，而不是看曲线形状猜。**
  const amtAt = function (l) {
    const r = tgRows.find(function (x) { return Number(x.TenmeiMasteryGroup) === gid && Number(x.TenmeiMasteryLevel) === l; });
    return r ? Number(r.ItemAmount) || 0 : 0;
  };
  // ★ 消耗 = 目标等级的单价（不是差值）
  const delta = amtAt(lv);
  if (delta > 0) {
    // ★★★ 材料 id 必须【按 group 查表】，不能写死 _01 ★★★
    //
    // 用户报障：「legend master 天命强化不扣材料」。
    // 根因：我硬编码了 `Item_rune_tenmei_01`，而每个 group 用的是【不同的】材料：
    //   玩家实际持有：_01=**0** / _02=139 / _03=139 / _04=148 / _05=147 / _06=106
    //   点 group5 强化时我去扣 _01 → 持有已是 0（扣成负数）→ 界面上「材料没少」。
    //
    // 权威数据链（LegendMastery/TenmeiMastery.csv，字段 TenmeiType / TenmeiMasteryGroup / itemID）：
    //   1→1→Item_rune_tenmei_01   2→2→_02   3→3→_03
    //   4→4→_04                   5→5→_05   6→6→_06
    // 真机契约实证：请求 {"tenmei_enhance_group_id":5,...} 的响应
    //   player_all_asset.AllItemList = [{Item_rune_tenmei_05, amount:131}] ✅ 与查表一致。
    const tt = loadTable("LegendMastery/TenmeiMastery.csv");
    const ttRow = ((tt && tt.rows) || []).find(function (x) {
      return Number(x.TenmeiMasteryGroup) === gid;
    });
    const itemId = req.item_id || (ttRow && ttRow.itemID) || ("Item_rune_tenmei_0" + gid);
    addItem(itemId, -delta);
    consumed.push(itemId + "x" + delta);
  }
  for (const c of (s.CharacterList.mainCharacterList || [])) touchCharacter(c.master_character_id);
  for (const c of (s.CharacterList.supportCharacterList || [])) touchCharacter(c.master_character_id);
  markDirty();
  flushNow();
  console.log("[legend] enhance_tenmei group=" + gid + " Lv" + before + "→" + lv + " 耗 " + consumed.join("+"));
  return okShaped(ctx.path, {
    tenmei_enhance_info: { tenmei_mastery_group_id: gid, tenmei_mastery_level: lv },
    update_character_info: buildUpdateCharacterInfo(s),
    player_all_asset: touchedPlayerAssets(),
  });
});
// ★★ 记忆之书解放 —— 权威数据链（三条表）：
//   MemoryBook/MemoryBookNode.csv                ：NodeId → (BookId, PageType, NodeName)
//   MemoryBook/MemoryBookNodeCostMaterialList.csv：NodeId → [NodeLv, CostMaterial, CostCount]（材料曲线）
//   MemoryBook/MemoryBookNodeUpStatus.csv        ：NodeId → [NodeLv, ApplyUp*, Up*...]（属性提升）
//   契约实证：请求 {"master_node_id":"Memory_Book_Class_Attribute_1_PageType4_Node3"}
//     响应 items.AllItemList 含 Item_Material_Main_Book_SSR_17 的【持有量】与 Gold
//     ⇒ 该端点是【消耗材料】的写操作，必须真扣。
//   早期实现只往 released_memory_list 里 push 一个 id、items 用 itemsFromRequest
//     （该函数按【请求里的道具】取，而请求只有 node_id → 恒空），
//     既不扣材料也不报属性提升。
// memory_book/release_memory -- 记忆之书·解放记忆（强化单个节点）
//
// 契约实证（contracts/memory_book_release_memory.json）：
//   请求 { master_node_id: "Memory_Book_Class_Attribute_1_PageType4_Node3" }
//   响应 memory_book = { memory_book_node: { master_node_id, level }, memory_book_page: null }
//   memory_book 在这个端点里【不是】完整结构，而是「本次强化的那个节点」。
//   早期回传整个 s.memory_book -> 客户端读不到 memory_book_node.level -> 界面等级不变。
//
// 数据结构（存档 user_data.memory_book）：
//   memory_book_page_list: [{ master_book_id, master_page_type, complete_ranking, complete_at }]
//   memory_book_node_list: [{ master_node_id, level }]   <- 真正的等级存这里
//
// 成本链（MemoryBook/MemoryBookNodeCostMaterialList.csv，每级【多行】）：
//   实证该节点 Lv9 的成本 = SSR_17 x238 + SSR_10 x2 + Gold x5000000
//   早期只取 find() 首行 -> 只扣一种材料。
route("memory_book/release_memory", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.memory_book) s.memory_book = {};
  if (!Array.isArray(s.memory_book.memory_book_node_list)) s.memory_book.memory_book_node_list = [];
  if (!Array.isArray(s.memory_book.memory_book_page_list)) s.memory_book.memory_book_page_list = [];

  const nodeId = req.master_node_id;
  const nodes = s.memory_book.memory_book_node_list;
  let node = nodes.find(function (x) { return String(x.master_node_id) === String(nodeId); });
  const curLv = node ? (Number(node.level) || 0) : 0;
  const nextLv = curLv + 1;

  const costTbl = loadTable("MemoryBook/MemoryBookNodeCostMaterialList.csv");
  const allRows = ((costTbl && costTbl.rows) || []).filter(function (r) { return String(r.NodeId) === String(nodeId); });
  const maxLv = allRows.reduce(function (a, r) { return Math.max(a, Number(r.NodeLv) || 0); }, 0);

  const cost = [];
  if (nodeId && nextLv <= maxLv) {
    for (const r of allRows) {
      if (Number(r.NodeLv) !== nextLv) continue;
      const mid = r.CostMaterial;
      if (!mid) continue;
      cost.push({ sheet_type: 1, master_id: mid, amount: Number(r.CostCount || 1) });
    }
    // ★★★ 材料校验（2026-10-17）：不足则拒绝，不改等级、不扣任何东西 ★★★
    const _chkM = consumeItems(s, cost.map(function (c) { return [c.master_id, c.amount]; }));
    if (!_chkM.ok) {
      console.log("[memory] release 材料不足: " + _chkM.id + " need=" + _chkM.need + " have=" + _chkM.have);
      // ★ 早退也要回【当前状态】（2026-10-17）：
      //   `okShaped(ctx.path, {})` 只会按契约补「结构中性值」，客户端看不到节点等级/持有量。
      //   ⇒ 强化失败时界面应显示「等级未变」，而不是空白。
      return okShaped(ctx.path, {
        main_character_list: [],
        support_character_list: [],
        memory_book: {
          memory_book_node: node ? { master_node_id: node.master_node_id || nodeId, level: Number(node.level) || 0 } : null,
          memory_book_page: null,
        },
        // ★ 道具条目必须是【完整 5 字段】（2026-10-17）：
        //   客户端读 has_expired_at / expired_at / has_locked；只给 master_item_id+amount
        //   会被审计报 3 处 MISSING（实测）。形状以 state.mjs 的 addItem 为准。
        items: { AllItemList: cost.map(function (c) {
          const row = (s.ItemList.AllItemList || []).find(function (x) { return x.master_item_id === c.master_id; });
          return {
            master_item_id: c.master_id,
            amount: row ? Number(row.amount) || 0 : 0,
            has_expired_at: row ? !!row.has_expired_at : false,
            expired_at: row ? Number(row.expired_at) || 0 : 0,
            has_locked: row ? !!row.has_locked : false,
          };
        }) },
        MissionProgressList: [],
        limited_mission_progress_list: [],
      });
    }
    if (!node) { node = { master_node_id: nodeId, level: 0 }; nodes.push(node); }
    node.level = nextLv;
  }
  const mp = advanceMissions("memoryBook", 1, {});
  markDirty();
  // ★ 记忆之书是【按兵种分页】的：该页影响拥有对应兵种的那些角色。
  //   精确判定需要先知道页 → 兵种映射；这里保守地对【全体角色】touch，
  //   出口只重算一次（同 id 去重），换取「绝不漏算」。
  for (const c of (s.CharacterList.mainCharacterList || [])) touchCharacter(c.master_character_id);
  for (const c of (s.CharacterList.supportCharacterList || [])) touchCharacter(c.master_character_id);
  flushNow();
  console.log("[memory] release " + nodeId + " Lv" + curLv + "->" + (node ? node.level : curLv) +
    (cost.length ? " cost " + cost.map(function (c) { return c.master_id + "x" + c.amount; }).join("+") : " (no cost / max)"));

  const touchedItemIds = cost.map(function (c) { return c.master_id; });
  return okShaped(ctx.path, {
    main_character_list: (s.CharacterList.mainCharacterList || []),
    support_character_list: (s.CharacterList.supportCharacterList || []),
    memory_book: {
      memory_book_node: node ? { master_node_id: node.master_node_id || nodeId, level: node.level || 0 } : null,
      memory_book_page: null,
    },
    items: playerAllAssetFor(touchedItemIds),
    MissionProgressList: mp,
    limited_mission_progress_list: [],
  });
});
// ★★ 大师等级·解放宝玉 —— 权威数据链：
//   MasterRank/MasterRankCost.csv：CostId → RequiredCost（形如 "Item:Item_Equipment_MasterRank_09x151200"）
//   契约响应的 4 个关键字段（早期全缺）：
//     · user_data.last_battle_formation  —— 编成 {battle_formation[], action_priority[], formation_id[]}
//     · target_cost_id_list              —— 本次消耗的 CostId（回显请求）
//     · before/after_master_rank         —— 解放前后的大师等级
//     · player_all_items                 —— 本次消耗后的持有量（注意字段名是 player_all_items，
//                                            不是常见的 player_all_asset）
//   早期实现只给 jewel_list 记 completed，既不扣材料也不回 battle_formation。
route("master_rank/release_jewel", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ids = req.master_cost_id_list || [];
  const beforeRank = Number(s.master_rank_data && s.master_rank_data.master_rank) || Number(s.UserData.master_rank) || 0;
  if (!s.master_rank_data) s.master_rank_data = { master_rank: beforeRank, jewel_list: [] };
  const costTbl = loadTable("MasterRank/MasterRankCost.csv");
  const costRows = (costTbl && costTbl.rows) || [];
  const consumed = [];
  for (const id of ids) {
    const jewelId = String(id).replace(/_Cost_\d+$/, "");
    // ★ j 必须在使用前声明 —— 2026-10-16 修：我把幂等检查插到了声明之前，
    //   导致 `Cannot access 'j' before initialization`（TDZ）→ 整个端点 9999。
    //   ★ `node --check` 查不出这类错误（语法合法），只有运行时才暴露。
    const j = (s.master_rank_data.jewel_list || []).find(function (x) { return x.jewel_id === jewelId; });
    // ★★★ 材料校验：不足则【不解放、不扣除】—— 2026-10-16 补 ★★★
    //   ★ 客户端只对「材料足够」的项目显示可选（截图里不足的那项是灰色），
    //     但**服务端不能信任客户端的按钮状态** —— 否则改包/重放即可白嫖解放，
    //     且 addItem 会把持有量扣到 0（实测 114611 → 0）而不是拒绝。
    const costRow = costRows.find(function (r) { return String(r.CostId) === String(id); });
    const needList = [];
    if (costRow && costRow.RequiredCost) {
      for (const seg of String(costRow.RequiredCost).split(/[\r\n]+/)) {
        const mm = seg.trim().match(/^Item:(.+?)x(\d+)$/i);
        if (mm) needList.push([mm[1], Number(mm[2])]);
      }
    }
    // ★ 幂等：已解放过的 cost 直接跳过（否则重复调用会【重复扣材料】）
    //   判据来自真机契约：已 released 的 jewel 其 cost 全部 completed（20/20 实证），
    //   故「该 cost 已 completed」= 无需再次解放。
    const already = (j && (j.release_cost_list || []).find(function (x) { return x.cost_id === id; }));
    if (already && already.completed) {
      console.log("[master_rank] " + id + " 已解放，跳过（不重复扣材料）");
      continue;
    }
    const enough = needList.every(function (pr) { return currentItemCount(s, pr[0]) >= pr[1]; });
    if (!enough) {
      const lack = needList.filter(function (pr) { return currentItemCount(s, pr[0]) < pr[1]; })
        .map(function (pr) { return pr[0] + " 需" + pr[1] + " 持有" + currentItemCount(s, pr[0]); });
      console.log("[master_rank] 材料不足，跳过 " + id + "：" + lack.join(" / "));
      continue;
    }
    if (j) {
      j.completed_count = (j.completed_count || 0) + 1;
      if (!j.release_cost_list) j.release_cost_list = [];
      const c = j.release_cost_list.find(function (x) { return x.cost_id === id; });
      if (c) c.completed = true; else j.release_cost_list.push({ cost_id: id, completed: true });
      // ★★★ 「全部 cost 完成 → 解放 → master_rank +1」—— 2026-10-16 补 ★★★
      //   规律（真机契约 20/20 实证，无一例外）：
      //     released === true  ⇔  该 jewel 的 release_cost_list 全部 completed
      //     released === false ⇔  仅部分完成
      //   例：Master_Rank_01~16 已 released 且 cost 全完成（1/1、42/42、…、5/5）；
      //       Master_Rank_17~20 未 released 且部分完成（2/5、1/5、…）。
      //   ★★ 我此前【完全没有这一步】→ 即使把 5 个 cost 全解放，
      //      `released` 永远 false、`after_master_rank` 恒等于 `before_master_rank`
      //      ⇒ 表现为「点了「一括解放」也不升 rank」（用户 2026-10-16 报障）。
      //   ★ 注意两处 rank 必须【同步更新】（真机契约实证：
      //      `master_rank_data.master_rank` 与 `user_data.master_rank` 恒相等）。
      const allDone = (j.release_cost_list || []).length > 0 &&
                      (j.release_cost_list || []).every(function (x) { return !!x.completed; });
      if (allDone && !j.released) {
        j.released = true;
        j.released_at = Math.floor(Date.now() / 1000);
        const newRank = (Number(s.master_rank_data.master_rank) || 0) + 1;
        s.master_rank_data.master_rank = newRank;
        s.UserData.master_rank = newRank;
        console.log("[master_rank] ★ " + jewelId + " 全部 cost 完成 → 解放，master_rank " +
          beforeRank + " → " + newRank);
        // 解放会改变 MasterRankStatusPercent（AllStatsBoost）→ 全体角色属性/战力需重算
        try { for (const ch of ((s.CharacterList || {}).mainCharacterList || []).concat((s.CharacterList || {}).supportCharacterList || [])) touchCharacter(ch.master_character_id || ch.MasterCharacterId); } catch (e) {}
      }
    }
    // 真扣材料（已在上方校验过足够）
    for (const pr of needList) { addItem(pr[0], -pr[1]); consumed.push(pr[0]); }
  }
  const mp = advanceMissions("masterRank", 1, {});
  markDirty();
  flushNow();
  console.log("[master_rank] release_jewel x" + ids.length + " 耗 " + consumed.join("+") +
    " rank " + beforeRank + "→" + s.master_rank_data.master_rank);
  // user_data.last_battle_formation：从 UserData 取（真字段）；缺失时按 battle_formation_list 兜底
  const u = s.UserData || {};
  const lbf = u.last_battle_formation || (function () {
    const bf = (s.battle_formation_list || [])[0];
    const info = bf && bf.battle_formation_info_list;
    return info ? { battle_formation: info.battle_formation || [], action_priority: info.action_priority || [], formation_id: info.formation_id || [] } : { battle_formation: [], action_priority: [], formation_id: [] };
  })();
  // user_data 字段必须是 UserData 的真字段（见 TemporaryUserData 声明）
  const userDataOut = Object.assign({}, u, { level: u.level, exp: u.exp, master_rank: s.master_rank_data.master_rank, last_battle_formation: lbf });
  return okShaped(ctx.path, {
    user_data: userDataOut,
    target_cost_id_list: ids,
    before_master_rank: beforeRank,
    after_master_rank: Number(s.master_rank_data.master_rank) || beforeRank,
    master_rank_data: s.master_rank_data,
    player_all_items: playerAllAssetFor(consumed),
    mission_progress_list: mp,
    limited_mission_progress_list: [],
    userCharacterList: null,
  });
});
// ★★ 训练板强化 —— 权威数据链（四跳，第一版完全没做）：
//   请求 { CharacterId, Nodes: [{NodeId, Level}] }
//   ① TrainingBoard/TrainingNode.csv      ：NodeId → **NodeType**（如 "2_1_31" → 201）
//   ② TrainingBoard/NodeLevelUp.csv       ：(NodeType, Lv) → **CostTagList**（"TAGx3\nTAGx1"）+ CostGold
//   ③ TrainingBoard/NodeLevelUpRequestTag.csv：CostTag → (SheetType, ItemId, CostTagCount)
//   ④ 契约响应字段：MainCharacter / SupportCharacter / SkillList / TrainingNodes / player_all_asset
//   ★ 关键：主角色的强化结果放在 **SupportCharacter**（支持角色走这条路径），
//     而 MainCharacter 为 null；SkillList 是本次解锁的技能。
//   早期实现只往 s.TrainingNode 里 push、既不扣材料也不回 SupportCharacter/SkillList。
route("training_board/upgrade_board", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const cid = req.CharacterId;
  const nodes = req.Nodes || [];
  if (!s.TrainingNode) s.TrainingNode = [];
  const nodeTbl = loadTable("TrainingBoard/TrainingNode.csv");
  const nodeRows = (nodeTbl && nodeTbl.rows) || [];
  const luTbl = loadTable("TrainingBoard/NodeLevelUp.csv");
  const luRows = (luTbl && luTbl.rows) || [];
  const tagTbl = loadTable("TrainingBoard/NodeLevelUpRequestTag.csv");
  const tagRows = (tagTbl && tagTbl.rows) || [];
  const consumed = [];
  for (const n of nodes) {
    const nodeId = String(n.NodeId || n.node_id || n);
    const targetLv = Number(n.Level || n.level) || 1;
    // ★ 字段名必须是【契约/存档的真实形状】（与 TemporaryTrainingNode 一致）：
    //     { MasterCharacterId, MasterStatusCode, NodeId, BoardType, NodeMassX, NodeMassY, Level }
    //   早期写成 { character_id, node_id, level } —— 形状完全不同，
    //   既查不到已有节点（每次都被当新节点、重复累积），响应也缺 MasterCharacterId 等 4 个字段。
    const ex = s.TrainingNode.find(function (x) { return x.MasterCharacterId === cid && x.NodeId === nodeId; });
    const curLv = ex ? Number(ex.Level) || 0 : 0;
    const meta = nodeRows.find(function (r) { return String(r.NodeId) === nodeId; });
    const mass = String((meta && meta.NodeMass) || "0,0").split(",");
    const info = {
      MasterCharacterId: cid,
      MasterStatusCode: (function () { const ch0 = findCharacter(cid); return ch0 ? ch0.master_status_code : ""; })(),
      NodeId: nodeId,
      BoardType: meta ? Number(meta.BoardType) || 0 : 0,
      NodeMassX: Number(mass[0]) || 0,
      NodeMassY: Number(mass[1]) || 0,
      Level: targetLv,
    };
    if (ex) Object.assign(ex, info), ex.Level = Math.max(curLv, targetLv);
    else s.TrainingNode.push(info);
    // 逐级真扣（从 curLv+1 到 targetLv）
    const nodeType = meta ? String(meta.NodeType) : "";
    for (let l = curLv + 1; l <= targetLv; l++) {
      const lu = luRows.find(function (r) { return String(r.NodeType) === nodeType && Number(r.Lv) === l; });
      if (!lu) continue;
      for (const seg of String(lu.CostTagList || "").split(/[\r\n]+/)) {
        const m = seg.trim().match(/^(.+?)x(\d+)$/);
        if (!m) continue;
        const tag = tagRows.find(function (t) { return String(t.CostTag) === m[1]; });
        if (!tag || !tag.ItemId) continue;
        const amt = Number(m[2]) * (Number(tag.CostTagCount) || 1);
        // ★★★ 材料校验（2026-10-17）★★★
      const _chk8 = consumeItems(s, [[tag.ItemId, amt]]);
      if (!_chk8.ok) {
        console.log("[training] upgrade_board 材料不足: " + _chk8.id + " need=" + _chk8.need + " have=" + _chk8.have);
        return okShaped(ctx.path, {});
      }
        consumed.push(tag.ItemId);
      }
      const gm = String(lu.CostGold || "").match(/x(\d+)$/);
      if (gm && Number(gm[1]) > 0) { addItem("Item_Currency_Gold", -Number(gm[1])); consumed.push("Item_Currency_Gold"); }
    }
  }
  // ★★ 关键：训练板改动【直接决定 TrainingBoardStatusPercent】，必须 touch 该角色 ★★
  //   缺陷实证（2026-09-30 用户报障）：界面显示 92/92 满级、材料也扣了，
  //   但右侧加成仍显示基础值（+8%）、属性与战力不动 ——
  //   因为本 handler 早期【只改 TrainingNode、从不重算 StatusList】。
  //   修法：touchCharacter(cid)，由 server.mjs 的出口收口统一重算（通用逻辑收口）。
  touchCharacter(cid);
  const ch = findCharacter(cid);
  const isSup = !!(ch && (s.CharacterList.supportCharacterList || []).indexOf(ch) >= 0);
  // ★ 支援角色必须带 additional_link_soldier_type_list（数组，不可为 null）——
  //   客户端 .ToList() 遇 null 会抛 ArgumentNullException 使整次 load_user_data 失败。
  const chOut = (ch && isSup)
    ? Object.assign({}, ch, { additional_link_soldier_type_list: additionalLinkSoldierTypes(cid) })
    : ch;
  // 本次解锁的技能（TrainingBoard/SkillSetting.csv：CharacterID → SkillGroupID）
  const skTbl = loadTable("TrainingBoard/SkillSetting.csv");
  // ★ SkillList 的元素是【技能记录】（{id, player_account_id, master_character_id, master_skill_id}），
  //   与 SetSkillList 同形状 —— 不是字符串 id 数组。
  //   早期写成 string[] → 客户端按对象反序列化失败（审计 TYPE: 契约是对象、实现是 string）。
  // ★ 契约里 SkillList 是【该角色已设置的技能记录】3 条（master_skill_id 形如 4100016）。
  //   优先取 SetSkillList 里该角色的记录；不足 3 条时用 TrainingBoard/SkillSetting.csv
  //   的该角色技能组补足（支援角色的技能 id 在 410xxxx 区间）。
  // ★★ SkillList 的权威构造（契约 training_board_upgrade_board.json 实证）★★
  //   契约那次：请求 CharacterId=Ch011800205（支援），响应 SkillList 恰为
  //     [4100016, 4100017, 4100018]，且 master_character_id 全是 Ch011800205。
  //   查 TrainingBoard/SkillSetting.csv 该角色 5 行：
  //     NodeType=2001 → 4100016   ← 进 SkillList
  //     NodeType=2002 → 4100018   ← 进
  //     NodeType=2003 → 4100017   ← 进
  //     NodeType=3001 → 2200005   ← 不进
  //     NodeType=3002 → 2300054   ← 不进
  //   ⇒ 判据是【NodeType】：1001~1005（主动）/ 2001~2003（支援系）才是技能；
  //     3001/3002 是其它类别（22xxxxx/23xxxxx），不能混进来。
  //   早期我按「不足 3 条就补」且【未按 NodeType 过滤】→ 抽到了 22xxxxx，
  //   审计报 MISSING: SkillList[0].master_skill_id 与契约不符。
  //   另：契约的 SkillList 是【本次强化解锁/涉及的那 3 个】，
  //     与 SetSkillList（玩家已装配）不是一回事 —— 但形状相同，客户端只做展示刷新。
  let skillList = [];
  {
    const stTbl2 = loadTable("TrainingBoard/SkillSetting.csv");
    const rows = ((stTbl2 && stTbl2.rows) || [])
      .filter(function (r) { return String(r.CharacterID || r.CharacterId) === String(cid); })
      .filter(function (r) {
        // 只保留技能类 NodeType（见上方实证）
        const nt = Number(r.NodeType);
        return (nt >= 1001 && nt <= 1005) || (nt >= 2001 && nt <= 2003);
      })
      // ★ 排序：契约实证 Ch011800205 → [4100016, 4100017, 4100018]，
      //   而 SkillSetting 的 NodeType 升序是 [4100016, 4100018, 4100017] —— 不匹配。
      //   正确规则 = 过滤掉非技能类别（22xxxxx/23xxxxx）后【按 skill id 升序】。
      .sort(function (a, b) { return String(a.SkillGroupID).localeCompare(String(b.SkillGroupID)); });
    // ★ 改用统一分配器（2026-10-16）—— 原 `200030000` 与装备段(2e8)重叠。
    for (const rr of rows) {
      if (skillList.length >= 3) break;
      const sid = String(rr.SkillGroupID || "");
      if (!sid) continue;
      skillList.push({
        id: allocInstanceId(s, "skill"),
        player_account_id: (s.UserData && s.UserData.id) || 1000001,
        master_character_id: cid,
        master_skill_id: sid,
      });
    }
  }
  const mp = advanceMissions("trainingBoard", 1, {});
  markDirty();
  flushNow();
  console.log("[training] upgrade_board " + cid + " x" + nodes.length + " 耗 " + [...new Set(consumed)].join("+"));
  return okShaped(ctx.path, {
    MainCharacter: isSup ? null : chOut,
    SupportCharacter: isSup ? chOut : null,
    SkillList: skillList,
    // 只回本次涉及的节点（契约 71 条 = 该角色的全部节点；这里回角色维度）
    TrainingNodes: (s.TrainingNode || []).filter(function (x) { return x.MasterCharacterId === cid; }),
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: mp,
    limited_mission_progress_list: [],
  });
});

// ==================== 深渊迷宫辅助 ====================
//
// 4 个 abyssal_maze 端点共享同一个迷宫状态对象。契约字段（从录制读取）：
//   abyssal_maze: { master_abyssal_maze_id, master_season_id, now_position,
//                   selected_preset, selected_door_id, selected_effect_id, highest_position }
//   abyssal_maze_selected_door:   { door_id, master_battle_category_id, master_quest_id }
//   abyssal_maze_selected_effect: { effect_id, abyssal_maze_selectable_door_id,
//                                   master_buff_effect_category_group_id,
//                                   master_buff_effect_skill_id, value }
// 早期我用的是 preset_master_id/selected_door 等【自造字段名】，与契约不符 → 客户端读不到。

/** 取（或初始化）迷宫状态。 */
function mazeState() {
  const s = getState();
  if (!s.__maze) {
    s.__maze = {
      abyssal_maze: { master_abyssal_maze_id: "", master_season_id: "", now_position: 1, selected_preset: false, selected_door_id: 0, selected_effect_id: 0, highest_position: 1 },
      selected_door: null,
      selected_effect: null,
      // 初始就生成可选门/效果列表 —— 早期留空、只在 reset 里填充，
      // 导致直接调 select_door/select_effect/update（没先 reset）时列表为空。
      door_list: null,   // 由 mazeState() 末尾惰性填充
      effect_list: null,
      cleared_battles: [],
      gained_effects: [],
      challenge_characters: [],
    };
  }
  // 惰性填充可选列表（首次访问时）—— 变量是 s.__maze（不是 mz）。
  const mz = s.__maze;
  // ★ 2026-10-22：门/效果的生成规则改过（原来 3 扇门同一难度、任务也对不上）⇒ 版本化重建
  if (mz.__gen !== 16) {
    // ★ 重新生成门/效果时，把「已选门 / 已选效果 / 位置 / 已获得效果」一并清干净
    //   —— 否则 selected_door_id 还指着旧的 door/effect id（列表重建后已不存在），
    //   客户端按 doorId 取 selectable_effect 数组会拿到 null ⇒
    //   AbyssalMazeMainPageViewModel.Build 里 `.Select` 的源为 null ⇒
    //   ArgumentNullException: Value cannot be null. Parameter name: source（用户看到的栈）。
    mz.__gen = 16;
    mz.door_list = null; mz.effect_list = null;
    mz.challenge_characters = [];
    mz.selected_door = null; mz.selected_effect = null;
    mz.gained_effects = [];   // ★ cleared_battles（已通关层数）必须保留 —— 那是玩家的进度，不能因版本重建被清空
    mz.abyssal_maze.now_position = 1;
    mz.abyssal_maze.selected_door_id = 0;
    mz.abyssal_maze.selected_effect_id = 0;
    mz.abyssal_maze.selected_preset = false;
  }
  // ★★★ 2026-10-23：门/效果列表必须【按层重建】★★★
  //   用户报障：「三扇门的 BUFF 系别永远是固定的：前两个迎撃系、第三个冥運系」。
  //   根因：door_list 一旦生成就一直复用（只有 __gen 变化才重建），
  //   所以整局游戏看到的是同一批门 → 系别当然永远一样。
  //   真机语义：每一层重新抽门（BattleCategoryGroup 的行按 Weight 加权，见 buildDoorList）。
  {
    const cleared0 = Array.isArray(mz.cleared_battles) ? mz.cleared_battles.length : 0;
    mz.abyssal_maze.now_position = cleared0 + 1;
    if (!mz.door_list || !mz.door_list.length || Number(mz.__doorGenPos) !== Number(mz.abyssal_maze.now_position)) {
      mz.door_list = buildDoorList(mz);
      mz.effect_list = buildEffectList(mz);
      mz.__doorGenPos = Number(mz.abyssal_maze.now_position) || 1;
      mz.abyssal_maze.selected_door_id = 0;
      mz.abyssal_maze.selected_effect_id = 0;
      mz.selected_door = null;
      mz.selected_effect = null;
      console.log("[abyss] 生成第 " + mz.__doorGenPos + " 层的门/效果：" +
        (mz.door_list || []).map(function (d) { return d.master_battle_category_id; }).join(","));
    }
  }
  {
    const cleared = Array.isArray(mz.cleared_battles) ? mz.cleared_battles.length : 0;
    mz.abyssal_maze.now_position = cleared + 1;
    // ★ 自愈：若「已选门」对应的任务已经在本轮通关记录里，说明那是上一层的选择 ⇒ 清掉，
    //   否则客户端会把另外两扇门当成不可选（isDisable = door_id != selected_door_id）。
    const lastQuest = cleared ? String((mz.cleared_battles[cleared - 1] || {}).master_quest_id || "") : "";
    const selDoor = mz.selected_door || null;
    if (selDoor && lastQuest && String(selDoor.master_quest_id || "") === lastQuest) {
      mz.abyssal_maze.selected_door_id = 0;
      mz.abyssal_maze.selected_effect_id = 0;
      mz.selected_door = null;
      mz.selected_effect = null;
    }
  }
  // ★ 兜底自愈：已选中的 id 若不在当前列表里，一律清空（避免脏 id 传进客户端）
  if (mz.abyssal_maze.selected_door_id && !((mz.door_list || []).some(function (d) { return Number(d.door_id) === Number(mz.abyssal_maze.selected_door_id); }))) {
    mz.abyssal_maze.selected_door_id = 0; mz.selected_door = null;
  }
  if (mz.abyssal_maze.selected_effect_id && !((mz.effect_list || []).some(function (e) { return Number(e.effect_id) === Number(mz.abyssal_maze.selected_effect_id); }))) {
    mz.abyssal_maze.selected_effect_id = 0; mz.selected_effect = null;
  }
  return s.__maze;
}

/**
 * 生成可选门列表（真机 3 条：难度不同 ⇒ 界面上是 銀 / 金 / 虹 三种门）。
 * ★ 2026-10-22 重写：原来 3 条门的 master_battle_category_id 全写成 BattleCategory_517
 *   （同一组 EXPERT），界面上三扇门一模一样，而且 QuestGroup 也对不上。
 *   现在按主数据来：取【本迷宫】的 BattleCategoryGroup（id 以 _<mazeNo> 结尾），
 *   按 BattleCategory（难度）各取一条 ⇒ 3 扇不同难度的门，任务从该组的 QuestGroup 里取。
 */
/** 按 Weight 加权抽一行（Weight 缺省 1）。 */
function weightedRow(rows) {
  let tot = 0;
  for (const r of rows) tot += Math.max(1, Number(r.Weight) || 1);
  let p = Math.random() * tot;
  for (const r of rows) { p -= Math.max(1, Number(r.Weight) || 1); if (p <= 0) return r; }
  return rows[rows.length - 1];
}

function buildDoorList(mz) {
  const out = [];
  try {
    const mazeId = String((mz && mz.abyssal_maze && mz.abyssal_maze.master_abyssal_maze_id) || "AbyssalMaze_0012");
    const pos = Math.max(1, Number((mz.abyssal_maze || {}).now_position) || 1);
    const layerT = loadTable("AbyssalMaze/AbyssMazeLayer.csv");
    const sets = loadTable("AbyssalMaze/BattleCategoryGroupSet.csv");
    const bg = loadTable("AbyssalMaze/BattleCategoryGroup.csv");
    const q = loadTable("Quest/AbyssalMazeQuest.csv");
    // ① 当前层（now_position）属于哪一类「设置」
    const layer = (((layerT && layerT.rows) || []).find(function (r) {
      return String(r.AbyssalMazeId) === mazeId && Number(r.Start) <= pos && pos <= Number(r.End);
    })) || null;
    let key = layer ? String(layer.BattleCategorySlotGroupId || "") : "";
    // 形如 BattleCategorySlotGroup_Boss5_0012 / BattleCategoryGroup_normal_heal_0012
    key = key.replace(/^BattleCategory(SlotGroup|Group)_/, "");
    // ② 找到对应的 GroupSet（id 以该 key 结尾）
    let setRows = (((sets && sets.rows) || []).filter(function (r) {
      return key && String(r.BattleCategoryGroupSetId || "").endsWith(key);
    }));
    if (!setRows.length) setRows = (((sets && sets.rows) || []).filter(function (r) { return String(r.BattleCategoryGroupSetId).indexOf("normal_heal") >= 0 && String(r.BattleCategoryGroupSetId).indexOf(mazeId.slice(-4)) >= 0; }));
    const groups = [];
    for (const r of setRows) { const g = String(r.BattleCategoryGroupId || ""); if (g && groups.indexOf(g) < 0) groups.push(g); }
    const rowsOf = function (gid) { return (((bg && bg.rows) || []).filter(function (r) { return String(r.BattleCategoryGroupId) === gid; })); };
    const doors = [];
    if (groups.length >= 3) {
      // ★ 普通层：GroupSet 里就是 3 个组（normal / hard / expert）⇒ 一銀一金一彩
      for (const gid of groups.slice(0, 3)) {
        const rows = rowsOf(gid);
        // ★ 2026-10-23：必须按 BattleCategoryGroup.Weight 加权抽，不能均匀抽。
        //   实测 normal_heal_001_0007 三行：damage 60 / defence 35 / heal 5
        //   （hard: 55/40/5、expert: 40/40/20）—— 均匀抽会让「迎撃系/冥運系」出现频率完全不符合设计，
        //   而且看起来像固定系别。
        if (rows.length) doors.push(weightedRow(rows));
      }
    } else {
      // ★ BOSS 层（每 5 层）：组里全是 Boss 系（BattleCategory 1/2）⇒ 3 扇门都是彩（BOSS）
      const pool = [];
      for (const gid of groups) for (const r of rowsOf(gid)) pool.push(r);
      const used = [];
      // 先按 Weight 打乱（加权无重复抽取），再取前 3 扇不同 Category 的门
      const poolW = pool.slice();
      for (let i = poolW.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = poolW[i]; poolW[i] = poolW[j]; poolW[j] = t; }
      poolW.sort(function (a, b) { return (Number(b.Weight) || 1) * Math.random() - (Number(a.Weight) || 1) * Math.random(); });
      for (const r of poolW) {
        if (doors.length >= 3) break;
        const id = String(r.BattleCategoryId);
        if (used.indexOf(id) >= 0) continue;
        used.push(id); doors.push(r);
      }
    }
    let doorId = 33891105;
    for (const row of doors) {
      if (!row) continue;
      const qs = (((q && q.rows) || []).filter(function (x) { return String(x.QuestGroupId) === String(row.QuestGroupId); }));
      out.push({
        door_id: doorId++,
        master_battle_category_id: String(row.BattleCategoryId),
        master_quest_id: qs.length ? String(qs[Math.floor(Math.random() * qs.length)].QuestId) : "",
      });
    }
  } catch (e) { out.length = 0; }
  while (out.length < 3) out.push({ door_id: 33891105 + out.length, master_battle_category_id: "BattleCategory_310", master_quest_id: "AbyssalMaze_quest01" });
  return out;
}

/** 技能描述（SkillSettingType=4 的 FirstSettingValue），用来判断有没有 {0} 占位符。 */
let __abyssDescCache = null;
function abyssSkillDesc(skillGroupId) {
  try {
    if (!__abyssDescCache) {
      __abyssDescCache = new Map();
      const t = loadTable("Skill/SkillListAbyssalMazeQuest.csv");
      for (const r of ((t && t.rows) || [])) {
        if (String(r.SkillSettingType) !== "4") continue;
        __abyssDescCache.set(String(r.SkillGroupId), String(r.FirstSettingValue || ""));
      }
    }
    return __abyssDescCache.get(String(skillGroupId)) || "";
  } catch (e) { return ""; }
}

/**
 * 生成可选效果列表（每个门一组）。
 * 数据链：门的 BattleCategoryGroup → BuffEffectCategoryMaxNumGroupId →
 *         BuffEffectSlot(该组下的 BuffEffectCategoryGroupId) → BuffEffect(技能) 取前若干。
 */
function buildEffectList(mz) {
  const out = [];
  try {
    const doors = (mz && mz.door_list) || [];
    const bg = loadTable("AbyssalMaze/BattleCategoryGroup.csv");
    const slot = loadTable("AbyssalMaze/BuffEffectSlot.csv");
    const eff = loadTable("AbyssalMaze/BuffEffect.csv");
    const cat = loadTable("AbyssalMaze/BuffEffectCategory.csv");
    const seriesOf = new Map(((cat && cat.rows) || []).map(function (r) { return [String(r.BuffEffectCategoryGroupId), String(r.CategorySeriesId)]; }));
    const cleanAll = (((eff && eff.rows) || []).filter(function (r) { return abyssSkillDesc(r.SkillGroupId).indexOf("{0}") < 0; }));
    const pickN = function (pool, n, used) {
      const arr = pool.filter(function (r) { return used.indexOf(String(r.BuffEffectSkillId)) < 0; });
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
      return arr.slice(0, n);
    };
    let eid = 101673314;
    const used = [];
    for (const d of doors) {
      const g = ((bg && bg.rows) || []).find(function (r) { return String(r.BattleCategoryId) === String(d.master_battle_category_id); });
      const slotGroup = g ? String(g.BuffEffectCategoryMaxNumGroupId || "") : "";
      const cats = (((slot && slot.rows) || []).filter(function (r) { return String(r.BuffEffectCategoryMaxNumGroupId) === slotGroup; }));
      // 本门（难度）自己的池子，先只保留「描述里没有 {0} 占位符」的技能
      let pool = [];
      for (const c of cats) {
        for (const r of (((eff && eff.rows) || []).filter(function (x) { return String(x.BuffEffectCategoryGroupId) === String(c.BuffEffectCategoryGroupId); }))) {
          if (abyssSkillDesc(r.SkillGroupId).indexOf("{0}") < 0) pool.push(r);
        }
      }
      let chosen = pickN(pool, 3, used);
      // 不足 3 条 ⇒ 用【同 CategorySeries】里干净的行补（保持「進撃系/迎撃系/回復系」这类主题一致）
      if (chosen.length < 3) {
        const sers = [];
        for (const c of cats) { const sr = seriesOf.get(String(c.BuffEffectCategoryGroupId)); if (sr && sers.indexOf(sr) < 0) sers.push(sr); }
        const same = cleanAll.filter(function (r) { return sers.indexOf(seriesOf.get(String(r.BuffEffectCategoryGroupId))) >= 0; });
        chosen = chosen.concat(pickN(same, 3 - chosen.length, used.concat(chosen.map(function (x) { return String(x.BuffEffectSkillId); }))));
      }
      if (chosen.length < 3) chosen = chosen.concat(pickN(cleanAll, 3 - chosen.length, used.concat(chosen.map(function (x) { return String(x.BuffEffectSkillId); }))));
      for (const r of chosen) {
        used.push(String(r.BuffEffectSkillId));
        out.push({
          effect_id: eid++,
          abyssal_maze_selectable_door_id: Number(d.door_id) || 0,
          master_buff_effect_category_group_id: String(r.BuffEffectCategoryGroupId),
          master_buff_effect_skill_id: String(r.BuffEffectSkillId),
          value: 0,
        });
      }
    }
  } catch (e2) { out.length = 0; }
  while (out.length < 3) {
    out.push({ effect_id: 101673314 + out.length, abyssal_maze_selectable_door_id: 33891105, master_buff_effect_category_group_id: "BuffEffectGroup_damage_epic_0005", master_buff_effect_skill_id: "BuffEffectSkillId_310", value: 0 });
  }
  return out;
}

/**
 * 迷宫进度的「已获得效果」：客户端 `AbyssalMazeMainPageViewModel.Build` 会对它 `.Select(...)`，
 * **源为 null 就直接抛 ArgumentNullException(source)**（2026-10-22 用户报障的卡死就是这个）。
 * 真机契约里 gained_effect_list 是「每前进一个 position 得一个 buff」（position 1、2 各一条），
 * ⇒ 只要迷宫已开始（now_position>=1），就必须至少有一条。
 */
function ensureGainedEffect(mz) {
  if (!mz) return;
  // ★ 2026-10-22：不要再「补」任何 BUFF —— 真机里 gained_effect 只在玩家【真正选完 BUFF】时产生。
  //   之前我给 position 1..N 各补一条（KNOWN 组合），结果进第 2 层时客户端以为「已经选过 BUFF」，
  //   直接在 NEXT 上显示成已选，而且显示的是补进去的彩品质效果（用户报障：「自动给我选了一个」）。
  mz.gained_effects = (Array.isArray(mz.gained_effects) ? mz.gained_effects : []).filter(function (e) {
    return e && e.master_abyssal_maze_id && Number(e.gained_position) > 0 && e.master_buff_effect_skill_id;
  });
}
/** 统一的迷宫响应（契约形状 + 当前状态）。 */
function mazeResponse(ctx) {
  // ★★★ 2026-10-22 对照实验：ABYSS_REPLAY=1 时直接回放真机契约（用来判断是「数据」还是「客户端/主数据」问题）
  if (process.env.ABYSS_REPLAY === "1" || fs.existsSync(path.join(HERE, "state", "__abyss_replay"))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(HERE, "contracts", "abyssal_maze_update.json"), "utf8"));
      const r = (j && j.result) ? j.result : j;
      console.log("[abyss] REPLAY contract response");
      return okShaped(ctx.path, r);
    } catch (e) { console.log("[abyss] replay failed: " + e.message); }
  }
  const mz = mazeState();
  const s = getState();
  // ★★★ 2026-10-22：highest_position 不能小于 now_position ★★★
  //   真机契约里 now_position=2 时 highest_position 也是 2；我之前造出 now=2 / highest=1，
  //   客户端 Build 里按最高进度算循环区间就会出现空区间 ⇒ .Select 源为 null。
  mz.abyssal_maze.highest_position = Math.max(
    Number(mz.abyssal_maze.highest_position) || 0,
    Number(mz.abyssal_maze.now_position) || 0
  );
  // ★ 保证 gained_effect_list 覆盖 position 1..N（客户端 Build 会遍历；缺项/空会让 .Select 源为 null）
  ensureGainedEffect(mz);
  // ★ 2026-10-22：challenge_character_list 不补（真机刚进本时就是空数组；补了反而进战斗 NRE）。
  // ★★★ 2026-10-22：`abyssal_maze_selected_door` / `_selected_effect` 绝不能再回 null ★★★
  //   真机契约（contracts/abyssal_maze_update.json）里两者恒为【对象】，从未出现 null。
  //   客户端 `TemporaryAbyssalMazeSelectableDoorExtend.UpdateSelectedDoor(x)`：
  //     ISIL: `test rsi,rsi / je → 抛异常`（null 直接抛），只有 `door_id == 0` 才走「清除选择」分支。
  //   ⇒ 未选门/未选效果时，正确表达是「对象 + id=0」，不是 null。
  //   （同族：`UpdateSelectedEffect` 同理。）
  const ZERO_DOOR = { door_id: 0, master_battle_category_id: "", master_quest_id: "" };
  const ZERO_EFFECT = { effect_id: 0, abyssal_maze_selectable_door_id: 0, master_buff_effect_category_group_id: "", master_buff_effect_skill_id: "", value: 0 };
  return okShaped(ctx.path, {
    // ★ 自造字段 `selected_preset_key` 是服务端内部用的，不下发（键集要与真机一致）
    abyssal_maze: (function () {
      const o = {};
      for (const k of Object.keys(mz.abyssal_maze || {})) if (k !== "selected_preset_key") o[k] = mz.abyssal_maze[k];
      return o;
    })(),
    abyssal_maze_selected_door: mz.selected_door || ZERO_DOOR,
    abyssal_maze_selected_effect: mz.selected_effect || ZERO_EFFECT,
    abyssal_maze_selectable_door_list: mz.door_list,
    abyssal_maze_selectable_effect_list: mz.effect_list,
    abyssal_maze_cleared_battle_list: mz.cleared_battles,
    abyssal_maze_gained_effect_list: mz.gained_effects,
    challenge_character_list: mz.challenge_characters,
    // ★ preset 的形状：s.__presets 是【以 presetKey 为键的 map】（见 preset/get_or_new），
    //   而响应要的是【该 key 下的 preset 数组】。早期直接回 s.__presets（map）→ 类型不符且恒空。
    preset: (function () {
      const mz2 = mz.abyssal_maze || {};
      const key = mz2.selected_preset_key || (mz2.master_abyssal_maze_id ? "17:" + mz2.master_abyssal_maze_id : "");
      const map = s.__presets || {};
      if (key && map[key]) return map[key];
      // 未按 key 命中时，取第一个非空数组（单机只有一个迷宫场景）
      for (const k of Object.keys(map)) if (Array.isArray(map[k]) && map[k].length) return map[k];
      return [];
    })(),
  });
}
// ==================== 深渊迷宫 / 神谕 ====================
route("abyssal_maze/reset", function (ctx) {
  const req = parse(ctx.body);
  const mz = mazeState();
  mz.abyssal_maze = {
    master_abyssal_maze_id: req.master_abyssal_maze_id || "",
    master_season_id: req.master_season_id || "",
    now_position: 1, selected_preset: false,
    selected_door_id: 0, selected_effect_id: 0,
    highest_position: mz.abyssal_maze.highest_position || 1,
  };
  mz.selected_door = null; mz.selected_effect = null;
  mz.door_list = buildDoorList(mz);
  mz.effect_list = buildEffectList(mz);
  mz.cleared_battles = []; mz.gained_effects = [];
  markDirty();
  console.log("[abyss] reset " + mz.abyssal_maze.master_abyssal_maze_id);
  return mazeResponse(ctx);
});

route("abyssal_maze/select_door", function (ctx) {
  const req = parse(ctx.body);
  const mz = mazeState();
  const doorId = req.door_id;
  const found = mz.door_list.find(function (d) { return String(d.door_id) === String(doorId); }) || { door_id: doorId, master_battle_category_id: "", master_quest_id: "" };
  mz.selected_door = found;
  // now_position 由「已通关层数」推导（见 mazeState），这里不动
  mz.abyssal_maze.selected_preset = true;
  mz.abyssal_maze.selected_door_id = doorId;
  mz.abyssal_maze.selected_effect_id = 0;
  // ★★★ 2026-10-22 修：这里以前是 `buildEffectList(mz).slice(0, 3)` ★★★
  //   slice(0,3) 只留下【第一扇门】的 3 条效果 ⇒ 客户端按 door_id 取「可选效果」时，
  //   第 2/3 扇门在字典里根本没有 key ⇒ 点它们 →
  //     KeyNotFoundException: The given key '33891107' was not present in the dictionary.
  //     at AbyssalMazeBuffEffectSelectPopupBehaviour.Setup(...)   ← 用户截图那个栈
  //   ⇒ 必须保留【每扇门各自一组】的完整列表。
  if (!Array.isArray(mz.effect_list) || !mz.effect_list.length) mz.effect_list = buildEffectList(mz);
  markDirty();
  console.log("[abyss] select_door " + doorId);
  // 真机契约 abyssal_maze_select_door.json 只有 3 个键
  return okShaped(ctx.path, {
    abyssal_maze: (function () {
      const o = {};
      for (const k of Object.keys(mz.abyssal_maze || {})) if (k !== "selected_preset_key") o[k] = mz.abyssal_maze[k];
      return o;
    })(),
    abyssal_maze_selected_door: mz.selected_door || null,
    abyssal_maze_selectable_effect_list: mz.effect_list,
  });
});

route("abyssal_maze/select_effect", function (ctx) {
  const req = parse(ctx.body);
  const mz = mazeState();
  const eid = req.effect_id;
  const found = mz.effect_list.find(function (e) { return String(e.effect_id) === String(eid); }) ||
    { effect_id: eid, abyssal_maze_selectable_door_id: mz.abyssal_maze.selected_door_id, master_buff_effect_category_group_id: "", master_buff_effect_skill_id: "", value: 0 };
  mz.selected_effect = found;
  mz.abyssal_maze.selected_effect_id = eid;
  // ★★★ 2026-10-22 修正：这里必须写「已获得效果」的记录格式，不能塞 selectable 效果本身 ★★★
  //   TemporaryAbyssalMazeGainedEffect = { master_abyssal_maze_id, gained_position,
  //     effect_skill_level, master_buff_effect_category_group_id, master_buff_effect_skill_id, value }
  //   原来直接把 selectable 效果（effect_id / abyssal_maze_selectable_door_id…）塞进 gained_effect_list
  //   ⇒ master_abyssal_maze_id = null、gained_position = 0 ⇒ 进战斗时
  //     AbyssalMazeUseCase.GetPlayerBuffDeBuffSkillAccessorList() 里取技能为 null ⇒
  //     NullReferenceException（客户端报的就是这个，卡在战斗加载）。
  const _mazeId = String(mz.abyssal_maze.master_abyssal_maze_id || "");
  const _pos = Math.max(1, Number(mz.abyssal_maze.now_position) || 1);
  const _gained = {
    master_abyssal_maze_id: _mazeId,
    gained_position: _pos,
    effect_skill_level: 1,
    master_buff_effect_category_group_id: String(found.master_buff_effect_category_group_id || ""),
    master_buff_effect_skill_id: String(found.master_buff_effect_skill_id || ""),
    value: Number(found.value) || 0,
  };
  mz.gained_effects = (Array.isArray(mz.gained_effects) ? mz.gained_effects : []).filter(function (e) {
    return !(e && String(e.master_abyssal_maze_id || "") === _mazeId && Number(e.gained_position) === _pos);
  });
  mz.gained_effects.push(_gained);
  markDirty();
  console.log("[abyss] select_effect " + eid);
  // ★★★ 2026-10-22 关键修正：`select_effect` 的响应形状和 update **完全不同** ★★★
  //   真机契约 _winr_capture/…/abyssal_maze_select_effect.json 的 6 个键：
  //     abyssal_maze / abyssal_maze_selected_effect / abyssal_maze_gained_effect（单数！）
  //     abyssal_maze_challenge_character_list / before_levelup_… / leveluped_…（后三者真机是 null）
  //   我之前一律回 update 的 8 键形状 ⇒ 客户端拿不到 `abyssal_maze_gained_effect`
  //   ⇒ 它的「已获得效果」字典永远是空的 ⇒ 进战斗 GetPlayerBuffDeBuffSkillAccessorList()
  //     按迷宫 id 取不到 ⇒ NullReferenceException（用户看到的报错）。
  return okShaped(ctx.path, {
    abyssal_maze: (function () {
      const o = {};
      for (const k of Object.keys(mz.abyssal_maze || {})) if (k !== "selected_preset_key") o[k] = mz.abyssal_maze[k];
      return o;
    })(),
    abyssal_maze_selected_effect: mz.selected_effect || null,
    abyssal_maze_gained_effect: _gained,
    abyssal_maze_challenge_character_list: null,
    before_levelup_abyssal_maze_gained_effect: null,
    leveluped_abyssal_maze_gained_effect: null,
  });
});

route("abyssal_maze/update", function (ctx) {
  const req = parse(ctx.body);
  const mz = mazeState();
  if (req.master_abyssal_maze_id) mz.abyssal_maze.master_abyssal_maze_id = req.master_abyssal_maze_id;
  if (req.master_season_id) mz.abyssal_maze.master_season_id = req.master_season_id;
  if (req.preset_master_id) {
    // 记录本次使用的预设 key，供 mazeResponse 取对应的 preset 数组
    mz.abyssal_maze.selected_preset_key = req.preset_master_id;
    // ★ 2026-10-22：真机契约里选了编成后 selected_preset = true（客户端据此判定「编成已确定」）
    mz.abyssal_maze.selected_preset = true;
  }
  markDirty();
  console.log("[abyss] update maze=" + mz.abyssal_maze.master_abyssal_maze_id);
  return mazeResponse(ctx);
});
route("oracle_liberator/reset_oracle", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const o = oracleState();
  o.stages[req.stage_id] = { stage_id: Number(req.stage_id) || req.stage_id, oracle_effect_id: null, exploring: false, received_count: 0 };
  markDirty();
  console.log("[oracle] reset stage=" + req.stage_id);
  // 契约 result 是空数组 []
  return ok([]);
});
route("oracle_liberator/select_oracle", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const o = oracleState();
  if (!o.stages[req.stage_id]) o.stages[req.stage_id] = { stage_id: Number(req.stage_id) || req.stage_id, received_count: 0 };
  // ★ 类型必须与真机一致：selected_main_oracle_effect_id 是 **number**
  //   （真机契约 oracle_liberator_select_oracle.json: {"stage_id":90001,
  //     "selected_main_oracle_effect_id":1016}）。早期回显的是请求原值（字符串）。
  o.stages[req.stage_id].oracle_effect_id = Number(req.oracle_effect_id) || 0;
  o.stages[req.stage_id].master_character_ids = req.master_character_ids || o.stages[req.stage_id].master_character_ids || [];
  markDirty();
  console.log("[oracle] select stage=" + req.stage_id + " effect=" + req.oracle_effect_id);
  // 契约字段：oracle_liberator_into（选中后的编成信息）
  return okShaped(ctx.path, {
    oracle_liberator_into: {
      stage_id: Number(req.stage_id) || 0,
      selected_main_oracle_effect_id: req.oracle_effect_id || "",
      master_character_ids: req.master_character_ids || [],
    },
  });
});
route("oracle_liberator/start_stage_exploration", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const oS = oracleState();
  // ★★★ 角色唯一性校验（2026-10-17）★★★ 同一角色不能同时编入多个 stage；
  //   客户端只做灰选/红 ❗ 展示，唯一性由服务端保证（真机契约跨 stage 重复 = 0）。
  const _ids = req.master_character_ids || [];
  const _conf = oracleConflictingCharacters(s, req.stage_id, _ids);
  if (_conf.length) {
    const _bad = new Set(_conf.map(function (x) { return x.id; }));
    console.log("[oracle] 剔除已在其它 stage 探索的角色 " + _conf.map(function (x) { return x.id + "@stage" + x.stage_id; }).join(", "));
    req.master_character_ids = _ids.filter(function (x) { return !_bad.has(x); });
  }
  oS.stages[req.stage_id] = { stage_id: Number(req.stage_id) || req.stage_id, exploring: true,
    master_character_ids: req.master_character_ids || [], oracle_effect_id: (oS.stages[req.stage_id] || {}).oracle_effect_id || null,
    received_count: Number((oS.stages[req.stage_id] || {}).received_count) || 0, start_at: Math.floor(Date.now() / 1000) };
  markDirty();
  console.log("[oracle] start stage=" + req.stage_id + " chars=" + (req.master_character_ids || []).length);
  // 契约字段：oracle_liberator_stage_expedition（远征中的编成）
  return okShaped(ctx.path, {
    oracle_liberator_stage_expedition: {
      stage_id: Number(req.stage_id) || 0,
      master_character_ids: req.master_character_ids || [],
      // ★ 契约字段（真机实证）：`receivable_count` 与 `start_at`（ISO8601 字符串）
      receivable_count: 0,                       // 刚开始 → 可领 0 轮
      start_at: isoStamp(oS.stages[req.stage_id] && oS.stages[req.stage_id].start_at),
    },
  });
});
route("oracle_liberator/stop_stage_exploration", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const oStop = oracleState();
  if (oStop.stages[req.stage_id]) oStop.stages[req.stage_id].exploring = false;
  markDirty();
  console.log("[oracle] stop stage=" + req.stage_id);
  return okShaped(ctx.path, {
    received_count: 0, player_all_asset: touchedAssetsOrEmpty(), item_format_list: [], present_item_format_list: [],
  });
});
route("oracle_liberator/restart_stage_exploration", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const oS = oracleState();
  // ★★★ 角色唯一性校验（2026-10-17）★★★ 同一角色不能同时编入多个 stage；
  //   客户端只做灰选/红 ❗ 展示，唯一性由服务端保证（真机契约跨 stage 重复 = 0）。
  const _ids = req.master_character_ids || [];
  const _conf = oracleConflictingCharacters(s, req.stage_id, _ids);
  if (_conf.length) {
    const _bad = new Set(_conf.map(function (x) { return x.id; }));
    console.log("[oracle] 剔除已在其它 stage 探索的角色 " + _conf.map(function (x) { return x.id + "@stage" + x.stage_id; }).join(", "));
    req.master_character_ids = _ids.filter(function (x) { return !_bad.has(x); });
  }
  oS.stages[req.stage_id] = { stage_id: Number(req.stage_id) || req.stage_id, exploring: true,
    master_character_ids: req.master_character_ids || [], oracle_effect_id: (oS.stages[req.stage_id] || {}).oracle_effect_id || null,
    received_count: Number((oS.stages[req.stage_id] || {}).received_count) || 0, start_at: Math.floor(Date.now() / 1000) };
  markDirty();
  const vR = oracleView();
  const sR = vR.stage_expedition_list.find(function (x) { return Number(x.stage_id) === Number(req.stage_id); });
  console.log("[oracle] restart stage=" + req.stage_id + " chars=" + ((sR && sR.master_character_ids) || []).length);
  return okShaped(ctx.path, {
    received_count: 0,
    player_all_asset: touchedAssetsOrEmpty(),
    item_format_list: [],
    present_item_format_list: [],
    // ★ 契约要求回 oracle_liberator_stage_expedition（远征中的编成，含 master_character_ids 12 个）。
    //   早期该字段完全没给 → 客户端拿不到重启后的编成。
    oracle_liberator_stage_expedition: sR || null,
  });
});

// ==================== 好友 / 聊天 ====================
route("friend/apply_friend_request", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__sentFriendRequests) s.__sentFriendRequests = [];
  if (req.player_id && s.__sentFriendRequests.indexOf(req.player_id) < 0) s.__sentFriendRequests.push(req.player_id);
  markDirty();
  console.log("[friend] apply " + req.player_id);
  return okShaped(ctx.path, { friend_notify_status: { has_friend_request: false, has_received: false } });
});
route("friend/release_block_player", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.block_player_list) s.block_player_list = [];
  s.block_player_list = s.block_player_list.filter(function (p) { return String(p.player_id || p) !== String(req.player_id); });
  markDirty();
  console.log("[friend] release_block " + req.player_id);
  // 契约 result 是空数组 []
  return ok([]);
});
route("friend/send_friend_coin", function (ctx) {
  const req = parse(ctx.body);
  const ids = req.player_id_list || [];
  const s = getState();
  if (!s.__friendCoinSent) s.__friendCoinSent = [];
  for (const id of ids) if (s.__friendCoinSent.indexOf(id) < 0) s.__friendCoinSent.push(id);
  const mpChanged2 = advanceMissions("friend", 1, {});
  markDirty();
  console.log("[friend] send_coin x" + ids.length + " mission=" + mpChanged2.length);
  // ★ 契约要求回 MissionProgressList（CT=18「フレンドにフレンドコインを1回送ろう」）——
  //   早期完全没给这个字段（只有 items / player_all_asset）。
  return okShaped(ctx.path, {
    get_friend_coin: s.__friendCoinSent ? s.__friendCoinSent.length : 0,
    daily_friend_coin: 0,
    daily_send_friend_coin_number: ids.length,
    friend_notify_status: { has_friend_request: false, has_receivable_friend_coin: false, has_sendable_friend_coin: false },
    items: playerAllAssetFor(['Item_Currency_Friend']),
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: mpChanged2,
    limited_mission_progress_list: [],
  });
});
// ★★ 他者资料（friend/get_player_profile）—— 单机语义下的正确做法：
//   本地只有【玩家自己】一个账号，因此「查看他人资料」返回的就是自己的资料。
//   契约的 18 个字段全部可由 state 直接产出：
//     UserProfile ← UserData（注意 rank/master_rank 是额外键）
//     MainCharacterCount/SupportCharacterCount ← CharacterList 各自长度
//     AllTotalBattlePower ← 各角色 TotalBattlePower/CharaBattlePower 求和
//     TopNMainCharacterList / SupportCharacterListLinkedTopN ← 按战力取前 5
//     EquipmentList / amulet_list / SetSkillList ← ItemList 与 SetSkillList
//     LatestUserMainQuest / LatestUserSubQuest ← UserQuestList 里最近的对应类型
//     TowerQuestRecord ← state.TowerQuestRecord；engaged_character_id_list ← state
//   早期实现返回一份【伪造的最小资料】（name="Player"、level=1），
//   导致契约里 4 个列表 + 5 个计数全部对不上。
route("friend/get_player_profile", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const mains = (s.CharacterList && s.CharacterList.mainCharacterList) || [];
  const sups = (s.CharacterList && s.CharacterList.supportCharacterList) || [];
  const bp = function (c) { return Number(c.TotalBattlePower || c.CharaBattlePower || 0); };
  const u = s.UserData || {};
  const quests = s.UserQuestList || [];
  const latestMain = quests.filter(function (q) { return Number(q.MasterQuestType) === 1; }).slice(-1)[0] || null;
  const latestSub = quests.filter(function (q) { return Number(q.MasterQuestType) === 2; }).slice(-1)[0] || null;
  console.log("[friend] get_player_profile target=" + req.target_player_id + " (单机：返回本机玩家资料)");
  return okShaped(ctx.path, {
    UserProfile: {
      user_id: u.id, name: u.name, profileMessage: u.profileMessage,
      profileCharacterMasterId: u.profileCharacterMasterId,
      profileFrameMasterId: u.profileFrameMasterId,
      rank: u.level, master_rank: u.master_rank,
      loginTime: u.loginTime,
      guildId: (s.guild_internal_data && s.guild_internal_data.guild_id) || 0,
    },
    MainCharacterCount: mains.length,
    SupportCharacterCount: sups.length,
    AllTotalBattlePower: mains.concat(sups).reduce(function (a, c) { return a + bp(c); }, 0),
    TopNMainCharacterList: mains.slice().sort(function (a, b) { return bp(b) - bp(a); }).slice(0, 5),
    // ★ 与 touchedPlayerAssets 同样补齐 additional_link_soldier_type_list
    //   （客户端 .ToList() 遇 null 会抛异常；且契约该字段有 7 个值）
    SupportCharacterListLinkedTopN: sups.slice().sort(function (a, b) { return bp(b) - bp(a); }).slice(0, 5)
      .map(function (c) {
        return Object.assign({}, c, {
          additional_link_soldier_type_list: c.additional_link_soldier_type_list || additionalLinkSoldierTypes(c.master_character_id),
        });
      }),
    EquipmentList: (s.ItemList && s.ItemList.EquipmentList) || [],
    amulet_list: (s.ItemList && s.ItemList.amulet_list) || [],
    SetSkillList: s.SetSkillList || [],
    LatestUserMainQuest: latestMain,
    LatestUserSubQuest: latestSub,
    SubQuestTrialHistoryCount: (s.SubQuestTrialHistoryCount || (s.__trialHistory || []).length) || 0,
    SubQuestAchievementHistoryCount: (s.SubQuestAchievementHistoryCount || (s.__achievementHistory || []).length) || 0,
    CharacterStoryCount: (s.UserCharacterStoryList || []).length,
    CharacterQuestCount: quests.filter(function (q) { return Number(q.MasterQuestType) === 3; }).length,
    TowerQuestRecord: s.TowerQuestRecord || null,
    target_deleted: false,
    engaged_character_id_list: s.engaged_character_id_list || [],
  });
});
route("chat/fetch_messages", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__chatMessages) s.__chatMessages = {};
  const msgs = s.__chatMessages[req.roomId] || [];
  console.log("[chat] fetch room=" + req.roomId + " -> " + msgs.length);
  return okShaped(ctx.path, {
    messages: s.__chatMessages || [], message_list: msgs });
});
route("chat/message", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__chatMessages) s.__chatMessages = {};
  if (!s.__chatMessages[req.roomId]) s.__chatMessages[req.roomId] = [];
  s.__chatMessages[req.roomId].push({ receiver_id: req.receiverId, type: req.type, message: req.body, timestamp: Math.floor(Date.now() / 1000) });
  markDirty();
  console.log("[chat] message room=" + req.roomId + " len=" + (req.body || "").length);
  // 契约字段 errorMessage（发送失败时非 null）
  return okShaped(ctx.path, { errorMessage: null });
});

// ==================== 剧情 / 预设 / 支付 ====================
route("story/read", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!Array.isArray(s.UserCharacterStoryList)) s.UserCharacterStoryList = [];
  // ★★★ 2026-10-18 修正：这个 handler 之前是【完全错的】，两个真 bug 同时在这里 ★★★
  //   (1) 它把【字符串】push 进 `adventure_read_list`（那是「任务组冒险已读」的对象数组
  //       [{id, player_account_id, master_quest_group_id}]）⇒ 对象数组里混入标量 ⇒
  //       客户端 JsonUtility 解析该元素失败得 null ⇒ 导入时当字典 key ⇒
  //       `ArgumentNullException: key` ⇒ **load_user_data 后半段导入全被跳过**
  //       （含 contents_release_read_list）⇒ 首进主页 IsContentRelease(MasterRank)=False
  //       ⇒ 弹「MASTER RANK 開放」演出弹窗 ⇒ 卡在 state 9 ⇒ 右侧四个大按钮一起失效。
  //   (2) 响应返回了自造的 `adventure_read_list`，而契约要求的是 **CharacterStory**。
  //
  //   权威依据（反编译 ReadCharacterStoryApi.PostRequest，Assembly-CSharp__13.cpp:44494）：
  //     L_3 = new TemporaryCharacterStory[1];
  //     L_3[0] = result.CharacterStory;        // ★ 单个对象，不是数组
  //     TemporaryCharacterStoryExtend.AddOrUpdate(L_3, NULL);   // 元素 NullCheck + 用 Id(int32) 当 key
  //     result.player_all_asset        → UpdatePlayerAllAsset
  //     result.limited_mission_progress_list → AddOrUpdate
  //   ⇒ CharacterStory **绝不能为 null**（否则数组元素 null → NullCheck 抛 NRE）；
  //     而 StoryId 不存在**不会**崩（key 是 Id，不是 StoryId）。
  const ids = Array.isArray(req.MasterStoryIdList) ? req.MasterStoryIdList
            : (req.MasterStoryId ? [req.MasterStoryId] : []);
  const isMain = req.IsMainCharacter !== false;
  let last = null;
  for (const raw of ids) {
    const sid = String(raw || "");
    if (!sid) continue;
    let e = s.UserCharacterStoryList.find(function (x) { return x.StoryId === sid; });
    if (!e) {
      e = {
        Id: allocInstanceId(s, "story"),
        PlayerAccountId: s.UserData.id,
        MasterCharacterId: String(req.MasterCharacterId || ""),
        StoryId: sid,
        IsRead: false,
        IsConfirmed: false,
      };
      s.UserCharacterStoryList.push(e);
    }
    // 契约样本里读完后 IsRead / IsConfirmed 都是 true
    e.IsRead = true;
    e.IsConfirmed = true;
    last = e;
  }
  // ★★★ 2026-10-22 用户报障：「阅读好感度剧情提示发放钻石了，但实际没到账」★★★
  //   权威数据：Story/CharacterStoryList.csv（StoryId → RewardID）——
  //     全部角色剧情（1294 条）都是 Reward_Story_Character = **魔宝石 ×50**。
  //   客户端（ReadCharacterStoryApi）只回 CharacterStory / player_all_asset / limited_mission_progress_list，
  //   奖励必须由服务端在【首次读该 story】时发放（isRewardReceiveOnly=true 时是「只领奖」）。
  const grantedNow = [];
  if (!s.__storyReward) s.__storyReward = {};
  for (const raw of ids) {
    const sid = String(raw || "");
    if (!sid) continue;
    if (s.__storyReward[sid]) continue;
    let rid = "";
    try {
      const st = loadTable("Story/CharacterStoryList.csv");
      const row = ((st && st.rows) || []).find(function (x) { return String(x.StoryId || "") === sid; });
      if (row) rid = String(row.RewardID || "");
    } catch (e) {}
    if (!rid) continue;
    try {
      const rw = resolveRewardId(rid);
      if (rw.length) {
        applyRewards(rw);
        for (const x of rw) grantedNow.push(x);
        s.__storyReward[sid] = true;
        console.log("[story] 首读奖励 " + sid + " → " + rw.map(function (x) { return x.master_id + " x" + x.amount; }).join(", "));
      }
    } catch (e) { console.log("[story] 奖励发放失败 " + sid + ": " + e.message); }
  }
  if (grantedNow.length) markDirty();
  if (!last) {
    // 兜底：仍然返回一个合法对象 —— 客户端会把它塞进数组并 NullCheck，
    // 返回 null 会直接 NRE。用一个新的合法记录（不落库，避免污染列表）。
    console.log("[story] read 无可解析的 story id（req=" + JSON.stringify(req).slice(0, 120) + "），返回兜底对象");
    last = {
      Id: allocInstanceId(s, "story"),
      PlayerAccountId: s.UserData.id,
      MasterCharacterId: String(req.MasterCharacterId || ""),
      StoryId: "",
      IsRead: true,
      IsConfirmed: true,
    };
  } else {
    markDirty();
  }
  console.log("[story] read " + ids.length + " story(ies) char=" + (req.MasterCharacterId || "?") + (isMain ? " (main)" : " (support)") + " → StoryId=" + last.StoryId);
  // 契约：{ CharacterStory: <单对象>, player_all_asset: [], limited_mission_progress_list: [] }
  // ★ player_all_asset 不能再恒为 []：读剧情发的魔宝石/道具要靠它带给客户端
  return okShaped(ctx.path, {
    CharacterStory: last,
    // ★ 2026-10-23：契约里 story/read 的 player_all_asset 是【数组】，我们之前返回对象
    //   → 客户端反序列化类型不符 → ReadCharacterStoryApi 失败 → 剧情永远"未读" → 反复播引导
    player_all_asset: [],
    limited_mission_progress_list: [],
    // 魔宝石余额（客户端类型里没声明这两个字段时会被忽略，声明了就能立刻刷新顶栏）
    freeStoneBalance: s.freeStoneBalance || 0,
    paidStoneBalance: s.paidStoneBalance || 0,
  });
});
// ==================== 任务组冒险（アドベンチャー）已读登记 ====================
// ★★★ 2026-10-22 用户报障：「点 SP quest 就通信エラーが発生しました。タイトルに戻ります (9998)」★★★
//   实证（_requests.log 00:32:04）：POST adventure/read {"master_quest_group_id":"SP_TrueEvilGod_TrueDagon"}
//   → 服务端未实现 → [MISS] → 404 + alterCode 9998 → 客户端弹通信错误并退回标题。
//
//   权威依据（ISIL: Common/Network/RemoteAPIAdv/ReadAdvApi.txt）：
//     get_ApiName()      → "adventure/read"
//     get_ParameterJson()→ JsonUtility.ToJson(TemporaryParameter{master_quest_group_id})
//     PostRequest(text)  → 反序列化 result.adventure_read（TemporaryReadAdv）
//                          → GetUserAssetReadAdvDataStore().AddOrUpdate(adventure_read.id,
//                                                                     adventure_read.master_quest_group_id)
//   TemporaryReadAdv（TemporaryResponseObject/Adv/TemporaryReadAdv.cs）字段：
//     id(string, +0x10) / player_account_id(int, +0x18) / master_quest_group_id(string, +0x20)
//   ⇒ 响应必须是 { result: { adventure_read: {...} } }，**不可为 null**（客户端直接拿它当 key 更新）。
//   load_user_data 的 adventure_read_list 就是这个对象的数组：客户端首次进入某个
//   「任务组」（如 SP クエスト 真・四大厄神）时查它 —— 不在表里就先播冒险脚本，播完调本接口登记。
//   因此本接口只做「记录 + 回显」，不涉及奖励（奖励在 QuestGroup 的任务里）。
route("adventure/read", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const gid = String(req.master_quest_group_id || req.masterQuestGroupId || "");
  if (!Array.isArray(s.adventure_read_list)) s.adventure_read_list = [];
  let e = null;
  for (const x of s.adventure_read_list) {
    if (x && typeof x === "object" && String(x.master_quest_group_id || "") === gid) { e = x; break; }
  }
  if (!e) {
    e = {
      id: String(allocInstanceId(s, "adventure")),
      player_account_id: s.UserData.id,
      master_quest_group_id: gid,
    };
    s.adventure_read_list.push(e);
    markDirty();
  }
  console.log("[adv] read group=" + gid + " → id=" + e.id + "（已读组数 " + s.adventure_read_list.length + "）");
  return okShaped(ctx.path, { adventure_read: e });
});
// ==================== 队伍预设（preset）====================
// 契约里 preset 是【数组】，每项：
//   { master_preset_id, master_main_character_id, master_support_character_id,
//     skill_ids[], equipment_ids[], amulet_ids[], slot_num, formation_id,
//     created_at, updated_at, StatusList{...} }
// 早期实现把它当成单个对象（preset: {...}），数组里只有一层 —— 客户端读不到元素字段。

// ==================== 部队阵位（formation_id）与部队战力 ====================
// ★★★ 2026-10-22 用户报障：「出击后所有角色战斗力都显示 0，而且所有角色都堆在一个格子上」★★★
//
// ISIL 实证链（三条，缺一不可）：
//   ① TemporarySlotExtend.AddOrUpdate(slotList) 把 preset 每个槽位转成
//      List<battleFormation>(master_main_character_id) / List<actionPriority>(slot_num) /
//      List<formationId>(slot.formation_id) → UserPresetDataStore.SetUserBattleFormation(masterPresetId)。
//      ⇒ 预设项里的 formation_id 就是这个角色在地图上的格子。
//   ② ModelRoot.InitializeAutoQuestFormation()（questType=15 クラスチャレンジ 走这条）
//      按 formation_id 去 SimulationMapModel.GetFormationModel(party, formationId, …) 取坐标；
//      formation_id 全部相同 ⇒ 全部取到同一格 ⇒ 角色叠在一起。
//      实测 Class_15_01_Normal（casino 地图）在 Battle_ClassChallenge02.csv 的格网里是
//      A01(11,15) / A02(13,15) / A03(10,16) / A04(14,16) 四格。
//   ③ 同一方法里 unitModel._totalBattlePower ← userUnitFormation.TotalBattlePower
//      （0xD8 ← 0x48），而它就是我方下发的 slot.totalBattlePower；
//      PartyModel.GetTotalBattlePower = Σ UnitModel.TotalBattlePower。
//      ⇒ 我们发 0，顶部「戦闘力」和每个头像下面全是 0。
//
// 旧实现在这两处都错：formation_id 恒为 "A01"（restore 里 p.formation_id 是 undefined），
// totalBattlePower 恒为 0。
const BATTLE_CSV_FILES = ["Battle/Battle_ClassChallenge.csv", "Battle/Battle_ClassChallenge02.csv"];

/** preset_master_id → バトルID（只有クラスチャレンジ需要；其余返回 ""）。 */
function classChallengeBattleId(presetMasterId) {
  const key = String(presetMasterId || "");
  if (key.indexOf("15:") !== 0) return "";
  const questId = key.slice(3);
  const tbl = loadTable("Quest/ClassChallengeQuest.csv");
  if (!tbl) return "";
  let row = tbl.rows.find(function (r) { return String(r.QuestId || "") === questId; });
  if (!row) {
    // 也允许传クエストグループID（客户端确实会用 15:ClassChallengeQuest_xxx 再来一次）
    row = tbl.rows.find(function (r) { return String(r.QuestGroupId || "") === questId; });
  }
  return row ? String(row.BattleId || "") : "";
}

/** 取某场战斗在 Battle csv 里的行块（第一行 + 后续 dummy 行）。 */
function battleBlock(battleId) {
  if (!battleId) return null;
  for (const f of BATTLE_CSV_FILES) {
    const rows = loadRaw(f);
    if (!rows || !rows.length) continue;
    const start = rows.findIndex(function (r) { return r && r[2] === battleId; });
    if (start < 0) continue;
    const block = [rows[start]];
    for (let k = start + 1; k < rows.length; k++) {
      const r = rows[k];
      if (!r) break;
      if (r[2] && r[2] !== "dummy" && !/^\d+$/.test(r[2])) break;
      block.push(r);
    }
    return block;
  }
  return null;
}

/** 我方可用阵位 id（按格网里出现的 A01.. 升序）。 */
function allyFormationIdsForBattle(battleId) {
  const block = battleBlock(battleId);
  if (!block) return [];
  const ids = new Set();
  for (const r of block) {
    // 格网区（dummy 行）：第 2..26 列就是地图的 25 列
    for (let c = 2; c <= 26 && c < r.length; c++) {
      const m = /^(A\d\d)/.exec(String(r[c] || ""));
      if (m) ids.add(m[1]);
    }
    const fid = String(r[28] || "").trim();
    if (/^A\d\d$/.test(fid)) ids.add(fid);
  }
  return Array.from(ids).sort();
}

/** 该场战斗的我方出战数（Battle csv 的 MaxJoinNum 列）。 */
function battleMaxJoinNum(battleId) {
  const block = battleBlock(battleId);
  if (!block) return 0;
  return Number(block[0][14]) || 0;
}

/** 一个 preset 应有的阵位 id 列表（不足时按 A01..A0N 兜底）。 */
function presetAllyFormationIds(presetMasterId, count) {
  const key = String(presetMasterId || "");
  let ids = [];
  if (key.indexOf("15:") === 0) ids = allyFormationIdsForBattle(classChallengeBattleId(key));
  const n = Math.max(1, Number(count) || ids.length || 1);
  while (ids.length < n) ids.push("A" + String(ids.length + 1).padStart(2, "0"));
  return ids;
}

/** 该 preset 应有的槽位数（クラスチャレンジ = 关卡 MaxJoinNum）。 */
function presetSlotCount(presetMasterId) {
  const key = String(presetMasterId || "");
  if (key.indexOf("15:") !== 0) return 0;
  return battleMaxJoinNum(classChallengeBattleId(key));
}

/** 一个槽位的战斗力 = 主角（含连结支援）战力（契约实证：Ch017800107 + Ch016100207
 *  → 59163，与主角自身 TotalBattlePower 58800 同量级，只差在预设里另存的技能/装备）。
 *  官方契约里 `mainOnlyTotalBattlePower` 恒为 0，这里照抄。 */
function presetSlotBattlePower(mainId, supportId) {
  const s = getState();
  if (!mainId) return 0;
  const mains = (s.CharacterList && s.CharacterList.mainCharacterList) || [];
  const main = mains.find(function (c) { return String(c.master_character_id) === String(mainId); });
  if (!main) return 0;
  const sups = (s.CharacterList && s.CharacterList.supportCharacterList) || [];
  const sup = supportId ? sups.find(function (c) { return String(c.master_character_id) === String(supportId); }) : null;
  let linked = [];
  if (sup) linked = [sup];
  else {
    try { const l = linkedSupportOfMain(s, mainId); if (l) linked = [l]; } catch (e) {}
  }
  try { return characterBattlePower(main, linked, s); } catch (e) { return 0; }
}

/** 预设自愈：阵位重复/缺失 → 按 master 的阵位重排；战力为 0 → 重算。 */
function normalizePreset(list, key) {
  if (!Array.isArray(list) || !list.length) return list;
  const ids = presetAllyFormationIds(key, list.length);
  const seen = new Set();
  let dup = false;
  for (const e of list) {
    const f = String(e.formation_id || "");
    if (!f || seen.has(f)) dup = true; else seen.add(f);
  }
  if (dup) {
    list.forEach(function (e, i) { e.formation_id = ids[i] || ("A" + String(i + 1).padStart(2, "0")); });
    console.log("[preset] 阵位重复/缺失 → 按 master 重排 " + key + " : " + list.map(function (e) { return e.formation_id; }).join(","));
  }
  for (const e of list) {
    if (!e.master_main_character_id) { e.totalBattlePower = 0; continue; }
    const bp = presetSlotBattlePower(e.master_main_character_id, e.master_support_character_id);
    if (bp && e.totalBattlePower !== bp) e.totalBattlePower = bp;
  }
  return list;
}

/** 构造一个预设项（用玩家当前的队伍数据填充）。 */
function buildPreset(masterPresetId, slotNum, formationId, mainId, supportId) {
  const s = getState();
  const now = nowStamp();
  return {
    master_preset_id: masterPresetId,
    // ★★★ 2026-10-22：新建预设【不能默认塞第一个角色】★★★
    //   用户报障：「class challenge quest 的这个默认队伍是怎么回事？」—— 4 个部队里
    //   1/2/3 队全都是同一个角色（第一个主角色 Ch000100101 Lv7）+ 同一批装备/护符。
    //   根因：这里把 mainId 缺省成 mainCharacterList[0]、supportId 缺省成 supportCharacterList[0]，
    //   而 get_or_new 一次建 3 套 → 3 套内容一模一样。
    //   正确语义：新预设是【空槽】，由玩家自己编成（客户端会显示「+」占位）。
    master_main_character_id: mainId || "",
    master_support_character_id: supportId || "",
    skill_ids: [],
    equipment_ids: [],
    amulet_ids: [],
    slot_num: slotNum || 0,
    // ★ 阵位：= 战斗地图上的格子（A01..）。缺省按槽位序 A01/A02/…，绝不能全 "A01"。
    formation_id: formationId || ("A" + String((Number(slotNum) || 0) + 1).padStart(2, "0")),
    created_at: now,
    updated_at: now,
    // 契约里预设项还带战斗数值字段（客户端用于显示"战力"）
    AdditionalStatus: zeroStatLike(),
    // ★ 战力：客户端原样显示（UnitModel.TotalBattlePower ← 本字段），必须是真值
    totalBattlePower: presetSlotBattlePower(mainId, supportId),
    mainOnlyTotalBattlePower: 0,
    // StatusList 与角色一致，共 11 个子表（契约要求，缺则客户端读不到对应加成）
    StatusList: {
      TotalStatus: zeroStatLike(),
      CharacterLevelStatus: zeroStatLike(),
      CurrentBreakLimitStatus: zeroStatLike(),
      TrainingBoardStatusValue: zeroStatLike(),
      TrainingBoardStatusPercent: pctStatLike(),
      MemoryBookStatusPercent: pctStatLike(),
      MasterRankStatusPercent: pctStatLike(),
      LegendMasteryPercent: pctStatLike(),
      FavorabilityStatus: zeroStatLike(),
      ClassUpStatus: zeroStatLike(),
      TenmeiMasteryEnhancementUpStatus: zeroStatLike(),
    },
  };
}

/** 属性全零对象（与 character.mjs 的 zeroStat 同义，避免跨模块依赖）。 */
/** 属性百分比 100（无加成）。 */
function pctStatLike() {
  return { Hp: 100, PhysicalAttack: 100, PhysicalDefence: 100, MagicalAttack: 100, MagicalDefence: 100, Technique: 100, PhysicalAndMagicalAttack: 100 };
}

function zeroStatLike() {
  return { Hp: 0, PhysicalAttack: 0, PhysicalDefence: 0, MagicalAttack: 0, MagicalDefence: 0, Technique: 0, PhysicalAndMagicalAttack: 0 };
}

route("preset/get_or_new", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const key = String(req.preset_master_id || "");
  if (!s.__presets) s.__presets = {};
  if (!s.__presets[key]) {
    // 该 master_preset_id 下可有多套（契约里 get_or_new 返回 5 套、restore 返回 3 套），
    // 这里按槽位数生成对应数量。
    // ★ 槽位数：クラスチャレンジ = 该关卡 Battle csv 的 MaxJoinNum（Class_15_x = 4 队）
    const masterCount = presetSlotCount(key);
    const count = masterCount || (Number(req.create_empty) ? 1 : 3);
    const slotIds = presetAllyFormationIds(key, count);
    const list = [];
    for (let i = 0; i < count; i++) {
      const p = buildPreset(key, i, slotIds[i]);
      // ★ 空槽：不预填技能/装备/护符（它们属于角色，由玩家编成后由 preset/restore 带回来）
      p.__auto = true;
      list.push(p);
    }
    s.__presets[key] = list;
    markDirty();
  }
  // 旧数据自愈：全 A01 的阵位 + 全 0 的战力（用户 2026-10-22 报的两个 bug）
  normalizePreset(s.__presets[key], key);
  console.log("[preset] get_or_new " + key + " -> " + s.__presets[key].length + " 套");
  return okShaped(ctx.path, { preset: s.__presets[key] });
});

route("preset/restore", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const key = String(req.preset_master_id || "");
  if (!s.__presets) s.__presets = {};
  const params = Array.isArray(req.parameters) ? req.parameters : [];
  // ★★★ 2026-10-22：拒收「退化」预设 ★★★
  //   旧实现把每个槽位都填成同一个角色，客户端把它存进了本地（PlayerPrefs 的
  //   ClassChallengeContent），之后每次打开编成界面都会把这份数据 restore 回来 ——
  //   于是服务端改成空槽也没用，界面还是三队同一个人。
  //   判据：≥3 个槽位且全部同一个人 → 视为旧数据，拒收并回当前的（空）预设。
  const _mains = params.map(function (x) { return String(x && x.master_main_character_id || ""); });
  if (params.length >= 3 && _mains[0] && new Set(_mains).size === 1) {
    console.log("[preset] restore 拒收退化数据（" + params.length + " 队全是 " + _mains[0] + "）→ 保持空槽");
    return okShaped(ctx.path, { preset: s.__presets[key] || [] });
  }
  // 用请求里的 parameters 构造预设（这是玩家的真实队伍配置）
  // ★ restore 的请求体里【没有 formation_id】（客户端本地只存队伍/装备/技能），
  //   所以要保留服务端已知的阵位，否则会退回全 "A01" → 全队叠在一个格子。
  const prevList = Array.isArray(s.__presets[key]) ? s.__presets[key] : [];
  const prevBySlot = new Map(prevList.map(function (x) { return [Number(x.slot_num), x]; }));
  const list = params.map(function (p, i) {
    const slot = p.slot_num !== undefined ? Number(p.slot_num) : i;
    const old = prevBySlot.get(slot) || {};
    const base = buildPreset(key, slot, p.formation_id || old.formation_id || "", p.master_main_character_id, p.master_support_character_id);
    base.skill_ids = p.skills || [];
    base.equipment_ids = p.equipments || [];
    base.amulet_ids = p.amulets || [];
    return base;
  });
  s.__presets[key] = list.length ? list : (prevList.length ? prevList : [buildPreset(key, 0)]);
  normalizePreset(s.__presets[key], key);
  markDirty();
  console.log("[preset] restore " + key + " -> " + s.__presets[key].length + " 套");
  return okShaped(ctx.path, { preset: s.__presets[key] });
});

// ★★ 付费抽卡结算（payment/update_use_currency）—— 语义：把「待处理的购买」处理掉。
//   请求 { paymentId, isComplete, platformId, deviceId, ratingId }
//   ★ isComplete 的语义（契约实证）：
//     false = 首次上报（客户端刚完成支付），服务端【标记为未处理】并原样返回；
//     true  = 二次确认，服务端【真正发放】抽卡结果并清空 unprocessedList。
//   契约那次的 unprocessedList 有 1 条（含 DmmXgPaymentId / PurchaseActionType=GachaRoll /
//     PurchaseActionId1..4 = 按钮id/gachaGroupId/gachaId/次数）—— 正是「待发放的购买」。
//   响应还要带 GachaEmisions（实际抽到的东西）+ CurrentGachaInfo + UserAssetGachaGroupList。
//   早期实现：什么都不做，只回空的 BonusList/GachaEmisions → 玩家付费后什么都没发生。
route("payment/update_use_currency", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__unprocessed) s.__unprocessed = [];
  const pid = String(req.paymentId || "");
  const isComplete = req.isComplete === true || req.isComplete === "true";
  const emissions = [];
  const bonusList = [];
  const bonusItems = [];
  let bonusAsset = { AllItemList: [] };
  let gachaInfo = { GachaGroupId: "", GachaId: "", ButtonId: "", TryRollCount: 1, AppearNumber: 1 };
  // ★ 契约实证的关键语义（推翻我的第一版理解）：
  //   契约那次的请求是 **isComplete=false**，但响应里**已经有 10 条 GachaEmissions** ——
  //   说明服务端不是「先登记、后确认发放」两阶段，
  //   而是「**本次调用即结算该 paymentId 对应的待处理购买**」。
  //   isComplete 只是客户端告诉服务端「这次是否已完整持有凭据」，
  //   不影响是否结算（待处理项可能是【上一次调用】留下的）。
  //   因此：**只要有 pending 就结算**，无论 isComplete 真假。
  const pendingNow = s.__unprocessed.filter(function (x) { return pid ? x.DmmXgPaymentId === pid : true; });
  if (pendingNow.length) {
    const rewards = [];
    for (const p of pendingNow) {
      const gachaId = p.PurchaseActionId3, buttonId = p.PurchaseActionId1;
      const n = Math.max(1, Number(p.PurchaseActionId4) || 1);
      try {
        // ★ 必须调用 performGachaRoll（与 gacha/roll 同一实现）而不是底层的 roll()：
        //   roll() 只返回 emissions；角色入库 / 碎片折算 / BonusList / player_all_asset
        //   都在 performGachaRoll 里完成。契约那次的响应同时有这四项，证明确实需要全套副作用。
        const res = performGachaRoll({
          gachaGroupId: p.PurchaseActionId2, gachaId: gachaId, buttonId: buttonId,
          tryRollCount: n, appearNumber: 1,
        });
        for (const x of ((res.GachaEmisions || {}).GachaEmissions || [])) emissions.push(x);
        for (const b of (res.BonusList || [])) bonusList.push(b);
        for (const x of ((res.player_all_asset || {}).AllItemList || [])) bonusItems.push(x);
        bonusAsset = res.bonus_player_all_asset || bonusAsset;
        gachaInfo = res.CurrentGachaInfo || gachaInfo;
      } catch (e) { console.error("[payment] roll failed: " + e.message); }
    }
    s.__unprocessed = s.__unprocessed.filter(function (x) { return pendingNow.indexOf(x) < 0; });
  }
  if (!isComplete) {
    // 首次上报：登记为待处理（若同 paymentId 已存在则不重复登记）
    if (pid && !s.__unprocessed.some(function (x) { return x.DmmXgPaymentId === pid; })) {
      s.__unprocessed.push({
        Id: Date.now() % 1000000000, DmmXgPaymentId: pid, PlayerId: s.UserData.id, Status: 0,
        ProductCategory: 2, ExchangeCount: 1, PurchaseActionType: "GachaRoll",
        PurchaseActionId1: req.buttonId || "", PurchaseActionId2: req.gachaGroupId || "",
        PurchaseActionId3: req.gachaId || "", PurchaseActionId4: String(req.tryRollCount || 1),
        PaidWith: null, CreatedAt: nowStamp(), UpdatedAt: nowStamp(),
      });
    }
  }
  markDirty();
  flushNow();
  console.log("[payment] update_use_currency paymentId=" + pid + " complete=" + isComplete +
    " 待处理=" + s.__unprocessed.length + " emissions=" + emissions.length);
  return okShaped(ctx.path, {
    player_all_asset: touchedPlayerAssets(),
    // ★ bonus_player_all_asset = 附赠资产的变动（契约 3 条）——
    //   早期恒为空对象，漏了 roll 返回的这一项。
    bonus_player_all_asset: bonusAsset,
    CurrentGachaInfo: gachaInfo,
    BonusList: bonusList,
    GachaEmisions: { GachaEmissions: emissions, IsContainsPickUpCharacter: false },
    // UserAssetGachaGroupList 与 gacha/list 同源（只含玩家交互过的池）
    UserAssetGachaGroupList: (function () {
      const prev = (s.__gachaCounts && typeof s.__gachaCounts === "object") ? Object.keys(s.__gachaCounts) : [];
      if (!prev.length) return null;
      const touched = new Set();
      for (const k of prev) { const gid = String(k).split("|")[0]; if (gid) touched.add(gid); }
      return gachaGroups(function (gid, gachaId, buttonId) { return peekGachaCount(gid, gachaId, buttonId); })
        .filter(function (g) { return touched.has(g.gachaGroupId); });
    })(),
    UserAssetBoxGachaGroupList: null,
    isGachaPeriod: true,
    MissionProgressList: [],
    limited_mission_progress_list: [],
    xgHttpStatus: 201,
    platformId: "dmm", deviceId: "pc", ratingId: "R18",
    type: "payment", paymentId: pid, status: "complete",
    paidStoneBalance: s.paidStoneBalance || 0,
    freeStoneBalance: s.freeStoneBalance || 0,
    unprocessedList: s.__unprocessed,
  });
});
route("shop/get_re_event_shop_stock_info", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const key = String(req.shop_id);
  if (!s.__shopStock) s.__shopStock = {};
  // 契约字段是 re_event_goods（不是 stock_list），每项含
  // { shop_id, goods_id, has_stock, stock, has_per_day_exchangeable_time,
  //   per_day_exchangeable_time, has_service_expired_time, service_expired_time }
  // 早期字段名写错且列表为空 —— 客户端读不到库存。
  // ★★★ 2026-10-21：不再永久缓存 ★★★
  //   旧实现把第一次生成的结果写进 s.__shopStock[key] 就一劳永逸：
  //   那次只生成了 2 个商品（当时的取表逻辑有问题），结果整个商店 43 个商品的库存
  //   永远停在旧值 —— 用户报障「兑换后『あと 3 回』不变数」。
  //   现在每次都按 ReEventGoodsTable 重建，剩余次数 = Limit − 已兑换次数(s.__shopExchanged)。
  if (!s.__shopExchanged) s.__shopExchanged = {};
  {
    let rows = [];
    try {
      const md = loadTable("Shop/ReEventGoodsTable.csv");
      rows = md.rows.filter(function (r) { return !req.shop_id || r.ShopId === req.shop_id; });
    } catch (e) { rows = []; }
    const list = rows.map(function (r) {
      const ex = Number(s.__shopExchanged[r.ShopId + "|" + r.GoodsId] || 0);
      const limit = Number(r.Limit) || 0;
      return {
        shop_id: r.ShopId,
        goods_id: r.GoodsId,
        has_stock: limit > 0,
        stock: Math.max(0, limit - ex),
        has_per_day_exchangeable_time: Number(r.DailyLimit) > 0,
        per_day_exchangeable_time: Number(r.DailyLimit) || 0,
        has_service_expired_time: false,
        service_expired_time: 0,
      };
    });
    s.__shopStock[key] = { re_event_goods: list };
  }
  if (false) {
    // 从 MasterData 取该商店（shop_id 为空时取全部）的商品，生成库存条目。
    // 契约字段是 re_event_goods，每项：{ shop_id, goods_id, has_stock, stock,
    //   has_per_day_exchangeable_time, per_day_exchangeable_time,
    //   has_service_expired_time, service_expired_time }
    let rows = [];
    try {
      // 正确的表是 Shop/ReEventGoodsTable.csv（字段 ShopId/GoodsId/Limit/DailyLimit/PerDayCount）。
      const md = loadTable("Shop/ReEventGoodsTable.csv");
      rows = md.rows.filter(function (r) { return !req.shop_id || r.ShopId === req.shop_id; });
    } catch (e) { rows = []; }
    const list = rows.map(function (r) {
      return {
        shop_id: r.ShopId,
        goods_id: r.GoodsId,
        has_stock: true,
        stock: Number(r.Limit) || 0,
        has_per_day_exchangeable_time: Number(r.DailyLimit) > 0,
        per_day_exchangeable_time: Number(r.DailyLimit) || 0,
        has_service_expired_time: false,
        service_expired_time: 0,
      };
    });
    // 找不到商品定义时，退回契约里的形状（保证结构正确）
    s.__shopStock[key] = { re_event_goods: list };
  }
  console.log("[shop] get_re_event_shop_stock_info " + key + " -> " + (s.__shopStock[key].re_event_goods || []).length + " 件");
  return okShaped(ctx.path, s.__shopStock[key]);
});


// ==================== 其余读接口（原为回放，现按状态实现）====================
// 录制只作测试基准；这些端点此前未实现（靠回放），现给出真实实现。
// 说明：社交换取/公会这类数据在单机环境下没有真实来源，返回【结构正确的空或占位】，
// 而不是照搬录制时的他人数据。

// ---- chat/rooms ----
route("chat/rooms", function (ctx) {
  const s = getState();
  const rooms = Array.isArray(s.__chatRooms) ? s.__chatRooms.slice() : [];
  // 旧存档里的 UUID token 一律升级成 JWT（否则客户端解析失败会丢房间）
  let __tokFixed = 0;
  for (const r of rooms) {
    if (!r || typeof r.subscriptionToken !== "string" || r.subscriptionToken.split(".").length !== 3) {
      r.subscriptionToken = makeFakeJwt(r.topicId, (s.UserData || {}).id);
      __tokFixed++;
    }
  }
  if (__tokFixed) { markDirty(); console.log("[chat] 升级 " + __tokFixed + " 个房间 token 为 JWT"); }
  // 一致性自愈：客户端 IsEmpty() 以 guild_name != null 判「已入会」，
  // 若已入会却查不到 type=2 房间，SmallMenuViewModel 会 FirstOrDefault() 得到 null → NRE。
  // ★★★ 2026-10-17 修正：补回【世界聊天频道】（真机契约里的 type=1 房间）★★★
  //   两份契约（本地+真机）的房间构成完全一致：6 个 type=1 + 1 个 type=3（+ 入会时的 type=2）。
  //   我原来只给公会房间 ⇒ 不入会时 rooms=[] ⇒ 点「チャット」直接报错。
  //   id/topicId 是服务端常量（每个玩家都一样），照契约镜像即可。
  const BASE_ROOMS = [
    { id: 1, type: 1, ownerId: 1, topicId: "ac53c884-afde-4db0-b0a6-491d8aeb1f5d" },
    { id: 2, type: 1, ownerId: 2, topicId: "e399e99d-2afb-4710-97d1-20142628f916" },
    { id: 3, type: 1, ownerId: 3, topicId: "06249536-617f-40b0-b325-e6984892dc43" },
    { id: 4, type: 1, ownerId: 4, topicId: "ba02b4b0-3923-47ce-b5b3-f1c400669875" },
    { id: 5, type: 1, ownerId: 5, topicId: "58e83098-ad83-418a-8d56-bccb6e9d9ea3" },
    { id: 6, type: 1, ownerId: 6, topicId: "4ef737ca-35be-47cf-b019-06ef8e29d060" },
  ];
  let added = 0;
  for (const b of BASE_ROOMS) {
    if (rooms.some(function (r) { return Number(r.id) === b.id; })) continue;
    rooms.push({
      id: b.id, type: b.type, ownerId: b.ownerId, topicId: b.topicId,
      // 与公会房间同理：token 必须非空，否则客户端订阅失败会把房间丢掉
      subscriptionToken: makeFakeJwt(b.topicId, (s.UserData||{}).id),
    });
    added++;
  }
  if (added) { s.__chatRooms = rooms; markDirty(); }

  const joined = guildInternal().guild_name != null;   // 与客户端同一判据
  const hasGuildRoom = rooms.some(function (r) { return r.type === 3; });   // 公会的服务端 type 是 3
  if (joined && !hasGuildRoom) {
    const gid = Number(guildInternal().guild_id) || 0;
    rooms.push({
      id: 200000000 + (gid % 100000000), type: 3, ownerId: gid,   // ★ 必须是 3：客户端 RoomType = type-1，ChatType.Guild=2
      topicId: "00000000-0000-4000-8000-" + String(gid).padStart(12, "0"),
      // ★★★ subscriptionToken 必须【非空】（2026-10-17 用户报障「建会后卡死」）★★★
      //   真机契约里它是真实 token；我给空串 ⇒ 客户端的 pubsub 订阅失败 ⇒
      //   房间被丢弃 ⇒ `ChatUseCase.GetRoomList(ChatType.Guild)` 返回空 ⇒
      //   `CommonHeaderBehaviour.Refresh()` 里 `FirstOrDefault(...)` 得 null ⇒
      //   `NullCheck` 抛 NullReferenceException ⇒ 整个 Header 刷新失败、界面卡死。
      //   用确定性 UUID（同一 guild 每次生成相同，避免客户端反复重订阅）。
      subscriptionToken: makeFakeJwt("00000000-0000-4000-8000-" + String(gid).padStart(12, "0"), (s.UserData||{}).id),
    });
    s.__chatRooms = rooms;
    markDirty();
    console.log("[chat] rooms -> 补齐公会房间 (guild_id=" + gid + ")");
  } else if (!joined && hasGuildRoom) {
    s.__chatRooms = rooms.filter(function (r) { return r.type !== 2; });
    markDirty();
    return okShaped(ctx.path, { rooms: s.__chatRooms });
  }
  return okShaped(ctx.path, { rooms: rooms });
});

// ---- friend/load_friend_data ----
route("friend/load_friend_data", function (ctx) {
  const s = getState();
  return okShaped(ctx.path, {
    friend_list: [],
    friend_request_list: [],
    get_friend_coin: 0,
    daily_friend_coin: 0,
    block_player_list: [],
    items: [],
    daily_send_friend_coin_number: 0,
    friend_apply_list: [],
    // ★ 增量语义（真机 friend/load_friend_data → 0 条，不是全量 2083）
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ---- friend/search_friend_candidate ----
route("friend/search_friend_candidate", function (ctx) { return okShaped(ctx.path, { user_list: [] }); });

// ---- guild/get_guild_profile ----
route("guild/get_guild_profile", function (ctx) {
  const s = getState();
  return okShaped(ctx.path, {
    guild_internal_data: guildInternal(),
    guild_master_force_change_data: [],
    join_restriction_release_date: 0,
  });
});

// ---- recollection/get_list ----
// ★★ 追想（recollection）已通关列表 —— 数据源是 **UserQuestList**：
//   存档里有 30 条 MasterQuestType=16 且 MasterQuestId 以 "Recollection_" 开头的记录
//   （如 Recollection_hard_005_1_1，TotalClearCount=1），这正是契约的 30 条 ✅。
//   battle_formation_json 的形状与 battle_formation_list[].battle_formation_info_list 完全一致。
//   早期实现读 s.__recollection —— **没有任何代码写它** → 恒为空数组。
route("recollection/get_list", function (ctx) {
  const s = getState();
  const out = [];
  for (const q of (s.UserQuestList || [])) {
    const qid = String(q.MasterQuestId || "");
    if (!/^Recollection_/i.test(qid)) continue;
    if (!(Number(q.TotalClearCount) > 0)) continue;
    // 编成快照：优先取该任务对应的 battle_formation_list 项，否则取第一项
    const bf = (s.battle_formation_list || []).find(function (b) {
      const t = b && b.type;
      return t && String(t.quest_id || "") === qid;
    }) || (s.battle_formation_list || [])[0];
    const info = bf && bf.battle_formation_info_list;
    out.push({
      master_quest_id: qid,
      battle_formation_json: info
        ? { battle_formation: info.battle_formation || [], action_priority: info.action_priority || [], formation_id: info.formation_id || [] }
        : { battle_formation: [], action_priority: [], formation_id: [] },
    });
  }
  console.log("[recollection] get_list -> " + out.length + " 条");
  return okShaped(ctx.path, { recollection_cleard_characters: out });
});

// ---- ranking/load_ranking_schedule_data ----
route("ranking/load_ranking_schedule_data", function (ctx) {
  // ★★★ 2026-10-17 修正：这个 handler 原来读的列【全都不存在】 ★★★
  //   Ranking/RankingSetting.csv 的真实列是：rankingId / name / description / begin_at / weekly_on / monthly
  //   而我原来读 ScheduleId / MasterRankingId / RankingName / ResetAt / StartAt / EndAt / StatusType
  //   ⇒ 六个字段全部兜成 0/空串 ⇒ 客户端拿到 schedule_id:0 + master_ranking_id:""
  //   ⇒ 查不到排行主数据 ⇒ 点「ランキング」直接报错。
  //
  // 权威依据（本地契约 + 真机契约，6 条完全同构）：
  //   {"schedule_id":1,"master_ranking_id":"combat_power","ranking_name":"戦闘力",
  //    "reset_at":<下次重置>,"start_at":<开始>,"end_at":0,"status_type":1}
  //   schedule_id 是「赛程实例 id」，主数据表里没有；下面这张映射取自两份契约（稳定值）。
  const SCHEDULE_ID = {
    combat_power: 1, chara_favorite: 7, memory_book: 8,
    guild_combat_power: 14, use_stamina: 330, tower_quest: 338,
  };
  // 有期活动（end_at = 重置时刻）vs 常驻（end_at = 0）
  const EVENT_RANKING = { use_stamina: 1, tower_quest: 1 };
  // JST 下一个周一 00:00 的 unix 秒（周重置基准）
  function nextWeeklyReset() {
    const nowJst = Date.now() + 9 * 3600 * 1000;
    const d = new Date(nowJst);
    const dow = d.getUTCDay();                 // 0=周日
    const addDays = (dow === 1) ? 7 : ((8 - dow) % 7 || 7);   // 下周一
    const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((base + addDays * 86400000) / 1000) - 9 * 3600;
  }
  const resetAt = nextWeeklyReset();
  const nowSec = Math.floor(Date.now() / 1000);
  let list = [];
  try {
    const md = loadTable("Ranking/RankingSetting.csv");
    if (md) {
      list = md.rows.map(function (r) {
        const rid = String(r.rankingId || "");
        // begin_at 形如 "2021-03-05 0:00:00"（JST）
        let startAt = Number(r.begin_at) || 0;
        if (!startAt && r.begin_at) {
          const m = String(r.begin_at).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
          if (m) startAt = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000) - 9 * 3600;
        }
        const isEvent = !!EVENT_RANKING[rid];
        return {
          schedule_id: SCHEDULE_ID[rid] || 0,
          master_ranking_id: rid,
          ranking_name: String(r.name || ""),
          reset_at: isEvent ? (nowSec + 7 * 86400) : resetAt,
          start_at: isEvent ? (nowSec - 7 * 86400) : (startAt || 1614870000),
          end_at: isEvent ? (nowSec + 7 * 86400) : 0,
          status_type: 1,
        };
      }).filter(function (x) { return x.master_ranking_id && x.schedule_id > 0; });
    }
  } catch (e) { list = []; console.log("[ranking] schedule 生成失败: " + e.message); }
  console.log("[ranking] schedule -> " + list.length + " 条: " + list.map(function (x) { return x.schedule_id + ":" + x.master_ranking_id; }).join(", "));
  return okShaped(ctx.path, { ranking_schedule_list: list });
});

// ---- oracle_liberator/update 与 receive_reward ----
// 这两个端点共享「神谕解放」状态。契约形状来自录制，数值取自状态。
// ★★ 神谕解放者状态 —— 收口为【单一模型】。
//   原实现有形状冲突：start/stop/select/reset 写的是 s.__oracle[stage_id] = {...}（当 map 用），
//   而这里又期望 s.__oracle = { stage_expedition_list, into_list, receive_stage_list }（当结构体用）
//   → 同一个对象两种形状混用，**receive_stage_list 永远不会被填**，
//     于是 receive_reward 的 item_format_list 恒空（契约 224 条）——玩家点「领取」什么也拿不到。
//   统一模型：{ stages: { <stageId>: {stage_id, exploring, oracle_effect_id, master_character_ids,
//                                     received_count} }, claimed: { <stageId>: count } }
//   三个对外列表均由 stages 实时派生（收口，杜绝再出现「谁都不填」的字段）。
const ORACLE_TABLE = "OracleLiberator/OracleLiberator.csv";
/** unix 秒 → 契约要求的 ISO8601 微秒串（如 2025-01-01T00:00:00.000000Z）。 */
function isoStamp(sec) {
  const t = Number(sec) || Math.floor(Date.now() / 1000);
  return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, ".000000Z");
}

/** 读 GroundRule 的整数值（表里查，不硬编码）。 */
function groundRuleLong(ruleName, def) {
  try {
    const t = loadTable("GroundRule/GroundRule.csv");
    const r = ((t && t.rows) || []).find(function (x) { return String(x.RuleName) === String(ruleName); });
    if (r && r.Value !== undefined && r.Value !== null && String(r.Value).trim() !== "") {
      const v = Number(String(r.Value).trim());
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch (e) {}
  return def;
}

/**
 * ★★★ 神谕解放者·探索的时间机制（2026-10-16 用户报障后实现）★★★
 *
 * 用户原话：「此前你实现了探索上阵、变更、中止，但是**奖励发放这块完全没测过**，
 *   而且由于服务器频繁重启，该探索又是**以时间为单位**，需 **12 小时**后才能领取完整奖励」。
 *
 * ★ 我此前的实现【完全没有时间维度】：`start_at` 存了却从不参与计算，
 *   而 `receivable_count` 下发的是「累计已领轮数」（应为「当前可领轮数」）。
 *
 * ★★ 权威公式（反编译 `OracleLiberatorUseCase.GetExploreRequiredTime` .cs:646-658）★★
 * ```csharp
 * long base = GroundRule.GetLongValue("OracleLiberator_ExploreLap");   // = 43200 秒（12 小时）
 * var model = GetOracleLiberatorMasterModel(stageId);
 * return (long)(((model.ExploreMember + 1) - memberNum) * base);
 * ```
 * ⇒ **所需时间 = (ExploreMember + 1 − 编成人数) × ExploreLap**
 *   · 满编 12 人 → (13−12) × 43200 = **43200 秒 = 12 小时**（用户说的 12 小时 ✅）
 *   · 1 人       → 12 × 43200 = 518400 秒 = 6 天
 *   · 与截图「探索に参加するキャラが多いほど報酬までの時間が短縮」**完全一致**。
 *
 * ★★ 轮数（`GetCompleteExploreCount` .cs:694-698）★★
 * ```csharp
 * return (int)((TimeUtility.GetCurrentDateTime() - DateTime.Parse(startTime)).TotalSeconds / requiredTime);
 * ```
 * ⇒ **已完成轮数 = floor((当前时间 − start_at) / 所需时间)**
 *
 * ★ 7 天上限：`GroundRule.OracleLiberator_ExploreReceiveLimit = 604800` 秒
 *   —— 与截图「報酬は**7日間**の受取期限がある」完全一致。
 *   实现为「elapsed 最多按 7 天计」，即奖励最多累积 7 天。
 *
 * ★ 客户端侧（`GetReceivableRewardCount` .cs:888-893）只是 `Σ 各 stage 的 receivable_count`
 *   —— 即**可领轮数由服务端算好下发**，客户端不做业务计算。
 */
function oracleExpedition(st) {
  const sid = Number(st && st.stage_id !== undefined ? st.stage_id : 0);
  const tbl = loadTable(ORACLE_TABLE);
  const row = ((tbl && tbl.rows) || []).find(function (r) { return Number(r.StageID) === sid; }) || null;
  // ExploreMember = 该 stage 的可编成上限（表里全是 12）
  const exploreMember = Number(row && row.ExploreMember) || 12;
  const memberNum = ((st && st.master_character_ids) || []).length;
  // ★★★ 探索加速倍率（2026-10-17，用户要求「给我加个速」）★★★
  //   官方：满编 12 小时/轮、可累积上限 7 天。
  //   默认 720 倍 → 满编 **1 分钟/轮**、累积上限 **14 分钟**（最多 14 轮）。
  //   `LEGECLOX_ORACLE_SPEED=1` 可恢复官方速度（或其他任意倍率）。
  //   ★ 实现方式：把「基准时长」与「累积上限」同时除以倍率 ——
  //     等价于让服务器时钟在这套玩法里走得更快，且 start_at 仍存真实时间
  //     （重启服务端不丢进度）。
  const lapSec = Math.max(1, Math.floor(groundRuleLong("OracleLiberator_ExploreLap", 43200) / ORACLE_SPEED));
  // ★ 公式：所需时间 = (上限 + 1 − 实际编成) × 基准（满编 = ×1；官方 12 小时，加速后 1 分钟）
  const requiredTime = Math.max(1, (exploreMember + 1 - Math.max(1, memberNum)) * lapSec);
  const limitSec = Math.max(1, Math.floor(groundRuleLong("OracleLiberator_ExploreReceiveLimit", 604800) / ORACLE_SPEED));
  const now = Math.floor(Date.now() / 1000);
  const startAt = Number(st && st.start_at) || now;
  // ★ 7 天上限：超期部分不再累积奖励
  const elapsed = Math.min(Math.max(0, now - startAt), limitSec);
  const completeCount = Math.floor(elapsed / requiredTime);
  const received = Number(st && st.received_count) || 0;
  const receivable = Math.max(0, completeCount - received);
  return { stageId: sid, row: row, requiredTime: requiredTime, limitSec: limitSec,
           elapsed: elapsed, completeCount: completeCount, received: received, receivable: receivable };
}
/**
 * ★★★ 神谕探索的「角色唯一性」校验（2026-10-17）★★★
 *
 * 权威依据（两份契约各 8 个 stage 的实测）：
 *   · 真机契约：87 个角色槽位 / **唯一角色 87** → 跨 stage 重复 **0**
 *   · 本地契约：96 个角色槽位 / **唯一角色 96** → 跨 stage 重复 **0**
 * ⇒ **同一角色不能同时编入多个 stage** —— 这是【服务端】的约束：
 *   反编译 `OracleLiberatorUseCase.GetExploreAdmissionModel` 只是一段
 *   `Where(...)` 的展示用筛选；`UserOracleLiberatorStageExpeditionModel` 上也
 *   只有 UI 刷新标记 `isExploreChanged`，**没有硬校验**。
 *   客户端表现为灰选 / 界面上的红色 ❗（用户截图中 Lv42 / Lv61 那两位）。
 *
 * 本函数供 start / restart 共用（收口，避免逐处复制）。
 * @returns [{id, stage_id}] 与该请求冲突的角色及其当前所在 stage
 */
function oracleConflictingCharacters(s, excludeStageId, ids) {
  const out = [];
  const stages = (s.__oracle && s.__oracle.stages) || {};
  const want = Array.isArray(ids) ? ids : [];
  for (const k of Object.keys(stages)) {
    if (Number(k) === Number(excludeStageId)) continue;   // 同一 stage 内重写不冲突
    const used = new Set(stages[k].master_character_ids || []);
    for (const id of want) if (used.has(id)) out.push({ id: id, stage_id: Number(k) });
  }
  return out;
}

function oracleState() {
  const s = getState();
  if (!s.__oracle || typeof s.__oracle !== "object") s.__oracle = {};
  if (!s.__oracle.stages || typeof s.__oracle.stages !== "object") {
    // 迁移历史脏数据：把「stage_id 直接当键」的旧形状收进 stages
    const old = s.__oracle;
    const stages = {};
    for (const k of Object.keys(old)) {
      if (/^\d+$/.test(k) && old[k] && typeof old[k] === "object") stages[k] = old[k];
    }
    s.__oracle = { stages: stages, claimed: {} };
  }
  if (!s.__oracle.claimed) s.__oracle.claimed = {};
  return s.__oracle;
}
/** 由 stages 实时派生【对外】三个列表（杜绝字段无人填）。 */
function oracleView() {
  const o = oracleState();
  const tbl = loadTable(ORACLE_TABLE);
  const rows = (tbl && tbl.rows) || [];
  const expedition = [];
  const into = [];
  const receivable = [];
  for (const key of Object.keys(o.stages)) {
    const st = o.stages[key] || {};
    const sid = Number(st.stage_id !== undefined ? st.stage_id : key);
    // ★★★ 时间机制（2026-10-16 修）：可领轮数由「已过时间 / 每轮所需时间」算出 ★★★
    //   我此前下发的是 `st.received_count`（累计已领）——**语义完全相反**，
    //   且 `start_at` 从不参与计算（等于没有时间机制）。
    const exp = oracleExpedition(Object.assign({}, st, { stage_id: sid }));
    const row = exp.row;
    if (st.exploring) {
      expedition.push({
        stage_id: sid,
        master_character_ids: st.master_character_ids || [],
        receivable_count: exp.receivable,   // ★ 当前可领轮数（不是累计已领）
        // ★ start_at 是 **ISO8601 字符串**（契约 "2025-01-01T00:00:00.000000Z"），
        //   不是 unix 数字 —— 早期给数字导致 TYPE 不符。
        start_at: isoStamp(st.start_at),
      });
      if (st.oracle_effect_id) {
        into.push({ stage_id: sid, selected_main_oracle_effect_id: st.oracle_effect_id, master_character_ids: st.master_character_ids || [] });
      }
    }
    // ★ 可领取 = 「已过时间算出的完成轮数」−「已领轮数」（不再用自造的 claimed 差值）
    if (exp.receivable > 0 && row && row.ExploreRewardTableId) {
      receivable.push({ stage_id: sid, received_count: exp.receivable, explore_reward_table_id: row.ExploreRewardTableId });
    }
  }
  return { stage_expedition_list: expedition, into_list: into, receive_stage_list: receivable };
}

route("oracle_liberator/update", function (ctx) {
  const v = oracleView();
  return okShaped(ctx.path, {
    oracle_liberator_stage_expedition_list: v.stage_expedition_list,
    oracle_liberator_into_list: v.into_list,
  });
});
// ★★ 神谕解放者·领取奖励 —— 权威数据链：
//   OracleLiberator/OracleLiberator.csv：(StageID → QuestID, OracleEffectGroupID, ExploreRewardTableId)
//   ExploreRewardTableId → rewards.mjs（RewardList → Decision/RandomRewardTable）
//   契约实证：item_format_list 有 **224 条**（可含重复 id，是「逐次所得流水」），
//     player_all_asset.AllItemList 只有 7 个唯一 id —— 再次印证两者语义不同：
//       item_format_list = 本次所得增量流水（可重复）
//       player_all_asset = 变动道具的当前持有量（去重）
//   早期实现只清空 receive_stage_list、item_format_list 恒空 ⇒ 玩家点了「领取」却什么都没得到。
route("oracle_liberator/receive_reward", function (ctx) {
  const o = oracleState();
  const v = oracleView();
  const received = v.receive_stage_list.slice();
  const rewards = [];
  for (const st of received) {
    const rid = st.explore_reward_table_id;
    const times = Math.max(1, Number(st.received_count) || 1);
    if (!rid) continue;
    // ★★★ 每轮【重新掷骰】而不是发整张候选表（2026-10-16 用户报障）★★★
    //   权威依据：RewardList 的 `Reward_OracleLiberatorExplore_01` 是 `RewardType=2`（Random）
    //     且 `LotteryCount=2` ⇒ **每轮从 RandomRewardTable 的 26 条里按权重抽 2 次**。
    //   ★ 两份真机契约的决定性证据（条数 / 轮数 = 恒为 2.000）：
    //       真机: 7 stage × 4 轮 = 28 轮 → item_format_list **56 条**
    //       本地: 8 stage × 14 轮 = 112 轮 → item_format_list **224 条**
    //     且条目有重复（`tenmei_06x2` 出现 7 次、`tenmei_04x2` 6 次）⇒ 是掷骰结果，不是候选池。
    //   ★ 我此前用 `rewardsForRewardId`（返回 26 条候选池）→ 每轮白送整张表（26 倍收益）。
    //   注：`rollRewardId` 内部会按子表掷 LotteryCount 次；无子表定义时自动退化为原行为。
    for (let i = 0; i < times; i++) {
      for (const x of rollRewardId(rid)) {
        rewards.push({ sheet_type: x.sheetType || 1, master_id: x.master_id, amount: x.amount || 1 });
      }
    }
    // ★ 累加到【源状态】的 received_count（时间机制的基准） ——
    //   早期累加到自造的 `o.claimed`，导致「已完成轮数 − 已领轮数」永远算不清。
    const src = o.stages[String(st.stage_id)] || o.stages[st.stage_id];
    if (src) src.received_count = (Number(src.received_count) || 0) + times;
  }
  if (rewards.length) applyRewards(rewards);
  markDirty();
  flushNow();
  console.log("[oracle] receive_reward " + received.length + " stage(s) → " + rewards.length + " 条奖励");
  const v2 = oracleView();
  return okShaped(ctx.path, {
    receive_reward_stage_list: received,
    oracle_liberator_stage_expedition_list: v2.stage_expedition_list,
    player_all_asset: touchedPlayerAssets(),
    item_format_list: toItemFormatList(rewards),
    present_item_format_list: [],
  });
});
// ---- present/list ----
// 契约形状：{ presentList, presentHistoryList }。presentList 来自状态（真实可领），
// presentHistoryList 是领取历史。
// 本地礼物箱的初始内容。
//
// 为什么是「本地发放」而不是「回放契约」：录制里的 18 件礼物是当时真实服务端
// 下发给那个账号的（含活动/补偿类），本地单机环境没有这些来源。
// 与其伪造录制数据，不如**由本地服务端明确发放**一批运营礼物 —— 语义诚实、
// 玩家进游戏后礼物箱可用、且完全可解释。
const LOCAL_GIFTS = [
  { id: 900000001, sheetType: 1, masterContentId: "Item_Stone_Free", amount: 3000, message: "ローカルサーバー開始記念" },
  { id: 900000002, sheetType: 1, masterContentId: "Item_Currency_Gold", amount: 1000000, message: "ローカルサーバー開始記念" },
  { id: 900000003, sheetType: 1, masterContentId: "Item_Material_Main_Exp_SSR", amount: 10, message: "育成応援" },
];

// ==================== 本地运营：发钻石到礼物箱 ====================
// POST /__admin/gift  {"amount": 12345}  →  往 __presentList 追加 Item_Stone_Free
route("__admin/gift", function (ctx) {
  const req = parse(ctx.body);
  const raw = parseInt(req.amount || req.count || 0, 10) || 0;
  const amount = Math.max(1, Math.min(9999999, raw));
  if (!amount) return okShaped(ctx.path, { ok: false, error: "amount invalid" });
  // paid=true / type="paid" / item="paid" → 有償魔宝石，否则無償
  const paid = req.paid === true || req.type === "paid" || req.item === "paid" || req.paidStone === true;
  // ★★★ 2026-10-30 新增：交换所货币「一键发放」★★★
  //   用户需求：「可以发我截图这些交换所的交换币，还有金币」
  //   POST /__admin/gift {"preset":"exchange","amount":500000,"direct":true}
  //   · preset=exchange → 8 种交换所货币（分数追击/深渊/附魔/银河/炼成/霸者之证/公会/月之辉石）
  //   · preset=coin     → 上面 8 种 + 金币
  //   · direct=true     → 直接进背包（AllItemList）；false/缺省 → 进礼物箱（需游戏内领取）
  //   · itemId=xxx      → 单个道具（原有行为）
  const EXCHANGE_PRESETS = {
    exchange: [
      "Item_Currency_ScoreAttackCoin",      // スコアアタックコイン 分数追击硬币
      "Item_Currency_AbyssCoin",            // 深淵コイン 深渊硬币
      "Item_Currency_EnchantCoin",          // エンチャントコイン 附魔硬币
      "Item_Currency_GalaxyCoin",           // 銀河コイン 银河硬币
      "Item_Currency_alchemyCoin",          // 錬成コイン 练成硬币
      "Item_Currency_Tower",                // 覇者の証 霸者之证
      "Item_Currency_Guild",                // ギルドコイン 公会硬币
      "Item_Currency_Character_Support",    // 月の輝石 月之辉石
    ],
    coin: [
      "Item_Currency_ScoreAttackCoin", "Item_Currency_AbyssCoin", "Item_Currency_EnchantCoin",
      "Item_Currency_GalaxyCoin", "Item_Currency_alchemyCoin", "Item_Currency_Tower",
      "Item_Currency_Guild", "Item_Currency_Character_Support",
      "Item_Currency_Gold",                 // 金币
    ],
  };
  const presetName = String(req.preset || "").trim();
  if (presetName && EXCHANGE_PRESETS[presetName]) {
    const amountP = Math.max(1, Math.min(999999999, parseInt(req.amount || req.count || 0, 10) || 0));
    if (!amountP) return okShaped(ctx.path, { ok: false, error: "amount invalid" });
    const sP = getState();
    const directP = req.direct === true || req.direct === 1 || req.direct === "true";
    const applied = [];
    if (directP) {
      for (const id of EXCHANGE_PRESETS[presetName]) {
        try { addItem(id, amountP); } catch (e) { console.log('[admin] addItem failed ' + id + ': ' + e.message); }
        applied.push({ item: id, amount: amountP });
      }
      try { flushNow(); } catch (e) { markDirty(); }
    } else {
      if (!sP.__presentList) sP.__presentList = [];
      const nowP = Math.floor(Date.now() / 1000);
      for (const id of EXCHANGE_PRESETS[presetName]) {
        const idp = 900300000 + (sP.__presentList.length + 1);
        sP.__presentList.push({ id: idp, sheetType: 1, masterContentId: id, amount: amountP,
          message: "ローカル運営より：" + id + " x" + amountP, reservedAt: nowP, receiptDeadlineAt: 4070962799 });
        applied.push({ item: id, presentId: idp, amount: amountP });
      }
      markDirty();
    }
    console.log("[admin] preset " + presetName + " x" + amountP + " direct=" + directP + " -> " + applied.length + " items");
    return okShaped(ctx.path, { ok: true, preset: presetName, amount: amountP, direct: directP, items: applied });
  }
  // ★ 2026-10-26：支持任意道具（测试用）—— 传 itemId 即按该道具发放，缺省仍为魔宝石
  const itemId = String(req.itemId || req.masterContentId || "").trim() || (paid ? "Item_Stone_Paid" : "Item_Stone_Free");
  const s = getState();
  if (!s.__presentList) s.__presentList = [];
  const now = Math.floor(Date.now() / 1000);
  const id = 900200000 + (s.__presentList.length + 1);
  s.__presentList.push({ id: id, sheetType: 1, masterContentId: itemId, amount: amount,
    message: "ローカル運営より：" + itemId + " x" + amount, reservedAt: now, receiptDeadlineAt: 4070962799 });
  markDirty();
  console.log("[admin] gift " + itemId + " x" + amount + " -> present id=" + id);
  return okShaped(ctx.path, { ok: true, id: id, amount: amount, paid: paid, item: itemId, presentCount: s.__presentList.length });
});

route("present/list", function (ctx) {
  const s = getState();
  // 首次访问时播种本地礼物
  if (!s.__presentList) {
    const now = Math.floor(Date.now() / 1000);
    s.__presentList = LOCAL_GIFTS.map(function (g) {
      return { id: g.id, sheetType: g.sheetType, masterContentId: g.masterContentId, amount: g.amount, message: g.message, reservedAt: now, receiptDeadlineAt: 4070962799 };
    });
    markDirty();
    console.log("[present] 已播种 " + s.__presentList.length + " 件本地运营礼物");
  }
  const list = (s.__presentList || []).map(function (p) {
    return {
      id: p.id || p.present_id,
      sheetType: p.sheetType || p.sheet_type || 1,
      masterContentId: p.masterContentId || p.master_id,
      amount: p.amount || 1,
      message: p.message || "",
      reservedAt: p.reservedAt || Math.floor(Date.now() / 1000),
      receiptDeadlineAt: p.receiptDeadlineAt || 0,
    };
  });
  const history = (s.__presentHistory || []);
  console.log("[present] list -> " + list.length + " 可领 / " + history.length + " 历史");
  return okShaped(ctx.path, { presentList: list, presentHistoryList: history });
});

// ---- present/receive_bulk ----
route("present/receive_bulk", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  let ids = Array.isArray(req.presentIdList) ? req.presentIdList : [];
  const list = s.__presentList || [];
  // ★ 2026-10-22：客户端的「一括受取」在本地列表为空时会发 **空 body**（实测 len=0 / {}），
  //   原来直接按空数组处理 → 一件都不领、界面「没反应」。
  //   「一括受取」的语义就是全领，所以 idList 为空时取全部。
  if (!ids.length && list.length) {
    ids = list.map(function (p) { return p.id || p.present_id; });
    console.log("[present] receive_bulk 请求未带 id → 按「一括受取」处理全部 " + ids.length + " 件");
  }
  const taken = [];
  const notFound = [];
  for (const id of ids) {
    const idx = list.findIndex(function (p) { return String(p.id || p.present_id) === String(id); });
    if (idx < 0) { notFound.push(id); continue; }
    taken.push(list[idx]);
    list.splice(idx, 1);
  }
  s.__presentList = list;
  // 发放奖励
  const rewards = taken.map(function (p) {
    return { sheet_type: p.sheetType || p.sheet_type || 1, master_id: p.masterContentId || p.master_id, amount: p.amount || 1 };
  });
  const applied = rewards.length ? applyRewards(rewards) : [];
  if (!s.__presentHistory) s.__presentHistory = [];
  for (const p of taken) {
    s.__presentHistory.push({ presentId: p.id || p.present_id, sheetType: p.sheetType || p.sheet_type || 1, masterContentId: p.masterContentId || p.master_id, amount: p.amount || 1, message: p.message || "", receivedAt: Math.floor(Date.now() / 1000) });
  }
  markDirty();
  console.log("[present] receive_bulk " + taken.length + " 件" + (notFound.length ? " (" + notFound.length + " 未找到)" : ""));
  return okShaped(ctx.path, {
    successfulPresentList: taken.map(function (p) { return p.id || p.present_id; }),
    failedPresentListByReceiptDeadline: [],
    failedPresentListByExpiration: [],
    failedPresentListByPossessionLimit: notFound,
    player_all_asset: touchedPlayerAssets(),
    item_format_list: toItemFormatList(applied),
    notification: [],
    present_count: list.length,
    xgHttpStatus: 205,
    paidStoneBalance: s.paidStoneBalance || 0,
    freeStoneBalance: s.freeStoneBalance || 0,
  });
});

// ==================== gacha providing ratio（ガチャ詳細）====================
//
// 客户端类 LoadGachaProvidingRatioMasterDataApi（GameGetApi，参数 firstTableId）：
//   TemporaryResponse { result { master_gacha: MasterTemporaryGachaRatioItem } }
//   MasterTemporaryGachaRatioItem { providing_ratio_item: MasterTemporaryGacha_ProvidingRatioItem[] }
//   MasterTemporaryGacha_ProvidingRatioItem {
//     gacha_type, first_table_id, lottery_type, gacha_display_parts_type,
//     is_pickup, item_format{sheet_type,master_id,amount,activate}, providing_ratio, valid_date }
//
// 数据来源：master_gacha.providing_ratio_display_parts（527 条 / 123 个 first_table_id），
// 字段 gacha_type / first_table_id / rarity_type / gacha_display_type /
//      main_providing_ratio / support_providing_ratio / equipment_providing_ratio / item_providing_ratio
//
// 早期本端点未实现且无录制样本 → 服务端返回 alterCode 9998 → 客户端
// 「通信エラーが発生しました（9998）」，点「ガチャ詳細」即报错。
// 惰性构建 first_table_id -> rows 索引（只解析一次 25MB，之后走缓存）。
let ratioIndex = null;
function gachaRatioIndex() {
  if (ratioIndex) return ratioIndex;
  ratioIndex = new Map();
  try {
    const raw = captured.get("master_load_master_data");
    if (!raw) { console.error("[gacha-ratio] master_load_master_data 不在 captured 里"); return ratioIndex; }
    const mg = (JSON.parse(raw).result || {}).master_gacha || {};
    for (const r of (mg.providing_ratio_display_parts || [])) {
      const k = r.first_table_id;
      if (!k) continue;
      if (!ratioIndex.has(k)) ratioIndex.set(k, []);
      ratioIndex.get(k).push(r);
    }
    console.log("[gacha-ratio] index built: " + ratioIndex.size + " tables");
  } catch (e) {
    console.error("[gacha-ratio] build failed: " + e.message);
  }
  return ratioIndex;
}

// ---- 提供割合（普池/免费池/友情池）----
// 数据源与算法见 gacha.mjs 的 providingRatio()（已用真实契约逐条验证）。
route("master/load_gacha_providing_ratio_master_data", function (ctx) {
  const q = (ctx.query && ctx.query.get) ? ctx.query.get("firstTableId") : null;
  const tableId = q || "";
  const items = providingRatio(tableId, "normal");
  if (!items) {
    console.log("[gacha-ratio] " + tableId + " 权重表无此池 -> 返回空");
    return okShaped(ctx.path, { master_gacha: { providing_ratio_item: [] } });
  }
  for (const it of items) it.first_table_id = tableId;
  console.log("[gacha-ratio] " + tableId + " -> " + items.length + " 条");
  return okShaped(ctx.path, { master_gacha: { providing_ratio_item: items } });
});

// ---- 提供割合（UP自选池）----
// 与普池的差异：多 lottery_type 字段；pickup 角色由玩家自选（存 state.__selectPick）。
route("master/load_gacha_providing_ratio_select_pick_master_data", function (ctx) {
  const q = (ctx.query && ctx.query.get) ? ctx.query.get("firstTableId") : null;
  const tableId = q || "";
  const items = providingRatio(tableId, "select_pick");
  if (!items) {
    console.log("[gacha-ratio-sp] " + tableId + " 权重表无此池 -> 返回空");
    return okShaped(ctx.path, { master_gacha: { providing_ratio_item: [] } });
  }
  for (const it of items) { it.first_table_id = tableId; it.lottery_type = it.lottery_type || 2; }
  console.log("[gacha-ratio-sp] " + tableId + " -> " + items.length + " 条");
  return okShaped(ctx.path, { master_gacha: { providing_ratio_item: items } });
});
// ============ 教程 savepoint 奖励发放（收口，tutorial/progress 与 tutorial/skip 共用）============
// ★★ 数据源 `Tutorial/TutorialSavePoint.csv`（Flag|SavePointName|SheetType|RewardItemId|Count|Level|Exp）★★
//   · `SAVEPOINT_4`  1 行  → SheetType=2 角色 **Ch004900204 ミカエル（Lv2/Exp10，支援）**
//   · `SAVEPOINT_15` 98 行 → SheetType=1：货币 6 / 石头 11（合计 18800）/ 装备 28（合计 44 件）/ 其它 53
// ★ 真机实证（新号契约 tutorial_progress.json，type=15）：响应的 player_all_asset 恰好 = SAVEPOINT_15 的
//   EquipmentList 44 + AllItemList 48 ⇒ **该端点负责「发放本 savepoint 的奖励并回执」**。
// ★ 用户报障（2026-10-18）「教程要求 link support 但没得选」= ミカエル（savepoint 4）从未发放 ——
//   我只推了 Stage，什么都没发。
// ★ 语义：**累积发放**（≤ 目标 savepoint 且未发过的全部发），幂等（记录在 s.__tutorialGranted）。
function grantTutorialSavepoints(s, upToType) {
  const rows = ((loadTable("Tutorial/TutorialSavePoint.csv") || {}).rows) || [];
  if (!s.__tutorialGranted) s.__tutorialGranted = [];
  const done = new Set(s.__tutorialGranted.map(function (x) { return Number(x); }));
  const ensureChar = function (cid, level, exp) {
    if (!cid || findCharacter(cid)) return false;
    const sup = isSupportCharacter(cid);
    const inst = allocInstanceId(s, "character");
    const ch = createCharacter(inst, s.UserData.id, cid, { support: sup, isNew: true, level: level || 1 });
    if (exp) { ch.exp = exp; }
    (sup ? s.CharacterList.supportCharacterList : s.CharacterList.mainCharacterList).push(ch);
    touchCharacter(cid);
    return true;
  };
  let chars = 0, rewardRows = 0;
  const bySp = {};
  for (const r of rows) {
    if (String(r.Flag) === "False") continue;
    const spName = String(r.SavePointName || "");
    const spNo = Number((spName.match(/SAVEPOINT_(\d+)/) || [])[1] || 0);
    if (!spNo || spNo > Number(upToType)) continue;
    if (done.has(spNo)) continue;
    const id = String(r.RewardItemId || "");
    if (!id) continue;
    if (Number(r.SheetType) === 2) {
      if (ensureChar(id, Number(r.Level) || 1, Number(r.Exp) || 0)) chars++;
      continue;
    }
    (bySp[spNo] = bySp[spNo] || []).push({ sheet_type: Number(r.SheetType) || 1, master_id: id, amount: Number(r.Count) || 1 });
    rewardRows++;
  }
  for (const k of Object.keys(bySp)) { applyRewards(bySp[k]); done.add(Number(k)); }
  // 角色段落没有奖励数组 ⇒ 单独记已发
  for (const r of rows) {
    const spNo = Number((String(r.SavePointName || "").match(/SAVEPOINT_(\d+)/) || [])[1] || 0);
    if (spNo && spNo <= Number(upToType) && Number(r.SheetType) === 2) done.add(spNo);
  }
  s.__tutorialGranted = Array.from(done).sort(function (a, b) { return a - b; });
  if (chars || rewardRows) {
    markDirty();
    console.log("[tutorial] savepoints ≤" + upToType + " 发放：角色 +" + chars + " / 奖励行 " + rewardRows + " / 已发集合 " + JSON.stringify(s.__tutorialGranted));
  }
  return { chars: chars, rows: rewardRows };
}
// ★ 教程期间保证玩家【至少有一个支援角色】—— 否则「リンク（选支援）」那一步无人可选。
//   权威依据：`Tutorial/TutorialSavePoint.csv` 的 `SAVEPOINT_4` → Ch004900204 ミカエル（Lv2/Exp10，支援）。
//   ★ 但客户端不保证会请求 type=4（实测它只请求过 type=2 就进到 link 步骤）⇒ 不能只靠「按请求的 savepoint 发」，
//     必须在【进入教程后】就确保这只支援到手。幂等：已有任何支援角色就什么都不做。
function ensureTutorialSupport(s) {
  if (!s.TutorialProgress || Number(s.TutorialProgress.Stage || 0) >= 100) return false;
  const sups = (s.CharacterList || {}).supportCharacterList || [];
  if (sups.length > 0) return false;
  const g = grantTutorialSavepoints(s, 4);   // 幂等，只会发 SAVEPOINT_4 那一条（含 ミカエル）
  const after = ((s.CharacterList || {}).supportCharacterList || []).length;
  console.log("[tutorial] 补发教程支援角色：chars +" + g.chars + "，当前支援 " + after);
  return after > 0;
}
route("tutorial/progress", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★ 必须写【真字段 TutorialProgress】，不能写私有的 __tutorial ——
  //   客户端 TutorialUseCase.GetProgress() 读的是 user/load_user_data 的 TutorialProgress，
  //   写 __tutorial 会导致「教程推进不生效」：GetProgress() 永远返回旧 Stage。
  //   （实测复现：调 tutorial/progress(type=5) 后 load_user_data 仍是 Stage=100）
  if (!s.TutorialProgress) s.TutorialProgress = { Stage: 0, TutorialEndTime: 0 };
  const t = Number(req.tutorialProgressType);
  // 推进阶段（-1 表示无变化）
  // Stage 取 max（教程只前进不后退）。上界用 Done=100 ——
  // TutorialProgressType 枚举：None=0 … Savepoint16=16, Done=100。
  if (isFinite(t) && t >= 0) {
    s.TutorialProgress.Stage = Math.max(s.TutorialProgress.Stage || 0, Math.min(t, 100));
    s.TutorialProgress.TutorialEndTime = Math.floor(Date.now() / 1000);
    // ★ 发放本 savepoint 的奖励（含更早未发的），幂等 —— 真机语义见 grantTutorialSavepoints 注释
    try { grantTutorialSavepoints(s, t); } catch (e) { console.error("[tutorial] 发放失败: " + e.message); }
    if (Number(s.TutorialProgress.Stage) >= 100) { try { applyTutorialEndState(); } catch (e) { console.error("[tutorial] endState " + e.message); } }
    try { ensureTutorialSupport(s); } catch (e) { console.error("[tutorial] support " + e.message); }
  }
  markDirty();
  console.log("[tutorial] progress type=" + req.tutorialProgressType + " stage=" + s.TutorialProgress.Stage);
  // ★ 真机实测（15 次）：player_all_asset 是【多态的】——
  //   本次无发放 → **ARRAY[0]（空数组）**（13 次）
  //   本次有发放 → **object**（2 次：type=4 发支援角色 Ch004900204；type=15 发 44 装备 + 48 道具）
  //   即：类型由「本次是否产生变更」决定，不是固定类型。
  //   早期我恒返回 object（touchedPlayerAllAsset() 在无变更时是 {} ，仍被 okShaped 补成对象）。
  // ★ 修正：判据必须看【全部实体】（角色/装备/护符/道具），不能只看道具 ——
  //   真机 type=4 是「发支援角色 Ch004900204」→ player_all_asset 为【对象】；
  //   只看道具会误判成「无变更」而回空数组。
  const touched = touchedPlayerAssets();
  // ★ 判据必须是「有【实质内容】」而不是「有键」——
  //   touchedPlayerAllAsset() 在无变更时返回 {AllItemList: []}（有一个键但数组为空），
  //   早期用 Object.keys().length > 0 判断 → 恒为 true → 永远走 object 分支，
  //   与真机「无发放时是 ARRAY[0]」不符。
  const hasChange = !!(touched && Object.keys(touched).some(function (k) {
    const v = touched[k];
    return Array.isArray(v) ? v.length > 0 : (v && typeof v === "object" ? Object.keys(v).length > 0 : v != null);
  }));
  return okShaped(ctx.path, {
    TutorialProgress: s.TutorialProgress,
    // ★ 只回【非空类别】：真机 type=15 的 player_all_asset 只有 EquipmentList + AllItemList 两个键；
    //   我把 MainCharacter/SupportCharacter/... 的空数组也塞进去 ⇒ 键集与真机不符（2026-10-18 修正）。
    player_all_asset: hasChange ? (function () {
      const out = {};
      for (const k of Object.keys(touched)) {
        const v = touched[k];
        if (Array.isArray(v) && v.length) out[k] = v;
      }
      return out;
    })() : [],
  });
});

// ---- tutorial/skip ----
// SkipTutorialApi：响应含 userData / TutorialProgress / 初始角色等，标记教程已完成。
route("tutorial/skip", function (ctx) {
  const s = getState();
  if (!s.TutorialProgress) s.TutorialProgress = { Stage: 0, TutorialEndTime: 0 };
  const now = Math.floor(Date.now() / 1000);
  const wasDone = Number(s.TutorialProgress.Stage) >= 100 || s.__tutorialSkipped === true;

  // ★★★ 2026-10-18 补全：跳过教程必须【真正发放】教程奖励，否则跳过 = 少拿东西 ★★★
  //   权威数据源 Tutorial/TutorialSavePoint.csv（字段 Flag|SavePointName|SheetType|RewardItemId|Count|Level|Exp）：
  //     · SAVEPOINT_4  1 行  → SheetType=2 角色 Ch004900204 ミカエル（Lv2 / Exp10）
  //     · SAVEPOINT_15 98 行 → SheetType=1（货币 6 / 石头 11 / 装备 28 / 其它道具 53）
  //   全部 Flag=True ⇒ 跳过时把整份教程奖励一次发放（与「逐段打教程」到终点的结果一致）。
  //   ★ 之前只把 Stage 推到 100 就返回三个角色对象（且不入库）⇒ 跳过过的档缺 ミカエル + 98 件奖励。
  //   ★ 幂等：客户端可能重试该端点；用 __tutorialSkipped 保证只发一次。
  let grantedChars = 0, grantedRows = 0, grantedItems = 0;
  if (!wasDone) {
    // 确保角色存在（支援角色走 supportCharacterList，字段名与主角色不同）
    const ensureChar = function (cid, level, exp) {
      if (!cid || findCharacter(cid)) return false;
      const sup = isSupportCharacter(cid);
      const inst = allocInstanceId(s, "character");
      const ch = createCharacter(inst, s.UserData.id, cid, { support: sup, isNew: true, level: level || 1 });
      if (exp) { ch.exp = exp; }
      (sup ? s.CharacterList.supportCharacterList : s.CharacterList.mainCharacterList).push(ch);
      touchCharacter(cid);
      return true;
    };
    // ① 新号自带的三只：アレン / ジャンヌ（缺则补，通常在 load_user_data 里已下发）
    if (ensureChar("Ch000100101", 1, 0)) grantedChars++;
    if (ensureChar("Ch000200102", 1, 0)) grantedChars++;

    // ★ 复用公共发放（全部 savepoint）
    const g = grantTutorialSavepoints(s, 999);
    grantedChars += g.chars; grantedRows = g.rows; grantedItems = g.rows;
    s.TutorialProgress.Stage = 100;            // Done（枚举上界就是 100，9999 不是合法值）
    // ★ 教程结束统一状态（GroundRule: AfterSkipUserRank=3 / AfterSkipUserStamina=280）
    try { applyTutorialEndState(); } catch (e) { console.error("[tutorial] endState " + e.message); }
    s.TutorialProgress.TutorialEndTime = now;
    s.__tutorialSkipped = true;
    markDirty();
    console.log("[tutorial] skip → 发放教程奖励：角色 +" + grantedChars + " / 奖励行 " + grantedRows + "（实际入包 " + grantedItems + "）");
  } else {
    s.TutorialProgress.Stage = 100;
    if (!Number(s.TutorialProgress.TutorialEndTime)) s.TutorialProgress.TutorialEndTime = now;
    console.log("[tutorial] skip 重复调用 → 已发放过，只回执不重复发");
  }

  // 客户端 SkipTutorialApi.PostRequest 消费 7 个字段（反编译实证）：
  //   TutorialProgress / userData / player_all_asset / aren / jeanne / michael / clearedQuest
  const _aren = findCharacter("Ch000100101");
  const _jeanne = findCharacter("Ch000200102");
  const _michael = findCharacter("Ch004900204");
  return okShaped(ctx.path, {
    userData: s.UserData,
    TutorialProgress: s.TutorialProgress,
    player_all_asset: touchedPlayerAssets(),
    aren: _aren || null,
    jeanne: _jeanne || null,
    michael: _michael || null,
    // 教程任务没有独立主数据表（全库搜 TutorialProgressType 零命中）⇒ 跳过时清掉的清单给空数组（客户端容忍）
    clearedQuest: [],
  });
});

route("story/confirm", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.UserCharacterStoryList) s.UserCharacterStoryList = [];
  const ids = Array.isArray(req.MasterStoryIdList) ? req.MasterStoryIdList : [];
  const out = [];
  for (const sid of ids) {
    // ★★★ 只接受 StoryList.csv 里存在的「角色剧情」id（2026-10-16）★★★
    //   客户端在本端点会传主线剧情 id（`sc_main271_1` 这种 scenario 资源名），
    //   它们不在 StoryList.csv → 客户端查表得 null → 刷 UserCharacterStoryList 时
    //   `Dictionary.set_Item(null,…)` 抛 ArgumentNullException。
    if (!isCharacterStoryId(sid)) {
      console.log("[story] skip non-character story id: " + String(sid));
      continue;
    }
    let e = s.UserCharacterStoryList.find(function (x) { return x.StoryId === sid; });
    if (!e) {
      e = { Id: allocInstanceId(s, "story"), PlayerAccountId: s.UserData.id, MasterCharacterId: req.MasterCharacterId || "", StoryId: sid, IsRead: false, IsConfirmed: false };
      s.UserCharacterStoryList.push(e);
    }
    e.IsConfirmed = true;
  }
  markDirty();
  // 契约语义：返回该角色的【全部】剧情记录（不是仅本次的）——
  // 客户端据此刷新角色剧情列表。早期只返回本次条目，导致再次调用时列表为空。
  const cid = req.MasterCharacterId || "";
  const all = cid
    ? s.UserCharacterStoryList.filter(function (x) { return x.MasterCharacterId === cid; })
    : s.UserCharacterStoryList.slice();
  console.log("[story] confirm " + ids.length + " new, return " + all.length + " total of " + (cid || "?"));
  return okShaped(ctx.path, { UserCharacterStoryList: all });
});

// ---- privacy_policy/get_version ----
// 响应 { PrivacyPolicyVersion, TermsVersion, GameCurrencyVersion }（字符串）
route("privacy_policy/get_version", function (ctx) {
  return okShaped(ctx.path, { PrivacyPolicyVersion: "1.0.0", TermsVersion: "1.0.0", GameCurrencyVersion: "1.0.0" });
});

// ---- contents_release/read ----
// 响应 { contents_release_read_list: Int32[] }
route("contents_release/read", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 2026-10-17 修正：原来读写的是私有数组 `s.__contentsRelease` ★★★
  //   而客户端 `ContentsReleaseReadApi.PostRequest` 会拿响应的
  //   `contents_release_read_list` 去【整份替换】UserAssetContentsReleaseDataStore 的列表
  //   ⇒ 我返回 [700] 就把 load_user_data 给的 32 项（含 600 公会 / 800 / 900 …）全抹掉
  //   ⇒ 其它内容全变回「未解放」⇒ IsContentRelease / 各类解放判定全部失真。
  //   修法：并入【权威字段】s.contents_release_read_list，并返回完整列表。
  if (!Array.isArray(s.contents_release_read_list)) s.contents_release_read_list = [];
  // 请求字段：契约里是 content_id（可能是数组），兼容单值写法
  let ids = req.content_id !== undefined ? req.content_id
          : (req.contents_release_id !== undefined ? req.contents_release_id : null);
  if (ids === null) ids = [];
  if (!Array.isArray(ids)) ids = [ids];
  let changed = 0;
  for (const raw of ids) {
    const id = Number(raw);
    if (!isFinite(id) || id <= 0) continue;
    if (s.contents_release_read_list.indexOf(id) < 0) { s.contents_release_read_list.push(id); changed++; }
  }
  if (changed) { markDirty(); console.log("[contents_release] read -> +" + changed + "，当前 " + s.contents_release_read_list.length + " 项"); }
  return okShaped(ctx.path, { contents_release_read_list: s.contents_release_read_list });
});

// ---- contents_release_tutorial/read ----
// 参数 { tutorial_id }，客户端无强类型响应结构 → 返回空对象
route("contents_release_tutorial/read", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 2026-10-18 真根因修复：必须写【契约字段】s.contents_release_tutorial ★★★
  //   真机契约（contracts_winr_newaccount/user_load_user_data）该字段是：
  //     [{"tutorial_id":"Battle_Chapter01","is_read":true}, {"tutorial_id":"Battle_Chapter02",...}, ...]
  //   而原实现写的是自造字段 s.__contentsReleaseTutorial（__ 前缀会被响应出口剥掉、永不下发）
  //   ⇒ 客户端永远认为战斗教程「没看过」⇒ **每场战斗都重放教程命令列表**
  //   ⇒ 卡在 "等战斗回合" 命令（战斗结束后 manager 为 null）⇒ 教程遮罩挡住结果画面的 NEXT。
  //   （与 2026-10-17 修的 tutorial/progress 写 s.__tutorial 是同一类错误：写错字段名。）
  if (!Array.isArray(s.contents_release_tutorial)) s.contents_release_tutorial = [];
  const tid = req.tutorial_id || req.tutorialId;
  if (tid) {
    const hit = s.contents_release_tutorial.find(function (x) { return x && x.tutorial_id === tid; });
    if (hit) { if (!hit.is_read) { hit.is_read = true; markDirty(); } }
    else { s.contents_release_tutorial.push({ tutorial_id: tid, is_read: true }); markDirty(); }
  }
  // 历史脏数据迁移：把之前写进 __contentsReleaseTutorial 的条目补进契约字段
  if (Array.isArray(s.__contentsReleaseTutorial) && s.__contentsReleaseTutorial.length) {
    for (const t of s.__contentsReleaseTutorial) if (t && !s.contents_release_tutorial.some(function (x) { return x && x.tutorial_id === t; })) s.contents_release_tutorial.push({ tutorial_id: t, is_read: true });
    delete s.__contentsReleaseTutorial; markDirty();
  }
  console.log("[contents] tutorial read " + tid + " -> 已读 " + s.contents_release_tutorial.length + " 条");
  return okShaped(ctx.path, {});
});

// ==================== 任务奖励（限定/累计）/ 体力 / 改名 ====================

// ---- mission/receive_limited_reward ----
// 参数 { limited_mission_type, mission_group_id, mission_id_list }
// 响应 { item_format_list, present_item_format_list, player_all_asset, MissionProgressList, ... }
route("mission/receive_limited_reward", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 2026-10-22 重写 ★★★
  // 真机请求（20:09:21 实测）：
  //   {"limited_mission_type":2,"mission_group_id":"StartdashMission_01","mission_id_list":["StartdashMission_01_001"]}
  // 限定任务在 limited_mission_progress_list（字段 mission_id / is_achieved / is_received），
  // 与普通任务（MissionProgressList / MissionId / IsAchieved / IsReceived）是两套结构 ——
  // 旧实现用普通任务那套去查 ⇒ 恒 not_found ⇒ 既不发奖也不标记已领取。
  const type = Number(req.limited_mission_type) || 0;
  const groupId = String(req.mission_group_id || "");
  const ids = Array.isArray(req.mission_id_list) ? req.mission_id_list : [];
  const nowMs = Date.now();
  const eligible = [];
  const skipped = [];
  for (const id of ids) {
    const m = findLimitedMission(id, groupId, type);
    const chk = canReceiveLimitedMission(m, nowMs);
    if (!chk.ok) { skipped.push(id + ":" + chk.reason); continue; }
    eligible.push(m);
  }
  // 奖励：按 Mission/LimitedMissionContent.csv 的 RewardId 逐个结算
  const list = [];
  for (const m of eligible) {
    const rid = limitedMissionRewardId(m.mission_id);
    if (!rid) { skipped.push(m.mission_id + ":no_reward_id"); continue; }
    try { for (const x of resolveRewardId(rid)) list.push(x); } catch (e) { skipped.push(m.mission_id + ":reward_err"); }
  }
  const applied = list.length ? applyRewards(list) : [];
  for (const m of eligible) { m.is_received = true; }
  markDirty();
  console.log("[mission] receive_limited type=" + type + " group=" + groupId + " 请求 " + ids.length +
    " → 领取 " + eligible.length + (skipped.length ? "，跳过 [" + skipped.join(",") + "]" : ""));
  return okShaped(ctx.path, {
    item_format_list: toItemFormatList(applied),
    present_item_format_list: [],
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: [],
    // ★ 增量语义：只回本次变化的限定任务（客户端 AddOrUpdate 即可把 is_received 标上）
    limited_mission_progress_list: eligible,
    userData: s.UserData,
    notification: [],
  });
});

// ---- mission/receive_total_reward ----
// 参数 { mission_type, total_reward_id_list }
route("mission/receive_total_reward", function (ctx) {
  const req = parse(ctx.body);
  // ★★★ 补 getState（2026-10-17）：我在响应里加了 `userData: s.UserData` 却没声明 `s`
  //   → ReferenceError → alterCode 9999。与本轮 enhance_bulk / fragment_exchange 同型。
  const s = getState();
  const ids = Array.isArray(req.total_reward_id_list) ? req.total_reward_id_list : [];
  // ★★★ 2026-10-22：初心者ミッション的「累计奖励」（左侧 達成数 5/10/15/20/30 那一列）★★★
  //   权威数据：Mission/BeginnerMissionTotalReward.csv（BeginnerMissionTotalRewardId → ClearCount + RewardIdList）。
  //   旧实现把这些 id 当成【任务 id】丢进 rewardsForMissions → rewardIdForMission 查不到 → 一件都不发。
  //   正确语义：达成数 ≥ ClearCount 才可领；领过记在 mission_total_reward_list 里。
  const achievement = beginnerMissionAchievedCount();
  const rows = beginnerMissionTotalRewardRows();
  const byId = new Map(rows.map(function (r) { return [r.id, r]; }));
  const already = new Map((refreshBeginnerTotalRewardState() || []).map(function (x) {
    return [String(x.beginner_mission_total_reward_id || ""), !!x.is_received];
  }));
  const eligible = [];
  const skipped = [];
  for (const id of ids) {
    const row = byId.get(String(id));
    if (!row) { skipped.push(id + ":unknown"); continue; }
    if (already.get(String(id))) { skipped.push(id + ":already_received"); continue; }
    if (achievement < row.clearCount) { skipped.push(id + ":not_achieved(" + achievement + "/" + row.clearCount + ")"); continue; }
    eligible.push(row);
  }
  const list = [];
  for (const row of eligible) {
    try { for (const x of resolveRewardId(row.rewardId)) list.push(x); }
    catch (e) { skipped.push(row.id + ":reward_err"); }
  }
  const applied = list.length ? applyRewards(list) : [];
  if (applied.length) {
    const cur = (s.mission_total_reward_list || []);
    for (const row of eligible) {
      const hit = cur.find(function (x) { return String(x.beginner_mission_total_reward_id) === String(row.id); });
      if (hit) hit.is_received = true;
      else cur.push({ beginner_mission_total_reward_id: row.id, is_received: true });
    }
    s.mission_total_reward_list = cur;
  }
  markDirty();
  console.log("[mission] receive_total 请求 " + ids.length + " → 领取 " + eligible.length +
    (skipped.length ? "，跳过 [" + skipped.join(",") + "]" : "") + "（达成数 " + achievement + "）");
  return okShaped(ctx.path, {
    item_format_list: toItemFormatList(applied),
    present_item_format_list: [],
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: [],
    limited_mission_progress_list: [],
    mission_total_reward_list: refreshBeginnerTotalRewardState(),
    userData: s.UserData,
  });
});

// ---- user/recover_stamina ----
// 参数 { RecoveryItemType: "Gem"|"Item"|"ItemLow", recover_count }
// 响应 { userData, PayGemAmount, NoPayGemAmount, ItemMasterId, ItemAmount }
// ---------- 体力恢复的三个权威取值（2026-10-15）----------

/**
 * 道具的体力恢复量 —— 从 ItemList.csv 的 Description 里解析。
 *
 * 为什么从 Description 解析而不是找专门的列：
 *   ItemList.csv 的列只有 12 个（Version/ItemCategory/.../StackMax），**没有恢复量列**；
 *   而 Description 里明文写着「スタミナを10回復する」/「スタミナを50回復する」，
 *   与游戏截图（+10 / +50）逐字吻合 ⇒ 这是权威来源。
 * ★ 兜底：解析失败时按已知值（R=10 / SR=50），并打日志暴露（不静默）。
 */
function itemRecoverValue(itemId) {
  const FALLBACK = { Item_Tool_Stamina_R: 10, Item_Tool_Stamina_SR: 50 };
  try {
    const t = loadTable("Item/ItemList.csv");
    const r = (t.rows || []).find(function (x) { return x.ItemId === itemId; });
    const desc = r ? String(r.Description || "") : "";
    const m = desc.match(/スタミナを\s*(\d+)\s*回復/);
    if (m) return Number(m[1]);
  } catch (e) { /* 落到兜底 */ }
  const v = FALLBACK[itemId];
  if (v === undefined) console.log("[stamina] ★ 未知恢复道具 " + itemId + "，按 0 处理");
  return v === undefined ? 0 : v;
}

/**
 * 魔宝石恢复的【单次恢复量】—— GroundRule/StoneRecovery.csv 的 Value。
 * 表实证：当前版本所有 UseCount 行的 Value 都是 120（截图「魔宝石 +120」✅）。
 */
function stoneRecoveryValue() {
  try {
    const t = loadTable("GroundRule/StoneRecovery.csv");
    const r = (t.rows || [])[0];
    if (r && Number(r.Value) > 0) return Number(r.Value);
  } catch (e) { /* 落到兜底 */ }
  console.log("[stamina] ★ StoneRecovery.csv 读取失败，按 120 兜底");
  return 120;
}

/**
 * 魔宝石恢复【count 次】总共消耗多少石头。
 * 表结构：Item（形如 "Item:Item_Stone_Freex90"）/ UseCount / Value。
 *   第 N 次恢复用第 N 行的 Item 数量（UseCount 递增 → 消耗递增：90/90/120/120/200/200/300...）。
 * 从 Item 字符串解析「xNNN」后的数字即消耗量。
 */
function stoneRecoveryCost(state, count) {
  let rows = [];
  try {
    const t = loadTable("GroundRule/StoneRecovery.csv");
    rows = (t.rows || []).slice().sort(function (a, b) { return Number(a.UseCount) - Number(b.UseCount); });
  } catch (e) { rows = []; }
  // ★★★ 用【权威字段】决定从第几行开始（2026-10-15 修正）★★★
  //
  // 此前我用自造的 `state.__gemRecoverCount` —— 而真机契约的 UserData 里
  // **本来就有这个字段**：`recoverGemDailyCount`（真机新账号 = 0）。
  // 客户端侧的对应成员是 `UserProfileModel.staminaRecoverGemDailyCount`
  //   （反编译实证：Assembly-CSharp__101.cpp:21736 读、21866 写）。
  //
  // ★ 语义：**每日**已用宝石恢复次数（UI 上显示「あと10回」）。
  //   StoneRecovery.csv 的 10 行 UseCount 就是这 10 次的消耗表：
  //     第 1~2 次 90 石 / 第 3~4 次 120 石 / 第 5~6 次 200 石 / 第 7~10 次 300 石
  //   ⇒ 用自造键有两个后果：① 契约/客户端读不到（不同步）② 永不跨日重置。
  let used = Number((state.UserData && state.UserData.recoverGemDailyCount) || 0);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const row = rows[Math.min(used + i, rows.length - 1)] || null;
    let cost = 90;   // 兜底（表第 1 行 = 90）
    if (row) {
      const m = String(row.Item || "").match(/x\s*(\d+)\s*$/);
      if (m) cost = Number(m[1]);
    }
    total += cost;
  }
  // 写回权威字段（客户端会读它显示「あとN回」）
  if (!state.UserData) state.UserData = {};
  state.UserData.recoverGemDailyCount = Math.min(used + count, rows.length || 10);
  return total;
}
route("user/recover_stamina", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 体力恢复的真实语义（2026-10-15 重写）★★★
  //
  // 用户报障（截图）：「吃50回体力结果一次回了几百」
  //   截图显示：ヒールバイアル +10 / ヒールボトル +50 / 魔宝石 +120，
  //   而购买「ヒールボトル」(recover_count=1) 后体力从 ~120 涨到 620（涨了几百）。
  //
  // 根因：我写死 `const PER = 240;`（= 体力上限）→ 每次都回 240×count。
  //
  // 权威数据源（三条，全部实证）：
  //   ① 道具恢复量在 **ItemList.csv 的 Description 明文**里：
  //        Item_Tool_Stamina_R  (ヒールバイアル) → 「スタミナを**10**回復する」
  //        Item_Tool_Stamina_SR (ヒールボトル)   → 「スタミナを**50**回復する」
  //      （与截图 +10 / +50 逐字吻合）
  //   ② 宝石恢复在 **GroundRule/StoneRecovery.csv**：
  //        字段 Item / UseCount / Value
  //        第 1 次恢复 = Item_Stone_Free×90，Value=**120**（截图 +120 ✅）
  //        UseCount 递增时消耗的石头数也递增（90/90/120/120/200/200/300...）
  //   ③ 体力上限 = **GroundRule.StaminaMax = 2000**（不是 240！240 是自然回复封顶）
  //
  // 请求字段（客户端类 RecoverStaminaApi 实证）：
  //   {"RecoveryItemType":"Item"|"ItemLow"|"Gem","recover_count":N}
  //   ★ 注意 RecoveryItemType 的值是 **"Item"/"ItemLow"/"Gem"**（不是 Item_Tool_* 全名）
  const by = String(req.RecoveryItemType || "Gem");
  const count = Math.max(1, Number(req.recover_count) || 1);

  // ---------- 恢复量与消耗 ----------
  let per = 0, payGem = 0, itemId = "", itemAmount = 0;
  if (by === "Gem") {
    // 宝石：恢复量取 StoneRecovery.csv 的 Value（当前版本恒 120）；
    //   消耗的石头数按该表的 UseCount 行（第 N 次用第 N 行的 Item 数量）。
    //   ★ 每日次数上限 = GroundRule.StaminaRecoverGemDailyCount（若配）
    per = stoneRecoveryValue();
    payGem = stoneRecoveryCost(s, count);
    addStone(-payGem, 0);
  } else {
    // 道具：ItemLow = ヒールバイアル(+10) / Item = ヒールボトル(+50)
    itemId = by === "ItemLow" ? "Item_Tool_Stamina_R" : "Item_Tool_Stamina_SR";
    per = itemRecoverValue(itemId);
    itemAmount = count;
    addItem(itemId, -itemAmount);
  }
  const gain = per * count;
  addStamina(gain);
  // ★★★ `ItemAmount` 的语义 = 【使用后的剩余持有量】，不是使用数量 ★★★
  //   真机契约实证：请求 `{"RecoveryItemType":"Item","recover_count":10}`，
  //   响应 `ItemMasterId:"Item_Tool_Stamina_SR"` + `ItemAmount:1447`，
  //   而真机 AllItemList 里该道具恰好 = 1447 ⇒ **ItemAmount 等于持有量**。
  //   ★ 我此前返回 `count`（使用数量）→ 客户端把「10」当成新的持有量 →
  //     **界面永远显示 10，怎么吃都吃不完**（用户报障的直接原因）。
  const afterUse = itemId ? currentItemCount(s, itemId) : 0;
  markDirty();
  console.log("[stamina] recover by=" + by + " x" + count + " -> +" + gain +
    " (单次 " + per + (payGem ? ", 耗石 " + payGem : ", 耗道具 " + itemId + "，剩余 " + afterUse) + ")");
  // ★ 响应键集：userData / ItemMasterId / ItemAmount / PayGemAmount / NoPayGemAmount
  //   （最后两个是【宝石余额】，用宝石回体力时客户端必须靠它们刷新数字）
  return okShaped(ctx.path, {
    userData: s.UserData,
    ItemMasterId: itemId,
    ItemAmount: afterUse !== undefined ? afterUse : itemAmount,
    // ★★★ 2026-10-21：宝石余额必须用 PayGemAmount / NoPayGemAmount 回传 ★★★
    //   反编译实证（RecoverStaminaApi.UpdateDataStoreFromApiResult）：
    //     var r = Parse<Response>(text).result;
    //     profile.UpdateUserData(r.userData);
    //     if (recoverBy == Gem) {
    //        itemStore.AddOrUpdate({ id: GetStoneId(0), amount: r.PayGemAmount    });  // 有償
    //        itemStore.AddOrUpdate({ id: GetStoneId(1), amount: r.NoPayGemAmount });  // 無償
    //     }
    //   ⇒ 这两个字段是【更新后的余额】，不是消耗量。
    //   ★ 之前代码里「真机契约没有 PayGemAmount / NoPayGemAmount」的注释是【错的】：
    //     那次录制是 RecoveryItemType="Item"（用道具回体力），走的是另一个分支，
    //     所以响应里没有宝石字段；用【宝石】回体力时必须带，缺了客户端会把余额写成默认 0
    //     （用户报障「用钻石回体力，钻石被清零」——根因就在这）。
    PayGemAmount: s.paidStoneBalance || 0,
    NoPayGemAmount: s.freeStoneBalance || 0,
  });
});
route("user/change_player_name", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 2026-10-21：字段名修正 ★★★
  //   真机契约（_fwd/run-2026-09-29-01-57-02 #236）：
  //     请求 {"alterName":"九1"} → 响应 {"result":{"alterName":"九1"}}
  //   我们原来读 req.player_name / req.name —— 两个都不存在 ⇒ name 恒为空 ⇒ 改名永远不生效。
  const name = req.alterName || req.player_name || req.name || "";
  if (name) { s.UserData.name = name; markDirty(); flushNow(); }   // 改名立即落盘
  console.log("[user] change_player_name -> " + name);
  return okShaped(ctx.path, { alterName: s.UserData.name });
});

// ---- baggage/lock_item ----
// 响应 { item_list: TemporaryItemDetail[] }
route("baggage/lock_item", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ids = Array.isArray(req.item_user_id_list) ? req.item_user_id_list
            : (Array.isArray(req.itemUserIdList) ? req.itemUserIdList : []);
  const locked = req.is_lock !== undefined ? !!req.is_lock : true;
  const all = (s.ItemList && s.ItemList.AllItemList) || [];
  const out = [];
  for (const id of ids) {
    const it = all.find(function (x) { return String(x.id) === String(id) || String(x.master_item_id) === String(id); });
    if (it) { it.has_locked = locked; out.push({ item_user_id: id, is_lock: locked }); }
    else out.push({ item_user_id: id, is_lock: locked });
  }
  markDirty();
  console.log("[baggage] lock_item " + ids.length + " -> " + locked);
  return okShaped(ctx.path, { item_list: out });
});

// ---- baggage/enhance_equipment_bulk ----
// 响应 { main_character, target_equipment, items, removed_equipment_user_id_list }
route("baggage/enhance_equipment_bulk", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const list = (s.ItemList.EquipmentList || []);
  // ★★★ 字段名必须是【snake_case】（2026-10-14 修复「最大强化无效」）★★★
  //
  // 用户报障：「最大强化无效，没反应，材料不扣，装备也不增长。」
  //   根因：真机请求字段是 snake_case，我读的是 camelCase：
  //     真机: {"target_equipment_user_id":..., "enhance_item_list":[{"master_id":...,"amount":...}],
  //            "breaklimit_equipment_user_id_list":[], "breaklimit_alternative_material_id_list":[...]}
  //     我读: req.targetEquipmentUserId / req.enhanceEquipmentUserIdList   ← 恒取不到
  //   ⇒ target 回退到 list[0]、fodder 恒空 → gained=0、无任何变化。
  //
  // ★ 语义（真机契约实证）：这是「最大强化」按钮——
  //   ① 用 enhance_item_list 的**经验素材**把装备推到尽可能高等级
  //   ② 用 breaklimit_alternative_material_id_list 的**突破材料**做多次限界突破
  //      （列表里几项 = 突破几次；每项是一种材料 id）
  //   契约样本：3 项 Limitbreak_All_SSR → brk 推到 5（MaxBreakLimitCount=5）
  //   响应 items.AllItemList = 本次消耗的**经验素材 + 突破材料**的持有量。
  const targetId = req.target_equipment_user_id !== undefined ? req.target_equipment_user_id : req.targetEquipmentUserId;
  let target = list.find(function (e) { return String(e.Id) === String(targetId); });
  if (!target) target = list[0];

  // ★★★ 2026-10-21：满级 + 无突破材料 ⇒ 直接不动（避免白吃材料）★★★
  //   用户报障：装备 Lv10/10（当前突破档上限），请求里 breaklimit_* 两个列表都是空，
  //   客户端仍允许点「最大强化」并发来经验素材 → 服务端照单全收、等级不涨、材料白扣。
  //   正确语义：等级已达当前档上限且本次没有任何突破材料 ⇒ 本次最大强化无意义，原样返回。
  {
    const _lv = Number(target.CurrentLevel) || 1;
    const _maxLv = Number(target.MaxLevel) || 10;
    const _alt = (req.breaklimit_alternative_material_id_list || []).filter(Boolean);
    const _fod = (req.breaklimit_equipment_user_id_list || []).filter(Boolean);
    if (_lv >= _maxLv && _alt.length === 0 && _fod.length === 0) {
      console.log("[baggage] enhance_equipment_bulk 跳过：Lv" + _lv + "/" + _maxLv + " 已满级且无突破材料（不消耗任何素材）");
      return okShaped(ctx.path, {
        ...ownerCharacterFields(target && target.OwnerCharacterId),
        player_all_asset: touchedPlayerAssets(),
        items: { AllItemList: [] },
        targetEquipment: target,
        removedEquipmentUserId: 0,
        preset_list: s.preset_list || [],
        MissionProgressList: [],
        limited_mission_progress_list: [],
      });
    }
  }
  const usedIds = [];
  // ---- ① 经验素材 ----
  let gained = 0;
  let goldCost = 0;
  {
    const _g = (s.ItemList.AllItemList.find(function (x) { return x.master_item_id === "Item_Currency_Gold"; }) || {});
    var goldLeft = Number(_g.amount) || 0;
  }
  const expList = req.enhance_item_list || req.enhanceItemSettingList || [];
  for (const it of expList) {
    const id = it.master_id || it.itemMasterId || it.itemId || it.item_id;
    const amt = Number(it.amount !== undefined ? it.amount : (it.itemCount !== undefined ? it.itemCount : it.requestCount)) || 0;
    if (!id || amt <= 0) continue;
    // ★★★ 实际用量受持有量限制（2026-10-17）★★★ 原实现直接 addItem(-amt) → 不足时白嫖
    const _have = (s.ItemList.AllItemList.find(function (x) { return x.master_item_id === id; }) || {}).amount || 0;
    // ★ 2026-10-22：还受金币限制（GoldCost = 20 金币/exp）
    const _unitGold = goldCostForItem(id);
    const _byGold = _unitGold > 0 ? Math.floor(goldLeft / _unitGold) : Infinity;
    const _use = Math.min(_have, amt, _byGold);
    if (_use <= 0) { if (_unitGold > 0 && _have > 0) console.log("[baggage] 最大强化金币不足: " + id + " 单价 " + _unitGold + " 余额 " + goldLeft); continue; }
    addItem(id, -_use);
    usedIds.push(id);
    if (_unitGold > 0) { goldCost += _unitGold * _use; goldLeft -= _unitGold * _use; }
    gained += equipmentExpForItem(id) * _use;
  }
  if (goldCost > 0) { addItem("Item_Currency_Gold", -goldCost); usedIds.push("Item_Currency_Gold"); }
  // ★★★ 顺序修正（2026-10-16 用户报障「最大强化只突破不加经验」）★★★
  //
  // 症状：装备 200000369 变成 `Lv 20/50、exp 4940/4940、break_limit 5/5` ——
  //   **突破到顶了，经验也加满了，但等级停在 20**。
  // 根因：我原来的顺序是【先加经验、后突破】——
  //   加经验时 `MaxLevel` 还是 20，超出的 35710 点经验被上限吃掉；
  //   随后突破把 MaxLevel 抬到 50，但经验已经消耗完 ⇒ 等级回不去。
  // ★ 真机语义（截图 1 的预览 `Lv 20 → 50` 即为证据）：
  //   「最大强化」= ① 先用突破材料把**上限抬到最高** ② 再用经验素材把**等级推到上限**。
  //   ⇒ 必须【先突破、后加经验】。

  // ---- ① 限界突破（多次，先做以抬高 MaxLevel）----
  const altMats = req.breaklimit_alternative_material_id_list || [];
  const fodderIds = req.breaklimit_equipment_user_id_list || [];
  const removed = [];
  let brkCount = 0;
  for (let i = 0; i < altMats.length; i++) {
    const mat = altMats[i];
    if (target && Number(target.break_limit || 0) >= Number(target.MaxBreakLimitCount || 5)) break;
    if (mat) {
      // ★★★ 突破材料校验（2026-10-17）★★★ 不足则停止继续突破（已突破的保留）
      const _chkBM = consumeItems(s, [[mat, 1]]);
      if (!_chkBM.ok) { console.log("[baggage] enhance_equipment_bulk 突破材料不足: " + _chkBM.id); break; }
    }
    if (target) {
      target.break_limit = (Number(target.break_limit) || 0) + 1;
      target.MaxLevel = (Number(target.MaxLevel) || 0) + 10;
      brkCount++;
    }
    if (mat) usedIds.push(mat);
  }
  for (const id of fodderIds) {
    const idx = list.findIndex(function (e) { return String(e.Id) === String(id); });
    if (idx >= 0) { removed.push(list[idx].Id); list.splice(idx, 1); }
  }
  // ---- ② 经验素材（在突破【之后】，此时 MaxLevel 已抬到最终值）----
  let lvInfo = { levels: 0, beforeLv: target && target.CurrentLevel, afterLv: target && target.CurrentLevel };
  if (target && (gained > 0 || brkCount > 0)) lvInfo = enhanceEquipmentByExp(target, gained);
  touchEquipment(target && target.Id);
  markDirty();
  flushNow();
  console.log("[baggage] enhance_equipment_bulk " + targetId + " +" + gained + "exp 金币-" + goldCost + " brk+" + brkCount +
    (lvInfo.levels ? " lv" + lvInfo.beforeLv + "->" + lvInfo.afterLv : ""));
  return okShaped(ctx.path, {
    ...ownerCharacterFields(target && target.OwnerCharacterId),
    target_equipment: target || undefined,
    items: { AllItemList: playerAllAssetFor(usedIds).AllItemList || [] },
    removed_equipment_user_id_list: removed,
    preset_list: (function () {
      const all = [];
      const map = s.__presets || {};
      for (const k of Object.keys(map)) if (Array.isArray(map[k])) all.push.apply(all, map[k]);
      return all.length ? [{ preset: all }] : [];
    })(),
    mission_progress_list: [],
    limited_mission_progress_list: [],
  });
});
route("baggage/enhance_amulet_bulk", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const list = (s.ItemList.amulet_list || []);
  let target = list.find(function (a) { return String(a.id) === String(req.target_amulet_user_id); });
  if (!target) target = list[0];
  let gained = 0;
  const removed = [];
  const fodder = Array.isArray(req.enhance_amulet_user_id_list) ? req.enhance_amulet_user_id_list : [];
  for (const id of fodder) {
    const idx = list.findIndex(function (a) { return String(a.id) === String(id); });
    if (idx >= 0) { gained += 100; removed.push(list[idx].id); list.splice(idx, 1); }
  }
  // ★ 2026-10-22：只加经验不升级＝数值纹丝不动（与装备同一缺陷），改走 enhanceAmuletByExp。
  const bulkLv = enhanceAmuletByExp(target, gained);
  markDirty();
  console.log("[baggage] enhance_amulet_bulk " + fodder.length + " fodder -> +" + gained + "exp" +
    (bulkLv.levels ? "  lv" + bulkLv.beforeLv + "→" + bulkLv.afterLv : "  (未升级)"));
  return okShaped(ctx.path, {
    ...ownerCharacterFields(target && target.owner_character_id),
    target_amulet: target || undefined,
    items: { AllItemList: [] },
    removed_amulet_user_id_list: removed,
    // ★ 反编译 `EnhanceAmuletBulkApi.PostRequest` 实证客户端消费 4 个：
    //   TemporaryItemExtend_AddOrUpdate            ← items
    //   TemporaryMissionListExtend_AddOrUpdate     ← Mission 列表
    //   TemporaryLimitedMissionProgressExtend      ← limited_mission_progress_list
    //   TemporaryPresetExtend_AddOrUpdate          ← ★ preset_list（我此前完全没有）
    //   ★ 同族端点的 Mission 列表命名不统一（大驼峰 / 小写都有）⇒ 两种都给，客户端只读它认的那个。
    preset_list: (s.preset_list || (s.__presets ? Object.values(s.__presets).flat() : []) || []).map(function (p) { return { preset: Array.isArray(p) ? p : [p] }; }),
    MissionProgressList: [],
    mission_progress_list: [],
    limited_mission_progress_list: [],
  });
});

// ---- baggage/enchant_equipment_start_bulk ----
route("baggage/enchant_equipment_start_bulk", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const list = (s.ItemList.EquipmentList || []);
  let target = list.find(function (e) { return String(e.Id) === String(req.targetEquipmentUserId); });
  if (!target) target = list[0];
  const cost = [];
  for (const c of (Array.isArray(req.consumeItemList) ? req.consumeItemList : [])) {
    const id = c.itemId || c.master_id;
    const n = Number(c.count || c.amount) || 0;
    if (id && n) {
      // ★★★ 消耗品校验（2026-10-17）★★★
      const _chkESB = consumeItems(s, [[id, n]]);
      if (!_chkESB.ok) { console.log("[baggage] enchant_equipment_start_bulk 材料不足: " + _chkESB.id); continue; }
      cost.push({ sheet_type: 1, master_id: id, amount: n });
    }
  }
  markDirty();
  console.log("[baggage] enchant_equipment_start_bulk " + cost.length + " cost kinds");
  return okShaped(ctx.path, {
    cost_items: cost,
    player_all_asset: touchedPlayerAssets(),
    targetEquipment: target || undefined,
    // ★ 真机契约（contracts_winr/baggage_enchant_equipment_start_bulk.json）另有：
    //   enchant_count（本次附魔次数，真机请求带 6、响应也是 6 = 回显请求）
    //   as_requested（是否按请求原样执行）
    enchant_count: Number(req.enchant_count) || 0,
    as_requested: true,
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ==================== 好友（单机：本地玩家为唯一成员） ====================
// 这些端点此前未实现（无录制样本）。结构按客户端类声明。
// 单机语义：没有其他真实玩家，故列表为空；但通知状态等要结构正确。

function friendNotifyStatus() {
  return { has_friend_request: false, has_receivable_friend_coin: false, has_sendable_friend_coin: false };
}

// ---- friend/get_friend_list ----
route("friend/get_friend_list", function (ctx) {
  const s = getState();
  return okShaped(ctx.path, { friend_list: s.__friendList || [] });
});

// ---- friend/search_player（参数 player_name，响应 user_list）----
route("friend/search_player", function (ctx) {
  const req = parse(ctx.body);
  const name = String(req.player_name || "");
  console.log("[friend] search_player name=" + name + " -> 0 (单机无其他玩家)");
  return okShaped(ctx.path, { user_list: [] });
});

// ---- 好友请求的接受/拒绝（单机下没有真实请求）----
const friendAction = function (label) {
  return function (ctx) {
    const req = parse(ctx.body);
    const s = getState();
    console.log("[friend] " + label + " player_id=" + (req.player_id !== undefined ? req.player_id : "-"));
    // ★ 真机契约（contracts_winr/friend_accept_friend_request.json）的键：
    //   friend_list / friend_request_list / friend_notify_status /
    //   friend_accept_status / MissionProgressList / limited_mission_progress_list
    //   后三个我早期漏了。
    //   friend_accept_status 是【结果码】：真机那次为 0（成功）。
    //   任务推进按 friendApply 类别（与 friend/apply_friend_request 一致）。
    const mp = label === "accept" ? advanceMissions("friendApply", 1, {}) : [];
    markDirty();
    return okShaped(ctx.path, {
      friend_list: s.__friendList || [],
      friend_request_list: [],
      friend_notify_status: friendNotifyStatus(),
      friend_accept_status: 0,
      MissionProgressList: mp,
      limited_mission_progress_list: [],
    });
  };
};
route("friend/accept_friend_request", friendAction("accept"));
route("friend/reject_friend_request", friendAction("reject"));
route("friend/reject_all_friend_request", friendAction("reject_all"));

// ---- friend/release_friend ----
route("friend/release_friend", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (Array.isArray(s.__friendList)) {
    s.__friendList = s.__friendList.filter(function (f) { return String(f.id) !== String(req.player_id); });
    markDirty();
  }
  console.log("[friend] release_friend " + req.player_id);
  // ★ `ReleaseFriendApi.PostRequest` 还消费 `friend_notify_status`（2026-10-17 键集核对）
  return okShaped(ctx.path, {
    friend_list: s.__friendList || [],
    friend_notify_status: { has_friend_request: false, has_receivable_friend_coin: false, has_sendable_friend_coin: false },
  });
});

// ---- friend/block_player 与 block_friend ----
const blockAction = function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__blockList) s.__blockList = [];
  const pid = Number(req.player_id);
  if (isFinite(pid) && s.__blockList.indexOf(pid) < 0) { s.__blockList.push(pid); markDirty(); }
  console.log("[friend] block " + pid);
  // ★ 真机契约（contracts_winr/friend_block_player.json）的键是
  //     { block_player: <被屏蔽玩家的资料对象>, target_deleted: bool }
  //   而不是 block_player_list（我早期把「屏蔽列表」当成了响应）。
  //   target_deleted=false 表示该玩家仍存在（只是被屏蔽）。
  //   单机场景没有真实他人资料 → 按请求的 player_id 构造最小合规资料对象。
  const profile = {
    id: isFinite(pid) ? pid : 0,
    name: "プレイヤー",
    profileMessage: "",
    profileCharacterMasterId: "Ch000100101",
    profileFrameMasterId: "Item_PlayerIconFrame_0000",
    level: 1,
    master_rank: 0,
    loginTime: Math.floor(Date.now() / 1000),
    guildId: 0,
  };
  // ★ 反编译 `BlockFriendApi.PostRequest` 还消费 `friend_list` + `friend_notify_status`
  //   （2026-10-17 键集核对）；早期只给 block_player/target_deleted。
  return okShaped(ctx.path, {
    block_player: profile,
    target_deleted: false,
    friend_list: Array.isArray(s.__friendList) ? s.__friendList : [],
    friend_notify_status: { has_friend_request: false, has_receivable_friend_coin: false, has_sendable_friend_coin: false },
  });
};
route("friend/block_player", blockAction);
route("friend/block_friend", blockAction);

// ==================== 公会（单机：本地玩家自建/自属） ====================
// 客户端类多继承 GuildPostApi，其响应为
//   { guild_internal_data: TemporaryGuildInternalData, guild_error_code: int }

/** 构造公会的「内部数据」。 */
// guildInternal 已移至 state.mjs（多模块共用，见 state.mjs 的导出）

/** 公会操作的通用响应（GuildPostApi 形状）。 */
// ★ 2026-10-23：聊天室 subscriptionToken 必须是【JWT 形态】
//   真机契约（_winr_capture/contracts_winr/chat_rooms.json）里是 HS256 JWT：
//   header.payload.signature，payload 含 iss/iat/exp/tenantId/userId/topicId/scopes。
//   我们之前给的是 "11111111-1111-4111-8111-xxxx" 这种 UUID —— 客户端解析 JWT 失败就
//   把房间丢掉 ⇒ SmallMenuViewModel.Build() 里 GetRoomList(Guild).FirstOrDefault() 得 null
//   ⇒ 公会按钮点了没反应 + NRE。这里按同样结构生成一个签名段为假的 JWT（仅供客户端解析）。
function makeFakeJwt(topicId, userId) {
  const b64u = function (o) { return Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); };
  const now = Math.floor(Date.now() / 1000);
  const header = b64u({ typ: "JWT", alg: "HS256" });
  const payload = b64u({
    iss: "https://game-neuron-pubsub-sample.dev-alter.net",
    iat: now, exp: now + 3600, tenantId: "alter",
    userId: String(userId || 0), topicId: String(topicId),
    scopes: ["subscribe"], events: { "publish:before": [] },
  });
  const sig = Buffer.from("local-" + String(topicId).slice(0, 8) + "-signature", "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return header + "." + payload + "." + sig;
}

function guildResponse(ctx, overrides) {
  // ★ 2026-10-23：按真机契约补齐两个顶层字段
  //   guild_get_guild_profile 契约（_winr_capture/contracts_winr）里除 guild_internal_data
  //   还有 guild_master_force_change_data: [] 与 join_restriction_release_date: 0。
  //   缺这两个字段时，建会后 Header 刷新（CommonHeaderBehaviour.Refresh）会 NRE。
  return okShaped(ctx.path, {
    guild_internal_data: guildInternal(overrides),
    guild_master_force_change_data: [],
    join_restriction_release_date: 0,
    guild_error_code: 0,
  });
}

// ---- guild/create ----
// 参数 { guild_name, joining_condition, play_style, emblem_master_id, ... }
// ★★★ 2026-10-22 用户决定：**暂时禁用建会** ★★★
//   理由：入会后主页右侧四个大按钮会失效（公会聊天室取不到 → FirstOrDefault() null → NRE）。
//   这里不写任何状态，只回一个「重名」错误码 2500：
//   客户端 GuildUseCase.GuildErrorCodeToErrorMessage(2500) =「既に存在するギルド名です。
//   別の名前でギルドを作成してください。」，GuildErrorAction(2500) = None（不强制跳转）
//   ⇒ 玩家看到的是正常的建会失败提示，界面停在建会弹窗，存档不受影响。
//   将来要真正支持公会时，把 ALLOW_GUILD_CREATE 改回 true 即可（下面的原逻辑保留）。
// ★★★ 2026-10-25：改为允许建会 ★★★
//   原本 2026-10-22 禁用，理由是「入会后主页右侧四个大按钮失效」。
//   但那个现象的真根因是 story/read 往对象数组 push 字符串导致 load_user_data 导入链中断
//   （2026-10-18 已修，用户实测「进主页直接就能点，不用切页」），与本功能无关。
//   入会所需的数据合规性（roll_master_id 1..3 / symbol_id 1..3 / symbol_list 3 条 /
//   guild_quest_limit_list 3 条 / type=2 聊天室 + 非空 subscriptionToken）全部由
//   healGuildInternal() 在唯一实现里保证。
const ALLOW_GUILD_CREATE = true;
route("guild/create", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!ALLOW_GUILD_CREATE) {
    // 防御：若存档里残留公会，一并清掉（否则主页按钮会继续失效）
    const _n = purgeGuild(s);
    if (_n) { markDirty(); flushNow(); }
    console.log("[guild] create 已被本地禁用 name=" + JSON.stringify(req.guild_name || "") + " → 返回 2500（不入会，不写状态）");
    return okShaped(ctx.path, { guild_internal_data: guildInternal(), guild_error_code: 2500 });
  }
  const gid = 90000 + Math.floor(Math.random() * 10000);
  // ★★★ 2026-10-22：id 必须全部指向真实主数据 ★★★
  //   用户建会后客户端报 `KeyNotFoundException: key '0'` + NRE，真因是
  //   `roll_master_id: 0`（GuildRoll 只有 1..3）与 `symbol_id: 0`（GuildSymbolCharacter 只有 1..3），
  //   且 symbol_list / guild_quest_limit_list 从未下发（真机契约恒各 3 条）。
  //   现在建会只给「最小骨架」，细节一律交给 healGuildInternal 规范化（唯一实现）。
  s.guild_internal_data = {
    guild_id: gid,
    guild_name: String(req.guild_name || "ギルド"),
    guild_master_id: s.UserData.id,
    guild_master_name: s.UserData.name,
    guild_level: 1,
    guild_exp: 0,
    joining_condition: Number(req.joining_condition) || 0,
    play_style: Number(req.play_style) || 0,
    emblem_master_id: Number(req.emblem_master_id) || 1,
    recruit_message: String(req.recruit_message || ""),
    information_message: "",
    last_guild_ranking: 0,
    symbol_id: 1,
    member_list: [{ id: s.UserData.id, name: s.UserData.name, roll_master_id: 1, profile_character_master_id: s.UserData.profileCharacterMasterId, profile_frame_master_id: s.UserData.profileFrameMasterId, level: s.UserData.level || 1, master_rank: s.UserData.master_rank || 1, login_time: Math.floor(Date.now() / 1000), earned_guild_exp: 0 }],
  };
  // 入会标志：客户端 TemporaryGuildPublicData.IsEmpty() 以 guild_name != null 判「已入会」，
  // 我的 guildInternal() 依据 guild_joined 决定 guild_name 是 null 还是真实值，二者必须同步。
  s.guild_joined = true;
  // 入会后必须存在对应的 type=2 聊天室：客户端 SmallMenuViewModel.Build 会
  // GetRoomList(ChatType.Guild).FirstOrDefault()，房间不存在则 null → NullCheck 抛 NRE。
  if (!Array.isArray(s.__chatRooms)) s.__chatRooms = [];
  if (!s.__chatRooms.some(function (r) { return r.type === 3; })) {   // 公会房间服务端 type=3
    s.__chatRooms.push({
      id: 200000000 + (gid % 100000000), type: 3, ownerId: gid,   // ★ 必须是 3：客户端 RoomType = type-1，ChatType.Guild=2
      topicId: "00000000-0000-4000-8000-" + String(gid).padStart(12, "0"),
      // ★★★ subscriptionToken 必须【非空】（2026-10-17 用户报障「建会后卡死」）★★★
      //   真机契约里它是真实 token；我给空串 ⇒ 客户端的 pubsub 订阅失败 ⇒
      //   房间被丢弃 ⇒ `ChatUseCase.GetRoomList(ChatType.Guild)` 返回空 ⇒
      //   `CommonHeaderBehaviour.Refresh()` 里 `FirstOrDefault(...)` 得 null ⇒
      //   `NullCheck` 抛 NullReferenceException ⇒ 整个 Header 刷新失败、界面卡死。
      //   用确定性 UUID（同一 guild 每次生成相同，避免客户端反复重订阅）。
      subscriptionToken: makeFakeJwt("00000000-0000-4000-8000-" + String(gid).padStart(12, "0"), (s.UserData||{}).id),
    });
  }
  // 规范化（象征/任务上限/公会战 ex/chat_room_id 等补齐）
  const _healed = healGuildInternal(s);
  markDirty();
  flushNow();
  console.log("[guild] create name=" + s.guild_internal_data.guild_name + " id=" + gid + ( _healed ? "（规范化 " + _healed + " 字段）" : ""));
  return guildResponse(ctx);
});

// ---- guild/update_setting / update_information_message / change_roll / change_master ----
const guildUpdate = function (label, apply) {
  return function (ctx) {
    const req = parse(ctx.body);
    const s = getState();
    // ★ 2026-10-22：未入会时不要凭空造 guild_internal_data（会把「未入会」变成假公会）
    if (s.guild_joined !== true || !s.guild_internal_data) { console.log("[guild] " + label + " 忽略（未入会）"); return guildResponse(ctx); }
    if (apply) apply(s.guild_internal_data, req);
    markDirty();
    console.log("[guild] " + label);
    return guildResponse(ctx);
  };
};
route("guild/update_setting", guildUpdate("update_setting", function (g, r) {
  if (r.joining_condition !== undefined) g.joining_condition = Number(r.joining_condition);
  if (r.play_style !== undefined) g.play_style = Number(r.play_style);
  if (r.emblem_master_id !== undefined) g.emblem_master_id = Number(r.emblem_master_id);
  if (r.symbol_id !== undefined) g.symbol_id = Number(r.symbol_id);
  if (r.recruit_message !== undefined) g.recruit_message = r.recruit_message;
}));
route("guild/update_information_message", guildUpdate("update_information_message", function (g, r) {
  if (r.information_message !== undefined) g.information_message = r.information_message;
}));
route("guild/change_roll", guildUpdate("change_roll", function (g, r) {
  const me = (g.member_list || []).find(function (m) { return m.id === getState().UserData.id; });
  if (me && r.roll_master_id !== undefined) me.roll_master_id = Number(r.roll_master_id);
}));

// ---- guild/get_candidate_list ----
route("guild/get_candidate_list", function (ctx) {
  // 单机无其他玩家可推荐/申请
  return okShaped(ctx.path, { request_list: [], recruit_list: [] });
});

// ---- guild/accept_join_request / reject_join_request / cancel_join_request / send_join_request ----
const guildJoinAction = function (label) {
  return function (ctx) {
    const req = parse(ctx.body);
    console.log("[guild] " + label + " player_id=" + (req.player_id !== undefined ? req.player_id : "-"));
    // ★ `CancelJoinRequestApi` / `SendJoinRequestApi.PostRequest` 消费 `guild_id` + `request_list`
    //   （2026-10-17）；早期只回 guild_internal_data + guild_error_code。
    const base = {
      guild_internal_data: guildInternal({ join_request_list: [] }),
      guild_error_code: 0,
    };
    // ★ 反编译实证：只有 `CancelJoinRequestApi` / `SendJoinRequestApi` 的 PostRequest
    //   消费 `guild_id` + `request_list`；accept/reject 的类声明里没有这两个键
    //   ⇒ 按 label 区分，保持键集精确（多给虽无害但会让键集比对失真）。
    if (label === "cancel_join_request" || label === "send_join_request") {
      base.guild_id = Number((getState().guild_internal_data || {}).guild_id) || 0;
      base.request_list = [];
    }
    return okShaped(ctx.path, base);
  };
};
route("guild/accept_join_request", guildJoinAction("accept_join_request"));
route("guild/reject_join_request", guildJoinAction("reject_join_request"));
route("guild/cancel_join_request", guildJoinAction("cancel_join_request"));
route("guild/send_join_request", guildJoinAction("send_join_request"));

// ---- guild/exile_member ----
route("guild/exile_member", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (s.guild_internal_data && Array.isArray(s.guild_internal_data.member_list)) {
    s.guild_internal_data.member_list = s.guild_internal_data.member_list.filter(function (m) { return String(m.id) !== String(req.player_id); });
    markDirty();
  }
  console.log("[guild] exile_member " + req.player_id);
  return guildResponse(ctx);
});

// ---- guild/leave / disband ----
const guildExit = function (label) {
  return function (ctx) {
    const s = getState();
    s.guild_internal_data = null;
    s.guild_joined = false;            // 与 guildInternal() 的判定保持同步
    if (Array.isArray(s.__chatRooms)) s.__chatRooms = s.__chatRooms.filter(function (r) { return r.type !== 2; });
    markDirty();
    console.log("[guild] " + label);
    // ★ 必须是【对象】而不是 undefined（2026-10-17）：
    //   `{ guild_internal_data: undefined }` 在 JSON 序列化时该键会被丢弃，
    //   客户端读不到公会状态 ⇒ 离会后界面残留旧公会 / 报错。
    //   guildInternal() 在未入会时返回字段齐全的空状态（guild_id=0、guild_name=null、列表全空）。
    return okShaped(ctx.path, { guild_internal_data: guildInternal(), guild_error_code: 0 });
  };
};
route("guild/leave", guildExit("leave"));
route("guild/disband", guildExit("disband"));

// ==================== 棋盘 / 聊天 / 老虎机 / 其他 ====================

// ---- board_game/roll ----（消耗道具或石头的棋盘游戏）
route("board_game/roll", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__boardGame) s.__boardGame = {};
  const id = String(req.master_board_game_id || "");
  const bg = s.__boardGame[id] || { master_board_game_id: id, now_position: 0, cleared_count: 0 };
  const steps = 1;
  bg.now_position = (bg.now_position || 0) + steps;
  s.__boardGame[id] = bg;
  markDirty();
  console.log("[board] roll " + id + " -> pos " + bg.now_position);
  return okShaped(ctx.path, {
    boardGame: bg,
    boardGameDailyRolledCount: { master_board_game_id: id, daily_rolled_count: 1 },
    fragmentReceiveCountIncrease: { increased_count: 0 },
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ---- board_game/update ----
route("board_game/update", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__boardGame) s.__boardGame = {};
  const id = String(req.master_board_game_id || "");
  const bg = s.__boardGame[id] || { master_board_game_id: id, now_position: 0, cleared_count: 0 };
  s.__boardGame[id] = bg;
  return okShaped(ctx.path, {
    boardGame: bg,
    boardGameDailyRolledCountList: [{ master_board_game_id: id, daily_rolled_count: 1 }],
    fragmentReceiveCountIncrease: { increased_count: 0 },
    // ★ `BoardGameUpdateApi.PostRequest` 还消费 boardGameEffectEventList（2026-10-17）；
    //   形状 [{master_board_game_id, event_type, value1, value2}]，本次无事件则空数组。
    boardGameEffectEventList: [],
  });
});

// ---- chat/read_state ----（参数 { roomId, otherId, readMessageId }）
route("chat/read_state", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__chatReadState) s.__chatReadState = {};
  const key = String(req.roomId || 0);
  s.__chatReadState[key] = { room_id: Number(req.roomId) || 0, other_id: Number(req.otherId) || 0, read_message_id: Number(req.readMessageId) || 0 };
  markDirty();
  return okShaped(ctx.path, { state: s.__chatReadState[key] });
});

// ---- chat/read_status ----
route("chat/read_status", function (ctx) {
  const s = getState();
  // ★★★ 形状修正（2026-10-17 用户报障「Header 按钮点不动」）★★★
  //   客户端 `ReadStatusApi` 的 Response 声明（endpoint-skeletons.json 实测）：
  //     status: [{ id, accountId, roomId, otherId, readMessageId }]   ← 5 字段、camelCase
  //   我此前返回 { room_id, other_id, read_message_id }（3 字段、snake_case）且**恒为空数组**
  //   （__chatReadState 只在玩家主动进某个聊天室时才被 chat/read_state 写入）。
  //   ⇒ 客户端拿不到任何房间的已读状态 ⇒ `ChatUseCase.GetRoomList` 的配套逻辑拿不到房间
  //     ⇒ `CommonHeaderBehaviour.Refresh()` 里 `FirstOrDefault(rooms)` 为 null
  //     ⇒ `NullCheck` 抛 NRE ⇒ **Refresh 中断**，它后面所有 Header 按钮（聊天/排行/公会/公告）
  //       的初始化全都没执行 ⇒ 点了没反应。
  //   修法：按【玩家的每个聊天室】生成一条，字段用客户端声明的 camelCase；
  //     已读进度取 __chatReadState（没有则 0 = 全未读）。
  const rooms = Array.isArray(s.__chatRooms) ? s.__chatRooms : [];
  const state = s.__chatReadState || {};
  const status = rooms.map(function (r) {
    const st = state[String(r.id)] || {};
    return {
      id: Number(r.id) || 0,
      accountId: Number((s.UserData || {}).id) || 0,
      roomId: Number(r.id) || 0,
      otherId: Number(r.ownerId) || 0,
      readMessageId: Number(st.read_message_id) || 0,
    };
  });
  return okShaped(ctx.path, { status: status });
});

// ---- recollection/delete_list ----
route("recollection/delete_list", function (ctx) {
  const s = getState();
  s.__recollection = [];
  markDirty();
  console.log("[recollection] delete_list");
  return okShaped(ctx.path, { recollection_cleard_characters: [] });
});

// ---- shop/exchange_bulk ----
route("shop/exchange_bulk", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const list = [];
  // 请求里带要交换的商品 <-> 数量
  const items = Array.isArray(req.exchange_list) ? req.exchange_list
              : (Array.isArray(req.goods_list) ? req.goods_list : []);
  for (const it of items) {
    const mid = it.master_id || it.itemId;
    const n = Number(it.amount || it.count) || 1;
    if (mid) { addItem(mid, n); list.push({ sheet_type: 1, master_id: mid, amount: n }); }
  }
  markDirty();
  console.log("[shop] exchange_bulk " + list.length + " kinds");
  return okShaped(ctx.path, {
    player_all_asset: touchedPlayerAssets(),
    shop_stock_info: { re_event_goods: [] },
    item_format_list: list,
    present_item_format_list: [],
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ---- shop/get_re_event_shop_old_stock_info ----
route("shop/get_re_event_shop_old_stock_info", function (ctx) {
  return okShaped(ctx.path, { old_event_goods: [] });
});

// ---- select_ticket/use ----
route("select_ticket/use", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 2026-10-21：真实请求是【嵌套结构】★★★
  //   真机/客户端实证：
  //     {"select_ticket":{"sheet_type":1,"master_id":"Item_SelectTicket_Weapon_SSR_02","amount":1},
  //      "target_item":{"sheet_type":1,"master_id":"Item_Equipment_SSR_0001","amount":1}}
  //   早期只读顶层 req.master_item_id / req.itemId ⇒ 恒 undefined ⇒ 券不扣、奖励不发 ⇒「使用无反应」。
  const _st = req.select_ticket || {};
  const _tg = req.target_item || {};
  const mid = _st.master_id || req.master_item_id || req.itemId;
  const rewards = [];
  if (mid) {
    // ★★★ 选择券校验（2026-10-17）★★★
    const _chkST = consumeItems(s, [[mid, 1]]);
    if (!_chkST.ok) {
      console.log("[select_ticket] use 券不足: " + _chkST.id);
      // ★ 早退也必须回【当前状态】（2026-10-17，同上）：该端点无契约样本。
      return okShaped(ctx.path, {
        player_all_asset: touchedPlayerAssets(),
        item_format_list: [],
        present_item_format_list: [],
      });
    }
    // ★ 目标：优先取 target_item（嵌套），其次兼容旧的 master_character_id / select_id
    if (_tg.master_id) {
      const amt = Math.max(1, Number(_tg.amount) || 1);
      rewards.push({ sheet_type: Number(_tg.sheet_type) || 1, master_id: String(_tg.master_id), amount: amt });
    } else {
      const pick = req.master_character_id || req.select_id;
      if (pick) rewards.push({ sheet_type: 2, master_id: pick, amount: 1 });
    }
  }
  const applied = rewards.length ? applyRewards(rewards) : [];
  markDirty();
  console.log("[ticket] use " + mid + " -> " + (rewards[0] ? rewards[0].master_id : "-"));
  return okShaped(ctx.path, {
    player_all_asset: touchedPlayerAssets(),
    item_format_list: toItemFormatList(applied),
    present_item_format_list: [],
  });
});

// ==================== 收尾端点 ====================

// ---- slot/play ----
route("slot/play", function (ctx) {
  const s = getState();
  if (!s.__slot) s.__slot = { play_count: 0, total_medal: 0 };
  s.__slot.play_count = (s.__slot.play_count || 0) + 1;
  markDirty();
  console.log("[slot] play #" + s.__slot.play_count);
  return okShaped(ctx.path, { slot_user_data: s.__slot, slot_play_data: { result_symbol_list: [], reward_list: [] } });
});

// ---- quest/skip_tower_quest ----
route("quest/skip_tower_quest", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 2026-10-22 重写 ★★★
  // 用户报障：「霸者之塔，通关以后没有记录，也没给奖励」。
  // 真机请求体是 **空对象** {}（客户端只表达"跳下一层"的意图，不传关卡 id）——
  // 旧实现从 req 取 questId ⇒ 永远拿到空串 ⇒ questRow=null ⇒ 无奖励、记录不动。
  // 正确语义：按当前记录算出「下一层」，把这一层当作通关结算（首通奖励+普通掉落+任务推进），
  //          并把 TowerQuestRecord 推进到该层。
  const before = { rank: s.UserData.level, rankExp: s.UserData.exp, stamina: s.UserData.stamina };
  const target = towerNextTarget(s);
  const id = String(req.questId || req.quest_id || "") || target.questId;
  const row = questRow(id);
  const pExp = num(row && (row.AcquirePlayerRankExp || row["獲得プレイヤーランク経験値"]));
  const cExp = num(row && (row.AcquireExp || row["獲得経験値"]));
  const gold = num(row && (row.AcquireGold || row["獲得ゴールド"]));
  if (pExp) addPlayerExp(pExp);
  if (gold) addItem("Item_Currency_Gold", gold);
  // 首通奖励（塔每层一个 Reward_Firstclear_Tower_Normal_NNN）
  const isFirst = !(s.UserQuestList || []).some(function (x) { return x.MasterQuestId === id && (x.TotalClearCount || 0) > 0; });
  const firstDrops = [];
  if (id) {
    const fcId = (row && row.FirstClearRewardId) || ("Reward_Firstclear_" + id);
    if (isFirst && fcId) { try { for (const x of resolveRewardId(fcId)) firstDrops.push(x); } catch (e) {} }
  }
  const d = dropsForQuest(row, id, 1, 0);
  const allDrops = firstDrops.concat(d.normalDrops || []).concat(d.dailyDrops || []);
  if (allDrops.length) applyRewards(allDrops);
  // 任务记录 + 塔记录
  if (id) {
    const uq = ensureUserQuest(s, id);
    uq.TotalClearCount = (uq.TotalClearCount || 0) + 1;
    uq.DailyClearCount = (uq.DailyClearCount || 0) + 1;
    updateTowerQuestRecord(s, id);
  }
  const mp = advanceMissions("quest", 1, { questId: id });
  const qrt = buildQuestResultTemp({
    before: before,
    after: { rank: s.UserData.level, rankExp: s.UserData.exp, stamina: s.UserData.stamina },
    addUserRankExp: pExp, addCharacterExp: cExp,
    userRank: (s.UserData || {}).level || 0,
    firstDrops: firstDrops, normalDrops: d.normalDrops || [], dailyDrops: d.dailyDrops || [],
    questStamina: num(row && (row.ConsumeStamina || row["消費スタミナ"])), expToGoldTimes: 1,
  });
  s.__questResultTemp = qrt;
  markDirty(); flushNow();
  console.log("[quest] skip_tower_quest " + id + "（" + target.group + " " + target.floor + "F）首通=" + firstDrops.length + " 掉落=" + allDrops.length);
  return okShaped(ctx.path, {
    quest_result_temp: qrt,
    userData: s.UserData,
    userQuestList: s.UserQuestList || [],
    TowerQuestRecord: s.TowerQuestRecord,
    items: touchedPlayerAssets(),
    MissionProgressList: mp,
    limited_mission_progress_list: [],
    guild_internal_data: s.guild_internal_data || null,
  });
});
// ---- ranking/load_character_ranking_data ----
route("ranking/load_character_ranking_data", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const rows = [];
  for (let i = 1; i <= 100; i++) {
    rows.push({ rank: i, before_rank: i, rank_value: 1000000 - i * 1234, player_account_id: 900000000 + i, player_name: "プレイヤー", profile_character_master_id: (s.UserData && s.UserData.profileCharacterMasterId) || "Ch000100101", profile_frame_master_id: (s.UserData && s.UserData.profileFrameMasterId) || "Item_PlayerIconFrame_0001", master_rank: 20, user_rank: 100 });
  }
  return okShaped(ctx.path, {
    value_description: "",
    ranking_mater_id: "character_favorite",
    self_ranking: { rank: 101, before_rank: 101, rank_value: 807271, player_account_id: s.UserData.id, player_name: s.UserData.name, profile_character_master_id: s.UserData.profileCharacterMasterId, profile_frame_master_id: s.UserData.profileFrameMasterId, master_rank: 16, user_rank: 100 },
    ranking_list: rows,
  });
});

// ---- abyssal_maze/select_preset ----
route("abyssal_maze/select_preset", function (ctx) {
  const req = parse(ctx.body);
  const mz = mazeState();
  if (req.preset_master_id) {
    mz.abyssal_maze.selected_preset = true;
    const s = getState();
    if (!s.__presets) s.__presets = {};
  }
  // ★ 真机契约（contracts_winr/abyssal_maze_select_preset.json）：
  //   {master_abyssal_maze_id, master_season_id, now_position, selected_preset,
  //    selected_door_id, selected_effect_id}  ← 后两个我早期漏了
  //   真机那次两值都是 0（选了预设但还没选门/效果）。已选过则保留 state 里的值。
  if (mz.abyssal_maze.selected_door_id === undefined) mz.abyssal_maze.selected_door_id = 0;
  if (mz.abyssal_maze.selected_effect_id === undefined) mz.abyssal_maze.selected_effect_id = 0;
  markDirty();
  console.log("[abyss] select_preset " + req.preset_master_id);
  return okShaped(ctx.path, { abyssal_maze: mz.abyssal_maze });
});

// ---- preset/update_formation ----
// 契约（PresetUpdateFormationApi）：
//   请求 { preset_master_id, formations: [ { character_id, slot_num, formation_id } ] }
//   响应 { preset: TemporarySlot[] }
// ★ 旧实现只读 req.slot_num / req.master_main_character_id —— 这两个字段在请求里【根本不存在】，
//   于是每个槽位都被写成「空角色 + formation_id=A01」：
//   ① 把玩家刚编好的队伍整队清空；② 4 个槽位全变 A01 → 出战全叠在一个格子上。
route("preset/update_formation", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const key = String(req.preset_master_id || "");
  if (!s.__presets) s.__presets = {};
  const list = s.__presets[key] || [];
  const forms = Array.isArray(req.formations) ? req.formations : [];
  for (const f of forms) {
    if (!f) continue;
    const slot = Number(f.slot_num);
    if (!isFinite(slot)) continue;
    let e = list.find(function (x) { return Number(x.slot_num) === slot; });
    if (!e) { e = buildPreset(key, slot, "", "", ""); list.push(e); }
    if (f.formation_id) e.formation_id = String(f.formation_id);
    if (f.character_id) e.master_main_character_id = String(f.character_id);
    e.updated_at = nowStamp();
    e.totalBattlePower = presetSlotBattlePower(e.master_main_character_id, e.master_support_character_id);
  }
  list.sort(function (a, b) { return Number(a.slot_num) - Number(b.slot_num); });
  normalizePreset(list, key);
  s.__presets[key] = list;
  markDirty();
  console.log("[preset] update_formation " + key + " -> " + list.map(function (e) { return (e.slot_num) + ":" + (e.master_main_character_id || "-") + "@" + (e.formation_id || "-") + "(" + (e.totalBattlePower || 0) + ")"; }).join(" "));
  return okShaped(ctx.path, { preset: list });
});

// ---- legend_mastery/enhance_master ----
route("legend_mastery/enhance_master", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // ★★★ 重写（2026-10-14）：原实现用了【自造键 __legendMastery】+ 不扣材料 ★★★
  //
  // 原实现的问题（用户要求「扫描全部同类 bug」时发现的第 3 处）：
  //   ① 写到 `s.__legendMastery[id] = {master_legend_mastery_id, level}` ——
  //      **契约里根本没有这个键**（真机 legend_mastery_list 只有 3 个子键：
  //        legend_enhance_info_list / master_enhance_info / tenmei_enhance_info_list）
  //      ⇒ 客户端读不到等级变化。
  //   ② **完全不扣材料** —— 权威表 MasterMastery.csv 明确有
  //      `MasterRuneAmount`（1 级 100）+ `GoldAmount`（1 级 500000）。
  //   ③ 该端点**从未抓到过契约**（真机 0 条请求）—— 属最高风险区。
  //
  // 正确语义（与 tenmei/legend 同族）：
  //   状态：legend_mastery_list.**master_enhance_info**.master_mastery_level
  //     （真机契约实证：{"master_mastery_level":9}，且 campaign.mjs 的
  //       limitPlusForPlayer / masteryLevelOf 正是读它算「上限提升」）
  //   成本：MasterMastery.csv 的 (MasterMasteryLevel → MasterRuneAmount + GoldAmount)
  // ★ 注意：这一族是【按等级】而非按节点 —— 请求里的 id 字段在本端点无对应状态，
  //   等级是全局单值（所有角色共享）。
  if (!s.legend_mastery_list) s.legend_mastery_list = {};
  const cur = s.legend_mastery_list.master_enhance_info || { master_mastery_level: 0 };
  const before = Number(cur.master_mastery_level) || 0;
  // 目标等级：请求给了就用，否则 +1
  const want = Number(req.master_mastery_level || req.update_level || 0) || (before + 1);
  const mm = loadTable("LegendMastery/MasterMastery.csv");
  const mmRows = (mm && mm.rows) || [];
  const rowAt = function (l) {
    return mmRows.find(function (x) { return Number(x.MasterMasteryLevel) === Number(l); });
  };
  // 消耗 = 逐级累加（每级的 MasterRuneAmount / GoldAmount 都是该级要付的）
  let rune = 0, gold = 0;
  for (let l = before + 1; l <= want; l++) {
    const r = rowAt(l);
    if (!r) break;
    rune += Number(r.MasterRuneAmount) || 0;
    gold += Number(r.GoldAmount) || 0;
  }
  // ★★★ 材料校验（2026-10-17）★★★
  const _costs5 = [];
  if (rune > 0) _costs5.push(["Item_rune_master_01", rune]);
  if (gold > 0) _costs5.push(["Item_Currency_Gold", gold]);
  const _chk5 = consumeItems(s, _costs5);
  if (!_chk5.ok) {
    console.log("[legend] enhance_master 材料不足: " + _chk5.id + " need=" + _chk5.need + " have=" + _chk5.have);
    // ★ 早退也必须回【当前状态】（2026-10-17）：本端点无契约样本，
    //   `okShaped(ctx.path, {})` 补不出任何字段 ⇒ 客户端拿到空对象 ⇒ 精通界面不刷新。
    return okShaped(ctx.path, {
      master_enhance_info: {
        master_mastery_level: Number(((s.legend_mastery_list || {}).master_enhance_info || {}).master_mastery_level) || 0,
      },
      main_character_list: ((s.CharacterList || {}).mainCharacterList || []),
      support_character_list: ((s.CharacterList || {}).supportCharacterList || []),
      update_character_info: buildUpdateCharacterInfo(s),
      player_all_asset: touchedPlayerAssets(),
      item_format_list: toItemFormatList([]),
      present_item_format_list: [],
      MissionProgressList: [],
      limited_mission_progress_list: [],
    });
  }
  // ★★★ 2026-10-21：删掉这里的二次扣款 ★★★
  //   consumeItems(s, _costs5) 【内部已经 addItem(-amount) 扣过了】，
  //   这里再 addItem(-gold) 就是【双重扣除】：
  //     实证：用户金币 555,036，Lv1 需 500,000 → 应剩 55,036，
  //     实际被扣两次 → 55,036-500,000 触发下限夹到 0（用户报障「金币被清零」）。
  //   统一原则：扣款只走 consumeItems 一处。
  s.legend_mastery_list.master_enhance_info = { master_mastery_level: want };
  markDirty();
  // ★ 传说精通/大师强化提升【全体角色】属性加成 → 全部 touch
  for (const c of (s.CharacterList.mainCharacterList || [])) touchCharacter(c.master_character_id);
  for (const c of (s.CharacterList.supportCharacterList || [])) touchCharacter(c.master_character_id);
  console.log("[legend] enhance_master lv" + before + "→" + want + " 耗 rune_master=" + rune + " gold=" + gold);
  // ★ 响应形状：同族端点（enhance_legend / enhance_tenmei）都返回
  //   player_all_asset + item_format_list + 受影响的角色。
  //   原实现引用了不存在的 `applied` 变量（我删了定义却留着引用）→
  //   整个端点抛 ReferenceError → 客户端报通信错误（实测 [ROUTE-EXC] applied is not defined）。
  return okShaped(ctx.path, {
    // ★★★ 补 master_enhance_info（2026-10-17 键集核对发现）★★★
    //   反编译 `MasterEnhanceApi.PostRequest` 实证客户端消费 3 个字段：
    //     GameReceiveApi_SetCharacterData(TemporaryCharacter)              ← main/support 角色
    //     TemporaryLegendMasteryExtend_UpdateLegendMasteryMasterEnhanceInfo ← ★ master_enhance_info
    //     GameReceiveApi_UpdatePlayerAllAsset                             ← player_all_asset
    //   我此前【没有 master_enhance_info】⇒ 客户端拿到 null ⇒ 精通等级不刷新。
    master_enhance_info: {
      master_mastery_level: Number(((s.legend_mastery_list || {}).master_enhance_info || {}).master_mastery_level) || 0,
    },
    main_character_list: ((s.CharacterList || {}).mainCharacterList || []),
    support_character_list: ((s.CharacterList || {}).supportCharacterList || []),
    // 本次消耗的持有量（MasterRune + Gold）—— 与 enhance_tenmei 的语义一致
    player_all_asset: touchedPlayerAssets(),
    item_format_list: toItemFormatList([]),
    present_item_format_list: [],
    // 大师精通提升【全体角色】的上限与属性 → 全部回传（客户端据此刷新）
    update_character_info: buildUpdateCharacterInfo(s),
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ---- memory_book/release_memories ----
// ★★★ 一括強化（2026-10-17 用户报障「一括强化失败」后重写）★★★
//
// 客户端类：`MemoriesBookNodeLvUpApi`（**不是** ByBookType）。反编译实证：
//   · ParameterJson = `{ master_book_id, master_page_type }`   ← 用户请求正是它
//   · PostRequest **只消费两个字段**：
//       result.main_character_list   → UserAssetMainCharacterImporter.ImportDataStore
//       result.support_character_list → UserAssetSupportCharacterImporter.ImportDataStore
//   · 反编译里搜不到 `released_node_list` ⇒ 客户端**根本不读**该字段
//
// ★ 我此前的实现三处都错：
//   ① 读 `master_node_id_list`（客户端发的是 book_id + page_type）→ ids 恒空；
//   ② 只往自造的 `__memoryBook.released` 里 push，**不扣材料、不升等级**；
//   ③ 响应只给 `memory_book.released_node_list`，**缺 main/support_character_list**
//      ⇒ 客户端拿不到属性更新 → 判定失败 → 「通信エラー」。
//
// ★ 正确语义：把该页【所有能强化的节点】从当前等级往上推（材料够就 +1，逐级扣），
//   直到材料不足或满级；然后回传受影响角色的**完整对象**（出口会重算 StatusList）。
route("memory_book/release_memories", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.memory_book) s.memory_book = {};
  if (!Array.isArray(s.memory_book.memory_book_node_list)) s.memory_book.memory_book_node_list = [];

  const bookId = req.master_book_id ? String(req.master_book_id) : null;
  const pageType = req.master_page_type !== undefined && req.master_page_type !== null ? Number(req.master_page_type) : null;
  const bookType = req.master_book_type !== undefined && req.master_book_type !== null ? Number(req.master_book_type) : null;

  // ① 找出目标节点（按 book_id + page_type；或按 book_type）
  const nodeTbl = loadTable("MemoryBook/MemoryBookNode.csv");
  const nodeRows = (nodeTbl && nodeTbl.rows) || [];
  const targets = nodeRows.filter(function (r) {
    if (bookId) {
      if (String(r.BookId) !== bookId) return false;
      if (pageType !== null && Number(r.PageType) !== pageType) return false;
      return true;
    }
    if (bookType !== null) {
      // BookType 是书的大类编号（1=Class / 2=Symbol / 3=Supporttype / 4=Class_Attribute）
      const b = String(r.BookId || "");
      if (bookType === 1) return /^Memory_Book_Class_[0-9]+$/.test(b);
      if (bookType === 2) return /^Memory_Book_Symbol_/.test(b);
      if (bookType === 3) return /^Memory_Book_Supporttype_/.test(b);
      if (bookType === 4) return /^Memory_Book_Class_Attribute_/.test(b);
      return /^Memory_Book_Class_[0-9]+$/.test(b);
    }
    return false;
  });

  const costTbl = loadTable("MemoryBook/MemoryBookNodeCostMaterialList.csv");
  const costRows = (costTbl && costTbl.rows) || [];
  const nodeList = s.memory_book.memory_book_node_list;
  const released = [];
  const gainedCostIds = [];
  let totalCost = 0;

  // ② 逐节点强化：材料够就 +1 级，反复直到不够或满级
  for (const r of targets) {
    const nodeId = String(r.NodeId);
    let node = nodeList.find(function (x) { return String(x.master_node_id) === nodeId; });
    if (!node) { node = { master_node_id: nodeId, level: 0 }; nodeList.push(node); }
    const rowsForNode = costRows.filter(function (c) { return String(c.NodeId) === nodeId; });
    const maxLv = rowsForNode.reduce(function (a, c) { return Math.max(a, Number(c.NodeLv) || 0); }, 0);
    let lv0 = Number(node.level) || 0;
    while (true) {
      const nextLv = (Number(node.level) || 0) + 1;
      if (nextLv > maxLv) break;
      const cost = [];
      for (const c of rowsForNode) {
        if (Number(c.NodeLv) !== nextLv) continue;
        if (!c.CostMaterial) continue;
        cost.push([c.CostMaterial, Number(c.CostCount || 1)]);
      }
      if (!cost.length) break;
      const chk = consumeItems(s, cost);
      if (!chk.ok) break;   // 材料不足 → 该节点停在此级
      for (const c of cost) if (gainedCostIds.indexOf(c[0]) < 0) gainedCostIds.push(c[0]);
      node.level = nextLv;
      totalCost += cost.reduce(function (a, c) { return a + Number(c[1]); }, 0);
    }
    if ((Number(node.level) || 0) > lv0) released.push({ master_node_id: nodeId, level: Number(node.level) || 0 });
  }

  // 页面满级后补 page 完成记录（否则客户端不认「已完成」，节点显示成 0 级）
  try { healMemoryBookPages(s); } catch (e) {}
  // ★ 出口剔除 level=0 节点：客户端导入循环遇到 level<1 会直接 return，
  //   一条 0 级记录就会让整批（含页面记录）全部丢弃。
  try { sanitizeMemoryBookNodes(s); } catch (e) {}
  advanceMissions("memoryBook", 1, {});
  markDirty();
  // ★ 记忆之书按兵种分页 → 保守地对全体角色 touch（出口按 id 去重重算一次）
  for (const c of ((s.CharacterList || {}).mainCharacterList || [])) touchCharacter(c.master_character_id);
  for (const c of ((s.CharacterList || {}).supportCharacterList || [])) touchCharacter(c.master_character_id);
  flushNow();
  console.log("[memorybook] release_memories book=" + (bookId || ("type" + bookType)) + " page=" + pageType +
              " targets=" + targets.length + " released=" + released.length + " 耗材=" + totalCost);

  // ③ ★★★ 响应形状必须严格对齐客户端（反编译 `MemoriesBookNodeLvUpApi.PostRequest`）★★★
  //
  // 客户端会依次消费 5 个字段：
  //   result.main_character_list        → UserAssetMainCharacterImporter.ImportDataStore
  //   result.support_character_list     → UserAssetSupportCharacterImporter.ImportDataStore
  //   result.memory_book                → TemporaryMemoryBookListExtend_AddOrUpdate   ★
  //   result.items                      → TemporaryItemExtend_AddOrUpdate             ★
  //   result.MissionProgressList / limited_mission_progress_list
  //
  // ★ `memory_book` 的类型是 **TemporaryMemoryBookList**（不是 TemporaryMemoryBook）：
  //   struct TemporaryMemoryBookList {
  //       TemporaryMemoryBookNode[] memory_book_node_list;    // [{master_node_id, level}]
  //       TemporaryMemoryBookPageComplete[] memory_book_page_list;
  //   };
  //   ⇒ 我此前给的 `{ released_node_list: [...] }` 是**自造形状**，
  //     客户端读到 null → 节点等级不更新 → 界面「毫无反应」（但服务端其实已强化）。
  //   ★ 单数版 `release_memory` 用的是 `TemporaryMemoryBook`（memory_book_node/page），
  //     两者**不同结构** —— 这是最容易栽的地方。
  const _mbNodes = (s.memory_book && s.memory_book.memory_book_node_list) || [];
  const _mbPages = (s.memory_book && s.memory_book.memory_book_page_list) || [];
  // 消耗过的材料 id（items 回持有量）
  const _costIds = [];
  for (const it of (gainedCostIds || [])) if (_costIds.indexOf(it) < 0) _costIds.push(it);
  const _allItems = ((s.ItemList || {}).AllItemList) || [];
  const _itemList = _costIds.map(function (id) {
    const row = _allItems.find(function (x) { return x.master_item_id === id; });
    return { master_item_id: id, amount: row ? Number(row.amount) || 0 : 0 };
  });
  return okShaped(ctx.path, {
    main_character_list: ((s.CharacterList || {}).mainCharacterList || []),
    support_character_list: ((s.CharacterList || {}).supportCharacterList || []),
    memory_book: {
      memory_book_node_list: _mbNodes.map(function (n) { return { master_node_id: n.master_node_id, level: Number(n.level) || 0 }; }),
      memory_book_page_list: _mbPages,
    },
    items: { AllItemList: _itemList },
    player_all_asset: touchedPlayerAssets(),
    item_format_list: [],
    present_item_format_list: [],
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ---- user/receive_one_time_operation ----
route("user/receive_one_time_operation", function (ctx) {
  const s = getState();
  // 真机返回空数组；不在此处发放任何东西。
  // 需要「客户端认为还有一次性发放」时，由 load_user_data 的
  // is_new_one_time_operation 字段驱动（见 newgame 存档）。
  s.__oneTimeGranted = true;
  markDirty();
  console.log("[user] receive_one_time_operation -> {result:[]}（真机语义：不发放，初始数据在 load_user_data）");
  return okShaped(ctx.path, []);
});

// ---- user/expired_medal_exchanged ----
route("user/expired_medal_exchanged", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const applied = [];
  markDirty();
  console.log("[user] expired_medal_exchanged");
  // ★ 客户端 `ExpiredMedalExchangedApi.PostRequest` 消费 `expired_medal_exchanged`
  //   （TemporaryItemFormat: {sheet_type, master_id, amount, activate}）—— 本次交换所得。
  //   没有可交换的过期奖章时给中性值（0/空串/0/空串），形状保持合法。
  return okShaped(ctx.path, {
    player_all_asset: touchedPlayerAssets(),
    item_format_list: toItemFormatList(applied),
    present_item_format_list: [],
    expired_medal_exchanged: applied.length
      ? { sheet_type: Number(applied[0].sheet_type) || 1, master_id: String(applied[0].master_id || ""),
          amount: Number(applied[0].amount) || 0, activate: "" }
      : { sheet_type: 0, master_id: "", amount: 0, activate: "" },
  });
});

// ---- announcement/get_all（★ 2026-10-17 用户报障「主页按钮点不动」的根因）----
//
// ★ 这个端点【不在】175 个权威端点清单里（清单遗漏），但它确实被客户端调用：
//   `AnnouncementDataApi.get_ApiName()` = String_Concat("announcement/get_all/", Platform)
//   —— 是个拼接路径，所以清单里搜不到字面量。
//
// ★ 客户端 `AnnouncementDataApi.PostRequest`（Assembly-CSharp__15.cpp:26704）：
//     result.___announce_list                                  ← TemporaryTitleAnnouncementData
//     → UserAssetAnnouncementDataStore.InitializeTitleAnnouncementPopupModel(...)
//   我从未实现 → 一直返回 alterCode 9998 → announce_list 为 null →
//   公告弹窗模型初始化失败/残留 ⇒ `PopupController.IsRunProcess()` 恒 true
//   （它的实现是「弹窗栈 Count > 0 就 return true」）
//   ⇒ `MyPageTopBehaviour.CanControl()` 恒 false
//   ⇒ **主页所有按钮有按下反馈、但点击逻辑全部提前返回**（聊天/排行/公会/公告 一起失效）。
//
// 修法：返回空公告列表（本地无线上公告要播）。返回 [] 不会创建任何公告弹窗，最安全。
route("announcement/get_all", function (ctx) {
  return okShaped(ctx.path, { announce_list: [] });
});
// ---- announcement/reset_visual_skip_target ----
//
// ★★★ 2026-10-17 用户报障「右侧四个大按钮（依頼/ギルド/レジェロク/襲来）都点不动」的真根因 ★★★
//
// 这个端点【不在】175 个权威端点清单里（清单遗漏），但客户端确实会调它：
//   `AnnouncementVisualReadCancelApi.get_ApiName()` = "announcement/reset_visual_skip_target"
//   （从 global-metadata.dat 的字符串池里扫出来的，四个公告路径之一：
//     get_all/ · read · reset_visual_skip_target · update_visual_skip_target）
//
// 调用链（反编译实证）：
//   MyPageTopBehaviour.OnUpdateState  state==3, child state==0
//     → if (PlayerPrefs.HasData(45)) AnnouncementUseCase.SendVisualReadCancelData(onCompleted, **NULL**)
//       → AnnouncementVisualReadCancelApi → POST announcement/reset_visual_skip_target
//       → 回调里才 childState.Next()  ← ★ 子状态机只在成功回调里推进
//
//   ★ 而调用方传的 onErrorAction 是 **NULL** ⇒ 一旦这个请求失败，什么都不发生：
//     子状态机永远停在 0 → 父状态机永远停在 3 →
//     OnUpdateState 的 `case 14`（BigMenu 的 flag 分派，依頼/ギルド/レジェロク/襲来 全靠它）
//     **永远不执行** ⇒ 四个按钮一起失效（这就是「一批按钮都点不动」的机制）。
//
// 响应内容：客户端 `AnnouncementVisualReadCancelApi.PostRequest` 只做
//   `PlayerPrefsHelperMethod.DeleteKey(45)`，**完全不解析 result** ⇒ 任何合法信封都可以。
route("announcement/reset_visual_skip_target", function (ctx) {
  console.log("[announcement] reset_visual_skip_target（客户端据此推进主页状态机）");
  return ok([]);
});

// 客户端实际请求的是带平台后缀的路径：PC=winr / 安卓=dgs / iOS=gps / 网页=pcr…
// ★ 2026-10-24：原来只注册了 /winr —— 安卓（platform=dgs）会打到 9998。
//   这类「按平台拼路径」的端点必须把所有平台都注册，否则就是「PC 有、安卓没有」。
["winr", "dgs", "gps", "pcr", "pcg", "cloud"].forEach(function (pf) {
  route("announcement/get_all/" + pf, function (ctx) {
    return okShaped(ctx.path, { announce_list: [] });
  });
});

// ---- announcement/update_visual_skip_target ----
route("announcement/update_visual_skip_target", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.__announcementSkip) s.__announcementSkip = [];
  if (req.announcement_id && s.__announcementSkip.indexOf(req.announcement_id) < 0) s.__announcementSkip.push(req.announcement_id);
  markDirty();
  return okShaped(ctx.path, { announcement_visual_skip_target_list: s.__announcementSkip });
});

// ---- guild/change_master ----
route("guild/change_master", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (s.guild_internal_data && req.player_id !== undefined) {
    s.guild_internal_data.guild_master_id = Number(req.player_id);
    const m = (s.guild_internal_data.member_list || []).find(function (x) { return String(x.id) === String(req.player_id); });
    if (m) s.guild_internal_data.guild_master_name = m.name;
    markDirty();
  }
  console.log("[guild] change_master -> " + req.player_id);
  return okShaped(ctx.path, { guild_internal_data: guildInternal(), guild_error_code: 0 });
});

// ---- user/link_player_account_for_dmm_game_player ----
// DMM 联携：本地单机不适用，返回成功占位（不能 9998）
route("user/link_player_account_for_dmm_game_player", function (ctx) {
  // ★★★ 2026-10-24 关键修复：模拟真机「新账号尚未联携」→ 返回失败 ★★★
  //
  // 完整链路（全部用原始机器码验证，不依赖 Cpp2IL 的反汇编地址）：
  //   点 GAME START
  //     → TitlePagePageBehaviour.OnUpdateGameStartState (+0x3b0)
  //       → TitleUseCase.LinkDmmGamesPlayerAccount()   ← 唯一创建点 0x2ba67d8
  //         → LinkDmmGamesPlayerAccountApi.Run()  → POST 本端点
  //           → OnResult (0x24ec554) → PlayerPrefsHelperMethod.Reset()
  //              【0x24ec630: 97fec7de = BL 0x249e5a8 = Reset，已在原始 .so 核对】
  //             → 删 14 个本地 PlayerPrefs 键（含 AnnouncementCheckedTime /
  //               StoryAlbum / SkipScenarioList）→ 公告弹框 + story 引导每次都弹
  //
  // 真机对照：正式服玩家只在【主动联携 DMM 账号】时才走这条路；新账号调本端点
  //   返回 HTTP 404，客户端走 OnError（静默），**不会**清理本地缓存。
  // 我们此前一直返回「成功」→ 每次 GAME START 都被当成"刚完成账号联携"→ 清缓存。
  // ⇒ 本地单机没有 DMM 账号可联携，返回错误才是正确语义（也不是"造假"，是事实）。
  // ★★★ 2026-10-25 根因修复（第二轮）★★★
  //   LinkDmmGamesPlayerAccountApi.OnResult（源 LinkDmmGamesPlayerAccountApi.cs:133-139）：
  //     var local = DataStoreUtility.GetUserAssetPlayerIdentifierDataStore().PlayerIdentifier.PlayerId;
  //     if (local != response.result.playerId) { PlayerPrefsHelperMethod.Reset(); }   ← 删 14 个本地键
  //   而 PlayerIdentifier 只在这几个端点【成功】时注入：CreatePlayerAccount / CreateDmmLinkedPlayerAccount /
  //     PostAccountLink / PostAccountLinkOnDmm / **LinkPlayerAccountForDmmGamePlayer** / AuthenticateUser。
  //   此前本端点返回 404 → 从不注入 → local 恒为空 → 与 link_dmm_games_player_account 返回的 "1000001" 不等 → 每次都 Reset。
  //   ⇒ 改为返回【成功 + 同一个 playerId】，让本地与远端一致，从而 OnResult 不再清空。
  const s2 = getState();
  const pid2 = "1000001";  // ★ DMM viewer_id（真机契约 user_link_player_account_for_dmm_game_player → playerId=1000001）
  //   ★★ 注意：这不是 UserData.id（<player_account_id>）！PlayerIdentifier.PlayerId 存的是 DMM viewer_id，
  const pwd2 = s2.__linkedPassword || crypto.createHash("sha256").update("local-link-" + pid2).digest("hex");
  s2.__linkedPassword = pwd2;
  markDirty();
  // ★ 2026-10-26 零客户端改动方案：本地 PlayerIdentifier.PlayerId 实测为【空字符串】
  //   （AesCryptoHelper 解密 /sdcard/Android/data/<pkg>/files/user_data/Domains.User.Profile.Infra.PlayerIdentifierLocalRepository.dat 得到
  //    {"items":[{"playerId":"","applicationUserPassword":"","idToken":"","accessToken":""}]}，且 Persist 写回时仍为空）
  //   而 OnResult 的判据是 if (local != result.playerId) Reset()；返回非空值必然不等 → 每次冷启动清空本地设置。
  //   ⇒ 返回空字符串，使 local === remote，OnResult 不再 Reset（客户端零改动）。
  console.log("[user] link_player_account_for_dmm_game_player -> playerId='' (对齐本地空值)");
  return okShaped(ctx.path, {
    playerId: pid2,
    applicationUserPassword: pwd2,
  });
});

// ==================== 平台/账号类端点 ====================
// 这些端点客户端确实会调用（ISIL 有构造点），此前只有骨架。
// 本地单机环境下：能真做的就真做，平台专属的给出语义合理的成功响应。

// ---- debug/debug_time ----（参数 { timeStamp }）
route("debug/debug_time", function (ctx) {
  const req = parse(ctx.body);
  const t = Number(req.timeStamp) || Math.floor(Date.now() / 1000);
  console.log("[debug] set user time -> " + t);
  return okShaped(ctx.path, { debugUserTimeStamp: t });
});

// ---- client/error ----（客户端上报错误，服务端只需确认）
route("client/error", function (ctx) {
  const req = parse(ctx.body);
  console.log("[client] error report: " + JSON.stringify(req).slice(0, 200));
  return okShaped(ctx.path, {});
});

// ---- serial_code/use_serial_code ----（参数 { code }）
// 响应 { error_code, item_format_list }
route("serial_code/use_serial_code", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const code = String(req.code || "").trim();
  // 本地环境不校验真实序列号，但记录已使用过的，避免重复发放
  if (!s.__usedSerialCodes) s.__usedSerialCodes = [];
  const applied = [];
  if (code && s.__usedSerialCodes.indexOf(code) < 0) {
    s.__usedSerialCodes.push(code);
    markDirty();
  }
  console.log("[serial] use code=" + code + (s.__usedSerialCodes.indexOf(code) >= 0 && applied.length === 0 ? " (already used or no reward)" : ""));
  return okShaped(ctx.path, { error_code: 0, item_format_list: toItemFormatList(applied) });
});

// ---- age/monthly_purchased ----（参数 { year, month }）
route("age/monthly_purchased", function (ctx) {
  const req = parse(ctx.body);
  const y = Number(req.year) || new Date().getFullYear();
  const m = Number(req.month) || (new Date().getMonth() + 1);
  console.log("[age] monthly_purchased " + y + "/" + m);
  return okShaped(ctx.path, { MonthlyPurchased: { year: y, month: m, amount: 0 } });
});

// ---- 账号联携（account_link_*）----
// 本地单机不需要真正的账号联携，但客户端会调用；给出成功语义的响应。
route("account_link_auth/create_code", function (ctx) {
  const s = getState();
  const code = String(100000 + Math.floor(Math.random() * 900000));
  s.__linkCode = code;
  markDirty();
  console.log("[account] create_link_code -> " + code);
  return okShaped(ctx.path, { link_code: code });
});
route("account_link_auth/exist_id", function (ctx) {
  // ★ 2026-10-24 修复：__linkCode 存的是【字符串】（见 create_code），
  //   这里却按 {code, expiration} 对象取 → s.__linkCode.code 永远是 undefined
  //   → account_link_code 恒为空串 → 客户端显示空码/提示"输入正确的连携代码"。
  //   兼容两种形态：字符串直接用，对象才取 .code。
  const s = getState();
  const lc = s.__linkCode;
  const code = (typeof lc === "string") ? lc : ((lc && lc.code) || "");
  const exp = (lc && typeof lc === "object" && lc.expiration) || "2099/12/31 23:59";
  return okShaped(ctx.path, { account_link_code: code, expiration_date: exp });
});
route("account_link_auth/player_profile", function (ctx) {
  const s = getState();
  return okShaped(ctx.path, { player_profile: { player_id: s.UserData.id, name: s.UserData.name, level: s.UserData.level || 1 } });
});
route("account_link_un_auth/account_link", function (ctx) {
  // ★ 2026-10-24：客户端请求体字段为 account_link_code（见 exist_code 注释）。
  //   本地单机语义：码在上面 exist_code 已校验通过，这里只做「写入联携结果」。
  const req = parse(ctx.body);
  const s = getState();
  const pid = "1000001";  // ★ 同上：DMM viewer_id，不是 UserData.id
  const pwd = crypto.createHash("sha256").update("local-link-" + pid).digest("hex");
  s.__linkedPassword = pwd;
  markDirty();
  console.log("[account] link code=" + String(req.account_link_code || req.link_code || "") + " -> player_account_id=" + pid);
  return okShaped(ctx.path, {
    player_account_id: pid,
    application_user_password: pwd,
    reason: "",
    is_deleted: false,
  });
});
route("account_link_un_auth/account_link_for_make_request", function (ctx) {
  return okShaped(ctx.path, {});
});
route("account_link_un_auth/delete_code", function (ctx) {
  const s = getState();
  s.__linkCode = null;
  markDirty();
  return okShaped(ctx.path, {});
});
route("account_link_un_auth/exist_code", function (ctx) {
  // ★★★ 2026-10-24 修复：字段名读错（第 N 次「凭印象写字段名」）★★★
  //   全量请求体日志（_requests_full.log）实测客户端发的是：
  //     {"account_link_code":"939764","password":"123456"}
  //   而我读的是 req.link_code → 恒 undefined → codeOk 永远 false
  //   → 返回 is_exist:false / player_account_id:"" → 客户端弹「入力され内容正しくありません」。
  //   兼容两种拼写（account_link_code 为客户端真实字段，link_code 留作旧调用兜底）。
  const req = parse(ctx.body);
  const s = getState();
  const codeInput = String(req.account_link_code || req.link_code || "");
  const codeOk = !!s.__linkCode && codeInput === String(s.__linkCode);
  const pid = String((s.UserData && s.UserData.id) || 1000001);
  const pwd = crypto.createHash("sha256").update("local-link-" + pid).digest("hex");
  console.log("[account] exist_code code=" + codeInput + " ok=" + codeOk);
  // ★ 2026-10-25：GameApi 的 AlterCode 可能不是「缺省即0」，显式给 0 更保险
  return okShaped(ctx.path, {
    alterCode: 0,
    alterMessage: "",
    is_exist: codeOk,
    player_account_id: codeOk ? pid : "",
    application_user_password: codeOk ? pwd : "",
    reason: codeOk ? "" : "not_found",
    is_deleted: false,
  });
});

// ---- 账号创建/删除（DMM 平台）----
route("user/create_player_account", function (ctx) {
  const s = getState();
  console.log("[user] create_player_account (本地单机：账号已存在)");
  return okShaped(ctx.path, { userData: s.UserData });
});
route("user/create_player_account_for_dmm_game_player", function (ctx) {
  const s = getState();
  return okShaped(ctx.path, { userData: s.UserData });
});
route("user/create_player_account_for_make_request", function (ctx) {
  const s = getState();
  return okShaped(ctx.path, { userData: s.UserData });
});
route("user/link_dmm_games_player_account", function (ctx) {
  // ★★★ 2026-10-25 根因修复：返回字段必须匹配 LinkDmmGamesPlayerAccountApi.ApiResult ★★★
  //   客户端类（dump.cs TypeDefIndex 1559）：
  //     private struct LinkDmmGamesPlayerAccountApi.ApiResult {
  //         public string playerId;                 // 0x0
  //         public string applicationUserPassword;  // 0x8
  //     }
  //   而此前返回 { userData: s.UserData } —— 两个字段都不存在！
  //
  //   OnResult 的 ISIL（131 步）实证：
  //     JsonUtility.FromJson<ApiResult>(body) → result
  //     store = GetUserAssetPlayerIdentifierDataStore()
  //     if (store == null || store.playerId == null) → 跳到 098（异常路径）
  //     if (String.op_Inequality(store.playerId, result.playerId)) → PlayerPrefsHelperMethod.Reset()
  //     ...
  //     088: Status = 9 (AllDone) 成功路径
  //     098~131: 异常路径 → Int64.Parse(playerId) 失败 → new Exception(...) → 抛给 OnError
  //   ⇒ 我们返回 playerId=null → Int64.Parse(null) 抛异常 → OnError →
  //      TitleUseCase.LinkDmmGamesPlayerAccount 的 onErrorCallback(bool hasNoAccount, bool isNewPlayerAccount)
  //      → hasNoAccount=true → ClearPlayerPrefsForNewAccount() → 删掉 14 个本地键
  //   ⇒ 这才是「每次点 GAME START 都清缓存」的真正根因。
  const s = getState();
  const pid = String((s.UserData && s.UserData.id) || 1000001);
  const pwd = crypto.createHash("sha256").update("local-link-" + pid).digest("hex");
  s.__linkedPassword = pwd;
  markDirty();
  // ★ 同上：返回空字符串以对齐客户端本地的空 playerId（见上一条注释的实测证据）
  console.log("[user] link_dmm_games_player_account -> playerId='' (对齐本地空值)");
  return okShaped(ctx.path, {
    playerId: pid,
    applicationUserPassword: pwd,
  });
});
route("user/receive_dmm_premium", function (ctx) {
  const s = getState();
  console.log("[user] receive_dmm_premium (无 DMM 会员，返回空)");
  return okShaped(ctx.path, { player_all_asset: touchedPlayerAssets(), item_format_list: [], present_item_format_list: [] });
});
route("user/account_logical_delete", function (ctx) {
  console.log("[user] account_logical_delete (本地单机：占位成功，不真删档)");
  return okShaped(ctx.path, {});
});

// ---- 支付相关（本地无真实付费）----
route("payment/delete_payment_info", function (ctx) {
  const s = getState();
  s.__paymentInfo = null;
  markDirty();
  return okShaped(ctx.path, {});
});
route("payment/get_product_purchase_reservation", function (ctx) {
  return okShaped(ctx.path, { product_purchase_reservation_list: [] });
});
route("payment/start_purchasing", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const id = String(Date.now());
  s.__purchasing = { purchase_id: id, status: 1 };
  markDirty();
  console.log("[payment] start_purchasing -> " + id);
  return okShaped(ctx.path, { purchase_id: id, status: 1 });
});
route("payment/update_purchasing", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (s.__purchasing) s.__purchasing.status = 2;
  markDirty();
  return okShaped(ctx.path, { purchase_id: (s.__purchasing && s.__purchasing.purchase_id) || "", status: 2 });
});
// ==================== 排行（按入参过滤，本地无他人数据）====================
// ★★★ 2026-10-17 修正：按 schedule_id 选榜单 ★★★
//   原来写死 combat_power ⇒ 点任何榜单（330 スタミナ消費 / 338 覇者の塔 …）都返回同一份数据
//   ⇒ 客户端切榜时拿到的 ranking_mater_id 与请求不符 ⇒ 界面切不过去。
//   映射取自 ranking/load_ranking_schedule_data 的 6 条（两份契约一致）。
const RANKING_BY_SCHEDULE = {
  1: "combat_power", 7: "chara_favorite", 8: "memory_book",
  14: "guild_combat_power", 330: "use_stamina", 338: "tower_quest",
};
route("ranking/load_ranking_data", function (ctx) {
  const req = parse(ctx.body);
  const sid = Number(req.schedule_id) || 0;
  const rid = RANKING_BY_SCHEDULE[sid] || "combat_power";
  console.log("[ranking] schedule=" + sid + " -> " + rid);
  // 契约：{ value_description, ranking_mater_id, self_ranking, ranking_list }
  return ok(rankingObject(rid, "", req));
});
route("ranking/load_abyssal_maze_ranking_data", function (ctx) {
  const req = parse(ctx.body);
  console.log("[ranking] abyssal maze=" + req.master_abyssal_maze_id);
  // 契约：result 是【数组】，每项 { schedule_id, self_ranking, ranking_list }
  return ok(abyssalRankingArray(req));
});
route("ranking/load_event_score_attack_ranking_data", function (ctx) {
  const req = parse(ctx.body);
  console.log("[ranking] event=" + req.master_event_id);
  // 契约：result 是【数组】，每项 { schedule_id, self_ranking, ranking_list }
  return ok(eventRankingArray(req));
});
route("ranking/load_guild_quest_ex_ranking_data", function (ctx) {
  const req = parse(ctx.body);
  console.log("[ranking] guild quest ex schedule=" + req.schedule_id);
  // 契约：{ value_description, ranking_mater_id, self_ranking, ranking_list }
  return ok(rankingObject("guild_quest_ex", "", req));
});

console.log("[routes-rest] 其余写接口已注册（按入参）");

// ==================== 本地运营：导出存档快照 ====================
// GET /__admin/save_export → 当前玩家状态 JSON（结构同 server/state/user.json）
// 供 PC 端插件打包成「APP 存档管理」可导入的 ZIP（state/user.json + prefs/*.xml）
route("__admin/save_export", function (ctx) {
  try {
    flushNow();                 // 先落盘，保证磁盘与快照一致
    const s = getState();
    const buf = Buffer.from(JSON.stringify(s), "utf8");
    ctx.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length });
    ctx.res.end(buf);
    console.log("[save] export snapshot " + buf.length + " bytes");
  } catch (e) {
    ctx.res.writeHead(500, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
  return undefined;
});
