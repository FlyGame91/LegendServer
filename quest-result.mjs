import { rankExpInLevel, tutorialInProgress } from "./state.mjs";
/**
 * quest_result_temp 的【唯一组装点】——battle/win 与 quest/skip* 共用。
 *
 * 为什么必须收口（本项目铁律）：
 *   契约里 5 个战斗/跳过类端点（battle/win、quest/skip、quest/skip_daily、
 *   quest/skip_sub_quest_bulk、quest/end）都返回【同一形状】的 quest_result_temp（29 字段）。
 *   早期只有 battle/win 有组装逻辑，其余 4 个端点连字段都没有 →
 *   契约审计里 4 处 normal_drop_list + 4 处 exp_to_gold_list + 2 处 daily_drop_list
 *   + 2 处 event_ticket_drop_list + 1 处 gold_quest_defeated_enemy_reward_list 全部为空。
 *   如果每个 handler 各写一份，未来必然再漏 —— 故收敛到本模块。
 *
 * 语义与数据来源（全部实证，无编造）：
 *   · before/after_user_rank(_exp)  —— UserData 的【真字段】是 level/exp（没有 rank/rank_exp）
 *   · need_user_rank_exp            —— Fusion/UserRankLevelUp.csv 的 NeedExp
 *   · normal_drop_list              —— Reward_Drop_<BattleId> / Quest.DropRewardId
 *                                      经 rewards.mjs（DecisionRewardTable + RandomRewardTable）
 *   · first_drop_list               —— 首通额外给 Quest.FirstClearRewardId
 *   · exp_to_gold_list              —— 满级角色溢出的经验折算金币
 *   · gold_quest_defeated_enemy_reward_list —— 金币关击败敌人的额外奖励（契约有 9 条，
 *                                     数据源未找到 ⇒ 保持空，诚实不编造）
 *   · daily_drop_list               —— 每日奖励（Quest.DailyRewardId）
 */
import { dropMultiplier } from "./campaign.mjs";
import { loadTable } from "./masterdata.mjs";
import { rewardsForRewardId, rollRewardId } from "./rewards.mjs";

/** Fusion/UserRankLevelUp.csv 的 Lv → NeedExp。 */
export function needRankExpFor(lv) {
  const t = loadTable("Fusion/UserRankLevelUp.csv");
  const r = ((t && t.rows) || []).find(function (x) { return Number(x.Lv) === Number(lv); });
  return r ? Number(r.NeedExp || 0) : 0;
}

/** 把 rewards 结果规范化成契约的 {sheet_type, master_id, amount}。 */
export function normalizeDrops(list) {
  return (list || []).map(function (x) {
    return { sheet_type: x.sheetType || 1, master_id: x.master_id, amount: x.amount || 1 };
  });
}

/**
 * 解析某个任务的掉落（普通 + 每日），并返回 {normalDrops, dailyDrops}。
 * 掉落 RewardId 的约定式命名 = "Reward_Drop_" + BattleId（主线 334 个任务里 113 个可匹配）。
 */
/**
 * 计算某任务的掉落。
 * @param row     Quest 表行
 * @param questId 任务 id
 * @param times   ★ 执行次数（まとめてskip 跳 N 次时乘 N，默认 1）
 *                —— 2026-10-15 新增。此前调用方漏传 → まとめてskip 只给单次量道具
 *                （用户截图实证：x24/x24/x111/x24/×1/×1 与单次掉落逐个吻合）。
 */
