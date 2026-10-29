// 扭蛋引擎 v2：按【池子定义】抽取，不同池子内容不同。
//
// 依据（客户端声明的结构 + MasterData 实测）：
//   MasterTemporaryGacha_FirstTable { gacha_type, sheet_type, reward_item_id, count, first_table_id }
//   MasterTemporaryGacha_FirstSelectPickGachaTable { gacha_type, sheet_type, reward_item_id, count, first_table_id, lottery_type }
//
// 实测结论（401 个抽取池）：
//   · 400 个是【纯角色池】—— 只出角色
//   · 仅 1 个（Other_Normal1，好友币池）含武器/防具/道具
//   · gacha_type=3 的是【自选池】，走 first_select_pick_table，用 select_pick_character_list 的角色
//
// 池内条目 sheet_type=3 表示 reward_item_id 是个"子表名"（Second_*），该子表的定义不在
// 我们手上的 master data 里（只有引用没有定义）。因此按其【命名语义】还原内容类型：
//   Second_Other_Normal_SSR_MAIN     -> SSR 主角角色
//   Second_Other_Normal_SR_WEAPON    -> SR 武器（装备）
//   Second_Other_Normal_R_ARMOR      -> R 防具（装备）
//   Second_Other_Normal_N_ITEM       -> N 道具
// 再在该类型的候选集合里按稀有度加权抽取。这样每个池子只会出它该出的东西。
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { getState, selectPickIds, selectPickResetCount } from "./state.mjs";
import { loadTable } from "./masterdata.mjs";
import { patchedMasterGacha, isPickupGroup } from "./gacha_pickup.mjs";

const HERE = path.dirname(process.argv[1] || ".");
const MASTER_FILE = "game_data/capture/by_endpoint/master_load_master_data.json";

let masterGacha = null;
function ensureMaster() {
  if (masterGacha) return masterGacha;
  try {
    // 2026-10-22：改走 gacha_pickup.mjs 的「打补丁版」（自选 PICKUP 池改造）。
    // 与 master/load_master_data 下发的是【同一份对象】，否则会出现
    // 「客户端显示可选、服务端抽取按原池」的错位。
    masterGacha = patchedMasterGacha();
    console.log("[gacha] master_gacha loaded (patched)");
  } catch (e) { console.error("[gacha] load failed: " + e.message); masterGacha = {}; }
  return masterGacha;
}

// ---------- 候选集合（按内容类型）----------
let chars = null, equips = null, mats = null;
function ensurePools() {
  if (chars) return;
  chars = []; equips = []; mats = [];
  try {
    const ct = loadTable("Character/Character.csv");
    for (const r of ct.rows) {
      const id = r.CharacterID;
      if (!id) continue;
      // 可抽角色的完整判据：
      //   1) 纯 Ch + 9 位数字（排除 ex/nxn/main/guild 等变体）
      //   2) Rarity > 0（Rarity=0 是敌人）
      //   3) 有立绘 StandResourceID
      //   4) 【必须有技能】—— 契约要求 MainCharacterSkill[0].master_skill_id 为字符串；
      //      池子里有 40 个角色（多为 Ch9xxxxxx「コマ劇用」等活动变体）在两个技能
      //      来源里都没有技能，抽到会让该字段变 null。
      if (!/^Ch\d{9}$/.test(id)) continue;
      const rarity = Number(r.Rarity) || 0;
      if (rarity <= 0 || !r.StandResourceID) continue;
      if (!skillIdForPool(id)) continue;
      const support = Number(r.SupportType) > 0;
      chars.push({ id: id, rarity: rarity, support: support });
    }
  } catch (e) { console.error("[gacha] chars failed: " + e.message); }
  try {
    const et = loadTable("Item/EquipmentList.csv");
    const it = loadTable("Item/ItemList.csv");
    const rar = new Map((it ? it.rows : []).map(function (r) { return [r.ItemId, Number(r.Rarity) || 1]; }));
    for (const r of (et ? et.rows : [])) {
      const id = r.ItemId;
      if (!id) continue;
      const t = Number(r.PartsType) || 0;   // 1=武器 2=防具 之类
      equips.push({ id: id, rarity: rar.get(id) || 1, partsType: t });
    }
  } catch (e) { console.error("[gacha] equips failed: " + e.message); }
  try {
    const it = loadTable("Item/ItemList.csv");
    for (const r of (it ? it.rows : [])) {
      const id = r.ItemId;
      if (!id || /_Equipment_/.test(id)) continue;
      mats.push({ id: id, rarity: Number(r.Rarity) || 1 });
    }
  } catch (e) { console.error("[gacha] mats failed: " + e.message); }
  console.log("[gacha] pools: " + chars.length + " chars, " + equips.length + " equips, " + mats.length + " items");
}

/**
 * 从池子描述解析「確定」保证。
 * 实测 51 个池带保证（如「1日1回SSR1体確定の無料10連ガチャ！」），
 * 早期实现是纯随机加权，可能 10 连一个 SSR 都不出 —— 客户端拿到与卡池承诺
 * 不符的结果会报通信错误。
 */
function guaranteeOf(groupId) {
  const mg = ensureMaster();
  const g = (mg.gacha_group || []).find(function (x) { return x.gacha_group_id === groupId; });
  if (!g) return null;
  const d = String(g.description || "").replace(/@@@|<[^>]+>/g, "");
  // 十连内 SSR 至少 N 体
  let m = d.match(/(\d+)体の内\s*(SSR|SR)(以上)?\s*(\d+)?体確定/);
  if (m) return { rarity: m[2], above: !!m[3], count: Number(m[4] || 1), within: Number(m[1]) };
  // SSR 1 体確定 / SSR10体確定 / SR1体確定
  m = d.match(/(SSR|SR|R)(\d+)?体確定/);
  if (m) return { rarity: m[1], above: false, count: Number(m[2] || 1), within: null };
  // 「10回引く」で SR 以上 1 体確定
  m = d.match(/(SSR|SR)(以上)?\s*(\d+)?体確定/);
  if (m) return { rarity: m[1], above: !!m[2], count: Number(m[3] || 1), within: null };
  return null;
}

