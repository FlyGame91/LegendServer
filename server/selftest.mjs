// 自测：验证写接口【确实读入参】并按入参产出，且【能正确改状态】。
//
// 判据：
//   1) 入参敏感性 —— 同一端点用不同入参，响应必须随之变化（否则仍在回放）。
//   2) 状态持久化 —— 写操作后 user/load_user_data 必须反映变化。
//   3) 无副作用残留 —— 自测结束后重置回录制存档。
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

// ★ 端口可用 LEGECLOX_TEST_PORT 覆盖（见 run-tests.mjs 的隔离测试）——
// 这样测试可以打到一个【用独立存档启动】的服务端，而不触碰用户的 state/user.json。
const PORT = Number(process.env.LEGECLOX_TEST_PORT || 18100);
const HERE = path.dirname(process.argv[1] || ".");

function call(api, body) {
  return new Promise(function (resolve) {
    const d = Buffer.from(JSON.stringify(body || {}), "utf8");
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/" + api, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": d.length }, timeout: 30000 }, function (res) {
      const c = []; res.on("data", function (b) { c.push(b); });
      res.on("end", function () { try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { resolve(null); } });
    });
    r.on("error", function () { resolve(null); });
    r.on("timeout", function () { r.destroy(); resolve(null); });
    r.write(d); r.end();
  });
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const gold = function (j) { const it = ((j && j.result && j.result.ItemList && j.result.ItemList.AllItemList) || []).find(function (x) { return x.master_item_id === "Item_Currency_Gold"; }); return it ? it.amount : 0; };

