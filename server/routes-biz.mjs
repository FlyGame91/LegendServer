// 业务写接口：按【请求入参】修改状态并返回真实结果。
//
// 设计原则（针对上一版的核心缺陷）：
//   1) 每个路由都解析 req.body —— 绝不忽略入参；
//   2) 结果由 MasterData + 当前状态推导，不回放固定快照；
//   3) 成功后 markDirty() 持久化，保证读接口能读到新状态；
//   4) 响应结构必须与录制契约一致（字段名/嵌套），否则客户端反序列化失败。
import { route, ok, err, shaped, shapeOf, okShaped } from "./server.mjs";
import { rewardsForMissions, rewardsForRewardId, resolveRewardId } from "./rewards.mjs";
import { dailyMissionRewardMultiplier, missionGroupOf } from "./campaign.mjs";
import { loadTable } from "./masterdata.mjs";
// ★ 2026-10-22 修：shop/exchange 里用了 fragmentItemFor/fragmentCountFor 但从未 import
//   ⇒ [ROUTE-EXC] ReferenceError: fragmentItemFor is not defined（该端点整体 500）。
import { fragmentItemFor, fragmentCountFor } from "./character.mjs";
import { getState, markDirty, applyRewards, toItemFormatList, playerAllAssetFor, findMission, canReceiveMissionReward, markMissionReceived, addItem, addStone, getItemAmount, findCharacter, itemsFromRequest, flushNow, touchedPlayerAllAsset, touchedPlayerAssets, consumeItems } from "./state.mjs";

function parse(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch (e) { return {}; }
}