/** 从 first_table_id 反推 gacha_group_id（First_SelectPick00233_01 -> SelectPick00233）。 */
function groupOfTableId(tableId) {
  if (!tableId) return null;
  const mg = ensureMaster();
  const id = String(tableId).replace(/^First_/, "").replace(/_\d+$/, "");
  if ((mg.gacha_group || []).some(function (x) { return x.gacha_group_id === id; })) return id;
  return null;
}

/** 从池子定义推断组 ID（供 guaranteeOf 查描述）。 */
function groupOfGacha(gachaId) {
  const mg = ensureMaster();
  const s = (mg.gacha_group_setting || []).find(function (x) { return x.gacha_id === gachaId; });
  return s ? s.gacha_group_id : null;
}

// 技能来源表（惰性加载）。
//   Character.csv.InitialSkillId  —— 主角色
//   TrainingBoard/SkillSetting.csv —— 覆盖支援角色（41xxxxx）
let skillCharSet = null;
function skillIdForPool(masterCharacterId) {
  if (!skillCharSet) {
    skillCharSet = new Set();
    try {
      const ct = loadTable("Character/Character.csv");
      for (const r of ct.rows) if (r.InitialSkillId) skillCharSet.add(r.CharacterID);
    } catch (e) {}
    try {
      const sk = loadTable("TrainingBoard/SkillSetting.csv");
      for (const r of sk.rows) if (r.SkillGroupID) skillCharSet.add(r.CharacterID);
    } catch (e) {}
  }
  return skillCharSet.has(masterCharacterId);
}

/** 从 Second_* 名字解析内容类型。 */
function kindOf(secondName) {
  const n = String(secondName).toUpperCase();
  const rarity = (n.match(/_(SSR|SR|R|N)_/) || [])[1] || "R";
  // 【必须允许数字后缀】`first_basic_table.reward_item_id` 有两种形态：
  //   Second_Other_Premium_SSR_MAIN      （无后缀）
  //   Second_Other_Premium_SSR_MAIN3     （带序号，实测 688 条 / 91 个唯一值，涉及 351 个池）
  // 早期写成 /_MAIN$/（行尾锚定），带序号的全部匹配失败 → 落到默认 "ITEM" →
  // 于是纯角色池也会产出非角色物品（如 Item_Ticket_Gold_EX）。
  // 改为 /_(...)d*$/ 后，两种形态都能正确归类。
  // ★★★ 第三种形态：**下划线分隔的数字后缀**（2026-10-14 随 5.0.0 新池子发现）★★★
  //
  // 真实数据的三种形态（按出现次数）：
  //   Second_Other_Premium_SSR_MAIN          (1021 条，无后缀)
  //   Second_Other_Premium_SSR_MAIN3         (350 条，紧跟数字)
  //   Second_Select_Pick_Default_SSR_MAIN_118 (154 条，★ 下划线+数字)
  // 我此前的正则只覆盖前两种 → 第三种落到默认值 "CHARACTER"，
  // 于是自选池的 SSR 角色被当成泛角色处理（丢失 MAIN/SUPPORT 的区分）。
  // 这条是被 5.0.0 的新池子 SelectPick00234 暴露出来的
  // （它的 Second_ 名全是 `_MAIN_118` / `_SUPPORT_118` 形态）。
  //
  // 修法：允许「可选下划线 + 数字」的后缀 —— (?:_?\d+)?$
  let kind = "CHARACTER";
  if (/_MAIN(?:_?\d+)?$/.test(n)) kind = "MAIN";
  else if (/_SUPPORT(?:_?\d+)?$/.test(n)) kind = "SUPPORT";
  else if (/_WEAPON(?:_?\d+)?$/.test(n)) kind = "WEAPON";
  else if (/_ARMOR(?:_?\d+)?$/.test(n)) kind = "ARMOR";
  else if (/_ITEM(?:_?\d+)?$/.test(n)) kind = "ITEM";
  return { rarity: rarity, kind: kind };
}

// Character.csv 的 Rarity 编码：2=R, 3=SR, 4=SSR, 6=(特典/最高)。
const RARITY_NUM = { N: 1, R: 2, SR: 3, SSR: 4 };

/** 按类型与稀有度抽一个。 */
function pickBy(kind, rarityName) {
  ensurePools();
  const want = RARITY_NUM[rarityName] || 2;
  let src;
  if (kind === "MAIN" || kind === "SUPPORT") src = chars.filter(function (c) { return kind === "MAIN" ? !c.support : c.support; });
  else if (kind === "WEAPON" || kind === "ARMOR") src = equips;
  else if (kind === "ITEM") src = mats;
  // CHARACTER（默认，含直接给出 ChXXXX 主数据 id 的条目）→ 从角色池取。
  else src = chars;
  if (!src.length) src = chars;   // 兜底：至少给角色（纯角色池绝不产出物品）
  if (!src.length) return null;
  // 优先同稀有度，其次邻近
  let cand = src.filter(function (x) { return x.rarity === want; });
  if (!cand.length) cand = src.filter(function (x) { return Math.abs(x.rarity - want) <= 1; });
  if (!cand.length) cand = src;
  const p = cand[Math.floor(Math.random() * cand.length)];
  const isChar = (kind === "MAIN" || kind === "SUPPORT" || kind === "CHARACTER");
  const isEquip = (kind === "WEAPON" || kind === "ARMOR");
  return { SheetType: isChar ? 2 : 1, ItemId: p.id, _isEquip: isEquip };
}

/**
 * 抽 n 次。
 * 按池子的 first_basic_table / first_select_pick_table 定义决定能出什么。
 */
