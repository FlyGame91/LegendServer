// 角色养成写接口：按入参真实修改角色状态。
//
// 数据来源（MasterData）：
//   Fusion/CharacterLevelUp.csv   Level -> NeedExp（按 DefaultUnitType 分组）
//   Item/MaterialList.csv         经验道具 -> EffectValue（SSR 25000 / SR 3200 / R 400 / N 50）
//   Character/Character.csv       角色基础（DefaultUnitType）
import fs from "node:fs";
import path from "node:path";
import { route, ok, shapedForPath, okShaped } from "./server.mjs";
import { loadTable } from "./masterdata.mjs";
import { advanceTutorialStage, characterLevelCap, getState, markDirty, flushNow, findCharacter, isMainCharacter, addItem, playerAllAssetFor, applyRewards, toItemFormatList, itemsFromRequest, guildInternal, advanceMissions, touchCharacter, touchEquipment, touchedPlayerAllAsset, touchedPlayerAssets, allocInstanceId, consumeItems , linkedSupportOfMain } from "./state.mjs";
import { fragmentItemFor, refreshCharacterStatus, maxBreakLimit, classSkillCostFor, breakLimitTargetFor, breakLimitCumCost } from "./character.mjs";
import { fragmentTotalLimit, fragmentDailyLimit } from "./campaign.mjs";

const HERE = path.dirname(process.argv[1] || ".");
function parse(body) { try { return JSON.parse(body || "{}"); } catch (e) { return {}; } }
/**
 * 某角色当前装备的实例 id 列表 —— 按【装备侧的 OwnerCharacterId】反查。
 *
 * ★ 为什么不存 `character.equipment_id_list`：真机契约里没有该字段（0/170），
 *   它是客户端自己算的索引；服务端的权威归属字段是 `OwnerCharacterId`。
 *   存派生字段会导致 ① 与 OwnerCharacterId 双写不一致 ② 响应里多出契约没有的键。
 */
function equipIdsOf(s, masterCharacterId) {
  const id = String(masterCharacterId || "");
  if (!id) return [];
  return (((s.ItemList || {}).EquipmentList) || [])
    .filter(function (e) { return String(e.OwnerCharacterId || "") === id; })
    .map(function (e) { return e.Id; });
}

// ---------- 经验道具表 ----------
let matTbl = null, lvTbl = null, charTbl = null;
function ensure() {
  if (!matTbl) matTbl = loadTable("Item/MaterialList.csv");
  if (!lvTbl) lvTbl = loadTable("Fusion/CharacterLevelUp.csv");
  if (!charTbl) charTbl = loadTable("Character/Character.csv");
}

/** 道具 -> 经验值。 */
export function expForItem(itemId) {
  ensure();
  if (!matTbl) return 0;
  const row = matTbl.rows.find(function (r) { return (r.ItemId || r["アイテムID"]) === itemId; });
  if (!row) return 0;
  const v = Number(row.EffectValue || row["効果量"] || 0);
  return v > 0 ? v : 0;
}

/** 角色默认单位类型（决定用哪条经验曲线）。 */
function unitTypeOf(masterCharacterId) {
  ensure();
  if (!charTbl) return 1;
  const row = charTbl.rows.find(function (r) { return (r.CharacterID || r["キャラクタID"]) === masterCharacterId; });
  if (!row) return 1;
  return Number(row.DefaultUnitType || row["キャラクタータイプ"] || 1) || 1;
}

/** 累计经验 -> 等级（按该单位类型的曲线）。 */
function levelForExp(unitType, totalExp) {
  ensure();
  if (!lvTbl) return 1;
  let lv = 1;
  let acc = 0;
  for (const r of lvTbl.rows) {
    const t = Number(r.DefaultUnitType || r["キャラクタータイプ"] || 0);
    if (t !== unitType) continue;
    const need = Number(r.NeedExp || r["必要経験値"] || 0);
    acc += need;
    if (totalExp >= acc) lv = Number(r.Lv || r["Lv"] || lv);
    else break;
  }
  return lv;
}

// ==================== character/enhance ====================
// 请求：{ characterId, type, itemList:[{itemId, requestCount}] }
// 行为：消耗经验道具 → 增加角色 exp → 重算等级。
/**
 * 好感度道具的单个经验值 —— ★ 直接取主数据 Item/MaterialList.csv 的 EffectValue ★
 *
 * 纠正（2026-10-22 用户报障「服务端好感度增加值和客户端不一致」）：
 *   之前我按一次实测反推成 N=50/R=100/SR=150/SSR=200（还声称"与期望吻合"），
 *   其实那次观测（N×30+R×30+SR×30 → Lv17）用主数据值同样成立：
 *     30×(100+500+1500) = 63000，累计表 Lv17=57800 ≤ 63000 < Lv18=67800 → 正好 Lv17。
 *   ⇒ 观测根本区分不了两套值，我选错了那套。
 *   主数据（客户端读的就是这张表）：
 *     Item_Material_Favorite_N   EffectValue=100   （カットケーキ）
 *     Item_Material_Favorite_R   EffectValue=500   （ハーフケーキ）
 *     Item_Material_Favorite_SR  EffectValue=1500  （ホールケーキ）
 *     Item_Material_Favorite_SSR EffectValue=3000  （デコレーションケーキ）
 */
const FAVORITE_ITEM_EXP_FALLBACK = { N: 100, R: 500, SR: 1500, SSR: 3000 };
let _favMatTbl = null;
function favoriteItemExpFromMaster(rarity) {
  try {
    if (!_favMatTbl) _favMatTbl = loadTable("Item/MaterialList.csv");
    const id = "Item_Material_Favorite_" + rarity;
    const row = ((_favMatTbl && _favMatTbl.rows) || []).find(function (r) { return String(r.ItemId) === id; });
    const v = row ? Number(row.EffectValue) : 0;
    if (v > 0) return v;
  } catch (e) {}
  return FAVORITE_ITEM_EXP_FALLBACK[rarity] || 0;
}
const FAVORITE_ITEM_EXP = {
  get N() { return favoriteItemExpFromMaster("N"); },
  get R() { return favoriteItemExpFromMaster("R"); },
  get SR() { return favoriteItemExpFromMaster("SR"); },
  get SSR() { return favoriteItemExpFromMaster("SSR"); },
};