// ==================== 复刻活动（ReEvent）点数换算 ====================
// ★★★ 2026-10-22 用户报障：「复刻活动通关应该给复刻点数，给原活动点数没有任何意义、无法使用」★★★
//
// 权威数据链：
//   · Event/Event.csv：QuestGroupId → ReEventFlag / NewEventFlag / PointItemId
//   · Quest/EventQuest.csv：QuestId → QuestGroupId / RecommendLevel / EventQuestType(3=チャレンジ)
//   · Reward/ReEventRewardList.csv：(NewEventFlag, RecommendLevel) → Reward_Drop[_New]_Re_Eve_boss_<lv>
//       实证：Reward_Drop_Re_Eve_boss_51 → Item_Re_EventPoint x612（原活动关是 Item_Eventpoint_05 x306，正好 2 倍）
//   · 商店侧实证：原活动商店 Shop_Event_XX **全部 0 个商品**（124 个全空），
//                 复刻商店 Shop_Event_Story_XXX 的 3143 个商品 Cost 全是 Item_Re_EventPoint
//   ⇒ 原活动点数道具（Item_Eventpoint_XX）在当前版本是【死道具】，复刻活动必须给 Item_Re_EventPoint。
let _evQuestIdx = null;
export function eventInfoForQuest(questId) {
  if (!_evQuestIdx) {
    _evQuestIdx = new Map();
    try {
      const q = loadTable("Quest/EventQuest.csv");   // 注意：本文件顶部已 import loadTable
      const ev = loadTable("Event/Event.csv");
      const byGroup = new Map();
      for (const r of ((ev && ev.rows) || [])) byGroup.set(String(r.QuestGroupId || ""), r);
      for (const r of ((q && q.rows) || [])) {
        const g = byGroup.get(String(r.QuestGroupId || ""));
        if (!g) continue;
        _evQuestIdx.set(String(r.QuestId), {
          isRe: String(g.ReEventFlag) === "True",
          newEvent: String(g.NewEventFlag) === "True",
          pointItem: String(g.PointItemId || ""),
          recommendLevel: Number(r.RecommendLevel) || 0,
          questType: Number(r.EventQuestType) || 0,
        });
      }
    } catch (e) { console.error("[reevent] 索引失败: " + e.message); }
  }
  return _evQuestIdx.get(String(questId)) || null;
}

/** 复刻活动的「チャレンジ（boss）」关：用 ReEventRewardList 的表（点数翻倍）。 */
export function reEventBossDropId(questId, row) {
  const info = eventInfoForQuest(questId);
  if (!info || !info.isRe) return "";
  const lvl = Number((row && row.RecommendLevel) || info.recommendLevel) || 0;
  const isBoss = Number((row && row.EventQuestType) || info.questType) === 3 || /_boss_/i.test(String(questId || ""));
  if (!lvl || !isBoss) return "";
  try {
    const t2 = loadTable("Reward/ReEventRewardList.csv");
    const hit = ((t2 && t2.rows) || []).find(function (r) {
      // ★ CSV 里是 "True"/"False"（首字母大写），不能拿 String(false) 去比
      return Number(r.RecommendLevel) === lvl && String(r.NewEventFlag) === (info.newEvent ? "True" : "False");
    });
    return hit ? String(hit.RewardId || "") : "";
  } catch (e) { return ""; }
}

/** 复刻活动：把原活动点数（Item_Eventpoint_XX）换成复刻点数，并按 id 合并。 */
export function convertReEventDrops(list, questId) {
  const info = eventInfoForQuest(questId);
  // ★ 永远返回【新数组】：调用方会用 `arr.length = 0` 就地清空，若返回同一个引用会把结果清没。
  if (!info || !info.isRe || !Array.isArray(list) || !list.length) return (list || []).slice();
  const agg = new Map();
  let converted = 0;
  for (const d of list) {
    let mid = String(d.master_id || "");
    if (/^Item_Eventpoint_/i.test(mid)) { mid = "Item_Re_EventPoint"; converted++; }
    const k = mid;
    const cur = agg.get(k);
    if (cur) cur.amount += Number(d.amount) || 0;
    else agg.set(k, { sheet_type: d.sheet_type !== undefined ? d.sheet_type : (d.sheetType || 1), master_id: mid, amount: Number(d.amount) || 0 });
  }
  if (converted) console.log("[reevent] " + questId + " 原活动点数 → 复刻点数（" + converted + " 项）");
  return [...agg.values()];
}

