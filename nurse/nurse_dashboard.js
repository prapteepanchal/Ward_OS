// ============================================================
// WARDOS — NURSE COMMAND CENTER
// File: nurse/nurse_dashboard.js
// ============================================================

import { stateStore } from "../shared/state_store.js";
import { mqttClient } from "../shared/mqtt_client.js";
import { alertEngine } from "../shared/alert_engine.js";
import { getMLBadge } from "../shared/ml_indicators.js";
import { DeviceRegistry } from "../shared/device_registry.js";
import { startSimulation } from "../shared/simulation.js";


// ============================================================
// DEVELOPMENT SETTINGS
// ============================================================

// Keep TRUE while we build/test the UI without the real broker.
// Later, when real MQTT is ready, we will set this to false.
const ENABLE_DEVELOPMENT_SIMULATION = true;

const OFFLINE_TIMEOUT_MS = 6000;


// ============================================================
// LOCAL UI STATE
// ============================================================

let selectedDeviceId = null;

let currentStatusFilter = "all";

let currentSort = "priority";

let currentView = "grid";

let renderRequested = false;

let simulationStarted = false;

const activeAlerts = [];


// ============================================================
// DOM REFERENCES
// ============================================================

const dom = {

    // Header
    globalSearch:
        document.getElementById("globalSearch"),

    currentDate:
        document.getElementById("currentDate"),

    lastSyncTime:
        document.getElementById("lastSyncTime"),

    notificationButton:
        document.getElementById("notificationButton"),

    notificationCount:
        document.getElementById("notificationCount"),

    // Sidebar
    patientNavCount:
        document.getElementById("patientNavCount"),

    emergencyNavCount:
        document.getElementById("emergencyNavCount"),

    mqttIndicator:
        document.getElementById("mqttIndicator"),

    mqttStatus:
        document.getElementById("mqttStatus"),

    mqttLatency:
        document.getElementById("mqttLatency"),

    // KPIs
    totalPatients:
        document.getElementById("totalPatients"),

    stablePatients:
        document.getElementById("stablePatients"),

    alertPatients:
        document.getElementById("alertPatients"),

    criticalPatients:
        document.getElementById("criticalPatients"),

    offlineDevices:
        document.getElementById("offlineDevices"),

    // Controls
    statusFilter:
        document.getElementById("statusFilter"),

    sortPatients:
        document.getElementById("sortPatients"),

    viewButtons:
        document.querySelectorAll(".view-button"),

    // Grid
    patientGrid:
        document.getElementById("patientGrid"),

    // Detail
    patientDetailSection:
        document.getElementById("patientDetailSection"),

    patientDetail:
        document.getElementById("patientDetail"),

    closePatientDetail:
        document.getElementById("closePatientDetail"),

    // Alerts
    alertList:
        document.getElementById("alertList"),

    activeAlertCount:
        document.getElementById("activeAlertCount"),

    // Notifications
    notificationPanel:
        document.getElementById("notificationPanel"),

    closeNotifications:
        document.getElementById("closeNotifications"),

    notificationList:
        document.getElementById("notificationList"),

    // Mobile
    sidebar:
        document.getElementById("sidebar"),

    mobileMenuButton:
        document.getElementById("mobileMenuButton")
};


// ============================================================
// INITIALIZE
// ============================================================

function init() {

    console.log(
        "WardOS Nurse Command Center initializing..."
    );


    setupRegisteredBeds();

    setupEventListeners();

    setupStateSubscription();

    setupAlertSubscription();

    setupMQTTStatusListener();

    updateDateAndTime();

    setInterval(
        updateDateAndTime,
        1000
    );


    // Periodically mark stale devices offline.
    setInterval(
        checkOfflineDevices,
        2000
    );


    // Start real MQTT connection attempt.
    try {

        mqttClient.connect();

    } catch (error) {

        console.warn(
            "WardOS MQTT initialization failed:",
            error
        );

    }


    // During development, start simulation automatically.
    if (
        ENABLE_DEVELOPMENT_SIMULATION
    ) {

        setTimeout(
            startDevelopmentSimulation,
            1200
        );

    }


    requestRender();


    console.log(
        "WardOS Nurse Command Center ready."
    );
}


