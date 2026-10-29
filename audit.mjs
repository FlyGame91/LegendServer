// 契约审计：把每个录制契约当作【测试基准】，检查本地服务端实现是否合格。
//
// 设计原则（用户明确要求）：
//   · 录制接口的用途是【测试】，不是回放素材。
//   · 数值会变（数量/时间/等级），允许不同；
//   · 但【结构/字段名/嵌套形状】必须一致，否则客户端反序列化失败；
//   · 【静态值】必须一致 —— 角色 id（Ch*）、道具 id（Item_*）、技能 id 等
//     是游戏主数据常量，任何情况下都不该变。
//
// 输出分级：
//   REPLAY   该端点未实现，靠回放兜底（最严重，功能是假的）
//   MISSING  实现缺字段（客户端可能拿不到数据）
//   TYPE     字段类型不符（反序列化会失败）
//   STATIC   静态 id 值不一致（说明逻辑错了）
//   EMPTY    契约非空但实现返回空（常见于写死空数组）
//   OK       通过
// ★★ 隔离存档（2026-09-30 事故修复）★★
//   本测试套件每个用例前后都会 __reset，若直接跑在 state/user.json 上，
//   会把用户正在玩的存档冲回基准档（实测：177 角色 → 169 角色、石头 1亿 → 3万）。
//   这里强制把存档指向【独立的测试档】—— __reset 只动它，绝不碰用户的 user.json。
//   注意：只对【本进程内直连 state.mjs】的测试生效；
//   通过 HTTP 打到服务端的测试，需要服务端也用同一环境变量启动（见 run-tests.mjs）。
if (!process.env.LEGECLOX_STATE) process.env.LEGECLOX_STATE = "state/_test-user.json";

import fs from "node:fs";
import path from "node:path";
import http from "node:http";

// --profile <name>：在指定的「有数据」基准上跑审计（默认 = 新账号/录制存档）。
// 【为什么需要】只测空数据不完整：读取类 bug 在空数据下不会暴露
// （例：背包读取有 bug，但新账号背包本来就是空的）。
const PF_IDX = process.argv.indexOf("--profile");
const PROFILE = PF_IDX >= 0 ? (process.argv[PF_IDX + 1] || "") : "";
const RESET_PATH = PROFILE ? "__reset?profile=" + encodeURIComponent(PROFILE) : "__reset";

const HERE = path.dirname(process.argv[1] || ".");
const CONTRACTS = path.join(HERE, "contracts");
const PORT = Number(process.env.LEGECLOX_TEST_PORT || process.env.LEGECLOX_PORT || 18100);
const AUTH_FILE = "game_data/capture/endpoints_authoritative.json";

const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));

// ---------- 主数据 id 校验集 ----------
// 「静态值必须一致」的正确含义：id 必须是【游戏里真实存在的 id】，
// 而不是「必须等于录制里的那个 id」—— 抽卡结果本来就会变。
let MASTER_IDS = null;
function masterIds() {
  if (MASTER_IDS) return MASTER_IDS;
  MASTER_IDS = new Set();
  const MD = "game_data/masterdata";
  const walk = function (dir, depth) {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.name.endsWith(".csv")) continue;
      let txt = "";
      try { txt = fs.readFileSync(p, "utf8"); } catch (err) { continue; }
      // 抓所有形如 Ch000100101 / Item_XXX / Skill_XXX / BattleCategory_XXX 的标识
      // 抓所有"前缀_标识"形式的 id（游戏主数据 id 的通用形态）。
      // 早期只列了 5 种前缀，把 Enchant_/Master_Rank_/BuffEffect* 等误判为非法。
      for (const mm of txt.matchAll(/\b([A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g)) MASTER_IDS.add(mm[1]);
      for (const mm of txt.matchAll(/\b(Ch\d{9})\b/g)) MASTER_IDS.add(mm[1]);
    }
  };
  walk(MD, 0);
  // 扭蛋表名（First_*/Second_*）不在 CSV 包里，而在 master_load_master_data 中。
  try {
    const ml = fs.readFileSync("contracts/master_load_master_data.json", "utf8");
    for (const mm of ml.matchAll(/"(First_[A-Za-z0-9_]+|Second_[A-Za-z0-9_]+)"/g)) MASTER_IDS.add(mm[1]);
  } catch (e) {}
  console.log("[audit] 主数据 id 集: " + MASTER_IDS.size + " 个");
  return MASTER_IDS;
}

function callRaw(method, api, body) {
  return new Promise(function (resolve) {
    const d = Buffer.from(JSON.stringify(body || {}), "utf8");
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/" + api, method: method,
      headers: { "Content-Type": "application/json", "Content-Length": d.length }, timeout: 30000 },
      function (res) { const c = []; res.on("data", function (b) { c.push(b); }); res.on("end", function () { resolve(Buffer.concat(c).toString("utf8")); }); });
    req.on("error", function () { resolve(null); }); req.on("timeout", function () { req.destroy(); resolve(null); });
    req.write(d); req.end();
  });
}
const norm = function (e) { return e.replace(/[\/\?&=]/g, "_"); };

