// local offline server 本地服务器 —— 核心。
//
// 目标：接管客户端的 API 流量，用本地数据替代已停服的官方服务器。
//
// 协议要点（从真实抓包 + 反编译确认）：
//  · 业务 API 基址 = https://<platform>.legend-clover.net/v1/<apiName>
//  · 请求/响应均为 JSON；成功响应包一层 {"result": {...}}
//  · 错误响应 { "result": { "alterCode": N, "alterMessage": "...", "randomCode": "...", "requestId": "..." } }
//    alterCode 7 = 维护中（客户端会显示维护页）
//  · /v1/ping 返回一个裸数字（非 JSON 对象）
//
// 端口：默认 18081（Angelica 用了 18080，错开）。
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { guildInternal, repairCharacterCodes, touchedCharacterIds as touchedCharacterIdsSync, syncLinkBattlePower, syncStatChanges, markDirty as markStateDirty } from "./state.mjs";
import { recomputeById as recomputeCharacterSync } from "./character.mjs";
import { isSupportCharacter as _isSup, statusCodeFor as _codeFor, initialBreakLimit as _breakLimitFor } from "./character.mjs";

const HERE = path.dirname(process.argv[1] || ".");
const PORT = Number(process.env.LEGECLOX_PORT || 18100);
const CONTRACTS = path.join(HERE, "contracts");

// ---- 客户端资源目录（用户自备）----
// 默认：<工作目录>/client/*_Data  或 环境变量 LGSRV_CLIENT_DATA 直接指定
function resolveClientData() {
  if (process.env.LGSRV_CLIENT_DATA) return process.env.LGSRV_CLIENT_DATA;
  var root = path.join(HERE, "..", "client");
  try {
    var hit = fs.readdirSync(root).filter(function (n) { return /_Data$/.test(n); });
    if (hit.length) return path.join(root, hit[0]);
  } catch (e) {}
  return path.join(root, "Game_Data");
}
const CLIENT_DATA = resolveClientData();

// Request log. Kept in a file rather than only on stdout so the history survives:
// a streamed job output is consumed on read, which made earlier diagnosis impossible.
const REQ_LOG = path.join(HERE, "_requests.log");
const RESP_LOG = path.join(HERE, "_responses.log");
// ★ 2026-10-21（用户要求）：全量请求日志 —— 每个请求的完整 body，不再按端点挑字段。
//   单独的 _requests_full.log，避免污染 _requests.log 的一行一条摘要格式。
//   body 上限 20000 字符；若客户端用了 compression（content-encoding）会标注，body 为乱码属正常。
const FULL_REQ_LOG = path.join(HERE, "_requests_full.log");

// In-memory cache for files that are large and requested repeatedly.
// readFileSync blocks Node's single thread, so a burst of concurrent requests
// (the game fetches thousands of assets) serialises behind every disk read.
// Caching the few big ones removes the repeated cost entirely.
const fileCache = new Map();

export function cachedRead(file) {
  // 缓存必须跟磁盘状态挂钩：之前只按路径缓存，替换了文件（例如重打 master zip）后
  // 仍会一直返回进程启动时的旧内容，导致客户端永远拿到过期数据。
  let st = null;
  try { st = fs.statSync(file); } catch (e) { return fs.readFileSync(file); }
  const hit = fileCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.buf;
  const buf = fs.readFileSync(file);
  fileCache.set(file, { mtime: st.mtimeMs, size: st.size, buf });
  return buf;
}

// Stream a file instead of reading it whole: no event-loop stall, no large allocation.
// Falls back to a 404 when the path is missing.
export function streamFile(file, res, contentType) {
  let st;
  try { st = fs.statSync(file); } catch (e) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{\"error\":\"not found\"}");
    return true;
  }
  res.writeHead(200, { "Content-Type": contentType || "application/octet-stream", "Content-Length": st.size });
  const rs = fs.createReadStream(file);
  // A ReadStream error MUST be handled: without a listener the emitted 'error' event is
  // unhandled and Node terminates the whole process. That is exactly what happened when the
  // game held a file open (EBUSY) -- one locked asset killed the server mid-session.
  rs.on("error", function () {
    try { res.destroy(); } catch (e) { /* already gone */ }
  });
  res.on("close", function () { try { rs.destroy(); } catch (e) { /* noop */ } });
  rs.pipe(res);
  return true;
}
// ---------- 工具 ----------
const j = (obj) => JSON.stringify(obj);
const ok = (result) => j({ result });
const err = (alterCode, alterMessage) => j({ result: { alterCode, alterMessage, randomCode: "000000000000_000000000000000", requestId: "" } });

// ★ 2026-10-19：人为延迟 —— 本地服务端响应只有 1~2ms，真实服务器 100~300ms。
//   实测证据：IAP 回调"同帧完成"时标题页会多弹一次跳过窗，"晚一帧"时不弹。
//   ⇒ 给平台接口补上真实量级的延迟，让客户端状态机看到正常的先后顺序。
//   可用环境变量调整：LEGECLOX_DMM_LATENCY_MS / LEGECLOX_API_LATENCY_MS（设 0 关闭）
//   ★ 2026-10-19 修正：按用户意见改成【所有接口】统一延迟，不再只挑两个。
//   只跳过【二进制资源 / master 包 / WebSocket】，否则几千个资源各延迟 150ms 会把加载拖成几分钟。
const ALL_LATENCY = Number(process.env.LEGECLOX_LATENCY_MS == null ? 150 : process.env.LEGECLOX_LATENCY_MS);
const DMM_LATENCY = ALL_LATENCY;             // 平台接口跟着全局走
const FILE_RE = /\.(zip|png|jpe?g|webp|unity3d|bundle|ab|ogg|mp3|wav|mp4|bin|dat|css|js)$/i;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 5e7) req.destroy(); });
    req.on("end", () => resolve(b));
  });
}

// ---------- 已抓到的真实响应（回退基线）----------
// 未实现本地逻辑的端点直接回放真实响应，让客户端先跑起来。
const captured = new Map();

// 端点响应骨架（由 gen_skeletons.mjs 从客户端 C# 类声明生成）。
// 用途：既没实现、也没录制样本的端点，至少返回【结构正确】的响应，
// 而不是 alterCode 9998（那会让客户端直接弹「通信エラー」）。
const skeletons = new Map();
function loadSkeletons() {
  const p = path.join(HERE, "endpoint-skeletons.json");
  if (!fs.existsSync(p)) return 0;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const k of Object.keys(j)) skeletons.set(k, j[k]);
    return skeletons.size;
  } catch (e) { console.error("[skeleton] load failed: " + e.message); return 0; }
}
function loadCaptured() {
  if (!fs.existsSync(CONTRACTS)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(CONTRACTS)) {
    if (!f.endsWith(".json") || f.endsWith(".req.json")) continue;
    const name = f.replace(/\.json$/, "");
    try {
      captured.set(name, fs.readFileSync(path.join(CONTRACTS, f), "utf8"));
      n++;
    } catch { /* ignore unreadable files */ }
  }
  return n;
}

/** 把 API 路径转成契约文件名（与抓取时的命名规则一致）。 */
function contractName(apiPath) {
  return apiPath.replace(/[?&=]/g, "_").replace(/\//g, "_").replace(/[^A-Za-z0-9_.-]/g, "_");
}

// ---------- 路由 ----------
const routes = new Map();
export function route(apiPath, handler) { routes.set(apiPath, handler); }

/**
 * 取某个端点的【契约形状】作为响应基板。
 *
 * 为什么需要：手写每个响应字段极易漏（实测 48 个端点有缺字段，会让客户端
 * 反序列化失败）。契约录制里字段名与嵌套形状是经过验证的，用它作基板可保证
 * 结构永远正确；再由状态引擎覆盖我们真正改动过的值。
 *
 * 传入 contractName（抓取时的文件名）与要覆盖的字段。
 */
export function shaped(contractName, overrides) {
  const base = captured.get(contractName);
  let obj;
  if (base) {
    try { const j = JSON.parse(base); obj = (j.result !== undefined) ? j.result : j; } catch (e) { obj = {}; }
  } else obj = {};
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      const v = overrides[k];
      if (v !== undefined) obj[k] = v;
    }
  }
  return ok(obj);
}

/** 同上，但返回对象本身（供调用方继续加工）。 */
/** 按请求路径自动找契约形状（路径 -> 文件名 的规则与抓取时一致）。 */
/**
 * 用契约形状补全响应里【缺失的顶层字段】。
 *
 * 只补缺失的、绝不覆盖 handler 已设置的值 —— 这样：
 *   · 字段名与嵌套形状来自已验证的录制，客户端反序列化不会失败；
 *   · 涉及状态的值由我们的路由提供，不再是过期快照。
 * 非对象结果（数组/标量）原样返回，不做处理。
 */
/**
 * 用【契约形状】作为响应骨架，再用【状态值】覆盖。
 *
 * 设计依据（用户明确要求）：
 *   · 录制接口的用途是【测试基准】，不是回放素材；
 *   · 数值会变（数量/时间/等级）允许不同，但【结构与字段名】必须一致 ——
 *     否则客户端反序列化失败；
 *   · 静态值（角色 id、道具 id 等游戏主数据常量）必须正确。
 *
 * 契约里的【字段名与嵌套形状】是 API 契约的一部分（静态），用它做骨架是正当的；
 * 而【值】必须来自状态。本函数会记录每个仍沿用契约值的字段，让"哪些值是陈旧的"
 * 一目了然 —— 这正是之前 mergeShape 做不到的（它静默填充，掩盖缺陷）。
 */
