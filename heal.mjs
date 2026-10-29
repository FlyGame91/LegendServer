#!/usr/bin/env node
/**
 * heal.mjs —— 存档自愈【工具】（2026-10-26 按用户要求：从「自动触发」改为「主动触发」）
 *
 * 用户原则（原话）：
 *   「所有自愈变成工具，分离为检查模块和修复模块，该工具主动触发，不自动触发，
 *     触发后先检查，有问题再修复，没问题就跳过」
 *   「异常情况咱们也不该管，不然会让异常被隐藏」
 *
 * 用法：
 *   node server/heal.mjs check          只检查（在内存里跑，不写盘）
 *   node server/heal.mjs fix            先检查 → 有问题才写盘 → 复验
 *   node server/heal.mjs check --json   机器可读
 *
 * ★ 本工具直接改 state/user.json，跑完【必须重启服务端】才生效
 *   （服务端把存档读进内存，不重启会覆盖回去）。
 * ★ 本工具不再被任何路由调用 —— load_user_data 里已全部移除。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ST from "./state.mjs";
import { recomputeStatusList } from "./character.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.LEGECLOX_STATE || path.join(HERE, "state", "user.json");

const MODE = (process.argv[2] || "check").toLowerCase();
const JSON_OUT = process.argv.includes("--json");

const st = ST.loadState();

// 每一项：[名字, 执行函数, 说明]；函数返回「修正处数」（0 = 本来没问题）
const ITEMS = [
  ["玩家经验(累计语义)", () => ST.healPlayerExp(),
    "旧档把 exp 当本级内进度存，需按 C(level) 补成累计值"],
  ["任务进度(need 阈值)", () => ST.healMissionProgress(),
    "旧 need 算法读错阈值字段 → 累计登录成就被误标已达成"],
  ["限定任务期间", () => ST.healLimitedMissionPeriods(),
    "期间限定任务的 end_at 统一到 2099-01-01"],
  ["技能费用上限", () => ST.healSkillCostLimit(st),
    "class up 第一级 +1、上限 6"],
  ["记忆之书页完成记录", () => ST.healMemoryBookPages(st),
    "页面完成记录与节点等级不一致时补齐"],
  ["霸者之塔记录", () => ST.healTowerQuestRecord(st),
    "按已通关塔层补最高记录/当前层"],
  ["副任务宝箱记录", () => ST.healSubQuestTreasureBoxes(st),
    "部全通后宝箱 x/5 应为满"],
  ["角色 link 关系", () => ST.healCharacterLinks(st),
    "快照里有、当前却丢了的支援 link 关系补回"],
  ["道中进度一致性", () => ST.healMidwayProgress(st),
    "父关卡未通关的道中记录必须清零"],
  ["角色剧情奖励", () => ST.healStoryRewards(),
    "story/read 以前不发奖，已读的补发"],
  ["重复角色去重", () => ST.dedupeOwnedCharacters(),
    "同一 master 只留 1 个实例，其余折算碎片"],
  ["属性算法版本", () => ST.healStatusListVersion(recomputeStatusList),
    "改了属性算法后，存档里已存的角色仍是旧算法结果 → 按重算收敛"],
  ["好感度等级", () => ST.healFavorabilityLevels(),
    "好感度等级越界/不一致时修正"],
];

const results = [];
for (const [name, fn, desc] of ITEMS) {
  let n = 0, err = null;
  try { n = Number(fn()) || 0; } catch (e) { err = e.message; }
  results.push({ name, desc, n, err });
}

const bad = results.filter(r => r.n > 0 || r.err);
const needFix = bad.length > 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ mode: MODE, needFix, results }, null, 2));
} else {
  console.log("检查存档: " + STATE_FILE);
  console.log("");
  for (const r of results) {
    const mark = r.err ? "ERROR " : (r.n > 0 ? "WARN " + r.n + " 处" : "OK");
    console.log("  " + r.name.padEnd(22, " ") + mark + (r.err ? " (" + r.err + ")" : ""));
    if (r.n > 0) console.log("      -> " + r.desc);
  }
  console.log("");
  console.log(needFix ? ("共 " + bad.length + " 项有问题") : "全部正常，无需修复");
}

if (MODE === "fix") {
  if (!needFix) {
    if (!JSON_OUT) console.log("");
    if (!JSON_OUT) console.log("没问题，跳过修复（未写盘）");
    process.exit(0);
  }
  ST.saveNow();
  if (!JSON_OUT) {
    console.log("");
    console.log("已写盘: " + STATE_FILE);
    console.log("★ 必须重启服务端才生效（服务端内存里是旧值）");
  }
  // 复验：重新从磁盘读 + 再跑一遍（新进程状态）
  let left = 0;
  try {
    ST.loadState();
    for (const [name, fn] of ITEMS) {
      try { if (Number(fn()) > 0) left++; } catch (e) { left++; }
    }
  } catch (e) { left = -1; }
  if (!JSON_OUT) console.log(left === 0 ? "复验：全部正常" : ("复验仍有 " + left + " 项，需人工看"));
  process.exit(left === 0 ? 0 : 1);
}

if (MODE !== "check") {
  console.error("未知命令: " + MODE + "（用法: check | fix）");
  process.exit(2);
}
process.exit(needFix ? 1 : 0);
