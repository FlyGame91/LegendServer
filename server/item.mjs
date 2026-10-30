export function enhanceEquipmentByExp(target, exp) {
  if (!target || !(exp > 0)) return { gained: 0, levels: 0, beforeLv: target && target.CurrentLevel, afterLv: target && target.CurrentLevel };
  const rarity = equipmentRarity(target.MasterEquipmentId);
  const maxLevel = Number(target.MaxLevel) || equipmentCurveMaxLv(rarity) - 1;
  const beforeLv = Number(target.CurrentLevel) || 1;
  const cur = Number(target.CurrentExp) || 0;
  const next = cur + exp;
  // ★ 等级 = 满足 累计(Lv) <= exp 的最大 Lv（上限 maxLevel）
  let lv = equipmentLevelForCumExp(rarity, next, maxLevel);
  if (lv > maxLevel) lv = maxLevel;
  const levelChanged = (lv !== beforeLv);
  target.CurrentLevel = lv;
  // ★★ MaxExp 的口径（真机 3415 件装备实证）★★
  //   未满级：MaxExp = 下一级的累计需求（用于进度条「あと N」）
  //   已满级：**MaxExp = 累计(MaxLevel) = CurrentExp**（无溢出空间）
  //     实证：Lv50/50 exp=58240 MaxExp=58240
  //           Lv20/20 exp=4300 MaxExp=4940 ← 这里的 4940 是「该级档位的总量」，
  //             等于 累计(21)；因为突破后能继续吃经验，故留了一档空间。
  //   统一做法：取 累计(min(maxLevel+1, 曲线最大Lv))，若曲线已到顶则等于累计(maxLevel)。
  const curveMax = equipmentCurveMaxLv(rarity);
  const nextLv = Math.min(lv + 1, curveMax);
  const maxExp = equipmentCumExp(rarity, nextLv);
  // ★★★ 2026-10-21 修正：MaxExp 必须按【当前等级+1 的累计经验】重算 ★★★
  //   真机实证（baggage_breakLimitEquipment 契约）：Lv20 的装备 MaxExp=4940 = 累计(21)，
  //   即使等级已达当前突破档上限（20/30）也是这个口径。
  //   我们此前在满级时**保留旧 MaxExp**（新造装备是初始值 60）⇒ Lv10/10 的装备仍是 60/60，
  //   客户端读到的经验条与「能否继续强化」判断全部错位（用户报障：满级仍可点最大强化）。
  if (maxExp !== null) target.MaxExp = maxExp;
  const _capExp = Number(target.MaxExp) || next;
  // ★ 满级时经验条应【填满】（真机实证：Lv50/50 → exp=58240 = MaxExp）
  target.CurrentExp = (lv >= maxLevel) ? _capExp : Math.min(next, _capExp);
  // ★★★ 等级变了必须重算属性（2026-10-14 用户报障：「升级没加属性」）★★★
  //   与角色升级是同一类缺陷：属性是「等级 + 主数据成长率」算出来的，
  //   **只改等级不重算＝界面上数值纹丝不动**。
  //   ★ 必须【保留已有的附魔结果】（type=2/3），否则一强化就把附魔洗掉。
  if (levelChanged) {
    // ★ 附魔行改为直接从 enchantList 折算（权威映射见 enchantStatusFromList）
    const ench = enchantStatusFromList(target.enchantList);
    target.statusList = buildEquipmentStatusList(target.MasterEquipmentId, lv, ench);
  }
  return { gained: exp, levels: lv - beforeLv, beforeLv: beforeLv, afterLv: lv };
}
// 道具/装备工厂：抽卡或奖励发装备时，客户端需要【装备实例 id】。
//
// 为什么需要：录制的 gacha/roll 里，装备类条目带 EquipmentUserAssetId（真实实例 id），
// 例如 {SheetType:1, ItemId:"Item_Equipment_R_02", EquipmentUserAssetId:4529980864}。
// 早期我返回 null，客户端可能找不到该装备实例 → 抽卡结果白屏。
//
// 数据来源（MasterData）：
//   Item/EquipmentList.csv     装备定义：PartsType/EquipmentType/StatusType1..2/Init/Up
//   Fusion/EquipmentLevelUp.csv  Rarity -> Lv -> NeedExp（用于 MaxLevel/MaxExp）
//   Item/ItemList.csv           Rarity 等通用信息
import { loadTable } from "./masterdata.mjs";

let eqTbl = null, eqLvTbl = null, itemTbl = null;
function ensure() {
  if (!eqTbl) eqTbl = loadTable("Item/EquipmentList.csv");
  if (!eqLvTbl) eqLvTbl = loadTable("Fusion/EquipmentLevelUp.csv");
  if (!itemTbl) itemTbl = loadTable("Item/ItemList.csv");
}
function n(v) { const x = Number(v); return isFinite(x) ? x : 0; }

/** 该 ItemId 是否是装备。 */
export function isEquipment(masterItemId) {
  ensure();
  if (!eqTbl) return false;
  return eqTbl.rows.some(function (r) { return r.ItemId === masterItemId; });
}

const STATUS_KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique", "PhysicalAndMagicalAttack"];
/**
 * ★★★ StatusType（属性种类）→ 响应字段名（2026-10-14 修正）★★★
 *
 * 我原来的映射是错的：`{1:"Hp", 2:"PhysicalDefence", 3:"MagicalDefence"}` ——
 * 把 StatusType 当成了「装备状态类型」的 1/2/3，而它其实是**属性种类**。
 *
 * 正确映射（用真机 400 件装备逐件反推：拿 EquipmentList 的
 * StatusType/Init/Up 算出期望值，再在 statusList[type=1] 里找等值的字段）：
 *   1 → Hp            2 → PhysicalAttack   3 → PhysicalDefence
 *   4 → MagicalAttack 5 → MagicalDefence   6 → Technique
 * 实证：SSR_0104 的 StatusType2=5 → 真机 statusList 里 MagicalDefence=29 ✓
 *   （旧映射没有 5 这个键 → 直接返回 null → **该属性整条丢失**）
 */
// ★★★ 2026-10-22 修正（用户报障：「一把剑为什么升级只加生命值？」）★★★
//   权威枚举：Common/CommonEnum/BasicStatusType.cs
//     None=0 Hp=1 PhysicalAttack=2 PhysicalDefence=3 MagicalAttack=4
//     MagicalDefence=5 Technique=6 DownPoint=7 PhysicalAndMagicalAtatck=8 PhysicalAndMagicalDefence=9
//   我此前把 7 当成「PhysicalAndMagicalAttack」，而 8 没有映射 → **type=8 的属性整条丢失**。
//   实证：Item_Equipment_SSR_0108（エルダーブレイド）StatusType2=8 / Init 23 / Up 2.41
//         → 界面上只剩 HP+70，第二个属性完全不显示。
//   影响面：EquipmentList 里 StatusType=8 共 153 个槽（主属性 72 件 + 副属性 81 件）。
//   （7=DownPoint / 9=PhysicalAndMagicalDefence 在响应结构里没有对应字段，保持跳过。）
const STATUS_KEY_BY_TYPE = { 1: "Hp", 2: "PhysicalAttack", 3: "PhysicalDefence", 4: "MagicalAttack", 5: "MagicalDefence", 6: "Technique", 8: "PhysicalAndMagicalAttack" };
const STATUS_TYPE_BY_KEY = { Hp: 1, PhysicalAttack: 2, PhysicalDefence: 3, MagicalAttack: 4, MagicalDefence: 5, Technique: 6, PhysicalAndMagicalAttack: 8 };
function statusKeyFor(typeNum) {
  return STATUS_KEY_BY_TYPE[Number(typeNum)] || null;
}
function statusTypeFor(key) {
  return STATUS_TYPE_BY_KEY[key] || 0;
}

/** 装备 Rarity（从 ItemList 取）。 */
function equipRarity(masterItemId) {
  ensure();
  if (!itemTbl) return 1;
  const r = itemTbl.rows.find(function (x) { return x.ItemId === masterItemId; });
  return r ? n(r.Rarity) || 1 : 1;
}

/** 该 Rarity 在 Lv1 时的 MaxLevel / MaxExp。 */
function levelCap(rarity) {
  ensure();
  if (!eqLvTbl) return { maxLevel: 1, maxExp: 0 };
  const rows = eqLvTbl.rows.filter(function (r) { return n(r.Rarity) === rarity; });
  if (!rows.length) return { maxLevel: 1, maxExp: 0 };
  let maxLv = 1, exp = 0;
  for (const r of rows) { const lv = n(r.Lv); if (lv > maxLv) maxLv = lv; if (lv === 2) exp = n(r.NeedExp); }
  return { maxLevel: maxLv, maxExp: exp };
}

/**
 * 创建装备实例（字段参照存档里已有装备）。
 * 只用于抽卡/奖励发放；写接口里的强化等另走状态修改。
 */
/**
 * ★★★ 构造某件装备在指定等级下的 statusList（唯一入口）★★★
 *
 * 契约与客户端要求（UserEquipmentStatusList.cs:60-66）：
 *   LevelStatus          = dict[1]   ← 必须有 type=1
 *   EnchantStatusValue   = dict[2]   ← 必须有 type=2
 *   EnchantStatusPercent = dict[3]   ← 必须有 type=3
 * 缺任何一条都会抛 KeyNotFoundException。
 *
 * 属性公式（契约实证）：`value = InitStatus + UpStatus × (level - 1)`，四舍五入取整。
 *   两个槽（StatusType1/2）都累加进 type=1 的对应属性。
 *   验算：SSR_0104(HP: 51+8/lv, MDEF: 10+0.99/lv) lv20 → Hp=203 / MDEF=29 ✓
 *
 * @param masterItemId 装备主数据 id
 * @param level        当前等级（决定属性）
 * @param enchant      可选的附魔结果 [{type,value,max}]（写入 type=2 平值 / type=3 百分比）
 */