// ============================================================
// INITIAL DEVICE STATES
// ============================================================

function setupRegisteredBeds() {

    const devices =
        DeviceRegistry.getAllDevices();


    devices.forEach(device => {

        stateStore.updateState({

            device_id:
                device.deviceId,

            seq: 0,

            hr: "--",

            spo2: "--",

            temp: "--",

            emergency: "OK",

            cleaned: false,

            anomaly_detected: false,

            source_path: "NONE",

            topic: "init"
        });


        // Initial devices are offline until data arrives.
        stateStore.markOffline(
            device.deviceId
        );
    });
}


// ============================================================
// DEVELOPMENT SIMULATION
// ============================================================

function startDevelopmentSimulation() {

    if (
        simulationStarted
    ) {

        return;
    }


    simulationStarted = true;


    console.log(
        "WardOS: Starting development simulation."
    );


    try {

        if (
            typeof mqttClient.enableSimulation ===
            "function"
        ) {

            mqttClient.enableSimulation();

        }

        startSimulation();

    } catch (error) {

        console.error(
            "WardOS simulation failed:",
            error
        );

    }
}


// ============================================================
// EVENT LISTENERS
// ============================================================

function setupEventListeners() {


    // --------------------------------------------------------
    // Search
    // --------------------------------------------------------

    if (dom.globalSearch) {

        dom.globalSearch.addEventListener(
            "input",
            requestRender
        );
    }


    // --------------------------------------------------------
    // Status filter
    // --------------------------------------------------------

    if (dom.statusFilter) {

        dom.statusFilter.addEventListener(
            "change",
            event => {

                currentStatusFilter =
                    event.target.value;

                requestRender();
            }
        );
    }


    // --------------------------------------------------------
    // Sort
    // --------------------------------------------------------

    if (dom.sortPatients) {

        dom.sortPatients.addEventListener(
            "change",
            event => {

                currentSort =
                    event.target.value;

                requestRender();
            }
        );
    }


    // --------------------------------------------------------
    // Grid / list view
    // --------------------------------------------------------

    dom.viewButtons.forEach(button => {

        button.addEventListener(
            "click",
            () => {

                currentView =
                    button.dataset.view;

                dom.viewButtons.forEach(btn => {
                    btn.classList.toggle(
                        "active",
                        btn === button
                    );
                });


                if (dom.patientGrid) {

                    dom.patientGrid.classList.toggle(
                        "list-view",
                        currentView === "list"
                    );
                }
            }
        );
    });


    // --------------------------------------------------------
    // Patient selection
    // --------------------------------------------------------

    if (dom.patientGrid) {

        dom.patientGrid.addEventListener(
            "click",
            event => {

                const card =
                    event.target.closest(
                        ".bed-card"
                    );


                if (!card) {
                    return;
                }


                selectedDeviceId =
                    Number(
                        card.dataset.id
                    );


                renderPatientDetail();

                requestRender();
            }
        );
    }


    // --------------------------------------------------------
    // Close patient detail
    // --------------------------------------------------------

    if (dom.closePatientDetail) {

        dom.closePatientDetail.addEventListener(
            "click",
            () => {

                selectedDeviceId = null;

                renderPatientDetail();

                requestRender();
            }
        );
    }


    // --------------------------------------------------------
    // Notification panel
    // --------------------------------------------------------

    if (
        dom.notificationButton &&
        dom.notificationPanel
    ) {

        dom.notificationButton.addEventListener(
            "click",
            () => {

                dom.notificationPanel
                    .classList
                    .add("open");

                dom.notificationPanel
                    .setAttribute(
                        "aria-hidden",
                        "false"
                    );
            }
        );
    }


    if (
        dom.closeNotifications &&
        dom.notificationPanel
    ) {

        dom.closeNotifications.addEventListener(
            "click",
            () => {

                dom.notificationPanel
                    .classList
                    .remove("open");

                dom.notificationPanel
                    .setAttribute(
                        "aria-hidden",
                        "true"
                    );
            }
        );
    }


    // --------------------------------------------------------
    // Mobile menu
    // --------------------------------------------------------

    if (
        dom.mobileMenuButton &&
        dom.sidebar
    ) {

        dom.mobileMenuButton.addEventListener(
            "click",
            () => {

                dom.sidebar.classList.toggle(
                    "open"
                );
            }
        );
    }
}


