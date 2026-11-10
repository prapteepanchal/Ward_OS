// ============================================================
// WardOS - 3D ward floor
//
// A live spatial view of the ward: every bed sits where it is,
// lit by its patient's current status. Hover shows the vitals,
// click opens the patient record. Driven ONLY by live state -
// nothing in the scene is decorative data.
//
//  - three.js is vendored in /lib/three (works offline)
//  - renders on demand; animates only while something moves
//    (intro, camera easing, critical-bed pulse)
//  - pauses when hidden; respects prefers-reduced-motion
//  - throws if WebGL is unavailable (caller shows a fallback)
// ============================================================

import * as THREE from "../lib/three/three.module.js";
import { statusGlyph, icon } from "./icons.js";
import { esc, fmtVital, vitalLevel } from "./util.js";

const STATUS_COLOR = {
  ok: 0x34D399,
  warning: 0xFBBF24,
  critical: 0xF87171,
  offline: 0x6B7689,
  removed: 0xB8954A
};

const BED_SPACING = 1.95;
const ROW_Z = 2.45;
const WARD_GAP = 2.6;
const MIN_SLOTS = 8;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function supportsWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGL2RenderingContext && c.getContext("webgl2")) || !!c.getContext("webgl");
  } catch {
    return false;
  }
}

