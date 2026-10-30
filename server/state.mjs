// 用户状态引擎：真实的本地服务端状态。
//
// WHY: the first version of this server replayed recorded responses verbatim and IGNORED the
// request body entirely. That made a single-mission claim return the whole batch that happened
// to be recorded, and nothing ever persisted. This module is the fix: one authoritative
// in-memory state, loaded from the captured save once, mutated by request parameters, and
// written back to disk after every change.
//
// 读取：从 state/user.json（首次运行由 contracts/user_load_user_data.json 播种）。
// 写入：所有写接口都通过本模块的 helper 修改，随后 markDirty() 落盘。
import fs from "node:fs";
import { loadTable } from "./masterdata.mjs";
import { resolveRewardId } from "./rewards.mjs";
import { dropsForQuest, questRow } from "./quest-result.mjs";
// 装备/护符工厂（sheet_type 3/4 的奖励需要造实例）
import { isEquipment, createEquipment, createAmulet, sellRewardsFor, equipmentRarity, rebuildAllEquipmentStatus, rebuildAllAmuletStatus } from "./item.mjs";
import { createCharacter, isSupportCharacter, battlePowerBase, characterBattlePower, classSkillCostFor, fragmentCountFor, fragmentItemFor } from "./character.mjs";
import path from "node:path";

const HERE = path.dirname(process.argv[1] || ".");
const STATE_DIR = path.join(HERE, "state");
// ★★ 存档路径可用环境变量覆盖（2026-09-30 事故修复）★★
//   事故：functest/selftest/audit 每个用例前后都调 __reset，直接覆盖 state/user.json ——
//   我一跑测试就把用户正在玩的存档冲回基准档（177 角色 → 169 角色，石头 1亿 → 3万），
//   表现为「进不去游戏 / 数据丢失」。
//   修法：测试进程用 LEGECLOX_STATE=state/_test-user.json 启动一个【独立服务端】，
//   或直接在进程内设该环境变量，这样 __reset 只动测试档，绝不碰用户的 user.json。
//   生产/游玩时该变量为空 → 仍用 state/user.json。
const STATE_FILE = process.env.LEGECLOX_STATE
  ? path.resolve(HERE, process.env.LEGECLOX_STATE)
  : path.join(STATE_DIR, "user.json");
const SEED_FILE = path.join(HERE, "contracts", "user_load_user_data.json");

let state = null;      // the whole `result` object from user/load_user_data
let dirty = false;
let saveTimer = null;

// ---------- 载入 / 落盘 ----------
export function loadState() {
  if (state) return state;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    console.log("[state] loaded " + STATE_FILE + " (" + Object.keys(state).length + " top-level fields)");
  } else {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    state = seed.result ? seed.result : seed;
    console.log("[state] seeded from contract capture");
    saveNow();
  }
  // 一次性迁移（道中/うでだめし 回档遗留）—— 只跑一次，跑完立即落盘
  try {
    if (!state.__midwayFix20261022) { migrateMidwayRollback(state); saveNow(); }
    if (!state.__giftRitriStamp) { grantRitriStampGift(state); saveNow(); }
    if (!state.__giftGold) { grantGoldGift(state); saveNow(); }
    if (!state.__giftChallengeTicket) { grantChallengeTicketGift(state); saveNow(); }
    if (!state.__giftReEventPoint) { grantReEventPointGift(state); saveNow(); }
    if (!state.__giftGachaMedal) { grantGachaMedalFix(state); saveNow(); }
    if (!state.__convertOldEventPoints) { convertOldEventPoints(state); saveNow(); }
    if (!state.__equipStatusFix20261022) { const n = rebuildAllEquipmentStatus(state); state.__equipStatusFix20261022 = true; console.log("[equip] 属性重算 " + n + " 件（StatusType=8 修正）"); saveNow(); }
    if (!state.__equipStatusFix2_20261022) { const n = rebuildAllEquipmentStatus(state); state.__equipStatusFix2_20261022 = true; console.log("[equip] 附魔行重算 " + n + " 件（type2/type3）"); saveNow(); }
    // ★★★ 2026-10-22：护符属性重建（第 2 属性此前整个丢失 + row2 多出一个 Hp）★★★
    //   权威依据见 item.mjs 的 buildAmuletStatusList 注释（5958 件真机护符逐行核对 100% 吻合）。
    if (!state.__amuletStatusFix20261022) {
      const n = rebuildAllAmuletStatus(state);
      // ★ 护符限界突破材料补给：新加的突破材料消耗（AmuletBreakLimit.csv Cost）需要霊宝，
      //   存档里 R 霊宝一直是 0（早期只发过 SR/SSR），不补会把 R 护符的突破卡死。
      const AMULET_MATS = ["Item_Material_Amulet_Limitbreak_R", "Item_Material_Amulet_Limitbreak_SR", "Item_Material_Amulet_Limitbreak_SSR"];
      const arr = (((state.ItemList || {}).AllItemList) || []);
      for (const mid of AMULET_MATS) {
        const cur = Number(((arr.find(function (x) { return x.master_item_id === mid; }) || {}).amount) || 0);
        if (cur < 10000) { addItem(mid, 10000 - cur); console.log("[supply] 護符霊宝 " + mid + " +" + (10000 - cur) + " → 10000"); }
      }
      state.__amuletStatusFix20261022 = true;
      console.log("[amulet] 属性重建 " + n + " 件（HP+第2属性/能力2 已按主数据重算）");
      saveNow();
    }
    // ★★★ 2026-10-22：公会数据自愈（用户建会后客户端 KeyNotFound '0' + NRE）★★★
    if (!state.__guildHeal20261022) { const n = healGuildInternal(state); state.__guildHeal20261022 = true; if (n) console.log("[guild] 数据自愈 " + n + " 个字段（职位/象征/列表 id 规范化）"); saveNow(); }
    // ★ 2026-10-22：公会一律清除（建会已禁用；保持「未入会」才不会让主页按钮失效）
    // ★★★ 2026-10-22 补偿：批量限界突破只加了 1 星（碎片已按全量扣掉）★★★
    //   实证：09:48:21 的请求 Ch000100101 / Ch000200102 各 requestCount=150 ——
    //   按 Fusion/CharacterBreakLimit.csv（累计口径）150 = 3★→6★（满星），
    //   而旧代码只 +1 星（3→4）且把 150 个碎片全扣了。这里补到预览承诺的 6 星。
    if (!state.__bulkBreakLimitFix20261022) {
      const FIX = { Ch000100101: 6, Ch000200102: 6 };
      for (const c of ((state.CharacterList || {}).mainCharacterList || [])) {
        const want = FIX[c.master_character_id];
        if (want && Number(c.break_limit || 0) < want) {
          console.log("[char] 补偿限界突破 " + c.master_character_id + " " + c.break_limit + " -> " + want);
          c.break_limit = want;
        }
      }
      state.__bulkBreakLimitFix20261022 = true;
      saveNow();
    }
    // ★ 2026-10-22：一次性恢复深渊迷宫已通关层数（版本重建时被误清过 1 层：quest175）
    if (!state.__abyssClearRestore20261022) {
      state.__maze = state.__maze || {};
      if (!Array.isArray(state.__maze.cleared_battles) || state.__maze.cleared_battles.length === 0) {
        state.__maze.cleared_battles = [{ master_abyssal_maze_id: "AbyssalMaze_0012", master_battle_category_id: "BattleCategory_310", master_quest_id: "AbyssalMaze_quest175", coin_add_amount: 1.1 }];
        console.log("[abyss] 恢复已通关层数：1 层（AbyssalMaze_quest175）");
      }
      state.__abyssClearRestore20261022 = true;
      saveNow();
    }
    if (!state.__guildPurge20261022) { const n = purgeGuild(state); state.__guildPurge20261022 = true; console.log("[guild] 已清除公会数据（改动 " + n + " 项）→ 未入会"); saveNow(); }
    if (!state.__randTicketFix20261022) { resolveRandomTicketItems(state); saveNow(); }
    if (!state.__giftGold2) { grantGoldGift2(state); saveNow(); }
    if (!state.__dropCompFix20261022) { compensateLostDrops(state); saveNow(); }
    if (!state.__supplyRunes20261022) { grantRuneGift(state); saveNow(); }
    if (!state.__presetFix20261022) { fixAutoPresets(state); saveNow(); }
    if (!state.__presetFix2_20261022) { fixAutoPresets2(state); saveNow(); }
  } catch (e) { console.log("[midway] 迁移失败: " + e.message); }
  return state;
}

// ★★ 2026-10-21（用户要求）：写操作全量审计 ★★
//   markDirty() 记录「谁改的」（调用点函数名 + 文件:行），
//   saveNow() 落盘时把这些改动合并成一行写进 _state_writes.log。
//   这样任何状态变化都能追溯，不受「客户端界面显示有上限/看不出来」影响。
const WRITE_LOG = "_state_writes.log";
let pendingTags = [];
function callerTag() {
  try {
    const st = String(new Error().stack || "").split("\n");
    // [0]="Error" [1]=callerTag [2]=markDirty [3]=实际调用者
    const line = st[3] || st[2] || "";
    const fname = (line.match(/at\s+([^\s(]+)/) || [])[1] || "?";
    const loc = line.match(/([^\/\\(]+)\.(mjs|js):(\d+):\d+/);
    // 栈行常常是 `at file:///app/server/routes-rest.mjs:2722:83`（无函数名）——
    // 这种时候 fname 会是一整条 URL，不能直接当名字用。
    let who = fname;
    if (/[:\/]/.test(who)) who = "(top)";
    if (loc) return who + "@" + loc[1] + ".mjs:" + loc[3];
    return who + "@?";
  } catch (e) {}
  return "unknown";
}

/** 标记有改动，延迟合并落盘（避免写操作密集时反复写 9MB）。 */
export function markDirty(tag) {
  try { pendingTags.push(tag || callerTag()); } catch (e) {}
  dirty = true;
  if (saveTimer) return;
  // Windows 无法可靠投递可捕获的终止信号（实测 child.kill("SIGTERM") 不触发钩子），
// 所以不能只靠退出钩子保数据 —— 缩短防抖，把「崩溃丢失窗口」压到最小。
// 9MB JSON 落盘约 74ms，250ms 防抖对性能影响可接受。
saveTimer = setTimeout(function () { saveTimer = null; if (dirty) saveNow(); }, 250);
}

/** 立即落盘。
 * 9 MB JSON: write to a temp file then rename so a crash never truncates the save.
 */
export function saveNow() {
  if (!state) return;
  dirty = false;
  let bytes = 0;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    const json = JSON.stringify(state);
    bytes = Buffer.byteLength(json);
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error("[state] save failed:", e.message); }
  // 写操作审计：合并同一批改动，去重后按出现顺序记录
  try {
    const tags = pendingTags.slice();
    pendingTags = [];
    if (tags.length) {
      const uniq = [];
      for (const t of tags) if (uniq.indexOf(t) < 0) uniq.push(t);
      fs.appendFileSync(WRITE_LOG,
        new Date().toISOString() + "  " + bytes + "B  x" + tags.length + "  " + uniq.slice(0, 12).join(" | ") + "\n");
    }
  } catch (e) {}
}

export function getState() { return loadState(); }

// ---------- 资产 ----------
/** 取某道具数量（从 ItemList.AllItemList）。 */
export function getItemAmount(masterItemId) {
  const s = loadState();
  const list = (s.ItemList && s.ItemList.AllItemList) || [];
  const it = list.find(function (x) { return x.master_item_id === masterItemId; });
  return it ? it.amount : 0;
}

/** 增减道具数量；不存在则新建。返回新数量。 */
// ---------- 「本次操作变动的道具」追踪 ----------
//
// 【逆向依据】客户端 GameReceiveApi.UpdatePlayerAllAsset(playerAllAsset) 会把
// player_all_asset 的六个列表**逐条应用到本地 DataStore**：
//   MainCharacter(0x10) / MainCharacterSkill(0x18) / SupportCharacter(0x20)
//   AllItemList(0x28) / amulet_list(0x30) / EquipmentList(0x38)
// （ISIL: GameReceiveApi.txt 的 UpdatePlayerAllAsset，按偏移遍历并 AddOrUpdate）
//
// 所以语义是「**本次操作发生变动的实体增量**」，不是全量，也不是「请求里提到的」。
//
// 【为什么在这里追踪】早期让每个 handler 各自传 playerAllAssetFor([...]) ——
// 结果 13 个端点漏传或传错（传成请求参数、传成空数组、只传金币）。
// 按编码铁律「任何场景都该生效的通用逻辑必须收口」，改为在**变更点自动记录**：
// 所有走 addItem/applyRewards 的改动都会被捕获，handler 无需手动列举。
let touchedItems = new Set();
let stoneChanged = false;
export function stoneTouched() { return stoneChanged; }

/** 开始一次请求的变更追踪（由 server.mjs 在路由调用前调用）。 */
/**
 * ★★★ 2026-10-22：属性/战力变更【收口】—— 不再依赖 handler 记得 touchCharacter ★★★
 *
 * 背景（用户要求）：「一切和属性、战斗力相关的变动，每次发生变更都应该要重算并做反馈」。
 * 之前靠每个 handler 手动 touchCharacter()，漏一处就「数值没变 / 战力不动」
 * （实证：enhanceFavorability 送礼升级好感度、training_board 落盘不同步…都被漏过）。
 *
 * 做法：请求开始时给【每个角色的属性输入】拍快照，响应出口再拍一次并 diff，
 * 任何"输入变了"的角色自动进入重算集合 —— handler 完全不必记得 touch。
 *
 * 快照包含（凡是能影响 StatusList / TotalBattlePower 的输入）：
 *   level / exp / break_limit / favorability_level / class_level / skill_cost_limit
 *   TrainingNode（每角色节点等级）
 *   装备（OwnerCharacterId → 实例 id / 等级 / 突破 / 附魔）
 *   link（支援 → 主角色 + 支援星级，影响 A主+A支 与 ★ 倍率）
 *   SetSkillList（影响乘数 0.03×技能数）
 * 全局输入（master_rank / memory_book / legend_mastery / engage 列表）变化时 → 全部重算。
 */
let _statSig = null, _statGlobal = "";
function _sigHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h;
}
function buildStatSignatures() {
  const s = loadState();
  const sig = new Map();
  const cl = s.CharacterList || {};
  const chs = [].concat(cl.mainCharacterList || [], cl.supportCharacterList || []);
  for (const ch of chs) {
    if (!ch || !ch.master_character_id) continue;
    sig.set(String(ch.master_character_id), [
      ch.level, ch.exp, ch.break_limit, ch.favorability_level, ch.favorability_exp,
      ch.class_level, ch.skill_cost_limit,
    ].join(","));
  }
  for (const n of (s.TrainingNode || [])) {
    const k = String(n.MasterCharacterId);
    if (sig.has(k)) sig.set(k, sig.get(k) + "|T" + n.NodeId + ":" + (Number(n.Level) || 0));
  }
  for (const e of ((s.ItemList || {}).EquipmentList || [])) {
    const k = String(e.OwnerCharacterId || "");
    if (k && sig.has(k)) sig.set(k, sig.get(k) + "|E" + e.Id + ":" + (e.CurrentLevel || 0) + ":" + (e.break_limit || 0) + ":" + (e.currentEnchantId || ""));
  }
  for (const a of ((s.ItemList || {}).amulet_list || [])) {
    const k = String(a.owner_character_id || "");
    if (k && sig.has(k)) sig.set(k, sig.get(k) + "|A" + a.id + ":" + (a.level || 0));
  }
  for (const sp of ((cl.supportCharacterList) || [])) {
    const m = String(sp.LinkedCharacterId || "");
    if (m && sig.has(m)) sig.set(m, sig.get(m) + "|L" + sp.master_character_id + ":" + (sp.break_limit || 0));
  }
  for (const sk of (s.SetSkillList || [])) {
    const k = String(sk.master_character_id || "");
    if (k && sig.has(k)) sig.set(k, sig.get(k) + "|S" + (sk.master_skill_id ? "1" : "0"));
  }
  return sig;
}
function globalStatSignature() {
  const s = loadState();
  return _sigHash(JSON.stringify([
    (s.UserData || {}).master_rank || 0,
    s.master_rank_data || {},
    s.memory_book || {},
    s.legend_mastery_list || {},
    s.engaged_character_id_list || [],
  ]));
}

export function beginTouch() {
  clearAutoSellResults();
  // ★ 属性变更收口：请求开始时拍快照（响应出口 diff）
  try { _statSig = buildStatSignatures(); _statGlobal = globalStatSignature(); } catch (e) { _statSig = null; }
  stoneChanged = false; touchedItems = new Set(); touchedChars = new Set(); touchedEquips = new Set(); touchedAmulets = new Set();
  // ★ 周期重置【统一放在登录（user/load_user_data）】——见 routes-read.mjs。
  //   用户说明（2026-10-22）：每天 0 点客户端会弹「日期更新」并强制重新登录，
  //   所以登录就是天然的 0 点钩子，不需要挂在每个请求上。
}

/** 本次请求【被触碰】的角色 master id 列表（供出口统一重算 StatusList）。 */
export function touchedCharacterIds() { return [...touchedChars]; }

/** 本次请求变更过的道具 id（已排序，便于比对）。 */
export function touchedItemIds() { return [...touchedItems]; }

/** 本次请求变更过的道具的当前持有量（player_all_asset.AllItemList 的正确内容）。 */
export function touchedPlayerAllAsset() { return playerAllAssetFor([...touchedItems]); }

// ---------- 「本次操作变动的实体」追踪（角色/装备/护符）----------
// 与道具同理：客户端会把 player_all_asset 的 MainCharacter/EquipmentList/
// amulet_list 逐条应用。凡创建或修改了这些实体，都应在响应里回传其最新形态。
let touchedChars = new Set();
let touchedEquips = new Set();
let touchedAmulets = new Set();

/** 记录一个角色实例被变更（传 master_character_id）。 */
export function touchCharacter(masterCharacterId) { if (masterCharacterId) touchedChars.add(String(masterCharacterId)); }
/** 记录一件装备实例被变更（传实例 Id）。 */
export function touchEquipment(instanceId) { if (instanceId) touchedEquips.add(String(instanceId)); }
/** 记录一个护符实例被变更（传实例 id）。 */
export function touchAmulet(instanceId) { if (instanceId) touchedAmulets.add(String(instanceId)); }

/** 本次变更的角色（主/支援分开，按客户端结构）。 */
export function touchedPlayerAssets() {
  const s = loadState();
  const mains = (s.CharacterList && s.CharacterList.mainCharacterList) || [];
  const sups = (s.CharacterList && s.CharacterList.supportCharacterList) || [];
  const eqs = (s.ItemList && s.ItemList.EquipmentList) || [];
  const ams = (s.ItemList && s.ItemList.amulet_list) || [];
  const s2 = loadState();
  const skillKeys = [...touchedChars];
  // ★★★ 2026-10-22：主角被 touch 时，必须把它的【link 支援】一起放进 SupportCharacter ★★★
  //   反编译实证（GameReceiveApi.UpdatePlayerAllAsset 的 IL，057~101）：
  //     for (每个 player_all_asset.MainCharacter m) {
  //         ImportDataStore(m);
  //         sp = FirstOrDefault(player_all_asset.SupportCharacter, s => s.LinkedCharacterId == m.master_character_id);
  //         SetUserMainCharacterLinkIndex(m.master_character_id, sp ? sp.master_character_id : "");   // ★ 没找到 = 写空串！
  //     }
  //   ⇒ 只要响应里【带了 MainCharacter 却没带对应的支援】，客户端就会把该主角的 link 索引**清成空**
  //     → 情报页「リンクなし」；而支援模型和战斗力都不受影响（所以弹窗仍显示リンク中、属性也还在）。
  //   这正好解释：class up 支援（MainCharacter 为空）不掉；class up 主角（MainCharacter=该主角）就掉。
  const touchedMains = mains.filter(function (c) { return touchedChars.has(String(c.master_character_id)); });
  const supOut = sups.filter(function (c) { return touchedChars.has(String(c.master_character_id)); });
  for (const m of touchedMains) {
    const linked = sups.find(function (x) { return x && String(x.LinkedCharacterId || "") === String(m.master_character_id); });
    if (linked && supOut.indexOf(linked) < 0) supOut.push(linked);
  }
  return {
    MainCharacter: touchedMains,
    SupportCharacter: supOut
      .map(function (c) {
        // ★ 支援角色的 additional_link_soldier_type_list 必须是【数组】——
        //   客户端对它做 .ToList()，null 会抛 ArgumentNullException 使整次 load_user_data 失败。
        return Object.assign({}, c, { additional_link_soldier_type_list: c.additional_link_soldier_type_list || additionalLinkSoldierTypes(c.master_character_id) });
      }),
    // ★ 契约的 player_all_asset 还含 MainCharacterSkill（技能变更时下发）——
    //   早期漏了这个键，靠契约兜底补上（结构对但值是录制数据）。
    MainCharacterSkill: (s2.SetSkillList || []).filter(function (x) { return skillKeys.indexOf(String(x.master_character_id)) >= 0; }),
    EquipmentList: eqs.filter(function (e) { return touchedEquips.has(String(e.Id)); }),
    amulet_list: ams.filter(function (a) { return touchedAmulets.has(String(a.id)); }),
    AllItemList: playerAllAssetFor([...touchedItems]).AllItemList,
  };
}
/**
 * ★★ 本次请求的【完整资产回执】—— 所有「产生/消耗资产」的写端点都该用它。
 *
 * 语义（由真机契约实证，见 _winr_capture/contracts_winr/*）：
 *   · player_all_asset   = 本次【变动】实体的当前持有量（含所得与消耗两种）
 *   · item_format_list   = 本次【所得】的增量清单（可含重复 id；消耗不进这里）
 *   实证：present/receive 请求 1 件 → held=1 条 / fmt=1 条且 held.amount(17) >= fmt.amount(1)；
 *         oracle receive_reward → fmt 224 条但仅 7 个唯一 id（说明 fmt 可重复，是「逐次所得」流水）。
 *
 * 为什么需要收口：早期各 handler 手写 player_all_asset / item_format_list，
 * 导致 11 处 AllItemList、7 处 item_format_list 恒空（玩家看到「操作成功但数量没变」）。
 * 现在统一由追踪集生成 —— handler 只要正确调用 addItem/applyRewards/addStone，
 * 回执自然正确（变更点自动 touch，见 beginTouch）。
 */
/**
 * ★★ 多态资产回执 —— 真机实测：player_all_asset 的类型【由本次是否产生变更决定】：
 *     无变更 → **空数组 []**（15 次实测中 13 次如此）
 *     有变更 → **对象 {MainCharacter,…}**
 *   这是客户端契约的固有特性（GameApi.UpdatePlayerAllAsset 两种分支都能处理），
 *   不是我们的简化。早期一律发对象 → 审计报 TYPE 不符（契约是数组、实现是对象）。
 *   所有「可能无变更」的写端点都应使用本函数，而不是直接传 touchedPlayerAssets()。
 */
/**
 * ★★ link 战力合计（main + support）★★
 *
 * 客户端把角色对象的 `TotalBattlePower` **原样显示**，不做任何计算：
 *   BattleFormula.GetMainBattlePowerForOutGame(ISIL) = `Move rax,[rcx+52]; Return`
 * 所以「link 状态下 戦闘力 = main + support」只能由服务端算好写进这个字段。
 *
 * 真机证据（同一队伍在 contract 里的两个字段，contracts/abyssal_maze_update.json）：
 *   Ch017800107 + Ch016100207 → totalBattlePower=59163 / mainOnlyTotalBattlePower=21175  (2.79×)
 *   Ch011102101 + Ch020100201 → 33716 / 12455 (2.71×)
 *   Ch013501101 + Ch004503206 → 32965 / 12267 (2.69×)
 *   Ch019700106 + Ch015202205 → 60289 / 23847 (2.53×)
 *   Ch018600108 + Ch015701203 → 60133 / 21805 (2.76×)
 * 而 character_engage.json 里【没挂支援】的条目 total == mainOnly（11695/11695、12647/12647）
 *   ⇒ total 含支援、mainOnly 不含。两者之差就是支援贡献。
 * 我们的 link 端点只改了 LinkedCharacterId，从不动 TotalBattlePower ——
 *   于是用户报障「换上 link 后战力不变、应该是 main+support 之和」。
 *
 * 实现：把「自身战力」记在 __ownBP（顶层 __ 键，finalizeBody 会剔除，不下发客户端），
 *   每次同步 = 自身 + Σ(挂在该 main 上的支援 CharaBattlePower)。
 *   幂等：重复调用、换支援、解除 link 都能正确收敛（不会累加）。
 */
/**
 * ★ 2026-10-22：好感度等级自愈。
 *   旧算法把 FavoriteLevelUp.csv 的 NeedExp 当成累计值，导致等级虚高
 *   （实证：ジャンヌ&ミカエル 存档 Lv21 / exp 17350，而累计口径只到 Lv10，
 *     客户端进度条自己算的就是「距 Lv11 还差 950」= 17350+950=18300=cum(11)）。
 *   这里按累计口径把 level 重算一遍，与客户端显示对齐。
 */
// 收藏/主页展示角色（FavoriteUserCharacter）必须【只含玩家已拥有的角色】。
// 依据（客户端自带 C++，Assembly-CSharp__69.cpp:1011-1020）：
//   MyPageCharaSelectPopupBehaviour.OnSelectCharacterSetUp()
//     → foreach (f in UserProfileUseCase.GetFavoriteCharacterList())
//       → CharacterUseCase.GetCharacterByCharacterId(f.CharacterId, 2)
//       → GetUserCharacterOpenSkillByCharacterId()
//       → UserCharacterHelper.GetUserCharacterFromCharacterId(id)   ← 未持有返回 null
//       → NullCheck → NullReferenceException（整个 マイページ 角色选择弹窗崩掉）
export function healFavoriteCharacters(s) {
  const st = s || loadState();
  const list = Array.isArray(st.FavoriteUserCharacter) ? st.FavoriteUserCharacter : [];
  const cl = st.CharacterList || {};
  const owned = new Set();
  for (const c of (cl.mainCharacterList || [])) owned.add(String((c && (c.master_character_id || c.MasterCharacterId)) || ""));
  for (const c of (cl.supportCharacterList || [])) owned.add(String((c && (c.master_character_id || c.MasterCharacterId)) || ""));
  owned.delete("");
  const kept = list.filter((id) => owned.has(String(id))).slice(0, 5);
  const changed = kept.length !== list.length || kept.some((v, i) => v !== list[i]);
  if (!changed) return 0;
  st.FavoriteUserCharacter = kept;
  return list.length - kept.length;
}

export function healFavorabilityLevels() {
  const s = loadState();
  try {
    const t = loadTable("Fusion/FavoriteLevelUp.csv");
    const rows = ((t && t.rows) || []).map(function (r) {
      return { Lv: Number(r.Lv) || 0, Need: Number(r.NeedExp) || 0 };
    }).filter(function (r) { return r.Lv > 0; }).sort(function (a, b) { return a.Lv - b.Lv; });
    if (!rows.length) return 0;
    let acc = 0;
    const cum = rows.map(function (r) { acc += r.Need; return { Lv: r.Lv, Total: acc }; });
    const levelOf = function (exp) {
      let lv = 1;
      for (const c of cum) { if (exp >= c.Total) lv = c.Lv; else break; }
      return lv;
    };
    let n = 0;
    const all = [].concat((s.CharacterList || {}).mainCharacterList || [], (s.CharacterList || {}).supportCharacterList || []);
    for (const ch of all) {
      if (!ch) continue;
      const want = levelOf(Number(ch.favorability_exp) || 0);
      if (Number(ch.favorability_level) !== want) { ch.favorability_level = want; n++; }
    }
    if (n) { markDirty(); console.log("[favorite] 好感度等级自愈 " + n + " 个角色"); }
    return n;
  } catch (e) { return 0; }
}

/**
 * 属性变更收口（响应出口调用）：diff 快照 → 把变更过的角色加入重算集合。
 * @returns {string[]} 本次自动判定为"属性输入变了"的角色 master id
 */
export function syncStatChanges() {
  if (!_statSig) return [];
  let cur;
  try { cur = buildStatSignatures(); } catch (e) { return []; }
  const g = globalStatSignature();
  const changed = [];
  if (g !== _statGlobal) {
    for (const id of cur.keys()) changed.push(id);
  } else {
    for (const [id, v] of cur) { if (_statSig.get(id) !== v) changed.push(id); }
    for (const id of _statSig.keys()) { if (!cur.has(id)) changed.push(id); }
  }
  _statSig = cur; _statGlobal = g;
  for (const id of changed) { try { touchCharacter(id); } catch (e) {} }
  if (changed.length) console.log("[stat-sync] 属性输入变更 → 自动重算 " + changed.length + " 个角色: " + changed.slice(0, 6).join(",") + (changed.length > 6 ? "…" : ""));
  return changed;
}

export function syncLinkBattlePower() {
  const s = loadState();
  const cl = s.CharacterList || {};
  const mains = cl.mainCharacterList || [];
  const sups = cl.supportCharacterList || [];
  const byMain = {};
  for (const sp of sups) {
    const mid = (sp && sp.LinkedCharacterId) ? String(sp.LinkedCharacterId) : "";
    if (!mid) continue;
    (byMain[mid] = byMain[mid] || []).push(sp);
  }
  let changed = 0;
  for (const m of mains) {
    const key = String(m.master_character_id);
    const next = characterBattlePower(m, byMain[key] || [], s);
    if (Number(m.TotalBattlePower) !== next) { m.TotalBattlePower = next; changed++; touchCharacter(key); }
  }
  // ★ 2026-10-22：支援角色也走同一套公式（A + ★/技能/class/engage/板子乘数）
  for (const sp of sups) {
    if (sp.CharaBattlePower === undefined) continue;
    const next = characterBattlePower(sp, [], s);
    if (Number(sp.CharaBattlePower) !== next) { sp.CharaBattlePower = next; changed++; touchCharacter(String(sp.master_character_id)); }
  }
  if (changed) { markDirty(); console.log("[bp] " + changed + " 个角色（主+支援）的战力已按官方公式重算"); }
  return changed;
}

export function touchedAssetsOrEmpty() {
  const t = touchedPlayerAssets();
  const has = Object.keys(t).some(function (k) {
    const v = t[k];
    return Array.isArray(v) ? v.length > 0 : (v && typeof v === "object" ? Object.keys(v).length > 0 : v != null);
  });
  return has ? t : [];
}

export function assetReceipt() {
  const items = [...touchedItems];
  return {
    player_all_asset: playerAllAssetFor(items),
    // item_format_list 这里给的是「本次变动道具的持有量」的等价增量视图；
    // 真正的「所得流水」由调用方把 applyRewards 的返回值传进来（见 assetReceiptWith）。
    item_format_list: toItemFormatList(items.map(function (id) {
      return { sheet_type: 1, master_id: id };
    }).map(function (x) {
      const s = loadState();
      const it = (s.ItemList.AllItemList || []).find(function (y) { return y.master_item_id === x.master_id; });
      return { sheet_type: x.sheet_type, master_id: x.master_id, amount: it ? it.amount : 0 };
    })),
  };
}

/**
 * 带「所得流水」的完整回执 —— 推荐用法。
 * @param gained applyRewards(...) 的返回值（本次所得，含重复 id）
 */
export function assetReceiptWith(gained) {
  const items = [...touchedItems];
  return {
    player_all_asset: playerAllAssetFor(items),
    item_format_list: toItemFormatList(gained || []),
  };
}


/**
 * 读某道具的【当前持有量】（纯读）。
 *
 * 用途：`user/recover_stamina` 的响应字段 `ItemAmount` 的真机语义是
 *   **使用后的剩余持有量**（真机契约：请求 recover_count=10 → ItemAmount=1447 = 持有量），
 *   不是「使用数量」。我此前返回 count → 客户端把使用数当成持有量 → 界面永远显示同一个数。
 */
export function currentItemCount(s, itemId) {
  s = s || loadState();
  if (!itemId) return 0;
  const it = (((s.ItemList || {}).AllItemList) || []).find(function (x) { return x.master_item_id === itemId; });
  return (it && Number(it.amount)) || 0;
}

/**
 * ★★★ 2026-10-21：票券类道具必须带有效期 ★★★
 *   实证（真机 + 反编译）：GachaPageBehaviour.Setup() 在【池子有 release_condition】时
 *   （即票券池）会对有效期做 Int64.Parse —— 我们的券是 has_expired_at:false / expired_at:0，
 *   客户端拿到空的日期字符串 → FormatException → 整个卡池页白屏。
 *   数据源：Item/TicketList.csv 的 PeriodDay（入手后 N 天）/ End（固定结束时间）。
 *   所有发放路径（商店兑换 / 礼包 / 任务 / 邮件）都经过 addItem，故在此统一补。
 */
