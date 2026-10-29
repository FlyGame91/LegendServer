// campaign.mjs —— 运营活动加成（2026-10-01 从新版 MasterData 破解）
//
// ★★ 为什么需要这个模块 ★★
//   用户报障：「现在有活动，character/receive_fragment 上限应该是 30」。
//   我原来硬编码 GroundRule 的 9，**完全没有活动加成** → 玩家每天少领一半以上。
//
// ★ 权威来源（三张活动表 + 反编译的公式）
//   1) ReceiveFragmentCampaign.csv —— 碎片受取次数活动
//   2) QuestCampaign.csv           —— 任务类活动（掉落量/体力报酬/报酬受取回数）
//   3) BoardGameCampaign.csv       —— 棋盘免费骰子活动
//   共同字段：Start / End / CampaignContent / ContentFixedValue
//
// ★ 公式（反编译 ReceiveFragmentUseCase.cs:82-99，逐行确认）
//   // 总量上限（GetTodayTotalReceivableCount）
//   GroundRule.GetLongValue("Fragment_Receive_Today_Receivable_Count")   // 9
//     + GetCampaignCount(1)                       // 活动 Content=1 → +18
//     + LimitPlusUseCase.GetEffectValue(1, masterRank)   // MasterRank 累计 +3
//
//   // 单角色上限（GetTodayOneCharacterReceivableCount）
//   ReceiveFragment.DailReceiveLimit                                      // 3
//     + GetCampaignCount(2)                       // 活动 Content=2
//
//   // GetCampaignCount(content) = 当前生效的 Campaign 里 ContentFixedValue 之和
//   ⇒ 玩家实测：9 + 18 + 3 = **30**（与用户所说完全一致）
//
// ★ 时间语义：表里的 Start/End 是 **JST 本地时间字符串**（"YYYY-MM-DD HH:MM:SS"），
//   直接按字符串比较即可（同格式下字典序 == 时间序）。**不要转 UTC**（我第一版转错，
//   导致 0 条生效）。

import { loadTable } from "./masterdata.mjs";

/** JST 当前时间，格式 "YYYY-MM-DD HH:MM:SS"（与 MasterData 里的 Start/End 同格式）。 */
export function nowJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

let _cache = null;
/** 加载三张活动表（惰性 + 缓存）。 */
function tables() {
  if (_cache) return _cache;
  const out = {};
  for (const [key, file] of [
    ["fragment", "ReceiveFragmentCampaign/ReceiveFragmentCampaign.csv"],
    ["quest", "QuestCampaign/QuestCampaign.csv"],
    ["board", "BoardGame/BoardGameCampaign.csv"],
  ]) {
    try {
      const t = loadTable(file);
      out[key] = (t && t.rows) ? t.rows : [];
    } catch (e) { out[key] = []; }
  }
  _cache = out;
  return out;
}

/**
 * 取得当前生效的活动条目。
 * @param {"fragment"|"quest"|"board"} kind
 * @param {string} [jst] 可注入的时间（测试用），缺省取当前 JST
 */
export function activeCampaigns(kind, jst) {
  const now = jst || nowJst();
  const rows = tables()[kind] || [];
  return rows.filter(function (r) {
    const a = r.Start, b = r.End;
    if (!a || !b) return false;
    return String(now) >= String(a) && String(now) <= String(b);
  });
}

/**
 * GetCampaignCount(content) —— 与反编译函数名一一对应。
 * 返回当前生效活动里 **同 CampaignContent** 的 ContentFixedValue 之和。
 */
export function campaignCount(kind, content, jst) {
  let sum = 0;
  for (const r of activeCampaigns(kind, jst)) {
    if (Number(r.CampaignContent) === Number(content)) sum += Number(r.ContentFixedValue) || 0;
  }
  return sum;
}

/** 碎片受取：基础 GroundRule 值（表里查，不硬编码）。 */
export function fragmentBaseLimit() {
  try {
    const t = loadTable("GroundRule/GroundRule.csv");
    const row = (t.rows || []).find(function (r) { return r.RuleName === "Fragment_Receive_Today_Receivable_Count"; });
    return row ? Number(row.Value) || 0 : 9;
  } catch (e) { return 9; }
}

