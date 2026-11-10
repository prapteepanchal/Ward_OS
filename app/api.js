// WardOS - API client. Session lives in an HttpOnly cookie;
// nothing sensitive is stored in browser storage.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => { window.location.replace("/index.html"); };
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, { method = "GET", body, raw = false, timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;

  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "X-WardOS-Request": "1" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new ApiError(0, "NETWORK", "The WardOS server cannot be reached");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    onUnauthorized();
    throw new ApiError(401, "UNAUTHENTICATED", "Your session has ended");
  }

  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    throw new ApiError(res.status, data.error ?? "ERROR", data.message ?? `Request failed (${res.status})`);
  }

  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

/** Download a file returned by the API. */
export async function download(path) {
  const res = await api(path, { raw: true, timeout: 60000 });
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "WardOS_report.xlsx";
  saveBlob(blob, name);
  return name;
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* offline: still clear locally */ }
}
