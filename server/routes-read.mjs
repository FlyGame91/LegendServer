// 读接口：从【当前状态】生成响应，而不是回放固定快照。
//
// 为什么必须这样：写接口改了状态，如果读接口还回放旧快照，玩家看到的数字就会回退。
// 每个读接口都用状态引擎里的最新数据组装响应。
import fs from "node:fs";
import path from "node:path";
import { route, ok, okShaped } from "./server.mjs";
import {
  allocInstanceId, getState, markDirty, resetDailyRewardIfNeeded, grantMasterRankDailyIfNeeded, ensureAbyssQuestEntries, trackLoginDay, advanceLimitedMissions, grantSubQuestStarRewards, resetFragmentIfNeeded, resetMonthlyIfNeeded, guildInternal, invasionQuestSlots, resetDailyMissionsIfNeeded, advanceLoginMissions, resetWeeklySkipIfNeeded, resetGemRecoverIfNeeded, resetDailyClearIfNeeded, refreshStateMissions, syncLinkBattlePower, ensureBeginnerMissionProgress, refreshBeginnerTotalRewardState, refreshAdditionalLinkSoldierTypes, weeklySkipQuestList,
} from "./state.mjs";
  // ★ 2026-10-26 用户明确：**不加编队自愈**。
  //   理由（原话）：「正常情况新号就是带几个教程编队的，数据正常情况下不会出错的，
  //   异常情况咱们也不该管，不然会让异常被隐藏」。
  //   ⇒ 编队为空就自动填 = 掩盖「谁该设编队却没设」，属于项目纪律明令禁止的「兜底掩盖缺陷」。
  //   函数 ensureBattleFormation 保留在 state.mjs（便于排查时手工调用），但不再挂在自愈链上。
import { legendMasteryPercent, isSupportCharacter, recomputeStatusList } from "./character.mjs";

const HERE = path.dirname(process.argv[1] || ".");
const C = path.join(HERE, "contracts");

/** 读一次契约文件并缓存（用于那些结构复杂、我们只需回放的字段）。 */
const rawCache = new Map();
function contract(name) {
  if (rawCache.has(name)) return rawCache.get(name);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(C, name + ".json"), "utf8"));
    const r = j.result !== undefined ? j.result : j;
    rawCache.set(name, r);
    return r;
  } catch (e) { rawCache.set(name, null); return null; }
}

// ★ 2026-10-23：角色剧情列表为空 → 客户端认为「全是新剧情」→ 每次进 story 都弹 storyview 引导
// ★ 2026-10-23：adventure_read_list 为空 → 客户端认为「从没读过任何剧情」→ 反复播 storyview 引导。
//   PC 端存档里有 2 条（SP_TrueEvilGod_*，由 adventure/read 正常写入），这里在为空时补种同样的两条。
export function seedAdventureReadIfEmpty() {
  const s = getState();
  if (Array.isArray(s.adventure_read_list) && s.adventure_read_list.length) return 0;
  const groups = ["SP_TrueEvilGod_TrueDagon", "SP_TrueEvilGod_TrueHastur"];
  s.adventure_read_list = groups.map(function (g, i) {
    return { id: String(600000000 + i), player_account_id: s.UserData.id, master_quest_group_id: g };
  });
  markDirty();
  console.log("[story] adventure_read_list 为空 → 补种 " + s.adventure_read_list.length + " 条");
  return s.adventure_read_list.length;
}

export function cleanBogusStories() {
  const s = getState();
  if (!Array.isArray(s.UserCharacterStoryList)) return 0;
  const before = s.UserCharacterStoryList.length;
  s.UserCharacterStoryList = s.UserCharacterStoryList.filter(function (x) {
    return x && /^Story_Char_[0-9A-Za-z]+_[0-9]+$/.test(String(x.StoryId || ""));
  });
  const removed = before - s.UserCharacterStoryList.length;
  if (removed > 0) { markDirty(); console.log("[story] 清理脏剧情记录 " + removed + " 条"); }
  return removed;
}