/**
 * ★★★ 2026-10-22：把装备的 enchantList 折算成 statusList 的 type=2/type=3 两行 ★★★
 *
 * 权威（真机契约逐件核对）：
 *   enchantList[].currentType 就是 BasicStatusType，但 7~12 是「百分比」那一套：
 *     1=Hp 2=PhysicalAttack 3=PhysicalDefence 4=MagicalAttack 5=MagicalDefence 6=Technique   → type=2（平值）
 *     7=PA% 8=PD% 9=MA% 10=MD% 11=Tech% 12=Hp%                                              → type=3（百分比）
 *   实证：
 *     · SSR_0104  enchantList [{5:7},{10:3}]  → statusList type2 MDEF=7 / type3 MDEF=3  ✅
 *     · SSR_0103  enchantList [{8:5},{7:1},{1:62}] → type2 Hp=62 / type3 PA=1, PD=5    ✅
 */
// ★ 用真机 57 件「带附魔」的装备反解出来的映射（57/57 逐件一致）：
//   平值：1=Hp 2=PhysicalAttack 3=PhysicalDefence 4=MagicalAttack 5=MagicalDefence
//   百分比：6=Hp% 7=PA% 8=PD% 9=MA% 10=MD%
//   11 以上不是基础属性（暴击率/伤害增减之类），不进 statusList
const ENCHANT_FLAT_KEY = { 1: "Hp", 2: "PhysicalAttack", 3: "PhysicalDefence", 4: "MagicalAttack", 5: "MagicalDefence" };
const ENCHANT_PCT_KEY  = { 6: "Hp", 7: "PhysicalAttack", 8: "PhysicalDefence", 9: "MagicalAttack", 10: "MagicalDefence" };
export function enchantStatusFromList(enchantList) {
  const out = [];
  for (const e of (enchantList || [])) {
    const t = Number(e && e.currentType);
    const v = Number(e && e.currentValue);
    if (!t || !v) continue;
    if (ENCHANT_FLAT_KEY[t]) out.push({ type: STATUS_TYPE_BY_KEY[ENCHANT_FLAT_KEY[t]], value: v, isPercent: false });
    else if (ENCHANT_PCT_KEY[t]) out.push({ type: STATUS_TYPE_BY_KEY[ENCHANT_PCT_KEY[t]], value: v, isPercent: true });
  }
  return out;
}

export function buildEquipmentStatusList(masterItemId, level, enchant) {
  ensure();
  const def = eqTbl ? eqTbl.rows.find(function (r) { return r.ItemId === masterItemId; }) : null;
  const lv = Math.max(1, Number(level) || 1);
  const mkRow = function (type) { const row = {}; for (const k of STATUS_KEYS) row[k] = 0; row.type = type; return row; };
  const row1 = mkRow(1), row2 = mkRow(2), row3 = mkRow(3);
  if (def) {
    for (const slot of [1, 2]) {
      const t = n(def["StatusType" + slot]);
      const init = n(def["InitStatus" + slot]);
      const up = n(def["UpStatus" + slot]);
      // ★ 修正：早期写成 `if (!t || !init) continue` ——
      //   把「InitStatus=0 但 UpStatus>0」的槽整条跳过（如某些装备的成长槽 init 为 0），
      //   导致该属性永远为 0。判据应是「有没有配 StatusType」。
      if (!t) continue;
      const key = statusKeyFor(t);
      if (!key) continue;
      const raw = init + up * (lv - 1);
      // ★ 取整规则：真机 MDEF = 10 + 0.99×19 = 28.81 → 29（四舍五入）
      row1[key] = (raw % 1 === 0) ? raw : Math.round(raw);
    }
  }
  // 附魔结果（type=2 平值 / type=3 百分比）
  if (Array.isArray(enchant)) {
    for (const e of enchant) {
      const t = Number(e && e.type);
      const v = Number(e && e.value) || 0;
      const key = statusKeyFor(t);
      if (!key) continue;
      if (e.isPercent) row3[key] = v;
      else row2[key] = v;
    }
  }
  return [row1, row2, row3];
}

// ★★★ 角色剧情 id 的合法性（2026-10-16）★★★
//
// 由来：客户端控制台报 `ArgumentNullException: key at LoadUserDataApi.PostRequest`，
//   反编译定位到 `TemporaryCharacterStoryExtend_AddOrUpdate`（Assembly-CSharp__13.cpp:27756）：
//     它用每条的 `StoryId` 去查 `CharacterStoryDataStore.GetCharaStoryByStoryId(StoryId)`，
//     **查不到返回 null** → `Dictionary.set_Item(null, ...)` → ArgumentNullException。
//
//   `story/confirm` 原先把请求里的 `MasterStoryIdList` 条目**不加过滤**写进 UserCharacterStoryList，
//   而客户端在这个端点会传**主线剧情 id**（形如 `sc_main271_1`，是 scenario 资源名），
//   它不在 `Story/StoryList.csv` 里（该表 1294 条全是 `Story_Char_<角色>_<序号>`）→ 必然查不到。
//
// ★ 判据：`UserCharacterStoryList[].StoryId` 必须是 StoryList.csv 里的 StoryId（StoryType=1 角色剧情）。
// ★ 三方对照：本项目的用户档曾有 1 条 sc_*，而契约档 0 条、真机契约 0 条。
let _storyIdSet = null;
/** 一次性重算【全部装备】的 statusList（2026-10-22：StatusType=8 之前被丢掉）。 */
export function rebuildAllEquipmentStatus(s) {
  ensure();
  const list = (((s.ItemList || {}).EquipmentList) || []);
  let changed = 0;
  for (const e of list) {
    if (!e || !e.MasterEquipmentId) continue;
    // ★ 附魔行从 enchantList 折算（不再从 statusList 反推 —— 那样永远是 0）
    const ench = enchantStatusFromList(e.enchantList);
    const next = buildEquipmentStatusList(e.MasterEquipmentId, Number(e.CurrentLevel) || 1, ench);
    if (JSON.stringify(next) !== JSON.stringify(e.statusList)) { e.statusList = next; changed++; }
  }
  return changed;
}

export function isCharacterStoryId(storyId) {
  const id = String(storyId || "");
  if (!id) return false;
  if (!_storyIdSet) {
    _storyIdSet = new Set();
    try {
      const t = loadTable("Story/StoryList.csv");
      for (const r of (t && t.rows) || []) { const v = r.StoryId; if (v) _storyIdSet.add(String(v)); }
    } catch (e) { /* 表缺失时退回「按前缀判断」 */ }
  }
  if (_storyIdSet.size) return _storyIdSet.has(id);
  return /^Story_Char_/.test(id);   // 兜底：只接受角色剧情命名
}

export function createEquipment(instanceId, masterItemId) {
  // 注：返回对象必须含契约的 16 个键（含 enchantList）—— 见下方 return。

  ensure();
  const def = eqTbl ? eqTbl.rows.find(function (r) { return r.ItemId === masterItemId; }) : null;
  const rarity = equipRarity(masterItemId);
  const cap = levelCap(rarity);
  // ★★ statusList 必须是【type 1/2/3 三条】，一条都不能少 ★★
  //   客户端 UserEquipmentStatusList.New（UserEquipmentStatusList.cs:60-66）做的是：
  //     LevelStatus          = dict[1]      ← Dictionary.get_Item(1)
  //     EnchantStatusValue   = dict[2]      ← Dictionary.get_Item(2)
  //     EnchantStatusPercent = dict[3]      ← Dictionary.get_Item(3)
  //   而 dict 只由【statusList 里出现过的 type】填充 →
  //   缺任何一条都会抛 KeyNotFoundException（实测崩溃栈：EquipmentUseCase 内
  //   TemporaryEquipmentStatusDetail.New → Item_TemporaryEquipmentItemExtend.AddOrUpdate
  //   → QuestSkipApi.PostRequest），表现为「通信エラー」。
  //   ★ 我早期写成「按 StatusType1/2 生成对应 type 的行」，把 StatusType（属性种类：
  //     1=HP/4=ATK/5=MATK…）误当成了 statusList 的 type（装备状态类型：1/2/3），
  //     于是 SSR_0086（StatusType1=4, StatusType2=5）只生成了 type=[4,5] → 崩。
  //
  //   type 语义（真机 3415 件装备 100% 是 [1,2,3] 实证）：
  //     type=1 → 基础属性 = Σ(InitStatus_k + UpStatus_k × (level-1))  ← 两个槽都累加进 type1
  //     type=2 → 附魔平值   （EnchantStatusValue，新建时为 0）
  //     type=3 → 附魔百分比 （EnchantStatusPercent，新建时为 0）
  //   验算：SSR_0104（Init1=51/Up1=8 HP；Init2=10/Up2=0.99 MDEF）Lv20 →
  //     HP   = 51 + 8×19 = 203     ✅ 真机 203
  //     MDEF = 10 + 0.99×19 = 28.81 → 29  ✅ 真机 29
  // ★★★ 属性计算收口到 buildEquipmentStatusList（2026-10-14）★★★
  //
  // 用户报障：「升级没加属性，你在角色升级那边犯过一次，现在装备这边又来了」。
  //   根因与角色那次【完全同型】：createEquipment 只在**创建时**算一次 statusList，
  //   而 enhanceEquipmentByExp 只改 CurrentLevel/CurrentExp，**从不重算属性**。
  //
  // 正确语义（契约实证，SSR_0104 的 lv1 与 lv20 对比）：
  //   `statusList[type=1][属性] = InitStatus + UpStatus × (CurrentLevel - 1)`
  //   验算：Hp   = 51 + 8×19    = 203   ✅ 真机 lv20 = 203
  //         MDEF = 10 + 0.99×19 = 28.81 → 29 ✅ 真机 lv20 = 29
  //   ⇒ 等级是属性公式的输入，**每次改等级都必须重算**。
  const statusList = buildEquipmentStatusList(masterItemId, 1);
  return {
    Id: instanceId,
    MasterEquipmentId: masterItemId,
    // ★★★ MaxLevel / break_limit 修正（2026-10-16）★★★
    //
    // 用户报障：「游戏进不去（通信エラー）」，根因就是这两行。
    //
    // ★ 我此前的错误：`MaxLevel: cap.maxLevel`（cap 来自 levelCap(rarity)），
    //   而 levelCap 返回的是 **Fusion/EquipmentLevelUp.csv 里该 Rarity 的最大 Lv（= 51）**
    //   —— 那是【等级曲线的上界】，不是【新造装备的初始上限】。
    //   另一行 `break_limit: 0` 更是写死 0。
    //
    // ★ 契约档与真机契约的权威对应（2360 件装备实证，无一例外）：
    //     MaxLevel = break_limit × 10
    //       break_limit=1 → MaxLevel=10   （新造装备的初始状态，占绝大多数）
    //       break_limit=2 → MaxLevel=20
    //       break_limit=5 → MaxLevel=50   （突破到顶）
    //   ★ 而 break_limit **最小是 1**（契约档/真机契约里为 0 的件数是 0）。
    //
    // ★ 为什么 break_limit=0 会让客户端崩：
    //   客户端用 break_limit 算星级并索引图标数组（同「7 星越界导致头像消失」那次，
    //   只是这次是**下界**越界）。0 ⇒ 索引 -1 ⇒ 每件都抛异常 ⇒ 整次 load_user_data 失败。
    //   ⇒ 我发的 682 件全是 0 星 + MaxLevel=51，客户端遍历到时必崩。
    MaxLevel: 10,          // = 初始 break_limit(1) × 10
    CurrentLevel: 1,
    MaxExp: cap.maxExp,    // 20(R) / 40(SR) / 60(SSR) —— 与契约档的 `1|10|20` 等组合一致 ✅
    CurrentExp: 0,
    MaxBreakLimitCount: 5,
    break_limit: 1,        // ★ 最小 1（契约档/真机均无 0）
    OwnerCharacterCategory: 0,
    OwnerCharacterId: null,
    currentEnchantId: null,
    previewEnchantId: null,
    HasLocked: false,
    DateOfAcquisition: 1700000000,
    statusList: statusList,
    // ★ enchantList 是契约要求的键（16 键之一）—— 早期漏了它，
    //   导致新造装备的 EquipmentList[0].enchantList 缺失（MISSING）。
    //   未附魔的装备该字段是【空数组】（契约实证：enchantList: []）。
    enchantList: [],
  };
}