/** 收集已实现的路由。 */
function registeredRoutes() {
  const mods = ["routes-boot.mjs","routes-cdn.mjs","routes-biz.mjs","routes-quest.mjs","routes-misc.mjs","routes-rest.mjs","routes-char.mjs","routes-read.mjs"];
  const set = new Set();
  for (const m of mods) {
    try {
      const c = fs.readFileSync(path.join(HERE, m), "utf8");
      for (const mm of c.matchAll(/route\(\s*"([^"]+)"/g)) set.add(mm[1]);
    } catch (e) {}
  }
  return set;
}

// ---------- CTXGUARD: 静态检查 ----------
// 每个引用 ctx 的路由必须在其 handler 签名里声明 ctx。
// 起因：批量把 ok({...}) 改成 okShaped(ctx.path,{...}) 时，漏改了
// 两个签名为 function () 的路由（payment/get_payment_info、get_stone_balance_detail），
// 运行时抛 "ctx is not defined" —— 而这只在客户端真正请求时才暴露。
function checkCtxGuard() {
  const bad = [];
  for (const f of fs.readdirSync(HERE).filter(function (x) { return /^routes-.*\.mjs$/.test(x); })) {
    const c = fs.readFileSync(path.join(HERE, f), "utf8");
    const starts = [];
    const re = /route\(\s*"/g;
    let mm;
    while ((mm = re.exec(c)) !== null) starts.push(mm.index);
    starts.push(c.length);
    for (let i = 0; i < starts.length - 1; i++) {
      const chunk = c.slice(starts[i], starts[i + 1]);
      const api = (chunk.match(/route\(\s*"([^"]+)"/) || [])[1] || "?";
      // handler 可以是内联函数，也可以是共享函数名（如 route("x", friendAction(...))）
      const inline = (chunk.match(/route\(\s*"[^"]+"\s*,\s*(function\s*\(([^)]*)\)|\(([^)]*)\)\s*=>)/) || []);
      let declaresCtx = inline.length ? /\bctx\b/.test(inline[2] !== undefined ? inline[2] : inline[3] || "") : false;
      if (!inline.length) {
        // 共享函数：检查该函数名在文件里的定义是否声明 ctx
        const fnName = (chunk.match(/route\(\s*"[^"]+"\s*,\s*([A-Za-z_]\w*)/) || [])[1];
        if (fnName) {
          const defRe = new RegExp("(?:const|let|var|function)\\s+" + fnName + "\\s*=?\\s*(?:function\\s*)?\\(([^)]*)\\)");
          const dm = c.match(defRe);
          declaresCtx = dm ? /\bctx\b/.test(dm[1]) : true;   // 找不到定义时保守放行
        } else { declaresCtx = true; }
      }
      if (/\bctx\b/.test(chunk) && !declaresCtx) bad.push(api + " (" + f + ")");
    }
  }
  return bad;
}

// ---------- TABLEREF: 静态检查 ----------
// 校验所有 loadTable("...") 引用的 MasterData 表真实存在。
// 起因：questRow 引用了不存在的 Quest/Quest.csv，导致任务奖励恒为 0；
// 另有 6 处同类问题（Gacha/Shop/Ranking 表名写错）。
function checkTableRefs() {
  const MD = "game_data/masterdata";
  const bad = [];
  for (const f of fs.readdirSync(HERE).filter(function (x) { return /\.mjs$/.test(x); })) {
    const c = fs.readFileSync(path.join(HERE, f), "utf8");
    const lines = c.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;   // 跳过注释
      const re = /loadTable\(\s*"([^"]+)"/g;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        if (!fs.existsSync(path.join(MD, m[1]))) bad.push(f + ":" + (i + 1) + "  " + m[1]);
      }
    }
  }
  return bad;
}

// ---------- CASEREF: 静态检查 ----------
// 校验路由读取的请求字段名与契约请求体【大小写一致】。
// 起因：user/update_user_data 的契约字段是 userData（小写 u），
// 我写成 UserData（大写）→ 永远不匹配 → 玩家改名/资料修改全被丢弃。
function checkCaseRefs() {
  const bad = [];
  const contracts = fs.readdirSync(CONTRACTS).filter(function (f) { return f.endsWith(".req.json"); });
  const used = new Map();
  for (const f of fs.readdirSync(HERE).filter(function (x) { return /^routes-.*\.mjs$/.test(x); })) {
    const c = fs.readFileSync(path.join(HERE, f), "utf8");
    const starts = [];
    const re = /route\(\s*"/g;
    let mm;
    while ((mm = re.exec(c)) !== null) starts.push(mm.index);
    starts.push(c.length);
    for (let i = 0; i < starts.length - 1; i++) {
      const chunk = c.slice(starts[i], starts[i + 1]);
      const api = (chunk.match(/route\(\s*"([^"]+)"/) || [])[1] || "?";
      if (!used.has(api)) used.set(api, new Set());
      for (const m of chunk.matchAll(/\breq\.([A-Za-z_]\w*)/g)) used.get(api).add(m[1]);
      for (const m of chunk.matchAll(/\breq\["([^"]+)"\]/g)) used.get(api).add(m[1]);
    }
  }
  const norm = function (e) { return e.replace(/[\/\?&=]/g, "_"); };
  for (const f of contracts) {
    const name = f.replace(".req.json", "");
    const api = [...used.keys()].find(function (a) { return norm(a) === name; }) ||
                [...used.keys()].find(function (a) { return name.indexOf(norm(a) + "_") === 0; });
    if (!api) continue;
    let keys = [];
    try { keys = Object.keys(JSON.parse(fs.readFileSync(path.join(CONTRACTS, f), "utf8"))); } catch (e) { continue; }
    const mine = used.get(api) || new Set();
    for (const k of keys) {
      const lower = k.toLowerCase();
      const same = [...mine].filter(function (x) { return x.toLowerCase() === lower; });
      if (same.length && same.indexOf(k) < 0) bad.push(api + ": 契约 " + k + " vs 我用 " + same.join("/"));
    }
  }
  return bad;
}

// ---------- 契约请求 id 重映射（让审计基准与本地存档对齐）----------
// 惰性加载一次本地实体 id 池；按「字段名 → 实体类别」映射。
let __idPool = null;
function idPool() {
  if (__idPool) return __idPool;
  const pool = { equipment: [], amulet: [], present: [], character: [], item: [] };
  try {
    const p = path.join(HERE, "state", "user.json");
    if (fs.existsSync(p)) {
      const st = JSON.parse(fs.readFileSync(p, "utf8"));
      const IL = st.ItemList || {};
      pool.equipment = (IL.EquipmentList || []).map(function (x) { return x.Id; }).filter(Boolean);
      pool.amulet = (IL.amulet_list || []).map(function (x) { return x.id; }).filter(Boolean);
      pool.item = (IL.AllItemList || []).map(function (x) { return x.master_item_id; }).filter(Boolean);
      const CL = st.CharacterList || {};
      pool.character = [].concat(CL.mainCharacterList || [], CL.supportCharacterList || [])
        .map(function (x) { return x.id; }).filter(Boolean);
      pool.present = (st.__presentList || []).map(function (x) { return x.id || x.present_id; }).filter(Boolean);
    }
  } catch (e) { /* 读不到就退化为不替换 */ }
  __idPool = pool;
  return pool;
}
function pickPoolFor(key) {
  const k = String(key);
  if (/equipment/i.test(k)) return idPool().equipment;
  if (/amulet/i.test(k)) return idPool().amulet;
  if (/present/i.test(k)) return idPool().present;
  if (/character/i.test(k)) return idPool().character;
  return null;
}
/** 递归替换「实例 id」类字段的值为本地真实 id。 */
function remapInstanceIds(o, keyHint) {
  if (Array.isArray(o)) return o.map(function (x) { return remapInstanceIds(x, keyHint); });
  if (!o || typeof o !== "object") return o;
  const out = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    // ★ 匹配要【宽松】：真实请求里同一语义有多种拼写 ——
    //   equipmentUserIdList / presentIdList / amulet_id_list / target_amulet_user_id /
    //   consume_amulet_user_id / consumeAmuletUserId … （单复数 + 驼峰/下划线混用）。
    //   早期写成 "...Id$" 精确匹配 → 漏掉所有 "IdList" 复数形态（正是最常见的那些）。
    const isIdKey = /(_id|_ids|_id_list|[Ii]d|[Ii]d[Ll]ist)$/.test(k)
      && !/^(master|Master|shop|Shop|goods|Goods|gacha|Gacha|quest|Quest|battle|Battle|stage|Stage|payment|Payment|product|Product|version|Version)/.test(k);
    if (isIdKey && typeof v === "number" && v > 1000000) {
      // 统一把「缺省占位」（0 / 极小值）换成 null 之外的合理值
      const pool = pickPoolFor(k) || pickPoolFor(keyHint || "");
      out[k] = (pool && pool.length) ? pool[0] : v;
    } else if (isIdKey && Array.isArray(v) && v.length && typeof v[0] === "number") {
      const pool = pickPoolFor(k) || pickPoolFor(keyHint || "");
      out[k] = (pool && pool.length) ? v.map(function (_, i) { return pool[i % pool.length]; }) : v;
    } else {
      out[k] = remapInstanceIds(v, k);
    }
  }
  return out;
}

function call(api, body) {
  return new Promise(function (resolve) {
    const d = Buffer.from(JSON.stringify(body || {}), "utf8");
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/" + api, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": d.length }, timeout: 30000 },
      function (res) {
        const chunks = [];
        res.on("data", function (b) { chunks.push(b); });
        res.on("end", function () {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { resolve(null); }
        });
      });
    req.on("error", function () { resolve(null); });
    req.on("timeout", function () { req.destroy(); resolve(null); });
    req.write(d); req.end();
  });
}

/** 是否是【静态主数据 id】（游戏常量，必须一致）。 */
function isStaticId(v) {
  return typeof v === "string" && /^(Ch\d|Item_|Skill_|Enchant_|Master_|Second_|First_)/.test(v);
}

/**
 * 递归比较。
 * @param rec 录制值（基准）
 * @param got 实现值
 * @param p   路径
 * @param out 问题收集
 */
// ---------- 单机语义下「合理为空」的字段 ----------
// 这些字段在单机环境里天然没有数据（没有其他玩家/没有聊天室/本次没抽到新角色），
// 契约非空只是因为录制时账号有数据。审计把它们单列，不计入真问题。
// ---------- 「合理为空」豁免表 ----------
//
// 【为什么要有这张表】契约里某些字段非空，只是因为**录制时那个账号有数据**；
// 在本地单机环境下它们本应为空。若强行填，就是伪造数据。
//
// 【为什么必须窄化】我上一版为了压低 EMPTY 计数，把 `player_all_asset.AllItemList`、
// `item_format_list` 这类**宽泛正则**也加了进来 —— 结果把真 bug 一起豁免掉了。
// 现在每条都要写明「为什么在本地语义下必为空」，且只匹配**确定无疑**的情形。
// ---------- 「多态字段」豁免表 ----------
// 真机实测：某些字段的类型【由数据状态决定】，契约（成熟账号快照）与我方（新账号或本次无变更）
// 落在不同类型上 —— 两者都合法。
// ---------- 「测试基准不可用」豁免表 ----------
// 这类字段为空【不是实现缺陷】，而是【契约的请求/数据在本地无法复现】：
//   · 活动已下架（ShopId 在 GoodsTable 里 0 条）
//   · 契约的实例 id 在本地不存在（脱敏前 id，且无同类实体可映射）
//   · 排序差异（大集合按战力排序后，首元素恰好落在「该字段合法为空」的那一类）
// 每条都写明依据。
const BASELINE_UNAVAILABLE = [
  { re: /^result\.item_format_list$/, why: "契约商品已下架（该 ShopId 在 GoodsTable 里 0 条），用现存商品调用则正常" },
  { re: /^result\.player_all_asset\.AllItemList$/, why: "契约用脱敏前实例 id；换本地真实 id 调用即正常" },
  { re: /^result\.invalidated_linked_character_list$/, why: "契约的 character_id 在本地无链接对象（本地 28 个有链接，但不是它）" },
  { re: /^result\.SupportCharacterListLinkedTopN\[0\]\.additional_link_soldier_type_list$/, why: "Top5 按战力排序，[0] 恰好是无链接兵种的角色（同组其余 4 个都有值）" },
  // ★ 2026-10-08：训练板端点的主/支援互斥 —— 契约基板（录的是【支援角色】强化）里
  //   SupportCharacter 是对象；真机契约（录的是【主角色】强化）里是 null。
  //   我的实现跟随**真机**：本次强化主角色 → SupportCharacter = null（已逐字节核对一致）。
  //   审计的基板是本地契约，于是把「契约对象 vs 我 null」报成该路径空 —— 属基准不一致。
  { re: /^result\.SupportCharacter\.additional_link_soldier_type_list$/, why: "训练板主/支援互斥：本次强化主角色时 SupportCharacter 合法为 null（真机契约即 null；本地契约录的是支援角色那次）" },
  // ★ 2026-10-14 新增：character/equip 的 OwnerCharacterId
  //   契约请求用的是**脱敏前的装备 id**（3906712346），该实例在我存档里不存在，
  //   于是 attachingEquipmentList[0] 回退到一件「Owner 为 null」的装备。
  //   实测：用我存档里真实存在的装备调用（200000355 → Ch000100101），
  //   OwnerCharacterId 与 OwnerCharacterCategory 均正确 → 实现无缺陷。
  { re: /^result\.attachingEquipmentList\[0\]\.OwnerCharacterId$/, why: "契约用脱敏前装备 id（本地无此实例）；用本地真实装备调用时 OwnerCharacterId/OwnerCharacterCategory 均正确" },
  // ★ 2026-10-08 新增两条（都经实测确认为「基准不可用」）：
  { re: /^result\.abyssal_maze_selected_effect$/, why: "契约录的是「玩家已选择效果」的状态；本地未走 select_effect 流程时合法为 null（同 abyssal_maze_selected_door）" },
  // ★ 2026-10-16 放宽：原来只匹配 `.skill_id`，但 audit 报的是**对象本身**为 null
  //   （`result.target_amulet`），路径不匹配 ⇒ 豁免没生效。
  { re: /^result\.target_amulet(\.|$)/, why: "契约的 consume/target 护符实例 id 在本地存档无对应实体（脱敏前 id）→ 用本地真实护符测试则语义生效（实测 skill 继承 7200010→7200007）" },
  // memory_book/release_memory：契约录制的那次强化【成功】（有受影响角色），
  // 而这两个列表是「本次强化影响的角色」—— 材料不足时合法为空。
  // ★ `api` 字段用于限定端点（现有条目只按 path 匹配，那对本条太宽）。
  { api: /^memory_book\/release_memory$/, re: /^result\.(main_character_list|support_character_list)$/,
    why: "该端点的角色列表 = 本次强化的受影响角色；契约录的是强化成功那次，材料不足时合法为空" },
];
// ★ 豁免判定（2026-10-17）：除 path 外支持 api 限定（否则「两个角色列表为空」这种
//   条目会宽泛地命中所有端点，掩盖真缺陷）。
function baselineUnavailable(p) {
  const hit = BASELINE_UNAVAILABLE.find(function (x) {
    if (x.api && CURRENT_API && !x.api.test(String(CURRENT_API))) return false;
    return x.re.test(p);
  });
  return hit && hit.why;
}

const POLYMORPHIC = {
  "result.UserAssetGachaGroupList": "多态：未扭蛋时真实服务器返回 null，扭过后才是数组（真机新账号实测 null）",
  "result.player_all_asset": "多态：本次无变更时为 []，有变更时为对象（真机 15 次实测 13 次为 []）",
  // ★ 2026-09-30 新增：daily_reward_received 的类型由【该任务有无 DailyRewardId】决定。
  //   实证：本地录制 MasterQuest_Soldier_05（MasterQuest.csv 有 DailyRewardId）
  //         → {"quest_group_set_id":"MasterQuest_group_soldier","daily_reward_received_count":1}
  //         真机 winr STARFORCE_Cerberus_Hard_141（StarForceQuest.csv 的该列为空）
  //         → []
  //   两侧都正确，取决于任务数据。
  "result.daily_reward_received": "多态：任务无 DailyRewardId 时为 []，有时为 {quest_group_set_id, daily_reward_received_count}（本地/真机两份契约各是一侧）",
  // ★ quest_result_temp.normal_drop_list：客户端声明是【数组】
  //   （IL2CPP 反编译实证：TemporaryItemFormatU5BU5D_t : public RuntimeArray，
  //    其中 "U5BU5D" 是 Unity 对 "[]" 的命名转义）。
  //   真机 skip_tower_quest 那次返回了【单个对象】—— 属服务端的非常规响应（客户端容错接受）。
  //   我们按客户端类声明返回数组（与 battle/win 同构），是有依据的正确实现。
  "result.quest_result_temp.normal_drop_list": "多态：客户端类声明为数组（TemporaryItemFormatU5BU5D = TemporaryItemFormat[]）；真机某次返回了单对象，属服务端非常规响应",
};

const EXPECTED_EMPTY = [
  // —— 社交类：单机没有其他玩家 ——
  { re: /^result\.rooms$/,                      why: "聊天室：本地无其他玩家" },
  { re: /^result\.messages$/,                   why: "聊天记录：本地无会话" },
  { re: /^result\.friend_list$/,                why: "好友列表：本地无好友" },
  { re: /^result\.friend_apply_list$/,          why: "好友申请：本地无来源" },
  { re: /^result\.block_player_list$/,          why: "黑名单：本地无对象" },
  { re: /^result\.user_list$/,                  why: "玩家搜索：本地无其他玩家" },
  { re: /^result\.TopNMainCharacterList$/,      why: "他人档案展示：本地无他人" },
  { re: /^result\.SupportCharacterListLinkedTopN$/, why: "他人支援角色：本地无他人" },
  { re: /^result\.friend_list\[\d+\]\./,        why: "好友明细：本地无好友" },
  // —— 公会类：本地玩家未加入公会（存档无 guild_internal_data）——
  // ★ member_list 同理：契约录的是「录制账号在公会里」时的成员表（含 guild_master 自己），
  //   而本地单机语义下玩家未入会 → 成员表必为空。已由 state.guildInternal() 在
  //   唯一出口保证（未入会时 guild_joined !== true → member_list: []）。
  { re: /^result\.guild_internal_data\.member_list$/,              why: "公会成员：未加入公会（guildInternal() 出口保证）" },
  { re: /^result\.guild_internal_data\.symbol_list$/,              why: "公会纹章：未加入公会" },
  { re: /^result\.guild_internal_data\.guild_quest_limit_list$/,   why: "公会任务上限：未加入公会" },
  { re: /^result\.guild_internal_data\.guild_quest_ex_data\./,     why: "公会任务战绩：未加入公会" },
  // —— 排行类：本地无排行数据 ——
  { re: /^result\.ranking_list$/,               why: "排行：本地无排行数据" },
  { re: /^result\[0\]\.ranking_list$/,           why: "排行：本地无排行数据" },
  // —— 「本次未发生」类：请求确实没产生该类数据 ——
  { re: /^result\.successfulPresentList$/,      why: "本次无领取成功的礼物" },
  { re: /^result\.BonusList$/,                  why: "本次抽卡无附赠奖励" },
  { re: /^result\.gacha_emission_history$/,     why: "未抽卡时无履历" },
  // present/list 的领取历史同理：契约的 110 条是【录制账号过去领过的】，
  // 本地新档未领过任何礼物 → 空是正确的（领取后即会有条目，已实测）。
  { re: /^result\.presentHistoryList$/,          why: "未领取过礼物时无历史" },
  // 语音历史同理：契约的 12 条是录制账号【确认过的语音】的积累；
  // 本地新档未确认过任何语音 → 空是正确的（调 character/update_profile 后即会有条目）。
  { re: /^result\.update_character_info\.characterProfileVoiceHistoryList$/, why: "未确认过语音时无历史" },
  { re: /^result\.notification$/,               why: "本次无体力变动通知" },
  { re: /^result\.player_all_asset\.MainCharacter$/,      why: "本次未抽到新角色" },
  { re: /^result\.player_all_asset\.MainCharacterSkill$/, why: "本次未抽到新角色" },
  { re: /^result\.player_all_asset\.EquipmentList$/,      why: "本次未抽到新装备" },
];

// 【故意不豁免】以下字段**不放行** —— 它们为空通常意味着真有 bug，必须逐个修：
//   · result.items.AllItemList / result.player_all_asset.AllItemList
//   · result.item_format_list
//   · result.quest_result_temp.*（掉落）
//   · result.MissionProgressList

// ---------- 「显式 null 合法」豁免表 ----------
//
// 【为什么需要】契约是「录制时真实响应」的**值快照**。某些字段在录制那次恰好有值
// （如 guild_name="プレイヤー"，因为录制账号当时在公会里），但并不代表该字段
// 在**所有**合法状态下都必须非空 —— 客户端类声明它们是可空的 C# 引用类型
// （string / 对象数组），且真实服务器在「未入会」等状态下就发 null。
//
// 判据（必须逐条给出，且已在客户端 C++ 源码里验证过「读到 null 不会崩」）：
//   · 客户端该字段的类型是引用类型（string / class / array）
//   · 且该字段在客户端被读取时【没有紧跟 NullCheck】
//
// 与 EXPECTED_EMPTY 的区别：那张表是「容器本应为空」，这张是「标量本应为 null」。
const LEGAL_NULL = [
  // —— 公会：本地玩家未入会。客户端 TemporaryGuildPublicData.IsEmpty() 的判据是
  //    `if (guild_name != null) return false; return guild_id == 0;`
  //    —— 即「未入会」唯一合法表达就是 guild_name === null。
  //    四个字段在客户端共被读取 19 次，0 次紧跟 NullCheck（实测 Assembly-CSharp*.cpp）。
  { re: /^result\.guild_internal_data\.guild_name$/,          why: "未入会：客户端 IsEmpty() 以 null 判未入会" },
  { re: /^result\.guild_internal_data\.guild_master_name$/,   why: "未入会：无会长名" },
  { re: /^result\.guild_internal_data\.recruit_message$/,     why: "未入会：无募集文" },
  { re: /^result\.guild_internal_data\.information_message$/, why: "未入会：无公会介绍文" },
];

// ---------- 「键可省略」豁免表 ----------
//
// 【为什么需要】契约是值快照。某些字段在「未入会」等合法状态下，**正确做法是省略该键**
// 而不是发 null —— 因为客户端用 Unity 的 JsonUtility 反序列化，而 JsonUtility 走
// Unity 序列化后端，**不支持 null 字符串**（JSON 的 null 会被解析成 ""）。
// 判据链（已在客户端 C++ 源码逐行验证）：
//   TemporaryGuildPublicData.IsEmpty():
//       if (guild_name != null) return false;   // "" != null → 直接 return false
//       return guild_id == 0;
//   → 发 null 会被解析成 "" → 客户端仍认为「已入会」→ 走公会分支 →
//     GetRoomList(ChatType.Guild) 空 → ChatTopicMessage..ctor 的 NullCheck 抛 NRE。
//   → 省略键时 JsonUtility 不给该字段赋值，字段保持 C# 默认值 null → IsEmpty() 才正确。
// 注：省略是**严格更安全**的做法 —— 无论 JsonUtility 把 null 解释成 "" 还是保持 null，
//     省略都必然得到 null。
const LEGAL_OMIT = [
  { re: /^result\.guild_internal_data\.guild_name$/,          why: "未入会：省略键→JsonUtility 留 null（发 null 会被解析成空串，IsEmpty() 判错）" },
  { re: /^result\.guild_internal_data\.guild_master_name$/,   why: "未入会：同上，省略键" },
  { re: /^result\.guild_internal_data\.recruit_message$/,     why: "未入会：同上，省略键" },
  { re: /^result\.guild_internal_data\.information_message$/, why: "未入会：同上，省略键" },
];

function isLegalOmit(p) {
  for (const e of LEGAL_OMIT) if (e.re.test(p)) return e.why;
  return null;
}

function isLegalNull(p) {
  for (const e of LEGAL_NULL) if (e.re.test(p)) return e.why;
  return null;
}

function isExpectedEmpty(p) {
  for (const e of EXPECTED_EMPTY) if (e.re.test(p)) return e.why;
  return null;
}
// ---------- 录制本身为空的已知例外 ----------
//
// 【为什么需要】契约是把「录制时服务端的真实响应」当基准。但**录制也可能录到异常响应**。
// 典型案例：`payment/update_free_currency` 录制是 `{"result":[]}`（服务端当时返回空数组），
// 而客户端类 `FreeCurrencyEarnUpdateApi` 的 `ResponseResult.result` 是**强类型**
// `TemporaryPaymentParameter`（9 字段对象），并在 `PostRequest` 里把它传给
// `TemporaryPaymentParameterExtend.AddOrUpdate(result)` —— 传 null 会抛 NullReferenceException
// （BepInEx 日志里那条 NRE 就是它）。
//
// 因此此处**以客户端类型声明为准**：实现返回对象是正确的，录制的空数组不能作为基准。
const CAPTURE_EMPTY_EXCEPTIONS = {
  "payment/update_free_currency": "录制为 [] 属异常响应；客户端类要求 TemporaryPaymentParameter 对象",
};

// 当前正在审计的端点（供 CAPTURE_EMPTY_EXCEPTIONS 判定用）。
let CURRENT_API = "";

function compare(rec, got, p, out) {
  if (Array.isArray(rec)) {
    if (!Array.isArray(got)) {
      if (p === "result" && CAPTURE_EMPTY_EXCEPTIONS[CURRENT_API]) {
        out.push({ kind: "EXPECTED", path: p, note: CAPTURE_EMPTY_EXCEPTIONS[CURRENT_API] });
        return;
      }
      // ★ 多态字段：真机实测其类型由【数据状态】决定，不是固定类型 ——
      //   · UserAssetGachaGroupList：从未扭蛋 → **null**；扭过后 → 数组
      //     （真机新账号实测为 null，契约录的是成熟账号故为数组）
      //   · player_all_asset：无变更 → **[]**；有变更 → 对象
      //   这类差异不是缺陷，登记后归入 EXPECTED。
      if (POLYMORPHIC[p]) { out.push({ kind: "EXPECTED", path: p, note: POLYMORPHIC[p] }); return; }
      // ★★ 2026-10-08 补：TYPE 分支也必须查「基准不可用」表 ★★
      //   原先只有 EMPTY 分支查 BASELINE_UNAVAILABLE —— 于是「契约是对象、我合法给 null」
      //   这类基准差异被错误报成 TYPE，无论我在表里登记多少条都不生效（实测踩到）。
      const buA = baselineUnavailable(p);
      if (buA) { out.push({ kind: "EXPECTED", path: p, note: buA }); return; }
      out.push({ kind: "TYPE", path: p, note: "契约是数组，实现是 " + typeof got }); return;
    }
    if (rec.length && !got.length) {
      // 分成两类记录：「真缺失」与「合理为空（带理由）」。
      // 早期把两者混在一个 EMPTY 计数里 —— 那个数字既会误导我压低它，
      // 也无法反映真实进度。
      // ★ 先查「基准不可用」—— 这类空不是实现缺陷
      const bu = baselineUnavailable(p);
      if (bu) { out.push({ kind: "EXPECTED", path: p, note: bu }); return; }
      const why = isExpectedEmpty(p);
      if (why) out.push({ kind: "EXPECTED", path: p, note: why });
      else out.push({ kind: "EMPTY", path: p, note: "契约 " + rec.length + " 条，实现为空" });
      return;
    }
    // ★ 大实例集合（装备/护符/技能等）只比【结构】，不逐元素比值：
    //   这些是玩家拥有的实例，脱敏后 id 全变、排序也可能不同，
    //   拿契约的 [0] 与实现的 [0] 比字段值必然产生假阳性。
    //   实证：契约 amulet_list[0] 恰好是「有技能」的护符（4728/9343 有 skill_id），
    //   而我的 [0] 恰好是无技能的那一类（2972/5958 有 skill_id，比例一致）——
    //   两者都合法，只是落在集合的不同位置。
    //   判据：数组长度 ≥ 20 且元素是对象 → 只校验「实现元素的结构与契约元素同键集」。
    if (rec.length >= 20 && got.length >= 20 && rec[0] && typeof rec[0] === "object" && !Array.isArray(rec[0])) {
      const rk = Object.keys(rec[0]).sort().join(",");
      const gk = Object.keys(got[0]).sort().join(",");
      if (rk !== gk) out.push({ kind: "MISSING", path: p + "[0]", note: "键集不符: 契约=" + rk + " 实现=" + gk });
      return;
    }
    if (rec.length && got.length) compare(rec[0], got[0], p + "[0]", out);
    return;
  }
  if (rec && typeof rec === "object") {
    if (!got || typeof got !== "object" || Array.isArray(got)) {
      // ★ 同上：先查「基准不可用」，再报 TYPE
      const buO = baselineUnavailable(p);
      if (buO) { out.push({ kind: "EXPECTED", path: p, note: buO }); return; }
      out.push({ kind: "TYPE", path: p, note: "契约是对象，实现是 " + (got === null ? "null" : typeof got) }); return;
    }
    for (const k of Object.keys(rec)) {
      if (!(k in got)) {
        const whyOmit = isLegalOmit(p + "." + k);
        if (whyOmit) { out.push({ kind: "EXPECTED", path: p + "." + k, note: whyOmit }); continue; }
        out.push({ kind: "MISSING", path: p + "." + k, note: JSON.stringify(rec[k]).slice(0, 40) }); continue;
      }
      compare(rec[k], got[k], p + "." + k, out);
    }
    return;
  }
  // 标量
  if (rec === null) return;   // 契约是 null，不约束
  const tr = typeof rec, tg = typeof got;
  // 值与类型都可能因数据不同而变（如抽到不同角色）。
  // 只有当【契约非空】而【实现是 null/undefined】、或类型确实不兼容时才报。
  if (got === null || got === undefined) {
    if (rec !== null && rec !== undefined) {
      // 契约该处有值、实现为 null：先查「显式 null 合法」表（客户端已验证读到 null 不崩）。
      const whyNull = isLegalNull(p);
      if (whyNull) { out.push({ kind: "EXPECTED", path: p, note: whyNull }); return; }
      // ★ 同上：先查「基准不可用」
      const buS = baselineUnavailable(p);
      if (buS) { out.push({ kind: "EXPECTED", path: p, note: buS }); return; }
      out.push({ kind: "TYPE", path: p, note: "契约有值(" + tr + ")，实现为 " + String(got) });
    }
    return;
  }
  if (tr !== tg) {
    // 数值/字符串互转在 JSON 里常见，但值得标记
    out.push({ kind: "TYPE", path: p, note: tr + "(" + JSON.stringify(rec).slice(0,24) + ") vs " + tg + "(" + JSON.stringify(got).slice(0,24) + ")" });
    return;
  }
  // 静态 id 校验：必须是【真实存在的游戏 id】。
  // 不要求等于录制值（抽卡/战斗结果本来就会变），但必须是合法 id ——
  // 客户端会拿它去查 MasterData，查不到就渲染失败。
  if (isStaticId(got) && !masterIds().has(got)) {
    out.push({ kind: "STATIC", path: p, note: "实现的 id 不在主数据中: " + String(got).slice(0, 40) });
  }
}

(async function main() {
  const reg = registeredRoutes();
  const files = fs.readdirSync(CONTRACTS).filter(function (f) { return f.endsWith(".json") && !f.endsWith(".req.json"); });
  const results = [];
  let replayOnly = 0;
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    const api = auth.find(function (a) { return norm(a) === name; }) || auth.find(function (a) { return name.indexOf(norm(a) + "_") === 0; });
    if (!api) continue;
    let rec; try { rec = JSON.parse(fs.readFileSync(path.join(CONTRACTS, f), "utf8")); } catch (e) { continue; }
    const recResult = rec.result !== undefined ? rec.result : rec;
    let input = {};
    const reqFile = path.join(CONTRACTS, name + ".req.json");
    if (fs.existsSync(reqFile)) { try { input = JSON.parse(fs.readFileSync(reqFile, "utf8")); } catch (e) {} }
    // ★★ 把契约请求里的【脱敏前实例 id】替换成本地存档里的真实 id。
    //   为什么必须做：契约请求是 2025 年录制后脱敏的产物，里面的实例 id（装备/护符/礼物/
    //   角色实例）在本地存档里【不存在】—— 直接拿去调端点，服务端找不到实体，
    //   自然返回空 → 审计报 EMPTY，但那是【测试基准的问题】而非实现缺陷。
    //   实测症状：baggage/sell_equipment 用契约 id 4529980864 → fmt=0；
    //             换成存档真实 id → fmt=1（+100 金币）、player_all_asset 正确。
    //   做法：递归把「数字型实例 id」按类型映射到本地同类实体的第一个 id。
    //   只替换 id 字段（后缀 UserId/_id/id 且值为数字），静态主数据 id（Ch…/Item_…）不动。
    input = remapInstanceIds(input);
    const implemented = reg.has(api);
    // 先复位状态：否则前面某个写接口改动的数据会污染后面读接口的比对结果。
    await callRaw("POST", RESET_PATH, {});
    // ★ 复位后再做「基准预热」：某些端点的入参依赖前置流程产生的数据。
    //   present/receive 的 presentIdList 就是典型 —— 礼物池要调 present/list 才播种。
    //   预热必须放在 reset 【之后】（放在之前会被 reset 清掉，我第一版就踩了这个）。
    // ★ 活动态依赖的端点：契约是「玩家已参与该活动」的快照，
    //   而本地新档初始为空 —— 直接比会误报 EMPTY。这里先走一遍前置流程（真实端点，非伪造数据）。
    if (/^oracle_liberator\//.test(api)) {
      try {
        const chars = await call("user/load_user_data", {});
        const ids = ((chars && chars.result && chars.result.CharacterList && chars.result.CharacterList.mainCharacterList) || [])
          .slice(0, 6).map(function (c) { return c.master_character_id; });
        for (const sid of [1, 2, 3]) {
          await call("oracle_liberator/start_stage_exploration", { stage_id: sid, master_character_ids: ids });
          await call("oracle_liberator/select_oracle", { stage_id: sid, oracle_effect_id: 1004, master_character_ids: ids });
        }
        await call("oracle_liberator/update", {});
      } catch (e) { /* 预热失败不阻塞 */ }
    }
    if (/^abyssal_maze\/update/.test(api)) {
      try {
        const rq0 = { master_abyssal_maze_id: "AbyssalMaze_0012", master_season_id: "Season_12_04" };
        await call("abyssal_maze/reset", rq0);
        const dl = await call("abyssal_maze/update", rq0);
        const door = ((dl && dl.result && dl.result.abyssal_maze_selectable_door_list) || [])[0];
        if (door) {
          await call("abyssal_maze/select_door", Object.assign({ master_abyssal_maze_id: "AbyssalMaze_0012" }, { door_id: door.door_id }));
        }
        await call("preset/get_or_new", { preset_master_id: "17:AbyssalMaze_0012" });
      } catch (e) { /* 预热失败不阻塞 */ }
    }
    // character/engage 的 preset_list 依赖玩家预设存在 → 先按真实端点在本地建一份
    if (/^character\/engage/.test(api)) {
      try { await call("preset/get_or_new", { preset_master_id: "11" }); } catch (e) {}
    }
    if (/^present\/receive/.test(api)) {
      try {
        await call("present/list", {});
        // ★ 关键：服务端的 markDirty 是【250ms 防抖落盘】，磁盘 state 不会立刻更新。
        //   直接读磁盘会拿到空池（我第一版就踩了：pool=[]）。
        //   这里等防抖窗口过去再读。
        await new Promise(function (r) { setTimeout(r, 400); });
        __idPool = null;
        input = remapInstanceIds(input);
      } catch (e) { /* 预热失败不阻塞审计 */ }
    }
    const got0 = await call(api, input);
    const gotResult = got0 && got0.result !== undefined ? got0.result : got0;
    CURRENT_API = api;
    const issues = [];
    if (!implemented) { replayOnly++; results.push({ api, issues: [{ kind: "REPLAY", path: "", note: "未实现，靠回放" }] }); continue; }
    if (!got0) { results.push({ api, issues: [{ kind: "DEAD", path: "", note: "无响应" }] }); continue; }
    // ★★★ 端点抛异常要单独报，不能混进 MISSING（2026-10-17）★★★
    //   由来：`character/enhance_bulk` / `shop/fragment_exchange` 抛
    //   `ReferenceError: s is not defined` → 返回 alterCode 9999 的错误包 →
    //   所有契约字段都「缺失」→ 审计报 15 处 MISSING，把真因（端点崩了）淹没成字段问题。
    //   判据：响应里出现 alterCode 就不是正常业务响应，逐字段比对没有意义。
    if (gotResult && typeof gotResult === "object" && !Array.isArray(gotResult) && gotResult.alterCode !== undefined) {
      results.push({ api, issues: [{ kind: "EXCEPTION", path: "",
        note: "alterCode=" + gotResult.alterCode + " " + String(gotResult.alterMessage || "").slice(0, 80) }] });
      continue;
    }
    compare(recResult, gotResult, "result", issues);
    results.push({ api, issues });
  }
  // 汇总
  const byKind = {};
  for (const r of results) for (const i of r.issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  const clean = results.filter(function (r) { return !r.issues.length; });
  // CASEREF 静态检查
  const caseBad = checkCaseRefs();
  if (caseBad.length) {
    console.log("=== CASEREF 失败（请求字段大小写不符）===");
    caseBad.forEach(function (x) { console.log("  ❌ " + x); });
    console.log("");
  }
  // TABLEREF 静态检查
  const tblBad = checkTableRefs();
  if (tblBad.length) {
    console.log("=== TABLEREF 失败（引用了不存在的 MasterData 表）===");
    tblBad.forEach(function (x) { console.log("  ❌ " + x); });
    console.log("");
  }
  // CTXGUARD 静态检查（不依赖运行时）
  const ctxBad = checkCtxGuard();
  if (ctxBad.length) {
    console.log("=== CTXGUARD 失败（路由引用了未声明的 ctx）===");
    ctxBad.forEach(function (x) { console.log("  ❌ " + x); });
    console.log("");
  }
  // 【关键】EMPTY 必须拆成两个独立计数：
  //   · EMPTY（真缺失）—— 契约有内容、本地语义下本该有、但我没实现 → 应持续下降
  //   · EXPECTED（合理为空）—— 本地单机确实没有该数据 → 应稳定，且每条附理由
  // 混在一起会同时掩盖两个方向的问题：压数字时会诱导我去伪造数据。
  const realEmpty = results.reduce(function (n, r) { return n + r.issues.filter(function (i) { return i.kind === "EMPTY"; }).length; }, 0);
  const expectedEmpty = results.reduce(function (n, r) { return n + r.issues.filter(function (i) { return i.kind === "EXPECTED"; }).length; }, 0);
  console.log("=== 契约审计汇总 ===" + (PROFILE ? "  [基准: " + PROFILE + "]" : "  [基准: 新账号]"));
  console.log("  审计端点: " + results.length);
  console.log("  ✅ 完全通过: " + clean.length);
  for (const k of ["REPLAY", "DEAD", "MISSING", "TYPE", "STATIC"]) {
    if (byKind[k]) console.log("  " + k + ": " + byKind[k]);
  }
  console.log("  ── 空值分解 ──");
  console.log("  ❗ EMPTY 真缺失: " + realEmpty + " 处（应收敛到 0）");
  console.log("  ○ EXPECTED 合理为空: " + expectedEmpty + " 处（单机语义本就无此数据）");
  console.log("  【判据】EXPECTED 每条都必须有理由；无理由的一律算 EMPTY。");
  console.log("");
  // 按严重度列出
  for (const k of ["REPLAY", "DEAD", "TYPE", "STATIC", "MISSING", "EMPTY"]) {
    const hit = results.filter(function (r) { return r.issues.some(function (i) { return i.kind === k; }); });
    if (!hit.length) continue;
    console.log("---------- " + k + " (" + hit.length + " 个端点) ----------");
    for (const h of hit) {
      const mine = h.issues.filter(function (i) { return i.kind === k; });
      console.log("  " + h.api);
      for (const i of mine.slice(0, 4)) console.log("      " + i.path + "  " + i.note);
      if (mine.length > 4) console.log("      ... 另 " + (mine.length - 4) + " 处");
    }
    console.log("");
  }
})();