export function roll(gachaId, buttonId, n) {
  const __t0 = Date.now();
  const mg = ensureMaster();
  const emissions = [];
  // 找到该 gacha_id 的池定义
  const base = (mg.gacha_base_info || []).find(function (x) { return x.gacha_id === gachaId; });
  const tableId = base ? base.first_table_id : null;
  // 本池的 PICK UP 角色集合 —— 用于输出 IsContainsPickUpCharacter
  // （契约的 TemporaryGachaEmissions.IsContainsPickUpCharacter，语义是
  //  「本次抽卡结果中是否包含 PICK UP 角色」）。
  // 普通池：first_basic_table 里 is_pickup=true 的条目；
  // 自选池：select_pick_character_list 里该 group 的角色。
  const pickupSet = (function () {
    const out = new Set();
    try {
      for (const e of (mg.first_basic_table || [])) {
        if (e.first_table_id === tableId && e.is_pickup && e.reward_item_id) out.add(e.reward_item_id);
      }
      const gid = groupOfFirstTableId(tableId) || String(tableId || "").replace(/^First_/, "").replace(/_\d+$/, "");
      if (isPickupGroup(gid)) {
        // 2026-10-22：可选 PICKUP 池 —— PICK UP = 玩家选的那 2 个，不是全部候选。
        for (const id of selectedPickup(tableId)) out.add(id);
      } else if (!out.size) {
        for (const s of (mg.select_pick_character_list || [])) {
          if (String(s.gacha_group_id) === gid && s.reward_item_id) out.add(s.reward_item_id);
        }
      }
    } catch (e) { }
    return out;
  })();
  let entries = tableId ? (mg.first_basic_table || []).filter(function (x) { return x.first_table_id === tableId; }) : [];
  if (!entries.length && tableId) {
    // 自选池走 first_select_pick_table
    const sp = (mg.first_select_pick_table || []).filter(function (x) { return x.first_table_id === tableId; });
    if (sp.length) {
      // 自选池（gacha_type=3）。
      // 关键：select_pick_character_list 只列【12 个可自选的 PICK-UP 角色】（全是 SSR），
      // 它是「确定获得」的目标，不是整个池子。整个池子由 first_select_pick_table 的
      // reward_item_id（Second_Select_Pick_Default_{SSR,SR,R}_{MAIN,SUPPORT}）定义。
      // 早期直接用 12 个 SSR 角色当池子 → 100% 出 SSR，与真实概率完全不符。
      const groupId2 = groupOfTableId(tableId);
      // ★★★ 必须用【玩家实际选的 2 个】角色，不是全部候选（2026-10-14 修）★★★
      //
      // 数据来源辨析（两张表容易混）：
      //   · select_pick_character_list   = 该池【全部 11 个可选候选】（供界面列出让玩家挑）
      //   · state.UserAssetSelectPickCharacterList = 玩家【已选定】的角色（每角色一条）
      // 我此前用前者当 pickup 池 → 11 个候选等概率 → 每个 pickup 概率被摊薄到 1/11，
      //   实测 pickup 只占 0.50%，而真机语义是「选定的 2 个角色共享 pickup 档 6%」→ 各约 3%。
      // ⇒ 收口到 selectedPickup()（它读 state 并做了历史脏数据兼容）。
      //   若玩家尚未选择，则回退到全部候选（保持「未选也能抽」的可用性）。
      const chosen = selectedPickup(tableId);
      const picked = chosen.length ? chosen : (groupId2 ? (mg.select_pick_character_list || [])
        .filter(function (x) { return x.gacha_group_id === groupId2; })
        .map(function (x) { return x.reward_item_id; }) : []);
      // 池条目按 lottery_type 分组抽（1/2/3 三阶段），按稀有度权重
      const GW = { SSR: 5, SR: 25, R: 70, N: 100 };
      const kindsOf = function (rows) {
        const m2 = new Map();
        for (const r of rows) {
          if (!r.reward_item_id) continue;
          const k = kindOf(r.reward_item_id);
          const key = k.kind + "|" + k.rarity;
          m2.set(key, (m2.get(key) || 0) + 1);
        }
        return [...m2.entries()].map(function (e) {
          const parts = e[0].split("|");
          return { kind: parts[0], rarity: parts[1], n: e[1] };
        });
      };
      const byLottery = new Map();
      for (const r of sp) {
        if (!byLottery.has(r.lottery_type)) byLottery.set(r.lottery_type, []);
        byLottery.get(r.lottery_type).push(r);
      }
      const stages = [...byLottery.values()].map(kindsOf).filter(function (x) { return x.length; });
      const flat = stages.length ? stages : [kindsOf(sp)];
      for (let i = 0; i < n; i++) {
        const stage = flat[i % flat.length];
        let tot = 0;
        for (const s of stage) tot += (GW[s.rarity] || 20) * s.n;
        let p = Math.random() * tot;
        let chosenK = stage[stage.length - 1];
        for (const s of stage) { p -= (GW[s.rarity] || 20) * s.n; if (p <= 0) { chosenK = s; break; } }
        // 若抽到 SSR 且本池有自选角色，就从自选角色里出（体现「自选」）；否则按类型取
        if (chosenK.rarity === "SSR" && picked.length) {
          const id = picked[Math.floor(Math.random() * picked.length)];
          emissions.push({ SheetType: 2, ItemId: id, Value: 1, IsNew: false, EquipmentUserAssetId: null });
        } else {
          const got = pickBy(chosenK.kind, chosenK.rarity);
          if (got) emissions.push({ SheetType: got.SheetType, ItemId: got.ItemId, Value: 1, IsNew: false, EquipmentUserAssetId: null });
        }
      }
      return { GachaEmisions: { GachaEmissions: stripInternalEmissions(emissions, pickupSet), IsContainsPickUpCharacter: containsPickUp(emissions, pickupSet) }, poolKind: "select-pick" };
    }
  }
  if (!entries.length) {
    console.log("[gacha] " + gachaId + ": no pool definition, fallback to characters");
    ensurePools();
    for (let i = 0; i < n; i++) {
      const p = chars[Math.floor(Math.random() * chars.length)];
      if (p) emissions.push({ SheetType: 2, ItemId: p.id, Value: 1, IsNew: false, EquipmentUserAssetId: null });
    }
    return { GachaEmisions: { GachaEmissions: stripInternalEmissions(emissions, pickupSet), IsContainsPickUpCharacter: containsPickUp(emissions, pickupSet) }, poolKind: "fallback" };
  }
  // ★ 2026-10-23：改用【官方提供割合表】决定稀有度（此前的 W 权重按“条目数”累加，
  //   池里 SSR 条目动辄上百条 → SSR 实际被放大到 30~60%，与官方 4% 完全不符）。
  const RARNUM = { N: 1, R: 2, SR: 3, SSR: 4 };
  const ratioRows = (mg.providing_ratio_display_parts || []).filter(function (x) { return x.first_table_id === tableId; });
  const ratioByRar = new Map();
  for (const r of ratioRows) {
    const w = (Number(r.main_providing_ratio) || 0) + (Number(r.support_providing_ratio) || 0)
            + (Number(r.equipment_providing_ratio) || 0) + (Number(r.item_providing_ratio) || 0);
    if (w <= 0) continue;
    const key = String(Number(r.rarity_type) || 0);
    ratioByRar.set(key, (ratioByRar.get(key) || 0) + w);
  }
  const ratioTotal = [...ratioByRar.values()].reduce(function (a, b) { return a + b; }, 0);
  const entriesByRar = new Map();
  for (const e of entries) {
    const k = kindOf(e.reward_item_id);
    const key = String(RARNUM[k.rarity] || 0);
    if (!entriesByRar.has(key)) entriesByRar.set(key, []);
    entriesByRar.get(key).push(e);
  }
  const W = { SSR: 5, SR: 25, R: 70, N: 100 };
  let total = 0;
  for (const e of entries) { const k = kindOf(e.reward_item_id); total += W[k.rarity] || 20; }
  // 可选 PICKUP：被 gacha_pickup.json 配成自选池的普通池，SSR 档改出玩家选的 2 个角色
  const gidPick = groupOfGacha(gachaId);
  const pickSel = (gidPick && isPickupGroup(gidPick)) ? selectedPickup(tableId) : [];
  if (gidPick && isPickupGroup(gidPick)) console.log("[gacha] pickup roll " + gidPick + " picks=" + pickSel.length + " (" + pickSel.join(",") + ")");
  for (let i = 0; i < n; i++) {
    let chosen = entries[entries.length - 1];
    if (ratioTotal > 0) {
      // 按官方稀有度百分比抽，再在该稀有度里随机取一条
      let pick = Math.random() * ratioTotal;
      let wantRar = null;
      for (const [rarKey, w] of ratioByRar) { pick -= w; if (pick <= 0) { wantRar = rarKey; break; } }
      const pool2 = entriesByRar.get(String(wantRar)) || [];
      if (pool2.length) chosen = pool2[Math.floor(Math.random() * pool2.length)];
      else {
        let pick2 = Math.random() * total;
        for (const e of entries) { const kk = kindOf(e.reward_item_id); pick2 -= W[kk.rarity] || 20; if (pick2 <= 0) { chosen = e; break; } }
      }
    } else {
      let pick = Math.random() * total;
      for (const e of entries) { const kk = kindOf(e.reward_item_id); pick -= W[kk.rarity] || 20; if (pick <= 0) { chosen = e; break; } }
    }
    const k = kindOf(chosen.reward_item_id);
    if (pickSel.length && k.rarity === "SSR" && (k.kind === "MAIN" || k.kind === "SUPPORT" || k.kind === "CHARACTER")) {
      const id2 = pickSel[Math.floor(Math.random() * pickSel.length)];
      emissions.push({ SheetType: 2, ItemId: id2, Value: 1, IsNew: false, EquipmentUserAssetId: null });
      continue;
    }
    const got = pickBy(k.kind, k.rarity);
    if (!got) continue;
    emissions.push({ SheetType: got.SheetType, ItemId: got.ItemId, Value: 1, IsNew: false, EquipmentUserAssetId: null, _isEquip: got._isEquip });
  }
  // ---- 兑现「確定」保证 ----
  // 若本次结果不满足卡池承诺，替换其中一条为承诺的稀有度。
  const gid2 = groupOfGacha(gachaId);
  const gq = (n >= 10) ? (gid2 ? guaranteeOf(gid2) : null) : null;   // ★ 单抽不触发“確定”保证
  if (gq) {
    const RAR_NUM = { N: 1, R: 2, SR: 3, SSR: 4 };
    const want = RAR_NUM[gq.rarity] || 3;
    // SSR 判定用「>= 4」而非「=== 4」—— Rarity 6 是更高稀有度，也算 SSR 以上。
    const ok = function (e) {
      const c = chars.find(function (x) { return x.id === e.ItemId; });
      const r = c ? c.rarity : 0;
      if (gq.above) return r >= want;
      return want === 4 ? r >= 4 : r === want;
    };
    let have = emissions.filter(ok).length;
    if (have < gq.count) {
      // 找同稀有度的候选角色补足
      const cand = chars.filter(function (c) { return gq.above ? c.rarity >= want : (want === 4 ? c.rarity >= 4 : c.rarity === want); });
      // 可选 PICKUP 池：確定枠优先给玩家选的角色
      const pickObjs = pickSel.map(function (id) { return chars.find(function (c) { return c.id === id; }) || { id: id, rarity: want, support: false }; });
      const pool2 = pickObjs.length ? pickObjs : (cand.length ? cand : chars);
      for (let k = have; k < gq.count && emissions.length; k++) {
        const pick = pool2[Math.floor(Math.random() * pool2.length)];
        if (!pick) break;
        // 替换最后一条角色型 emission（保留装备/道具条目的多样性）
        let idx2 = -1;
        for (let z = emissions.length - 1; z >= 0; z--) { if (emissions[z].SheetType === 2) { idx2 = z; break; } }
        if (idx2 < 0) idx2 = emissions.length - 1;
        emissions[idx2] = { SheetType: 2, ItemId: pick.id, Value: 1, IsNew: false, EquipmentUserAssetId: null };
      }
      console.log("[gacha] guarantee applied: " + gq.rarity + (gq.above ? "+" : "") + " x" + gq.count + " for " + gid2);
    }
  }
  return { GachaEmisions: { GachaEmissions: stripInternalEmissions(emissions, pickupSet), IsContainsPickUpCharacter: containsPickUp(emissions, pickupSet) }, poolKind: "basic" };
}