// ============================================================
// STATE STORE SUBSCRIPTION
// ============================================================

function setupStateSubscription() {

    stateStore.subscribe(
        () => {

            requestRender();
        }
    );
}


// ============================================================
// ALERT ENGINE SUBSCRIPTION
// ============================================================

function setupAlertSubscription() {

    alertEngine.subscribe(
        alert => {

            registerAlert(alert);

            requestRender();
        }
    );
}


// ============================================================
// MQTT STATUS
// ============================================================

function setupMQTTStatusListener() {

    window.addEventListener(
        "mqtt-status",
        event => {

            updateMQTTStatus(
                event.detail
            );
        }
    );
}


function updateMQTTStatus(status) {

    if (!status) {
        return;
    }


    if (dom.mqttStatus) {

        dom.mqttStatus.textContent =
            status;
    }


    if (dom.mqttIndicator) {

        dom.mqttIndicator.className =
            "connection-indicator";


        if (
            status === "CONNECTED"
        ) {

            dom.mqttIndicator
                .classList
                .add("connected");
        }


        else if (
            status === "CONNECTING"
        ) {

            dom.mqttIndicator
                .classList
                .add("connecting");
        }


        else if (
            status === "RAW MODE"
        ) {

            dom.mqttIndicator
                .classList
                .add("raw");
        }


        else if (
            status === "SIMULATION"
        ) {

            dom.mqttIndicator
                .classList
                .add("connected");
        }
    }


    if (dom.mqttLatency) {

        if (
            status === "SIMULATION"
        ) {

            dom.mqttLatency.textContent =
                "SIM";

        }

        else if (
            status === "CONNECTED"
        ) {

            dom.mqttLatency.textContent =
                "LIVE";

        }

        else {

            dom.mqttLatency.textContent =
                "--";
        }
    }
}


// ============================================================
// DATE + CLOCK
// ============================================================

function updateDateAndTime() {

    const now =
        new Date();


    if (dom.currentDate) {

        dom.currentDate.textContent =
            now.toLocaleDateString(
                "en-IN",
                {
                    day: "2-digit",
                    month: "short",
                    year: "numeric"
                }
            );
    }


    if (dom.lastSyncTime) {

        dom.lastSyncTime.textContent =
            now.toLocaleTimeString(
                "en-US",
                {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit"
                }
            );
    }
}


// ============================================================
// OFFLINE DETECTION
// ============================================================

function checkOfflineDevices() {

    const now =
        Date.now();


    stateStore
        .getAllStates()
        .forEach(state => {

            if (!state) {
                return;
            }


            if (
                now - state.lastSeen >
                OFFLINE_TIMEOUT_MS
            ) {

                stateStore.markOffline(
                    state.deviceId
                );
            }
        });
}


// ============================================================
// RENDER QUEUE
// ============================================================

function requestRender() {

    if (
        renderRequested
    ) {

        return;
    }


    renderRequested =
        true;


    requestAnimationFrame(
        render
    );
}


// ============================================================
// MAIN RENDER
// ============================================================

function render() {

    renderRequested =
        false;


    let states =
        stateStore.getAllStates();


    states =
        applySearchFilter(states);


    states =
        applyStatusFilter(states);


    states =
        sortStates(states);


    renderKPIs();

    renderPatientGrid(states);

    renderPatientDetail();

    renderAlertCenter();

    renderNotifications();

    updateWardCount();
}


// ============================================================
// FILTER — SEARCH
// ============================================================

function applySearchFilter(states) {

    const query =
        dom.globalSearch
            ? dom.globalSearch.value
                .trim()
                .toLowerCase()
            : "";


    if (!query) {

        return [...states];
    }


    return states.filter(state => {

        const name =
            String(
                state.patientName || ""
            ).toLowerCase();


        const bed =
            String(
                state.bed || ""
            ).toLowerCase();


        const id =
            String(
                state.id || ""
            ).toLowerCase();


        const device =
            String(
                state.deviceId || ""
            ).toLowerCase();


        return (
            name.includes(query) ||
            bed.includes(query) ||
            id.includes(query) ||
            device.includes(query)
        );
    });
}


