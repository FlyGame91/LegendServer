// use-profile.mjs —— 存档档位切换工具（2026-10-18）
//
// 为什么要有它（而不是手工 copy）：
//   本项目已多次因「手工拷文件」出事——拷错方向、忘记备份、切完忘了重启服务端。
//   把流程固化成命令，减少这类低级错。
//
// 用法：
//   node server/use-profile.mjs list               列出所有档位 + 当前档摘要
//   node server/use-profile.mjs save <名字>        把当前 state/user.json 另存为档位
//   node server/use-profile.mjs load <名字>        切换到该档（自动备份当前档到 _auto/）
//
// 注意：load/save 只改文件；**必须重启服务端**才生效（服务端把 state 读进内存）。
//       本工具会打印重启命令。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, "state", "user.json");
const DIR = path.join(HERE, "state", "profiles");
const AUTO = path.join(DIR, "_auto");

// ★★ 客户端会「拿本地缓存回传覆盖」的字段（不是存档数据，是客户端侧缓存）★★
// 判据：客户端有本地副本，换号后会把它原样 POST 上来（证据：set_auto_sell_item 三次请求体 6093 字节全同）。
// 这些【不按档保留】——目标档没有它们时保持为空，否则客户端一回传就污染新号。
// 其余一切（编队 battle_formation_list / 编成预设 __presets / 教程 / 养成 / 各 __ 状态）都是【存档数据】，以目标档为准，绝不动。
const CONFIG_KEYS = [
  // 只有这 3 个是【客户端有本地副本、换号后会原样 POST 回来】的字段。
  // 判据（2026-10-26 实证）：同一端点的请求体长度是否每次都完全相同 —— 完全相同 ⇒ 客户端在重放本地缓存。
  "auto_sell_item_id_list",            // baggage/set_auto_sell_item（三次请求体 6093 字节全同）
  "FavoriteUserCharacter",             // character/favorite
  "UserAssetSelectPickCharacterList",  // gacha/select_character
];
// ★ 不在这里的（因为它们是【存档数据】，一律以目标档为准）：
//   battle_formation_list / last_battle_formation（编队）
//   __presets（编成预设）← 用户 2026-10-26 明确：编成预设也算存档数据
//   __linkSnapshot / __charProfiles / 教程 / 养成 / 其它 __ 状态
//   ⇒ copyFileSync 整文件替换已经实现「档里有就用档里的、档里没有就没有」。
/**
 * 处理「客户端会拿本地缓存回传覆盖」的字段。
 * 规则（用户 2026-10-26）：
 *   目标档【有】该字段 → 保留目标档的值（清除旧号值后写入新值 = copyFileSync 已完成）
 *   目标档【没有】该字段 → 确保不存在（不留旧号残留）
 * ★ 注意：这里【只处理 CONFIG_KEYS 这几个客户端缓存字段】，
 *   绝不碰编队 / 编成预设 / 教程 / 养成数据 —— 那些都是存档数据，以目标档为准。
 */
function reconcileClientCachedFields(filePath) {
  const fs2 = nodefs;
  const j = JSON.parse(fs2.readFileSync(filePath, "utf8"));
  const kept = [], absent = [];
  for (const k of CONFIG_KEYS) {
    if (j[k] !== undefined) kept.push(k);   // 目标档自带 → 保留（什么都不做）
    else absent.push(k);                    // 目标档没有 → 本来就没有，无需处理
  }
  if (kept.length) console.log("[use-profile] 目标档自带客户端缓存字段（按档保留）: " + kept.join(", "));
  if (absent.length) console.log("[use-profile] 目标档没有的客户端缓存字段（自然为空，不会被旧号污染）: " + absent.join(", "));
  return kept;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function summary(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const m = (s.CharacterList || {}).mainCharacterList || [];
    const p = (s.CharacterList || {}).supportCharacterList || [];
    const tut = (s.TutorialProgress || {}).Stage;
    return {
      kb: (fs.statSync(file).size / 1024).toFixed(0),
      chars: m.length + "+" + p.length,
      rank: (s.userData || s.UserData || {}).level,
      mrank: (s.master_rank_data || {}).master_rank,
      tutorial: tut,
      stone: s.freeStoneBalance,
      items: ((s.ItemList || {}).AllItemList || []).length,
    };
  } catch (e) { return { err: e.message }; }
}