let _ticketRows = null;
function ticketExpiryFor(itemId) {
  try {
    if (!_ticketRows) {
      _ticketRows = new Map();
      const t = loadTable("Item/TicketList.csv");
      for (const r of ((t && t.rows) || [])) {
        const id = String(r.ItemId || r["アイテムID"] || "");
        if (id) _ticketRows.set(id, { End: String(r.End || ""), PeriodDay: Number(r.PeriodDay) || 0 });
      }
    }
  } catch (e) { _ticketRows = new Map(); }
  const row = _ticketRows.get(String(itemId));
  if (!row) return 0;
  if (row.End) {
    const t2 = Date.parse(String(row.End).replace(/\//g, "-").replace(" ", "T") + "+09:00");
    if (!isNaN(t2)) return Math.floor(t2 / 1000);
  }
  if (row.PeriodDay > 0) return Math.floor(Date.now() / 1000) + row.PeriodDay * 86400;
  return 0;
}

export function addItem(masterItemId, delta) {
  // ★★ 硬防护：魔宝石【不属于】ItemList.AllItemList（真机契约实证 0 条 Stone 条目）——
  //   它走顶层的 freeStoneBalance / paidStoneBalance。
  //   任何调用点误用 addItem 写石头，都会被这里转发到 addStone，
  //   并打日志暴露调用者（避免「抽卡后水晶被重置」这类问题复发）。
  if (masterItemId === "Item_Stone_Free" || masterItemId === "Item_Stone_Paid") {
    console.warn("[state] addItem 收到石头 id（" + masterItemId + " x" + delta +
                 "）→ 已转发到 addStone。石头不应进 AllItemList（见真机契约）。");
    addStone(masterItemId === "Item_Stone_Free" ? delta : 0,
             masterItemId === "Item_Stone_Paid" ? delta : 0);
    return getState().freeStoneBalance;
  }
  // ★★★ 2026-10-26：随机券（Item_Rand_*）不能当普通道具入包 ★★★
  //   用户报障（第 N 次）：「交換所买随机物品，得到的是 ID 为随机物品的东西，
  //   而不是出货池里的某个随机物品」。根因是各 handler 直接 addItem(goods.ItemId)，
  //   绕过了 applyRewards 里的随机券展开逻辑。这里做【统一兜底】，
  //   任何路径拿到 Item_Rand_* 都会先展开成真实装备/道具。
  if (/^Item_Rand_/i.test(String(masterItemId)) && delta > 0) {
    try {
      const got = applyRewards([{ sheet_type: 1, master_id: masterItemId, amount: delta }]);
      console.log("[state] addItem 收到随机券 " + masterItemId + " x" + delta +
                  " → 已转发到 applyRewards 展开（实得 " + (got || []).length + " 项： " +
                  (got || []).map(function (g) { return g.master_id + "x" + g.amount; }).join(", ") + "）");
      return 0;
    } catch (e) {
      console.warn("[state] 随机券展开失败 " + masterItemId + ": " + e.message);
    }
  }
  const s = loadState();
  if (!s.ItemList) s.ItemList = { EquipmentList: [], amulet_list: [], AllItemList: [] };
  if (!s.ItemList.AllItemList) s.ItemList.AllItemList = [];
  let it = s.ItemList.AllItemList.find(function (x) { return x.master_item_id === masterItemId; });
  if (!it) {
    it = { master_item_id: masterItemId, amount: 0, has_expired_at: false, expired_at: 0, has_locked: false };
    s.ItemList.AllItemList.push(it);
  }
  it.amount = Math.max(0, (it.amount || 0) + delta);
  // ★ int32 上限钳制：客户端金额字段是 int，超过 2147483647 会溢出（金币变 0）→ 统一压到 20 亿
  if (it.amount > 2000000000) it.amount = 2000000000;
  // ★ 票券类：确保带有效期（否则客户端卡池页 long.Parse 空字符串会抛 FormatException）
  if (delta > 0) {
    const exp = ticketExpiryFor(masterItemId);
    if (exp > 0 && (!it.has_expired_at || !it.expired_at)) {
      it.has_expired_at = true;
      it.expired_at = exp;
    }
  }
  touchedItems.add(masterItemId);   // 自动记录本次变更
  markDirty();
  return it.amount;
}

/**
 * ★★★ 原子扣减（2026-10-17，自查发现 22 个 handler 缺此保护）★★★
 *
 * 由来：所有消耗类 handler 都是「直接 addItem(id, -n)」，而 `addItem` 内部是
 *   `Math.max(0, amount + delta)`（防负数钳制）⇒ **材料不足时操作照常成功、材料只扣到 0**
 *   = 白嫖。已实测：`enhance_tenmei` 的 `1@lv50` 被请求 88 次而玩家只有 132 个材料，
 *   等级全部"成功"、材料只扣了 130。
 *
 * ★ 语义：**全部够才扣，否则一个都不扣**（原子性），并返回缺什么。
 *   用法：
 *     const r = consumeItems(s, [[itemId, amount], ...]);
 *     if (!r.ok) { console.log(...r); return okShaped(ctx.path, {}); }
 *
 * @param list 形如 [[id, amount], ...] 或 [{id, amount}, ...]
 * @returns {ok:true} | {ok:false, id, need, have}
 */
export function consumeItems(s, list) {
  const pairs = (list || []).map(function (x) {
    return Array.isArray(x) ? [x[0], x[1]] : [x.id, x.amount];
  }).filter(function (p) { return p[0] && Number(p[1]) > 0; });
  const st = s || loadState();
  for (const p of pairs) {
    const have = currentItemCount(st, p[0]);
    if (have < Number(p[1])) return { ok: false, id: p[0], need: Number(p[1]), have: have };
  }
  for (const p of pairs) addItem(p[0], -Number(p[1]));
  return { ok: true };
}

/** 玩家免费/付费石头。 */
export function addStone(free, paid) {
  const s = loadState();
  // 魔宝石不在 ItemList.AllItemList 里，走 UserData 的 freeStoneBalance / paidStoneBalance。
  // 早期这里登记了 touchedItems -> playerAllAssetFor 查不到就回退用「本次数量」当持有量 ->
  // 客户端拿到 Item_Stone_Free:300 就把持有量刷成 300（把 +300 当成了 =300）。
  if (typeof free === "number" && free) {
    s.freeStoneBalance = Math.max(0, (s.freeStoneBalance || 0) + free);
    stoneChanged = true;
  }
  if (typeof paid === "number" && paid) {
    s.paidStoneBalance = Math.max(0, (s.paidStoneBalance || 0) + paid);
    stoneChanged = true;
  }
  markDirty();
}

/** 体力。 */
export function addStamina(delta) {
  const s = loadState();
  const u = s.UserData;
  if (!u) return;
  // NOTE: stamina may legitimately EXCEED maxStamina (items push it above; only natural
  // recovery stops at the cap). The capture itself shows 910/240, and the in-game UI showed
  // 1804/240, so do NOT clamp here.
  u.stamina = Math.max(0, (u.stamina || 0) + delta);
  markDirty();
}

/** 玩家经验/等级。 */
// ============ 玩家等级经验：全项目唯一的「累计 / 本级」换算（2026-10-18 收口）============
// ★★ 语义修正（用户报障「教程卡在 RANK UP，OK 点不动」）★★
//   权威实证（真机新号契约 battle/win，rank 3→4 那次）：
//     before_user_rank=3 / after_user_rank=4 / add_user_rank_exp=10
//     before_user_rank_exp=10 / after_user_rank_exp=8
//     before_need=12 / after_need=15
//     userData: level=4  exp=40
//   验算：C(4)=10+10+12=32，40-32=8 = after_user_rank_exp ✅
//   真机成熟契约：level=100 时 exp=120312 = C(100) ✅
//   ⇒ UserData.exp 是【累计总经验】；before/after_user_rank_exp 是【本级内进度】= 累计 − C(等级)。
//   ★ 我此前把 UserData.exp 当本级内进度用（升级后清零）⇒ 发给客户端偏小：
//     level=2 时发 exp=0，客户端算 exp − C(2) = −10 → 经验槽负值 → 升级演出算不出 → OK 永久无响应。
const _rankRows = () => { const t = loadTable("Fusion/UserRankLevelUp.csv"); return (t && t.rows) ? t.rows : []; };
/** C(L) = 从 1 级升到 L 级所需的累计经验（表里 Lv=1 的 NeedExp 是 0，从 Lv=2 起累加）。 */
export function rankCumExp(lv) {
  const L = Math.max(1, Number(lv) || 1);
  if (!_rankRows().length) return 0;
  let sum = 0;
  for (const r of _rankRows()) { const n = Number(r.Lv); if (n >= 2 && n <= L) sum += Number(r.NeedExp || 0); }
  return sum;
}
/** 由累计经验反推等级（满级 100 封顶）。 */
export function rankForExp(totalExp) {
  const MAX = 100; let lv = 1;
  while (lv < MAX && Number(totalExp) >= rankCumExp(lv + 1)) lv++;
  return lv;
}
/** 本级内进度 = 累计 − C(等级)（不小于 0）。 */
export function rankExpInLevel(totalExp, lv) {
  return Math.max(0, (Number(totalExp) || 0) - rankCumExp(Number(lv) || 1));
}

/** 修复旧档：把「本级内进度」语义的 exp 补成累计（幂等，无变化时返回 0）。 */
export function healPlayerExp() {
  const s = loadState(); const u = s.UserData; if (!u) return 0;
  const lv = Number(u.level) || 1;
  const base = rankCumExp(lv);
  const exp = Number(u.exp) || 0;
  if (exp < base) { u.exp = base + exp; markDirty(); return 1; }
  return 0;
}

/** 教程是否进行中（Stage < 100）。★ 教程内【不推进玩家 rank】 —— 权威依据见 applyTutorialEndState。 */
function groundRuleNum(key, dflt) {
  try {
    const t = loadTable("GroundRule/GroundRule.csv");
    const r = ((t && t.rows) || []).find(function (x) { return String(x.Key) === String(key); });
    if (!r) return dflt;
    const v = Number(r.ConstantValue);
    return isFinite(v) ? v : dflt;
  } catch (e) { return dflt; }
}
/**
 * 保证「战斗编成」有效 —— 权威依据：真机新号契约（contracts_winr_newaccount）。
 *   真机新号：last_battle_formation = {battle_formation:["Ch000100101","Ch000200102"],
 *             action_priority:[99,99], formation_id:["A01","A02"]}
 *             battle_formation_list[0].type.has_setting = true / quest_type = 1
 * ★★ 为什么必须修（2026-10-18「卡在加载 100%」）★★
 *   剧情关 `_s`（如 Main_003_02_s，MasterQuest.BattleId 为空）**没有选队界面**，
 *   客户端直接拿 `UserData.last_battle_formation` 构建战斗单位 ⇒ 我们给的是空数组 ⇒
 *   单位数 0 ⇒ `BattleScene.Model.ModelRoot..ctor(restoredUnitModelList=NULL, …)` 抛 NRE ⇒
 *   打断 ResourceCache.Update 的加载回调 ⇒ 资源永久留在 loading 缓存 ⇒ 每帧重插同一 key ⇒
 *   `ArgumentException: key 已存在` 无限刷屏 ⇒ 卡在 100%。
 *   （`_m` 战斗关有编成界面，所以之前三场都正常 —— 这个缺陷只在剧情关暴露。）
 */

const MAX_FORMATION_SLOT = 5;
function normalizeFormationInfo(info) {
  if (!info || !Array.isArray(info.battle_formation)) return 0;
  let fixed = 0;
  if (info.battle_formation.length > MAX_FORMATION_SLOT) {
    fixed += info.battle_formation.length - MAX_FORMATION_SLOT;
    info.battle_formation = info.battle_formation.slice(0, MAX_FORMATION_SLOT);
  }
  const n = info.battle_formation.length;
  const ap = Array.from({ length: n }, (_, i) => i + 1);
  const fi = Array.from({ length: n }, (_, i) => "A" + String(i + 1).padStart(2, "0"));
  if (JSON.stringify(info.action_priority) !== JSON.stringify(ap) || JSON.stringify(info.formation_id) !== JSON.stringify(fi)) {
    info.action_priority = ap; info.formation_id = fi; fixed += 1;
  }
  return fixed;
}

/**
 * 清理「跨号残留」的编成预设（换号时 __presets 未清 → 里面可能引用别的号的角色）。
 * 判据：任一非空 master_main/support_character_id 不在本档 CharacterList 内 ⇒ 整组移除。
 * 只删「整组」，不做半套修剪（半套编成在客户端同样非法）。
 */
export function healPresets(s) {
  s = s || loadState();
  const presets = s.__presets;
  if (!presets || typeof presets !== "object") return 0;
  const owned = new Set();
  const cl = s.CharacterList || {};
  for (const c of cl.mainCharacterList || []) if (c && c.master_character_id) owned.add(String(c.master_character_id));
  for (const c of cl.supportCharacterList || []) if (c && c.master_character_id) owned.add(String(c.master_character_id));
  if (!owned.size) return 0;
  let cleared = 0;
  for (const key of Object.keys(presets)) {
    const arr = presets[key];
    if (!Array.isArray(arr) || !arr.length) continue;
    let bad = 0, sample = [];
    for (const p of arr) {
      for (const f of ["master_main_character_id", "master_support_character_id"]) {
        const v = p && p[f];
        if (v && !owned.has(String(v))) { bad++; if (sample.length < 4) sample.push(String(v)); }
      }
    }
    if (bad > 0) {
      console.log("[preset] 清理跨号残留编成 " + key + "（" + bad + " 个角色不在本档: " + sample.join(",") + "）→ 整组移除");
      delete presets[key];
      cleared++;
    }
  }
  return cleared;
}

export function healFormationSlots(s) {
  let n = 0;
  const lbf = s.UserData && s.UserData.last_battle_formation;
  if (lbf) n += normalizeFormationInfo(lbf);
  for (const b of s.battle_formation_list || []) n += normalizeFormationInfo(b.battle_formation_info_list || b);
  for (const k of Object.keys(s.__presets || {})) {
    const arr = s.__presets[k]; if (!Array.isArray(arr)) continue;
    for (const p of arr) n += normalizeFormationInfo(p.battle_formation_info_list || p);
  }
  return n;
}

export function ensureBattleFormation(s) {
  const st = s || loadState();
  // ★★★ 2026-10-26 用户明确：编队【可以为空】—— 玩家可以在界面上主动清空/不设编队，
  //   那是合法状态，不许自动填。只有【教程期间】不能为空：
  //   教程关（_s 剧情关）没有选队界面，直接用 last_battle_formation 构建出战单位，
  //   为空会导致 ModelRoot 构建 0 个单位 → NullReferenceException → 卡在加载 100%。
  //   ⇒ 非教程：本函数只做「结构非法」的修补（formation_id 长度不匹配等），绝不动「空」。
  const inTutorial = tutorialInProgress(st);
  const mains = ((st.CharacterList || {}).mainCharacterList || []).slice(0, 5);
  const ids = mains.map(function (c) { return c.master_character_id; });
  if (!ids.length) return 0;
  const prio = ids.map(function () { return 99; });
  const slots = ids.map(function (_, i) { return "A0" + (i + 1); });
  let fixed = 0;
  const lb = st.UserData && st.UserData.last_battle_formation;
  if (inTutorial && (!lb || !Array.isArray(lb.battle_formation) || lb.battle_formation.length === 0)) {
    st.UserData.last_battle_formation = { battle_formation: ids.slice(), action_priority: prio.slice(), formation_id: slots.slice() };
    fixed++;
  }
  if (inTutorial && (!Array.isArray(st.battle_formation_list) || st.battle_formation_list.length === 0)) {
    st.battle_formation_list = [{ type: { has_setting: true, quest_type: 1, quest_group_id: "", quest_id: "" },
      battle_formation_info_list: { battle_formation: ids.slice(), action_priority: prio.slice(), formation_id: slots.slice() } }];
    fixed++;
  } else {
    for (const bf of st.battle_formation_list) {
      if (!bf.type) bf.type = { has_setting: true, quest_type: 1, quest_group_id: "", quest_id: "" };
      if (!bf.battle_formation_info_list) bf.battle_formation_info_list = {};
      const info = bf.battle_formation_info_list;
      if (inTutorial && (!Array.isArray(info.battle_formation) || !info.battle_formation.length)) {
        info.battle_formation = ids.slice(); info.action_priority = prio.slice(); info.formation_id = slots.slice();
        bf.type.has_setting = true; fixed++;
      } else if (!Array.isArray(info.formation_id) || info.formation_id.length !== info.battle_formation.length) {
        info.formation_id = info.battle_formation.map(function (_, i) { return "A0" + (i + 1); });
        if (!Array.isArray(info.action_priority) || info.action_priority.length !== info.battle_formation.length)
          info.action_priority = info.battle_formation.map(function () { return 99; });
        fixed++;
      }
    }
  }
  if (fixed) { markDirty(); console.log("[state] battle formation 修正 " + fixed + " 处（" + ids.length + " 人编成）"); }
  return fixed;
}

export function tutorialInProgress() {
  const s = loadState();
  const st = s.TutorialProgress || {};
  return Number(st.Stage || 0) < 100;
}

/**
 * 教程结束（走完或跳过）时的统一玩家状态，权威来源 `GroundRule`：
 *   `AfterSkipUserRank    = 3`    ← 教程结束后玩家等级
 *   `AfterSkipUserStamina = 280`  ← 教程结束后体力
 * ★★ 为什么教程内必须【不升级】（2026-10-18 用户报障「RANK UP 弹窗 OK 点不动」）★★
 *   客户端 `ResultRankUpPopupBehaviour` 的 `CloseAnimation`（虚方法槽 17 的覆写）是**空协程**（无 yield），
 *   而 `PopupComponentBehaviour.Close` 的实现是：
 *     EventSystemUtility.Disable();
 *     Observable.FromCoroutine(CloseAnimation, publishEveryValue:false).Subscribe(onNext => PopupController.Close(...));
 *   ⇒ 空协程不产生值 ⇒ onNext 永不执行 ⇒ `PopupController.Close` 永不调用
 *   ⇒ **弹窗不销毁 + 输入系统一直 Disable** ⇒ 之后点什么都没反应（连按下动画都没有）。
 *   探针实测：`PopupController.Close` 调用 **0 次**，弹窗出现后没有任何点击进入 UI。
 *   官方线上不会遇到，是因为**教程阶段不给玩家 rank 经验**（所以教程内永不弹 RANK UP），
 *   教程结束后直接置成 AfterSkipUserRank。
 */
export function applyTutorialEndState() {
  const s = loadState();
  const u = s.UserData;
  if (!u) return;
  const rank = Math.max(1, Number(groundRuleNum("AfterSkipUserRank", 3)) || 3);
  const sta = Math.max(0, Number(groundRuleNum("AfterSkipUserStamina", 280)) || 280);
  const prevLv = Number(u.level) || 1;
  if (prevLv < rank) {
    u.level = rank;
    u.exp = rankCumExp(rank);          // 累计经验口径（见 rankCumExp 注释）
  }
  if ((Number(u.stamina) || 0) < sta) u.stamina = sta;
  markDirty();
  console.log("[tutorial] 结束态：level " + prevLv + " → " + u.level + "（exp=" + u.exp + "）/ stamina " + u.stamina);
}

/**
 * ★★ 2026-10-20：教程阶段的【唯一推进实现】★★
 *
 * 真机实测：带 tutorialProgressType 的请求不止 tutorial/progress ——
 *   quest/start(type=1,5,9) / quest/end(3,7,11) / gacha/roll(16) / tutorial/progress(2,4,6,8,10,12..15)
 * 早期只有 tutorial/progress 推进 Stage，其余全部忽略 ⇒ 阶段永远落后一步。
 * 后果（实测）：教程十连 gacha/roll 携带 type=16，服务端没推进到 16，
 *   客户端认为「抽卡这一步没完成」，弹窗的收尾流程不执行 → EventSystemUtility 一直 Disable
 *   → 「未所持キャラ獲得」弹窗出现后整屏点不动（撤销/OK/X 全无反应）。
 *
 * @param {number} t tutorialProgressType（负数/-1 表示不推进）
 * @returns {{before:number, after:number}} 变化前后
 */
export function advanceTutorialStage(t) {
  const s = loadState();
  if (!s.TutorialProgress) s.TutorialProgress = { Stage: 0, TutorialEndTime: 0 };
  const before = Number(s.TutorialProgress.Stage) || 0;
  const n = Number(t);
  if (!isFinite(n) || n < 0) return { before: before, after: before };
  const after = Math.max(before, Math.min(n, 100));
  if (after !== before) {
    s.TutorialProgress.Stage = after;
    s.TutorialProgress.TutorialEndTime = Math.floor(Date.now() / 1000);
    markDirty();
    console.log("[tutorial] 阶段推进 " + before + " → " + after + "（来源 tutorialProgressType=" + n + "）");
    // ★ type=100 = 教程结束标记（真机实证：character/enhance 那次请求带 100）。
    //   结束时套用 GroundRule 的结束态：AfterSkipUserRank(默认3) / AfterSkipUserStamina(默认280)。
    //   录制实证 82_resp：教程结束后 rank=3、stamina=280 —— 与这两个规则值一致。
    if (after >= 100) {
      try { applyTutorialEndState(); } catch (e) { console.error("[tutorial] endState " + e.message); }
    }
  }
  return { before: before, after: after };
}

/**
 * ★★ 角色等级上限的【唯一实现】★★
 *
 * 依据（2026-10-20）：
 *   · 客户端用 character_exp_info_list[].maxLevel 决定升级上限；真机 rank 2 那场战斗给的是 maxLevel=2。
 *   · 大师等级同样抬升上限：MasterRank/MasterRankBonus.csv 有
 *       Version, MasterRank, UpCharacterLevelLimit, ...
 *       ...,1,1,...  ...,2,1,...  ...,3,1,...      ← 每级 +1
 *     客户端侧对应 MasterRankBonusInfo.UpCharacterLevelLimit / UserRankMaxLevel。
 *
 * 公式：上限 = 玩家 RANK + Σ(MasterRank ≤ 当前大师等级 的 UpCharacterLevelLimit)
 *   当前存档 master_rank=0 ⇒ 上限 = RANK（与真机 rank3/角色≤3 一致）。
 *
 * @returns {number} 角色可达到的最大等级
 */
export function characterLevelCap() {
  const s = loadState();
  const u = s.UserData || {};
  const userRank = Math.max(1, Number(u.level) || 1);
  const mrank = Math.max(0, Number(u.master_rank) || 0);
  let bonus = 0;
  try {
    const t = loadTable("MasterRank/MasterRankBonus.csv");
    const rows = (t && t.rows) || [];
    if (rows.length) {
      for (const r of rows) {
        const mr = Number(r.MasterRank);
        if (isFinite(mr) && mr <= mrank) bonus += Number(r.UpCharacterLevelLimit) || 0;
      }
    } else {
      bonus = mrank;          // 表缺失时按「每级 +1」兜底
    }
  } catch (e) { bonus = mrank; }
  return userRank + bonus;
}

export function addPlayerExp(delta) {
  // ★ 2026-10-20：删掉「教程期间不推进 rank」的规避。
  //   当初加它的理由是「RANK UP 弹窗关不掉 → 输入锁死」，但那个弹窗关不掉的真正原因是
  //   旧插件（探针 + 伪造支付回调）打乱了状态机；插件清理干净后已不再发生。
  //   而正式服【教程第一次战斗就会升级】—— 录制 2026-09-29 #24：
  //     before_user_rank=1 → after_user_rank=2，add_user_rank_exp=10。
  //   ⇒ 规避会让游戏行为偏离正式服（表现为 WIN 界面没有 RANK UP），必须删除。
  const s = loadState();
  const u = s.UserData;
  if (!u) return;
  const MAX_USER_RANK = 100;
  let lv = Number(u.level) || 1;
  let prev = Number(u.exp) || 0;
  // ★ 旧档迁移：旧实现把 exp 当「本级内进度」（升级后清零）⇒ 会出现 exp < C(lv)。
  //   这时把旧值当本级进度，补成累计：exp = C(lv) + 旧值。
  const base = rankCumExp(lv);
  if (prev < base) prev = base + prev;
  let exp = prev + (Number(delta) || 0);          // ★ 累计
  const oldLv = lv;
  while (lv < MAX_USER_RANK && exp >= rankCumExp(lv + 1)) lv++;
  u.level = lv;
  u.exp = exp;
  // ★★ 升级奖励体力：每升 1 级 +20，且【不封顶到 240】★★
  //   真机实证（录制 2026-09-29 #24 quest_result_temp）：
  //     before_user_rank 1 → after_user_rank 2，before_stamina 240 → after_stamina 260
  //   所以体力可以超过 StaminaRecoveryMax(240)：rank2=260、rank3=280（82/86/103_resp 实证）。
  //   绝对上限用 GroundRule.StaminaMax(2000)。
  if (lv > oldLv) {
    const gain = 20 * (lv - oldLv);
    const cap = 2000;
    const cur = Number(u.stamina) || 0;
    u.stamina = Math.min(cap, cur + gain);
    console.log("[rank] " + oldLv + " → " + lv + "：体力 +" + gain + "（" + cur + " → " + u.stamina + "）");
  }
  markDirty();
}

// ---------- 任务 ----------
/** 找任务进度条目。 */
export function findMission(missionId) {
  const s = loadState();
  return (s.MissionProgressList || []).find(function (m) { return m.MissionId === missionId; }) || null;
}

/**
 * 任务的「领取资格」判定 —— 统一入口（收口）。
 *
 * ★★ 为什么必须收口（2026-10-08 实测缺陷）★★
 *   mission/receive_reward 只查了 IsReceived，**没查 IsAchieved** →
 *   实测「未达成的任务也能领奖」：
 *     找一个 IsAchieved=false 的 AchievementMission_Amulet_Star_04 调用 →
 *     真的发了 Item_Stone_Free x50。
 *   客户端只在「已达成且未领取」上显示按钮，但**服务端不能信任客户端状态**。
 *   三个端点（receive_reward / receive_limited_reward / receive_total_reward）都要用同一判据，
 *   散落实现必然漏（我已实测漏了 3 处）。
 *
 * @returns {{ok:boolean, reason?:string}}
 */
/**
 * ★★★ 每日报酬的「已领取次数」计数与上限（2026-10-14 新增）★★★
 *
 * 用户报障：「我每次进入游戏都可以领这个 daily 报酬（skip 带 daily 报酬的地图），
 *   按理说每天只能批量 skip 一次，因为 skip 完了以后 daily 报酬要明天才会刷新出来，
 *   但是现在每次进游戏都能再领一次。」
 *
 * ★ 真根因（两条独立错误叠加）：
 *   ① 我把 `daily_reward_received_count` 理解成【上限】而写成 limit 常量；
 *      而客户端模型（反编译 C++ 实证）是：
 *        struct TemporaryQuestDailyRewardReceived {
 *            String_t* ___quest_group_set_id;
 *            int32_t   ___daily_reward_received_count;   // ← **已领取次数**
 *        };
 *        struct UserQuestDailyRewardReceived { QuestGroupSetId; int32_t Count; };
 *        UserAssetQuestDataStore_GetDailyRewardReceivedCount(id) → dict[id].Count
 *      ⇒ 它是「今天这个组已经领了几次」，不是上限。
 *   ② 我**从不累加**它，也**不校验**上限 → 每次调用都全额发奖，
 *      且回传的 count 恒 = limit ⇒ 客户端永远认为「还能领」。
 *
 * ★ 正确语义（真机契约 winr/quest_skip_daily.json 实证）：
 *   · user_quest_list[].DailySkipCount      = 2   ← 今日已跳过 2 次（达上限）
 *   · daily_reward_received_list[].count    = 2   ← 今日已领 2 次（达上限）
 *   两者**同步递增**：每成功跳过 1 次，就领到 1 次报酬。
 *   上限 = QuestDailyReward.csv 的 DailyRewardLimit + 活动 DAILY_REWARD_LIMIT_ADD
 *     （当前活动 SP/マスタークエスト各 +1 → 1+1 = 2）
 *
 * ★ 跨日重置：与每日任务同一时点（GroundRule.Mission_Nomal_Daily_ResetTime = 0:00 JST），
 *   用 todayKey() 比对，跨日则把全部组的 count 归零。
 */

/** 读取某组的「今日已领次数」（纯读，不存在返回 0）。 */
export function dailyRewardReceivedCount(questGroupSetId) {
  const s = loadState();
  resetDailyRewardIfNeeded(s);
  const e = (s.daily_reward_received_list || []).find(function (x) {
    return String(x.quest_group_set_id) === String(questGroupSetId);
  });
  return e ? (Number(e.daily_reward_received_count) || 0) : 0;
}

/**
 * ★★★ 2026-10-22：碎片领取次数的跨日重置（收口到状态层）★★★
 * 缺陷实证（用户报障「过 12 点 daily 报酬没刷新」顺带发现）：
 *   原来这个重置写在 routes-char.mjs 的 handler 里，只有【点领取】时才会跑；
 *   而且用的是 new Date().toISOString()（UTC）—— JST 00:00~09:00 期间仍是前一天。
 * 现在改成：JST 日期键 + 由 load_user_data 统一触发。
 */
/**
 * ★ 2026-10-22：期间限定任务的结束时间统一改到 2099-01-01。
 *   用户要求：「一切期间限定任务的结束时间改到 2099 年 1 月 1 日」。
 *   数据源 = state.limited_mission_progress_list（每条带 start_at / end_at / reward_limit_at，
 *   客户端的「開催期間」「受取期限」直接显示这两个字段）。
 *   幂等：已经是 2099 的条目不动。
 */
/**
 * ★ 2026-10-22：登录天数跟踪（LoginDay 之前恒为 1，导致「期間中にN日間ログイン」任务永远不动）。
 *   首次运行时用 _requests_full.log 里出现过的 JST 日期做 bootstrap（真实登录证据），
 *   之后每次登录把当天加进去。天数 = __loginDays 的长度。
 */
function pad2(n) { return String(n).padStart(2, "0"); }
function dayKeyOf(d) { return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()); }
export function trackLoginDay() {
  const s = loadState();
  const today = (function () { const j = new Date(Date.now() + 9 * 3600 * 1000); return dayKeyOf(j); })();
  if (!Array.isArray(s.__loginDays)) {
    const days = new Set();
    try {
      const lines = fs.readFileSync("_requests_full.log", "utf8").split("\n");
      for (const l of lines) {
        if (!/^\d{4}-\d{2}-\d{2}T/.test(l)) continue;
        const d = new Date(l.slice(0, 19) + "Z");
        if (isNaN(d.getTime())) continue;
        days.add(dayKeyOf(new Date(d.getTime() + 9 * 3600 * 1000)));
      }
    } catch (e) {}
    days.add(today);
    s.__loginDays = [...days].sort();
    console.log("[login] 首次 bootstrap 登录天数: " + s.__loginDays.join(", "));
  } else if (s.__loginDays.indexOf(today) < 0) {
    s.__loginDays.push(today);
    s.__loginDays.sort();
  }
  s.LoginDay = s.__loginDays.length;
  markDirty();
  return s.LoginDay;
}

/**
 * ★ 2026-10-22：期间限定任务的进度推进。
 *   之前 limited_mission_progress_list 是【录制的静态值】，从来不动 ——
 *   用户报障「期間中に2日間ログイン 一直显示 1/2，我都登录 2 天了」。
 *   支持的内容类型（Mission/LimitedMissionContent.csv）：
 *     37 = 期间内登录 N 天      → progress = 期间内登录天数（cap N）
 *     28 = プレイヤーRANKを N に → progress = 玩家等级（cap N）
 *      5 = 指定关卡クリア        → progress = 1/0
 *   is_achieved = progress >= N。
 */
/**
 * ★ 2026-10-22：サブクエスト 的 ★ 进度奖励（報酬一覧里的 ★7 / ★14 / ★21）。
 *   用户报障「sub quest 进度奖励没有发放」—— 我此前完全没实现。
 *
 * 数据链：
 *   Quest/SubQuest.csv      QuestId → QuestGroupId（如 SUB_NOMAL_001）
 *   Quest/QuestGroup.csv    AchievementRewardIdList = "7:Reward_X\n14:Reward_Y\n21:Reward_Z"
 *   每通关 1 关算 3 ★（关卡评价 3 星；我们的存档没有逐关星级，按"通关≥1 次 = 3★"近似）
 *   已领取记录：state.__subStarGranted = { "SUB_NOMAL_001|7": true }
 */
export function grantSubQuestStarRewards() {
  const s = loadState();
  let sq = null, qg = null;
  try { sq = loadTable("Quest/SubQuest.csv"); qg = loadTable("Quest/QuestGroup.csv"); } catch (e) { return 0; }
  if (!sq || !qg) return 0;
  if (!s.__subStarGranted) s.__subStarGranted = {};
  // ★ 星级来源：AchievementList（battle/win 时按 achievementList 落库的"战斗条件达成"记录）
  //   —— 这才是正确来源（2026-10-17 就实现过），我一度误以为没存、改用"通关次数×3"估算，错了。
  //   每关星数 = 该关不同 AchievementIndex 的个数（0~3）；章节星数 = 各关之和。
  const starsByQuest = {};
  for (const a of (s.AchievementList || [])) {
    const qid = String(a.MasterQuestId || "");
    if (!qid) continue;
    if (!starsByQuest[qid]) starsByQuest[qid] = new Set();
    starsByQuest[qid].add(String(a.AchievementIndex !== undefined ? a.AchievementIndex : a.MasterAchievementId || ""));
  }
  const starsByGroup = {};
  const groupOfQuest = {};
  for (const row of (sq.rows || [])) {
    const qid = String(row.QuestId || "");
    const gid = String(row.QuestGroupId || "");
    if (qid && gid) groupOfQuest[qid] = gid;
  }
  for (const qid of Object.keys(starsByQuest)) {
    const gid = groupOfQuest[qid];
    if (!gid) continue;
    const n = Math.min(3, starsByQuest[qid].size);
    starsByGroup[gid] = (starsByGroup[gid] || 0) + n;
  }
  let granted = 0;
  for (const g of (qg.rows || [])) {
    const gid = String(g.QuestGroupId || "");
    const list = String(g.AchievementRewardIdList || "");
    if (!gid || !list) continue;
    const stars = starsByGroup[gid] || 0;
    if (!stars) continue;
    for (const seg of list.split(/[\r\n]+/)) {
      const m = /^(\d+):(.+)$/.exec(seg.trim());
      if (!m) continue;
      const need = Number(m[1]) || 0;
      const rid = m[2].trim();
      if (!rid || stars < need) continue;
      const key = gid + "|" + need;
      if (s.__subStarGranted[key]) continue;
      try {
        const rw = resolveRewardId(rid) || [];
        if (rw.length) applyRewards(rw);
        s.__subStarGranted[key] = true;
        granted++;
        console.log("[quest] サブクエスト ★ 奖励发放 " + gid + " ★" + need + "（当前 ★" + stars + "）→ " + rid + " x" + rw.length + " 项");
      } catch (e) { console.error("[quest] ★ 奖励发放失败 " + rid + ": " + e.message); }
    }
  }
  if (granted) markDirty();
  return granted;
}

// ==================== 累计体力消耗（MissionContentType=17 StaminaCount）====================
// 用户问：「累计体力消耗你总能算吧」。
// 没有现成的累计计数器，但能从**已通关次数**还原：
//   累计体力 = Σ(每个任务的 TotalClearCount × 该任务的 ConsumeStamina)
// 依据：quest/start 扣体力、quest/skip* 也扣体力，而 skip 同样会累加 TotalClearCount
//   （routes-quest.mjs 的 skip 分支），所以「通关次数 × 单位体力」= 该任务累计消耗。
// 校验：当前存档算出来 ≈ 34,695（Sp_Sweets_01_08 那个 1050 次 skip 就占 21,000）。
const STAMINA_TABLES = [
  "Quest/MainQuest.csv", "Quest/SubQuest.csv", "Quest/SpQuest.csv", "Quest/EventQuest.csv",
  "Quest/CharacterQuest.csv", "Quest/MasterQuest.csv", "Quest/InvasionQuest.csv", "Quest/TowerQuest.csv",
  "Quest/ClassChallengeQuest.csv", "Quest/StarForceQuest.csv", "Quest/AbyssalMazeQuest.csv",
  "Quest/OracleLiberatorQuest.csv", "Quest/GuildQuest.csv", "Quest/NxNBossQuest.csv",
  "Quest/OtherWorldCorridor.csv", "Quest/RecollectionTower.csv", "Quest/QuestCharacterQuest.csv"
];
let _questStaminaIdx = null;
function questStaminaIndex() {
  if (_questStaminaIdx) return _questStaminaIdx;
  _questStaminaIdx = new Map();
  for (const t of STAMINA_TABLES) {
    let tb = null;
    try { tb = loadTable(t); } catch (e) { continue; }
    for (const r of (tb && tb.rows) || []) {
      const id = r.QuestId; if (!id) continue;
      const c = Number(r.ConsumeStamina) || 0;
      if (!_questStaminaIdx.has(String(id))) _questStaminaIdx.set(String(id), c);
    }
  }
  return _questStaminaIdx;
}

export function cumulativeStaminaConsumed(s) {
  s = s || loadState();
  const idx = questStaminaIndex();
  let total = 0;
  for (const q of (s.UserQuestList || [])) {
    const n = Number(q.TotalClearCount) || 0;
    if (n <= 0) continue;
    const c = idx.get(String(q.MasterQuestId));
    if (c) total += n * c;
  }
  return total;
}

/** 深渊：累计通关层数（= 所有 AbyssalMaze_* 任务的 TotalClearCount 之和）。 */
function abyssClearedTotal(s) {
  let n = 0;
  for (const q of (s.UserQuestList || [])) {
    if (!/^AbyssalMaze_/i.test(String(q.MasterQuestId || ""))) continue;
    n += Number(q.TotalClearCount) || 0;
  }
  return n;
}
/** 指定 QuestGroupId 的累计通关次数。 */
function questGroupClearTotal(s, groupId) {
  let idx = null;
  try { idx = loadTable("Quest/AbyssalMazeQuest.csv"); } catch (e) { return 0; }
  const ids = new Set(((idx && idx.rows) || []).filter(function (r) { return String(r.QuestGroupId) === String(groupId); }).map(function (r) { return String(r.QuestId); }));
  let n = 0;
  for (const q of (s.UserQuestList || [])) if (ids.has(String(q.MasterQuestId))) n += Number(q.TotalClearCount) || 0;
  return n;
}
/**
 * 深渊「強化効果の扉」的颜色等级（MissionContentType=57 的 V1）。
 *   5=R(common) / 4=SR(rare) / 3=SSR(epic)  —— 依据任务文案
 *   「深淵の迷宮R強化効果の扉を2回クリアしよう」(V1=5) /「SR…」(V1=4) /「SSR…ボスステージを除く」(V1=3)。
 * 判定链：battle_category_id → BattleCategoryGroup.BuffEffectCategoryMaxNumGroupId
 *         → BuffEffectSlot.BuffEffectCategoryGroupId → BuffEffectCategory.CategorySeriesId
 *         → BuffCategorySeries.Grade(1/2/3)
 */
let _abyssGradeCache = null;
function abyssDoorGrade(battleCategoryId) {
  if (!_abyssGradeCache) {
    _abyssGradeCache = new Map();
    try {
      const bg = loadTable("AbyssalMaze/BattleCategoryGroup.csv");
      const slot = loadTable("AbyssalMaze/BuffEffectSlot.csv");
      const cat = loadTable("AbyssalMaze/BuffEffectCategory.csv");
      const ser = loadTable("AbyssalMaze/BuffCategorySeries.csv");
      const gradeOfSeries = new Map(((ser && ser.rows) || []).map(function (r) { return [String(r.CategorySeriesId), Number(r.Grade) || 0]; }));
      const seriesOfCat = new Map(((cat && cat.rows) || []).map(function (r) { return [String(r.BuffEffectCategoryGroupId), String(r.CategorySeriesId)]; }));
      const catOfSlot = new Map(((slot && slot.rows) || []).map(function (r) { return [String(r.BuffEffectCategoryMaxNumGroupId), String(r.BuffEffectCategoryGroupId)]; }));
      for (const r of ((bg && bg.rows) || [])) {
        const c = catOfSlot.get(String(r.BuffEffectCategoryMaxNumGroupId));
        if (!c) continue;
        const g = gradeOfSeries.get(seriesOfCat.get(c) || "");
        if (g) _abyssGradeCache.set(String(r.BattleCategoryId), { grade: g, type: Number(r.BattleCategory) || 0 });
      }
    } catch (e) {}
  }
  return _abyssGradeCache.get(String(battleCategoryId)) || null;
}
/** 深渊：按「强化效果等级」统计累计通关次数（V1: 5=R/4=SR/3=SSR；SSR 排除 BOSS 层）。 */
function abyssClearsByGrade(s, v1) {
  const wantGrade = 6 - (Number(v1) || 0);   // 5→1(common/R) 4→2(rare/SR) 3→3(epic/SSR)
  const exclBoss = Number(v1) === 3;
  let n = 0;
  for (const e of (s.__abyssClearLog || [])) {
    const info = abyssDoorGrade(e.battle_category_id);
    if (!info || info.grade !== wantGrade) continue;
    if (exclBoss && (info.type === 1 || info.type === 2)) continue;   // 1=BossHard 2=Boss
    n++;
  }
  return n;
}

export function advanceLimitedMissions() {
  const s = loadState();
  let rows = [];
  try { const t = loadTable("Mission/LimitedMissionContent.csv"); rows = (t && t.rows) || []; } catch (e) { return 0; }
  const loginDays = (s.__loginDays || []).slice().sort();
  let n = 0;
  for (const p of (s.limited_mission_progress_list || [])) {
    const row = rows.find(function (r) { return String(r.MissionId) === String(p.mission_id); });
    if (!row) continue;
    const type = Number(row.MissionContentType);
    const target = Number(row.MissionValue1) || 0;
    // need = 「达成所需的次数」。多数类型就是 V1；但 CT=5 的 V1 是【任务 id 字符串】，
    // 次数在 V2 —— 早期直接用 V1 当门槛（Number("Main_006_01_m")=NaN→0）⇒ 永远 ach=false。
    let need = target;
    let prog = null;
    if (type === 37) {
      const start = String(p.start_at || "").slice(0, 10).replace(/\//g, "-");
      const cnt = loginDays.filter(function (d) { return !start || d >= start; }).length;
      prog = Math.min(target || cnt, cnt);
    } else if (type === 28) {
      const rank = Number((s.UserData || {}).level) || 0;
      prog = Math.min(target || rank, rank);
    } else if (type === 5) {
      // Quest_QuestId_ClearCount：V1=任务 id，V2=所需通关次数
      // ★ 2026-10-23：原来固定回 1/0（只看有没有通过），「合計3回クリア」永远不达成。
      const q = (s.UserQuestList || []).find(function (x) { return String(x.MasterQuestId) === String(row.MissionValue1); });
      need = Number(row.MissionValue2) || 1;
      prog = Math.min(Number((q && q.TotalClearCount) || 0), need);
    } else if (type === 3) {
      // Quest_QuestGroupId_ClearCount：V1=任务组 id，V2=所需通关次数
      //   （深渊 BOSS 层「15ステージを合計3回クリア」等）
      need = Number(row.MissionValue2) || 1;
      prog = Math.min(questGroupClearTotal(s, row.MissionValue1), need);
    } else if (type === 56) {
      // 深渊「N ステージをクリアしよう」：累计通关层数
      need = Number(row.MissionValue1) || 1;
      prog = Math.min(abyssClearedTotal(s), need);
    } else if (type === 57) {
      // 深渊「◯◯強化効果の扉を N 回クリアしよう」
      need = Number(row.MissionValue2) || 1;
      prog = Math.min(abyssClearsByGrade(s, row.MissionValue1), need);
    } else if (type === 4) {
      // Quest_QuestType_ClearCount：V1=QuestType（2=サブクエスト…），V2=次数
      const qt = Number(row.MissionValue1) || 0;
      need = Number(row.MissionValue2) || 0;
      let cnt = 0;
      for (const q of (s.UserQuestList || [])) {
        if ((Number(q.TotalClearCount) || 0) <= 0) continue;
        if (questTypeOf(q.MasterQuestId) === qt) cnt += Number(q.TotalClearCount) || 0;
      }
      prog = need > 0 ? Math.min(cnt, need) : cnt;
    } else if (type === 20) {
      // TrainingBoard_EnhanceCount_MainCharacterCount：V1=1(主角)，V2=次数
      // 用 TrainingNode 的 Level 总和近似「强化次数」（每次升级恰好 +1 级）
      need = Number(row.MissionValue2) || 0;
      const mains = new Set(((s.CharacterList || {}).mainCharacterList || []).map(function (c) { return String(c.master_character_id); }));
      let cnt = 0;
      for (const n of (s.TrainingNode || [])) if (mains.has(String(n.MasterCharacterId))) cnt += Number(n.Level) || 0;
      prog = need > 0 ? Math.min(cnt, need) : cnt;
    } else if (type === 17) {
      // StaminaCount：V1 = 需要消耗的体力
      const spent = cumulativeStaminaConsumed(s);
      prog = need > 0 ? Math.min(spent, need) : spent;
    } else if (type === 50) {
      // MissionClear：V1=限定任务组，V2=该组内需要完成的任务数
      const gid = String(row.MissionValue1 || "");
      need = Number(row.MissionValue2) || 0;
      const cnt = (s.limited_mission_progress_list || []).filter(function (x) {
        return String(x.group_id) === gid && x.is_achieved && String(x.mission_id) !== String(p.mission_id);
      }).length;
      prog = need > 0 ? Math.min(cnt, need) : cnt;
    }
    if (prog === null) continue;
    const ach = need > 0 ? prog >= need : false;
    if (Number(p.progress) !== prog || !!p.is_achieved !== ach) {
      p.progress = prog;
      p.is_achieved = ach;
      n++;
    }
  }
  if (n) { markDirty(); console.log("[mission] 期间限定任务进度更新 " + n + " 条"); }
  return n;
}

export const LIMITED_MISSION_END = "2099-01-01 23:59:59";
export function healLimitedMissionPeriods() {
  const s = loadState();
  const list = s.limited_mission_progress_list || [];
  let n = 0;
  for (const m of list) {
    if (!m) continue;
    if (String(m.end_at) !== LIMITED_MISSION_END) { m.end_at = LIMITED_MISSION_END; n++; }
    if (String(m.reward_limit_at) !== LIMITED_MISSION_END) { m.reward_limit_at = LIMITED_MISSION_END; n++; }
  }
  if (n) { markDirty(); console.log("[state] 期间限定任务结束时间 → 2099-01-01（" + n + " 项）"); }
  return n;
}

// ==================== 道中（うでだめしチャレンジ）进度一致性 ====================
// 背景（用户报障 2026-10-22）：「到目前为止我也没见到うでだめし任务」。
//
// 实证：
//   · うでだめし = MainQuest.csv 里 MainQuestType=2（MidWay）的 127 个 Main_*_w，
//     它们通过【父关卡的 EnabledMidwayIdList】挂在地图节点上（124 行有值）。
//   · _requests.log 全量（2026-09-29 起，8.1 万条）里 Main_*_w 的请求只有 3 条，
//     全在 2026-09-30，且都是第 2 部 —— 第 1 部一次都没请求过。
//   · 但存档里 53 条 _w 记录的 TotalClearCount 全是 1，其中 42 条的父关卡根本还没通关。
//   · 官方契约（contracts/user_load_user_data.json）里 59 条 _w 也全是已通关 —— 那是满进度账号。
//   ⇒ 结论：这份存档是从「官方满进度账号」回档到第 54 章时留下的，道中记录没跟着回档。
//     客户端按记录判定「已完成」，界面上就不再把它们当作可挑战关卡 ⇒ 用户一个都看不到。
//
// 处理（一次性迁移 + 常驻不变量）：
//   ① __midwayFix20261022：把现有 _w 记录一律清零（它们在本时间线里从未被打过）。
//   ② healMidwayProgress：以后每次登录做一致性修复 —— 父关卡没通关的 _w 记录清零，
//      避免再次出现「回档后道中仍是已完成」。
let _midwayParentMap = null;
function midwayParentMap() {
  if (_midwayParentMap) return _midwayParentMap;
  _midwayParentMap = new Map();
  try {
    const tb = loadTable("Quest/MainQuest.csv");
    for (const r of (tb && tb.rows) || []) {
      const raw = r.EnabledMidwayIdList || r["開放される道中IDリスト"];
      if (!raw) continue;
      for (const id of String(raw).split(/[,;\s]+/).filter(Boolean)) _midwayParentMap.set(id, String(r.QuestId));
    }
  } catch (e) { console.log("[midway] 父关卡表读取失败: " + e.message); }
  return _midwayParentMap;
}

function zeroQuest(q) {
  q.TotalClearCount = 0; q.DailyClearCount = 0; q.DailySkipCount = 0; q.DailyItemUseCount = 0;
}

/** 道中任务不变量：父关卡没通关 ⇒ 道中记录必须清零。 */

// ==================== link（主↔支）关系自愈 ====================
// 用户报障（第二次）：「我的 link 又丢了」。
// 事实：服务端存档里的 link 是对的（supportCharacterList[i].LinkedCharacterId 指向 main），
//   客户端「情報」页却显示「リンクなし」—— 客户端靠 CharacterAccessor.LinkedCharacterId
//   （来自 UserSupportCharacter.LinkedCharacterId）过滤出「该 main 的支援」，
//   一旦本地支援对象被某个只回局部列表的响应刷成旧值，就会显示没有 link。
// 做法：① 每次 link/unlink 都把「谁连谁」记进 __linkSnapshot（持久化）；
//      ② 登录时按快照自愈 —— 快照里有、当前却空了的补回去（目标 main 仍在且没被占用）；
//         当前指向不存在的主角色的，清空。
export function rememberLink(s, supportId, mainId) {
  s = s || loadState();
  if (!s.__linkSnapshot || typeof s.__linkSnapshot !== "object") s.__linkSnapshot = {};
  const k = String(supportId || "");
  if (!k) return;
  if (mainId) s.__linkSnapshot[k] = String(mainId);
  else delete s.__linkSnapshot[k];
}

export function healCharacterLinks(s) {
  s = s || loadState();
  // 首次运行：用当前 link 建立快照（保护既有关系）
  if (!s.__linkSnapshot || typeof s.__linkSnapshot !== "object") {
    s.__linkSnapshot = {};
    for (const sp of ((s.CharacterList || {}).supportCharacterList || [])) {
      if (sp && sp.LinkedCharacterId) s.__linkSnapshot[String(sp.master_character_id)] = String(sp.LinkedCharacterId);
    }
    console.log("[link] 已建立 link 快照：" + Object.keys(s.__linkSnapshot).length + " 条");
    try { markDirty("[link] snapshot seed"); } catch (e) {}
  }
  const snap = s.__linkSnapshot;
  const cl = s.CharacterList || {};
  const mains = new Set(((cl.mainCharacterList) || []).map(function (c) { return String(c.master_character_id); }));
  const sups = (cl.supportCharacterList) || [];
  let fixed = 0, cleared = 0;
  for (const sp of sups) {
    const mid = sp && sp.LinkedCharacterId ? String(sp.LinkedCharacterId) : "";
    if (mid && !mains.has(mid)) { sp.LinkedCharacterId = null; sp.LinkedCharacterType = 0; cleared++; }
  }
  for (const sp of sups) {
    if (!sp || sp.LinkedCharacterId) continue;
    const want = snap[String(sp.master_character_id)];
    if (!want || !mains.has(want)) continue;
    const taken = sups.some(function (x) { return x !== sp && String(x.LinkedCharacterId || "") === want; });
    if (taken) continue;
    sp.LinkedCharacterId = want; sp.LinkedCharacterType = 1; fixed++;
  }
  if (fixed || cleared) console.log("[link] 自愈：补回 " + fixed + " 条 / 清掉悬空 " + cleared + " 条");
  return fixed;
}


// ==================== サブクエスト「宝箱」记录补齐 ====================
// 数据源：SimulationEvent/SimulationEvent.csv 的 (BattleId → ContentValue)，
//   每个有宝箱的关卡固定一条 <questId>_Box_01。サブクエスト每部正好 5 个
//   （Sub_XX_01..05_<Diff>_b），与界面「宝箱 x/5」一一对应。
// 为什么补：宝箱是战斗里拾取的，批量推进时没带 simulationTreasureEventIdList，
//   结果「部全通」但宝箱还是 1/5。这里按「该关已通关 ⇒ 宝箱视为已拾取」补记录，幂等。
let _subBoxMap = null;
function subQuestBoxMap() {
  if (_subBoxMap) return _subBoxMap;
  _subBoxMap = new Map();
  try {
    const tb = loadTable("SimulationEvent/SimulationEvent.csv");
    for (const r of (tb && tb.rows) || []) {
      const battle = r.BattleId || r["バトルID"];
      const box = r.ContentValue || r["内容値"];
      if (battle && box && /^Sub_/.test(String(battle)) && /_Box_[0-9]+$/.test(String(box))) {
        _subBoxMap.set(String(battle), String(box));
      }
    }
  } catch (e) { console.log("[subbox] 表读取失败: " + e.message); }
  return _subBoxMap;
}

// ==================== 一次性礼物：リトリーのスタンプ ×500,000 ====================
// 用户要求（2026-10-22）：「这个材料给我发50万，用礼物形式发吧，这样我才能直接收取」。
// 材料 = Item_Material_Book_SSR_01（リトリーのスタンプ，記憶の書消耗品）。
// 走 present 系统（__presentList），用户在礼物箱「一括受取」即可。
function grantRitriStampGift(s) {
  if (!Array.isArray(s.__presentList)) s.__presentList = [];
  const id = 900200001;
  if (!s.__presentList.some(function (p) { return String(p.id || p.present_id) === String(id); })) {
    s.__presentList.push({
      id: id, sheetType: 1, masterContentId: "Item_Material_Book_SSR_01", amount: 500000,
      message: "ローカル運営より：リトリーのスタンプ",
      reservedAt: Math.floor(Date.now() / 1000), receiptDeadlineAt: 4070962799,
    });
  }
  s.__giftRitriStamp = true;
  console.log("[present] 已放入礼物：リトリーのスタンプ ×500000（presentId " + id + "）");
}

// ==================== 主角变动时，连带回传它的 link 支援 ====================
// 用户实证（2026-10-22）：
//   · class up 【支援】角色 → 支援界面里「リンク中」的主角色还在（因为响应里 support_character 带着它，
//     LinkedCharacterId 一并被客户端导入）；
//   · class up 【主角】角色 → 主角情报页的 link 栏变空（响应里 support_character 恒 null，
//     客户端没有重新导入那条 link 关系）。
// ⇒ 凡是回 main_character 的养成接口，只要该主角挂着支援，就把它一起回在 support_character 里，
//   让客户端把 link 关系重新导入一次（真机那次 support_character=null 是因为那个账号没连支援）。
export function linkedSupportOfMain(s, mainMasterId) {
  s = s || loadState();
  if (!mainMasterId) return null;
  const sups = ((s.CharacterList || {}).supportCharacterList) || [];
  const sp = sups.find(function (x) { return x && String(x.LinkedCharacterId || "") === String(mainMasterId); });
  if (!sp) return null;
  return Object.assign({}, sp, { additional_link_soldier_type_list: additionalLinkSoldierTypes(sp.master_character_id) });
}

// ==================== 一次性礼物：金币（补到 20 亿）====================
// 用户要求「发 500 亿金币」，但客户端金额字段是 **int32**（TemporaryItemDetail.amount /
// TemporaryItemFormat.amount 都是 int）⇒ 上限 2,147,483,647。500 亿会溢出成负数/乱数。
// 因此发到「余额 = 2,000,000,000」为止（留 1.4 亿余量，避免之后打怪掉金币再溢出）。
function grantGoldGift(s) {
  if (!Array.isArray(s.__presentList)) s.__presentList = [];
  const id = 900200002;
  if (!s.__presentList.some(function (p) { return String(p.id || p.present_id) === String(id); })) {
    const arr = ((s.ItemList || {}).AllItemList) || [];
    const cur = Number((arr.find(function (x) { return x.master_item_id === "Item_Currency_Gold"; }) || {}).amount) || 0;
    const amount = Math.max(0, 2000000000 - cur);
    if (amount > 0) {
      s.__presentList.push({
        id: id, sheetType: 1, masterContentId: "Item_Currency_Gold", amount: amount,
        message: "ローカル運営より：ゴールド補給",
        reservedAt: Math.floor(Date.now() / 1000), receiptDeadlineAt: 4070962799,
      });
      console.log("[present] 已放入金币礼物 ×" + amount + "（补到 20 亿，from " + cur + "）");
    }
  }
  s.__giftGold = true;
}

// ==================== 一次性补发：2026-10-21 23:22 之后「出击掉落」被吃掉的补偿 ====================
// 事故：我在 battle/win 里加的「复刻点数换算」用了别名数组（convertReEventDrops 原样返回同一个数组，
//   随后 normalDrops.length = 0 把结果清空）→ 所有【出击】的 normal_drop 全部丢失（skip 不受影响）。
// 影响窗口：2026-10-21T23:22 ~ 2026-10-22T00:20（修复上线）。期间通关的关卡见下表。
// 处理：按 dropsForQuest（与跳过同一实现）重掷一次并补发。
const LOST_DROP_QUESTS = [
  "Sp_Equipment_01_06",
  "Main_090_01_m", "Main_091_01_m", "Main_092_01_m", "Main_093_01_m", "Main_094_01_m",
  "Main_095_01_m", "Main_096_01_m", "Main_097_01_m", "Main_098_01_m", "Main_099_01_m",
  "Main_100_01_m", "Main_101_01_m", "Main_102_01_m",
  "STARFORCE_Griffon_80",
];
function compensateLostDrops(s) {
  let total = 0, quests = 0;
  for (const qid of LOST_DROP_QUESTS) {
    const row = questRow(qid);
    if (!row) { console.warn("[comp] 找不到任务 " + qid); continue; }
    try {
      const d = dropsForQuest(row, qid, 1, 0);
      const list = (d.normalDrops || []).slice();
      if (!list.length) continue;
      applyRewards(list);
      total += list.length; quests++;
      console.log("[comp] 补发 " + qid + " → " + list.map(function (x) { return x.master_id + " x" + x.amount; }).join(", "));
    } catch (e) { console.warn("[comp] " + qid + " 失败: " + e.message); }
  }
  console.log("[comp] 掉落补偿完成：" + quests + " 关 / " + total + " 条");
  s.__dropCompFix20261022 = true;
}

// ==================== 一次性补给：各种ルーン（2026-10-22）====================
// 用户要求：「レジェンドルーン 发 10000 个，这里的各种ルーン各发 10000 个」。
// 权威 id（Item/ItemList.csv，ItemCategory=1 / ItemMiddleType=15）：
//   Item_rune_legend_01  レジェンドルーン
//   Item_rune_tenmei_01..06  勇気 / 愛 / 正義 / 叡智 / 統治 / 才知 のルーン（天命強化 6 种）
//   Item_rune_master_01  マスタールーン（マスター強化）
function grantRuneGift(s) {
  const LIST = [
    "Item_rune_legend_01",
    "Item_rune_tenmei_01", "Item_rune_tenmei_02", "Item_rune_tenmei_03",
    "Item_rune_tenmei_04", "Item_rune_tenmei_05", "Item_rune_tenmei_06",
    "Item_rune_master_01",
  ];
  const arr = (((s.ItemList || {}).AllItemList) || []);
  for (const id of LIST) {
    const cur = Number(((arr.find(function (x) { return x.master_item_id === id; }) || {}).amount) || 0);
    if (cur < 10000) { addItem(id, 10000 - cur); console.log("[supply] ルーン " + id + " +" + (10000 - cur) + " → 10000"); }
  }
  s.__supplyRunes20261022 = true;
}

// ==================== 第二次金币补给（2026-10-22）====================
// 用户：「我金币不够用了，给我发点」——补到 2,000,000,000（客户端金额是 int32，上限 2,147,483,647）。
function grantGoldGift2(s) {
  // 直接入包（不走礼物箱，省一步领取；金额仍受 int32 上限约束）
  const arr = ((s.ItemList || {}).AllItemList) || [];
  const cur = Number((arr.find(function (x) { return x.master_item_id === "Item_Currency_Gold"; }) || {}).amount) || 0;
  const amount = Math.max(0, 2000000000 - cur);
  if (amount > 0) {
    addItem("Item_Currency_Gold", amount);
    console.log("[supply] 金币 +" + amount + "（" + cur + " → " + (cur + amount) + "）");
  }
  s.__giftGold2 = true;
}

// ==================== 一次性礼物：クラスチャレンジ挑戦券 ×500 ====================
// 用户要求（2026-10-22）：「class challenge quest 的挑战券给我发500张，以礼物形式」。
// 道具 = Item_Ticket_ChallengeQuest（チャレンジチケット，クラスチャレンジクエスト挑戦用）。
function grantChallengeTicketGift(s) {
  if (!Array.isArray(s.__presentList)) s.__presentList = [];
  const id = 900200003;
  if (!s.__presentList.some(function (p) { return String(p.id || p.present_id) === String(id); })) {
    s.__presentList.push({
      id: id, sheetType: 1, masterContentId: "Item_Ticket_ChallengeQuest", amount: 500,
      message: "ローカル運営より：クラスチャレンジチケット",
      reservedAt: Math.floor(Date.now() / 1000), receiptDeadlineAt: 4070962799,
    });
    console.log("[present] 已放入挑战券礼物 ×500");
  }
  s.__giftChallengeTicket = true;
}

// ==================== 一次性补给：复刻活动点数（Item_Re_EventPoint）====================
// 用户要求（2026-10-22）：「复刻点数你再给我发几百万吧，我要测试别的兑换」。
// 复刻商店（Shop_Re_Event_*）的兑换货币就是它；客户端字段是 int32，上限 2,147,483,647。
function grantReEventPointGift(s) {
  const target = 5000000;
  if (!s.ItemList) s.ItemList = { EquipmentList: [], amulet_list: [], AllItemList: [] };
  if (!Array.isArray(s.ItemList.AllItemList)) s.ItemList.AllItemList = [];
  const cur = Number(((s.ItemList.AllItemList.find(function (x) { return x.master_item_id === "Item_Re_EventPoint"; }) || {}).amount) || 0);
  const add = Math.max(0, target - cur);
  if (add > 0) {
    addItem("Item_Re_EventPoint", add);
    console.log("[supply] 复刻点数 +" + add + "（" + cur + " → " + target + "）");
  }
  s.__giftReEventPoint = true;
}

// ==================== 一次性修正：ガチャメダル 的 id 世代错配 ====================
// 用户报障（2026-10-22）：「你之前发的材料 ID 不一样，数量没合并，也不能拿来兑换」
//
// 根因（实证）：
//   · 我此前按【道具名称】匹配发的「ガチャメダル」是 **旧世代** id
//     Item_Gacha_Medal_0007(茶) / 0008(水色) / 0009(橙) / 0010(黄緑) ×10000；
//   · 当前版本真正在用的是 **新世代** id：0520(黒) / 0521(茶) / 0522(水色) / 0523(橙) / 0524(黄緑)；
//   · 证据：Shop/GoodsTable.csv 里 Shop_GachaMedal_007..010（旧）**商品数 = 0**（空壳商店），
//           而 Shop_GachaMedal_520..524（新）分别有 306 / 28 / 26 … 个商品，且 Cost 正好是 0520..0524。
//   ⇒ 旧的 10000 个是死道具（无任何商店消耗），新的 20/80/80 才是能用的。
//
// 处理：把旧世代的数量【迁移】到同色的新世代 id（并删除旧条目），再把五种颜色都补到 10000。
function grantGachaMedalFix(s) {
  const arr = (((s.ItemList || {}).AllItemList) || []);
  const MAP = [
    ["Item_Gacha_Medal_0007", "Item_Gacha_Medal_0521"], // 茶色
    ["Item_Gacha_Medal_0008", "Item_Gacha_Medal_0522"], // 水色
    ["Item_Gacha_Medal_0009", "Item_Gacha_Medal_0523"], // 橙色
    ["Item_Gacha_Medal_0010", "Item_Gacha_Medal_0524"], // 黄緑色
  ];
  for (const [oldId, newId] of MAP) {
    const it = arr.find(function (x) { return x.master_item_id === oldId; });
    if (!it || !(Number(it.amount) > 0)) continue;
    addItem(newId, Number(it.amount));
    console.log("[medal] 迁移旧世代 " + oldId + " x" + it.amount + " → " + newId);
  }
  // 删除旧世代条目（死道具，留着只会让背包出现同名重复堆）
  s.ItemList.AllItemList = arr.filter(function (x) { return !/^Item_Gacha_Medal_00(0[789]|10)$/.test(String(x.master_item_id)); });
  // 五种颜色补到 10000（便于兑换测试）
  for (const id of ["Item_Gacha_Medal_0520", "Item_Gacha_Medal_0521", "Item_Gacha_Medal_0522", "Item_Gacha_Medal_0523", "Item_Gacha_Medal_0524"]) {
    const cur = Number(((s.ItemList.AllItemList.find(function (x) { return x.master_item_id === id; }) || {}).amount) || 0);
    if (cur < 10000) { addItem(id, 10000 - cur); console.log("[medal] 补齐 " + id + " → 10000（+" + (10000 - cur) + "）"); }
  }
  s.__giftGachaMedal = true;
}

// ==================== 一次性兑现：历史遗留的「ランダム」占位道具 ====================
// 2026-10-22 之前，商店「パック」里的 Item_Rand_*（ランダムSSR槍 等）被当普通道具塞进背包，
// 玩家身上留下 4 个「?」占位符（既不能用也不是装备）。这里按 RandomTicketList 兑现成具体装备。
function resolveRandomTicketItems(s) {
  const arr = (((s.ItemList || {}).AllItemList) || []);
  const keep = [];
  let converted = 0;
  let rtTbl = null;
  for (const it of arr) {
    const mid = String(it.master_item_id || "");
    if (!/^Item_Rand_/i.test(mid) || !(Number(it.amount) > 0)) { keep.push(it); continue; }
    if (!rtTbl) { try { rtTbl = loadTable("Item/RandomTicketList.csv"); } catch (e) { rtTbl = null; } }
    const row = ((rtTbl && rtTbl.rows) || []).find(function (r) { return String(r.ItemId) === mid; });
    const rid = row ? String(row.RewardId || "") : "";
    if (!rid) { console.warn("[reward] 随机券无 RewardId: " + mid); continue; }
    const n = Number(it.amount);
    for (let k = 0; k < n; k++) {
      try { applyRewards(resolveRewardId(rid) || []); } catch (e) { console.warn("[reward] 兑现失败 " + mid + ": " + e.message); }
    }
    converted += n;
    console.log("[reward] 历史随机券 " + mid + " x" + n + " → " + rid + " 已兑现");
  }
  if (converted) s.ItemList.AllItemList = keep;
  s.__randTicketFix20261022 = true;
}

// ==================== 一次性换算：原活动点数 → 复刻点数 ====================
// 2026-10-22：复刻活动以前发的是【原活动点数】Item_Eventpoint_XX，而原活动商店
// （Shop_Event_XX）在现版本**全部 0 个商品**，这些点数完全用不了。
// 已有的存量按 1:1 换成 Item_Re_EventPoint（复刻商店的通用货币）。
function convertOldEventPoints(s) {
  const arr = (((s.ItemList || {}).AllItemList) || []);
  let total = 0;
  const keep = [];
  for (const it of arr) {
    if (/^Item_Eventpoint_/i.test(String(it.master_item_id)) && Number(it.amount) > 0) {
      total += Number(it.amount);
      console.log("[reevent] 存量换算 " + it.master_item_id + " x" + it.amount + " → Item_Re_EventPoint");
      continue;
    }
    keep.push(it);
  }
  if (total > 0) {
    s.ItemList.AllItemList = keep;
    addItem("Item_Re_EventPoint", total);
    console.log("[reevent] 原活动点数合计 " + total + " → 复刻点数");
  }
  s.__convertOldEventPoints = true;
}

// ==================== 预设队伍：清掉「自动生成且每队都一样」的假预设 ====================
// 旧实现 buildPreset 把每个槽位都填成 mainCharacterList[0]，get_or_new 一次建 3 套 →
// 三套一模一样（class challenge 部队 1/2/3 全是同一个 Lv7 角色）。
// 新实现改成空槽；这里把历史上自动生成的假预设整条删掉，让客户端按新逻辑重建（空槽）。
function fixAutoPresets(s) {
  if (s.__presetFix20261022) return;
  const presets = s.__presets || {};
  let removed = 0;
  for (const key of Object.keys(presets)) {
    const list = presets[key];
    if (!Array.isArray(list) || list.length < 2) continue;
    const hasAuto = list.some(function (x) { return x && x.__auto; });
    if (hasAuto) continue;                       // 新逻辑创建的，保留
    const ids = new Set(list.map(function (x) { return String((x && x.master_main_character_id) || ""); }));
    if (ids.size !== 1) continue;                // 玩家自己编过的（不同角色）→ 保留
    const only = [...ids][0];
    if (!only) continue;                         // 空槽 → 保留
    delete presets[key]; removed++;
    console.log("[preset] 删除自动生成的假预设 " + key + "（" + list.length + " 队全是 " + only + "）");
  }
  s.__presetFix20261022 = true;
  if (removed) markDirty();
}

// 第二轮清理（2026-10-22）：第一轮删掉后，客户端又把本地缓存 restore 回来了，
// 这里再清一次（此时 preset/restore 已经会拒收「N 队同一个人」的退化数据）。
function fixAutoPresets2(s) {
  if (s.__presetFix2_20261022) return;
  const presets = s.__presets || {};
  let removed = 0;
  for (const key of Object.keys(presets)) {
    const list = presets[key];
    if (!Array.isArray(list) || list.length < 3) continue;
    const ids = new Set(list.map(function (x) { return String((x && x.master_main_character_id) || ""); }));
    if (ids.size !== 1) continue;
    const only = [...ids][0];
    if (!only) continue;
    delete presets[key]; removed++;
    console.log("[preset] 二次清理假预设 " + key + "（" + list.length + " 队全是 " + only + "）");
  }
  s.__presetFix2_20261022 = true;
  if (removed) markDirty();
}

export function healSubQuestTreasureBoxes(s) {
  s = s || loadState();
  const map = subQuestBoxMap();
  if (!map.size) return 0;
  if (!Array.isArray(s.userQuestTreasureBox)) s.userQuestTreasureBox = [];
  const have = new Set(s.userQuestTreasureBox.map(function (x) { return String((x && x.master_secret_treasure_id) || ""); }));
  const cleared = new Set((s.UserQuestList || []).filter(function (q) { return (q.TotalClearCount || 0) > 0; }).map(function (q) { return q.MasterQuestId; }));
  let added = 0;
  for (const [qid, box] of map) {
    if (!cleared.has(qid) || have.has(box)) continue;
    s.userQuestTreasureBox.push({ quest_type: 2, master_quest_id: qid, master_secret_treasure_id: box });
    have.add(box); added++;
  }
  if (added) console.log("[subbox] 补齐 " + added + " 个サブクエスト宝箱记录");
  return added;
}


// ==================== 覇者の塔（TowerQuest）进度记录 ====================
// 用户报障：「霸者之塔，通关以后没有记录，也没给奖励」。
// 实证：19:54 通关 TOWER_D_001（battle/win + quest/end 都到了，首通奖励也发了），
//   但 TowerQuestRecord 一直是 {HighestFloor:0, CurrentClearedFloor:0} → 界面「最高記録 -F / 次のフロア 1F」。
//   根因：quest/end 与 battle/win 都不碰 TowerQuestRecord，只有 skip 端点动它（而且算错）。
// 数据源：Quest/TowerQuest.csv（QuestGroupId = TOWER_A..D，FloorNumber = 1..80）。
let _towerIdx = null;
function towerIndex() {
  if (_towerIdx) return _towerIdx;
  const byQuest = new Map(), byGroupFloor = new Map();
  try {
    const tb = loadTable("Quest/TowerQuest.csv");
    for (const r of (tb && tb.rows) || []) {
      const q = String(r.QuestId || "");
      const g = String(r.QuestGroupId || "");
      const f = Number(r.FloorNumber) || 0;
      if (!q || !g || !f) continue;
      byQuest.set(q, { group: g, floor: f, row: r });
      byGroupFloor.set(g + "#" + f, q);
    }
  } catch (e) { console.log("[tower] 表读取失败: " + e.message); }
  _towerIdx = { byQuest, byGroupFloor };
  return _towerIdx;
}
export function towerInfoOf(questId) { return towerIndex().byQuest.get(String(questId || "")) || null; }
export function towerQuestIdOf(groupId, floor) { return towerIndex().byGroupFloor.get(String(groupId) + "#" + Number(floor)) || ""; }

// 通关一层后更新记录（最高记录 + 当前层 + 更新时间）
export function updateTowerQuestRecord(s, questId) {
  s = s || loadState();
  const info = towerInfoOf(questId);
  if (!info) return null;
  const rec = s.TowerQuestRecord || {};
  const sameGroup = String(rec.CurrentQuestGroupId || "") === info.group;
  const curCleared = sameGroup ? (Number(rec.CurrentClearedFloor) || 0) : 0;
  s.TowerQuestRecord = {
    HighestFloor: Math.max(Number(rec.HighestFloor) || 0, info.floor),
    CurrentQuestGroupId: info.group,
    CurrentClearedFloor: Math.max(curCleared, info.floor),
    CurrentUpdatedAt: Math.floor(Date.now() / 1000),
  };
  return s.TowerQuestRecord;
}

// 下一层要打/要跳的关卡 id（按当前记录推）
export function towerNextTarget(s) {
  s = s || loadState();
  const rec = s.TowerQuestRecord || {};
  let group = String(rec.CurrentQuestGroupId || "");
  if (!group || !towerIndex().byGroupFloor.has(group + "#1")) group = "TOWER_A";
  let floor = (Number(rec.CurrentClearedFloor) || 0) + 1;
  let id = towerQuestIdOf(group, floor);
  while (!id && floor <= 80) { floor++; id = towerQuestIdOf(group, floor); }
  return { group, floor, questId: id };
}

// 登录自愈：按“已通关的塔层”把记录补回来（回档/漏记都能修）
export function healTowerQuestRecord(s) {
  s = s || loadState();
  const cleared = new Set((s.UserQuestList || []).filter(function (q) { return (q.TotalClearCount || 0) > 0; }).map(function (q) { return q.MasterQuestId; }));
  const byGroup = new Map();
  for (const qid of cleared) {
    const info = towerInfoOf(qid);
    if (!info) continue;
    byGroup.set(info.group, Math.max(byGroup.get(info.group) || 0, info.floor));
  }
  if (!byGroup.size) return 0;
  let bestGroup = "", bestFloor = 0, maxFloor = 0;
  for (const [g, f] of byGroup) { maxFloor = Math.max(maxFloor, f); if (f >= bestFloor) { bestFloor = f; bestGroup = g; } }
  const rec = s.TowerQuestRecord || {};
  let curGroup = String(rec.CurrentQuestGroupId || "");
  let curFloor = Number(rec.CurrentClearedFloor) || 0;
  // 记录里的组如果一层都没通过（例：回档后停在 TOWER_A 0F，但玩家其实通了 TOWER_D 1F）→ 切到有进度的组
  if (!curGroup || !(byGroup.get(curGroup))) { curGroup = bestGroup; curFloor = bestFloor; }
  else { curFloor = Math.max(curFloor, byGroup.get(curGroup) || 0); }
  // ★ 2026-10-26：改成【幂等】—— 原来把 CurrentUpdatedAt 也放进比较，用的是 Date.now()，
  //   导致每次调用都判定「有变化」→ 返回 1 → heal.mjs check 永远报「霸者之塔记录 WARN」。
  //   现在只比较三个实质字段；确实变了才写 CurrentUpdatedAt。
  const nextHighest = Math.max(Number(rec.HighestFloor) || 0, maxFloor);
  const changed = Number(rec.HighestFloor) !== nextHighest
    || String(rec.CurrentQuestGroupId || "") !== String(curGroup)
    || Number(rec.CurrentClearedFloor || 0) !== Number(curFloor);
  if (!changed) return 0;
  s.TowerQuestRecord = {
    HighestFloor: nextHighest,
    CurrentQuestGroupId: curGroup,
    CurrentClearedFloor: curFloor,
    CurrentUpdatedAt: Math.floor(Date.now() / 1000),
  };
  console.log("[tower] 记录自愈 -> " + bestGroup + " " + curFloor + "F（最高 " + nextHighest + "F）");
  return 1;
}

// ==================== 記憶の書：页面完成记录（memory_book_page_list）====================
// 用户报障：「记忆之书，一键强化失败」。
// 实证：存档里 memory_book_node_list 有 12 条（Class_1 的 PageType1 已经全 10 级满级），
//   但 memory_book_page_list 是**空数组**；官方契约里页面满级都会有
//   {master_book_id, master_page_type, complete_ranking, complete_at} 的记录（16 条）。
//   ⇒ 客户端拿不到「这一页已完成」，于是把节点显示成 0 级（+0%→+1%），
//     点一括強化时服务端发现全都满级 → released=0 → 界面看起来「失败」。
// 处理：按节点等级反推页面是否满级，补齐 page 记录（幂等）。
let _mbNodeMeta = null;
function memoryBookNodeMeta() {
  if (_mbNodeMeta) return _mbNodeMeta;
  const maxLv = new Map(), pageOf = new Map(), nodesByPage = new Map();
  try {
    const cost = loadTable("MemoryBook/MemoryBookNodeCostMaterialList.csv");
    for (const r of (cost && cost.rows) || []) {
      const id = String(r.NodeId || ""); if (!id) continue;
      maxLv.set(id, Math.max(maxLv.get(id) || 0, Number(r.NodeLv) || 0));
    }
    const nd = loadTable("MemoryBook/MemoryBookNode.csv");
    for (const r of (nd && nd.rows) || []) {
      const id = String(r.NodeId || ""); if (!id) continue;
      const key = String(r.BookId || "") + "|" + (Number(r.PageType) || 0);
      pageOf.set(id, key);
      if (!nodesByPage.has(key)) nodesByPage.set(key, []);
      nodesByPage.get(key).push(id);
    }
  } catch (e) { console.log("[mbook] 表读取失败: " + e.message); }
  _mbNodeMeta = { maxLv, pageOf, nodesByPage };
  return _mbNodeMeta;
}

// ★★★ 2026-10-22 反编译实证（TemporaryMemoryBookListExtend.AddOrUpdate 的 IL）★★★
//   客户端导入 memory_book_node_list 的循环里：
//     level < 1            → 直接 return（**不是 continue**，整个导入就此结束！）
//     master 查不到        → 同样 return
//     level > NodeMaxLevel → 同样 return
//   ⇒ 列表里只要出现【一条 level=0 的记录】，这条之后的节点全部不会被导入，
//     页面记录（memory_book_page_list）也一并跳过。
//   官方契约的 memory_book_node_list 是 123 条、**level 全 ≥1**（只含强化过的节点）——
//   我们此前把 0 级节点也塞进去（PageType2 的 Node3..6 就是 0 级）⇒ 导入在第 3 条就断了：
//   表现就是「大部分节点显示解放可能（0 级）」「一括強化 看起来没反应」
//   （但「解放」单点能刷新，因为单条版 AddOrUpdate 只处理一个节点，不受影响）。
//   ⇒ 出口必须剔除 level<1 的节点，与官方形状一致。
export function sanitizeMemoryBookNodes(s) {
  s = s || loadState();
  const mb = s.memory_book;
  if (!mb || !Array.isArray(mb.memory_book_node_list)) return 0;
  const before = mb.memory_book_node_list.length;
  mb.memory_book_node_list = mb.memory_book_node_list.filter(function (n) {
    return n && Number(n.level) >= 1;
  });
  const removed = before - mb.memory_book_node_list.length;
  if (removed) console.log("[mbook] 剔除 " + removed + " 条 level=0 节点（客户端会因它中断整批导入）");
  return removed;
}

export function healMemoryBookPages(s) {
  s = s || loadState();
  sanitizeMemoryBookNodes(s);
  const meta = memoryBookNodeMeta();
  if (!meta.nodesByPage.size) return 0;
  if (!s.memory_book) s.memory_book = {};
  if (!Array.isArray(s.memory_book.memory_book_page_list)) s.memory_book.memory_book_page_list = [];
  const levels = new Map();
  for (const n of (s.memory_book.memory_book_node_list || [])) levels.set(String(n.master_node_id), Number(n.level) || 0);
  const have = new Set(s.memory_book.memory_book_page_list.map(function (x) { return String(x.master_book_id) + "|" + Number(x.master_page_type); }));
  let added = 0;
  for (const [key, ids] of meta.nodesByPage) {
    if (have.has(key)) continue;
    let all = ids.length > 0;
    for (const id of ids) {
      const mx = meta.maxLv.get(id) || 0;
      if (mx <= 0 || (levels.get(id) || 0) < mx) { all = false; break; }
    }
    if (!all) continue;
    const parts = key.split("|");
    s.memory_book.memory_book_page_list.push({
      master_book_id: parts[0], master_page_type: Number(parts[1]) || 0,
      complete_ranking: 0, complete_at: Math.floor(Date.now() / 1000),
    });
    have.add(key); added++;
  }
  if (added) console.log("[mbook] 补齐页面完成记录 " + added + " 条");
  return added;
}

// ==================== 技能费用（skill_cost_limit）====================
// 用户口径：class up 第一级 +1，之后不再加，最大 6。
// 旧存档里 class_level=2 的角色仍是 5（历史 bug 从没加过）→ 按表重算自愈。
export function healSkillCostLimit(s) {
  s = s || loadState();
  const mains = ((s.CharacterList || {}).mainCharacterList) || [];
  let fixed = 0;
  for (const ch of mains) {
    if (!ch || !ch.master_character_id) continue;
    const lv = Number(ch.class_level) || 0;
    let expect = 5;                              // 基础 5
    for (let i = 1; i <= lv; i++) expect += classSkillCostFor(ch.master_character_id, i);
    if ((Number(ch.skill_cost_limit) || 0) !== expect) {
      ch.skill_cost_limit = expect; fixed++;
    }
  }
  if (fixed) console.log("[class_up] skill_cost_limit 自愈 " + fixed + " 个角色");
  return fixed;
}

export function healMidwayProgress(s) {
  s = s || loadState();
  const parents = midwayParentMap();
  if (!parents.size) return 0;
  const byId = new Map();
  for (const q of s.UserQuestList || []) byId.set(q.MasterQuestId, q);
  let fixed = 0;
  for (const q of s.UserQuestList || []) {
    if (!/_w$/.test(q.MasterQuestId)) continue;
    const parent = parents.get(q.MasterQuestId);
    if (!parent) continue;
    const p = byId.get(parent);
    if (p && (p.TotalClearCount || 0) > 0) continue;
    if ((q.TotalClearCount || 0) !== 0 || (q.DailyClearCount || 0) !== 0) { zeroQuest(q); fixed++; }
  }
  return fixed;
}

/** 一次性迁移：回档遗留的道中「已通关」记录全部清零。 */
function migrateMidwayRollback(s) {
  if (s.__midwayFix20261022) return;
  let n = 0;
  for (const q of s.UserQuestList || []) {
    if (!/_w$/.test(q.MasterQuestId)) continue;
    if ((q.TotalClearCount || 0) > 0) { zeroQuest(q); n++; }
  }
  s.__midwayFix20261022 = true;
  console.log("[midway] 迁移 2026-10-22：把 " + n + " 条道中（うでだめし）记录清零（回档遗留）");
}

export function resetFragmentIfNeeded(s) {
  s = s || loadState();
  const today = todayKey();
  if (s.__fragmentDay === today) return 0;
  s.__fragmentDay = today;
  let n = 0;
  for (const e of (s.TodayReceivedFragmentList || [])) {
    if (Number(e.DailyReceiveCount)) { e.DailyReceiveCount = 0; n++; }
    if (Number(e.DailyItemUseCount)) e.DailyItemUseCount = 0;
  }
  markDirty();
  if (n) console.log("[state] 碎片领取次数已跨日重置（" + today + " JST）: " + n + " 条归零");
  return n;
}

/**
 * ★★★ 2026-10-22：每月重置（每月 1 日 00:00 JST）★★★
 * 覆盖：MonthlyPurchased（月额购买记录）、MonthlyMission_* 任务进度、
 *       以及任何 __monthly 前缀的计数器。
 */
export function resetMonthlyIfNeeded(s) {
  s = s || loadState();
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const mk = jst.getUTCFullYear() + "-" + (jst.getUTCMonth() + 1);
  if (s.__monthKey === mk) return 0;
  s.__monthKey = mk;
  let n = 0;
  if (Array.isArray(s.MonthlyPurchased) && s.MonthlyPurchased.length) { n += s.MonthlyPurchased.length; s.MonthlyPurchased = []; }
  for (const m of (s.MissionProgressList || [])) {
    if (!/^MonthlyMission_/.test(String(m.MissionId || ""))) continue;
    if (m.Progress || m.IsAchieved || m.IsReceived) { m.Progress = 0; m.IsAchieved = false; m.IsReceived = false; n++; }
  }
  for (const k of Object.keys(s || {})) {
    if (/^__monthly/i.test(k)) { s[k] = {}; n++; }
  }
  markDirty();
  console.log("[state] 每月重置（" + mk + " JST）: " + n + " 项归零");
  return n;
}

/** 跨日重置：把全部组的已领次数归零（幂等，靠 __dailyRewardDay 比对）。 */
/**
 * ★ 宝石恢复次数的跨日重置（2026-10-15 补）
 *
 * 字段：`UserData.recoverGemDailyCount`（真机契约实证；客户端对应
 *   `UserProfileModel.staminaRecoverGemDailyCount`）。
 *   UI 上显示「あと10回」= 每日 10 次（StoneRecovery.csv 有 10 行）。
 *
 * 与 dailyReward / weeklySkip 同一模式：靠 __gemRecoverDay 比对，跨日归零。
 * ★ 缺少这一步的后果：用满 10 次后**永久无法再用宝石恢复体力**。
 */
export function resetGemRecoverIfNeeded(s) {
  s = s || loadState();
  const today = todayKey();
  if (s.__gemRecoverDay === today) return 0;
  s.__gemRecoverDay = today;
  const u = s.UserData;
  if (u && Number(u.recoverGemDailyCount)) {
    console.log("[state] 宝石恢复次数已跨日重置: " + u.recoverGemDailyCount + " → 0");
    u.recoverGemDailyCount = 0;
    markDirty();
    return 1;
  }
  return 0;
}
/**
 * ★★★ マスターランク每日特典（2026-10-22 用户提问「master rank 的每日奖励你会发么」）★★★
 *
 * 权威数据：`MasterRank/MasterRankBonus.csv`
 *   MasterRank | UpCharacterLevelLimit(每级+1) | DailyStaminaItem(每级+1)
 *   ⇒ 客户端「マスターランク詳細」里显示的是**累计值**：
 *      MR4 → キャラレベル上限 104（=100+4）、1日1回ヒールバイアル 4個（=4）
 *   「ヒールバイアル」= `Item_Tool_Stamina_R`（Item/ItemList.csv，ItemCategory 4）。
 *
 * 语义：每天第一次登录发一次，数量 = 当前 MasterRank。用 `__masterRankDailyDay` 记日期（JST）。
 */
/**
 * ★★★ 深渊迷宫任务条目（2026-10-22 用户报障：点开深渊迷宫就卡住）★★★
 *
 * 客户端 `AbyssalMazeMainPageViewModel.Build(Cache.QuestCache questCache)` 会对
 *   `questCache.GetQuestList(QuestType.AbyssalMaze=17)` 做 `.Select(...)`；
 * 玩家一条 type=17 都没有时该查询返回 **null**（不是空数组）⇒
 *   `ArgumentNullException: Value cannot be null. Parameter name: source`
 *   ⇒ `AbyssalMazeMainPageBehaviour.<Setup>d__35.MoveNext` 协程中断 ⇒ 界面卡在背景。
 * （Player.log 的栈实证，2026-10-22 两次都是同一处。）
 *
 * 做法：把 `Quest/AbyssalMazeQuest.csv` 的 733 条任务补进 UserQuestList（type=17、未通关）。
 * 真实服务器的 UserQuestList 也包含「已解锁但未通关」的条目，所以这是补数据而不是造假。
 */
export function ensureAbyssQuestEntries(s) {
  s = s || loadState();
  let rows = [];
  try { const t = loadTable("Quest/AbyssalMazeQuest.csv"); rows = (t && t.rows) || []; } catch (e) { return 0; }
  if (!rows.length) return 0;
  if (!Array.isArray(s.UserQuestList)) s.UserQuestList = [];
  const have = new Set(s.UserQuestList.map(function (q) { return q && q.MasterQuestId; }));
  let n = 0;
  for (const r of rows) {
    const id = String(r.QuestId || "");
    if (!id || have.has(id)) continue;
    s.UserQuestList.push({ MasterQuestId: id, MasterQuestType: 17, TotalClearCount: 0, DailyClearCount: 0, DailySkipCount: 0, DailyItemUseCount: 0 });
    have.add(id);
    n++;
  }
  if (n) { markDirty(); console.log("[abyss] UserQuestList 补齐深渊任务 " + n + " 条（type=17，未通关）"); }
  return n;
}

export function grantMasterRankDailyIfNeeded(s) {
  s = s || loadState();
  const today = todayKey();
  if (s.__masterRankDailyDay === today) return 0;
  const rank = Number((s.master_rank_data && s.master_rank_data.master_rank) ||
                      (s.UserData && s.UserData.master_rank) || 0);
  s.__masterRankDailyDay = today;
  if (!(rank > 0)) return 0;
  const id = "Item_Tool_Stamina_R";   // ヒールバイアル
  addItem(id, rank);
  markDirty();
  console.log("[master_rank] 每日特典 ヒールバイアル ×" + rank + "（MR" + rank + " / " + today + "）");
  return rank;
}

export function resetDailyRewardIfNeeded(s) {
  s = s || loadState();
  const today = todayKey();
  if (s.__dailyRewardDay === today) return 0;
  s.__dailyRewardDay = today;
  let n = 0;
  for (const e of (s.daily_reward_received_list || [])) {
    if (Number(e.daily_reward_received_count)) { e.daily_reward_received_count = 0; n++; }
  }
  if (n) console.log("[state] 每日报酬次数已跨日重置: " + n + " 组归零");
  markDirty();
  return n;
}

/**
 * 累加某组的「今日已领次数」，并返回累加后的值（写路径）。
 * ★ 只在【真正发放了报酬】时调用 —— 未发放就不该计数。
 */
export function bumpDailyRewardReceived(questGroupSetId) {
  const s = loadState();
  resetDailyRewardIfNeeded(s);
  if (!Array.isArray(s.daily_reward_received_list)) s.daily_reward_received_list = [];
  let e = s.daily_reward_received_list.find(function (x) {
    return String(x.quest_group_set_id) === String(questGroupSetId);
  });
  if (!e) { e = { quest_group_set_id: questGroupSetId, daily_reward_received_count: 0 }; s.daily_reward_received_list.push(e); }
  e.daily_reward_received_count = (Number(e.daily_reward_received_count) || 0) + 1;
  markDirty();
  return e.daily_reward_received_count;
}

/**
 * ★★★ 角色 StatusList 的【算法版本自愈】（2026-10-14）★★★
 *
 * 为什么需要：
 *   StatusList 是【服务端算好存进存档】的，而 refreshTouchedCharactersIn
 *   只重算「本次请求被 touch 的角色」（廉价短路 `if (!ids.length) return`）。
 *   ⇒ 当我【修正了属性算法】后，历史上已存的 87 个角色仍是旧算法的结果，
 *     不会自动更新 —— 表现为「代码改了但界面数值没变」。
 *
 * 实例（本次）：LegendMasteryPercent 的 BasicStatusType 映射修正后
 *   （8=ATK+DEF → 8=ATK+MATK），存档里 87 个角色仍是
 *   {ATK:16, DEF:16, MATK:15} —— 而正确值是 {ATK:16, DEF:15, MATK:16}。
 *
 * 判据：**只对「与重算结果不一致」的角色写回**，并打日志说明改了哪些字段。
 *   ★ 不盲改：先算出 fresh，与 stored 逐字段比对，一致就不动（既省性能又留证据）。
 *
 * 与「每日重置」不同，这是**一次性**的（算法修正后跑一次即收敛）；
 *   但保留为常驻自愈也无害 —— 收敛后每次都是 0 改动。
 *
 * @param {Function} recompute  (characterId) => freshStatusList（由 character.mjs 提供）
 * @param {Function} isSup      (characterId) => boolean
 * @returns {number} 修正的角色数
 */
export function healStatusListVersion(recomputeFull) {
  const s = loadState();
  const all = [...((s.CharacterList || {}).mainCharacterList || []),
               ...((s.CharacterList || {}).supportCharacterList || [])];
  let fixed = 0; const detail = [];
  for (const c of all) {
    if (!c || !c.master_character_id) continue;
    const stored = c.StatusList;
    if (!stored || typeof stored !== "object") continue;
    // ★ 用 character.mjs 的 recomputeStatusList 做【整份重算】——
    //   它会重建全部子表 + 重算 TotalStatus + 缩放战力。
    //   （我第一版只修 LegendMasteryPercent 一个子表，**漏了 TotalStatus** ——
    //    结果子表对了但 TotalStatus 仍是旧算法的值，
    //    被新增的「业务不变量」层当场抓到：存储 DEF=119/MATK=242 vs 重算 DEF=118/MATK=244。）
    let before, after;
    try {
      before = JSON.stringify(stored);
      recomputeFull(c);            // 原地修改 c.StatusList
      after = JSON.stringify(c.StatusList);
    } catch (e) { continue; }
    if (before !== after) {
      if (detail.length < 3) detail.push(c.master_character_id);
      fixed++;
    }
  }
  if (fixed) {
    markDirty();
    console.log("[state] StatusList 算法自愈: " + fixed + " 个角色整份重算（如 " + detail.join(", ") + "）");
  }
  return fixed;
}

/**
 * 任务状态的【自愈】：IsAchieved / Progress 与任务定义对不上时按 need 校正。
 *
 * 为什么需要（2026-10-14）：
 *   修 `missionNeed` 只影响【今后】的推进，无法撤销**已经被写坏的历史数据**：
 *   `AchievementMission_TotalLogin_09~29`（累计登录 270~2000 天）曾被算成 need=1
 *   → 被写成 `Prog=1, IsAchieved=true, IsReceived=false` → 永久挂在「可领取」
 *   → 客户端每次登录都弹「ミッション達成！」。
 *
 * 校正规则（保守，只修「明确矛盾」的，不猜）：
 *   · `Progress > need`  → 夹到 need（不可能超过目标）
 *   · `IsAchieved` 但 `Progress < need` → 判为脏数据，撤回 IsAchieved
 *     ★ 这是【撤回玩家已得到的状态】，只在数学上不可能时执行 ——
 *       正常推进绝不会出现 Progress < need 却 IsAchieved 的情况。
 *   · 已领取（IsReceived）的任务【不动】—— 那说明玩家真的达成过并拿了奖励，
 *     宁可留着（宁可少修，不可错修）。
 *
 * @returns {number} 修复的条数
 */
export function healMissionProgress() {
  const s = loadState();
  const list = s.MissionProgressList || [];
  const ctx = ensureMissionCtx();
  let n = 0;
  for (const m of list) {
    if (!m || typeof m.MissionId !== "string") continue;
    if (m.IsReceived) continue;               // 已领取：绝不动（宁可少修）
    const c = ctx.get(m.MissionId);
    if (!c) continue;
    const need = missionNeed(m);
    const p = Number(m.Progress) || 0;
    if (p > need) { m.Progress = need; n++; }
    if (m.IsAchieved && p < need) {
      // 数学上不可能：未达目标却标记达成 → 撤回
      m.IsAchieved = false;
      n++;
    }
    // 反向补齐：Progress 够了但没标达成
    if (!m.IsAchieved && (Number(m.Progress) || 0) >= need) { m.IsAchieved = true; n++; }
  }
  if (n) {
    markDirty();
    console.log("[state] 任务进度自愈: " + n + " 条校正");
  }
  return n;
}

// ==================== 期間限定ミッション（limited_mission_progress_list）====================
// 用户报障（2026-10-22）：「任务奖励领取后不发放，同时你也注意一下领取后任务是否标记到完成」。
// 实证：客户端 20:09:21 发的是
//   {"limited_mission_type":2,"mission_group_id":"StartdashMission_01","mission_id_list":["StartdashMission_01_001"]}
//   而旧实现用 canReceiveMissionReward()/findMission() —— 它们只查 MissionProgressList（普通任务），
//   限定任务在【另一个数组】limited_mission_progress_list 里，字段名也不同（mission_id / is_achieved / is_received）
//   ⇒ 恒返回 not_found ⇒ 既不发奖也不标记。
let _limitedRewardMap = null;
function limitedRewardMap() {
  if (_limitedRewardMap) return _limitedRewardMap;
  _limitedRewardMap = new Map();
  try {
    const tb = loadTable("Mission/LimitedMissionContent.csv");
    for (const r of (tb && tb.rows) || []) {
      const id = r.MissionId || r["ミッションID"];
      const rid = r.RewardId || r["報酬ID"];
      if (id && rid) _limitedRewardMap.set(String(id), String(rid));
    }
  } catch (e) { console.log("[limited] 报酬表读取失败: " + e.message); }
  return _limitedRewardMap;
}

export function limitedMissionRewardId(missionId) { return limitedRewardMap().get(String(missionId || "")) || ""; }

/** 在 limited_mission_progress_list 里找一条（可按组/类型限定）。 */
export function findLimitedMission(missionId, groupId, missionType) {
  const s = loadState();
  return (s.limited_mission_progress_list || []).find(function (m) {
    if (!m || String(m.mission_id) !== String(missionId)) return false;
    if (groupId && String(m.group_id) !== String(groupId)) return false;
    if (missionType && Number(m.mission_type) !== Number(missionType)) return false;
    return true;
  }) || null;
}

/** 限定任务的领取资格：已达成 + 未领取（+ 未过领取期限）。 */
export function canReceiveLimitedMission(m, nowMs) {
  if (!m) return { ok: false, reason: "not_found" };
  if (!m.is_achieved) return { ok: false, reason: "not_achieved" };
  if (m.is_received) return { ok: false, reason: "already_received" };
  const lim = m.reward_limit_at || m.end_at || "";
  if (lim) {
    const ts = Date.parse(String(lim).replace(" ", "T") + "+09:00");
    if (isFinite(ts) && ts < (nowMs || Date.now())) return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

export function canReceiveMissionReward(missionId) {
  const m = findMission(missionId);
  if (!m) return { ok: false, reason: "not_found" };
  if (!m.IsAchieved) return { ok: false, reason: "not_achieved" };
  if (m.IsReceived) return { ok: false, reason: "already_received" };
  return { ok: true };
}

/** 标记任务已领取。 */
export function markMissionReceived(missionId) {
  const m = findMission(missionId);
  if (!m) return false;
  m.IsReceived = true;
  markDirty();
  return true;
}

// ---------- 角色 ----------
/**
 * 按 master_character_id 或实例 id 找角色。
 * 返回 { char, isMain } 以便调用方决定放进 main_character 还是 support_character。
 */
export function findCharacter(characterId) {
  const s = loadState();
  const cl = s.CharacterList || {};
  const mains = cl.mainCharacterList || [];
  const sups = cl.supportCharacterList || [];
  let c = mains.find(function (x) { return x.master_character_id === characterId || x.id === characterId; });
  if (c) return c;
  return sups.find(function (x) { return x.master_character_id === characterId || x.id === characterId; }) || null;
}

/** 判断角色是否属于主角色列表。 */
export function isMainCharacter(ch) {
  const s = loadState();
  return (s.CharacterList.mainCharacterList || []).indexOf(ch) >= 0;
}

/**
 * 把状态重置回【录制存档】。
 * 用途：自测会真实修改状态，跑完必须复原，否则交付给玩家的是被测试污染过的存档。
 */
// ---------- 多基准存档（profiles）----------
//
// 【为什么需要】只测「新账号」状态是不完整的审计：
// 若某段读取代码有 bug，而新账号本来就没有该数据，这个 bug 永远不会暴露。
// 因此保留若干「按真实流程积累出来」的存档快照，供审计在不同数据状态下各跑一遍。
//
// 快照来源：seedflow.mjs --keep（走客户端真实端点产生数据，绝不凭空写字段）。
const PROFILE_DIR = path.join(STATE_DIR, "profiles");

/** 当前基准名（null = 录制原始存档）。 */
let activeProfile = null;

/** 保存当前内存状态为命名基准。 */
export function saveProfile(name) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROFILE_DIR, name + ".json"), JSON.stringify(state));
  console.log("[state] profile saved: " + name);
  return name;
}

/** 列出已有基准。 */
export function listProfiles() {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  return fs.readdirSync(PROFILE_DIR).filter(function (f) { return /\.json$/.test(f); })
    .map(function (f) { return f.replace(/\.json$/, ""); });
}

/**
 * 复位状态。
 * @param profile 基准名（省略 = 录制原始存档；"__latest" = 复用当前内存态）
 */
export function resetState(profile) {
  // ★ 醒目横幅：reset 是【破坏性】操作，必须在日志里一眼可见，
  //   不能被当成读操作（用户因此丢过两次存档）。
  console.log("\n" + "=".repeat(72));
  console.log("!! __reset 触发 —— 即将覆盖: " + STATE_FILE);
  console.log("!! profile=" + (profile || "(录制存档)") + "  pid=" + process.pid);
  console.log("=".repeat(72) + "\n");
  // ★★ 事故防护（2026-09-30）★★
  //   resetState 会【立即覆盖 state/user.json】。当天我为了「读一下数据」调用
  //   POST /v1/__reset?profile=accumulated，把用户正在玩的存档整个回退到了 09-27 基准，
  //   用户 08:35~08:38 的全部操作（enhance / break_limit / training_board ×44 节点）丢失。
  //   根因不是「reset 有 bug」（它的语义就是重置），而是【调用者把只读意图用成了写操作】。
  //   两道防护：
  //     ① 覆盖前先把当前 user.json 另存为备份（保留最近 20 份），任何 reset 都可回滚；
  //     ② reset 时打印醒目横幅，让「重置」这件事在日志里一眼可见，不会被当成读操作。
  try {
    if (fs.existsSync(STATE_FILE)) {
      const bdir = path.join(STATE_DIR, "_autobak");
      fs.mkdirSync(bdir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(STATE_FILE, path.join(bdir, "user-" + stamp + ".json"));
      // ★★ 加固（2026-09-30 事故）★★
      //   原上限 20 份，被我连续跑测试（每次 reset 生成一份）刷爆 →
      //   用户真实存档的备份被挤掉，只剩测试档。改为：
      //     ① 上限 300 份；② 删除时【跳过】「角色数 ≥ 当前档」的备份（更完整的档永不删）。
      const all = fs.readdirSync(bdir).filter(function (f) { return /^user-.*\.json$/.test(f); }).sort();
      let curChars = 0;
      try {
        const cur = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        const cl = cur.CharacterList || {};
        curChars = ((cl.mainCharacterList || []).length) + ((cl.supportCharacterList || []).length);
      } catch (e) {}
      const charCountOf = function (fp) {
        try {
          const o = JSON.parse(fs.readFileSync(fp, "utf8"));
          const cl = o.CharacterList || {};
          return ((cl.mainCharacterList || []).length) + ((cl.supportCharacterList || []).length);
        } catch (e) { return -1; }
      };
      while (all.length > 300) {
        const victim = all.shift();
        try {
          const fp = path.join(bdir, victim);
          if (charCountOf(fp) >= curChars) { continue; }   // 更完整 → 跳过不删
          fs.unlinkSync(fp);
        } catch (e) {}
      }
      console.log("[state] !! RESET START — 当前存档已备份到 _autobak/user-" + stamp + ".json");
    }
  } catch (e) { console.error("[state] autobak failed:", e.message); }
  if (profile) {
    const pf = path.join(PROFILE_DIR, profile + ".json");
    if (fs.existsSync(pf)) {
      state = JSON.parse(fs.readFileSync(pf, "utf8"));
      activeProfile = profile;
      saveNow();
      console.log("[state] !! RESET DONE -> profile: " + profile + "（user.json 已被该基准覆盖）");
      return state;
    }
    console.warn("[state] profile not found: " + profile + " -> 回退到录制存档");
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  state = seed.result ? seed.result : seed;
  activeProfile = null;
  saveNow();
  console.log("[state] !! RESET DONE -> captured save（user.json 已被录制存档覆盖）");
  return state;
}

/** 列出自动备份（供恢复用）。 */
export function listAutoBackups() {
  const bdir = path.join(STATE_DIR, "_autobak");
  if (!fs.existsSync(bdir)) return [];
  return fs.readdirSync(bdir).filter(function (f) { return /^user-.*\.json$/.test(f); }).sort();
}

/** 从自动备份恢复（name 省略则取最新一份，即「reset 前的那一份」）。 */
export function restoreAutoBackup(name) {
  const bdir = path.join(STATE_DIR, "_autobak");
  const list = listAutoBackups();
  if (!list.length) return null;
  const pick = name || list[list.length - 1];
  const src = path.join(bdir, pick);
  if (!fs.existsSync(src)) return null;
  fs.copyFileSync(src, STATE_FILE);
  state = JSON.parse(fs.readFileSync(src, "utf8"));
  activeProfile = null;
  console.log("[state] restored from autobak: " + pick);
  return pick;
}

/** 状态快照的哈希（用于自测比对是否有改动）。 */
export function stateSignature() {
  const s = loadState();
  const parts = [];
  parts.push("stamina=" + s.UserData.stamina);
  parts.push("exp=" + s.UserData.exp);
  parts.push("free=" + s.freeStoneBalance);
  const gold = (s.ItemList.AllItemList || []).find(function (x) { return x.master_item_id === "Item_Currency_Gold"; });
  parts.push("gold=" + (gold ? gold.amount : 0));
  parts.push("items=" + (s.ItemList.AllItemList || []).length);
  parts.push("quests=" + (s.UserQuestList || []).length);
  for (const c of (s.CharacterList.mainCharacterList || []).slice(0, 5)) parts.push(c.master_character_id + ":" + c.level + ":" + c.exp + ":" + c.break_limit);
  return parts.join("|");
}

// ---------- 导出视图（写接口回传的 player_all_asset 等）----------
/** 生成 player_all_asset（只含被改动过的项，或按需全量）。 */
export function playerAllAssetFor(itemIds) {
  const s = loadState();
  const list = (s.ItemList && s.ItemList.AllItemList) || [];
  // 同 playerAllAssetFull：itemIds 为空时返回空，不得返回全部道具。
  // （空数组语义是「本次不涉及任何道具」，不是「不过滤」。）
  if (!itemIds || !itemIds.length) return { AllItemList: [] };
  const want = new Set(itemIds);
  const out = [];
  for (const it of list) {
    if (!want.has(it.master_item_id)) continue;
    out.push({ master_item_id: it.master_item_id, amount: it.amount, has_expired_at: !!it.has_expired_at, expired_at: it.expired_at || 0, has_locked: !!it.has_locked });
  }
  return { AllItemList: out };
}

/** 生成 item_format_list（领奖回执）。 */
export function toItemFormatList(items) {
  return (items || []).map(function (i) {
    return { sheet_type: i.sheet_type !== undefined ? i.sheet_type : i.sheetType, master_id: i.master_id || i.itemId, amount: i.amount };
  });
}

/**
 * 把一组奖励应用到状态，并返回 item_format_list。
 *
 * 关键：`Item_Direct_*` 不是背包道具，而是【直接作用于玩家字段】的授予 ——
 * 由 MasterData 的 Item/DirectGrantList.csv 定义，共 5 种：
 *   Item_Direct_Stamina      -> UserData.stamina
 *   Item_Direct_Rank         -> UserData.exp（玩家等级经验）
 *   Item_Direct_Exp_Zenith   -> UserData.exp
 *   Item_Direct_Exp_Origin   -> UserData.exp
 *   Item_Direct_Exp_Nadia    -> UserData.exp
 * 其余（Item_Currency_*、Item_Material_* 等）进 ItemList.AllItemList。
 */
const DIRECT_GRANTS = {
  "Item_Direct_Stamina": "stamina",
  "Item_Direct_Rank": "exp",
  "Item_Direct_Exp_Zenith": "exp",
  "Item_Direct_Exp_Origin": "exp",
  "Item_Direct_Exp_Nadia": "exp",
};

/**
 * 支援角色的 additional_link_soldier_type_list ——「已解锁的链接兵种」列表。
 *
 * 权威数据链：TrainingBoard/AdditionalLinkNode.csv 定义 8 个「リンク-○○」节点：
 *   NodeType 501..508 → NodeId 2_4_11 / 2_4_21 / … / 2_4_81
 *   501=ソルジャー 502=ランサー 503=ライダー 504=セイント
 *   505=ソーサラー 506=シューター 507=エアリアル 508=アサシン
 *   契约实证：支持角色的该字段值是 **[2,3,4,5,6,7,8]** 或 **[8,7,6,4,3,2,1]** ——
 *     即「已解锁的兵种编号集合」（= NodeType − 500），确实落在 [1..8] 内 ✅
 * 语义：玩家在训练板上解锁这些节点后，该支持角色即可与「不同兵种」的主角色链接。
 * 实现：从该角色已解锁的 TrainingNode（NodeId 形如 2_4_X1）反推兵种编号。
 * 无数据时返回**空数组**（契约要求它是数组而非 null —— 这是客户端 .ToList() 的入参，
 *   给 null 会抛 ArgumentNullException 使整次 load_user_data 失败）。
 */
export function additionalLinkSoldierTypes(masterCharacterId) {
  const s = loadState();
  const nodes = s.TrainingNode || [];
  const out = [];
  for (const n of nodes) {
    if (String(n.MasterCharacterId) !== String(masterCharacterId)) continue;
    const m = String(n.NodeId || "").match(/^2_4_(\d)1$/);
    if (!m) continue;
    const t = Number(m[1]);
    if (t >= 1 && t <= 8 && out.indexOf(t) < 0) out.push(t);
  }
  out.sort(function (a, b) { return a - b; });
  return out;
}

/**
 * ★★★ 2026-10-22：刷新所有支援角色的 additional_link_soldier_type_list ★★★
 *
 * 用户报障：「支援角色强化板全解放了，和不同职业的 main link 却显示『未発動』」。
 * 客户端判定（マスタークラス特性発動条件，弹窗原文）：
 *   「自身と同一のクラス、もしくはアディショナルリンクを解放しているサポートとリンクする」
 *   ⇒ 支援的 SoldierType == 主角的 SoldierType，或主角的 SoldierType ∈ 该支援的
 *      additional_link_soldier_type_list（= 训练板上已解锁的「リンク-○○」节点）。
 *   实证：Ch015701203（リヤナ）已解锁 2_4_11/21/41/51/61/71/81 七个节点，
 *         但存档里该字段是 []（我们只在增量下发时算，没写回角色对象）
 *         → 客户端认为「没解放」→ 特性不发动。
 * 这里按 TrainingNode 实时算好写回（幂等，变了才 markDirty）。
 */
export function refreshAdditionalLinkSoldierTypes() {
  const s = loadState();
  const sups = (((s.CharacterList || {}).supportCharacterList) || []);
  let changed = 0;
  for (const c of sups) {
    if (!c || !c.master_character_id) continue;
    const list = additionalLinkSoldierTypes(c.master_character_id);
    const cur = Array.isArray(c.additional_link_soldier_type_list) ? c.additional_link_soldier_type_list : null;
    const same = cur && cur.length === list.length && cur.every(function (x, i) { return Number(x) === list[i]; });
    if (!same) { c.additional_link_soldier_type_list = list; changed++; }
  }
  if (changed) { markDirty(); console.log("[link] additional_link_soldier_type_list 刷新 " + changed + " 个支援"); }
  return changed;
}

/**
 * 2026-10-22 用户报障：「star force quest 通关没扣次数」。
 *
 * 客户端 QuestStageInfoAccessor 有两个「本周剩余」：
 *   LastCanWeeklySkip  = WeeklySkipLimit - WeeklySkipCount
 *   LastCanWeeklyClear = 出击（通关）也要吃同一个每周额度
 * 而我们既没在【出击通关】时累加 __weeklySkip，
 * user/load_user_data 的 WeeklySkipQuestList 也恒为 []（客户端永远显示 70/70）。
 *
 * 本函数按 QuestSkip.csv 的 (QuestType, TargetQuestGroupSetIdList) 生成完整列表，
 * 计数取 state.__weeklySkip（跳过与出击共用；跨周由 resetWeeklySkipIfNeeded 清零）。
 */
export function weeklySkipQuestList() {
  const s = loadState();
  const out = [];
  const seen = new Set();
  try {
    const t = loadTable("Quest/QuestSkip.csv");
    for (const r of ((t && t.rows) || [])) {
      const lim = Number(r.WeeklySkipLimit) || 0;
      if (!lim) continue;
      const qt = Number(r.QuestType) || 0;
      for (const seg of String(r.TargetQuestGroupSetIdList || "").split(/[\r\n]+/)) {
        const set = seg.trim();
        if (!set) continue;
        const key = qt + "|" + set;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ MasterQuestGroupSetId: set, MasterQuestType: qt, WeeklySkipCount: Number((s.__weeklySkip || {})[set]) || 0 });
      }
    }
  } catch (e) {}
  return out;
}

/** 出击通关时累加「本周次数」（B 型：周上限关卡，跳过与出击共用同一额度）。 */
export function bumpWeeklySkip(questGroupSetId, n) {
  const s = loadState();
  const set = String(questGroupSetId || "");
  const add = Math.max(1, Number(n) || 1);
  if (!set) return 0;
  if (!s.__weeklySkip) s.__weeklySkip = {};
  s.__weeklySkip[set] = (Number(s.__weeklySkip[set]) || 0) + add;
  markDirty();
  return s.__weeklySkip[set];
}

/** 造一件装备实例并入库（自动分配实例 id、记录 touch）。 */
/**
 * ★★★ 实例 id 分配器（装备与护符共享 userEquipmentId 空间）★★★
 *
 * 真机证据（契约 3741 护符 + 1247 装备）：
 *   护符 id 段 **1598182810 ~ 1934506047**
 *   装备 id 段 **3884920937 ~ 4529974441**
 *   ⇒ 两段**完全不重叠**（跨列表冲突 = 0）。
 *
 * ★ 我此前的实现：两个 grant 各自「只看自己的列表、取 max+1」
 *   ⇒ 装备与护符**都从 200000000 起** ⇒ 实测 **507 个 id 既是护符又是装备**。
 *   客户端的 `IconListViewItemModel..ctor(_index, _indexInCategory, amuletAccessor,
 *   characterID, isFormationSave, **beforeUserEquipmentId**)` 按这个 id 查实体 ——
 *   撞车时查到的是**装备**对象，类型不符 ⇒ `AmuletAccessor` 为 null ⇒
 *   `PathUtility.GetAmuletFirstSkillIconPath(null)` 解引用 ⇒ NRE
 *   ⇒ 錬成界面アミュレット列表**整体渲染失败**（用户报障：列表空白 + 游戏卡死）。
 *
 * ★ 修法：统一分配器 + 分段（装备 2e8 起 / 护符 3e8 起），
 *   且分配时**同时避开两个列表**（防未来再撞）。
 */
const EQUIP_ID_BASE = 200000000;
const AMULET_ID_BASE = 300000000;
// ★★★ 角色实例 id 独立段（2026-10-16）★★★
// 真机实证：三类实例 id 【完全不重叠】
//   角色 143767356~184142795 / 装备 3884920937~4529974441 / 护符 1598182810~1934506047
// 而我的档曾出现「角色 ∩ 装备 = 169、角色 ∩ 护符 = 11」的双重撞车 ——
//   根因有两个：① `routes-misc.mjs` 抽卡入库硬编码 `300000000 + cl.length`（护符段）；
//   ② 旧 allocInstanceId 只避让装备+护符，【不避让角色】。
// 客户端用一个 int64 id 在【共用查询空间】里查实体，撞车时返回错误类型 → null → NRE。
const CHARACTER_ID_BASE = 100000000;
// ★★★ 另三类「带实例 id 的列表」也需要独立段（2026-10-16）★★★
// 根因：`routes-char.mjs` 用 `600000000 + s.SetSkillList.length` 生成 id ——
//   列表被 filter 缩短后再 push 会**重用已有 id** → 客户端用它建字典 →
//   `ArgumentException: An item with the same key has already been added` → 通信错误。
// ★ 判据：**凡是客户端会按 id 建索引的列表，id 必须在该列表内唯一**，且跨列表不撞车。
const SKILL_ID_BASE     = 400000000;   // SetSkillList
const STORY_ID_BASE     = 500000000;   // UserCharacterStoryList
const ADVENTURE_ID_BASE = 600000000;   // adventure_read_list
/**
 * ★★★ 装备和的「上次基准」存取（差量调整用）★★★
 *
 * 为什么不挂在角色对象上：会**多出一个契约里没有的键** ——
 *   审计实测 `CharacterList.mainCharacterList[0]` 的键集不符：
 *     `...TotalBattlePower, **__equipSum**, battle_join_count...`
 *   ⇒ 客户端的角色对象形状是契约规定的，内部状态不该下发。
 * 为什么需要它：`AdditionalStatus` 里有一部分（天赋技能等）**算不出来**
 *   （其输入 `TalentSkillLevel` 不在 `user_load_user_data` 里），
 *   所以只能按「装备和的变化量」做差量调整，而差量需要一个上次基准。
 */
export function equipSumBase(s, masterCharacterId) {
  const m = s.__equipSums;
  return (m && m[String(masterCharacterId)]) || null;
}
export function setEquipSumBase(s, masterCharacterId, sum) {
  if (!s.__equipSums || typeof s.__equipSums !== "object") s.__equipSums = {};
  s.__equipSums[String(masterCharacterId)] = sum;
}

/**
 * 某角色当前装备的实例 id 列表 —— 按【装备侧的 OwnerCharacterId】反查。
 *
 * ★ 为什么不存 `character.equipment_id_list`：真机契约里没有该字段，
 *   它是客户端自己算的索引（`UserMainCharacterEquipmentIndex.get_EquipmentIdList()`）。
 *   服务端的权威归属字段是 `OwnerCharacterId`（契约实证 57/57 已装备件都有它）。
 * ★ 收口理由：本项目已 **2 次**因「自造列表字段」出问题 ——
 *   `equipment_id_list`（角色对象）与 `amulet_id_list`（角色对象）。
 */
export function equipmentIdsOf(s, masterCharacterId) {
  const id = String(masterCharacterId || "");
  if (!id) return [];
  return (((s.ItemList || {}).EquipmentList) || [])
    .filter(function (e) { return String(e.OwnerCharacterId || "") === id; })
    .map(function (e) { return e.Id; });
}

/**
 * 某角色当前佩带的护符实例 id 列表 —— 按【护符侧的 owner_character_id】反查。
 * ★ 字段名大小写与装备不同：护符是 `owner_character_id` / `owner_character_category`（全小写），
 *   装备是 `OwnerCharacterId` / `OwnerCharacterCategory`（大驼峰）—— 这是契约的事实。
 */
export function amuletIdsOf(s, masterCharacterId) {
  const id = String(masterCharacterId || "");
  if (!id) return [];
  return (((s.ItemList || {}).amulet_list) || [])
    .filter(function (a) { return String(a.owner_character_id || "") === id; })
    .map(function (a) { return a.id; });
}

export function allocInstanceId(s, kind) {
  // ★ 避让【全部三类实体】的 id —— 只避让同类是与角色段撞车的直接原因。
  const used = new Set();
  for (const e of (((s.ItemList || {}).EquipmentList) || [])) used.add(Number(e.Id));
  for (const a of (((s.ItemList || {}).amulet_list) || [])) used.add(Number(a.id));
  const CL = (s.CharacterList || {});
  for (const c of (CL.mainCharacterList || [])) used.add(Number(c.id));
  for (const c of (CL.supportCharacterList || [])) used.add(Number(c.id));
  // ★ 其余三类带 id 的列表也要纳入避让集合
  for (const x of (s.SetSkillList || [])) used.add(Number(x.id));
  for (const x of (s.UserCharacterStoryList || [])) used.add(Number(x.Id));
  for (const x of (s.adventure_read_list || [])) used.add(Number(x.id));
  let id = (kind === "amulet") ? AMULET_ID_BASE
         : (kind === "character") ? CHARACTER_ID_BASE
         : (kind === "skill") ? SKILL_ID_BASE
         : (kind === "story") ? STORY_ID_BASE
         : (kind === "adventure") ? ADVENTURE_ID_BASE
         : EQUIP_ID_BASE;
  while (used.has(id)) id++;
  return id;
}

export function grantEquipment(masterEquipmentId) {
  const s = loadState();
  if (!s.ItemList) s.ItemList = { EquipmentList: [], amulet_list: [], AllItemList: [] };
  if (!s.ItemList.EquipmentList) s.ItemList.EquipmentList = [];
  const inst = createEquipment(allocInstanceId(s, "equipment"), masterEquipmentId);
  s.ItemList.EquipmentList.push(inst);
  touchedEquips.add(String(inst.Id));
  markDirty();
  return inst;
}

/** 造一个护符实例并入库。 */
export function grantAmulet(masterAmuletId) {
  const s = loadState();
  if (!s.ItemList) s.ItemList = { EquipmentList: [], amulet_list: [], AllItemList: [] };
  if (!s.ItemList.amulet_list) s.ItemList.amulet_list = [];
  const inst = createAmulet(allocInstanceId(s, "amulet"), masterAmuletId);
  s.ItemList.amulet_list.push(inst);
  touchedAmulets.add(String(inst.id));
  markDirty();
  return inst;
}

/**
 * ★★★ 自动炼成（オート錬成）—— 2026-10-16 用户报障「自动炼成的材料是否发放」后实现 ★★★
 *
 * 客户端机制（反编译 `Assembly-CSharp__101.cpp:3001-3013` 实证）：
 * ```csharp
 * struct TemporaryAutoSellItemInfo {
 *   string  auto_sell_master_item_id;                    // 被自动炼成的道具
 *   int32_t auto_sell_amount;                            // 数量
 *   TemporaryAutoSellItemInfoDetail[] gained_item_info;  // 炼成产物 [{master_item_id, amount}]
 * }
 * ```
 * 语义：玩家在「自動錬成設定」里勾选一批道具（`auto_sell_item_id_list`），
 *   **之后获得这些道具时不再进背包，而是当场炼成**（换成专属货币），
 *   结果通过响应的 `auto_sell_item_list` 回执给客户端弹窗展示。
 *
 * ★ 我此前完全没实现这一步 ⇒ 那些道具照常进背包、**炼成产物也没发** ——
 *   正是用户说的「自动炼成的材料是否发放」。
 */
let _autoSellCache = null, _autoSellCacheKey = "";
function _autoSellCheck(itemId) {
  const s = loadState();
  const key = String((s.auto_sell_item_id_list || []).length);
  if (!_autoSellCache || _autoSellCacheKey !== key) {
    _autoSellCache = autoSellSet();
    _autoSellCacheKey = key;
  }
  return _autoSellCache.has(String(itemId || ""));
}

export function autoSellSet() {
  const s = loadState();
  return new Set((s.auto_sell_item_id_list || []).map(String));
}

/** 判道具属于哪张出售表（决定用哪个 SellPrice）。 */
export function autoSellKindOf(itemId) {
  const id = String(itemId || "");
  if (/^Item_Equipment_/.test(id) || /^Item_Equip_/.test(id)) return "equipment";
  if (/^Item_Amulet_/.test(id)) return "amulet";
  return "item";
}

/** 本轮请求内发生的自动炼成记录（形状 = TemporaryAutoSellItemInfo）。 */
let autoSellOut = [];
export function autoSellResults() { return autoSellOut; }
export function clearAutoSellResults() { autoSellOut = []; }
function recordAutoSell(masterItemId, amount, gained) {
  if (!masterItemId || !amount) return;
  autoSellOut.push({
    auto_sell_master_item_id: masterItemId,
    auto_sell_amount: amount,
    gained_item_info: (gained || []).map(function (g) {
      return { master_item_id: g.master_id, amount: g.amount };
    }),
  });
}
export function applyRewards(items) {
  const applied = [];
  // ★ 2026-10-21：发奖审计日志 —— 每次发放都落一行到 _rewards.log，
  //   便于「用户看不到数值变化时」核对奖励到底有没有发（宝石显示有上限，肉眼看不出来）。
  try {
    const list = (items || []).map(function (x) {
      return (x.master_id || x.itemId) + " x" + (x.amount || 0);
    }).filter(function (s) { return s && !/x0$/.test(s); });
    if (list.length) {
      const fs2 = fs;
      fs2.appendFileSync("_rewards.log",
        new Date().toISOString() + "  " + list.join(", ") + "\n");
    }
  } catch (e) {}
  for (const it of items || []) {
    const id = it.master_id || it.itemId;
    const amount = it.amount || 0;
    if (!id || !amount) continue;
    const sheet = it.sheet_type !== undefined ? it.sheet_type : (it.sheetType || 1);
    // ★ sheet_type 语义（契约实证）：
    //   1 = 普通道具（进 AllItemList）　2 = 角色
    //   3 = **装备**（造实例进 EquipmentList）　4 = **护符**（造实例进 amulet_list）
    //   早期一律走 addItem → 装备/护符被当成普通道具塞进 AllItemList，
    //   客户端在 EquipmentList/amulet_list 里找不到 → 表现为「给了装备但背包里没有」。
    //   证据：quest/skip_daily 的响应 player_all_asset 同时有 EquipmentList[1] 与 amulet_list[112]。
    // ★★★ 2026-10-22 用户报障：「交換結果只显示 Random SSR，看不到具体获得的东西」★★★
    //   Item_Rand_*（ランダムSSR槍 / ランダムSSR軽鎧 …）不是真实道具，是「随机券」占位符：
    //   权威链 Item/RandomTicketList.csv（ItemId → RewardId）
    //     → Reward/RewardList.csv → RandomRewardTable → DropBox_Equipment_SSR_xxx
    //     → Reward/RewardBoxTable.csv → 具体装备 Id
    //   旧实现把它当普通道具 addItem → 背包里多一个「?」占位符，玩家等于什么都没拿到。
    if (/^Item_Rand_/i.test(String(id))) {
      let _rid = "";
      try {
        const _rt = loadTable("Item/RandomTicketList.csv");
        const _row = ((_rt && _rt.rows) || []).find(function (r) { return String(r.ItemId) === String(id); });
        if (_row) _rid = String(_row.RewardId || "");
      } catch (e) {}
      if (_rid) {
        const _times = Math.max(1, Number(amount) || 1);
        for (let _n = 0; _n < _times; _n++) {
          let _got = [];
          try { _got = resolveRewardId(_rid) || []; } catch (e) { _got = []; }
          for (const _g of _got) {
            const _sub = applyRewards([{ sheet_type: _g.sheet_type, master_id: _g.master_id, amount: _g.amount }]);
            for (const _a of _sub) applied.push(_a);
          }
        }
        console.log("[reward] 随机券 " + id + " x" + _times + " → " + _rid + " 掷骰完成");
        continue;
      }
    }
    // ★★ 自动炼成优先于入包（2026-10-16）★★
    //   勾选过的道具获得时直接炼成，不进背包；产物（专属货币）当场发放。
    if (_autoSellCheck(id)) {
      const kind = autoSellKindOf(id);
      const rw = sellRewardsFor(kind, id, amount);
      if (rw.length) {
        for (const g of rw) addItem(g.master_id, g.amount);
        recordAutoSell(id, amount, rw);
        applied.push({ sheet_type: 1, master_id: id, amount: amount });
        continue;
      }
    }
    // ★★★ 2026-10-21：sheet_type = 2 是【角色】（不是道具）★★★
    //   缺陷实证（用户报障）：复刻商店兑换角色 Ch014403105 后，服务端把它当道具
    //   addItem("Ch014403105") 塞进 AllItemList → 客户端找不到这个"道具"的 master 数据
    //   → NullReferenceException / FormatException → 卡池白屏、界面卡死。
    //   正确处理：造角色实例进 CharacterList（主/支援按 SupportType 分派）。
    if (sheet === 2 || /^Ch\d{9}$/.test(String(id))) {
      const s = getState();   // ★ applyRewards 里没有外层 s，必须就地取
      // ★★★ 2026-10-22 用户规则：「重复角色应该给碎片，就跟抽卡那边一样」★★★
      //   抽卡路径（routes-misc 的 performGachaRoll）早就有这个判断，但 applyRewards
      //   （商店兑换 / 任务奖励 / 邮件 等所有发奖路径）没有 —— 于是同一角色被反复塞进
      //   CharacterList，产生重复实例。这里统一：已持有 ⇒ 折算碎片（FragmentCount 张/个）。
      const _isOwned = function (mid) {
        return ((s.CharacterList && s.CharacterList.mainCharacterList) || []).some(function (c) { return c && String(c.master_character_id) === String(mid); }) ||
               ((s.CharacterList && s.CharacterList.supportCharacterList) || []).some(function (c) { return c && String(c.master_character_id) === String(mid); });
      };
      if (_isOwned(id)) {
        const _fcnt = fragmentCountFor(id);
        const _fitem = fragmentItemFor(id);
        if (_fcnt > 0 && _fitem) {
          const total = _fcnt * amount;
          addItem(_fitem, total);
          applied.push({ sheet_type: 1, master_id: _fitem, amount: total });
          console.log("[reward] 角色重复 → 折算碎片 " + id + " x" + amount + " ⇒ " + _fitem + " x" + total);
        } else {
          console.warn("[reward] 角色重复但查不到碎片定义: " + id + "（Character.csv FragmentCount / FragmentList.csv）");
        }
        continue;
      }
      for (let n = 0; n < amount; n++) {
        try {
          // ★ createCharacter(instanceId, accountId, masterCharacterId, opts) ——
          //   第一个参数是【实例 id】，不是 master id（早先传错会让角色 id 变成 "Ch..." 字符串）
          // ★ 2026-10-21：不要用 allocInstanceId()（它依赖模块级 state，未初始化时会抛
          //   "Cannot read properties of undefined (reading 'ItemList')" → 角色发不出去，券却已扣）。
          //   直接从当前 state 的现有角色里取最大 id +1。
          let _maxId = 100000000;
          for (const _c of [].concat(s.CharacterList.mainCharacterList || [], s.CharacterList.supportCharacterList || [])) {
            const _n = Number(_c.id); if (isFinite(_n) && _n > _maxId) _maxId = _n;
          }
          const ch = createCharacter(_maxId + 1, (s.UserData || {}).id, id, { support: isSupportCharacter(id) });
          if (!ch) continue;
          if (!s.CharacterList) s.CharacterList = { mainCharacterList: [], supportCharacterList: [] };
          if (isSupportCharacter(id)) {
            if (!Array.isArray(s.CharacterList.supportCharacterList)) s.CharacterList.supportCharacterList = [];
            s.CharacterList.supportCharacterList.push(ch);
          } else {
            if (!Array.isArray(s.CharacterList.mainCharacterList)) s.CharacterList.mainCharacterList = [];
            s.CharacterList.mainCharacterList.push(ch);
          }
          // ★★★ 2026-10-21：必须【登记本次变更的角色】★★★
          //   缺陷实证（用户报障「换的角色又没到账」，反复多次）：
          //   角色确实写进了 store（runs 起来主 60 只），但响应里的
          //   player_all_asset.MainCharacter 是空的 —— 客户端
          //   GameReceiveApi.UpdatePlayerAllAsset 只按 MainCharacter[] 增量把角色塞进本地
          //   CharacterDataStore，缺失 ⇒ 客户端永远不知道有这个角色（重启后 load_user_data
          //   才会看到）。道具之所以正常，是因为 addItem 内部会 touchItem。
          //   ⇒ 与 addItem 同理，角色发放也必须 touchCharacter，否则「发了＝没发」。
          //   对照：tutorial 的两处 ensureChar 本来就调了 touchCharacter，所以教程角色从未出问题。
          touchCharacter(id);
          applied.push({ sheet_type: 2, master_id: id, amount: 1 });
        } catch (e) { console.error("[reward] 角色发放失败 " + id + ": " + e.message); }
      }
      continue;
    }
    if (sheet === 3 || isEquipment(id)) {
      for (let n = 0; n < amount; n++) grantEquipment(id);
    } else if (sheet === 4 || /^Item_Amulet_/.test(id)) {
      for (let n = 0; n < amount; n++) grantAmulet(id);
    } else if (id === "Item_Stone_Free") addStone(amount, 0);
    else if (id === "Item_Stone_Paid") addStone(0, amount);
    else if (DIRECT_GRANTS[id] === "stamina") addStamina(amount);
    else if (DIRECT_GRANTS[id] === "exp") addPlayerExp(amount);
    else addItem(id, amount);
    applied.push({ sheet_type: sheet, master_id: id, amount: amount });
  }
  return applied;
}
/**
 * 生成【完整】的 player_all_asset。
 *
 * 关键（从客户端代码 UserAssetGachaResultDataStore.UpdateUserGachaResult 得到证实）：
 * 它会对抽到的每个角色调用 CharacterDataStore.GetCharacterInfo。若该角色尚未进入
 * 玩家数据，就必须能从本次响应的 player_all_asset.MainCharacter 里找到 —— 否则
 * 客户端拿不到角色信息，抽卡结果界面渲染失败（表现为白屏）。
 * 录制的响应正是这个规律：MainCharacter 只含本次 IsNew 的角色，EquipmentList 只含
 * 本次抽到的装备，MainCharacterSkill 给每个新角色补 3 条技能记录。
 *
 * @param newCharacters 本次新增的角色对象数组
 * @param newEquipments 本次新增的装备对象数组
 * @param itemIds       需要一并回传持有量的道具 id
 */
export function playerAllAssetFull(newCharacters, newEquipments, itemIds) {
  const s = loadState();
  const out = {
    EquipmentList: newEquipments || [],
    MainCharacter: newCharacters || [],
    MainCharacterSkill: [],
    AllItemList: [],
  };
  // 每个新角色补技能记录：第 1 条带真实技能 id（由调用方传入 skillOf 查 Character.csv），
  // 后 2 条是 null 占位 —— 与契约一致（契约第 1 条是 "1100002" 这样的字符串）。
  const skillOf = arguments.length > 3 ? arguments[3] : null;
  // ★ 响应内 MainCharacterSkill 的临时 id（不落库）—— 用 9e8 段，
  //   避开落库实体的 1~6e8 段（原先用 500000000，与 story 段重叠）。
  let skillId = 900000000;
  for (const ch of (newCharacters || [])) {
    const real = skillOf ? skillOf(ch.master_character_id) : null;
    out.MainCharacterSkill.push({ id: skillId++, player_account_id: ch.player_account_id, master_character_id: ch.master_character_id, master_skill_id: real });
    out.MainCharacterSkill.push({ id: skillId++, player_account_id: ch.player_account_id, master_character_id: ch.master_character_id, master_skill_id: null });
    out.MainCharacterSkill.push({ id: skillId++, player_account_id: ch.player_account_id, master_character_id: ch.master_character_id, master_skill_id: null });
  }
  // 道具持有量
  const all = (s.ItemList && s.ItemList.AllItemList) || [];
  // 只包含【本次涉及的】道具。itemIds 为空时返回空列表 —— 绝不能返回全部。
  // 早期写成「空则不过滤」，导致 bonus_player_all_asset 塞进全部 982 个道具，
  // 响应从 13KB 膨胀到 128KB；客户端拿到的数据结构与预期完全不符。
  if (!itemIds || !itemIds.length) return out;
  const want = new Set(itemIds);
  for (const it of all) {
    if (!want.has(it.master_item_id)) continue;
    out.AllItemList.push({ master_item_id: it.master_item_id, amount: it.amount, has_expired_at: !!it.has_expired_at, expired_at: it.expired_at || 0, has_locked: !!it.has_locked });
  }
  return out;
}

// ---------- 扭蛋计数（供 gacha/list 返回真实状态）----------
//
// 为什么需要：客户端靠 gacha/list 里的 totalCount / dailyCount 判断「还能不能抽」。
// 我们早期没实现这个端点（走回放），于是计数永远是录制时的旧值：
//   Sp00039「1日1回」在录制里 dailyCount=2，客户端据此认为今日已用完 → 按钮显示
//   「0回引く」并报「開催期間外のため、ガチャを引くことができませんでした。」

/** 今天（JST）的日期串，用于每日重置判断。 */
// ★ 必须用 JST —— 每日重置的基准是 GroundRule 的
//   Mission_Nomal_Daily_ResetTime = 0:00（JST）。
//   本机虽在 GMT+9，但不能依赖本机时区（换机器/出差就会错日）。
function todayKey() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.getUTCFullYear() + "-" + (jst.getUTCMonth() + 1) + "-" + jst.getUTCDate();
}

