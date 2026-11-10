// ============================================================
// WardOS - Nurse Command Centre
// Ward-level monitoring: every assigned patient at a glance,
// alerts, devices, admissions and reports.
// ============================================================

import { startApp } from "../app/shell.js";
import { monitorView, alertsView, devicesView, reportsView, openPatientDetail } from "../app/views.js";
import { api } from "../app/api.js";
import { modal, toast } from "../app/ui.js";
import { icon } from "../app/icons.js";
import { esc } from "../app/util.js";

async function admitPatient(ctx) {
  let wards, doctors;
  try {
    [wards, doctors] = await Promise.all([api("/api/wards"), api("/api/doctors")]);
  } catch (error) {
    return toast("Cannot admit right now", error.message, "crit");
  }
  const freeBeds = wards.flatMap(w => w.beds.filter(b => !b.occupied).map(b => ({ ...b, wardId: w.id, ward: w.name })));
  if (!freeBeds.length) return toast("No free beds", "All beds in your ward are occupied.", "warn");

  const result = await modal({
    title: "Admit patient",
    submitLabel: "Admit",
    body: `
      <div class="field"><label for="ad-name">Full name</label><input class="input" id="ad-name" name="name" required maxlength="120" autocomplete="off"></div>
      <div class="grid cols-2">
        <div class="field"><label for="ad-age">Age</label><input class="input" id="ad-age" name="age" type="number" min="0" max="120"></div>
        <div class="field"><label for="ad-sex">Sex</label><select class="select" id="ad-sex" name="sex"><option value="">--</option><option value="F">Female</option><option value="M">Male</option><option value="O">Other</option></select></div>
      </div>
      <div class="field"><label for="ad-bed">Bed</label><select class="select" id="ad-bed" name="bed" required>
        ${freeBeds.map(b => `<option value="${b.wardId}:${b.id}">${esc(b.ward)} · bed ${esc(b.label)}</option>`).join("")}</select></div>
      <div class="field"><label for="ad-doc">Attending doctor</label><select class="select" id="ad-doc" name="doctorId" required>
        ${doctors.map(d => `<option value="${d.id}">${esc(d.name)}${d.title ? ` - ${esc(d.title)}` : ""}</option>`).join("")}</select></div>
      <div class="field"><label for="ad-dx">Reason for admission</label><input class="input" id="ad-dx" name="diagnosis" maxlength="200"></div>
      <p class="dim" style="font-size:12.5px">Assign a wearable afterwards from Devices. A personal access code for the patient portal is generated now.</p>`,
    onSubmit: data => {
      const [wardId, bedId] = data.bed.split(":");
      return api("/api/patients", {
        method: "POST",
        body: { name: data.name, age: data.age, sex: data.sex, wardId, bedId: Number(bedId), doctorId: Number(data.doctorId), diagnosis: data.diagnosis }
      });
    }
  });

  if (result?.accessCode) {
    await modal({
      title: "Patient admitted",
      hideSubmit: true,
      cancelLabel: "Done",
      body: `<p class="muted">Give the patient this access code for the WardOS patient portal. It is shown only once.</p><div class="code-reveal">${esc(result.accessCode)}</div>`
    });
  }
}

const ctx = await startApp({
  role: "nurse",
  title: "Nurse station",
  defaultView: "overview",
  nav: [
    { id: "overview", label: "Ward overview", icon: "grid", badge: s => ({ n: s.patientList.filter(p => p.status === "critical").length, cls: "crit" }) },
    { id: "alerts", label: "Alerts", icon: "bell", badge: s => ({ n: s.unacknowledged.length, cls: s.unacknowledged.some(a => a.severity === "CRITICAL") ? "crit" : "" }) },
    { id: "devices", label: "Devices", icon: "device" },
    { id: "reports", label: "Reports", icon: "report" }
  ],
  views: {
    overview: (el, c) => {
      const cleanup = monitorView(el, c, {
        title: "Ward overview",
        subtitle: `Live monitoring for ${c.me.wardIds.join(", ") || "your ward"} · ${c.me.name}`,
        extraActions: `<button class="btn" id="admit-btn">${icon("plus")}Admit patient</button>`
      });
      el.querySelector("#admit-btn").addEventListener("click", () => admitPatient(c));
      return cleanup;
    },
    alerts: alertsView,
    devices: devicesView,
    reports: reportsView
  }
});

if (ctx) ctx.openPatient = id => openPatientDetail(ctx, id);