/** 自选角色候选（该组 select_pick_character_list）。 */
export function selectableCharacters(groupId) {
  const mg = ensureMaster();
  const list = (mg.select_pick_character_list || []).filter(function (x) { return x.gacha_group_id === groupId; }).map(function (x) { return x.reward_item_id; });
  if (list.length) return list;
  ensurePools();
  return chars.slice(0, 12).map(function (c) { return c.id; });
}

/**
 * 本次抽卡的消耗。
 * 依据：①卡池是否 is_free（免费池不扣）②gacha_button_setting 的 price（真实定价）。
 * 早期硬编码 300/回，导致 Sp00039 这种「無料ガチャ」也被扣了 3000 石。
 * 返回 { cost, free } —— free=true 表示不扣任何货币。
 */
export function costFor(gachaId, buttonId, n) {
  const mg = ensureMaster();
  // 该 gacha 属于哪个组，组是否免费
  const setting = (mg.gacha_group_setting || []).find(function (x) { return x.gacha_id === gachaId; });
  const group = setting ? (mg.gacha_group || []).find(function (x) { return x.gacha_group_id === setting.gacha_group_id; }) : null;
  if (group && group.is_free) return { cost: 0, free: true, currency: null };
  // 按钮定价。注意 price.amount 是【该按钮整次抽取的总价】（roll_number 回），
  // 不是每回价格 —— 早期乘以 n 导致 10 连扣了 30000 而非 3000。
  const btn = (mg.gacha_button_setting || []).find(function (x) { return x.button_id === buttonId; });
  if (btn && btn.price && btn.price.master_id) {
    const amount = Number(btn.price.amount) || 0;
    if (amount === 0) return { cost: 0, free: true, currency: null };
    return { cost: amount, free: false, currency: btn.price.master_id };
  }
  // 兜底：1 回 300 石
  return { cost: 300 * n, free: false, currency: "Item_Stone_Free" };
}