/**
 * 本周（JST）的标识串，用于【每周重置】判断。
 *
 * ★ 为什么需要（用户报障「まとめてskip 按钮直接废了」的根因之一）：
 *   `__weeklySkip` 是**周计数**，但我此前**完全没有重置逻辑** ——
 *   一旦用满（如 75/75），就**永久卡死**：按钮变灰、再也跳不了。
 *   （对比：daily 任务有 resetDailyMissionsIfNeeded，dailyReward 有 __dailyRewardDay，
 *     唯独 weeklySkip 漏了。）
 *
 * ★ 周的起点：采用 **ISO 周（周一为第一天）**。
 *   依据：日本手游惯例 + 官方 UI 文案是「今週のスキップ可能回数」，
 *   而游戏内的周常活动（スターフォース）按周一更新。
 *   ★ 诚实标注：GroundRule 里**没有**周重置时间的配置项（只有 StaminaRecoveryTime），
 *     故此处按 ISO 周实现；若日后发现官方用别的基准，改这一个函数即可（收口）。
 */
function weekKey() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  // 取 JST 的「日期」（去掉时分秒），再按 ISO 周（周一=1 … 周日=7）回退
  const d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
  const dow = d.getUTCDay() || 7;              // 0(周日) → 7
  d.setUTCDate(d.getUTCDate() - (dow - 1));    // 回退到本周一
  return d.getUTCFullYear() + "-W" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate();
}