console.log("[itemfactory] module ready");
// ---------- 限界突破消耗 ----------
//
// 来源：Fusion/EquipmentBreakLimit.csv
//   字段 DefaultEquipmentType, Rarity, ItemId, BreakLimitType, MaxLevel, Cost, SubstitutableCost
//   Cost 形如 "Item:Item_Currency_Goldx3000\nItem:Item_Material_Equipment_Limitbreak_N_01x4"
//
// 【为什么需要】baggage/breakLimitEquipment 的响应里 items.AllItemList 不是「目标装备自身」，
// 而是**本次限界突破的消耗材料**（Gold + Limitbreak 材料）的当前持有量。
// 我早期误以为 items = 请求涉及的道具，导致这里恒为空。
//
// 匹配规则：先按 (DefaultEquipmentType, Rarity, BreakLimitType) 精确匹配；
// 装备的 DefaultEquipmentType 取自 Item/EquipmentList.csv 的 PartsType，
// Rarity 取自 Item/ItemList.csv。
let _blTbl = null;
function blTable() {
  if (_blTbl === undefined || _blTbl === null) {
    try { _blTbl = loadTable("Fusion/EquipmentBreakLimit.csv"); } catch (e) { _blTbl = false; }
  }
  return _blTbl || null;
}

/** 解析 Cost 字符串 -> [{ master_id, amount }]。 */
export function parseCostString(cost) {
  const out = [];
  if (!cost) return out;
  for (const line of String(cost).split("\n")) {
    const m = line.trim().match(/^Item:([A-Za-z0-9_]+)x(\d+)$/);
    if (m) out.push({ master_id: m[1], amount: Number(m[2]) });
  }
  return out;
}

/**
 * 取某件装备在指定限界突破等级所需的材料（含金币）。
 * @param masterEquipmentId 主数据装备 id（Item_Equipment_*）
 * @param breakLimitType   目标突破阶段（1..N）
 */
/**
 * ★ 职业碎片 → 该职业的 ClassUp 解放素材（**必须查权威表**）。
 *
 * 权威链（四跳）：
 *   Item/FragmentList.csv        (ItemId → CharacterId)
 *   → Character/Character.csv    (CharacterId → SoldierType)
 *   → ClassUp/ClassUpCostTag.csv (CostTag = MAIN_<SOLDIER>_CLASS_01_Cost_Tag_01
 *                                 → ItemId = Item_Material_MasterClassUp_SSR_<N>)
 *
 * ★ 教训：早期用 `replace(/^Item_Fragment_/, "Item_Material_ClassUp_")` 字符串推导，
 *   拼出的 `Item_Material_ClassUp_Main_0267` **在 MasterData 里根本不存在**
 *   （18 个 MasterClassUp 素材里没有 Main 系列）。
 *   这与「碎片 id 必须查 FragmentList」是同一类缺陷 —— 字符串推导必然错。
 */
export function classUpMaterialFor(fragmentItemId) {
  let fl = null, chT = null, tagT = null;
  try { fl = loadTable("Item/FragmentList.csv"); } catch (e) {}
  try { chT = loadTable("Character/Character.csv"); } catch (e) {}
  try { tagT = loadTable("ClassUp/ClassUpCostTag.csv"); } catch (e) {}
  if (!fl || !chT || !tagT) return null;
  const fr = fl.rows.find(function (r) { return r.ItemId === fragmentItemId; });
  if (!fr || !fr.CharacterId) return null;
  const chr = chT.rows.find(function (r) { return r.CharacterID === fr.CharacterId; });
  if (!chr) return null;
  // SoldierType(1..8) → CostTag 里的兵种名（与 ClassUpLevelParameter 同一套命名）
  const SOLDIER = { "1": "SOLDIER", "2": "LANCER", "3": "RIDER", "4": "SAINT",
                    "5": "SORCERER", "6": "SHOOTER", "7": "AERIAL", "8": "ASSASSIN" };
  const sName = SOLDIER[String(chr.SoldierType)];
  if (!sName) return null;
  const prefix = "MAIN_" + sName + "_CLASS_01_Cost_Tag_";
  const row = tagT.rows.find(function (r) { return String(r.CostTag) === prefix + "01"; });
  return row ? row.ItemId : null;
}

export function breakLimitCost(masterEquipmentId, breakLimitType) {
  const t = blTable();
  if (!t) return [];
  // 装备的「类型」与「稀有度」
  let partsType = "", rarity = "";
  try {
    const el = loadTable("Item/EquipmentList.csv");
    const eRow = el && el.rows.find(function (r) { return r.ItemId === masterEquipmentId; });
    if (eRow) partsType = String(eRow.PartsType || "");
  } catch (e) {}
  try {
    const il = loadTable("Item/ItemList.csv");
    const iRow = il && il.rows.find(function (r) { return r.ItemId === masterEquipmentId; });
    if (iRow) rarity = String(iRow.Rarity || "");
  } catch (e) {}
  const blt = String(breakLimitType);
  // 逐级放宽匹配：精确 -> 只按类型+阶段 -> 只按稀有度+阶段 -> 任意同阶段
  const tries = [
    function (r) { return r.DefaultEquipmentType === partsType && r.Rarity === rarity && r.BreakLimitType === blt; },
    function (r) { return r.DefaultEquipmentType === partsType && r.BreakLimitType === blt; },
    function (r) { return r.Rarity === rarity && r.BreakLimitType === blt; },
    function (r) { return r.BreakLimitType === blt; },
  ];
  for (const pred of tries) {
    const hit = t.rows.find(function (r) { return pred(r) && r.Cost; });
    if (hit) return parseCostString(hit.Cost);
  }
  return [];
}

/** 同上，但返回含 sheet_type 的响应格式。 */
export function breakLimitCostFormatted(masterEquipmentId, breakLimitType) {
  return breakLimitCost(masterEquipmentId, breakLimitType).map(function (x) {
    return { sheet_type: 1, master_id: x.master_id, amount: x.amount };
  });
}

/**
 * 护符限界突破材料（`Fusion/AmuletBreakLimit.csv` 的 Cost 列）。
 * ★ 契约实证（baggage_break_limit_amulet）：突破 2→3 消耗
 *   Item_Material_Amulet_Limitbreak_SSR ×1 + Item_Currency_Gold ×100000 + 星の粉 ×50
 *   （= 表中 Rarity 4 / BreakLimitType 3 的 Cost 行）。
 */
export function amuletBreakLimitCost(masterAmuletId, breakLimitType) {
  const t = amuletBlTable();
  if (!t) return [];
  const rarity = amuletRarityNum(masterAmuletId);
  const row = ((t.rows || []).find(function (r) {
    return Number(r.Rarity) === rarity && Number(r.BreakLimitType) === Number(breakLimitType);
  })) || null;
  return row ? parseCostString(row.Cost) : [];
}
// ---------- 装备附魔（enchant）----------
//
// 【为什么需要】baggage/enchantEquipmentFix 与 enchantEquipmentStart 是**操作后回执**：
// 客户端拿它刷新附魔界面，需要看到操作【之后】的 targetEquipment ——
// 包含 currentEnchantId/previewEnchantId 与实时的 enchantList。
// 早期直接把存档里的装备对象原样返回，而该装备可能从未附魔
// （currentEnchantId=null、enchantList=[]）→ 界面读不到附魔数据。
//
// 【术语与数据源】
//   · Enchant 主数据：EquipmentEnchant/Enchant.csv
//       列 EnchantgroupID / EnchantID / Name / ResourceId / EquipmentPartsType / EnchantItemList
//     EnchantID 形态 = Enchant_<组号2位>[<部位2位>]
//       组形态（parts=0）：Enchant_04  ← 用 SSR/SR/R 通用材料
//       部位形态（parts=1..4）：Enchant_0401/0402/0403/0404 ← 用 Item_Material_Enchant_04_01 等
//   · 「附魔石 → 附魔组」的对应就写在 EnchantItemList 里（材料 id 含组号）。
//   · enchantList 的 currentType 是【附加属性类型编号】，maxValue 取自
//     EquipmentEnchant/EnchantStatus.csv 按 (Grade, EquipmentPartsType) 的分档区间上限。
//
// 【单机语义】附魔是确定性的：用哪颗附魔石就得到哪个附魔组；
// 三个槽位的属性类型/数值由主数据推得（随机区间取下限，保证可复现）。

