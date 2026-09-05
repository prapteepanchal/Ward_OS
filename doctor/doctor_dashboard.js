// doctor/doctor_dashboard.js
import { stateStore } from '../shared/state_store.js';
import { mqttClient } from '../shared/mqtt_client.js';
import { historyStore } from '../shared/history_store.js';
import { getMLBadge } from '../shared/ml_indicators.js';
import { DeviceRegistry } from '../shared/device_registry.js';
import { startSimulation } from '../shared/simulation.js';

let selectedDeviceId = null;
let charts = {};
let renderRequested = false;

const dom = {
  clock: document.getElementById('topbar-clock'),
  list: document.getElementById('patient-list'),
  count: document.getElementById('patient-count'),
  emptyState: document.getElementById('empty-state'),
  detailView: document.getElementById('patient-detail-view'),
  
  detailName: document.getElementById('detail-name'),
  detailBed: document.getElementById('detail-bed'),
  detailWard: document.getElementById('detail-ward'),
  detailId: document.getElementById('detail-id'),
  detailHr: document.getElementById('detail-hr'),
  detailSpo2: document.getElementById('detail-spo2'),
  detailTemp: document.getElementById('detail-temp'),
  detailMlBadge: document.getElementById('detail-ml-badge'),

  tabs: document.querySelectorAll('.tab'),
  tabContents: document.querySelectorAll('.tab-content'),

  mqttDot: document.getElementById('sidebar-mqtt-dot'),
  mqttText: document.getElementById('sidebar-mqtt-text'),
  rawBanner: document.getElementById('raw-mode-banner'),
  btnSimulate: document.getElementById('toggle-sim-btn')
};

// Colors matching CSS vars
const colors = {
  hr: '#34D399',
  spo2: '#22D3EE',
  anomaly: '#A78BFA',
  rawLine: 'rgba(138, 151, 171, 0.4)'
};

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
      dom.rawBanner.classList.remove('active');
    } else if (status === 'CONNECTING') {
      dom.mqttDot.classList.add('connecting');
    } else if (status === 'RAW MODE') {
      dom.mqttDot.classList.add('raw');
      dom.rawBanner.classList.add('active');
    }
  });

  dom.btnSimulate.addEventListener('click', () => {
    startSimulation();
    dom.btnSimulate.style.display = 'none';
  });

  dom.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      dom.tabs.forEach(t => t.classList.remove('active'));
      dom.tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.getAttribute('data-target')).classList.add('active');
    });
  });

  mqttClient.connect();
  requestRender();
}

function updateClock() {
  dom.clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}

