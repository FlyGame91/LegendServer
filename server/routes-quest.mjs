// 战斗 / 任务 / 扭蛋 / 商店 / 背包 写接口：全部按入参修改状态。
import { buildQuestResultTemp, dropsForQuest, needRankExpFor, ensureUserQuest, questGroupTypeOf, questGroupSetOf, questRow, reEventBossDropId, convertReEventDrops } from "./quest-result.mjs";
import { dailyRewardLimitFor, weeklySkipLimitFor, userDailyClearLimit } from "./campaign.mjs";
import fs from "node:fs";
import path from "node:path";
import { route, ok, shapedForPath, okShaped } from "./server.mjs";
import { loadTable } from "./masterdata.mjs";
import { levelForCharacter, requiredExpFor, refreshCharacterStatus, currentLevelProgress, expToNextLevel } from "./character.mjs";
import { grantGuildExp, updateTowerQuestRecord, advanceTutorialStage, characterLevelCap, getState, markDirty, findCharacter, addItem, addStone, addStamina, addPlayerExp, applyRewards, toItemFormatList, playerAllAssetFor, itemsFromRequest, flushNow, advanceMissions, guildInternal, touchedPlayerAllAsset, touchedPlayerAssets, invasionQuestSlots, touchedItemIds, dailyRewardReceivedCount, bumpDailyRewardReceived, dailyClearCount, bumpDailyClear, autoSellResults, consumeItems, currentItemCount, bumpWeeklySkip } from "./state.mjs";
import { rewardsForMissions, resolveRewardId, rollRewardId } from "./rewards.mjs";

const HERE = path.dirname(process.argv[1] || ".");
function parse(b) { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } }

// ---------- 任务主表（消耗体力 / 奖励定义）----------
let questTbl = null;
// 任务表可能有多个（主线/支线/活动/深渊/神谕…）。
// 早期只查 Quest/Quest.csv —— 该文件不存在，导致 questRow 永远返回 null，
// 于是体力消耗、金币、角色经验全为 0（战斗结算形同虚设）。
// ★ 任务数据分散在 13+ 张表里（没有统一的 Quest.csv）。
//   漏表的后果实证：**Quest/MasterQuest.csv 曾被漏掉** →
//     questRow("MasterQuest_Soldier_05") 返回 null →
//     掉落/金币/经验全部算成 0（契约里 quest/skip 那次的 exp_to_gold=3000、normal_drop=11 条）。
//   排查方法：遍历 MasterData 的 Quest/*.csv，找出「含 QuestId 列但未在此列表」的表。
//   （注意 MasterQuest.csv 的列名是 QuestId，与 MainQuest 等一致，漏掉纯粹是人工枚举不全。）

let questCache = null;

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// ==================== クラスチャレンジ：挑戦券（通行证）====================
// ★★★ 2026-10-22 用户报障：「通行证没扣减」★★★
//   权威数据链：
//     ① GroundRule.csv 的 Item_ChallengeTicket_Id = "Item_Ticket_ChallengeQuest"
//        （客户端 CommonHeaderBehaviour.SetChallengeCoinText 就是读这条规则 + GetUserItemCount，
//          所以战斗界面右上角那个数字 = 挑战券数量）
//     ② ClassChallengeQuest.csv 的 ConsumeChallengeCoin = 每次挑战消耗的张数（Ccq_* 均为 1）
//     ③ Item/ItemList.csv：Item_Ticket_ChallengeQuest 名称「チャレンジチケット」，
//        说明「クラスチャレンジクエストに挑むためのチケット」
//   旧实现：quest/start 只扣体力（クラスチャレンジ的 ConsumeStamina=0），券一张没扣 ——
//   玩家打多少场都是 500 张。
function challengeTicketId() {
  try {
    const t2 = loadTable("GroundRule/GroundRule.csv");
    const r = ((t2 && t2.rows) || []).find(function (x) { return String(x.RuleName || "") === "Item_ChallengeTicket_Id"; });
    if (r && r.Value) return String(r.Value);
  } catch (e) {}
  return "Item_Ticket_ChallengeQuest";
}

/** 扣挑战券（クラスチャレンジ专用）。返回实际扣掉的张数；非クラスチャレンジ返回 0。 */
function payChallengeTickets(s, questId, times) {
  const cc = classChallengeRow(questId);
  if (!cc) return 0;
  const need = num(cc.ConsumeChallengeCoin) * Math.max(1, Math.floor(Number(times) || 1));
  if (need <= 0) return 0;
  const tid = challengeTicketId();
  const have = currentItemCount(s, tid);
  const paid = Math.min(need, have);
  if (paid > 0) consumeItems(s, [{ id: tid, amount: paid }]);
  if (paid < need) {
    console.warn("[quest] 挑战券不足 " + tid + " 需要" + need + " 持有" + have + "（仍放行，扣 " + paid + "）");
  }
  console.log("[quest] class-challenge 挑战券-" + paid + " -> " + currentItemCount(s, tid));
  return paid;
}

/** 该任务若是クラスチャレンジ，返回其主表行；否则 null。 */
function classChallengeRow(questId) {
  if (!questId) return null;
  try {
    const t2 = loadTable("Quest/ClassChallengeQuest.csv");
    const rows = (t2 && t2.rows) || [];
    return rows.find(function (x) { return String(x.QuestId || "") === String(questId); }) || null;
  } catch (e) { return null; }
}

/**
 * userData + last_battle_formation —— 契约要求 quest/skip* 的 userData 里含编成快照。
 * 真字段是 UserData.last_battle_formation（{battle_formation, action_priority, formation_id}）；
 * 缺失时从 battle_formation_list[0] 兜底（形状一致）。
 */
/**
 * 自动出售结果 —— 契约形状：
 *   { auto_sell_master_item_id, auto_sell_amount, gained_item_info: [{master_item_id, amount}] }
 * 语义：本次掉落中【符合玩家自动出售设置】的道具被自动卖掉，换成金币/炼金币。
 * 数据源：state.__autoSellSet（由 baggage/set_auto_sell_item 写入）。
 * 单机默认未开启 → 返回空数组（诚实，不编造）。
 */
function autoSellResult(s, drops) {
  const set = s.__autoSellSet;
  if (!set || !set.length || !drops || !drops.length) return [];
  const out = [];
  for (const d of drops) {
    if (set.indexOf(d.master_id) < 0) continue;
    out.push({
      auto_sell_master_item_id: d.master_id,
      auto_sell_amount: d.amount || 1,
      gained_item_info: [{ master_item_id: "Item_Currency_alchemyCoin", amount: (d.amount || 1) * 5 }],
    });
  }
  return out;
}

function withLastFormation(s) {
  const u = s.UserData || {};
  let lbf = u.last_battle_formation;
  if (!lbf) {
    const bf = (s.battle_formation_list || [])[0];
    const info = bf && bf.battle_formation_info_list;
    lbf = info
      ? { battle_formation: info.battle_formation || [], action_priority: info.action_priority || [], formation_id: info.formation_id || [] }
      : { battle_formation: [], action_priority: [], formation_id: [] };
  }
  return Object.assign({}, u, { last_battle_formation: lbf });
}

// ==================== quest/start ====================
// 请求：{ questId, ... }。行为：扣体力，返回可进入的战斗信息。
// 契约 daily_reward_received_list 是【数组的数组】（每个任务组一条已领取奖励 id 列表），
// 而存档里的同名字段是 { quest_group_set_id, daily_reward_received_count } 对象数组 ——
// 两者【语义不同】，不可直接回传（早期直接回传导致 TYPE 不符）。
function localDailyRewardReceived() {
  const s2 = getState();
  const n = ((s2.daily_reward_received_list || []).length) || 0;
  const out = [];
  for (let i = 0; i < n; i++) out.push([]);
  return out;
}

route("quest/start", function (ctx) {
  const req = parse(ctx.body);
  // ★ 真机 quest/start 也携带 tutorialProgressType（1/5/9…），必须推进教程阶段
  try { advanceTutorialStage(req.tutorialProgressType); } catch (e) {}
  const s = getState();
  const row = questRow(req.questId);
  const cost = num(row && (row.ConsumeStamina || row["消費スタミナ"]));
  if (cost > 0) addStamina(-cost);
  // ★ クラスチャレンジ：扣挑战券（通行证）。见上方 challengeTicketId 的注释。
  payChallengeTickets(s, req.questId, 1);
  // 记录当前进行中的任务，供 quest/end 使用
  s.__currentQuest = req.questId;
  // 新的一关开始 → 清掉上一场战斗的「已计数」标记（防止 battle/win 后客户端掉线、
  // quest/end 没到，导致下一次正规通关被误判为重复计数）
  s.__battleClearedQuest = null;
  markDirty();
  console.log("[quest] start " + req.questId + " stamina-" + cost + " -> " + s.UserData.stamina);
  // ★★ quest_seed 必须与真机一致：`{"quest_seed":""}`（空串）★★
  //   真机契约（battle 关也不例外）返回的就是空串；而我此前返回随机数字串 →
  //   客户端把「非空 seed」当成「本关有战斗」，于是对【无 BattleId 的纯剧情关】
  //   （如 Main_003_02_s，MasterQuest.BattleId 为空）也去加载战斗场景 ⇒
  //   `BattleScene.Model.ModelRoot..ctor` 抛 NullReferenceException（SetupModelRoot 传入
  //   restoredUnitModelList=NULL）⇒ 打断 ResourceCache.Update 的回调 ⇒ 该资源永久留在
  //   loading 缓存 ⇒ 每帧重插同一 key ⇒ `ArgumentException: key 已存在` 无限刷屏 ⇒ 加载卡 100%。
  return okShaped(ctx.path, { quest_seed: "" });
});

// ==================== battle/start ====================
route("battle/start", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  s.__currentBattle = req.battleId;
  s.__currentQuestId = req.questId;
  markDirty();
  console.log("[battle] start quest=" + req.questId + " battle=" + req.battleId);
  // 契约 result 是空数组 []
  return ok([]);
});

// ==================== battle/win ====================
// 请求含战斗结果。行为：发经验/金币/掉落，更新任务进度。
/** 复刻活动券：1 点体力 = 1 张（真机契约实证，见 quest-result.mjs 的 RE_EVENT_TICKET_ID 注释）。 */
function grantEventTickets(amount) {
  const n = Math.round(Number(amount) || 0);
  if (n <= 0) return 0;
  try { applyRewards([{ sheet_type: 1, master_id: "Item_Re_EventTicket", amount: n }]); } catch (e) {}
  return n;
}

/**
 * 深渊赛季编号（用于 StageClear 奖励表：Reward_AbyssMaze_Drop_01_01_StageClear_XX）。
 * 权威：state.__maze.abyssal_maze.master_season_id（如 Season_12_08 → 12）；
 *       回退到 AbyssalMaze.csv 的 ScheduleId。
 */
function abyssSeasonNo(mz) {
  try {
    const sid = String(((mz || {}).abyssal_maze || {}).master_season_id || "");
    const m = sid.match(/(\d+)/);
    if (m) return Number(m[1]);
  } catch (e) {}
  try {
    const mazeId = String(((mz || {}).abyssal_maze || {}).master_abyssal_maze_id || "");
    const t = loadTable("AbyssalMaze/AbyssalMaze.csv");
    const row = ((t && t.rows) || []).find(function (r) { return String(r.AbyssalMazeId) === mazeId; });
    if (row && Number(row.ScheduleId) > 0) return Number(row.ScheduleId);
  } catch (e) {}
  return 12;
}