/**
 * 碎片「今日总受取上限」= GroundRule 基础 + 活动(Content=1) + MasterRank 累计。
 */
export function fragmentTotalLimit(masterRank, jst) {
  return fragmentBaseLimit()
    + campaignCount("fragment", 1, jst)
    + masterRankFragmentBonus(masterRank);
}

/**
 * MasterRank 的碎片上限累计加成。
 * 数据源：MasterRank/MasterRankBonus.csv 的 UpReceivableFragmentLimit（按 rank 逐级累加，
 *   实测 rank5/10/15 各 +1 → rank16 累计 +3，与游戏内「マスターランク詳細」一致）。
 */
export function masterRankFragmentBonus(masterRank) {
  try {
    const t = loadTable("MasterRank/MasterRankBonus.csv");
    const r = Number(masterRank) || 0;
    let sum = 0;
    for (const row of (t.rows || [])) {
      if (Number(row.MasterRank) > r) break;
      sum += Number(row.UpReceivableFragmentLimit) || 0;
    }
    return sum;
  } catch (e) { return 0; }
}

/**
 * 单角色碎片「今日受取上限」= ReceiveFragment.DailReceiveLimit + 活动(Content=2)。
 */
export function fragmentDailyLimit(masterCharacterId, jst) {
  let base = 3;
  try {
    const t = loadTable("ReceiveFragment/ReceiveFragment.csv");
    const row = (t.rows || []).find(function (r) { return r.CharacterId === masterCharacterId; });
    if (row) base = Number(row.DailReceiveLimit) || 3;
  } catch (e) { /* 默认 3 */ }
  return base + campaignCount("fragment", 2, jst);
}

/**
 * QuestCampaign 的倍率/加值查询（按 Category + CampaignContent）。
 *
 * ★ Category 语义（从表内容 + 游戏内文案反推，非反编译确认）：
 *   4  = サブクエスト（掉落量倍率 6倍）
 *   9  = SPクエスト（报酬受取回数 +1）
 *   11 = デイリーミッション（体力报酬倍率 3倍，CategoryFilter 限定任务组）
 *   13 = マスタークエスト（报酬受取回数 +1）
 *
 * @param {number} category
 * @param {number} content    CampaignContent（1=倍率类 / 2=次数类 / 6=体力 / 7=?）
 * @param {string} [jst]
 */
export function questCampaignMult(category, content, jst) {
  let sum = 0;
  for (const r of activeCampaigns("quest", jst)) {
    if (Number(r.Category) !== Number(category)) continue;
    if (Number(r.CampaignContent) !== Number(content)) continue;
    sum += Number(r.ContentFixedValue) || 0;
  }
  return sum;
}

/**
 * 取某 Category 的倍率（无活动时返回 1，便于直接相乘）。
 */
export function questCampaignRate(category, content, jst) {
  const v = questCampaignMult(category, content, jst);
  return v > 1 ? v : 1;
}

/**
 * デイリーミッション的体力报酬倍率（Category=11, Content=6, FixedValue=3）。
 * ★ 带 CategoryFilter：只有属于该任务组的任务才享受加成。
 * @param {string} missionGroupId 例如 "MissionGroup_Sub_01"
 */
export function dailyMissionStaminaRate(missionGroupId, jst) {
  let best = 1;
  for (const r of activeCampaigns("quest", jst)) {
    if (Number(r.Category) !== 11) continue;
    if (Number(r.CampaignContent) !== 6) continue;
    if (r.CategoryFilter && missionGroupId && String(r.CategoryFilter) !== String(missionGroupId)) continue;
    const v = Number(r.ContentFixedValue) || 0;
    if (v > best) best = v;
  }
  return best;
}