export function dropsForQuest(row, questId, times, dailyTimes) {
  const n = Math.max(1, Math.floor(Number(times) || 1));
  // ★★ 2026-10-21：每日报酬掉落必须受【剩余每日额度】限制 ★★
  //   缺陷实证（用户报障）：强者之道 skip 时界面显示「デイリー報酬 0/2」（额度已用完），
  //   却仍然发了带「デイリー報酬」标签的道具 —— 因为这里无条件按 n 次掷骰。
  //   现在由调用方传入【本次允许的每日次数】（= min(执行次数, 剩余额度)），默认 0（不发）。
  const dn = Math.max(0, Math.floor(Number(dailyTimes) || 0));
  const battleId = row && (row.BattleId || row["バトルID"] || row["バトルIDリスト"]);
  // ★ 复刻活动的挑战关用 ReEventRewardList 的表；其余沿用任务自己的 DropRewardId
  const dropId = reEventBossDropId(questId, row) || (row && row.DropRewardId) || (battleId ? "Reward_Drop_" + battleId : "");
  const dailyId = row && row.DailyRewardId;

  // ★ 活动：掉落量倍率（ACQUIRE_DROP_MUL）—— 每次掷骰都生效
  //   2026-10-08 修正：不再靠 id 前缀猜，改为**按 QuestType 判定**
  //   （QuestCampaign 的 Category 4/5/6 对应 サブクエスト NORMAL/HARD/CHAPTER，QuestType=2）。
  //   ★ QuestType 不在 Quest 表里，必须经 QuestGroup.csv 两跳（questGroupTypeOf）。
  let mult = 1;
  try { mult = dropMultiplier(questGroupTypeOf(questId), questGroupSetOf(questId)); } catch (e) { mult = 1; }
  if (!(mult > 1)) mult = 1;

  // ★★★ 独立掷骰 N 次，再合并结果（2026-10-15 修正）★★★
  //
  // 用户报障：「我认为你的掉落还是有问题，你是直接给掉落*skip次数了，
  //            但实际上应该每次都是独立掉落，最终将结果合并」
  //   —— **完全正确**。我此前的实现是 `单次掷骰 × n`：
  //     · 每个子表只掷【一次】，得到一组固定物品，再整体乘 n
  //     · 后果：**概率分布被压缩成「重复同一组 n 次」**
  //   实测证据（同一任务跑 6 次单次掷骰）：
  //     ```
  //     第1次: ... Material_Enchant_06_03x1 Material_Enchant_01_03x1
  //     第2次: ... Material_Enchant_04_03x1 Material_Enchant_12_03x1
  //     第3次: ... Material_Enchant_04_03x1 Material_Enchant_01_03x1   ← 每次的 Enchant 都不同
  //     ```
  //   而我的 `×n` 实现给出的是一组固定物品 ×6（如 `Enchant_04_03 x6`）——
  //   相当于把「每次独立抽 1 个」错成了「抽 1 个然后复制 6 份」。
  //   用户截图里两个 `×6` 的红框道具正是这个痕迹。
  //
  // ★ 正确语义：**每一次跳过/战斗都是一次独立的掉落事件**，
  //   各自掷骰（含活动倍率），最后把 N 次的结果**按 master_id 合并**（amount 相加）。
  //   这样：
  //     · 固定掉落（如 MasterRank_09×24）→ 合并后 24×N（与原来数值相同 ✅）
  //     · 随机掉落（如 Enchant）→ 变成 N 次独立抽样的**并集**（正确分布 ✅）
  const agg = new Map();   // master_id → { sheet_type, master_id, amount }
  const bump = function (x) {
    const k = String(x.master_id);
    const cur = agg.get(k);
    const amt = Math.max(1, Math.round((Number(x.amount) || 1) * mult));
    if (cur) cur.amount += amt;
    else agg.set(k, { sheet_type: x.sheet_type || 1, master_id: x.master_id, amount: amt });
  };
  for (let i = 0; i < n; i++) {
    if (dropId) for (const x of rollRewardId(dropId)) bump(x);
  }
  // dailyDrops 同理（它是「每日报酬」掉落，也与次数一 一对应）
  const dailyAgg = new Map();
  const bumpDaily = function (x) {
    const k = String(x.master_id);
    const cur = dailyAgg.get(k);
    const amt = Math.max(1, Math.round((Number(x.amount) || 1) * mult));
    if (cur) cur.amount += amt;
    else dailyAgg.set(k, { sheet_type: x.sheet_type || 1, master_id: x.master_id, amount: amt });
  };
  for (let i = 0; i < dn; i++) {
    if (dailyId) for (const x of rollRewardId(dailyId)) bumpDaily(x);
  }
  return {
    normalDrops: convertReEventDrops([...agg.values()], questId),
    dailyDrops: convertReEventDrops([...dailyAgg.values()], questId),
    dropId: dropId,
    dailyId: dailyId,
  };
}
/**
 * 组装契约要求的 quest_result_temp（29 字段全覆盖）。
 * @param ctxObj {
 *   before: {rank, rankExp, stamina},          战斗前快照
 *   after:  {rank, rankExp, stamina},          战斗后快照
 *   addUserRankExp, addCharacterExp,           本次增量
 *   characterExpInfo,                          角色经验明细（可空）
 *   firstDrops, normalDrops, dailyDrops,       各类掉落
 *   addGuildExp                                公会经验（无公会时为 0）
 * }
 */
