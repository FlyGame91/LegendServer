// 可选的 PICKUP 角色（自选 PU）—— master_gacha 补丁 + 配置
//
// 【为什么必须补 master 而不是改客户端】（客户端 ISIL 证据）
//   · Alter/UI/GachaPageDetailGroupView.ChangeLayoutGroup:
//       Compare [rax+80], 3        ; rax = GachaGroupInfoBase, +0x50 = gacha_type
//       → 只有 gacha_type==3 的池才会走自选分支（GetUserSelectPickGachaGroupModel + 按钮 SetActive）
//   · Alter/UI/SelectPickGachaPopupBehaviour.Setup:
//       Call GachaGroupDataStore.GetSelectPickGachaList(gachaGroupId)
//       → 候选角色 = master_gacha.select_pick_character_list 里该 group 的行
//   · Domains/UseCase/Gacha/GachaProvidingRatioUseCase:
//       Compare [rbx+80], 3 → 命中则 new LoadGachaProvidingRatioSelectPickMasterDataApi
//       → 提供割合改调 master/load_gacha_providing_ratio_select_pick_master_data（本服已实现）
//   ⇒ 所以「给普通池加可选 PICKUP」= 服务端下发 master 时：
//       ① 目标池 gacha_type -> 3（客户端才会出现「キャラ選択」）
//       ② 补 select_pick_character_list 候选（弹窗里可选的角色）
//       ③ 补 first_select_pick_table（客户端 GenerateFirstTableInfo(gachaType=3) 要读这张表）
//     客户端一句话都不用改。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTable } from "./masterdata.mjs";

const MASTER_FILE = "game_data/capture/by_endpoint/master_load_master_data.json";
const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "gacha_pickup.json");

// 默认配置：普通池（プレミアム/ノーマル/無料10連）改成自选；已有的 4 个自选池扩候选。
const DEFAULT_CONFIG = {
  enabled: true,
  selectLimit: 2,
  selectResetLimit: 99,
  candidates: "ssr",
  // 2026-10-23：只改造プレミアムガチャ。
  //   友情池/無料10連 的按钮只有 1~2 个，而 type=3 时客户端会把
  //   gachaButtonPartsBehaviourList 的【全部槽位】SetActive(true)（ISIL SetGachaButtonState
  //   643-746：gacha_type==3 分支逐个 SetActive(true)）→ 槽位比按钮多就露出白块。
  //   原生自选池都是 4~5 个按钮，故 premium 补到 5 个即可填满。
  convert: ["Other_Premium1"],
  extend: ["SelectPick00231", "SelectPick00232", "SelectPick00233", "SelectPick00234"],
};

let _cfg = null;
export function pickupConfig() {
  if (_cfg) return _cfg;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      _cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } else {
      _cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(_cfg, null, 2), "utf8");
      console.log("[gacha-pickup] 生成默认配置 " + CONFIG_FILE);
    }
  } catch (e) {
    console.error("[gacha-pickup] 配置读取失败: " + e.message);
    _cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  return _cfg;
}

// 候选角色：与 gacha.mjs 的 pool 判据一致（Ch+9位 / Rarity>0 / 有立绘 / 有技能），
// 默认只收 SSR（Rarity>=4）—— 自选 PICKUP 在真机上就是 SSR 档。
let _cand = null;
export function pickupCandidates() {
  if (_cand) return _cand;
  const cfg = pickupConfig();
  const spec = cfg.candidates === undefined ? "ssr" : cfg.candidates;
  if (Array.isArray(spec)) { _cand = spec.map(String); return _cand; }
  const out = [];
  try {
    const ct = loadTable("Character/Character.csv");
    const sk = loadTable("TrainingBoard/SkillSetting.csv");
    const skillIds = new Set(((sk && sk.rows) || []).filter(function (r) { return r.SkillGroupID; }).map(function (r) { return r.CharacterID; }));
    for (const r of ((ct && ct.rows) || [])) {
      const id = r.CharacterID;
      if (!/^Ch[0-9]{9}$/.test(String(id || ""))) continue;
      const rar = Number(r.Rarity) || 0;
      if (!(rar > 0) || !r.StandResourceID) continue;
      if (!r.InitialSkillId && !skillIds.has(id)) continue;
      if (spec === "ssr" && rar < 4) continue;
      out.push(id);
    }
  } catch (e) {
    console.error("[gacha-pickup] 候选角色读取失败: " + e.message);
  }
  _cand = out;
  return _cand;
}

let _master = null;   // 补丁后的 master_gacha
let _buf = null;      // 补丁后的整包 JSON（master/load_master_data 直接回这份）
let _native = null;   // 原始 master 里本来就是 gacha_type=3 的池

export function patchedMasterGacha() { ensurePatched(); return _master; }
export function patchedMasterBuffer() { ensurePatched(); return _buf; }

/** 原始（未打补丁）master 里就是自选池的 group（用于区分「原生自选」与「我们改的」）。 */
export function isNativeSelectPick(gid) { ensurePatched(); return _native.has(String(gid)); }

/** 该 group 是否被配置成「可选 PICKUP」。 */
export function isPickupGroup(gid) {
  if (!gid) return false;
  const cfg = pickupConfig();
  if (cfg.enabled === false) return false;
  const all = [].concat(cfg.convert || [], cfg.extend || []).map(String);
  return all.indexOf(String(gid)) >= 0;
}

function ensurePatched() {
  if (_master) return;
  const raw = JSON.parse(fs.readFileSync(MASTER_FILE, "utf8"));
  const md = raw.result || raw;
  const mg = md.master_gacha || (md.master_gacha = {});
  _native = new Set(((mg.gacha_group || [])).filter(function (g) { return Number(g.gacha_type) === 3; }).map(function (g) { return String(g.gacha_group_id); }));
  try { applyPatch(mg); } catch (e) { console.error("[gacha-pickup] 补丁失败: " + e.message); }
  _master = mg;
  _buf = Buffer.from(JSON.stringify(raw), "utf8");
}