function favoriteItemExp(itemId) {
  const m = /Favorite_(SSR|SR|R|N)$/.exec(String(itemId || ""));
  return m ? (FAVORITE_ITEM_EXP[m[1]] || 0) : 0;
}

let favoriteTable = null;
/** FavoriteLevelUp.csv → [{Lv, NeedExp}]，按 Lv 升序。 */
function favoriteLevelRows() {
  if (favoriteTable) return favoriteTable;
  let rows = [];
  try {
    const t = loadTable("Fusion/FavoriteLevelUp.csv");
    rows = ((t && t.rows) || []).map(function (r) {
      return { Lv: Number(r.Lv) || 0, NeedExp: Number(r.NeedExp) || 0 };
    }).filter(function (r) { return r.Lv > 0; }).sort(function (a, b) { return a.Lv - b.Lv; });
  } catch (e) { rows = []; }
  favoriteTable = rows;
  return rows;
}

/**
 * 累计经验 → 好感度等级。
 * ★ 2026-10-22 纠正：FavoriteLevelUp.csv 的 NeedExp 是【每级所需】，不是累计值。
 *   累计 = 前缀和（Lv21 = 103800）。
 *   验证：契约 170 个角色的 (favorability_level, favorability_exp) 用累计口径 170/170 全中；
 *        用旧的「当累计」口径只对 12 个。
 */
let _favCum = null;
function favoriteCumRows() {
  if (_favCum) return _favCum;
  const rows = favoriteLevelRows();
  let acc = 0;
  _favCum = rows.map(function (r) { acc += r.NeedExp; return { Lv: r.Lv, Total: acc }; });
  return _favCum;
}
function favoriteLevelForExp(exp) {
  const rows = favoriteCumRows();
  if (!rows.length) return 1;
  let lv = 1;
  for (const r of rows) { if (exp >= r.Total) lv = r.Lv; else break; }
  return Math.min(lv, rows[rows.length - 1].Lv);
}

/** 好感度强化（character/enhance type=2）。 */
function enhanceFavorability(ctx, req, s, ch) {
  let gained = 0;
  const consumed = [];
  for (const it of (req.itemList || [])) {
    const row = s.ItemList.AllItemList.find(function (x) { return x.master_item_id === it.itemId; });
    const have = (row && row.amount) || 0;
    const use = Math.min(have, Number(it.requestCount || 0));
    if (use <= 0) continue;
    const per = favoriteItemExp(it.itemId);
    if (per <= 0) continue;                       // 不是好感度道具 → 不动
    addItem(it.itemId, -use);
    gained += per * use;
    consumed.push({ itemId: it.itemId, count: use });
  }
  const beforeLv = Number(ch.favorability_level) || 1;
  const beforeExp = Number(ch.favorability_exp) || 0;
  ch.favorability_exp = beforeExp + gained;
  // ★ 2026-10-22：等级【只升不降】。
  //   旧存档里有历史值（如 ジャンヌ&ミカエル Lv21 / exp17300），它是老表/老算法留下的，
  //   按新表算只到 Lv10 —— 直接覆盖等于把玩家进度降级。好感度本来也不会掉，故取 max。
  ch.favorability_level = Math.max(beforeLv, favoriteLevelForExp(ch.favorability_exp));
  // ★ 2026-10-22：好感度等级 → FavorabilityStatus（属性加成）必须【即时重算】。
  //   原来只 markDirty，属性要等下次登录 heal 才更新（面板/战力延迟一拍）。
  touchCharacter(ch.master_character_id);
  markDirty();
  console.log("[char] favorite " + req.characterId + " +" + gained + "exp -> Lv" + ch.favorability_level
    + "（" + beforeLv + "→" + ch.favorability_level + "，exp " + beforeExp + "→" + ch.favorability_exp + "）");
  const isMain = (s.CharacterList.mainCharacterList || []).indexOf(ch) >= 0;
  return okShaped(ctx.path, {
    main_character: isMain ? ch : null,
    support_character: isMain ? linkedSupportOfMain(s, ch.master_character_id) : ch,
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: [],
    limited_mission_progress_list: [],
    guild_internal_data: guildInternal(),
  });
}

route("character/enhance", function (ctx) {
  const req = parse(ctx.body);
  // ★★ 教程的最后一步是「強化（喂经验）」，真机在这次请求里带 tutorialProgressType=100
  //   （录制实证 #84, 2026-09-29 06:31:08）。100 = 教程结束标记，必须在此接住。
  try { advanceTutorialStage(req.tutorialProgressType); } catch (e) {}
  const s = getState();
  const ch = findCharacter(req.characterId);
  if (!ch) { console.log("[char] enhance: character not found " + req.characterId); return okShaped(ctx.path, { main_character: null, support_character: null, player_all_asset: { AllItemList: [] }, MissionProgressList: [], limited_mission_progress_list: [] }); }

  // ★★ 2026-10-20：type=2 = 喂【好感度道具】，不是升级经验 ★★
  //   实证：用户操作后客户端发来 {"characterId":"Ch018701107","type":2,
  //     "itemList":[Favorite_N x30, Favorite_R x30, Favorite_SR x30]}
  //   而我们原来不判 type，一律按 expForItem 当等级经验处理
  //   ⇒ 材料扣掉了、好感度不动（用户报障：「材料没了，好感度也没长」）。
  //   好感度经验值：N=50 / R=100 / SR=150 / SSR=200（由用户实测反推，见下方注释）
  //   等级表：Fusion/FavoriteLevelUp.csv（Lv,NeedExp，累计口径，Lv1=0 … Lv21=13000）
  if (Number(req.type) === 2) {
    return enhanceFavorability(ctx, req, s, ch);
  }

  let gainedExp = 0;
  const consumed = [];
  for (const it of (req.itemList || [])) {
    const have = (s.ItemList.AllItemList.find(function (x) { return x.master_item_id === it.itemId; }) || {}).amount || 0;
    const use = Math.min(have, Number(it.requestCount || 0));
    if (use <= 0) continue;
    addItem(it.itemId, -use);
    gainedExp += expForItem(it.itemId) * use;
    consumed.push({ itemId: it.itemId, count: use });
  }
  ch.exp = (ch.exp || 0) + gainedExp;
  const ut = unitTypeOf(ch.master_character_id);
  let newLv = levelForExp(ut, ch.exp);
  // ★★ 角色等级上限 = 玩家 RANK（2026-10-20 实录实证；见 routes-quest.mjs battle/win 注释）★★
  const cap = characterLevelCap();   // 玩家 RANK + 大师等级加成
  if (newLv > cap) {
    newLv = cap;
    if (typeof requiredExpFor === "function") {
      try { ch.exp = Math.min(ch.exp, requiredExpFor(ch.master_character_id, cap)); } catch (e) {}
    }
  }
  const leveled = newLv !== ch.level;
  ch.level = newLv; refreshCharacterStatus(ch);
  touchCharacter(ch && ch.master_character_id);
  markDirty();
  console.log("[char] enhance " + req.characterId + " +" + gainedExp + "exp -> Lv" + newLv + (leveled ? " (level up)" : "") + " consumed " + JSON.stringify(consumed));

  const isMain = (s.CharacterList.mainCharacterList || []).indexOf(ch) >= 0;
  return okShaped(ctx.path, {
    main_character: isMain ? ch : null,
    support_character: isMain ? linkedSupportOfMain(s, ch.master_character_id) : ch,
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: [],
    limited_mission_progress_list: [],
    guild_internal_data: guildInternal(),
  });
});

