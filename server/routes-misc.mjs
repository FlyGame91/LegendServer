// 扭蛋 / 商店 / 礼物 / 背包 写接口：按入参修改状态。
import { route, ok, shapedForPath, okShaped } from "./server.mjs";
import { loadTable } from "./masterdata.mjs";
import { advanceTutorialStage, getState, markDirty, addItem, addStone, applyRewards, toItemFormatList, playerAllAssetFor, playerAllAssetFull, peekGachaCount, bumpGachaCount, recordEmissionHistory, normalizeSelectPickList, selectPickIds, selectPickResetCount, getEmissionHistory, itemsFromRequest, repairCharacterCodes, flushNow, touchedPlayerAllAsset, touchedPlayerAssets, touchAmulet, touchEquipment, autoSellResults, allocInstanceId, consumeItems, currentItemCount } from "./state.mjs";
import { roll, costFor, selectableCharacters, bonusFor, gachaGroups, getMasterGacha } from "./gacha.mjs";
import { createCharacter, initialSkillId, isSupportCharacter, statusCodeFor, initialBreakLimit, fragmentCountFor, fragmentItemFor, joinedRewardFor, firstClearAndTrialRewards } from "./character.mjs";
import { isEquipment, createEquipment, sellRewardsFor } from "./item.mjs";
import fs from "node:fs";
import path from "node:path";

// 运行目录（PC = server/，安卓 = files/lcserver/）—— 所有诊断开关都走这里
const HERE = path.dirname(process.argv[1] || ".");

function parse(b) { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// ==================== gacha/roll ====================
// 请求：{ gachaGroupId, gachaId, buttonId, tryRollCount, ... }
// 行为：按 MasterData 的消耗扣石头，发抽到的角色/道具。
let gachaTbl = null, gachaCostTbl = null;
function ensureGacha() {
  // 扭蛋数据不在 CSV 包里（在 master/load_master_data 的 master_gacha，见 gacha.mjs）
      // —— Gacha/Gacha.csv 不存在，这里不再引用。
      if (!gachaTbl) gachaTbl = null;
  if (!gachaCostTbl) gachaCostTbl = null;
}
// ==================== gacha/list ====================
// 客户端据此决定按钮可用性与「あとN回」显示。必须返回【真实计数】，
// 否则会长期停留在录制时的旧值（曾导致「1日1回」的免费池显示 0 回可抽）。
/** 构建 gacha/list：以 MasterData 的池定义 + 我们的真实计数。 */
// ★ 读路径必须用 peekGachaCount（纯读、无副作用）——
//   用 gachaCount/ensureGachaCount 会给全部 178 个池创建计数条目并落盘，
//   导致之后再也分不清「玩家真扭过的池」（实测症状：新账号扭 1 次后返回 178 个池）。
function buildGachaGroupList(s) {
  const list = gachaGroups(function (groupId, gachaId, buttonId) {
    return peekGachaCount(groupId, gachaId, buttonId);
  });
  // ★★★ 2026-10-21：自选池【仅保留真机样本里出现过的按钮】★★★
  //   真机 SelectPick00231 只回 1 个按钮（無償魔宝石_10回引く），
  //   而 master 里该池有 4 个（含 有償_10連_1500 / 有償魔宝石_1日1回割引_1回引く）。
  //   我们全量下发后卡池页白屏，且控制台有 FormatException（疑似客户端要解析
  //   "有償_10連_1500" 这类带数字后缀的按钮 id）。先按真机样本收敛验证。
  for (const g of list) {
    if (!/^SelectPick/i.test(String(g.gachaGroupId))) continue;
    for (const gl of (g.gachaList || [])) {
      if (!Array.isArray(gl.buttonList)) continue;
      const keep = gl.buttonList.filter(function (b) { return String(b.buttonId) === "無償魔宝石_10回引く"; });
      if (keep.length) gl.buttonList = keep;
    }
  }
  return list;
}

/**
 * ★★ 「玩家交互过的扭蛋池」列表 —— gacha/list 与 gacha/roll 的**唯一实现**。
 *
 * 为什么必须收口（本项目铁律 + 实际踩坑）：
 *   真机实测：玩家侧列表【只含交互过的池】—— 建号后只扭过教程池 → ARRAY[1]。
 *   早期 gacha/list 做了过滤、gacha/roll 却直接用全量 buildGachaGroupList(s) →
 *   roll 返回 **178 个池**（含玩家从未碰过的），客户端拿它更新本地计数器，
 *   状态与 list 不一致 → **通信エラー**（用户实测反馈的现象）。
 *   ★ 两个判据必须在调用 buildGachaGroupList 之前取快照 —— 它有读副作用
 *     （gachaGroups → peekGachaCount 会为全部 178 个池创建计数条目）。
 * @returns { everRolled: boolean, groups: Array }  everRolled=false 时应回 null
 */
export function touchedGachaGroups(s) {
  const prevCounts = (s.__gachaCounts && typeof s.__gachaCounts === "object") ? s.__gachaCounts : {};
  const prevKeys = Object.keys(prevCounts);
  const touched = new Set();
  for (const k of prevKeys) { const gid = String(k).split("|")[0]; if (gid) touched.add(gid); }
  const all = buildGachaGroupList(s);
  return { everRolled: prevKeys.length > 0, groups: all.filter(function (g) { return touched.has(g.gachaGroupId); }) };
}

/**
 * ★★ 2026-10-20：按【开放期】下发全部卡池（修复「カチャ页 无卡池」）★★
 *
 * 原实现只下发「玩家交互过的池」（touchedGachaGroups），新号只有教程池 →
 * 教程结束后卡池页直接空白（「現在開催中のガチャはありません」），抽卡教程也接不下去。
 *
 * 正解：master_gacha.gacha_group 里有 start_date / end_date（字符串 "YYYY/MM/DD HH:mm:ss"），
 *   绝大多数是 2020/09/28 ~ 2100/12/31（长期开放）。这里按【当前时间落在开放期内】筛选，
 *   和 gacha/roll 使用同一实现，避免「list 与 roll 集合不一致 → 客户端计数错乱 → 通信エラー」。
 */
function parseGachaDate(v) {
  if (!v) return 0;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const m = String(v).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2}):(\d{2}))?/);
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                     Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  return d.getTime();
}