function fmt(x) {
  if (x.err) return "无法解析: " + x.err;
  return x.kb + "KB  角色 " + x.chars + "  rank=" + x.rank + "  master_rank=" + x.mrank +
         "  教程=" + x.tutorial + "  石=" + x.stone + "  道具=" + x.items;
}

const [cmd, name] = process.argv.slice(2);

if (!cmd || cmd === "list") {
  console.log("当前档 state/user.json：");
  console.log("  " + fmt(summary(STATE)));
  console.log("\n可用档位（state/profiles/）：");
  if (!fs.existsSync(DIR)) { console.log("  (目录不存在)"); }
  else {
    const files = fs.readdirSync(DIR).filter(f => f.endsWith(".json") && !f.endsWith(".bak"));
    if (!files.length) console.log("  (无)");
    for (const f of files) {
      const p = path.join(DIR, f);
      console.log("  " + f.replace(/\.json$/, "").padEnd(18) + fmt(summary(p)));
    }
    if (fs.existsSync(AUTO)) {
      const n = fs.readdirSync(AUTO).filter(f => f.endsWith(".json")).length;
      console.log("\n自动备份 _auto/：" + n + " 个（load 时的旧档快照）");
    }
  }
} else if (cmd === "save") {
  if (!name) { console.error("用法: node server/use-profile.mjs save <名字>"); process.exit(2); }
  fs.mkdirSync(DIR, { recursive: true });
  const dst = path.join(DIR, name + ".json");
  fs.copyFileSync(STATE, dst);
  console.log("已保存当前档 → " + dst);
  console.log("  " + fmt(summary(dst)));
} else if (cmd === "load") {
  if (!name) { console.error("用法: node server/use-profile.mjs load <名字>"); process.exit(2); }
  const src = path.join(DIR, name + ".json");
  if (!fs.existsSync(src)) { console.error("档位不存在: " + src); process.exit(2); }
  fs.mkdirSync(AUTO, { recursive: true });
  const backup = path.join(AUTO, path.basename(STATE, ".json") + "-" + stamp() + ".json");
  if (fs.existsSync(STATE)) { fs.copyFileSync(STATE, backup); console.log("旧档已备份 → " + backup); }
  fs.copyFileSync(src, STATE);
  // ★★ 存档数据规则（2026-10-26 用户明确）★★
  //   「如果你换的号有这个数据，那就清除后写入新数据；如果没这个数据，那就只清除；
  //     如果换新号，那就全清后按照新号标准搞数据」
  //   ⇒ 本质就是【以目标档为准】：copyFileSync 已整文件替换（目标档有→用它的值；没有→自然不存在）。
  //   ⇒ 所以这里【不做】任何「按字段无条件删除」——那会删掉目标档自带的数据（编队/编成预设等全是存档数据）。
  //   唯一例外：下面这几个是「客户端会拿本地缓存回传覆盖」的字段。
  //   若目标档【没有】它们，就确保不存在（否则客户端回传时不会被拦）；有的话一律用目标档的值。
  reconcileClientCachedFields(STATE);
  console.log("已切换 → " + STATE);
  console.log("  " + fmt(summary(STATE)));
  console.log("\n★ 必须重启服务端才生效：");
  console.log("  Get-NetTCPConnection -LocalPort 18100 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }");
  console.log("  node server/main.mjs    （然后 node server/start-game.mjs 启动游戏）");
} else {
  console.log("未知命令: " + cmd);
  console.log("用法: list | save <名字> | load <名字>");
  process.exit(2);
}