// ==================== character/enhance_bulk ====================
route("character/enhance_bulk", function (ctx) {
  const req = parse(ctx.body);
  // ★★★ 补 getState（2026-10-17）：我在「持有量校验」里用了 `s` 却没声明，
  //   导致 ReferenceError: s is not defined → alterCode 9999 → 整个端点不可用
  //   （audit 的 15 处 MISSING 全部由此产生）。
  const s = getState();
  const list = req.bulkInfoList || [];
  const out = [];
  for (const b of list) {
    const ch = findCharacter(b.characterId || b.character_id);
    if (!ch) continue;
    // 批量强化：按 itemList 累计经验（与单个强化同源）
    let gained = 0;
    for (const it of (b.itemList || [])) {
      const want = Number(it.requestCount || it.count || 0);
      if (!it.itemId || !want) continue;
      // ★★★ 与单体强化一致：实际用量受持有量限制（2026-10-17）★★★
      //   原实现直接 addItem(-want)，而 addItem 有 Math.max(0,…) 钳制
      //   ⇒ 材料不足时经验照给、材料只扣到 0 = 白嫖。
      const have = (s.ItemList.AllItemList.find(function (x) { return x.master_item_id === it.itemId; }) || {}).amount || 0;
      const use = Math.min(have, want);
      if (use <= 0) continue;
      addItem(it.itemId, -use);
      gained += expForItem(it.itemId) * use;
    }
    ch.exp = (ch.exp || 0) + gained;
    const ut = unitTypeOf(ch.master_character_id);
    let lv2 = levelForExp(ut, ch.exp);
    const cap2 = characterLevelCap();   // 玩家 RANK + 大师等级加成
    if (lv2 > cap2) {
      lv2 = cap2;
      if (typeof requiredExpFor === "function") {
        try { ch.exp = Math.min(ch.exp, requiredExpFor(ch.master_character_id, cap2)); } catch (e) {}
      }
    }
    ch.level = lv2; refreshCharacterStatus(ch);
    out.push(ch);
  }
  markDirty();
  // ★ 出口自动重算属性（server.mjs 的统一收口）—— 必须 touch 才会被重算。
  for (const x of out) touchCharacter(x.master_character_id);
  console.log("[char] enhance_bulk x" + out.length);
  const mains = out.filter(function (x) { return isMainCharacter(x); });
  const sups = out.filter(function (x) { return !isMainCharacter(x); });
  // ★ 契约字段名是 **main_character_list / support_character_list**（带 _list 后缀）——
  //   而 character/break_limit_bulk 用的是 main_characters/support_characters（无 _list）。
  //   同族端点字段名不同，必须逐端点核对契约。
  // ★★ 2026-10-21：support_character_list 不能只回"本次被强化的支援角色" ★★
  //   缺陷实证（用户报障）：批量升级【主角】后，已 link 的支援角色在编成界面变成
  //   「サポートなし」，但 link 列表里仍显示「リンク中」。
  //   原因：客户端会用响应的 support_character_list 去刷新自己的支援角色仓库，
  //   而批量强化主角时这个数组是空的（真机契约里那次也是 0 条，因为那个账号当时没 link）
  //   ⇒ 已 link 的支援条目被清掉，主/支关联显示消失。
  //   修法：把所有【已 link 的支援角色】一并回传（它们的 LinkedCharacterId 是关联的唯一来源），
  //   保证客户端刷新后仍能重建 主→支 的对应关系。
  const linkedSupports = ((s.CharacterList || {}).supportCharacterList || []).filter(function (x) {
    return x && x.LinkedCharacterId;
  });
  const supportOut = sups.slice();
  for (const sp of linkedSupports) if (supportOut.indexOf(sp) < 0) supportOut.push(sp);
  return okShaped(ctx.path, { main_character_list: mains, support_character_list: supportOut, player_all_asset: touchedPlayerAssets(), MissionProgressList: [], limited_mission_progress_list: [], guild_internal_data: getState().guild_internal_data || null });
});
route("character/break_limit", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ch = findCharacter(req.characterId);
  if (!ch) return okShaped(ctx.path, { main_character: null, support_character: null, player_all_asset: { AllItemList: [] }, MissionProgressList: [], limited_mission_progress_list: [] });
  // ★★★ 2026-10-26：单次突破【只升 1 星】★★★
  //   用户报障：「预期到 5 星，结果到 6 星了」—— 角色页的「限界突破」按一次一星，
  //   而「一键突破」(character/break_limit_bulk) 才是一路到上限。
  //   根因：这里错用了 breakLimitTargetFor(ch, requestCount) —— 它按「碎片够就一路升」算，
  //   而 requestCount 是【本次消耗的碎片数】，被当成了「可用碎片总量」→ 直接跳到满星。
  const _before = Number(ch.break_limit) || 0;
  const _cap = maxBreakLimit(ch.master_character_id);
  const _targetLevel = Math.min(_before + 1, _cap);
  const _cumB = breakLimitCumCost(ch.master_character_id, _before);
  const _cumT = breakLimitCumCost(ch.master_character_id, _targetLevel);
  const _cost = (_cumB === null || _cumT === null || _targetLevel <= _before) ? 0 : (_cumT - _cumB);
  const _tgt = { target: _targetLevel, cost: _cost, before: _before };
  if (_tgt.target <= _tgt.before) {
    console.log("[char] break_limit 已达上限或碎片不足 " + req.characterId + " (bl=" + _tgt.before + ")");
    const isMain0 = (s.CharacterList.mainCharacterList || []).indexOf(ch) >= 0;
    return okShaped(ctx.path, { main_character: isMain0 ? ch : null, support_character: isMain0 ? null : ch, player_all_asset: { AllItemList: [] }, MissionProgressList: [], limited_mission_progress_list: [] });
  }
  // ★★★ 碎片校验（2026-10-17）★★★
  if (req.fragmentId && _cost > 0) {
    const _chkB = consumeItems(s, [[req.fragmentId, _cost]]);
    if (!_chkB.ok) {
      console.log("[char] break_limit 碎片不足: " + _chkB.id + " need=" + _chkB.need + " have=" + _chkB.have);
      return okShaped(ctx.path, { main_character: null, support_character: null, player_all_asset: { AllItemList: [] }, MissionProgressList: [], limited_mission_progress_list: [] });
    }
  }
  // ★★★ 突破等级上限校验（2026-10-14，用户报「角色边框消失」）★★★
  //   我原先是 `ch.break_limit = (ch.break_limit||0) + 1` —— **无上限**，
  //   反复测试就把它推到了 7（权威表所有 Rarity 最高都是 6）。
  //   越界值让客户端的星级计算/缩略图渲染失效（立绘正常，缩略图空白）。
  //   判据：Fusion/CharacterBreakLimit.csv 的 (DefaultUnitType, Rarity) → max(BreakLimitType)。
  ch.break_limit = _tgt.target;   // ★ 一次可跨多级（预览多少星就给多少星）
  // ★ 突破会改变 CurrentBreakLimitStatus（基础值随突破等级提升）→ 必须重算属性。
  refreshCharacterStatus(ch);
  const mpChanged = advanceMissions("equipBreakLimit", 1, { questId: req.quest_id || req.questId });
  touchCharacter(ch && ch.master_character_id);
  markDirty();
  console.log("[char] break_limit " + req.characterId + " -> " + ch.break_limit);
  const isMain = (s.CharacterList.mainCharacterList || []).indexOf(ch) >= 0;
  return okShaped(ctx.path, {
    main_character: isMain ? ch : null,
    support_character: isMain ? linkedSupportOfMain(s, ch.master_character_id) : ch,
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: mpChanged,
    limited_mission_progress_list: [],
  });
});