export function availableGachaGroups(s) {
  // ★★★ 2026-10-21 最终规则（真机数据逐字段核对）★★★
  //   集合 = 交互过的池 ∪ 解放条件已满足的池（持有票券 → 票券池）
  //   票券池按钮的 totalCount 【= 持有票券数】（真机实证 totalCount=69 正好是券数）；
  //   我此前把它当“已抽次数”恒填 0 → 客户端拿 0 处理时抛 FormatException → 卡池白屏。
  const mg = getMasterGacha();
  const groups = mg.gacha_group || [];
  const all = buildGachaGroupList(s);
  if (!all.length) return [];
  const byId = new Map();
  for (const g of groups) byId.set(String(g.gacha_group_id), g);

  const counts = (s.__gachaCounts && typeof s.__gachaCounts === "object") ? s.__gachaCounts : {};
  const touched = new Set(Object.keys(counts).map(function (k) { return String(k).split("|")[0]; }));

  const out = [];
  const seen = new Set();
  for (const x of all) {
    const gid = String(x.gachaGroupId);
    if (seen.has(gid)) continue;
    const g = byId.get(gid);
    if (!g) continue;
    const cond = Number(g.release_condition) || 0;
    let keep = touched.has(gid);
    let ticketHave = -1;
    if (cond !== 0) {
      const val = g.release_condition_value || {};
      const need = Number(val.amount) || 0;
      if (need > 0) {
        try { ticketHave = currentItemCount(s, String(val.master_id || "")); } catch (e) { ticketHave = 0; }
        if (ticketHave >= need) keep = true;
      }
    }
    // ★ 诊断：_no_ticket_pool.flag → 不下发票券池（保留持有票券）
    try {
      if (fs.existsSync(path.join(HERE, "_no_ticket_pool.flag")) && cond !== 0) continue;
    } catch (e) {}
    if (!keep) continue;
    // 票券池按钮：totalCount = 持有券数
    if (ticketHave >= 0) {
      for (const gl of (x.gachaList || [])) {
        for (const btn of (gl.buttonList || [])) { btn.totalCount = ticketHave; btn.dailyCount = 0; }
      }
    }
    out.push(x); seen.add(gid);
  }
  return out;
}

// ==================== gacha/emission_history ====================
// 「獲得履歴」页面读这个。原来未实现（走回放），回放数据的 created_at 又是我脱敏时
// 改成的 2025-01-01，客户端按 unix 解析 → 显示 1970-01-01。现在返回真实记录。
route("gacha/emission_history", function (ctx) {
  const list = getEmissionHistory();
  console.log("[gacha] emission_history -> " + list.length + " 条");
  return okShaped(ctx.path, { gacha_emission_history: list });
});

/**
 * 角色的初始技能 id。
 *
 * 优先用 Character.csv 的 InitialSkillId（主角色的真实初始技能）；
 * 支援角色该字段为空，其技能记录在存档的 SetSkillList 里（形如 4100010）——
 * 那是玩家已开出的技能，作为回退足够（契约只要求第 1 条是字符串技能 id）。
 */
function skillIdFor(masterCharacterId) {
  const fromMaster = initialSkillId(masterCharacterId);
  if (fromMaster) return fromMaster;
  const s = getState();
  const hit = (s.SetSkillList || []).find(function (x) { return x.master_character_id === masterCharacterId && x.master_skill_id; });
  return hit ? String(hit.master_skill_id) : null;
}

route("gacha/list", function (ctx) {
  const s = getState();
  // 顺带自愈历史遗留的角色 code/归属（客户端进扭蛋页必调本端点）
  repairCharacterCodes(isSupportCharacter, statusCodeFor, initialBreakLimit);
  // ★ 真机实测（2 次）：新账号【从未扭过蛋】时 UserAssetGachaGroupList = **null**；
  //   扭过一次后才是 ARRAY[1]（只含玩家交互过的池，非全量）。
  //   早期我恒返回 178 项全量池 —— 新账号不该有。
  //   ★ 判据必须在【buildGachaGroupList 之前】取：
  //     buildGachaGroupList → gachaGroups(gachaCount) → state.gachaCount() 会
  //     【创建】__gachaCounts 条目（读的副作用），之后再判就恒为 true。
  // ★★ 两个判据都必须在 buildGachaGroupList【之前】取：
  //   buildGachaGroupList → gachaGroups(gachaCount) → state.gachaCount() 会给
  //   【全部 178 个池】创建 __gachaCounts 条目（读的副作用），之后再判就恒为 true、
  //   且无法区分「玩家真扭过的池」。
  //   · everRolled    ：state 里原本有没有计数记录 → 决定回 null 还是数组
  //   · touchedGroups ：原本记录里出现过的 groupId → 决定数组含哪些池
  //     真机实测：建号后只扭过教程池 → ARRAY[1]（只含 Other_Tutorial1），不是全量 178。
  // ★★ 教程期间【只回教程池】★★（2026-10-20 实测）
  //   回 59 个池时客户端直接显示「現在開催中のガチャはありません」（列表被整体判为不可用）；
  //   而真机那一刻 gacha/list 只回 1 个池（Other_Tutorial1，见录制 77/99_resp）→ 页面正常。
  //   故：教程未结束（Stage<100）时只下 tutorial 池；结束后才按开放期下发全部池。
  // ★★ 2026-10-20：严格对齐真机的“从未抽过 → null”+“抽过后才是数组” ★★
  //   真机录制：建号后第一次 gacha/list（还没抽过）= **null**（77_resp, 115B）；
  //   抽过教程池之后 = ARRAY[1]（99_resp, 423B，只含 Other_Tutorial1）。
  //   实测：未抽过却回数组时，卡池页显示「現在開催中のガチャはありません」。
  const stage = Number((s.TutorialProgress && s.TutorialProgress.Stage) || 0);
  const counts = (s.__gachaCounts && typeof s.__gachaCounts === "object") ? s.__gachaCounts : {};
  const everRolled = Object.keys(counts).length > 0;
  const allOpen = availableGachaGroups(s);
  const groups = !everRolled
    ? []
    : (stage < 100
        ? allOpen.filter(function (g) { return /^Other_Tutorial/i.test(g.gachaGroupId); })
        : allOpen);
  // 读取侧也做一次形状迁移：state 里若残留旧形状（select_character_id_list），
  // 客户端 LoadUserGachaApi 会 List.Add(entry.master_character_id) 加进 null
  // → GachaPageDetailGroupView 取 CharacterInfo(null) → NRE → 资源缓存不排空 → 卡死。
  // ★ 诊断开关：存在 _gacha_replay.flag 时，原样回放真机 gacha/list 响应
  try {
    if (fs.existsSync(path.join(HERE, "_gacha_replay.flag"))) {
      const cap = JSON.parse(fs.readFileSync(path.join(HERE, "contracts", "gacha_list.json"), "utf8"));
      console.log("[gacha] 回放真机 gacha/list（诊断模式）");
      return okShaped(ctx.path, cap.result || cap);
    }
  } catch (e) { console.error("[gacha] 回放失败: " + e.message); }
  normalizeSelectPickList(s, null, []);
  // ★ 2026-10-21 撤销：曾在此处把 master 的自选角色全量写进 state，
  //   结果污染了 UserAssetSelectPickCharacterList（6 条 → 几十条），客户端解析崩溃导致卡池白屏。
  // （自选池补齐逻辑已移除：会污染 UserAssetSelectPickCharacterList）
  // ★ 诊断：存在 _gacha_null.flag 时返回“无池”（等同新号）
  try {
    if (fs.existsSync(path.join(HERE, "_gacha_null.flag"))) {
      console.log("[gacha] 诊断模式：返回 null");
      return okShaped(ctx.path, { UserAssetGachaGroupList: null, UserAssetBoxGachaGroupList: null, UserAssetSelectPickCharacterList: [] });
    }
  } catch (e) {}
  console.log("[gacha] list -> " + groups.length + " groups, selectPick " + (s.UserAssetSelectPickCharacterList || []).length);
  return okShaped(ctx.path, {
    UserAssetGachaGroupList: groups.length ? groups : null,
    UserAssetBoxGachaGroupList: null,
    UserAssetSelectPickCharacterList: s.UserAssetSelectPickCharacterList || [],
  });
});