let _enTbl = null, _enStTbl = null;
function enTable() {
  if (_enTbl === null) { try { _enTbl = loadTable("EquipmentEnchant/Enchant.csv"); } catch (e) { _enTbl = false; } }
  return _enTbl || null;
}
let _matTbl = null;
function matTable() {
  if (_matTbl === null) { try { _matTbl = loadTable("Item/MaterialList.csv"); } catch (e) { _matTbl = false; } }
  return _matTbl || null;
}
let _eqLvTbl = null;
function eqLvTable() {
  if (_eqLvTbl === null) { try { _eqLvTbl = loadTable("Fusion/EquipmentLevelUp.csv"); } catch (e) { _eqLvTbl = false; } }
  return _eqLvTbl || null;
}
function enStatusTable() {
  if (_enStTbl === null) { try { _enStTbl = loadTable("EquipmentEnchant/EnchantStatus.csv"); } catch (e) { _enStTbl = false; } }
  return _enStTbl || null;
}

/** 装备的部位类型（1..4）：取自 Item/EquipmentList.csv 的 PartsType。 */
export function equipmentPartsType(masterEquipmentId) {
  try {
    const el = loadTable("Item/EquipmentList.csv");
    const row = el && el.rows.find(function (r) { return r.ItemId === masterEquipmentId; });
    if (row) return String(row.PartsType || "");
  } catch (e) {}
  return "";
}

/** 装备的稀有度。 */
export function equipmentRarity(masterEquipmentId) {
  try {
    const il = loadTable("Item/ItemList.csv");
    const row = il && il.rows.find(function (r) { return r.ItemId === masterEquipmentId; });
    if (row) return String(row.Rarity || "");
  } catch (e) {}
  return "";
}

/**
 * 由「附魔石 master id」推出附魔组 id（形如 Enchant_04）。
 * 依据：Enchant.csv 的 EnchantItemList 列出的材料 id 里含组号
 * （如 Item_Material_Enchant_04_01 → Enchant_04）。
 */
export function enchantGroupForItem(enchantItemMasterId) {
  const t = enTable();
  if (!t || !enchantItemMasterId) return null;
  const hit = t.rows.find(function (r) {
    return String(r.EnchantItemList || "").split("\n").some(function (x) { return x.trim() === String(enchantItemMasterId); });
  });
  if (!hit) return null;
  // 组形态（parts=0）的 EnchantID 就是组 id
  if (String(hit.EquipmentPartsType) === "0") return hit.EnchantID;
  // 部位形态则去掉末两位部位号
  return String(hit.EnchantID).replace(/\d{2}$/, "");
}

/**
 * 由「附魔组 + 装备部位」推出该装备适用的 EnchantID。
 * 优先取部位形态（Enchant_0401），没有则回退组形态（Enchant_04）。
 */
/**
 * 该装备部位可用的【默认附魔组】。
 * 用途：Fix 被单独调用（没有 Start 的上下文）时仍需给出确定结果 ——
 *   契约实证 Fix 独立调用也返回了 Enchant_0401，说明真实服务端总能定出组。
 * 规则：优先取有「该部位专属形态（Enchant_XXXX）」的组，否则取最早的通组（Enchant_XX）。
 */
export function defaultEnchantGroupFor(partsType) {
  const t = enTable();
  if (!t) return null;
  const p = String(partsType || "");
  if (p && p !== "0") {
    const hit = t.rows.filter(function (r) { return String(r.EquipmentPartsType) === p; })
      .map(function (r) { return String(r.EnchantID).replace(/\d{2}$/, ""); })
      .filter(function (g, i, a) { return a.indexOf(g) === i; });
    if (hit.length) return hit[0];
  }
  const grp = t.rows.find(function (r) { return String(r.EquipmentPartsType) === "0"; });
  return grp ? grp.EnchantID : null;
}

export function enchantIdFor(groupId, partsType) {
  const t = enTable();
  if (!t || !groupId) return null;
  const p = String(partsType || "");
  if (p && p !== "0") {
    const exact = t.rows.find(function (r) { return r.EnchantID === groupId + p.padStart(2, "0"); });
    if (exact) return exact.EnchantID;
  }
  const grp = t.rows.find(function (r) { return r.EnchantID === groupId && String(r.EquipmentPartsType) === "0"; });
  return grp ? grp.EnchantID : groupId;
}

/**
 * 构造某件装备的 enchantList（3 个槽位）。
 *
 * ★★★ 权威依据（2026-10-14 重写）★★★
 *
 * 用户报障：「エンチャント結果永远是固定值，应该是在如图3的属性中随机3种，
 *   数值也按照上下限来随机」。**完全正确**，我原实现写死取 `min`。
 *
 * ① 客户端模型（反编译 il2cppOutput 实证）：
 *    ```csharp
 *    struct EquipmentEnchantStatusMasterModel {
 *        int32_t ___StatusType;   // 属性类型
 *        int32_t ___Min;          // ★ 随机下限
 *        int32_t ___Max;          // ★ 随机上限
 *    };
 *    ```
 *    ⇒ 语义就是「在 [Min, Max] 内随机」，不是取下限。
 *
 * ② StatusType 的映射（\`EquipmentEnchantDataStore.cs:301-340\` 逐行实证）：
 *    ```
 *    StatusValueDictionary[1]=HP  [2]=ATK  [3]=DEF  [4]=MATK  [5]=MDEF        （平值）
 *    StatusRateDictionary [1]=HP% [2]=ATK% [3]=DEF% [4]=MATK% [5]=MDEF% [6]=DEX% （基础百分比）
 *    ```
 *    再往后（12~21）是 EnchantStatus.csv 的 Grade5/6 十列战斗属性百分比，
 *    按表内列序依次编号。
 *
 * ③ 真机数据校验（58 件已附魔装备、数百条记录）：
 *    type=1→HP / 2→ATK / 3→DEF / 4→MATK / 5→MDEF 的「平值列」匹配率 **100%**，
 *    且 value 恒满足 `Min <= value <= Max` —— 证明随机语义与映射都对。
 *    样本：`t5=7/8  t10=3/6  t0=0/0` / `t8=5/6  t7=1/2  t1=62/81`（各不相同 → 确认随机）
 *
 * @param masterEquipmentId 装备主数据 id（决定 EquipmentPartsType）
 * @param rnd               随机源（可注入以便测试）
 */
export function buildEnchantList(masterEquipmentId, rnd) {
  const random = rnd || Math.random;
  const parts = equipmentPartsType(masterEquipmentId);
  const st = enStatusTable();
  const zero = { currentType: 0, currentValue: 0, currentMaxValue: 0, alterType: 0, alterValue: 0, alterMaxValue: 0 };
  if (!st || !parts) return [zero, zero, zero];

  // ---- 属性类型编号表（2026-10-14 修正）----
  //
  // ★★★ 用户报障：「エンチャント出现了不应该出现的属性，图3 是应该出现的属性，
  //   根据エンチャント素材的不同，属性列表是不一样的」★★★
  //
  // 我此前的错误：把【Grade1~4 的平值列与基础百分比列】也放进了池子 →
  //   随机出了 `type=5(MDEF平值)`、`type=2(ATK平值)`、`type=8(DEF%)` 这类，
  //   而真机附魔**只会出现 Grade5/6 的那 10 项战斗属性百分比**。
  //
  // ★ 权威依据（两条）：
  //  ① EnchantStatus.csv 的列结构是按 Grade 分组的：
  //     Grade1~4 → ApplyHP/ATK/MATK/DEF/MDEF（平值 + 百分比）
  //     Grade5~6 → ApplyCRITPer/MDMPer/PDMPer/NDMPer/AOEPer/SKILLPer/
  //                DEFResPer/MDEFResPer/DEFPenPer/MDEFPenPer（★ 仅百分比，无平值）
  //  ② 用户截图（条件設定エンチャント）列出的可选条件正是这 10 项：
  //     物理与ダメージ / 魔法与ダメージ / 通常攻撃与ダメージ / スキル与ダメージ /
  //     範囲スキル与ダメージ / 物理ダメージ耐性 / 魔法ダメージ耐性 /
  //     ディフェンス無視倍率 / レジスト無視倍率 / クリティカルダメージ倍率
  //  ③ 契约实证：请求 Enchant_01_01 → alter 行 type=19/16/17（全在这 10 项内）
  //
  // type 编号（与客户端 EnumCharacterStatusType 对齐，见 EquipmentEnchantDataStore）：
  //   CRIT=12  MDM=13  PDM=14  NDM=15  AOE=16  SKILL=17
  //   DEFRes=18  MDEFRes=19  DEFPen=20  MDEFPen=21
  const COMBAT_COLS = [
    { col: "CRIT",    type: 12 },
    { col: "MDM",     type: 13 },
    { col: "PDM",     type: 14 },
    { col: "NDM",     type: 15 },
    { col: "AOE",     type: 16 },
    { col: "SKILL",   type: 17 },
    { col: "DEFRes",  type: 18 },
    { col: "MDEFRes", type: 19 },
    { col: "DEFPen",  type: 20 },
    { col: "MDEFPen", type: 21 },
  ];
  // ---- 汇总该部位可用的 (type, min, max) 池 ----
  const rows = st.rows.filter(function (r) { return String(r.EquipmentPartsType) === String(parts); });
  if (!rows.length) return [zero, zero, zero];
  const pool = [];
  for (const r of rows) {
    // ★ 只取 Grade5/6（战斗属性百分比）；Grade1~4 的平值/基础百分比【不进池】
    const g = Number(r.Grade);
    if (g < 5) continue;
    for (const d of COMBAT_COLS) {
      if (r["Apply" + d.col + "Per"] !== "True") continue;
      const mn = Number(r[d.col + "PerMin"]), mx = Number(r[d.col + "PerMax"]);
      if (isFinite(mn) && isFinite(mx) && mx > 0) pool.push({ type: d.type, min: mn, max: mx, grade: g });
    }
  }  if (!pool.length) return [zero, zero, zero];

  // ---- 随机抽 3 条【互不重复的属性】----
  //   契约实测（baggage_enchantEquipmentStart）：three rows = type 19 / 16 / 17，
  //   三者互不相同，且各自 value ∈ [min, max]。
  const out = [];
  const usedType = new Set();
  let guard = 0;
  while (out.length < 3 && guard++ < 200) {
    const p = pool[Math.floor(random() * pool.length)];
    if (!p || usedType.has(p.type)) continue;
    usedType.add(p.type);
    // ★ 在 [min, max] 内随机（含端点）—— 这是本函数的核心修正
    const span = Math.max(0, p.max - p.min);
    const v = p.min + Math.floor(random() * (span + 1));
    out.push({ currentType: p.type, currentValue: v, currentMaxValue: p.max, alterType: 0, alterValue: 0, alterMaxValue: 0 });
  }
  while (out.length < 3) out.push(zero);
  return out;
}

