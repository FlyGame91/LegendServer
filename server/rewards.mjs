// 任务奖励解析器：按【请求入参】从 MasterData 算出真实奖励，而不是回放固定快照。
//
// 数据链（全部来自 MasterData）：
//   mission_id (如 DailyMission_LoginTime_01)
//     -> Mission/NormalMissionContent.csv  取 RewardId 列 (Reward_DailyMission_LoginTime_01)
//       -> Reward/RewardList.csv           取 RewardTableId
//         -> Reward/DecisionRewardTable.csv 取 (SheetType, RewardItemId, Count) 列表
import { loadTable } from "./masterdata.mjs";

let contentTbl = null;
let beginnerContentTbl = null;
let limitedContentTbl = null;
let rewardListTbl = null;
let rewardTableTbl = null;
let randomRewardTbl = null;
let rewardBoxTbl = null;

function ensureLoaded() {
  if (contentTbl) return;
  contentTbl = loadTable("Mission/NormalMissionContent.csv");
  beginnerContentTbl = loadTable("Mission/BeginnerMissionContent.csv");
  limitedContentTbl = loadTable("Mission/LimitedMissionContent.csv");
  rewardListTbl = loadTable("Reward/RewardList.csv");
  rewardTableTbl = loadTable("Reward/DecisionRewardTable.csv");
  // ★ 掉落类奖励走 RandomRewardTable（带 Weight 权重），不是 DecisionRewardTable。
  //   判据：RewardList 的 RewardType —— 1=Decision(固定) / 2=Random(权重随机) / 3=Display(仅展示)。
  //   实证：Reward_Drop_Main_001_01_m 的两个子表 RewardType 全是 2，
  //         内容在 RandomRewardTable（{RewardTableId, SheetType, RewardItemId, Count, Weight}）。
  //   早期只读 DecisionRewardTable → 掉落永远解析为空。
  randomRewardTbl = loadTable("Reward/RandomRewardTable.csv");
  // ★ 掉落箱表：DropBox_* 是「再抽一次的箱」，需二次加权展开（见 expandDropBox）
  rewardBoxTbl = loadTable("Reward/RewardBoxTable.csv");
  buildIndexes();
}

// ==================== 索引（2026-10-22）====================
// RewardList 5.1 万行 / Random 3.9 万行 / Decision 1.7 万行。
// 原来每个子表都要全表扫描一遍 —— まとめてskip 跳 N 次时是 O(N × 9 万行)。
// 索引后单次解析只碰命中的几十行，且语义完全不变。
let subsByRewardId = null;    // RewardId -> [{tableId, type, count}]
let randomByTable = null;     // RewardTableId -> [row]
let decisionByTable = null;   // RewardTableId -> [row]
let boxByDropBox = null;      // DropBoxId -> [row]

function buildIndexes() {
  subsByRewardId = new Map();
  for (const r of ((rewardListTbl && rewardListTbl.rows) || [])) {
    const id = String(pick(r, ["RewardId", "報酬ID"]) || "");
    if (!id) continue;
    const tid = pick(r, ["RewardTableId", "報酬テーブルID"]);
    if (!tid) continue;
    const type = Number(pick(r, ["RewardType", "報酬タイプ"]) || 0);
    const cnt = Number(pick(r, ["LotteryCount", "抽選回数"]) || 0) || 1;
    if (!subsByRewardId.has(id)) subsByRewardId.set(id, []);
    subsByRewardId.get(id).push({ tableId: String(tid), type, count: cnt });
  }
  randomByTable = new Map();
  for (const r of ((randomRewardTbl && randomRewardTbl.rows) || [])) {
    const tid = String(pick(r, ["RewardTableId", "報酬テーブルID"]) || "");
    if (!tid) continue;
    if (!randomByTable.has(tid)) randomByTable.set(tid, []);
    randomByTable.get(tid).push(r);
  }
  decisionByTable = new Map();
  for (const r of ((rewardTableTbl && rewardTableTbl.rows) || [])) {
    const tid = String(pick(r, ["RewardTableId", "報酬テーブルID"]) || "");
    if (!tid) continue;
    if (!decisionByTable.has(tid)) decisionByTable.set(tid, []);
    decisionByTable.get(tid).push(r);
  }
  boxByDropBox = new Map();
  for (const r of ((rewardBoxTbl && rewardBoxTbl.rows) || [])) {
    const id = String(pick(r, ["DropBoxId", "ドロップボックスID"]) || "");
    if (!id) continue;
    if (!boxByDropBox.has(id)) boxByDropBox.set(id, []);
    boxByDropBox.get(id).push(r);
  }
}