/**
 * ★★★ 每周跳过次数重置（2026-10-15 补）★★★
 *
 * 用户报障：「まとめてskip 按钮直接废了」。
 *   根因之一：`__weeklySkip` 只累加、**从不重置** —— 一旦某任务组用满上限，
 *   就永久卡死（客户端显示「今週あと 0 回」且按钮变灰）。
 *
 * 实现：与 daily 重置同一模式（`__weekKey` 比对，跨周归零）。
 * 幂等：同一周内多次调用只重置一次。
 *
 * @returns {number} 被归零的条目数（0 表示本周已重置过）
 */
/**
 * ★★★ 每日通关次数的跨日重置（2026-10-15 补）★★★
 *
 * 背景（用户说明的关卡机制，三类）：
 *   ① MasterQuest / SpQuest —— **每日免费通关 N 次**（出击与 skip 都算），
 *      用完免费次数后**照常消耗体力**，且**skip 无次数上限**（受体力约束）。
 *   ② StarForce / ClassChallenge / 复刻Event / 活动Event —— **每周 skip 次数上限**，
 *      关卡本身无出击次数限制，且跳过**不消耗体力**。
 *   ③ SubQuest —— **每日通关次数上限**（`DailyQuestClearLimit`，出击与 skip 都算），
 *      超过即不能再打，且**消耗体力**。
 *
 * ⇒ 三类都需要「今日已通关次数」这个计数，而它必须**【跨日归零】**：
 *   不清零的后果 = 第二天所有关卡都显示「已用完」，玩家无法再打。
 *   （我此前只在 quest/end 累加、从不重置 —— 典型的「缺第三件事」。）
 *
 * 数据源：`UserQuestList[].DailyClearCount`（真机契约字段名实证）。
 */
