/* Shisha World B2B Onboarding — 3-step stepper.
 *
 * Steps 1 and 2 POST their data to the Zoho standalone function STEP_ENDPOINT,
 * as a single `mp` argument holding a JSON map. The email address rides on both
 * so the function can correlate the partial submissions.
 *
 * Step 3 does NOT call the function. Its submit button posts the whole form to
 * the Zoho Forms endpoint as multipart/form-data, using Zoho Forms' own field
 * names (see ZOHO_FIELD_MAP).
 */
(function () {
  "use strict";

  /* ============================================================
   * CONFIG
   * ============================================================ */

  /* Zoho standalone function called by steps 1 and 2.
   *
   * SECURITY: the zapikey below is readable by anyone who views source, and
   * this function creates leads. Expect junk submissions unless the Deluge
   * function itself rate-limits / sanity-checks its input. */
  var STEP_ENDPOINT =
    "https://www.zohoapis.eu/crm/v7/functions/shishaworldb2bonboardingformcreatelead/actions/execute?auth_type=apikey&zapikey=1003.0b08f668bda263ba81cb847d77df31f7.8ad9c959bffcec519169cf4b486fd8a9";

  /* Name of the Deluge function's argument. The step data is JSON-encoded into
   * this single parameter, i.e.  mp={"step":1,"email":"a@b.com",...}
   *
   * It MUST go in the query string. Verified 2026-07-15 against the live
   * function: Zoho reads arguments from the URL only and ignores the request
   * body — an identical payload sent as a urlencoded body arrived as mp=null,
   * while the same JSON in the query string arrived intact. */
  var STEP_ENDPOINT_ARG = "mp";

  /* Guards the query string against Zoho's URL length limit. `additional_info`
   * is the only free-text field long enough to matter; it is truncated rather
   * than allowed to silently break the whole request. */
  var MAX_ARG_CHARS = 6000;

  /* Verified 2026-07-15: zohoapis.eu returns no Access-Control-Allow-Origin,
   * and answers the CORS preflight with 401 rather than approving it. So:
   *   - the body MUST stay application/x-www-form-urlencoded (a CORS "simple
   *     request") or the preflight kills it before it is ever sent;
   *   - the response is unreadable, hence no-cors / opaque below.
   * The POST is still delivered and the function still runs; we just cannot see
   * what it returned. Flip to false only if Zoho starts sending CORS headers. */
  var STEP_ENDPOINT_OPAQUE = true;

  // The original Zoho Forms endpoint from the export. Submitted at the end.
  var ZOHO_FORM_ACTION =
    "https://forms.zohopublic.eu/ookaportal/form/ShishaWorldB2BOnboarding/formperma/8ZW0_sUo-Cj-T_lo3TrRq1KY2WlNFNvoDEb7W6VAsu8/htmlRecords/submit";

  // Zoho Forms marks Address_Region (State/Region/Province) mandatory, but the
  // design has no field for it. We copy City into it so the submission is not
  // rejected. FIX PROPERLY by making Region optional in the Zoho form builder,
  // then set this to false.
  var COPY_CITY_INTO_REGION = true;

  // Where Zoho sends the user after a successful record submission. Left empty
  // so we can keep the user on this page and show our own thank-you block.
  var ZOHO_REDIRECT_URL = "";

  var MAX_FILE_BYTES = 5 * 1024 * 1024;

  /* Our field name -> Zoho Forms field name.
   * `street` and `house_number` are merged into Address_AddressLine1 because
   * the Zoho form has no separate house-number field. */
  var ZOHO_FIELD_MAP = {
    business_unit: "SingleLine4", // hidden constant, "SHISHA WORLD B2B"
    email: "Email",
    first_name: "Name_First",
    last_name: "Name_Last",
    mobile_phone: "PhoneNumber_countrycode",
    business_phone: "PhoneNumber1_countrycode",
    company_name: "SingleLine",
    business_type: "Dropdown",
    terms: "DecisionBox",
    marketing_opt_in: "DecisionBox1",
    address_type: "Dropdown1",
    country: "Address_Country",
    post_code: "Address_ZipCode",
    city: "Address_City",
    additional_info: "MultiLine",
    default_shipping: "DecisionBox2",
    vat_id: "SingleLine1",
    register_number: "SingleLine2",
    fid: "SingleLine3",
    vat_document: "FileUpload",
    register_document: "FileUpload1",
  };

  /* ============================================================
   * Step definitions
   * ============================================================ */

  /* `transport` decides what a step's button does:
   *   "webhook" — POST just this step's fields to STEP_ENDPOINT
   *   "zoho"    — submit the whole form to Zoho Forms (final step only) */
  var STEPS = [
    {
      n: 1,
      nextLabel: "Speichern und weiter",
      transport: "webhook",
      fields: [
        "email",
        "first_name",
        "last_name",
        "mobile_phone",
        "business_phone",
        "company_name",
        "business_type",
        "terms",
        "marketing_opt_in",
      ],
    },
    {
      n: 2,
      nextLabel: "Speichern und weiter",
      transport: "webhook",
      fields: [
        "address_type",
        "country",
        "street",
        "house_number",
        "post_code",
        "city",
        "additional_info",
        "default_shipping",
      ],
    },
    {
      n: 3,
      nextLabel: "Registrierung abschließen",
      transport: "zoho",
      fields: [
        "vat_id",
        "register_number",
        "fid",
        "vat_document",
        "register_document",
      ],
    },
  ];

  /* ============================================================
   * Validation — regexes lifted from Zoho's own validation.js so the
   * client-side rules stay identical to what the form expects.
   * ============================================================ */

  var EMAIL_RE =
    /^[\w]([\w\-.+&'/]*)@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,22}$/;
  var PHONE_RE = /^[+]{0,1}[()0-9-. ]+$/;

  var MESSAGES = {
    required: "Dieses Feld ist erforderlich.",
    email: "Bitte gib eine gültige E-Mail-Adresse ein.",
    phone: "Bitte gib eine gültige Telefonnummer ein.",
    terms: "Bitte akzeptiere die Allgemeinen Geschäftsbedingungen, um fortzufahren.",
    fileSize: "Die Datei ist zu groß (max. 5 MB).",
  };

  /* ============================================================
   * State + DOM
   * ============================================================ */

  var form = document.getElementById("onboarding");
  var progress = document.getElementById("progress");
  var backBtn = document.getElementById("backBtn");
  var nextBtn = document.getElementById("nextBtn");
  var nextLabel = nextBtn.querySelector(".sw-btnLabel");
  var loginHint = document.getElementById("loginHint");
  var formError = document.getElementById("formError");

  var current = 0; // index into STEPS
  var busy = false;

  function el(name) {
    return form.elements[name];
  }

  function fieldWrap(name) {
    var node = el(name);
    return node ? node.closest(".sw-field, .sw-check") : null;
  }

  function valueOf(name) {
    var node = el(name);
    if (!node) return "";
    if (node.type === "checkbox") return node.checked;
    if (node.type === "file") return node.files[0] || null;
    return node.value.trim();
  }

  /* ============================================================
   * Validation
   * ============================================================ */

  // Returns an error message, or "" when the field is fine.
  function checkField(name) {
    var node = el(name);
    if (!node) return "";

    var val = valueOf(name);
    var required = node.hasAttribute("data-required");

    if (node.type === "checkbox") {
      if (required && !val) return name === "terms" ? MESSAGES.terms : MESSAGES.required;
      return "";
    }

    if (node.type === "file") {
      if (val && val.size > MAX_FILE_BYTES) return MESSAGES.fileSize;
      return "";
    }

    if (required && !val) return MESSAGES.required;
    if (!val) return ""; // optional and empty — nothing more to check

    if (node.type === "email" && !EMAIL_RE.test(val)) return MESSAGES.email;
    if (node.getAttribute("data-check") === "phone" && !PHONE_RE.test(val))
      return MESSAGES.phone;

    return "";
  }

  function showError(name, msg) {
    var slot = form.querySelector('[data-error-for="' + name + '"]');
    var wrap = fieldWrap(name);
    if (slot) {
      slot.textContent = msg || "";
      slot.classList.toggle("sw-show", !!msg);
    }
    if (wrap) wrap.classList.toggle("sw-invalid", !!msg);
  }

  function clearError(name) {
    showError(name, "");
  }

  function stepIsValid(step) {
    return step.fields.every(function (name) {
      return !checkField(name);
    });
  }

  // Paint every error for the step at once — used when Next is pressed.
  function paintStepErrors(step) {
    var firstBad = null;
    step.fields.forEach(function (name) {
      var msg = checkField(name);
      showError(name, msg);
      if (msg && !firstBad) firstBad = name;
    });
    if (firstBad && el(firstBad)) el(firstBad).focus();
    return !firstBad;
  }

  /* ============================================================
   * Rendering
   * ============================================================ */

  function render() {
    var step = STEPS[current];

    Array.prototype.forEach.call(form.querySelectorAll(".sw-step"), function (s) {
      s.classList.toggle("sw-active", Number(s.dataset.step) === step.n);
    });

    Array.prototype.forEach.call(progress.children, function (li) {
      li.classList.toggle("sw-reached", Number(li.dataset.step) <= step.n);
    });

    nextLabel.textContent = step.nextLabel;
    backBtn.hidden = current === 0;
    loginHint.hidden = current !== 0;

    syncNextBtn();
    hideFormError();
  }

  function syncNextBtn() {
    nextBtn.disabled = busy || !stepIsValid(STEPS[current]);
  }

  function setBusy(state) {
    busy = state;
    nextBtn.classList.toggle("sw-busy", state);
    backBtn.disabled = state;
    syncNextBtn();
  }

  function showFormError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }

  function hideFormError() {
    formError.hidden = true;
  }

  /* ============================================================
   * Per-step POST
   * ============================================================ */

  /* The map handed to the Deluge function as `mp`.
   *
   * Steps 1 and 2 carry no file fields, so nothing is base64'd here — the
   * document bytes go to Zoho Forms in the final multipart submit instead.
   *
   * Booleans stay real booleans and `step` stays a real number: this is JSON,
   * so Deluge receives them as Bool/Number rather than the string "false",
   * which is truthy in Deluge and a classic source of inverted logic. */
  function payloadFor(step) {
    var data = { step: step.n, email: valueOf("email") };

    step.fields.forEach(function (name) {
      var node = el(name);
      if (!node || node.type === "file") return;
      data[name] = valueOf(name); // checkbox -> boolean, everything else -> string
    });
    return data;
  }

  async function callStepEndpoint(step) {
    if (!STEP_ENDPOINT) {
      console.warn("[onboarding] no STEP_ENDPOINT — payload:", payloadFor(step));
      return { ok: true, skipped: true };
    }

    // The whole step goes in one argument as a JSON map, so Deluge can read it
    // with mp.get("email"). It goes in the QUERY STRING — Zoho ignores the
    // request body for function arguments.
    var data = payloadFor(step);
    var json = JSON.stringify(data);

    if (json.length > MAX_ARG_CHARS && data.additional_info) {
      var slack = json.length - MAX_ARG_CHARS;
      data.additional_info = data.additional_info.slice(0, -slack) + "…";
      json = JSON.stringify(data);
      console.warn("[onboarding] additional_info truncated to fit the URL limit");
    }

    var url =
      STEP_ENDPOINT +
      (STEP_ENDPOINT.indexOf("?") === -1 ? "?" : "&") +
      STEP_ENDPOINT_ARG +
      "=" +
      encodeURIComponent(json);

    console.info("[onboarding] step " + step.n + " -> " + STEP_ENDPOINT_ARG + ":", data);

    // No body: Zoho would ignore it anyway. Staying free of custom headers keeps
    // this a CORS "simple request" so no preflight is triggered.
    var res = await fetch(url, {
      method: "POST",
      mode: STEP_ENDPOINT_OPAQUE ? "no-cors" : "cors",
    });

    // An opaque response exposes no status or body; reaching here without a
    // network error is all the confirmation we can get.
    if (STEP_ENDPOINT_OPAQUE) return { ok: true, opaque: true };

    if (!res.ok) throw new Error("Step endpoint returned HTTP " + res.status);

    var json = await res.json().catch(function () {
      return null;
    });
    if (json && json.ok === false) {
      return { ok: false, field: json.field, message: json.message };
    }
    return { ok: true, data: json };
  }

  /* ============================================================
   * Final Zoho Forms submit
   * ============================================================
   * A plain, top-level multipart form POST — exactly what index.zoho-export.html
   * did. The browser navigates to Zoho's response, so Zoho shows its own
   * thank-you / error page and we never mask a failed submission.
   *
   * Not fetch(): the endpoint sends no CORS headers. Not a hidden iframe
   * either — that hid Zoho's response and made failures look like successes.
   */

  function buildZohoValues() {
    var values = {};

    Object.keys(ZOHO_FIELD_MAP).forEach(function (ours) {
      var node = el(ours);
      if (!node || node.type === "file") return;
      values[ZOHO_FIELD_MAP[ours]] = valueOf(ours);
    });

    // Zoho has one street line; the design splits street and house number.
    var street = valueOf("street");
    var house = valueOf("house_number");
    values.Address_AddressLine1 = (street + " " + house).trim();

    if (COPY_CITY_INTO_REGION) values.Address_Region = valueOf("city");

    return values;
  }

  function submitToZohoForms() {
    var proxy = document.createElement("form");
    proxy.action = ZOHO_FORM_ACTION;
    proxy.method = "POST";
    proxy.enctype = "multipart/form-data";
    proxy.acceptCharset = "UTF-8";
    proxy.style.display = "none";

    function addHidden(name, value) {
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      proxy.appendChild(input);
    }

    addHidden("zf_referrer_name", "");
    addHidden("zf_redirect_url", ZOHO_REDIRECT_URL);
    addHidden("zc_gad", "");

    var values = buildZohoValues();
    Object.keys(values).forEach(function (zohoName) {
      var value = values[zohoName];

      // Checkboxes must serialise exactly as the original export did: present
      // and "on" when ticked, absent entirely when not.
      if (typeof value === "boolean") {
        if (value) addHidden(zohoName, "on");
        return;
      }
      addHidden(zohoName, value == null ? "" : String(value));
    });

    // Real File objects have to be moved into the proxy form's own file inputs;
    // a hidden text input cannot carry bytes.
    ["vat_document", "register_document"].forEach(function (ours) {
      var source = el(ours);
      if (!source || !source.files.length) return;

      var input = document.createElement("input");
      input.type = "file";
      input.name = ZOHO_FIELD_MAP[ours];
      proxy.appendChild(input);

      var dt = new DataTransfer();
      dt.items.add(source.files[0]);
      input.files = dt.files;
    });

    document.body.appendChild(proxy);

    // The export set document.charset here; that property is read-only now and
    // assigning to it throws under "use strict". acceptCharset above does the
    // same job.
    console.info("[onboarding] submitting to Zoho Forms:", values);
    proxy.submit(); // navigates away; nothing after this runs
  }

  /* ============================================================
   * Navigation
   * ============================================================ */

  async function advance() {
    var step = STEPS[current];
    if (busy) return;

    hideFormError();
    if (!paintStepErrors(step)) return;

    setBusy(true);

    // The final step hands off to Zoho and the browser leaves this page, so the
    // spinner stays up until navigation happens.
    if (step.transport === "zoho") {
      submitToZohoForms();
      return;
    }

    try {
      var result = await callStepEndpoint(step);

      if (!result.ok) {
        setBusy(false);
        if (result.field && el(result.field)) {
          showError(result.field, result.message || MESSAGES.required);
          el(result.field).focus();
        } else {
          showFormError(
            result.message || "Etwas ist schiefgelaufen. Bitte versuche es erneut."
          );
        }
        return;
      }
    } catch (err) {
      console.error("[onboarding] step " + step.n + " failed:", err);
      setBusy(false);
      showFormError(
        "Der Server ist nicht erreichbar. Bitte prüfe deine Verbindung und versuche es erneut."
      );
      return;
    }
    setBusy(false);

    current++;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goBack() {
    if (busy || current === 0) return;
    current--;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ============================================================
   * Wiring
   * ============================================================ */

  function populateCountries() {
    var select = el("country");
    var frag = document.createDocumentFragment();
    (window.SW_COUNTRIES || []).forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      frag.appendChild(opt);
    });
    select.appendChild(frag);
  }

  function initDropZones() {
    Array.prototype.forEach.call(form.querySelectorAll(".sw-drop"), function (zone) {
      var input = zone.querySelector('input[type="file"]');
      var label = zone.querySelector(".sw-dropFile");

      function paint() {
        var file = input.files[0];
        if (!file) {
          label.hidden = true;
          label.textContent = "";
          return;
        }
        label.hidden = false;
        label.textContent = file.name + " (" + Math.round(file.size / 1024) + " KB)";

        var clear = document.createElement("button");
        clear.type = "button";
        clear.className = "sw-dropClear";
        clear.textContent = "Entfernen";
        clear.addEventListener("click", function (e) {
          e.stopPropagation();
          input.value = "";
          paint();
          clearError(input.name);
          syncNextBtn();
        });
        label.appendChild(clear);
      }

      ["dragenter", "dragover"].forEach(function (ev) {
        zone.addEventListener(ev, function (e) {
          e.preventDefault();
          zone.classList.add("sw-dragging");
        });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        zone.addEventListener(ev, function () {
          zone.classList.remove("sw-dragging");
        });
      });

      zone.addEventListener("drop", function (e) {
        e.preventDefault();
        if (!e.dataTransfer.files.length) return;
        // DataTransfer -> input.files is the only way to keep the native input
        // as the single source of truth for the file.
        var dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });

      input.addEventListener("change", paint);
    });
  }

  function initSelectPlaceholders() {
    Array.prototype.forEach.call(form.querySelectorAll("select"), function (sel) {
      function paint() {
        sel.classList.toggle("sw-empty", !sel.value);
      }
      sel.addEventListener("change", paint);
      paint();
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    advance();
  });

  backBtn.addEventListener("click", goBack);

  // Live-enable the Next button as the user types.
  form.addEventListener("input", syncNextBtn);
  form.addEventListener("change", syncNextBtn);

  // Show a field's error only once the user has left it, not while typing.
  form.addEventListener(
    "blur",
    function (e) {
      var name = e.target.name;
      if (name && STEPS[current].fields.indexOf(name) !== -1) {
        showError(name, checkField(name));
      }
    },
    true
  );

  // Clear a visible error as soon as the value becomes valid again.
  form.addEventListener("input", function (e) {
    var name = e.target.name;
    if (name && !checkField(name)) clearError(name);
  });

  populateCountries();
  initDropZones();
  initSelectPlaceholders();
  render();
})();
