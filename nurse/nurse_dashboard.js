// nurse/nurse_dashboard.js
import { stateStore } from '../shared/state_store.js';
import { mqttClient } from '../shared/mqtt_client.js';
import { alertEngine } from '../shared/alert_engine.js';
import { getMLBadge } from '../shared/ml_indicators.js';
import { OverrideClient } from '../shared/override_client.js';
import { DeviceRegistry } from '../shared/device_registry.js';
import { startSimulation } from '../shared/simulation.js';

let selectedDeviceId = null;
let renderRequested = false;

// DOM Elements
const dom = {
  clock: document.getElementById('topbar-clock'),
  grid: document.getElementById('bed-grid'),
  kpiActive: document.getElementById('kpi-active'),
  kpiCritical: document.getElementById('kpi-critical'),
  kpiDevices: document.getElementById('kpi-devices'),
  kpiHealth: document.getElementById('kpi-health'),
  kpiLastPacket: document.getElementById('kpi-last-packet'),
  mqttDot: document.getElementById('sidebar-mqtt-dot'),
  mqttText: document.getElementById('sidebar-mqtt-text'),
  alertsContainer: document.getElementById('alerts-container'),
  rawBanner: document.getElementById('raw-mode-banner'),
  drawer: {
    panel: document.getElementById('patient-drawer'),
    closeBtn: document.getElementById('close-drawer-btn'),
    bed: document.getElementById('drawer-bed'),
    name: document.getElementById('drawer-name'),
    hr: document.getElementById('drawer-hr'),
    spo2: document.getElementById('drawer-spo2'),
    temp: document.getElementById('drawer-temp'),
    mlBadge: document.getElementById('drawer-ml-badge'),
    emergencyPanel: document.getElementById('drawer-emergency-panel'),
    emergencyMsg: document.getElementById('drawer-emergency-msg'),
    btnAck: document.getElementById('btn-ack'),
    btnCodeBlue: document.getElementById('btn-code-blue'),
    btnReqDoc: document.getElementById('btn-req-doc'),
    btnAddNote: document.getElementById('btn-add-note')
  },
  navEmergencyCount: document.getElementById('nav-emergency-count'),
  btnSimulate: document.getElementById('toggle-sim-btn')
};

// Initialize
function init() {
  updateClock();
  setInterval(updateClock, 1000);

  // Setup Registry Fake Beds
  DeviceRegistry.getAllDevices().forEach(dev => {
    stateStore.updateState({
      device_id: dev.deviceId,
      hr: '--', spo2: '--', temp: '--', emergency: 'OK',
      topic: 'init'
    });
  });

  stateStore.subscribe(() => requestRender());
  
  window.addEventListener('mqtt-status', (e) => {
    const status = e.detail;
    dom.mqttText.textContent = status;
    dom.mqttDot.className = 'status-dot';
    
    if (status === 'CONNECTED') {
      dom.mqttDot.classList.add('connected');
      dom.kpiHealth.textContent = 'ONLINE';
      dom.kpiHealth.style.color = 'var(--ok)';
      dom.rawBanner.classList.remove('active');
    } else if (status === 'CONNECTING') {
      dom.mqttDot.classList.add('connecting');
      dom.kpiHealth.textContent = 'CONNECTING';
      dom.kpiHealth.style.color = 'var(--warning)';
    } else if (status === 'RAW MODE') {
      dom.mqttDot.classList.add('raw');
      dom.kpiHealth.textContent = 'RAW FALLBACK';
      dom.kpiHealth.style.color = 'var(--warning)';
      dom.rawBanner.classList.add('active');
    } else {
      dom.kpiHealth.textContent = 'OFFLINE';
      dom.kpiHealth.style.color = 'var(--offline)';
    }
  });

  alertEngine.subscribe(renderToast);

  dom.drawer.closeBtn.addEventListener('click', () => {
    selectedDeviceId = null;
    dom.drawer.panel.classList.remove('open');
    requestRender();
  });

  dom.grid.addEventListener('mousedown', (e) => {
    const card = e.target.closest('.bed-card');
    if (card) {
      selectedDeviceId = parseInt(card.getAttribute('data-id'));
      dom.drawer.panel.classList.add('open');
      requestRender();
    }
  });

  dom.btnSimulate.addEventListener('click', () => {
    startSimulation();
    dom.btnSimulate.style.display = 'none';
  });

  setupOverrideButtons();
  
  mqttClient.connect();
  requestRender();
}

function updateClock() {
  const now = new Date();
  dom.clock.textContent = now.toLocaleTimeString('en-US', { hour12: false });
}

// Rendering Loop
function requestRender() {
  if (!renderRequested) {
    renderRequested = true;
    requestAnimationFrame(render);
  }
}

function escapeHTML(str) {
  if (!str) return '';
  return str.toString().replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag])
  );
}