/**
 * ★★ 扭蛋抽取的【唯一实现】—— 从 gacha/roll 路由抽出，供 payment/update_use_currency 复用。
 *
 * 为什么必须抽出来：payment/update_use_currency 在结算「待处理的付费购买」时
 *   需要与 gacha/roll【完全一致】的副作用（角色入库 + 碎片折算 + BonusList + player_all_asset）。
 *   早期 payment 直接调 roll()（只返回 emissions）→ BonusList/player_all_asset 恒空，
 *   而契约那次的响应里这四项都有值（10 emissions / 4 BonusList / 3 bonus / 7 items）。
 *   复制一份逻辑必然产生分歧，故收敛为单一实现（本项目铁律）。
 * @returns 响应体对象（不含 {result} 包装）
 */
route("gacha/roll", function (ctx) {
  const req = parse(ctx.body);
  return okShaped(ctx.path, performGachaRoll(req));
});

export function performGachaRoll(req) {
  const s = getState();
  // ★★ 教程十连的请求体带 tutorialProgressType=16 —— 不推进就会导致「未所持キャラ獲得」
  //   弹窗出现后整屏点不动（客户端认为抽卡这步没完成）。见 state.mjs advanceTutorialStage 注释。
  try { advanceTutorialStage(req.tutorialProgressType); } catch (e) {}
  const n = Math.max(1, num(req.tryRollCount) || 1);

  // 抽取（真实池子，见 gacha.mjs 的说明）
  const res = roll(req.gachaId, req.buttonId, n);
  const emissions = res.GachaEmisions.GachaEmissions;

  // 消耗：按卡池定义（免费池不扣；否则看按钮定价）
  const costInfo = costFor(req.gachaId, req.buttonId, n);
  const cost = costInfo.cost;
  if (!costInfo.free && cost > 0) {
    if (costInfo.currency === "Item_Stone_Free" || costInfo.currency === "Item_Stone_Paid") {
      // 魔宝石：优先扣无偿
      const freeBal = s.freeStoneBalance || 0;
      const useFree = Math.min(freeBal, cost);
      const usePaid = cost - useFree;
      if (useFree) addStone(-useFree, 0);
      if (usePaid) addStone(0, -usePaid);
    } else {
      // 其他货币（如好友币 Item_Currency_Friend）：走道具扣减
      // ★★★ 道具货币校验（2026-10-17）★★★ 不足则拒绝抽卡
      const _chk2 = consumeItems(s, [[costInfo.currency, cost]]);
      if (!_chk2.ok) {
        console.log("[gacha] roll 货币不足: " + _chk2.id + " need=" + _chk2.need + " have=" + _chk2.have);
        // ★ 2026-10-21：不足时也要回【完整结构】—— 空对象会让客户端解析失败并卡死
        // ★ 2026-10-22：这里**不能**用 okShaped(ctx.path, ...) —— performGachaRoll 是
        //   从多个入口复用的纯函数，没有 ctx。实测（票券=0 抽 10連チケット池）：
        //   ReferenceError: ctx is not defined @ routes-misc.mjs:272 → 客户端收到 9999。
        return {
          player_all_asset: touchedPlayerAssets(),
          bonus_player_all_asset: { AllItemList: [] },
          CurrentGachaInfo: { GachaGroupId: req.gachaGroupId, GachaId: req.gachaId, ButtonId: req.buttonId, TryRollCount: 0, AppearNumber: 1 },
          BonusList: [],
          GachaEmisions: { GachaEmissions: [], IsContainsPickUpCharacter: false },
          UserAssetGachaGroupList: null,
          UserAssetBoxGachaGroupList: null,
          isGachaPeriod: true,
          MissionProgressList: [],
          limited_mission_progress_list: [],
          freeStoneBalance: s.freeStoneBalance || 0,
          paidStoneBalance: s.paidStoneBalance || 0,
          xgHttpStatus: 205, platformId: null, deviceId: null, ratingId: null,
          type: null, paymentId: null, status: null, productList: [],
        };
      }
    }
  }
  // 把抽到的东西真正入库：角色进 CharacterList，道具进 AllItemList。
  const itemRows = [];
  const newChars = [];
  const newEquips = [];
  // 重复角色折算出的碎片（要进 player_all_asset.AllItemList —— 客户端靠它刷新持有量）
  const dupFragments = [];
  // 新角色的「加入奖励」（首次获得才发）
  const newCharJoined = [];
  for (const e of emissions) {
    if (e.SheetType === 2) {
      // 角色入库。**必须按 SupportType 分流**：
      //   SupportType == 0 -> mainCharacterList
      //   SupportType != 0 -> supportCharacterList
      // 早期一律塞进 mainCharacterList，导致支援角色被当主角处理 ——
      // 客户端拿它查 linked data 失败（NRE），抽卡结果页空白且按钮无响应。
      if (!s.CharacterList) s.CharacterList = { mainCharacterList: [], supportCharacterList: [] };
      const isSup = isSupportCharacter(e.ItemId);
      const cl = isSup ? s.CharacterList.supportCharacterList : s.CharacterList.mainCharacterList;
      const owned = cl.some(function (c) { return c.master_character_id === e.ItemId; }) ||
                    (isSup ? s.CharacterList.mainCharacterList : s.CharacterList.supportCharacterList)
                      .some(function (c) { return c.master_character_id === e.ItemId; });
      if (!owned) {
        // 必须传 support 标志 —— 支援与主角色的字段名完全不同（见 character.mjs）。
        // 早期没传 → 支援角色被按主角色字段构造 → 缺 additional_link_soldier_type_list，
        // 客户端 ImportDataStore 做 .ToList() 时抛 ArgumentNullException，整次 load_user_data 失败。
        // ★ 用统一分配器（走 CHARACTER_ID_BASE = 1e8 段）——
        //   原先是硬编码 `300000000 + cl.length`，那正是【护符段】→ 与护符 id 撞车。
        const nc = createCharacter(allocInstanceId(s, "character"), s.UserData.id, e.ItemId, { isNew: true, support: isSup });
        cl.push(nc);
        newChars.push(nc);
        e.IsNew = true;
        // ★ 首次获得该角色 -> 追加 BonusList 的两大来源（此前完全没发）：
        //   ① 首通奖励 Firstclear + 试用奖励 Trial（CharacterQuest -> DecisionRewardTable）
        //   ② 加入奖励 JoinedReword（JoinedReword.csv）
        // 契约实证：新角色 Ch001800103 -> [Fragment_Main_0018 x20, Stone_Free x50, rune_master_01 x5]，
        // 与下面两个函数的输出逐项一致。
        for (const fr of firstClearAndTrialRewards(e.ItemId)) newCharJoined.push(fr);
        for (const jr of joinedRewardFor(e.ItemId)) newCharJoined.push(jr);
      } else {
        // ★ 重复角色 -> 折算碎片（此前【完全没发】，即玩家报的「抽卡奖励未发放」）
        // 规则（已用真实录制逐项验证）：碎片数量 = Character.csv 的 FragmentCount，
        // 同一角色重复多次则累加；碎片道具 id 由 Item/FragmentList.csv 反查。
        const fcnt = fragmentCountFor(e.ItemId);
        const fitem = fragmentItemFor(e.ItemId);
        if (fcnt > 0 && fitem) {
          addItem(fitem, fcnt);
          dupFragments.push({ sheet_type: 1, master_id: fitem, amount: fcnt });
        }
      }
    } else if (isEquipment(e.ItemId)) {
      // 装备：必须创建【实例】并把实例 id 写回 emission，否则客户端找不到该装备。
      // 录制的响应里装备条目就带 EquipmentUserAssetId（真实实例 id）。
      if (!s.ItemList.EquipmentList) s.ItemList.EquipmentList = [];
      const eqList = s.ItemList.EquipmentList;
      // ★ 改用统一分配器（2026-10-16）—— 原 `400000000 + eqList.length` 用的是 4e8 段
      //   （与技能段冲突），且「列表长度」在删除后会重用已有 id。
      const inst = createEquipment(allocInstanceId(s, "equipment"), e.ItemId);
      eqList.push(inst);
      newEquips.push(inst);
      e.EquipmentUserAssetId = inst.Id;
    } else {
      // 普通道具/素材：累加数量
      addItem(e.ItemId, e.Value || 1);
      itemRows.push({ sheet_type: e.SheetType, master_id: e.ItemId, amount: e.Value || 1 });
    }
  }
  // 扭蛋相关任务进度推进（契约里有 DailyMission_FriendGacha_01 之类）
  const missionProg = [];
  for (const mp of (s.MissionProgressList || [])) {
    if (/Gacha/i.test(mp.MissionId || "")) {
      mp.Progress = (mp.Progress || 0) + n;
      mp.IsAchieved = true;
      missionProg.push(mp);
    }
  }
  // 额外赠送（BonusList）：从 MasterData 取，并真正发放。
  // 注意区分两个字段（早期我混淆了）：
  //   BonusList            = 本次【赠送清单】（本次新增多少）
  //   bonus_player_all_asset = 赠送后玩家的【持有量】（含本次增加后的值）
  // ★ BonusList 的真实构成（早期我只用了 gacha_detail_info.bonus_reward，因此几乎是空的）：
  //   ① 新角色的「加入奖励」—— JoinedReword.csv（首次获得才发）
  //   ② 按钮自身的附赠 —— gacha_detail_info.bonus_reward（如 Gacha_Medal）
  // 两项都在契约里同时出现，且都必须真正发放。
  const bonusList = newCharJoined.concat(bonusFor(req.gachaId, req.buttonId));
  // ★★ 发放必须【按容器分派】，不能一律 addItem ★★
  //   缺陷（2026-09-30 用户报障「抽卡后水晶被重置到 50」）：
  //     新角色的首通奖励里有 Item_Stone_Free x50（Reward_Firstclear_Character_0018），
  //     早期一律 addItem → 石头被当成普通道具写进 ItemList.AllItemList，
  //     于是存档里多出 {master_item_id:"Item_Stone_Free", amount:50}。
  //   而客户端读石头有【两个来源】：顶层 freeStoneBalance 与 AllItemList 里的同名条目 ——
  //   当两者都存在且不一致时，界面显示成 AllItemList 的那个（截图实证：「無償 50」）。
  //   真机契约的 AllItemList 里【没有任何 Stone 条目】（石头只走顶层字段）。
  //   ⇒ 与 applyRewards 同一套分派规则（那里已经修过，这里漏了）。
  for (const b of bonusList) {
    if (!b.master_id || !b.amount) continue;
    if (b.master_id === "Item_Stone_Free") addStone(b.amount, 0);
    else if (b.master_id === "Item_Stone_Paid") addStone(0, b.amount);
    else addItem(b.master_id, b.amount);
  }
  const bonusAsset = playerAllAssetFor(bonusList.map(function (b) { return b.master_id; }));
  // 记录抽取次数（gacha/list 会读它；每日限制也据此判定）
  bumpGachaCount(req.gachaGroupId, req.gachaId, req.buttonId, 1);
  // 写入獲得履歴（gacha/emission_history 会读它，带真实时间戳）
  recordEmissionHistory(req.gachaGroupId, emissions);
  markDirty();
  flushNow();   // 关键操作：立即落盘，不等防抖
  console.log("[gacha] roll " + req.gachaId + " x" + n + " -> " + emissions.length + " emissions, bonus " + bonusList.length + ", cost " + cost + (costInfo.free ? " (FREE)" : ""));

  return {
    // 完整资产：新角色/新装备/技能/道具 —— 客户端要靠它解析抽到的东西，缺了会白屏
    // AllItemList 要含【本次全部变动道具】：普通道具 + 重复角色折算的碎片。
    // 早期只传 itemRows（而 itemRows 又只收 SheetType!=2 且非装备的条目），
    // 结果玩家十连抽到重复角色时 AllItemList 为空 —— 界面碎片持有量不更新。
    player_all_asset: playerAllAssetFull(newChars, newEquips,
      itemRows.map(function (r) { return r.master_id; })
        .concat(dupFragments.map(function (f) { return f.master_id; })),
      skillIdFor),
    bonus_player_all_asset: bonusAsset,
    CurrentGachaInfo: {
      GachaGroupId: req.gachaGroupId,
      GachaId: req.gachaId,
      ButtonId: req.buttonId,
      TryRollCount: n,
      AppearNumber: req.appearNumber || 1,
    },
    BonusList: bonusList,
    GachaEmisions: res.GachaEmisions,
    // 【必须用实时计数】buildGachaGroupList(s) 会基于 state.__gachaCounts 重建，
// 而 s.UserAssetGachaGroupList 是【契约回放的旧值】(Sp00039 恒为 totalCount=2/dailyCount=2)。
// 客户端抽卡后拿这个列表更新本地计数 → dailyCount 变回 2，超过「1日1回」上限 →
// 判定「開催期間外」并弹窗。这就是「能抽但报过期」的真根因。
    // ★ 必须用 touchedGachaGroups（与 gacha/list 同源）——
    //   早期用 buildGachaGroupList(s) 返回全量 178 个池，与 list 的 2 个不一致，
    //   客户端据此更新本地计数 → 状态错乱 → 通信エラー。
    // ★ 与 gacha/list 同一实现（否则两边集合不一致 → 客户端计数错乱 → 通信エラー）
    UserAssetGachaGroupList: (function () { const g = availableGachaGroups(s); return g.length ? g : null; })(),
    UserAssetBoxGachaGroupList: null,
    isGachaPeriod: true,
    MissionProgressList: missionProg,
    limited_mission_progress_list: [],
    xgHttpStatus: 205,
    platformId: null, deviceId: null, ratingId: null, type: null,
    paymentId: null, status: null, productList: [],
    paidStoneBalance: s.paidStoneBalance || 0,
    freeStoneBalance: s.freeStoneBalance || 0,

  };
}
route("gacha/select_character", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const gid = req.gacha_group_id;
  const ids = req.master_character_id_list || [];
  // 写入必须按契约的【扁平结构】（每角色一条，字段名 master_character_id）。
  // 曾写成「每组一条 + select_character_id_list」→ 客户端 List.Add(null) →
  // GachaPageDetailGroupView 取 CharacterInfo(null) → NRE → 资源缓存不排空 → 卡死。
  normalizeSelectPickList(s, gid, ids, undefined);
  markDirty();
  console.log("[gacha] select_character " + gid + " -> " + JSON.stringify(ids));
  return okShaped(ctx.path, {
    gacha_group_id: gid,
    select_pick_reset_count: selectPickResetCount(s, gid),
    user_select_character_list: ids,
  });
});
route("gacha/select_character_update", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const gid = req.gacha_group_id;
  const ids = req.master_character_id_list || [];
  // 「更新（重选）」= reset_count +1，并同样按契约的扁平结构写入。
  const next = selectPickResetCount(s, gid) + 1;
  normalizeSelectPickList(s, gid, ids, next);
  markDirty();
  console.log("[gacha] select_character_update " + gid + " reset=" + next + " -> " + JSON.stringify(ids));
  return okShaped(ctx.path, {
    gacha_group_id: gid,
    select_pick_reset_count: next,
    user_select_character_list: ids,
  });
});