/** RewardType=1（固定奖励）表的全部行：
 *  ① 表在 DecisionRewardTable → 全部行直接发；
 *  ② 表只在 RandomRewardTable → 也视为「固定清单」全部发（全库 8 条，形如
 *     Main_014_05_m_Box_01 → DropBox_Equipment_SR_Weapon x1 w10000），但 DropBox_* 必须展开。 */
function fixedRowsOf(tableId) {
  ensureLoaded();
  const dec = decisionRowsOf(tableId);
  if (dec.length) return dec;
  const out = [];
  for (const r of (randomByTable.get(String(tableId)) || [])) {
    const itemId = String(pick(r, ["RewardItemId", "アイテムID"]) || "").trim();
    if (!itemId) continue;
    const cnt = Number(pick(r, ["Count", "個数"]) || 1) || 1;
    const sheet = Number(pick(r, ["SheetType", "シートタイプ"]) || 1) || 1;
    const item = derefDropBox({ sheet_type: sheet, master_id: itemId, amount: cnt });
    if (item) out.push(item);
  }
  return out;
}

/** DecisionRewardTable 里某张表的【全部固定行】（RewardType=1 用）。 */
function decisionRowsOf(tableId) {
  ensureLoaded();
  const out = [];
  for (const r of (decisionByTable.get(String(tableId)) || [])) {
    const itemId = String(pick(r, ["RewardItemId", "アイテムID"]) || "").trim();
    if (!itemId) continue;
    const cnt = Number(pick(r, ["Count", "個数"]) || 1) || 1;
    const sheet = Number(pick(r, ["SheetType", "シートタイプ"]) || 1) || 1;
    out.push({ sheet_type: sheet, master_id: itemId, amount: cnt });
  }
  return out;
}

/** 从一行里按候选字段名取值（MasterData 的英文列名可能有细微差异）。 */
function pick(row, names) {
  for (const n of names) if (row[n] !== undefined && row[n] !== "") return row[n];
  return null;
}

/** mission_id -> RewardId（如 Reward_DailyMission_LoginTime_01）。 */
export function rewardIdForMission(missionId) {
  ensureLoaded();
  // ★ 2026-10-22：初心者ミッション的内容在 Mission/BeginnerMissionContent.csv（35 条），
  //   早期只查 NormalMissionContent → 初心者任务的 RewardId 解析为 null → 领奖拿到空。
  const tables = [contentTbl, beginnerContentTbl, limitedContentTbl].filter(Boolean);
  let row = null;
  for (const tb of tables) {
    row = tb.rows.find((r) => Object.values(r).some((v) => String(v) === missionId));
    if (row) break;
  }
  if (!row) return null;
  if (!row) return null;
  // RewardId 列在日文表头里是「報酬ID」；英文表头可能被引号/换行破坏，故按值形态找。
  for (const k of Object.keys(row)) {
    const v = String(row[k] || "");
    if (v.startsWith("Reward_")) return v;
  }
  return null;
}

