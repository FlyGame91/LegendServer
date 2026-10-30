// seedflow.mjs —— 按【真实业务流程】制造数据，把存档从「新账号」推进到「有数据」状态。
//
// 【为什么需要】只测空数据是不完整的审计：若某段读取代码有 bug，而新账号
// 本来就没有该数据，这个 bug 永远不会暴露。必须在「有数据」状态下也跑一遍。
//
// 【铁律】这里制造数据**只能走真实业务流程**（客户端实际会调的端点），
// 绝不能直接往 state/user.json 里塞字段值 —— 凭空生成的数据是错误数据，
// 会掩盖真实契约（例如实例 id 分配、字段名、嵌套结构都可能与真实不符）。
//
// 用法: node seedflow.mjs [--keep]
//   --keep  保留累积后的状态（供后续审计使用）；默认跑完复位。
import http from "node:http";
import fs from "node:fs";

const PORT = 18100;
const KEEP = process.argv.indexOf("--keep") >= 0;
// --save <name>：把累积出来的状态存为命名基准，供审计切换到「有数据」状态。
const SAVE_IDX = process.argv.indexOf("--save");
const SAVE_NAME = SAVE_IDX >= 0 ? (process.argv[SAVE_IDX + 1] || "accumulated") : null;

function call(api, body) {
  return new Promise(function (resolve) {
    const d = Buffer.from(JSON.stringify(body === undefined ? {} : body), "utf8");
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/" + api, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": d.length }, timeout: 120000 },
      function (res) {
        const c = [];
        res.on("data", function (b) { c.push(b); });
        res.on("end", function () { try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { resolve(null); } });
      });
    req.on("error", function () { resolve(null); });
    req.write(d); req.end();
  });
}
const R = function (x) { return x && x.result !== undefined ? x.result : x; };
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const CK = function (p) { return JSON.parse(fs.readFileSync("contracts/" + p, "utf8")); };
const hasCK = function (p) { return fs.existsSync("contracts/" + p); };

const steps = [];
function note(what, detail) { steps.push("  ✓ " + what + (detail ? "  (" + detail + ")" : "")); }