// ============================================================
// FILTER — STATUS
// ============================================================

function applyStatusFilter(states) {

    if (
        currentStatusFilter === "all"
    ) {

        return [...states];
    }


    return states.filter(
        state => {

            if (
                currentStatusFilter ===
                "stable"
            ) {

                return (
                    state.status ===
                    "ok"
                );
            }


            if (
                currentStatusFilter ===
                "alert"
            ) {

                return (
                    state.status ===
                    "warning"
                );
            }


            return (
                state.status ===
                currentStatusFilter
            );
        }
    );
}


// ============================================================
// SORT
// ============================================================

function sortStates(states) {

    const copy =
        [...states];


    if (
        currentSort === "bed"
    ) {

        return copy.sort(
            (a, b) =>
                Number(a.bed) -
                Number(b.bed)
        );
    }


    if (
        currentSort === "name"
    ) {

        return copy.sort(
            (a, b) =>
                String(
                    a.patientName
                ).localeCompare(
                    String(
                        b.patientName
                    )
                )
        );
    }


    if (
        currentSort === "updated"
    ) {

        return copy.sort(
            (a, b) =>
                b.lastSeen -
                a.lastSeen
        );
    }


    // Priority
    const priority = {
        critical: 0,
        warning: 1,
        removed: 2,
        offline: 3,
        ok: 4
    };


    return copy.sort(
        (a, b) => {

            const pa =
                priority[a.status] ?? 99;

            const pb =
                priority[b.status] ?? 99;


            if (pa !== pb) {

                return pa - pb;
            }


            return (
                Number(a.bed) -
                Number(b.bed)
            );
        }
    );
}


// ============================================================
// KPI RENDER
// ============================================================

function renderKPIs() {

    const states =
        stateStore.getAllStates();


    const total =
        states.length;


    const stable =
        states.filter(
            state =>
                state.status === "ok"
        ).length;


    const warning =
        states.filter(
            state =>
                state.status === "warning"
        ).length;


    const critical =
        states.filter(
            state =>
                state.status === "critical"
        ).length;


    const offline =
        states.filter(
            state =>
                state.status === "offline" ||
                state.status === "removed"
        ).length;


    setText(
        dom.totalPatients,
        total
    );


    setText(
        dom.stablePatients,
        stable
    );


    setText(
        dom.alertPatients,
        warning
    );


    setText(
        dom.criticalPatients,
        critical
    );


    setText(
        dom.offlineDevices,
        offline
    );


    setText(
        dom.patientNavCount,
        total
    );


    setText(
        dom.emergencyNavCount,
        critical
    );


    setText(
        dom.notificationCount,
        activeAlerts.length
    );
}


// ============================================================
// PATIENT GRID
// ============================================================

function renderPatientGrid(states) {

    if (!dom.patientGrid) {

        return;
    }


    if (
        states.length === 0
    ) {

        dom.patientGrid.innerHTML = `

            <div class="monitor-loading">

                <span>
                    No patients match the current filters.
                </span>

            </div>
        `;

        return;
    }


    const html =
        states
            .map(
                state =>
                    createBedCard(state)
            )
            .join("");


    dom.patientGrid.innerHTML =
        html;
}


// ============================================================
// BED CARD
// ============================================================

