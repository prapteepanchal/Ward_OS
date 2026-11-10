# WardOS — Audit & Change Record

A copy of the pre-rebuild source (including uncommitted work) is kept at `../_backup_before_rebuild/WardOS`. `WardOS.zip` was an older snapshot of the same tree.

## 1. What existed

- Static HTML/JS only — **no backend, no database**.
- `index.js` login accepted **any** staff ID/password; the patient "login" only stored a typed name in `localStorage`.
- `nurse_dashboard.js` (3,389 lines) connected straight to MQTT from the browser and had `ENABLE_DEVELOPMENT_SIMULATION = true`, which **fabricated vitals in the page**.
- `device_registry.js` was a hardcoded mock; `override_client.js` only logged to the console; `history_store.js` was in-memory only.
- The doctor page was minimal; the patient page was a stub.
- About 15 empty placeholder files. `nurse.html` showed hardcoded "🟢 Connected / Latency 18 ms".

## 2. Bugs and risks found

| # | Issue | Fix |
|---|---|---|
| 1 | Any browser on the broker can subscribe to every patient's vitals, so patient isolation was impossible | MQTT moved to the server; browsers receive only their permitted patients over SSE |
| 2 | No real authentication, roles or permissions | Hashed passwords (scrypt), server sessions in HttpOnly cookies, per-endpoint permission checks, CSRF header, login throttling, audit log |
| 3 | `AlertEngine.resolveCondition()` was never called, and its key format didn't match the StateStore condition keys, so alerts never closed when vitals recovered | StateStore now reports cleared conditions; the engine is keyed by patient + condition |
| 4 | Unacknowledged **critical** alerts silently expired after 5 minutes | Critical alerts never expire; only non-critical alerts auto-clear, and only after the condition has cleared |
| 5 | TTLs had drifted from the committed 30 s / 10 s / 15 s to 5 min / 60 s / 30 s | The original values are restored as the "clear grace" period (documented in `shared/config.js`) |
| 6 | Sensor REMOVED kept the previous temperature on screen | Removal clears all vitals |
| 7 | Raw-topic frames could overwrite fresher cleaned values | Cleaned data wins; raw is used only when cleaned data is stale |
| 8 | Broker loss made every device look "offline" | A separate `link-lost` state; no device alerts while the server cannot see the broker |
| 9 | `AudioContext` was created per beep with no unlock handling | A single context, unlocked on first interaction, with a mute toggle and a header indicator |
| 10 | Unescaped MQTT values in `innerHTML` | All dynamic text is escaped; strict CSP |
| 11 | A module-level `setInterval` in the alert engine; timers were never cleared | Timers are owned, unref'd and stoppable |
| 12 | Message-callback events from stale MQTT clients | Active-client guard |

## 3. Preserved behaviour

These were kept on purpose:

- Broker URL `ws://localhost:9001/mqtt`, topics `wardos/cleaned/vitals` and `wearable/data`, and the payload format. The only change is an optional `sim` flag sent by the simulator.
- `MqttClientManager`:
  - message queue drained every 50 ms (50 per tick)
  - manual exponential backoff
  - RAW mode after 10 s of silence (checked every 2 s)
  - statuses OFFLINE / CONNECTING / CONNECTED / RAW MODE
  - `mqtt-status` events
- `StateStore.deriveStatus()` ordering: removed > emergency/critical > anomaly > warning > ok. Connectivity is layered on top of it.
- Device offline after 6 s (the original dashboard value).
- ML badges keep their meanings. Anomaly flags are described as signal quality, not clinical findings.

## 4. Threshold note

The project brief asked for HR < 50 / > 120, SpO₂ < 90 and Temp > 38. The existing code had critical tiers of HR 40/140, SpO₂ 90 and Temp 39. Both are kept:

- The brief's values are the **warning** tier.
- The original values are the **critical** tier.
- SpO₂ < 90 is critical, as specified.

## 5. Known limitations / not done

- No admin UI for creating staff accounts. Accounts come from the seed file or from direct database inserts. A small admin CLI is the next step.
- The external clinician override / ML-flag API (`:5050`) from the frontend requirements document is not part of this repository and is not wired up. Clinical actions (notes, doctor request, code blue) are stored and audited by WardOS itself.
- Code blue is **recorded**, not paged. The UI says so.
- No service worker:
  - If the server process is down, pages cannot load.
  - Pages already open keep working from the IndexedDB cache, including offline reports marked INCOMPLETE.
- HTTPS/WSS needs a reverse proxy or a certificate. Set `SECURE_COOKIES=1` when using one.
- Not validated for clinical use. This needs a security review and clinical-safety validation before any real deployment.