export function seedCharacterStoriesIfEmpty() {
  const s = getState();
  if (Array.isArray(s.UserCharacterStoryList) && s.UserCharacterStoryList.length) return 0;
  try {
    const p = path.join(path.dirname(process.argv[1] || "."), "data", "csv", "Story", "CharacterStoryList.csv");
    if (!fs.existsSync(p)) return 0;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const sid = (cols[1] || "").trim();
      // 只接受合法剧情 id，跳过表头（CSV 有两行表头：日文 + 英文）
      if (!/^Story_Char_[0-9A-Za-z]+_[0-9]+$/.test(sid)) continue;
      const m = sid.match(/^Story_Char_([^_]+)_/);
      out.push({
        Id: allocInstanceId(s, "story"),
        PlayerAccountId: s.UserData.id,
        MasterCharacterId: m ? ("Ch" + m[1]) : "",
        StoryId: sid,
        IsRead: true,
        IsConfirmed: true,
      });
    }
    if (out.length) {
      // 只预置【一条】：让客户端认为「剧情功能已使用过」，从而不再播 storyview 引导；
      // 其余剧情保持未读（保留「新」标记）。可用 LC_STORY_SEED_N 调整条数。
      const n = Math.max(1, parseInt(process.env.LC_STORY_SEED_N || "1", 10) || 1);
      s.UserCharacterStoryList = out.slice(0, n);
      markDirty();
      console.log("[story] 角色剧情预置为已读 " + out.length + " 条（修复 story 引导重复弹）");
      return out.length;
    }
  } catch (e) { console.log("[story] seed failed: " + e.message); }
  return 0;
}