export function resetDailyClearIfNeeded(s) {
  s = s || loadState();
  const today = todayKey();
  if (s.__questClearDay === today) return 0;
  s.__questClearDay = today;
  let n = 0;
  for (const q of (s.UserQuestList || [])) {
    if (Number(q.DailyClearCount)) { q.DailyClearCount = 0; n++; }
    if (Number(q.DailySkipCount)) q.DailySkipCount = 0;
  }

  if (n) {
    markDirty();
    console.log("[state] 每日通关次数已跨日重置（" + today + " JST）: " + n + " 条归零");
  }
  return n;
}

/** 读某任务今日已通关次数（纯读，不产生副作用）。 */
export function dailyClearCount(s, questId) {
  s = s || loadState();
  const q = (s.UserQuestList || []).find(function (x) { return x.MasterQuestId === questId; });
  return (q && Number(q.DailyClearCount)) || 0;
}

/** 累加某任务今日通关次数（写路径）。 */
export function bumpDailyClear(s, questId, n) {
  s = s || loadState();
  if (!questId || !n) return;
  if (!s.UserQuestList) s.UserQuestList = [];
  let q = s.UserQuestList.find(function (x) { return x.MasterQuestId === questId; });
  if (!q) { q = { MasterQuestId: questId, TotalClearCount: 0, DailyClearCount: 0, DailySkipCount: 0, DailyItemUseCount: 0 }; s.UserQuestList.push(q); }
  q.DailyClearCount = (Number(q.DailyClearCount) || 0) + n;
  markDirty();
}