// ============================================================================
// ★★ CampaignContent 枚举语义（2026-10-08 从 global-metadata 字符串池破解）★★
//   metadata 里这几个常量名连续存放，正是 CampaignContent 的枚举定义：
//     ACQUIRE_DROP_MUL          掉落量倍率
//     DAILY_REWARD_LIMIT_ADD    报酬受取回数 +N
//     CONSUME_STAMINA_MUL       体力消耗倍率
//     ACQUIRE_GOLD_MUL          金币倍率
//     ACQUIRE_RANK_EXP_MUL      经验倍率
//     DAILY_MISSION_REWARD_MUL  デイリーミッション报酬倍率
//   与表数据交叉验证（QuestCampaign.csv 按 Content 分组看描述）：
//     Content=1 → 「サブクエストのドロップ量N倍」                ⇒ ACQUIRE_DROP_MUL
//     Content=2 → 「SP/マスタークエスト…デイリー報酬受取可能回数+N」 ⇒ DAILY_REWARD_LIMIT_ADD
//     Content=6 → 「デイリーミッションの獲得スタミナN倍」          ⇒ DAILY_MISSION_REWARD_MUL
//     Content=7 → 「キャラクエスト本日の出撃可能回数+N」           ⇒ 出击回数
//   ReceiveFragmentCampaign.csv 复用同一枚举：
//     Content=1 → 全账号「本日の受取可能回数 +N」
//     Content=2 → 单角色「本日の1キャラあたりの受取可能回数 +N」
//   BoardGameCampaign.csv：Content=2 → 「本日無料でサイコロを振れる回数 +N」
// ============================================================================

/** CampaignContent 枚举（与客户端 metadata 常量同名，便于对照反编译）。 */
export const CAMPAIGN_CONTENT = {
  ACQUIRE_DROP_MUL: 1,          // 掉落量倍率
  DAILY_REWARD_LIMIT_ADD: 2,    // 报酬受取回数 +N
  CONSUME_STAMINA_MUL: 3,       // 体力消耗倍率
  ACQUIRE_GOLD_MUL: 4,          // 金币倍率
  ACQUIRE_RANK_EXP_MUL: 5,      // 经验倍率
  DAILY_MISSION_REWARD_MUL: 6,  // 每日任务报酬倍率
  QUEST_CHALLENGE_COUNT_ADD: 7, // 出击可能回数 +N（キャラクエスト）
};

/** QuestCategory 枚举（从 QuestCampaign 的 Category 列 + 描述反推）。 */
export const QUEST_CATEGORY = {
  SUB_QUEST: 4,            // サブクエスト（掉落量）
  SUB_QUEST_HARD: 5,       // サブクエスト（HARD）
  SUB_QUEST_CHAPTER: 6,    // サブクエスト（CHAPTER）
  SP_QUEST: 9,             // SPクエスト（报酬回数）
  MASTER_QUEST: 10,        // マスタークエスト系（报酬回数）
  DAILY_MISSION: 11,       // デイリーミッション（报酬倍率）
  CHARACTER_QUEST: 12,     // キャラクエスト（出击回数）
  MASTER_QUEST_2: 13,      // マスタークエスト（报酬回数）
};

/**
 * QuestCampaign 里「指定任务」的加值。
 * ★ 与反编译 QuestUseCase.GetDailyRewardCount 的过滤条件对齐：
 *     `x.CampaignContent == 2`（DAILY_REWARD_LIMIT_ADD）
 *   再按 Category 与（可选）QuestGroupSetId 判定是否命中该任务。
 *
 * @param {number} questType       QuestGroup.csv 的 QuestType
 * @param {string} questGroupSetId 该任务所属的 QuestGroupSetId
 * @param {number} content         CampaignContent
 * @param {number} [category]      若给出则额外要求 Category 相等
 * @param {string} [jst]
 * @returns {number} 命中的 ContentFixedValue 之和（无匹配为 0）
 */
export function questCampaignValueFor(questType, questGroupSetId, content, category, jst) {
  let sum = 0;
  for (const r of activeCampaigns("quest", jst)) {
    if (Number(r.CampaignContent) !== Number(content)) continue;
    if (category !== undefined && category !== null && Number(r.Category) !== Number(category)) continue;
    // CategoryFilter 为空 → 全部适用；非空 → 必须等于该任务的 QuestGroupSetId
    const f = String(r.CategoryFilter || "").trim();
    if (f && f !== String(questGroupSetId || "")) continue;
    sum += Math.trunc(Number(r.ContentFixedValue) || 0);
  }
  return sum;
}