export function applyEnchant(target, enchantItemMasterId, confirm) {
  if (!target) return target;
  const parts = equipmentPartsType(target.MasterEquipmentId);
  // 附魔组的确定顺序：
  //   ① 请求带了附魔石 → 由材料 id 反查
  //   ② 已有 preview（Start 阶段或 pending）→ 从中取组
  //   ③ 都没有（Fix 被单独调用）→ 取该装备部位可用的第一个附魔组
  //      （契约实测 Fix 独立调用时仍返回了 Enchant_0401，即真实服务端总能给出结果）
  let group = null;
  if (enchantItemMasterId) group = enchantGroupForItem(enchantItemMasterId);
  if (!group && target.previewEnchantId) group = String(target.previewEnchantId).replace(/\d{2}$/, "");
  if (!group) group = defaultEnchantGroupFor(parts);
  const eid = group ? enchantIdFor(group, parts) : null;
  const vals = buildEnchantList(target.MasterEquipmentId);

  // ★★★ 附魔的两阶段语义（2026-10-14 修正）★★★
  //
  // 用户报障：「结果我没有保存，为什么自动给我保存覆盖了？」
  //   根因：Start 阶段我把【已保存的 current】也用新预览覆盖了 →
  //   界面上「元のステータス」（旧）与「新しいステータス」（新）显示成一样，
  //   看起来就像"没点保存却自动存了"。
  //
  // ★ 权威依据（真机 3415 件装备里唯一的「已有 current 且有 preview」样本）：
  //   ```
  //   3980152562  cur=Enchant_04  prev=Enchant_04
  //       [0] cur=9/4   alter=8/1      ← ★ current 保留旧值，alter 放新预览（两者不同！）
  //       [1] cur=4/11  alter=9/7
  //       [2] cur=7/7   alter=4/20
  //   ```
  //   另：57 件「有 current 无 preview」的装备，其 alter **全部为 0** ✓
  //   ⇒ Start（预览）：**保留 current 原样**，只写 alter；
  //     Fix（保存）：把预览值落到 current，alter 归零。
  //
  // 我此前的错误：Start 时把 current 换成新预览值（alter===cur），
  //   既丢了玩家已保存的附魔显示，又造成「未保存却已生效」的观感。
  if (confirm) {
    // Fix：把【预览的 alter】落到 current，alter 清零。
    //   注意必须用 alter 的值（那是预览结果），而不是重新生成一个新的随机值 ——
    //   否则玩家看到的「新しいステータス」与实际保存的不一致。
    const prevRows = (target.enchantList || []);
    if (eid) target.currentEnchantId = eid;
    target.previewEnchantId = null;
    target.enchantList = vals.map(function (x, i) {
      const p = prevRows[i] || {};
      // 若预览里有值（alterType 非 0），落它；否则用新生成的值兜底
      const hasPrev = Number(p.alterType) !== 0;
      return {
        currentType: hasPrev ? Number(p.alterType) : x.currentType,
        currentValue: hasPrev ? Number(p.alterValue) : x.currentValue,
        currentMaxValue: hasPrev ? Number(p.alterMaxValue) : x.currentMaxValue,
        alterType: 0, alterValue: 0, alterMaxValue: 0,
      };
    });
  } else {
    // Start：**保留 current**（已保存的正式附魔），只把新预览写进 alter。
    if (eid) target.previewEnchantId = eid;
    const prevRows = (target.enchantList || []);
    target.enchantList = vals.map(function (x, i) {
      const p = prevRows[i] || {};
      return {
        // ★ 关键：current 三列原样保留（没有旧值时 x.currentType 本就是 0）
        currentType: Number(p.currentType) || 0,
        currentValue: Number(p.currentValue) || 0,
        currentMaxValue: Number(p.currentMaxValue) || 0,
        alterType: x.currentType, alterValue: x.currentValue, alterMaxValue: x.currentMaxValue,
      };
    });
  }
  // ★ 2026-10-22：附魔后必须重算 statusList 的 type=2/3 两行（否则「エンチャント」数值永远是 0）
  try {
    target.statusList = buildEquipmentStatusList(target.MasterEquipmentId, Number(target.CurrentLevel) || 1, enchantStatusFromList(target.enchantList));
  } catch (e) {}
  return target;
}

console.log("[itemfactory] enchant ready");

// ---------- 护符工厂（sheet_type 奖励用）----------
//
// 权威数据链：Item/AmuletList.csv 的 (ItemId → StatusType1/InitStatus1/StatusType2/InitStatus2)
//   契约实证（quest/skip_daily 的 amulet_list[0]）：
//     Item_Amulet_SR_0001 → max_level 10 / max_exp 40 / break_limit 1 /
//       skill_id 7100008 / status_list [{type:1,Hp:50,PhysicalAttack:10},{type:2},{type:3}]
//   StatusType1=1 表示「属性类型 1（Hp 系）」，InitStatus1=50 = 初值。
let amuletTblCache = null;
/**
 * 护符的随机「アビリティ」（skill_id）。
 *
 * ★★ 权威数据链（2026-10-08 破解）★★
 *   Item/AmuletList.csv 的 **AbilityGroupId1 / AbilityGroupId2**
 *     → EquipmentEnchant/AmuletRandomAbility.csv 按 AbilityGroupId 取候选 SkillGroupId（带 Rate 权重）
 *     → 加权随机抽一个作为该护符的 skill_id
 *
 *   实证（真机契约 user_load_user_data，3741 个护符 / 1858 个有 skill_id）：
 *     · Item_Amulet_SSR_0001 (AbilityGroupId1=1000) 的 skill_id 集合
 *       = {7100001..7100016} —— **与表里 group 1000 的 16 个候选完全一致** ✅
 *     · 同一 master_amulet_id 的 skill_id **不恒定**（是随机赋的），
 *       所以不能用「字符串推导」或写死，必须走这个池。
 *   我早期在 createAmulet 里写死 `skill_id: null` → 审计报
 *     TYPE: 契约有值(number)，实现为 null（baggage/synthesis_amulet）。
 *
 * @param {string} masterAmuletId
 * @returns {number|null} 抽到的 skill_id（无候选时为 null）
 */
export function rollAmuletSkillId(masterAmuletId) {
  try {
    if (!amuletTblCache) amuletTblCache = loadTable("Item/AmuletList.csv");
    const rows = (amuletTblCache && amuletTblCache.rows) || [];
    const def = rows.find(function (r) { return String(r.ItemId) === String(masterAmuletId); });
    if (!def) return null;
    if (!amuletAbilityCache) amuletAbilityCache = loadTable("EquipmentEnchant/AmuletRandomAbility.csv");
    const abil = ((amuletAbilityCache && amuletAbilityCache.rows) || []);
    const groups = [def.AbilityGroupId1, def.AbilityGroupId2].filter(function (g) { return g && String(g).trim(); });
    const pool = [];
    for (const g of groups) {
      for (const r of abil) {
        if (String(r.AbilityGroupId) !== String(g)) continue;
        const sid = String(r.SkillGroupId || "").trim();
        if (!sid) continue;
        pool.push({ sid: sid, rate: Number(r.Rate) || 1 });
      }
    }
    if (!pool.length) return null;
    const total = pool.reduce(function (s, x) { return s + x.rate; }, 0);
    let pick = Math.random() * total;
    for (const x of pool) { pick -= x.rate; if (pick <= 0) return Number(x.sid) || null; }
    return Number(pool[pool.length - 1].sid) || null;
  } catch (e) { return null; }
}

let amuletAbilityCache = null;

/**
 * ★★★ 「錬成」产出解析（2026-10-16 用户报障后按权威表实现）★★★
 *
 * 用户报障三连：「扣减数量 / 炼成结果（应该产出什么）/ 自动炼成的材料是否发放」
 * 截图是「錬成」界面（三个页签：装備品 / アミュレット / 素材），
 * 对应三个端点 `baggage/sell_equipment` / `sell_amulet` / `sell_item`。
 *
 * ★ 权威数据源（`SellPrice` 列，格式 `ITEM:<货币id>x<数量>`，可多段换行）：
 *   · `Item/EquipmentList.csv` → SellPrice  例：`ITEM:Item_Currency_Goldx1500\nITEM:Item_Currency_Equipmentx100`
 *   · `Item/AmuletList.csv`    → SellPrice  例：`ITEM:Item_Currency_Goldx600\nITEM:Item_Material_Amulet_Exp_SSRx1`
 *   · `Item/SellItemList.csv`  → SellPrice  例：`ITEM:Item_Currency_EnchantCoinx1`
 *
 * ★ 真机契约逐位验证：
 *   · sell_equipment（1 件）→ Gold 1500 + Equipment 100        ✅
 *   · sell_amulet（50 件）  → Gold 30000 + 星の粉 50（= 600/件）✅
 *   · sell_item（1383 个）  → EnchantCoin 1383（1:1）           ✅
 *
 * ★★ 我此前的错误：一律产出 `Item_Currency_Gold` 且金额是写死的（100 / 50 / ×10）——
 *   **产出的是各品类【专用货币】**（装备币 / 附魔币 / 星の粉），不是金币。
 */
