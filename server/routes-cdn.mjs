// 本地 CDN 层：提供资源清单，以及（按需的）资源本体回退。
//
// 为什么需要
// ----------
// Windows 客户端启动时向资源服务器请求 fileInfo，与本地 cache/local_file.json
// 做差异比对，只下载缺的文件。停服后 asset.legend-clover.net 会死 ——
// 但客户端【仍会请求 fileInfo】来比对，这一步必须由本地应答，否则启动卡住。
//
// 关键事实（已核实）
// ----------------
// · 本地资源 41,318/41,318 齐全，MD5 全通过
// · cache/local_file.json 已与 resource/fileInfo 同步（差异 0）
// → 差异比对为空，客户端【不需要下载任何资源本体】
// → 服务端只需提供 fileInfo；资源本体路径作为保险保留。
import fs from "node:fs";
import path from "node:path";
import { route, setResourceResolver, cachedRead, streamFile } from "./server.mjs";

const LAB = (function () {
  if (process.env.LGSRV_CLIENT_DATA) return process.env.LGSRV_CLIENT_DATA;
  var root = path.join(path.dirname(process.argv[1] || "."), "..", "client");
  try {
    var hit = fs.readdirSync(root).filter(function (n) { return /_Data$/.test(n); });
    if (hit.length) return path.join(root, hit[0]);
  } catch (e) {}
  return path.join(root, "Game_Data");
})();
const RES = path.join(LAB, "resource");

// Resource bodies are served from the lab itself -- a self-contained localisation must not
// depend on the original install. (It briefly did: the client kept re-downloading one
// asset, holding it open for writing, which made reads fail with EBUSY. The real cause was
// a wrong file, not the location; see the note on bg_event_legeroku_001.prefab below.)
//
// That asset had a body whose MD5 did not match its fileInfo entry, so the client treated
// it as corrupt on every launch and re-downloaded it. It was replaced with the correct copy
// from the CDN and now verifies; a full MD5 sweep of all 41,318 entries reports zero
// mismatches. Locking can still happen transiently while the client writes a file, so
// findResource() below detects that and answers 404 instead of crashing.
function resourceRoots() { return [RES]; }

function findResource(rel) {
  let sawLocked = false;
  for (const root of resourceRoots()) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    try { fs.accessSync(p, fs.constants.R_OK); return p; }
    catch (e) { sawLocked = true; }
  }
  return sawLocked ? null : undefined;   // null = exists but locked, undefined = absent
}

// Primary source for the manifests. WHY A COPY AND NOT resource/ DIRECTLY:
// the running game opens files under resource/ exclusively, so reading them from the
// server fails with EBUSY, and the client also rewrites/removes entries there on launch
// (observed: fileInfo and winr vanished from resource/ right after a game start).
// A staged copy is immune to both.
const STAGED = path.join(path.dirname(process.argv[1] || "."), "assets");
// ★ 2026-10-21 安卓（dgs 平台）：清单与资源体独立一套，见 安卓本地化勘察.md §1.3
const DGS_ROOT = path.join(STAGED, "dgs");
const DGS_MANIFEST = path.join(STAGED, "dgs.fileInfo");

// Prefer the staged copy; fall back to the installed resource dir.
function manifestPath(name, platform) {
  if (platform === "dgs" && name === "fileInfo" && fs.existsSync(DGS_MANIFEST)) return DGS_MANIFEST;
  if (platform === "dgs" && name === "dgs") {
    const idx = path.join(STAGED, "dgs.fileIndex");
    if (fs.existsSync(idx)) return idx;
    return DGS_MANIFEST;
  }
  const staged = path.join(STAGED, name);
  if (fs.existsSync(staged)) return staged;
  const installed = path.join(RES, name);
  if (fs.existsSync(installed)) return installed;
  return null;
}
const PLATFORMS = ["winr", "pcr", "pcg", "dgs", "gps", "cloud"];

// ---- 清单路由（精确）----
// /<platform>/fileInfo  → 本地 resource/fileInfo（随包基准清单，41,318 条）
// /<platform>/<platform> → 本地 resource/<platform>（资源包索引）
for (const platform of PLATFORMS) {
  route(platform + "/fileInfo", async ({ res }) => {
    const p = manifestPath("fileInfo", platform);
    if (!p) { res.writeHead(404); res.end("no fileInfo"); return undefined; }
    const buf = cachedRead(p);
    res.writeHead(200, { "Content-Type": platform === "dgs" ? "application/json; charset=utf-8" : "application/octet-stream", "Content-Length": buf.length });
    res.end(buf);
    return undefined;
  });
  route(platform + "/" + platform, async ({ res }) => {
    const p = manifestPath(platform, platform);
    if (!p) { res.writeHead(404); res.end("no index"); return undefined; }
    const buf = cachedRead(p);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length });
    res.end(buf);
    return undefined;
  });
}