/**
 * 掉落量倍率（ACQUIRE_DROP_MUL）。Command Category 与 QuestType 的对应：
 *   4=サブクエスト(NORMAL) / 5=(HARD) / 6=(CHAPTER)
 * @returns {number} 倍率（无活动 = 1）
 */
export function dropMultiplier(questType, questGroupSetId, jst) {
  // ★ 只有 サブクエスト（QuestType=2）吃这个倍率，对应 Category 4/5/6。
  //   ★★ 踩坑：我第一版写成 `cats = {2:[4,5,6]}[questType] || [null]` ——
  //     当 questType 不是 2 时 cats 为空 → 回退成 [null]（不按 Category 过滤）→
  //     **主线/袭来/SP 等所有任务都被乘 6 倍**（严重错误）。
  //   正确做法：非目标 QuestType 直接返回 1，绝不「不过滤」。
  if (Number(questType) !== 2) return 1;
  let best = 1;
  for (const cat of [4, 5, 6]) {
    const v = questCampaignValueFor(questType, questGroupSetId, CAMPAIGN_CONTENT.ACQUIRE_DROP_MUL, cat, jst);
    if (v > best) best = v;
  }
  return best;
}

/**
 * 每日报酬「受取可能回数」的额外次数（DAILY_REWARD_LIMIT_ADD）。
 * 反编译 QuestUseCase.GetDailyRewardCount：
 *   DailyRewardLimit + Σ(命中活动的 ContentFixedValue)
 */
export function dailyRewardLimitAdd(questType, questGroupSetId, jst) {
  // ★ 同样不能「不过滤」：只有表里列出的 QuestType 才有对应的 Category。
  // ★★ QuestType → Category 映射（反编译 QuestUseCase.cs:2389-2395 逐行确认）★★
  //   注意这两组**编号不对应**，是反的，不能凭数字相等去猜：
  //     QuestType=4（SPクエスト）    → Category=9
  //     QuestType=10（マスタークエスト）→ Category=13   ← 我第一版写成 10→10，漏了
  const cats = { 4: [9], 10: [13] }[Number(questType)];
  if (!cats) return 0;
  let sum = 0;
  for (const cat of cats) {
    sum += questCampaignValueFor(questType, questGroupSetId, CAMPAIGN_CONTENT.DAILY_REWARD_LIMIT_ADD, cat, jst);
  }
  return sum;
}

/**
 * デイリーミッション报酬倍率（DAILY_MISSION_REWARD_MUL，Category=11）。
 * CategoryFilter 指向 MissionGroup_*（任务组）。
 */
export function dailyMissionRewardMultiplier(missionGroupId, jst) {
  let best = 1;
  for (const r of activeCampaigns("quest", jst)) {
    if (Number(r.CampaignContent) !== CAMPAIGN_CONTENT.DAILY_MISSION_REWARD_MUL) continue;
    if (Number(r.Category) !== QUEST_CATEGORY.DAILY_MISSION) continue;
    const f = String(r.CategoryFilter || "").trim();
    if (f && missionGroupId && f !== String(missionGroupId)) continue;
    const v = Math.trunc(Number(r.ContentFixedValue) || 0);
    if (v > best) best = v;
  }
  return best;
}

/**
 * 某任务的「每日报酬可领取次数上限」= 表里的 DailyRewardLimit + 活动 DAILY_REWARD_LIMIT_ADD。
 * 反编译 QuestUseCase.GetDailyRewardCount（QuestUseCase.cs:2333-2395）：
 *   limit = Quest.DailyRewardSetting.DailyRewardLimit;
 *   if (questType == 4)  // SPクエスト
 *       foreach (campaign where Content==2 && (Category==9 || CategoryFilter==QuestGroupSetId)) limit += value;
 *   else if (questType == 10)  // マスタークエスト
 *       foreach (campaign where Content==2 && Category==13) limit += value;
 */