export function sellRewardsFor(kind, masterItemId, count) {
  const TABLE = {
    equipment: "Item/EquipmentList.csv",
    amulet: "Item/AmuletList.csv",
    item: "Item/SellItemList.csv",
  };
  const file = TABLE[kind];
  if (!file || !masterItemId) return [];
  let row = null;
  try {
    const t = loadTable(file);
    const raw = t.rows || [];
    for (const r of raw) {
      if (String(r.ItemId || "") === String(masterItemId)) { row = r; break; }
    }
  } catch (e) { return []; }
  if (!row) return [];
  // ★ 可出售性：IsSell 明确为 false 的不产出（表里可能缺该列，缺省视为可售）
  const isSell = row.IsSell;
  if (isSell !== undefined && isSell !== null && String(isSell).trim() !== "" &&
      String(isSell).toLowerCase() === "false") return [];
  const spec = String(row.SellPrice || "");
  if (!spec.trim()) return [];
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const out = [];
  // 格式：`ITEM:<货币id>x<数量>`，多段以换行分隔
  for (const seg of spec.split(/[\r\n]+/)) {
    const mm = /^\s*ITEM:([A-Za-z0-9_]+)x(\d+)\s*$/.exec(seg);
    if (!mm) continue;
    const id = mm[1];
    const amt = Number(mm[2]) * n;
    if (!id || !amt) continue;
    out.push({ sheet_type: 1, master_id: id, amount: amt });
  }
  return out;
}

/**
 * 护符的 Rarity 数值（与 AmuletGradeHitWeight.csv 的 Rarity 列对齐）。
 * R=2 / SR=3 / SSR=4 —— 与 Character.csv 的 Rarity 编码同一套。
 */
export function amuletRarityNum(masterAmuletId) {
  const m = String(masterAmuletId || "").match(/^Item_Amulet_(SSR|SR|R)_/);
  const k = m ? m[1] : "R";
  return k === "SSR" ? 4 : (k === "SR" ? 3 : 2);
}

let amuletSkillValCache = null, amuletGradeWtCache = null, amuletStatusValCache = null;

/**
 * 护符的「アビリティ等级」（grade）—— 按 Rarity 的命中权重抽取。
 *
 * ★★★ 权威数据源：`EquipmentEnchant/AmuletGradeHitWeight.csv`（3 行）★★★
 * ```
 *   Rarity | BeginnerGradeWeight | IntermediateGradeWeight | AdvancedGradeWeight | SpecialGradeWeight | SuperGradeWeight
 *     2(R) |        100         |           0            |          0          |         0          |        0        ⇒ grade 1（必然）
 *     3(SR)|          0         |         100            |          0          |         0          |        0        ⇒ grade 2（必然）
 *     4(SSR)|         0         |           0            |        600          |       325          |       75        ⇒ grade 3(60%) / 4(32.5%) / 5(7.5%)
 * ```
 * ★ 真机契约印证：`Item_Amulet_R_0001~0004` 的 grade 恒 {1}、`SR_0001~0004` 恒 {2}、
 *   `SSR_0001~0005` 为 {3,4,5} —— 与权重表完全一致。
 *
 * ★★ 为什么 grade 绝不能是 0（本缺陷的根因）★★
 *   客户端 `EquipmentEnchantDataStore.GetAmuletSkillInfo(grade, skillGroupId)`
 *   （Assembly-CSharp__96.cpp:20953，源 .cs:726-734）是：
 *     `AmuletSkillValueDictionary[grade][skillGroupId]`，**grade 查不到就
 *      AlterLog.LogError + return NULL**；
 *   而调用方 `PathUtility.GetAmuletFirstSkillIconPath`（.cs:485-487）对它做了
 *   `NullCheck` ⇒ **抛 NullReferenceException** ⇒ 炼成界面アミュレット列表
 *   **每一项都崩** ⇒ 表现为「列表空白 + 游戏卡死」。
 */
export function rollAmuletGrade(masterAmuletId) {
  try {
    if (!amuletGradeWtCache) amuletGradeWtCache = loadTable("EquipmentEnchant/AmuletGradeHitWeight.csv");
    const rows = (amuletGradeWtCache && amuletGradeWtCache.rows) || [];
    const rar = amuletRarityNum(masterAmuletId);
    const row = rows.find(function (r) { return Number(r.Rarity) === rar; });
    if (!row) return 1;
    const cand = [
      { g: 1, w: Number(row.BeginnerGradeWeight) || 0 },
      { g: 2, w: Number(row.IntermediateGradeWeight) || 0 },
      { g: 3, w: Number(row.AdvancedGradeWeight) || 0 },
      { g: 4, w: Number(row.SpecialGradeWeight) || 0 },
      { g: 5, w: Number(row.SuperGradeWeight) || 0 },
    ].filter(function (x) { return x.w > 0; });
    if (!cand.length) return 1;
    const total = cand.reduce(function (s, x) { return s + x.w; }, 0);
    let p = Math.random() * total;
    for (const x of cand) { p -= x.w; if (p <= 0) return x.g; }
    return cand[cand.length - 1].g;
  } catch (e) { return 1; }
}

/**
 * 在 [min, max] 内按 `LotteryRange`（步长）随机取一个值。
 *
 * ★ 真机实证（`AmuletSkillValue.csv` 的 LotteryRange 列）：
 * ```
 *   7100001 r=1    [1,3]     → 真机 3,4,5,6,7,8,9,10,12,14   （整数）
 *   7100003 r=2    [2,6]     → 真机 6,8,10,12,14,18,20,22…   （全偶数）
 *   7100009 r=0.5  [0.5,1.5] → 真机 1.5,2,2.5,3,3.5…         （半整数）
 *   7200002 r=10   [10,30]   → 真机 20,30,40,50…             （10 的倍数）
 * ```
 * ★ 浮点步长必须消尾差：0.5 步长直接累加会得到 1.5000000000000002，
 *   而真机是干净的 1.5 / 2.5 —— 故统一 `Math.round(v * 100) / 100`。
 */
function pickByRange(min, max, range) {
  const lo = Number(min) || 0, hi = Number(max) || 0, st = Number(range) || 0;
  if (!(hi > lo) || !(st > 0)) return lo;
  const steps = Math.floor((hi - lo) / st + 1e-9);
  const k = Math.floor(Math.random() * (steps + 1));
  return Math.round((lo + k * st) * 100) / 100;
}

/**
 * 护符的「アビリティ三件套」：skill_id / skill_effect_grade / skill_effect_value。
 *
 * ★ 数据链：
 *   ① skill_id  ← AbilityGroupId 候选池加权抽（见 rollAmuletSkillId）
 *   ② grade     ← Rarity 按 AmuletGradeHitWeight.csv 权重抽（见 rollAmuletGrade）
 *   ③ value     ← AmuletSkillValue.csv 的 (Grade, SkillGroupId) 行
 *                 的 [EffectValueMin, EffectValueMax] 内按 LotteryRange 步长抽
 *
 * ★ 三者要么一起有、要么一起无（skill_id 为 null 时 grade/value 恒 0）——
 *   真机 3741 个护符里「有 skill_id 但 grade=0」是 **0 个**（严格互斥）。
 *   我此前只滚了 skill_id、把 grade/value 写死 0 ⇒ 造出 168 个非法组合 ⇒
 *   客户端 GetAmuletSkillInfo(0, …) 返回 NULL ⇒ NullCheck 抛 NRE。
 */
export function rollAmuletSkillValue(grade, skillId) {
  try {
    if (!amuletSkillValCache) amuletSkillValCache = loadTable("EquipmentEnchant/AmuletSkillValue.csv");
    const rows = (amuletSkillValCache && amuletSkillValCache.rows) || [];
    const row = rows.find(function (r) {
      return Number(r.Grade) === Number(grade) && String(r.SkillGroupId) === String(skillId);
    });
    if (!row) return 0;
    return pickByRange(row.EffectValueMin, row.EffectValueMax, row.LotteryRange);
  } catch (e) { return 0; }
}

export function rollAmuletSkill(masterAmuletId) {
  const sid = rollAmuletSkillId(masterAmuletId);
  if (!sid) return { skill_id: null, skill_effect_grade: 0, skill_effect_value: 0 };
  const grade = rollAmuletGrade(masterAmuletId);
  return { skill_id: sid, skill_effect_grade: grade, skill_effect_value: rollAmuletSkillValue(grade, sid) };
}

/**
 * 护符的「ステータス三件套」。
 * ★ 权威表 `EquipmentEnchant/AmuletStatusValue.csv`（25 行 = 5 grade × 5 StatusType）。
 * ★ 真机实证：1858 个有 skill 的护符里只有 8 个带 status（0→1850），
 *   所以**默认不给 status 是符合真机的**（status 是合成继承来的，不是初始就有）。
 */
export function rollAmuletStatus(grade) {
  try {
    if (!amuletStatusValCache) amuletStatusValCache = loadTable("EquipmentEnchant/AmuletStatusValue.csv");
    const rows = (amuletStatusValCache && amuletStatusValCache.rows) || [];
    const cand = rows.filter(function (r) { return Number(r.Grade) === Number(grade); });
    if (!cand.length) return { status_type: 0, status_effect_value: 0, status_effect_grade: 0 };
    const row = cand[Math.floor(Math.random() * cand.length)];
    return {
      status_type: Number(row.StatusType) || 0,
      status_effect_value: pickByRange(row.PerMin, row.PerMax, row.LotteryRange),
      status_effect_grade: Number(grade) || 0,
    };
  } catch (e) { return { status_type: 0, status_effect_value: 0, status_effect_grade: 0 }; }
}