route("battle/win", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const qid = req.questId || s.__currentQuestId;
  const row = qid ? questRow(qid) : null;
  const gold = num(row && (row.AcquireGold || row["獲得ゴールド"]));
  const pExp = num(row && (row.AcquirePlayerRankExp || row["獲得プレイヤーランク経験値"]));
  const cExp = num(row && (row.AcquireExp || row["獲得経験値"]));

  // 战斗结算的「战斗前」快照（契约 quest_result_temp 需要 before/after 对比）
  // ★ 字段名必须用 UserData 的【真实字段】：level / exp ——
  //   TemporaryUserData 的声明是 { id, name, ..., level, exp, master_rank, ... }，
  //   【没有】rank / rank_exp 这两个字段（早期误用，导致 before/after 恒为默认值）。
  //   before_need_user_rank_exp / after_need_user_rank_exp 来自 Fusion/UserRankLevelUp.csv 的 NeedExp。
  const beforeStamina = s.UserData.stamina || 0;
  const beforeRank = s.UserData.level || 1;
  const beforeRankExp = s.UserData.exp || 0;
  const rankTable = loadTable("Fusion/UserRankLevelUp.csv");
  const rankRows = (rankTable && rankTable.rows) ? rankTable.rows : [];
  const needRankExpFor = function (lv) {
    const r = rankRows.find(function (x) { return Number(x.Lv) === Number(lv); });
    return r ? Number(r.NeedExp || 0) : 0;
  };
  const beforeNeedRankExp = needRankExpFor(beforeRank + 1);

  const applied = [];
  if (gold) applied.push({ sheet_type: 1, master_id: "Item_Currency_Gold", amount: gold });
  applyRewards(applied);
  // 这两个数组在【try 块外】声明，供响应组装使用 ——
  // 掉落计算在 try 里，若把变量声明在 try 内，响应组装处会 ReferenceError。
  const dropIds = [];
  const appliedIds = applied.map(function (a) { return a.master_id; });
  if (pExp) addPlayerExp(pExp);

  // 【角色经验】—— 契约 quest_result_temp.add_character_exp 与 character_exp_info_list。
  // 参战角色（主线 + 支援）各得 cExp 经验；支援角色也涨（与游戏一致）。
  const participantIds = [].concat(
    Array.isArray(req.mainCharacterIdList) ? req.mainCharacterIdList : [],
    Array.isArray(req.supportCharacterIdList) ? req.supportCharacterIdList : []
  );
  const charExpInfo = [];
  const touchedChars = [];
  for (const cid of participantIds) {
    const ch = findCharacter(cid);
    if (!ch) continue;
    const beforeLevel = ch.level || 1;
    const beforeTotal = ch.exp || 0;          // 存档字段 = 【累计经验】
    // ★★★ 语义修正（2026-10-14）★★★
    //   契约 character_exp_info_list 的 beforeExp/afterExp 是【本级内进度】，
    //   而存档的 ch.exp 是【累计】—— 两者语义不同（本项目已记录过此类陷阱）。
    //   实证：Ch011102101 lv114 存档 exp=7621365，累计(114)=7620724
    //        → 本级进度 = 641 = 契约 battle/win 的 beforeExp ✓ 精确吻合
    //   同理 beforeRequiredExp = 【升到下一级】所需（= 单级(beforeLevel+1)），
    //     不是「本级已消耗量」。
    //   早期直接把累计值填进去 → 客户端进度条显示成 7621365/300000（错误）。
    const beforeExp = currentLevelProgress(ch.master_character_id, beforeTotal);
    const requiredBefore = expToNextLevel(ch.master_character_id, beforeLevel);
    if (cExp > 0) ch.exp = beforeTotal + cExp;
    // 按经验曲线重算等级（与 character/enhance 同源）
    let newLevel = levelForCharacter(ch.master_character_id, ch.exp);
    // ★★ 角色等级上限 = 玩家 RANK ★★（2026-10-20 实录实证）
    //   真机 rank 3 时角色最高 3 级（82_resp: 两只主角 Lv3）；客户端显示的 "Lv 4/3" 就是超限。
    //   上限值来自 character_exp_info_list[].maxLevel —— 真机在 rank 2 那场战斗里给的是 2。
    //   ⇒ 必须按【结算后的玩家 rank】封顶，并把经验截到该等级所需。
    const levelCap = characterLevelCap();   // 玩家 RANK + 大师等级加成（见 state.mjs）
    if (newLevel > levelCap) {
      newLevel = levelCap;
      ch.exp = Math.min(ch.exp, requiredExpFor(ch.master_character_id, levelCap));
    }
    ch.level = newLevel; refreshCharacterStatus(ch);
    charExpInfo.push({
      characterId: cid,
      beforeLevel: beforeLevel,
      afterLevel: ch.level,
      beforeExp: beforeExp,
      beforeRequiredExp: requiredBefore,
      afterExp: currentLevelProgress(ch.master_character_id, ch.exp),
      afterRequiredExp: expToNextLevel(ch.master_character_id, ch.level),
      maxLevel: levelCap,
    });
    touchedChars.push(ch);
  }

  // 记录通关（quest/end 之外的兜底）
  if (!s.UserQuestList) s.UserQuestList = [];
  let q = qid ? s.UserQuestList.find(function (x) { return x.MasterQuestId === qid; }) : null;
  // ★ 统一经 ensureUserQuest（6 字段齐全 + MasterQuestType 查表，收口）
  if (qid && !q) q = ensureUserQuest(s, qid);
  if (q) {
    q.TotalClearCount = (q.TotalClearCount || 0) + 1;
    // ★ 2026-10-22：标记「本关的通关次数已由 battle/win 计入」——
    //   紧随其后的 quest/end(is_clear) 不得再加一次（见 quest/end 的说明）。
    s.__battleClearedQuest = qid;
    // ★ 2026-10-22 用户报障「star force quest 通关没扣次数」：
    //   B 型（周上限）关卡——星骑士/职业挑战/复刻/活动——**出击通关也吃本周额度**。
    try {
      const _mech = questMechanism(s, qid, row);
      if (_mech && _mech.kind === "WEEKLY" && _mech.set && Number(_mech.questType) === 11) {
        const _c = bumpWeeklySkip(_mech.set, 1);
        console.log("[weekly] 出击通关 → " + _mech.set + " 本周 " + _c + "/" + _mech.weeklyLimit);
      }
    } catch (e) {}
  }

  // 计算掉落：普通掉落来自 DropRewardId，首通额外给 FirstClearRewardId。
  const normalDrops = [];
  const firstClearDrops = [];
  // ★ 首通判定提到 try 外 —— 复刻券的发放规则要用它（见下面的 eventTicketAmount）
  let isFirstClear = false;
  try {
    // ★ 掉落 RewardId 的【约定式命名】：Reward_Drop_<BattleId>
    //   实证：Reward/RewardList.csv 里有 113 条 Reward_Drop_Main_<...>（另有 Sub/Sp/Invasion/
    //   Equipment/Character 等族，共 9950 条）。主线 334 个有 BattleId 的任务中 113 个能匹配上。
    //   ★ 两点必须诚实说明：
    //     ① Quest 表的 DropRewardId 列【全 477 行都是空】——静态定义不在 Quest 表；
    //     ② 真机契约的 normal_drop_list 里出现 Gold 1342/95000/95000/130000 这类数值，
    //        在 MasterData 里【查不到】对应条目 ⇒ 那是【服务端战斗随机掉落】，无静态数据源。
    //   故本实现：能按命名匹配到的用真表数据；匹配不到的为空（诚实，不编造）。
    // ★ 复刻活动的挑战关用 ReEventRewardList 的表（点数 2 倍且是 Item_Re_EventPoint）
    const dropId = reEventBossDropId(qid, row) || (row && row.DropRewardId) || (qid ? "Reward_Drop_" + qid : "");
    // ★ 掉落同样要【掷骰】（RewardType=2 Random，6 个实际子表 + 1 个 Display）——
    //   与 quest-result.mjs 的 dropsForQuest 保持一致（那里已用 rollRewardId）。
    //   注：首通奖励（下面 fcId）是 `RewardType=1`（Decision 固定）→ 继续用 rewardsForRewardId 正确。
    if (dropId) for (const x of rollRewardId(dropId)) {
      normalDrops.push({ sheet_type: x.sheetType || 1, master_id: x.master_id, amount: x.amount || 1 });
    }
    // ★ 复刻活动：原活动点数（Item_Eventpoint_XX）→ Item_Re_EventPoint（原活动商店全是空的，点数用不了）
    if (normalDrops.length) {
      // ★ 用副本：convertReEventDrops 可能原样返回同一个数组（非复刻活动），
      //   直接 length=0 会把结果一起清掉（StarForce 掉落消失就是这么来的）。
      const _conv = convertReEventDrops(normalDrops.slice(), qid);
      normalDrops.length = 0;
      for (const x of _conv) normalDrops.push(x);
    }
    // ★★★ 2026-10-23：深渊「コイン加算量」★★★
    //   真机实证（_winr_capture/contracts_winr/battle_win.json，AbyssalMaze_quest174）：
    //     基础表 Reward_AbyssMaze_Drop_02_01_Coin = Item_Currency_AbyssCoin x200
    //     实得 normal_drop_list = Item_Currency_AbyssCoin **220** = 200 × 1.1
    //   ⇒ 深渊的硬币掉落要乘 BattleCategoryGroup.CoinAddAmount（本赛全部 1.1）。
    //   我们此前不乘 → 每场固定 200，与真机差 10%，且不同层看起来完全一样。
    if (/^AbyssalMaze_/i.test(String(qid || ""))) {
      let coinAdd = 1.1;
      try {
        const catId = String(req.abyssalMazeBattleCategoryId || "");
        const bgT = loadTable("AbyssalMaze/BattleCategoryGroup.csv");
        const catRow = catId ? ((bgT && bgT.rows) || []).find(function (r) { return String(r.BattleCategoryId) === catId; }) : null;
        if (catRow && Number(catRow.CoinAddAmount) > 0) coinAdd = Number(catRow.CoinAddAmount);
      } catch (e) {}
      for (const d of normalDrops) {
        if (d.master_id === "Item_Currency_AbyssCoin") d.amount = Math.round((Number(d.amount) || 0) * coinAdd);
      }
      console.log("[abyss] コイン加算量 ×" + coinAdd + "（" + String(req.abyssalMazeBattleCategoryId || "-") + "）");
    }
    const q2 = s.UserQuestList.find(function (x) { return x.MasterQuestId === qid; });
    const isFirst = q2 && (q2.TotalClearCount || 0) <= 1;
    isFirstClear = !!isFirst;
    // ★ 2026-10-21：SubQuest.csv 的表头含换行/引号，列名解析不稳定 ⇒ FirstClearRewardId 常读不到。
    //   按真机命名规则兜底：Reward_Firstclear_<questId>（RewardList.csv 实证存在）。
    const fcId = (row && row.FirstClearRewardId) || ("Reward_Firstclear_" + qid);
    if (isFirst && fcId) for (const x of resolveRewardId(fcId)) {
      firstClearDrops.push({ sheet_type: x.sheetType || 1, master_id: x.master_id, amount: x.amount || 1 });
    }
    // 把掉落真正发给玩家
    const allDrops = firstClearDrops.concat(normalDrops);
    if (allDrops.length) applyRewards(allDrops);
    for (const d of allDrops) dropIds.push(d.master_id);
  } catch (e) { console.error("[battle] drop calc failed: " + e.message); }

  // ★★★ 2026-10-21：战斗（出击）也必须发放/消耗【每日报酬】★★★
  //   用户报障：「出击和 skip 其实都是消耗 daily 次数的，但你这里出击不消耗」。
  //   依据：Quest/QuestDailyReward.csv 按 QuestType 定义 DailyRewardLimit；
  //        客户端也有 MaxDailyReward / CurrentDailyReward 两个字段驱动界面「デイリー報酬 X/Y」。
  //   ⇒ 出击 = 1 次消耗：有剩余额度就掷 1 次 daily 掉落并 +1 计数，额度为 0 则不发。
  const dailyDrops = [];
  try {
    const hasDaily = !!(row && (row.DailyRewardId || row["デイリー報酬ID"]));
    const set0 = questGroupSetOf(qid);
    if (hasDaily && set0) {
      const qt0 = questGroupTypeOf(qid);
      const limit = Number(dailyRewardLimitFor(qt0, set0)) || 0;
      const got = Number(dailyRewardReceivedCount(set0)) || 0;
      const remain = Math.max(0, limit - got);
      if (remain > 0) {
        const dd = dropsForQuest(row, qid, 1, 1);
        for (const x of dd.dailyDrops) dailyDrops.push(x);
        if (dailyDrops.length) applyRewards(dailyDrops);
        bumpDailyRewardReceived(set0);
        console.log("[battle] 每日报酬已发放并消耗 1 次（" + (got + 1) + "/" + limit + "）");
      } else {
        console.log("[battle] 每日报酬额度已用完（" + got + "/" + limit + "）→ 不发");
      }
    }
  } catch (e) { console.error("[battle] daily reward failed: " + e.message); }

  // ★★★ 2026-10-23：深渊「10 层阶段奖励」★★★
  //   权威 1：AbyssalMaze.csv 的 RewardObtainmentText
  //     「10ステージクリアごとに対象からランダムで入手できます。」
  //   权威 2：Reward/RewardList.csv 有 12 张 StageClear 表（每赛季一张，随机 SSR 装备）：
  //     Reward_AbyssMaze_Drop_01_01_StageClear_01..12 → Reward_AbyssMaze_Drop_XX_01_StageClear_01
  //   我们此前完全没实现 → 用户看到永远只有固定 4 件（コイン/强化材料），层数毫无存在感。
  const stageClearDrops = [];
  try {
    if (/^AbyssalMaze_/i.test(String(qid || ""))) {
      const mz = s.__maze || {};
      const cleared = Array.isArray(mz.cleared_battles) ? mz.cleared_battles.length : 0;
      const layerNo = cleared + 1;   // 本场是第几层（quest/end 之后才计入 cleared）
      if (layerNo % 10 === 0) {
        if (!Array.isArray(mz.__stageClearGranted)) mz.__stageClearGranted = [];
        if (mz.__stageClearGranted.indexOf(layerNo) < 0) {
          const seasonNo = abyssSeasonNo(mz);
          const rid = "Reward_AbyssMaze_Drop_01_01_StageClear_" + String(seasonNo).padStart(2, "0");
          for (const x of rollRewardId(rid)) {
            stageClearDrops.push({ sheet_type: x.sheetType || 1, master_id: x.master_id, amount: x.amount || 1 });
          }
          if (stageClearDrops.length) {
            applyRewards(stageClearDrops);
            mz.__stageClearGranted.push(layerNo);
            markDirty();
            console.log("[abyss] " + layerNo + " 层阶段奖励（season " + seasonNo + "）→ " +
              stageClearDrops.map(function (d) { return d.master_id + "x" + d.amount; }).join(", "));
          }
        }
      }
    }
  } catch (e) { console.error("[abyss] stage clear failed: " + e.message); }

  // 组装 quest_result_temp（契约 29 字段，覆盖关键的数值对）
  // ★ 组装收口到 quest-result.mjs 的 buildQuestResultTemp（与 quest/skip* 共用同一实现）——
  //   避免「5 个端点同形状字段、只有 1 个实现」的漏改（早期只 battle/win 有组装）。
  // ★ 2026-10-23：公会经验 = 消耗体力 × 次数（真机契约实证，见 state.mjs grantGuildExp）
  let gExpRes = { before: { level: 0, exp: 0 }, after: { level: 0, exp: 0 }, add: 0 };
  try { gExpRes = grantGuildExp((Number(row && (row.ConsumeStamina || row["消費スタミナ"])) || 0) * 1); } catch (e) { console.error("[guild] exp: " + e.message); }
  const qrt = buildQuestResultTemp({
    before: { rank: beforeRank, rankExp: beforeRankExp, stamina: beforeStamina, guildLevel: gExpRes.before.level, guildExp: gExpRes.before.exp },
    after: { rank: s.UserData.level, rankExp: s.UserData.exp, stamina: s.UserData.stamina, guildLevel: gExpRes.after.level, guildExp: gExpRes.after.exp },
    addGuildExp: gExpRes.add,
    addUserRankExp: pExp,
    userRank: (s.UserData || {}).level || 0,   // ★ exp_to_gold 仅在 RANK 满级时产生
    addCharacterExp: cExp,
    characterExpInfo: charExpInfo,
    firstDrops: firstClearDrops,
    normalDrops: normalDrops,
    dailyDrops: dailyDrops,
    stageClearDrops: stageClearDrops,
    // ★ exp_to_gold：满级玩家按任务体力折算（战斗恒 1 次）
    questStamina: num(row && (row.ConsumeStamina || row["消費スタミナ"])), expToGoldTimes: 1,
    // ★ 复刻券 = 体力消耗 × 1 次
    // ★★★ 2026-10-22 用户口径（权威，且与真机契约不冲突）：★★★
    //   · 首通 = 固定 10 张 **+** 体力消耗份（1 点体力 = 1 张）
    //   · 重复 = 只有体力消耗份
    //   ⇒ 体力为 0 的首通，就正好只有那 10 张。
    //
    //   实证核对：
    //     contracts/battle_win.json = Main_2nd_171_01_m，ConsumeStamina=0，
    //       event_ticket_drop_list = [{Item_Re_EventTicket, amount:10}]  → 10 + 0 = 10 ✓
    //     quest_skip 契约 体力30 × 54 次 = 1620 张（skip 只能打在已通关关卡上 ⇒ 重复口径）✓
    //     skip_sub_quest_bulk 体力15 × 7 次 → 105 × 4 条 ✓
    eventTicketAmount: grantEventTickets(
      (isFirstClear ? 10 : 0) + num(row && (row.ConsumeStamina || row["消費スタミナ"]))
    ),
  });
  s.__questResultTemp = qrt;

  // 推进任务进度（战斗类），并把变化的任务返回给客户端。
  // 只有 MissionContentType 与「战斗」相关的任务会被推进（见 state.mjs 的 MISSION_KINDS）。
  // ★ 临时诊断（2026-10-21）：把客户端上报的评分/挑战/宝箱字段原样打到日志，
  //   用于确认サブクエスト的 achievementList / trialList / 宝箱 结构后再实现持久化与发奖。
  try {
    console.log("[bw.req] " + JSON.stringify({
      questId: qid,
      clearTurn: req.clearTurn,
      achievementList: req.achievementList,
      trialList: req.trialList,
      simulationTreasureEventIdList: req.simulationTreasureEventIdList,
      deadCharacterIdList: req.deadCharacterIdList,
      remainingHpList: req.remainingHpList,
      keys: Object.keys(req)
    }).slice(0, 1200));
  } catch (e) {}

  // ★★ 2026-10-21：サブクエスト 的【星级评价 / 挑战 / 宝箱】持久化 + 挑战奖励 ★★
  //   真机上报结构（用户实机 battle/win 抓包）：
  //     "achievementList":[{"battleConditionId":"BattleCondition_Def_Sub_Achievement_01","index":0}, ...]
  //     "trialList":[{"battleConditionId":"Sub_01_01_Normal_b_01","index":0,
  //                   "rewardId":"Reward_Trial_Sub_01_01_Normal_b_01"}, ...]
  //   持久化结构（客户端反编译 TemporaryQuestAchievement / TemporaryQuestTrial）：
  //     {quest_type, MasterQuestId, MasterAchievementId, BattleId, AchievementIndex}
  //     {quest_type, MasterQuestId, MasterTrialId,       BattleId, TrialIndex}
  //   早期实现完全没写这两个容器 ⇒ 界面永远 ★0 / 挑戦 0/2，挑战奖励也从不发。
  try {
    const qtype = (function () {
      const qq = (s.UserQuestList || []).find(function (x) { return x.MasterQuestId === qid; });
      return qq ? Number(qq.MasterQuestType) || 2 : 2;
    })();
    const battleId = req.battleId || qid;
    if (!Array.isArray(s.AchievementList)) s.AchievementList = [];
    if (Array.isArray(req.achievementList)) {
      for (const a of req.achievementList) {
        const mid = a && a.battleConditionId;
        const idx = Number(a && a.index) || 0;
        if (!mid) continue;
        const dup = s.AchievementList.some(function (x) {
          return x && x.MasterQuestId === qid && x.MasterAchievementId === mid && Number(x.AchievementIndex) === idx;
        });
        if (dup) continue;
        s.AchievementList.push({ quest_type: qtype, MasterQuestId: qid, MasterAchievementId: mid, BattleId: battleId, AchievementIndex: idx });
        console.log("[battle] 星级达成 " + qid + " " + mid + "#" + idx);
      }
    }
    // —— 宝箱（secret treasure）：真机字段 simulationTreasureEventIdList ——
    //   持久化结构（反编译 TemporaryQuestTreasureBox）：
    //     {quest_type, master_quest_id, master_secret_treasure_id}
    //   奖励：RewardList.csv 里按命名 <questId>_Box_01 存在（实证 Sub_01_01_Normal_b_Box_01）。
    if (!Array.isArray(s.userQuestTreasureBox)) s.userQuestTreasureBox = [];
    if (Array.isArray(req.simulationTreasureEventIdList)) {
      for (const tid of req.simulationTreasureEventIdList) {
        if (!tid) continue;
        const dup = s.userQuestTreasureBox.some(function (x) {
          return x && x.master_quest_id === qid && x.master_secret_treasure_id === tid;
        });
        if (dup) continue;
        s.userQuestTreasureBox.push({ quest_type: qtype, master_quest_id: qid, master_secret_treasure_id: tid });
        console.log("[battle] 宝箱记录 " + qid + " " + tid);
        // 奖励 id 就是宝箱事件 id 本身；若表里没有，再退回 <questId>_Box_01
        try {
          let rw = resolveRewardId(tid);
          if (!rw || !rw.length) rw = resolveRewardId(qid + "_Box_01");
          if (rw && rw.length) { applyRewards(rw); console.log("[battle] 宝箱奖励 " + tid + " x" + rw.length); }
          else console.log("[battle] 宝箱奖励未找到: " + tid);
        } catch (e) { console.error("[battle] 宝箱奖励失败: " + e.message); }
      }
    }
    if (!Array.isArray(s.TrialList)) s.TrialList = [];
    if (Array.isArray(req.trialList)) {
      for (const t of req.trialList) {
        const mid = t && t.battleConditionId;
        const idx = Number(t && t.index) || 0;
        if (!mid) continue;
        const dup = s.TrialList.some(function (x) {
          return x && x.MasterQuestId === qid && x.MasterTrialId === mid && Number(x.TrialIndex) === idx;
        });
        if (dup) continue;
        s.TrialList.push({ quest_type: qtype, MasterQuestId: qid, MasterTrialId: mid, BattleId: battleId, TrialIndex: idx });
        // 挑战奖励：请求里直接带了 rewardId（真机行为），首次达成才发
        if (t.rewardId) {
          try {
            const rw = resolveRewardId(t.rewardId);
            if (rw && rw.length) { applyRewards(rw); console.log("[battle] 挑战奖励 " + t.rewardId + " x" + rw.length); }
          } catch (e) { console.error("[battle] 挑战奖励失败 " + t.rewardId + ": " + e.message); }
        }
      }
    }
  } catch (e) { console.error("[battle] 星级/挑战记录失败: " + e.message); }

  const missionChanged = advanceMissions("battle", 1, { questId: qid, battleId: req.battleId });

  // ★★ 2026-10-20：记录「上一次使用的编队」★★
  //   真机 battle/win 请求体里就带着编队：
  //     mainCharacterIdList / supportCharacterIdList / actionPriority / formationId
  //     mstPresetId（预置 id，-1 表示无） / isUpdatePreset（是否把本次编队存成预置）
  //   而 UserData.last_battle_formation 正是同形状的三数组
  //     {"battle_formation":[...], "action_priority":[...], "formation_id":[...]}
  //   我们原来把这几个字段全丢了 ⇒ last_battle_formation 永远停在建号时的两只教学角色
  //   ⇒ 用户每次进战斗都要重新编队（用户报障）。
  //   语义：last_battle_formation 永远更新为「最近一次出战编队」；
  //         battle_formation_list（玩家预置）仅在 isUpdatePreset=true 时更新，避免覆盖玩家手工预置。
  try {
    const mains = Array.isArray(req.mainCharacterIdList) ? req.mainCharacterIdList : [];
    const prio = Array.isArray(req.actionPriority) ? req.actionPriority : [];
    const fids = Array.isArray(req.formationId) ? req.formationId : [];
    if (mains.length) {
      const info = { battle_formation: mains.slice(), action_priority: prio.slice(), formation_id: fids.slice() };
      s.UserData.last_battle_formation = info;
      // ★★ 2026-10-21：编队按【任务类型】分档保存 ★★
      //   真机结构 battle_formation_list[i].type = {has_setting, quest_type, quest_group_id, quest_id}
      //   ⇒ 同类型任务共用一条编队记录（用户预期：「同类型 quest 应该会保存编队」）。
      //   早期只维护一条全局记录（quest_type=0），导致换类型打一场就把别的类型编队覆盖/丢失。
      const qtype = questGroupTypeOf(qid) || 0;
      const qgroup = questGroupSetOf(qid) || "";      // 如 SP_EXP / MAIN_ALL
      if (!Array.isArray(s.battle_formation_list)) s.battle_formation_list = [];
      // ★★ 2026-10-21：三档都要写 ★★
      //   反编译 UserAssetBattleFormationDataStore 的加载分支：按 type 里
      //   quest_id / quest_group_id / quest_type 分别存入不同的字典，
      //   取时「最具体优先」。只写最泛的一档（quest_type）时，若客户端先按
      //   quest_group_id（如 SP_EXP_003）查，就会查不到 → 编成界面空白。
      //   故：类型档 + 组档 + 关卡档 各写一条，任何查找路径都能命中。
      // ★ 2026-10-21 追加：客户端可能按【任务组 id】(QuestGroupId, 如 SP_FAVORITE_004)
      //   而不是【任务组集合 id】(QuestGroupSetId, 如 SP_Favorite) 查找 —— 两种都写。
      const qgroupId = String((row && (row.QuestGroupId || row["クエストグループID"])) || "");
      const scopes = [
        { quest_type: qtype, quest_group_id: "", quest_id: "" },
        { quest_type: qtype, quest_group_id: qgroup, quest_id: "" },
        { quest_type: qtype, quest_group_id: qgroup, quest_id: qid },
      ];
      if (qgroupId && qgroupId !== qgroup) {
        scopes.push({ quest_type: qtype, quest_group_id: qgroupId, quest_id: "" });
        scopes.push({ quest_type: qtype, quest_group_id: qgroupId, quest_id: qid });
      }
      for (const sc of scopes) {
        let slot = s.battle_formation_list.find(function (x) {
          const t = (x && x.type) || {};
          return Number(t.quest_type) === sc.quest_type
            && String(t.quest_group_id || "") === sc.quest_group_id
            && String(t.quest_id || "") === sc.quest_id;
        });
        if (!slot) {
          s.battle_formation_list.push({ type: { has_setting: true, quest_type: sc.quest_type, quest_group_id: sc.quest_group_id, quest_id: sc.quest_id }, battle_formation_info_list: info });
        } else {
          slot.type.has_setting = true;
          slot.battle_formation_info_list = info;
        }
      }
      console.log("[battle] 编队已按三档保存：type=" + qtype + " group=" + qgroup + " quest=" + qid + "（" + mains.length + " 人）");
      if (req.isUpdatePreset === true || Number(req.mstPresetId) >= 0) {
        console.log("[battle] 客户端标记了 isUpdatePreset/mstPresetId=" + req.mstPresetId);
      }
      console.log("[battle] last_battle_formation ← " + mains.length + " 人");
    }
  } catch (e) { console.error("[battle] 记录编队失败: " + e.message); }

  // ★ 2026-10-22：覇者の塔 —— 通关一层必须写 TowerQuestRecord，否则界面「最高記録 -F」永远不动
  try {
    if (/^TOWER_/i.test(String(qid || ""))) {
      const r = updateTowerQuestRecord(s, qid);
      if (r) console.log("[tower] 记录更新 -> " + r.CurrentQuestGroupId + " " + r.CurrentClearedFloor + "F（最高 " + r.HighestFloor + "F）");
    }
  } catch (e) { console.error("[tower] 记录更新失败: " + e.message); }
  markDirty();
  flushNow();   // 关键操作：立即落盘，不等防抖
  console.log("[battle] win quest=" + qid + " gold+" + gold + " pexp+" + pExp + " cexp+" + cExp + " chars=" + touchedChars.length + " missions=" + missionChanged.length);
  return okShaped(ctx.path, {
    quest_result_temp: s.__questResultTemp,
    daily_reward_received: [],
    mainCharacterList: touchedChars.filter(function (c) { return (s.CharacterList.mainCharacterList || []).indexOf(c) >= 0; }),
    supportCharacterList: touchedChars.filter(function (c) { return (s.CharacterList.supportCharacterList || []).indexOf(c) >= 0; }),
    // player_all_asset = 本次战斗【实际变动的道具】的当前持有量：
    // 含 AcquireGold + 掉落（normal_drop / first_drop）。
    // 早期只传 applied（仅金币）→ AcquireGold=0 的关卡恒为空。
    player_all_asset: touchedPlayerAssets(), auto_sell_item_list: autoSellResults(),
    userData: withLastFormation(s),
    userQuestTreasureBox: s.userQuestTreasureBox || [],
    TowerQuestRecord: s.TowerQuestRecord || null,
    InvasionQuestSlot: invasionQuestSlots(),
    // ★ 契约实证：items.AllItemList 与 player_all_asset.AllItemList 【内容相同】
    //   （都是本次变动的道具持有量，如 Gold / AbyssSoul / EventTicket）。
    //   早期用 itemsFromRequest(req) —— 而 battle/win 的请求只有角色 id，没有道具字段 → 恒空。
    items: playerAllAssetFor([...touchedItemIds()]),
    justReleasedQuestGroupId: null,
    battle_formation_list: s.battle_formation_list || [],
    abyssal_maze: null, abyssal_maze_selectable_door_list: null,
    abyssal_maze_selectable_effect_list: null, abyssal_maze_cleared_battle: null,
    challenge_character_list: null, event_score_attack: null,
    auto_sell_item_list: autoSellResult(s, normalDrops.concat(firstClearDrops)),
    MissionProgressList: missionChanged,
    limited_mission_progress_list: [],
    // ★ 2026-10-21：把星级/挑战回给客户端（否则界面不刷新）
    achievementList: s.AchievementList || [],
    trialList: s.TrialList || [],
    userQuestTreasureBox: s.userQuestTreasureBox || [],
    guild_internal_data: guildInternal(),
  });
});
// ==================== battle/fail ====================
route("battle/fail", function (ctx) {
  const s = getState();
  console.log("[battle] fail");
  return okShaped(ctx.path, { MissionProgressList: [], limited_mission_progress_list: [], userData: s.UserData });
});