export function resetWeeklySkipIfNeeded(s) {
  s = s || loadState();
  const wk = weekKey();
  if (s.__weekKey === wk) return 0;
  s.__weekKey = wk;
  let n = 0;
  for (const k of Object.keys(s.__weeklySkip || {})) {
    if (Number(s.__weeklySkip[k])) { s.__weeklySkip[k] = 0; n++; }
  }
  if (n) {
    markDirty();
    console.log("[state] 每周跳过次数已跨周重置（" + wk + " JST 周）: " + n + " 组归零");
  }
  return n;
}

/**
 * ★★★ 每日任务重置（2026-10-14 补）★★★
 *
 * 权威依据：GroundRule/GroundRule.csv 的
 *   Mission_Nomal_Daily_ResetTime = 0:00  —— 每日任务在 JST 0:00 重置。
 *
 * 缺陷（用户报障「每天进游戏都弹一堆任务完成提示」的根因之一）：
 *   我此前【完全没有这个机制】—— 每日任务的 Progress / IsAchieved / IsReceived
 *   会永久累积。运行几天后 10 条 DailyMission_* 长期停在「已达成未领取」，
 *   客户端每次登录都为它们弹「ミッション達成！」。
 *
 * 真机对照（contracts_winr/user_load_user_data.json，当天抓的）：
 *   20 条 DailyMission 里只有 3 条达成（DailyMission_Login_01 / LoginTime_01/02
 *   —— 因为当天登录过），其余 17 条 Progress=0 / IsAchieved=false。
 *   而我的存档 10 条达成 —— 差异就是「没重置」。
 *
 * 分类判据（已验证 21/21 纯净、零例外）：
 *   MissionId 以 "DailyMission_" 开头 即每日任务。
 *   验证：21 个 DailyMission_* 的 MissionGroupId 集合，与「含 DailyMission_ 成员
 *   的组」完全一致（无交叉污染、无反向越界）。
 *
 * 重置内容（三条都要归零）：
 *   Progress = 0 / IsAchieved = false / IsReceived = false
 *   ★ IsReceived 也要清 —— 否则第二天该任务是「已完成且领过了」，
 *     玩家当天无法再领（真机每天都能重新领）。
 *
 * ★ 不重置的：AchievementMission_*（永久成就，Progress 是累计值如 1000/10000）、
 *   MissionGroup_AchievementMission_*、以及一切非 DailyMission_ 前缀的任务。
 *
 * @returns {number} 本次重置的条数（0 = 今天已重置过 / 无需重置）
 */
const DAILY_MISSION_RE = /^DailyMission_/;

export function resetDailyMissionsIfNeeded(force) {
  const s = loadState();
  const today = todayKey();
  // force 用于测试/__reset 场景；正常路径靠 __missionDay 比对（同日幂等）
  if (!force && s.__missionDay === today) return 0;
  const list = s.MissionProgressList || [];
  let n = 0;
  for (const m of list) {
    if (!m || typeof m.MissionId !== "string") continue;
    if (!DAILY_MISSION_RE.test(m.MissionId)) continue;
    if (m.Progress === 0 && !m.IsAchieved && !m.IsReceived) continue;
    m.Progress = 0;
    m.IsAchieved = false;
    m.IsReceived = false;
    n++;
  }
  s.__missionDay = today;
  if (n) {
    markDirty();
    console.log("[state] 每日任务重置（" + today + " JST）: " + n + " 条归零");
  }
  return n;
}

/**
 * 登录类每日任务的推进（每次登录 +1）。
 *
 * 权威依据：MissionContentType 的登录族（见 MISSION_KINDS.login = [1, 8, 37]）：
 *   CT=1  登录时段（V1~V2 是 "0:00"~"23:59:59" 这类时间段）
 *   CT=8  「今日も一日がんばろう」（每日登录）
 *   CT=37 登录天数
 *
 * 缺陷：服务端【从不推进它】—— DailyMission_Login_01 永远停在种子存档的
 *   IsAchieved=true / IsReceived=false，于是每次登录都弹提示。
 *   真机当天它是 Progress=1 / IsAchieved=true / IsReceived=false（登录即达成、可领）。
 *
 * 实现：客户端每次 user/load_user_data（= 进入游戏）时推进一次，
 *   且【同一天只推进一次】（靠 __loginMissionDay 比对，避免客户端轮询刷爆）。
 *
 * 顺序要求：必须先 resetDailyMissionsIfNeeded() 再调用本函数 ——
 *   否则会把「昨天已达成的状态」当成今天的（当天仍显示已达成）。
 *
 * @returns {Array} 本次真正变化的任务记录（供响应回执）
 */
/**
 * 当前时刻（JST）是否落在 [v1, v2] 时段内。V 形如 "0:00" / "23:59:59"。
 */
function inLoginWindow(v1, v2) {
  const parse = function (t) {
    const m = String(t || "").match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
  };
  const a = parse(v1), b = parse(v2);
  if (a === null || b === null) return false;
  const d = new Date(Date.now() + 9 * 3600 * 1000);         // JST
  const sec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return sec >= a && sec <= b;
}

/**
 * 补建「时段类（MissionContentType=1）每日任务」的进度条目。
 * 只补【当前命中】的时段，未命中的不创建 —— 与真机语义一致。
 * @returns {number} 新建条数
 */
export function ensureTimeWindowMissions() {
  const s = loadState();
  const ctx = ensureMissionCtx();
  if (!s.MissionProgressList) s.MissionProgressList = [];
  const have = new Set(s.MissionProgressList.map(function (m) { return m && m.MissionId; }));
  let created = 0;
  for (const [mid, c] of ctx) {
    if (!/^DailyMission_/.test(String(mid))) continue;
    if (Number(c.MissionContentType) !== 1) continue;
    if (have.has(mid)) continue;
    if (!inLoginWindow(c.MissionValue1, c.MissionValue2)) continue;
    s.MissionProgressList.push({ MissionId: mid, Progress: 0, IsAchieved: false, IsReceived: false, MissionType: 2 });
    created++;
    console.log("[mission] 补建时段任务 " + mid + "（" + c.MissionValue1 + "~" + c.MissionValue2 + "）");
  }
  if (created) markDirty();
  return created;
}

export function advanceLoginMissions() {
  const s = loadState();
  const today = todayKey();
  // ★★ 2026-10-20：先【补建】当前时段命中的时段任务（CT=1）★★
  //   缺陷：advanceMissions 只遍历 MissionProgressList 里【已存在】的条目；
  //   而真机语义是「未命中的时段任务不创建条目」（录制实证：早上 6 点建号，LoginTime_02 不存在）。
  //   ⇒ 早上登录过的账号，到了 12:00 之后登录，LoginTime_02（12:00~23:59）永远补不出来，
  //     界面一直是 0/1（用户报障）。这里按 master 的 V1/V2 时段判定，缺哪个补哪个。
  try { ensureTimeWindowMissions(); } catch (e) { console.error("[mission] 补建时段任务失败: " + e.message); }
  // ★★★ 时序 bug 修复（2026-10-14，用户报「时间型任务未生效」）★★★
  //
  // 现象：16:05 JST（两个时段 00:00~23:59 / 12:00~23:59 都在区间内），
  //        但界面显示 LoginTime_01/02 都是 **0/1 未达成**。
  //
  // 根因：我原来用【一个】日内幂等标记 `__loginMissionDay` 拦住整个函数 ——
  //   今早 05:57 首次登录时，LoginTime_01（00:00~23:59）达成、
  //   LoginTime_02（12:00~23:59）**正确地**不达成（当时还没到 12 点）；
  //   但到了 12:00 之后，标记说「今天已推进过」→ **不再重新判定时段** → 永远卡在 0/1。
  //
  // ★ 正确语义（真机契约证据）：
  //   · LoginTime_02 的达成是【按任意一次落在区间内的登录】判定的，不是按 loginTime 那一刻：
  //     成熟账号 LoginTime_02 Ach=true，而其 UserData.loginTime=JST 04:10（在 12:00 之前）
  //     ⇒ 它是在当天 12:00 之后的某次登录达成的。
  //   · 新账号（JST 06:29 录制）**整个 LoginTime_02 条目都不存在** ——
  //     未命中的时段任务不创建条目。
  //   ⇒ 所以【时段类任务(CT=1)必须每次登录都重新判定】，不能被日内标记挡住。
  //
  // 修法：把幂等标记【只用于非时段类】（CT=8 每日登录、CT=37 登录天数 —— 这些确实一天只算一次），
  //   时段类(CT=1)改为每次都判定（幂等性由「达成后不再改」自然保证）。
  const isTimeWindow = function (missionId) {
    const c = ensureMissionCtx().get(missionId);
    return c && Number(c.MissionContentType) === 1;
  };

  // ① 时段类：每次都判定（不看日内标记）
  const timeChanged = advanceMissions("login", 1, { onlyContentType: 1 });

  // ② 非时段类：保持日内幂等
  let otherChanged = [];
  if (s.__loginMissionDay !== today) {
    s.__loginMissionDay = today;
    otherChanged = advanceMissions("login", 1, { excludeContentType: 1 }) || [];
  }

  return [...(timeChanged || []), ...otherChanged];
}

/**
 * 取某按钮的计数（必要时按日重置）。
 * 返回 { totalCount, dailyCount }
 */
// ★★ 设计修正：读函数【不得】有写副作用。
// 原实现会在读不到条目时【创建】它并 markDirty()，于是：
//   gacha/list → buildGachaGroupList → gachaCount(全部 178 个池)
//   → 179 个条目被创建并落盘 → 之后再也无法区分「玩家真扭过的池」。
// 实测症状：新账号扭 1 次后，gacha/list 返回 178 个池（真机只返回 1 个 Other_Tutorial1）。
// 修法：拆成两支 ——
//   · peekGachaCount()：纯读，不存在就返回零值对象（【不写 state】），供展示用
//   · ensureGachaCount()：真正要累加时才创建
export function peekGachaCount(groupId, gachaId, buttonId) {
  const s = loadState();
  const key = groupId + "|" + gachaId + "|" + buttonId;
  const e = s.__gachaCounts ? s.__gachaCounts[key] : null;
  if (!e) return { totalCount: 0, dailyCount: 0, day: todayKey() };
  // 跨日重置只在【真正要写】时落盘；读路径只做内存视图
  if (e.day !== todayKey()) return { totalCount: e.totalCount || 0, dailyCount: 0, day: todayKey() };
  return e;
}

/** 取（必要时创建）计数器 —— 仅供【写路径】使用（bumpGachaCount）。 */
export function ensureGachaCount(groupId, gachaId, buttonId) {
  const s = loadState();
  if (!s.__gachaCounts) s.__gachaCounts = {};
  const key = groupId + "|" + gachaId + "|" + buttonId;
  let e = s.__gachaCounts[key];
  if (!e) { e = { totalCount: 0, dailyCount: 0, day: todayKey() }; s.__gachaCounts[key] = e; markDirty(); }
  if (e.day !== todayKey()) { e.dailyCount = 0; e.day = todayKey(); markDirty(); }
  return e;
}

/** 兼容旧名（写路径语义）。 */
export function gachaCount(groupId, gachaId, buttonId) {
  return ensureGachaCount(groupId, gachaId, buttonId);
}

/** 记一次抽取。 */
export function bumpGachaCount(groupId, gachaId, buttonId, times) {
  const e = ensureGachaCount(groupId, gachaId, buttonId);
  e.totalCount += (times || 1);
  e.dailyCount += (times || 1);
  markDirty();
  return e;
}

// ---------- 扭蛋獲得履歴 ----------
// 契约形状（gacha/emission_history）：
//   { gacha_emission_history: [{ gacha_group_id, sheet_type, master_item_id,
//       amount, created_at }] }
// created_at 是 "YYYY-MM-DD HH:MM:SS" 字符串。
// 早期该端点未实现（走回放），而回放数据的 created_at 被我脱敏改成了 2025-01-01，
// 客户端据此显示成 1970 —— 且内容永远是录制时的旧记录。