// 【语义单例字段的出口规范化】(2026-09-28)
// 有些字段的语义是「玩家当前状态」的**单例**，其正确值只可能来自状态，
// 绝不可能来自契约录制值。最典型的是 guild_internal_data：
// 契约里录的是【录制账号在公会里】(guild_name="プレイヤー")。
// 客户端判据 TemporaryGuildPublicData.IsEmpty():
//     if (guild_name != null) return false;  return guild_id == 0;
// 空串 != null → IsEmpty()=false → 客户端认为【已入会】→ 去查公会聊天室
// → GetRoomList(ChatType.Guild).FirstOrDefault() = null
// → ChatTopicMessage..ctor 的 NullCheck(roomInfo) 抛 NRE（主页每帧崩）。
// 为什么必须在出口统一处理：merge 的对象分支对「契约有、我没提供」的键走
// neutralOf(base[k]) **直接赋值、不递归**，所以只要 handler 漏填（尤其是提前
// return 分支），该字段就会被静默变成空串。逐处补 = 必然漏改（已实测漏了 5 个端点）。
// 这里做一次深度规范化：凡是名为 guild_internal_data 的键，值一律换成 guildInternal()。
// 【关键】未入会时必须【删除】guild_name 等字符串键，而不是发 null(2026-09-28)
// 客户端用 Unity 的 JsonUtility 反序列化，而 JsonUtility 走 Unity 序列化后端，
// **不支持 null 字符串** —— JSON 里的 null 会被解析成 ""（空字符串）。
// 而客户端判据 TemporaryGuildPublicData.IsEmpty()（C++ 实证）是：
//     if (guild_name != null) return false;   // "" != null → 到这里就 return false 了！
//     return guild_id == 0;
// 于是发 null 根本无效：客户端仍判定「已入会」→ 走公会分支 →
// GetRoomList(ChatType.Guild) 空 → ChatTopicMessage..ctor 的 NullCheck 抛 NRE。
// 解法：**省略该键**。键不存在时 JsonUtility 不会给该字段赋值，
// 字段保持 C# 默认值 null → IsEmpty() 才能真正走到 guild_id == 0 那一支。
const GUILD_NULL_STRING_KEYS = ["guild_name", "guild_master_name", "recruit_message", "information_message"];
const SEMANTIC_SINGLETONS = {
  guild_internal_data: () => {
    const g = guildInternal();
    // 仅未入会时删除：入会时这些字段可能有合法空串（契约实测 recruit_message: ""）
    const joined = !(g && (g.guild_name === null || g.guild_name === undefined) && g.guild_id === 0);
    if (!joined && g && typeof g === "object") {
      for (const k of GUILD_NULL_STRING_KEYS) {
        if (g[k] === null || g[k] === undefined) delete g[k];
      }
    }
    return g;
  },
};
function normalizeSemanticSingletons(node, depth) {
  if (depth > 12 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = normalizeSemanticSingletons(node[i], depth + 1);
    return node;
  }
  for (const k of Object.keys(node)) {
    const factory = SEMANTIC_SINGLETONS[k];
    if (factory) {
      try { node[k] = factory(); } catch (e) { /* 状态未就绪：保留原值 */ }
    } else {
      node[k] = normalizeSemanticSingletons(node[k], depth + 1);
    }
  }
  return node;
}

// 【字符串出口】把语义单例规范化应用到任意 JSON 响应文本。
// 覆盖三个出口：①路由返回的字符串 ②回放 (captured) ③骨架。
// 回放路径尤其重要：录制响应里的 guild_internal_data 是【录制账号在公会里】，
// 直接回放会让客户端以为玩家入了会 → 查公会聊天室 → NRE。
// 先做廉价的 substring 判断，避免对 10MB 级响应做无谓的 parse/stringify。
/**
 * ★★ 出口统一重算 + 响应体内角色对象刷新（收口点）★★
 *
 * 缺陷背景（2026-09-30 用户报障）：
 *   training_board/upgrade_board 只改 TrainingNode，从不重算 StatusList
 *   → 界面显示 92/92 满级、材料已扣，但属性加成仍是基础 8%，属性与战力不动。
 *   同类漏改还有 enhance_bulk / break_limit_bulk / level_down / enhance_legend /
 *   enhance_master / release_memory —— 共 7 处。
 *   根因不是「某个 handler 忘了调」，而是【通用逻辑散落在调用处】。
 *
 * 收口设计（符合本项目「任何场景都该生效的逻辑必须在公共层收口」铁律）：
 *   变更点只需 touchCharacter(id)；本函数在【所有响应的唯一出口】完成三件事：
 *     ① 重算被触碰角色的 StatusList（反映最新养成状态）
 *     ② 把响应体里这些角色的对象替换为最新值
 *        （handler 是在 touch 之后、重算之前构造 out 的，直接发出去会是旧值 →
 *          客户端拿旧值更新面板，看不到即时效果）
 *     ③ 之后才做其他出口处理（guild 语义单例等）
 *
 * 开销：touchedChars 为空时零开销（绝大多数请求）；非空时按角色数重算（单个 ~11ms）。
 */
function refreshTouchedCharactersIn(text) {
  if (typeof text !== "string") return text;
  // ★★★ 2026-10-22：属性变更收口 —— 先按【快照 diff】自动判定哪些角色的属性输入变了，
  //   再取 touchedCharacterIdsSync()。这样 handler 忘了 touchCharacter 也不会漏重算。
  let ids = [];
  try { syncStatChanges(); } catch (e) { console.error("[stat-sync] " + e.message); }
  try {
    // 同步读取：state.mjs 的这些追踪集合是模块级变量，可直接取。
    ids = touchedCharacterIdsSync();
  } catch (e) { return text; }
  if (!ids.length) return text;
  const fresh = {};
  for (const id of ids) {
    const c = recomputeCharacterSync(id);
    if (c) fresh[String(id)] = c;
  }
  // ★★ 2026-10-22：重算完 StatusList 之后，把 link 合计写回主角色 ★★
  //   支援角色升级/突破/换装备都会改 CharaBattlePower → 挂着它的 main 的
  //   TotalBattlePower 必须同步（客户端只显示这个字段，见 BattleFormula）。
  //   sync 内部会 touchCharacter(main)，所以下面再扫一遍 touchedCharacterIdsSync。
  try { syncLinkBattlePower(); } catch (e) { console.error("[link-bp] sync失败: " + e.message); }
  // ★ 2026-10-22：重算结果必须落盘 —— 否则下次启动又从旧文件读回「加成=0」
  //   （实测：training_board/upgrade_board 之后 flushNow() 在重算【之前】执行，
  //     内存里 TrainingBoardStatusPercent=+1%，磁盘上还是 0）。
  try { markStateDirty(); } catch (e) {}
  for (const id of touchedCharacterIdsSync()) {
    const key = String(id);
    if (fresh[key]) continue;
    const c = recomputeCharacterSync(key);
    if (c) fresh[key] = c;
  }
  if (!Object.keys(fresh).length) return text;
  console.log("[status.recompute] " + Object.keys(fresh).length + " 个角色 StatusList 已重算");
  // 只在响应体确实含角色对象时才解析（关键字符廉价判定）。
  if (text.indexOf("master_character_id") === -1) return text;
  try {
    const j = JSON.parse(text);
    let replaced = 0;
    const walk = (node) => {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = walk(node[i]); return node; }
      const id = node.master_character_id;
      // ★★ 必须限定「这确实是角色对象」★★
      //   踩坑记录：SkillList 的元素（技能记录）也带 master_character_id
      //   （{id, player_account_id, master_character_id, master_skill_id}），
      //   早期只按 master_character_id 匹配 → 把技能记录整个替换成了角色对象，
      //   审计报 MISSING: SkillList[0].master_skill_id 缺失。
      //   判据：角色对象的标志是【一定有 StatusList 或 CharaBattlePower/TotalBattlePower】，
      //   技能记录则一定有 master_skill_id。
      const isCharObject = node.StatusList !== undefined ||
                           node.CharaBattlePower !== undefined ||
                           node.TotalBattlePower !== undefined;
      const isSkillRecord = node.master_skill_id !== undefined;
      if (id !== undefined && !isSkillRecord && isCharObject && fresh[String(id)]) {
        replaced++;
        return fresh[String(id)];
      }
      for (const k of Object.keys(node)) node[k] = walk(node[k]);
      return node;
    };
    const out = walk(j);
    if (!replaced) return text;   // 响应里其实没有这些角色 → 保持原样（省一次序列化）
    return JSON.stringify(out);
  } catch (e) { return text; }
}