// ==================== quest/end ====================
// 请求：{ quest_id, is_clear, ... }。行为：记录通关次数、发首通奖励。
/**
 * 主線任务 → 本次应下发的「機能解放」编号列表。
 *
 * 数据源：ReleaseContentsSetting/ReleaseContentsSetting.csv
 *   位置: Version(0) No(1) PartId(2) ChapterId(3) SectionId(4) PlayerRank(5)
 *         ContentName(6) IsNotify(7) AdvId(8) SubTutorialType(9) UnlockContent(10)
 *   文件前两行都是表头（日文 + 英文），数据从第 3 行开始。
 *
 * 规则（真机录制实证）：
 *   · 清掉「第N章 第1節」时，下发 ChapterId == N 的全部 No；
 *   · 只在【首次通关】时下发（TotalClearCount === 1），避免每次重复弹引导。
 *   实证：#27 quest/end(Main_001_01_m) → [1,11]；#46 → [2]；#63 → [3]。
 *
 * @returns {number[]} 释放编号（客户端再按编号查 setting 得到内容 id）
 */
let _releaseRows = null;
function releaseSettingRows() {
  if (_releaseRows) return _releaseRows;
  _releaseRows = [];
  try {
    const p = "game_data/masterdata/ReleaseContentsSetting/ReleaseContentsSetting.csv";
    const lines = String(fs.readFileSync(p, "utf8")).split(/\r?\n/).filter(function (l) { return l.trim(); });
    for (let i = 2; i < lines.length; i++) {
      const c = lines[i].split(",");
      _releaseRows.push({
        No: Number(c[1]), ChapterId: Number(c[3]), SectionId: Number(c[4]), UnlockContent: c[10],
      });
    }
  } catch (e) { console.error("[release] 读表失败: " + e.message); }
  return _releaseRows;
}

