// WardOS - sign-in page
import { api } from "./api.js";

const ROUTES = { nurse: "/nurse/nurse_dashboard.html", doctor: "/doctor/doctor_dashboard.html", patient: "/patient/patient.html" };

const form = document.getElementById("login-form");
const errorBox = document.getElementById("login-error");
const submit = document.getElementById("submit-btn");
const staffFields = document.getElementById("staff-fields");
const patientFields = document.getElementById("patient-fields");
const hint = document.getElementById("server-hint");
let role = localStorage.getItem("wardos-last-role") || "nurse";
let options = { patientNameOnlyLogin: false, demo: false };

function setRole(next) {
  role = next;
  document.querySelectorAll(".role").forEach(b => b.setAttribute("aria-checked", String(b.dataset.role === role)));
  staffFields.classList.toggle("hidden", role === "patient");
  patientFields.classList.toggle("hidden", role !== "patient");
  submit.textContent = role === "patient" ? "View my readings" : `Sign in as ${role}`;
  clearError();
  updateDemoNote();
  (role === "patient" ? document.getElementById("pname") : document.getElementById("username")).focus();
}

function updateDemoNote() {
  const note = document.getElementById("demo-note");
  const parts = [];
  if (options.demo) parts.push("Demo environment - demonstration accounts are listed in <span class='mono'>server/seed/demo_seed.json</span>.");
  if (role === "patient" && options.patientNameOnlyLogin) parts.push("Name-only patient sign-in is enabled for this demo. Real deployments require the access code.");
  note.innerHTML = parts.join(" ");
  note.classList.toggle("hidden", !parts.length);
  document.getElementById("code-optional").textContent = options.patientNameOnlyLogin ? "(optional in demo)" : "";
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}
function clearError() { errorBox.classList.add("hidden"); }

document.querySelectorAll(".role").forEach(b => {
  b.addEventListener("click", () => setRole(b.dataset.role));
  b.addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const roles = ["nurse", "doctor", "patient"];
    const i = (roles.indexOf(role) + (e.key === "ArrowRight" ? 1 : 2)) % 3;
    setRole(roles[i]);
    document.querySelector(`.role[data-role="${roles[i]}"]`).focus();
  });
});

form.addEventListener("submit", async e => {
  e.preventDefault();
  clearError();
  submit.classList.add("loading");
  try {
    if (role === "patient") {
      const name = document.getElementById("pname").value.trim();
      const accessCode = document.getElementById("pcode").value.trim();
      if (!name) throw new Error("Enter your full name as registered at admission");
      if (!accessCode && !options.patientNameOnlyLogin) throw new Error("Enter the access code from your admission card");
      await api("/api/auth/patient-login", { method: "POST", body: { name, accessCode } });
    } else {
      const username = document.getElementById("username").value.trim();
      const password = document.getElementById("password").value;
      if (!username || !password) throw new Error("Enter your staff ID and password");
      await api("/api/auth/login", { method: "POST", body: { role, username, password } });
    }
    localStorage.setItem("wardos-last-role", role);
    window.location.replace(ROUTES[role]);
  } catch (error) {
    showError(error.message);
    document.getElementById("password").value = "";
  } finally {
    submit.classList.remove("loading");
  }
});

// Already signed in? Go straight to the right dashboard.
(async () => {
  const params = new URLSearchParams(location.search);
  if (params.has("expired")) showError("Your session ended. Please sign in again.");
  if (params.has("ended")) showError("Your session was closed (signed out elsewhere or discharged).");
  try {
    options = await api("/api/auth/options");
    hint.textContent = "Connected to the local WardOS server.";
    try {
      const me = await api("/api/auth/me");
      if (me?.role && !params.has("expired")) return window.location.replace(ROUTES[me.role]);
    } catch { /* not signed in */ }
  } catch {
    hint.textContent = "The WardOS server is not reachable. Start it with “npm start” (or “npm run demo”).";
    hint.style.color = "var(--crit)";
  }
  setRole(role);
})();