/** RewardId -> [{ sheetType, itemId, count }]。 */
export function rewardsForRewardId(rewardId) {
  ensureLoaded();
  const out = [];
  const seen = new Set();
  const tableIds = [rewardId];
  if (rewardListTbl) {
    for (const r of rewardListTbl.rows) {
      const id = pick(r, ["RewardId", "報酬ID"]);
      if (id !== rewardId) continue;
      const t = pick(r, ["RewardTableId", "報酬テーブルID"]);
      if (t && tableIds.indexOf(t) < 0) tableIds.push(t);
    }
  }
  // 两张表都扫：DecisionRewardTable（固定奖励）与 RandomRewardTable（权重随机掉落）。
  const scan = function (tbl, isRandom) {
    if (!tbl) return;
    for (const r of tbl.rows) {
      const tid = pick(r, ["RewardTableId", "報酬テーブルID"]);
      if (tableIds.indexOf(tid) < 0) continue;
      const itemId = pick(r, ["RewardItemId", "アイテムID"]);
      const count = pick(r, ["Count", "個数"]);
      const sheet = pick(r, ["SheetType", "シートタイプ"]);
      if (!itemId) continue;
      const weight = isRandom ? Number(pick(r, ["Weight", "重み"]) || 0) : null;
      // 去重键含 weight，避免同一道具的不同权重档被误合并
      const key = tid + "|" + itemId + "|" + count + "|" + (weight === null ? "" : weight);
      if (seen.has(key)) continue;
      seen.add(key);
      const o = { sheetType: sheet ? Number(sheet) : 1, master_id: itemId, amount: count ? Number(count) : 1 };
      if (isRandom) o.weight = weight;
      out.push(o);
    }
  };
  scan(rewardTableTbl, false);
  scan(randomRewardTbl, true);
  return out;
}

/**
 * ★★ 掉落掷骰 —— 掉落奖励的正确语义（契约实证）。
 *
 * 与 rewardsForRewardId 的关键区别：
 *   rewardsForRewardId 返回【候选池】（用于展示提供割合之类），
 *   本函数返回【掷骰后的结果】—— 每个 RandomRewardTable 子表按 Weight 加权抽 1 条。
 *
 * 契约实证（quest/skip 的 MasterQuest_Soldier_05）：
 *   DropRewardId = Reward_Drop_Mquest_Soldier_005，其 RewardList 有 11 个子表
 *   （10 个 RewardType=2 的随机子表 + 1 个 RewardType=3 的展示子表），
 *   每个子表 LotteryCount=1 → 契约的 normal_drop_list 正好 **11 条**。
 *   ⇒ 语义 = 「每个子表掷 1 次骰」，不是「把所有候选都发」。
 *
 * 早期我直接用 rewardsForRewardId → 把子表 1 的 10 个权重档全发了（10 条），
 * 用户实测表现为「襲来跳过只给魂」（魂是子表 1 权重最高的那条，其余是同一子表的其他档）。
 *
 * @param rewardId Quest/表的 DropRewardId
 * @returns 掷骰结果数组 [{sheet_type, master_id, amount}]
 */
export function rollRewardId(rewardId) {
  return resolveRewardId(rewardId);
}

/**
 * ★★★ 2026-10-22：奖励结算的【唯一正确入口】★★★
 *
 * RewardList 的每一行是一个「子表」，RewardType 决定语义（权威：RewardList.csv）：
 *   type 1 = Decision（固定奖励）  → **整张表的每一行都要发**
 *   type 2 = Random（权重随机）    → **按 Weight 抽 LotteryCount 次**（空行=不掉落档）
 *   type 3 = Display（仅展示）     → 不发
 *
 * 旧实现只认 type 2 的掷骰，type 1 也走 pickOneFromTable（只取一行）→ 多行固定奖励被吞掉；
 * 而 granting 路径（首通/任务/登录奖励）又走 rewardsForRewardId（整张表全发）→
 * 带 type 2 子表的奖励（追憶の塔 25/50/80、限定任务等）会把随机池整个送出去。
 * 现在统一到这里：所有发奖路径都必须用本函数，返回的就是「真实该发的清单」。
 */