/**
 * ★★ 2026-10-21：复刻活动券（Item_Re_EventTicket）★★
 *   真机契约实证（_winr_capture/contracts_winr/quest_skip.json）：
 *     "event_ticket_drop_list":[{"sheet_type":1,"master_id":"Item_Re_EventTicket","amount":1620}]
 *   而该次 skip 是「体力30 × 54 次 = 1620」；bulk 那次是「体力15 × 7 次 = 105」×4 条
 *   ⇒ **券数 = 体力消耗 × 执行次数**（1 点体力 = 1 张）。
 *   我们此前完全没实现（用户报障：消耗体力却拿不到复刻券）。
 */
export const RE_EVENT_TICKET_ID = "Item_Re_EventTicket";

export function buildQuestResultTemp(o) {
  const b = o.before || {}, a = o.after || {};
  const cExp = Number(o.addCharacterExp) || 0;
  const info = o.characterExpInfo || [];
  // ★★★ exp_to_gold_list：满级玩家把【任务体力】折算成金币（2026-10-15 破解）★★★
  //
  // ★ 我此前的理解是错的 —— 它【不是】「角色经验溢出转金币」。
  //   错因：我拿 add_character_exp 去反推比值，而 quest/skip 的该值恒为 0 → 无法定义，
  //        于是猜了个系数 10，并标注「已知偏差」。
  //
  // ★ 真实公式（用 11 份真机录制、29 条样本逐条验证，28/29 命中）：
  //   ```
  //   金币 = 该任务的 ConsumeStamina × 100 × 本次执行次数
  //   ```
  //   实证：
  //     stam=10 → 1000    stam=15 → 1500    stam=20 → 2000    stam=30 → 3000
  //     skip_sub_quest_bulk: Sub_12_boss2_Hard_b stam=15 × skip=7 → 10500 ✅
  //     skip_daily（15 任务）: 金币 = stam×100×DailySkipCount（14/15 命中）
  //     STARFORCE bulk: stam=30 × 54 次 → 162000 ✅
  //     battle/win: Invasion_CharaExp_01_07 stam=10 → 1000 ✅
  //   ★ 唯一不符：skip_daily 那次 MasterQuest_Shooter_05（skip=2 但只给 3000）
  //     —— 同批其余 14 条都符合，判定为官方该次的异常/特殊配置，不据以改公式。
  //
  // ★ 语义：玩家 RANK 满级后，本应获得的「经验类收益」改为按任务体力折算金币 ——
  //   所以它出现在【所有战斗/跳过类端点】，且与参战角色是否满级无关。
  //   （我此前按「满级角色数」累加 → 完全偏了。）
  //
  // 入参：o.expToGoldTimes = 本次执行次数（skip/批量时 >1；战斗恒 1）
  //       o.questStamina   = 该任务的 ConsumeStamina
  // ★★★ exp_to_gold_list 支持【逐任务一条】(2026-10-16 真机契约核验后修正) ★★★
  //   真机契约实测：
  //     · `quest/skip_sub_quest_bulk`（4 个任务）→ **4 条**，每条 = 该任务 cost × 次数 × 100
  //         例：[10500,10500,10500,10500]，10500 = 15 × 7 × 100 ✅
  //     · `quest/skip_daily`（15 个任务）→ **15 条**（4000/6000/…）
  //     · `quest/skip` / `battle/win`（单任务）→ **1 条**
  //   ★ 我此前只支持「一条总和」→ bulk/daily 的结构与真机不符。
  //   入参优先级：`o.expToGoldStaminaList`（数组，逐任务）> `o.questStamina`（单值）。
  // ★★ 2026-10-21：exp_to_gold 只在【玩家 RANK 满级】时才产生 ★★
  //   缺陷实证（用户报障）：rank 41 的账号跳过时也拿到了「EXP上限報酬」。
  //   反推依据：此公式是用【满级账号（Lv100, master_rank16）】的 29 条真机样本拟合出来的，
  //   只有在 RANK 达到 UserLvMax 时，本应获得的经验收益才会折算成金币。
  // 券条目【逐任务一条】（真机 bulk 那次是 4 条 ×105，对应 4 个任务）
  const eventTicketList = [];
  const _ticketAmounts = Array.isArray(o.eventTicketAmounts)
    ? o.eventTicketAmounts
    : (Number(o.eventTicketAmount) > 0 ? [Number(o.eventTicketAmount)] : []);
  for (const a of _ticketAmounts) {
    const n = Math.round(Number(a) || 0);
    if (n > 0) eventTicketList.push({ sheet_type: 1, master_id: RE_EVENT_TICKET_ID, amount: n });
  }
  let goldList = [];
  const _maxRank = (function () {
    try {
      const t = loadTable("GroundRule/GroundRule.csv");
      const r = ((t && t.rows) || []).find(function (x) { return String(x.RuleName) === "UserLvMax"; });
      return r ? Number(r.Value) || 100 : 100;
    } catch (e) { return 100; }
  })();
  const _rank = Number(o.userRank) || 0;
  const _expToGoldEnabled = _rank >= _maxRank;
  if (!_expToGoldEnabled) {
    goldList = [];
  } else if (Array.isArray(o.expToGoldStaminaList)) {
    goldList = o.expToGoldStaminaList
      .map(function (v) { return Math.round((Number(v) || 0) * 100); })
      .filter(function (v) { return v > 0; })
      .map(function (v) { return { sheet_type: 1, master_id: "Item_Currency_Gold", amount: v }; });
  } else {
    const perRunGold = (Number(o.questStamina) || 0) * 100;
    const times = Math.max(1, Number(o.expToGoldTimes) || 1);
    const goldFromExp = perRunGold * times;
    if (goldFromExp > 0) goldList = [{ sheet_type: 1, master_id: "Item_Currency_Gold", amount: goldFromExp }];
  }
  return {
    before_user_rank: b.rank || 1,
    after_user_rank: a.rank || b.rank || 1,
    // ★ 本级内进度 = 累计 − C(等级)：UserData.exp 是【累计总经验】，
    //   直接把累计值当本级进度会让经验槽越界（2026-10-18 修正）。
    before_user_rank_exp: rankExpInLevel(b.rankExp, b.rank || 1),
    after_user_rank_exp: rankExpInLevel(a.rankExp, a.rank || b.rank || 1),
    before_need_user_rank_exp: needRankExpFor((b.rank || 1) + 1),
    after_need_user_rank_exp: needRankExpFor((a.rank || b.rank || 1) + 1),
    before_stamina: b.stamina || 0,
    after_stamina: a.stamina || b.stamina || 0,
    // ★ 教程进行中仍要发【非 0】的 add_user_rank_exp —— 反编译 `UserRankUpDirecting` 第一行就是
    //   `if (battleResultInfo.AddUserRankExp == 0) return;`（**不排后续回调**）⇒
    //   归零会让整条结算链断在第一步 ⇒ 结果画面 NEXT 永不激活（实测踩到）。
    //   「不弹 RANK UP」不是靠归零，而是靠 state.addPlayerExp 的教程守卫【不让等级跨过门槛】：
    //   客户端 IsRankUp 取决于 before/after rank，两者相等 ⇒ 不弹窗，但经验槽动画照常跑完 ⇒ 链不断。
    add_user_rank_exp: Number(o.addUserRankExp) || 0,
    add_character_exp: cExp,
    character_exp_info_list: info,
    first_drop_list: normalizeDrops(o.firstDrops),
    first_normal_drop_list: [],
    // ★ 2026-10-23：深渊每 10 层的阶段奖励（随机 SSR 装备）—— 由 battle/win 计算后传入
    stage_clear_drop_list: normalizeDrops(o.stageClearDrops),
    quest_group_clear_drop_list: [],
    quest_group_normal_clear_drop_list: [],
    daily_drop_list: normalizeDrops(o.dailyDrops),
    normal_drop_list: normalizeDrops(o.normalDrops),
    event_ticket_drop_list: normalizeDrops(o.eventTicketDrops),
    achievement_total_reward_list: [],
    // 金币关击败敌人的额外奖励 —— 契约有（9 条）但数据源未找到，保持空（诚实）
    gold_quest_defeated_enemy_reward_list: normalizeDrops(o.goldEnemyDrops),
    exp_to_gold_list: goldList,
    event_ticket_drop_list: eventTicketList,
    event_reward_info: null,
    before_guild_level: b.guildLevel || 0,
    before_guild_exp: b.guildExp || 0,
    after_guild_level: a.guildLevel || 0,
    after_guild_exp: a.guildExp || 0,
    add_guild_exp: Number(o.addGuildExp) || 0,
    // ★ 契约实证（本地 + 真机两份都是 []）：该字段是**空数组**，不是 null。
    //   我写死 null → 审计报 TYPE: 契约是数组，实现是 object（4 个端点都中）。
    //   语义：単机无公会任务 EX 结算 → 空数组（与 daily_reward_received_list 同类）。
    guild_quest_ex_result_info: [],
  };
}