/** 额外赠送（BonusList）。 */
export function bonusFor(gachaId, buttonId) {
  const mg = ensureMaster();
  const rows = (mg.gacha_detail_info || []).filter(function (x) { return x.gacha_id === gachaId; });
  if (!rows.length) return [];
  const row = (buttonId ? rows.find(function (x) { return x.button_setting === buttonId; }) : null) || rows[0];
  const b = row.bonus_reward;
  if (!Array.isArray(b)) return [];
  return b.map(function (x) { return { sheet_type: x.sheet_type, master_id: x.master_id, amount: x.amount }; });
}

/** 暴露 master_gacha（供路由构建 gacha/list 用）。 */
export function getMasterGacha() { return ensureMaster(); }

/**
 * 构建 gacha/list 的 UserAssetGachaGroupList。
 * 形状（来自录制契约）：
 *   { gachaGroupId, lastGachaId, gachaList:[{ gachaId, appearNumber,
 *       buttonList:[{ buttonId, totalCount, dailyCount, lastUpdateTime }] }],
 *     selectPickResetCount }
 */
export function gachaGroups(counterFn) {
  const mg = ensureMaster();
  const settings = mg.gacha_group_setting || [];
  const detail = mg.gacha_detail_info || [];
  const out = [];
  for (const st of settings) {
    const gid = st.gacha_group_id;
    const gachaId = st.gacha_id;
    // 该池有哪些按钮
    const rows = detail.filter(function (x) { return x.gacha_id === gachaId; });
    const buttons = [];
    for (const r of rows) {
      if (!r.button_setting) continue;
      const c = counterFn ? counterFn(gid, gachaId, r.button_setting) : { totalCount: 0, dailyCount: 0 };
      buttons.push({
        buttonId: r.button_setting,
        totalCount: c.totalCount || 0,
        dailyCount: c.dailyCount || 0,
        lastUpdateTime: Math.floor(Date.now() / 1000),
      });
    }
    if (!buttons.length) continue;
    out.push({
      gachaGroupId: gid,
      lastGachaId: gachaId,
      gachaList: [{ gachaId: gachaId, appearNumber: st.appear_number || 1, buttonList: buttons }],
      // 2026-10-22：真实重置次数（原来恒 0，客户端「変更」剩余次数显示不对）
      selectPickResetCount: (function () { try { return selectPickResetCount(getState(), gid); } catch (e) { return 0; } })(),
    });
  }
  return out;
}

console.log("[gacha] module ready");

/**
 * 剥掉 emission 上的内部辅助字段（_isEquip / _pickup）。
 *
 * 【为什么必须做】契约的 TemporaryGachaEmission 只有 5 个字段：
 *   SheetType / ItemId / Value / IsNew / EquipmentUserAssetId
 * 我在内部用 _isEquip、_pickup 做分类判断，若直接回传就会多出未知字段 ——
 * 客户端虽然通常忽略未知字段，但多字段会污染契约比对，且没有理由让它们出现在线上响应里。
 */
function stripInternalEmissions(emissions, pickupSet) {
  const out = [];
  for (const e of emissions || []) {
    out.push({
      SheetType: e.SheetType,
      ItemId: e.ItemId,
      Value: e.Value,
      IsNew: !!e.IsNew,
      EquipmentUserAssetId: e.EquipmentUserAssetId === undefined ? null : e.EquipmentUserAssetId,
    });
  }
  return out;
}
/**
 * 本次抽卡结果里是否包含 PICK UP 角色。
 *
 * 【为什么单独一个函数】最初写成 `IsContainsPickUpCharacter: emissions.some(x => x._pickup)`，
 * 而 `_pickup` 是在 `stripInternalEmissions()` 内部才赋值的 —— 参数求值顺序上
 * `some()` 先于 `stripInternalEmissions()` 执行，读到的全是 undefined，于是恒为 true。
 * 独立成函数后不依赖任何副作用。
 */