export function dailyRewardLimitFor(questType, questGroupSetId, jst) {
  // ★ 参数是 QuestType / QuestGroupSetId（不传 questId）——
  //   因为 campaign.mjs 不能 import quest-result.mjs（会循环依赖）。
  //   调用方（routes-quest.mjs）用 questGroupTypeOf/questGroupSetOf 解析后传入。
  let base = 1;
  try {
    const t = loadTable("Quest/QuestDailyReward.csv");
    const rows = (t && t.rows) || [];
    const qt = String(Number(questType));
    const hit = rows.filter(function (r) { return String(r.QuestType) === qt && String(r.IsDisplay) === "True"; });
    if (hit.length) base = Number(hit[0].DailyRewardLimit) || 1;
  } catch (e) { /* 用默认 1 */ }
  return base + dailyRewardLimitAdd(questType, questGroupSetId, jst);
}

/**
 * 查某任务的 MissionGroupId（DailyMission 的活动 CategoryFilter 用它匹配）。
 * 数据源：Mission/NormalMissionContent.csv 的 (MissionId → MissionGroupId)。
 * ★ 为什么需要：存档的 MissionProgressList 里【没有】MissionGroupId 字段
 *   （只有 MissionId/Progress/IsAchieved/IsReceived/MissionType），
 *   而活动的 CategoryFilter 是 MissionGroup_* → 必须回主数据查。
 */
export function missionGroupOf(missionId) {
  try {
    const t = loadTable("Mission/NormalMissionContent.csv");
    const row = ((t && t.rows) || []).find(function (r) { return r.MissionId === missionId; });
    return row ? String(row.MissionGroupId || "") : "";
  } catch (e) { return ""; }
}

// ============================================================================
// ★★ LimitPlusUseCase.GetEffectValue —— 统一的「上限提升」系统 ★★
//   权威依据（反编译）：
//     · LimitPlusUseCase.cs:92-102    —— switch(effectType) 的 12 个分支
//     · QuestUseCase.cs:2856-2892     —— effectType 3/4/5/6/7/10/11 的语义
//     · QuestUseCase.cs:2953-2960     —— 每周跳过上限（effectType 7/8/9/10/11）
//
//   每个分支都是同一个公式：
//     value = MasterRankBonus(某列, masterRank) + MasterMastery(某列, 已解锁等级)
//
//   ┌────────────┬──────────────────────────────────────────┬──────────────────────┐
//   │ effectType │ 语义                                     │ 数据源列             │
//   ├────────────┼──────────────────────────────────────────┼──────────────────────┤
//   │     0      │ 角色等级上限                             │ UpCharacterLevelLimit│
//   │     1      │ 碎片受取上限                             │ UpReceivableFragment │
//   │     3      │ サブクエスト上限（非 Adversary）         │ UpNormalSubQuestLimit│
//   │     4      │ サブクエスト上限（Adversary）            │ UpNormalSubAdversary…│
//   │     5      │ HARD サブクエスト上限（非 Adversary）    │ UpHardSubQuestLimit  │
//   │     6      │ HARD サブクエスト上限（Adversary）       │ UpHardSubAdversary…  │
//   │     7      │ StarForce 跳过上限（非 混界）            │ UpStarForceSkipLimit │
//   │     8      │ StarForce 跳过上限（混界）               │ UpkongaiStarForce…   │
//   │     9      │ イベントチャレンジ跳过上限               │ UpEventChallengeSkip │
//   │    10      │ マスタークエスト / ClassChallenge 跳过   │ UpClassChallengeSkip │
//   │    11      │ ReEvent 跳过上限                         │ UpReEventSkipLimit   │
//   └────────────┴──────────────────────────────────────────┴──────────────────────┘
//
//   ★ 语义映射的把握度（诚实标注）：
//     · effectType 0/1 —— **已确认**（碎片那次 9+18+3=30 实证）
//     · 3/4/5/6/7 —— **已确认**（QuestUseCase.cs:2856-2892 明文分支）
//     · 8/9/10/11 —— 由 switch 分支的调用点顺序 + 表列名推断，未逐行核对
// ============================================================================