function finalizeBody(text) {
  if (typeof text !== "string") return text;
  // ★ 先统一重算并刷新响应体内的角色对象（见上方注释）
  text = refreshTouchedCharactersIn(text);
  // ★★ 出口收口的两个自愈（符合「通用逻辑必须在公共层收口」）：
  //   ① guild_internal_data —— 未入会时省略 4 个字符串键（客户端 IsEmpty() 判据）
  //   ② CharacterList —— 角色字段形状（主角/支援是两套字段名；支援缺
  //      additional_link_soldier_type_list 会让客户端 .ToList() 抛 ArgumentNullException
  //      导致【整次 load_user_data 失败】→ 表现为「通信エラー」）
  //   ② 的必要性：早期只在 gacha/list 里自愈，但客户端启动链【不经过】该端点，
  //      脏数据会直接随 load_user_data 下发 → 崩在启动。
  // ★★★ 剔除内部状态顶层键（`__` 前缀）—— 2026-10-16 ★★★
  //
  // 由来：`user/load_user_data` 用 `ok(s)` **直接返回整个 state**（routes-read.mjs:60），
  //   于是 state 里 29 个内部标记全被下发给客户端，合计 **0.728 MB**
  //   （其中 `__shopStock` 独占 **686 KB** —— 它来自 shop/get_re_event_shop_stock_info，
  //     把整份 re_event_goods 列表存进 state 并【持久化】）。
  // ★ 契约里 `__` 键是 **0 个** —— 它们是服务端实现细节，不属于协议。
  // ★ 收口在【唯一出口】：一次覆盖所有端点（不必逐个 handler 改）。
  // ★ 廉价短路：不含 `"__` 的响应直接跳过（10 MB 级响应不做无谓的 parse/stringify）。
  // ★ 除了 `__` 前缀，还有几个【没有前缀的自造 state 字段】也必须拦下：
  //   `guild_joined` 只用于服务端判定「玩家是否在公会」（guildInternal 读它），
  //   契约（contracts + _winr 两份）里**没有**这个键 —— 早期 strip 只处理 `__`，
  //   于是它被下发给客户端，让 load_user_data 的顶层键变成 58 个（契约 57）。
  const STATE_ONLY_KEYS = ["guild_joined"];
  const hasStateOnly = STATE_ONLY_KEYS.some(function (k) { return text.indexOf('"' + k + '"') !== -1; });
  if (!process.env.LEGECLOX_NO_STRIP && (text.indexOf('"__') !== -1 || hasStateOnly)) {
    try {
      const j0 = JSON.parse(text);
      const r0 = j0 && j0.result;
      if (r0 && typeof r0 === "object" && !Array.isArray(r0)) {
        let stripped = 0, bytes = 0;
        for (const k of Object.keys(r0)) {
          if (k.startsWith("__") || STATE_ONLY_KEYS.indexOf(k) >= 0) {
            bytes += JSON.stringify(r0[k]).length; delete r0[k]; stripped++;
          }
        }
        if (stripped) {
          console.log("[strip] 剔除 " + stripped + " 个内部状态键（" + (bytes / 1024).toFixed(0) + " KB）");
          text = JSON.stringify(j0);
        }
      }
    } catch (e) { /* 解析失败则原样返回，绝不影响响应 */ }
  }

  const needGuild = text.indexOf("guild_internal_data") !== -1;
  const needChars = text.indexOf("CharacterList") !== -1;
  if (!needGuild && !needChars) return text;
  if (needChars) {
    try {
      const n = repairCharacterCodes(_isSup, _codeFor, _breakLimitFor);
      if (n) console.log("[chars.repair@finalize] 修复 " + n + " 处角色字段（出口自愈）");
    } catch (e) { /* 自愈失败不得影响响应 */ }
  }
  if (!needGuild) return text;
  try {
    const j = JSON.parse(text);
    const before = j && j.result && j.result.guild_internal_data;
    if (!before || typeof before !== "object") return text;
    // 【服务端侧铁证】每次带 guild_internal_data 的响应都记录实际发出的 guild_name。
    // 排查「客户端以为已入会」时，这是判断「到底是谁发的」唯一可靠方式 ——
    // 客户端探针只能看到「已入会」的结果，看不到是哪个端点造成的。
    console.log("[guild.out] guild_id=" + before.guild_id + " guild_name=" +
                JSON.stringify(before.guild_name) + " member_list=" +
                ((before.member_list || []).length) + "  <- " +
                "(keys=" + Object.keys(before).length + ")");
    normalizeSemanticSingletons(j, 0);
    const after = j.result.guild_internal_data;
    if (before.guild_name !== after.guild_name) {
      console.warn("[semantic] guild_internal_data.guild_name " + JSON.stringify(before.guild_name) +
                   " -> " + JSON.stringify(after.guild_name) + " (契约录制值已由状态取代)");
    }
    return JSON.stringify(j);
  } catch (e) { return text; }
}

export function okShaped(apiPath, overrides, opts) {
  const name = contractName(apiPath);
  let key = name;
  if (!captured.has(key)) {
    for (const k of captured.keys()) { if (k === name || k.indexOf(name + "_") === 0) { key = k; break; } }
  }
  const raw = captured.get(key);
  if (!raw) return ok(overrides || {});
  let skeleton;
  try { const jj = JSON.parse(raw); skeleton = (jj.result !== undefined) ? jj.result : jj; } catch (e) { return ok(overrides || {}); }
  if (typeof skeleton !== "object" || skeleton === null || Array.isArray(skeleton)) return ok(overrides || {});
  // 【关键】深度合并：契约提供【结构】，我的值提供【数值】。
  // 早期是浅覆盖，若我的值是空对象/空数组就会把契约的嵌套字段全部抹掉 ——
  // 实测导致 battle/win 的 quest_result_temp（29 个字段）全空。
  // 规则：
  //   · 我的值是【非空对象】且契约对应位置也是对象 -> 递归合并
  //   · 我的值是【空对象/空数组】-> 保留契约结构（那是 API 契约的一部分）
  //   · 其他情况（标量、非空数组、null）-> 用我的值
  // 【中性值】按契约的【类型与键集】生成，值全部置零 ——
  // 这样结构（客户端反序列化所需）与契约一致，但**绝不带入录制时的数据**。
  // 这是本函数的核心取舍：结构借契约、内容必须来自状态。
  function neutralOf(v, depth) {
    if (depth > 8) return null;
    if (Array.isArray(v)) return [];
    if (v === null) return null;
    const t = typeof v;
    if (t === "string") return "";
    if (t === "number") return 0;
    if (t === "boolean") return false;
    if (t === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = neutralOf(v[k], depth + 1);
      return o;
    }
    return null;
  }

  function merge(base, over, path) {
    // 【语义单例字段必须收口】(2026-09-28)
    // guild_internal_data 是「玩家当前公会状态」的语义单例：正确值只可能来自状态，
    // 绝不可能来自契约的录制值。契约里它录的是【录制账号在公会里】
    // (guild_name="プレイヤー")，于是任何没有显式提供该字段的 handler 走兜底时，
    // 都会被 neutralOf 变成 guild_name=""。而客户端判据是
    // TemporaryGuildPublicData.IsEmpty():
    //     if (guild_name != null) return false;  return guild_id == 0;
    // 空串 != null → IsEmpty()=false → 客户端认为【已入会】→ 去查公会聊天室
    // → GetRoomList(ChatType.Guild).FirstOrDefault() = null
    // → ChatTopicMessage..ctor 的 NullCheck(roomInfo) 抛 NRE（主页每帧崩）。
    // 修法：该字段的 base 一律换成 guildInternal()（未入会时 guild_name 本就是 null，
    // neutralOf 对 null 原样保留）。无论 handler 是否漏填、是否走提前返回路径，
    // 出口都必然是正确语义 —— 符合「通用逻辑必须在公共层收口」。
    if (typeof path === "string" && /(^|\.)guild_internal_data$/.test(path)) {
      try { base = guildInternal(); } catch (e) { /* 状态未就绪时退回契约 base */ }
    }
    if (over === undefined) {
      // 我完全没提供这个字段 → 用中性值占位（保证结构），
      // 并记录以便发现「handler 漏填」的端点。
      if (base !== undefined) {
        console.warn("[shape-tripped] " + path + " 未由 handler 提供，已置中性值");
      }
      return neutralOf(base, 0);
    }
    // 【显式 null 必须保留】—— null 在契约里是合法值，且客户端常以 null 作语义判据。
    // 反例（2026-09-28 卡死真因）：客户端 TemporaryGuildPublicData.IsEmpty() 的判据是
    //     if (guild_name != null) return false;  return guild_id == 0;
    // 即「未入会」唯一合法表达是 guild_name === null。
    // 若把 handler 明确给的 null 换成中性值 ""（空字符串不是 null！），
    // 客户端会误判为「已入会」→ 查公会聊天室 → 空列表 FirstOrDefault()=null
    // → NullCheck 抛 NRE → 主页每帧崩 → 界面卡死。
    // 规则：契约侧是 string/object/array 时原样保留 null；
    //       契约侧是 number/boolean（C# 值类型，为 null 会反序列化失败）时仍用中性值。
    // ★★ 【多态字段】—— 真机实测这类字段的类型【按需变化】，绝不能被契约类型强制统一：
    //   · player_all_asset（tutorial/progress 等）：本次无发放 → ARRAY[0]；有发放 → object
    //     （15 次实测：13 次 ARRAY[0]、2 次 object —— 分别对应 type=4 发支援角色、type=15 发装备+道具）
    //   · UserAssetGachaGroupList（gacha/list）：从未扭蛋 → null；扭过后 → 数组
    //   早期 merge 会把我的 [] / null 按契约类型改回对象/数组，掩盖了真实语义。
    //   规则：这些字段【原样透传 handler 给的值】，不做类型归一。
    //   · daily_reward_received（quest/skip）：该任务【无 DailyRewardId】时是 ARRAY[0]，
    //     有 DailyRewardId 时是 object {quest_group_set_id, daily_reward_received_count}
    //     —— 实证：本地录制用 MasterQuest_Soldier_05（有 DailyRewardId → 对象），
    //     真机 winr 用 STARFORCE_Cerberus_Hard_141（无 → 空数组）。
    //     早期 merge 按契约类型把我的 [] 改回对象，导致"无每日奖励"的任务也报了一条记录。
    if (typeof path === "string" && /(^|\.)(player_all_asset|UserAssetGachaGroupList|UserAssetBoxGachaGroupList|daily_reward_received)$/.test(path)) {
      return over;
    }

    if (over === null) {
      // 仅在这两种情况下保留 null（都是 C# 里可安全为 null 的引用类型）：
      //   · 契约该处本身就是 null / 不存在（真实服务器也发 null，客户端已验证可容忍）
      //   · 契约该处是 string（C# string 是引用类型；空串与 null 语义可能不同！）
      // 其余情况（契约是数字/布尔/对象/数组）仍用中性值，
      // 避免把 null 送进客户端会立即解引用的字段。
      if (base === undefined || base === null || typeof base === "string") return null;
      // ★★ 2026-10-08 修正：契约是 object/array 时也要保留 null ★★
      //   反例（training_board/upgrade_board）：handler 明确回 `SupportCharacter: null`
      //   （因为本次强化的是【主角色】，支援侧就该是 null —— 真机契约同样是 null），
      //   而契约基板（录制的成熟账号那次强化的是支援角色）里它是【对象】→
      //   被 neutralOf 换成空对象 → 审计报
      //     EMPTY: SupportCharacter.additional_link_soldier_type_list 契约 7 条，实现为空。
      //   语义：**「本次不涉及该实体」的正确表达就是 null**，与 guild_name 那次同类。
      //   客户端对这两个字段都只做判空（null → 跳过渲染），不会解引用。
      return null;
    }
    // 【容器类型属于契约】契约是数组就必须给数组，是对象就必须给对象。
    // 实测 player_all_asset 在 4 个端点是数组、26 个端点是对象 ——
    // 用统一对象去覆盖数组型端点会让客户端解析失败。
    const baseIsArr = Array.isArray(base);
    const overIsArr = Array.isArray(over);
    if (base !== undefined && baseIsArr !== overIsArr) {
      console.warn("[shape] TYPE MISMATCH at " + path + ": contract=" + (baseIsArr ? "array" : "object") + " override=" + (overIsArr ? "array" : "object") + " -> 采用契约类型");
      return base;
    }
    if (Array.isArray(over)) {
      // 【重要】契约是数组时，只借用它的【元素形状】检验（结构属于契约），
      // 但**绝不能借用它的内容** —— 早期写成「我空则返回契约数组」，
      // 结果把录制时抽到的角色（Ch001800103）注入了每一次响应，
      // 客户端以为抽到了却没入库 → 表现为「抽卡结果显示的角色丢失」。
      // 正确语义：我空就是空（数组类型已由上面的类型检查保证）。
      return over;
    }
    if (typeof over === "object") {
      const keys = Object.keys(over);
      // 同数组规则：**只借契约的结构、不借内容**。
      // 我传了空对象就返回空对象（早期返回契约对象 → 把录制时的数据注入了响应）。
      if (keys.length === 0) return over;
      if (base && typeof base === "object" && !Array.isArray(base)) {
        const out = {};
        // 【只借结构，绝不借值】：契约有、我没提供的键 → 用中性值（neutralOf）。
        // 早期写成 `out[k] = base[k]` 直接拷贝契约值 —— 那正是
        // 「guild_id 出现契约值 36493」这类泄漏的根源。
        for (const k of Object.keys(base)) {
          if (!(k in over)) {
            out[k] = neutralOf(base[k], 0);
            console.warn("[shape-tripped] " + path + "." + k + " 未由 handler 提供，已置中性值");
          }
        }
        for (const k of keys) out[k] = merge(base[k], over[k], path + "." + k);
        return out;
      }
      return over;
    }
    return over;
  }
  const merged = merge(skeleton, overrides || {}, apiPath);
  normalizeSemanticSingletons(merged, 0);
  if (opts && opts.warn) {
    const stale = [];
    for (const k of Object.keys(skeleton)) { if (!overrides || !(k in overrides)) stale.push(k); }
    if (stale.length) console.warn("[shape] " + apiPath + " 沿用契约结构: " + stale.slice(0, 8).join(",") + (stale.length > 8 ? " (+" + (stale.length - 8) + ")" : ""));
  }
  return ok(merged);
}
export function mergeShape(apiPath, plainText) {
  // 【已停用】原实现用录制契约补齐缺失字段 —— 那等于把回放伪装成实现，
  // 会掩盖「我根本没返回这个字段」的真实缺陷（实测掩盖了 96 处 MISSING）。
  // 录制只应作为测试基准，不应参与运行时响应。保留函数签名以兼容调用方。
  if (process.env.LEGECLOX_SHAPE_WARN !== "0") {
    console.warn("[shape] DISABLED (was filling from contract): " + apiPath);
  }
  return plainText;
}