/**
 * 主线关卡 → {章, 節}。
 * ★ 2026-10-21 修：原来用 questId 的正则解析（Main_018_09_m → 误判 18 章 9 节），
 *   而真正的章节在 MainQuest.csv 的「章 / 節」列（该关卡是 53 章 1 节）。
 *   后果：清掉「第54話」时本应解锁 No=17「記憶の書解放」(内容302)，却回了空 → 客户端卡在解锁引导。
 */
let _mainQuestIdx = null;
function mainQuestInfo(questId) {
  if (!_mainQuestIdx) {
    _mainQuestIdx = new Map();
    try {
      const p2 = "game_data/masterdata/Quest/MainQuest.csv";
      const text = String(fs.readFileSync(p2, "utf8"));
      // 简易 CSV 解析（该表含带换行的引号字段）
      const rows = []; let row = [], cur = "", q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ",") { row.push(cur); cur = ""; }
        else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
        else if (c !== "\r") cur += c;
      }
      if (cur || row.length) { row.push(cur); rows.push(row); }
      for (const r of rows) {
        const id = r[2];
        if (!id || !/^Main_/.test(id)) continue;
        _mainQuestIdx.set(id, { chapter: Number(r[6]) || 0, section: Number(r[7]) || 0 });
      }
    } catch (e) { console.error("[release] MainQuest 读表失败: " + e.message); }
  }
  return _mainQuestIdx.get(String(questId || "")) || null;
}

function unlockContentsFor(questId, isFirstClear) {
  try {
    const info = mainQuestInfo(questId);
    if (!info) {
      // 非主线（或表里没有）→ 不臆造
      return [];
    }
    const chapter = Number(info.chapter) || 0;
    if (!chapter) return [];
    // ★ 补发语义：把「章 <= 当前章 且 節=1」的所有解锁里、玩家尚未读过的都下发。
    //   这样即使之前漏发（本次修复前的数据），下一次 quest/end 也会补出来；
    //   已读的由 contents_release_read_list 过滤，不会重复弹。
    const read = new Set(((getState().contents_release_read_list) || []).map(function (x) { return Number(x); }));
    // 只补【最近一条】未读解锁（章节号最大的那批），避免一次性弹十几个引导：
    //   客户端的功能解锁本身是按任务进度算的，这里只是"弹一次提示"，补最新一条即可。
    // ★★★ 2026-10-22：改为【精确章节匹配】★★★
    //   真机契约实证（_fwd run-2026-09-29-06-15-15）：
    //     第1章 → unlock_content_list [1,11]（两行 ChapterId 都是 1）
    //     第2章 → [2]、第3章 → [3]
    //   ⇒ 只在该关卡所属章节等于配置里的 ChapterId 时才下发。
    //   原来的「≤ chapter 取最大一批」会在第 56 章之后**每次都回 [18]** →
    //   客户端反复弹「サブクエスト第4部解放」。
    const cand = releaseSettingRows()
      .filter(function (r) { return Number(r.ChapterId) === chapter && r.SectionId === 1 && !read.has(Number(r.UnlockContent)); });
    const out = cand.map(function (r) { return r.No; });
    if (out.length) console.log("[release] " + questId + "（章" + chapter + "）解锁功能编号 " + JSON.stringify(out));
    return out;
  } catch (e) { return []; }
}

route("quest/end", function (ctx) {
  const req = parse(ctx.body);
  // ★ 真机 quest/end 携带 tutorialProgressType（3/7/11…）
  try { advanceTutorialStage(req.tutorialProgressType); } catch (e) {}
  const s = getState();
  const qid = req.quest_id;
  // ★ 统一经 ensureUserQuest —— 它不仅新建（6 字段齐全 + MasterQuestType 查表），
  //   还会【修复已存在的旧记录】（补 DailySkipCount / DailyItemUseCount / MasterQuestType）。
  //   早期这里只在新建时补齐字段，存档里已有的 4 字段旧记录不会被修 →
  //   quest/end 响应里 quests[] 元素缺字段 → 客户端打完关卡点 NEXT 卡死。
  const first = !(s.UserQuestList || []).some(function (x) { return x.MasterQuestId === qid; });
  const q = ensureUserQuest(s, qid, num(req.quest_type));
  // ★★★ 2026-10-22：通关次数【一关一次】★★★
  //   真机契约实证（contracts/user_load_user_data.json 的 322 条主线记录）：
  //     TotalClearCount = 1 的有 318 条、2 的有 3 条、3 的有 1 条
  //   ⇒ 正常打一遍只 +1。而我们的流程是 battle/win → quest/end 两个请求都会加，
  //     结果「打一遍 = 2」（存档里 57 条主线有 15 条是 2，全是走我们服务端打的）。
  //   修法：battle/win 已经计过数的关卡，quest/end 不再重复计（剧情关没有 battle/win，
  //   仍然由 quest/end 计一次）。
  // 覇者の塔：quest/end 也兜一次（防止某条链路只有 quest/end 没有 battle/win）
  try {
    if (req.is_clear && /^TOWER_/i.test(String(qid || ""))) updateTowerQuestRecord(s, qid);
  } catch (e) {}
  const alreadyCounted = s.__battleClearedQuest === qid;
  if (alreadyCounted) s.__battleClearedQuest = null;
  if (req.is_clear) {
    if (!alreadyCounted) {
      q.TotalClearCount = (q.TotalClearCount || 0) + 1;
      // ★ 2026-10-22：没有 battle/win 的链路（剧情关之外都走 battle/win，这里兜底）也要吃周额度
      try {
        const _m2 = questMechanism(s, qid, questRow(qid));
        if (_m2 && _m2.kind === "WEEKLY" && _m2.set && Number(_m2.questType) === 11) bumpWeeklySkip(_m2.set, 1);
      } catch (e) {}
    }
    q.DailyClearCount = (q.DailyClearCount || 0) + 1;
  }
  // ★ 2026-10-22：深渊迷宫通关 → 记一层 cleared（now_position 由 cleared 数推导）
  try {
    if (/^AbyssalMaze_/i.test(String(qid)) && req.is_clear) {
      const mz = s.__maze;
      if (mz) {
        if (!Array.isArray(mz.cleared_battles)) mz.cleared_battles = [];
        if (!mz.cleared_battles.some(function (x) { return String(x.master_quest_id) === String(qid); })) {
          const door = mz.selected_door || {};
          mz.cleared_battles.push({
            master_abyssal_maze_id: String((mz.abyssal_maze || {}).master_abyssal_maze_id || ""),
            master_battle_category_id: String(door.master_battle_category_id || ""),
            master_quest_id: String(qid),
            coin_add_amount: 1.1,
          });
          // ★ 2026-10-23：累计通关日志（限定任务 MissionContentType=57「○○強化効果の扉をN回クリア」用）
          //   cleared_battles 会因深渊重置被清空，所以另存一份只增不减的日志。
          if (!Array.isArray(s.__abyssClearLog)) s.__abyssClearLog = [];
          s.__abyssClearLog.push({ quest_id: String(qid), battle_category_id: String(door.master_battle_category_id || ""), at: Date.now() });
          if (s.__abyssClearLog.length > 5000) s.__abyssClearLog = s.__abyssClearLog.slice(-5000);
          if (mz.abyssal_maze) mz.abyssal_maze.highest_position = Math.max(Number(mz.abyssal_maze.highest_position) || 0, mz.cleared_battles.length + 1);
          // ★★★ 2026-10-22：通关后必须把「已选门/已选效果」清掉 ★★★
          //   客户端 AbyssalMazeMainPageBehaviour.UpdateView 里算门的禁用状态是：
          //     isDisable = (door.door_id != abyssal_maze.selected_door_id)  —— ISIL 932~943 实证
          //   （位在 `[rdi+0x148] → [rax+0x48]` 的已选门对象，和 `[rsi+0x10]` 的门 id 比较）
          //   ⇒ 只要 selected_door_id 还留着上一层的门 id，另外两扇门就被灰掉、点不了。
          //   用户报障：「其他两个门不让我选」、「每关的难度都应该是独立选择的」。
          mz.abyssal_maze.selected_door_id = 0;
          mz.abyssal_maze.selected_effect_id = 0;
          mz.selected_door = null;
          mz.selected_effect = null;
          console.log("[abyss] 通关记录 +1（共 " + mz.cleared_battles.length + " 层）quest=" + qid);
        }
      }
    }
  } catch (e) {}
  const mpChanged = advanceMissions("quest", 1, { questId: req.quest_id || req.questId });
  markDirty();
  flushNow();   // 关键操作：立即落盘，不等防抖
  console.log("[quest] end " + qid + " clear=" + !!req.is_clear + " total=" + q.TotalClearCount + (first ? " (first)" : ""));
  // ★ limited_mission_progress_list 不能恒空 —— 数据就在 state 里（40 条）。
  //   真机契约 quest/end 返回 6 条（活动限定任务的进度快照）。
  //   早期恒空 → 客户端拿不到活动任务进度，打完关卡点 NEXT 后界面无法继续（卡死）。
  return okShaped(ctx.path, {
    quests: [q],
    // ★★ 2026-10-21：本次新解锁的功能（客户端据此弹「機能解放」引导）★★
    //   真机实证（录制 #27/#46/#63）：清掉「主線 第N章 第1節」时下发该章的解锁编号，
    //   客户端弹引导，弹完调 contents_release/read 标记已读。
    //   早期恒回 [] ⇒ 引导永远不弹（用户报障）。
    unlock_content_list: unlockContentsFor(qid, q.TotalClearCount === 1),
    MissionProgressList: mpChanged,
    // ★ 增量语义：真机 quest/end 返回 6 条【本次变化的限定任务】，不是全量 40 条。
    //   本端点不做限定任务推进（advanceMissions 只管普通任务）→ 无变化 → 空数组。
    //   语义同 MissionProgressList。（详见 routes-read.mjs 里 load_mypage_data 的说明）
    limited_mission_progress_list: [],
  });
});
route("quest/end_adv", function (ctx) {
  const req = parse(ctx.body);
  console.log("[quest] end_adv " + req.quest_id);
  // 契约 result 是空数组 []
  return ok([]);
});