/** LimitPlus 的 effectType → MasterRankBonus/MasterMastery 的列名。 */
export const LIMIT_PLUS_COLUMN = {
  // ★★★ 只有 effectType 0/1 取 MasterRankBonus，其余【只在 MasterMastery】(2026-10-15 反编译修正) ★★★
  //
  // 权威依据 `LimitPlusUseCase.GetEffectValue`（Assembly-CSharp__84.cpp:33779-34000）：
  //   ```csharp
  //   case 0: V_0 += GetTotalMasterRankBonus(rank).Item1;   // ★ 有 MasterRank 部分
  //           V_0 += GetUserMasterMasteryEffectValue(0, mastery, true);
  //   case 1: V_0 += GetTotalMasterRankBonus(rank).Item2;   // ★ 有
  //           V_0 += GetUserMasterMasteryEffectValue(1, mastery, true);
  //   case 3: V_0 += GetUserMasterMasteryEffectValue(4, mastery, true);   // ★ 只有 mastery
  //   case 4..9: 同 case 3（各用不同的 mastery 枚举）
  //   ```
  // ⇒ 我此前给 3~6 填了 `rank: "UpCharacterQuestLimit"` —— **凭空多加了 MasterRank 部分**，
  //   导致 SubQuest 每日通关上限算成 20+4+3=27（正确是 20+4=24，用户截图实证）。
  0: { rank: "UpCharacterLevelLimit",   mastery: "UpCharacterLevelLimit" },
  1: { rank: "UpReceivableFragmentLimit", mastery: "UpReceivableFragmentLimit" },
  3: { rank: null, mastery: "UpNormalSubQuestLimit" },
  4: { rank: null, mastery: "UpNormalSubAdversaryQuestLimit" },
  5: { rank: null, mastery: "UpHardSubQuestLimit" },
  6: { rank: null, mastery: "UpHardSubAdversaryQuestLimit" },
  7: { rank: null, mastery: "UpStarForceSkipLimit" },
  8: { rank: null, mastery: "UpkongaiStarForceSkipLimit" },
  9: { rank: null, mastery: "UpEventChallengeSkipLimit" },
 10: { rank: null, mastery: "UpClassChallengeSkipLimit" },
 11: { rank: null, mastery: "UpReEventSkipLimit" },
};

/**
 * LimitPlusUseCase.GetEffectValue(effectType, masterRank) —— 与反编译函数同名同义。
 *
 * @param {number} effectType  0/1/3/4/5/6/7/8/9/10/11
 * @param {number} masterRank  玩家 master_rank
 * @param {number} masteryLevel 玩家 MasterMastery 等级（LegendMasteryUseCase.GetUserMasterMasteryLevel）
 * @returns {number} 上限提升值（累加）
 */
export function limitPlusValue(effectType, masterRank, masteryLevel) {
  const col = LIMIT_PLUS_COLUMN[Number(effectType)];
  if (!col) return 0;
  return masterRankColumnSum(col.rank, masterRank) + masteryColumnSum(col.mastery, masteryLevel);
}

/** 累加 MasterRankBonus.csv 某列到 masterRank 为止。 */
function masterRankColumnSum(column, masterRank) {
  if (!column) return 0;
  try {
    const t = loadTable("MasterRank/MasterRankBonus.csv");
    const r = Number(masterRank) || 0;
    let sum = 0;
    for (const row of (t.rows || [])) {
      if (Number(row.MasterRank) > r) break;
      sum += Number(row[column]) || 0;
    }
    return sum;
  } catch (e) { return 0; }
}

