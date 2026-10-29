// ★ 2026-10-22：崩溃可观测性 —— 之前进程静默消失，日志里一个字都没有
//   （17:23:21 服务了一个 master zip 之后就没了，用户端 Connection refused）。
import path from "node:path";
const HERE_DIR = path.dirname(process.argv[1] || ".");
process.on("uncaughtException", function (e) {
  try { fs?.appendFileSync?.(path.join(HERE_DIR, "_crash.log"), new Date().toISOString() + " uncaught: " + (e && (e.stack || e.message || e)) + "\n"); } catch (x) {}
  console.error("[FATAL] uncaught:", e && (e.stack || e.message || e));
});
process.on("unhandledRejection", function (e) {
  try { fs?.appendFileSync?.(path.join(HERE_DIR, "_crash.log"), new Date().toISOString() + " rejection: " + (e && (e.stack || e.message || e)) + "\n"); } catch (x) {}
  console.error("[FATAL] unhandledRejection:", e && (e.stack || e.message || e));
});
// local offline server 本地服务器 —— 入口。
//
// 用法: node main.mjs
// 监听 http://127.0.0.1:18081
import fs from "node:fs";
import { start } from "./server.mjs";
import { flushOnExit, syncLinkBattlePower } from "./state.mjs";
import "./routes-boot.mjs";
import "./routes-cdn.mjs";
import "./routes-biz.mjs";
import "./routes-quest.mjs";
import "./routes-misc.mjs";
import "./routes-rest.mjs";
import "./routes-char.mjs";
import "./routes-read.mjs";

flushOnExit();
// ★ 2026-10-22：启动时把 link 合计写回主角色战力（幂等）——保证重启后首次 load_user_data
//   拿到的就是「main + support」，不必等玩家手动换一次 link。
try { syncLinkBattlePower(); } catch (e) { console.error("link-bp 初始化失败: " + e.message); }
start().catch((e) => { console.error("启动失败:", e); process.exit(1); });