// ---------- 任务表索引（公共层）----------
// ★ 收口说明（2026-09-30）：本函数原先是 routes-quest.mjs 的私有实现，
//   routes-rest.mjs 的 quest/skip_tower_quest 也需要它 → 按「通用逻辑必须收口」
//   移到公共层导出，避免每个路由文件各抄一份（抄的那份必然会漏表）。
export const QUEST_TABLES = [
  "Quest/MainQuest.csv", "Quest/SubQuest.csv", "Quest/EventQuest.csv",
  "Quest/SpQuest.csv", "Quest/CharacterQuest.csv", "Quest/TowerQuest.csv",
  "Quest/AbyssalMazeQuest.csv", "Quest/OracleLiberatorQuest.csv",
  "Quest/GuildQuest.csv", "Quest/InvasionQuest.csv", "Quest/NxNBossQuest.csv",
  "Quest/StarForceQuest.csv", "Quest/ClassChallengeQuest.csv",
  // —— 补漏（2026-09-29）——
  "Quest/MasterQuest.csv",          // ★ 大师职业任务（quest/skip 契约用的就是它）
  "Quest/QuestCharacterQuest.csv",  // 角色任务（另一个命名）
  "Quest/OtherWorldCorridor.csv",   // 異世界回廊
  "Quest/RecollectionTower.csv",    // 追想の塔
  "Quest/ReleaseRoad.csv",          // 解放の道
];
let questCache = null;
export function questRow(questId) {
  if (!questCache) {
    questCache = new Map();
    for (const t of QUEST_TABLES) {
      let tb = null;
      try { tb = loadTable(t); } catch (e) { continue; }
      if (!tb) continue;
      for (const r of tb.rows) {
        const id = r.QuestId || r["クエストID"];
        if (id && !questCache.has(String(id))) questCache.set(String(id), r);
      }
    }
    console.log("[quest] 任务表已索引: " + questCache.size + " 个任务");
  }
  return questCache.get(String(questId)) || null;
}