/** 领奖类响应共用的字段集合（与契约一致）。 */
// reqBody 由调用方传入（可选）—— 用于推断「本次涉及的道具」。
// 早期误写成直接引用调用方的 req，导致 baggage/enchantEquipmentStart 等
// 走 stateOnly/assetEnvelope 的端点抛 "req is not defined"。
function assetEnvelope(applied, extra, reqBody) {
  const s = getState();
  const touched = applied.map(function (a) { return a.master_id; });
  const out = {
    item_format_list: toItemFormatList(applied),
    present_item_format_list: [],
    player_all_asset: touchedPlayerAssets(),
    notification: [],
    userData: s.UserData,
  };
  if (extra) for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

// ============================ 任务领奖 ============================
// 请求：{ mission_type, mission_id_list: [...] }
// 之前忽略入参 → 点 1 个任务返回录制时的 13 份奖励。现在按入参逐个解析并汇总。
route("mission/receive_reward", function (ctx) {
  const req = parse(ctx.body);
  const ids = Array.isArray(req.mission_id_list) ? req.mission_id_list : [];
  if (!ids.length) {
    // 空入参：仍返回契约形状（不能 500，也不能 alterCode）——
    // 早期这里用 assetEnvelope，形状与契约不一致。
    const s0 = getState();
    flushNow();
    return okShaped(ctx.path, {
      item_format_list: [],
      present_item_format_list: [],
      player_all_asset: touchedPlayerAssets(),
      notification: [],
      userData: s0.UserData,
      MissionProgressList: [],
      limited_mission_progress_list: [],
    });
  }

  // ★ 过滤已领取的任务（防无限重复领取）—— 服务端必须自己把关
  // ★ 用收口的「领取资格」判定（未达成 / 已领取 / 不存在 都不发奖）
  const { list } = rewardsForMissions(ids, {
    skipReceived: true,
    isReceived: function (id) { return !canReceiveMissionReward(id).ok; },
  });

  // ★★ 活动：デイリーミッション报酬倍率（DAILY_MISSION_REWARD_MUL, Content=6）★★
  //   反编译 + 表数据确认：当前活动 `[509] Cat=11 Content=6 Val=3`，
  //   CategoryFilter 指向 MissionGroup_*（如 MissionGroup_LoginTime_01）。
  //   ★ 作用对象：奖励里的 `Item_Direct_Stamina`（体力直接发放项）。
  //     实证：DailyMission_LoginTime_01 → Reward_DailyMission_LoginTime_01
  //          → [{sheetType:1, master_id:"Item_Direct_Stamina", amount:240}]
  //          → 活动 3 倍 → 720（与游戏内「スタミナ報酬3倍」一致）。
  //   诚实标注：反编译只给出「存在 Content=6 的倍率活动」与 Category/CategoryFilter 语义，
  //     未逐行确认它作用在哪个奖励项上；我按「体力类奖励项」处理（最符合文案）。
  // ★★ 纠错（2026-10-08）：倍率只能作用【一次】，不能按 mission 数重复累乘 ★★
  //   我第一版写成「对每个 mission id 遍历整个 list 各乘一次」——
  //   于是双任务时同一份奖励被乘了 2 次（×3 × ×3 = ×9）：
  //     实测 DailyMission_Sub_01 + DailyMission_Invasion_01 → 期望 600，实际 1800。
  //   正确做法：**对每个奖励项，取「它所属 mission 的倍率」**，每个项只乘一次。
  //   实现：先按 master_id 反查它来自哪个 mission（同一 id 可能多个 mission 都给，
  //   取【最大倍率】——奖励已按 id 聚合，无法再拆分，取最大是最符合玩家预期的近似）。
  try {
    const multByItem = new Map();
    for (const id of ids) {
      const mult = dailyMissionRewardMultiplier(missionGroupOf(id));
      if (mult <= 1) continue;
      for (const item of list) {
        const cur = multByItem.get(item.master_id) || 1;
        if (mult > cur) multByItem.set(item.master_id, mult);
      }
    }
    for (const item of list) {
      const mult = multByItem.get(item.master_id) || 1;
      if (mult > 1) item.amount = Math.max(1, Math.round((Number(item.amount) || 0) * mult));
    }
  } catch (e) { /* 活动加成失败不应影响奖励本身 */ }
  // 记录体力变化：契约的 notification 是 [{ type:"stamina", before, after }]，
  // 用于客户端弹「体力 +N」提示。早期写死空数组，通知永远不显示。
  const staminaBefore = getState().UserData.stamina || 0;
  const applied = applyRewards(list);
  const staminaAfter = getState().UserData.stamina || 0;

  // 标记为已领取，防止重复领取。
  const progressed = [];
  for (const id of ids) {
    markMissionReceived(id);
    const m = findMission(id);
    if (m) progressed.push(m);
  }
  console.log("[mission] receive " + ids.length + " -> " + applied.length + " reward kinds");
  flushNow();   // 领奖是关键操作：立即落盘
  // 以契约形状为基板，只覆盖本次真正变化的字段，保证字段集永不缺失。
  const s = getState();
  return okShaped(ctx.path, {
    item_format_list: toItemFormatList(applied),
    present_item_format_list: [],
    player_all_asset: touchedPlayerAssets(),
    notification: [],
    userData: s.UserData,
    MissionProgressList: progressed,
    limited_mission_progress_list: [],
  });
});

// ============================ 礼物领取 ============================
// 请求：{ presentIdList: [...] }。返回被领取的 present 与剩余数量。
route("present/receive", function (ctx) {
  const req = parse(ctx.body);
  const ids = Array.isArray(req.presentIdList) ? req.presentIdList : [];
  const s = getState();
  // presentList 来自 present/list 的当前状态
  const list = (s.__presentList || []);
  const taken = [];
  const rewards = [];
  for (const id of ids) {
    const idx = list.findIndex(function (p) { return String(p.present_id) === String(id) || String(p.id) === String(id); });
    if (idx < 0) continue;
    const p = list.splice(idx, 1)[0];
    taken.push(p);
    // 礼物对象有两种形态：
    //   ① present/list 下发的 {id, sheetType, masterContentId, amount}（本服务端采用）
    //   ② 带 item_list/items 数组的形态
    // 早期只处理 ② → 本地礼物永远发不出奖励（item_format_list 恒空）。
    if (Array.isArray(p.item_list) || Array.isArray(p.items)) {
      for (const it of (p.item_list || p.items)) {
        rewards.push({ sheet_type: it.sheet_type || 1, master_id: it.master_id || it.item_id, amount: it.amount || it.count || 1 });
      }
    } else if (p.masterContentId || p.master_id) {
      rewards.push({ sheet_type: p.sheetType || p.sheet_type || 1, master_id: p.masterContentId || p.master_id, amount: p.amount || 1 });
    }
  }
  const applied = applyRewards(rewards);
  // ★ 写入【领取历史】（present/list 的 presentHistoryList 来源）——
  //   早期 present/receive_bulk 写了、present/receive 没写 →
  //   单件领取后 presentHistoryList 仍为空（契约 110 条）。
  //   历史条目形状（契约实证）：
  //     { presentId, sheetType, masterContentId, amount, message, receivedAt }
  if (!s.__presentHistory) s.__presentHistory = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const p of taken) {
    s.__presentHistory.push({
      presentId: p.id || p.present_id,
      sheetType: p.sheetType || p.sheet_type || 1,
      masterContentId: p.masterContentId || p.master_id,
      amount: p.amount || 1,
      message: p.message || "",
      receivedAt: nowSec,
    });
  }
  markDirty();
  const failed = ids.filter(function (id) { return !taken.some(function (t) { return String(t.present_id) === String(id) || String(t.id) === String(id); }); });
  return okShaped(ctx.path, {
    successfulPresentList: taken,
    failedPresentListByReceiptDeadline: [],
    failedPresentListByExpiration: failed,
    failedPresentListByPossessionLimit: [],
    player_all_asset: touchedPlayerAssets(),
    item_format_list: toItemFormatList(applied),
    notification: [],
    present_count: list.length,
  });
});