// ============================================================================
// ★★★ 护符（アミュレット）属性体系 —— 2026-10-22 用户报障 ★★★
//
// 用户原话：「アミュレット有没有和装备存在同样问题呢？即双属性词条但却是单属性，
//            我忘了アミュレット是几属性了，你查查」
//
// 结论：**护符是 2 属性**（HP + 物攻/物防/魔攻/魔防 之一），我们之前只写了 HP。
//
// 权威依据链（三条互相印证，缺一不可）：
//   ① 主数据 `Item/AmuletList.csv`：每件护符有 **两个** 属性槽
//        StatusType1/InitStatus1/UpStatus1 → 恒为 1(=Hp)
//        StatusType2/InitStatus2/UpStatus2 → 2/3/4/5 = 物攻/物防/魔攻/魔防
//      （例：SSR_0005 = Hp 68.75 +12.5/Lv、物攻 15 +1.88/Lv）
//   ② 真机契约 `contracts/user_load_user_data.json`（5958 件护符，逐件比对 100% 吻合）：
//        status_list[type=1] **恒有 2 个非零字段** = Hp + StatusType2 对应字段
//            Hp             = round(InitStatus1 + UpStatus1 × (Lv-1))
//            StatusType2 栏 = round(InitStatus2 + UpStatus2 × (Lv-1))
//        status_list[type=2] **恒为全 0**（5958/5958 —— 这一行是空槽）
//        status_list[type=3] = アビリティ2（status_type / status_effect_value），无则全 0
//            （5958/5958 与 status_type→字段映射、status_effect_value 逐位吻合）
//   ③ 契约 `baggage_synthesis_amulet`（SSR_0006 Lv20）：
//        row1 {Hp:306, MagicalAttack:51}、row3 {MagicalDefence:6.5}
//        = 68.75+12.5×19=306.25→306；15+1.88×19=50.72→51 ✓ 公式同样吻合
//
// ⇒ 我此前的 createAmulet 有 4 处错：
//    (1) 第 2 属性**整个丢失**（只写了 Hp）—— 用户看到的就是这个；
//    (2) 把 InitStatus2 塞进了 row2 的 **Hp** 字段（真机 row2 恒全 0）；
//    (3) 行里没有 PhysicalAndMagicalAttack 字段（客户端类声明里有）；
//    (4) 等级变化不重算 status_list（只改等级不重算＝界面上数值纹丝不动）。
//
// 另外：アビリティ两组由主数据的 AbilityGroupId1 / AbilityGroupId2 决定，二者互斥：
//   Ab1（1000/2000）→ スキル（skill_id 系）    ；Ab2（3000）→ ステータス（status_type 系）
//   真机 5958 件逐 master 核对：Ab1 组 status=0（个别例外来自合成继承），
//   Ab2 组 skill=0 —— 与 `EquipmentEnchant/AmuletRandomAbility.csv` 的分组完全一致。
// ============================================================================
let amuletLvTblCache = null, amuletBlTblCache = null, amuletRandAbCache = null;
function amuletLvTable() { if (!amuletLvTblCache) amuletLvTblCache = loadTable("Fusion/AmuletLevelUp.csv"); return amuletLvTblCache; }
function amuletBlTable() { if (!amuletBlTblCache) amuletBlTblCache = loadTable("Fusion/AmuletBreakLimit.csv"); return amuletBlTblCache; }
function amuletDef(masterAmuletId) {
  if (!amuletTblCache) amuletTblCache = loadTable("Item/AmuletList.csv");
  const rows = (amuletTblCache && amuletTblCache.rows) || [];
  return rows.find(function (r) { return String(r.ItemId) === String(masterAmuletId); }) || null;
}

/** 护符在指定限界突破档位的等级上限（`Fusion/AmuletBreakLimit.csv`）。
 *  真机契约实证：R/SR bl1 → 10；SSR bl2 → 20、bl3 → 30、bl5 → 50。 */
export function amuletMaxLevel(masterAmuletId, breakLimit) {
  const t = amuletBlTable();
  const rows = (t && t.rows) || [];
  const rarity = amuletRarityNum(masterAmuletId);
  const bl = Math.max(1, Number(breakLimit) || 1);
  const hit = rows.find(function (r) { return Number(r.Rarity) === rarity && Number(r.BreakLimitType) === bl; });
  if (hit) return Number(hit.MaxLevel) || 10;
  const base = rows.find(function (r) { return Number(r.Rarity) === rarity && Number(r.BreakLimitType) === 1; });
  return base ? (Number(base.MaxLevel) || 10) : 10;
}

/** 护符累计经验（`Fusion/AmuletLevelUp.csv`，与装备同口径：Σ NeedExp(1..lv)）。 */
export function amuletCumExp(rarity, lv) {
  const t = amuletLvTable();
  if (!t) return null;
  let sum = 0, found = false;
  for (const r of t.rows) {
    if (String(r.Rarity) !== String(rarity)) continue;
    const L = Number(r.Lv);
    if (L > lv) continue;
    sum += Number(r.NeedExp) || 0;
    found = true;
  }
  return found ? sum : null;
}
/** 曲线表里该 Rarity 的最大 Lv（满级 Lv+1）。 */
export function amuletCurveMaxLv(rarity) {
  const t = amuletLvTable();
  if (!t) return 51;
  let mx = 0;
  for (const r of t.rows) if (String(r.Rarity) === String(rarity)) mx = Math.max(mx, Number(r.Lv) || 0);
  return mx || 51;
}
/** 用累计经验求等级（满足 累计(Lv) <= exp 的最大 Lv，不超过 maxLevel）。 */
export function amuletLevelForCumExp(rarity, exp, maxLevel) {
  const curveMax = amuletCurveMaxLv(rarity);
  const ceiling = Math.min(Number(maxLevel) || curveMax, curveMax);
  let lv = 1;
  for (let L = 2; L <= ceiling; L++) {
    const need = amuletCumExp(rarity, L);
    if (need === null) break;
    if (Number(exp) < need) break;
    lv = L;
  }
  return lv;
}

/**
 * 构建护符的 status_list（三条：1=基础属性 / 2=空槽 / 3=アビリティ2）。
 * ★ 唯一实现 —— createAmulet / 强化升级 / 合成继承 / 一次性重建 全部走这里。
 */
const AMULET_STATUS_KEYS = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];

export function buildAmuletStatusList(masterAmuletId, level, statusType, statusValue) {
  const def = amuletDef(masterAmuletId);
  const lv = Math.max(1, Number(level) || 1);
  // ★ 键集必须与真机一致：**护符的行里没有 PhysicalAndMagicalAttack**（装备有）。
  //   5958 件护符逐行核对：键集恒为 {type,Hp,PhysicalAttack,PhysicalDefence,MagicalAttack,MagicalDefence,Technique}。
  const mkRow = function (type) {
    const row = { type: type };
    for (const k of AMULET_STATUS_KEYS) row[k] = 0;
    return row;
  };
  const row1 = mkRow(1), row2 = mkRow(2), row3 = mkRow(3);
  if (def) {
    for (const slot of [1, 2]) {
      const t = n(def["StatusType" + slot]);
      if (!t) continue;
      const key = statusKeyFor(t);
      if (!key) continue;
      const raw = n(def["InitStatus" + slot]) + n(def["UpStatus" + slot]) * (lv - 1);
      // ★ 取整与装备同一规则（四舍五入）：306.25→306、50.72→51（契约逐位吻合）
      row1[key] = (raw % 1 === 0) ? raw : Math.round(raw);
    }
  }
  const st = Number(statusType) || 0, sv = Number(statusValue) || 0;
  if (st && sv) { const k3 = statusKeyFor(st); if (k3) row3[k3] = sv; }
  return [row1, row2, row3];
}

/** 一次性重算【全部护符】的 status_list / max_level / max_exp（幂等）。 */
export function rebuildAllAmuletStatus(s) {
  const list = (((s.ItemList || {}).amulet_list) || []);
  let changed = 0;
  for (const a of list) {
    if (!a || !a.master_amulet_id) continue;
    let dirty = false;
    const next = buildAmuletStatusList(a.master_amulet_id, Number(a.current_level) || 1, a.status_type, a.status_effect_value);
    if (JSON.stringify(next) !== JSON.stringify(a.status_list)) { a.status_list = next; dirty = true; }
    const bl = Math.max(1, Number(a.break_limit) || 1);
    const ml = amuletMaxLevel(a.master_amulet_id, bl);
    if (Number(a.max_level) !== ml) { a.max_level = ml; dirty = true; }
    const rarity = amuletRarityNum(a.master_amulet_id);
    // ★ MaxExp 口径（真机 5958 件实证）：cum(min(Lv+1, 绝对满级 50))
    //   Lv1 → cum(2)=60 / Lv20(突破上限) → cum(21)=4940 / Lv50 → cum(50)=58240
    const nextLv = Math.min((Number(a.current_level) || 1) + 1, amuletCurveMaxLv(rarity) - 1);
    const me = amuletCumExp(rarity, nextLv);
    if (me !== null && Number(a.max_exp) !== me) { a.max_exp = me; dirty = true; }
    if (dirty) changed++;
  }
  return changed;
}

/**
 * 护符吃经验（与装备同口径：累计经验 → 等级，并在等级变化时重算 status_list）。
 * ★ 契约实证（baggage_enhance_amulet_by_item）：请求 2N+2R+2SSR = 30×2+120×2+2000×2 = 4300
 *   → 响应 target_amulet.current_exp = **4300**、current_level = **20**、max_exp = **4940**
 *   ⇒ 护符与装备共用同一套经验素材（N/R/SR/SSR）与同一套累计口径。
 */
export function enhanceAmuletByExp(target, gained) {
  if (!target || !(gained > 0)) return { gained: 0, levels: 0, beforeLv: target && target.current_level, afterLv: target && target.current_level };
  const rarity = amuletRarityNum(target.master_amulet_id);
  const maxLevel = amuletMaxLevel(target.master_amulet_id, Math.max(1, Number(target.break_limit) || 1));
  const beforeLv = Number(target.current_level) || 1;
  const cur = Number(target.current_exp) || 0;
  const next = cur + gained;
  let lv = amuletLevelForCumExp(rarity, next, maxLevel);
  if (lv > maxLevel) lv = maxLevel;
  const levelChanged = (lv !== beforeLv);
  target.current_level = lv;
  // ★ 与真机同一口径：MaxExp = cum(min(Lv+1, 50))；CurrentExp 恒 = min(累计, MaxExp)
  //   （契约实证：Lv20/20 → 4940/4300（未填满）；Lv50/50 → 58240/58240（填满））
  const nextLv = Math.min(lv + 1, amuletCurveMaxLv(rarity) - 1);
  const maxExp = amuletCumExp(rarity, nextLv);
  if (maxExp !== null) target.max_exp = maxExp;
  const capExp = Number(target.max_exp) || next;
  target.current_exp = Math.min(next, capExp);
  if (levelChanged) {
    target.status_list = buildAmuletStatusList(target.master_amulet_id, lv, target.status_type, target.status_effect_value);
  }
  return { gained: gained, levels: lv - beforeLv, beforeLv: beforeLv, afterLv: lv };
}