function createBedCard(state) {

    const selected =
        selectedDeviceId ===
        state.deviceId;


    const badge =
        safeGetMLBadge(state);


    const lastSeen =
        formatLastSeen(
            state.lastSeen,
            state.status
        );


    const statusLabel =
        getStatusLabel(
            state.status
        );


    return `

        <article
            class="
                bed-card
                status-${escapeHTML(
                    state.status
                )}
                ${selected ? "selected" : ""}
            "
            data-id="${escapeHTML(
                state.deviceId
            )}"
        >

            <div class="bed-header">

                <span>
                    BED ${escapeHTML(
                        state.bed
                    )}
                </span>

                <span>
                    ${escapeHTML(
                        lastSeen
                    )}
                </span>

            </div>


            <div class="bed-patient">

                ${escapeHTML(
                    state.patientName
                )}

            </div>


            <div class="vitals-grid">

                <div class="vital-main">

                    <span class="value">

                        ${escapeHTML(
                            state.vitals.hr
                        )}

                    </span>

                    <span class="vital-label">
                        HEART RATE · BPM
                    </span>

                </div>


                <div class="vital-sub spo2">

                    <span class="value">

                        ${formatVital(
                            state.vitals.spo2,
                            "%"
                        )}

                    </span>

                    <span class="vital-label">
                        SpO₂
                    </span>

                </div>


                <div class="vital-sub temp">

                    <span class="value">

                        ${formatVital(
                            state.vitals.temp,
                            "°"
                        )}

                    </span>

                    <span class="vital-label">
                        TEMP
                    </span>

                </div>

            </div>


            <div class="bed-footer">

                <span
                    class="
                        ml-badge
                        ${escapeHTML(
                            badge.style
                        )}
                    "
                >

                    ${escapeHTML(
                        badge.label
                    )}

                </span>


                <span>

                    ${escapeHTML(
                        statusLabel
                    )}

                </span>

            </div>

        </article>
    `;
}


// ============================================================
// PATIENT DETAIL
// ============================================================

function renderPatientDetail() {

    if (!dom.patientDetail) {

        return;
    }


    if (!selectedDeviceId) {

        dom.patientDetail.innerHTML = `

            <div class="empty-detail">

                <div class="empty-detail-icon">
                    ◉
                </div>

                <h3>
                    Select a patient
                </h3>

                <p>
                    Select a bed from the live monitor
                    to view detailed telemetry.
                </p>

            </div>
        `;

        return;
    }


    const state =
        stateStore.getState(
            selectedDeviceId
        );


    if (!state) {

        return;
    }


    const badge =
        safeGetMLBadge(state);


    const emergencyMessage =
        state.status === "critical"
            ? `
                <div
                    style="
                        margin-top:18px;
                        padding:14px;
                        border:1px solid rgba(239,98,98,.35);
                        border-left:3px solid var(--critical);
                        border-radius:8px;
                        background:rgba(239,98,98,.06);
                    "
                >

                    <strong
                        style="
                            color:var(--critical);
                            font-family:var(--font-mono);
                            font-size:10px;
                        "
                    >
                        CRITICAL PATIENT ALERT
                    </strong>

                    <p
                        style="
                            margin-top:7px;
                            color:var(--text-secondary);
                            font-size:11px;
                            line-height:1.6;
                        "
                    >

                        ${
                            state.mlMeta
                                ?.anomalyDetected
                                ? "Reading contains an anomaly flag. Verify the patient physically before acting."
                                : "Patient requires immediate clinical verification."
                        }

                    </p>

                </div>
            `
            : "";


    dom.patientDetail.innerHTML = `

        <div
            style="
                padding:20px;
            "
        >

            <div
                style="
                    display:flex;
                    justify-content:space-between;
                    gap:20px;
                    align-items:flex-start;
                "
            >

                <div>

                    <div
                        style="
                            color:var(--text-muted);
                            font-family:var(--font-mono);
                            font-size:9px;
                            letter-spacing:1px;
                        "
                    >
                        BED ${escapeHTML(
                            state.bed
                        )} · ${escapeHTML(
                            state.ward
                        )}
                    </div>

                    <h3
                        style="
                            margin-top:7px;
                            font-size:20px;
                        "
                    >
                        ${escapeHTML(
                            state.patientName
                        )}
                    </h3>

                    <div
                        style="
                            margin-top:5px;
                            color:var(--text-muted);
                            font-size:10px;
                        "
                    >
                        Patient ID:
                        ${escapeHTML(
                            state.id
                        )}
                        · Age
                        ${escapeHTML(
                            state.age
                        )}
                    </div>

                </div>


                <span
                    class="
                        ml-badge
                        ${escapeHTML(
                            badge.style
                        )}
                    "
                >
                    ${escapeHTML(
                        badge.label
                    )}
                </span>

            </div>


            <div
                style="
                    margin-top:22px;
                    display:grid;
                    grid-template-columns:
                        repeat(3,minmax(0,1fr));
                    gap:12px;
                "
            >

                ${createDetailVital(
                    "Heart Rate",
                    state.vitals.hr,
                    "bpm",
                    "var(--hr)"
                )}

                ${createDetailVital(
                    "SpO₂",
                    state.vitals.spo2,
                    "%",
                    "var(--spo2)"
                )}

                ${createDetailVital(
                    "Temperature",
                    state.vitals.temp,
                    "°C",
                    "var(--temp)"
                )}

            </div>


            ${emergencyMessage}

        </div>
    `;
}