function containsPickUp(emissions, pickupSet) {
  if (!pickupSet || !pickupSet.size) return false;
  for (const e of emissions || []) if (pickupSet.has(e.ItemId)) return true;
  return false;
}

// ==================== 提供割合（load_gacha_providing_ratio_*）====================
//
// 【数据来源与算法（已用真实契约逐条验证）】
//
// ① 总权重：`master_gacha.providing_ratio_display_parts[first_table_id]`
//    每种 (rarity_type, gacha_display_type) 一条，给出该类的总量：
//      main_providing_ratio / support_providing_ratio / equipment_ / item_
//    rarity_type: 4=SSR, 3=SR, 2=R, 1=N
//    gacha_display_type: 1=角色, 4=装备, 5=道具
//
// ② 单条概率 = 该类总量 ÷ 该类条目数，**截断到 5 位小数**（不是四舍五入）。
//    实测验证（普池 first_table_id=First_Other_Premium1_01，167 条）：
//      SSR主 2% ÷ 93 = 0.021505 → 0.02150 ✅
//      SSR辅 2% ÷ 33 = 0.060606 → 0.06060 ✅
//      SR主  11% ÷ 11 = 1.000000 → 1.00000 ✅
//      R主   37% ÷ 10 = 3.700000 → 3.70000 ✅
//      R辅   37% ÷  9 = 4.111111 → 4.11111 ✅
//
// ③ 条目来源：契约的条目集合 = 池内实际角色，按 (Rarity, SupportType) 分层。
//    分层与 gacha_display_parts_type 的对应（实测）：
//      31=SSR主 32=SSR辅 21=SR主 22=SR辅 11=R主 12=R辅
//      23=SR装备 24=SR道具 13=R装备 14=R道具 4=N道具（友情池）
//
// ④ 【已知简化】池内角色的**精确名单**：官方按角色实装日期 + 活动变体规则筛选，
//    该规则未在客户端数据中给出（Second_* 子表不在数据源内）。
//    本实现取「Character.csv 中 Rarity/SupportType 匹配、且非活动变体（纯 Ch+9 位数字）、
//    且有技能」的角色作为候选集 —— 规模与官方同级（不是精确名单）。
//    用户已确认此简化可接受（验收标准：跑通链路 + 体验不离谱）。

/**
 * 池内角色名单。
 *
 * 【为什么用「官方抓取名单」而不是「按规则筛选」】
 * 官方池内容按「角色实装日期 + 活动变体」等规则筛选，但该规则**不在客户端数据里**
 * （Second_* 子表缺失、activateDate 仅 10 个角色有值）。
 * 我已从真服务器抓到 3 个池的官方名单（167/167/104 条），直接采用 ——
 * 这比任何推测规则都可靠，且用户已确认数值不必精确到官方。
 *
 * 兜底：抓不到名单的池，用 Character.csv 按 (Rarity, SupportType) 分层取（规模误差可接受）。
 */
let _officialRatio = null;
function officialRatio() {
  if (_officialRatio) return _officialRatio;
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "gacha-ratio-official.json");
    if (fs.existsSync(p)) { _officialRatio = JSON.parse(fs.readFileSync(p, "utf8")); return _officialRatio; }
  } catch (e) { console.warn("[gacha] 官方名单读取失败: " + e.message); }
  _officialRatio = {};
  return _officialRatio;
}

/** 稀有度 -> 角色集合（按 SupportType 分主/辅）；优先用官方名单。 */
let _ratioChars = null;
function ratioCharacters(tableId) {
  // ① 优先：该池的官方名单
  const off = officialRatio()[tableId];
  if (off && off.length) {
    const out = { main: new Map(), support: new Map() };
    const ct0 = loadTable("Character/Character.csv");
    const byId0 = new Map((ct0 ? ct0.rows : []).map(function (r) { return [r.CharacterID, r]; }));
    for (const it of off) {
      if (it.item_format.sheet_type !== 2) continue;
      const id = it.item_format.master_id;
      const r = byId0.get(id);
      if (!r) continue;
      const rar = Number(r.Rarity);
      const isSup = Number(r.SupportType) !== 0;
      const m = isSup ? out.support : out.main;
      if (!m.has(rar)) m.set(rar, []);
      m.get(rar).push(id);
    }
    return out;
  }
  // ② 兜底：按分层取（无官方名单的池）
  if (_ratioChars) return _ratioChars;
  const ct = loadTable("Character/Character.csv");
  const sk = loadTable("TrainingBoard/SkillSetting.csv");
  const skillIds = new Set((sk ? sk.rows : []).filter(function (r) { return r.SkillGroupID; }).map(function (r) { return r.CharacterID; }));
  const out = { main: new Map(), support: new Map() };
  for (const r of (ct ? ct.rows : [])) {
    const id = r.CharacterID;
    if (!/^Ch\d{9}$/.test(id)) continue;
    const rar = Number(r.Rarity);
    if (!(rar > 0)) continue;
    if (!r.InitialSkillId && !skillIds.has(id)) continue;
    const isSup = Number(r.SupportType) !== 0;
    const m = isSup ? out.support : out.main;
    if (!m.has(rar)) m.set(rar, []);
    m.get(rar).push(id);
  }
  _ratioChars = out;
  return out;
}

/** 截断到 5 位小数（与官方一致，非四舍五入）。 */
function trunc5(n) { return String(Math.floor(n * 100000) / 100000); }

/** 数值格式化为 "x.xxxxx"（补齐 5 位小数）。 */
function fmt5(n) {
  const t = Math.floor(n * 100000) / 100000;
  return t.toFixed(5);
}