// ============================ 道具/货币增减 ============================
// 商店兑换：{ ShopId, GoodsId, ExchangeCount }
// ★★ 商店交换 —— 必须真读 MasterData 并真扣真发。
//   权威数据链：Shop/GoodsTable.csv 的 (ShopId, GoodsId) 行给出
//     SheetType / ItemId / Count / Cost（形如 "Item:Item_Currency_ScoreAttackCoinx2500"）
//   实测该表 12839 行；例：Shop_Exchange_ScoreAttackCoin + Shop_ScoreAttackCoin_13
//     → Item_Equipment_SSR_0304 x1，消耗 Item_Currency_ScoreAttackCoin x2500
//   （真机 UI 显示「16,100 → 13,600」正是扣 2500，与此吻合。）
//   早期实现只 markDirty()、什么都不做 —— 表现为「换了但持有量不变、道具没到手」。
// ---- 商店数据辅助（权威来源 Shop/GoodsTable.csv）----
// ★★★ 2026-10-21：同一个 GoodsId 可能在【三张表】里都存在，价格不同 ★★★
//   实证：Shop_Event_04_13
//     EventGoodsTable  → Cost = Item:Item_EventpointEX_0003x50   （活动点数）
//     ReEventGoodsTable→ Cost = Item:Item_Re_EventPointx100       （复刻点数）
//   而 Shop_Event_04 同时出现在 Shop/ReShopTable.csv（复刻商店清单）里。
//   用户报障：「我材料很足却说材料不足」—— 因为复刻商店里被按【活动点数】收款（他 0 个）。
//   ⇒ 按「该 ShopId 是否复刻商店」选表：复刻 → ReEventGoodsTable 优先，其余 → 活动/普通优先。
let goodsTblCache = null, reGoodsCache = null, evGoodsCache = null, reShopIds = null;
function loadShopTables() {
  if (!goodsTblCache) {
    const t = loadTable("Shop/GoodsTable.csv");
    goodsTblCache = (t && t.rows) ? t.rows : [];
    console.log("[shop] GoodsTable 索引 " + goodsTblCache.length + " 行");
  }
  if (!reGoodsCache) { const t = loadTable("Shop/ReEventGoodsTable.csv"); reGoodsCache = (t && t.rows) ? t.rows : []; }
  if (!evGoodsCache) { const t = loadTable("Shop/EventGoodsTable.csv"); evGoodsCache = (t && t.rows) ? t.rows : []; }
  if (!reShopIds) {
    const t = loadTable("Shop/ReShopTable.csv");
    reShopIds = new Set(((t && t.rows) || []).map(function (r) { return String(r.ShopId); }));
    console.log("[shop] 复刻商店 " + reShopIds.size + " 个");
  }
}
function findIn(tbl, shopId, goodsId) {
  return tbl.find(function (r) {
    return String(r.ShopId) === String(shopId) && String(r.GoodsId) === String(goodsId);
  }) || null;
}
function findGoods(shopId, goodsId) {
  loadShopTables();
  const isRe = reShopIds.has(String(shopId));
  const order = isRe
    ? [reGoodsCache, evGoodsCache, goodsTblCache]
    : [evGoodsCache, goodsTblCache, reGoodsCache];
  for (const tbl of order) {
    const row = findIn(tbl, shopId, goodsId);
    if (row) return row;
  }
  return null;
}
/** 解析 Cost 字段："Item:<id>x<amount>"，多段以换行分隔。 */
function parseCost(cost) {
  const out = [];
  for (const seg of String(cost || "").split(/[\r\n]+/)) {
    const m = seg.match(/^\s*(\w+):(.+?)x(\d+)\s*$/);
    if (m) out.push({ kind: m[1], itemId: m[2], amount: Number(m[3]) });
  }
  return out;
}