/**
 * 任务 → 所属「任务组集合 id」（QuestGroupSetId）。
 *
 * 权威链路【两跳】（实证 MasterQuest_Soldier_05）：
 *   ① questRow(id).QuestGroupId           = "MasterQuest_Soldier"
 *   ② Quest/QuestGroup.csv 按 QuestGroupId 查 → QuestGroupSetId = "MasterQuest_group_soldier"
 *
 * ★ 教训：绝不能用「ID 字符串推导」得到它。
 *   我第一版写成 row.QuestGroupSetId —— 而 **Quest 各表根本没有这一列**
 *   （MasterQuest.csv 的列是 Version/QuestGroupId/QuestId/...），
 *   拿一个不存在的列名去读，结果恒为 ""，正是本项目反复踩的
 *   「读了一个没有来源的字段」模式。必须经 QuestGroup.csv 这一跳。
 *
 * ★ 为什么必须收口在公共层：quest/skip 的 daily_reward_received、
 *   quest/skip_daily 的 WeeklySkipQuestList、battle/win 的任务推进
 *   都需要它 —— 分散实现必然口径不一致。
 */
export function questGroupSetOf(questId) {
  const row = questRow(questId);
  if (!row) return "";
  const gid = String(row.QuestGroupId || "");
  if (!gid) return "";
  let tbl = null;
  try { tbl = loadTable("Quest/QuestGroup.csv"); } catch (e) { return ""; }
  if (!tbl) return "";
  const g = (tbl.rows || []).find(function (r) { return String(r.QuestGroupId) === gid; });
  return String((g && g.QuestGroupSetId) || "");
}