/**
 * 生成某池的 providing_ratio_item 列表。
 * @param tableId first_table_id
 * @param kind    "normal"（普池/免费池/友情池）| "select_pick"（UP自选池）
 */
export function providingRatio(tableId, kind) {
  const g = getMasterGacha();
  const prd = g.providing_ratio_display_parts || [];
  const weights = prd.filter(function (x) { return x.first_table_id === tableId; });
  if (!weights.length) return null;   // 权重表无此池 -> 调用方回退
  const chars = ratioCharacters(tableId);
  const items = [];
  const isPick = kind === "select_pick";

  // 该池的 pickup 角色（自选池从 state 取玩家选的，普通池从 first_basic_table.is_pickup 取）
  const pkSet = new Set(selectedPickup(tableId));

  // gacha_display_type=1 的角色类：按 rarity + main/support 分列。
  // 【自选池】权重表有 3 组 LotteryType（MainSupport/MainMain/SupportSupport）x N rarity，
  // 必须**只取一组** —— 取哪组由「玩家选的 2 个 pickup 各是 Main 还是 Support」决定。
  // 若全取会重复 3 倍（实测 501 条 vs 契约 167 条）。
  let charRows = weights.filter(function (x) { return Number(x.gacha_display_type) === 1; });
  if (isPick) {
    const wantLT = pickLotteryType(tableId);
    const filtered = charRows.filter(function (x) { return String(x.LotteryType || "") === wantLT; });
    if (filtered.length) charRows = filtered;
    else { // 找不到指定 LotteryType 时取第一组，避免输出三份
      const first = String(charRows[0] && charRows[0].LotteryType || "");
      charRows = charRows.filter(function (x) { return String(x.LotteryType || "") === first; });
    }
  }
  for (const w of charRows) {
    const rar = Number(w.rarity_type);
    const mainTotal = Number(w.main_providing_ratio) || 0;
    const supTotal = Number(w.support_providing_ratio) || 0;
    // parts 编码：(rarity-1)*10 + 1/2 —— SSR(4)→31/32, SR(3)→21/22, R(2)→11/12
    const partsMain = (rar - 1) * 10 + 1, partsSup = (rar - 1) * 10 + 2;
    // 主角色
    if (mainTotal > 0) {
      const arr = chars.main.get(rar) || [];
      if (arr.length || (isPick && pkSet.size && rar === 4)) {
        // 2026-10-22：pickup 必须【无条件】出现在提供割合里 —— 普通池改造成的自选池，
        // 玩家选的角色可能不在该池的官方名单（arr）里，早期用 pk = arr∩pkSet 会得到空，
        // 于是自选角色在概率表里根本不显示。
        const pkList = [...pkSet];
        const np = arr.filter(function (id) { return !pkSet.has(id); });
        // 【自选池】pickup 单独占用额度，非 pickup 用剩余额度：
        //   实测 MainMain rar=4: main=8.0 → pickup 6%（2人各3%）+ 非pickup 2%（91人各0.02197%）
        //   即：非pickup 额度 = mainTotal - pickupTotal，pickup 额度 = mainTotal × 0.6（仅主列）
        if (isPick && pkList.length && rar === 4) {
          // pickup 额度 = 【基座】× 60%，基座 = mainTotal + supportTotal。
          // 依据（SelectPick00231 MainMain 行）：main=8.0 support=2.0 → 基座 10%
          //   pickup = 10 × 0.6 = 6%（2人各3%）✅ 官方实测
          //   非pickup main = 8 - 6 = 2%（91人各0.02197%）✅ 官方实测
          // 早期用 mainTotal×0.6=4.8 是错的（漏了 support 那一列也属基座）。
          const base = mainTotal + supTotal;
          // ★ 2026-10-22：普通池改造成的自选池，main 只有 2%（= base 2+2 的一半）：
          //   base*0.6 = 2.4 > mainTotal 2 → npTotal 变负数、显示 -0.00440%。
          //   故 pickup 额度上限取 mainTotal（pickup 只能吃掉「主」那一列的份额）。
          const pkTotal = Math.min(mainTotal, base * 0.6);
          const npTotal = Math.max(0, mainTotal - pkTotal);
          const perPk = pkTotal / pkList.length;
          const perNp = np.length ? npTotal / np.length : 0;
          if (npTotal > 0) for (const id of np) items.push(mkItem(rar, partsMain, id, fmt5(perNp), false, isPick));
          for (const id of pkList) items.push(mkItem(rar, partsMain, id, fmt5(perPk), true, isPick));
        } else {
          const per = arr.length ? mainTotal / arr.length : 0;
          const pkIn = arr.filter(function (id) { return pkSet.has(id); });
          for (const id of np) items.push(mkItem(rar, partsMain, id, fmt5(per), false, isPick));
          for (const id of pkIn) items.push(mkItem(rar, partsMain, id, fmt5(per), true, isPick));
        }
      }
    }
    // 支援角色
    if (supTotal > 0) {
      const arr = chars.support.get(rar) || [];
      if (arr.length) {
        const per = supTotal / arr.length;
        for (const id of arr) items.push(mkItem(rar, partsSup, id, fmt5(per), false, isPick));
      }
    }
  }

  // 装备 / 道具（友情池才有）
  for (const w of weights) {
    const dt = Number(w.gacha_display_type);
    if (dt !== 4 && dt !== 5) continue;
    const total = dt === 4 ? Number(w.equipment_providing_ratio) : Number(w.item_providing_ratio);
    if (!(total > 0)) continue;
    const parts = (Number(w.rarity_type) - 1) * 10 + (dt === 4 ? 3 : 4);
    const list = equipmentOrItems(dt, Number(w.rarity_type));
    if (!list.length) continue;
    const per = total / list.length;
    for (const id of list) items.push(mkItem(Number(w.rarity_type), parts, id, fmt5(per), false, false));
  }
  return items;
}