// ======================= user/load_user_data =======================
// 整个存档：直接返回当前状态。写接口的所有改动都会在这里体现。
route("user/load_user_data", function () {
  try { cleanBogusStories(); seedCharacterStoriesIfEmpty(); } catch (e) { }
  // ★★ 每日重置 + 登录任务推进（2026-10-14 补）★★
  //   顺序不能反：必须先重置（把昨天的状态清零），再推进登录任务 ——
  //   否则会把「昨天已达成的状态」当成今天的（当天仍显示已达成）。
  //   两个函数都自带【同日幂等】（靠 __missionDay / __loginMissionDay 比对），
  //   所以客户端频繁轮询本端点也只会生效一次。
  //   权威依据：GroundRule 的 Mission_Nomal_Daily_ResetTime = 0:00（JST）。
  // ★★ 2026-10-26：所有 heal* 自愈已移出本路由，改为【工具】server/heal.mjs（check / fix 主动触发）。
  //   用户原则：「异常情况咱们也不该管，不然会让异常被隐藏」。
  //   本路由只保留【业务逻辑】：定时重置、进度推进、派生数据刷新。
  resetDailyMissionsIfNeeded();
  advanceLoginMissions();
  // ★★★ 每周跳过次数重置（2026-10-15 补）★★★
  //   用户报障：「まとめてskip 按钮直接废了」—— 根因之一就是 __weeklySkip 只累加、从不重置，
  //   一旦某任务组用满上限（如 75/75）就永久卡死（按钮变灰、再也跳不了）。
  //   与上面两个日重置同一模式（靠 __weekKey 比对，跨周幂等）。
  resetWeeklySkipIfNeeded(getState());
  // ★ 宝石恢复次数的跨日重置（同属「每日计数」，与上面两个日重置并列）
  resetGemRecoverIfNeeded(getState());
  // ★ 每日【通关次数】的跨日重置（三类关卡机制都依赖它）
  resetDailyClearIfNeeded(getState());
  // ★ 2026-10-22：每日【报酬领取次数】（SPクエスト「ディリー報酬 x/2」）的跨日重置。
  //   原来只在 quest 的领取接口里才触发 → 过了 0 点不领东西就永远显示 0/2。
  resetDailyRewardIfNeeded(getState());
  grantMasterRankDailyIfNeeded(getState());   // ★ マスターランク每日特典（ヒールバイアル ×MR）
  ensureAbyssQuestEntries(getState());        // ★ 深渊迷宫任务条目（缺 type=17 会让迷宫主页 Build 崩）
  // ★ 2026-10-22：碎片领取次数（JST 口径）
  resetFragmentIfNeeded(getState());
  // ★ 2026-10-22：每月重置（每月 1 日 00:00 JST）
  resetMonthlyIfNeeded(getState());
  // ★ 2026-10-22：道中（うでだめしチャレンジ）与主线进度的一致性修复 ——
  //   父关卡没通关的道中记录必须清零，否则客户端会把它们当成「已完成」而不再显示。
  // ★ 2026-10-22：登录天数 + 期间限定任务进度
  trackLoginDay();
  advanceLimitedMissions();
  // ★ 2026-10-22：サブクエスト ★ 进度奖励
  grantSubQuestStarRewards();
  // ★ 状态型任务刷新（MasterRank / 玩家RANK / 登录天数 / ★N以上角色·装备数）
  refreshStateMissions();
  // ★ 2026-10-22：初心者ミッション —— 补建进度条目 + 刷新累计奖励的领取状态（下发给客户端）
  try { ensureBeginnerMissionProgress(); refreshBeginnerTotalRewardState(); } catch (e) { console.log("[mission] beginner 初始化失败: " + e.message); }
  // ★ 2026-10-22：支援的「アディショナルリンク」解放列表（不同职业 link 能否发动特性就靠它）
  try { refreshAdditionalLinkSoldierTypes(); } catch (e) { console.log("[link] addLink 刷新失败: " + e.message); }
  // ★ 2026-10-22：本周次数列表（星骑士等 B 型关卡的「剩余次数」靠它显示）
  try { const s2 = getState(); s2.WeeklySkipQuestList = weeklySkipQuestList(); } catch (e) { console.log("[weekly] 列表生成失败: " + e.message); }
  // ★ 2026-10-22：全量下发前把 link 合计写回主角色战力（幂等）
  syncLinkBattlePower();
  const s = getState();
  // ★ 2026-10-23：UserAssetGachaGroupList 为 null → 客户端 .ToList() 抛异常 → 整次 load_user_data 导入中断，
  //   后续所有 store（含剧情/解放）都不会被填充 → 表现为「剧情界面反复播引导」等一堆诡异现象。
  try {
    if (!Array.isArray(s.UserAssetGachaGroupList)) {
      const ref = contract("user_load_user_data");
      if (ref && Array.isArray(ref.UserAssetGachaGroupList) && ref.UserAssetGachaGroupList.length) {
        s.UserAssetGachaGroupList = ref.UserAssetGachaGroupList;
        markDirty();
        console.log("[fix] UserAssetGachaGroupList 从契约补齐 " + s.UserAssetGachaGroupList.length + " 组");
      } else {
        s.UserAssetGachaGroupList = [];
        markDirty();
        console.log("[fix] UserAssetGachaGroupList 置空数组");
      }
    }
  } catch (e) { console.log("[fix] gachaGroup err " + e.message); }
  console.log("[read] load_user_data (stamina=" + s.UserData.stamina + " gold=" +
    ((s.ItemList.AllItemList.find(function (x) { return x.master_item_id === "Item_Currency_Gold"; }) || {}).amount || 0) + ")");
  // ★★★ 必须剔除 guild_internal_data（2026-10-16）★★★
  //
  // 根因：本端点用 `ok(s)` **直接返回整个 state**，而契约的 `user_load_user_data`
  //   只有 57 个顶层键 —— **没有** `guild_internal_data`（本地契约 103 份 + 真机契约
  //   107 份逐份扫描实证：含该键的只有 9 个端点：battle_win / character_enhance(_bulk) /
  //   guild_get_guild_profile / quest_skip(_daily/_bulk/_tower) / user_load_mypage_data）。
  //
  // `finalizeBody` 的 strip 只剔 `__` 前缀键，而 `guild_internal_data` 没有前缀 → 漏网，
  //   于是 87 − 29 = 58 键（契约 57 键，多出的正是它）。
  // ⇒ 客户端拿到「契约里不该出现在此端点的公会对象」，整次 load_user_data 处理失败。
  //
  // ★ 用【浅拷贝】删除，绝不改内存 state（delete s.guild_internal_data 会破坏公会功能）。
  const out = Object.assign({}, s);
  delete out.guild_internal_data;
  delete out.guild_joined;   // 双保险（finalizeBody 也会剔，这里先剔）
  // （2026-10-17 实验已还原：unlock_content_list 不是 IsContentRelease 的判据入口）
  // ★★★ 临时诊断开关：定位「ANE(key=null)」到底是哪组字段引起的（2026-10-17，用完删除）★★★
  //   背景：用户档 9.46MB 每次 load_user_data 都抛 Dictionary.set_Item(key=null)，
  //   而契约档（8.7MB）不抛 —— 结构差异已排除（顶层键 57/57 一致），只剩【值】。
  //   用法：LEGECLOX_AB=A 或 A,B → 把这几组的字段值换成契约档的值，再看 ANE 是否消失。
  //   分组按客户端 PostRequest 的处理顺序 + 数据类型切分。
  const AB = String(process.env.LEGECLOX_AB || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  if (AB.length) {
    const ref = contract("user_load_user_data");
    if (ref) {
      const GROUPS = {
        A: ["CharacterList","SetSkillList","TrainingNode","UserCharacterStoryList","engaged_character_id_list","FavoriteUserCharacter","TodayReceivedFragmentList"],
        B: ["ItemList","preset_list","UserAssetSelectPickCharacterList","UserAssetGachaGroupList","UserAssetBoxGachaGroupList","shop_stock_info","auto_sell_item_id_list"],
        C: ["UserData","freeStoneBalance","paidStoneBalance","master_rank_data","LoginDay","deviceId","paymentId","platformId","ratingId","status","type","xgHttpStatus","productList","MonthlyPurchased","is_new_one_time_operation","is_battle_record_reset"],
        D: ["UserQuestList","MissionProgressList","limited_mission_progress_list","AchievementList","TrialList","WeeklySkipQuestList","daily_reward_received_list","mission_total_reward_list","userQuestTreasureBox","SubQuestSkipFilter","TowerQuestRecord"],
        E: ["legend_mastery_list","memory_book","contents_release_read_list","contents_release_tutorial","all_character_max_status_list","all_equipment_max_status_list","adventure_read_list","event_info_list","battle_formation_list","UserLoginBonusList","UserMyPageBackgroundList","unlock_content_list","friend_apply_list","block_player_list","shop_service_available_list","TutorialProgress"],
      };
      const swapped = [];
      for (const g of AB) {
        for (const k of (GROUPS[g] || [])) {
          if (ref[k] !== undefined) { out[k] = ref[k]; swapped.push(k); }
        }
      }
      console.log("[AB] 用契约值替换 " + swapped.length + " 个字段（组 " + AB.join("+") + "）: " + swapped.slice(0, 8).join(",") + (swapped.length > 8 ? "…" : ""));
    }
  }
  // ★★★ 诊断开关（2026-10-17）：只替换指定的顶层字段为契约值，用于逐字段二分。
  //   用法：LEGECLOX_OVERRIDE=UserMyPageBackgroundList 或 FieldA,FieldB
  //   背景：「契约档全量替换 → 首进按钮直接可用」，说明导入中断是我的某个字段引起的；
  //   而 E 组的 16 个字段里与契约有差异的只有 5 个（其余 11 个逐字节相同，不可能是元凶）。
  const OV = String(process.env.LEGECLOX_OVERRIDE || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  if (OV.length) {
    const ref0 = contract("user_load_user_data");
    if (ref0) {
      const hit = [];
      for (const k of OV) { if (ref0[k] !== undefined) { out[k] = ref0[k]; hit.push(k); } }
      console.log("[override] 用契约值替换: " + hit.join(","));
    }
  }
  return ok(out);
})

// ======================= user/load_mypage_data =======================
// 主页数据里嵌了 userData 与部分资产，用最新状态覆盖这些片段。
route("user/load_mypage_data", function (ctx) {
  const s = getState();
  // 【重要】早期实现是 `for (k of base) out[k] = base[k]` —— 直接把**契约录制值**
  // 拷进响应。这是与 okShaped 同类的「借用录制数据」泄漏：
  // 新账号下看不出问题（两边都是空/旧值），但一旦有数据就会暴露出
  // 「主页显示 0 条任务、详情显示 2083 条」这种不一致。
  // 正确做法：每个字段都从**状态**取，契约只用于确定字段集。
  const data = {
    // friend_notify_status 是【对象】（契约: {has_friend_request, has_receivable_friend_coin, has_sendable_friend_coin}）
    // —— 早期我填了 number 0，直接触发 TYPE 不符。缺省必须给同结构的对象。
    friend_notify_status: s.friend_notify_status || {
      has_friend_request: (s.friend_apply_list || []).length > 0,
      has_receivable_friend_coin: false,
      has_sendable_friend_coin: false,
    },
    // present_count 由当前礼物箱长度推导（有数据时才非 0 —— 正是 statetest 要覆盖的场景）
    present_count: s.present_count !== undefined ? s.present_count : ((s.__presentList || []).length),
    // ★ 2026-10-30：announce_list 的契约类型是【object】({announce_parts_list:[...]})，
    //   而这里原来给的是数组 [] → server.mjs 的 merge 检测到 TYPE MISMATCH 后
    //   「采用契约类型」，把【录制时的旧公告】塞回响应。那条公告的 url 指向
    //   https://notification.legend-clover.net/...（关服后已不可达）→
    //   客户端每次启动都弹公告并在 WebView 里一直 loading（用户报障「一直 connecting」）。
    //   修行：始终下发【契约形状的空公告列表】。
    announce_list: { announce_parts_list: [], announce_banner_list: [], announce_visual_list: [] },
    expired_medal_exchanged_flag: !!s.expired_medal_exchanged_flag,
    // ★★★ 这两个字段必须是【空的】—— 它们不是「当前状态」，是「本次变化的增量」★★★
    //
    // 用户报障：「还是一直循环弹框，就 3 个已完成任务，但是循环提示任务完成，根本停不下来」
    //
    // 反编译定位（游戏自带 il2cppOutput，权威）：
    //   UserAssetMissionDataStore.cs:87-102（UpdateUserMissionList）
    //     foreach (mission in updateUserMissionList) {
    //         if (mission.IsAchieved && !mission.IsReceived && isNotify)   // 行 87
    //             noticeList.Add({m_MissionId, m_MissionType});            // 行 89-95
    //     }
    //     if (!noticeList.IsEmpty()) NoticeController.SetNoticeList(noticeList);  // 行 99-102
    //   TemporaryMissionList.cs:17-27（扩展方法 AddOrUpdate）
    //     if (list.IsEmpty()) return;   // 空数组直接 return，不会弹
    //     ...UpdateUserMissionList(list, isNotify);
    //   ★ 关键：判定【只依赖 IsAchieved/IsReceived】，**没有任何「已弹过」的本地记录**。
    //     ⇒ 只要某任务停在 achieved && !received，**每一次**带该列表的响应都会重新弹它。
    //
    // 真机契约实证（_winr_capture/contracts_winr 全量比对）：
    //   user/load_user_data        → MissionProgressList = **2083**（完整快照）
    //   user/load_mypage_data      → MissionProgressList = **0**   ← 空！
    //   user/update_user_data      → 21（本次变化）
    //   其余写端点 → 0~7（本次变化）
    //   ⇒ 语义 = 「本次操作变动的任务增量」，**只有 load_user_data 是全量快照**。
    //
    // 缺陷：我给 load_mypage_data 也塞了全量 2083 条 →
    //   客户端的 load_mypage_data 是**主页每 ~7 秒轮询一次**的端点 →
    //   于是每 7 秒都收到那 3 条「已达成未领取」→ 每 7 秒重弹一次 → 无限循环。
    //   （服务端日志实证：16:47:25 之后每 ~7 秒一次 load_mypage_data，持续不停）
    //
    // 修法：按真机语义返回**空数组**（本端点不做任何任务变更）。
    //   ★ 不能「返回全部但客户端只取变化」—— 契约就是空的，客户端会全量遍历。
    MissionProgressList: [],
    limited_mission_progress_list: [],
    guild_internal_data: guildInternal(),
    having_service_expire_list: s.having_service_expire_list || [],
    userData: s.UserData,
    freeStoneBalance: s.freeStoneBalance,
    paidStoneBalance: s.paidStoneBalance,
    master_rank_data: s.master_rank_data,
    FavoriteUserCharacter: s.FavoriteUserCharacter,
    engaged_character_id_list: s.engaged_character_id_list || [],
  };
  return okShaped(ctx.path, data);
});

// ======================= user/update_user_data =======================
// 客户端把本地改动同步上来：合并进状态后回传。
route("user/update_user_data", function (ctx) {
  const s = getState();
  let patch = {};
  try { patch = JSON.parse(ctx.body || "{}"); } catch (e) { patch = {}; }
  const p = patch.result !== undefined ? patch.result : patch;
  let merged = 0;
  for (const k of Object.keys(p || {})) {
    // UserData 字段大小写【两种都要认】：契约/客户端用 userData（小写 u）。
    // 早期只判 "UserData"（大写）→ 永远不匹配 → 玩家改名/资料修改全被丢弃。
    if (/^userdata$/i.test(k) && p[k] && typeof p[k] === "object" && !Array.isArray(p[k])) {
      for (const f of Object.keys(p[k])) { s.UserData[f] = p[k][f]; merged++; }
      continue;
    }
    s[k] = p[k];
    merged++;
  }
  if (merged) markDirty();
  // 记录客户端上传的【顶层键】—— 排查「state 被客户端上传污染」的关键线索。
  // 例：若客户端上传里带了 guild_internal_data / guild_joined，通用合并会把它写进 state，
  // 从而影响 guildInternal() 的判定。
  const keys = Object.keys(p || {});
  console.log("[read] update_user_data merged " + merged + " field(s); keys=[" +
    keys.slice(0, 40).join(",") + (keys.length > 40 ? ",+" + (keys.length - 40) : "") + "]");
  if (keys.some(function (k) { return /guild/i.test(k); })) {
    console.warn("[read] ⚠ update_user_data 含 guild 相关键: " + keys.filter(function (k) { return /guild/i.test(k); }).join(","));
  }
  // 契约：{ userData, serverTime, InvasionQuestSlot, achievementList, trialList,
  //         fragmentReceiveCountIncrease, unlock_content_list,
  //         MissionProgressList, limited_mission_progress_list }
  // 早期直接 ok(s) 把整个存档当 result 返回 —— 形状完全不对。
  return okShaped(ctx.path, {
    userData: s.UserData,
    serverTime: Math.floor(Date.now() / 1000),
    // ★ 与 quest/get_invasion 同源（收口在 state.mjs 的 invasionQuestSlots()）
    InvasionQuestSlot: invasionQuestSlots(),
    achievementList: s.AchievementList || [],
    trialList: s.TrialList || [],
    fragmentReceiveCountIncrease: s.fragmentReceiveCountIncrease || { increased_count: 0 },
    unlock_content_list: s.unlock_content_list || [],
    // ★ 增量语义（真机契约实证 user/update_user_data → 21 条，不是全量 2083）：
    //   只有 user/load_user_data 是全量快照，其余端点的这两个字段都是「本次变化的」。
    //   塞全量会让客户端把「长期 achieved && !received」的任务【每次】都重弹
    //   （反编译 UserAssetMissionDataStore.cs:87-102 只判 IsAchieved/IsReceived，无已弹记录）。
    //   详见同文件 load_mypage_data 的完整说明。
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ======================= 支付/货币余额 =======================
route("payment/get_payment_info", function (ctx) {
  const s = getState();
  return okShaped(ctx.path, {
    xgHttpStatus: 205,
    platformId: null, deviceId: null, ratingId: null, type: null,
    paymentId: null, status: null, productList: [],
    paidStoneBalance: s.paidStoneBalance || 0,
    freeStoneBalance: s.freeStoneBalance || 0,
  });
});
// 契约里 update_free_currency 返回 result:[]（空数组，非对象）。保持原样以免客户端反序列化失败。
route("payment/update_free_currency", function (ctx) {
  // 【关键修复】此前返回 `{"result":[]}`（空数组），而客户端类
  // FreeCurrencyEarnUpdateApi 声明的是**对象**：
  //   TemporaryPaymentParameter { xgHttpStatus, platformId, deviceId, ratingId,
  //                                type, paymentId, status, paidStoneBalance, freeStoneBalance }
  // 其 PostRequest 会把结果传给 TemporaryPaymentParameterExtend.AddOrUpdate(result)。
  // 传空数组 → 反序列化得 null → AddOrUpdate(null) 抛 NullReferenceException
  // （BepInEx 日志里那条 NRE 就是它），并干扰后续的卡池期间判定。
  //
  // 注：录制的契约本身也是 `{"result":[]}` —— 但那是**抓包时服务端真的返回了空**，
  // 不能作为实现依据。此处以**客户端类型声明**为准（类型是硬约束）。
  // ★★ 按【真机契约】返回空数组（2026-09-30 修正）★★
  //   真机契约（三份独立样本一致）：{"result":[]}
  //   我早期担心"空数组 → 反序列化得 null → AddOrUpdate(null) 抛 NRE"，
  //   于是返回了完整的 TemporaryPaymentParameter 对象。但反编译 C++ 源码
  //   （Assembly-CSharp__13.cpp:18186-18195，源 TemporaryPaymentParameter.cs:29-31）
  //   证实 AddOrUpdate 对 null 有保护：
  //       if (result == null) { return; }      // 直接返回，不崩
  //   ⇒ 返回 [] 是安全的，且与真机一致。改为 []。
  //   （石头余额由 payment/get_payment_info 与 user/load_user_data 下发，不靠本端点。）
  return okShaped(ctx.path, []);
});
route("payment/get_stone_balance_detail", function (ctx) {
  // ★★ 按【真机契约】实现（2026-09-30 修正）★★
  //   真机契约（三份独立样本完全一致，含 4.24.1 正式服 + 新账号）：
  //       {"result":{"xgHttpStatus":205,"PaymentBalanceList":[]}}
  //   —— 只有 2 个字段，【不含】paidStoneBalance / freeStoneBalance！
  //   早期我多返回了 paidStoneBalance/freeStoneBalance 且 xgHttpStatus 写成 0，
  //   客户端解析后判定数据异常 → 弹「通信エラーが発生しました。タイトルに戻ります」，
  //   且请求序列【停在该端点之后】（实测 09:17 起不再发 load_mypage_data）。
  //   注意：石头余额由 payment/get_payment_info 下发（真机那里才有
  //   paidStoneBalance/freeStoneBalance 字段），不是本端点。
  return okShaped(ctx.path, { xgHttpStatus: 205, PaymentBalanceList: [] });
});

// ======================= 用户资料修改（写状态）=======================
route("user/change_player_message", function (ctx) {
  const s = getState();
  let req = {}; try { req = JSON.parse(ctx.body || "{}"); } catch (e) {}
  if (typeof req.player_message === "string") { s.UserData.profileMessage = req.player_message; markDirty(); }
  console.log("[read] change_player_message -> " + s.UserData.profileMessage);
  // 契约：{ player_message }（返回刚设置的那条消息），不是整个 UserData。
  return okShaped(ctx.path, { player_message: s.UserData.profileMessage });
});
route("user/change_mypage_background", function (ctx) {
  const s = getState();
  let req = {}; try { req = JSON.parse(ctx.body || "{}"); } catch (e) {}
  if (!s.UserMyPageBackgroundList) s.UserMyPageBackgroundList = {};
  s.UserMyPageBackgroundList.current_background_id = req.background_id || null;
  s.UserMyPageBackgroundList.current_still_id = req.still_id || null;
  markDirty();
  // 契约 result 是数组 []，不是对象
  return ok([]);
});
route("user/change_profile_character_frame", function (ctx) {
  const s = getState();
  let req = {}; try { req = JSON.parse(ctx.body || "{}"); } catch (e) {}
  if (req.master_item_id) s.UserData.profileFrameMasterId = req.master_item_id;
  if (req.master_character_id) s.UserData.profileCharacterMasterId = req.master_character_id;
  markDirty();
  // 契约：{ userData, MissionProgressList, limited_mission_progress_list }
  // 契约：{ userData, MissionProgressList, limited_mission_progress_list }
  // ★ 这两个字段是「本次变化」的增量，真机该端点为 0 条 —— 不是全量（见 load_mypage_data 的说明）
  return okShaped(ctx.path, { userData: s.UserData, MissionProgressList: [], limited_mission_progress_list: [] });
});

console.log("[routes-read] 读接口已注册（从状态生成）");