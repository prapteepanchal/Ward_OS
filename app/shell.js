// ============================================================
// WardOS - Application shell shared by every role:
// sidebar, header (clock, connectivity, sound, alerts),
// system banners, critical-alert strip, notification drawer,
// hash router, alert sound + reminders.
// ============================================================

import { api, logout, setUnauthorizedHandler } from "./api.js";
import { LiveStore, cacheClear } from "./live.js";
import { icon } from "./icons.js";
import { AlertSound, toast } from "./ui.js";
import { esc, initials, timeAgo, fmtTime, severityChip, lifecycleChip, $ } from "./util.js";
import { config } from "../shared/config.js";

const ROLE_LABEL = { nurse: "Nurse", doctor: "Doctor", patient: "Patient" };

/**
 * @param {object} options
 *   role, title, nav: [{ id, label, icon, badge?: (store)=>{n,cls} }],
 *   views: { [id]: (el, ctx, param) => cleanup? }, defaultView,
 *   onAlertAction?: (alert, action) => Promise
 */
export async function startApp(options) {
  setUnauthorizedHandler(() => window.location.replace("/index.html?expired=1"));

  let me;
  try {
    me = await api("/api/auth/me");
  } catch (error) {
    if (error.status === 401) return window.location.replace("/index.html");
    // Server unreachable: try to continue from the offline cache.
    me = JSON.parse(sessionStorage.getItem("wardos-me") || "null");
    if (!me) return renderUnreachable();
  }
  if (me.role !== options.role) return window.location.replace(`/${me.role}/${me.role === "patient" ? "patient.html" : `${me.role}_dashboard.html`}`);
  sessionStorage.setItem("wardos-me", JSON.stringify(me));

  const store = new LiveStore(me);
  const sound = options.role === "patient" ? null : new AlertSound();
  const ctx = { me, store, sound, role: options.role, refresh: () => {} };

  document.body.innerHTML = layout(options, me);
  const app = $(".app");
  const contentEl = $("#content");

  // ---------------- Router ----------------
  let cleanup = null;
  let currentView = null;

  function route() {
    const [id, param] = (location.hash.replace(/^#\/?/, "") || options.defaultView).split("/");
    const view = options.views[id] ? id : options.defaultView;
    if (typeof cleanup === "function") cleanup();
    cleanup = null;
    currentView = view;
    document.querySelectorAll(".nav-item[data-view]").forEach(n => n.dataset.view === view ? n.setAttribute("aria-current", "page") : n.removeAttribute("aria-current"));
    const navItem = options.nav.find(n => n.id === view);
    $("#crumb-view").textContent = navItem?.label ?? "";
    contentEl.innerHTML = `<div class="view"></div>`;
    cleanup = options.views[view](contentEl.firstElementChild, ctx, param ? decodeURIComponent(param) : null);
    app.classList.remove("menu-open");
    contentEl.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
  ctx.navigate = (id, param) => { location.hash = `#/${id}${param ? `/${encodeURIComponent(param)}` : ""}`; };
  ctx.currentView = () => currentView;
  window.addEventListener("hashchange", route);

  // ---------------- Sidebar ----------------
  $("#collapse-btn")?.addEventListener("click", () => {
    app.classList.toggle("collapsed");
    try { localStorage.setItem("wardos-collapsed", app.classList.contains("collapsed") ? "1" : "0"); } catch { /* ignore */ }
  });
  if (localStorage.getItem("wardos-collapsed") === "1") app.classList.add("collapsed");
  $("#menu-btn").addEventListener("click", () => app.classList.toggle("menu-open"));
  $("#logout-btn").addEventListener("click", async () => {
    store.stop();
    await logout();
    await cacheClear();
    sessionStorage.removeItem("wardos-me");
    window.location.replace("/index.html");
  });

  // ---------------- Clock ----------------
  const clock = $("#clock");
  const tick = () => {
    const d = new Date();
    clock.innerHTML = `${d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })} <b>${d.toLocaleTimeString([], { hour12: false })}</b>`;
  };
  tick();
  setInterval(tick, 1000);

  // ---------------- Sound ----------------
  const soundBtn = $("#sound-btn");
  const renderSound = () => {
    if (!sound || !soundBtn) return;
    const st = sound.state;
    soundBtn.innerHTML = icon(sound.muted || st !== "ready" ? "mute" : "sound");
    soundBtn.classList.toggle("attn", st === "locked" && !sound.muted);
    soundBtn.title = st === "unavailable" ? "Audio not supported by this browser"
      : sound.muted ? "Alert sound muted - click to unmute"
      : st === "locked" ? "Click anywhere to enable alert sound (browser requires a click first)"
      : "Alert sound on - click to mute";
    soundBtn.setAttribute("aria-label", soundBtn.title);
  };
  soundBtn?.addEventListener("click", () => { sound.toggleMute(); renderSound(); });
  sound?.onChange(renderSound);
  renderSound();

  // ---------------- Notifications drawer ----------------
  $("#alerts-btn")?.addEventListener("click", () => openNotifications(ctx, options));

  // ---------------- Live updates ----------------
  let lastReminder = Date.now();
  store.on((type, payload) => {
    if (type === "alert" && payload.event === "CREATED" && options.role !== "patient") {
      const a = payload.alert;
      if (a.severity === "CRITICAL") {
        sound?.play("critical");
        toast(`Critical - ${a.patientName}`, `${a.ward ?? ""} · Bed ${a.bed ?? "?"}`, "crit", 8000);
      } else {
        toast(`${a.patientName}`, a.message ?? "", "warn");
      }
    }
    if (type === "connection") renderConnectivity(ctx);
    if (["snapshot", "alert", "system", "connection"].includes(type)) {
      renderConnectivity(ctx);
      renderCritStrip(ctx, options);
      renderBadges(ctx, options);
    }
    if (type === "patients" || type === "snapshot") renderBadges(ctx, options);
  });

  // Gentle reminder while unacknowledged critical alerts exist.
  if (sound && config.alerts.criticalReminderMs > 0) {
    setInterval(() => {
      const pending = store.unacknowledged.some(a => a.severity === "CRITICAL");
      if (pending && Date.now() - lastReminder >= config.alerts.criticalReminderMs) {
        lastReminder = Date.now();
        sound.play("critical");
      }
    }, 5000);
  }

  // Relative timestamps refresh.
  setInterval(() => document.querySelectorAll("[data-ago]").forEach(el => { el.textContent = timeAgo(Number(el.dataset.ago)); }), 5000);

  renderConnectivity(ctx);
  await store.start();
  route();
  return ctx;
}

// ------------------------------------------------------------

function layout(options, me) {
  const nav = options.nav.map(n => `
    <a class="nav-item" href="#/${n.id}" data-view="${n.id}" title="${esc(n.label)}">
      ${icon(n.icon)}<span class="label">${esc(n.label)}</span><span class="count hidden" data-badge="${n.id}"></span>
    </a>`).join("");

  const staff = options.role !== "patient";
  const sub = me.role === "patient" ? "Patient portal" : me.title || ROLE_LABEL[me.role];

  return `
  <a class="sr-only" href="#content">Skip to content</a>
  <div class="app">
    <aside class="sidebar" aria-label="Main navigation">
      <div class="brand">
        <div class="brand-mark">${icon("pulse")}</div>
        <div class="brand-name">WARDOS<small>${esc(options.title)}</small></div>
      </div>
      <div class="side-section">
        <span class="eyebrow">${staff ? "Monitoring" : "My care"}</span>
        <nav class="nav">${nav}</nav>
      </div>
      <div class="side-foot">
        <div class="side-user">
          <div class="avatar">${esc(initials(me.name))}</div>
          <div class="who"><strong>${esc(me.name)}</strong><span>${esc(sub)}</span></div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn ghost sm" id="logout-btn" style="flex:1;justify-content:flex-start">${icon("logout")}<span class="label">Sign out</span></button>
          ${staff ? `<button class="icon-btn" id="collapse-btn" aria-label="Collapse sidebar" title="Collapse sidebar">${icon("collapse")}</button>` : ""}
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" id="menu-btn" aria-label="Open menu">${icon("menu")}</button>
        <div class="crumbs"><span>${esc(ROLE_LABEL[me.role])}</span>${icon("chevron").replace("<svg", '<svg width="14" height="14"')}<strong id="crumb-view"></strong></div>
        <div class="spacer"></div>
        <div class="links" id="links" aria-label="Connection status"></div>
        <div class="clock" id="clock"></div>
        ${staff ? `<button class="icon-btn" id="sound-btn"></button>
        <button class="icon-btn" id="alerts-btn" aria-label="Open alerts">${icon("bell")}<span class="badge hidden" id="alerts-badge"></span></button>` : ""}
      </header>
      <div id="banners" aria-live="polite"></div>
      <div id="crit-strip" class="crit-strip" aria-live="assertive"></div>
      <main class="content" id="content" tabindex="-1"></main>
    </div>
  </div>`;
}

function pill(cls, label, title) {
  return `<span class="link-pill ${cls}" title="${esc(title)}"><span class="dot"></span><span class="txt">${esc(label)}</span></span>`;
}

function renderConnectivity(ctx) {
  const c = ctx.store.connectivity;
  const links = $("#links");
  const banners = $("#banners");
  if (!links) return;

  const brokerCls = !c.server ? "" : c.broker === "CONNECTED" ? "ok" : c.broker === "RAW MODE" ? "warn" : "crit";
  const brokerLabel = !c.server ? "Broker ?" : c.broker === "CONNECTED" ? "MQTT live" : c.broker === "RAW MODE" ? "MQTT raw" : c.broker === "CONNECTING" ? "MQTT connecting" : "MQTT down";

  links.innerHTML =
    pill(c.server ? "ok" : "crit", c.server ? "Server" : "Server offline", c.server ? "Connected to the local WardOS server" : "WardOS server unreachable") +
    (ctx.role === "patient" ? "" : pill(brokerCls, brokerLabel, `MQTT broker: ${c.broker}`)) +
    (c.network ? "" : pill("warn", "No network", "This computer reports no network connection"));

  const items = [];
  if (!c.server) {
    items.push(`<div class="banner crit">${icon("wifiOff")}<span><strong>Not live.</strong> The local WardOS server cannot be reached${c.cachedAt ? ` - showing data cached at <span class="mono">${fmtTime(c.cachedAt, true)}</span>` : ""}. Readings shown are not current. Reconnecting automatically.</span></div>`);
  } else if (ctx.role !== "patient" && c.broker !== "CONNECTED" && c.broker !== "RAW MODE") {
    items.push(`<div class="banner crit">${icon("unlink")}<span><strong>MQTT broker link down</strong> (${esc(c.broker)}). Wearable data is not being received; device states are unknown, not offline. Stored history and reports remain available.</span></div>`);
  } else if (c.rawMode) {
    items.push(`<div class="banner warn">${icon("alert")}<span><strong>Raw mode.</strong> No cleaned telemetry for over ${config.mqtt.rawModeSilenceMs / 1000} s - the cleaning pipeline may be down. Values come directly from the sensors.</span></div>`);
  }
  if (c.simulation && c.server) {
    items.push(`<div class="banner info">${icon("info")}<span><strong>Simulated telemetry.</strong> Readings come from the WardOS simulator, not real wearables.</span></div>`);
  }
  const html = items.join("");
  if (banners.dataset.html !== html) {
    banners.innerHTML = html;
    banners.dataset.html = html;
  }
}

function renderBadges(ctx, options) {
  for (const n of options.nav) {
    if (!n.badge) continue;
    const el = document.querySelector(`[data-badge="${n.id}"]`);
    if (!el) continue;
    const b = n.badge(ctx.store);
    el.classList.toggle("hidden", !b || !b.n);
    if (b?.n) {
      el.textContent = b.n;
      el.className = `count ${b.cls ?? ""}`;
    }
  }
  const badge = $("#alerts-badge");
  if (badge) {
    const n = ctx.store.unacknowledged.length;
    badge.classList.toggle("hidden", !n);
    badge.textContent = n > 99 ? "99+" : n;
  }
}

function renderCritStrip(ctx, options) {
  const strip = $("#crit-strip");
  if (!strip || ctx.role === "patient") return;
  const crit = ctx.store.unacknowledged.filter(a => a.severity === "CRITICAL").slice(0, 3);
  const html = crit.map(a => `
    <div class="crit-row" data-id="${esc(a.id)}">
      <span class="sev">${icon("siren").replace("<svg", '<svg width="14" height="14"')}CRITICAL</span>
      <div class="what"><strong>${esc(a.patientName)}</strong> <span class="mono">· ${esc(a.ward ?? "")} · Bed ${esc(a.bed ?? "?")}</span><br>
        <span>${esc(a.message)}${a.conditionActive ? "" : " (readings have returned to range - acknowledgement still required)"}</span></div>
      <time class="mono" data-ago="${a.createdAt}">${timeAgo(a.createdAt)}</time>
      <div style="display:flex;gap:6px">
        <button class="btn sm" data-open="${a.patientId}">View</button>
        <button class="btn sm solid-danger" data-ack="${esc(a.id)}">Acknowledge</button>
      </div>
    </div>`).join("");
  if (strip.dataset.html === html) return;
  strip.dataset.html = html;
  strip.innerHTML = html;
  strip.querySelectorAll("[data-ack]").forEach(b => b.addEventListener("click", () => acknowledge(b, b.dataset.ack)));
  strip.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => ctx.openPatient?.(Number(b.dataset.open))));
}

export async function acknowledge(button, alertId) {
  button?.classList.add("loading");
  try {
    await api(`/api/alerts/${encodeURIComponent(alertId)}/acknowledge`, { method: "POST", body: {} });
    toast("Alert acknowledged", "", "ok", 2500);
  } catch (error) {
    toast("Could not acknowledge", error.message, "crit");
  } finally {
    button?.classList.remove("loading");
  }
}

// ------------------------------------------------------------
// Notification drawer
// ------------------------------------------------------------

function openNotifications(ctx) {
  const backdrop = document.createElement("div");
  backdrop.className = "drawer-backdrop";
  const drawer = document.createElement("aside");
  drawer.className = "drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Open alerts");
  document.body.append(backdrop, drawer);

  const render = () => {
    const alerts = ctx.store.openAlerts;
    drawer.innerHTML = `
      <div class="drawer-head"><div><h2 style="font-size:15px">Open alerts</h2><span class="dim" style="font-size:12px">${ctx.store.unacknowledged.length} need acknowledgement</span></div>
        <div style="display:flex;gap:6px"><a class="btn sm ghost" href="#/alerts">Alert centre</a><button class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div></div>
      <div class="drawer-body"><div class="alert-list">
        ${alerts.length ? alerts.map(a => `
          <div class="alert-item ${a.severity}">
            <span class="rail"></span>
            <div>
              <div class="top">${severityChip(a.severity)} ${lifecycleChip(a.status)}</div>
              <div class="msg"><span class="who">${esc(a.patientName)}</span> - ${esc(a.message)}</div>
              ${a.note ? `<div class="note">${esc(a.note)}</div>` : ""}
              <div class="meta"><span>${esc(a.ward ?? "")} · Bed ${esc(a.bed ?? "?")}</span><span data-ago="${a.createdAt}">${timeAgo(a.createdAt)}</span>${a.conditionActive ? "<span>condition active</span>" : "<span>condition cleared</span>"}</div>
            </div>
            <div class="acts">${a.status === "NEW" ? `<button class="btn sm" data-ack="${esc(a.id)}">${icon("check")}Ack</button>` : ""}
              <button class="btn sm ghost" data-open="${a.patientId}">Patient</button></div>
          </div>`).join("") : `<div class="empty">${icon("shield")}<strong>No open alerts</strong><span>All monitored patients are within limits.</span></div>`}
      </div></div>`;
    drawer.querySelector("[data-close]").addEventListener("click", close);
    drawer.querySelectorAll("[data-ack]").forEach(b => b.addEventListener("click", () => acknowledge(b, b.dataset.ack)));
    drawer.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => { close(); ctx.openPatient?.(Number(b.dataset.open)); }));
    drawer.querySelector('a[href="#/alerts"]')?.addEventListener("click", close);
  };

  const off = ctx.store.on(type => { if (type === "alert" || type === "snapshot") render(); });
  const onKey = e => { if (e.key === "Escape") close(); };
  function close() {
    off();
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    drawer.remove();
  }
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  render();
}

function renderUnreachable() {
  document.body.innerHTML = `<div class="empty" style="min-height:100vh">${icon("wifiOff")}<strong>WardOS server unreachable</strong>
    <span>No cached session is available on this device. Check that the local WardOS server is running, then reload.</span>
    <button class="btn" onclick="location.reload()">Retry</button></div>`;
}
