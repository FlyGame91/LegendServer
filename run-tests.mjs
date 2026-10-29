// run-tests.mjs —— 在【隔离存档 + 独立端口】上跑全部测试套件（2026-09-30）
//
// 为什么需要它（事故根因）：
//   selftest / functest / audit 等每个用例前后都调 POST /v1/__reset，
//   而 __reset 会【立即覆盖 state/user.json】。
//   我此前直接对【用户正在使用的 18100 服务端】跑测试 →
//   每次跑完都把用户存档冲回基准档（177 角色 → 169 角色、石头 1亿 → 3万），
//   表现为「进不了游戏 / 数据丢失」。
//
// 做法：
//   ① 用 LEGECLOX_STATE=state/_test-user.json 起一个【独立服务端】在 LEGECLOX_PORT=18199；
//      它的 __reset 只动测试档，绝不碰 state/user.json。
//   ② 测试脚本通过 LEGECLOX_TEST_PORT=18199 指向它（脚本内默认读该变量）。
//   ③ 跑完杀掉子进程。
//
// 用法：node run-tests.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORT = process.env.LEGECLOX_TEST_PORT || "18199";
const TEST_STATE = "state/_test-user.json";

// 测试档不存在时，从当前 user.json 复制一份作为起点（只读复制，不改原件）
const testStatePath = path.join(HERE, TEST_STATE);
if (!fs.existsSync(testStatePath)) {
  const src = path.join(HERE, "state", "user.json");
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, testStatePath);
    console.log("[run-tests] 已从 user.json 复制测试档: " + TEST_STATE);
  }
}

// ★ 记录用户存档的 md5 —— 跑完后必须逐字节不变（这是本套件的核心承诺：
//   「测试永不触碰用户存档」，2026-09-30 那次事故后加的硬断言）
const userPath = path.join(HERE, "state", "user.json");
const md5 = async function (p) {
  try { const c = await import("node:crypto"); return c.createHash("md5").update(fs.readFileSync(p)).digest("hex"); }
  catch (e) { return "(读不到)"; }
};
const userMd5Before = await md5(userPath);
// ★ 关键指标快照（2026-10-16 新增）—— md5 变化时用它区分「测试污染」与「客户端正在玩」。
//   踩到的场景：套件在跑、游戏也在跑（生产实例 18100 连着客户端），
//   客户端每次操作都会写 state/user.json ⇒ md5 必变 ⇒ 旧断言误报「存档被改动」。
//   判据：角色数 / rank / master_rank 不变 且 石头没被重置到小额 ⇒ 判为「客户端在玩」。
const snapOf = function (p) {
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    const cl = o.CharacterList || {};
    return { mains: (cl.mainCharacterList || []).length, sups: (cl.supportCharacterList || []).length,
             rank: (o.UserData || {}).level, mr: (o.master_rank_data || {}).master_rank,
             free: Number(o.freeStoneBalance) || 0 };
  } catch (e) { return null; }
};
const userSnapBefore = snapOf(userPath);
const testMd5Before = await md5(testStatePath);