/** 生成 "YYYY-MM-DD HH:MM:SS" 形式的当前时间。 */
export function nowStamp() {
  const d = new Date();
  const p = function (v) { return (v < 10 ? "0" : "") + v; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
         p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/** 追加一批獲得履歴。 */
export function recordEmissionHistory(groupId, emissions) {
  const st = loadState();
  if (!st.__gachaHistory) st.__gachaHistory = [];
  const ts = nowStamp();
  for (const e of (emissions || [])) {
    st.__gachaHistory.push({
      gacha_group_id: groupId,
      sheet_type: e.SheetType,
      master_item_id: e.ItemId,
      amount: e.Value || 1,
      created_at: ts,
    });
  }
  // 契约里说明「過去30日間まで最大500件」
  const cap = 500;
  if (st.__gachaHistory.length > cap) st.__gachaHistory = st.__gachaHistory.slice(-cap);
  markDirty();
}

/** 取獲得履歴（最新的在前，最多 500 条）。 */
export function getEmissionHistory() {
  const st = loadState();
  const h = st.__gachaHistory || [];
  return h.slice(-500).reverse();
}

/**
 * 从【请求体】推断本次操作涉及的道具，返回它们的持有量。
 *
 * 为什么需要：契约里 player_all_asset.AllItemList 应当包含本次操作涉及的道具
 * （消耗的 + 获得的）。早期大量路由传 null，导致返回空数组 —— 实测 21 个端点
 * 因此 EMPTY。这里做通用推断，避免每个路由各写一遍。
 */
/**
 * 把「玩家资产【实例 id】」映射回它在 AllItemList 里的【主数据 id】。
 *
 * 【为什么需要】客户端请求里大量出现的是实例 id，例如
 *   baggage/breakLimitEquipment { targetEquipmentUserId: 4271694449 }
 * 它不是 AllItemList 里的 master_item_id（那是 Item_Equipment_*）。
 * 早期 itemsFromRequest 直接把这些数字当作道具 id 去查 AllItemList → 必然查不到 →
 * items.AllItemList 恒为空。
 *
 * 映射来源（都在存档里）：
 *   EquipmentList[].Id           -> MasterEquipmentId
 *   amulet_list[].id             -> master_amulet_id（或等价字段）
 *   CharacterList                -> master_character_id
 */
export function instanceToMasterId(instId) {
  if (instId === undefined || instId === null || instId === "") return null;
  const s = loadState();
  const want = String(instId);
  const eq = ((s.ItemList && s.ItemList.EquipmentList) || []).find(function (e) { return String(e.Id) === want; });
  if (eq) return eq.MasterEquipmentId || null;
  const am = ((s.ItemList && s.ItemList.amulet_list) || []).find(function (a) { return String(a.id) === want; });
  if (am) return am.master_amulet_id || am.MasterAmuletId || null;
  const cl = [].concat((s.CharacterList && s.CharacterList.mainCharacterList) || [],
                       (s.CharacterList && s.CharacterList.supportCharacterList) || []);
  const ch = cl.find(function (c) { return String(c.id) === want; });
  if (ch) return ch.master_character_id || null;
  return null;
}

export function itemsFromRequest(req) {
  const ids = new Set();
  if (!req || typeof req !== "object") return [];
  const walk = function (o, depth) {
    if (depth > 4 || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    for (const k of Object.keys(o)) {
      const v = o[k];
      // ① 直接是主数据 id 的字段。
      //   ★ 判据不能只靠字段名白名单 —— 实测请求里同一语义有 4 种命名：
      //       master_item_id / itemId / item_id / masterItemId / itemMasterId /
      //       itemMasterId / item_master_id / itemMasterId …
      //     （契约实证：baggage/enhanceEquipmentByItem 用 "itemMasterId"，
      //       baggage/enhance_amulet_by_item 用 "item_master_id"，
      //       character/exchange_class_fragment 用 "master_item_id"）
      //     靠白名单必然漏（早期就漏了 itemMasterId 一整个系列）。
      //   稳健判据 = 【值本身长得像 MasterData 的 id】（Item_ 前缀的字符串）。
      if (typeof v === "string" && /^Item_[A-Za-z0-9_]+$/.test(v)) {
        ids.add(v);
        continue;
      }
      // ①b 兼容少数非 Item_ 前缀的道具 id（如 Fragment_* / Stone_* 之类），
      //    仍按字段名兜一层。
      if (typeof v === "string" && /^(master_id|itemMasterId|itemId|item_id|itemMasterID|masterItemId|fragmentId|fragment_id|master_item_id|target_item_id|materialId|material_id|consumeItemId)$/.test(k)) {
        if (v) ids.add(v);
        continue;
      }
      // ② 实例 id 字段（装备/护符/角色）—— 必须映射回主数据 id，
      //    否则会把数字当成道具名去查 AllItemList，永远查不到。
      if ((typeof v === "string" || typeof v === "number") && /(_user_id|UserId|user_asset_id|useEquipmentId|consumeEquipmentUserId|targetEquipmentUserId|equipId|amuletId)$/i.test(k)) {
        const mapped = instanceToMasterId(v);
        if (mapped) ids.add(mapped);
        continue;
      }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(req, 0);
  return [...ids];
}

// ---------- 入侵任务槽（InvasionQuestSlot）----------
//
// 权威数据链：Quest/InvasionQuest.csv 的 (QuestType, InvasionQuestSubGroup) 组合共 15 种，
//   契约逐条实测其 (InvasionQuestType, SubGroupNumber) 组合 **全部落在表内** ✅。
// 语义：入侵任务是【按时间轮换】的活动槽 —— 契约 7 条的可见时长分别是
//   1951s / 34727s / 26371s / 14805s / 43200s(×3) 秒，可见这是一组并行的轮换计时器
//   （43200s = 12 小时是主周期）。
// 实现策略：以【12 小时周期】为基准，用固定偏移为每个组合生成确定性的可见窗口 ——
//   · 确定性（同一时刻多次调用结果一致，客户端不会看到槽位闪烁）
//   · 周期性（与契约同量级）
//   · 诚实：这是本地重建的活动排期，非官方时刻表（官方排期不在 MasterData 里）。
// 早期实现只读 `s.__invasionSlots`，而**没有任何代码写它** → 恒为空数组。
export function invasionQuestSlots(nowSec) {
  const now = Number(nowSec) || Math.floor(Date.now() / 1000);
  const CYCLE = 43200;                                  // 12 小时主周期（契约实证）
  const combos = [
    [4, 3], [5, 1], [2, 2], [6, 2], [3, 2], [6, 1], [4, 1],
  ];
  const out = [];
  for (let i = 0; i < combos.length; i++) {
    const [type, sub] = combos[i];
    // 每个组合有各自的相位偏移，使窗口彼此错开（与契约「7 条不同起止」一致）
    const offset = i * 3607;                            // 质数间隔避免同相
    const start = Math.floor((now - offset) / CYCLE) * CYCLE + offset;
    const span = i % 3 === 0 ? 43200 : (1951 + i * 4073);  // 主周期或错开的短窗口
    out.push({
      InvasionQuestType: type,
      SubGroupNumber: sub,
      VisibleStartTime: start,
      VisibleEndTime: start + span,
    });
  }
  return out;
}

// ---------- 角色数据自愈 ----------
//
// 修复历史遗留：早期 createCharacter 一律用 "ユーザ用1"，且抽到的支援角色被塞进
// mainCharacterList。客户端 CharacterUseCase.GetCharacterTalentSkillGroupId 拿
// master_status_code 查 CharacterCodeLinkedData，查不到就抛 NullReferenceException
// → 抽卡结果页空白且按钮无响应。
//
// 判据来自 MasterData：Character.csv 的 SupportType（0=主角，非0=支援）。
// 这里按传进来的判定函数做纠正，返回修正条数。
/**
 * 自选池选择列表的【唯一读写入口】。
 *
 * 契约（gacha/list）里 UserAssetSelectPickCharacterList 是**扁平结构**：
 *   每个角色一条 { gacha_group_id, master_character_id, select_pick_reset_count }
 * 对应客户端类 Common.Network.TemporaryResponseObject.Gacha.TemporaryUserSelectCharacterList
 * （只有 gacha_group_id / master_character_id / select_pick_reset_count 三个字段）。
 *
 * 为什么必须收口：客户端 LoadUserGachaApi.cs:107 逐条读 `entry.master_character_id`
 * 并 List.Add。若写入的是别的形状（我曾写成「每组一条 + select_character_id_list 数组」），
 * 客户端会 Add 进 null → CharacterDetailUseCase.GetStatus 的 NullCheck 抛 NRE
 * → 该 NRE 在 ResourceCache.Update 的回调里抛出、中断循环 → 资源永远留在 loadingCache
 * → 每帧重复 Dictionary.Add 同 key → 上千次 ArgumentException → 界面卡死。
 * 因此这里既负责写入，也负责把历史脏数据修正回来。
 */
export function normalizeSelectPickList(s, gid, ids, resetCount) {
  if (!s.UserAssetSelectPickCharacterList) s.UserAssetSelectPickCharacterList = [];
  const list = s.UserAssetSelectPickCharacterList;

  // 1) 迁移历史脏数据：{ select_character_id_list: [...] } → 每角色一条
  const migrated = [];
  for (const e of list) {
    if (Array.isArray(e.select_character_id_list)) {
      for (const id of e.select_character_id_list) {
        migrated.push({ gacha_group_id: e.gacha_group_id, master_character_id: id, select_pick_reset_count: e.select_pick_reset_count || 0 });
      }
    } else if (e.master_character_id) {
      migrated.push({ gacha_group_id: e.gacha_group_id, master_character_id: e.master_character_id, select_pick_reset_count: e.select_pick_reset_count || 0 });
    }
    // 既无 select_character_id_list 又无 master_character_id 的条目直接丢弃（无法修复）
  }
  s.UserAssetSelectPickCharacterList = migrated;

  if (!gid) return s.UserAssetSelectPickCharacterList;

  // 2) 该组的当前 reset_count（保留既有值）
  const prev = migrated.find(function (x) { return x.gacha_group_id === gid; });
  const count = (resetCount === undefined || resetCount === null)
    ? (prev ? prev.select_pick_reset_count || 0 : 0)
    : Number(resetCount);

  // 3) 移除该组旧条目，再按【每角色一条】写入
  const keep = s.UserAssetSelectPickCharacterList.filter(function (x) { return x.gacha_group_id !== gid; });
  for (const id of (ids || [])) {
    keep.push({ gacha_group_id: gid, master_character_id: id, select_pick_reset_count: count });
  }
  s.UserAssetSelectPickCharacterList = keep;
  return s.UserAssetSelectPickCharacterList;
}

/** 读取某组已选角色（供 gacha.mjs 的 pickup 加权使用）。 */
export function selectPickIds(s, gid) {
  const list = (s && s.UserAssetSelectPickCharacterList) || [];
  const out = [];
  for (const e of list) {
    if (String(e.gacha_group_id) !== String(gid)) continue;
    if (e.master_character_id) out.push(e.master_character_id);
    else if (Array.isArray(e.select_character_id_list)) for (const x of e.select_character_id_list) if (x) out.push(x);
  }
  return [...new Set(out)];
}

/** 读取某组的 reset_count。 */
export function selectPickResetCount(s, gid) {
  const list = (s && s.UserAssetSelectPickCharacterList) || [];
  const hit = list.find(function (e) { return String(e.gacha_group_id) === String(gid); });
  return hit ? (hit.select_pick_reset_count || 0) : 0;
}

export function repairCharacterCodes(isSupport, codeFor, breakLimitFor) {
  const s = loadState();
  if (!s.CharacterList) return 0;
  const main = s.CharacterList.mainCharacterList || [];
  const sup = s.CharacterList.supportCharacterList || [];
  let fixed = 0;
  // 1) 纠正 code
  for (const c of main) {
    const want = codeFor(c.master_character_id);
    if (c.master_status_code !== want) { c.master_status_code = want; fixed++; }
  }
  for (const c of sup) {
    const want = codeFor(c.master_character_id);
    if (c.master_status_code !== want) { c.master_status_code = want; fixed++; }
  }
  // 2) 纠正列表归属（支援角色不该在 mainCharacterList）
  const moveToSup = main.filter(function (c) { return isSupport(c.master_character_id); });
  if (moveToSup.length) {
    s.CharacterList.mainCharacterList = main.filter(function (c) { return !isSupport(c.master_character_id); });
    for (const c of moveToSup) {
      if (!sup.some(function (x) { return x.master_character_id === c.master_character_id; })) sup.push(c);
    }
    fixed += moveToSup.length;
  }
  // 3) 修正支援角色的【字段名】—— 支援角色用另一套字段（见 character.mjs 的 createCharacter）：
  //    LinkedCharacterType / LinkedCharacterId / additional_status / CharaBattlePower /
  //    additional_link_soldier_type_list
  //    历史脏数据用主角色的字段名构造（AdditionalStatus / TotalBattlePower），
  //    且缺 additional_link_soldier_type_list → 客户端 .ToList() 抛 ArgumentNullException。
  for (const c of sup) {
    if (c.AdditionalStatus !== undefined && c.additional_status === undefined) {
      c.additional_status = c.AdditionalStatus; delete c.AdditionalStatus; fixed++;
    }
    if (c.TotalBattlePower !== undefined && c.CharaBattlePower === undefined) {
      c.CharaBattlePower = c.TotalBattlePower; delete c.TotalBattlePower; fixed++;
    }
    if (c.skill_cost_limit !== undefined) { delete c.skill_cost_limit; fixed++; }
    if (!Array.isArray(c.additional_link_soldier_type_list)) {
      c.additional_link_soldier_type_list = []; fixed++;
    }
    if (c.LinkedCharacterType === undefined) { c.LinkedCharacterType = 0; fixed++; }
    if (c.LinkedCharacterId === undefined) { c.LinkedCharacterId = null; fixed++; }
  }
  // 4) 修正【初始突破星级】为 0 的历史脏数据。
  //    Fusion/CharacterBreakLimit.csv 规定：FragmentCount==0 的最大 BreakLimitType 即初始星级
  //    （R1/R2 -> 1 星，R3 -> 2 星，R4 -> 3 星）。早期 createCharacter 一律给 0 星，
  //    导致抽到的 SSR 显示 0 星、界面要求突破。
  //    0 星在任何正常存档里都不存在（抽到即有初始星级），故一律视为脏数据修正。
  if (typeof breakLimitFor === "function") {
    for (const c of main) {
      if (c.break_limit === 0) { const w = breakLimitFor(c.master_character_id); if (w > 0) { c.break_limit = w; fixed++; } }
    }
    for (const c of sup) {
      if (c.break_limit === 0) { const w = breakLimitFor(c.master_character_id); if (w > 0) { c.break_limit = w; fixed++; } }
    }
  }
  // 5) 自愈自选池选择列表的历史脏数据。
  //    旧实现写成「每组一条 + select_character_id_list 数组」，而契约要求
  //    「每角色一条 + master_character_id」。脏数据会让客户端 List.Add(null)，
  //    进而在 GachaPageDetailGroupView 取 CharacterInfo(null) → NRE → 界面卡死。
  //    normalizeSelectPickList 同时做迁移与去重，这里只需判断是否有形状不对的条目。
  {
    const before = JSON.stringify(s.UserAssetSelectPickCharacterList || []);
    const dirty = (s.UserAssetSelectPickCharacterList || []).some(function (e) {
      return Array.isArray(e.select_character_id_list) || !e.master_character_id;
    });
    if (dirty) {
      normalizeSelectPickList(s, null, []);
      if (JSON.stringify(s.UserAssetSelectPickCharacterList) !== before) {
        fixed++;
        console.log("[state] repaired select-pick list (flat per-character shape)");
      }
    }
  }
  if (fixed) { markDirty(); console.log("[state] repaired " + fixed + " character field(s)"); }
  return fixed;
}

// ---------- 退出前强制落盘 ----------
//
// 为什么需要：markDirty 用 1500ms 防抖合并写盘（9MB JSON，每次 74ms）。
// 但若在这窗口内进程被杀/断电，最近的改动会丢失 ——
// 实测：改名后立即杀进程 → 重启后名字回退。
// 这里注册退出钩子，收到信号或异常时立即 saveNow()。
// （断电仍无法覆盖，那是防抖方案固有的取舍。）
let exitHooked = false;
export function flushOnExit() {
  if (exitHooked) return;
  exitHooked = true;
  const flush = function (why) {
    try { if (dirty) { console.log("[state] flush on " + why); saveNow(); } } catch (e) {}
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try { process.on(sig, function () { flush(sig); process.exit(0); }); } catch (e) {}
  }
  process.on("beforeExit", function () { flush("beforeExit"); });
  process.on("uncaughtException", function (e) { flush("uncaughtException"); throw e; });
}

/** 关键操作后立即落盘（语义化别名，便于在路由里表达意图）。 */
export function flushNow() { saveNow(); }

// ---------- 任务进度推进 ----------
//
// 契约里多个端点会返回 MissionProgressList（战斗/抽卡/领奖后任务进度变化）。
// 存档有 2083 条任务记录，字段 { MissionId, Progress, IsAchieved, IsReceived, MissionType }。
// 早期各端点一律返回 []，任务系统实际上没有推进。
//
// 这里按【任务类型】做通用推进：MissionType 与事件的对应关系取自 MasterData
// 的 Mission 表（若表缺失则退回保守规则：所有未完成任务 +1）。

/**
 * 按事件推进任务进度。
 * @param kind  事件类型：battle / gacha / login / quest / shop / present
 * @param amount 推进量（默认 1）
 * @returns 本次【发生变化】的任务记录数组（供响应返回）
 */
/**
 * 按事件推进任务进度。
 * @param kind  事件类型（见 MISSION_KINDS）
 * @param amount 推进量
 * @param ectx  事件上下文 { questId, battleId, roomId ... } —— 用于匹配 MissionValue1
 */
export function advanceMissions(kind, amount, ectx) {
  const s = loadState();
  const n = amount || 1;
  const list = s.MissionProgressList || [];
  const changed = [];
  for (const m of list) {
    if (!m || m.IsReceived) continue;
    // 只推进与本次事件【同类】的任务 ——
    // MissionContentType 描述任务追踪什么（如 3=襲来、4=共闘、17=体力消耗、
    // 31=装備作成、39=角色持有、45=強化ボード、48=アミュレット錬成…）。
    // 早期实现是「所有未完成任务一律 +1」，会把无关任务全部推成已达成，明显错误。
    if (!missionMatches(kind, m, ectx)) continue;
    const need = missionNeed(m);
    const before = m.Progress || 0;
    const wasAchieved = !!m.IsAchieved;
    m.Progress = Math.min(need, before + n);
    if (m.Progress >= need) m.IsAchieved = true;
    // 【只返回本次真正发生变化的任务】——
    // 契约实证：battle/win 那次返回 0 条（没有任务变化），
    // quest/end 返回 9 条、gacha/roll 返回 1 条。返回全部已达成任务是错的。
    if (m.Progress !== before || m.IsAchieved !== wasAchieved) changed.push(m);
  }
  if (changed.length) markDirty();
  return changed;
}

// 事件类型 -> 推进的 MissionContentType 集合。
//
// 依据（从 MasterData 的 MissionDescription 反推，逐个核对）：
//   CT=3  襲来（INVASION_ALL）を N 回クリア
//   CT=5  共闘クエスト【指定】をクリア
//   CT=28 プレイヤーRANK を N に
//   CT=31 ★N以上の装備品を M 個作成
//   CT=35 装備品を N 個錬成
//   CT=36 共闘クエスト（集合）をすべてクリア
//   CT=37 ログイン日数 N 日
//   CT=39 ★N以上のキャラを M 体所有
//   CT=42 クラスチャレンジクエスト【指定】をクリア
//   CT=49 マスターランクを N に
//   CT=53 初めてエンゲージを行う
// ★★ MissionContentType 全表（从 NormalMissionContent.csv 统计，共 24 种）——
//   早期我只覆盖了 9 种，漏掉的类型导致对应任务永不推进（如 43=特定活动关卡）。
//   逐条对应【玩家的具体动作】：
//     1  登录时段        2  (未用)
//     3  襲来クリア      4  サブクエストクリア       5  指定关卡クリア（最も多い 1110 条）
//     8  每日登录        12 サブクエスト挑戦達成      17 体力消費
//     18 送好友币        28 プレイヤーRANK           29 デイリーをN個クリア
//     31 装備作成(★N以上) 35 装備錬成                36 强者之道全クリア
//     37 ログイン日数     38 ノーマルガチャ           39 キャラ所持(★N以上)
//     42 クラスチャレンジ 43 活動关卡（オカシなケーキ）44 DMM连携
//     45 メイン強化ボード 46 サポート強化ボード       47 アミュレット作成
//     48 アミュレット錬成 49 マスターランク           51 剧情碎片领取
//     53 エンゲージ       58 DMM版游玩
const MISSION_KINDS = {
  // —— 战斗/任务类 ——
  battle:  [3, 5, 36, 42],          // 戦闘クリア系
  // ★ quest 只含「主线/强者之道/职业挑战/マスター/活动」类。
  //   移除 3（襲来）与 12（サブクエスト挑戦）—— 它们的 V1 是通配符或纯数字，
  //   在当前「按值放行」的规则下会被无条件推进（实证：skip MasterQuest 误推 7 条襲来任务）。
  //   这两类各自有专属 kind（invasion / subChallenge），由对应端点使用。
  // ★ 2026-10-26：移除 4（共斗挑战次数）—— 实测 quest/start|end 会把
  //   AchievementMission_Coop_01~11（共斗 1/5/10/30/50/100/150/200/300/500/1000 次）
  //   全部推到达成（V1=7 是副本类型、纯数字被「按值放行」），与「通关主线」这个动作完全不匹配。
  quest:   [5, 36, 42, 43],
  invasion: [3],                   // 襲来（V1=INVASION_ALL 或 STARFORCE_*）
  subChallenge: [12],              // サブクエスト挑戦数（V1=纯数字目标）
  // ★ 每日任务跳过：契约实证只推进 CT=43 的 DailyMission_*（4 条），
  //   不牵动 AchievementMission_*（那些属于「战斗」类，由 battle/win 推进）。
  skipDaily: [43],
  subQuest: [4, 12],                // サブクエスト（通关 + 挑战达成）
  questGroup: [36],                 // 强者之道全クリア
  eventQuest: [43],                 // 活動关卡（如オカシなケーキ）
  // —— 养成类（按具体动作细分）——
  equipBreakLimit: [31, 39],        // 装備作成/持有
  amuletBreakLimit: [47, 48],       // アミュレット作成/錬成
  // ★ 2026-10-26：移除 53（engage/誓约）—— 强化不该推进誓约任务，engage 有专属 kind
  enhance: [45, 46, 49],            // メイン/サポート強化ボード + マスターランク
  mainBoard: [45],
  supportBoard: [46],
  itemEnhance: [35],                // 装備品を錬成
  masterRank: [49],
  engage: [53],
  // —— 资源/其他 ——
  stamina: [17],                    // 体力消費
  login:   [1, 8, 37],              // 登录时段/每日/天数
  rank:    [28],                    // 玩家等级
  dailyClear: [29],                 // デイリーをN個クリア
  gacha:   [38],                    // ノーマルガチャ
  friend:  [18],                    // 送好友币
  story:   [51],                    // 剧情碎片领取
  account: [44, 58],                // DMM 连携 / DMM 版游玩
  shop:    [31],
  present: [],
};

let missionCtx = null;
function ensureMissionCtx() {
  if (missionCtx) return missionCtx;
  missionCtx = new Map();
  // ★ 2026-10-22：初心者ミッション的内容也在 Mission/*Content.csv 里（BeginnerMissionContent），
  //   早期只读 NormalMissionContent → 初心者任务全部查不到内容定义
  //   → missionMatches 直接 return false（永不推进）、refreshStateMissions 跳过、missionNeed 恒 1。
  for (const tbl of ["Mission/NormalMissionContent.csv", "Mission/BeginnerMissionContent.csv"]) {
    try {
      const t = loadTable(tbl);
      if (t) for (const r of t.rows) if (r.MissionId) missionCtx.set(r.MissionId, r);
    } catch (e) {}
  }
  return missionCtx;
}

// ==================== 初心者ミッション（BeginnerMission）====================
// ★★★ 2026-10-22 用户报障：「新手任务没有计数」★★★
//
// 反编译实证（UserAssetMissionDataStore.UpdateUserMissionList）：
//   TemporaryMissionList.MissionType 决定进哪个字典 ——
//     1/2 → 通常任务；**3 → 初心者ミッション**；其它 → 打日志「不明な種別 MissionType:{0}」。
//   而初心者ミッション的定义在 **Mission/BeginnerMissionContent.csv**（35 条 = 7 天 × 5 条）。
//   我们的 MissionProgressList 里【一条都没有】→ 页面「ミッション達成数 0」、每条 0/N、奖励领不了。
//   ⇒ 登录时补建这些条目（MissionType=3），并接上进度源（见 MISSION_STATE_SRC）。
let beginnerRowsCache = null;
export function beginnerMissionRows() {
  if (beginnerRowsCache) return beginnerRowsCache;
  beginnerRowsCache = [];
  try {
    const t = loadTable("Mission/BeginnerMissionContent.csv");
    if (t) for (const r of t.rows) if (r.MissionId) beginnerRowsCache.push(r);
  } catch (e) {}
  return beginnerRowsCache;
}

/** 初心者ミッション的累计奖励表（Mission/BeginnerMissionTotalReward.csv，5 档：5/10/15/20/30）。 */
let beginnerTotalCache = null;
export function beginnerMissionTotalRewardRows() {
  if (beginnerTotalCache) return beginnerTotalCache;
  beginnerTotalCache = [];
  try {
    const t = loadTable("Mission/BeginnerMissionTotalReward.csv");
    if (t) for (const r of t.rows) {
      const id = String(r.BeginnerMissionTotalRewardId || "");
      if (id) beginnerTotalCache.push({ id: id, clearCount: Number(r.ClearCount) || 0, rewardId: String(r.RewardIdList || "") });
    }
  } catch (e) {}
  return beginnerTotalCache;
}

/** 初心者ミッション【已达成】的条数（= 界面上的「ミッション達成数」）。 */
export function beginnerMissionAchievedCount() {
  const s = loadState();
  const ids = new Set(beginnerMissionRows().map(function (r) { return String(r.MissionId); }));
  const done = new Set((s.MissionProgressList || [])
    .filter(function (m) { return m && ids.has(String(m.MissionId)) && m.IsAchieved; })
    .map(function (m) { return String(m.MissionId); }));
  return done.size;
}

/** 初心者ミッション累计奖励的领取状态（写回 state，随 load_user_data 下发）。 */
export function refreshBeginnerTotalRewardState() {
  const s = loadState();
  const rows = beginnerMissionTotalRewardRows();
  if (!rows.length) return s.mission_total_reward_list || [];
  const prev = new Map(((s.mission_total_reward_list || [])).map(function (x) {
    return [String(x.beginner_mission_total_reward_id || ""), !!x.is_received];
  }));
  const list = rows.map(function (r) {
    return { beginner_mission_total_reward_id: r.id, is_received: prev.get(r.id) === true };
  });
  s.mission_total_reward_list = list;
  return list;
}

/**
 * 一次性补发【已经读过的角色剧情】奖励（2026-10-22）。
 * 背景：story/read 以前完全不发奖 —— 客户端弹「獲得 魔宝石×50」但服务端什么都没给。
 * 权威数据：Story/CharacterStoryList.csv（StoryId → RewardID = Reward_Story_Character = 石50）。
 * 用 __storyReward 记已发，天然幂等。
 */
export function healStoryRewards() {
  const s = loadState();
  const list = s.UserCharacterStoryList;
  if (!Array.isArray(list) || !list.length) return 0;
  if (!s.__storyReward) s.__storyReward = {};
  let map = null;
  let granted = 0;
  for (const e of list) {
    const sid = String((e && e.StoryId) || "");
    if (!sid || s.__storyReward[sid]) continue;
    if (map === null) {
      map = new Map();
      try {
        const t2 = loadTable("Story/CharacterStoryList.csv");
        if (t2) for (const r of t2.rows) { const id = String(r.StoryId || ""); if (id) map.set(id, String(r.RewardID || "")); }
      } catch (err) {}
    }
    const rid = map.get(sid);
    if (!rid) continue;
    try {
      const rw = resolveRewardId(rid);
      if (rw.length) {
        applyRewards(rw);
        s.__storyReward[sid] = true;
        granted += rw.length;
        console.log("[story] 补发 " + sid + " → " + rw.map(function (x) { return x.master_id + " x" + x.amount; }).join(","));
      }
    } catch (err) {}
  }
  if (granted) markDirty();
  return granted;
}

/**
 * 一次性修复：把存档里【已经存在的重复角色实例】去重，并按抽卡规则折算成碎片。
 * 背景：2026-10-22 之前 applyRewards 不判断「已持有」→ 复刻商店反复兑换同一角色，
 *      存档里出现同一 master 角色的多个实例（实测 18 主 + 23 支援）。
 * 规则：同一 master 只保留 1 个实例（优先保留等级/经验更高的），其余每一个折算
 *      Character.csv 的 FragmentCount 张碎片（Item/FragmentList.csv 反查碎片 id）。
 */
export function dedupeOwnedCharacters() {
  const s = loadState();
  if (s.__charDedup20261022) return 0;
  let removed = 0, fragTotal = 0;
  const seen = new Map();
  for (const key of ["mainCharacterList", "supportCharacterList"]) {
    const list = (s.CharacterList || {})[key];
    if (!Array.isArray(list)) continue;
    const keep = [];
    for (const c of list) {
      const mid = String((c && c.master_character_id) || "");
      if (!mid) { keep.push(c); continue; }
      const prev = seen.get(mid);
      if (!prev) { seen.set(mid, c); keep.push(c); continue; }
      // 重复：保留等级更高的那个
      const better = (Number(c.level) || 0) > (Number(prev.level) || 0) ? c : prev;
      const worse = better === c ? prev : c;
      if (better !== prev) {
        const idx = keep.indexOf(prev);
        if (idx >= 0) keep[idx] = better;
        seen.set(mid, better);
      }
      const fcnt = fragmentCountFor(mid);
      const fitem = fragmentItemFor(mid);
      if (fcnt > 0 && fitem) { addItem(fitem, fcnt); fragTotal += fcnt; }
      removed++;
      console.log("[char] 去重 " + mid + "（丢弃实例 id=" + (worse && worse.id) + "）→ 碎片 " + (fitem || "?") + " x" + fcnt);
    }
    s.CharacterList[key] = keep;
  }
  s.__charDedup20261022 = true;
  if (removed) { markDirty(); console.log("[char] 重复角色去重完成：删除 " + removed + " 个实例，补碎片 " + fragTotal + " 张"); }
  return removed;
}

/** 补建初心者ミッション的进度记录（幂等）。返回新增条数。 */
export function ensureBeginnerMissionProgress() {
  const s = loadState();
  const rows = beginnerMissionRows();
  if (!rows.length) return 0;
  if (!Array.isArray(s.MissionProgressList)) s.MissionProgressList = [];
  const have = new Set(s.MissionProgressList.map(function (m) { return m && m.MissionId; }));
  let added = 0;
  for (const r of rows) {
    const id = String(r.MissionId || "");
    if (!id || have.has(id)) continue;
    s.MissionProgressList.push({ MissionId: id, Progress: 0, IsAchieved: false, IsReceived: false, MissionType: 3 });
    added++;
  }
  if (added) { markDirty(); console.log("[mission] 初心者ミッション 补建 " + added + " 条进度记录（MissionType=3）"); }
  return added;
}

/**
 * questId → QuestGroupSetId（如 "Sp_Sweets_04_15" → "SP_Favorite"）。
 * 数据链：Quest/SpQuest.csv 的 QuestGroupId（=SP_FAVORITE_004）
 *         → Quest/QuestGroup.csv 的 QuestGroupSetId（=SP_Favorite）。
 * 惰性建索引并缓存。
 */
let questSetIdx = null;
function questGroupSetOf(questId) {
  if (!questSetIdx) {
    questSetIdx = new Map();
    // ① quest 表：QuestId → QuestGroupId
    const qgMap = new Map();
    try {
      const t = loadTable("Quest/QuestGroup.csv");
      if (t) for (const r of t.rows) qgMap.set(String(r.QuestGroupId), String(r.QuestGroupSetId || ""));
    } catch (e) {}
    for (const tbl of ["Quest/SpQuest.csv", "Quest/MainQuest.csv", "Quest/SubQuest.csv",
                       "Quest/EventQuest.csv", "Quest/CharacterQuest.csv", "Quest/MasterQuest.csv"]) {
      try {
        const t = loadTable(tbl);
        if (!t) continue;
        for (const r of t.rows) {
          const qid = r.QuestId; if (!qid) continue;
          const gid = String(r.QuestGroupId || "");
          const set = qgMap.get(gid) || "";
          if (set) questSetIdx.set(String(qid), set);
        }
      } catch (e) {}
    }
  }
  return questSetIdx.get(questId) || "";
}

/**
 * questId → **QuestType**（任务的种类编号）。
 * ★ 这个编号是 CT=4 / CT=5 等任务的 MissionValue1 的取值域 ——
 *   CT=4 的 V1 是 2/7/10，分别对应「サブクエスト / 共闘クエスト / マスタークエスト」：
 *     QuestType=1 main / 2 sub / 3 invasion(襲来) / 4 sp / 5 tower / 6 character /
 *                7 coop(共闘) / 8 event / 9 guild / 10 master / 11 starforce /
 *                13 NxN / 14 otherworld / 15 classChallenge / 16 recollection /
 *                17 abyssalMaze / 18 oracleLiberator
 *   ★ 权威来源：Quest/QuestGroup.csv 的 (QuestGroupId → QuestType)，
 *     questId → QuestGroupId 从各 quest 表取。
 * 早期我把「纯数字的 V1」一律当参数放行 → 所有 CT=4 任务（17 条）被同时推进，
 *   客户端看到 25 条「已达成未领取」→ 每次跳过都弹「ミッション達成」提示（用户报的问题3）。
 */
let questTypeIdx = null;
function questTypeOf(questId) {
  if (!questTypeIdx) {
    questTypeIdx = new Map();
    const qgMap = new Map();
    try {
      const t = loadTable("Quest/QuestGroup.csv");
      if (t) for (const r of t.rows) qgMap.set(String(r.QuestGroupId), Number(r.QuestType) || 0);
    } catch (e) {}
    for (const tbl of ["Quest/SpQuest.csv", "Quest/MainQuest.csv", "Quest/SubQuest.csv",
                       "Quest/EventQuest.csv", "Quest/CharacterQuest.csv", "Quest/MasterQuest.csv",
                       "Quest/InvasionQuest.csv", "Quest/TowerQuest.csv", "Quest/ClassChallengeQuest.csv",
                       "Quest/RecollectionTower.csv", "Quest/OtherWorldCorridor.csv"]) {
      try {
        const t = loadTable(tbl);
        if (!t) continue;
        for (const r of t.rows) {
          const qid = r.QuestId; if (!qid) continue;
          const gid = String(r.QuestGroupId || "");
          const ty = qgMap.get(gid) || 0;
          if (ty) questTypeIdx.set(String(qid), ty);
        }
      } catch (e) {}
    }
  }
  return questTypeIdx.get(String(questId)) || 0;
}

function missionMatches(kind, m, ectx) {
  const kinds = MISSION_KINDS[kind];
  if (!kinds) return false;
  const c = ensureMissionCtx().get(m.MissionId);
  if (!c) return false;   // 查不到任务内容定义 → 不推进（保守）
  const ct = Number(c.MissionContentType);
  if (kinds.indexOf(ct) < 0) return false;
  // ★ 内容类型白/黑名单（2026-10-14）——
  //   用途：把「时段类任务(CT=1)」与「每日/累计登录类(CT=8/37)」拆开推进，
  //   因为前者必须【每次登录重新判定时段】，后者才是【一天一次】。
  //   见 advanceLoginMissions 的注释。
  if (ectx && ectx.onlyContentType !== undefined && ct !== Number(ectx.onlyContentType)) return false;
  if (ectx && ectx.excludeContentType !== undefined && ct === Number(ectx.excludeContentType)) return false;
  // 若该任务指定了具体目标（MissionValue1），必须与本次事件匹配 ——
  // 例：CT=5「共闘クエスト【VS リチャード１世 Beginner】をクリア」V1=Coop_01_Beginner，
  // 只有打这个副本才推进。早期忽略 V1 → 一场战斗完成了所有同类任务（746 条）。
  const target = String(c.MissionValue1 || "").trim();
  if (!target) return true;                       // 无具体目标（如「装備品を1個錬成」）
  // ★ 通配必须结合来源判断：INVASION_ALL 只对【襲来任务本身】放行，
  //   不能因为「通配」就让任意 quest 推进襲来任务。
  //   判据：本次事件的 quest 其 QuestType 必须是 3（襲来）。
  if (/^(INVASION_ALL|ALL)$/.test(target)) {
    for (const q of [ectx.questIds || [], [ectx.questId], [ectx.battleId]].flat()) {
      if (q && questTypeOf(String(q)) === 3) return true;
    }
    return false;
  }
  // MissionValue1 的语义【按 ContentType 而异】（三类）：
  //   CT=5/36（共闘/强者之道）V1 是【具体副本 id】（如 Coop_01_Beginner）→ 精确匹配
  //   CT=31（作成品評）       V1 是【星数阈值】（如 "5"）→ 是参数，不是 id
  //   CT=43（活動关卡）       V1 是【任务组前缀】（SP_EXP / SP_Favorite / SP_Equipment）
  //     契约实证：请求含 Sp_Exp_07_15 / Sp_Sweets_04_15 / Sp_Equipment_03_12，
  //       而对应 4 条 daily mission 的 V1 正是 SP_EXP / SP_Favorite / SP_Equipment
  //       ⇒ 前缀匹配（把 questId 的 "Sp_Exp_07_15" 规范成 "SP_EXP" 再比）
  // ★ CT=4：V1 是 **QuestType 编号**（2=サブ / 7=共闘 / 10=マスター）——
  //   必须与本次 quest 的 QuestType **相等**，不能一律放行。
  //   实证：quest/skip 打的是 MasterQuest_Soldier_05（QuestType=10）→
  //     契约只推进 DailyMission_MasterQuest_01（V1=10）；
  //     而 AchievementMission_Coop_*（V1=7）不该推进。
  if (ct === 4) {
    const want = Number(target);
    for (const q of [ectx.questIds || [], [ectx.questId], [ectx.battleId]].flat()) {
      if (!q) continue;
      if (questTypeOf(String(q)) === want) return true;
    }
    return false;
  }
  // ★ CT=12（サブクエスト挑戦数）：V1 是纯数字目标 —— 只有【サブクエスト】事件才推进。
  if (ct === 12) {
    for (const q of [ectx.questIds || [], [ectx.questId], [ectx.battleId]].flat()) {
      if (q && questTypeOf(String(q)) === 2) return true;
    }
    return false;
  }
  // ★★ CT=1：登录时段任务（V1~V2 是 "0:00"~"23:59:59" 这类时间段）★★
  //   缺陷：V1 是【时间字符串】而非 id，走不到任何 id 匹配分支 →
  //     这两条每日任务（DailyMission_LoginTime_01/02）**永远不会被推进**。
  //   真机当天它们是 Progress=1 / IsAchieved=true（当天登录过即达成）。
  //   判据：当前 JST 时刻落在 [V1, V2] 区间内 → 达成。
  //   实证：LoginTime_01 = "0:00"~"23:59:59"（全天）；LoginTime_02 = "12:00"~"23:59:59"（仅下午）
  if (ct === 1) {
    const toSec = function (t) {
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t == null ? "" : t).trim());
      if (!m) return null;
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
    };
    const a = toSec(target), b = toSec(c.MissionValue2);
    if (a === null || b === null) return false;   // 形状不符 → 不推进（保守）
    const now = new Date(Date.now() + 9 * 3600 * 1000);
    const cur = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    return cur >= a && cur <= b;
  }
  if (/^\d+$/.test(target)) return true;
  if (!ectx) return false;                        // 有具体 id 目标但无上下文 → 不推进
  // ① CT=43（活動关卡）：V1 是 **QuestGroupSetId**（如 SP_Favorite / SP_EXP / SP_Equipment）。
  //   ★ 关键一跳（我第一版漏了）：questId 里的词与 V1 **字面不同** ——
  //     Sp_Sweets_04_15 的 QuestGroupId 是 **SP_FAVORITE_004**，而 V1 写的是 SP_Favorite。
  //     必须查 Quest/SpQuest.csv（或其它 quest 表）的 QuestGroupId，
  //     再去 Quest/QuestGroup.csv 拿 QuestGroupSetId，才能比对。
  //   实证映射：SP_FAVORITE_004 → SP_Favorite ✅、SP_EXP_004 → SP_EXP ✅、SP_EQUIPMENT_003 → SP_Equipment ✅
  if (ct === 43) {
    if (process.env.MISSION_DEBUG) console.log("[mm] CT43 target=" + target + " questIds=" + JSON.stringify(ectx.questIds) + " sets=" + JSON.stringify((ectx.questIds||[]).map(function(q){return q+"→"+questGroupSetOf(String(q));})));
    const t2 = String(target).toLowerCase();
    for (const q of [ectx.questIds || [], [ectx.questId], [ectx.battleId]].flat()) {
      if (!q) continue;
      const set = questGroupSetOf(String(q));
      if (set && set.toLowerCase() === t2) return true;
    }
    return false;
  }
  const cands = [ectx.questId, ectx.battleId, ectx.masterId].filter(Boolean).map(String);
  for (const cid of cands) {
    if (cid === target) return true;
    if (cid.indexOf(target) >= 0 || target.indexOf(cid) >= 0) return true;
  }
  return false;
}

/** 任务目标值（MissionValue2 通常是需要的次数）。 */
// ★★ 达标阈值在 V1 还是 V2 —— 按 ContentType 分两类（2026-10-14 修正）★★
//
// 缺陷（用户报障「每天弹一堆任务完成提示」的根因之二）：
//   原实现只会读 `MissionValue2`：
//       const v = Number(c.MissionValue2);  return v > 0 ? v : 1;
//   于是凡是「阈值在 V1」的任务都被算成 need=1 → **立刻达成**。
//
//   实测案例（你的存档）：AchievementMission_TotalLogin_09~29（累计登录 270~2000 天）
//     我   : Prog=1,   IsAchieved=true,  IsReceived=false  ← 错，而且天天弹提示
//     真机 : Prog=261, IsAchieved=false                   ← 对（261 < 270，还差 9 天）
//   即 21 条「还没达成的累计登录成就」被我误判成已达成 → 永久挂在「可领取」上。
//
// 判据（对全部 27 种 ContentType 统计 V1/V2 的数值化比例得出，两类互斥、无混合）：
//   阈值在 V2：CT 3,4,5,31,39,42,43,51,58      （V2 100% 是数值）
//   阈值在 V1：CT 12,17,18,28,29,35,37,45,46,48,49,53 （V2 为空，V1 100% 是数值）
// 例：CT=37「ログイン日数270日」V1=270 / V2=""  → 阈值在 V1
//     CT=5 「Main_2nd_171_01_m をクリア」V1=关卡id / V2=1 → 阈值在 V2
// ★ 用「V2 是不是空」做运行时判据，比写死 CT 清单更稳（新 CT 也能正确回退）：
//   V2 有值 → 用 V2；V2 为空但 V1 是数值 → 用 V1；两者都没有 → 1。
const NEED_IN_V1 = new Set([12, 17, 18, 28, 29, 35, 37, 45, 46, 48, 49, 53]);

/**
 * ★★★ 状态型任务（Task 的 Progress = 某个【当前状态值】，而不是累加计数）★★★
 *
 * 用户报障（2026-10-16）：「master rank 的达成条件、任务达成条件都有问题」——
 *   截图实证：`マスターランクを18にしよう 18/18`（可领取），而玩家 master_rank 只有 **16**。
 *
 * ★ 真机契约（决定性，20 条 MasterRank 任务逐条对照）：
 * ```
 *   真机 master_rank = 16
 *   MasterRank_01~16:  Prog = 1..16（各自目标值；已达成）  Ach=true
 *   MasterRank_17~20:  Prog = **16**（= 当前 rank！）      Ach=false
 * ```
 * ⇒ **Progress 跟随当前状态，而不是每次事件 +1。**
 *
 * ★ 我此前的实现（`advanceMissions`）一律：
 * ```js
 *   m.Progress = Math.min(need, before + n);   // ← 对状态型任务是错的
 * ```
 *   导致 MasterRank_17 被推到 17、_18 推到 18（**凭空达成**）。
 *
 * ★ 逐 CT 确认（真机契约 + MasterData 的 MissionDescription 双向印证）：
 * | CT | 描述 | Progress 的真值 | need 取值 |
 * |---|---|---|---|
 * | 28 | プレイヤーRANKを N に | `UserData.level` | V1 |
 * | 37 | ログイン日数 N 日 | 累计登录天数 | V1 |
 * | **49** | **マスターランクを N に** | **`master_rank_data.master_rank`** | **V1** |
 * | 31 | ★N以上の装備品を M 個作成 | **★N 以上的装备件数** | **V2** |
 * | 39 | ★N以上のキャラを M 体所有 | **★N 以上的角色数** | **V2** |
 *   真机实证（CT=39）：_20(V1=6,V2=40) Prog=40 Ach=true（clamp）；
 *                     _26(V1=6,V2=50) Prog=45 Ach=false（★6以上只有 45 个）✅
 *   真机实证（CT=31）：_14(V1=5,V2=40) Prog=39 Ach=false（★5以上装备 39 件）✅
 */
let _charRarMap = null;
function charRarityOf(masterCharacterId) {
  if (!_charRarMap) {
    _charRarMap = new Map();
    try {
      const t = loadTable("Character/Character.csv");
      if (t) for (const r of t.rows) {
        // ★ 列名是 `CharacterID`（大写 ID），不是 CharacterId
        const id = String(r.CharacterID || r.CharacterId || "").trim();
        if (id) _charRarMap.set(id, Number(r.Rarity) || 0);
      }
    } catch (e) {}
  }
  return _charRarMap.get(String(masterCharacterId || "")) || 0;
}
/**
 * ★★★ 「★N以上のキャラ」= `break_limit >= N` 的角色数（**不是 Rarity！**）★★★
 *
 * 判据（真机契约 1247 件装备 / 170 个角色的分布逐项反推）：
 * ```
 *   角色 break_limit 分布：2→2、3→28、4→23、5→72、**6→45** 个
 *     ⇒ `break_limit >= 6` = 45，与 Character_Star_26(V1=6,V2=50) 的 Prog=45 **完全一致** ✅
 *   装备 break_limit 分布：1→20、2→1178、3→9、4→1、**5→39** 件
 *     ⇒ `break_limit >= 5` = 39，与 Equipment_Star_14(V1=5,V2=40) 的 Prog=39 **完全一致** ✅
 * ```
 * ★ 我第一版用了 `Rarity`（角色）与 `equipmentRarity()`（装备）—— **都错**：
 *   角色的 Rarity 只有 2/3/4/6（6 仅主人公 2 个）→ 算出 2（应 45）；
 *   装备的 Rarity 只有 2/3/4（SSR 封顶）→ 「★5」根本不存在 → 算出 0（应 39）。
 *   **「★」= 星级 = `break_limit`，与 Rarity 是两个维度。**
 */
function countCharStarAtLeast(s, star) {
  const n = Number(star) || 0;
  if (!n) return 0;
  const cl = s.CharacterList || {};
  let c = 0;
  for (const ch of ((cl.mainCharacterList || []).concat(cl.supportCharacterList || []))) {
    if ((Number(ch.break_limit) || 0) >= n) c++;
  }
  return c;
}
function countEquipStarAtLeast(s, star) {
  const n = Number(star) || 0;
  if (!n) return 0;
  let c = 0;
  for (const e of (((s.ItemList || {}).EquipmentList) || [])) {
    if ((Number(e.break_limit) || 0) >= n) c++;
  }
  return c;
}
// ---- 初心者ミッション的进度源小工具（2026-10-22）----
function _questRows(s) { return Array.isArray(s.UserQuestList) ? s.UserQuestList : []; }
/** 某任务的累计通关次数。 */
function questTotalClear(s, questId) {
  const q = _questRows(s).find(function (x) { return String(x.MasterQuestId) === String(questId); });
  return q ? Number(q.TotalClearCount) || 0 : 0;
}
/** サブクエスト（QuestType=2）的累计通关次数（CT=4「サブクエストをN回クリア」）。 */
function subQuestClears(s) {
  let n = 0;
  for (const q of _questRows(s)) if (questTypeOf(q.MasterQuestId) === 2) n += Number(q.TotalClearCount) || 0;
  return n;
}
/** 某个 QuestGroupSetId 下【已通关的关卡数】（CT=43「SPクエスト◯◯をN回クリア」）。 */
function clearedCountInSet(s, setId) {
  let n = 0;
  for (const q of _questRows(s)) {
    if ((Number(q.TotalClearCount) || 0) <= 0) continue;
    if (questGroupSetOf(q.MasterQuestId) === String(setId)) n++;
  }
  return n;
}
function charsAtLeast(list, lv) { return (list || []).filter(function (c) { return (Number(c.level) || 0) >= lv; }).length; }
function equippedList(s) { return (((s.ItemList || {}).EquipmentList) || []); }
/** 装备附魔的 group（Enchant_0401 → Enchantgroup_04）。 */
let _enchantGroupMap = null;
function enchantGroupOf(enchantId) {
  if (_enchantGroupMap === null) {
    _enchantGroupMap = new Map();
    try {
      const et = loadTable("EquipmentEnchant/Enchant.csv");
      if (et) for (const r of et.rows) { const id = String(r.EnchantID || ""); if (id) _enchantGroupMap.set(id, String(r.EnchantgroupID || "")); }
    } catch (e) {}
  }
  return _enchantGroupMap.get(String(enchantId || "")) || "";
}
/** 同一角色身上同一附魔组的最大件数（2セット/4セット効果的判定依据）。 */
function maxEnchantSetCount(s) {
  const byChar = new Map();
  for (const e of equippedList(s)) {
    const owner = e.OwnerCharacterId; if (!owner) continue;
    const g = enchantGroupOf(e.currentEnchantId); if (!g) continue;
    if (!byChar.has(owner)) byChar.set(owner, new Map());
    const m = byChar.get(owner);
    m.set(g, (m.get(g) || 0) + 1);
  }
  let best = 0;
  for (const m of byChar.values()) for (const n of m.values()) if (n > best) best = n;
  return best;
}
/** 状态型任务的「状态源」—— 键 = MissionContentType。 */
const MISSION_STATE_SRC = {
  28: function (s) { return Number((s.UserData || {}).level) || 0; },
  // ★ CT=37 官方用的是独立计数器（真机 LoginDay=288 而 Prog=261，差 27 天断签），
  //   本地没有那个计数器 → 用 `LoginDay`（它就是累计登录天数，语义最近）。
  //   标注：数值可能与官方不同，但**语义方向正确**（不再是无意义的 +1 累加）。
  37: function (s) { return Number(s.LoginDay) || 0; },
  49: function (s) { return Number((s.master_rank_data || {}).master_rank) || 0; },
  31: function (s, v1) { return countEquipStarAtLeast(s, v1); },
  39: function (s, v1) { return countCharStarAtLeast(s, v1); },
  // ===== 初心者ミッション（Mission/BeginnerMissionContent.csv，35 条）=====
  // 反编译 getMissionInfoTemp()：ProgressMax 取自 master 模型字段，语义见各条注释。
  2:  function (s) { return (s.__friendList || []).length; },                       // フレンドをN人作ろう
  4:  function (s) { return subQuestClears(s); },                                   // サブクエストをN回クリア
  5:  function (s, v1, row) { return questTotalClear(s, String(row.MissionValue1 || "").trim()); },  // 指定关卡クリア
  9:  function (s) { const f = String(((s.UserData || {}).profileFrameMasterId) || ""); return f && f !== "Item_PlayerIconFrame_0001" ? 1 : 0; },  // アイコンフレーム変更
  13: function (s, v1, row) { return charsAtLeast(((s.CharacterList || {}).supportCharacterList) || [], Number(row.MissionValue2) || 0); },  // サポートN体をLvX
  19: function (s, v1, row) { return charsAtLeast(((s.CharacterList || {}).mainCharacterList) || [], Number(row.MissionValue2) || 0); },     // メインN体をLvX
  20: function (s) { return (s.TrainingNode || []).reduce(function (a, n) { return a + (Number(n.Level) || 0); }, 0); },  // 強化ボードをN回強化（节点等级和≈强化次数）
  24: function (s) { return equippedList(s).some(function (e) { return !!e.OwnerCharacterId; }) ? 1 : 0; },               // 装備品を装着
  32: function (s) { return maxEnchantSetCount(s) >= 2 ? 1 : 0; },                  // エンチャント2セット効果
  33: function (s) { return equippedList(s).some(function (e) { return !!e.currentEnchantId; }) ? 1 : 0; },               // エンチャント1回
  34: function (s) { return equippedList(s).some(function (e) { return (Number(e.break_limit) || 0) >= 2; }) ? 1 : 0; },   // 限界突破1回
  36: function (s, v1, row) {
    const ids = String(row.MissionValue1 || "").split(/[\r\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!ids.length) return 0;
    return ids.filter(function (id) { return questTotalClear(s, id) > 0; }).length;
  },                                                                                // SPクエスト◯◯の3段目をすべてクリア
  40: function (s) { const mb = s.memory_book || {}; return (mb.memory_book_node_list || []).some(function (n) { return (Number(n.level) || 0) > 0; }) ? 1 : 0; },  // 記憶の書を1回強化
  41: function (s) { return maxEnchantSetCount(s) >= 4 ? 1 : 0; },                  // エンチャント4セット効果
  43: function (s, v1, row) { return clearedCountInSet(s, String(row.MissionValue1 || "").trim()); },  // SPクエスト（グループ）をN回クリア
};

/**
 * 刷新所有【状态型任务】的 Progress（=`min(need, 当前状态值)`）。
 *
 * ★ 何时调用：进入游戏（`user/load_user_data`）+ 状态变化后。
 * ★ 已达成的不回退（`IsAchieved` 保持 true），与真机契约一致
 *   （真机 _20 Prog=40 而不是 45 —— 它在达成时被 clamp 到 need 后就不再变）。
 */
export function refreshStateMissions() {
  const s = loadState();
  try { ensureBeginnerMissionProgress(); } catch (e) {}
  const changed = [];
  const ctx = ensureMissionCtx();
  for (const m of (s.MissionProgressList || [])) {
    if (!m || m.IsReceived) continue;
    const c = ctx.get(m.MissionId);
    if (!c) continue;
    const ct = Number(c.MissionContentType);
    const fn = MISSION_STATE_SRC[ct];
    if (!fn) continue;
    const need = missionNeed(m);
    const cur = fn(s, Number(String(c.MissionValue1 || "").trim()), c);
    const before = m.Progress || 0;
    const wasAch = !!m.IsAchieved;
    // ★★★ 自愈：已判达成、但【当前状态其实不够】→ 撤回（只对未领取的）★★★
    //   我的旧实现把状态型任务按「+1 累加」推，导致 MasterRank_17 变成 17/17、
    //   _18 变成 18/18（玩家 master_rank 只有 16）—— 界面出现「可领取」的假按钮。
    //   判据：状态型任务的达成必须【恒等于】`cur >= need`。
    //   ★ 已领取（IsReceived）的一律不动 —— 玩家真领过，宁可少修不可错修。
    if (wasAch && cur < need) {
      m.IsAchieved = false;
      m.Progress = Math.min(need, cur);
      changed.push(m);
      console.log("[mission] 撤回误推的成就 " + m.MissionId + "（状态 " + cur + " < 需求 " + need + "）");
      continue;
    }
    if (wasAch) continue;   // 已达成的保持（与真机契约的 clamp 行为一致）
    const next = Math.min(need, cur);
    if (next === before) continue;
    m.Progress = next;
    if (cur >= need) m.IsAchieved = true;
    changed.push(m);
  }
  if (changed.length) markDirty();
  return changed;
}

export function missionNeed(m) {
  const c = ensureMissionCtx().get(m.MissionId);
  if (!c) return 1;
  const ct = Number(c.MissionContentType);
  const isNum = function (x) { return /^-?\d+(\.\d+)?$/.test(String(x == null ? "" : x).trim()); };
  // ★ 初心者ミッション的两类特殊语义（反编译 getMissionInfoTemp 的模型分类）：
  //   CT=13/19「サポート/メインN体をLvXに」→ 人数阈值在 V1、等级在 V2 ⇒ need = V1
  //   CT=36「SPクエスト◯◯の3段目をすべてクリア」→ V1 是关卡 id 列表 ⇒ need = 列表长度
  if (ct === 13 || ct === 19) return isNum(c.MissionValue1) && Number(c.MissionValue1) > 0 ? Number(c.MissionValue1) : 1;
  if (ct === 36) {
    const ids = String(c.MissionValue1 || "").split(/[\r\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    return ids.length || 1;
  }
  if (NEED_IN_V1.has(ct)) {
    return isNum(c.MissionValue1) ? Number(c.MissionValue1) : 1;
  }
  // 默认（含 CT=3/4/5/31/39/42/43/51/58）：阈值在 V2
  if (isNum(c.MissionValue2) && Number(c.MissionValue2) > 0) return Number(c.MissionValue2);
  // 回退：V2 不可用时若 V1 是数值，也可能是阈值（防御新 CT）
  if (isNum(c.MissionValue1) && Number(c.MissionValue1) > 0) return Number(c.MissionValue1);
  return 1;
}

/** 取全部已有进度（用于读接口）。 */
export function allMissionProgress() {
  return loadState().MissionProgressList || [];
}

// ---------- 公会内部数据 ----------
//
// 契约里 guild_internal_data 含 member_list / symbol_list / guild_quest_limit_list /
// guild_quest_ex_data 等子列表；缺了客户端读不到对应界面数据。
// 单机语义：成员=本地玩家自己；其余给结构正确的空列表。
// 收口于此，供 routes-rest / routes-quest / routes-char 共用（避免三处各写一份）。
/**
 * 公会内部数据（guild_internal_data）的【唯一出口】。
 *
 * 关键契约（逆向自客户端 TemporaryGuildPublicData.IsEmpty，Common/Network/
 * TemporaryResponseObject/Guild/TemporaryGuildPublicData.cs:24）：
 *
 *     if (guild_name != null) return false;   // ← 空字符串【不是】null！
 *     return guild_id == 0;
 *
 * 即「未入会」的唯一合法表达是 `guild_name === null`。
 * 一旦写成 `""`（空字符串），客户端判定 IsEmpty()==false → 认为玩家【在公会里】
 * → SmallMenuViewModel.Build（SmallMenuViewModel.cs:53-56）走
 *   `GetRoomList(ChatType.Guild).FirstOrDefault()` → 房间列表为空 → null
 * → 紧跟的 NullCheck 抛 NullReferenceException → 主页每帧崩 → 界面卡死。
 *
 * 因此本函数遵守两条硬规则：
 *   1) 未入会时 guild_name 必须是 null（不是 ""），且 member_list 必须为空。
 *   2) 入会时 chat/rooms 必须存在对应的 type=2 房间（见 chatRooms 是否一致）。
 * 单机语义：本地玩家不自建公会 → 一律「未入会」。
 */
export function guildInternal(overrides) {
  const s = loadState();
  // ★ 2026-10-22：出数据前先自愈（id 必须指向真实主数据，列表必须给全）
  try { healGuildInternal(s); } catch (e) {}
  const joined = s.guild_joined === true;      // 只有显式入会才为 true（单机默认为 false）
  // 排查用：入会状态异常时能立刻看见（单机默认必须为 false）
  if (joined && process.env.LEGECLOX_GUILD_DEBUG !== "0") {
    console.warn("[guild] guildInternal: guild_joined=true -> 返回入会数据 (guild_name=" +
      JSON.stringify((s.guild_internal_data || {}).guild_name) + ")");
  }
  const base = (joined && s.guild_internal_data) ? s.guild_internal_data : {};
  const out = {};
  for (const k of Object.keys(base)) out[k] = base[k];

  if (!joined) {
    // 未入会：按 TemporaryGuildPublicData.IsEmpty 的语义，guild_name 必须为 null。
    out.guild_id = 0;
    out.guild_name = null;
    out.guild_master_id = 0;
    out.guild_master_name = null;
    out.guild_level = 0;
    out.guild_exp = 0;
    out.joining_condition = 0;
    out.play_style = 0;
    out.emblem_master_id = 0;
    out.recruit_message = null;
    out.information_message = null;
    out.last_guild_ranking = 0;
    out.symbol_id = 0;
    out.chat_room_id = 0;
    out.member_list = [];
    out.symbol_list = [];
  } else {
    out.guild_name = out.guild_name == null ? null : out.guild_name;
    if (!Array.isArray(out.member_list)) out.member_list = [];
    if (!Array.isArray(out.symbol_list)) out.symbol_list = [];
  }
  out.guild_quest_limit = out.guild_quest_limit || 0;
  out.join_request_list = Array.isArray(out.join_request_list) ? out.join_request_list : [];
  out.last_chat_message_id = out.last_chat_message_id || 0;
  if (!Array.isArray(out.guild_quest_limit_list)) out.guild_quest_limit_list = [];
  if (!out.guild_quest_ex_data) out.guild_quest_ex_data = { rank: 0, score: 0, members_score_list: [] };
  if (overrides) for (const k of Object.keys(overrides)) out[k] = overrides[k];
  return out;
}

/**
 * 公会数据的自愈 / 规范化（2026-10-22）。
 *
 * ★ 由来（用户报障「建公会之后界面就崩了」）：客户端 BepInEx 日志实证
 *     [Error] KeyNotFoundException: The given key '0' was not present in the dictionary.
 *     [Error] KeyNotFoundException: The given key 'None' was not present in the dictionary.
 *     [Error] NullReferenceException: Object reference not set to an instance of an object.
 *   真因：guild/create 造出来的数据里 `roll_master_id = 0`、`symbol_id = 0`，
 *   而主数据里 `Guild/GuildRoll.csv` 只有 1..3（1=ギルドマスター/2=サブマスター/3=メンバー）、
 *   `Guild/GuildSymbolCharacter.csv` 只有 1..3（ゼニス/オリジン/ナディア）。
 *   ⇒ 客户端拿 0 去查字典 → KeyNotFoundException；随后拿不到成员/象征 → NRE。
 *   另外 symbol_list / guild_quest_limit_list 我此前根本没给（真机契约里各有 3 条）。
 *
 * 规则（本函数即唯一实现，create / 读接口 / 启动迁移 都走它）：
 *   ① 所有「指向主数据」的 id 必须真实存在（等级/徽章/象征/职位/头像框）
 *   ② symbol_list 恒 3 条（id 1..3）、guild_quest_limit_list 恒 3 条
 *   ③ member_list 至少含本地玩家，且 roll_master_id ∈ {1,2,3}
 *   ④ chat_room_id 与 chat/rooms 的 type=2 房间 id 同一算法（200000000 + guild_id % 1e8）
 * @returns {number} 修正的字段数（0 = 本来就合规）
 */
export function healGuildInternal(s) {
  if (!s || s.guild_joined !== true) return 0;
  if (!s.guild_internal_data || typeof s.guild_internal_data !== "object") {
    s.guild_internal_data = null; s.guild_joined = false; return 1;
  }
  const g = s.guild_internal_data;
  let n = 0;
  const set = function (k, v) {
    if (JSON.stringify(g[k]) !== JSON.stringify(v)) { g[k] = v; n++; }
  };
  const ud = s.UserData || {};
  const uid = Number(ud.id) || 1000001;
  const uname = String(ud.name || "プレイヤー");
  if (!(Number(g.guild_id) > 0)) set("guild_id", 90000 + (uid % 10000));
  if (!g.guild_name) set("guild_name", uname);
  if (!(Number(g.guild_master_id) > 0)) set("guild_master_id", uid);
  if (!g.guild_master_name) set("guild_master_name", uname);
  if (!(Number(g.guild_level) >= 1)) set("guild_level", 1);
  if (!(Number(g.guild_exp) >= 0)) set("guild_exp", 0);
  if (!(Number(g.emblem_master_id) >= 1)) set("emblem_master_id", 1);
  if (!(Number(g.symbol_id) >= 1)) set("symbol_id", 1);
  if (g.recruit_message == null) set("recruit_message", "");
  if (g.information_message == null) set("information_message", "");
  if (g.last_guild_ranking == null) set("last_guild_ranking", 0);
  // ---- 成员：职位必须是 1..3，头像/头像框必须是主数据里存在的 id ----
  const members = (Array.isArray(g.member_list) ? g.member_list : []).map(function (m) {
    const o = {};
    for (const k of Object.keys(m || {})) o[k] = m[k];
    o.id = Number(o.id) || uid;
    o.name = String(o.name || uname);
    const roll = Number(o.roll_master_id);
    o.roll_master_id = (roll >= 1 && roll <= 3) ? roll : 1;
    o.profile_character_master_id = String(o.profile_character_master_id || ud.profileCharacterMasterId || "Ch000100101");
    o.profile_frame_master_id = String(o.profile_frame_master_id || ud.profileFrameMasterId || "Item_PlayerIconFrame_0000");
    o.level = Number(o.level) || 1;
    o.master_rank = Number(o.master_rank) || 1;
    o.login_time = Number(o.login_time) || Math.floor(Date.now() / 1000);
    o.earned_guild_exp = Number(o.earned_guild_exp) || 0;
    return o;
  });
  if (!members.length) {
    members.push({
      id: uid, name: uname, roll_master_id: 1,
      profile_character_master_id: String(ud.profileCharacterMasterId || "Ch000100101"),
      profile_frame_master_id: String(ud.profileFrameMasterId || "Item_PlayerIconFrame_0000"),
      level: Number(ud.level) || 1, master_rank: Number(ud.master_rank) || 1,
      login_time: Math.floor(Date.now() / 1000), earned_guild_exp: 0,
    });
  }
  set("member_list", members);
  // ---- 象征（GuildSymbolCharacter 只有 1..3）----
  const syms = (Array.isArray(g.symbol_list) ? g.symbol_list : []).filter(function (x) {
    return x && Number(x.id) >= 1 && Number(x.id) <= 3;
  }).map(function (x) { return { id: Number(x.id), level: Number(x.level) || 1, exp: Number(x.exp) || 0 }; });
  for (const id of [1, 2, 3]) {
    if (!syms.some(function (x) { return x.id === id; })) syms.push({ id: id, level: 1, exp: 0 });
  }
  syms.sort(function (a, b) { return a.id - b.id; });
  set("symbol_list", syms);
  // ---- 公会任务上限列表（真机契约恒 3 条，id=1..3）----
  const lims = (Array.isArray(g.guild_quest_limit_list) ? g.guild_quest_limit_list : []).filter(function (x) {
    return x && Number(x.id) >= 1 && Number(x.id) <= 3;
  }).map(function (x) {
    return { id: Number(x.id), quest_limit: Number(x.quest_limit) || 10, quest_clear_count: Number(x.quest_clear_count) || 0 };
  });
  for (const id of [1, 2, 3]) {
    if (!lims.some(function (x) { return x.id === id; })) lims.push({ id: id, quest_limit: 10, quest_clear_count: 0 });
  }
  lims.sort(function (a, b) { return a.id - b.id; });
  set("guild_quest_limit_list", lims);
  set("join_request_list", Array.isArray(g.join_request_list) ? g.join_request_list : []);
  if (g.guild_quest_limit == null) set("guild_quest_limit", 0);
  if (g.last_chat_message_id == null) set("last_chat_message_id", 0);
  // ---- 公会战 ex 数据（真机契约：rank/score/members_score_list，本地玩家恒在列表里）----
  const ex = (g.guild_quest_ex_data && typeof g.guild_quest_ex_data === "object") ? g.guild_quest_ex_data : {};
  const msList = (Array.isArray(ex.members_score_list) ? ex.members_score_list : []).map(function (x) {
    const ssl = (Array.isArray(x.symbol_score_list) ? x.symbol_score_list : []).filter(function (y) {
      return y && Number(y.id) >= 1 && Number(y.id) <= 3;
    }).map(function (y) { return { id: Number(y.id), best_score: Number(y.best_score) || 0 }; });
    for (const id of [1, 2, 3]) {
      if (!ssl.some(function (y) { return y.id === id; })) ssl.push({ id: id, best_score: 0 });
    }
    ssl.sort(function (a, b) { return a.id - b.id; });
    return { player_account_id: Number(x.player_account_id) || uid, symbol_score_list: ssl };
  });
  if (!msList.some(function (x) { return Number(x.player_account_id) === uid; })) {
    msList.push({ player_account_id: uid, symbol_score_list: [{ id: 1, best_score: 0 }, { id: 2, best_score: 0 }, { id: 3, best_score: 0 }] });
  }
  set("guild_quest_ex_data", { rank: Number(ex.rank) || 0, score: Number(ex.score) || 0, members_score_list: msList });
  // ---- 公会聊天室 id 必须与 chat/rooms 的 type=2 房间一致 ----
  set("chat_room_id", 200000000 + (Number(g.guild_id) % 100000000));
  return n;
}

/**
 * 彻底清除公会（2026-10-22，用户要求「先禁掉建会 + 删掉公会数据让游戏恢复」）。
 *
 * 为什么要清：入会后客户端 SmallMenuViewModel.Build 会走
 *   `ChatUseCase.GetRoomList(ChatType.Guild).FirstOrDefault()` → 取不到就 null → NullCheck NRE
 *   ⇒ 主页右侧四个大按钮一起失效（用户报障「主页按钮没法点了」）。
 * 单机没有真实公会/真实公会聊天，**保持「未入会」是唯一稳定状态**。
 * 清除项：guild_joined / guild_internal_data / __chatRooms 里的 type=2（公会）房间。
 * 不碰任何玩家资产（角色/装备/道具/任务进度）。
 */
export function purgeGuild(s) {
  let n = 0;
  if (s.guild_joined !== false) { s.guild_joined = false; n++; }
  if (s.guild_internal_data !== null && s.guild_internal_data !== undefined) { s.guild_internal_data = null; n++; }
  if (Array.isArray(s.__chatRooms)) {
    const before = s.__chatRooms.length;
    s.__chatRooms = s.__chatRooms.filter(function (r) { return r && Number(r.type) !== 2; });
    if (s.__chatRooms.length !== before) n++;
  }
  return n;
}

/** 是否已加入公会（单机默认未入会）。 */

// ★ 2026-10-23：公会经验（真机契约实证：add_guild_exp = 消耗体力 × 次数）
//   证据（_winr_capture/contracts_winr）：
//     quest_skip.json          stamina 30 × 54 = 1620 → add_guild_exp 1620
//     quest_skip_sub_quest_bulk.json 15 × 28 = 420 → 420
//     quest_skip_daily.json    10 × 83 = 830 → 830
//     battle_win.json（Main_2nd_171_01_m，stamina 0）→ 0
//   ⇒ 任何任务通关都给公会经验，值 = 消耗体力 × 执行次数。
//   等级门槛来自 Guild/GuildLevel.csv（Level 2 = 200 exp …）。
export function grantGuildExp(amount) {
  const s = loadState();
  const gi = s.guild_internal_data;
  if (s.guild_joined !== true || !gi) return { before: { level: 0, exp: 0 }, after: { level: 0, exp: 0 }, add: 0 };
  const before = { level: Number(gi.guild_level) || 1, exp: Number(gi.guild_exp) || 0 };
  const add = Math.max(0, Math.floor(Number(amount) || 0));
  if (add > 0) {
    gi.guild_exp = before.exp + add;
    try {
      const lv = loadTable("Guild/GuildLevel.csv").rows;
      let lvl = before.level;
      for (let guard = 0; guard < 100; guard++) {
        const nx = lv.find(function (r) { return Number(r.Level) === lvl + 1; });
        if (!nx) break;
        if (Number(gi.guild_exp) >= Number(nx.Exp)) lvl++; else break;
      }
      gi.guild_level = lvl;
    } catch (e) {}
    const me = (gi.member_list || []).find(function (m) { return String(m.id) === String((s.UserData || {}).id); });
    if (me) me.earned_guild_exp = (Number(me.earned_guild_exp) || 0) + add;
    markDirty();
  }
  return { before: before, after: { level: Number(gi.guild_level) || 1, exp: Number(gi.guild_exp) || 0 }, add: add };
}

export function isGuildJoined() { return loadState().guild_joined === true; }

// ---------- 装备附魔的「进行中」状态 ----------
//
// 【为什么需要】baggage/enchantEquipmentStart 与 enchantEquipmentFix 是**一对**：
//   Start 请求带 enchantItemMasterId（附魔石）→ 服务端算出附魔结果并回 previewEnchantId
//   Fix   请求【只有 targetEquipmentUserId】→ 服务端须记住 Start 时算出的结果并落成 current
// 即真实服务端在两次调用之间保存了「进行中的附魔」。若 Fix 独立调用时无处可取
// （previewEnchantId 已被 Start 清空或从未设过），就会返回 null —— 客户端界面读不到附魔。
export function setPendingEnchant(equipmentId, enchantId) {
  const st = loadState();
  if (!st.__pendingEnchant) st.__pendingEnchant = {};
  if (enchantId) st.__pendingEnchant[String(equipmentId)] = String(enchantId);
  else delete st.__pendingEnchant[String(equipmentId)];
  markDirty();
}

export function getPendingEnchant(equipmentId) {
  const st = loadState();
  const m = st.__pendingEnchant || {};
  return m[String(equipmentId)] || null;
}

console.log("[state] module ready");
export function healBattleFormations(s) {
  const owned = new Set();
  for (const c of (s.CharacterList && s.CharacterList.mainCharacterList) || []) owned.add(c.master_character_id);
  for (const c of (s.CharacterList && s.CharacterList.supportCharacterList) || []) owned.add(c.master_character_id);
  let fixed = 0;
  const clean = (ids) => {
    if (!Array.isArray(ids)) return [];
    const before = ids.length;
    const out = ids.filter((id) => !id || owned.has(id));
    fixed += (before - out.length);
    return out;
  };
  const fixInfo = (info) => {
    if (!info || !Array.isArray(info.battle_formation)) return;
    const n0 = info.battle_formation.length;
    info.battle_formation = clean(info.battle_formation);
    const n = info.battle_formation.length;
    if (n !== n0) {
      if (Array.isArray(info.action_priority)) info.action_priority = info.action_priority.slice(0, n);
      if (Array.isArray(info.formation_id)) info.formation_id = info.formation_id.slice(0, n);
    }
  };
  if (s.UserData && s.UserData.last_battle_formation) fixInfo(s.UserData.last_battle_formation);
  for (const b of s.battle_formation_list || []) fixInfo(b.battle_formation_info_list || b);
  for (const k of Object.keys(s.__presets || {})) {
    const arr = s.__presets[k];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) fixInfo(p.battle_formation_info_list || p);
  }
  return fixed;
}