/**
 * 任务组集合的 QuestType（= 契约里的 MasterQuestType）。
 *
 * 权威链路同 questGroupSetOf：Quest 表 QuestGroupId → Quest/QuestGroup.csv → QuestType。
 * 实证：STARFORCE_CERBERUS_HARD → 11、MasterQuest_group_soldier → 10、
 *       SP_EXP → 4、SUB_012 → 2（与两份契约的 MasterQuestType 完全一致）。
 *
 * ★ 教训：Quest 各表【没有】QuestType 列（那是 QuestGroup 表的），
 *   早期写 row.QuestType → 恒为 0（真机该值 11、我算出 0）。
 */
export function questGroupTypeOf(questId) {
  const row = questRow(questId);
  if (!row) return 0;
  const gid = String(row.QuestGroupId || "");
  if (!gid) return 0;
  let tbl = null;
  try { tbl = loadTable("Quest/QuestGroup.csv"); } catch (e) { return 0; }
  if (!tbl) return 0;
  const g = (tbl.rows || []).find(function (r) { return String(r.QuestGroupId) === gid; });
  return Number((g && g.QuestType) || 0);
}

/**
 * 取得（必要时创建）某任务的 UserQuest 记录 —— **字段必须齐全**。
 *
 * ★★ 为什么必须收口（2026-09-30 缺陷）★★
 *   UserQuest 记录的权威形状（真机契约 quest/end + quest/skip 实证，6 个字段）：
 *     { MasterQuestId, MasterQuestType, TotalClearCount,
 *       DailyClearCount, DailySkipCount, DailyItemUseCount }
 *   我此前在 **3 处** 各自手写这个对象，其中 2 处（quest/start、skip_sub_quest_bulk）
 *   只写了 4 个字段、且 MasterQuestType 写死 0 →
 *   客户端读 DailySkipCount/DailyItemUseCount 时拿到默认值，且 Type 恒 0
 *   → 表现：打完关卡点 NEXT 后卡死（quest/end 响应里 quests[] 元素字段不全）。
 *   ⇒ 按「通用逻辑必须收口」，改为本函数唯一构造。
 *
 * @param {object} s         state
 * @param {string} questId   任务 id
 * @param {number} [questType] 显式指定 QuestType（省略则查 QuestGroup.csv）
 */
export function ensureUserQuest(s, questId, questType) {
  if (!s.UserQuestList) s.UserQuestList = [];
  let q = s.UserQuestList.find(function (x) { return x.MasterQuestId === questId; });
  if (q) {
    // 修复历史脏数据：补齐缺失字段
    if (q.DailySkipCount === undefined) q.DailySkipCount = 0;
    if (q.DailyItemUseCount === undefined) q.DailyItemUseCount = 0;
    if (!q.MasterQuestType) q.MasterQuestType = questGroupTypeOf(questId);
  } else {
    q = {
      MasterQuestId: questId,
      MasterQuestType: (questType !== undefined && questType !== null && questType !== 0)
        ? questType : questGroupTypeOf(questId),
      TotalClearCount: 0,
      DailyClearCount: 0,
      DailySkipCount: 0,
      DailyItemUseCount: 0,
    };
    s.UserQuestList.push(q);
  }
  return q;
}