/** 礼包展开：Item/PackItemList.csv → [{id, amount}]（与 routes-misc 的 packItems 同源） */
let _packIdx2 = null;
function packItems2(packId) {
  if (!_packIdx2) {
    _packIdx2 = new Map();
    try {
      const t = loadTable("Item/PackItemList.csv");
      for (const r of ((t && t.rows) || [])) {
        const pid = String(r.ItemId || "");
        const out = String(r.OutputItemId || "");
        const cnt = Number(r.Count || 1) || 1;
        if (!/^Pack_/.test(pid) || !out) continue;
        if (!_packIdx2.has(pid)) _packIdx2.set(pid, []);
        _packIdx2.get(pid).push({ id: out, amount: cnt });
      }
    } catch (e) {}
  }
  return _packIdx2.get(String(packId)) || [];
}

route("shop/exchange", function (ctx) {
  const req = parse(ctx.body);
  const s = getState();
  const count = Math.max(1, Number(req.ExchangeCount || 1));
  const goods = findGoods(req.ShopId, req.GoodsId);
  if (!goods) {
    console.log("[shop] exchange 未找到商品 " + req.ShopId + "/" + req.GoodsId + " → 返回空但不报错");
    markDirty();
    return okShaped(ctx.path, {
      player_all_asset: touchedPlayerAssets(),
      ExchangeCountConditionTrueIdList: [], item_format_list: [], present_item_format_list: [],
      shop_stock_info: s.shop_stock_info || { shop_stock_info_list: [] },
      shop_service_available_list: [],
    });
  }
  // ★★★ 2026-10-22：限购校验（与 shop/exchange_list 同一判据）★★★
  //   ReEventGoodsTable 的 Limit / DailyLimit / WeeklyLimit / MonthlyLimit；已兑换数记在 __shopExchanged。
  try {
    const _key = String(req.ShopId) + "|" + String(req.GoodsId);
    const _done = Number((s.__shopExchanged || {})[_key] || 0);
    const _limit = Number(goods.Limit) || 0;
    if (_limit > 0 && _done >= _limit) {
      console.log("[shop] exchange " + _key + " 已达限购 " + _limit + " → 拒绝");
      return okShaped(ctx.path, {
        player_all_asset: touchedPlayerAssets(), ExchangeCountConditionTrueIdList: [],
        item_format_list: [], present_item_format_list: [],
        shop_stock_info: s.shop_stock_info || { normal_goods: [], shop_stone_product: [], event_goods: [] },
        shop_service_available_list: [],
      });
    }
  } catch (e) {}

  // 消耗（Cost 形如 "Item:<itemId>x<amount>"，可能多段以换行分隔）
  // ★★★ 材料/货币校验（2026-10-17）★★★ 不足则拒绝，不发放也不扣任何东西
  // ★★★ 2026-10-21：成本里的【魔宝石】走独立余额，不能走 consumeItems ★★★
  //   用户报障：魔宝石商店点「交換」没反应。
  //   该商品 Cost = "Item:Item_Stone_Paidx1900"，而石头存在 freeStoneBalance / paidStoneBalance，
  //   不在 AllItemList 里 ⇒ consumeItems 永远判定不足 ⇒ 直接返回空响应。
  const _costs1raw = parseCost(goods.Cost).map(function (c) { return [c.itemId, c.amount * count]; });
  let _stoneFreeNeed = 0, _stonePaidNeed = 0;
  const _costs1 = [];
  for (const [id, amt] of _costs1raw) {
    if (id === "Item_Stone_Free") _stoneFreeNeed += amt;
    else if (id === "Item_Stone_Paid") _stonePaidNeed += amt;
    else _costs1.push([id, amt]);
  }
  if (_stoneFreeNeed > (s.freeStoneBalance || 0) || _stonePaidNeed > (s.paidStoneBalance || 0)) {
    console.log("[shop] exchange 魔宝石不足: 需要 無償" + _stoneFreeNeed + "/有償" + _stonePaidNeed +
      " 持有 無償" + (s.freeStoneBalance||0) + "/有償" + (s.paidStoneBalance||0));
    return okShaped(ctx.path, {
      player_all_asset: touchedPlayerAssets(), ExchangeCountConditionTrueIdList: [],
      item_format_list: [], present_item_format_list: [],
      shop_stock_info: s.shop_stock_info || { normal_goods: [], shop_stone_product: [], event_goods: [] },
      shop_service_available_list: [],
    });
  }
  const _chk1 = consumeItems(s, _costs1);
  if (_chk1.ok && (_stoneFreeNeed || _stonePaidNeed)) { addStone(-_stoneFreeNeed, -_stonePaidNeed); }
  if (!_chk1.ok) {
    console.log("[shop] exchange 材料不足: " + _chk1.id + " need=" + _chk1.need + " have=" + _chk1.have);
    // ★★★ 2026-10-21：失败也必须回【完整结构】★★★
    //   原来 return okShaped(ctx.path, {}) —— 客户端拿到空对象 → FormatException
    //   → 该次 API 调用永不回调 → 界面一直"处理中" → 之后所有按钮都点不动（用户报障「卡死」）。
    return okShaped(ctx.path, {
      player_all_asset: touchedPlayerAssets(),
      ExchangeCountConditionTrueIdList: [],
      item_format_list: [],
      present_item_format_list: [],
      shop_stock_info: s.shop_stock_info || { normal_goods: [], shop_stone_product: [], event_goods: [] },
      shop_service_available_list: [],
    });
  }
  // ★ 记入"已兑换次数"（复刻商店库存重建用）
  try {
    if (!s.__shopExchanged) s.__shopExchanged = {};
    const _k = String(req.ShopId) + "|" + String(req.GoodsId);
    s.__shopExchanged[_k] = (Number(s.__shopExchanged[_k]) || 0) + count;
  } catch (e) {}
  // 发放 —— ★ 必须按道具类型分派，不能一律 addItem ★
  //   魔宝石（Item_Stone_Free / Item_Stone_Paid）【不在】ItemList.AllItemList 里，
  //   它们走 UserData 的 freeStoneBalance / paidStoneBalance 两个独立字段。
  //   早期一律 addItem → 石头被当成普通道具塞进 AllItemList →
  //   客户端拿到 `Item_Stone_Free:300` 就把持有量**刷成 300**（把 +300 当成了 =300）。
  //   实证（用户报障）：34480 石换 300 石后掉到 300。
  const gained = [];
  // ★ 2026-10-23：必须在【发放之前】判定「是否已持有」。
  //   原实现是发完再查 → 刚发放的角色立刻变成"已持有" → 回执被改成碎片
  //   （实测：兑换 Ch000500102 实际进了角色列表，回执却写 Item_Fragment_Main_0005 x50）。
  const _wasOwnedChar = (function () {
    if (!/^Ch\d{9}$/.test(String(goods.ItemId || ""))) return false;
    const cl = s.CharacterList || {};
    return [].concat(cl.mainCharacterList || [], cl.supportCharacterList || []).some(function (c) {
      return c && String(c.master_character_id) === String(goods.ItemId);
    });
  })();
  if (goods.ItemId) {
    const n = Number(goods.Count || 1) * count
    const isChar = /^Ch\d{9}$/.test(String(goods.ItemId));
    const isPack = /^Pack_/.test(String(goods.ItemId));
    if (goods.ItemId === 'Item_Stone_Free') addStone(n, 0)
    else if (goods.ItemId === 'Item_Stone_Paid') addStone(0, n)
    else if (isChar) applyRewards([{ sheet_type: 2, master_id: goods.ItemId, amount: n }])
    else if (isPack) {
      for (const pi of packItems2(goods.ItemId)) {
        const amt = pi.amount * n;
        // ★ 回执以【实际发放结果】为准：包里的「ランダムSSR槍」会被 applyRewards 掷骰成具体装备
        const got = applyRewards([{ sheet_type: 1, master_id: pi.id, amount: amt }]);
        if (got && got.length) for (const g of got) gained.push({ sheet_type: g.sheet_type !== undefined ? g.sheet_type : (g.sheetType || 1), master_id: g.master_id, amount: g.amount });
        else gained.push({ sheet_type: 1, master_id: pi.id, amount: amt });
      }
    }
    else {
      // ★★★ 2026-10-26：改用 applyRewards —— 随机券（Item_Rand_*）必须在这里掷骰展开，
      //   不能 addItem 把「?」占位符塞进背包（用户报障：买到的是随机物品 ID 本身）。
      const _got = applyRewards([{ sheet_type: 1, master_id: goods.ItemId, amount: n }]);
      if (_got && _got.length) for (const _g of _got) gained.push({ sheet_type: _g.sheet_type !== undefined ? _g.sheet_type : 1, master_id: _g.master_id, amount: _g.amount });
    }
    if (!isPack) {
      // ★ 角色可能被折算成碎片（applyRewards 里判断已持有）→ 回执以实际发放为准
      if (isChar) {
        const owned = _wasOwnedChar;
        if (owned) {
          const fid = fragmentItemFor(goods.ItemId);
          const fcnt = fragmentCountFor(goods.ItemId);
          if (fid && fcnt > 0) gained.push({ sheet_type: 1, master_id: fid, amount: fcnt * n });
        } else gained.push({ sheet_type: 2, master_id: goods.ItemId, amount: n });
      } else if (!/^Item_Rand_/i.test(String(goods.ItemId))) {
        // ★ 随机券已在上面 applyRewards 分支 push 过【实得清单】→ 这里不能再 push 券 id 本身
        gained.push({ sheet_type: 1, master_id: goods.ItemId, amount: n });
      }
    }
  }
  markDirty();
  flushNow();
  console.log("[shop] exchange " + req.ShopId + "/" + req.GoodsId + " x" + count +
    " → 得 " + goods.ItemId + " x" + (Number(goods.Count || 1) * count) +
    " 耗 " + parseCost(goods.Cost).map(function (c) { return c.itemId + "x" + (c.amount * count); }).join("+"));
  // ★★★ 2026-10-21：重建该商店的库存随响应下发 ★★★
  //   用户报障：角色兑换后商店列表不刷新（角色兑换走的是本接口 shop/exchange，不是 exchange_list）。
  //   剩余 = ReEventGoodsTable.Limit − __shopExchanged，客户端据此显示 SOLD OUT。
  let stockInfo = {};
  try {
    stockInfo = JSON.parse(JSON.stringify(s.shop_stock_info || {}));
    const reTbl = loadTable("Shop/ReEventGoodsTable.csv");
    const shopId = String(req.ShopId);
    const rebuilt = [];
    for (const r of ((reTbl && reTbl.rows) || [])) {
      if (String(r.ShopId) !== shopId) continue;
      const ex = Number((s.__shopExchanged || {})[shopId + "|" + String(r.GoodsId)] || 0);
      const limit = Number(r.Limit) || 0;
      rebuilt.push({
        shop_id: r.ShopId, goods_id: r.GoodsId,
        has_stock: limit > 0, stock: Math.max(0, limit - ex),
        has_per_day_exchangeable_time: false, per_day_exchangeable_time: 0,
        has_service_expired_time: false, service_expired_time: 0,
      });
    }
    const keep = (stockInfo.event_goods || []).filter(function (x) { return String(x.shop_id) !== shopId; });
    stockInfo.event_goods = keep.concat(rebuilt);
  } catch (e) { console.error("[shop] exchange 库存重建失败: " + e.message); }
  return okShaped(ctx.path, {
    // player_all_asset 语义 = 本次【实际变动】的持有量（含消耗与所得两种）
    player_all_asset: touchedPlayerAssets(),
    ExchangeCountConditionTrueIdList: [],
    item_format_list: gained,
    present_item_format_list: [],
    shop_stock_info: stockInfo,
    shop_service_available_list: [],
  });
});