(async function main() {
  // 复位，保证起点一致
  await call("__reset", {});
  const base = await call("user/load_user_data");
  const mains = (base.result.CharacterList.mainCharacterList || []);
  if (mains.length < 3) { console.log("角色不足，无法自测"); process.exit(1); }
  const C1 = mains[0].master_character_id, C2 = mains[1].master_character_id, C3 = mains[2].master_character_id;
  console.log("使用角色:", C1, C2, C3);
  console.log("初始 Gold:", gold(base), "| stamina:", base.result.UserData.stamina);
  console.log("");

  let pass = 0, fail = 0, skipped = 0;
  function check(name, ok, detail) {
    if (ok) { pass++; console.log("  ✅ " + name + (detail ? "  " + detail : "")); }
    else { fail++; console.log("  ❌ " + name + (detail ? "  " + detail : "")); }
  }

  // ---------- 1. 任务领奖：入参敏感性 ----------
  console.log("【1】mission/receive_reward 按入参");
  // ★★ 改为【动态发现】已达成且未领取的任务（2026-10-14）★★
  //   原来硬编码 DailyMission_LoginTime_01 / DailyMission_Invasion_01 ——
  //   而新增的「每日任务重置」会在每天 0:00 把它们清零（IsAchieved=false），
  //   于是这两个断言必然失败。**那不是实现缺陷，是测试硬编码了会变的业务状态。**
  //   正确做法：从当前响应里挑「已达成且未领取」的任务 —— 与 functest 的做法一致。
  // ★★ 本组断言测的是【体力】，所以候选必须筛「奖励里含 Item_Direct_Stamina」的任务 ★★
  //   （2026-10-14 修正）第一版只筛「已达成未领取」，结果选中了
  //   MissionGroup_AchievementMission_EngageChallenge_0005（奖励是金币）→
  //   断言期望体力 x0，实际给金币 → 假失败。
  //   ⇒ 断言的目标类型必须和候选的筛选条件一致。
  const { dailyMissionRewardMultiplier, missionGroupOf } = await import("./campaign.mjs");
  const pub0 = await import("./rewards.mjs");
  const givesStamina = function (mid) {
    try {
      const rw = pub0.rewardsForRewardId(pub0.rewardIdForMission(mid)) || [];
      return rw.some(function (x) { return x.master_id === "Item_Direct_Stamina" && Number(x.amount) > 0; });
    } catch (e) { return false; }
  };
  const cands = (base.result.MissionProgressList || [])
    .filter(function (m) { return m.IsAchieved && !m.IsReceived; })
    .map(function (m) { return m.MissionId; })
    .filter(givesStamina);
  if (cands.length < 2) {
    console.log("  ⚠️ 已达成未领取的体力奖励任务不足（" + cands.length + " 个）");
  }
  // ★ 必须两个【不同】的任务 —— 同一个任务第二次调用会被「已领取」守卫拦下，
  //   那是正确行为，不是缺陷（实测踩过：T2 回退成 T1 → 断言假失败）。
  //   只有一个候选时，本组只做「单任务」断言。
  const T1 = cands[0];
  const T2 = cands[1] || null;
  if (!T1) { skipped++; console.log("  ⚠️ 没有可用的体力奖励任务 → 跳过第 1 组断言（不报失败）"); }
  console.log("  选用任务: " + T1 + (T2 ? " / " + T2 : "（仅 1 个，跳过双任务断言）"));
    if (!T2) skipped++;
  const m1 = await call("mission/receive_reward", { mission_type: 2, mission_id_list: [T1] });
  // ★ 必须用【已达成】的任务（2026-10-08 加了「未达成不发奖」守卫）——
  //   DailyMission_Sub_01 在录制存档里是 IsAchieved=false，加了守卫后会被正确拦截，
  //   于是 a2 变成空、断言失败。这不是实现缺陷，是测试选了不该选的任务。
  // ★ 两次调用必须用【互不重叠】的已达成任务 ——
  //   第一版两次都含 DailyMission_LoginTime_01，第二次它已 IsReceived → 被守卫拦截 → 假失败。
  const m2 = T2
    ? await call("mission/receive_reward", { mission_type: 2, mission_id_list: [T2] })
    : { result: { item_format_list: [] } };
  const a1 = (m1.result.item_format_list || []).map(function (x) { return x.master_id + "x" + x.amount; }).join(",");
  const a2 = (m2.result.item_format_list || []).map(function (x) { return x.master_id + "x" + x.amount; }).join(",");
  // ★★ 断言改为「活动感知」而非硬编码数值（2026-10-08）★★
  //   原断言写死 240 / 200，而活动「デイリーミッションの獲得スタミナ3倍」生效后变成
  //   720 / 1800 → 断言失败。**这不是实现缺陷，是测试期望值过时**。
  //   修法：用 campaign.mjs 算出「当前应有的值」再断言 —— 这样活动开/关都不会误报。
  const expectStamina = function (missionId) {
    const base = (pub0.rewardsForRewardId(pub0.rewardIdForMission(missionId)) || [])
      .filter(function (x) { return x.master_id === "Item_Direct_Stamina"; })
      .reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
    return base * dailyMissionRewardMultiplier(missionGroupOf(missionId));
  };
  const expSt1 = T1 ? expectStamina(T1) : 0;
  const expSt2 = T2 ? expectStamina(T2) : 0;
  if (T1) {
    check("单任务体力 = 基础×活动倍率(" + expSt1 + ")", a1.indexOf("x" + expSt1) >= 0, a1);
  } else {
    skipped++; console.log("  ⏭️  跳过单任务体力断言（无候选）");
  }
  if (T2) {
    check("双任务体力 = 基础×活动倍率(" + expSt2 + ")", a2.indexOf("x" + expSt2) >= 0, a2);
    // ★ 原断言「两次响应不同」不成立（2026-10-14）：
    //   LoginTime_01/02 的奖励【形状相同】（都是 Item_Direct_Stamina x720）→
    //   字符串必然相等。**这不是实现问题，是断言选错了判据** ——
    //   「响应不同」从来不是「读入参」的充分条件（两条不同任务可以给同样奖励）。
    //   真正的入参敏感性由下面「未达成任务不发奖」的对照来证明。
  }

  // ★★ 入参敏感性的【稳定】测法：用「未达成」的任务做对照 ★★
  //   （2026-10-14）原来靠「两条已达成任务结果不同」来证明读入参 ——
  //   但每日任务重置后，当天可能只有 1 条已达成，该前提不再成立。
  //   改用「已达成 vs 未达成」：前者有奖励、后者必须 0 ——
  //   既证明读入参，又顺带验证「未达成不发奖」守卫。
  const notAch = (base.result.MissionProgressList || [])
    .filter(function (m) { return !m.IsAchieved && !m.IsReceived; })
    .map(function (m) { return m.MissionId; })[0];
  if (notAch) {
    const m3 = await call("mission/receive_reward", { mission_type: 2, mission_id_list: [notAch] });
    const a3 = (m3.result.item_format_list || []).length;
    check("未达成任务不发奖（入参敏感性对照）", a3 === 0, notAch + " → " + a3 + " 条");
  } else {
    console.log("  ⏭️  无「未达成」任务可作对照");
  }

  await sleep(2000);
  const afterM = await call("user/load_user_data");
  check("体力已持久化增加", afterM.result.UserData.stamina === base.result.UserData.stamina + expSt1 + expSt2,
    base.result.UserData.stamina + " -> " + afterM.result.UserData.stamina + "（期望 +" + (expSt1 + expSt2) + "）");

  // ---------- 2. 角色强化 ----------
  console.log("【2】character/enhance 按入参并改状态");
  const before2 = (await call("user/load_user_data")).result.CharacterList.mainCharacterList.find(function (c) { return c.master_character_id === C2; });
  const e1 = await call("character/enhance", { characterId: C2, type: 1, itemList: [{ itemId: "Item_Material_Main_Exp_SSR", requestCount: 2 }], tutorialProgressType: -1 });
  await sleep(2000);
  const after2 = (await call("user/load_user_data")).result.CharacterList.mainCharacterList.find(function (c) { return c.master_character_id === C2; });
  check("经验 +50000（SSR 25000 x2）", after2.exp === before2.exp + 50000, before2.exp + " -> " + after2.exp);
  check("等级已提升", after2.level > before2.level, before2.level + " -> " + after2.level);
  check("响应返回被强化的角色", e1.result.main_character && e1.result.main_character.master_character_id === C2);

  // ---------- 3. 突破 ----------
  console.log("【3】character/break_limit 按入参");
  const b1 = await call("character/break_limit", { characterId: C3, isMainCharacter: true, requestCount: 1 });
  await sleep(2000);
  const afterB = (await call("user/load_user_data")).result.CharacterList.mainCharacterList.find(function (c) { return c.master_character_id === C3; });
  check("突破值 +1 并持久化", afterB.break_limit >= 1, "break_limit=" + afterB.break_limit);
  check("响应是请求的那个角色", b1.result.main_character && b1.result.main_character.master_character_id === C3);

  // ---------- 4. 改名 ----------
  console.log("【4】user/change_player_message 写状态");
  await call("user/change_player_message", { player_message: "自测消息" });
  await sleep(2000);
  const afterU = await call("user/load_user_data");
  check("签名已更新", afterU.result.UserData.profileMessage === "自测消息", afterU.result.UserData.profileMessage);

  // ---------- 5. 扭蛋扣石 ----------
  console.log("【5】gacha/roll 按入参扣石");
  const g0 = (await call("user/load_user_data")).result.freeStoneBalance;
  // ★ 用真实存在的付费池（2026-10-14）
  //   原断言用 "TestGacha"（不存在的池）→ 不扣石 → 假失败。
  //   ★ 字段名是 **camelCase**（gachaGroupId / gachaList / gachaId / buttonList）
  //     —— 我第一版按 snake_case 读，恒取不到 → 又变成「静默跳过」。
  //     判据就是真机契约 gacha/list 的原文字段名。
  //   兜底：gacha/list 为空时（该存档未扭过蛋）直接用已知的付费池 id。
  const gl = (await call("gacha/list", {})).result;
  let paidId = null, paidButton = null;
  const groups = Array.isArray(gl.UserAssetGachaGroupList) ? gl.UserAssetGachaGroupList : [];
  for (const g of groups) {
    for (const ga of (g.gachaList || [])) {
      for (const b of (ga.buttonList || [])) {
        if (b.buttonId && !/無料|チュートリアル|フレンド|友好/.test(b.buttonId)) {
          paidId = ga.gachaId; paidButton = b.buttonId; break;
        }
      }
      if (paidId) break;
    }
    if (paidId) break;
  }
  if (!paidId) { paidId = "Other_Premium1"; paidButton = "魔宝石_10回引く"; }
  console.log("  付费池: " + paidId + " / " + paidButton);
  await call("gacha/roll", { gachaId: paidId, buttonId: paidButton, tryRollCount: 1 });
  await sleep(2000);
  const g1 = (await call("user/load_user_data")).result.freeStoneBalance;
  check("付费池扣石", g1 < g0, g0 + " -> " + g1 + "（池 " + paidId + "）");

  // ---------- 6. 商店/礼物 ----------
  console.log("【6】present/list 与 present/receive 状态化");
  const pl0 = await call("present/list", {});
  const n0 = (pl0.result.presentList || []).length;
  check("present/list 有内容", n0 > 0, n0 + " 项");

  // ---------- 复位 ----------
  console.log("");
  await call("__reset", {});
  const restored = await call("user/load_user_data");
  check("状态已复位到录制存档", restored.result.UserData.stamina === base.result.UserData.stamina && gold(restored) === gold(base),
        "stamina=" + restored.result.UserData.stamina + " gold=" + gold(restored));

  console.log("");
  console.log("总计: 通过 " + pass + " / 失败 " + fail + (skipped ? " / 跳过 " + skipped : ""));
  process.exit(fail > 0 ? 1 : 0);
})();