export function resolveRewardId(rewardId) {
  ensureLoaded();
  const out = [];
  const subs = subsByRewardId.get(String(rewardId)) || [];
  if (!subs.length) {
    // 没有子表定义 → 退化为「按单表解析」（保持旧行为，避免空掉落）
    return rewardsForRewardId(rewardId);
  }
  for (const sub of subs) {
    if (sub.type === 3) continue;               // 展示用，不发放
    if (sub.type === 2) {
      for (let n = 0; n < sub.count; n++) {
        const picked = derefDropBox(pickOneFromTable(sub.tableId));
        if (picked) out.push(picked);
      }
      continue;
    }
    // type 1（含未知类型）：固定奖励 → 全给（Decision 表 / 少数写在 Random 表里的固定清单）
    for (const x of fixedRowsOf(sub.tableId)) out.push(x);
  }
  return out;
}

/** 从某个 RewardTableId 按 Weight 加权抽 1 条（Decision 表无 Weight 时取第一条）。 */
/**
 * 展开掉落箱 —— RewardBoxTable 的 (DropBoxId → [SheetType, RewardItemId, Count, Weight])。
 * 权威依据：RandomRewardTable 里的 reward_item_id 可能是 DropBox_* 形态
 *   （如 DropBox_Equipment_SR_Equip_Soldier），它在 RewardBoxTable 里定义了
 *   「再按权重抽一件真实装备」（实测 22 条候选）。
 * 若不展开，客户端会拿到名为 DropBox_* 的「道具」—— 该 id 在主数据里不是道具 → 显示异常。
 */
function expandDropBox(dropBoxId) {
  if (!rewardBoxTbl) return null;
  const pool = [];
  let total = 0;
  for (const r of (boxByDropBox.get(String(dropBoxId)) || [])) {
    const itemId = pick(r, ["RewardItemId", "アイテムID"]);
    if (!itemId) continue;
    const w = Number(pick(r, ["Weight", "重み"]) || 0);
    const cnt = Number(pick(r, ["Count", "個数"]) || 1) || 1;
    const sheet = Number(pick(r, ["SheetType", "シートタイプ"]) || 1) || 1;
    pool.push({ sheet_type: sheet, master_id: itemId, amount: cnt, w: w });
    total += w;
  }
  if (!pool.length) return null;
  if (total <= 0) return { sheet_type: pool[0].sheet_type, master_id: pool[0].master_id, amount: pool[0].amount };
  let x = Math.random() * total;
  for (const p of pool) { x -= p.w; if (x <= 0) return { sheet_type: p.sheet_type, master_id: p.master_id, amount: p.amount }; }
  const last = pool[pool.length - 1];
  return { sheet_type: last.sheet_type, master_id: last.master_id, amount: last.amount };
}

/** 若抽到的是 DropBox_*，递归展开成真实道具（最多 5 层，防环）。 */
function derefDropBox(item) {
  let cur = item;
  for (let d = 0; d < 5; d++) {
    if (!cur || !/^DropBox_/.test(String(cur.master_id || ""))) return cur;
    const nx = expandDropBox(cur.master_id);
    if (!nx) return null;   // 箱内无候选 → 不发放（不产生名为 DropBox_ 的假道具）
    cur = nx;
  }
  return cur;
}