// ============================================================
// DETAIL VITAL CARD
// ============================================================

function createDetailVital(
    label,
    value,
    unit,
    color
) {

    return `

        <div
            style="
                padding:15px;
                border:1px solid var(--border);
                border-radius:9px;
                background:var(--surface);
            "
        >

            <div
                style="
                    color:var(--text-muted);
                    font-family:var(--font-mono);
                    font-size:8px;
                    letter-spacing:.8px;
                "
            >
                ${escapeHTML(label)}
            </div>


            <div
                style="
                    margin-top:9px;
                    font-family:var(--font-mono);
                    font-size:27px;
                    font-weight:600;
                    color:${color};
                "
            >

                ${escapeHTML(value)}

                <span
                    style="
                        font-size:10px;
                        color:var(--text-muted);
                    "
                >
                    ${escapeHTML(unit)}
                </span>

            </div>

        </div>
    `;
}


// ============================================================
// ALERT HANDLING
// ============================================================

function registerAlert(alert) {

    if (!alert) {

        return;
    }


    const state =
        stateStore.getState(
            alert.deviceId
        );


    const alertRecord = {

        id:
            alert.id ||
            `${Date.now()}-${Math.random()}`,

        type:
            alert.type,

        deviceId:
            alert.deviceId,

        patientName:
            alert.patientName ||
            state?.patientName ||
            "Unknown",

        bed:
            alert.bed ||
            state?.bed ||
            "--",

        ward:
            state?.ward ||
            "Unknown",

        message:
            alert.message ||
            "Clinical alert",

        vitals:
            alert.vitals ||
            state?.vitals,

        timestamp:
            Date.now()
    };


    activeAlerts.unshift(
        alertRecord
    );


    // Keep only recent alerts.
    if (
        activeAlerts.length > 20
    ) {

        activeAlerts.pop();
    }


    if (
        alertRecord.type ===
        "CRITICAL"
    ) {

        playCriticalBeep();
    }
}


// ============================================================
// ALERT CENTER
// ============================================================

function renderAlertCenter() {

    if (
        !dom.alertList
    ) {

        return;
    }


    if (
        activeAlerts.length === 0
    ) {

        dom.alertList.innerHTML = `

            <div class="alert-empty">

                <span>
                    ✓
                </span>

                <p>
                    No active clinical alerts.
                </p>

            </div>
        `;


        setText(
            dom.activeAlertCount,
            "0 ACTIVE"
        );

        return;
    }


    const visibleAlerts =
        activeAlerts.slice(
            0,
            5
        );


    dom.alertList.innerHTML =
        visibleAlerts
            .map(
                alert => `

                    <div
                        class="
                            toast
                            type-${escapeHTML(
                                alert.type
                            )}
                        "
                    >

                        <div class="toast-header">

                            ${escapeHTML(
                                alert.type
                            )}

                            · WARD
                            ${escapeHTML(
                                alert.ward
                            )}

                            · BED
                            ${escapeHTML(
                                alert.bed
                            )}

                        </div>


                        <div class="toast-body">

                            <strong>
                                ${escapeHTML(
                                    alert.patientName
                                )}
                            </strong>

                            <br>

                            ${escapeHTML(
                                alert.message
                            )}

                        </div>

                    </div>
                `
            )
            .join("");


    setText(
        dom.activeAlertCount,
        `${activeAlerts.length} ACTIVE`
    );
}


// ============================================================
// NOTIFICATIONS
// ============================================================

