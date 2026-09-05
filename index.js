/* =========================================================
   WARDOS — LOGIN CONTROLLER
   Role selection + local session routing
   ========================================================= */


const roleButtons = document.querySelectorAll(".role-option");

const loginForm = document.getElementById("loginForm");

const staffFields = document.getElementById("staffFields");

const patientFields = document.getElementById("patientFields");

const staffIdInput = document.getElementById("staffId");

const passwordInput = document.getElementById("password");

const patientNameInput = document.getElementById("patientName");

const rememberInput = document.getElementById("remember");

const loginButtonText =
  document.getElementById("loginButtonText");

const loginError =
  document.getElementById("loginError");


/* =========================================================
   CURRENT ROLE
   ========================================================= */

let selectedRole = "nurse";


/* =========================================================
   ROUTES
   ========================================================= */

const ROLE_ROUTES = {

  nurse:
    "./nurse/nurse_dashboard.html",

  doctor:
    "./doctor/doctor_dashboard.html",

  patient:
    "./patient/patient.html"

};


/* =========================================================
   ROLE LABELS
   ========================================================= */

const ROLE_LABELS = {

  nurse: "Nurse",

  doctor: "Doctor",

  patient: "Patient"

};


/* =========================================================
   INITIALIZE
   ========================================================= */

document.addEventListener(
  "DOMContentLoaded",
  initializeLogin
);


/* =========================================================
   INITIALIZE LOGIN
   ========================================================= */

function initializeLogin() {

  setupRoleSelection();

  setupLoginForm();

  restoreSession();

}


/* =========================================================
   ROLE SELECTION
   ========================================================= */

function setupRoleSelection() {

  roleButtons.forEach((button) => {

    button.addEventListener(
      "click",
      () => {

        const role =
          button.dataset.role;

        selectRole(role);

      }
    );

  });

}


/* =========================================================
   SELECT ROLE
   ========================================================= */

function selectRole(role) {

  selectedRole = role;


  /* -----------------------------------------
     Update buttons
     ----------------------------------------- */

  roleButtons.forEach((button) => {

    const isActive =
      button.dataset.role === role;

    button.classList.toggle(
      "active",
      isActive
    );

    button.setAttribute(
      "aria-pressed",
      String(isActive)
    );

  });


  /* -----------------------------------------
     Update form
     ----------------------------------------- */

  const isPatient =
    role === "patient";


  staffFields.classList.toggle(
    "hidden",
    isPatient
  );


  patientFields.classList.toggle(
    "hidden",
    !isPatient
  );


  /* -----------------------------------------
     Update required fields
     ----------------------------------------- */

  staffIdInput.required =
    !isPatient;

  passwordInput.required =
    !isPatient;

  patientNameInput.required =
    isPatient;


  /* -----------------------------------------
     Update button
     ----------------------------------------- */

  loginButtonText.textContent =
    `Continue as ${ROLE_LABELS[role]}`;


  /* -----------------------------------------
     Clear old error
     ----------------------------------------- */

  clearError();

}


/* =========================================================
   LOGIN FORM
   ========================================================= */

function setupLoginForm() {

  loginForm.addEventListener(
    "submit",
    handleLogin
  );

}


/* =========================================================
   HANDLE LOGIN
   ========================================================= */

function handleLogin(event) {

  event.preventDefault();

  clearError();


  /* =========================================
     PATIENT LOGIN
     ========================================= */

  if (selectedRole === "patient") {

    handlePatientLogin();

    return;

  }


  /* =========================================
     STAFF LOGIN
     ========================================= */

  handleStaffLogin();

}


/* =========================================================
   PATIENT LOGIN
   ========================================================= */

function handlePatientLogin() {

  const patientName =
    patientNameInput.value.trim();


  if (!patientName) {

    showError(
      "Please enter your registered patient name."
    );

    patientNameInput.focus();

    return;

  }


  /*
   * IMPORTANT:
   *
   * At this stage we only store the name
   * locally.
   *
   * Later this will be replaced/validated
   * against the WardOS patient/device registry.
   */

  const session = {

    role: "patient",

    patientName: patientName,

    loginTime:
      new Date().toISOString()

  };


  saveSession(
    session,
    rememberInput.checked
  );


  redirectToRole(
    "patient"
  );

}


/* =========================================================
   STAFF LOGIN
   ========================================================= */

function handleStaffLogin() {

  const staffId =
    staffIdInput.value.trim();

  const password =
    passwordInput.value;


  if (!staffId) {

    showError(
      "Please enter your staff ID."
    );

    staffIdInput.focus();

    return;

  }


  if (!password) {

    showError(
      "Please enter your password."
    );

    passwordInput.focus();

    return;

  }


  /*
   * TEMPORARY FRONTEND LOGIN
   *
   * We are NOT creating fake credentials.
   *
   * Any non-empty credentials are accepted
   * temporarily so that the UI flow works.
   *
   * Real authentication can be connected
   * later without changing the dashboard
   * architecture.
   */

  const session = {

    role: selectedRole,

    staffId: staffId,

    loginTime:
      new Date().toISOString()

  };


  saveSession(
    session,
    rememberInput.checked
  );


  redirectToRole(
    selectedRole
  );

}


/* =========================================================
   SAVE SESSION
   ========================================================= */

function saveSession(
  session,
  remember
) {

  const sessionData =
    JSON.stringify(session);


  /*
   * Session storage:
   * cleared when browser session ends.
   */

  sessionStorage.setItem(
    "wardos_session",
    sessionData
  );


  /*
   * Remember session:
   * persists locally.
   */

  if (remember) {

    localStorage.setItem(
      "wardos_session",
      sessionData
    );

  }
  else {

    localStorage.removeItem(
      "wardos_session"
    );

  }

}


/* =========================================================
   RESTORE SESSION
   ========================================================= */

function restoreSession() {

  const savedSession =
    localStorage.getItem(
      "wardos_session"
    );


  if (!savedSession) {

    return;

  }


  try {

    const session =
      JSON.parse(savedSession);


    if (
      !session ||
      !session.role
    ) {

      return;

    }


    /*
     * We intentionally don't automatically
     * redirect here yet.
     *
     * Later we can add a proper
     * "Continue previous session?" flow.
     */

    if (
      session.role === "patient" &&
      session.patientName
    ) {

      patientNameInput.value =
        session.patientName;

    }

  }
  catch (error) {

    console.warn(
      "WardOS: Could not restore session.",
      error
    );

  }

}


/* =========================================================
   REDIRECT
   ========================================================= */

function redirectToRole(role) {

  const route =
    ROLE_ROUTES[role];


  if (!route) {

    showError(
      "Unable to determine the selected role."
    );

    return;

  }


  window.location.href =
    route;

}


/* =========================================================
   ERROR
   ========================================================= */

function showError(message) {

  loginError.textContent =
    message;

  loginError.classList.remove(
    "hidden"
  );

}


function clearError() {

  loginError.textContent =
    "";

  loginError.classList.add(
    "hidden"
  );

}
