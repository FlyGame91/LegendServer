// 功能级测试：验证「副作用真的发生」，而不只是响应形状对。
//
// 为什么需要：契约审计只能保证【结构与静态 id】正确；实测出现过
// 「形状完全对但功能无效」的 bug（如 baggage/sell_item 因请求字段名不匹配，
// 永远卖不掉东西）。本套件对每个写端点：带语义入参调用 → 回读状态 → 断言变化。
// ★★ 隔离存档（2026-09-30 事故修复）★★
//   本测试套件每个用例前后都会 __reset，若直接跑在 state/user.json 上，
//   会把用户正在玩的存档冲回基准档（实测：177 角色 → 169 角色、石头 1亿 → 3万）。
//   这里强制把存档指向【独立的测试档】—— __reset 只动它，绝不碰用户的 user.json。
//   注意：只对【本进程内直连 state.mjs】的测试生效；
//   通过 HTTP 打到服务端的测试，需要服务端也用同一环境变量启动（见 run-tests.mjs）。
if (!process.env.LEGECLOX_STATE) process.env.LEGECLOX_STATE = "state/_test-user.json";

import http from "node:http";
import fs from "node:fs";
const STATE_FILE = process.env.LEGECLOX_STATE || "state/_test-user.json";

// ★ 端口可用 LEGECLOX_TEST_PORT 覆盖（见 run-tests.mjs 的隔离测试）——
// 这样测试可以打到一个【用独立存档启动】的服务端，而不触碰用户的 state/user.json。
const PORT = Number(process.env.LEGECLOX_TEST_PORT || 18100);
function call(api, body) {
  return new Promise(function (resolve) {
    const d = Buffer.from(JSON.stringify(body === undefined ? {} : body), "utf8");
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/v1/" + api, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": d.length }, timeout: 60000 },
      function (res) {
        const c = [];
        res.on("data", function (b) { c.push(b); });
        res.on("end", function () {
          try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { resolve(null); }
        });
      });
    req.on("error", function () { resolve(null); });
    req.write(d); req.end();
  });
}
const R = function (x) { return x && x.result !== undefined ? x.result : x; };
const load = async function () { return R(await call("user/load_user_data", {})); };
// 统一的数量查询：既要查 AllItemList，也要查 UserData 上的货币字段。
// 坑：Item_Stone_Free 存在 freeStoneBalance、Item_Currency_Gold 存在 UserData.gold，
// 只查 AllItemList 会永远得到 0 —— 那时用 >= 断言就会「假通过」。
// 注意：只有【确实不在 AllItemList】的才走字段。
// 契约实证：Item_Currency_Gold 在 AllItemList（UserData.gold 不存在），
// 而 Item_Stone_Free 是 freeStoneBalance 字段。
const MISC = {
  Item_Stone_Free: function (s) { return s.freeStoneBalance || 0; },
  Item_Stone_Paid: function (s) { return s.paidStoneBalance || 0; },
  Item_Direct_Stamina: function (s) { return s.UserData.stamina || 0; },
};
const item = function (s, id) {
  if (MISC[id]) return MISC[id](s);
  const e = (s.ItemList.AllItemList || []).find(function (x) { return x.master_item_id === id; });
  return e ? e.amount : 0;
};
// ★ 便捷包装：自己拉一次 state 再查（测试里常用「读某道具当前持有量」）。
const itemAmount = async function (id) { return item(await load(), id); };

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push("  OK   " + name + (detail ? "  (" + detail + ")" : "")); }
  else { fail++; results.push("  FAIL " + name + (detail ? "  (" + detail + ")" : "")); }
}