function pickOneFromTable(tableId) {
  // ★★★ 2026-10-22 修正（用户报障：「爆率不对，耳环我记得概率特别低」）★★★
  //   权威数据：Reward/RandomRewardTable.csv 里「稀有物品 + 空行」是同一张加权表的两档，例如
  //     Reward_Drop_Ccq_aerial_sorcerer_01_04:
  //        Item_Equipment_SSR_0247  Weight=1
  //        (空 RewardItemId)        Weight=9999      ← 「不掉落」这一档
  //   旧实现 if (!itemId) continue; 把「不掉落」档整行丢掉 ⇒ 池子里只剩稀有物品
  //   ⇒ 概率从 1/10000 变成 100%。全库 617 张表都有这种空行，影响的是所有掉落。
  //   正确语义：空行 = 一次「什么都没抽到」的结果，权重必须计入。
  const pool = [];
  let total = 0;
  for (const r of (randomByTable.get(String(tableId)) || [])) {
    const itemId = String(pick(r, ["RewardItemId", "アイテムID"]) || "").trim();
    const w = Number(pick(r, ["Weight", "重み"]) || 0);
    if (!itemId && !(w > 0)) continue;          // 既无道具又无权重 → 纯排版行，忽略
    const cnt = Number(pick(r, ["Count", "個数"]) || 1) || 1;
    const sheet = Number(pick(r, ["SheetType", "シートタイプ"]) || 1) || 1;
    pool.push({ sheet_type: sheet, master_id: itemId, amount: itemId ? cnt : 0, w: w });
    total += w;
  }
  if (pool.length) {
    let picked = null;
    if (total <= 0) picked = pool.find(function (x) { return x.master_id; }) || null;
    else {
      let x = Math.random() * total;
      picked = pool[pool.length - 1];
      for (const p of pool) { x -= p.w; if (x <= 0) { picked = p; break; } }
    }
    if (!picked || !picked.master_id) return null;   // 「不掉落」档
    return { sheet_type: picked.sheet_type, master_id: picked.master_id, amount: picked.amount };
  }
  // 无 Random 表 → 查 Decision 表（取第一行；全部行请用 decisionRowsOf）
  const dec = decisionRowsOf(tableId);
  return dec.length ? dec[0] : null;
}

/** 按请求里的 mission_id_list 汇总奖励。 */
/**
 * 汇总多个任务的奖励。
 *
 * ★ 2026-09-30 修正：新增 skipReceived 选项。
 *   缺陷：mission/receive_reward **完全没检查 IsReceived** →
 *     「デイリー報酬」可无限重复领取（用户实测报障）。
 *   客户端只在【已达成且未领取】的任务上显示可领按钮，
 *   而服务端不校验 → 同一 mission_id 反复调用就能反复得奖。
 *   ⇒ 服务端必须自己把关（不能信任客户端的按钮状态）。
 *
 * @param {string[]} missionIds
 * @param {{skipReceived?: boolean, isReceived?: (id:string)=>boolean}} [opts]
 *        skipReceived=true 时跳过已领取的任务（写路径应传 true）
 */
export function rewardsForMissions(missionIds, opts) {
  const o = opts || {};
  const agg = new Map();
  const per = [];
  for (const id of missionIds || []) {
    // ★★ 双重把关（2026-10-08 补）★★
    //   ① 已领取 → 跳过（幂等）
    //   ② **未达成 → 跳过** —— 这是我漏掉的一条，实测可「领没打过的任务奖励」：
    //        找一个 IsAchieved=false 的任务（AchievementMission_Amulet_Star_04）调用
    //        mission/receive_reward → 真的发了 Item_Stone_Free x50。
    //      客户端只在「已达成且未领取」的任务上显示领取按钮，
    //      但**服务端不能信任客户端的按钮状态**（同 skill_coin 那次教训），必须自己校验。
    if (o.skipReceived && typeof o.isReceived === "function" && o.isReceived(id)) {
      per.push({ missionId: id, rewardId: null, items: [], skipped: "already_received" });
      continue;
    }
    if (o.skipNotAchieved && typeof o.isAchieved === "function" && !o.isAchieved(id)) {
      per.push({ missionId: id, rewardId: null, items: [], skipped: "not_achieved" });
      continue;
    }
    const rid = rewardIdForMission(id);
    const list = rid ? resolveRewardId(rid) : [];
    per.push({ missionId: id, rewardId: rid, items: list });
    for (const it of list) {
      const k = it.sheetType + "|" + it.master_id;
      const cur = agg.get(k);
      if (cur) cur.amount += it.amount;
      else agg.set(k, { sheet_type: it.sheetType, master_id: it.master_id, amount: it.amount });
    }
  }
  return { list: [...agg.values()], per };
}