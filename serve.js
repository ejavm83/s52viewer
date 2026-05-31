// Zero-dependency static file server for the S-52 viewer.
// Usage:  node serve.js [port]
//   Port: CLI 인자 > 환경 변수 PORT > 기본 8000
// Binds 0.0.0.0 so other machines on the LAN can open http://<this-host-ip>:<port>/
import http from "node:http";
import os from "node:os";
import { readFile } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCellIndex, listEncCellNames } from "./lib/cell-index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8000;
const fromArg = parseInt(process.argv[2], 10);
const fromEnv = parseInt(process.env.PORT ?? "", 10);
const port =
  Number.isFinite(fromArg) && fromArg > 0 && fromArg <= 65535
    ? fromArg
    : Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 65535
      ? fromEnv
      : DEFAULT_PORT;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".000": "application/octet-stream",
};

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/api/cells") {
      const files = listEncCellNames();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(files));
      return;
    }
    if (urlPath === "/api/index") {
      const idx = buildCellIndex();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(idx));
      return;
    }
    if (urlPath === "/cell-index.json") {
      const prebuilt = path.join(root, "cell-index.json");
      readFile(prebuilt, (err, data) => {
        if (!err) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(data);
          return;
        }
        const idx = buildCellIndex();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(idx));
      });
      return;
    }
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
    readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      const ext = path.extname(filePath).toLowerCase();
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
      // 변하지 않는 정적 자산(ENC 셀·심볼·카탈로그)은 장기 캐시 → 재방문 시 네트워크 0.
      if (ext === ".000" || ext === ".png" || ext === ".csv" || ext === ".xml") {
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      } else if (ext === ".js") {
        headers["Cache-Control"] = "public, max-age=86400"; // ?v= 쿼리로 무효화하므로 안전
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`S-52 viewer (this machine): http://localhost:${port}/`);
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const list of Object.values(nets)) {
      if (!list) continue;
      for (const n of list) {
        if (n.internal) continue;
        if (n.family === "IPv4" || n.family === 4) addrs.push(n.address);
      }
    }
    if (addrs.length) {
      console.log("Same LAN / intranet — open in a browser:");
      for (const a of addrs) console.log(`  http://${a}:${port}/`);
    } else {
      console.log("No non-loopback IPv4 found; use this host's IP manually.");
    }
  });
