// ============================================================
// WardOS - Sign-in hero scene (illustrative, not patient data)
//
// Rows of beds across a ward floor; each band sends small
// telemetry packets along arcs to the local WardOS hub. A
// visual explanation of the system, rendered with three.js.
// Instanced geometry, ~30 fps cap, paused when hidden, a single
// still frame under prefers-reduced-motion.
// ============================================================

import * as THREE from "../lib/three/three.module.js";

export function startLoginScene(host) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return () => {};
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-hidden", "true");

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0f15, 24, 58);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);

  scene.add(new THREE.HemisphereLight(0xb8d0ff, 0x090c11, 0.7));
  const key = new THREE.DirectionalLight(0xfff1e0, 1.2);
  key.position.set(-8, 14, 10);
  scene.add(key);

  const disposables = [];
  const keep = (...x) => { disposables.push(...x); return x[0]; };

  // Floor grid
  const grid = new THREE.GridHelper(80, 64, 0x1c2633, 0x141b25);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);
  keep(grid.geometry, grid.material);

  // Beds (instanced): frame + mattress + status light
  const COLS = 9, ROWS = 4;
  const beds = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = (c - (COLS - 1) / 2) * 2.3;
      const z = (r - (ROWS - 1) / 2) * 3.6 + (r % 2 ? 0.5 : -0.5);
      beds.push({ x, z, flip: r % 2 === 1 });
    }
  }
  const frameGeo = keep(new THREE.BoxGeometry(1.0, 0.32, 2.05));
  const matGeo = keep(new THREE.BoxGeometry(0.9, 0.12, 1.9));
  const lightGeo = keep(new THREE.BoxGeometry(0.42, 0.04, 0.12));
  const frameMat = keep(new THREE.MeshStandardMaterial({ color: 0x252e3d, roughness: 0.6, metalness: 0.4 }));
  const mattMat = keep(new THREE.MeshStandardMaterial({ color: 0x6f7c92, roughness: 0.9 }));
  const lightMat = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const frames = new THREE.InstancedMesh(frameGeo, frameMat, beds.length);
  const matts = new THREE.InstancedMesh(matGeo, mattMat, beds.length);
  const lights = new THREE.InstancedMesh(lightGeo, lightMat, beds.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);

  // Status mix: mostly stable, a few warnings, one critical
  const palette = { ok: new THREE.Color(0x34D399), warn: new THREE.Color(0xFBBF24), crit: new THREE.Color(0xF87171) };
  const critIndex = 13;
  beds.forEach((b, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.flip ? Math.PI : 0);
    m.compose(new THREE.Vector3(b.x, 0.2, b.z), q, one); frames.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(b.x, 0.42, b.z), q, one); matts.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(b.x, 0.5, b.z + (b.flip ? 1.08 : -1.08)), q, one); lights.setMatrixAt(i, m);
    b.status = i === critIndex ? "crit" : [5, 22, 31].includes(i) ? "warn" : "ok";
    lights.setColorAt(i, palette[b.status]);
  });
  scene.add(frames, matts, lights);

  // Hub (the local WardOS server)
  const hub = new THREE.Group();
  hub.position.set(0, 0, -9.5);
  const coreGeo = keep(new THREE.CylinderGeometry(0.55, 0.7, 2.6, 6));
  const coreMat = keep(new THREE.MeshStandardMaterial({ color: 0x10241f, emissive: 0x10b981, emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.6 }));
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.y = 1.3;
  hub.add(core);
  const ringGeo = keep(new THREE.TorusGeometry(1.25, 0.025, 8, 64));
  const ringMat = keep(new THREE.MeshBasicMaterial({ color: 0x34D399, transparent: true, opacity: 0.55 }));
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  hub.add(ring);
  const ring2 = new THREE.Mesh(ringGeo, keep(ringMat.clone()));
  ring2.rotation.x = Math.PI / 2;
  ring2.position.y = 0.05;
  hub.add(ring2);
  scene.add(hub);

  // Telemetry packets travelling bed -> hub on arcs
  const PACKETS = 70;
  const packetGeo = keep(new THREE.BufferGeometry());
  const positions = new Float32Array(PACKETS * 3);
  const colors = new Float32Array(PACKETS * 3);
  packetGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  packetGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const dot = document.createElement("canvas");
  dot.width = dot.height = 32;
  const g = dot.getContext("2d");
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const dotTex = keep(new THREE.CanvasTexture(dot));
  const packetMat = keep(new THREE.PointsMaterial({ size: 0.32, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(new THREE.Points(packetGeo, packetMat));

  const hubPoint = new THREE.Vector3(0, 2.1, -9.5);
  const packets = Array.from({ length: PACKETS }, (_, i) => spawn({}, i / PACKETS));
  function spawn(p, phase = 0) {
    const b = beds[Math.floor(Math.random() * beds.length)];
    p.from = new THREE.Vector3(b.x, 0.6, b.z);
    p.mid = new THREE.Vector3((b.x + hubPoint.x) / 2, 3.2 + Math.random() * 1.8, (b.z + hubPoint.z) / 2);
    p.t = phase;
    p.speed = 0.18 + Math.random() * 0.12;
    p.color = palette[b.status];
    return p;
  }
  const curvePoint = new THREE.Vector3();
  function quad(p, t) {
    const u = 1 - t;
    curvePoint.set(
      u * u * p.from.x + 2 * u * t * p.mid.x + t * t * hubPoint.x,
      u * u * p.from.y + 2 * u * t * p.mid.y + t * t * hubPoint.y,
      u * u * p.from.z + 2 * u * t * p.mid.z + t * t * hubPoint.z
    );
    return curvePoint;
  }

  // ---------------- loop ----------------
  let raf = 0, last = 0, running = true, elapsed = 0;
  const target = new THREE.Vector3(-6.5, 0.4, -3);

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    if (now - last < 33) return;           // ~30 fps is plenty
    const dt = Math.min(0.1, (now - last) / 1000 || 0.016);
    last = now;
    elapsed += dt;
    draw(dt);
  }

  function draw(dt) {
    // Slow orbital drift
    const a = -0.5 + Math.sin(elapsed * 0.05) * 0.22;
    camera.position.set(-4 + Math.sin(a) * 31, 14 + Math.sin(elapsed * 0.07) * 0.6, Math.cos(a) * 31);
    camera.lookAt(target);

    for (let i = 0; i < PACKETS; i++) {
      const p = packets[i];
      p.t += p.speed * dt;
      if (p.t >= 1) spawn(p);
      const pt = quad(p, p.t);
      positions[i * 3] = pt.x; positions[i * 3 + 1] = pt.y; positions[i * 3 + 2] = pt.z;
      const fade = Math.sin(Math.PI * Math.min(1, p.t)) * 0.95;
      colors[i * 3] = p.color.r * fade; colors[i * 3 + 1] = p.color.g * fade; colors[i * 3 + 2] = p.color.b * fade;
    }
    packetGeo.attributes.position.needsUpdate = true;
    packetGeo.attributes.color.needsUpdate = true;

    // Critical bed breathes; hub rings expand as data arrives
    const s = 0.5 + 0.5 * Math.sin(elapsed * 2.6);
    lights.setColorAt(critIndex, palette.crit.clone().multiplyScalar(0.55 + 0.6 * s));
    lights.instanceColor.needsUpdate = true;
    const r1 = (elapsed * 0.35) % 1, r2 = (elapsed * 0.35 + 0.5) % 1;
    ring.scale.setScalar(1 + r1 * 2.2); ring.material.opacity = 0.5 * (1 - r1);
    ring2.scale.setScalar(1 + r2 * 2.2); ring2.material.opacity = 0.5 * (1 - r2);
    core.rotation.y += dt * 0.25;

    renderer.render(scene, camera);
  }

  const ro = new ResizeObserver(() => { resize(); if (reduced) draw(0); });
  ro.observe(host);
  resize();

  if (reduced) {
    elapsed = 4;
    draw(0);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return function stop() {
    running = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    for (const d of disposables) d.dispose?.();
    frames.dispose(); matts.dispose(); lights.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