function mergeShapeLegacy(apiPath, plainText) {
  let name = contractName(apiPath);
  if (!captured.has(name)) {
    let found = null;
    for (const k of captured.keys()) { if (k === name || k.indexOf(name + "_") === 0) { found = k; break; } }
    if (!found) return plainText;
    name = found;
  }
  let mine, theirs;
  try { mine = JSON.parse(plainText); } catch (e) { return plainText; }
  if (typeof mine !== "object" || mine === null || Array.isArray(mine)) return plainText;
  try {
    const j = JSON.parse(captured.get(name));
    theirs = (j.result !== undefined) ? j.result : j;
  } catch (e) { return plainText; }
  if (typeof theirs !== "object" || theirs === null || Array.isArray(theirs)) return plainText;
  const mr = mine.result;
  if (typeof mr !== "object" || mr === null || Array.isArray(mr)) return plainText;
  let added = 0;
  for (const k of Object.keys(theirs)) {
    if (!(k in mr)) { mr[k] = theirs[k]; added++; }
  }
  if (!added) return plainText;
  console.log("[shape] " + apiPath + " filled " + added + " missing field(s) from contract");
  return JSON.stringify(mine);
}

export function shapedForPath(apiPath, overrides) {
  const name = contractName(apiPath);
  // 契约文件名可能带查询参数后缀，做一次前缀匹配兜底。
  let key = name;
  if (!captured.has(key)) {
    for (const k of captured.keys()) { if (k === name || k.indexOf(name + "_") === 0) { key = k; break; } }
  }
  return shaped(key, overrides);
}

export function shapeOf(contractName, overrides) {
  const base = captured.get(contractName);
  let obj;
  if (base) {
    try { const j = JSON.parse(base); obj = (j.result !== undefined) ? j.result : j; } catch (e) { obj = {}; }
  } else obj = {};
  if (overrides) for (const k of Object.keys(overrides)) { const v = overrides[k]; if (v !== undefined) obj[k] = v; }
  return obj;
}

// 资源回退钩子（由 routes-cdn.mjs 注入），在路由与回放都未命中时尝试。
let resourceResolver = null;
export function setResourceResolver(fn) { resourceResolver = fn; }

// ★★★ 回放模式目录（LEGECLOX_REPLAY）：直接返回真机抓到的原始响应 ★★★
//   用途：判断「哪一环是我实现的问题」—— 用真机新号的原样响应跑一遍，客户端表现即官方基线。
const REPLAY_DIR = process.env.LEGECLOX_REPLAY || "";