/**
 * アビリティ2（ステータス系）—— 由主数据 AbilityGroupId2 决定，无该组则返回全 0。
 * 数据链：AbilityGroupId2 → `AmuletRandomAbility.csv`(StatusType 1..5, 等权)
 *          → grade 按 Rarity 权重（`AmuletGradeHitWeight.csv`）
 *          → value 在 `AmuletStatusValue.csv`(Grade, StatusType) 的 [PerMin,PerMax] 内按 LotteryRange 抽。
 */
export function rollAmuletStatusFor(masterAmuletId) {
  const NONE = { status_type: 0, status_effect_value: 0, status_effect_grade: 0 };
  try {
    const def = amuletDef(masterAmuletId);
    if (!def) return NONE;
    const grp = Number(def.AbilityGroupId2) || 0;
    if (!grp) return NONE;
    if (!amuletRandAbCache) amuletRandAbCache = loadTable("EquipmentEnchant/AmuletRandomAbility.csv");
    const rows = (((amuletRandAbCache && amuletRandAbCache.rows) || []).filter(function (r) {
      return Number(r.AbilityGroupId) === grp && Number(r.StatusType) > 0;
    }));
    if (!rows.length) return NONE;
    const total = rows.reduce(function (s2, r) { return s2 + (Number(r.Rate) || 0); }, 0);
    let p = Math.random() * total, pick = rows[rows.length - 1];
    for (const r of rows) { p -= (Number(r.Rate) || 0); if (p <= 0) { pick = r; break; } }
    const type = Number(pick.StatusType) || 0;
    const grade = rollAmuletGrade(masterAmuletId);
    if (!amuletStatusValCache) amuletStatusValCache = loadTable("EquipmentEnchant/AmuletStatusValue.csv");
    const row = (((amuletStatusValCache && amuletStatusValCache.rows) || []).find(function (r) {
      return Number(r.Grade) === Number(grade) && Number(r.StatusType) === type;
    })) || null;
    return {
      status_type: type,
      status_effect_value: row ? pickByRange(row.PerMin, row.PerMax, row.LotteryRange) : 0,
      status_effect_grade: grade,
    };
  } catch (e) { return NONE; }
}

export function createAmulet(instanceId, masterAmuletId, nowSec) {
  const breakLimit = 1;
  const maxLevel = amuletMaxLevel(masterAmuletId, breakLimit);
  const maxExp = amuletCumExp(amuletRarityNum(masterAmuletId), 2);   // 累计到 Lv2 = 升到下一级所需
  // ★ アビリティ两组（主数据互斥：Ab1=スキル / Ab2=ステータス），各滚各的；没有就全 0。
  const skill = rollAmuletSkill(masterAmuletId);
  const st = rollAmuletStatusFor(masterAmuletId);
  return {
    id: instanceId,
    master_amulet_id: masterAmuletId,
    max_level: maxLevel,
    current_level: 1,
    max_exp: (maxExp === null ? 20 : maxExp),
    current_exp: 0,
    max_break_limit_count: 5,
    break_limit: breakLimit,
    owner_character_category: 0,
    owner_character_id: null,
    has_locked: false,
    date_of_acquisition: nowSec || Math.floor(Date.now() / 1000),
    ...skill,
    ...st,
    status_list: buildAmuletStatusList(masterAmuletId, 1, st.status_type, st.status_effect_value),
  };
}

// ---------- 装备强化（经验素材 → 等级）----------
//
// ★★★ 权威数据链（2026-10-14 新增）★★★
//
// 用户报障：「装备强化没反应」。真因有三：
//   ① 请求字段名读错：真机是 `itemMasterId` + `itemCount`，
//      我读的是 `itemId` / `requestCount` ⇒ 恒取不到 → 什么都没发生。
//   ② 经验值硬编码 `gained += 100 * use`，而权威来源是
//      `Item/MaterialList.csv` 的 `EffectValue`：
//        N=30 / R=120 / SR=480 / SSR=2000（Abyss 系列同值）
//   ③ 只加 CurrentExp、**从不判断升级**（也不会把经验截到 MaxExp）。
//
// 契约实证（baggage_enhanceEquipmentByItem）：
//   请求 N×2 + R×2 + SR×0 + SSR×2
//   → 30×2 + 120×2 + 2000×2 = **4300** = 响应里的 CurrentExp ✓ 逐位吻合
//
// 升级曲线 Fusion/EquipmentLevelUp.csv：(Rarity, Lv) → NeedExp（**累计经验**，
//   单调递增：SSR lv1=0 / lv2=60 / … / lv20=420 / … / lv30=3410）。
//   ⇒ 等级 = 满足 NeedExp(Lv) <= exp 的最大 Lv。
export function equipmentExpForItem(itemMasterId) {
  const t = matTable();
  if (!t) return 0;
  const r = t.rows.find(function (x) { return (x.ItemId || x["アイテムID"]) === itemMasterId; });
  return r ? (Number(r.EffectValue) || 0) : 0;
}
/**
 * ★★★ 2026-10-22 用户报障：「装备最大强化不扣金币」★★★
 * 权威：Item/MaterialList.csv 的 **GoldCost** 列（每 1 个素材的强化手续费）
 *   Item_Material_Equipment_Exp_N   → ITEM:Item_Currency_Goldx600    （30 exp  ×20）
 *   Item_Material_Equipment_Exp_R   → x2400   （120 exp ×20）
 *   Item_Material_Equipment_Exp_SR  → x9600   （480 exp ×20）
 *   Item_Material_Equipment_Exp_SSR → x40000  （2000 exp ×20）
 *   Abyss_* 同值（EquipmentLevelUp=2，用于深渊装备，同样收手续费）
 * 即「20 金币 / 1 点装备经验」。没配 GoldCost 的素材返回 0。
 */
export function goldCostForItem(itemMasterId) {
  try {
    const t = loadTable("Item/MaterialList.csv");
    const r = ((t && t.rows) || []).find(function (x) { return String(x.ItemId) === String(itemMasterId); });
    if (!r) return 0;
    const m = String(r.GoldCost || "").match(/x(\d+)$/);
    if (m) return Number(m[1]) || 0;
    return 0;
  } catch (e) { return 0; }
}


/**
 * ★★★ 装备升级曲线的【累计经验】语义（2026-10-14 实证破解）★★★
 *
 * `Fusion/EquipmentLevelUp.csv`：(Rarity, Lv) → NeedExp。
 * **NeedExp 是「升到该级所需付出的经验」，不是累计值** ——
 * 累计 = Σ(NeedExp over lv=1..N)。
 *
 * 真机对照（_winr_capture/contracts_winr/user_load_user_data.json，3415 件装备）：
 * ```
 *   MaxLevel=20 → MaxExp= 4940  = 累计到 lv21 ✓
 *   MaxLevel=30 → MaxExp=13430  = 累计到 lv31 ✓   (另一档 10520 = 累计到 lv30，见下)
 *   MaxLevel=40 → MaxExp=30640  = 累计到 lv41 ✓
 *   MaxLevel=50 → MaxExp=58240  = 累计到 lv51 ✓   （曲线表最大 Lv 恰好是 51）
 * ```
 * ⇒ **满级 Lv N 的 MaxExp = 累计到 Lv N+1**（末级与后一级的差当作满级后的溢出上限）。
 *   这条同时解释了「为什么曲线表只有 lv1~51 而装备最高 50 级」。
 *
 * 而 `CurrentExp = 4300` = **累计到 lv20**（契约那件的 CurrentLevel=20）——
 *   说明 CurrentExp 也是【累计口径】，与 MaxExp 同一坐标系。
 */
export function equipmentCumExp(rarity, lv) {
  const t = eqLvTable();
  if (!t) return null;
  let sum = 0, found = false;
  for (const r of t.rows) {
    if (String(r.Rarity) !== String(rarity)) continue;
    const L = Number(r.Lv);
    if (L > lv) continue;
    sum += Number(r.NeedExp) || 0;
    found = true;
  }
  return found ? sum : null;
}

/** 按 (Rarity, Lv) 取该级的 NeedExp（升级该级所需经验）。 */
export function equipmentNeedExp(rarity, lv) {
  const t = eqLvTable();
  if (!t) return null;
  const r = t.rows.find(function (x) {
    return String(x.Rarity) === String(rarity) && String(x.Lv) === String(lv);
  });
  return r ? (Number(r.NeedExp) || 0) : null;
}

/** 曲线表里该 Rarity 的最大 Lv（= 装备可强化到的最高级 + 1）。 */
export function equipmentCurveMaxLv(rarity) {
  const t = eqLvTable();
  if (!t) return 51;
  let mx = 0;
  for (const r of t.rows) if (String(r.Rarity) === String(rarity)) mx = Math.max(mx, Number(r.Lv) || 0);
  return mx || 51;
}

/**
 * 用「累计经验」求等级：满足 累计(Lv) <= exp 的最大 Lv（不超过 maxLevel）。
 */
export function equipmentLevelForCumExp(rarity, exp, maxLevel) {
  const curveMax = equipmentCurveMaxLv(rarity);
  const ceiling = Math.min(Number(maxLevel) || curveMax, curveMax);
  let lv = 1;
  for (let L = 2; L <= ceiling; L++) {
    const need = equipmentCumExp(rarity, L);
    if (need === null) break;
    if (Number(exp) < need) break;
    lv = L;
  }
  return lv;
}

/**
 * 用经验素材强化一件装备（收口：路由只调这一个函数）。
 *
 * ★ 契约实证（baggage_enhanceEquipmentByItem）：
 *   请求 N×2 + R×2 + SR×0 + SSR×2 → 30×2+120×2+2000×2 = **4300**
 *   响应 CurrentExp = **4300** ✓ 逐位吻合
 *
 * @returns {{gained:number, levels:number, beforeLv:number, afterLv:number}}
 */