// 碎片兑换：{ item_id_list: [...] }
route("shop/fragment_exchange", function (ctx) {
  const req = parse(ctx.body);
  // ★★★ 补 getState（2026-10-17）：同 enhance_bulk，`s` 未声明。
  const s = getState();
  const ids = Array.isArray(req.item_id_list) ? req.item_id_list : [];
  // 碎片交换：消耗碎片、获得对应道具。
  // 请求形如 [{ master_id, amount }]；契约响应的 items.AllItemList 是交换后的持有量。
  const gained = [];
  for (const it of ids) {
    const mid = (it && (it.master_id || it.itemId || it.master_item_id)) || it;
    const n = (it && (it.amount || it.count)) || 1;
    if (!mid) continue;
    // ★★★ 碎片校验（2026-10-17）★★★
    const _chkF = consumeItems(s, [[mid, n]]);
    if (!_chkF.ok) {
      console.log("[shop] fragment_exchange 碎片不足: " + _chkF.id + " need=" + _chkF.need + " have=" + _chkF.have);
      continue;
    }
    gained.push({ sheet_type: 1, master_id: mid, amount: n });
  }
  console.log("[shop] fragment_exchange x" + ids.length);
  markDirty();
  return okShaped(ctx.path, {
    item_format_list: gained,
    items: playerAllAssetFor(gained.map(function (g) { return g.master_id; })),
    present_item_format_list: [],
  });
});

