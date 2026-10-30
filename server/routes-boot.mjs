// 启动链路由：客户端从启动到进主页必须走通的端点。
//
// 顺序（从真实抓包确认）：
//   title/get_title_info → ping → master_data/get_version
//   → master/load_master_data → user/authenticate_player_account
//   → payment/get_payment_info → user/load_user_data → user/load_mypage_data
//   → chat/rooms → oracle_liberator/update
import { route, ok, err, captured, contractName, cachedRead } from "./server.mjs";
import { loadTable, indexBy } from "./masterdata.mjs";
import { patchedMasterBuffer } from "./gacha_pickup.mjs";


// ---------- 0. 环境引导（tellme）----------
// 客户端启动第一步：GET /v1/tell-me-domain
// 真实服返回纯文本环境名 "prod"；客户端据此在【本地】TellMeDomainProductionConfig
// 里查各端点基址。停服后该域名会死，故本地必须自己返回 "prod"。
// 注意：响应是【纯文本】而非 JSON —— 不能用 ok() 包装。
// 旧：返回纯文本 "prod"。
// 新：客户端 TellMeSettingEnvironmentNode{name, endpoints{...}} —— 直接把所有端点指到本地，
//     这样即使客户端用响应里的端点数，也不会再连公网。
route("tell-me-domain", () => "prod");
// ---------- 1. 标题信息 ----------
// ★ 临时实验：换成五周年纪念标题（网页版当前用这套：prefab + bg + 5 个 Spine）
// 真机/网页契约里该字段是空串，说明客户端另有判据；这里先直接指定试一次。
route("title/get_title_info", () => ok({
  background_prefab_name: process.env.LEGECLOX_TITLE_PREFAB ?? "mo_title_fiveanniversary_01",
  bgm_resource_id: "",
  logo_scale: Number(process.env.LEGECLOX_LOGO_SCALE ?? 0.62),
}));

// ---------- 2. 存活探测 ----------
// 真实响应是一个裸数字（非 JSON 对象），客户端按字符串取。
// ★ 真机实测：ping 返回【64 位随机 long】的十进制字符串（19~20 字符，有正有负）：
//   7488609448856525416 / -6158906303662147828 / 6764585465959306481
// 每请求都不同，与服务器时间无关。客户端 PingApi 的 3 个 PostRequest 全是【空实现】
// （ISIL 里只有 `Return`），即该端点纯做存活探测，值本身不被解析。
// 早期返回 Date.now()（毫秒时间戳，13 位）—— 类型同是数字、客户端也不看，
// 但长度/符号与真机不同，为保真改为随机 long。
route("ping", () => {
  // 生成有符号 64 位随机整数（可正可负，与真机一致）
  const hi = Math.floor(Math.random() * 0x100000000);
  const lo = Math.floor(Math.random() * 0x100000000);
  let v = BigInt(hi) * 4294967296n + BigInt(lo);
  if (v >= 9223372036854775808n) v -= 18446744073709551616n;
  return v.toString();
});

// ---------- 3. MasterData 版本 ----------
// 必须与客户端期望的 GUID 一致，否则它会去重新下载。
const MD_GUID = "8a1f4d92-6c3e-4b71-9d05-2fe8c7a41b63";
route("master_data/get_version", () => ok({ MasterDataVersionGuid: MD_GUID }));

// ---------- 4. MasterData 本体 ----------
// 真实服返回 25.6 MB（master_gacha + master_reward）。
// 我们从磁盘上的完整下载版直接回放：这是最保真的做法。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MD_FULL = "game_data/capture/by_endpoint/master_load_master_data.json";
route("master/load_master_data", async ({ res }) => {
  const p = fs.existsSync(MD_FULL) ? MD_FULL : path.join(HERE, "contracts", "master_load_master_data.json");
  if (!fs.existsSync(p)) return err(9998, "9998: masterdata not found");
  // ★★★ 2026-10-22：下发前先打「可选 PICKUP 角色」补丁（见 gacha_pickup.mjs）★★★
  //   补丁内容：目标池 gacha_type->3 + select_pick_character_list 候选 + first_select_pick_table。
  //   客户端据此才会把该池当自选池显示「キャラ選択」。失败时退回原始文件（保命）。
  let buf;
  try {
    buf = (p === MD_FULL) ? patchedMasterBuffer() : cachedRead(p);
  } catch (e) {
    console.error("[master] gacha_pickup patch failed: " + e.message);
    buf = cachedRead(p);
  }
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
  return undefined;   // 已自行响应
});

// ---------- 5. 登录 ----------
// 客户端拿 idToken/accessToken 后续用于鉴权。
// 本地服务端不做真鉴权，发一对固定 token 即可 —— 但要够长，
// 因为客户端可能对 token 做长度校验（参照 Angelica：OnetimeToken 须 >= 32 字符）。
const LOCAL_TOKEN = "localtoken0000000000000000000000";
route("user/authenticate_player_account", () => ok({
  idToken: LOCAL_TOKEN,
  accessToken: LOCAL_TOKEN,
}));

// ---------- 6. 支付信息 ----------
// payment/get_payment_info 的实现在更晚加载的模块中（避免重复注册导致前者被静默覆盖）
// payment/update_free_currency 的实现在更晚加载的模块中（避免重复注册导致前者被静默覆盖）
// payment/get_stone_balance_detail 的实现在更晚加载的模块中（避免重复注册导致前者被静默覆盖）
