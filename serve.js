// Zero-dependency static file server for the S-52 viewer.
// Usage:  node serve.js [port]
import http from "node:http";
import { readFile, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    // list the .000 cells available in the 000/ folder
    if (urlPath === "/api/cells") {
      try {
        const files = readdirSync(path.join(root, "000"))
          .filter((f) => /\.\d{3}$/i.test(f) && f.toLowerCase().endsWith(".000"))
          .sort();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(files));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
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