/** 累加 MasterMastery.csv 某列到 masteryLevel 为止。 */
function masteryColumnSum(column, masteryLevel) {
  if (!column) return 0;
  try {
    const t = loadTable("LegendMastery/MasterMastery.csv");
    const lv = Number(masteryLevel) || 0;
    let sum = 0;
    for (const row of (t.rows || [])) {
      if (Number(row.MasterMasteryLevel) > lv) break;
      sum += Number(row[column]) || 0;
    }
    return sum;
  } catch (e) { return 0; }
}
/** 从 state 取玩家的 MasterMastery 等级（存档路径：legend_mastery_list.master_enhance_info.master_mastery_level）。 */
export function masteryLevelOf(state) {
  try {
    const s = state || {};
    const me = (s.legend_mastery_list || {}).master_enhance_info || {};
    return Number(me.master_mastery_level) || 0;
  } catch (e) { return 0; }
}

/**
 * 便捷：直接按玩家当前状态算某 effectType 的上限提升值。
 * @param {object} state  getState() 的结果
 * @param {number} effectType
 */
/**
 * ★★★ 每日通关上限（含 LimitPlus 加成）—— 权威链复刻 (2026-10-15) ★★★
 *
 * 反编译依据：`QuestUseCase.GetUserDailyClearLimit(questType, questId)`
 *   （Assembly-CSharp__86.cpp:26754-26960，源 QuestUseCase.cs:11xx）：
 * ```csharp
 * int limit = quest.DailyQuestClearLimit;            // 表里的基础值
 * switch (questType) {
 *   case 2:  // SubQuest
 *     if (difficulty == 1) limit += GetEffectValue(adversary ? 4 : 3);   // NORMAL
 *     if (difficulty == 2) limit += GetEffectValue(adversary ? 6 : 5);   // HARD
 * }
 * ```
 *   ★ `GetEffectValue` = `LimitPlusUseCase.GetEffectValue(effectType, masterRank)`
 *     = MasterRankBonus 对应列 + MasterMastery 对应列（本项**只在 MasterMastery**）。
 *
 * ★ 实测验证（2026-10-15，mastery=9）：
 * ```
 *   UpNormalSubQuestLimit            累计 Lv9 = +4   （Lv2/6/11/16/... 各 +2）
 *   UpNormalSubAdversaryQuestLimit   累计 Lv9 = +4   （同上）
 *   UpHardSubQuestLimit              累计 Lv9 = +2   （Lv3/7/12/... 各 +1）
 *   UpHardSubAdversaryQuestLimit     累计 Lv9 = +2
 * ```
 * 与用户游戏内截图**逐项吻合**：
 *   · 普通关 DailyQuestClearLimit=20 → 20+4 = **24**（界面「本日あと 24 回」）
 *   · boss关 DailyQuestClearLimit= 5 →  5+4 =  **9**（界面「本日あと 9 回」）
 *
 * ⇒ 用户报的「本日あと N 回」正是这个值；**基础值在 Quest 表、加成在 MasterMastery**。
 */
export function userDailyClearLimit(state, questType, row) {
  const base = Number(row && (row.DailyQuestClearLimit || row["1日あたりのクリア回数上限"])) || 0;
  if (!base) return 0;
  let et = null;
  if (Number(questType) === 2) {                        // SubQuest
    const diff = Number(row && row.Difficulty);
    const adv = String((row && row.Adversary) || "").toLowerCase() === "true";
    if (diff === 1) et = adv ? 4 : 3;                   // NORMAL / NORMAL-Adversary
    else if (diff === 2) et = adv ? 6 : 5;              // HARD   / HARD-Adversary
  }
  if (et === null) return base;
  let add = 0;
  try { add = limitPlusForPlayer(state, et); } catch (e) { add = 0; }
  return base + add;
}