// ---- 资源本体回退 ----
// 由 server.mjs 在路由未命中且回放兜底也未命中时调用。
// 形如 winr/adv/back/x.png；只服务 resource/ 下的文件，含路径逃逸检查。
const EXT = /\.(png|jpg|jpeg|mat|prefab|asset|bytes|acb|awb|usm|evsc|unity3d|bundle|txt|json|dat|bin|shader|anim|controller|ttf|otf|mp4|webm)$/i;
export function resolveResource(relPath, res) {
  // ★★★ 2026-10-24：客户端「お知らせ（公告）」弹框的图片走的是服务器托管路径 ★★★
  //   实测客户端会反复请求 m/xxxxxx/game-info/a8RcSYvh3bYA.png ——
  //   a8RcSYvh3bYA.png 是【硬编码在客户端里的文件名】，本地资源包里没有（fileInfo 0 条）。
  //   离线版若不接管 → 404 → 弹框里图片空白（用户报障「公告图片没显示」）。
  //   处置：任何 /game-info/ 下的图片一律回落成本地的停服公告横幅（ui/event/banner/service_end.png）。
  if (relPath.indexOf("/game-info/") >= 0 && /\.(png|jpg|jpeg)$/i.test(relPath)) {
    // ★ 优先用【APK 自带】的图（data/announcement/game-info.png），不依赖 16GB 资源包；
    //   资源包里的 service_end.png 只作兜底。
    const bundled = path.join(path.dirname(process.argv[1] || "."), "data", "announcement", "game-info.png");
    const banner = fs.existsSync(bundled) ? bundled : path.join(DGS_ROOT, "ui/event/banner/service_end.png");
    if (fs.existsSync(banner)) {
      console.log("[cdn] game-info 图片回落本地公告横幅: " + relPath + "  ← " + banner);
      streamFile(banner, res, "image/png");
      return true;
    }
  }
  const slash = relPath.indexOf("/");
  if (slash < 0) return false;
  const platform = relPath.slice(0, slash);
  if (PLATFORMS.indexOf(platform) < 0) return false;
  const rel = relPath.slice(slash + 1);
  if (!EXT.test(rel)) return false;
  // dgs（安卓）资源体：独立根目录，逐条按清单落地
  if (platform === "dgs") {
    const pd = path.join(DGS_ROOT, rel);
    if (fs.existsSync(pd)) { streamFile(pd, res, "application/octet-stream"); return true; }
    return false;
  }
  const picked = findResource(rel);
  if (picked === undefined) return false;      // absent everywhere -> normal 404
  if (picked === null) {
    // Present but locked (the client is writing it). Answer 404 rather than throwing:
    // an unhandled read error used to terminate the server mid-download.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{\"error\":\"locked\"}");
    return true;
  }
  streamFile(picked, res, "application/octet-stream");
  return true;
}


// ---- MasterData ZIP ----
// The redirect plugin maps https://master.legend-clover.net/<guid>.zip -> /master/<guid>.zip.
// Serve the ZIP we already downloaded (5,230,598 B) for the current GUID; answer with the
// same bytes whatever the requested GUID is, because the version endpoint hands the client
// this exact GUID.
const MD_ZIP = "game_data/8a1f4d92-6c3e-4b71-9d05-2fe8c7a41b63.zip";
const MD_GUID_CURRENT = "8a1f4d92-6c3e-4b71-9d05-2fe8c7a41b63";
route("master/" + MD_GUID_CURRENT + ".zip", async ({ res }) => {
  if (!fs.existsSync(MD_ZIP)) { res.writeHead(404); res.end("no masterdata zip"); return undefined; }
  const buf = cachedRead(MD_ZIP);
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": buf.length });
  res.end(buf);
  return undefined;
});
console.log("[cdn] MasterData ZIP 路由已注册: /master/" + MD_GUID_CURRENT + ".zip");
// ---- WebView 本地页面（抽卡注意事项 / 关于抽卡勋章）----
// 客户端用 WebView2 打开 misc.legend-clover.net/gacha-info/xxx.html，
// 插件 LegecloxWebView 已把 URL 改写到 127.0.0.1:18100/gacha-info/xxx.html。
for (const _wvName of ["gacha_info.html", "medal_info.html"]) {
  const _wvRel = "gacha-info/" + _wvName;
  route(_wvRel, async ({ res }) => {
    const fp = path.join(RES, _wvRel);
    if (!fs.existsSync(fp)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found: " + _wvRel); return undefined; }
    const buf = fs.readFileSync(fp);
    console.log("[WEBVIEW] " + _wvRel + " -> 200 " + buf.length + "B");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
    res.end(buf);
    return undefined;
  });
}
console.log("[cdn] WebView 页面路由已注册: gacha-info/*.html");
setResourceResolver(resolveResource);
console.log("[cdn] 资源清单路由已注册（" + PLATFORMS.join("/") + "）+ 本体回退");