// ==================== quest/skip 系列 ====================
// ★ quest/skip —— 按契约补全 quest_result_temp（与 battle/win 同形 29 字段）。
//   契约实证：quest/skip 的 quest_result_temp 里有 normal_drop_list[11] / daily_drop_list[9] /
//   gold_quest_defeated_enemy_reward_list[9] / exp_to_gold_list[1] —— 早期我只扣体力、
//   其余全场，故 4 处 drop 字段在审计里恒空。组装已收口到 quest-result.mjs。
// ★★★ まとめてskip（isBulkSkip）的次数计算 —— 唯一实现（2026-10-15 新增）★★★
//
// 用户需求（原话）：
//   「まとめてskip应该一次性消耗掉：剩余体力/每次消耗 的通关次数，并发放对应次数的奖励，
//     如果剩余可skip次数不足，则只扣除剩余次数的skip，并返还多扣除的体力」
//
// 语义：客户端发 `isBulkSkip=true` + `skipCount=0` 时，表示「尽可能多地跳」，
//   具体跳几次由【服务端】算 —— 客户端只提供意图，不提供次数。
//   （反编译实证：QuestSkipApi 只把 5 个字段打包成 JSON，无任何次数的本地计算；
//     调用点 QuestUseCase.TrySkipQuest(questType, questId, isBulkSkip, skipCount) 直接透传。）
//
// 两个上限（取较小值）：
//   ① 体力上限 = floor(当前体力 / 每次消耗)
//   ② 周上限   = weeklySkipLimitFor(...) − 本周已跳次数（limit 为 0 表示不限制）
//
// ★ 关于「返还多扣除的体力」：
//   正确做法是【先算 min 再扣】，天然不会多扣 —— 无需先扣后返还。
//   用户提到「返还」是因为他预期实现可能先按体力算完再发现周上限不够；
//   这里直接先取 min，效果等价且更简单。
//
// @returns {{ n, byStamina, byWeek, cost, clamped }} 实际次数与两个来源上限
/**
 * ★★★ 关卡机制判定（2026-10-15 用户说明后重写）★★★
 *
 * 用户原话（权威）：
 *   「不扣体力是因为它属于每日奖励，每个 master quest 每天有两次免费通关的机会，
 *    注意这个通关是包括你出击通关和 skip 通关两种形式的，消耗完每日免费次数就开始正常计算体力消耗，
 *    并且每日的免费通关掉率也不一样，这是一种减负机制……此外不止 master quest，sp quest 也有这种机制。」
 *   「star force quest 不同，它没有每日免费奖励，它是以周为单位限制周 skip 次数，
 *    关卡没有出击次数限制，但是限制每周的 skip 次数，类似设计的还有 class challenge quest、复刻 event、活动 event。」
 *   「还有第三种设计，就是 sub quest，它也没有每日免费奖励，但它不是限制周 skip 次数而是限制每天的通关次数，
 *    注意我的用词，我说的是通关次数，意味着不管是 skip 还是出击，都有次数限制。」
 *
 * ⇒ 三类机制（判据按【数据特征】而非 questType，更稳）：
 *   | 类型 | 判据 | 代价 |
 *   |---|---|---|
 *   | **A 每日免费通关** | 任务表有 `DailyRewardId`（MasterQuest 40/40、SpQuest 168/180）| 免费次数内不扣体力；用完扣体力；**skip 无上限** |
 *   | **B 周 skip 上限** | `QuestSkip.csv` 该 questType 有 `WeeklySkipLimit`（StarForce 70 / ClassChallenge 30 / ReEvent 200 / EVE 70）| 受周剩余限制；**不扣体力** |
 *   | **C 每日通关上限** | 任务表有 `DailyQuestClearLimit`（SubQuest 168/216、EventQuest 425/8239）| 受每日剩余限制；**扣体力** |
 *
 * ★ 我此前的错误（用户报障的直接原因）：
 *   把 A 型的「每日免费通关次数」当成了「**skip 次数上限**」→ 免费次数用完就返回 n=0，
 *   导致「本日あと 2 回」用完后**再也跳不动**（而正确行为是继续消耗体力跳过）。
 *   同时**完全不扣体力** → 即使超出免费次数也不付费。
 */
export function questMechanism(state, questId, row) {
  // ★ 2026-10-23：公会任务（Guild_*）单独一类
  //   GuildQuest.csv 里 ConsumeStamina=0、DailyQuestClearLimit=0、无 DailyRewardId
  //   ⇒ 旧逻辑落到 kind=NONE，bulkSkipCount 只给 1 次（用户报障：まとめてskip 只能跳 1 次）
  if (/^Guild_/i.test(String(questId || ""))) {
    return { kind: "GUILD", questType: questGroupTypeOf(questId), set: questGroupSetOf(questId), dailyLimit: 0, dailyClearLimit: 0, weeklyLimit: 0 };
  }
  const qt = questGroupTypeOf(questId);
  const set = questGroupSetOf(questId);
  const hasDailyReward = !!(row && (row.DailyRewardId || row["デイリー報酬ID"]));
  // ★ 每日通关上限 = 表里的基础值 + LimitPlus 加成（权威链见 campaign.mjs 的 userDailyClearLimit）
  //   实测：普通关 20+4=24、boss关 5+4=9 —— 与用户界面「本日あと N 回」逐项吻合。
  const dailyClearLimit = userDailyClearLimit(state, qt, row);
  const weeklyLimit = set ? weeklySkipLimitFor(state, qt, set) : 0;
  const kind = hasDailyReward ? "FREE"
             : dailyClearLimit > 0 ? "DAILYCLEAR"
             : weeklyLimit > 0 ? "WEEKLY"
             : "NONE";
  return {
    kind: kind,
    questType: qt,
    set: set,
    dailyLimit: hasDailyReward ? dailyRewardLimitFor(qt, set) : 0,   // A 型：每日免费通关次数（含活动加成）
    dailyClearLimit: dailyClearLimit,                                // C 型：每日通关上限
    weeklyLimit: weeklyLimit,                                        // B 型：每周 skip 上限
  };
}

/**
 * 计算本次 skip 的【次数】与【体力消耗】。
 *
 * ★ 三类机制各自的公式（依据用户说明 + 真机样本）：
 * ```
 * A 每日免费通关（MasterQuest / SpQuest）：
 *     n_free = max(0, 每日免费次数限额 − 今日已用)          ← 界面「デイリー報酬 N/N」
 *     n_paid = cost>0 ? floor(体力 / cost) : 0              ← 免费次数用完后的付费部分
 *     n      = n_free + n_paid                              ← ★ 无 skip 上限
 *     体力扣 = max(0, n − n_free) × cost                    ← 只有超出免费的次数才付费
 * B 周 skip 上限（StarForce / ClassChallenge / ReEvent / 活动Event）：
 *     n      = max(0, 周上限 − 本周已跳)
 *     体力扣 = 0                                            ← 真机 29 样本实证 Δ=0
 * C 每日通关上限（SubQuest / 部分 EventQuest）：
 *     n      = max(0, 每日通关上限 − 今日已通关)
 *     n      = min(n, floor(体力 / cost))                   ← 体力也要够
 *     体力扣 = n × cost
 * ```
 *
 * ★ 交叉验证：
 *   · MasterQuest（截图：体力 20、cost 30、免费剩 2）→ n = 2 + floor(20/30)=0 → **跳 2、Δ体力 0** ✅
 *   · STARFORCE（真机：体力 4、周剩 54）→ n = 54、Δ0 ✅
 *   · SubQuest bulk（真机：cost 15、limit 5、跳 7）→ 受每日上限约束
 */
export function bulkSkipCount(state, opts) {
  const cost = Math.max(0, Number(opts.cost) || 0);
  const stamina = Math.max(0, Number(state.UserData && state.UserData.stamina) || 0);
  const mech = opts.mech || { kind: "NONE" };
  const want = Math.max(0, Number(opts.want) || 0);
  let n = 0, staminaCost = 0, freeUsed = 0;
  let nFree = 0, nPaid = 0, used = 0;

  if (mech.kind === "FREE") {
    used = opts.dailyUsed || 0;
    nFree = Math.max(0, mech.dailyLimit - used);
    nPaid = cost > 0 ? Math.floor(stamina / cost) : 0;
    n = nFree + nPaid;
    // 本次请求只想要 want 次时按 want 截断（skipCount>0 的显式请求）
    if (want > 0) n = Math.min(n, want);
    freeUsed = Math.min(n, nFree);
    staminaCost = Math.max(0, n - freeUsed) * cost;
  } else if (mech.kind === "DAILYCLEAR") {
    used = opts.dailyClearToday || 0;
    n = Math.max(0, mech.dailyClearLimit - used);
    if (cost > 0) n = Math.min(n, Math.floor(stamina / cost));
    if (want > 0) n = Math.min(n, want);
    staminaCost = n * cost;
  } else if (mech.kind === "WEEKLY") {
    const wkUsed = (state.__weeklySkip && state.__weeklySkip[mech.set]) || 0;
    n = Math.max(0, mech.weeklyLimit - wkUsed);
    if (want > 0) n = Math.min(n, want);
    staminaCost = 0;   // ★ B 型不消耗体力（真机实证）
  } else if (mech.kind === "GUILD") {
    // 公会任务：无体力消耗、无每日/每周上限（主数据三项全 0）
    // 「まとめてskip」时客户端发 skipCount=0 → 取一个安全上限 10 次/请求
    n = want > 0 ? want : 10;
    staminaCost = 0;
  } else {
    // 无任何配置 → 保守 1 次（避免无限刷）
    n = want > 0 ? want : 1;
    staminaCost = 0;
  }
  n = Math.max(0, Math.floor(n));
  if (n === 0) staminaCost = 0;
  return {
    n: n,
    kind: mech.kind,
    staminaCost: staminaCost,
    freeUsed: freeUsed,
    nFree: nFree,
    nPaid: nPaid,
    used: used,
    weeklyLimit: mech.weeklyLimit || 0,
    dailyLimit: mech.dailyLimit || 0,
    dailyClearLimit: mech.dailyClearLimit || 0,
    clamped: want > 0 && n < want,
  };
}
/**
 * ★ 组装 quest/skip 家族共用的两个「额度回执」字段（2026-10-15 收口）。
 *
 * 为什么抽出来：这两个字段在【早退分支】（无可跳次数）与【成功路径】各写了一份，
 *   早期早退分支硬编码 `[]` / `null` → 额度用完时客户端拿不到计数，
 *   界面无法显示「本日あと 0 回」，表现为「按钮还能点但没反应」。
 *
 * @returns {{daily_reward_received: object|Array, WeeklySkipQuest: object|null}}
 */