function renderNotifications() {

    if (
        !dom.notificationList
    ) {

        return;
    }


    if (
        activeAlerts.length === 0
    ) {

        dom.notificationList.innerHTML = `

            <div class="notification-empty">

                <span>
                    ✓
                </span>

                <p>
                    No new notifications.
                </p>

            </div>
        `;

        return;
    }


    dom.notificationList.innerHTML =
        activeAlerts
            .slice(
                0,
                10
            )
            .map(
                alert => `

                    <div
                        class="
                            toast
                            type-${escapeHTML(
                                alert.type
                            )}
                        "
                        style="
                            margin-bottom:9px;
                        "
                    >

                        <div class="toast-header">

                            ${escapeHTML(
                                alert.type
                            )}

                        </div>


                        <div class="toast-body">

                            Ward
                            ${escapeHTML(
                                alert.ward
                            )}

                            · Bed
                            ${escapeHTML(
                                alert.bed
                            )}

                            <br>

                            <strong>
                                ${escapeHTML(
                                    alert.patientName
                                )}
                            </strong>

                            <br>

                            ${escapeHTML(
                                alert.message
                            )}

                        </div>

                    </div>
                `
            )
            .join("");
}


// ============================================================
// OFFLINE BEEP
// ============================================================

function playCriticalBeep() {

    try {

        const AudioContext =
            window.AudioContext ||
            window.webkitAudioContext;


        if (!AudioContext) {

            return;
        }


        const context =
            new AudioContext();


        const oscillator =
            context.createOscillator();


        const gain =
            context.createGain();


        oscillator.type =
            "sine";


        oscillator.frequency.value =
            880;


        gain.gain.setValueAtTime(
            0.0001,
            context.currentTime
        );


        gain.gain.exponentialRampToValueAtTime(
            0.18,
            context.currentTime + 0.02
        );


        gain.gain.exponentialRampToValueAtTime(
            0.0001,
            context.currentTime + 0.35
        );


        oscillator.connect(gain);

        gain.connect(
            context.destination
        );


        oscillator.start();

        oscillator.stop(
            context.currentTime +
            0.36
        );

    } catch (error) {

        console.warn(
            "WardOS alert audio unavailable:",
            error
        );
    }
}


// ============================================================
// WARD COUNT
// ============================================================

function updateWardCount() {

    const count =
        stateStore
            .getAllStates()
            .length;


    const text =
        document.querySelector(
            ".ward-selector-text small"
        );


    if (text) {

        text.textContent =
            `${count} monitored beds`;
    }
}


// ============================================================
// HELPERS
// ============================================================

function safeGetMLBadge(state) {

    try {

        return getMLBadge(
            state.mlMeta,
            state.vitals.hr
        ) || {
            label: "NO DATA",
            style: ""
        };

    } catch {

        return {
            label: "NO DATA",
            style: ""
        };
    }
}


function getStatusLabel(status) {

    const labels = {

        ok:
            "STABLE",

        warning:
            "ATTENTION",

        critical:
            "CRITICAL",

        offline:
            "OFFLINE",

        removed:
            "NO SENSOR"
    };


    return (
        labels[status] ||
        String(status).toUpperCase()
    );
}


function formatLastSeen(
    timestamp,
    status
) {

    if (
        status === "offline"
    ) {

        return "OFFLINE";
    }


    if (
        status === "removed"
    ) {

        return "NO SENSOR";
    }


    const difference =
        Date.now() -
        Number(timestamp);


    if (
        difference < 5000
    ) {

        return "LIVE";
    }


    if (
        difference < 60000
    ) {

        return `${Math.floor(
            difference / 1000
        )}s`;
    }


    return `${Math.floor(
        difference / 60000
    )}m`;
}


function formatVital(
    value,
    unit
) {

    if (
        value === null ||
        value === undefined ||
        value === "--" ||
        value === "REMOVED" ||
        value === "N/A"
    ) {

        return escapeHTML(
            value ?? "--"
        );
    }


    return `${escapeHTML(value)}${unit}`;
}


function setText(
    element,
    value
) {

    if (element) {

        element.textContent =
            value;
    }
}


function escapeHTML(value) {

    if (
        value === null ||
        value === undefined
    ) {

        return "";
    }


    return String(value)
        .replace(
            /[&<>"']/g,
            character => {

                const map = {

                    "&": "&amp;",

                    "<": "&lt;",

                    ">": "&gt;",

                    "\"": "&quot;",

                    "'": "&#39;"
                };


                return map[character];
            }
        );
}


// ============================================================
// START
// ============================================================

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        init,
        {
            once: true
        }
    );
}

else {

    init();
}