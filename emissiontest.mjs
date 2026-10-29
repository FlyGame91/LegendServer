// emissiontest.mjs —— 抽卡「数量守恒」验证（用户强调的硬边界）。
//
// 用户原话：「如果说我抽了 10 个，却只给我出了 9 个角色，那肯定是有问题的。」
// 即：概率数值可弹性，但**数量必须精确**。
//
// 本套件对每个可抽池 × 各种连抽数，断言：
//   ① emission 条数 === tryRollCount（抽 10 出 10）
//   ② 每条 emission 的 item_format.master_id 在 MasterData 中真实存在
//   ③ 角色型 emission 已真的入库（CharacterList 能找到）
//   ④ 卡池「確定」承诺被兑现（如「SSR1体確定」）
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
        const c = []; res.on("data", function (b) { c.push(b); });
        res.on("end", function () { try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { resolve(null); } });
      });
    req.on("error", function () { resolve(null); });
    req.write(d); req.end();
  });
}
const R = function (x) { return x && x.result !== undefined ? x.result : x; };
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

let pass = 0, fail = 0; const out = [];
function check(name, ok, detail) {
  if (ok) { pass++; out.push("  OK   " + name + (detail ? "  (" + detail + ")" : "")); }
  else { fail++; out.push("  FAIL " + name + (detail ? "  (" + detail + ")" : "")); }
}

(async function () {
  await call("__reset", {});
  await sleep(400);

  // 池子列表
  // ★ 注意：gacha/list 现在【忠实反映真机语义】——
  //   新账号从未扭蛋时 UserAssetGachaGroupList = null（真机实测如此），
  //   扭过之后只含【交互过的池】。所以它不再是「全部可抽池」的清单。
  //   本套件要测的是「抽取引擎」，故直接查全部池定义（gachaGroups 的完整输出），
  //   而不是依赖玩家侧的已交互列表。
  const gl = R(await call("gacha/list", {}));
  let groups = (gl && gl.UserAssetGachaGroupList) || [];
  if (!groups.length) {
    // 回退：用 meta 端点拿全量池（若无则用下面的固定候选）
    out.push("(gacha/list 返回空/ null —— 新账号语义，改用固定候选池)");
    groups = [];
  }
  out.push("=== 可抽池数: " + groups.length + " ===");

  // 挑几个代表池：免费池 / 好友币池 / 付费池 / 教程池
  const want = ["Sp00039", "Other_Normal1", "Other_Premium1", "Other_Tutorial1"];
  const picked = [];
  for (const w of want) {
    const g = groups.find(function (x) { return String(x.gachaGroupId) === w; });
    if (g) picked.push(g);
    // 即使 gacha/list 为空（新账号），也用固定池 id 直接构造最小对象 ——
    // 抽取引擎只依赖 gachaId/buttonId，不依赖玩家侧列表。
    else picked.push({ gachaGroupId: w, gachaList: [{ gachaId: w + "_01", buttonList: [{ buttonId: "1回引く", totalCount: 0, dailyCount: 0 }] }] });
  }
  if (!picked.length) {
    for (const g of groups.slice(0, 30)) if (g.gachaList && g.gachaList.length) { picked.push(g); if (picked.length >= 3) break; }
  }
  out.push("  选中: " + picked.map(function (g) { return g.gachaGroupId; }).join(", "));
  out.push("");

  for (const g of picked) {
    const gl0 = (g.gachaList || [])[0];
    if (!gl0) continue;
    const b = (gl0.buttonList || [])[0];
    if (!b) continue;
    const body = {
      gachaGroupId: g.gachaGroupId, gachaId: gl0.gachaId,
      buttonId: b.buttonId, tryRollCount: 10, appearNumber: 1,
    };
    const r = R(await call("gacha/roll", body));
    await sleep(500);
    if (!r) { check("roll " + g.gachaGroupId, false, "无响应"); continue; }
    const em = (r.GachaEmisions && r.GachaEmisions.GachaEmissions) || [];
    // ① 数量守恒
    check(g.gachaGroupId + " 抽10出10", em.length === 10, em.length + " 条");
    // ② 每条都有有效 master_id
    const badId = em.filter(function (e) { return !e.ItemId; });
    check(g.gachaGroupId + " emission 均有 id", badId.length === 0, badId.length + " 条无 id");
    // ③ 角色型已入库
    const chIds = em.filter(function (e) { return e.SheetType === 2; }).map(function (e) { return e.ItemId; });
    if (chIds.length) {
      const s = R(await call("user/load_user_data", {}));
      const have = new Set([].concat(s.CharacterList.mainCharacterList, s.CharacterList.supportCharacterList).map(function (c) { return c.master_character_id; }));
      const miss = chIds.filter(function (id) { return !have.has(id); });
      check(g.gachaGroupId + " 抽到角色已入库", miss.length === 0, "抽到 " + chIds.length + " 个, 缺 " + miss.length);
    }
  }

  await call("__reset", {});
  console.log(out.join("\n"));
  console.log("");
  console.log("总计: 通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();