let _report = null;
export function pickupReport() { ensurePatched(); return _report || { convert: [], extend: [], candidates: 0 }; }

function applyPatch(mg) {
  const cfg = pickupConfig();
  _report = { convert: [], extend: [], candidates: 0 };
  if (cfg.enabled === false) { console.log("[gacha-pickup] 已关闭"); return; }
  const groups = (mg.gacha_group = mg.gacha_group || []);
  const byId = new Map(groups.map(function (g) { return [String(g.gacha_group_id), g]; }));
  const convert = (cfg.convert || []).map(String).filter(function (id) { return byId.has(id); });
  const extend = (cfg.extend || []).map(String).filter(function (id) { return byId.has(id); });
  const limit = Number(cfg.selectLimit) > 0 ? Number(cfg.selectLimit) : 2;
  const resetLimit = Number(cfg.selectResetLimit) > 0 ? Number(cfg.selectResetLimit) : 99;

  // ① 目标池 -> gacha_type 3（客户端才会显示「キャラ選択」）
  for (const gid of convert) {
    const g = byId.get(gid);
    g.gacha_type = 3;
    g.select_limit = limit;
    g.select_reset_limit = Math.max(Number(g.select_reset_limit) || 0, resetLimit);
    if (!Number(g.select_pick_button_color_type)) g.select_pick_button_color_type = 1;
    _report.convert.push(gid);
  }

  // ② 候选角色（保留原有候选在前，追加缺失的）
  const cand = pickupCandidates();
  _report.candidates = cand.length;
  const list = (mg.select_pick_character_list = mg.select_pick_character_list || []);
  for (const gid of convert.concat(extend)) {
    const have = new Set(list.filter(function (r) { return String(r.gacha_group_id) === gid; }).map(function (r) { return String(r.reward_item_id); }));
    let added = 0;
    for (const id of cand) {
      if (have.has(id)) continue;
      list.push({ gacha_group_id: gid, sheet_type: 2, reward_item_id: id, character_face_type: 1 });
      added++;
    }
    if (extend.indexOf(gid) >= 0) _report.extend.push(gid + " (+" + added + ")");
  }

  // ②b 按钮补到 5 个 —— 客户端 type=3 时会把 prefab 的全部按钮槽位强制显示
  //     （ISIL SetGachaButtonState 649~746 遍历 gachaButtonPartsBehaviourList 逐个 SetActive(true)），
  //     槽位多于按钮就会显示成白块。原生自选池按钮数都是 4~5，这里补齐到 5。
  const detail = (mg.gacha_detail_info = mg.gacha_detail_info || []);
  const btnTpl = [
    { button_setting: "有償魔宝石_1日1回割引_1回引く", button_sales_text: "1日1回限定", order: 1000 },
    { button_setting: "有償_10連_1500", button_sales_text: "期間中1回限定", order: 900 },
    // ★ 2026-10-23：不要「有償魔宝石_10回引く」—— 用户实测 5 个按钮在界面上站不下
    //   （红框那个 10回引く 有償3000 去掉），保持原生自选池的 4 个按钮形态。
    { button_setting: "無償魔宝石_1回引く", button_sales_text: "", order: 100 },
    { button_setting: "無償魔宝石_10回引く", button_sales_text: "SR以上1体確定", order: 10 },
  ];
  const btnIds = new Set((mg.gacha_button_setting || []).map(function (b) { return String(b.button_id); }));
  for (const gid of convert) {
    const gachaIds = (mg.gacha_group_setting || []).filter(function (s2) { return String(s2.gacha_group_id) === gid; }).map(function (s2) { return String(s2.gacha_id); });
    for (const gachaId of gachaIds) {
      const have = new Set(detail.filter(function (d) { return String(d.gacha_id) === gachaId; }).map(function (d) { return String(d.button_setting); }));
      for (const t of btnTpl) {
        if (have.has(t.button_setting)) continue;
        if (!btnIds.has(t.button_setting)) continue;
        detail.push({ gacha_id: gachaId, button_setting: t.button_setting, button_sales_text: t.button_sales_text, order: t.order, bonus_reward: [] });
      }
    }
  }

  // ③ 被改的池必须补 first_select_pick_table（客户端 GenerateFirstTableInfo(gachaType=3) 读它）
  const settings = (mg.gacha_group_setting = mg.gacha_group_setting || []);
  const bases = (mg.gacha_base_info = mg.gacha_base_info || []);
  const firstTable = (mg.first_basic_table = mg.first_basic_table || []);
  const spTable = (mg.first_select_pick_table = mg.first_select_pick_table || []);
  for (const gid of convert) {
    const tids = settings.filter(function (s) { return String(s.gacha_group_id) === gid; })
      .map(function (s) {
        const b = bases.find(function (x) { return x.gacha_id === s.gacha_id; });
        return b ? String(b.first_table_id || "") : "";
      }).filter(Boolean);
    for (const tid of tids) {
      if (spTable.some(function (r) { return String(r.first_table_id) === tid; })) continue;
      const basics = firstTable.filter(function (r) { return String(r.first_table_id) === tid; });
      for (const b of basics) {
        spTable.push({ gacha_type: 3, first_table_id: tid, lottery_type: 1, sheet_type: b.sheet_type, reward_item_id: b.reward_item_id, count: b.count });
      }
    }
  }
  console.log("[gacha-pickup] convert=" + _report.convert.join(",") + " extend=" + _report.extend.join(",") + " candidates=" + _report.candidates);
}