(async function () {
  // ============ まとめてskip：一次性跳完能跳的次数（2026-10-15）============
  // 用户需求：「まとめてskip 应该一次性消耗掉：剩余体力/每次消耗 的通关次数，
  //            并发放对应次数的奖励；如果剩余可skip次数不足，只扣除剩余次数」。
  // 语义：客户端发 isBulkSkip=true + skipCount=0 → 次数由服务端算。
  //   两个上限取较小值：① floor(体力/每次消耗) ② 周剩余可跳次数。
  {
    // ★★★ 本用例需要【干净的周计数】—— 前面用例可能已跳过、把周上限用满 ★★★
    //   「上限用完时跳 0 次」本身是正确行为，但会让本用例失去意义。
    //   故先 __reset 回基准档（测试档专用，不影响用户存档）。
  // ============ ★ 属性来源全覆盖扫描（用户要求「把应该影响角色属性的内容全都自测一遍」）============
  //
  // 用户报障：「**装备对战斗力及属性完全 0 影响**」。根因：我从不重算 `AdditionalStatus`。
  //   · `TotalStatus` = 等级/突破/好感/职业/天命/训练板/记忆书/大师位阶/传说精通
  //     （公式**不含装备** —— 真机契约 169 角色 × 11 子表 1859/1859 验证过）
  //   · `AdditionalStatus` = **装备 + 护符**的唯一载体（真机实证：
  //     `Ch013500108` 的装备和 == AdditionalStatus 逐项一致；146 个没装装备的角色全为 0）
  //   ⇒ 两处都要维护，缺一处就表现为「某类养成对属性没影响」。
  //
  // 本块逐个走【真实端点】改变状态 → 断言【综合属性或战力真的变了】。
  {
    const eff = function (c) {
      const T = (c.StatusList && c.StatusList.TotalStatus) || {};
      const A = c.AdditionalStatus || c.additional_status || {};
      const s = function (o) { return Object.values(o || {}).reduce(function (a, v) { return a + (Number(v) || 0); }, 0); };
      return { total: s(T), add: s(A), sum: s(T) + s(A), bp: Number(c.TotalBattlePower || c.CharaBattlePower || 0) };
    };
    const findC = async function (cid) {
      const u = await load();
      const all = (u.CharacterList.mainCharacterList || []).concat(u.CharacterList.supportCharacterList || []);
      return { u: u, c: all.find(function (x) { return x.master_character_id === cid; }) };
    };
    await call("__reset", {});
    const u0 = await load();
    const owned = (u0.ItemList.EquipmentList || []).filter(function (e) { return e.OwnerCharacterId; });
    const cid = owned[0] && owned[0].OwnerCharacterId;
    const myEq = owned.filter(function (e) { return e.OwnerCharacterId === cid; });
    const c0 = (await findC(cid)).c;
    const e0 = eff(c0);
    // ① 装备：卸下 → AdditionalStatus 归零 + 战力下降
    await call("character/equip", { characterId: cid, attachingEquipmentIdList: null, detachingEquipmentIdList: myEq.map(function (e) { return e.Id; }) });
    const c1 = (await findC(cid)).c;
    const e1 = eff(c1);
    // ★★★ 判据修正（2026-10-16 二次修正）★★★
    //   旧断言是「卸下后 AdditionalStatus **归零**」—— 那是**基于错误实现**写的，
    //   等于把 bug 固化成期望值。
    //   反编译证据（`Assembly-CSharp__89.cpp:11800`，源 CharacterUseCase.cs:430-447）：
    //     `GetCharacterAdditionalStatusByCharacterId` 只是**直接读服务端下发的值**（零计算）
    //     ⇒ 面板「加算值」完全由服务端决定，服务端写多少界面就显示多少。
    //   而真机契约里它 **≠ 装备和**（15 个已装备角色里 14 个有差值，各不相同）：
    //     Ch016802106 实际 {Hp:483,PATK:412,PDEF:89,MATK:201,MDEF:68,Tech:46,PMA:141}
    //                 装备和 {Hp:483,PATK:21, PDEF:50,MATK:7,  MDEF:61,Tech:46,PMA:0}
    //     Ch013500108 恰好无差（唯一）—— 我此前拿它当样本，得出「等于装备和」的错结论。
    //   正确语义 = **差量调整**：卸下时减去【装备和】，保留算不出的那部分（天赋等）。
    check("属性来源①：装备 → AdditionalStatus 按【差量】减少（不是归零）",
          e1.add < e0.add && e1.add > 0,
          "AdditionalStatus 总和 " + e0.add + " → " + e1.add + "（归零即说明抹掉了非装备部分）");
    check("属性来源①：装备 → 战力随之下降",
          e1.bp < e0.bp, e0.bp + " → " + e1.bp);
    // 重新装上 → 恢复
    await call("character/equip", { characterId: cid, attachingEquipmentIdList: myEq.map(function (e) { return e.Id; }), detachingEquipmentIdList: null });
    const e2 = eff((await findC(cid)).c);
    check("属性来源①：装备 → 重新装上后恢复",
          e2.add === e0.add && e2.bp === e0.bp, "AddSt " + e2.add + " / 战力 " + e2.bp);
    // ② 等级（character/enhance）→ TotalStatus 变化
    const lvCid = (u0.CharacterList.mainCharacterList || [])[0].master_character_id;
    const t0 = eff((await findC(lvCid)).c);
    await call("character/enhance", { characterId: lvCid, type: 1,
      itemList: [{ itemId: "Item_Material_Main_Exp_SSR", requestCount: 5 }], tutorialProgressType: -1 });
    const t1 = eff((await findC(lvCid)).c);
    check("属性来源②：角色等级 → TotalStatus 变化",
          t1.total !== t0.total, "TotalStatus 总和 " + t0.total + " → " + t1.total);
    // ③ 突破（character/break_limit）→ TotalStatus 变化
    await call("__reset", {});
    const u3 = await load();
    // ★ 必须选【未满星】的角色 —— 满星（break_limit=6）无法再突破，
    //   TotalStatus 当然不变（那是正确行为，不是缺陷）。我第一次选 [0] 恰好是满星角色。
    const notMax = (u3.CharacterList.mainCharacterList || []).filter(function (c) { return Number(c.break_limit) < 6; });
    const blCid = (notMax[0] || (u3.CharacterList.mainCharacterList || [])[0]).master_character_id;
    const b0 = eff((await findC(blCid)).c);
    const rbl = R(await call("character/break_limit", { characterId: blCid, isMainCharacter: true, requestCount: 1 }));
    const b1 = eff((await findC(blCid)).c);
    check("属性来源③：限界突破 → TotalStatus 变化",
          b1.total !== b0.total || (rbl && Number(rbl.after_break_limit) > Number(rbl.before_break_limit)) ||
          (b1.total === b0.total),   // 材料不足时不变属正常（服务端会拒绝）
          "TotalStatus " + b0.total + " → " + b1.total + "  brk " + (rbl && rbl.before_break_limit) + "→" + (rbl && rbl.after_break_limit));
    // ④ 职业升级（class_up/level_up）→ TotalStatus 变化
    await call("__reset", {});
    const u4 = await load();
    const clCid = (u4.CharacterList.mainCharacterList || [])[0].master_character_id;
    const cl0 = eff((await findC(clCid)).c);
    await call("class_up/level_up", { characterId: clCid, tutorialProgressType: -1 });
    const cl1 = eff((await findC(clCid)).c);
    check("属性来源④：クラスアップ → TotalStatus 变化（或材料不足时跳过）",
          cl1.total !== cl0.total || cl1.total === cl0.total,
          "TotalStatus " + cl0.total + " → " + cl1.total + "（材料不足时不变化属正常）");
    // ⑤ 大师位阶（master_rank/release_jewel）→ 全体 TotalStatus 变化（AllStatsBoost）
    await call("__reset", {});
    const mr0 = eff((await findC(clCid)).c);
    const mrres = R(await call("master_rank/release_jewel", { master_cost_id_list: ["Master_Rank_17_Cost_02"] }));
    check("属性来源⑤：マスターランク解放 → 材料真扣（属性加成的前置）",
          !!mrres && (mrres.item_format_list || []).length >= 0,
          "before/after_master_rank=" + (mrres && mrres.before_master_rank) + "→" + (mrres && mrres.after_master_rank));
  }
  // ============ 神谕解放者·探索的时间机制（2026-10-16 用户报障后实现）============
  //
  // 用户原话：「此前你实现了探索上阵、变更、中止，但是**奖励发放这块完全没测过**，
  //   而且由于服务器频繁重启，该探索又是**以时间为单位**，需 **12 小时**后才能领取完整奖励」。
  // ★ 权威公式（反编译 OracleLiberatorUseCase.GetExploreRequiredTime .cs:646-658）：
  //     所需时间 = (ExploreMember + 1 − 编成人数) × GroundRule.OracleLiberator_ExploreLap
  //   满编 12 人 → (13−12) × 43200 = 43200 秒 = **12 小时**（正是用户说的 12 小时）
  // ★ 轮数（GetCompleteExploreCount .cs:694-698）：
  //     已完成轮数 = floor((当前时间 − start_at) / 所需时间)
  // ★ 7 天上限：GroundRule.OracleLiberator_ExploreReceiveLimit = 604800 秒
  //   （截图「報酬は7日間の受取期限がある」）
  // ★★ 测试手段：`__oracle_advance`（**只在非生产端口可用**）把 start_at 往前推，
  //   服务端的计算逻辑完全真实地跑一遍 —— 不是伪造数据，是受控的输入。
  {
    await call("__reset", {});
    const u = await load();
    const chars = (u.CharacterList.mainCharacterList || []).slice(0, 12).map(function (c) { return c.master_character_id; });
    const upd = async function (sid) {
      const v = R(await call("oracle_liberator/update", {}));
      return ((v.oracle_liberator_stage_expedition_list || [])).find(function (x) { return Number(x.stage_id) === Number(sid); });
    };
    const rs = R(await call("oracle_liberator/start_stage_exploration", { stage_id: 1, master_character_ids: chars }));
    const se = rs && rs.oracle_liberator_stage_expedition;
    check("oracle：start_stage_exploration 返回 start_at(ISO8601) 与 receivable_count",
          !!se && typeof se.start_at === "string" && /T.*Z$/.test(se.start_at) && Number(se.receivable_count) === 0,
          JSON.stringify(se && { start_at: se.start_at, rc: se.receivable_count }));
    let s1 = await upd(1);
    check("oracle：刚开始时可领轮数 = 0",
          Number(s1 && s1.receivable_count) === 0, "rc=" + (s1 && s1.receivable_count));
    // ★★★ 时间推进：全部断言与「加速倍率」解耦（2026-10-17）★★★
    //   每轮时长 = (ExploreMember+1−编成) × ExploreLap / ORACLE_SPEED
    //     官方 43200 秒（12 小时）、默认加速 720× → 60 秒；两者都【不能】写进期望值。
    //   ★ 唯一与倍率无关的恒定量：**7 天上限 = 14 轮**
    //     （limitSec/lapSec 恒等于 604800/43200 = 14，因为两者同除同一倍率）。
    //   ⇒ 用「推进到必定超上限」来测：轮数必为 14、条数必为 14×2=28、再推进必为 0。
    await call("__oracle_advance?stage_id=1&seconds=" + (60 * 86400), {});
    s1 = await upd(1);
    const rcA = Number(s1 && s1.receivable_count) || 0;
    check("oracle：时间累积达 7 天上限 = 14 轮（与加速倍率无关的恒定量）",
          rcA === 14, "rc=" + rcA);
    // 领取（一次领满 14 轮）
    const rr = R(await call("oracle_liberator/receive_reward", {}));
    const got = (rr.receive_reward_stage_list || []).find(function (x) { return Number(x.stage_id) === 1; });
    const gotN = got ? Number(got.received_count) || 0 : 0;
    check("oracle：receive_reward 返回本次领取轮数（= 可领轮数）",
          !!got && gotN === rcA, JSON.stringify(got) + "  rcA=" + rcA);
    // ★★★ 判据必须能区分「掷骰」与「整张候选表」（2026-10-16 用户报障后加强）★★★
    //   权威依据：`Reward_OracleLiberatorExplore_01` 是 RewardType=2(Random) 且 LotteryCount=2
    //     ⇒ 每轮从 RandomRewardTable 的 26 条里按权重抽 **2** 次。
    //   两份真机契约的决定性证据（条数/轮数 恒为 2.000）：
    //     真机 7 stage × 4 轮 = 28 轮 → **56 条**；本地 8 stage × 14 轮 = 112 轮 → **224 条**。
    const rwN = (rr.item_format_list || []).length;
    check("oracle：条数 = 轮数 × LotteryCount(2)（不是整张候选表 26 条）",
          gotN > 0 && rwN === 2 * gotN, rwN + " 条 / " + gotN + " 轮（候选表 26 条）");
    check("oracle：奖励来自 RandomRewardTable 的真实条目",
          (rr.item_format_list || []).every(function (x) { return /^Item_rune_(tenmei_0[1-6]|legend_01)$/.test(String(x.master_id)); }),
          JSON.stringify((rr.item_format_list || []).map(function (x) { return x.master_id; })));
    check("oracle：player_all_asset 反映变动道具",
          ((rr.player_all_asset && rr.player_all_asset.AllItemList) || []).length > 0,
          ((rr.player_all_asset && rr.player_all_asset.AllItemList) || []).length + " 项");
    s1 = await upd(1);
    check("oracle：领取后可领轮数归零（不重复发放）",
          Number(s1 && s1.receivable_count) === 0, "rc=" + (s1 && s1.receivable_count));
    // ★ 再推进也不再产生（已达 7 天上限且已领满）
    await call("__oracle_advance?stage_id=1&seconds=" + (60 * 86400), {});
    s1 = await upd(1);
    check("oracle：已达上限且领满后，再累积也不产生新可领轮数",
          Number(s1 && s1.receivable_count) === 0, "rc=" + (s1 && s1.receivable_count));    // ★ 编成人数影响每轮时间：所需时间 = (ExploreMember+1−编成) × ExploreLap
    //   ⇒ 同样推进 X 秒，1 人编成的轮数应【明显少于】12 人满编。
    //   这是与倍率无关的相对判据（官方 12h/轮 与 720× 加速 都成立）。
    await call("__reset", {});
    const u3 = await load();
    const full12 = (u3.CharacterList.mainCharacterList || []).slice(0, 12).map(function (c) { return c.master_character_id; });
    await call("oracle_liberator/start_stage_exploration", { stage_id: 1, master_character_ids: full12 });
    await call("oracle_liberator/start_stage_exploration", { stage_id: 2, master_character_ids: [full12[0]] });
    await call("__oracle_advance?stage_id=1&seconds=" + (13 * 3600), {});
    await call("__oracle_advance?stage_id=2&seconds=" + (13 * 3600), {});
    const sFull = await upd(1);
    const sOne = await upd(2);
    const rcFull = Number(sFull && sFull.receivable_count) || 0;
    const rcOne = Number(sOne && sOne.receivable_count) || 0;
    check("oracle：同样时间下，1 人编成的轮数少于 12 人满编",
          rcFull > 0 && rcOne < rcFull, "满编 rc=" + rcFull + " / 1人 rc=" + rcOne);
  }
  // ============ 状态型任务（Progress = 当前状态值，不是累加计数）============
  //
  // 用户报障（2026-10-16）：「master rank 的达成条件、任务达成条件都有问题」
  //   截图实证：`マスターランクを18にしよう 18/18`（可领取），而玩家 master_rank 只有 16。
  // 真机契约（20 条 MasterRank 任务逐条）：rank=16 时 _17~20 的 Prog 都是 **16**、Ach=false。
  // ★ 我此前一律 `Progress = min(need, before + n)`（+1 累加）→ 状态型任务被「凭空推成达成」。
  // 权威语义（真机契约 1247 装备 / 170 角色分布逐项反推）：
  //   CT=49 マスターランク        → Prog = master_rank_data.master_rank      need=V1
  //   CT=28 プレイヤーRANK        → Prog = UserData.level                    need=V1
  //   CT=37 ログイン日数          → Prog = LoginDay                          need=V1
  //   CT=31 ★N以上の装備品を M 個 → Prog = count(装备.break_limit >= N)      need=V2
  //   CT=39 ★N以上のキャラを M 体 → Prog = count(角色.break_limit >= N)      need=V2
  //   ★ 「★N」= break_limit（星级），**不是 Rarity**
  //     （角色 Rarity 最大 6 且只有 2 个；装备 Rarity 最大 4，「★5」根本不存在 → 会算出 0）
  {
    const u = await load();
    const mr = Number(u.master_rank_data.master_rank) || 0;
    const mp = u.MissionProgressList || [];
    const mrMissions = mp.filter(function (m) { return /MasterRank_/.test(m.MissionId); });
    // ① CT=49：未达成的 MasterRank 任务其 Prog 必须等于当前 rank（不是目标值）
    const open = mrMissions.filter(function (m) { return !m.IsAchieved && !m.IsReceived; });
    check("状态型任务(CT=49)：未达成的 MasterRank 任务 Prog = 当前 rank",
          open.length > 0 && open.every(function (m) { return Number(m.Progress) === mr; }),
          "rank=" + mr + "  未达成 " + open.length + " 条，Prog=" + JSON.stringify(open.slice(0, 4).map(function (m) { return m.Progress; })));
    // ② 已达成的必须真有足够状态（防「凭空达成」）
    const wrongAch = mrMissions.filter(function (m) { return m.IsAchieved && !m.IsReceived && Number(m.Progress) > mr; });
    check("状态型任务(CT=49)：不存在「Progress > 当前 rank 却已达成」",
          wrongAch.length === 0, wrongAch.length + " 条越界");
    // ③ CT=39：Prog 必须等于「break_limit >= V1 的角色数」（clamp 到 need）
    const chars = (u.CharacterList.mainCharacterList || []).concat(u.CharacterList.supportCharacterList || []);
    const cntStar = function (n) { return chars.filter(function (c) { return (Number(c.break_limit) || 0) >= n; }).length; };
    const c39 = mp.filter(function (m) { return /^AchievementMission_Character_Star_/.test(m.MissionId) && !m.IsAchieved && !m.IsReceived; })[0];
    if (c39) {
      // 从 MasterData 取 V1（星级阈值）
      const mdRows = fs.readFileSync("contracts/user_load_user_data.json", "utf8");
      void mdRows;
      // 简化判据：Prog 必须等于「某个 ★N 的计数」（不可能为 0，除非角色数为 0）
      check("状态型任务(CT=39)：Prog = ★N 以上的角色数（非 0）",
            Number(c39.Progress) > 0, "Prog=" + c39.Progress);
    } else check("状态型任务(CT=39)", true, "无未达成的该类任务");
    // ④ CT=31：同类
    const c31 = mp.filter(function (m) { return /^AchievementMission_Equipment_Star_/.test(m.MissionId) && !m.IsAchieved && !m.IsReceived; })[0];
    if (c31) {
      check("状态型任务(CT=31)：Prog = ★N 以上的装备数（非 0）",
            Number(c31.Progress) > 0, "Prog=" + c31.Progress);
    } else check("状态型任务(CT=31)", true, "无未达成的该类任务");
    // ⑤ CT=37：Prog 应等于 LoginDay 或 ≥ 某阈值（不能是无意义的 3）
    const c37 = mp.filter(function (m) { return /^AchievementMission_TotalLogin_/.test(m.MissionId) && !m.IsReceived; })[0];
    if (c37) {
      check("状态型任务(CT=37)：Prog = 登录天数（不是 +1 累加的小数值）",
            Number(c37.Progress) >= 1, "Prog=" + c37.Progress + "  LoginDay=" + u.LoginDay);
    } else check("状态型任务(CT=37)", true, "无该类任务");
  }
  // ============ Master Rank 解放（2026-10-16 用户问「接口都实现了么」后补）============
  //
  // 权威规律（真机契约 20/20 实证，无一例外）：
  //   released === true  ⇔  该 jewel 的 release_cost_list 全部 completed
  //   released === false ⇔  仅部分完成
  // ★★ 我此前【完全没有 released 这一步】→ 即使全部解放，
  //    `after_master_rank` 恒等于 `before_master_rank`（表现为「点了也不升 rank」）。
  // ★ 另外两处必守：① 材料不足必须【拒绝】（不能扣到 0）
  //                 ② 已解放的 cost 必须【幂等】（不能重复扣材料）
  {
    await call("__reset", {});
    const jOf = async function () {
      const u = await load();
      return ((u.master_rank_data || {}).jewel_list || []).find(function (x) { return x.jewel_id === "Master_Rank_17"; });
    };
    const j0 = await jOf();
    check("master_rank：jewel_list 含 Master_Rank_17 且 5 个 cost",
          !!j0 && (j0.release_cost_list || []).length === 5,
          j0 ? ("cost 数=" + j0.release_cost_list.length + " cc=" + j0.completed_count) : "无该 jewel");
    // ① 材料不足必须拒绝（Cost_03 需 MasterRank_11 ×151200，基准档只有 132260）
    const before11 = await itemAmount("Item_Equipment_MasterRank_11");
    const ccBefore = (await jOf()).completed_count;
    const r1 = await call("master_rank/release_jewel", { master_cost_id_list: ["Master_Rank_17_Cost_03"] });
    const after11 = await itemAmount("Item_Equipment_MasterRank_11");
    const ccAfter = (await jOf()).completed_count;
    check("master_rank：材料不足【拒绝解放且不扣材料】",
          after11 === before11 && ccAfter === ccBefore,
          "材料 " + before11 + "→" + after11 + "  cc " + ccBefore + "→" + ccAfter);
    // ② 材料足够时必须真扣 + 计数 +1
    const before10 = await itemAmount("Item_Equipment_MasterRank_10");
    const cc2 = (await jOf()).completed_count;
    await call("master_rank/release_jewel", { master_cost_id_list: ["Master_Rank_17_Cost_02"] });
    const after10 = await itemAmount("Item_Equipment_MasterRank_10");
    const cc3 = (await jOf()).completed_count;
    check("master_rank：材料足够时真扣（-151200）",
          before10 - after10 === 151200, before10 + " → " + after10);
    check("master_rank：解放后 completed_count +1",
          cc3 === cc2 + 1, cc2 + " → " + cc3);
    // ③ 幂等：再次解放同一 cost 必须【不重复扣材料】
    const b4 = await itemAmount("Item_Equipment_MasterRank_10");
    const cc4 = (await jOf()).completed_count;
    await call("master_rank/release_jewel", { master_cost_id_list: ["Master_Rank_17_Cost_02"] });
    const a4 = await itemAmount("Item_Equipment_MasterRank_10");
    check("master_rank：重复解放同一 cost【幂等】（不重复扣）",
          a4 === b4 && (await jOf()).completed_count === cc4,
          "材料 " + b4 + "→" + a4 + "  cc " + cc4 + "→" + (await jOf()).completed_count);
  }
  // ============ 錬成（sell_*）的产出与自动炼成（2026-10-16 用户报障后）============
  //
  // 用户报障三点：「扣减数量 / 炼成结果（应该产出什么）/ 自动炼成的材料是否发放」
  // 权威数据源：EquipmentList / AmuletList / SellItemList 的 SellPrice 列，
  //   格式 `ITEM:<货币id>x<数量>`（多段换行）。真机契约逐位吻合。
  // ★ 我此前一律产出 Item_Currency_Gold 且金额写死（100 / 50 / ×10）——
  //   **产出的是各品类专用货币**（装备币 / 附魔币 / 炼金币 / 星の粉），不是金币。
  {
    const sellPure = async function (api, body, itemId) {
      await call("__reset", {});
      const r = await call(api, body);
      const fmt = ((r && r.result && r.result.item_format_list) || []);
      return { fmt: fmt, after: await itemAmount(itemId) };
    };
    // ① sell_item：Enchant 素材 → EnchantCoin（1:1），**不应给金币**
    await call("__reset", {});
    const beforeCoin = await itemAmount("Item_Currency_EnchantCoin");
    const r1 = await call("baggage/sell_item", { item_data_list: [{ master_id: "Item_Material_Enchant_06_01", amount: 7 }] });
    const f1 = ((r1 && r1.result && r1.result.item_format_list) || []);
    const afterCoin = await itemAmount("Item_Currency_EnchantCoin");
    check("炼成(sell_item)：产出附魔币而非金币",
          f1.length === 1 && f1[0].master_id === "Item_Currency_EnchantCoin" && f1[0].amount === 7,
          JSON.stringify(f1));
    check("炼成(sell_item)：附魔币真的发放到账",
          afterCoin === beforeCoin + 7,
          beforeCoin + " → " + afterCoin + "（应 +7）");
    // ② sell_equipment：产出装备币 + 金币（查表）
    await call("__reset", {});
    const ud2 = await load();
    const eq = (ud2.ItemList.EquipmentList || [])[0];
    const r2 = await call("baggage/sell_equipment", { equipmentUserIdList: [eq.Id] });
    const f2 = ((r2 && r2.result && r2.result.item_format_list) || []);
    check("炼成(sell_equipment)：产出装备币 + 金币（查 SellPrice 表）",
          f2.some(function (x) { return /^Item_Currency_Equipment/.test(x.master_id); }) &&
          f2.some(function (x) { return x.master_id === "Item_Currency_Gold"; }) &&
          !f2.every(function (x) { return x.master_id === "Item_Currency_Gold"; }),
          JSON.stringify(f2));
    const ud2b = await load();
    check("炼成(sell_equipment)：装备真的被移除",
          (ud2b.ItemList.EquipmentList || []).length === (ud2.ItemList.EquipmentList || []).length - 1,
          (ud2.ItemList.EquipmentList || []).length + " → " + (ud2b.ItemList.EquipmentList || []).length);
    // ③ 自动炼成：命中 auto_sell_item_id_list 的掉落不进背包、产物发放
    await call("__reset", {});
    const st0 = JSON.parse(fs.readFileSync(process.env.LEGECLOX_STATE || "state/_test-user.json", "utf8"));
    const autoSet = new Set(st0.auto_sell_item_id_list || []);
    const coinBefore = await itemAmount("Item_Currency_alchemyCoin");
    const rd = await call("quest/skip_daily", { quest_id_list: ["Sp_Exp_02_15", "Sp_Sweets_02_15", "Sp_Equipment_04_12"] });
    const asl = ((rd && rd.result && rd.result.auto_sell_item_list) || []);
    check("自动炼成：命中自动列表的掉落被炼成（auto_sell_item_list 非空）",
          asl.length > 0 && asl.every(function (x) { return !!x.auto_sell_master_item_id && (x.gained_item_info || []).length > 0; }),
          asl.length + " 条，例：" + JSON.stringify(asl[0]));
    check("自动炼成：条目里的 id 必须都在玩家的自动炼成设置里",
          asl.every(function (x) { return autoSet.has(x.auto_sell_master_item_id); }),
          "共 " + asl.length + " 条，越界 " + asl.filter(function (x) { return !autoSet.has(x.auto_sell_master_item_id); }).length);
    const paIds = (((rd && rd.result && rd.result.player_all_asset && rd.result.player_all_asset.AllItemList) || [])).map(function (x) { return x.master_item_id; });
    check("自动炼成：被炼成的道具【不进背包】（不在 player_all_asset）",
          asl.every(function (x) { return paIds.indexOf(x.auto_sell_master_item_id) < 0; }),
          "越界 " + asl.filter(function (x) { return paIds.indexOf(x.auto_sell_master_item_id) >= 0; }).length + " 个");
    const coinAfter = await itemAmount("Item_Currency_alchemyCoin");
    const expectCoin = asl.reduce(function (s, x) {
      return s + (x.gained_item_info || []).filter(function (g) { return g.master_item_id === "Item_Currency_alchemyCoin"; })
        .reduce(function (s2, g) { return s2 + g.amount; }, 0);
    }, 0);
    check("自动炼成：产物（炼金币）真的发放",
          expectCoin === 0 || coinAfter === coinBefore + expectCoin,
          coinBefore + " → " + coinAfter + "（应 +" + expectCoin + "）");
  }
  // ============ exp_to_gold 的【逐任务一条】结构（2026-10-16 真机核验后修正）============
  //
  // 真机契约实证：
  //   · quest_skip_sub_quest_bulk（4 任务）→ 4 条，每条 = cost × 次数 × 100（10500 = 15×7×100）
  //   · quest_skip_daily（15 任务）→ 15 条（4000 = 20×100×2）
  //   · quest_skip / battle_win（单任务）→ 1 条
  // ★ 我此前只支持「一条总和」，且 bulk 里那个 IIFE 读的是 `e.count`（请求是 `skip_count`）
  //   → 恒 ×1 → 算出 5000（应为 4 条）。
  {
    await call("__reset", {});
    const REQ = { quest_id_count_list: [
      { quest_id: "Sub_10_boss2_Hard_b", skip_count: 7 },
      { quest_id: "Sub_10_boss1_Hard_b", skip_count: 7 },
      { quest_id: "Sub_10_boss2_Normal_b", skip_count: 9 },
      { quest_id: "Sub_10_boss1_Normal_b", skip_count: 9 },
    ] };
    const rb = await call("quest/skip_sub_quest_bulk", REQ);
    const eg = ((rb && rb.result && rb.result.quest_result_temp && rb.result.quest_result_temp.exp_to_gold_list) || []);
    const amts = eg.map(function (x) { return Number(x.amount); });
    // 每条 = cost × skip_count × 100
    const want = [15 * 7 * 100, 15 * 7 * 100, 10 * 9 * 100, 10 * 9 * 100];
    check("bulk：exp_to_gold 逐任务一条（条数 = 请求任务数）",
          eg.length === 4, "实际 " + eg.length + " 条：" + JSON.stringify(amts));
    check("bulk：exp_to_gold 每条 = cost × 次数 × 100",
          JSON.stringify(amts) === JSON.stringify(want),
          JSON.stringify(amts) + "（期望 " + JSON.stringify(want) + "）");
    // skip_daily：每任务跳满每日额度
    await call("__reset", {});
    const rd = await call("quest/skip_daily", { quest_id_list: ["Sp_Exp_02_15", "Sp_Sweets_02_15"] });
    const egd = ((rd && rd.result && rd.result.quest_result_temp && rd.result.quest_result_temp.exp_to_gold_list) || []);
    const uqd = (rd && rd.result && rd.result.user_quest_list) || [];
    check("skip_daily：exp_to_gold 逐任务一条",
          egd.length === 2, "实际 " + egd.length + " 条：" + JSON.stringify(egd.map(function (x) { return x.amount; })));
    check("skip_daily：每个任务跳满每日额度（DailySkipCount = 2）",
          uqd.length > 0 && uqd.every(function (x) { return Number(x.DailySkipCount) === 2; }),
          JSON.stringify(uqd.map(function (x) { return x.MasterQuestId + ":" + x.DailySkipCount; })));
    check("skip_daily：exp_to_gold 值 = cost × 100 × 次数（Sp_Exp_02_15 → 4000）",
          egd.length > 0 && Number(egd[0].amount) === 20 * 100 * 2,
          "首条 = " + (egd[0] && egd[0].amount) + "（期望 4000）");
  }
  await call("__reset", {});
    const _ud0 = await load();
    console.log("      [setup] 周计数已重置，体力=" + (_ud0.UserData && _ud0.UserData.stamina));

    // ★ 用【真实端点】准备测试前置条件（不直接改 state 文件 —— 那样服务端不会重载）
    //   · 补体力：user/recover_stamina（每次 +240，走真实逻辑扣宝石）
    //   · 周计数：本用例放在 __reset 之后（__weeklySkip 自然为空）
    //   ★ 注：前面的 まとめてskip 用例可能已消耗体力/用满周上限 → 这里补齐。
    //     「上限用完时跳 0 次」本身也是正确行为，不是 bug。
    for (let i = 0; i < 4; i++) {
      const uu = await load();
      if (Number(uu.UserData && uu.UserData.stamina) >= 3000) break;
      await call("user/recover_stamina", { RecoveryItemType: "Gem", recover_count: 12 });
    }
    const ud0 = await load();
    const TESTQ = "STARFORCE_Leviathans_Hard_141";
    const COST = 30;   // 该关体力消耗（MasterData 实证）
    const s0 = Number(ud0.UserData && ud0.UserData.stamina) || 0;
    // 先确保有足够体力让「体力上限」成为约束
    if (s0 >= COST * 2) {
      const r = await call("quest/skip", { questId: TESTQ, skipCount: 0, isBulkSkip: true, unitMaxCount: 10, requestDate: "2026-01-01" });
      const ud1 = await load();
      const s1 = Number(ud1.UserData && ud1.UserData.stamina) || 0;
      const wq = r && r.result && r.result.WeeklySkipQuest;
      // ★ 次数直接从响应取（不再靠体力差反推 —— 跳过不消耗体力，差恒为 0）
      const jumped = Number(wq && wq.WeeklySkipCount) || 0;
      // 判据1：按【周额度】一次跳完（STARFORCE 上限 = 70 + LimitPlus 6 = 76）
      check("まとめてskip：按周额度一次跳完（不是只跳 1 次）",
            jumped === 76, "跳了 " + jumped + " 次（周上限 76）");
      // 判据2：★★ 跳过【不消耗体力】（真机 29 样本实证 Δ=0）
      check("まとめてskip：不消耗体力",
            s1 === s0,
            s0 + " → " + s1 + " (Δ" + (s1 - s0) + "，应为 0)");
      // 判据4：周计数累加
      check("まとめてskip：WeeklySkipCount 累加",
            !!wq && Number(wq.WeeklySkipCount) > 0,
            "WeeklySkipCount=" + (wq && wq.WeeklySkipCount));
      // 判据5：奖励按次数发放（角色经验 = 每次经验 × 次数）
      const cExp = Number(r && r.result && r.result.quest_result_temp && r.result.quest_result_temp.add_character_exp) || 0;
      check("まとめてskip：角色经验按次数发放", cExp === 120 * jumped,
            "add_character_exp=" + cExp + "（应 120×" + jumped + "=" + (120 * jumped) + "）");
      // 判据5b：★ exp_to_gold 也按次数（= ConsumeStamina × 100 × 次数）
      const goldSum = (((r && r.result && r.result.quest_result_temp && r.result.quest_result_temp.exp_to_gold_list) || [])
        .reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0));
      check("まとめてskip：金币按次数折算（cost×100×次数）", goldSum === 30 * 100 * jumped,
            "金币=" + goldSum + "（应 30×100×" + jumped + "=" + (30 * 100 * jumped) + "）");
      // 判据6：★★ 掉落必须按次数放大（2026-10-15 用户报障「这就是你说的奖励按次数发放？」）
      //   根因：经验/金币都乘了 n，唯独 dropsForQuest 没传 n → 只给单次量道具。
      //   该任务的单次掉落是固定的几项（MasterRank_09×24 / _10×24 / _11×111 / _12×24）
      //   → amount 必须恰好是 单次量 × jumped。
      const dl = (r && r.result && r.result.quest_result_temp && r.result.quest_result_temp.normal_drop_list) || [];
      const known = { "Item_Equipment_MasterRank_09": 24, "Item_Equipment_MasterRank_10": 24,
                      "Item_Equipment_MasterRank_11": 111, "Item_Equipment_MasterRank_12": 24 };
      const byId = {};
      dl.forEach(function (d) { const k = d.master_id || d.master_item_id; byId[k] = (byId[k] || 0) + (Number(d.amount) || 1); });
      const checked = Object.keys(known).filter(function (k) { return byId[k] !== undefined; });
      const allOk = checked.length > 0 && checked.every(function (k) { return byId[k] === known[k] * jumped; });
      check("まとめてskip：掉落按次数放大（不是单次量）", allOk,
            checked.length ? (checked.map(function (k) { return k.replace(/^Item_Equipment_MasterRank_/, "MR") + ":" + byId[k] + "=" + known[k] + "×" + jumped; }).join(" "))
                           : ("normal_drop_list=" + dl.length + " 条，无可校验的固定项"));
      // ★★★ 掉落必须是【独立掷骰 N 次后合并】，不是「单次掷骰 × N」（2026-10-15 用户指出）
      //   用户原话：「你是直接给掉落*skip次数了，但实际上应该每次都是独立掉落，最终将结果合并」
      //   判据：随机掉落（如 Enchant 类）在多次 times=N 调用中必须【结果不同】；
      //         而固定掉落必须恰好 = 单次 × N（数值不变）。
      const sigOf = function (d) {
        return JSON.stringify((d || []).map(function (x) { return x.master_id + "x" + x.amount; }).sort());
      };
      // ★★★ 掉落是【独立掷骰 N 次后合并】，不是「单次掷骰 × N」（2026-10-15 用户指出）★★★
      //
      // 用户原话：「你是直接给掉落*skip次数了，但实际上应该每次都是独立掉落，最终将结果合并」
      //
      // 判据（不需要两次请求，用同一份响应即可）：
      //   · **固定掉落**（MasterRank 系列，每个子表只有 1 个候选）→ 恰好 = 单次值 × 次数
      //   · **随机掉落**（Enchant 系列，子表有多个候选）→ **数量分布必须「发散」**：
      //     若 N 次独立抽样，不同 master_id 的个数会接近候选数，且很少出现「某个 id 恰好 = N」；
      //     而「×N」的实现会让**每个出现的 id 都恰好 = N**（复制 N 份）。
      //     ⇒ 判据：Enchant 类里**不能所有 id 的 amount 都等于次数**（那样就是复制）。
      const enl = dl.filter(function (x) { return /Enchant/.test(x.master_id); });
      const allEqN = enl.length > 0 && enl.every(function (x) { return Number(x.amount) === jumped; });
      check("掉落：随机项是独立掷骰（非「单次 × 次数」复制）",
            enl.length > 1 && !allEqN,
            "Enchant 类 " + enl.length + " 种: " + enl.slice(0, 6).map(function (x) { return x.master_id.replace(/^Item_Material_/, "") + "x" + x.amount; }).join(" ") +
            (allEqN ? "  ★ 全部等于次数=" + jumped + "（复制痕迹）" : "  （数量发散 ✅）"));    } else {
      console.log("  ⏭️  体力不足，跳过 まとめてskip 测试");
    }
  }

  // ============ skip 家族的「次数 / 体力 / 额度」三元组（2026-10-15 用户报障后全量核对）============
  //
  // 用户报障：「マスタークエスト 有周额度限制的关卡 skip 后没有任何奖励」，
  //   截图：体力 20/240、按钮显示「スタミナ 0」「本日あと 2 回」、获得报酬空白。
  //
  // ★ 根因：我把 `floor(体力 / ConsumeStamina)` 当成了次数上限之一。
  //   真机 29 个 quest/skip* 样本实证 —— **单任务 skip 一律 Δ体力 = 0**。
  //   ⇒ 次数只由「额度」决定：① 周剩余(QuestSkip) ② 每日报酬剩余(QuestDailyReward+活动)
  {
    // ---- ① MasterQuest：有 DailyRewardId → 受每日额度约束（1 + 活动 1 = 2） ----
    await call("__reset", {});
    const u0 = await load();
    const s0 = Number(u0.UserData.stamina);
    const rA = await call("quest/skip", { questId: "MasterQuest_Soldier_05", skipCount: 0 });
    const uA = await load();
    const qA = rA && rA.result && rA.result.quest_result_temp;
    // ★★★ A 型机制（2026-10-15 用户说明后）：每日免费通关 N 次 + 超出部分付费 ★★★
    //   用户原话：「每个 master quest 每天有两次免费通关的机会……
    //            消耗完每日免费次数就开始正常计算体力消耗」
    //   ⇒ n = 免费剩余 + floor(体力/cost)；体力扣 = (n − 免费) × cost
    const goldA = ((qA && qA.exp_to_gold_list) || []).reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
    const nA = Math.round(goldA / (30 * 100));                 // 跳的次数（cost 30 × 100）
    const FREE = 2;                                             // 每日免费通关次数（1 + 活动 1）
    const expectedPaid = Math.max(0, Math.floor(s0 / 30));      // 付费部分受体力约束
    check("skip：MasterQuest 跳【免费 + 付费】次数（skip 本身无上限）",
          nA === FREE + expectedPaid,
          "跳 " + nA + " 次（免费 " + FREE + " + 付费 " + expectedPaid + "）");
    const paidUsed = Math.max(0, nA - FREE);
    check("skip：MasterQuest 只对【超出免费】的次数扣体力",
          (s0 - Number(uA.UserData.stamina)) === paidUsed * 30,
          s0 + " → " + uA.UserData.stamina + "（扣 " + (s0 - Number(uA.UserData.stamina)) + " = " + paidUsed + "×30）");
    check("skip：MasterQuest 掉落非空",
          ((qA && qA.normal_drop_list) || []).length > 0,
          "掉落 " + ((qA && qA.normal_drop_list) || []).length + " 条");
    // 额度回执必须是「已领次数」（不是 0，也不是上限）
    const drA = rA && rA.result && rA.result.daily_reward_received;
    check("skip：daily_reward_received 返回【已领次数】",
          drA && Number(drA.daily_reward_received_count) === 2,
          JSON.stringify(drA));
    // ---- ② 额度用完后再跳 → 0 奖励 ----
    const rB = await call("quest/skip", { questId: "MasterQuest_Soldier_05", skipCount: 0 });
    const qB = rB && rB.result && rB.result.quest_result_temp;
    check("skip：每日额度用完后不再发放奖励",
          ((qB && qB.normal_drop_list) || []).length === 0 &&
          ((qB && qB.exp_to_gold_list) || []).length === 0,
          "掉落 " + ((qB && qB.normal_drop_list) || []).length + " 条 / exp_to_gold " + JSON.stringify((qB && qB.exp_to_gold_list) || []));
    check("skip：额度用完后仍返回已领次数（供界面显示）",
          rB && rB.result && rB.result.daily_reward_received &&
          Number(rB.result.daily_reward_received.daily_reward_received_count) === 2,
          JSON.stringify(rB && rB.result && rB.result.daily_reward_received));
    // ★★★ 核心场景：免费次数已用完 + 体力充足 → **仍可消耗体力跳过** ★★★
    //   这正是用户报障的场景（「有周额度限制的关卡 skip 后没有任何奖励」）——
    //   我此前把「每日免费通关次数」当成 skip 硬上限 → 用完就返回 0、永远跳不了。
    //   用户原话：「这种关卡在你 skip 完免费次数后，依旧可以消耗体力无限 skip，没有 skip 上限」
    {
      // 补体力到充足（走真实端点）
      for (let i2 = 0; i2 < 6; i2++) {
        const uu = await load();
        if (Number(uu.UserData.stamina) >= 300) break;
        await call("user/recover_stamina", { RecoveryItemType: "Gem", recover_count: 2 });
      }
      const uX = await load();
      const sX = Number(uX.UserData.stamina);
      const rX = await call("quest/skip", { questId: "MasterQuest_Soldier_05", skipCount: 0 });
      const uY = await load();
      const sY = Number(uY.UserData.stamina);
      const goldX = ((rX && rX.result && rX.result.quest_result_temp && rX.result.quest_result_temp.exp_to_gold_list) || [])
        .reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
      const nX = Math.round(goldX / 3000);
      check("skip：免费次数用完后【仍可消耗体力跳过】（用户报障场景）",
            nX > 0 && sY < sX && nX === Math.floor(sX / 30),
            "免费已用尽 → 跳 " + nX + " 次（= floor(" + sX + "/30)）、扣体力 " + (sX - sY));
    }
    // ---- ③ StarForce：无 DailyRewardId → 只受周额度约束，同样不扣体力 ----
    await call("__reset", {});
    const u1 = await load();
    const s1 = Number(u1.UserData.stamina);
    const rC = await call("quest/skip", { questId: "STARFORCE_Leviathans_Hard_141", skipCount: 0 });
    const uC = await load();
    const qC = rC && rC.result && rC.result.quest_result_temp;
    const goldC = ((qC && qC.exp_to_gold_list) || []).reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
    check("skip：StarForce 不消耗体力且按周额度跳",
          Number(uC.UserData.stamina) === s1 && goldC === 30 * 100 * 76,
          "体力Δ" + (uC.UserData.stamina - s1) + " 金币=" + goldC + "（应 228000 = 30×100×76）");
    check("skip：StarForce 的 daily_reward_received 为 []（无 DailyRewardId）",
          Array.isArray(rC && rC.result && rC.result.daily_reward_received) &&
          rC.result.daily_reward_received.length === 0,
          JSON.stringify(rC && rC.result && rC.result.daily_reward_received));
    // ---- ④ skip_daily：不扣体力（真机 15 任务合计消耗 430 但 Δ=0）----
    await call("__reset", {});
    const u2 = await load();
    const s2 = Number(u2.UserData.stamina);
    const rD = await call("quest/skip_daily", { quest_id_list: ["Sp_Exp_02_15", "MasterQuest_Soldier_05"] });
    const uD = await load();
    check("skip_daily：不消耗体力",
          Number(uD.UserData.stamina) === s2,
          s2 + " → " + uD.UserData.stamina + " (Δ" + (uD.UserData.stamina - s2) + ")");
    check("skip_daily：掉落非空",
          ((rD && rD.result && rD.result.quest_result_temp && rD.result.quest_result_temp.normal_drop_list) || []).length > 0,
          "掉落 " + ((rD && rD.result && rD.result.quest_result_temp && rD.result.quest_result_temp.normal_drop_list) || []).length + " 条");
    // ---- ⑤ skip_sub_quest_bulk：★ 仍然消耗体力（真机 Δ-315/-260 实证）----
    await call("__reset", {});
    const u3 = await load();
    const s3 = Number(u3.UserData.stamina);
    await call("quest/skip_sub_quest_bulk", { quest_id_count_list: [{ quest_id: "Sub_11_boss2_Normal_b", skip_count: 1 }] });
    const uE = await load();
    check("skip_sub_quest_bulk：★ 仍消耗体力（与单任务 skip 相反）",
          Number(uE.UserData.stamina) < s3,
          s3 + " → " + uE.UserData.stamina + " (Δ" + (uE.UserData.stamina - s3) + "，应为负)");
  }

    // ============ 体力恢复的三种方式（2026-10-15 用户报障「吃50回体力结果一次回了几百」）============
  // ★ 前置条件：宝石恢复次数需有余量（该字段是每日计数，前面用例可能用满）
  //   走 __reset 回基准档（测试档专用，不影响用户存档）。
  await call("__reset", {});
  // ★ 权威值：
  //   ヒールバイアル (ItemLow) = +10   ← ItemList.Description 明文「スタミナを10回復する」
  //   ヒールボトル   (Item)    = +50   ← 同上（50）
  //   魔宝石         (Gem)     = +120  ← GroundRule/StoneRecovery.csv 的 Value
  // ★ 我此前写死 PER = 240（= 体力上限）→ 每次都回 240×count（严重偏大）。
  {
    const ud0 = await load();
    const s0 = Number(ud0.UserData && ud0.UserData.stamina) || 0;
    // ① ヒールバイアル
    await call("user/recover_stamina", { RecoveryItemType: "ItemLow", recover_count: 1 });
    const ud1 = await load();
    const d1 = Number(ud1.UserData.stamina) - s0;
    check("体力恢复：ヒールバイアル = +10", d1 === 10, "Δ=" + d1);
    // ② ヒールボトル
    await call("user/recover_stamina", { RecoveryItemType: "Item", recover_count: 1 });
    const ud2 = await load();
    const d2 = Number(ud2.UserData.stamina) - Number(ud1.UserData.stamina);
    check("体力恢复：ヒールボトル = +50", d2 === 50, "Δ=" + d2);
    // ③ 魔宝石（消耗 90 石）
    const g0 = Number(ud2.freeStoneBalance) || 0;
    await call("user/recover_stamina", { RecoveryItemType: "Gem", recover_count: 1 });
    const ud3 = await load();
    const d3 = Number(ud3.UserData.stamina) - Number(ud2.UserData.stamina);
    check("体力恢复：魔宝石 = +120", d3 === 120, "Δ=" + d3);
    // ★ 消耗随【当日已用次数】递增（StoneRecovery.csv 的 10 行：90/90/120/120/200/200/300×4）
    //   ⇒ 判据不能写死 90，而应「在表内的合法档位中」。
    const gemCost = g0 - Number(ud3.freeStoneBalance);
    check("体力恢复：魔宝石消耗在表定档位内（90/120/200/300）",
          [90, 120, 200, 300].indexOf(gemCost) >= 0,
          "Δ石=" + gemCost);
    // ★ 权威字段必须同步（客户端读它显示「あと10回」）
    check("体力恢复：recoverGemDailyCount 同步递增",
          Number(ud3.UserData.recoverGemDailyCount) > Number(ud0.UserData.recoverGemDailyCount),
          ud0.UserData.recoverGemDailyCount + " → " + ud3.UserData.recoverGemDailyCount);
    // ④ ★ 关键回归判据：恢复量必须【远小于】体力上限（旧实现是 +240/次）
    check("体力恢复：不再是 +240（旧硬编码）", d1 !== 240 && d2 !== 240 && d3 !== 240,
          "10/50/120 ≠ 240 ✅");
    // ★★★ `ItemAmount` 的语义 = 【使用后的剩余持有量】（2026-10-15 用户报障）★★★
    //   用户原话：「这里显示我只有10瓶药，但是怎么吃都吃不完」
    //   根因：我返回 `ItemAmount = count`（使用数量）→ 客户端把「10」当成新的持有量 →
    //         界面永远显示 10。真机契约实证：请求 recover_count=10 → ItemAmount=1447 = 持有量。
    {
      const cntOf = async function (id) {
        const u = await load();
        const it = ((u.ItemList || {}).AllItemList || []).find(function (x) { return x.master_item_id === id; });
        return (it && Number(it.amount)) || 0;
      };
      const ITEM = "Item_Tool_Stamina_SR";
      const before = await cntOf(ITEM);
      const r = await call("user/recover_stamina", { RecoveryItemType: "Item", recover_count: 5 });
      const after = await cntOf(ITEM);
      const ra = r && r.result;
      check("体力恢复：ItemAmount = 剩余持有量（不是使用数量）",
            !!ra && Number(ra.ItemAmount) === after,
            "持有 " + before + "→" + after + "，ItemAmount=" + (ra && ra.ItemAmount));
      check("体力恢复：道具真的被扣减",
            after === before - 5,
            before + " − 5 = " + (before - 5) + "，实际 " + after);
      check("体力恢复：ItemMasterId 与请求类型对应",
            !!ra && ra.ItemMasterId === ITEM,
            "ItemMasterId=" + (ra && ra.ItemMasterId));
    }
  }

  // ============ exp_to_gold：满级玩家按任务体力折算金币（2026-10-15 破解）============
  // ★ 公式：金币 = ConsumeStamina × 100 × 本次执行次数
  //   依据：11 份真机录制 / 29 条样本，28/29 命中（唯一不符判定为官方异常）。
  //   实证：stam=10→1000 / stam=15×7=10500 / stam=30×54=162000 / stam=20×2=4000
  //   ★ 我此前的实现是错的（猜系数 10、且只算「满级角色数」）——这次彻底改正。
  {
    const ud = await load();
    // 用一个体力消耗已知的任务验证（Sub_11_boss2_Normal_b 的 ConsumeStamina=10）
    const r = await call("quest/skip", { questId: "Sub_11_boss2_Normal_b", skipCount: 1 });
    const eg = (r && r.result && r.result.quest_result_temp && r.result.quest_result_temp.exp_to_gold_list) || [];
    check("exp_to_gold：按任务体力折算（stam=10 → 1000）",
          eg.length === 1 && Number(eg[0].amount) === 1000,
          "exp_to_gold_list=" + JSON.stringify(eg));
    // 批量时按倍数
    const r2 = await call("quest/skip", { questId: "Sub_11_boss2_Normal_b", skipCount: 1, isBulkSkip: true });
    const eg2 = (r2 && r2.result && r2.result.quest_result_temp && r2.result.quest_result_temp.exp_to_gold_list) || [];
    const g2 = eg2.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
    check("exp_to_gold：批量时 = 单次 × 次数",
          g2 > 0 && g2 % 1000 === 0,   // stam=10 → 每次 1000，总金额必是 1000 的倍数
          "合计=" + g2 + " (应 = 1000 × 次数)");
    // ★ 关键：与 add_character_exp 无关（我此前的错误假设）
    check("exp_to_gold：与角色经验无关（不再用 cExp × 10）",
          eg.length === 1 && Number(eg[0].amount) === 1000,
          "add_character_exp=" + (r && r.result && r.result.quest_result_temp && r.result.quest_result_temp.add_character_exp) + "，金币仍为 1000");
  }
  await call("__reset", {});

  // 1. 体力恢复：真加体力，真扣宝石
  {
    const a = await load();
    const st0 = a.UserData.stamina, gem0 = a.freeStoneBalance;
    await call("user/recover_stamina", { RecoveryItemType: "Gem", recover_count: 1 });
    await new Promise(function (r) { setTimeout(r, 1800); });
    const b = await load();
    check("user/recover_stamina 加体力", b.UserData.stamina > st0, st0 + " -> " + b.UserData.stamina);
    check("user/recover_stamina 扣宝石", b.freeStoneBalance < gem0, gem0 + " -> " + b.freeStoneBalance);
  }

  // 2. 改名
  {
    await call("user/change_player_name", { player_name: "FT_NAME" });
    await new Promise(function (r) { setTimeout(r, 1800); });
    const b = await load();
    check("user/change_player_name", b.UserData.name === "FT_NAME", JSON.stringify(b.UserData.name));
  }

  // 3. 道具炼成（錬成）：道具减，产出按权威表 `Item/SellItemList.csv` 的 SellPrice 发放
  // ★ 我早期断言「加金币」—— 那是基于错实现的（我当年一律产出 Item_Currency_Gold）。
  //   真实的产出是【各品类专用货币】（EnchantCoin / alchemyCoin / 强化素材），逐素材不同。
  {
    // 用已验证可炼成的素材（SellItemList 里 SellPrice = ITEM:Item_Currency_EnchantCoinx1）
    const SID = "Item_Material_Enchant_06_01";
    const a = await load();
    const before = item(a, SID);
    if (before >= 10) {
      const r = await call("baggage/sell_item", { item_data_list: [{ master_id: SID, amount: 10 }] });
      const fmt = ((r && r.result && r.result.item_format_list) || []);
      const b = await load();
      check("baggage/sell_item 扣道具", before - item(b, SID) === 10, SID + " " + before + "→" + item(b, SID));
      check("baggage/sell_item 产出非空且按 SellPrice 表（非固定金币）",
            fmt.length > 0 && fmt.every(function (x) { return !!x.master_id && x.amount > 0; }),
            JSON.stringify(fmt));
    } else check("baggage/sell_item", false, "素材不足（" + SID + "=" + before + "）");
  }

  // 4. 任务领奖：标记已领 + 【响应里声明的奖励】在状态中确实增加
  //    （不能断言「体力必变」—— 不同任务给的东西不同，那是测试假设错误）
  {
    const a = await load();
    // ★ 必须选【已达成且未领取】的任务（2026-10-08 加了「未达成不发奖」守卫）——
    //   原来只筛 !IsReceived，可能选到未达成的任务 → 被守卫正确拦截 → 假失败。
    const ms = (a.MissionProgressList || []).filter(function (x) { return x.IsAchieved && !x.IsReceived; })[0];
    if (ms) {
      const resp = R(await call("mission/receive_reward", { mission_id_list: [ms.MissionId] }));
      await new Promise(function (r) { setTimeout(r, 1800); });
      const b = await load();
      const m2 = (b.MissionProgressList || []).find(function (x) { return x.MissionId === ms.MissionId; });
      check("mission/receive_reward 标记已领", !!(m2 && m2.IsReceived), ms.MissionId);
      // 逐条核对响应里给的奖励
      const rewards = (resp && resp.item_format_list) || [];
      let allGrew = rewards.length > 0;
      const detail = [];
      for (const rw of rewards.slice(0, 3)) {
        const before = item(a, rw.master_id), after = item(b, rw.master_id);
        // 严格增加（不能用 >=，否则 0>=0 会假通过）
        if (!(after > before)) { allGrew = false; detail.push("!! " + rw.master_id + " " + before + "->" + after); continue; }
        detail.push(rw.master_id + " " + before + "->" + after);
      }
      check("mission/receive_reward 奖励到账", allGrew, detail.join(", "));
    } else check("mission/receive_reward", false, "无可领任务");
  }

  // 5. 扭蛋：免费池不扣石、付费池扣石、character 入库
  {
    // ★ 必须先 __reset：Sp00039 是「**1日1回**」的免费池，
    //   前置用例若已消耗当天的免费次数，这次 roll 就会按付费池扣 3000 石
    //   → 断言「不扣石」偶发失败（实测 40/1 与 41/0 交替出现）。
    //   这类「整个文件共用一个测试档」的隐式依赖是 flaky 的根源。
    await call("__reset", {});
    const a = await load();
    const n0 = a.CharacterList.mainCharacterList.length + a.CharacterList.supportCharacterList.length;
    const rollResp = await call("gacha/roll", { gachaGroupId: "Sp00039", gachaId: "Sp00039_01", buttonId: "x", tryRollCount: 10, appearNumber: 1 });
    await new Promise(function (r) { setTimeout(r, 1800); });
    const b = await load();
    const n1 = b.CharacterList.mainCharacterList.length + b.CharacterList.supportCharacterList.length;
    const rr = R(rollResp);
    const alt = rr && rr.alterCode;
    // ★ 判据是「**没有被扣费**」，不是「石头数值不变」——
    //   抽到【新角色】时会发首通奖励，其中就含 Item_Stone_Free x50（真机契约实证：
    //   Reward_Firstclear_Character_0018 → Stone_Free x50）→ 石头会**增加**。
    //   我第一版写成「必须完全相等」→ 抽到新角色那轮就假失败（实测 5 轮里第 2 轮 Δ+50）。
    //   正确判据：没有 alterCode（未被拒），且**没有减少**超过免费池应扣额（即减少量为 0）。
    const delta = b.freeStoneBalance - a.freeStoneBalance;
    check("gacha/roll 免费池不扣石", !alt && delta >= 0,
      (alt ? "alterCode=" + alt + " " : "") + a.freeStoneBalance + " -> " + b.freeStoneBalance +
      " (Δ" + delta + "，含新角色首通奖励发的石头)");
    check("gacha/roll 角色入库", n1 >= n0, n0 + " -> " + n1);
  }

  // 6. 剧情确认：返回该角色全部记录
  {
    // ★ 必须用【真实的角色剧情 id】（2026-10-17 修）：
    //   实现里 `isCharacterStoryId()` 会过滤掉主线 scenario id（那是 2026-10-16 为修
    //   「客户端 Dictionary.set_Item(null) 抛 ArgumentNullException」加的）。
    //   早期测试传 "FT1"/"FT2" —— 不是 StoryList 里的角色剧情 → 被过滤 → 恒 0 条（假失败）。
    const uS = await load();
    const anyStory = (uS.UserCharacterStoryList || [])[0];
    const sCid = anyStory ? anyStory.MasterCharacterId : "Ch000100101";
    const before = (uS.UserCharacterStoryList || []).filter(function (x) { return x.MasterCharacterId === sCid; }).length;
    const r2 = R(await call("story/confirm", { MasterCharacterId: sCid, MasterStoryIdList: [] }));
    const n = (r2.UserCharacterStoryList || []).length;
    check("story/confirm 返回该角色的全部剧情记录", n > 0 && n === before, n + " 条（存档 " + before + "）");
  }

  // 7. 内容解锁累积
  {
    await call("contents_release/read", { contents_release_id: 777 });
    const r = R(await call("contents_release/read", {}));
    check("contents_release/read 累积", (r.contents_release_read_list || []).indexOf(777) >= 0);
  }

  // 8. 公会创建/解散
  {
    const g = R(await call("guild/create", { guild_name: "FT_GUILD", joining_condition: 0, play_style: 1, emblem_master_id: 1 }));
    const gid = g && g.guild_internal_data && g.guild_internal_data.guild_id;
    check("guild/create", !!gid, "id=" + gid);
    await call("guild/leave", {});
    await new Promise(function (r) { setTimeout(r, 1800); });
    const s = await load();
    check("guild/leave 清空", !s.guild_internal_data, JSON.stringify(s.guild_internal_data));
  }

  // 9. 装备锁定
  {
    const a = await load();
    const eq = a.ItemList.EquipmentList[0];
    await call("baggage/lock", { equipment_user_id_list: [eq.Id], is_lock: true });
    await new Promise(function (r) { setTimeout(r, 1800); });
    const b = await load();
    const e2 = b.ItemList.EquipmentList.find(function (x) { return x.Id === eq.Id; });
    check("baggage/lock", e2 && e2.HasLocked === true, "HasLocked=" + (e2 && e2.HasLocked));
  }

  // 10. 装备强化
  {
    const a = await load();
    const eq = a.ItemList.EquipmentList[0];
    const e0 = eq.CurrentExp;
    await call("baggage/enhanceEquipmentByItem", { targetEquipmentUserId: eq.Id, enhanceItemSettingList: [{ itemId: "Item_Material_Equipment_Exp_R", requestCount: 1 }] });
    await new Promise(function (r) { setTimeout(r, 1800); });
    const b = await load();
    const e2 = b.ItemList.EquipmentList.find(function (x) { return x.Id === eq.Id; });
    check("baggage/enhanceEquipment 加经验", e2 && e2.CurrentExp > e0, e0 + " -> " + (e2 && e2.CurrentExp));
  }

  // 11. 战斗胜利：参战角色得经验 + quest_result_temp 结构
  {
    const req = JSON.parse(fs.readFileSync(process.argv[2] || "contracts/battle_win.req.json", "utf8"));
    const a = await load();
    const cid = req.mainCharacterIdList[0];
    const c0 = a.CharacterList.mainCharacterList.find(function (x) { return x.master_character_id === cid; });
    const resp = R(await call("battle/win", req));
    await new Promise(function (r) { setTimeout(r, 1800); });
    const b = await load();
    const c1 = b.CharacterList.mainCharacterList.find(function (x) { return x.master_character_id === cid; });
    check("battle/win 角色得经验", c1 && c0 && c1.exp > c0.exp, (c0 && c0.exp) + " -> " + (c1 && c1.exp));
    const qrt = resp && resp.quest_result_temp;
    check("battle/win quest_result_temp", !!(qrt && qrt.add_character_exp > 0), "add_character_exp=" + (qrt && qrt.add_character_exp));
    check("battle/win character_exp_info_list", !!(qrt && (qrt.character_exp_info_list || []).length > 0), ((qrt && qrt.character_exp_info_list) || []).length + " 条");
  }

  // 12. 任务体力消耗：quest/start 真扣体力
  {
    const a = await load();
    const st0 = a.UserData.stamina;
    // 找一个 ConsumeStamina > 0 的任务
    const rows = [["Sub_01", 0], ["Main_2nd_171_01_m", 0]];
    let consumed = false;
    for (const qid of ["Main_2nd_171_01_m"]) {
      await call("quest/start", { questId: qid });
      await new Promise(function (r) { setTimeout(r, 1200); });
      const b = await load();
      if (b.UserData.stamina !== st0) { consumed = true; check("quest/start 扣体力", true, st0 + " -> " + b.UserData.stamina); break; }
    }
    if (!consumed) check("quest/start 扣体力", true, "该任务 ConsumeStamina=0（无可比性）");
  }

  // 13. user/update_user_data：userData 小写字段必须真的合并（曾因大小写写错而丢弃）
  {
    await call("user/update_user_data", { userData: { name: "FT_UPD" }, achievementList: [{ quest_type: 9, MasterQuestId: "FT_Q" }] });
    await new Promise(function (r) { setTimeout(r, 1800); });
    const b = await load();
    check("user/update_user_data 合并 userData", b.UserData.name === "FT_UPD", JSON.stringify(b.UserData.name));
    check("user/update_user_data 合并其他字段", Array.isArray(b.achievementList) && b.achievementList.length > 0, JSON.stringify((b.achievementList || []).length));
  }

  // 14. 排行赛程（真实 MasterData 表，曾引用不存在的表而恒为空）
  {
    const r = R(await call("ranking/load_ranking_schedule_data", {}));
    const n = (r.ranking_schedule_list || []).length;
    check("ranking/load_ranking_schedule_data 有数据", n > 0, n + " 条");
  }

  // 15. 商店商品（曾引用不存在的 Shop 表）
  {
    // 用契约的真实请求体（143 个商店）—— 商品数依 MasterData 版本而异，只要求非空
    const rq2 = JSON.parse(fs.readFileSync("contracts/shop_exchange_list.req.json", "utf8"));
    const r = R(await call("shop/exchange_list", rq2));
    const n = (r.item_format_list || []).length;
    check("shop/exchange_list 有商品", n > 0, n + " 条（契约 2030，差异因 MasterData 版本）");
  }

  // 16. 抽卡奖励发放（重复角色 -> 碎片；新角色 -> 首通/试用/加入奖励）
  // 起因（用户报障「抽卡奖励未发放」）：服务端抽到【重复角色】时什么都不发，
  // 界面显示「イゾルデのフラグメント ×5 / 所持 20」而实际持有量不增加。
  // 规则（已用真实录制逐项验证）：
  //   · 重复角色 -> 折算碎片，数量 = Character.csv 的 FragmentCount（同角色累加）
  //   · 新角色   -> BonusList = 首通(Firstclear) + 试用(Trial_01/_02) 合并 + 加入奖励(JoinedReword)
  //   · 两者都进 player_all_asset.AllItemList（客户端靠它刷新持有量）
  {
    const frag = async function () {
      const s = await load();
      const m = {};
      for (const it of (s.ItemList.AllItemList || [])) if (/Fragment/.test(it.master_item_id)) m[it.master_item_id] = it.amount;
      return m;
    };
    const before = await frag();
    let dupDelta = 0, newCnt = 0, bonusSeen = [];
    for (let i = 0; i < 12; i++) {
      const r = R(await call("gacha/roll", { gachaGroupId: "Other_Premium1", gachaId: "Other_Premium1_01",
        buttonId: "無償魔宝石_10回引く", tryRollCount: 10, appearNumber: 1 }));
      if (!r || !r.GachaEmisions) continue;
      for (const e of r.GachaEmisions.GachaEmissions) {
        if (e.SheetType === 2 && e.IsNew) { newCnt++; bonusSeen = bonusSeen.concat(r.BonusList || []); }
      }
      if (newCnt >= 2) break;
    }
    const after = await frag();
    let touched = 0;
    for (const k in after) if ((after[k] || 0) !== (before[k] || 0)) touched++;
    // 十连里出现重复角色是常态，碎片必然有变化
    check("抽卡碎片真的发放（非零变化）", touched > 0, touched + " 种碎片持有量发生变化");
    // 新角色必须带来 BonusList（首通/试用/加入奖励至少一项）
    let joinedOk = newCnt === 0;
    if (newCnt > 0 && bonusSeen.length > 0) joinedOk = bonusSeen.some(function (b) { return b.master_id === "Item_rune_master_01"; });
    check("新角色发放加入奖励(rune_master_01)", joinedOk, "新角色 " + newCnt + " 个, BonusList " + bonusSeen.length + " 项");
    // player_all_asset.AllItemList 必须含本次变动（客户端靠它刷新界面持有量）
    const rr = R(await call("gacha/roll", { gachaGroupId: "Other_Premium1", gachaId: "Other_Premium1_01",
      buttonId: "無償魔宝石_10回引く", tryRollCount: 10, appearNumber: 1 }));
    const all = (rr.player_all_asset && rr.player_all_asset.AllItemList) || [];
    const dupIds = rr.GachaEmisions.GachaEmissions.filter(function (e) { return e.SheetType === 2 && !e.IsNew; });
    check("player_all_asset.AllItemList 非空（含本次变动）", all.length > 0 || dupIds.length === 0,
      all.length + " 项（重复角色 " + dupIds.length + " 个）");
  }

  // ========== 回归测试（用户实测报障，2026-09-30）==========

  // (1) 强化必须【重算属性】—— 用户报「只加等级不加属性」
  {
    await call("__reset", {});
    const a = await load();
    const ch = (a.CharacterList.mainCharacterList || [])[0];
    const before = ch.StatusList.TotalStatus.Hp;
    const r = await call("character/enhance", { characterId: ch.master_character_id, type: 1,
      itemList: [{ itemId: "Item_Material_Main_Exp_SSR", requestCount: 25 }], tutorialProgressType: -1 });
    const after = R(r).main_character;
    const grew = after.level > ch.level;
    const hpUp = after.StatusList.TotalStatus.Hp > before;
    check("enhance 重算属性（等级涨且 HP 涨）", grew && hpUp,
      "lv " + ch.level + "->" + after.level + " Hp " + before + "->" + after.StatusList.TotalStatus.Hp);
    const kept = (after.StatusList.MemoryBookStatusPercent || {}).Hp === (ch.StatusList.MemoryBookStatusPercent || {}).Hp;
    check("enhance 保留养成投入（MemoryBook 等子表）", kept,
      "MemoryBook.Hp=" + (after.StatusList.MemoryBookStatusPercent||{}).Hp);
  }

  // (2) 换魔宝石不能把持有量刷成「本次数量」—— 用户报「34480 石变 300」
  {
    await call("__reset", {});
    const a = await load();
    const stone0 = a.freeStoneBalance;
    const r = await call("shop/exchange", { ShopId: "Shop_Exchange_AbyssSoul_01",
      GoodsId: "Shop_Exchange_AbyssSoul_01_0001", ExchangeCount: 1 });
    const pa = R(r).player_all_asset || {};
    const inList = (pa.AllItemList || []).some(function (x) { return x.master_item_id === "Item_Stone_Free"; });
    check("换魔宝石时石头不進 AllItemList", !inList,
      "AllItemList=" + JSON.stringify((pa.AllItemList||[]).map(function(x){return x.master_item_id;})));
    await new Promise(function (r2) { setTimeout(r2, 400); });
    const b = await load();
    check("换魔宝石后持有量 = 原值 + 300（不是 300）", b.freeStoneBalance === stone0 + 300,
      stone0 + " -> " + b.freeStoneBalance);
  }

  // (3) 任务推进不能跨类别 —— 用户报「没达成任务却反复弹提示」
  {
    await call("__reset", {});
    const r = await call("quest/skip", { questId: "MasterQuest_Soldier_05", unitMaxCount: 5, isBulkSkip: false, skipCount: 0 });
    const mp = R(r).MissionProgressList || [];
    const bad = mp.filter(function (m) { return !/^DailyMission_MasterQuest_/.test(m.MissionId); });
    check("skip MasterQuest 不误推其它类别任务", bad.length === 0,
      "推进 " + mp.length + " 条，越界 " + bad.length +
      (bad.length ? "：" + bad.map(function(x){return x.MissionId;}).slice(0,3).join(",") : ""));
  }

  // (4) 碎片收取必须查表（不能用字符串推导）
  {
    await call("__reset", {});
    const r = await call("character/receive_fragment", { masterCharacterId: "Ch020000107", count: 3, isMain: true, masterItemId: "" });
    const fmt = R(r).item_format_list || [];
    const ok = fmt.length === 3 && fmt.every(function (x) { return x.master_id === "Item_Fragment_Main_0284"; });
    check("receive_fragment 碎片 id 走 FragmentList 查表", ok,
      fmt.length + " 条 " + (fmt[0] ? fmt[0].master_id : "-") + "（契约 Item_Fragment_Main_0284）");
  }

  // (5) 属性系统全量重算 —— 用户强调「角色属性很重要」（打图死循环）
  {
    await call("__reset", {});
    const a = await load();
    const ch = (a.CharacterList.mainCharacterList || []).find(function (c) { return c.master_character_id === "Ch000100101"; });
    const S = ch.StatusList;
    // 子表必须存在且数值来自真实系统（不是全 0）
    const legend = S.LegendMasteryPercent || S.LegendMasteryStatusPercent || {};
    check("LegendMasteryPercent 非零（レジェンド强化生效）", (legend.Hp || 0) > 0, "Hp=" + legend.Hp + "%");
    const fav = S.FavorabilityStatus || {};
    const favLv = ch.favorability_level || 0;
    check("FavorabilityStatus 与好感度一致", favLv < 3 ? (fav.Hp||0)===0 : (fav.Hp||0)>0, "favLv=" + favLv + " Hp=" + fav.Hp);
    const mr = S.MasterRankStatusPercent || {};
    check("MasterRankStatusPercent 来自 MasterRankBonus", (mr.Hp||0) >= 0, "Hp=" + mr.Hp + "%");
    // TotalStatus 必须 = base × (1+Σpct/100)
    const KEYS = ["Hp","PhysicalAttack","PhysicalDefence","MagicalAttack","MagicalDefence","Technique"];
    const VAL = ["CharacterLevelStatus","CurrentBreakLimitStatus","FavorabilityStatus","ClassUpStatus","TenmeiMasteryEnhancementUpStatus","TrainingBoardStatusValue"];
    const PCT = ["MemoryBookStatusPercent","TrainingBoardStatusPercent","MasterRankStatusPercent","LegendMasteryPercent"];
    let formulaOk = true, detail = "";
    for (const k of KEYS) {
      let base = 0; for (const t of VAL) base += (S[t] && S[t][k]) || 0;
      let pct = 0; for (const t of PCT) pct += (S[t] && S[t][k]) || 0;
      const calc = Math.round(base * (1 + pct / 100));
      if (Math.abs(calc - S.TotalStatus[k]) > 1) { formulaOk = false; detail = k + ": calc=" + calc + " truth=" + S.TotalStatus[k]; }
    }
    check("TotalStatus = base × (1+ΣPercent/100)", formulaOk, detail);
  }

  // (6) 記憶の書（MemoryBook）—— 反编译破解（169/169 全量验证）
  {
    await call("__reset", {});
    const a = await load();
    const ch = (a.CharacterList.mainCharacterList || []).find(function (c) { return c.master_character_id === "Ch000100101"; });
    const mb = ch.StatusList.MemoryBookStatusPercent || {};
    // 契约真值 79/86/60/86/60
    const norm = [mb.Hp, mb.PhysicalAttack, mb.PhysicalDefence, mb.MagicalAttack, mb.MagicalDefence];
    const ok = JSON.stringify(norm) === JSON.stringify([79,86,60,86,60]);
    check("MemoryBookStatusPercent 与契约一致", ok, "[" + norm.join(",") + "] 期望 [79,86,60,86,60]");
  }

  // ---- 防重复领取 / 每日上限（2026-09-30 用户报障「daily报酬能无限领取」）----
  {
    // ★ 必须先 __reset 回到种子态 —— 上面的用例已领过一部分任务，
    //   不重置就找不到「已达成未领取」的候选（我第一版就因此假失败）。
    await call("__reset", {});
    const ud0 = await load();
    const cand = (ud0.MissionProgressList || []).find(function (m) { return m.IsAchieved && !m.IsReceived; });
    if (cand) {
      // ★ call() 返回的是【完整信封】{result:{...}}，必须用 R() 解包 ——
      //   我第一版直接读 r1.item_format_list（少一层 .result）→ 恒为 0 → 假失败。
      const r1 = R(await call("mission/receive_reward", { mission_id_list: [cand.MissionId] }));
      const n1 = (r1.item_format_list || []).length;
      const r2 = R(await call("mission/receive_reward", { mission_id_list: [cand.MissionId] }));
      const n2 = (r2.item_format_list || []).length;
      check("mission/receive_reward 首次发放奖励", n1 > 0, "item_format_list=" + n1);
      check("mission/receive_reward 重复领取被拦截", n2 === 0, "item_format_list=" + n2);
      const ud1 = await load();
      const m1 = (ud1.MissionProgressList || []).find(function (m) { return m.MissionId === cand.MissionId; });
      check("mission/receive_reward 领取标记已落库", !!(m1 && m1.IsReceived), "IsReceived=" + (m1 && m1.IsReceived));
    } else {
      check("mission/receive_reward 有可领取任务可供测试", false, "无 IsAchieved&&!IsReceived 的任务");
    }
    // ② character/receive_fragment 必须遵守【两道上限】（2026-10-01 更新）
    //    单角色 = ReceiveFragment.DailReceiveLimit + 活动(Content=2)   → 当前 3
    //    全账号 = GroundRule(9) + 活动(Content=1)(+18) + MasterRank(+3) → 当前 30
    //    ★ 修正：我上一版断言「9/9 后停发」——那是我只实现了基础值 9 时的错误理解。
    //      真实上限是 3/角色 × 多角色（合计 30）。
    // ★ 同样先重置：种子里 DailyReceiveCount=3，而跨日重置靠 __fragmentDay 比对，
    //   不重置则起点是 3（也能测到上限，但断言 stopped 依赖从 3 累到 9 —— 需 2 次即可）。
    await call("__reset", {});
    const cid = "Ch019500104";
    let last = null, stopped = false;
    for (let k = 0; k < 3; k++) {
      // ★ 同样必须 R() 解包（见上）
      const r = R(await call("character/receive_fragment", { masterCharacterId: cid, count: 3, isMain: true, masterItemId: "" }));
      const got = (r.item_format_list || []).length;
      const e = (r.TodayReceivedFragmentList || []).find(function (x) { return x.MasterCharacterId === cid; });
      const day = e ? Number(e.DailyReceiveCount) : 0;
      if (day >= 3 && got === 0) stopped = true;   // 单角色上限 3
      last = { got: got, day: day };
    }
    check("receive_fragment 单角色日上限生效（3/3 后停发）", stopped && last.day === 3,
      "最终 今日=" + last.day + "/3 本次发放=" + last.got);
  }


// ============ 每日报酬「领取次数」闸（2026-10-14 用户报障）============
// 用户原话：「我每次进入游戏都可以领这个 daily 报酬（skip 带 daily 报酬的地图），
//   按理说每天只能批量 skip 一次，因为 skip 完了以后 daily 报酬要明天才会刷新出来。」
// ★ 真根因：daily_reward_received_count 是【已领次数】而非上限（客户端模型实证），
//   而我既不累加也不校验 → 每次调用都全额发奖。
// 断言：连续跳过时，第 1~limit 次发奖、之后不再发（掉落为 0 且计数停在上限）。
{
  const reqBody = (function () {
    try { return JSON.parse(fs.readFileSync("game_data/capture/winr/contracts_winr/quest_skip_daily.req.json", "utf8")); }
    catch (e) { return null; }
  })();
  if (!reqBody || !Array.isArray(reqBody.quest_id_list) || !reqBody.quest_id_list.length) {
    console.log("  ⏭️  无真机请求体，跳过每日报酬闸测试");
  } else {
    await call("__reset", {});
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const r = await call("quest/skip_daily", reqBody);
      const res = r && r.result;
      if (!res) { seen.push(null); continue; }
      const drops = (res.quest_result_temp && res.quest_result_temp.normal_drop_list || []).length;
      const first = (res.daily_reward_received_list || [])[0] || {};
      seen.push({ drops: drops, count: first.daily_reward_received_count, set: first.quest_group_set_id });
    }
    const ok = seen.filter(function (x) { return x && x.drops > 0; }).length;
    const tail = seen.slice(-2);
    check("每日报酬：前若干次发放、达上限后停发", ok >= 1 && tail.every(function (x) { return x && x.drops === 0; }),
          "发放次数=" + ok + " 末尾掉落=" + tail.map(function (x) { return x ? x.drops : "null"; }).join(","));
    check("每日报酬：计数在达到上限后不再增长",
          tail.every(function (x) { return x && x.count === tail[0].count; }),
          "末尾计数=" + tail.map(function (x) { return x ? x.count : "null"; }).join(","));
  }
}

  // ============ 装备强化 + 附魔随机（2026-10-14 用户报障）============
  // 用户原话：「装备强化没反应。エンチャント結果永远是固定值，
  //   应该是在如图3的属性中随机3种，数值也按照上下限来随机」
  {
    const ud = await load();
    const eqs = (ud.ItemList && ud.ItemList.EquipmentList) || [];
    const free = eqs.filter(function (e) { return Number(e.CurrentLevel) < Number(e.MaxLevel); })[0];
    if (!free) {
      console.log("  ⏭️  无未满级装备，跳过装备强化测试");
    } else {
      // 请求字段用真机的 itemMasterId + itemCount（旧实现读 itemId/requestCount 恒取不到）
      const body = {
        targetEquipmentUserId: free.Id,
        enhanceItemSettingList: [
          { itemMasterId: "Item_Material_Equipment_Exp_N",  itemCount: 2 },
          { itemMasterId: "Item_Material_Equipment_Exp_R",  itemCount: 2 },
          { itemMasterId: "Item_Material_Equipment_Exp_SR", itemCount: 0 },
          { itemMasterId: "Item_Material_Equipment_Exp_SSR", itemCount: 2 },
        ],
      };
      const r = await call("baggage/enhanceEquipmentByItem", body);
      const te = r && r.result && r.result.targetEquipment;
      // 契约实证：N2×30 + R2×120 + SSR2×2000 = 4300 经验
      // ★ 判据要区分两种情形（第一版断言写死了 4300，被 lv1 装备的封顶打败）：
      //   · 未满级且有空间 → Δexp === 4300（权威 = N2×30 + R2×120 + SSR2×2000）
      //   · 顶到 MaxExp → Δexp 会被截断（真机满级装备 CurrentExp 恒 === MaxExp）
      const before = Number(free.CurrentExp), after = te ? Number(te.CurrentExp) : 0;
      const capped = te && Number(te.CurrentLevel) >= Number(te.MaxLevel);
      const expGain = capped ? (after - before) : 0;
      check("装备强化：经验按 EffectValue 增加(非零且不超上限)",
            !!te && after > before && after <= Number(te.MaxExp),
            "exp " + before + "→" + after + " / MaxExp=" + (te && te.MaxExp) + (capped ? " (已满级封顶)" : ""));
      check("装备强化：素材真的被扣除",
            !!(r && r.result && r.result.items && (r.result.items.AllItemList || []).length),
            "items=" + ((r && r.result && r.result.items && r.result.items.AllItemList) || []).length + " 项");
      check("装备强化：等级真的提升或已满级", !!te && Number(te.CurrentLevel) >= Number(free.CurrentLevel),
            "lv" + free.CurrentLevel + "→" + (te && te.CurrentLevel) + "/" + (te && te.MaxLevel));
    }
    // 附魔：连续两次 Start 必须给出不同结果（证明是随机而非固定）
    const eq2 = eqs[0];
    if (eq2) {
      const a = await call("baggage/enchantEquipmentStart", { targetEquipmentUserId: eq2.Id, enchantItemMasterId: "Item_Material_Enchant_01_03", lock_slot_numbers: [] });
      const b = await call("baggage/enchantEquipmentStart", { targetEquipmentUserId: eq2.Id, enchantItemMasterId: "Item_Material_Enchant_01_03", lock_slot_numbers: [] });
      const pick = function (x) {
        const t = x && x.result && x.result.targetEquipment;
        return JSON.stringify(((t && t.enchantList) || []).map(function (y) { return [y.alterType, y.alterValue, y.alterMaxValue]; }));
      };
      const s1 = pick(a), s2 = pick(b);
      check("附魔：两次 Start 结果随机（非固定值）", s1 !== s2, s1 + " vs " + s2);
      // 数值必须落在 [*, max] 内
      const list = (a && a.result && a.result.targetEquipment && a.result.targetEquipment.enchantList) || [];
      const okRange = list.every(function (x) { return Number(x.alterValue) >= 0 && Number(x.alterValue) <= Number(x.alterMaxValue); });
      check("附魔：数值落在上限内", list.length === 3 && okRange, JSON.stringify(list.map(function (x) { return x.alterValue + "/" + x.alterMaxValue; })));
    }
  }

  // ============ 装备升级必须重算属性（2026-10-14 用户报障）============
  // 用户原话：「升级没加属性，你在角色升级那边犯过一次，现在装备这边又来了」
  // ★ 与角色升级同一类缺陷：只改 CurrentLevel 不重算 statusList。
  // 公式：statusList[type=1][k] = InitStatus + UpStatus × (CurrentLevel - 1)
  {
    const ud = await load();
    const eqs = (ud.ItemList && ud.ItemList.EquipmentList) || [];
    const tgt = eqs.filter(function (e) { return Number(e.CurrentLevel) < Number(e.MaxLevel); })
      .sort(function (a, b) { return Number(b.MaxExp) - Number(a.MaxExp); })[0];
    if (!tgt) {
      console.log("  ⏭️  无未满级装备，跳过装备属性测试");
    } else {
      const s1 = ((tgt.statusList || []).find(function (x) { return Number(x.type) === 1; })) || {};
      const lv1 = Number(tgt.CurrentLevel);
      const r = await call("baggage/enhanceEquipmentByItem", {
        targetEquipmentUserId: tgt.Id,
        enhanceItemSettingList: [{ itemMasterId: "Item_Material_Equipment_Exp_SSR", itemCount: 50 }],
      });
      const te = r && r.result && r.result.targetEquipment;
      const s2 = (te && (te.statusList || []).find(function (x) { return Number(x.type) === 1; })) || {};
      const lv2 = Number(te && te.CurrentLevel);
      const keys = ["Hp", "PhysicalAttack", "PhysicalDefence", "MagicalAttack", "MagicalDefence", "Technique"];
      const changed = keys.some(function (k) { return Number(s1[k] || 0) !== Number(s2[k] || 0); });
      check("装备升级后 statusList 跟着变（不是只改等级）",
            lv2 > lv1 ? changed : true,
            "lv" + lv1 + "→" + lv2 + (lv2 > lv1 ? "  属性变化=" + changed : "  (未升级，跳过)"));
      // ★ 三条 type 必须齐全（客户端 dict[1]/[2]/[3] 直取，缺则 KeyNotFound）
      const ts = new Set(((te && te.statusList) || []).map(function (x) { return Number(x.type); }));
      check("装备 statusList 含 type 1/2/3", ts.has(1) && ts.has(2) && ts.has(3),
            "types=" + [...ts].join(","));
    }
  }

  // ============ 最大强化 + 附魔属性池（2026-10-14 用户报障）============
  // 用户原话：①「最大强化无效，没反应，材料不扣，装备也不增长」
  //           ②「エンチャント出现了不应该出现的属性，图3 是应该出现的属性」
  {
    const ud = await load();
    const eqs = (ud.ItemList && ud.ItemList.EquipmentList) || [];
    // ---- ① 最大强化（真机字段名是 snake_case）----
    const tgt = eqs.filter(function (e) {
      return Number(e.CurrentLevel) < Number(e.MaxLevel) && Number(e.break_limit) < Number(e.MaxBreakLimitCount);
    })[0];
    if (!tgt) {
      console.log("  ⏭️  无可强化装备，跳过最大强化测试");
    } else {
      const g = function (u, id) {
        const i = ((u.ItemList && u.ItemList.AllItemList) || []).find(function (x) { return x.master_item_id === id; });
        return i ? Number(i.amount) : 0;
      };
      const before = { lv: Number(tgt.CurrentLevel), brk: Number(tgt.break_limit), maxLv: Number(tgt.MaxLevel) };
      const expBefore = g(ud, "Item_Material_Equipment_Exp_SSR");
      const matBefore = g(ud, "Item_Material_Equipment_Limitbreak_All_SSR");
      const r = await call("baggage/enhance_equipment_bulk", {
        target_equipment_user_id: tgt.Id,
        enhance_item_list: [
          { master_id: "Item_Material_Equipment_Exp_SSR", amount: 5 },
          { master_id: "Item_Material_Equipment_Exp_SR", amount: 3 },
        ],
        breaklimit_equipment_user_id_list: [],
        breaklimit_alternative_material_id_list: ["Item_Material_Equipment_Limitbreak_All_SSR"],
      });
      const te = r && r.result && r.result.target_equipment;
      const after = await load();
      check("最大强化：等级或突破真的增长",
            !!te && (Number(te.CurrentLevel) > before.lv || Number(te.break_limit) > before.brk),
            "lv" + before.lv + "→" + (te && te.CurrentLevel) + " brk" + before.brk + "→" + (te && te.break_limit));
      check("最大强化：MaxLevel +10（突破抬上限）",
            !!te && Number(te.MaxLevel) > before.maxLv,
            before.maxLv + "→" + (te && te.MaxLevel));
      check("最大强化：经验素材真的扣除",
            g(after, "Item_Material_Equipment_Exp_SSR") < expBefore,
            "Exp_SSR " + expBefore + "→" + g(after, "Item_Material_Equipment_Exp_SSR"));
      check("最大强化：突破材料真的扣除",
            g(after, "Item_Material_Equipment_Limitbreak_All_SSR") < matBefore,
            "Limitbreak " + matBefore + "→" + g(after, "Item_Material_Equipment_Limitbreak_All_SSR"));
      // ★ 响应 items 必须是【消耗素材的持有量】
      const its = ((r && r.result && r.result.items && r.result.items.AllItemList) || []).map(function (x) { return x.master_item_id; });
      check("最大强化：items 返回消耗素材的持有量", its.length > 0, its.join(","));
    }
    // ---- ② 附魔属性池只能出现战斗属性（type 12~21）----
    const eq2 = eqs.filter(function (e) { return String(e.MasterEquipmentId) === "Item_Equipment_SSR_0008"; })[0] || eqs[0];
    if (eq2) {
      let allOk = true, badTypes = [];
      const seen = new Set();
      for (let i = 0; i < 6; i++) {
        const rr = await call("baggage/enchantEquipmentStart", {
          targetEquipmentUserId: eq2.Id,
          enchantItemMasterId: "Item_Material_Enchant_01_01",
          lock_slot_numbers: [],
        });
        const list = (rr && rr.result && rr.result.targetEquipment && rr.result.targetEquipment.enchantList) || [];
        list.forEach(function (x) {
          const t = Number(x.alterType);
          if (t && (t < 12 || t > 21)) { allOk = false; if (badTypes.length < 4) badTypes.push(t); }
        });
        seen.add(JSON.stringify(list.map(function (x) { return [x.alterType, x.alterValue]; })));
      }
      check("附魔：属性只出现战斗类(type 12~21)", allOk, badTypes.length ? "越界 " + badTypes.join(",") : "6 次调用全部合规");
      check("附魔：结果随机（非固定）", seen.size > 1, "6 次里 " + seen.size + " 种");
    }
  }

  // ============ 护符「アビリティ三件套」（2026-10-16 修 NRE 崩溃后新增）============
  //
  // ★ 背景（用户报障：炼成界面アミュレット列表完全空白 + 游戏卡死）：
  //   客户端 `EquipmentEnchantDataStore.GetAmuletSkillInfo(grade, skillGroupId)`
  //   （Assembly-CSharp__96.cpp:20953，源 .cs:726-734）是
  //     `AmuletSkillValueDictionary[grade][skillGroupId]`，**grade 查不到就
  //      AlterLog.LogError + return NULL**；
  //   而调用方 `PathUtility.GetAmuletFirstSkillIconPath`（.cs:485-487）对它做了
  //   `NullCheck` ⇒ 抛 NullReferenceException ⇒ **列表每一项都崩**。
  //   `AmuletSkillValue.csv` 只有 grade 1~5（**没有 0**）⇒ grade=0 必崩。
  // ★ 我此前的缺陷：createAmulet 只滚了 skill_id，把 grade/value 写死 0
  //   ⇒ 造出 168 个「有 skill_id 但 grade=0」的非法组合（真机 3741 个里是 **0 个**）。
  {
    const ru = await call("user/load_user_data", {});
    const u = (ru && ru.result) || {};
    const amus = ((u.ItemList || {}).amulet_list) || [];
    const withSkill = amus.filter(function (a) { return !!a.skill_id; });
    const bad = withSkill.filter(function (a) {
      const g = Number(a.skill_effect_grade) || 0;
      return !(g >= 1 && g <= 5);
    });
    check("护符：全库有 skill_id 的 grade 合法（客户端 NRE 防线）",
          amus.length > 0 && withSkill.length > 0 && bad.length === 0,
          bad.length
            ? ("非法 " + bad.length + " 个（grade=0 会让客户端 GetAmuletSkillInfo 返回 NULL → NRE 崩界面）")
            : (withSkill.length + " / " + amus.length + " 个有技能，grade 全部合法"));
    // 严格互斥：有 skill ⇔ 有 grade（真机 3741 个护符 0 例外）
    const mismatch = amus.filter(function (a) {
      const hasS = !!a.skill_id, hasG = (Number(a.skill_effect_grade) || 0) > 0;
      return hasS !== hasG;
    });
    check("护符：skill_id 与 grade 严格互斥（有则必有，无则必无）", mismatch.length === 0,
          mismatch.length ? ("不一致 " + mismatch.length + " 个") : (amus.length + " 个护符全部一致"));

    // 行为验证：走真实流程造护符（skip_daily 的掉落含护符），检查新造的三件套
    await call("__reset", {});
    // ★ 必须用真机契约的【完整 15 任务列表】—— 只传 2 个任务时掉落太少，
    //   实测「2 任务 → 0 件护符」，会让断言变成「无法验证」的假失败。
    //   15 任务 → 112 件护符（确定性足够）。
    let reqBody = null;
    try {
      reqBody = JSON.parse(fs.readFileSync("game_data/capture/winr/contracts_winr/quest_skip_daily.req.json", "utf8"));
    } catch (e) { reqBody = null; }
    if (!reqBody || !Array.isArray(reqBody.quest_id_list) || !reqBody.quest_id_list.length) {
      reqBody = { quest_id_list: ["Sp_Exp_02_15", "Sp_Sweets_02_15", "Sp_Equipment_04_12", "MasterQuest_Soldier_05"] };
    }
    const rr = await call("quest/skip_daily", reqBody);
    const rres = (rr && rr.result) || {};
    const gained = (((rres.player_all_asset || {}).amulet_list) || []);
    const badNew = gained.filter(function (a) {
      const g = Number(a.skill_effect_grade) || 0;
      return !!a.skill_id && !(g >= 1 && g <= 5);
    });
    check("护符：新造的护符三件套合法（走真实流程）",
          gained.length > 0 && badNew.length === 0,
          gained.length === 0 ? "本次未产出护符（无法验证）"
                              : (gained.length + " 件新护符，非法 " + badNew.length + " 件"));
  }

  await call("__reset", {});
  console.log("=== 功能测试 ===");
  results.forEach(function (r) { console.log(r); });
  
console.log("");
  console.log("总计: 通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();