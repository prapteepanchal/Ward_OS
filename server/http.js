// ============================================================
// WardOS - Minimal HTTP toolkit: router, JSON, cookies,
// security headers and an allow-listed static file server.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.js";

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const regex = new RegExp("^" + pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    }) + "$");
    this.routes.push({ method, regex, keys, handler, options });
  }

  get(p, h, o) { this.add("GET", p, h, o); }
  post(p, h, o) { this.add("POST", p, h, o); }

  match(method, pathname) {
    let methodMismatch = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      if (route.method !== method) { methodMismatch = true; continue; }
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }
}

// ------------------------------------------------------------
// Request / response helpers
// ------------------------------------------------------------

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key) out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export async function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
        resolve(body);
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(data);
}

export function sendFile(res, status, bytes, contentType, filename) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`
  });
  res.end(Buffer.from(bytes));
}

export function clientIp(req) {
  return req.socket?.remoteAddress ?? null;
}

// ------------------------------------------------------------
// Static files - only these top-level paths are ever served.
// server/, data/, node_modules/, .env, .git are never exposed.
// ------------------------------------------------------------

const STATIC_ROOTS = new Set(["assets", "lib", "shared", "app", "nurse", "doctor", "patient"]);
const STATIC_FILES = new Set(["index.html", "sw.js", "manifest.webmanifest"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  if (rel.endsWith("/")) rel += "index.html";

  const top = rel.split("/")[0];
  if (!(STATIC_FILES.has(rel) || STATIC_ROOTS.has(top))) return false;
  if (rel.split("/").some(seg => seg === ".." || seg.startsWith("."))) return false;

  const file = path.join(ROOT_DIR, rel);
  if (!file.startsWith(ROOT_DIR + path.sep)) return false;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return serveStatic(req, res, `/${rel}/`);

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext];
  if (!type) return false;

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": type,
    "Content-Length": stat.size,
    ETag: etag,
    // Revalidate every time: offline caching is done by the
    // service worker, so stale code is never served silently.
    "Cache-Control": ext === ".woff2" ? "public, max-age=604800" : "no-cache",
    ...(rel === "sw.js" ? { "Service-Worker-Allowed": "/" } : {})
  });

  if (req.method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(file).pipe(res);
  }
  return true;
}