route("character/break_limit_bulk", function (ctx) {
  const req = parse(ctx.body);
  const list = req.bulkInfoList || [];
  const s = getState();
  const out = [];
  for (const b of list) {
    const ch = findCharacter(b.characterId || b.character_id);
    if (!ch) continue;
    // ★★★ 2026-10-22 用户报障：「预览显示能突破到材料允许的最高星，实际只升 1 星」★★★
    //   真因：FragmentCount 是【累计】口径，客户端把「升到目标星级所需的总碎片」放在 requestCount
    //   （契约实证：requestCount=150 → 响应 break_limit=6），而我这里 `+1` 还把 150 全扣了。
    //   现在：先按累计表算出能升到第几星 + 实际消耗，再扣碎片、整段应用。
    const frag = b.fragmentId || b.fragment_id;
    const cnt = Number(b.requestCount || b.request_count || 1) || 1;
    const _tgtB = breakLimitTargetFor(ch, cnt);
    if (_tgtB.target <= _tgtB.before) {
      console.log("[char] break_limit_bulk 已达上限或碎片不足，跳过 " + (b.characterId || b.character_id) + " (bl=" + _tgtB.before + ")");
      out.push(ch);
      continue;
    }
    // ★★★ 碎片校验必须在【改等级之前】（2026-10-17）★★★
    if (frag && _tgtB.cost > 0) {
      const _chkBB = consumeItems(s, [[frag, _tgtB.cost]]);
      if (!_chkBB.ok) {
        console.log("[char] break_limit_bulk 碎片不足: " + _chkBB.id + " need=" + _chkBB.need + " have=" + _chkBB.have);
        continue;
      }
    }
    ch.break_limit = _tgtB.target;
    console.log("[char] break_limit_bulk " + (b.characterId || b.character_id) + " " + _tgtB.before + " -> " + _tgtB.target + "（耗碎片 " + _tgtB.cost + "）");
    out.push(ch);
  }
  const mpChanged = advanceMissions("equipBreakLimit", 1, { questId: req.quest_id || req.questId });
  markDirty();
  // ★ 角色/装备突破都会改属性（CurrentBreakLimitStatus）→ 必须 touch
  for (const x of out) touchCharacter(x.master_character_id);
  // 字段名必须与契约一致：main_characters / support_characters（早期写成 *_list，
  // 客户端读不到 → 突破结果弹窗空白）。按角色实际所属列表分类。
  const mains = out.filter(function (x) { return isMainCharacter(x); });
  const sups = out.filter(function (x) { return !isMainCharacter(x); });
  // ★★★ 2026-10-22：support_characters 不能只回"本次突破的支援角色" ★★★
  //   与 character/enhance_bulk 同型缺陷（那次已修，这里是漏掉的第二处）：
  //   客户端用响应里的 support_characters 刷新支援角色仓库，
  //   只回空数组时，未列出的支援会被清掉 → 主/支的 link 关系整批消失
  //   （用户第二次报障「我的 link 又丢了」；服务端日志显示丢之前刚点过
  //     character/break_limit_bulk，且本次请求全是主角色 ⇒ support_characters 恒空）。
  //   修法：把【所有已 link 的支援角色】一并带上（LinkedCharacterId 是关联的唯一来源）。
  const linkedSupports = ((s.CharacterList || {}).supportCharacterList || []).filter(function (x) {
    return x && x.LinkedCharacterId;
  });
  const supportOut = sups.slice();
  for (const sp of linkedSupports) if (supportOut.indexOf(sp) < 0) supportOut.push(sp);
  console.log("[char] break_limit_bulk -> main " + mains.length + " / support " + sups.length + " (+link " + (supportOut.length - sups.length) + ")");
  return okShaped(ctx.path, { main_characters: mains, support_characters: supportOut, player_all_asset: touchedPlayerAssets(), MissionProgressList: mpChanged, limited_mission_progress_list: [] });
});
route("character/favorite", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  // FavoriteUserCharacter 是【字符串数组】（契约与存档一致）：["Ch017800107", ...]
  // 早期包成 [{master_character_id:...}] 会让客户端反序列化失败。
  {
      // 只接受【玩家已拥有的角色】（客户端会按 id 反查 UserCharacter，未持有会 NRE）
      const cl0 = s.CharacterList || {};
      const own = new Set();
      for (const x of (cl0.mainCharacterList || [])) own.add(String((x && (x.master_character_id || x.MasterCharacterId)) || ""));
      for (const x of (cl0.supportCharacterList || [])) own.add(String((x && (x.master_character_id || x.MasterCharacterId)) || ""));
      const raw = Array.isArray(req.favoriteCharacterIds) ? req.favoriteCharacterIds : [];
      const kept = raw.map(String).filter((id) => own.has(id)).slice(0, 5);
      if (kept.length !== raw.length) console.log("[fav] 丢弃未持有的收藏角色 " + (raw.length - kept.length) + " 个: " + raw.filter((id) => !own.has(String(id))).join(","));
      s.FavoriteUserCharacter = kept;
    }
  markDirty();
  console.log("[char] favorite -> " + (req.favoriteCharacterIds || []).length);
  // 契约 result 是【字符串数组】["Ch017800107", ...]，不是对象。
  return ok(req.favoriteCharacterIds || []);
});