export function limitPlusForPlayer(state, effectType) {
  const mr = Number((state && state.UserData && state.UserData.master_rank)) || 0;
  return limitPlusValue(effectType, mr, masteryLevelOf(state));
}
/**
 * 每周跳过上限（QuestSkip.csv 的 WeeklySkipLimit + LimitPlus 加成）。
 * ★ 权威链（反编译 QuestUseCase.cs:2953-2960 + QuestSkip.csv）：
 *   base = QuestSkip.csv 里该 (QuestType, QuestGroupSetId) 的 WeeklySkipLimit
 *   add  = LimitPlusUseCase.GetEffectValue(effectType, masterRank)
 *   effectType 按 QuestType 选（QuestUseCase.cs:2953-2960 的 switch）：
 *     0→10（マスター/ClassChallenge）/ 3→8（混界）/ 4→11（ReEvent）/ 7→9（事件）/ 其它→无
 * 表数据实证：STARFORCE 系列 = 70 / ClassChallenge = 30 / EVE = 200
 * 真机契约：STARFORCE_CERBERUS_HARD 的 WeeklySkipCount = 54（< 70）
 *
 * @returns {number} 周上限；0 表示不限制（表里为空）
 */
export function weeklySkipLimitFor(state, questType, questGroupSetId) {
  let base = 0;
  try {
    const t = loadTable("Quest/QuestSkip.csv");
    const qt = String(Number(questType));
    const setId = String(questGroupSetId || "");
    // 优先按 (QuestType, SetId) 精确匹配；SetId 列是多行文本，用包含判断
    const rows = (t.rows || []).filter(function (r) { return String(r.QuestType) === qt; });
    let best = 0;
    for (const r of rows) {
      const list = String(r.TargetQuestGroupSetIdList || "");
      const hit = !list.trim() || (setId && list.split(/\r?\n/).map(function (x) { return x.trim(); }).indexOf(setId) >= 0);
      if (!hit) continue;
      const v = Number(r.WeeklySkipLimit) || 0;
      if (v > best) best = v;
    }
    base = best;
  } catch (e) { base = 0; }
  if (!base) return 0;   // 表里没配 → 不限制
  // ★★★ LimitPlus 加成：effectType 按 QuestType 分派（2026-10-15 反编译修正）★★★
  //
  // 权威依据：`QuestUseCase.GetSkipLimit`（QuestUseCase.cs:2953-2997），
  //   IL2CPP 编译成 `switch (questType - 8)`：
  //   ```
  //   case 0 (QT=8)  → GetEffectValue(10)   // ClassChallenge
  //   case 1 (QT=9)  → 无加成（直接返回）
  //   case 2 (QT=10) → 无加成
  //   case 3 (QT=11) → setId 含混界标记 ? GetEffectValue(8) : GetEffectValue(7)   // StarForce
  //   case 4 (QT=12) → GetEffectValue(11)   // EventChallenge
  //   case 5 (QT=13) → 无加成
  //   case 6 (QT=14) → 无加成
  //   case 7 (QT=15) → GetEffectValue(9)    // ReEvent
  //   default        → 无加成
  //   ```
  // ★ 我此前的映射表 { 10: 10, 15: 10, 12: 8, 8: 11, 11: 9, 5: 9 } **完全错误**：
  //   · QT=11（StarForce）应取 effectType 7 或 8，我写的是 9（→ UpEventChallengeSkipLimit）
  //     ⇒ **用错了列**：StarForce 上限本该用 UpStarForceSkipLimit(+3/档)，
  //       我读了 UpEventChallengeSkipLimit(+5/档) → 上限算成 75（应 76）
  //   · QT=15（ReEvent）应取 9，我写的是 10
  //   · QT=10/12 我给了加成，实际**没有**
  // 实证：用户截图「今週のスキップ可能回数 76/76」，而我算出 75 → 差 1 就是这么来的。
  const qtN = Number(questType);
  let add = 0;
  if (qtN === 8) {
    add = limitPlusForPlayer(state, 10);                       // ClassChallenge
  } else if (qtN === 11) {
    // 混界（kongai）判定：setId 含特定标记 → effectType 8，否则 7
    const isKongai = /kongai|KONGAI|混界/.test(String(questGroupSetId || ""));
    add = limitPlusForPlayer(state, isKongai ? 8 : 7);         // StarForce
  } else if (qtN === 12) {
    add = limitPlusForPlayer(state, 11);                       // EventChallenge
  } else if (qtN === 15) {
    add = limitPlusForPlayer(state, 9);                        // ReEvent
  }
  // QT=9/10/13/14 及其它：无 LimitPlus 加成
  return base + add;
}
