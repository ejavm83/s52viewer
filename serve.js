// Zero-dependency static file server for the S-52 viewer.
// Usage:  node serve.js [port]
import http from "node:http";
import { readFile } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCellIndex, listEncCellNames } from "./lib/cell-index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.argv[2], 10) || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
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
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`S-52 viewer at http://localhost:${port}/`));