function render() {
  renderRequested = false;
  
  const states = stateStore.getAllStates();
  
  // Update KPIs
  let activeCount = 0;
  let criticalCount = 0;
  let deviceCount = states.length;
  
  const gridHTML = states.map(state => {
    if (state.status !== 'offline' && state.status !== 'removed') activeCount++;
    if (state.status === 'critical') criticalCount++;

    const badge = getMLBadge(state.mlMeta, state.vitals.hr);
    const isSelected = selectedDeviceId === state.deviceId;
    
    // Time since last seen
    const ageMs = Date.now() - state.lastSeen;
    let ageStr = 'Just now';
    if (ageMs > 60000) ageStr = `${Math.floor(ageMs/60000)}m ago`;
    else if (ageMs > 5000) ageStr = `${Math.floor(ageMs/1000)}s ago`;
    if (state.status === 'offline') ageStr = 'Offline';

    return `
      <div class="bed-card status-${state.status} ${isSelected ? 'selected' : ''}" data-id="${state.deviceId}">
        <div class="bed-header">
          <span>BED ${escapeHTML(state.bed)}</span>
          <span style="font-size:0.75rem; color:var(--text-muted)">${ageStr}</span>
        </div>
        <div class="bed-patient">${escapeHTML(state.patientName)}</div>
        
        <div class="vitals-grid">
          <div class="vital-main">
            <span class="value">${escapeHTML(state.vitals.hr)}</span>
            <span class="vital-label">BPM</span>
          </div>
          <div class="vital-sub spo2">
            <span class="value">${escapeHTML(state.vitals.spo2)}%</span>
            <span class="vital-label">SpO₂</span>
          </div>
          <div class="vital-sub temp">
            <span class="value">${escapeHTML(state.vitals.temp)}°</span>
            <span class="vital-label">TEMP</span>
          </div>
        </div>

        <div class="bed-footer">
          <span class="ml-badge ${badge.style}">${badge.label}</span>
          <span style="color:var(--${state.status === 'critical' ? 'critical' : (state.status === 'warning' ? 'warning' : 'text-muted')})">
            ${state.status.toUpperCase()}
          </span>
        </div>
      </div>
    `;
  }).join('');

  if (dom.grid.innerHTML !== gridHTML) {
    dom.grid.innerHTML = gridHTML;
  }

  dom.kpiActive.textContent = activeCount;
  dom.kpiCritical.textContent = criticalCount;
  dom.kpiDevices.textContent = deviceCount;
  dom.kpiLastPacket.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
  
  if (criticalCount > 0) {
    dom.navEmergencyCount.textContent = criticalCount;
    dom.navEmergencyCount.style.display = 'inline-block';
  } else {
    dom.navEmergencyCount.style.display = 'none';
  }

  // Update Drawer if open
  if (selectedDeviceId) {
    const state = stateStore.getState(selectedDeviceId);
    if (state) {
      dom.drawer.bed.textContent = `BED ${state.bed} · ${state.ward}`;
      dom.drawer.name.textContent = state.patientName;
      dom.drawer.hr.innerHTML = `${escapeHTML(state.vitals.hr)} <span style="font-size:1rem; color:var(--text-muted)">bpm</span>`;
      dom.drawer.spo2.innerHTML = `${escapeHTML(state.vitals.spo2)}<span style="font-size:1rem; color:var(--text-muted)">%</span>`;
      dom.drawer.temp.innerHTML = `${escapeHTML(state.vitals.temp)}<span style="font-size:1rem; color:var(--text-muted)">°C</span>`;
      
      const badge = getMLBadge(state.mlMeta, state.vitals.hr);
      dom.drawer.mlBadge.textContent = badge.label;
      dom.drawer.mlBadge.className = `ml-badge ${badge.style}`;

      if (state.status === 'critical') {
        dom.drawer.emergencyPanel.classList.add('active');
        if (state.mlMeta.anomalyDetected) {
          dom.drawer.emergencyMsg.innerHTML = "Verify patient physically before acting. The reading may be affected by an anomaly/interference.";
          dom.drawer.emergencyMsg.style.color = 'var(--warning)';
        } else {
          dom.drawer.emergencyMsg.innerHTML = "Verify patient immediately.";
          dom.drawer.emergencyMsg.style.color = 'var(--text)';
        }
      } else {
        dom.drawer.emergencyPanel.classList.remove('active');
      }
    }
  }
}

// Toast Alerts
function renderToast(alert) {
  const toast = document.createElement('div');
  toast.className = `toast type-${alert.type}`;
  toast.innerHTML = `
    <div class="toast-header">${alert.type === 'CRITICAL' ? '🚨' : '⚠'} ${alert.type}</div>
    <div class="toast-body">
      <strong>Bed ${escapeHTML(alert.bed)} · ${escapeHTML(alert.patientName)}</strong><br>
      ${escapeHTML(alert.message)}<br>
      ${alert.vitals ? `HR: ${alert.vitals.hr} | SpO₂: ${alert.vitals.spo2}%` : ''}
    </div>
  `;
  dom.alertsContainer.appendChild(toast);
  
  // Auto remove toast after a while visually
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 8000);
}

function setupOverrideButtons() {
  const act = async (actionFn, actionName) => {
    if (!selectedDeviceId) return;
    const state = stateStore.getState(selectedDeviceId);
    if (!state) return;
    await actionFn(selectedDeviceId, state.seq);
    alert(`${actionName} triggered for ${state.patientName}`);
  };

  dom.drawer.btnAck.addEventListener('click', () => act(OverrideClient.acknowledge, 'Acknowledge'));
  dom.drawer.btnCodeBlue.addEventListener('click', () => act(OverrideClient.callCodeBlue, 'Code Blue'));
  dom.drawer.btnReqDoc.addEventListener('click', () => act(OverrideClient.requestDoctor, 'Doctor Requested'));
  dom.drawer.btnAddNote.addEventListener('click', () => {
    if (!selectedDeviceId) return;
    const note = prompt("Enter clinical note:");
    if (note) OverrideClient.addNote(selectedDeviceId, note);
  });
}

init();