// ==================== shop ====================
// 商店兑换：{ ShopId, GoodsId, ExchangeCount }
// 商店商品表（真实存在的是 GoodsTable / ReEventGoodsTable；
// 早期引用的 Shop/ShopItem.csv 与 Shop/Shop.csv 都不存在 → 兑换永远查不到商品）。
let shopTbl = null, shopReTbl = null;
function shopGoods(shopId, goodsId) {
  if (!shopTbl) shopTbl = loadTable("Shop/GoodsTable.csv");
  if (!shopReTbl) shopReTbl = loadTable("Shop/ReEventGoodsTable.csv");
  if (!shopTbl && !shopReTbl) return null;
  const all = [].concat(shopTbl ? shopTbl.rows : [], shopReTbl ? shopReTbl.rows : []);
  return all.find(function (r) {
    if (goodsId && String(r.GoodsId) === String(goodsId)) return true;
    return shopId && String(r.ShopId) === String(shopId);
  }) || null;
}
function shopGoodsLegacy(shopId, goodsId) {
  if (!shopTbl) return null;
  return shopTbl.rows.find(function (r) {
    return String(r.GoodsId || r["商品ID"] || r.ShopItemId || "") === String(goodsId);
  }) || null;
}
// ★★★ 2026-10-21：shop/exchange_list 是【真正的兑换】★★★
//   用户报障：复刻商店点「交換 ハーフアニバーサリーセット」，弹出来的却是
//   金币 105925 / 金券 2 / 角色 30 / 体力药 9916 —— 那全是【库存】，不是奖励。
//   根因：我把它实现成了"只读列表"（把这些商店所有商品的当前持有量当 item_format_list 返回），
//   客户端就把这份"持有量"当成"获得商品"显示了。完全没有扣 cost、也没有发奖。
//   正确语义（商品数据实证）：
//     商品 Shop_Event_Story_012_01 → ItemId = **Pack_0052**，Cost = Item_Re_EventPoint x500
//     Pack_0052 在 Item/PackItemList.csv 里 = 4 件套：
//       Item_Ticket_Gacha_R10_01 x1 / Item_Tool_Stamina_SR x5 /
//       Item_Material_Favorite_SSR x5 / Item_Currency_Gold x5,000,000
//   ⇒ 每个 ExchangeList 条目：扣 Cost×次数 → 展开 Pack（或单件）发放 → 扣库存 → 回【本次所得】。
let _packIdx = null;
function packItems(packId) {
  if (!_packIdx) {
    _packIdx = new Map();
    try {
      const t = loadTable("Item/PackItemList.csv");
      for (const r of ((t && t.rows) || [])) {
        // 载入后的字段名（实测）：Flag / ItemId(=Pack_xxxx) / OutputItemId(=真实道具) / Count / Order
        const pid = String(r.ItemId || "");
        const realId = String(r.OutputItemId || "");
        if (!/^Pack_/.test(pid)) continue;
        const cnt = Number(r["個数"] || r.Count || 1) || 1;
        if (!_packIdx.has(pid)) _packIdx.set(pid, []);
        _packIdx.get(pid).push({ id: realId, amount: cnt });
      }
    } catch (e) { console.error("[shop] PackItemList 读取失败: " + e.message); }
  }
  return _packIdx.get(String(packId)) || [];
}