// ★★★ 顺序回放（LEGECLOX_REPLAY_SEQ = 转发器抓包运行目录）★★★
//   用途：把真机【新号建号→教程全程】的响应按时间顺序依次回放，
//   还原官方行为基线（静态目录回放只能给每个端点的最后一份，看不出流程）。
//   数据来源：server/_fwd/run-*/{calls.ndjson, bodies/NN_resp.json}。
//   规则：同一端点的第 k 次调用 → 该端点第 k 份录制响应；用尽后重复最后一份。
const SEQ_DIR = process.env.LEGECLOX_REPLAY_SEQ || "";
const SEQ_SKIP = new Set(["master_data/get_version", "master/load_master_data", "winr/fileInfo", "winr/winr"]);
const seqMap = new Map();     // endpoint -> [{file, status}]
const seqCursor = new Map();  // endpoint -> 已用次数
let seqLoadSnaps = [];        // load_user_data 的快照序列（按录制顺序）
let seqBattleWins = 0;        // 已回放的 battle/win 次数 = 真实推进度
if (SEQ_DIR) {
  try {
    const calls = fs.readFileSync(path.join(SEQ_DIR, "calls.ndjson"), "utf8").split("\n").filter(Boolean);
    for (const line of calls) {
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      const raw = String(o.path || "").replace(/^\/v1\//, "");
      if (!raw) continue;
      const f = path.join(SEQ_DIR, "bodies", o.n + "_resp.json");
      if (!fs.existsSync(f)) continue;
      if (!seqMap.has(raw)) seqMap.set(raw, []);
      seqMap.get(raw).push({ file: f, status: Number(o.status) || 200 });
    }
    console.log("[REPLAY-SEQ] 载入 " + seqMap.size + " 个端点 / " + calls.length + " 条调用记录");
    // ★ load_user_data 不能按「调用次数」索引：客户端【启动时就会连调两次】，
    //   而录制里第 2 份是「打完 3 场之后」的快照（632KB / 7+5 角色 / 教程 Stage16）
    //   ⇒ 会把教程直接跳过（实测：登录直接进主界面）。
    //   正确做法：按【已回放的 battle/win 次数】选快照 = 按真实进度推进。
    seqLoadSnaps = (seqMap.get("user/load_user_data") || []).slice();
  } catch (e) { console.error("[REPLAY-SEQ] 载入失败: " + e.message); }
}
// 回放【排除表】：这些端点的值必须与本地实际文件一致，不能照抄抓包。
//   · master_data/get_version —— 抓包里是当时的 GUID，我们本地只有 c7ae4643…zip；
//     照抄会导致客户端去下 097c52ab…zip → 404 → 通信エラー（实测踩到）。
const REPLAY_SKIP = new Set(["master_data/get_version"]);

// ★ 2026-10-20：DMM 平台接口的应答体（供 /__dmm/ 与 /__o/<dmm-host>/ 两条路径共用）
function dmmResponseBody(dhost, dpath, dreq) {
  if (dhost.indexOf("recibo") >= 0 && dpath.indexOf("/v1/batch/skus") === 0) {
    let ids = [];
    try {
      const q = JSON.parse(dreq || "{}");
      const list = q.productId || q.productIds || q.ProductId || q.ProductIds || q.Skus || q.skus;
      if (typeof list === "string") ids = [list];
      else if (Array.isArray(list)) ids = list.filter((x) => typeof x === "string");
    } catch (e) {}
    if (process.env.LEGECLOX_DMM_SKUS === "0") ids = [];
    const mk = (id) => ({
      ProductId: id, productId: id,
      Type: "consumable", type: "consumable",
      Title: id, title: id,
      Description: id, description: id,
      Price: "¥0", price: "¥0",
      PriceAmountMicros: 0, priceAmountMicros: 0,
      PriceCurrencyCode: "JPY", priceCurrencyCode: "JPY",
    });
    const arr = ids.map(mk);
    return { Skus: arr, skus: arr };
  }
  if (dhost.indexOf("recibo") >= 0 && dpath.indexOf("/v2/pc/sdk/initialize") === 0) {
    return { ApplicationId: 0, applicationId: 0, GamesId: 0, gamesId: 0,
             GamesIdSignature: "", gamesIdSignature: "", ViewerId: 0, viewerId: 0,
             ViewerIdSignature: "", viewerIdSignature: "",
             PointChargeUrl: "", pointChargeUrl: "",
             CreditChangeUrl: "", creditChangeUrl: "",
             IsAdult: true, isAdult: true,
             AppLegalCommerceUrl: "", appLegalCommerceUrl: "" };
  }
  if (dhost.indexOf("recibo") >= 0 && dpath.indexOf("/v1/receipts") === 0) {
    return { ReceiptInfoList: [], InappPurchaseDataList: [], InappDataSignatureList: [],
             receiptInfoList: [], inappPurchaseDataList: [], inappDataSignatureList: [] };
  }
  if (dhost.indexOf("client-netgame") >= 0) return { result: 0 };
  return {};
}

function cdnMime(f) {
  const e = (f.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  if (e === ".gif") return "image/gif";
  if (e === ".json") return "application/json";
  if (e === ".js") return "application/javascript";
  if (e === ".css") return "text/css";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let p = url.pathname;
  // ★ 安卓本地化：metadata 里的域名被换成本地 http 前缀（等长替换），这里还原成原路径
  //   /aaaaaaaaaaaaa/dgs/<name> -> /dgs/<name>；/bbbbbbbbbb/<guid>.zip -> /master/<guid>.zip；/cccccccccc/v1/... -> /v1/...
  const LOCAL_PREFIX = [[/^\/aaaaaaaaaaaa\//, "/dgs/"], [/^\/bbbbbbbbb\//, "/master/"], [/^\/ccccccccc\//, "/"], [/^\/d{8,12}\//, "/"]];
  for (const [re, rep] of LOCAL_PREFIX) if (re.test(p)) { p = p.replace(re, rep); break; }
  if (req.url.includes("cccccccccc") || req.url.includes("aaaaaaaaaaaaa")) console.log("[PREFIX-DBG] in=" + req.url + " -> " + p);
  // 统一：先剥掉 /v1 前缀（业务 API 用），再剥掉前导斜杠，
  // 使注册名与请求路径的规范形式一致（如 "winr/fileInfo"、"title/get_title_info"）。
  // ★ 兼容【录制模式】的路径前缀 /__o/<原host>/<路径>。
  //   插件在两种模式下的写法必须一致（在线=转发器18110，离线=本地18100），
  //   否则每切换一次模式都要重编插件 —— 本项目已因「忘了换插件」导致离线进不去一次。
  //   转发器认这个前缀来选上游；本地服务端只需把它剥掉即可忽略。
  // ★★★ DMM 平台接口实现（不是转发、不是万能 200）★★★
  //   插件把 DMM 域名改写成 /__dmm/<host>/<原路径>，这里按【host + 路径】分别应答，
  //   让 DMM SDK 的每个调用都拿到它期望的形状：
  //     · ae.recibo.../v2/pc/sdk/initialize → InitializeSdkResponseModel
  //     · ae.recibo.../v1/batch/skus       → { skus: [] }（商品列表：空，不是初始化模型）
  //     · api.store.../log/sdk/usage       → {}（用量上报，只要 200）
  //     · log.client-netgame.../client_access.php → {"result":0}
  if (url.pathname.startsWith("/__dmm/")) {
    const rest = decodeURIComponent(url.pathname.slice("/__dmm/".length));
    const si = rest.indexOf("/");
    const dhost = (si < 0 ? rest : rest.slice(0, si)).toLowerCase();
    const dpath = si < 0 ? "/" : rest.slice(si);
    // ★ 必须把请求体读出来：
    //   ① 日志里能看到 SDK 用哪种命名（它用同一个 JsonUtility 序列化请求，键名规则一脉相承）；
    //   ② /v1/batch/skus 必须【按请求里的商品 ID】逐条回 SKU —— 回空数组会让 SDK
    //      拿到 null/空集合，在成功回调里 NRE，最后变成 GET_PRODUCT_API_ERROR
    //      {"message":"Object reference not set to an instance of an object."}。
    let dreq = "";
    try { if (req.method === "POST") dreq = await readBody(req); } catch (e) {}
    if (dreq) console.log("[DMM-REQ] " + dhost + dpath + " body=" + dreq.slice(0, 400));
    let dbody = dmmResponseBody(dhost, dpath, dreq);
    const txt = JSON.stringify(dbody);
    if (DMM_LATENCY > 0) await delay(DMM_LATENCY);
    console.log("[DMM] " + dhost + dpath + " -> " + txt.slice(0, 160) + (DMM_LATENCY > 0 ? "  (+" + DMM_LATENCY + "ms)" : ""));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(txt) });
    res.end(txt);
    return;
  }
  // ★ 2026-10-20：插件会把【一切】http(s) 改写进来，但本地只实现了业务/资源/master/tellme 这些域名。
  //   公告图、通知图等在 misc./notification. 这类 CDN 上 —— 本地没有实现 ⇒ 弹窗内容空白。
  //   这里对【不认识的域名】做「实时回源 + 落盘缓存」：现在能显示，日后断网也能用。
  {
    const KNOWN = new Set(["winr.legend-clover.net", "pcr.legend-clover.net", "pcg.legend-clover.net",
      "dgs.legend-clover.net", "gps.legend-clover.net", "master.legend-clover.net",
      "asset.legend-clover.net", "tellme.legend-clover.net"]);
    const _cm = /^\/__o\/([^\/]+)(\/.*)?$/.exec(url.pathname);
    if (_cm) {
      const _ch = decodeURIComponent(_cm[1]).toLowerCase();
      const _cp = _cm[2] || "/";
      // ★ 2026-10-21 修：asset 域名只在本地实现了 winr/fileInfo 与 winr/winr，
      //   其余路径（winr/sound/native/**、winr/resource/** 等）本地没有实现 →
      //   以前直接掉进业务路由返回 404 → 客户端下载音频时无限重试 → 卡在「展開中 100%」。
      //   现在：asset 域名下未实现的路径也走「回源 + 落盘缓存」。
      const _isAssetUnhandled = (_ch === "asset.legend-clover.net" && !/^\/winr\/(fileInfo|winr)/.test(_cp));
      if ((!KNOWN.has(_ch) || _isAssetUnhandled) && !_ch.endsWith("dmm.com") && !_ch.endsWith("dmm.co.jp")) {
        // ★ 2026-10-21 已撤销：assets/dgs 是安卓(dgs)平台的资源包（Build target 13），
        //   Windows 客户端加载不了 —— 会每帧抛 AssetBundleLoadAsyncJob NRE。
        //   因此 winr 资源仍走「回源 + 落盘缓存」。
        let _assetHit = (typeof global.__assetHit === "number") ? global.__assetHit : 0;
        const CDN_CACHE = path.join(HERE, "_cdn_cache");
        const _safe = _cp.replace(/[?#].*$/, "").replace(/^\/+/, "");
        const _file = path.join(CDN_CACHE, _ch, _safe);
        try {
          if (fs.existsSync(_file)) {
            const buf = fs.readFileSync(_file);
            _assetHit++; global.__assetHit = _assetHit;
            if (_assetHit % 500 === 0) console.log("[ASSET] hit " + _assetHit + " 次（最近: " + _cp + "）");
            res.writeHead(200, { "Content-Type": cdnMime(_file), "Content-Length": buf.length, "X-Local-Cache": "hit" });
            res.end(buf);
            return;
          }
        } catch (e) {}
        // ★ 2026-10-29 本地回源（关服后 CDN 会 404）：
        //   先把资源按 winr 路径映射到 lab/resource 读本地副本，命中就落进 _cdn_cache 并返回；
        //   未命中才走网络。这样 PC 端不依赖外部 CDN。
        try {
          const _plain = _safe.replace(/^winr\//, "");
          const _localPath = path.join(CLIENT_DATA, "resource", _plain);
          if (_plain && fs.existsSync(_localPath) && fs.statSync(_localPath).isFile()) {
            const buf = fs.readFileSync(_localPath);
            try { fs.mkdirSync(path.dirname(_file), { recursive: true }); fs.writeFileSync(_file, buf); } catch (e) {}
            console.log("[CDN] " + _ch + _cp + " -> 200 " + buf.length + "B (local)");
            res.writeHead(200, { "Content-Type": cdnMime(_localPath), "Content-Length": buf.length, "X-Local-Src": "resource" });
            res.end(buf);
            return;
          }
        } catch (e) {}
        try {
          const upstream = "https://" + _ch + _cp;
          const r2 = await fetch(upstream, { headers: { "user-agent": "UnityPlayer/2022.3.62f2" } });
          if (r2.ok) {
            const buf = Buffer.from(await r2.arrayBuffer());
            try { fs.mkdirSync(path.dirname(_file), { recursive: true }); fs.writeFileSync(_file, buf); } catch (e) {}
            console.log("[CDN] " + _ch + _cp + " -> 200 " + buf.length + "B (cached)");
            res.writeHead(200, { "Content-Type": r2.headers.get("content-type") || cdnMime(_file), "Content-Length": buf.length });
            res.end(buf);
            return;
          }
          console.log("[ASSET] MISSING " + _ch + _cp + " (upstream " + r2.status + ")");
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("asset missing: " + _cp);
          return;
        } catch (e) {
          console.log("[ASSET] MISSING " + _ch + _cp + " (fetch err: " + e.message + ")");
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("asset unavailable: " + _cp);
          return;
        }
      }
    }
  }

  // ★ 2026-10-20：插件若把 DMM 也改写进来（"一切请求都改写"模式），
  //   这里识别 /__o/<dmm-host>/... 并交给同一个 DMM 应答器，避免 9998 未实现。
  {
    const _od = /^\/__o\/([^\/]+)(\/.*)?$/.exec(url.pathname);
    if (_od) {
      const _oh = decodeURIComponent(_od[1]).toLowerCase();
      if (_oh.endsWith("dmm.com") || _oh.endsWith("dmm.co.jp")) {
        const _op = _od[2] || "/";
        let _oreq = "";
        try { if (req.method === "POST") _oreq = await readBody(req); } catch (e) {}
        if (_oreq) console.log("[DMM-REQ] " + _oh + _op + " body=" + _oreq.slice(0, 300));
        const _obody = dmmResponseBody(_oh, _op, _oreq);
        const _otxt = JSON.stringify(_obody);
        if (DMM_LATENCY > 0) await delay(DMM_LATENCY);
        console.log("[DMM] " + _oh + _op + " -> " + _otxt.slice(0, 140));
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(_otxt) });
        res.end(_otxt);
        return;
      }
    }
  }
  const _mo = /^\/__o\/[^\/]+(\/.*)?$/.exec(p);
  if (_mo) p = _mo[1] || "/";
  if (p.startsWith("/v1/")) p = p.slice(4);
  else if (p === "/v1") p = "";
  if (p.startsWith("/")) p = p.slice(1);
  // ★ load_user_data：按「已回放的战斗数」选快照（SEQ-LOADUD）
  if (SEQ_DIR && p === "user/load_user_data" && seqLoadSnaps.length) {
    try {
      let idx = 0;
      // 真机只在 4 个时间点取过 load_user_data（建号 / 打完 3 场 / 教程完成 / 继续玩），
      // 中间状态无法重建 ⇒ 前 2 战仍给「建号快照」，避免一跳两级。
      if (seqBattleWins >= 5) idx = 3;
      else if (seqBattleWins >= 4) idx = 2;
      else if (seqBattleWins >= 3) idx = 1;
      const item = seqLoadSnaps[Math.min(idx, seqLoadSnaps.length - 1)];
      const raw = fs.readFileSync(item.file, "utf8");
      console.log("[REPLAY-SEQ] user/load_user_data -> 快照#" + (idx + 1) + " (battles=" + seqBattleWins + ") " + raw.length + "B");
      res.writeHead(item.status, { "Content-Type": "application/json" });
      res.end(raw);
      return;
    } catch (e) { console.error("[REPLAY-SEQ] loadUserData fail: " + e.message); }
  }
  // 顺序回放：同一端点第 k 次调用 → 第 k 份录制响应
  if (SEQ_DIR && p && !p.startsWith("__") && !SEQ_SKIP.has(p) && seqMap.has(p)) {
    try {
      const list = seqMap.get(p);
      const k = seqCursor.get(p) || 0;
      if (p === "battle/win") seqBattleWins++;
      seqCursor.set(p, k + 1);
      const item = list[Math.min(k, list.length - 1)];
      const raw = fs.readFileSync(item.file, "utf8");
      console.log("[REPLAY-SEQ] " + p + " #" + (k + 1) + "/" + list.length + " -> " + item.status + " " + raw.length + "B (" + path.basename(item.file) + ")");
      res.writeHead(item.status, { "Content-Type": "application/json" });
      res.end(raw);
      return;
    } catch (e) { console.error("[REPLAY-SEQ] fail " + p + ": " + e.message); }
  }
  // 回放模式：命中抓包文件则原样返回（未抓到的端点自动落回正常逻辑）
  if (REPLAY_DIR && p && !p.startsWith("__") && !REPLAY_SKIP.has(p)) {
    try {
      const rp = path.join(REPLAY_DIR, p.replace(/\//g, "_") + ".json");
      if (fs.existsSync(rp)) {
        const raw = fs.readFileSync(rp, "utf8");
        console.log("[REPLAY-REAL] " + p + " (" + raw.length + "B)");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(raw);
        return;
      }
    } catch (e) { console.error("[REPLAY-REAL] fail " + p + ": " + e.message); }
  }
  const method = req.method || "GET";
  const body = method === "POST" ? await readBody(req) : "";
  // ★ 所有【接口】响应统一补真实网络延迟（资源/包/WS 除外）
  if (ALL_LATENCY > 0) {
    const _p0 = url.pathname.replace(/^\/__o\/[^\/]+/, "").replace(/^\/v1\//, "/").replace(/^\//, "");
    const _isFile = FILE_RE.test(_p0) || _p0.startsWith("master/") || url.pathname.startsWith("/__ws");
    if (!_isFile) await delay(ALL_LATENCY);
  }
  // 每个请求开始前重置「本次变更」追踪 —— 这样 player_all_asset 的内容
  // 由变更点自动累积，handler 无需手工列举（见 state.mjs 的 beginTouch）。
  try { const _st = await import("./state.mjs"); if (_st.beginTouch) _st.beginTouch(); } catch (e) {}

  // CORS：网页端(WebGL)从 play.games.dmm.co.jp 发请求，必须放行
  // 客户端用这个响应头同步"服务器时间"（GameApi.SetServerTime -> TimeUtility.SetCurrentDateTime）。
  // 卡池开催期间的判断就基于它。不发这个头，客户端会停在旧时间，把卡池判成「開催期間外」。
  res.setHeader("x-server-timestamp", String(Math.floor(Date.now() / 1000)));
  res.setHeader("x-allowed-time-difference", "300");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // DMM / off-machine sink: answer 200 with an empty JSON object so the calling SDK
  // sees a benign result instead of a TLS failure. Registered outside the route table
  // so it always wins and never falls through to the "not implemented" error.
  // 自测用：把状态重置回录制存档。仅在本地服务端有效。
  // ★★★ 时间旅行（仅测试用）：把神谕探索的 start_at 往前推 N 秒 ★★★
  //
  // 为什么需要：探索是【以时间为单位】的（满编 12 人 = 12 小时一轮，
  //   `GetExploreRequiredTime` = (ExploreMember + 1 − 编成人数) × ExploreLap）。
  //   要在自动化测试里验证「奖励发放」，不可能真等 12 小时。
  //
  // ★ 这不是「伪造数据」，而是「受控的输入」：
  //   推进 start_at 之后，**服务端的计算逻辑完全真实地跑一遍**
  //   （已完成轮数 = floor(elapsed / requiredTime)，受 7 天上限约束）。
  //
  // ★ 与 __reset 同款端口闸：**生产端口一律 403**（防止污染用户正在玩的存档）。
  if (p === "__oracle_advance") {
    const isProdPort = !process.env.LEGECLOX_PORT;
    if (isProdPort) {
      console.warn("[GUARD] 拒绝在生产端口 " + PORT + " 上执行 __oracle_advance");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "REFUSED: __oracle_advance is blocked on the production port", port: PORT }));
      return;
    }
    try {
      const { getState, markDirty, flushNow } = await import("./state.mjs");
      const st = getState();
      const o = st.__oracle || (st.__oracle = {});
      const stages = o.stages || (o.stages = {});
      const stageId = (url.searchParams.get("stage_id") || "").trim();
      const seconds = Number(url.searchParams.get("seconds")) || 0;
      const now = Math.floor(Date.now() / 1000);
      const touched = [];
      for (const k of Object.keys(stages)) {
        if (stageId && String(k) !== String(stageId)) continue;
        const stg = stages[k] || {};
        if (!Number(stg.start_at)) stg.start_at = now;
        stg.start_at = Number(stg.start_at) - seconds;
        touched.push({ stage_id: Number(stg.stage_id !== undefined ? stg.stage_id : k), start_at: stg.start_at });
      }
      markDirty(); flushNow();
      console.log("[TEST] __oracle_advance -" + seconds + "s  applied to " + touched.length + " stage(s)");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, advanced_seconds: seconds, stages: touched }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }

  if (p === "__reset") {
    try {
      const { resetState, listProfiles } = await import("./state.mjs");
      // 读 query ?profile=xxx，支持切换到某个「有数据」基准（审计双基准用）。
      const qp = (url.searchParams.get("profile") || "").trim();
      // ★★★ 端口闸：__reset 只允许在【非生产端口】上执行（2026-10-14）★★★
      //
      // 为什么（两次事故的共同根因）：
      //   · 2026-09-30：我在【用户正在玩的 18100】上跑测试，每个用例前后调 __reset
      //     → 用户存档被冲回基准档（177 角色 → 169、石头 1 亿 → 3 万）。
      //   · 2026-10-14：我在 18100 上做「天命强化扣材料」的验证，
      //     把 tenmei 等级推高 1~6 级、master 9→11、消耗了 rune_master 70→0 和 1.1 亿金币。
      //   两次都是「在用户实例上跑会改状态的验证」。
      //
      // 前面的「角色数不能变少」闸只拦得住一类污染 ——
      //   **同等或更多数据量的污染（如上面那次）它完全拦不住**。
      // 所以必须加一道与数据无关的闸：**认端口**。
      //
      // 判据：生产端口 = 18081（默认）/ 18082。非生产端口（18199 测试、其它）一律放行。
      // 需要在生产端口强制重置时，显式带 ?allow_prod=1（并在日志里留痕）。
      // ★ 生产端口 = 本服务的实际端口（默认 18100，用户的实例就是这个）。
      //   我第一版写成 [18081, 18082] —— 那是**别的项目**的端口（本项目早期记录里提过
      //   18081 被 Angelica Aster 占用），凭印象写 → 闸门根本不生效。
      //   正确判据：**「用户正在用的实例」= LEGECLOX_PORT 未显式设置时的默认端口**，
      //   而测试永远显式设 LEGECLOX_PORT=18199。所以：
      //   只要 LEGECLOX_PORT 环境变量【未设置】，就判定为生产实例。
      const isProdPort = !process.env.LEGECLOX_PORT;
      if (isProdPort && url.searchParams.get("allow_prod") !== "1") {
        console.warn("[GUARD] 拒绝在生产端口 " + PORT + " 上执行 __reset（避免污染正在使用的存档）");
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "REFUSED: __reset is blocked on the production port",
          port: PORT,
          hint: "测试/验证请用 LEGECLOX_PORT=18199 + LEGECLOX_STATE=state/_test-user.json；" +
                "确需在生产端口重置请加 &allow_prod=1",
        }));
        return;
      }
      // ★★ 防误覆盖（2026-09-30 事故）★★
      //   我为了「读数据」调 __reset?profile=accumulated，把用户正在玩的存档
      //   （177 角色）覆盖成了基准档（169 角色）→ 用户的抽卡/养成丢失。
      //   加固：若【目标档角色数 < 当前档角色数】，必须显式带 ?force=1 才允许覆盖。
      //   这是「宁可拒绝，也不静默丢数据」的取舍。
      if (qp && url.searchParams.get("force") !== "1") {
        try {
          const cur = JSON.parse(fs.readFileSync(path.join(HERE, "state", "user.json"), "utf8"));
          const tgt = JSON.parse(fs.readFileSync(path.join(HERE, "state", "profiles", qp + ".json"), "utf8"));
          const n = function (o) { const c = o.CharacterList || {}; return ((c.mainCharacterList || []).length) + ((c.supportCharacterList || []).length); };
          if (n(tgt) < n(cur)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "REFUSED: target profile has FEWER characters than current state",
              current: n(cur), target: n(tgt), profile: qp,
              hint: "若确实要覆盖，请加 &force=1",
            }));
            return;
          }
        } catch (e) { /* 读不到就放行（保持旧行为） */ }
      }
      resetState(qp || undefined);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, profile: qp || null, profiles: listProfiles() }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  // 把当前内存状态存为命名基准（seedflow --keep 使用）
  if (p === "__save_profile") {
    try {
      const { saveProfile } = await import("./state.mjs");
      const name = (url.searchParams.get("name") || "default").trim();
      saveProfile(name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: name }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (p === "dmm-blocked") {
    // DMM SDK sink. An empty {} is not enough: the initialize call is deserialized
    // into InitializeSdkResponseModel and a null body produced
    //   GET_PRODUCT_API_ERROR {"message":"Object reference not set to an instance of an object."}
    // which made the client retry the UsageLog upload forever and never leave
    // GameStartState.IapInitialize. Return a fully-populated, benign model instead so
    // deserialisation succeeds and the SDK treats initialisation as done.
    const body = JSON.stringify({
      applicationId: 0,
      gamesId: 0,
      gamesIdSignature: "",
      viewerId: 0,
      viewerIdSignature: "",
      pointChargeUrl: "",
      creditChangeUrl: "",
      isAdult: true,
      appLegalCommerceUrl: "",
    });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  // Request log: the quickest way to tell whether the client got past its start-up
  // gates is to see which endpoints it actually asks for.
  console.log("[REQ-LOG] " + method + " " + p + (url.search || ""));
  // ★ 全量请求日志（用户要求）：完整 URL + 关键头 + 完整 body
  try {
    const h = req.headers || {};
    const head = [
      new Date().toISOString(),
      method,
      p + (url.search || ""),
      "len=" + (body ? Buffer.byteLength(body) : 0),
      "ct=" + (h["content-type"] || "-"),
      "ce=" + (h["content-encoding"] || "-"),
    ].join("  ");
    fs.appendFileSync(FULL_REQ_LOG,
      head + "\n  BODY " + (body ? String(body).slice(0, 20000) : "(empty)") + "\n");
  } catch (e) {}
  try {
    // 记录完整 URL（含 query）—— 排查时 query 参数往往就是关键线索。
    const fullUrl = p + (url.search || "");
    // 记录请求体 —— 排查「同一端点两次调用结果不同」时，参数差异往往是关键线索。
    // ★ 2026-09-30 扩展：原先只记 gacha/*，导致排查 quest/skip 报错时
    //   **完全不知道客户端传的是哪个 questId**（只能看到 URL）。现在按端点分档记录：
    //     · gacha/*        → 抽卡关键字段
    //     · quest/* 写接口 → questId / quest_id / quest_id_list（截断）
    //     · 其它写接口     → 仅记 body 长度（避免日志被大 body 淹没）
    let bodyNote = "";
    if (body) {
      try {
        const b = JSON.parse(body);
        if (/^gacha\//.test(p)) {
          bodyNote = "  BODY=" + JSON.stringify({
            gachaGroupId: b.gachaGroupId, gachaId: b.gachaId, buttonId: b.buttonId,
            tryRollCount: b.tryRollCount, appearNumber: b.appearNumber,
          });
        } else if (/^quest\//.test(p)) {
          const brief = {};
          // ★ 2026-10-18：把【战斗选项】也记下来 —— 排查「教程命令等战斗回合却永远等不到」时，
          //   is_auto_quest / is_formation_skip / is_adv_skip 决定战斗是否被自动推进，
          //   而 BattleCache.Build(battleAutoQuest, isSkipFormation, …) 的第一个入参就是它。
          for (const k of ["questId", "quest_id", "is_clear", "skipCount",
                           "is_auto_quest", "is_formation_skip", "is_adv_skip", "is_debug", "tutorialProgressType"]) {
            if (b[k] !== undefined) brief[k] = b[k];
          }
          if (Array.isArray(b.quest_id_list)) brief.quest_id_list = b.quest_id_list.slice(0, 30);
          if (Array.isArray(b.quest_id_count_list)) brief.quest_id_count_list = b.quest_id_count_list.slice(0, 30);
          bodyNote = "  BODY=" + JSON.stringify(brief);
        } else if (/^(user\/authenticate_player_account|user\/create_player_account|account_link)/.test(p)) {
          // ★★★ 认证类端点【绝不记录 body】（2026-10-14，交付闸发现的泄露）★★★
          //
          // 原实现走的是下面的「body <= 400 就原样记」分支 —— 而
          // user/authenticate_player_account 的请求体正是：
          //   {"platformType":"winr","playerId":"1000001",
          //    "applicationUserPassword":"<redacted>..."}
          // ⇒ **把账号 id + 完整 64 位凭据写进了 _requests.log**（实测 13 处）。
          //
          // 判据（offline-client-revival skill 的交付闸）：
          //   「日志（含轮转）必须清 —— 里面是全部请求明文」。
          //   但**只删日志是治标**：服务端一跑就又写进去。
          //   ⇒ 治本是【让敏感字段根本不被记录】。（skill 原则：运行时再生的文件，
          //     清完不得再启动 —— 与其反复清，不如不产生。）
          //
          // 只记「有没有凭据」这一事实（排查用得上），不记值本身。
          const hasId = /"playerId"\s*:/.test(body);
          const hasPw = /"applicationUserPassword"\s*:/.test(body);
          bodyNote = "  BODY=(REDACTED: playerId=" + hasId + " password=" + hasPw + " len=" + body.length + ")";
        } else if (body.length <= 400) {
          bodyNote = "  BODY=" + body.slice(0, 400);
        } else {
          bodyNote = "  BODY(len=" + body.length + ")";
        }
      } catch (e) { bodyNote = "  BODY=(unparsable len=" + body.length + ")"; }
    }
    fs.appendFile(REQ_LOG, new Date().toISOString() + "  " + method + " " + fullUrl + bodyNote + "\n", function () {});
  } catch (e) { /* logging must never break a request */ }

  const h = routes.get(p);
  if (h) {
    try {
      const out = await h({ req, res, path: p, method, body, query: url.searchParams });
      if (out === undefined) return;            // 处理器已自行响应
      if (typeof out === "string") {
        const merged = finalizeBody(mergeShape(p, out));
        // ★★★ 必须显式给 Content-Length（2026-10-16）★★★
        // 不设时 Node 会降级为 `transfer-encoding: chunked`。本项目实证：
        //   两个【成功】的 MB 级端点都走 streamFile（带 Content-Length）：
        //     winr/fileInfo 10.33MB、master/load_master_data 25.57MB；
        //   而【唯一失败】的 user/load_user_data（9.46MB）是全服务端唯一
        //     用 `res.end(字符串)` 发送的 → 唯一 chunked 的那个。
        // 客户端是 UnityWebRequest，对无长度的大分块响应处理异常 →
        //   表现为「通信エラーが発生しました。タイトルに戻ります」（静默失败）。
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(merged) });
        res.end(merged);
        fs.appendFile(RESP_LOG, new Date().toISOString() + "  200  " + p + "  " + merged.length + "B  " + merged.slice(0, 80).replace(/\s+/g, " ") + "\n", function () {});
        return;
      }
      const _b = out.body;
      const _h = { "Content-Type": "application/json" };
      if (typeof _b === "string") _h["Content-Length"] = Buffer.byteLength(_b);
      res.writeHead(out.status || 200, _h); res.end(_b);
    } catch (e) {
      console.error("[ROUTE-EXC] " + method + " " + p + " threw: " + String(e && e.message || e));
      try { fs.appendFile(REQ_LOG, new Date().toISOString() + "  !! EXCEPTION " + method + " " + p + " : " + String(e && e.message || e) + "\n", function () {}); } catch (e2) {}
      console.error("[ERR]", p, String(e && e.stack || e));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(err(9999, "9999:" + String(e && e.message || e)));
    }
    return;
  }

  // 回退：回放已抓到的真实响应
  const cn = contractName(p);
  if (captured.has(cn)) {
    // 【重要】回放只应用于「尚未实现的端点」，且必须显式可见 ——
    // 静默回放会让未实现功能看起来正常，掩盖真实缺口。
    console.warn("[REPLAY] " + p + " <-- un-implemented, replaying recorded response");
    try { fs.appendFile(REQ_LOG, new Date().toISOString() + "  !!! REPLAY " + p + "\n", function () {}); } catch (e) {}
    const _rp = finalizeBody(captured.get(cn));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(_rp) });
    res.end(_rp);
    return;
  }
  // 资源本体回退（CDN 层）
  if (resourceResolver && resourceResolver(p, res)) return;

  // 第三层：骨架兜底（结构来自客户端类声明，值全为零值）
  const cn2 = contractName(p);
  if (skeletons.has(cn2)) {
    console.warn("[SKELETON] " + p + " <-- 未实现且无录制，返回客户端类声明生成的骨架");
    try { fs.appendFile(REQ_LOG, new Date().toISOString() + "  ??? SKELETON " + p + "\n", function () {}); } catch (e) {}
    const _sk = finalizeBody(JSON.stringify({ result: skeletons.get(cn2) }));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(_sk) });
    res.end(_sk);
    return;
  }
  // 未实现且无样本
  console.log("[MISS]", method, p);
  res.writeHead(404, { "Content-Type": "application/json" });
    // ★ 2026-10-29 WebView 本地页面（gacha-info/*.html）
    //   客户端用 WebView2 打开 misc.legend-clover.net/gacha-info/xxx.html，
    //   插件已把它改写到 127.0.0.1:18100/gacha-info/xxx.html，这里从 lab/resource 读本地 HTML。
    if (p.indexOf("gacha-info/") === 0) {
      try {
        const fp = path.join(CLIENT_DATA, "resource", p);
        if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          const buf = fs.readFileSync(fp);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
          res.end(buf);
          console.log("[WEBVIEW] " + p + " -> 200 " + buf.length + "B (local html)");
          return;
        }
      } catch (e) { console.log("[WEBVIEW] err " + e.message); }
    }
  res.end(err(9998, "9998: not implemented locally: " + p));
});

