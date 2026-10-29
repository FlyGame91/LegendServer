// statetest.mjs —— 「有数据状态」下的读取正确性测试。
//
// 【为什么单独一套】audit.mjs 比的是「契约（录制值）vs 我的实现」，契约是固定快照，
// 无论当前存档有没有数据，判定都一样 ——**它测不出「数据存在时读取是否正确」**。
//
// 用户指出的盲区：
//   「假设背包的读取代码有问题，但因我新账号，我背包里没有东西，
//     所以这个读取的问题并没有体现出来。」
//
// 本套件补上这一层：
//   ① 用**真实业务流程**制造数据（seedflow 的步骤）
//   ② 然后调用【读取类】端点，断言返回值**确实反映了刚制造出来的数据**
//   ③ 数据必须是流程产生的（含真实实例 id、真实字段结构），不能凭空写
//
// 用法: node statetest.mjs
// ★★ 隔离存档（2026-09-30 事故修复）★★
//   本测试套件每个用例前后都会 __reset，若直接跑在 state/user.json 上，
//   会把用户正在玩的存档冲回基准档（实测：177 角色 → 169 角色、石头 1亿 → 3万）。
//   这里强制把存档指向【独立的测试档】—— __reset 只动它，绝不碰用户的 user.json。
//   注意：只对【本进程内直连 state.mjs】的测试生效；
//   通过 HTTP 打到服务端的测试，需要服务端也用同一环境变量启动（见 run-tests.mjs）。
if (!process.env.LEGECLOX_STATE) process.env.LEGECLOX_STATE = "state/_test-user.json";

import http from "node:http";
import fs from "node:fs";

// ★ 端口可用 LEGECLOX_TEST_PORT 覆盖（见 run-tests.mjs 的隔离测试）——
// 这样测试可以打到一个【用独立存档启动】的服务端，而不触碰用户的 state/user.json。
const PORT = Number(process.env.LEGECLOX_TEST_PORT || 18100);
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
const load = async function () { return R(await call("user/load_user_data", {})); };

let pass = 0, fail = 0;
const out = [];
function check(name, ok, detail) {
  if (ok) { pass++; out.push("  OK   " + name + (detail ? "  (" + detail + ")" : "")); }
  else { fail++; out.push("  FAIL " + name + (detail ? "  (" + detail + ")" : "")); }
}