route("shop/exchange_list", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const exchanges = Array.isArray(req.ExchangeList) ? req.ExchangeList : [];
  if (!shopTbl) shopTbl = loadTable("Shop/GoodsTable.csv");
  if (!shopReTbl) shopReTbl = loadTable("Shop/ReEventGoodsTable.csv");
  const gained = [];        // 本次真正获得的道具
  const consumed = [];      // 本次消耗
  for (const ex of exchanges) {
    let count = Math.max(1, Number(ex.ExchangeCount || 1));
    const goods = (function () {
      // findGoods 定义在 routes-biz.mjs，本文件用不了 → 本地查两张商品表
      for (const t of [shopReTbl, shopTbl]) {
        if (!t) continue;
        const row = (t.rows || []).find(function (r) {
          return String(r.GoodsId || r["商品ID"] || "") === String(ex.GoodsId);
        });
        if (row) return row;
      }
      return null;
    })();
    if (!goods) { console.log("[shop] exchange_list 未找到商品 " + ex.ShopId + "/" + ex.GoodsId); continue; }    // ★★★ 2026-10-22：库存上限必须校验（用户报障：まとめて交換 后商品不消失、角色重复到账）★★★
    //   权威：Shop/ReEventGoodsTable.csv 的 Limit / DailyLimit / WeeklyLimit / MonthlyLimit。
    //   旧实现完全不看 Limit → 同一件「限购 1」的角色可以被无限次兑换（每次扣 2000 点），
    //   存档里出现同一个 master 角色的多个实例（已发现 41 个重复）。
    try {
      const _key = String(ex.ShopId) + "|" + String(ex.GoodsId);
      const _done = Number((s.__shopExchanged || {})[_key] || 0);
      const _limit = Number(goods.Limit) || 0;
      if (_limit > 0 && _done + count > _limit) {
        const _left = Math.max(0, _limit - _done);
        console.log("[shop] exchange_list " + _key + " 超出限购 " + _limit + "（已兑 " + _done + "）→ 本次只兑 " + _left);
        count = _left;
      }
      if (count <= 0) continue;
    } catch (e) {}
    // 1) 扣 cost
    // parseCost 在 routes-biz.mjs，本文件用不了 → 本地解析（格式 "Item:Item_Re_EventPointx500"，可多行）
    const parseCostLocal = function (spec) {
      const out = [];
      for (const seg of String(spec || "").split(/[\r\n]+/)) {
        const body = seg.trim().replace(/^[^:]+:/, "");
        const m = body.match(/^(.+?)x(\d+)$/);
        if (!m) continue;
        const amount = Number(m[2]) || 0;
        if (m[1] && amount > 0) out.push({ itemId: m[1].trim(), amount: amount });
      }
      return out;
    };
    const costList = parseCostLocal(goods.Cost).map(function (c) { return [c.itemId, c.amount * count]; });
    const chk = consumeItems(s, costList);
    if (!chk.ok) {
      console.log("[shop] exchange_list 材料不足: " + chk.id + " need=" + chk.need + " have=" + chk.have);
      continue;
    }
    for (const c of costList) consumed.push({ master_id: c[0], amount: c[1] });
    // 2) 发放（Pack 展开 / 单件）
    const itemId = String(goods.ItemId || "");
    const amount = (Number(goods.Count || goods.Amount || 1) || 1) * count;
    // ★ sheet_type 必须来自商品表（1=道具 / 2=角色 / 3=装备 / 4=护符）——
    //   旧实现一律写 1 → 角色被当成「道具 Ch002701107」下发，客户端的獲得演出/列表刷新会失败。
    const _sheetType = Number(goods.SheetType) || (/^Ch\d{9}$/.test(itemId) ? 2 : 1);
    const list = /^Pack_/.test(itemId)
      ? packItems(itemId).map(function (x) { return { sheet_type: 1, master_id: x.id, amount: x.amount * count }; })
      : [{ sheet_type: _sheetType, master_id: itemId, amount: amount }];
    for (const g of list) {
      if (!g.master_id) continue;
      // ★ 用 applyRewards 的【实际发放结果】组装 item_format_list ——
      //   重复角色会被折算成碎片（见 state.mjs applyRewards），此时回执必须是碎片 id，
      //   否则客户端会显示「獲得 角色 XXX」但背包里多的是碎片。
      const got = applyRewards([g]);
      if (got && got.length) {
        for (const x of got) gained.push({ sheet_type: x.sheet_type !== undefined ? x.sheet_type : (x.sheetType || 1), master_id: x.master_id, amount: x.amount });
      } else {
        gained.push(g);
      }
    }
    // 3) 扣库存
    try {
      // ★★ 库存有两套结构，必须都扣 ★★
      //   ① s.shop_stock_info.event_goods / normal_goods（load_user_data 下发的）
      //   ② s.__shopStock[key].re_event_goods（shop/get_re_event_shop_stock_info 用的缓存）
      //   只扣 ① 的话，界面上「あと N 回」不会变（用户报障：交换次数不减）。
      const dec = function (arr) {
        if (!arr) return false;
        const st = arr.find(function (x) { return String(x.shop_id) === String(ex.ShopId) && String(x.goods_id) === String(ex.GoodsId); });
        if (st && st.has_stock) { st.stock = Math.max(0, Number(st.stock || 0) - count); return true; }
        return false;
      };
      // ★ 同时记入"已兑换次数"（库存重建用）
      if (!s.__shopExchanged) s.__shopExchanged = {};
      const _exKey = String(ex.ShopId) + "|" + String(ex.GoodsId);
      s.__shopExchanged[_exKey] = (Number(s.__shopExchanged[_exKey]) || 0) + count;
      dec((s.shop_stock_info && s.shop_stock_info.event_goods) || []);
      dec((s.shop_stock_info && s.shop_stock_info.normal_goods) || []);
      if (s.__shopStock) {
        for (const k of Object.keys(s.__shopStock)) {
          dec((s.__shopStock[k] && s.__shopStock[k].re_event_goods) || []);
        }
      }
    } catch (e) {}
    console.log("[shop] exchange_list " + ex.ShopId + "/" + ex.GoodsId + " x" + count +
      " → " + list.map(function (x) { return x.master_id + "x" + x.amount; }).join("+") +
      " 耗 " + costList.map(function (c) { return c[0] + "x" + c[1]; }).join("+"));
  }
  markDirty(); flushNow();
  // ★★★ 2026-10-21：按 master + 已兑换次数【重建】涉及商店的库存，随响应下发 ★★★
  //   用户报障：复刻商店兑换角色后，商品仍在列表里、剩余次数不刷新。
  //   原因：此前只回传旧的 s.shop_stock_info（没有把 __shopExchanged 折算进去）。
  //   现在：Limit（ReEventGoodsTable）− 已兑换次数 = 剩余，客户端据此显示「あと N 回 / SOLD OUT」。
  let stockInfo = {};
  try {
    stockInfo = JSON.parse(JSON.stringify(s.shop_stock_info || {}));
    const shops = new Set(exchanges.map(function (e) { return String(e.ShopId); }));
    const reTbl = loadTable("Shop/ReEventGoodsTable.csv");
    const rebuilt = [];
    for (const r of ((reTbl && reTbl.rows) || [])) {
      if (!shops.has(String(r.ShopId))) continue;
      const ex = Number((s.__shopExchanged || {})[String(r.ShopId) + "|" + String(r.GoodsId)] || 0);
      const limit = Number(r.Limit) || 0;
      rebuilt.push({
        shop_id: r.ShopId, goods_id: r.GoodsId,
        has_stock: limit > 0, stock: Math.max(0, limit - ex),
        has_per_day_exchangeable_time: false, per_day_exchangeable_time: 0,
        has_service_expired_time: false, service_expired_time: 0,
        user_exchange_period_time: 0,
      });
    }
    const keep = (stockInfo.event_goods || []).filter(function (x) { return !shops.has(String(x.shop_id)); });
    stockInfo.event_goods = keep.concat(rebuilt);
  } catch (e) { console.error("[shop] 库存重建失败: " + e.message); }
  return okShaped(ctx.path, {
    player_all_asset: touchedPlayerAssets(),
    item_format_list: gained,
    present_item_format_list: [],
    shop_stock_info: stockInfo,
    ExchangeCountConditionTrueIdList: [],
  });
});