function skipQuotaReceipt(s, questId, row, n) {
  const hasDaily = !!(row && (row.DailyRewardId || row["デイリー報酬ID"]));
  const gid = questGroupSetOf(questId);
  const daily = hasDaily && gid
    ? { quest_group_set_id: gid, daily_reward_received_count: dailyRewardReceivedCount(gid) }
    : [];   // 无 DailyRewardId 的任务给 []（真机 StarForce 实证）
  let weekly = null;
  if (gid) {
    // 累加本周跳过次数（★ 只在真的跳了时累加；n=0 表示本次没跳）
    if (n > 0) {
      if (!s.__weeklySkip) s.__weeklySkip = {};
      s.__weeklySkip[gid] = (s.__weeklySkip[gid] || 0) + n;
    }
    weekly = {
      MasterQuestGroupSetId: gid,
      MasterQuestType: questGroupTypeOf(questId),
      WeeklySkipCount: (s.__weeklySkip && s.__weeklySkip[gid]) || 0,
    };
  }
  return { daily_reward_received: daily, WeeklySkipQuest: weekly };
}
route("quest/skip", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const row = questRow(req.questId);
  const cost = num(row && (row.ConsumeStamina || row["消費スタミナ"]));
  // ★★★ まとめてskip（2026-10-15）★★★
  //   客户端发 isBulkSkip=true + skipCount=0 → 语义是「尽可能多地跳」，次数由服务端算。
  //   两个上限取较小值：① 体力支持的次数 ② 本周剩余可跳次数。
  //   详见 bulkSkipCount 的说明。
  const wantN = Math.max(0, num(req.skipCount) || 0);
  // ★★★ 次数上限（2026-10-15 修正：体力不参与）★★★
  //   ① 周剩余（QuestSkip.WeeklySkipLimit）
  //   ② 每日报酬剩余（仅对有 DailyRewardId 的任务）—— 对应界面「本日あと N 回」
  const set0 = questGroupSetOf(req.questId);
  const qt0 = questGroupTypeOf(req.questId);
  // ★★★ 关卡机制（A 每日免费通关 / B 周skip上限 / C 每日通关上限）★★★
  const mech = questMechanism(s, req.questId, row);
  const hasDaily = mech.kind === "FREE";
  let n, bulkInfo = null;
  // ★★★ 2026-10-22 修正（用户报障：「skip 65 次后体力不降反增、完全不扣体力」）★★★
  //   旧实现只在「isBulkSkip 或 skipCount=0」时才走 bulkSkipCount（体力就是在那里算的），
  //   而客户端的「スキップ回数選択」弹窗发的是【显式 skipCount=N】（isBulkSkip 缺省 false）
  //   → 走 else 分支 n = wantN，bulkInfo 恒 null → stamCost 恒 0 → 一次都没扣体力。
  //   而客户端弹窗自己算得清清楚楚（截图：1965/240 → 15/240，65 次 × 30 体力 = 1950），
  //   真机样本 quest_skip_sub_quest_bulk 的 before/after 也正是 775→5（Δ-770）。
  //   ⇒ 显式次数也必须走同一套机制计算（含每日免费次数抵扣、体力上限截断）。
  {
    bulkInfo = bulkSkipCount(s, {
      cost: cost,
      mech: mech,
      want: wantN,
      dailyUsed: (mech.kind === "FREE" && set0) ? dailyRewardReceivedCount(set0) : 0,
      dailyClearToday: dailyClearCount(s, req.questId),
    });
    n = bulkInfo.n;
    console.log("[quest] bulkSkip " + req.questId + " 机制=" + mech.kind +
      " 免费剩余=" + bulkInfo.nFree + "(上限" + bulkInfo.dailyLimit + "-已用" + bulkInfo.used + ")" +
      " 付费可跳=" + bulkInfo.nPaid +
      " 每日通关=" + (bulkInfo.used) + "/" + mech.dailyClearLimit +
      " 周上限=" + mech.weeklyLimit +
      " → 跳 " + n + " 次、耗体力 " + bulkInfo.staminaCost);
    if (n <= 0) {
      // 体力不足或本周已用完 → 不消耗、不发奖，返回当前状态（客户端会提示）
      console.log("[quest] bulkSkip 无可跳次数，直接返回");
      markDirty(); flushNow();
      return okShaped(ctx.path, {
        quest_result_temp: buildQuestResultTemp({
          before: { rank: s.UserData.level || 1, rankExp: s.UserData.exp || 0, stamina: s.UserData.stamina || 0 },
          after: { rank: s.UserData.level, rankExp: s.UserData.exp, stamina: s.UserData.stamina },
          addUserRankExp: 0, addCharacterExp: 0, normalDrops: [], dailyDrops: [],
    userRank: (s.UserData || {}).level || 0,   // ★ exp_to_gold 仅在 RANK 满级时产生
          questStamina: 0, expToGoldTimes: 0,   // 没跳 → 无金币
        }),
        userQuest: (s.UserQuestList || []).find(function (x) { return x.MasterQuestId === req.questId; }) || null,
        AchievementList: s.AchievementList || [], TrialList: s.TrialList || [],
        UserData: s.UserData,
        player_all_asset: touchedPlayerAssets(), auto_sell_item_list: autoSellResults(),
        InvasionQuestSlot: invasionQuestSlots(),
        auto_sell_item_list: [], MissionProgressList: [], limited_mission_progress_list: [],
        guild_internal_data: guildInternal(),
        // ★ 用真实额度回执（n=0 → 不累加周计数，但如实返回当前已领/已跳次数）
        ...skipQuotaReceipt(s, req.questId, row, 0),
      });
    }
  }
  const before = { rank: s.UserData.level || 1, rankExp: s.UserData.exp || 0, stamina: s.UserData.stamina || 0 };
  // ★★★ 跳过【不消耗体力】（2026-10-15 修正）★★★
  //   真机 29 个 quest/skip* 样本实证：单任务 skip 一律 Δ体力 = 0
  //   （STARFORCE 消耗30/跳54次 → Δ0；MasterQuest 消耗30 → Δ0；skip_daily 15任务合计430 → Δ0）。
  //   表里的 ConsumeStamina 是【实际战斗】的消耗，不是跳过消耗。
  //   ★ 但 cost 仍要传给 buildQuestResultTemp 折算 exp_to_gold（= cost × 100 × 次数）。
  // ★★★ 体力消耗按【机制】决定（2026-10-15）★★★
  //   A 每日免费通关：免费次数内不扣，超出部分扣（staminaCost = (n - freeUsed) × cost）
  //   B 周 skip 上限：**不扣体力**（真机 29 样本 Δ=0）
  //   C 每日通关上限：扣（n × cost）
  const stamCost = (bulkInfo && bulkInfo.staminaCost) || 0;
  if (stamCost > 0) addStamina(-stamCost);
  // ★ クラスチャレンジ的「跳过」同样要扣挑战券（按次数）
  payChallengeTickets(s, req.questId, n);
  const pExp = num(row && (row.AcquirePlayerRankExp || row["獲得プレイヤーランク経験値"])) * n;
  const cExp = num(row && (row.AcquireExp || row["獲得経験値"])) * n;
  const gold = num(row && (row.AcquireGold || row["獲得ゴールド"])) * n;
  if (pExp) addPlayerExp(pExp);
  if (gold) addItem("Item_Currency_Gold", gold);
  // ★★★ 掉落必须按次数放大（2026-10-15 修）★★★
  //
  // 用户报障：「这就是你说的奖励按次数发放？」（截图里 まとめてskip 只给了单次量的道具）
  //
  // 根因：经验/金币都乘了 n（见上面的 pExp/cExp/gold），**唯独掉落没乘** ——
  //   写成 `dropsForQuest(row, questId)` 而不是 `dropsForQuest(row, questId, n)`。
  //   实测该任务的单次掉落 = [MasterRank_09×24, _10×24, _11×111, _12×24, Enchant_05_03×1, _04_03×1]，
  //   与用户截图显示的 x24/x24/x111/x24/×1/×1 **逐个吻合** → 铁证。
  // ★ 每日掉落只发【剩余额度】内的次数（用户报障：额度 0/2 还在发デイリー報酬）
  const _dailyRemain = (function () {
    try {
      if (!hasDaily || !set0) return 0;
      return Math.max(0, Number(dailyRewardLimitFor(qt0, set0)) - Number(dailyRewardReceivedCount(set0)));
    } catch (e) { return 0; }
  })();
  const _dailyTimes = Math.min(n, _dailyRemain);
  if (_dailyRemain <= 0 && n > 0) console.log("[quest] skip 每日额度已用完（" + (hasDaily ? dailyRewardReceivedCount(set0) + "/" + dailyRewardLimitFor(qt0, set0) : "无每日") + "）→ 不发デイリー報酬");
  const { normalDrops, dailyDrops } = dropsForQuest(row, req.questId, n, _dailyTimes);
  const applied = normalDrops.concat(dailyDrops);
  if (applied.length) applyRewards(applied);
  // ★ 记录通关次数（UserQuest 记录的字段必须与契约一致）
  //   真机 userQuest 形状：{MasterQuestId, MasterQuestType, TotalClearCount,
  //                        DailyClearCount, DailySkipCount, DailyItemUseCount}
  //   ★ 早期缺 DailySkipCount / DailyItemUseCount，且 MasterQuestType 写死 0 ——
  //     MasterQuestType 必须查 QuestGroup.csv（见 questGroupTypeOf）。
  //   ★ 跳过的次数记进 DailySkipCount（真机 STARFORCE 那条 DailySkipCount=54=DailyClearCount）。
  if (req.questId) {
    if (!s.UserQuestList) s.UserQuestList = [];
    let q = s.UserQuestList.find(function (x) { return x.MasterQuestId === req.questId; });
    // ★ 统一经 ensureUserQuest（收口）
    if (!q) q = ensureUserQuest(s, req.questId);
    q.TotalClearCount = (q.TotalClearCount || 0) + n;
    q.DailySkipCount = (q.DailySkipCount || 0) + n;
  }
  // ★★★ 消耗每日报酬额度（2026-10-15 补）★★★
  //   有 DailyRewardId 的任务，每跳一次就消耗 1 次「本日の受取可能回数」——
  //   这正是界面上「本日あと N 回」的那 N（MasterQuest 上限 = 1 + 活动 1 = 2）。
  //   不累加的话客户端永远认为「还能领」，与 daily_reward_received_count 语义不符。
  // ★★★ 消耗「每日免费通关次数」（2026-10-15 修正）★★★
  //   只有【超出免费额度的部分】才付费；免费部分是 nFree，实际用掉 freeUsed = min(n, nFree)。
  //   用户原话：「消耗完每日免费次数就开始正常计算体力消耗」
  if (hasDaily && set0 && bulkInfo && bulkInfo.freeUsed > 0) {
    for (let k = 0; k < bulkInfo.freeUsed; k++) bumpDailyRewardReceived(set0);
  }
  // ★★★ 累加「今日通关次数」（2026-10-15 补）★★★
  //   ★ 关键：skip **也算通关**（用户原话：「这个通关是包括你出击通关和 skip 通关两种形式的」）
  //     所以 SubQuest 的每日通关上限、MasterQuest 的免费次数都受 skip 影响。
  if (req.questId && n > 0) bumpDailyClear(s, req.questId, n);
  // ★ 传入 questId 上下文，使 43/4/12 等「指定关卡」类任务能被正确匹配（早期传空对象）
  // ★ 传【全部】quest id：CT=43 的任务按「任务组前缀」匹配（SP_EXP 等），需遍历整批
  const mp = advanceMissions("quest", 1, { questId: req.questId, questIds: [req.questId] });
  const qrt = buildQuestResultTemp({
    before: before,
    after: { rank: s.UserData.level, rankExp: s.UserData.exp, stamina: s.UserData.stamina },
    addUserRankExp: pExp, addCharacterExp: cExp,
    userRank: (s.UserData || {}).level || 0,   // ★ exp_to_gold 仅在 RANK 满级时产生
    normalDrops: normalDrops, dailyDrops: dailyDrops,
    // ★ exp_to_gold：满级玩家按【体力 × 100 × 次数】折算
    questStamina: cost, expToGoldTimes: n,
    // ★ 复刻券 = 体力 × 次数（真机：30×54=1620）
    eventTicketAmount: grantEventTickets(cost * n),
  });
  s.__questResultTemp = qrt;
  markDirty(); flushNow();
  console.log("[quest] skip " + req.questId + " x" + n + " (跳过不耗体力, cost=" + cost + " 仅用于 exp→gold)" +
    " drops=" + (normalDrops.length + dailyDrops.length) + " gold+" + gold +
    " 每日额度=" + (hasDaily ? (dailyRewardReceivedCount(set0) + "/" + dailyRewardLimitFor(qt0, set0)) : "无"));
  return okShaped(ctx.path, {
    quest_result_temp: qrt,
    // ★★ daily_reward_received 的语义（两份契约对照后确认）★★
    //   本地录制（MasterQuest_Soldier_05）→ {"quest_group_set_id":"MasterQuest_group_soldier",
    //                                        "daily_reward_received_count":1}
    //   真机 winr （STARFORCE_Cerberus_Hard_141）→ []
    //   ⇒ 不是协议差异，而是【任务有无 DailyRewardId】的状态差异：
    //     MasterQuest.csv 里 MasterQuest_Soldier_05 有 DailyRewardId
    //     （= Reward_Dailydrop_Mquest_Soldier_005），StarForceQuest 那条没有。
    //   语义 = 「该任务所属任务组的今日已领每日奖励次数」，无每日奖励的任务给 []。
    //   早期写死 [] → 对有 DailyRewardId 的任务缺了这条回执（客户端不刷新每日奖励状态）。
    // ★ 额度回执（与早退分支共用 skipQuotaReceipt，已收口）
    ...skipQuotaReceipt(s, req.questId, row, n),
    // userQuest 的字段必须齐全（见上）
    userQuest: (s.UserQuestList || []).find(function (x) { return x.MasterQuestId === req.questId; }) || null,
    AchievementList: s.AchievementList || [], TrialList: s.TrialList || [],
    UserData: s.UserData,
    player_all_asset: touchedPlayerAssets(), auto_sell_item_list: autoSellResults(),
    InvasionQuestSlot: invasionQuestSlots(),
    // auto_sell_item_list：自动出售的产物（契约 5 条）。数据源是玩家的自动出售设置 +
    //   本次掉落中被自动卖掉的部分；单机默认未开启自动出售 → 空（已登记 EXPECTED）。
    auto_sell_item_list: autoSellResult(s, applied),
    MissionProgressList: mp,
    limited_mission_progress_list: [],
    guild_internal_data: guildInternal(),
    // ★★ 键名与类型（两份契约一致，2026-09-30 修正）★★
    //   · WeeklySkipQuest（【单数】）是【对象】，不是数组：
    //       本地契约 {"MasterQuestGroupSetId":"MasterQuest_group_soldier",
    //                 "MasterQuestType":10,"WeeklySkipCount":9}
    //       真机契约 {"MasterQuestGroupSetId":"STARFORCE_CERBERUS_HARD",
    //                 "MasterQuestType":11,"WeeklySkipCount":54}
    //     （真机那条正是「袭来(STARFORCE)跳过」时产生的 —— 本次报障的直接现场）
    //   · WeeklySkipQuestList（【复数】）才是数组 → 在 quest/skip_daily 与
    //     quest/skip_sub_quest_bulk 里。
    //   我早期把 WeeklySkipQuest 写死成 [] → merge 检测到「契约是 object、我是 array」，
    //   按契约类型替换成【录制那次的旧对象】→ 客户端拿到与本次任务无关的周跳过数据
    //   → 通信错误（本次袭来 skip 报错的真因）。
    //   语义：该任务所属「任务组集合」的本周跳过次数（本周累计）。
  });
});
// ★ quest/skip_daily —— 同样补全 quest_result_temp
route("quest/skip_daily", function (ctx) {
  const req = parse(ctx.body);
  const ids = req.quest_id_list || [];
  const s = getState();
  const before = { rank: s.UserData.level || 1, rankExp: s.UserData.exp || 0, stamina: s.UserData.stamina || 0 };
  // ★★★ 每日报酬的「领取次数」闸（2026-10-14 修复用户报障）★★★
  //
  // 用户报障：「每次进入游戏都可以领这个 daily 报酬（跳过所有带 daily 报酬的 SP 地图）。
  //   按理说每天只能批量 skip 一次，因为 skip 完了 daily 报酬要明天才刷新，
  //   但现在每次进游戏我都能再领一次。」
  //
  // ★ 真根因（两条独立错误叠加）：
  //   ① 语义读反：我把 `daily_reward_received_count` 当成【上限】写成常量；
  //      而客户端模型（反编译 il2cppOutput 实证）是：
  //        struct TemporaryQuestDailyRewardReceived {
  //            String_t* ___quest_group_set_id;
  //            int32_t   ___daily_reward_received_count;   // ← **已领取次数**
  //        };
  //        struct UserQuestDailyRewardReceived { QuestGroupSetId; int32_t Count; };
  //        UserAssetQuestDataStore_GetDailyRewardReceivedCount(id) → Dictionary[id].Count
  //        （UserAssetQuestDataStore.cs:303-308）
  //      ⇒ 它是「今天这组已经领了几次」，不是上限。
  //   ② 从不累加、从不校验 → 每次调用都全额发奖，
  //      且回传的 count 恒 = limit ⇒ 客户端永远认为「还能领」。
  //
  // ★ 正确语义（真机契约 _winr_capture/contracts_winr/quest_skip_daily.json 实证）：
  //     user_quest_list[].DailySkipCount  = 2   ← 今日已跳过 2 次
  //     daily_reward_received_list[].count = 2   ← 今日已领 2 次（两者同步递增）
  //   上限 = QuestDailyReward.csv 的 DailyRewardLimit(1) + 活动 DAILY_REWARD_LIMIT_ADD(+1) = 2
  //
  // ★ 判定必须在【发放之前】完成（否则第一批已经发出去了才发现超限）。
  const claim = new Map();          // set → { limit, got, canClaim }
  const eligible = [];              // [{ id, claim }]
  for (const id of ids) {
    const set = questGroupSetOf(id);
    let c;
    if (!set) {
      c = { set: "", limit: 0, got: 0, canClaim: true };
    } else if (claim.has(set)) {
      c = claim.get(set);
    } else {
      const limit = dailyRewardLimitFor(questGroupTypeOf(id), set);
      const got = dailyRewardReceivedCount(set);
      c = { set: set, limit: limit, got: got, canClaim: got < limit };
      claim.set(set, c);
    }
    eligible.push({ id: id, claim: c });
  }
  const blocked = [...claim.values()].filter(function (c) { return !c.canClaim; });
  if (blocked.length) {
    console.log("[quest] skip_daily 每日报酬已达上限，跳过发奖: " +
      blocked.map(function (c) { return c.set + "(" + c.got + "/" + c.limit + ")"; }).join(", "));
  }

  // 只对「本组还有领取次数」的任务发奖（跳过即领报酬；领满则该任务不再产出）
  let total = 0, pExp = 0, cExp = 0, gold = 0;
  const allNormal = [], allDaily = [];
  let granted = 0;
  const goldStaminaList = [];   // ★ 逐任务的 (cost × 次数)，供 exp_to_gold 逐条输出
  for (const e of eligible) {
    if (!e.claim.canClaim) continue;
    const row = questRow(e.id);
    // ★★★ 每个任务跳【该组剩余的每日报酬额度】次（2026-10-16 真机契约核验后修正）★★★
    //   真机 `quest/skip_daily` 实证：15 个任务的 `DailySkipCount = 2`，
    //   且 `exp_to_gold_list` 每条 = cost × 100 × 2（Sp_Exp_02_15: 20 → 4000）✅
    //   ★ 我此前「每个任务只跳 1 次」→ 奖励给少了一半、exp_to_gold 也少一条的量。
    const times = Math.max(1, Number(e.claim.limit) - Number(e.claim.got));
    const oneCost = num(row && (row.ConsumeStamina || row["消費スタミナ"]));
    total += oneCost * times;
    pExp += num(row && (row.AcquirePlayerRankExp || row["獲得プレイヤーランク経験値"])) * times;
    cExp += num(row && (row.AcquireExp || row["獲得経験値"])) * times;
    gold += num(row && (row.AcquireGold || row["獲得ゴールド"])) * times;
    goldStaminaList.push(oneCost * times);
    const d = dropsForQuest(row, e.id, times, times);   // times 本身就是剩余每日额度
    for (const x of d.normalDrops) allNormal.push(x);
    for (const x of d.dailyDrops) allDaily.push(x);
    granted++;
  }
  // ★★★ 跳过【不消耗体力】（2026-10-15 修正）★★★
  //   真机 29 个 quest/skip* 样本实证：quest/skip_daily 的 15 个任务合计消耗 430，
  //   但响应 Δ体力 = **0**（1374 → 1374）。
  //   ★ 保留 total 的累加（它仍要传给 buildQuestResultTemp 折算 exp_to_gold）。
  // if (total) addStamina(-total);   ← 已移除：跳过不扣体力
  if (pExp) addPlayerExp(pExp);
  if (gold) addItem("Item_Currency_Gold", gold);
  if (allNormal.length || allDaily.length) applyRewards(allNormal.concat(allDaily));
  // ★ 计数：只对【真的发了奖】的组累加（已满的组不动）
  for (const c of claim.values()) if (c.canClaim) { const t = Math.max(1, Number(c.limit) - Number(c.got)); for (let k2 = 0; k2 < t; k2++) bumpDailyRewardReceived(c.set); }
  // ★ DailySkipCount 同步累加（真机契约：Skip=2 / count=2 两者同步）。
  //   我此前恒为 0 —— 客户端用它显示「今日已跳过次数」，不累加会一直显示 0/2。
  for (const e of eligible) {
    if (!e.claim.canClaim) continue;
    const uq = ensureUserQuest(s, e.id);
    // ★ 跳了 times 次就累加 times（真机 DailySkipCount=2 与 daily_reward_received_count=2 同步）
    const t2 = Math.max(1, Number(e.claim.limit) - Number(e.claim.got));
    uq.DailySkipCount = (Number(uq.DailySkipCount) || 0) + t2;
  }
  const anyClaimable = granted > 0;
  // ★ 传【全部】quest id：CT=43 的任务按「QuestGroupSetId」匹配（SP_Favorite 等），需遍历整批
  // ★ 用 skipDaily（只 CT=43），避免牵动 AchievementMission_*（那些由 battle/win 推进）
  const mp = advanceMissions("skipDaily", 1, { questId: ids[0], questIds: ids });
  const qrt = buildQuestResultTemp({
    before: before,
    after: { rank: s.UserData.level, rankExp: s.UserData.exp, stamina: s.UserData.stamina },
    addUserRankExp: pExp, addCharacterExp: cExp,
    userRank: (s.UserData || {}).level || 0,   // ★ exp_to_gold 仅在 RANK 满级时产生
    normalDrops: allNormal, dailyDrops: allDaily,
    // ★ exp_to_gold：total 已是「各任务体力之和」，故直接用它（times=1）
    // ★★★ exp_to_gold：逐任务一条（2026-10-16 真机核验后修正）★★★
    //   真机 `quest/skip_daily`：15 个任务 → 15 条，每条 = cost × 100 × 该任务跳的次数
    //     例 Sp_Exp_02_15（cost 20，跳 2 次）→ 4000 条 ✅
    expToGoldStaminaList: goldStaminaList,
    // ★ 复刻券：逐任务一条（cost × times），与 exp_to_gold 同源
    eventTicketAmounts: goldStaminaList.map(function (v) { return v; }),
  });
  grantEventTickets(goldStaminaList.reduce(function (a, b) { return a + (Number(b) || 0); }, 0));
  s.__questResultTemp = qrt;
  markDirty(); flushNow();
  console.log("[quest] skip_daily x" + ids.length + " stamina-" + total + " drops=" + (allNormal.length + allDaily.length));
  return okShaped(ctx.path, {
    quest_result_temp: qrt,
    // ★★ 每日报酬领取状态（2026-10-08 按真机契约 + 反编译修正）★★
    //   真机契约形状：【每个 QuestGroupSetId 一条】
    //     [{quest_group_set_id:"SP_EXP", daily_reward_received_count:2}, ...]（15 条）
    //   count = QuestDailyReward.DailyRewardLimit + 活动 DAILY_REWARD_LIMIT_ADD
    //     （反编译 QuestUseCase.GetDailyRewardCount；当前活动让 SP/マスタークエスト 1→2）
    //   ★ 我早期直接回 s.daily_reward_received_list（存档里的旧数组，值恒 0）——
    //     既没算活动加成，也没按本次跳过的任务重新聚合。
    daily_reward_received_list: (function () {
      const bySet = new Map();
      for (const qid of (ids || [])) {
        const set = questGroupSetOf(qid);
        if (!set) continue;
        if (!bySet.has(set)) bySet.set(set, qid);
      }
      const out = [];
      for (const [set, qid] of bySet) {
        out.push({
          quest_group_set_id: set,
          // ★★★ 这里是【今日已领次数】，不是上限！（2026-10-14 修正）★★★
          //   客户端模型（反编译实证）：
          //     TemporaryQuestDailyRewardReceived { quest_group_set_id, daily_reward_received_count }
          //     UserQuestDailyRewardReceived      { QuestGroupSetId, Count }
          //     访问器 GetDailyRewardReceivedCount 返回的就是这个 Count。
          //   真机契约：Skip=2 / count=2（两者同步递增，上限=DailyRewardLimit+活动=2）。
          //   我早期写成 dailyRewardLimitFor(...)（上限常量）→
          //     客户端每次比较都以为「还能领」→ 用户每次进游戏都能再领一遍。
          daily_reward_received_count: dailyRewardReceivedCount(set),
        });
      }
      return out;
    })(),
    // ★ 契约要用【本次跳过的那批任务】的 UserQuest 记录（15 条，与请求的 15 个 quest 一一对应）。
    //   早期写死空数组 quests: []，且缺 user_quest_list / WeeklySkipQuestList /
    //   achievement_list / trial_list 四个字段 —— 而数据其实都在 state 里：
    //     UserQuestList（1263 条）、AchievementList（665）、TrialList（372）与契约条数一致。
    user_quest_list: (function () {
      const out = [];
      for (const id of ids) {
        const q = (s.UserQuestList || []).find(function (x) { return x.MasterQuestId === id; });
        if (q) out.push(q);
      }
      return out;
    })(),
    // WeeklySkipQuestList：按 quest_group_set_id 汇总本周跳过次数
    WeeklySkipQuestList: (function () {
      if (!s.__weeklySkip) s.__weeklySkip = {};
      const bySet = new Map();
      // ★ 先建「set → 一个代表 questId」的映射，供查 QuestType 用。
      //   踩坑：我第一版在 bySet 循环里用了 id —— 而 id 是【上一个循环的变量】，
      //   在这里不存在 → 运行时 ReferenceError → 整个端点 9999 失败。
      const repOf = new Map();
      for (const id of ids) {
        const set = questGroupSetOf(id);
        if (!set) continue;
        if (!repOf.has(set)) repOf.set(set, id);
        bySet.set(set, (bySet.get(set) || 0) + 1);
      }
      // ★ 语义（真机契约实证）：【每个请求项输出一条】（15 项 → 15 条），计数递增累加。
      const out = [];
      for (const id of ids) {
        const set = questGroupSetOf(id);
        if (!set) continue;
        s.__weeklySkip[set] = (s.__weeklySkip[set] || 0) + 1;
        out.push({
          MasterQuestGroupSetId: set,
          MasterQuestType: questGroupTypeOf(id),
          WeeklySkipCount: s.__weeklySkip[set],
        });
      }
      return out;
    })(),
    achievement_list: s.AchievementList || [],
    trial_list: s.TrialList || [],
    auto_sell_item_list: autoSellResult(s, allNormal.concat(allDaily)),
    user_data: withLastFormation(s),
    player_all_asset: touchedPlayerAssets(), auto_sell_item_list: autoSellResults(),
    // ★ 契约字段名是 **mission_progress_list**（小写 + 下划线）——
    //   quest/skip 用的是 MissionProgressList（大驼峰）。同族端点字段名不同。
    mission_progress_list: mp,
    limited_mission_progress_list: [],
    guild_internal_data: guildInternal(),
  });
});
// ★ quest/skip_sub_quest_bulk —— 同样补全 quest_result_temp（收口到 quest-result.mjs）