(async function () {
  await call("__reset", {});
  await sleep(300);

  // ============ 阶段 1：按真实流程制造数据 ============
  const s0 = await load();
  const eq0 = (s0.ItemList.EquipmentList || []).length;

  // 抽卡 -> 新角色（真实实例 id）
  const roll = R(await call("gacha/roll", { gachaGroupId: "Other_Premium1", gachaId: "Other_Premium1", buttonId: "x", tryRollCount: 10, appearNumber: 1 }));
  await sleep(2200);
  const s1 = await load();
  const ch1 = [].concat(s1.CharacterList.mainCharacterList, s1.CharacterList.supportCharacterList);

  // 装备穿戴（产生 owner 关联）
  const eq1 = (s1.ItemList.EquipmentList || [])[0];
  const chA = (s1.CharacterList.mainCharacterList || [])[0];
  if (eq1 && chA) {
    await call("character/equip", { characterId: chA.master_character_id, attachingEquipmentIdList: [eq1.Id], detachingEquipmentIdList: [] });
    await sleep(800);
  }

  // 技能设置（产生 SetSkillList 记录）
  if (chA) {
    await call("character/change_skill", { characterId: chA.master_character_id, skillIdList: ["1100276", "1100275"] });
    await sleep(800);
  }

  // 创建公会（产生 guild_internal_data）
  await call("guild/create", { guild_name: "STATETEST_GUILD", recruit_message: "t", play_style: 1, joining_condition: 0 });
  await sleep(800);

  // 装备限界突破（产生消耗与突破等级变化）
  const s2 = await load();
  const eqB = (s2.ItemList.EquipmentList || [])[0];
  let blBefore = 0;
  if (eqB) {
    blBefore = eqB.break_limit || 0;
    await call("baggage/breakLimitEquipment", { targetEquipmentUserId: eqB.Id, consumeEquipmentUserId: 0, alternativeMaterialId: "" });
    await sleep(900);
  }

  out.push("=== 阶段 1：制造数据（全部走真实端点）===");
  out.push("  抽卡后角色数: " + ch1.length);
  out.push("  装备穿戴: " + (eq1 ? chA.master_character_id + " <- " + eq1.Id : "(无)") + "");
  out.push("");

  // ============ 阶段 2：读取类端点必须反映刚制造的数据 ============
  out.push("=== 阶段 2：读取一致性断言 ===");
  const s3 = await load();
  const ch3 = [].concat(s3.CharacterList.mainCharacterList, s3.CharacterList.supportCharacterList);

  // 2.1 抽到的角色必须出现在【读取】里（这是最核心的：读 vs 实际）
  const declared = ((roll && roll.player_all_asset && roll.player_all_asset.MainCharacter) || []).map(function (c) { return c.master_character_id; });
  const inRead = declared.filter(function (id) { return ch3.some(function (c) { return c.master_character_id === id; }); });
  check("抽到的角色在 load_user_data 中可读", declared.length === 0 || inRead.length === declared.length,
        "声明 " + declared.length + " / 可读 " + inRead.length);

  // 2.2 装备穿戴后，角色身上必须能读到该装备（双向一致）
  if (eq1 && chA) {
    const c = ch3.find(function (x) { return x.master_character_id === chA.master_character_id; });
    const e = (s3.ItemList.EquipmentList || []).find(function (x) { return String(x.Id) === String(eq1.Id); });
    // ★ 改为「按装备侧的 OwnerCharacterId 反查」（2026-10-16）——
    //   原断言用的是 `c.equipment_id_list`，那是**我自造的、契约里没有的字段**
    //   （真机 0/170、本地契约 0/169 都没有它）。这是本项目【第 3 次】把自造字段写进断言。
    check("穿戴后角色可读回装备（按 OwnerCharacterId 反查）",
          !!e && String(e.OwnerCharacterId) === String(chA.master_character_id),
          e ? ("Owner=" + e.OwnerCharacterId + " cat=" + e.OwnerCharacterCategory) : "装备缺失");
    // ★ 字段名必须是 OwnerCharacterId（2026-10-14）
    //   原断言用的是 equipped_character_id —— 那是**我自己造的、客户端不认的字段**，
    //   等于把 bug 固化进测试里（"基于可疑实现写的断言会固化 bug"，本项目已第 2 次）。
    //   真机契约实证：装备归属字段是 OwnerCharacterId / OwnerCharacterCategory。
    check("穿戴后装备可读回持有者", !!e && String(e.OwnerCharacterId) === String(chA.master_character_id),
          e ? String(e.OwnerCharacterId) + " / cat=" + e.OwnerCharacterCategory : "装备缺失");
  }

  // 2.3 技能设置后，SetSkillList 必须可读且结构正确
  if (chA) {
    const mine = (s3.SetSkillList || []).filter(function (x) { return x.master_character_id === chA.master_character_id; });
    check("技能配置可读回", mine.length === 2, mine.length + " 条");
    check("技能记录结构正确", mine.length > 0 && !!mine[0].master_skill_id && mine[0].player_account_id !== undefined,
          mine.length ? Object.keys(mine[0]).join(",") : "-");
  }

  // 2.4 公会创建后必须可读
  // ★ 改从 mypage 读（2026-10-17）：`user/load_user_data` **不再下发** guild_internal_data。
  //   依据：契约 210 份（本地 103 + 真机 107）逐份扫描 —— 含该键的只有 9 个端点，
  //   其中【没有】user_load_user_data。它是「语义单例」，在出口对需要它的端点单独注入。
  const _myG = R(await call("user/load_mypage_data", {}));
  check("公会可读回", !!(_myG.guild_internal_data && _myG.guild_internal_data.guild_name),
        _myG.guild_internal_data ? _myG.guild_internal_data.guild_name : "无");

  // 2.5 限界突破后 break_limit 必须真的变了
  if (eqB) {
    const after = (s3.ItemList.EquipmentList || []).find(function (x) { return String(x.Id) === String(eqB.Id); });
    check("限界突破后 break_limit 递增", !!after && (after.break_limit || 0) > blBefore, blBefore + " -> " + (after ? after.break_limit : "?"));
  }

  // ============ 阶段 3：两个读取端点必须【互相一致】============
  // 客户端实际只有两个读取入口：user/load_user_data（全量）与 user/load_mypage_data（主页）。
  // 二者共享若干字段（MissionProgressList / guild_internal_data / userData / present_count …），
  // 必须一致 —— 若各写一份逻辑，极易出现「主页显示 3 条任务、详情显示 5 条」这类 bug。
  // 这正是「数据存在时才暴露」的问题：新账号两边都是空，永远看不出不一致。
  out.push("");
  out.push("=== 阶段 3：两个读取端点的一致性 ===");
  const my = R(await call("user/load_mypage_data", {}));
  const uu = await load();

  const cmp = function (name, a, b) {
    const na = Array.isArray(a) ? a.length : (a === undefined || a === null ? -1 : 1);
    const nb = Array.isArray(b) ? b.length : (b === undefined || b === null ? -1 : 1);
    check("两读取端点一致: " + name, na === nb, "mypage " + na + " / user_data " + nb);
  };
  // ★★ 修正（2026-10-14）：不是所有同名字段都该一致 ★★
  //   原来断言 MissionProgressList / limited_mission_progress_list 两端点条数相同 ——
  //   那是**基于我自己的 bug 写的**（我当时两处都塞了全量）。
  //   真机契约实证（contracts_winr 对比）：
  //     MissionProgressList            load_user_data=2083（全量快照） mypage=**0**（增量）
  //     limited_mission_progress_list  load_user_data=40            mypage=**0**
  //   ⇒ 这两个字段语义是【增量】，只有 load_user_data 是全量；两端点**本就不该相同**。
  //   若强行要求一致，就是在固化 bug。
  check("mypage 的任务字段为空（增量语义，非全量）",
        (my.MissionProgressList || []).length === 0 && (my.limited_mission_progress_list || []).length === 0,
        "MissionProgressList=" + (my.MissionProgressList || []).length +
        " limited=" + (my.limited_mission_progress_list || []).length);
  check("user_data 的任务字段为全量快照",
        (uu.MissionProgressList || []).length > 0,
        (uu.MissionProgressList || []).length + " 条");
  // ★ 这些字段【确实两端点共享】，必须一致
  cmp("engaged_character_id_list", my.engaged_character_id_list, uu.engaged_character_id_list);
  // ★ 修正（2026-10-17）：guild_internal_data 在两端点的出现规则【不同】，不能比「是否都有」。
  //   mypage 有（客户端主页要显示公会），user_load_user_data **没有**（契约 210 份实证）。
  //   早期断言「两边一致」是基于旧实现（我那时在 load_user_data 里泄漏了该键）。
  check("mypage 含 guild_internal_data（主页要显示公会）", !!my.guild_internal_data,
        my.guild_internal_data ? "有" : "无");
  check("user_data 不含 guild_internal_data（契约实证）", uu.guild_internal_data === undefined,
        uu.guild_internal_data === undefined ? "不含 ✅" : "含（应去掉）");

  // userData 的关键字段必须一致（改名/体力/等级等）
  check("两端点 userData.stamina 一致", my.userData && uu.UserData && my.userData.stamina === uu.UserData.stamina,
        (my.userData ? my.userData.stamina : "?") + " / " + uu.UserData.stamina);
  check("两端点 userData.name 一致", my.userData && uu.UserData && my.userData.name === uu.UserData.name,
        JSON.stringify(my.userData ? my.userData.name : null) + " / " + JSON.stringify(uu.UserData.name));
  check("两端点 freeStoneBalance 一致", my.freeStoneBalance === uu.freeStoneBalance,
        my.freeStoneBalance + " / " + uu.freeStoneBalance);

  // 公会成员列表：创建公会后两边都必须能读到同一个人
  if (uu.guild_internal_data) {
    const gm = (my.guild_internal_data && my.guild_internal_data.member_list) || [];
    const gu = (uu.guild_internal_data && uu.guild_internal_data.member_list) || [];
    check("公会成员列表两端口径一致", gm.length === gu.length, "mypage " + gm.length + " / user_data " + gu.length);
  }

  await call("__reset", {});
  console.log(out.join("\n"));
  console.log("");
  console.log("总计: 通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();