/** Soft radial gradient used for the light pool under each bed. */
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Ward name painted on the floor. */
function floorTextTexture(title, subtitle) {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 160;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(232,237,244,0.55)";
  g.font = "600 64px 'IBM Plex Sans', system-ui, sans-serif";
  g.fillText(title, 8, 70);
  g.fillStyle = "rgba(138,151,171,0.45)";
  g.font = "400 38px 'IBM Plex Sans', system-ui, sans-serif";
  g.fillText(subtitle, 10, 130);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function bedNumber(label) {
  const n = parseInt(String(label ?? "").replace(/\D+/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class WardFloor {
  constructor(root, { onSelect } = {}) {
    if (!supportsWebGL()) throw new Error("WebGL unavailable");

    this.root = root;
    this.onSelect = onSelect;
    this.beds = new Map();          // patientId -> bed record
    this.emptyBeds = [];
    this.wardZones = new Map();     // wardId -> { group, slots }
    this.disposables = [];
    this.layoutKey = "";
    this.hovered = null;
    this.needsRender = true;
    this.running = true;
    this.visible = true;
    this.showLabels = true;
    this.clock = new THREE.Clock();
    this.introStart = reduced() ? null : performance.now();

    root.innerHTML = "";
    root.setAttribute("role", "application");
    root.setAttribute("aria-label", "3D ward floor. Drag to rotate, scroll to zoom, click a bed to open the patient record.");

    // ---------------- Renderer ----------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    root.appendChild(this.canvas);

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "floor-labels";
    root.appendChild(this.labelLayer);

    root.insertAdjacentHTML("beforeend", `
      <div class="floor-hud" aria-hidden="true">
        <span class="key"><i style="background:#F87171"></i>Critical</span>
        <span class="key"><i style="background:#FBBF24"></i>Warning</span>
        <span class="key"><i style="background:#34D399"></i>Stable</span>
        <span class="key"><i style="background:#6B7689"></i>Not monitored</span>
        <span>· Drag to rotate · Scroll to zoom</span>
      </div>
      <div class="floor-tools">
        <button class="icon-btn" data-tool="labels" title="Toggle bed labels" aria-label="Toggle bed labels">${icon("note")}</button>
        <button class="icon-btn" data-tool="reset" title="Reset view" aria-label="Reset view">${icon("collapse")}</button>
      </div>`);
    root.querySelector('[data-tool="reset"]').addEventListener("click", () => this.resetView());
    root.querySelector('[data-tool="labels"]').addEventListener("click", () => {
      this.showLabels = !this.showLabels;
      this.labelLayer.style.display = this.showLabels ? "" : "none";
    });

    // ---------------- Scene ----------------
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0f15, 26, 62);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.target = new THREE.Vector3(0, 0, 0);
    this.view = { azimuth: -0.42, elevation: 1.0, distance: 30 };
    this.goal = { ...this.view };

    const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x0b0f14, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff4e6, 1.6);
    key.position.set(-10, 18, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -30; key.shadow.camera.right = 30;
    key.shadow.camera.top = 20; key.shadow.camera.bottom = -20;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key);
    this.keyLight = key;
    const rim = new THREE.DirectionalLight(0x6fa8ff, 0.45);
    rim.position.set(12, 8, -14);
    this.scene.add(rim);

    // Floor
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x0f151d, roughness: 0.92, metalness: 0.05 });
    this.floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), floorMat);
    this.floorMesh.rotation.x = -Math.PI / 2;
    this.floorMesh.receiveShadow = true;
    this.scene.add(this.floorMesh);
    this.track(this.floorMesh.geometry, floorMat);

    // Shared geometry / materials
    this.glow = glowTexture();
    this.disposables.push(this.glow);
    this.geo = {
      frame: new THREE.BoxGeometry(1.02, 0.3, 2.12),
      mattress: new THREE.BoxGeometry(0.92, 0.14, 1.96),
      blanket: new THREE.BoxGeometry(0.95, 0.05, 1.22),
      pillow: new THREE.BoxGeometry(0.68, 0.1, 0.36),
      head: new THREE.BoxGeometry(1.08, 0.78, 0.08),
      pole: new THREE.CylinderGeometry(0.018, 0.018, 1.25, 8),
      screen: new THREE.BoxGeometry(0.44, 0.3, 0.035),
      pad: new THREE.PlaneGeometry(2.8, 3.9),
      hit: new THREE.BoxGeometry(1.4, 1.2, 2.6)
    };
    Object.values(this.geo).forEach(g => this.disposables.push(g));
    this.mat = {
      frame: new THREE.MeshStandardMaterial({ color: 0x2b3445, roughness: 0.55, metalness: 0.45 }),
      mattress: new THREE.MeshStandardMaterial({ color: 0x8793a8, roughness: 0.85 }),
      blanket: new THREE.MeshStandardMaterial({ color: 0x33415a, roughness: 0.9 }),
      pillow: new THREE.MeshStandardMaterial({ color: 0x7c889c, roughness: 0.9 }),
      head: new THREE.MeshStandardMaterial({ color: 0x1f2735, roughness: 0.6, metalness: 0.3 }),
      pole: new THREE.MeshStandardMaterial({ color: 0x8a97ab, roughness: 0.4, metalness: 0.8 }),
      empty: new THREE.MeshStandardMaterial({ color: 0x1a212b, roughness: 0.9, transparent: true, opacity: 0.55 }),
      hit: new THREE.MeshBasicMaterial({ visible: false })
    };
    Object.values(this.mat).forEach(m => this.disposables.push(m));

    this.root3d = new THREE.Group();
    this.scene.add(this.root3d);

    // ---------------- Interaction ----------------
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindEvents();

    // ---------------- Lifecycle ----------------
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.io = new IntersectionObserver(entries => {
      this.visible = entries.some(e => e.isIntersecting);
      if (this.visible) this.requestRender();
    });
    this.io.observe(root);
    this.onVisibility = () => { if (!document.hidden) this.requestRender(); };
    document.addEventListener("visibilitychange", this.onVisibility);

    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  track(...items) { this.disposables.push(...items); }

  // ------------------------------------------------------------
  // Layout: wards side by side, beds in two facing rows
  // ------------------------------------------------------------

  rebuildLayout(patients) {
    // Clear previous layout
    for (const child of [...this.root3d.children]) this.root3d.remove(child);
    this.beds.clear();
    this.emptyBeds = [];
    this.labelLayer.innerHTML = "";
    for (const zone of this.wardZones.values()) zone.dispose?.();
    this.wardZones.clear();

    const byWard = new Map();
    for (const p of patients) {
      if (!byWard.has(p.wardId)) byWard.set(p.wardId, { name: p.ward, patients: [] });
      byWard.get(p.wardId).patients.push(p);
    }

    let cursorX = 0;
    const wardIds = [...byWard.keys()].sort();
    for (const wardId of wardIds) {
      const ward = byWard.get(wardId);
      const numbers = ward.patients.map(p => bedNumber(p.bed)).filter(Boolean);
      const slots = Math.max(MIN_SLOTS, Math.max(0, ...numbers) + (Math.max(0, ...numbers) % 2));
      const cols = Math.ceil(slots / 2);
      const width = cols * BED_SPACING + 1.6;
      const depth = ROW_Z * 2 + 3.4;
      const zone = new THREE.Group();
      zone.position.x = cursorX + width / 2;
      this.root3d.add(zone);

      // Zone slab + outline
      const slabGeo = new THREE.BoxGeometry(width, 0.04, depth);
      const slabMat = new THREE.MeshStandardMaterial({ color: 0x131a24, roughness: 0.95 });
      const slab = new THREE.Mesh(slabGeo, slabMat);
      slab.position.y = 0.02;
      slab.receiveShadow = true;
      zone.add(slab);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(slabGeo), new THREE.LineBasicMaterial({ color: 0x2a3446, transparent: true, opacity: 0.9 }));
      edges.position.y = 0.02;
      zone.add(edges);

      // Centre aisle marking
      const aisleGeo = new THREE.PlaneGeometry(width - 1.2, 0.03);
      const aisleMat = new THREE.MeshBasicMaterial({ color: 0x2a3446 });
      const aisle = new THREE.Mesh(aisleGeo, aisleMat);
      aisle.rotation.x = -Math.PI / 2;
      aisle.position.y = 0.045;
      zone.add(aisle);

      // Ward name on the floor
      const textTex = floorTextTexture(ward.name ?? wardId, `${ward.patients.length} patient${ward.patients.length === 1 ? "" : "s"} · ${wardId}`);
      const textMat = new THREE.MeshBasicMaterial({ map: textTex, transparent: true, depthWrite: false });
      const textGeo = new THREE.PlaneGeometry(6.4, 1.0);
      const text = new THREE.Mesh(textGeo, textMat);
      text.rotation.x = -Math.PI / 2;
      text.position.set(-width / 2 + 3.4, 0.05, depth / 2 + 0.85);
      zone.add(text);

      this.track(slabGeo, slabMat, edges.geometry, edges.material, aisleGeo, aisleMat, textTex, textMat, textGeo);

      const occupied = new Set();
      for (const p of ward.patients) {
        const n = bedNumber(p.bed);
        if (n) occupied.add(n);
      }
      // Patients without a numeric bed get the first free slots.
      let spare = 1;
      const slotOf = new Map();
      for (const p of ward.patients) {
        let n = bedNumber(p.bed);
        if (!n || slotOf.has(n)) {
          while (occupied.has(spare) || slotOf.has(spare)) spare++;
          n = spare;
        }
        slotOf.set(n, p);
      }

      for (let n = 1; n <= slots; n++) {
        const col = Math.floor((n - 1) / 2);
        const row = (n - 1) % 2;
        const x = -width / 2 + 0.8 + BED_SPACING / 2 + col * BED_SPACING;
        const z = row === 0 ? -ROW_Z : ROW_Z;
        const patient = slotOf.get(n);
        if (patient) this.addBed(zone, patient, x, z, row, n);
        else this.addEmptyBed(zone, x, z, row);
      }

      this.wardZones.set(wardId, { group: zone, width, depth });
      cursorX += width + WARD_GAP;
    }

    // Centre everything around the origin
    const total = Math.max(0, cursorX - WARD_GAP);
    this.root3d.position.x = -total / 2;
    this.extent = Math.max(total, 10);
    const fit = Math.min(58, 15 + this.extent * 1.08);
    this.defaultDistance = fit;
    if (!this.layoutKey) {
      this.goal.distance = fit;
      this.view.distance = this.introStart ? fit * 1.45 : fit;
    }
  }

  addEmptyBed(zone, x, z, row) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = row === 0 ? 0 : Math.PI;
    const frame = new THREE.Mesh(this.geo.frame, this.mat.empty);
    frame.position.y = 0.2;
    g.add(frame);
    zone.add(g);
    this.emptyBeds.push(g);
  }

  addBed(zone, patient, x, z, row, slot) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = row === 0 ? 0 : Math.PI;   // headboards face the walls
    const intro = new THREE.Group();          // scaled during the intro
    g.add(intro);

    const add = (geo, mat, y, zOff = 0, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, y, zOff);
      m.castShadow = cast;
      m.receiveShadow = true;
      intro.add(m);
      return m;
    };
    add(this.geo.frame, this.mat.frame, 0.25);
    add(this.geo.mattress, this.mat.mattress, 0.47);
    const blanketMat = this.mat.blanket.clone();
    add(this.geo.blanket, blanketMat, 0.565, 0.32);
    add(this.geo.pillow, this.mat.pillow, 0.59, -0.72);
    add(this.geo.head, this.mat.head, 0.5, -1.08);

    // Bedside monitor (screen glows with the patient's status)
    const pole = add(this.geo.pole, this.mat.pole, 0.63, 0, true);
    pole.position.set(0.68, 0.63, -0.9);
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x0b0f14, emissive: 0x34D399, emissiveIntensity: 0.9, roughness: 0.3 });
    const screen = new THREE.Mesh(this.geo.screen, screenMat);
    screen.position.set(0.68, 1.32, -0.9);
    screen.rotation.y = -0.5;
    screen.castShadow = true;
    intro.add(screen);

    // Light pool on the floor
    const padMat = new THREE.MeshBasicMaterial({ map: this.glow, color: 0x34D399, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending });
    const pad = new THREE.Mesh(this.geo.pad, padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.05;
    g.add(pad);

    // Invisible hit box for picking
    const hit = new THREE.Mesh(this.geo.hit, this.mat.hit);
    hit.position.y = 0.6;
    hit.userData.patientId = patient.id;
    g.add(hit);

    zone.add(g);
    this.track(screenMat, padMat, blanketMat);

    const label = document.createElement("div");
    label.className = "floor-label";
    label.dataset.patient = patient.id;
    label.addEventListener("click", () => this.onSelect?.(patient.id));
    label.addEventListener("pointerenter", () => this.setHover(patient.id));
    label.addEventListener("pointerleave", () => this.setHover(null));
    this.labelLayer.appendChild(label);

    this.beds.set(patient.id, {
      group: g, intro, screenMat, padMat, blanketMat, hit, label,
      anchor: new THREE.Vector3(),
      status: null, dimmed: false, slot,
      delay: slot * 45
    });
  }

  // ------------------------------------------------------------
  // Live update
  // ------------------------------------------------------------

  update(patients, visibleIds = null) {
    const key = patients.map(p => `${p.id}:${p.wardId}:${p.bed}`).sort().join("|");
    if (key !== this.layoutKey) {
      this.rebuildLayout(patients);
      this.layoutKey = key;
    }

    for (const p of patients) {
      const bed = this.beds.get(p.id);
      if (!bed) continue;
      const color = STATUS_COLOR[p.status] ?? STATUS_COLOR.offline;
      const live = p.deviceStatus === "online";
      if (bed.status !== p.status) {
        bed.status = p.status;
        bed.screenMat.emissive.setHex(color);
        bed.padMat.color.setHex(color);
        bed.baseScreen = live ? (p.status === "critical" ? 1.6 : 0.9) : 0.15;
        bed.basePad = p.status === "critical" ? 0.9 : p.status === "warning" ? 0.65 : live ? 0.42 : 0.1;
        bed.blanketMat.color.setHex(0x33415a).lerp(new THREE.Color(color), live || p.status === "removed" ? 0.38 : 0.08);
        bed.screenMat.emissiveIntensity = bed.baseScreen;
        bed.padMat.opacity = bed.basePad;
      }
      bed.dimmed = visibleIds ? !visibleIds.has(p.id) : false;
      bed.label.style.opacity = bed.dimmed ? "0.2" : "";
      bed.padMat.opacity = bed.dimmed ? 0.03 : bed.basePad;

      // Label content (escaped; values from live state only)
      const vit = k => {
        const level = vitalLevel(p, k);
        const v = level === "stale" ? "--" : fmtVital(p.vitals?.[k], k);
        return `<span class="${level === "crit" ? "c" : level === "warn" ? "w" : ""}">${k === "hr" ? "HR" : k === "spo2" ? "SpO₂" : "T"} ${v}</span>`;
      };
      const short = p.name.split(" ").length > 1 ? `${p.name.split(" ")[0][0]}. ${p.name.split(" ").slice(-1)[0]}` : p.name;
      const html = `<div class="fl-top">${statusGlyph(p.status)}<span class="b">${esc(p.bed ?? "--")}</span>${esc(short)}</div><div class="fl-v">${vit("hr")}${vit("spo2")}${vit("temp")}</div>`;
      if (bed.labelHtml !== html) {
        bed.label.innerHTML = html;
        bed.labelHtml = html;
      }
      bed.label.className = `floor-label ${p.status}${this.compact ? " compact" : ""}`;
      bed.label.setAttribute("aria-label", `${p.name}, bed ${p.bed}, ${p.status}`);
    }
    this.requestRender();
  }

  // ------------------------------------------------------------
  // Camera & interaction
  // ------------------------------------------------------------

  resetView() {
    this.goal = { azimuth: -0.42, elevation: 1.0, distance: this.defaultDistance ?? 30 };
    this.requestRender();
  }

  bindEvents() {
    const c = this.canvas;
    let drag = null;

    this.onPointerDown = e => {
      drag = { x: e.clientX, y: e.clientY, az: this.goal.azimuth, el: this.goal.elevation, moved: false };
      c.setPointerCapture(e.pointerId);
    };
    this.onPointerMove = e => {
      const rect = c.getBoundingClientRect();
      this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        this.goal.azimuth = Math.max(-1.3, Math.min(1.3, drag.az - dx * 0.006));
        this.goal.elevation = Math.max(0.42, Math.min(1.35, drag.el + dy * 0.004));
        c.classList.toggle("dragging", drag.moved);
        this.requestRender();
      } else {
        this.pick();
      }
    };
    this.onPointerUp = e => {
      c.classList.remove("dragging");
      if (drag && !drag.moved) {
        this.pick();
        if (this.hovered !== null) this.onSelect?.(this.hovered);
      }
      drag = null;
      try { c.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    this.onLeave = () => { if (!drag) this.setHover(null); };
    this.onWheel = e => {
      e.preventDefault();
      const max = Math.max(48, 14 + (this.extent ?? 10));
      this.goal.distance = Math.max(9, Math.min(max, this.goal.distance * (1 + Math.sign(e.deltaY) * 0.08)));
      this.requestRender();
    };
    this.onKey = e => {
      const step = 0.12;
      if (e.key === "ArrowLeft") this.goal.azimuth = Math.max(-1.3, this.goal.azimuth - step);
      else if (e.key === "ArrowRight") this.goal.azimuth = Math.min(1.3, this.goal.azimuth + step);
      else if (e.key === "ArrowUp") this.goal.elevation = Math.min(1.35, this.goal.elevation + step);
      else if (e.key === "ArrowDown") this.goal.elevation = Math.max(0.42, this.goal.elevation - step);
      else if (e.key === "+" || e.key === "=") this.goal.distance = Math.max(9, this.goal.distance * 0.9);
      else if (e.key === "-") this.goal.distance = Math.min(60, this.goal.distance * 1.1);
      else if (e.key === "0") this.resetView();
      else return;
      e.preventDefault();
      this.requestRender();
    };
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointerleave", this.onLeave);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("keydown", this.onKey);
    c.addEventListener("dblclick", () => this.resetView());
  }

  pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.beds.values()].map(b => b.hit), false);
    this.setHover(hits.length ? hits[0].object.userData.patientId : null);
  }

  setHover(id) {
    if (this.hovered === id) return;
    this.hovered = id;
    this.canvas.style.cursor = id !== null ? "pointer" : "";
    for (const [pid, bed] of this.beds) bed.label.style.zIndex = pid === id ? "5" : "";
    this.requestRender();
  }

  requestRender() {
    this.needsRender = true;
  }

  resize() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // ------------------------------------------------------------
  // Frame loop (on-demand)
  // ------------------------------------------------------------

  loop(now) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || document.hidden) return;

    let animating = false;

    // Camera easing
    const k = reduced() ? 1 : 0.12;
    for (const key of ["azimuth", "elevation", "distance"]) {
      const d = this.goal[key] - this.view[key];
      if (Math.abs(d) > 1e-4) { this.view[key] += d * k; animating = true; }
      else this.view[key] = this.goal[key];
    }

    // Intro: beds rise in sequence
    if (this.introStart) {
      const t = now - this.introStart;
      let done = true;
      for (const bed of this.beds.values()) {
        const p = Math.max(0, Math.min(1, (t - bed.delay) / 520));
        const e = 1 - Math.pow(1 - p, 3);
        bed.intro.scale.set(1, Math.max(0.001, e), 1);
        bed.intro.position.y = (1 - e) * -0.2;
        if (p < 1) done = false;
      }
      if (done) this.introStart = null;
      animating = true;
    }

    // Hover lift
    for (const [id, bed] of this.beds) {
      const goalY = id === this.hovered ? 0.08 : 0;
      const d = goalY - bed.group.position.y;
      if (Math.abs(d) > 1e-3) { bed.group.position.y += d * 0.2; animating = true; }
    }

    // Critical beds breathe (slow, never flashing)
    const critical = [...this.beds.values()].filter(b => b.status === "critical" && !b.dimmed);
    if (critical.length && !reduced()) {
      const s = 0.5 + 0.5 * Math.sin(now / 650);
      for (const bed of critical) {
        bed.padMat.opacity = bed.basePad * (0.65 + 0.55 * s);
        bed.screenMat.emissiveIntensity = bed.baseScreen * (0.75 + 0.35 * s);
      }
      animating = true;
    }

    if (!animating && !this.needsRender) return;
    this.needsRender = false;

    // Position camera on a sphere around the target
    const { azimuth, elevation, distance } = this.view;
    this.camera.position.set(
      this.target.x + Math.sin(azimuth) * Math.cos(elevation) * distance,
      this.target.y + Math.sin(elevation) * distance,
      this.target.z + Math.cos(azimuth) * Math.cos(elevation) * distance
    );
    this.camera.lookAt(this.target);

    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  placeLabels() {
    if (!this.showLabels) return;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    const compact = this.view.distance > 38;
    for (const bed of this.beds.values()) {
      bed.group.getWorldPosition(bed.anchor);
      bed.anchor.y += 1.75;
      bed.anchor.project(this.camera);
      const behind = bed.anchor.z > 1;
      const x = (bed.anchor.x * 0.5 + 0.5) * w;
      const y = (-bed.anchor.y * 0.5 + 0.5) * h;
      bed.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      bed.label.style.visibility = behind || x < -80 || x > w + 80 || y < -40 || y > h + 80 ? "hidden" : "visible";
      if (compact !== bed.label.classList.contains("compact")) bed.label.classList.toggle("compact", compact);
    }
    this.compact = compact;
  }

  // ------------------------------------------------------------

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.io.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onLeave);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("keydown", this.onKey);
    for (const item of this.disposables) item.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.root.innerHTML = "";
  }
}