// ============================ 角色碎片领取 ============================
// 请求：{ masterCharacterId, count, isMain, masterItemId }
// character/receive_fragment 的实现在更晚加载的模块中（避免重复注册导致前者被静默覆盖）
// ★★ 登录奖励 —— 数据链（全部来自 MasterData）：
//   state.UserLoginBonusList[] = { login_bonus_group_id, day_progress, last_received }
//     → LoginBonus/LoginBonusSetting.csv 按 (LoginBonusGroupId, AppearNumber=day_progress+1)
//       取 RewardId
//     → Reward/DecisionRewardTable.csv（经 rewards.mjs）解析成 (SheetType, ItemId, Amount)
//   契约响应结构（真机实测）：
//     BonusList: [{ LoginBonusGroupId, AppearNumber, item_format_list[], present_item_format_list[] }]
//     例：{LoginBonusGroupId:"20210527_0000", AppearNumber:8, item_format_list:[{sheet_type:1, master_id:"Item_Stone_Free", amount:50}]}
//   早期实现：BonusList 恒空、道具恒发 300 石（硬编码）—— 既不真实也无法领到正确奖励。
route("login_bonus/receive", function (ctx) {
  const s = getState();
  const lb = Array.isArray(s.UserLoginBonusList) ? s.UserLoginBonusList : [];
  // ★★★ 2026-10-21：存档里没有登录奖励组时自动补常驻组 ★★★
  //   用户报障「以前每天首次登录会弹每日登录奖励，现在一次都不弹」——
  //   根因：state.UserLoginBonusList = []（空数组），客户端没有可领的组，BonusList 恒空 → 不弹窗。
  //   常驻组 20210527_0000「ログインボーナス」在 master 里 Start=2021/1/1 ~ End=2200/1/1，永远有效。
  if (!lb.some(function (b) { return String(b.login_bonus_group_id) === "20210527_0000"; })) {
    lb.push({ login_bonus_group_id: "20210527_0000", day_progress: 0, last_received: 0 });
    s.UserLoginBonusList = lb;
    markDirty();
    console.log("[login_bonus] 已补常驻组 20210527_0000");
  }
  const setting = loadTable("LoginBonus/LoginBonusSetting.csv");
  const rows = (setting && setting.rows) ? setting.rows : [];
  const now = Math.floor(Date.now() / 1000);
  // ★★ 三个必须的守卫（用户报障「每次登录都发」「计数到 11/10」）★★
  //   ① 【同一天只能领一次】—— 检查 last_received 是否已在今天。
  //      早期无条件发放 → 每次登录（甚至每次进主页）都发一遍奖励。
  //   ② 【天数不能超过该 group 的上限】—— 上限 = LoginBonusSetting.csv 里
  //      该 group 的 AppearNumber 最大值（实证：20210527_0000 是 14 天、
  //      多数 Event group 是 10 天、LoginBonusEvent_20260925_0001 只有 7 天）。
  //      早期无上限检查 → day_progress 被推到 11（界面显示 11/10）。
  //   ③ 【找不到对应天数就跳过】—— 早期用 `|| rows.find(该 group 任意一行)` 兜底，
  //      会把「第 11 天」错误地发成「第 1 天」的奖励（重复发放）。
  const startOfDay = function (ts) { const d = new Date(ts * 1000); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000); };
  const today = startOfDay(now);
  const maxAppearOf = function (gid) {
    let mx = 0;
    for (const r of rows) if (String(r.LoginBonusGroupId) === gid) mx = Math.max(mx, Number(r.AppearNumber) || 0);
    return mx;
  };
  const bonusList = [];
  const allRewards = [];
  for (const b of lb) {
    const gid = String(b.login_bonus_group_id || "");
    if (!gid) continue;
    // ① 今天已领过 → 跳过（客户端会据 BonusList 为空而不弹窗）
    const last = Number(b.last_received) || 0;
    if (last && startOfDay(last) >= today) continue;
    // 本次要领的天数 = 已推进天数 + 1
    const appear = (Number(b.day_progress) || 0) + 1;
    // ② 超过上限 → 该 group 已领完，跳过
    const maxAppear = maxAppearOf(gid);
    // ★ 走完一轮后【循环重置】（常驻组 14 天一轮，保证每天都能领到）
    if (maxAppear && appear > maxAppear) {
      b.day_progress = 0;
      b.last_received = 0;
      console.log("[login_bonus] " + gid + " 已走完 " + maxAppear + " 天 → 循环重置");
    }
    const appear2 = (Number(b.day_progress) || 0) + 1;
    // ③ 严格按 (group, 天数) 查，**不做兜底回退**
    const row = rows.find(function (r) {
      return String(r.LoginBonusGroupId) === gid && Number(r.AppearNumber) === appear2;
    });
    if (!row) continue;
    const got = resolveRewardId(row.RewardId) || [];
    // 按 BonusList 的形状输出（master_id 而非 master_item_id）
    const fmt = got.map(function (x) {
      return { sheet_type: x.sheetType || 1, master_id: x.master_id, amount: x.amount || 1 };
    });
    bonusList.push({ LoginBonusGroupId: gid, AppearNumber: appear2, item_format_list: fmt, present_item_format_list: [] });
    for (const f of fmt) allRewards.push(f);
    b.day_progress = appear2;
    b.last_received = now;
  }
  // 真正发放
  if (allRewards.length) applyRewards(allRewards);
  markDirty();
  flushNow();
  console.log("[login_bonus] receive -> " + bonusList.length + " 组 / " + allRewards.length + " 项奖励");
  return okShaped(ctx.path, {
    BonusDay: now,
    BonusList: bonusList,
    // 契约里 player_all_asset 是数组（真机实测 [] ）；有变动时才给对象（与多态规则一致）
    // ★ 契约实证：login_bonus/receive 的 BonusList 有 2 条，但 player_all_asset 是 **[]** ——
    //   说明登录奖励【不体现在 player_all_asset 里】（它走 freeStoneBalance 等独立字段）。
    //   早期我按「有发放就给对象」处理 → 审计报 TYPE 不符（契约数组、实现对象）。
    //   修正：该端点的 player_all_asset 恒为 []（与契约一致）。
    player_all_asset: [],
    present_count: (s.__presentList || []).length,
    xgHttpStatus: 205,
    freeStoneBalance: s.freeStoneBalance || 0,
    paidStoneBalance: s.paidStoneBalance || 0,
    platformId: null, deviceId: null, ratingId: null, type: null,
    paymentId: null, status: null, productList: [],
  });
});

console.log("[routes-biz] 写接口已注册（按入参）");