route("quest/skip_sub_quest_bulk", function (ctx) {
  const req = parse(ctx.body);
  const list = req.quest_id_count_list || [];
  const s = getState();
  const before = { rank: s.UserData.level || 1, rankExp: s.UserData.exp || 0, stamina: s.UserData.stamina || 0 };
  let total = 0, pExp = 0, cExp = 0, gold = 0;
  const allNormal = [], allDaily = [];
  const goldStaminaList = [];   // ★ 逐任务的 (cost × 次数)，供 exp_to_gold 逐条输出
  for (const e of list) {
    const row = questRow(e.quest_id);
    // ★★★ 字段名修正（2026-10-15）★★★
    //   真机请求体是 `{"quest_id":"...","skip_count":N}` —— 我此前读 `e.count`，
    //   而请求里【没有 count 字段】→ 恒回退到 1 → **无论客户端要跳几次都只跳 1 次**。
    //   实测：请求 skip_count=3、cost=10 → 体力只扣 10（应为 30）。
    const want = num(e.skip_count) || num(e.count) || 1;
    // ★★★ C 型机制：受【每日通关次数上限】约束（2026-10-15）★★★
    //   用户原话：「sub quest …不是限制周 skip 次数而是限制每天的通关次数，
    //            注意我的用词，我说的是通关次数，意味着不管是 skip 还是出击，都有次数限制」
    //   数据源：SubQuest.csv 的 DailyQuestClearLimit（boss 关 5 / 普通关 20）。
    const mech = questMechanism(s, e.quest_id, row);
    let cnt = want;
    // ★★ 2026-10-22 回滚 ★★
    //   我曾把「SubQuestSkipFilter 的当日额度」当成权威来卡次数 —— 那是建立在
    //   「有次数却不让 skip」的错误前提上的（实际是那关【从未通关过】，客户端本来就不许 skip，
    //   属于正常行为）。这个改动反而【放松】了真实限制（SubQuest.csv 的每日通关上限），已还原。
    if (mech.dailyClearLimit > 0) {
      const used = dailyClearCount(s, e.quest_id);
      cnt = Math.max(0, Math.min(want, mech.dailyClearLimit - used));
      if (cnt < want) {
        console.log("[quest] bulkSkip " + e.quest_id + " 每日通关上限 " + mech.dailyClearLimit +
          "（今日已 " + used + "）→ 本次只跳 " + cnt + "/" + want);
      }
    }
    if (cnt <= 0) continue;   // 已达上限 → 本次不跳（不发奖、不扣体力）
    const oneCost = num(row && (row.ConsumeStamina || row["消費スタミナ"]));
    total += oneCost * cnt;
    goldStaminaList.push(oneCost * cnt);   // ★ exp_to_gold 逐任务一条
    pExp += num(row && (row.AcquirePlayerRankExp || row["獲得プレイヤーランク経験値"])) * cnt;
    cExp += num(row && (row.AcquireExp || row["獲得経験値"])) * cnt;
    gold += num(row && (row.AcquireGold || row["獲得ゴールド"])) * cnt;
    // ★ 掉落按次数放大（独立掷骰 cnt 次后合并，见 quest-result.mjs）
    const d = dropsForQuest(row, e.quest_id, cnt, cnt);
    for (const x of d.normalDrops) allNormal.push(x);
    for (const x of d.dailyDrops) allDaily.push(x);
    if (e.quest_id) {
      let q = (s.UserQuestList || []).find(function (x) { return x.MasterQuestId === e.quest_id; });
      if (!q) q = ensureUserQuest(s, e.quest_id);
      q.TotalClearCount = (q.TotalClearCount || 0) + cnt;
      // ★ skip 也算「通关」+ 记跳过次数（DailySkipCount 此前恒为 0）
      q.DailySkipCount = (Number(q.DailySkipCount) || 0) + cnt;
      bumpDailyClear(s, e.quest_id, cnt);
    }
  }
  if (total) addStamina(-total);
  if (pExp) addPlayerExp(pExp);
  if (gold) addItem("Item_Currency_Gold", gold);
  if (allNormal.length || allDaily.length) applyRewards(allNormal.concat(allDaily));
  const mp = advanceMissions("quest", 1, { questId: list[0] && list[0].quest_id, questIds: list.map(function (x) { return x.quest_id; }) });
  const qrt = buildQuestResultTemp({
    before: before,
    after: { rank: s.UserData.level, rankExp: s.UserData.exp, stamina: s.UserData.stamina },
    addUserRankExp: pExp, addCharacterExp: cExp,
    userRank: (s.UserData || {}).level || 0,   // ★ exp_to_gold 仅在 RANK 满级时产生
    normalDrops: allNormal, dailyDrops: allDaily,
    // ★★★ exp_to_gold：**逐任务一条**（2026-10-16 真机契约核验后修正）★★★
    //   真机 `quest_skip_sub_quest_bulk`（4 任务）→ 4 条，每条 = cost × 次数 × 100
    //     例：[10500,10500,10500,10500]，10500 = 15×7×100 ✅
    //   ★ 我此前写成「一条总和」，且那个 IIFE 读的是 `e.count`（请求里是 `skip_count`）
    //     → 恒 ×1 → 算出 5000（应 42000 结构为 4 条）。
    expToGoldStaminaList: goldStaminaList,
    // ★ 复刻券：逐任务一条（真机 bulk = 4 条 ×105 = 体力15 × 7次）
    eventTicketAmounts: goldStaminaList.map(function (v) { return v; }),
  });
  grantEventTickets(goldStaminaList.reduce(function (a, b) { return a + (Number(b) || 0); }, 0));
  s.__questResultTemp = qrt;
  markDirty(); flushNow();
  console.log("[quest] skip_sub_quest_bulk x" + list.length + " stamina-" + total +
    " drops=" + (allNormal.length + allDaily.length) + " gold+" + gold);
  // ★★ 键集必须与【真机契约】完全一致（2026-09-30 修正）★★
  //   真机（contracts_winr/quest_skip_sub_quest_bulk.json）13 个键：
  //     quest_result_temp / daily_reward_received_list / user_quest_list /
  //     WeeklySkipQuestList / AchievementList / TrialList / **UserData**（大写 U+D）/
  //     player_all_asset / MissionProgressList / limited_mission_progress_list /
  //     InvasionQuestSlot / guild_internal_data / auto_sell_item_list
  //   ★ 我早期缺 7 个（WeeklySkipQuestList / AchievementList / TrialList / UserData /
  //     InvasionQuestSlot / guild_internal_data / auto_sell_item_list），
  //     还多给了 3 个真机没有的（daily_reward_received / quests / userData 小写）。
  //   ★★ 最致命的是 `userData`（小写）—— 真机是 `UserData`（大写 U 与 D）。
  //     客户端读 UserData 拿到 null → 通信错误（本次「襲来 skip 报错」的真因）。
  return okShaped(ctx.path, {
    quest_result_temp: qrt,
    // ★★ 每日报酬领取状态（2026-10-08 按真机契约修正）★★
    //   真机契约的形状是【每个 QuestGroupSetId 一条】：
    //     [{quest_group_set_id:"SP_EXP", daily_reward_received_count:2}, ...]
    //   而 count = 表里 DailyRewardLimit + 活动 DAILY_REWARD_LIMIT_ADD
    //     （反编译 QuestUseCase.GetDailyRewardCount；当前活动让 SP/マスタークエスト 1→2）
    // ★★ 本端点的形状与 quest/skip_daily【不同】（真机契约逐条核对）★★
    //     skip_sub_quest_bulk → **每个请求项一个空数组** \`[[], [], [], []]\`（4 项 → 4 条）
    //     skip_daily          → [{quest_group_set_id, daily_reward_received_count}, ...]
    //   我上一轮从 skip_daily 复制了「对象 + 活动计数」的写法到这里 —— 两处都错：
    //     ① 变量名用了 ids（本端点是 list）→ ReferenceError → 整端点 9999
    //     ② 元素形状用了对象（本端点应是空数组）
    //   ⇒ 同族端点的元素形状可能不同，**必须逐端点对照契约**。
    daily_reward_received_list: (list || []).map(function () { return []; }),
    user_quest_list: (function () {
      const out = [];
      for (const e of list) {
        const q = (s.UserQuestList || []).find(function (x) { return x.MasterQuestId === e.quest_id; });
        if (q) out.push(q);
      }
      return out;
    })(),
    // ★ 语义（真机契约实证）：【每个请求项输出一条】，按请求顺序，WeeklySkipCount 递增累加。
    //   真机请求 4 项（Sub_12_boss2/boss1 × 7、Sub_11_boss2/boss1 × 7）→ 响应 4 条：
    //     SUB_012:7 / SUB_012:14 / SUB_011:7 / SUB_011:14   ← 同一 set 出现两次、计数递增
    //   ★ 我第一版按 set 去重合并成 2 条 → 客户端拿到的条数与请求项数不符。
    WeeklySkipQuestList: (function () {
      if (!s.__weeklySkip) s.__weeklySkip = {};
      const out = [];
      for (const e of list) {
        const set = questGroupSetOf(e.quest_id);
        if (!set) continue;
        const cnt = num(e.skip_count) || num(e.count) || 1;
        const qt = questGroupTypeOf(e.quest_id);
        // ★★ 每周跳过上限校验（2026-10-08 补）★★
        //   权威链：QuestSkip.csv 的 WeeklySkipLimit（STARFORCE=70 / ClassChallenge=30 / EVE=200）
        //     + LimitPlusUseCase.GetEffectValue(effectType, masterRank)（反编译 QuestUseCase.cs:2953-2960）
        //   真机契约实证：STARFORCE_CERBERUS_HARD 的 WeeklySkipCount=54（在 70 内）。
        //   缺陷：我早期只累加计数、**从不校验上限** → 可以无限跳过。
        const limit = weeklySkipLimitFor(s, qt, set);
        const used = Number(s.__weeklySkip[set]) || 0;
        const allow = limit > 0 ? Math.max(0, Math.min(cnt, limit - used)) : cnt;
        if (allow < cnt) {
          console.log("[quest] skip 周上限: " + set + " " + used + "/" + limit + "，本次请求 " + cnt + " → 只允许 " + allow);
        }
        s.__weeklySkip[set] = used + allow;
        out.push({
          MasterQuestGroupSetId: set,
          MasterQuestType: qt,
          WeeklySkipCount: s.__weeklySkip[set],
        });
      }
      return out;
    })(),
    AchievementList: s.AchievementList || [],
    TrialList: s.TrialList || [],
    UserData: withLastFormation(s),
    player_all_asset: touchedPlayerAssets(), auto_sell_item_list: autoSellResults(),
    MissionProgressList: mp,
    limited_mission_progress_list: [],
    InvasionQuestSlot: invasionQuestSlots(),
    guild_internal_data: guildInternal(),
    auto_sell_item_list: autoSellResult(s, allNormal.concat(allDaily)),
  });
});
route("quest/sub_quest_skip_filter", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // 请求字段名与响应不同：请求 item_tool_stamina_enabled_r -> 响应 item_tool_stamina_r_enabled。
  s.SubQuestSkipFilter = {
    player_account_id: s.UserData.id,
    chapter_selections: req.chapter_selections || [],
    item_tool_stamina_r_enabled: req.item_tool_stamina_enabled_r ? 1 : 0,
    item_tool_stamina_sr_enabled: req.item_tool_stamina_enabled_sr ? 1 : 0,
    normal_skip_count: req.normal_skip_count || 0,
    normal_assault_skip_count: req.normal_assault_skip_count || 0,
    hard_skip_count: req.hard_skip_count || 0,
    hard_assault_skip_count: req.hard_assault_skip_count || 0,
  };
  // 契约 daily_reward_received_list 是【数组的数组】（每个任务组一条已领取奖励 id 列表），
  // 与存档里的同名对象数组语义不同 —— 不可直接回传。
  const dailyRewardReceived = [[],[],[],[],[],[],[],[],[],[],[],[],[],[],[]];
  markDirty();
  // 契约：{ SubQuestSkipFilter: {...} }
  return okShaped(ctx.path, { SubQuestSkipFilter: s.SubQuestSkipFilter });
});
// ★ 入侵任务槽 —— 契约字段名是 **InvasionQuestSlot**（不是 invasion_quest_slot_list），
//   早期两者都错（字段名 + 无数据源）。生成逻辑收口在 state.mjs 的 invasionQuestSlots()。
route("quest/get_invasion", function (ctx) {
  return okShaped(ctx.path, { InvasionQuestSlot: invasionQuestSlots() });
});

console.log("[routes-quest] 战斗/任务接口已注册（按入参）");