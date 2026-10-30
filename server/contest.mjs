// 并发/一致性测试：客户端会并行发请求，必须保证【无丢失更新】。
//
// 为什么需要：state 用「读-改-写」模式，若并发处理有竞态，会出现
// 声明了 N 个新角色但只入库 N-1 个、或货币扣减少了这类问题。
// 本套件用 Promise.all 并发发起写请求，再回读状态做【精确对账】。
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
const load = async function () { return R(await call("user/load_user_data", {})); };
const gold = function (s) { const e = (s.ItemList.AllItemList || []).find(function (x) { return x.master_item_id === "Item_Currency_Gold"; }); return e ? e.amount : 0; };
const amt = function (s, id) { const e = (s.ItemList.AllItemList || []).find(function (x) { return x.master_item_id === id; }); return e ? e.amount : 0; };

let pass = 0, fail = 0;
const out = [];
function check(name, ok, detail) {
  if (ok) { pass++; out.push("  OK   " + name + (detail ? "  (" + detail + ")" : "")); }
  else { fail++; out.push("  FAIL " + name + (detail ? "  (" + detail + ")" : "")); }
}

(async function () {
  await call("__reset", {});

  // 1. 并发抽卡：声明新增的角色必须全部入库
  {
    const a = await load();
    const before = new Set([].concat(a.CharacterList.mainCharacterList, a.CharacterList.supportCharacterList).map(function (c) { return c.master_character_id; }));
    const rolls = await Promise.all([1,2,3,4,5].map(function () {
      return call("gacha/roll", { gachaGroupId: "Sp00039", gachaId: "Sp00039_01", buttonId: "x", tryRollCount: 10, appearNumber: 1 });
    }));
    const declared = [];
    rolls.forEach(function (r) {
      const mc = (R(r) && R(r).player_all_asset && R(r).player_all_asset.MainCharacter) || [];
      mc.forEach(function (c) { declared.push(c.master_character_id); });
    });
    await new Promise(function (r) { setTimeout(r, 2500); });
    const b = await load();
    const after = new Set([].concat(b.CharacterList.mainCharacterList, b.CharacterList.supportCharacterList).map(function (c) { return c.master_character_id; }));
    const lost = declared.filter(function (x) { return !after.has(x); });
    check("并发抽卡无丢失", lost.length === 0, "声明 " + declared.length + " 个，丢失 " + lost.length);
    // 实例 id 唯一性
    const all = [].concat(b.CharacterList.mainCharacterList, b.CharacterList.supportCharacterList);
    const ids = all.map(function (c) { return c.id; });
    const dup = ids.filter(function (x, i) { return ids.indexOf(x) !== i; });
    check("并发后实例 id 唯一", dup.length === 0, dup.length + " 个重复");
  }

  // 2. 并发出售：资源守恒（精确对账）
  // ★ 产出按权威表 `Item/SellItemList.csv` 的 SellPrice（可能是金币/附魔币/炼金币）——
  //   我早期断言「金币 +1000」是基于错实现（当年一律给金币 ×10/个）。
  {
    // 用已验证可炼成的素材（SellPrice = ITEM:Item_Currency_EnchantCoinx1，即 1:1）
    const SID = "Item_Material_Enchant_06_01";
    const a = await load();
    const m0 = amt(a, SID);
    if (m0 > 200) {
      const c0 = amt(a, "Item_Currency_EnchantCoin");
      await Promise.all([1,2,3,4,5,6,7,8,9,10].map(function () {
        return call("baggage/sell_item", { item_data_list: [{ master_id: SID, amount: 10 }] });
      }));
      await new Promise(function (r) { setTimeout(r, 2500); });
      const b = await load();
      check("并发出售 道具精确扣减", m0 - amt(b, SID) === 100, "-" + (m0 - amt(b, SID)) + " (期望 -100)");
      check("并发出售 产出精确增加（按 SellPrice 表）",
            amt(b, "Item_Currency_EnchantCoin") - c0 === 100,
            "+" + (amt(b, "Item_Currency_EnchantCoin") - c0) + " (期望 +100)");
    } else check("并发出售", false, "素材不足（" + SID + "=" + m0 + "）");
  }

  // 3. 并发读性能：模拟客户端启动时的并行拉取
  {
    const eps = [
      ["user/load_user_data", {}], ["gacha/list", {}], ["user/load_mypage_data", {}],
      ["chat/rooms", {}], ["friend/load_friend_data", {}], ["oracle_liberator/update", {}],
      ["present/list", {}], ["ranking/load_ranking_data", {}],
    ];
    const t0 = Date.now();
    const rs = await Promise.all(eps.map(function (e) { return call(e[0], e[1]); }));
    const ms = Date.now() - t0;
    const okN = rs.filter(function (x) { return x && JSON.stringify(x).indexOf("alterCode") < 0; }).length;
    check("并发读全部成功", okN === eps.length, okN + "/" + eps.length + " 用时 " + ms + "ms");
    check("并发读延迟可接受", ms < 3000, ms + "ms");
  }

  // 4. 存档始终可解析（并发写不破坏 JSON）
  {
    let okJson = true, fields = 0;
    try {
      const s = JSON.parse(fs.readFileSync("state/user.json", "utf8"));
      fields = Object.keys(s).length;
    } catch (e) { okJson = false; }
    check("存档 JSON 可解析", okJson, fields + " 个顶层字段");
  }

  await call("__reset", {});
  console.log("=== 并发测试 ===");
  out.forEach(function (r) { console.log(r); });
  console.log("");
  console.log("总计: 通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();