(async function () {
  await call("__reset", {});
  const s0 = R(await call("user/load_user_data", {}));
  const eq0 = (s0.ItemList.EquipmentList || []).length;
  const ch0 = (s0.CharacterList.mainCharacterList || []).length + (s0.CharacterList.supportCharacterList || []).length;
  const it0 = (s0.ItemList.AllItemList || []).length;
  console.log("=== 起始（新账号）===");
  console.log("  角色 " + ch0 + " | 装备 " + eq0 + " | 道具 " + it0);
  console.log("");

  // ---------- 1. 任务与战斗流程（产生掉落/经验/金币/任务进度）----------
  const questIds = ["Main_2nd_171_01_m", "Main_1_1_01_m"];
  for (const qid of questIds) {
    await call("quest/start", { questId: qid });
    if (hasCK("battle_win.req.json")) {
      const req = CK("battle_win.req.json");
      req.questId = qid; req.battleId = qid;
      await call("battle/win", req);
    }
    await call("quest/end", { quest_id: qid, is_clear: true, skippedScenarios: [] });
    note("完成任务", qid);
  }

  // ---------- 2. 抽卡（产生新角色/装备/技能记录）----------
  const gachas = [
    { gachaGroupId: "Sp00039", gachaId: "Sp00039_01", buttonId: "x", tryRollCount: 10, appearNumber: 1 },
    { gachaGroupId: "Other_Premium1", gachaId: "Other_Premium1", buttonId: "x", tryRollCount: 10, appearNumber: 1 },
  ];
  for (const g of gachas) {
    const r = R(await call("gacha/roll", g));
    const n = ((r && r.player_all_asset && r.player_all_asset.MainCharacter) || []).length;
    note("抽卡", (g.gachaGroupId || "?") + " 新增 " + n + " 角色");
  }

  // ---------- 3. 养成（强化/突破/装备/技能）----------
  const s1 = R(await call("user/load_user_data", {}));
  const chars = (s1.CharacterList.mainCharacterList || []).slice(0, 3);
  for (const c of chars) {
    await call("character/enhance", { characterId: c.master_character_id, type: 1, itemList: [] });
    await call("character/break_limit", { characterId: c.master_character_id, isMain: true });
  }
  note("角色强化+突破", chars.length + " 个");

  // 装备强化与限界突破（走真实端点）
  const eqs = (s1.ItemList.EquipmentList || []).slice(0, 2);
  for (const e of eqs) {
    await call("baggage/enhanceEquipmentByItem", { targetEquipmentUserId: e.Id, itemIdList: [], useItemIdList: [] });
  }
  if (eqs.length) {
    await call("baggage/breakLimitEquipment", { targetEquipmentUserId: eqs[0].Id, consumeEquipmentUserId: 0, alternativeMaterialId: "" });
    note("装备强化+突破", eqs.length + " 件");
  }

  // 装备到角色（产生 owner 关联）
  if (chars.length && eqs.length) {
    await call("character/equip", { characterId: chars[0].master_character_id, attachingEquipmentIdList: [eqs[0].Id], detachingEquipmentIdList: [] });
    note("装备穿戴", chars[0].master_character_id + " <- " + eqs[0].Id);
  }

  // 技能设置（产生 SetSkillList 记录）
  if (chars.length) {
    await call("character/change_skill", { characterId: chars[0].master_character_id, skillIdList: ["1100276", "1100275"] });
    note("技能设置", chars[0].master_character_id);
  }

  // ---------- 4. 任务领奖 / 礼物 / 商店（产生 item_format_list 与资产变化）----------
  const am = R(await call("user/load_user_data", {}));
  const achIds = (am.AchievementList || []).filter(function (m) { return m.IsAchieved && !m.IsReceived; }).slice(0, 3).map(function (m) { return m.MissionId; });
  if (achIds.length) {
    await call("mission/receive_reward", { mission_id_list: achIds });
    note("任务领奖", achIds.length + " 个");
  }

  const pl = R(await call("present/list", {}));
  const pids = ((pl && pl.presentList) || []).slice(0, 2).map(function (p) { return p.id; });
  if (pids.length) {
    await call("present/receive", { presentIdList: pids });
    note("领取礼物", pids.length + " 件");
  }

  // ---------- 5. 剧情 / 教程 / 内容解锁（产生 read/history 记录）----------
  await call("story/confirm", { MasterCharacterId: chars[0] ? chars[0].master_character_id : "", MasterStoryIdList: ["sc_main271_1"] });
  await call("tutorial/progress", { step: 1 });
  await call("contents_release/read", { contents_release_id_list: [] });
  note("剧情/教程/内容解锁");

  // ---------- 6. 公会（本地自建，产生 guild_internal_data）----------
  await call("guild/create", { guild_name: "LOCAL_GUILD", recruit_message: "test", play_style: 1, joining_condition: 0 });
  note("创建公会");

  await sleep(2500);
  const s2 = R(await call("user/load_user_data", {}));
  const eq2 = (s2.ItemList.EquipmentList || []).length;
  const ch2 = (s2.CharacterList.mainCharacterList || []).length + (s2.CharacterList.supportCharacterList || []).length;
  const it2 = (s2.ItemList.AllItemList || []).length;
  console.log("=== 流程执行 ===");
  steps.forEach(function (x) { console.log(x); });
  console.log("");
  console.log("=== 结果（有数据状态）===");
  console.log("  角色 " + ch0 + " -> " + ch2 + "  (+" + (ch2 - ch0) + ")");
  console.log("  装备 " + eq0 + " -> " + eq2 + "  (+" + (eq2 - eq0) + ")");
  console.log("  道具 " + it0 + " -> " + it2 + "  (+" + (it2 - it0) + ")");
  console.log("  公会: " + (s2.guild_internal_data ? "已创建 (" + s2.guild_internal_data.guild_name + ")" : "无"));
  console.log("  任务进度变化: " + ((s2.MissionProgressList || []).filter(function (m) { return m.Progress > 0; }).length) + " 条有进度");

  if (SAVE_NAME) {
    // 通过 __save_profile 把当前内存状态落为基准（走 HTTP，不直接写文件）
    const sr = await call("__save_profile?name=" + encodeURIComponent(SAVE_NAME), {});
    console.log("");
    console.log("已保存基准: " + SAVE_NAME + "  -> " + JSON.stringify(R(sr)));
    console.log("跑审计: node audit.mjs --profile " + SAVE_NAME);
  } else if (!KEEP) {
    await call("__reset", {});
    console.log("");
    console.log("已复位到新账号（如需保留请加 --keep / --save <name>）");
  } else {
    console.log("");
    console.log("已保留累积状态 —— 现在可以跑 audit.mjs 查看「有数据」下的表现");
  }
})();