// ============================================================================
// ★★★ WebSocket：pub/sub 推送通道（v7.24）★★★
//   客户端 SubscriptionManager（Assembly-CSharp__11.cpp:29855/30170）用
//   wss://<官方 pubsub 域> 建长连接；离线连不上 ⇒ 每 ~2 秒重连一次，
//   控制台每次刷一行 "An error has occurred during a TLS handshake."
//   （字符串在 UnityPlayer.dll，异常发生在托管线程池工作项里 —— UnityWebRequest 拦不到。）
//   插件已把该 URL 改写成 ws://127.0.0.1:18100/__ws/<原host><原路径>，
//   这里完成 101 握手并保持连接：客户端「连得上」即可，离线没有事件要推。
// ============================================================================
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsSendFrame(socket, opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  try { socket.write(Buffer.concat([head, payload])); } catch (e) {}
}

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const proto = req.headers["sec-websocket-protocol"];
  if (!key) { try { socket.destroy(); } catch (e) {} return; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  let head = "HTTP/1.1 101 Switching Protocols\r\n" +
             "Upgrade: websocket\r\n" +
             "Connection: Upgrade\r\n" +
             "Sec-WebSocket-Accept: " + accept + "\r\n";
  if (proto) head += "Sec-WebSocket-Protocol: " + String(proto).split(",")[0].trim() + "\r\n";
  head += "\r\n";
  console.log("[WS] 101 " + req.url + (proto ? "  proto=" + proto : ""));
  try { socket.write(head); socket.setNoDelay(true); } catch (e) {}
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) {
        const m = buf.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) { wsSendFrame(socket, 0x8, payload.subarray(0, 2)); try { socket.end(); } catch (e) {} return; }
      if (opcode === 0x9) { wsSendFrame(socket, 0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1) {
        const txt = payload.toString("utf8");
        console.log("[WS] <- " + txt.slice(0, 200));
        // graphql-ws（AppSync 同款）子协议：客户端发 connection_init，服务端必须回 connection_ack，
        // 否则客户端等超时后会断开重连。离线没有事件要推，ack + 保持连接即可。
        let msg = null;
        try { msg = JSON.parse(txt); } catch (e) {}
        if (msg && msg.type === "connection_init") {
          const ack = JSON.stringify({ type: "connection_ack" });
          wsSendFrame(socket, 0x1, Buffer.from(ack, "utf8"));
          console.log("[WS] -> " + ack);
        } else if (msg && (msg.type === "subscribe" || msg.type === "start")) {
          // ★ 2026-10-23：graphql-ws 订阅必须回 next，否则客户端认为订阅失败、
          //   会把对应聊天室（尤其是刚建的公会室）从本地列表丢掉 ⇒ SmallMenuViewModel NRE。
          //   离线没有事件源，回一条「初始快照」即可（空消息 / 未读 0）。
          const q = String((msg.payload && msg.payload.query) || "");
          const vars = JSON.stringify((msg.payload && msg.payload.variables) || {});
          console.log("[WS] subscribe id=" + msg.id + " vars=" + vars.slice(0, 160) + " query=" + q.replace(/\s+/g, " ").slice(0, 240));
          const field = (q.match(/subscription\s*[A-Za-z0-9_]*\s*\{?\s*([A-Za-z0-9_]+)/) || [])[1] || "subscription";
          const data = {};
          data[field] = null;
          const nextMsg = JSON.stringify({ type: "next", id: msg.id, payload: { data: data } });
          wsSendFrame(socket, 0x1, Buffer.from(nextMsg, "utf8"));
          console.log("[WS] -> " + nextMsg.slice(0, 160));
        } else if (msg && (msg.type === "complete" || msg.type === "stop")) {
          console.log("[WS] complete id=" + msg.id);
        } else if (msg && msg.type === "ping") {
          wsSendFrame(socket, 0x1, Buffer.from(JSON.stringify({ type: "pong" }), "utf8"));
        }
      }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => { console.log("[WS] closed " + req.url); });
});

export function start() {
  const n = loadCaptured();
  const ns = loadSkeletons();
  return new Promise((resolve) => {
server.listen(PORT, "127.0.0.1", () => {
      console.log("[local-server] http://127.0.0.1:" + PORT);
      console.log("  已加载真实响应样本: " + n);
    console.log("  已加载端点骨架: " + ns);
      console.log("  已注册本地路由: " + routes.size);
      resolve(server);
    });
  });
}

export { server, captured, contractName, ok, err, j, PORT };