function escapeHTML(str) {
  if (!str) return '';
  return str.toString().replace(/[&<>'"]/g, 
    tag => ({'&': '&amp;','<': '&lt;','>': '&gt;',"'": '&#39;','"': '&quot;'}[tag])
  );
}

function requestRender() {
  if (!renderRequested) {
    renderRequested = true;
    requestAnimationFrame(render);
  }
}

function render() {
  renderRequested = false;
  const states = stateStore.getAllStates();
  
  dom.count.textContent = states.length;

  const listHTML = states.map(state => {
    const isSelected = selectedDeviceId === state.deviceId;
    return `
      <div class="list-item ${isSelected ? 'selected' : ''}" data-id="${state.deviceId}">
        <div class="list-item-header">
          <span class="list-item-name">${escapeHTML(state.patientName)}</span>
          <span style="color:var(--${state.status === 'critical' ? 'critical' : (state.status === 'warning' ? 'warning' : 'text-muted')})">
            ${state.status.toUpperCase()}
          </span>
        </div>
        <div class="list-item-bed">Bed ${escapeHTML(state.bed)} · ${escapeHTML(state.ward)}</div>
        <div class="list-item-vitals mt-1">
          <span class="text-hr">HR: ${escapeHTML(state.vitals.hr)}</span>
          <span class="text-spo2">SpO₂: ${escapeHTML(state.vitals.spo2)}%</span>
        </div>
      </div>
    `;
  }).join('');

  if (dom.list.innerHTML !== listHTML) {
    dom.list.innerHTML = listHTML;
    dom.list.querySelectorAll('.list-item').forEach(el => {
      el.addEventListener('click', () => {
        selectPatient(parseInt(el.getAttribute('data-id')));
      });
    });
  }

  updateDetailView();
}

function selectPatient(deviceId) {
  selectedDeviceId = deviceId;
  dom.emptyState.style.display = 'none';
  dom.detailView.style.display = 'block';
  
  // Rebuild charts from scratch to avoid lingering data
  destroyCharts();
  createCharts();
  
  requestRender();
}

function updateDetailView() {
  if (!selectedDeviceId) return;
  const state = stateStore.getState(selectedDeviceId);
  if (!state) return;

  dom.detailName.textContent = state.patientName;
  dom.detailBed.textContent = state.bed;
  dom.detailWard.textContent = state.ward;
  dom.detailId.textContent = state.id;
  
  dom.detailHr.textContent = state.vitals.hr;
  dom.detailSpo2.textContent = state.vitals.spo2;
  dom.detailTemp.textContent = state.vitals.temp;

  const badge = getMLBadge(state.mlMeta, state.vitals.hr);
  dom.detailMlBadge.textContent = badge.label;
  dom.detailMlBadge.className = `ml-badge ${badge.style}`;

  updateCharts();
}

function destroyCharts() {
  if (charts.hr) charts.hr.destroy();
  if (charts.spo2) charts.spo2.destroy();
  charts = {};
}

function createCharts() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = '#8A97AB';
  Chart.defaults.font.family = "'IBM Plex Mono', monospace";
  
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false }
    },
    scales: {
      x: { type: 'category', display: false },
      y: { grid: { color: 'rgba(255,255,255,0.05)' } }
    }
  };

  const ctxHr = document.getElementById('chart-hr').getContext('2d');
  charts.hr = new Chart(ctxHr, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      ...commonOptions,
      scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, min: 40, max: 180 } }
    }
  });

  const ctxSpo2 = document.getElementById('chart-spo2').getContext('2d');
  charts.spo2 = new Chart(ctxSpo2, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      ...commonOptions,
      scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, min: 75, max: 100 } }
    }
  });
}

// Throttle chart updates
let lastChartUpdate = 0;

function updateCharts() {
  if (!selectedDeviceId || !charts.hr) return;
  
  const now = Date.now();
  if (now - lastChartUpdate < 1000) return; // Max 1 fps for charts
  lastChartUpdate = now;

  const hist = historyStore.getHistory(selectedDeviceId);
  
  // Prepare HR data
  const labels = hist.clean.map((_, i) => i);
  const hrCleanData = hist.clean.map(s => s.hr === 'REMOVED' ? null : parseInt(s.hr));
  const hrRawData = hist.raw.map(s => s.hr === 'REMOVED' ? null : parseInt(s.hr));
  
  // Find anomalies for point colors
  const pointColors = hist.clean.map(s => s.anomalyDetected ? colors.anomaly : colors.hr);
  const pointRadius = hist.clean.map(s => s.anomalyDetected ? 5 : 0);

  charts.hr.data = {
    labels: labels,
    datasets: [
      {
        label: 'Clean HR',
        data: hrCleanData,
        borderColor: colors.hr,
        borderWidth: 2,
        tension: 0.3,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        pointRadius: pointRadius
      },
      {
        label: 'Raw HR',
        data: hrRawData,
        borderColor: colors.rawLine,
        borderWidth: 1,
        borderDash: [5, 5],
        tension: 0.1,
        pointRadius: 0
      }
    ]
  };
  
  // Prepare SpO2
  const spo2CleanData = hist.clean.map(s => s.spo2 === 'REMOVED' ? null : parseInt(s.spo2));
  charts.spo2.data = {
    labels: labels,
    datasets: [{
      label: 'Clean SpO2',
      data: spo2CleanData,
      borderColor: colors.spo2,
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 0
    }]
  };

  charts.hr.update();
  charts.spo2.update();
}

init();