function mkItem(rarity, parts, masterId, ratio, isPickup, withLottery) {
  const o = {
    gacha_type: withLottery ? 3 : 1,
    first_table_id: "",                 // 由调用方补
    gacha_display_parts_type: parts,
    is_pickup: !!isPickup,
    item_format: { sheet_type: /^Ch/.test(masterId) ? 2 : 1, master_id: masterId, amount: 1 },
    providing_ratio: ratio,
    valid_date: "",
  };
  if (withLottery) o.lottery_type = 2;
  return o;
}

/** 装备/道具候选（友情池用）。缺 Second_* 表 -> 用 ItemList 按稀有度取。 */
function equipmentOrItems(displayType, rarity) {
  const il = loadTable("Item/ItemList.csv");
  if (!il) return [];
  // ItemMiddleType: 50=武器, 51=防具 之类；用 ItemCategory 区分道具/装备
  const rows = il.rows.filter(function (r) {
    return Number(r.Rarity) === rarity && /^Item_(Equipment|Material)_/.test(r.ItemId);
  });
  return rows.slice(0, displayType === 4 ? 60 : 40).map(function (r) { return r.ItemId; });
}

/**
 * 自选池该用哪组 LotteryType —— 由玩家选的 2 个 pickup 角色各是 Main 还是 Support 决定。
 *   2 主   -> MainMain
 *   2 辅   -> SupportSupport
 *   1主1辅 -> MainSupport
 */
function pickLotteryType(tableId) {
  const pk = selectedPickup(tableId);
  if (!pk.length) return "MainSupport";
  try {
    const ct = loadTable("Character/Character.csv");
    const byId = new Map((ct ? ct.rows : []).map(function (r) { return [r.CharacterID, r]; }));
    let main = 0, sup = 0;
    for (const id of pk) {
      const r = byId.get(id);
      if (!r) continue;
      if (Number(r.SupportType) === 0) main++; else sup++;
    }
    if (main === 2) return "MainMain";
    if (sup === 2) return "SupportSupport";
    return "MainSupport";
  } catch (e) { return "MainSupport"; }
}

/**
 * first_table_id -> gacha_group_id。
 * 实测：first_table_id 不一定由组名派生（Sp00039 -> First_Other_Premium3_23），
 * 任何「从表名裁出组名」的写法在这些池上都会取不到玩家选择。
 */
let _tableGroupMap = null;
let _groupById = null;
function groupOfFirstTableId(tableId) {
  if (!tableId) return null;
  if (!_tableGroupMap) {
    _tableGroupMap = new Map();
    const mg = ensureMaster();
    const settings = mg.gacha_group_setting || [];
    _groupById = new Map((mg.gacha_group || []).map(function (g) { return [String(g.gacha_group_id), g]; }));
    for (const b of (mg.gacha_base_info || [])) {
      const st = settings.find(function (x) { return x.gacha_id === b.gacha_id; });
      if (!st || !b.first_table_id) continue;
      const tid = String(b.first_table_id);
      if (!_tableGroupMap.has(tid)) _tableGroupMap.set(tid, []);
      _tableGroupMap.get(tid).push(String(st.gacha_group_id));
    }
  }
  const list = _tableGroupMap.get(String(tableId)) || [];
  if (!list.length) return null;
  // ★ 2026-10-22：同一张 first_table_id 会被多个组共用！
  //   实测 First_Other_Premium1_01 同时属于 Other_Premium1 和 **StepUp00009**，
  //   早期用「后写覆盖」的 Map → 取到 StepUp00009 → 玩家在 premium 选的角色读不到
  //   → pickSel 恒空 → 抽卡完全没有 PICKUP 效果（实测 200 抽 0 次 pick）。
  //   选法：① 被 gacha_pickup 配置成自选池的组优先 ② 其次跳过 StepUp(view_type=3) ③ 否则取第一个。
  for (const gid of list) if (isPickupGroup(gid)) return gid;
  for (const gid of list) {
    const g = _groupById.get(gid);
    if (g && Number(g.view_type) !== 3) return gid;
  }
  return list[0];
}

/**
 * 玩家在自选池里选中的 pickup 角色。
 *
 * 数据源：state.UserAssetSelectPickCharacterList（由 gacha/select_character 写入）。
 * 实测结构是**扁平的**（每个角色一条）：
 *   { gacha_group_id: "SelectPick00184", master_character_id: "Ch004001205", select_pick_reset_count: 0 }
 * 早期我按 `__selectPick[groupId]` 取，字段名不对 → 永远取不到 → pickup 加权失效。
 */
function selectedPickup(tableId) {
  try {
    const st = getState();
    // tableId(First_SelectPick00231_01) -> groupId(SelectPick00231)
    // ★ 2026-10-22：不能只靠字符串裁剪 —— 有的池 first_table_id 与组名完全不同
    //   （Sp00039 的 first_table_id = First_Other_Premium3_23）。先按 gacha_base_info 反查。
    const groupId = groupOfFirstTableId(tableId) || String(tableId).replace(/^First_/, "").replace(/_\d+$/, "");
    // 读取同样收口到 state.selectPickIds —— 兼容历史脏数据形状。
    return selectPickIds(st, groupId);
  } catch (e) { return []; }
}
// ★ 2026-10-23 出货日志：记录每个池的实际稀有度分布（用于核对概率）
export function rollLogged(gachaId, buttonId, n) {
  const r = roll(gachaId, buttonId, n);
  try {
    const em = (r && r.GachaEmisions && r.GachaEmisions.GachaEmissions) || [];
    const dist = {};
    for (const e of em) {
      const id = String(e.ItemId || "");
      const mm = id.match(/_(SSR|SR|R|N)_/) || [];
      const key = mm[1] || (id.startsWith("Ch") ? "CHAR" : "OTHER");
      dist[key] = (dist[key] || 0) + 1;
    }
    console.log("[roll] " + gachaId + " n=" + n + " → " + JSON.stringify(dist));
  } catch (e) { }
  return r;
}