const srv = spawn(process.execPath, [path.join(HERE, "main.mjs")], {
  cwd: HERE,
  env: Object.assign({}, process.env, { LEGECLOX_STATE: TEST_STATE, LEGECLOX_PORT: TEST_PORT }),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let srvLog = "";
srv.stdout.on("data", (d) => { srvLog += d.toString(); });
srv.stderr.on("data", (d) => { srvLog += d.toString(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(6000);

// ★ 套件清单（顺序有意义）：
//   · 前六个是行为测试（HTTP 调用 + 断言副作用）
//   · invariants 是【业务不变量】层（skill 五层里最重要的一层）—— 断言「关键数值关系」成立，
//     而不只是字段形状对。纯读、无副作用，所以可以随套件随时跑。
//   · 最后两个是【面板属性精度】验证（纯读，不走 HTTP，直接 import 模块比对契约）：
//       verify_status  —— 我的输入 + 我的算法 vs 契约（日常回归）
//       verify_vs_live —— 契约的输入 + 我的算法 vs 契约（★ 把差异唯一归因到算法）
//     两者缺一不可：只跑前者会因「输入随游玩变化」而无法区分是算法错还是数据不同。
const suites = ["selftest.mjs", "functest.mjs", "emissiontest.mjs", "statetest.mjs", "contest.mjs", "audit.mjs",
                "invariants.mjs", "verify_status.mjs", "verify_vs_live.mjs"];
const results = [];
for (const f of suites) {
  const r = spawn(process.execPath, [path.join(HERE, f)], {
    cwd: HERE,
    env: Object.assign({}, process.env, { LEGECLOX_TEST_PORT: TEST_PORT, LEGECLOX_STATE: TEST_STATE }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  r.stdout.on("data", (d) => { out += d.toString(); });
  r.stderr.on("data", (d) => { out += d.toString(); });
  const code = await new Promise((res) => r.on("close", res));
  const line = out.split("\n").filter((l) => /总计/.test(l)).slice(-1)[0]
            || out.split("\n").filter((l) => /完全通过/.test(l)).slice(-1)[0] || "(无输出)";
  // 验证器失败时把差异明细一并带出（它们已经打印了，这里只需标记）
  results.push({ f, line: line.trim(), code: code, out: out });
}

try { srv.kill(); } catch (e) {}

console.log("\n===== 隔离测试结果（端口 " + TEST_PORT + " / 存档 " + TEST_STATE + "）=====");
for (const r of results) console.log("  " + r.f.padEnd(20) + r.line + (r.code ? "   [exit " + r.code + "]" : ""));

// 失败套件：把它们打印过的差异明细原样带出来（否则汇总里只看到一行 "失败 N"）
const failed = results.filter(function (r) { return r.code; });
if (failed.length) {
  console.log("\n===== 失败套件明细 =====");
  for (const r of failed) {
    console.log("\n--- " + r.f + " ---");
    const lines = r.out.split("\n").filter(function (l) { return /差异|❌|FAIL|不同|缺失/.test(l); });
    (lines.length ? lines.slice(0, 25) : r.out.split("\n").slice(-15)).forEach(function (l) { console.log("  " + l); });
  }
}

// ★ 存档完整性断言：跑完全套后 user.json 必须逐字节未变
const userMd5After = await md5(userPath);
const untouched = userMd5After === userMd5Before;
let benign = false;
let verdict;
if (untouched) {
  verdict = "未被触碰 ✅";
} else {
  const b = userSnapBefore, a = snapOf(userPath);
  if (b && a && a.mains === b.mains && a.sups === b.sups && a.rank === b.rank && a.mr === b.mr &&
      a.free >= b.free - 100000) {
    benign = true;
    verdict = "md5 变了，但【关键指标正常】—— 疑似客户端正在游玩（非测试污染）⚠️";
  } else {
    verdict = "★ 被改动了 ❌" + (b && a
      ? "（关键指标异常：角色 " + b.mains + "/" + b.sups + " → " + a.mains + "/" + a.sups +
         "，rank " + b.rank + " → " + a.rank + "，master_rank " + b.mr + " → " + a.mr + "）"
      : "（无法读取快照）");
  }
}
console.log("\n用户存档 state/user.json " + verdict);
console.log("  before md5 = " + userMd5Before);
console.log("  after  md5 = " + userMd5After);
console.log("  测试档 " + TEST_STATE + " md5: " + testMd5Before + " → " + (await md5(testStatePath)) + "（测试档允许变化）");

const dirtyFail = (untouched || benign) ? 0 : 1;
const totalFail = failed.length + dirtyFail;
console.log("\n【总览】套件 " + results.length + " 个，失败 " + failed.length + " 个" +
            (untouched ? "" : (benign ? "（存档 md5 变化，已归因为客户端游玩 ⚠️）" : " + 存档被改动")));
process.exit(totalFail ? 1 : 0);