// ==================== 背包：装备锁定 / 出售 / 强化 ====================
// ★★ 锁定/解锁 —— 契约响应形状（实证 contracts/baggage_lock.json）：
//   { equipmentList: [<装备最新形态，含 HasLocked>], amulet_list: [<护符最新形态，含 has_locked>] }
//   ★ 字段名陷阱（两套命名）：
//       装备用 **HasLocked**（首字母大写），护符用 **has_locked**（全小写）
//   早期实现写成 e.is_locked / a.is_locked —— 两个都不是客户端的字段，
//   且只回 player_all_asset，于是「锁定标记看起来没生效」。
route("baggage/lock", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const eqIds = req.equipmentIdList || [];
  const amIds = req.amulet_id_list || [];
  const lockedEq = [];
  const lockedAm = [];
  for (const e of (s.ItemList.EquipmentList || [])) {
    if (eqIds.indexOf(e.Id) < 0) continue;
    e.HasLocked = !e.HasLocked;
    lockedEq.push(e);
    touchEquipment(e.Id);
  }
  for (const a of (s.ItemList.amulet_list || [])) {
    if (amIds.indexOf(a.id) < 0) continue;
    a.has_locked = !a.has_locked;
    lockedAm.push(a);
    touchAmulet(a.id);
  }
  markDirty();
  console.log("[baggage] lock eq=" + lockedEq.length + " am=" + lockedAm.length);
  return okShaped(ctx.path, { equipmentList: lockedEq, amulet_list: lockedAm });
});
route("baggage/sell_equipment", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ids = req.equipmentUserIdList || [];
  // ★★★ 产出按权威表 `Item/EquipmentList.csv` 的 SellPrice 列（2026-10-16 修）★★★
  //   格式 `ITEM:<货币id>x<数量>`（可多段）。真机契约实证：1 件 → Gold 1500 + Equipment 100。
  //   ★ 我此前一律给 Gold 且金额写死 100 —— 产出的是各品类【专用货币】而非金币。
  const gains = [];
  const keep = [];
  for (const e of (s.ItemList.EquipmentList || [])) {
    if (ids.indexOf(e.Id) >= 0) {
      // ★ 装备实例的键是 `MasterEquipmentId`（契约实证），不是 MasterItemId
      const master = e.MasterEquipmentId || e.master_equipment_id;
      for (const g of sellRewardsFor("equipment", master, 1)) gains.push(g);
      continue;
    }
    keep.push(e);
  }
  s.ItemList.EquipmentList = keep;
  for (const g of gains) addItem(g.master_id, g.amount);
  markDirty();
  console.log("[baggage] sell_equipment x" + ids.length + " -> " + JSON.stringify(mergeGains(gains).map(function (g) { return g.master_id + "x" + g.amount; })));
  // ★ 卖装备会改 EquipmentList —— 必须用复数版 touchedPlayerAssets()（含装备/护符/角色），
  //   早期用只含道具的 touchedPlayerAllAsset()，靠契约兜底补 EquipmentList（结构对但值是录制数据）。
  return okShaped(ctx.path, { player_all_asset: touchedPlayerAssets(), item_format_list: mergeGains(gains), auto_sell_item_list: autoSellResults() });
});
route("baggage/sell_amulet", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ids = req.amulet_user_id_list || [];
  // ★★★ 产出按权威表 `Item/AmuletList.csv` 的 SellPrice 列（2026-10-16 修）★★★
  //   真机契约实证：50 件 → Gold 30000 + 星の粉 50（即每件 600 金 + 1 星の粉）✅
  const gains = [];
  s.ItemList.amulet_list = (s.ItemList.amulet_list || []).filter(function (a) {
    if (ids.indexOf(a.id) >= 0 || ids.indexOf(a.Id) >= 0) {
      const master = a.master_amulet_id || a.MasterAmuletId;
      for (const g of sellRewardsFor("amulet", master, 1)) gains.push(g);
      return false;
    }
    return true;
  });
  for (const g of gains) addItem(g.master_id, g.amount);
  markDirty();
  console.log("[baggage] sell_amulet x" + ids.length + " -> " + JSON.stringify(mergeGains(gains).map(function (g) { return g.master_id + "x" + g.amount; })));
  return okShaped(ctx.path, { player_all_asset: touchedPlayerAssets(), item_format_list: mergeGains(gains), auto_sell_item_list: autoSellResults() });
});
route("baggage/sell_item", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const list = req.item_data_list || [];
  // ★★★ 产出按权威表 `Item/SellItemList.csv` 的 SellPrice 列（2026-10-16 修）★★★
  //   真机契约实证：`Item_Material_Enchant_06_01` ×1383 → `Item_Currency_EnchantCoin` ×1383（1:1）✅
  //   ★ 我此前写成「Gold ×10/个」—— 错品类且错金额。
  //   契约请求字段是 master_id / amount（不是 master_item_id）。
  const gains = [];
  const soldIds = [];
  for (const it of list) {
    const id = it.master_id || it.master_item_id || it.masterItemId || it.itemId;
    const n = num(it.amount !== undefined ? it.amount : (it.count || it.requestCount));
    if (!id || !n) continue;
    // ★★★ 持有量校验（2026-10-17）：不足则按实有数量卖出 ★★★
    //   原实现直接 addItem(-n) → 持有不足时扣到 0，但产出仍按 n 算 = 白嫖。
    const _have = currentItemCount(s, id);
    const _use = Math.min(_have, n);
    if (_use <= 0) continue;
    const rw = sellRewardsFor("item", id, _use);
    if (!rw.length) continue;   // 不在 SellItemList（不可炼成）→ 不扣也不给
    addItem(id, -_use);
    soldIds.push(id);
    for (const g of rw) gains.push(g);
  }
  for (const g of gains) addItem(g.master_id, g.amount);
  markDirty();
  console.log("[baggage] sell_item x" + list.length + " -> " + JSON.stringify(mergeGains(gains).map(function (g) { return g.master_id + "x" + g.amount; })));
  return okShaped(ctx.path, { player_all_asset: touchedPlayerAssets(), item_format_list: mergeGains(gains) });
});
route("baggage/set_auto_sell_item", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  s.auto_sell_item_id_list = req.master_item_id_list || [];
  markDirty();
  console.log("[baggage] set_auto_sell x" + s.auto_sell_item_id_list.length);
  return okShaped(ctx.path, { auto_sell_item_id_list: s.auto_sell_item_id_list });
});

// ==================== 公告已读 ====================
route("announcement/read", function (ctx) {
  const req = parse(ctx.body);
  console.log("[announcement] read " + req.operation_announcement_id);
  // 契约 result 是空数组 []
  return ok([]);
});

/** 把同 master_id 的产出合并成一条（真机契约的 item_format_list 无重复 id）。 */
function mergeGains(gains) {
  const m = new Map();
  for (const g of (gains || [])) {
    if (!g || !g.master_id || !g.amount) continue;
    const cur = m.get(g.master_id);
    if (cur) cur.amount += g.amount;
    else m.set(g.master_id, { sheet_type: g.sheet_type || 1, master_id: g.master_id, amount: g.amount });
  }
  return [...m.values()];
}

console.log("[routes-misc] 扭蛋/商店/背包接口已注册（按入参）");