// ==================== character/receive_fragment ====================
route("character/receive_fragment", function (ctx) {
  const req = parse(ctx.body);
  const n = Number(req.count || 1);
  // ★ 契约的 item_format_list 是【逐份一条】（3 次 → 3 条，每条 amount=1），不是一条 amount=3。
  //   masterItemId 为空时（契约那次就是空），从 masterCharacterId 推导碎片道具 id。
  const s0 = getState();
  // ★★ 绝对不能用「字符串推导」猜碎片 id ★★
  //   我第一版按命名规律推：Ch020000107 → 后4位 → Item_Fragment_Main_0107 —— **错的**。
  //   权威表 Item/FragmentList.csv（CharacterId → ItemId）给出的是：
  //     Ch020000107 → Item_Fragment_Main_**0284**
  //     Ch000100101 → Item_Fragment_Main_0001（连 0001 都只是巧合）
  //   即角色编号与碎片编号【没有简单的位数对应关系】，必须查表。
  //   character.mjs 早已导出 fragmentItemFor()，直接用它（收口）。
  let itemId = req.masterItemId;
  if (!itemId && req.masterCharacterId) itemId = fragmentItemFor(req.masterCharacterId);

  // ★★ 每日领取上限 + 计数落库（2026-09-30 补）★★
  //   权威规则（MasterData 实证）：
  //     GroundRule.csv: **Fragment_Receive_Today_Receivable_Count = 9**（每日可领 9 次）
  //     真机契约 character/receive_fragment 响应：
  //       TodayReceivedFragmentList: [{MasterCharacterId, TotalReceiveCount:177,
  //                                    DailyReceiveCount:3, DailyItemUseCount:0}]
  //       （DailyReceiveCount 是【今天已领次数】，TotalReceiveCount 是累计）
  //   缺陷：我早期既不检查上限、也不写入 TodayReceivedFragmentList →
  //     该字段恒为旧值，且**可以无限领取**（超出每日 9 次也不拦）。
  //   ★ 语义与 mission 的「已领取」不同：这里是【按天计数】，不是一次性开关。
  // ★★ 上限 = 基础 + 活动加成 + MasterRank 加成（收口到 campaign.mjs）★★
  //   反编译 ReceiveFragmentUseCase.cs:82-99 的公式：
  //     总上限   = GroundRule(9) + GetCampaignCount(1)(+18) + LimitPlus(masterRank)(+3) = 30
  //     单角色   = ReceiveFragment.DailReceiveLimit(3) + GetCampaignCount(2)
  //   我上一轮硬编码 9 —— **完全没有活动加成**，玩家每天少领 21 次（用户报障）。
  const totalLimit = fragmentTotalLimit(s0.UserData && s0.UserData.master_rank);
  const dailyLimit = fragmentDailyLimit(req.masterCharacterId);
  if (!s0.TodayReceivedFragmentList) s0.TodayReceivedFragmentList = [];
  // ★ 2026-10-22：改用 JST 日期（原来用 UTC，JST 00:00~09:00 会错一天）
  const _jst = new Date(Date.now() + 9 * 3600 * 1000);
  const today = _jst.getUTCFullYear() + "-" + (_jst.getUTCMonth() + 1) + "-" + _jst.getUTCDate();
  if (s0.__fragmentDay !== today) {                    // 跨日重置
    s0.__fragmentDay = today;
    for (const e of s0.TodayReceivedFragmentList) { e.DailyReceiveCount = 0; e.DailyItemUseCount = 0; }
  }
  let entry = s0.TodayReceivedFragmentList.find(function (x) { return x.MasterCharacterId === req.masterCharacterId; });
  if (!entry) {
    entry = { MasterCharacterId: req.masterCharacterId, TotalReceiveCount: 0, DailyReceiveCount: 0, DailyItemUseCount: 0 };
    s0.TodayReceivedFragmentList.push(entry);
  }
  const already = Number(entry.DailyReceiveCount) || 0;
  // ★★ 两道上限（反编译 ReceiveFragmentUseCase.cs:82-99）★★
  //   ① 单角色日上限 = ReceiveFragment.DailReceiveLimit + GetCampaignCount(2)
  //        → 该角色今天最多领几次（默认 3，受 Content=2 的活动影响）
  //   ② 全账号日上限 = GroundRule(9) + GetCampaignCount(1)(+18) + MasterRank累计(+3)
  //        → **所有角色今天合计**最多领几次（当前 30）
  //   我第一版只做了 ①，于是玩家实测「领 3 次就没了」—— 而活动本应给到 30。
  //   注：MasterRank 界面显示的「12回」= 9 + 3（不含活动），活动横幅单独显示 +18，合计 30。
  // UserFragmentReceiveCountIncrease.IncreasedCount —— 由服务端下发（BoardGame 活动等）。
  // 本地存档暂无该字段 → 0（不影响 MasterRank/活动加成的计算）。
  const increasedCount = Number((s0.UserFragmentReceiveCountIncrease || {}).IncreasedCount) || 0;
  // ★★ 完整公式（反编译 ReceiveFragmentUseCase.cs:82-210，逐行对齐）★★
  //   GetTodayTotalReceivableCount()  —— 全账号日上限
  //     total = GroundRule(9) + GetCampaignCount(1)(活动 +18) + LimitPlus(masterRank)(+3) = 30
  //   GetDailyReceiveFragment()       —— 界面显示的「今日剩余可领」
  //     CurrentNumber = clamp((total + increased) - receivedToday, 0, total + increased)
  //   GetTodayOneCharacterReceivableCount() —— 单角色日上限
  //     perChar = ReceiveFragment.DailReceiveLimit(3) + GetCampaignCount(2)(当前无活动 = 0) = 3
  //
  //   ★ 关键区分（我一开始搞混了）：
  //     「フラグメント受取回数上限 12回」（MasterRank 界面）= 9 + MR3，**不含活动**；
  //     「受取可能回数 +18」（活动横幅）= 活动增量；两者相加 = 30 = **全账号今日可领总数**。
  //     而单角色仍是 3（真机契约实证 DailyReceiveCount:3）—— 每个角色各能领 3 次。
  //   ⇒ 玩家体验：给 10 个角色各领 3 次（合计 30 次），而不是一个角色领 30 次。
  const allReceivedToday = (s0.TodayReceivedFragmentList || [])
    .reduce(function (sum, x) { return sum + (Number(x.DailyReceiveCount) || 0); }, 0);
  const totalRemain = Math.max(0, totalLimit + increasedCount - allReceivedToday);
  const grant = Math.max(0, Math.min(n, dailyLimit - already, totalRemain));   // 超出任一上限的部分不发放
  if (grant <= 0) {
    console.log("[char] receive_fragment " + req.masterCharacterId + " x" + n +
                " -> 已达上限（该角色今日 " + already + "/" + dailyLimit +
                "，全账号今日 " + allReceivedToday + "/" + totalLimit + "）");
  }

  const list = [];
  if (itemId) for (let k2 = 0; k2 < grant; k2++) list.push({ sheet_type: 1, master_id: itemId, amount: 1 });
  const applied = list.length ? applyRewards(list) : [];
  entry.DailyReceiveCount = already + grant;
  entry.TotalReceiveCount = (Number(entry.TotalReceiveCount) || 0) + grant;
  if (grant > 0) console.log("[char] receive_fragment " + req.masterCharacterId + " x" + grant +
    " (今日 " + entry.DailyReceiveCount + "/" + dailyLimit + ", 累计 " + entry.TotalReceiveCount + ")");
  flushNow();
  const s = getState();
  return okShaped(ctx.path, {
    TodayReceivedFragmentList: s.TodayReceivedFragmentList || [],
    // ★ 注意：这里曾有【两个 items 键】(JS 允许重复键，后者覆盖前者) ——
    //   我插入的新 items 被后面的旧 items 覆盖，导致 items 恒空。
    //   JS 对象字面量的重复键是静默覆盖，不加严格模式检查不出来。
    item_format_list: toItemFormatList(applied),
    items: playerAllAssetFor(applied.map(function (x) { return x.master_id; })),
    player_all_asset: touchedPlayerAssets(),
    present_item_format_list: [],
    notification: [],
    userData: s.UserData,
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ==================== character/change_skill ====================
route("character/change_skill", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  if (!s.SetSkillList) s.SetSkillList = [];
  const ch = findCharacter(req.characterId);
  const ids = Array.isArray(req.skillIdList) ? req.skillIdList : [];
  // 存档里 SetSkillList 的结构是【每条一个技能】：
  //   { id, player_account_id, master_character_id, master_skill_id }
  // 早期我写成 { character_id, skill_id_list } —— 字段名完全不符，客户端读不到。
  // 正确做法：移除该角色的旧技能记录，再按新列表逐条插入。
  s.SetSkillList = s.SetSkillList.filter(function (x) { return x.master_character_id !== req.characterId; });
  // ★★★ 改用统一分配器（2026-10-16）★★★
  // 原实现 `600000000 + s.SetSkillList.length` 在「filter 掉旧记录后再 push」时
  // 会重用已有 id → 客户端建字典抛 ArgumentException。
  //   例：id=600000184 同时属于 Ch000100101/1100276 与 Ch012300107/1100275。
  for (const sid of ids) {
    s.SetSkillList.push({ id: allocInstanceId(s, "skill"), player_account_id: s.UserData.id, master_character_id: req.characterId, master_skill_id: sid });
  }
  touchCharacter(ch && ch.master_character_id);
  markDirty();
  console.log("[char] change_skill " + req.characterId + " -> " + ids.length + " skill(s)");
  // 契约字段：SkillIdList + main_character
  return okShaped(ctx.path, { SkillIdList: ids, main_character: ch, support_character: null });
});

// ==================== character/equip ====================
route("character/equip", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ch = findCharacter(req.characterId);
  const attach = req.attachingEquipmentIdList || [];
  const detach = req.detachingEquipmentIdList || [];
  if (ch) {
    // ★★★ 不再维护 `ch.equipment_id_list`（2026-10-16 移除）★★★
    //   真机契约里**没有任何角色**带这个字段（真机 0/170、本地契约 0/169）——
    //   它是【客户端自己算的索引】（`UserMainCharacterEquipmentIndex.get_EquipmentIdList()`），
    //   不是服务端下发的字段。我此前把它写进角色对象 ⇒ 审计报「键集不符」（MISSING）。
    //   权威归属字段是**装备侧的 `OwnerCharacterId`**（契约实证 57/57 已装备件都有它）
    //   ⇒ 需要「某角色的装备列表」时按 OwnerCharacterId 反查（见 equipIdsOf）。
  }
  // ★★★ 更新装备的持有者 —— 字段名必须是 OwnerCharacterId / OwnerCharacterCategory ★★★
  //
  // 用户报障：「一键脱装无效、自动装备无效」（截图 4/5）。
  //
  // 根因：我改的是 `equipped_character_id` —— 而**真机契约里根本没有这个字段**。
  // 客户端的装备归属字段是两个：
  //   OwnerCharacterId      (string|null) 装备者的 master_character_id
  //   OwnerCharacterCategory(int)         1=主角色 / 2=支援角色
  // 实证（_winr_capture/contracts_winr，1247 件里 57 件已装备）：
  //   {Id:3884920937, MasterEquipmentId:"Item_Equipment_SSR_0104",
  //    OwnerCharacterCategory:1, OwnerCharacterId:"Ch016802106", ...}
  // 而我写入的 equipped_character_id 客户端**不读** → 装备界面认为「什么都没变」
  //   → 一键脱装/自动装备看起来「无效」。
  //
  // ★ 服务端日志实证（17:11:20 用户点一键脱装的那次）：
  //   POST character/equip {"characterId":"Ch000100101",
  //                         "attachingEquipmentIdList":null,      ← AllDetach 传 null
  //                         "detachingEquipmentIdList":[200000354]}
  //   请求发出且服务端 200 —— 所以问题不在「没请求」，而在「改了客户端不看的字段」。
  //   （AllDetach 反编译：EquipmentUseCase.AllDetach → ExchangeAsync(charId, NULL, detachList)）
  const catOf = function (cid) {
    return (s.CharacterList.supportCharacterList || []).some(function (x) { return x.master_character_id === cid; }) ? 2 : 1;
  };
  for (const e of (s.ItemList.EquipmentList || [])) {
    if (attach.indexOf(e.Id) >= 0) {
      e.OwnerCharacterId = req.characterId;
      e.OwnerCharacterCategory = catOf(req.characterId);
    }
    if (detach.indexOf(e.Id) >= 0) {
      e.OwnerCharacterId = null;
      e.OwnerCharacterCategory = 0;
    }
  }
  touchEquipment(ch && ch.Id);
  markDirty();
  console.log("[char] equip " + req.characterId + " +" + attach.length + " -" + detach.length);
  // 契约字段：invalidated_character_list / attachingEquipmentList /
  //           detachingEquipmentList / change_equipment_data_list
  const eqList = s.ItemList.EquipmentList || [];
  const attaching = attach.map(function (id) { return eqList.find(function (e) { return String(e.Id) === String(id); }); }).filter(Boolean);
  const detaching = detach.map(function (id) { return eqList.find(function (e) { return String(e.Id) === String(id); }); }).filter(Boolean);
  return okShaped(ctx.path, {
    invalidated_character_list: ch ? [ch] : [],
    attachingEquipmentList: attaching,
    detachingEquipmentList: detaching,
    // ★ change_equipment_data_list = [{main_character_id, equipment_id_list}]
    //   —— 该角色【本次装备变更后】的完整装备槽位列表（契约实证）。
    //   早期恒为空数组 → 客户端不知角色的装备变化，装备界面不刷新。
    change_equipment_data_list: ch ? [{
      main_character_id: req.characterId,
      equipment_id_list: equipIdsOf(s, ch.master_character_id),   // ★ 按 OwnerCharacterId 反查
    }] : [],
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

// ==================== class_up/level_up ====================
// ★★ 职业突破（ClassUp）—— 权威数据链（三条表）：
//   ClassUp/ClassUpCost.csv   ：CostID → CostTagList（形如 "TAGx100\nTAGx10..."）+ CostGold
//   ClassUp/ClassUpCostTag.csv：CostTag → (SheetType, ItemId, CostTagCount)
//   契约实证：响应 player_all_asset.AllItemList 有 6 项 MasterClassUp 材料与 Board 材料
//   ⇒ 该端点是【消耗材料】的写操作，必须真扣（早期只 +1 class_level，不扣材料 →
//     AllItemList 恒空，玩家看不到材料被消耗）。
//   CostID 的推导：由角色单位类型 + 目标等级组成，形如 Main_<UnitType>_<N>。
//   无匹配时退化为只用 CostGold，绝不编造材料。
function classUpCostFor(masterCharacterId, targetLevel) {
  const costTbl = loadTable("ClassUp/ClassUpCost.csv");
  const tagTbl = loadTable("ClassUp/ClassUpCostTag.csv");
  const lvTbl2 = loadTable("ClassUp/ClassUpLevelParameter.csv");
  if (!costTbl || !tagTbl) return null;
  // ★ CostID 的权威推导必须查 ClassUp/ClassUpLevelParameter.csv：
  //     字段 (CharacterType, SoldierType, Level, ClassName, SkillCost, CostID)
  //     例：CharacterType=1, SoldierType=1, Level=1 → CostID="Main_Soldier_1"（マスターソルジャーⅠ）
  //   ★ 我第一版按「DefaultUnitType 数字」拼 "_1_" 去匹配 —— 错的：
  //     CostID 里用的是【兵种名】(Soldier/Lancer/Rider/Saint/Shooter/Wing/Dark/…)，不是数字。
  //   角色→(CharacterType, SoldierType)：Character.csv 的 DefaultUnitType(角色类型=CharacterType)
  //     与默认兵种；本实现用 unitTypeOf 取 CharacterType，SoldierType 取 ClassUpLevelParameter 里
  //     该 CharacterType 下 Level 匹配的第一条（多数角色只有一个兵种分支）。
  const ctype = unitTypeOf(masterCharacterId);
  const rows2 = (lvTbl2 && lvTbl2.rows) || [];
  let hit2 = rows2.find(function (r) {
    return Number(r.CharacterType) === Number(ctype) && Number(r.Level) === Number(targetLevel);
  });
  if (!hit2) hit2 = rows2.find(function (r) { return Number(r.Level) === Number(targetLevel); });
  const costId = hit2 && hit2.CostID;
  const hit = (costTbl.rows || []).find(function (r) { return String(r.CostID) === String(costId); });
  if (!hit) return null;
  const out = [];
  for (const seg of String(hit.CostTagList || "").split(/[\r\n]+/)) {
    const m = seg.trim().match(/^(.+?)x(\d+)$/);
    if (!m) continue;
    const tag = (tagTbl.rows || []).find(function (t) { return String(t.CostTag) === m[1]; });
    if (!tag || !tag.ItemId) continue;
    out.push({ sheet_type: Number(tag.SheetType) || 1, master_id: tag.ItemId, amount: Number(m[2]) * (Number(tag.CostTagCount) || 1) });
  }
  const gold = Number(hit.CostGold) || 0;
  if (gold) out.push({ sheet_type: 1, master_id: "Item_Currency_Gold", amount: gold });
  return out;
}

// ★★★ 临时实验开关（2026-10-22，用户同意）★★★
// 验证「class up 响应里的 main_character 是否会把 CharacterAccessor 刷成"无 link"版本」。
// true=实验（不回 main_character）；false=正常。确认后改回 false。
const CLASS_UP_BARE_EXPERIMENT = false;   // 实验结束：真因是 player_all_asset 缺支援（见 state.mjs touchedPlayerAssets）

route("class_up/level_up", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ch = findCharacter(req.master_character_id);
  if (!ch) {
    console.log("[class_up] 角色不存在 " + req.master_character_id);
    return okShaped(ctx.path, { main_character: null, support_character: null, player_all_asset: touchedPlayerAssets(), MissionProgressList: [], limited_mission_progress_list: [] });
  }
  const before = Number(ch.class_level) || 0;
  const after = before + 1;
  // 真扣材料（权威表）
  const cost = classUpCostFor(ch.master_character_id, after);
  // ★★★ 材料校验（2026-10-17）：不足则拒绝，不改等级 ★★★
  if (cost && cost.length) {
    const _chkC = consumeItems(s, cost.map(function (c) { return [c.master_id, c.amount]; }));
    if (!_chkC.ok) {
      console.log("[class_up] level_up 材料不足: " + _chkC.id + " need=" + _chkC.need + " have=" + _chkC.have);
      return okShaped(ctx.path, { main_character: ch, support_character: linkedSupportOfMain(s, ch.master_character_id), player_all_asset: touchedPlayerAssets(), MissionProgressList: [], limited_mission_progress_list: [] });
    }
  }
  ch.class_level = after;
  // ★ 2026-10-22：class up 的「技能费用」按 ClassUpLevelParameter.SkillCost 增加
  //   （主角 Level1 +1，之后 +0；支援恒 0）→ 上限 6。
  if (isMainCharacter(ch)) {
    const add = classSkillCostFor(ch.master_character_id, after);
    if (add) ch.skill_cost_limit = (Number(ch.skill_cost_limit) || 5) + add;
    console.log("[class_up] " + ch.master_character_id + " skill_cost_limit -> " + ch.skill_cost_limit + " (+" + add + ")");
  }
  touchCharacter(ch.master_character_id);
  const mp = advanceMissions("classUp", 1, {});
  markDirty();
  flushNow();
  console.log("[char] class_up " + ch.master_character_id + " Lv" + before + "→" + after +
    (cost ? " 耗 " + cost.map(function (c) { return c.master_id + "x" + c.amount; }).join("+") : " (无匹配 CostID，未扣材料)"));
  const isMain = (s.CharacterList.mainCharacterList || []).indexOf(ch) >= 0;
  return okShaped(ctx.path, {
    // 实验：不回 main_character（见文件顶部的 CLASS_UP_BARE_EXPERIMENT 说明）
    main_character: CLASS_UP_BARE_EXPERIMENT ? null : (isMain ? ch : null),
    support_character: isMain ? linkedSupportOfMain(s, ch.master_character_id) : ch,
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: mp,
    limited_mission_progress_list: [],
  });
});
route("class_up/level_down", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const ch = findCharacter(req.master_character_id);
  if (ch) { ch.class_level = Math.max(0, (ch.class_level || 1) - 1); markDirty(); touchCharacter(req.master_character_id); }
  // level_down 没有录制样本；按 level_up 的契约形状（main_character/support_character/
  // player_all_asset）返回，另附两个客户端会忽略的任务字段。
  // ★ 改用 okShaped 并补 Mission 列表（2026-10-17 键集核对）：
  //   骨架（客户端类声明）要求 MissionProgressList + limited_mission_progress_list，
  //   而 ok() 只回 3 个键 ⇒ 客户端读不到任务回执。
  return okShaped(ctx.path, {
    // 主角变动 → 连带回传它的 link 支援（见 state.mjs 的说明：support 界面的 link 就是这么保住的）
    main_character: ch,
    support_character: linkedSupportOfMain(s, ch.master_character_id),
    player_all_asset: touchedPlayerAssets(),
    MissionProgressList: [],
    limited_mission_progress_list: [],
  });
});

console.log("[routes-char] 角色养成接口已注册（按入参）");