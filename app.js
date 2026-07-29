// Safe defensive Storage wrappers to prevent "SecurityError: Access is denied" under strict local file:/// protocol settings
const safeStorage = {
  get(type, key, fallback = "") {
    try {
      const val = window[type].getItem(key);
      return val !== null ? val : fallback;
    } catch (e) {
      console.warn(`Storage access blocked for ${type}.${key}, using fallback.`, e);
      return this._mem[type][key] !== undefined ? this._mem[type][key] : fallback;
    }
  },
  set(type, key, val) {
    try {
      window[type].setItem(key, val);
    } catch (e) {
      console.warn(`Storage set blocked for ${type}.${key}`, e);
      this._mem[type][key] = String(val);
    }
  },
  remove(type, key) {
    try {
      window[type].removeItem(key);
    } catch (e) {
      console.warn(`Storage remove blocked for ${type}.${key}`, e);
      delete this._mem[type][key];
    }
  },
  _mem: { localStorage: {}, sessionStorage: {} }
};

function escapeHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let assets = JSON.parse(safeStorage.get("localStorage", "assetGuard_assets")) || [];
let html5QrScanner = null;
let activeCategory = "All";
let activeStatus = "All";
let searchQuery = "";
let currentPage = 1;
let assetsPerPage = 50; // Dynamic client-side layout pagination (default 50 per page!)
let isScannerStarting = false;
let shouldStopScanner = false;
let currentLanguage = safeStorage.get("localStorage", "assetGuard_lang") || "en";
// Clean up legacy pre-filled parameters from previous sessions
if (safeStorage.get("localStorage", "assetGuard_cloud_id") === "smm-sandbox") safeStorage.remove("localStorage", "assetGuard_cloud_id");
if (safeStorage.get("localStorage", "assetGuard_workspace_id") === "3") safeStorage.remove("localStorage", "assetGuard_workspace_id");
if (safeStorage.get("sessionStorage", "assetGuard_email") === "llee_smm@smm.com") safeStorage.remove("sessionStorage", "assetGuard_email");
let isOfflineMode = safeStorage.get("localStorage", "assetGuard_offline_mode") === "true";

let apiConfig = {
  cloudId: safeStorage.get("localStorage", "assetGuard_cloud_id") || "",
  workspaceId: safeStorage.get("localStorage", "assetGuard_workspace_id") || "",
  email: safeStorage.get("sessionStorage", "assetGuard_email") || "",
  token: safeStorage.get("sessionStorage", "assetGuard_token") || "",
  syncLimit: parseInt(safeStorage.get("localStorage", "assetGuard_sync_limit")) || 100
};
let atlassianBaseUrl = safeStorage.get("sessionStorage", "assetGuard_base_url") || "";

// State persistence
function saveState() {
  safeStorage.set("localStorage", "assetGuard_assets", JSON.stringify(assets));
  safeStorage.set("localStorage", "assetGuard_lang", currentLanguage);
  safeStorage.set("localStorage", "assetGuard_offline_mode", isOfflineMode);
  
  // Save non-confidential routing IDs persistently to bypass slow auto-resolution hops
  safeStorage.set("localStorage", "assetGuard_cloud_id", apiConfig.cloudId);
  safeStorage.set("localStorage", "assetGuard_workspace_id", apiConfig.workspaceId);
  safeStorage.set("localStorage", "assetGuard_sync_limit", apiConfig.syncLimit);
  
  // Save highly-confidential credentials in temporary session storage
  safeStorage.set("sessionStorage", "assetGuard_email", apiConfig.email);
  safeStorage.set("sessionStorage", "assetGuard_token", apiConfig.token);
}

// Native sessionStorage is already automatically wiped by the browser when the tab or browser is closed.
// Keeping sessionStorage intact on page refreshes ensures a smooth user experience!

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  // Initialize Data from LocalStorage or start empty
  const savedAssets = safeStorage.get("localStorage", "assetGuard_assets");
  const seeds = window.itAssetSeeds || [];
  
  if (savedAssets) {
    try {
      assets = JSON.parse(savedAssets);
      // Filter out any mock seed devices to get rid of the fake devices permanently
      const seedIds = seeds.map(s => (s.id || "").toLowerCase());
      assets = assets.filter(a => !seedIds.includes((a.id || "").toLowerCase()));
      saveState();
    } catch (e) {
      console.error("Failed to parse local storage assets, resetting.", e);
      assets = [];
      saveState();
    }
  } else {
    // Start with a completely clean database
    assets = [];
    saveState();
  }

  // Initial Render
  updateMetrics();
  renderAssetList();
  applyTranslations(currentLanguage);
  setupEventListeners();
  toggleOfflineUI(isOfflineMode);
});
// Atlassian Connection Status Dashboard and Auto-Resolution Helpers
function isValidUUID(str) {
  if (!str) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str.trim());
}

// Parse smart QR codes containing JSON, URL query parameters, Atlassian URLs, pure numbers, or raw ID strings
function parseScannedContent(text) {
  const result = {
    id: "",
    name: "",
    category: "Laptop",
    serial: "",
    location: "",
    condition: "Healthy",
    cpu: "",
    ram: "",
    storage: "",
    os: ""
  };

  const trimmed = text.trim();
  if (!trimmed) return result;



  // 1. Try JSON
  try {
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const data = JSON.parse(trimmed);
      if (data.id) result.id = String(data.id);
      if (data.name) result.name = String(data.name);
      if (data.category) result.category = String(data.category);
      if (data.serial) result.serial = String(data.serial);
      if (data.serialNumber) result.serial = String(data.serialNumber);
      if (data.location) result.location = String(data.location);
      if (data.condition) result.condition = String(data.condition);
      
      if (data.specs) {
        if (data.specs.cpu) result.cpu = String(data.specs.cpu);
        if (data.specs.ram) result.ram = String(data.specs.ram);
        if (data.specs.storage) result.storage = String(data.specs.storage);
        if (data.specs.os) result.os = String(data.specs.os);
      } else {
        if (data.cpu) result.cpu = String(data.cpu);
        if (data.ram) result.ram = String(data.ram);
        if (data.storage) result.storage = String(data.storage);
        if (data.os) result.os = String(data.os);
      }
      return result;
    }
  } catch (e) {
    console.log("QR parse: Not a JSON string", e);
  }

  // 1.5. Special check: Try to extract Atlassian Assets IDs if it contains .atlassian.net
  if (trimmed.includes(".atlassian.net")) {
    try {
      const urlObj = new URL(trimmed);
      const objId = urlObj.searchParams.get("objectId") || urlObj.searchParams.get("selectedObjectId");
      if (objId) {
        result.id = "smm" + objId;
        result.serial = trimmed;
        return result;
      }
    } catch (e) {
      console.log("QR parse: Atlassian URL parser error", e);
    }
  }

  // 2. Try URL query parameters
  if (trimmed.includes("=") || trimmed.includes("&")) {
    try {
      let queryStr = trimmed;
      if (trimmed.includes("?")) {
        queryStr = trimmed.split("?")[1];
      }
      const params = new URLSearchParams(queryStr);
      
      let matchedAny = false;
      if (params.has("id")) { result.id = params.get("id"); matchedAny = true; }
      if (params.has("name")) { result.name = params.get("name"); matchedAny = true; }
      if (params.has("category")) { result.category = params.get("category"); matchedAny = true; }
      if (params.has("serial")) { result.serial = params.get("serial"); matchedAny = true; }
      if (params.has("serialNumber")) { result.serial = params.get("serialNumber"); matchedAny = true; }
      if (params.has("location")) { result.location = params.get("location"); matchedAny = true; }
      if (params.has("condition")) { result.condition = params.get("condition"); matchedAny = true; }
      if (params.has("cpu")) { result.cpu = params.get("cpu"); matchedAny = true; }
      if (params.has("ram")) { result.ram = params.get("ram"); matchedAny = true; }
      if (params.has("storage")) { result.storage = params.get("storage"); matchedAny = true; }
      if (params.has("os")) { result.os = params.get("os"); matchedAny = true; }
      
      if (matchedAny && result.id) {
        return result;
      }
    } catch (e) {
      console.log("QR parse: Not query parameters", e);
    }
  }

  // 3. Try to sniff if the text is an Atlassian Assets or generic URL containing a numeric ID
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.includes(".atlassian.net") || trimmed.includes("/assets/") || trimmed.includes("/object/")) {
    try {
      // Match patterns like /object/1234, /objects/1234, /assets/1234, /asset/1234 or a trailing /1234
      const objectMatch = trimmed.match(/\/object(?:s)?\/([0-9]+)/i);
      const assetsMatch = trimmed.match(/\/asset(?:s)?\/([0-9]+)/i);
      const trailingMatch = trimmed.match(/\/([0-9]+)(?:[?#]|$)/);

      let numericId = "";
      if (objectMatch) {
        numericId = objectMatch[1];
      } else if (assetsMatch) {
        numericId = assetsMatch[1];
      } else if (trailingMatch) {
        numericId = trailingMatch[1];
      }

      if (numericId) {
        result.id = "smm" + numericId;
        result.serial = trimmed; // Keep full URL as fallback serial
        return result;
      }
    } catch (e) {
      console.log("QR parse: Atlassian ID sniffer exception", e);
    }
  }

  // 4. Try to parse if it is a pure numeric ID (the digits next to the QR code, e.g. "1024" or "0421")
  if (/^[0-9]+$/.test(trimmed) && trimmed.length > 0) {
    result.id = "smm" + trimmed;
    result.serial = trimmed;
    return result;
  }

  // 5. Try to parse "M" prefixed tags (e.g. "M2379" -> "smm2379")
  if (trimmed.toLowerCase().startsWith("m") && /^[0-9]+$/.test(trimmed.substring(1))) {
    result.id = "smm" + trimmed.substring(1);
    result.serial = trimmed;
    return result;
  }

  // 6. Generic plain barcode/raw ID fallback
  result.id = trimmed;
  if (trimmed.length > 5) {
    result.serial = trimmed;
  }
  return result;
}

// Prefills the Add Asset form inputs with a parsed content object
function prefillAddAssetForm(parsed) {
  let normalizedId = parsed.id.trim().toUpperCase();
  if (normalizedId.startsWith("M") && normalizedId.length > 2) {
    normalizedId = "SMM" + normalizedId.substring(1);
  }

  document.getElementById("add-id").value = normalizedId;
  document.getElementById("add-name").value = parsed.name || "";
  document.getElementById("add-category").value = parsed.category || "Laptop";
  document.getElementById("add-serial").value = parsed.serial || "";
  document.getElementById("add-location").value = parsed.location || "";
  document.getElementById("add-condition").value = parsed.condition || "Healthy";
  document.getElementById("add-spec-cpu").value = parsed.cpu || "";
  document.getElementById("add-spec-ram").value = parsed.ram || "";
  document.getElementById("add-spec-storage").value = parsed.storage || "";
  document.getElementById("add-spec-os").value = parsed.os || "";
}

function updateConnectionUI(status, detailsMsg = "") {
  const card = document.getElementById("connection-status-card");
  const badge = document.getElementById("connection-status-badge");
  const details = document.getElementById("connection-status-details");

  if (!card || !badge || !details) return;

  // Clear previous state classes
  card.className = "connection-status-card " + status;
  badge.className = "connection-badge status-" + status;

  // Set translation/text
  if (status === "offline") {
    badge.textContent = "Offline Mode";
  } else {
    badge.textContent = t("conn_status_" + status);
  }

  // Persistence of connection state
  if (status !== "syncing" && status !== "offline") {
    safeStorage.set("localStorage", "assetGuard_last_sync_status", status);
    if (status === "connected") {
      const timeStr = new Date().toLocaleString();
      safeStorage.set("localStorage", "assetGuard_last_sync_time", timeStr);
      safeStorage.set("localStorage", "assetGuard_last_sync_error", "");
    } else if (status === "error") {
      safeStorage.set("localStorage", "assetGuard_last_sync_error", detailsMsg);
    }
  }

  // Set details content
  if (status === "offline") {
    details.innerHTML = `
      <span style="color: var(--accent-purple); font-weight: 600; display: flex; align-items: center; gap: 6px;">
        <i class="fa-solid fa-plane-slash"></i> Offline Sandbox Mode Active
      </span>
      <p style="margin-top: 4px; font-size: 11.5px; color: var(--text-secondary); line-height: 1.4;">
        The system is running purely in local-storage mode. Live synchronization with Atlassian is disabled, and changes are confined to your browser database.
      </p>
    `;
  } else if (status === "unconfigured") {
    details.innerHTML = `<span>${t("conn_status_details_unconfigured")}</span>`;
  } else if (status === "ready") {
    details.innerHTML = `<span>${t("conn_status_details_ready")}</span>`;
  } else if (status === "syncing") {
    details.innerHTML = `<span style="display: flex; align-items: center; gap: 8px;"><i class="fa-solid fa-spinner fa-spin"></i> ${detailsMsg || t("sync_loading")}</span>`;
  } else if (status === "connected") {
    const count = safeStorage.get("localStorage", "assetGuard_last_sync_count") || "0";
    const time = safeStorage.get("localStorage", "assetGuard_last_sync_time") || new Date().toLocaleString();
    details.innerHTML = `<span>${t("conn_status_details_connected", { time, count })}</span>`;
  } else if (status === "error") {
    const isFailedToFetch = detailsMsg.toLowerCase().includes("failed to fetch");
    if (isFailedToFetch) {
      details.innerHTML = `
        <span style="color: var(--status-error); font-weight: 600; display: flex; align-items: center; gap: 6px;"><i class="fa-solid fa-triangle-exclamation"></i> Browser CORS Block Detected</span>
        <p style="margin-top: 4px; font-size: 12px; color: var(--text-secondary);">
          Atlassian Cloud APIs restrict web browsers from making direct requests from external origins (CORS security).
        </p>
        
        <div style="margin-top: 12px; background: var(--bg-body); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 10px;">
          <div style="font-weight: 600; font-size: 12px; color: var(--text-primary); border-bottom: 1px solid var(--border-color); padding-bottom: 4px; display: flex; align-items: center; gap: 6px;">
            <i class="fa-solid fa-lightbulb" style="color: #FFC400;"></i> How to bypass this:
          </div>
          
          <div style="font-size: 11.5px; line-height: 1.4; color: var(--text-secondary);">
            <strong style="color: var(--text-primary);">Option A (Easiest - 10 seconds):</strong> Install a CORS Bypass browser extension:
            <ul style="margin: 6px 0 0 16px; padding: 0; list-style-type: disc;">
              <li>Search & install the extension: <strong>"Allow CORS: Access-Control-Allow-Origin"</strong> for Chrome/Firefox/Edge.</li>
              <li>Turn the extension <strong>ON</strong> (extension icon turns green).</li>
              <li>Click <strong>Sync from Atlassian</strong> again!</li>
            </ul>
          </div>
          
          <div style="font-size: 11.5px; line-height: 1.4; color: var(--text-secondary); border-top: 1px solid var(--border-color); padding-top: 8px;">
            <strong style="color: var(--text-primary);">Option B (Manual Inputs):</strong> Find your real UUIDs manually to bypass auto-resolution:
            <ol style="margin: 6px 0 0 16px; padding: 0; list-style-type: decimal;">
              <li>Open your Jira Assets web page in your browser.</li>
              <li>Press <strong>F12</strong> (Developer Tools), go to the <strong>Network</strong> tab.</li>
              <li>Search for <strong>"aql"</strong> or <strong>"workspace"</strong>, and click any completed request.</li>
              <li>Copy the UUIDs from the request URL:
                <ul style="margin-top: 2px; padding-left: 12px; list-style-type: circle;">
                  <li><strong>Workspace ID</strong> is the long UUID after <code style="font-family: monospace; color: var(--accent-blue);">/workspace/</code></li>
                  <li><strong>Cloud ID</strong> is the long UUID after <code style="font-family: monospace; color: var(--accent-blue);">/ex/jira/</code></li>
                </ul>
              </li>
              <li>Enter those UUIDs directly into the fields below to bypass auto-resolution!</li>
            </ol>
          </div>
        </div>
        
        <div class="error-details-block" style="margin-top: 10px;">Original System Error: ${escapeHTML(detailsMsg)}</div>
      `;
    } else {
      details.innerHTML = `
        <span>${t("conn_status_details_error")}</span>
        <div class="error-details-block">${escapeHTML(detailsMsg)}</div>
      `;
    }
  }
}

function toggleOfflineUI(isOffline) {
  const container = document.getElementById("atlassian-fields-container");
  const syncBtn = document.getElementById("sync-atlassian-btn");
  
  const cloudIdInput = document.getElementById("api-cloud-id");
  const workspaceIdInput = document.getElementById("api-workspace-id");
  const emailInput = document.getElementById("api-email");
  const tokenInput = document.getElementById("api-token");
  
  if (cloudIdInput && workspaceIdInput && emailInput && tokenInput) {
    if (isOffline) {
      cloudIdInput.removeAttribute("required");
      workspaceIdInput.removeAttribute("required");
      emailInput.removeAttribute("required");
      tokenInput.removeAttribute("required");
    } else {
      cloudIdInput.setAttribute("required", "");
      workspaceIdInput.setAttribute("required", "");
      emailInput.setAttribute("required", "");
      tokenInput.setAttribute("required", "");
    }
  }

  if (container) {
    if (isOffline) {
      container.classList.add("disabled-fade");
      const inputs = container.querySelectorAll("input, select, button");
      inputs.forEach(i => i.disabled = true);
    } else {
      container.classList.remove("disabled-fade");
      const inputs = container.querySelectorAll("input, select, button");
      inputs.forEach(i => {
        i.disabled = false;
      });
    }
  }

  if (syncBtn) {
    if (isOffline) {
      syncBtn.classList.add("disabled-fade");
      syncBtn.disabled = true;
    } else {
      syncBtn.classList.remove("disabled-fade");
      syncBtn.disabled = false;
    }
  }

  // Update Status Dashboard representation
  if (isOffline) {
    updateConnectionUI("offline");
  } else {
    // Restore normal representation
    if (!apiConfig.cloudId || !apiConfig.workspaceId || !apiConfig.email || !apiConfig.token) {
      updateConnectionUI("unconfigured");
    } else {
      const lastStatus = safeStorage.get("localStorage", "assetGuard_last_sync_status") || "ready";
      const lastError = safeStorage.get("localStorage", "assetGuard_last_sync_error") || "";
      updateConnectionUI(lastStatus, lastError);
    }
  }
}


async function resolveCloudId(subdomain) {
  const emailVal = (document.getElementById("api-email")?.value || "").trim() || apiConfig.email;
  const tokenVal = (document.getElementById("api-token")?.value || "").trim() || apiConfig.token;
  
  const headers = {};
  if (emailVal && tokenVal) {
    headers["Authorization"] = `Basic ${btoa(`${emailVal}:${tokenVal}`)}`;
  }
  headers["Accept"] = "application/json";

  const tenantInfoUrl = `https://${subdomain}.atlassian.net/_edge/tenant_info`;
  const serverInfoUrl = `https://${subdomain}.atlassian.net/rest/api/3/serverInfo`;
  const metadataUrl = `https://${subdomain}.atlassian.net/metadata/properties/id`;

  const urlsToTry = [tenantInfoUrl, serverInfoUrl, metadataUrl];

  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data) {
          if (data.cloudId) {
            console.log("Resolved Cloud ID from tenant_info successfully!");
            return data.cloudId;
          }
          if (data.baseUrl && data.baseUrl.includes("/ex/jira/")) {
            const match = data.baseUrl.match(/\/ex\/jira\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (match) {
              console.log("Resolved Cloud ID from serverInfo successfully!");
              return match[1];
            }
          }
          if (data.id) {
            console.log("Resolved Cloud ID from metadata successfully!");
            return data.id;
          }
        }
      }
    } catch (e) {
      console.warn(`Direct fetch to ${url} failed (likely CORS), trying proxy fallback...`, e);
      try {
        let parsed = null;
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const proxyRes = await fetch(proxyUrl);
        if (proxyRes.ok) {
          const proxyData = await proxyRes.json();
          if (proxyData && proxyData.contents) {
            parsed = JSON.parse(proxyData.contents);
          }
        }

        if (parsed) {
          if (parsed.cloudId) {
            console.log("Resolved Cloud ID via proxy from tenant_info successfully!");
            return parsed.cloudId;
          }
          if (parsed.baseUrl && parsed.baseUrl.includes("/ex/jira/")) {
            const match = parsed.baseUrl.match(/\/ex\/jira\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (match) {
              console.log("Resolved Cloud ID via proxy from serverInfo successfully!");
              return match[1];
            }
          }
          if (parsed.id) {
            console.log("Resolved Cloud ID via proxy from metadata successfully!");
            return parsed.id;
          }
        }
      } catch (proxyError) {
        console.error(`Proxy fetch to ${url} also failed:`, proxyError);
      }
    }
  }
  return null;
}

async function resolveWorkspaceId(cloudId, originalSubdomain) {
  const auth = btoa(`${apiConfig.email}:${apiConfig.token}`);
  const headers = {
    "Authorization": `Basic ${auth}`,
    "Accept": "application/json"
  };

  const urls = [];
  if (originalSubdomain) {
    urls.push(`https://${originalSubdomain}.atlassian.net/rest/servicedeskapi/assets/workspace`);
  }
  if (cloudId && cloudId.includes("-")) {
    urls.push(`https://api.atlassian.com/ex/jira/${cloudId}/rest/servicedeskapi/assets/workspace`);
  }
  
  // Backups
  if (originalSubdomain) {
    urls.push(`https://${originalSubdomain}.atlassian.net/rest/servicedeskapi/insight/workspace`);
  }
  if (cloudId && cloudId.includes("-")) {
    urls.push(`https://api.atlassian.com/ex/jira/${cloudId}/rest/servicedeskapi/insight/workspace`);
  }

  let resolvedId = null;
  let lastError = null;

  for (const url of urls) {
    try {
      console.log("Attempting to resolve Workspace ID from:", url);
      let res;
      try {
        res = await fetch(url, { method: "GET", headers });
      } catch (fetchErr) {
        console.warn(`Direct fetch to ${url} failed, attempting proxy fallback...`, fetchErr);
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const proxyRes = await fetch(proxyUrl);
        if (proxyRes.ok) {
          const proxyData = await proxyRes.json();
          if (proxyData && proxyData.contents) {
            const contentsText = proxyData.contents;
            res = {
              ok: true,
              status: 200,
              json: async () => JSON.parse(contentsText),
              text: async () => contentsText
            };
          }
        }
        if (!res) throw fetchErr; // Fall through to catch if proxy resolution failed entirely
      }

      if (res && res.ok) {
        const data = await res.json();
        if (data && data.values && data.values.length > 0 && data.values[0].workspaceId) {
          resolvedId = data.values[0].workspaceId;
          break;
        }
      } else if (res) {
        const txt = await res.text();
        lastError = new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
      }
    } catch (e) {
      lastError = e;
    }
  }

  if (resolvedId) {
    return resolvedId;
  } else {
    throw lastError || new Error("Workspace ID could not be found in response.");
  }
}

// Background Sync: Create object in Atlassian JSM Assets
async function pushNewAssetToAtlassian(asset) {
  if (isOfflineMode) {
    console.log("Atlassian Push (Create) bypassed: Active Offline Mode.");
    return;
  }
  if (!apiConfig.email || !apiConfig.token || !atlassianBaseUrl) {
    console.log("Atlassian Push (Create) bypassed: Missing configuration or base URL.");
    return;
  }

  const auth = btoa(`${apiConfig.email}:${apiConfig.token}`);
  const headers = {
    "Authorization": `Basic ${auth}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-ExperimentalApi": "opt-in"
  };

  const objectTypeId = safeStorage.get("localStorage", "assetGuard_detected_object_type_id") || "2";
  const attrMap = JSON.parse(safeStorage.get("localStorage", "assetGuard_attribute_map")) || {};

  const attributes = [];
  const addAttr = (name, val) => {
    const attrId = attrMap[name.toLowerCase()];
    if (attrId && val) {
      attributes.push({
        objectTypeAttributeId: attrId,
        objectAttributeValues: [{ value: String(val) }]
      });
    }
  };

  // Map fields dynamically based on synced schema mapping
  addAttr("Model", asset.name);
  addAttr("Category", asset.category);
  addAttr("Status", asset.status);
  addAttr("Owner", asset.owner);
  addAttr("Serial Number", asset.serialNumber || asset.serial);
  addAttr("Serial", asset.serialNumber || asset.serial);
  addAttr("Location", asset.location);
  
  if (asset.specs) {
    addAttr("CPU", asset.specs.cpu);
    addAttr("RAM", asset.specs.ram);
    addAttr("Storage", asset.specs.storage);
    addAttr("OS", asset.specs.os);
  }

  const payload = {
    objectTypeId,
    attributes
  };

  try {
    console.log("Pushing new asset to Atlassian:", payload);
    const res = await fetch(`${atlassianBaseUrl}/object`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.id) {
        console.log("Successfully created remote asset in Atlassian! ID:", data.id);
        asset.atlassianObjectId = data.id;
        saveState();
        showToast("Asset pushed to Atlassian Cloud!", "success");
      }
    } else {
      const txt = await res.text();
      console.warn("Atlassian POST failed:", txt);
    }
  } catch (err) {
    console.error("Atlassian POST network error:", err);
  }
}

// Background Sync: Update object in Atlassian JSM Assets
async function pushUpdateToAtlassian(asset) {
  if (isOfflineMode) {
    console.log("Atlassian Push (Update) bypassed: Active Offline Mode.");
    return;
  }
  if (!apiConfig.email || !apiConfig.token || !atlassianBaseUrl || !asset.atlassianObjectId) {
    console.log("Atlassian Push (Update) bypassed: Missing configuration, base URL, or remote ID.");
    return;
  }

  const auth = btoa(`${apiConfig.email}:${apiConfig.token}`);
  const headers = {
    "Authorization": `Basic ${auth}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-ExperimentalApi": "opt-in"
  };

  const attrMap = JSON.parse(safeStorage.get("localStorage", "assetGuard_attribute_map")) || {};

  const attributes = [];
  const addAttr = (name, val) => {
    const attrId = attrMap[name.toLowerCase()];
    if (attrId) {
      attributes.push({
        objectTypeAttributeId: attrId,
        objectAttributeValues: [{ value: String(val || "") }]
      });
    }
  };

  // Map the updateable fields
  addAttr("Status", asset.status);
  addAttr("Owner", asset.owner);
  addAttr("Location", asset.location);

  const payload = {
    attributes
  };

  try {
    console.log(`Pushing updates to Atlassian for asset ${asset.atlassianObjectId}:`, payload);
    const res = await fetch(`${atlassianBaseUrl}/object/${asset.atlassianObjectId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      console.log("Successfully updated remote asset in Atlassian!");
      showToast("Updates pushed to Atlassian Cloud!", "success");
    } else {
      const txt = await res.text();
      console.warn("Atlassian PUT failed:", txt);
    }
  } catch (err) {
    console.error("Atlassian PUT network error:", err);
  }
}

// Atlassian API Sync Logic
async function syncWithAtlassian() {
  if (isOfflineMode) {
    showToast("Sync bypassed: Active Offline Mode.", "warning");
    return;
  }
  if (!apiConfig.cloudId || !apiConfig.workspaceId || !apiConfig.email || !apiConfig.token) {
    showToast(t("notif_sync_error").replace("{error}", "Missing API Config (Cloud ID, Workspace ID, Email, or Token)"), "error");
    openModal("settings-modal");
    updateConnectionUI("error", "Missing configuration fields.");
    return;
  }

  // Prevent common user copy-paste errors where Cloud ID and Workspace ID are identical UUIDs
  if (apiConfig.cloudId.trim().toLowerCase() === apiConfig.workspaceId.trim().toLowerCase()) {
    const errorMsg = "Configuration Error: Your Cloud ID and Workspace ID are identical! They must be different UUIDs. Check Assets URL for Workspace ID.";
    updateConnectionUI("error", errorMsg);
    showToast(errorMsg, "error");
    openModal("settings-modal");
    return;
  }

  // Compile the list of all historic type IDs specified by the user to merge all their assets
  const allTypeIds = [
    3, 14, 23, 24, 28, 35, 43, 45, 52, 53, 55, 57, 59, 61, 65, 68, 70, 74, 75, 76, 80, 
    115, 138, 163, 164, 165, 169, 171, 172, 195, 197, 199, 202, 279
  ];
  const extractedTypeId = parseInt(safeStorage.get("localStorage", "assetGuard_extracted_type_id")) || null;
  if (extractedTypeId && !allTypeIds.includes(extractedTypeId)) {
    allTypeIds.push(extractedTypeId);
  }
  const targetAqlQuery = `objectType IN (${allTypeIds.join(", ")})`;
  console.log("Compiled multi-link targeted AQL query:", targetAqlQuery);

  updateConnectionUI("syncing", t("sync_loading"));
  showToast(t("sync_loading"), "info");

  // Keep track of our actual runtime Cloud ID and Workspace ID
  let targetCloudId = apiConfig.cloudId;
  let targetWorkspaceId = apiConfig.workspaceId;

  const isSubdomain = !targetCloudId.includes("-");

  // Stage 1: Auto-resolve Cloud ID if it is a subdomain
  if (isSubdomain) {
    console.log("Cloud ID is a subdomain. Attempting to resolve to UUID...");
    updateConnectionUI("syncing", "Resolving Cloud ID...");
    const resolvedCloud = await resolveCloudId(targetCloudId);
    if (resolvedCloud) {
      // Save the human-readable subdomain before we overwrite apiConfig.cloudId with the UUID!
      safeStorage.set("localStorage", "assetGuard_subdomain", targetCloudId);
      
      console.log("Resolved Cloud ID UUID:", resolvedCloud);
      targetCloudId = resolvedCloud;
      // Also update stored config so we don't have to resolve next time
      apiConfig.cloudId = resolvedCloud;
      const cloudInput = document.getElementById("api-cloud-id");
      if (cloudInput) cloudInput.value = resolvedCloud;
      saveState();
    }
  }

  // Stage 2: Auto-resolve Workspace ID if it is a schema ID (not a UUID)
  if (!isValidUUID(targetWorkspaceId)) {
    console.log(`Workspace ID '${targetWorkspaceId}' is a Schema ID. Attempting auto-resolution...`);
    updateConnectionUI("syncing", "Resolving Workspace ID...");
    try {
      const originalSubdomain = !apiConfig.cloudId.includes("-") ? apiConfig.cloudId : (isSubdomain ? apiConfig.cloudId : null);
      const resolvedWorkspace = await resolveWorkspaceId(targetCloudId, originalSubdomain);
      if (resolvedWorkspace) {
        console.log("Resolved Workspace ID UUID:", resolvedWorkspace);
        targetWorkspaceId = resolvedWorkspace;
        // Save back to state
        apiConfig.workspaceId = resolvedWorkspace;
        const workspaceInput = document.getElementById("api-workspace-id");
        if (workspaceInput) workspaceInput.value = resolvedWorkspace;
        saveState();
        showToast("Workspace ID resolved automatically!", "success");
      }
    } catch (err) {
      console.error("Workspace ID resolution failed:", err.message);
      let diagMsg = "Could not resolve Schema ID to Atlassian Workspace UUID.";
      if (err.message.includes("401") || err.message.includes("unauthorized") || err.message.includes("Unauthorized")) {
        diagMsg = "Auth failed (HTTP 401). Please verify your Atlassian Email and API Token in settings!";
      } else if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError") || err.message.includes("abort")) {
        diagMsg = "Network blocked! Please make sure your Chrome 'Allow CORS' extension is turned ON!";
      } else {
        diagMsg = `Resolution failed: ${err.message}. Try pasting your long Workspace UUID directly!`;
      }
      updateConnectionUI("error", diagMsg);
      showToast(diagMsg, "error");
      return; // Stop the sync immediately to prevent misleading 404 dead link screens!
    }
  }

  updateConnectionUI("syncing", "Fetching Assets from Atlassian...");

  // Define the common Atlassian Assets API path variants using final UUIDs
  const paths = [];
  
  // 1. Prioritize known working base URL if we have synced successfully before
  if (atlassianBaseUrl) {
    // If targetWorkspaceId is a UUID but the cached base URL contains a legacy schema integer ID,
    // or vice versa, discard the stale cached base URL to avoid 404 loops or slow timeouts!
    const isTargetUuid = isValidUUID(targetWorkspaceId);
    const cachedContainsUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(atlassianBaseUrl);
    
    if (isTargetUuid === cachedContainsUuid) {
      const verifiedPath = `${atlassianBaseUrl}/object/aql`;
      paths.push(verifiedPath);
    } else {
      console.warn("Discarding stale cached base URL due to format mismatch:", atlassianBaseUrl);
      safeStorage.remove("sessionStorage", "assetGuard_base_url");
      atlassianBaseUrl = "";
    }
  }

  // 2. High-speed Official public API Gateway paths (using resolved UUIDs)
  if (targetCloudId && targetCloudId.includes("-")) {
    const p1 = `https://api.atlassian.com/ex/jira/${targetCloudId}/jsm/assets/workspace/${targetWorkspaceId}/v1/object/aql`;
    const p2 = `https://api.atlassian.com/ex/jira/${targetCloudId}/assets/workspace/${targetWorkspaceId}/v1/object/aql`;
    if (!paths.includes(p1)) paths.push(p1);
    if (!paths.includes(p2)) paths.push(p2);
  }

  // 3. Fallbacks (only if direct UUID paths fail)
  const originalSubdomainText = !apiConfig.cloudId.includes("-") ? apiConfig.cloudId : null;
  if (originalSubdomainText) {
    const p = `https://${originalSubdomainText}.atlassian.net/gateway/api/jsm/assets/workspace/${targetWorkspaceId}/v1/object/aql`;
    if (!paths.includes(p)) paths.push(p);
  }
  const pFallback = `https://api.atlassian.com/jsm/assets/workspace/${targetWorkspaceId}/v1/object/aql`;
  if (!paths.includes(pFallback)) paths.push(pFallback);

  let success = false;
  let lastError = null;
  let remoteAssets = [];

  for (let i = 0; i < paths.length; i++) {
    let pageStart = 0;
    const pageLimit = 25; // Atlassian enforces a strict maximum page-size limit of 25 for AQL queries. Keeping this at 25 allows smooth, infinite page-looping!
    let allValuesForPath = [];
    let pathSuccess = false;
    let hasMore = true;

    while (hasMore) {
      const currentUrl = `${paths[i]}?start=${pageStart}&limit=${pageLimit}&resultsPerPage=${pageLimit}&cb=${Date.now()}`;
      console.log(`Syncing page starting at ${pageStart}...`, currentUrl);

      // Create a 5-second network timeout controller to prevent syncing hangs
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const auth = btoa(`${apiConfig.email}:${apiConfig.token}`);
        const response = await fetch(currentUrl, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-ExperimentalApi": "opt-in"
          },
          body: JSON.stringify({
            qlQuery: targetAqlQuery,
            includeAttributes: true,
            start: pageStart,
            resultsPerPage: pageLimit
          })
        });

        clearTimeout(timeoutId);

        if (response && response.ok) {
          const data = await response.json();
          if (data && data.values && data.values.length > 0) {
            allValuesForPath = allValuesForPath.concat(data.values);
            
            // Provide active, real-time download count in the UI so they know it is busy downloading
            updateConnectionUI("syncing", `Syncing: Loaded ${allValuesForPath.length} assets...`);
            
            // Advance start offset by the actual number of assets returned
            pageStart += data.values.length;
            
            // Check if we retrieved everything or reached our dynamic safety sync limit
            const maxSyncLimit = apiConfig.syncLimit || 100;
            if (allValuesForPath.length >= maxSyncLimit) {
              console.log(`Reached safety sync limit of ${maxSyncLimit} assets.`);
              hasMore = false;
            } else if (data.totalFilterCount !== undefined) {
              if (allValuesForPath.length >= data.totalFilterCount) {
                hasMore = false;
              }
            } else {
              // Fallback: Stop if less than the requested limit is returned
              if (data.values.length < pageLimit || data.isLastPage === true) {
                hasMore = false;
              }
            }
            pathSuccess = true;
          } else {
            hasMore = false;
          }
        } else if (response) {
          const errText = await response.text();
          let errTextClean = errText || response.statusText;
          if (response.status === 404) {
            errTextClean = "Jira Assets path not found (404 Not Found). This usually means either your Cloud UUID or Workspace UUID is mismatched or unresolved.";
          }
          lastError = new Error(`HTTP ${response.status}: ${errTextClean}`);
          console.warn(`Page starting at ${pageStart} failed:`, lastError.message);
          hasMore = false;
          pathSuccess = false;
        }
      } catch (err) {
        lastError = err;
        console.warn(`Exception on page starting at ${pageStart}:`, err.message);
        hasMore = false;
        pathSuccess = false;
      }
    }

    if (pathSuccess && allValuesForPath.length > 0) {
      remoteAssets = allValuesForPath.map(mapAtlassianObject);
      success = true;

      // Save working base URL and dynamic mapping
      const currentBase = paths[i].replace("/object/aql", "");
      safeStorage.set("sessionStorage", "assetGuard_base_url", currentBase);
      atlassianBaseUrl = currentBase;

      // Build attribute ID mapping dynamically from the synced assets' attributes
      const attrMap = {};
      let detectedObjectTypeId = "";
      allValuesForPath.forEach(obj => {
        if (obj.objectType && obj.objectType.id) {
          detectedObjectTypeId = obj.objectType.id;
        }
        if (obj.attributes) {
          obj.attributes.forEach(attr => {
            if (attr.objectTypeAttribute && attr.objectTypeAttribute.name && attr.objectTypeAttribute.id) {
              attrMap[attr.objectTypeAttribute.name.toLowerCase()] = attr.objectTypeAttribute.id;
            }
          });
        }
      });
      if (detectedObjectTypeId) {
        safeStorage.set("localStorage", "assetGuard_detected_object_type_id", detectedObjectTypeId);
      }
      safeStorage.set("localStorage", "assetGuard_attribute_map", JSON.stringify(attrMap));

      console.log(`Sync succeeded on Path ${i + 1} with ${allValuesForPath.length} total assets retrieved!`);
      break; // Stop trying other paths
    }
  }

  if (success) {
    // Merge strategy: Remote Overwrites Local (Atlassian Wins)
    remoteAssets.forEach(remote => {
      const index = assets.findIndex(a => a.id.toLowerCase() === remote.id.toLowerCase());
      if (index !== -1) {
        assets[index] = { ...assets[index], ...remote };
      } else {
        assets.push(remote);
      }
    });

    safeStorage.set("localStorage", "assetGuard_last_sync_count", remoteAssets.length);
    saveState();
    updateMetrics();
    renderAssetList();
    updateConnectionUI("connected");
    showToast(t("notif_sync_success").replace("{count}", remoteAssets.length), "success");
  } else {
    console.error("All sync paths failed. Last error:", lastError);
    const errMsg = lastError ? lastError.message : "404 Not Found";
    updateConnectionUI("error", errMsg);
    showToast(t("notif_sync_error").replace("{error}", errMsg), "error");
  }
}

function mapAtlassianObject(obj) {
  const getAttr = (name) => {
    if (!obj.attributes) return "";
    const attr = obj.attributes.find(a => a.objectTypeAttribute && a.objectTypeAttribute.name.toLowerCase() === name.toLowerCase());
    return attr && attr.objectAttributeValues && attr.objectAttributeValues.length > 0 ? attr.objectAttributeValues[0].displayValue : "";
  };

  return {
    atlassianObjectId: obj.id, // Store original Jira Assets ID
    id: obj.label || obj.id,
    name: obj.name || obj.label || obj.id,
    model: getAttr("Model") || obj.name || "Standard Model",
    category: (obj.objectType && obj.objectType.name) ? obj.objectType.name : (getAttr("Category") || "IT Asset"),
    status: getAttr("Status") || "Open",
    owner: getAttr("Owner") || "",
    condition: "Good",
    serial: getAttr("Serial Number") || getAttr("Serial") || "N/A",
    location: getAttr("Location") || "Corporate Office",
    lastUpdated: new Date().toLocaleDateString(),
    history: [{
      date: new Date().toLocaleDateString(),
      type: "Sync",
      user: "System",
      note: "Synchronized from Atlassian Assets"
    }],
    specs: {
      cpu: getAttr("CPU") || "---",
      ram: getAttr("RAM") || "---",
      storage: getAttr("Storage") || "---",
      os: getAttr("OS") || "---"
    }
  };
}

// Translation Helper
function t(key, params = {}) {
  const dict = translations[currentLanguage] || translations["en"];
  let text = dict[key] || translations["en"][key] || key;
  
  // Replace parameters like {name} with values from params object
  for (const [pKey, pVal] of Object.entries(params)) {
    // If the param value itself is a translation key, translate it
    const translatedVal = dict[pVal] || translations["en"][pVal] || pVal;
    text = text.replace(new RegExp(`\\{${pKey}\\}`, 'g'), translatedVal);
  }
  
  return text;
}

// Apply translations to the whole UI
function applyTranslations(lang) {
  currentLanguage = lang;
  
  // Update UI Elements with data-i18n
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
  
  // Update placeholders
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.placeholder = t(key);
  });

  // Refresh dynamic content
  updateMetrics();
  renderAssetList();
}

// Audio Synthesizer Beep
function playBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(1000, audioCtx.currentTime); 
    gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime); 
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.12); 
  } catch (e) {
    console.warn("Audio Context sound failed (permissions may be blocked):", e);
  }
}

// Toast System
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  let icon = '<i class="fa-solid fa-circle-info"></i>';
  if (type === "success") icon = '<i class="fa-solid fa-circle-check"></i>';
  if (type === "error") icon = '<i class="fa-solid fa-circle-xmark"></i>';
  
  toast.innerHTML = `${icon} <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Metrics Panel Updater
function updateMetrics() {
  const totalCount = assets.length;
  const openCount = assets.filter(a => a.status === "Open").length;
  const ownedCount = assets.filter(a => a.status === "Owned").length;
  const brokenCount = assets.filter(a => a.status === "Not Working").length;

  document.getElementById("metric-total").textContent = totalCount;
  document.getElementById("metric-open").textContent = openCount;
  document.getElementById("metric-owned").textContent = ownedCount;
  document.getElementById("metric-broken").textContent = brokenCount;
}

// Render Asset Catalog List
function renderAssetList(resetPage = false) {
  if (resetPage) currentPage = 1;

  const grid = document.getElementById("asset-list-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const terms = searchQuery.toLowerCase().trim().split(/\s+/).filter(t => t.length > 0);

  const filtered = assets.filter(asset => {
    let categoryMatch = (activeCategory === "All") || (activeCategory === asset.category);
    let statusMatch = (activeStatus === "All") || (activeStatus === asset.status);

    const searchMatch = terms.every(term => {
      return (asset.id || "").toLowerCase().includes(term) ||
             (asset.name || "").toLowerCase().includes(term) ||
             (asset.owner || "").toLowerCase().includes(term) ||
             (asset.category || "").toLowerCase().includes(term) ||
             (asset.condition || "").toLowerCase().includes(term);
    });

    return categoryMatch && statusMatch && searchMatch;
  });

  const totalPages = Math.ceil(filtered.length / assetsPerPage);
  if (currentPage > totalPages) currentPage = Math.max(1, totalPages);

  const startNum = filtered.length === 0 ? 0 : (currentPage - 1) * assetsPerPage + 1;
  const endNum = Math.min(currentPage * assetsPerPage, filtered.length);

  const counterEl = document.getElementById("results-counter");
  if (counterEl) {
    counterEl.textContent = `Showing ${startNum} - ${endNum} of ${filtered.length} assets (Total: ${assets.length})`;
  }

  // Manage client-side pagination buttons state & visibility
  const paginationControls = document.getElementById("pagination-controls");
  const pageIndicator = document.getElementById("page-indicator");
  const prevBtn = document.getElementById("prev-page-btn");
  const nextBtn = document.getElementById("next-page-btn");
  
  if (paginationControls && pageIndicator && prevBtn && nextBtn) {
    if (filtered.length > assetsPerPage) {
      paginationControls.style.display = "flex";
      pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
      prevBtn.disabled = (currentPage === 1);
      nextBtn.disabled = (currentPage === totalPages);
    } else {
      paginationControls.style.display = "none";
    }
  }

  const emptyState = document.getElementById("empty-state");
  if (filtered.length === 0) {
    if (emptyState) emptyState.style.display = "block";
    grid.style.display = "none";
    return;
  } else {
    if (emptyState) emptyState.style.display = "none";
    grid.style.display = "grid";
  }

  // Slice results to render only the 50 assets for the current page
  const pageAssets = filtered.slice((currentPage - 1) * assetsPerPage, currentPage * assetsPerPage);

  pageAssets.forEach((asset, index) => {
    const card = document.createElement("div");
    card.className = "asset-card";
    card.style.animationDelay = `${index * 0.05}s`;
    
    let statusClass = asset.status.toLowerCase().replace(" ", "-");
    let statusKey = `status_${asset.status.toLowerCase().replace(" ", "_")}`;

    // Category Icons Map
    let categoryIcon = "fa-laptop";
    const cat = asset.category.toLowerCase().replace(/[-\s]+/g, "_");
    
    const iconMap = {
      laptop: "fa-laptop",
      tablet: "fa-tablet-screen-button",
      phone: "fa-mobile-screen-button",
      monitor: "fa-desktop",
      computer: "fa-desktop",
      projector: "fa-video",
      digital_signage: "fa-tv",
      printer: "fa-print",
      charger: "fa-plug",
      av_cart: "fa-truck-ramp-box",
      mixing_console: "fa-sliders",
      microphone: "fa-microphone",
      receiver: "fa-radio",
      laptop_storage_cart: "fa-cart-shopping",
      scanner: "fa-print",
      video_conferencing_kit: "fa-chalkboard-user",
      jamboard: "fa-chalkboard",
      speakermic: "fa-volume-high",
      drive_external: "fa-hard-drive",
      camera: "fa-camera",
      projection_screen: "fa-display",
      sensor: "fa-microchip",
      speaker: "fa-volume-up",
      mobile_hotspot: "fa-wifi",
      transducer: "fa-wave-square",
      ups: "fa-battery-three-quarters",
      time_clock: "fa-clock",
      pos_devices: "fa-credit-card",
      security_key: "fa-key",
      operating_system: "fa-window-maximize",
      software: "fa-floppy-disk",
      other: "fa-box-archive"
    };

    if (iconMap[cat]) {
      categoryIcon = iconMap[cat];
    } else if (cat.includes("drive")) {
      categoryIcon = "fa-hard-drive";
    } else if (cat.includes("projection")) {
      categoryIcon = "fa-display";
    } else if (cat.includes("hotspot")) {
      categoryIcon = "fa-wifi";
    }

    card.innerHTML = `
      <div class="asset-card-header">
        <span class="asset-id-tag">${escapeHTML(asset.id)}</span>
        <span class="status-badge ${statusClass}">${t(statusKey)}</span>
      </div>
      <h3 class="asset-title">${escapeHTML(asset.name)}</h3>
      <div class="asset-meta">
        <div class="meta-item">
          <i class="fa-solid ${categoryIcon}"></i>
          <span>${t(asset.category.toLowerCase().replace(/[-\s]+/g, "_"))}</span>
        </div>
        <div class="meta-item">
          <i class="fa-solid fa-user"></i>
          <span>${asset.owner ? escapeHTML(asset.owner) : "---"}</span>
        </div>
      </div>
    `;
    
    card.onclick = () => openDetailsModal(asset.id);
    grid.appendChild(card);
  });
}

// User Profile & Directory Logic
function openPeopleDirectory() {
  renderPeopleList();
  openModal("people-directory-modal");
}

function renderPeopleList() {
  const peopleList = document.getElementById("people-list");
  const searchInput = document.getElementById("people-search-input");
  const filter = searchInput ? searchInput.value.toLowerCase().trim() : "";
  
  peopleList.innerHTML = "";
  
  // Find all unique owners
  const ownersSet = new Set();
  assets.forEach(a => {
    if (a.owner) ownersSet.add(a.owner);
  });
  
  const owners = Array.from(ownersSet).filter(owner => 
    !filter || owner.toLowerCase().includes(filter)
  ).sort();
  
  if (owners.length === 0) {
    peopleList.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">${t("no_assets_owned")}</div>`;
  } else {
    owners.forEach(owner => {
      const userAssets = assets.filter(a => a.owner === owner);
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary";
      btn.style.justifyContent = "space-between";
      btn.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <i class="fa-solid fa-user-circle" style="font-size: 18px; color: var(--accent-purple);"></i>
          <span>${escapeHTML(owner)}</span>
        </div>
        <span class="status-badge owned" style="font-size: 10px;">${userAssets.length}</span>
      `;
      btn.onclick = () => {
        closeModal("people-directory-modal");
        openUserProfile(owner);
      };
      peopleList.appendChild(btn);
    });
  }
}

function openUserProfile(userName) {
  const userAssets = assets.filter(a => a.owner === userName);
  
  document.getElementById("user-profile-name").textContent = userName;
  document.getElementById("user-profile-stats").textContent = `${userAssets.length} Assets Owned`;
  
  const container = document.getElementById("user-assets-list");
  container.innerHTML = "";
  
  userAssets.forEach(asset => {
    const item = document.createElement("div");
    item.className = "user-asset-item";
    item.innerHTML = `
      <div class="user-asset-info">
        <span class="user-asset-tag">${escapeHTML(asset.id)}</span>
        <span class="user-asset-model">${escapeHTML(asset.name)}</span>
        <span class="user-asset-category">${t(asset.category.toLowerCase())}</span>
      </div>
      <button class="btn btn-secondary btn-sm" style="min-height: 36px; padding: 0 12px; font-size: 12px;">
        ${t("view_details")}
      </button>
    `;
    item.querySelector("button").onclick = () => {
      closeModal("user-profile-modal");
      openDetailsModal(asset.id);
    };
    container.appendChild(item);
  });
  
  // Set up Bulk Return button
  const bulkBtn = document.getElementById("bulk-return-btn");
  bulkBtn.onclick = () => {
    if (confirm(t("confirm_bulk_return", { count: userAssets.length, user: userName }))) {
      bulkReturnAssets(userName);
    }
  };
  
  openModal("user-profile-modal");
}

function bulkReturnAssets(userName) {
  const userAssets = assets.filter(a => a.owner === userName);
  const timestamp = new Date().toISOString();
  
  userAssets.forEach(asset => {
    // Log distinct history event
    asset.history.push({
      timestamp,
      typeKey: "history_type_checkin",
      descKey: "history_checked_in",
      params: { 
        owner: userName, 
        condition: asset.condition,
        note: "Bulk return" 
      }
    });
    
    // Update state
    asset.status = "Open";
    asset.owner = "";
  });
  
  saveState();
  updateMetrics();
  renderAssetList();
  closeModal("user-profile-modal");
  showToast(t("notif_saved"), "success");
}

// Helper to resolve Atlassian Direct Object URL
function getAtlassianObjectUrl(objectId) {
  let sub = safeStorage.get("localStorage", "assetGuard_subdomain") || "";
  if (!sub && apiConfig.cloudId && !apiConfig.cloudId.includes("-")) {
    sub = apiConfig.cloudId;
  }
  if (!sub) {
    sub = "smm-sandbox"; // Standard project fallback
  }
  return `https://${sub}.atlassian.net/jira/assets/object/${objectId}`;
}

// Open Detail/Action Modal
function openDetailsModal(assetId, defaultTab = "overview") {
  const asset = assets.find(a => (a.id || "").toLowerCase() === assetId.toLowerCase());
  if (!asset) {
    showToast(t("notif_not_found"), "error");
    return;
  }

  // Set Title
  document.getElementById("details-modal-title").textContent = asset.id;

  // Atlassian Link Setup
  const jiraLinkContainer = document.getElementById("view-jira-link-container");
  const jiraLink = document.getElementById("view-jira-link");
  if (jiraLinkContainer && jiraLink) {
    if (asset.atlassianObjectId) {
      jiraLink.href = getAtlassianObjectUrl(asset.atlassianObjectId);
      jiraLinkContainer.style.display = "block";
    } else {
      jiraLinkContainer.style.display = "none";
    }
  }

  // Overview Tab Fields
  document.getElementById("view-name").textContent = asset.name;
  document.getElementById("view-category").textContent = t(asset.category.toLowerCase().replace(/[-\s]+/g, "_"));
  document.getElementById("view-serial").textContent = asset.serialNumber || "--";
  document.getElementById("view-location").textContent = asset.location || "--";
  document.getElementById("view-condition").textContent = asset.condition;

  // Status badge setup
  const statusBadge = document.getElementById("view-status-badge");
  const statusSlug = asset.status.toLowerCase().replace(" ", "-");
  statusBadge.className = `status-badge ${statusSlug}`;
  statusBadge.textContent = t(`status_${asset.status.toLowerCase().replace(" ", "_")}`);
  
  // Owner setup
  const ownerText = document.getElementById("view-owner-text");
  if (asset.status === "Owned") {
    ownerText.textContent = `${t("owner")}: ${asset.owner}`;
  } else if (asset.status === "Open") {
    ownerText.textContent = t("status_open");
  } else {
    ownerText.textContent = `${t("owner")}: ${asset.owner || "---"} (${t("status_not_working")})`;
  }

  // Populate Specs List
  const specsList = document.getElementById("view-specs-list");
  specsList.innerHTML = "";
  if (asset.specs && Object.keys(asset.specs).length > 0) {
    for (const [key, value] of Object.entries(asset.specs)) {
      const formattedKey = key.charAt(0).toUpperCase() + key.slice(1);
      const div = document.createElement("div");
      div.className = "spec-item";
      div.innerHTML = `<span class="spec-key">${escapeHTML(formattedKey)}</span><span class="spec-val">${escapeHTML(value)}</span>`;
      specsList.appendChild(div);
    }
  } else {
    specsList.innerHTML = `<span style="color: var(--text-muted); font-size:12px;">---</span>`;
  }
  
  // Acquisition Date
  if (asset.acquisitionDate) {
    const acqDiv = document.createElement("div");
    acqDiv.className = "spec-item";
    acqDiv.innerHTML = `<span class="spec-key">${t("acquisition_date")}</span><span class="spec-val">${escapeHTML(asset.acquisitionDate)}</span>`;
    specsList.appendChild(acqDiv);
  }

  // Tab Content 2 (Edit Form) setup
  document.getElementById("edit-asset-id").value = asset.id;
  document.getElementById("edit-status").value = asset.status;
  document.getElementById("edit-owner").value = asset.owner;
  document.getElementById("edit-location").value = asset.location;
  
  // Reset error displays
  document.getElementById("error-edit-owner").classList.remove("active");
  document.getElementById("error-edit-issue").classList.remove("active");

  const condNormal = document.getElementById("edit-condition-normal");
  const condNotWorking = document.getElementById("edit-condition-notworking");
  
  if (asset.status === "Not Working") {
    condNotWorking.value = asset.condition;
    condNormal.value = "";
  } else {
    condNormal.value = asset.condition;
    condNotWorking.value = "";
  }

  toggleEditStatusFields(asset.status);

  // Tab Content 3 (History Timeline)
  renderHistoryTimeline(asset.history, "view-history-timeline");

  // Tab Content 4 (QR Code Generator)
  generateQRTag(asset.id);

  // Reset tab focus to parameterized defaultTab
  switchDetailTab(defaultTab);

  // Show Modal
  openModal("details-modal");
}

// Enforce Form UI adjustments based on status
function toggleEditStatusFields(status) {
  const ownerGroup = document.getElementById("edit-owner-group");
  const issueGroup = document.getElementById("edit-issue-group");
  const normalGroup = document.getElementById("edit-condition-normal-group");

  if (status === "Owned") {
    ownerGroup.style.display = "block";
    issueGroup.style.display = "none";
    normalGroup.style.display = "block";
  } else if (status === "Not Working") {
    ownerGroup.style.display = "block";
    issueGroup.style.display = "block";
    normalGroup.style.display = "none";
  } else {
    ownerGroup.style.display = "none";
    issueGroup.style.display = "none";
    normalGroup.style.display = "block";
  }
}

// Render History Timeline (Generic with Year Headers)
function renderHistoryTimeline(historyList, containerId = "detail-history-timeline", showAssetInfo = false) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (!historyList || historyList.length === 0) {
    container.innerHTML = `<div style="color: var(--text-muted); font-size:13px; text-align:center;">---</div>`;
    return;
  }

  const sorted = [...historyList].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  let lastYear = null;

  sorted.forEach(item => {
    const date = new Date(item.timestamp);
    const year = date.getFullYear();
    
    // Insert Year Header if year changed
    if (year !== lastYear) {
      const yearHeader = document.createElement("div");
      yearHeader.className = "timeline-year-header";
      yearHeader.textContent = year;
      container.appendChild(yearHeader);
      lastYear = year;
    }

    const div = document.createElement("div");
    
    // Determine icon and color based on type
    let icon = "•";
    let typeClass = "event";
    
    if (item.typeKey) {
      if (item.typeKey === "history_type_checkout") {
        icon = "📤";
        typeClass = "checkout";
      } else if (item.typeKey === "history_type_checkin") {
        icon = "📥";
        typeClass = "checkin";
      } else if (item.typeKey === "history_type_transfer") {
        icon = "🔄";
        typeClass = "transfer";
      } else if (item.typeKey === "history_type_created") {
        icon = "✨";
        typeClass = "created";
      } else if (item.typeKey === "history_type_status") {
        icon = "⚙️";
        typeClass = "status-change";
      }
    }
    
    div.className = `timeline-item ${typeClass}`;
    
    // Localized Date formatting
    const dateStr = date.toLocaleString(currentLanguage, { 
      weekday: 'short',
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit' 
    });

    // Handle structured vs legacy history
    const description = item.descKey ? t(item.descKey, item.params || {}) : item.description;
    const typeTitle = item.typeKey ? t(item.typeKey) : (item.type || "Event");
    
    const assetContext = showAssetInfo ? `<div class="timeline-asset-id"><strong>[${escapeHTML(item.assetId)}]</strong> ${escapeHTML(item.assetName)}</div>` : "";

    div.innerHTML = `
      <div class="timeline-time">${dateStr}</div>
      <div class="timeline-title">${icon} ${escapeHTML(typeTitle)}</div>
      ${assetContext}
      <div class="timeline-desc">${escapeHTML(description)}</div>
    `;
    container.appendChild(div);
  });
}

// Global History Aggregation & Rendering
function renderGlobalHistory() {
  const categoryFilter = document.getElementById("global-history-category-filter").value;
  const yearFilter = document.getElementById("global-history-year-filter").value;
  const searchQuery = document.getElementById("global-history-search").value.toLowerCase().trim();

  // Aggregate and Enrich
  let globalEntries = [];
  assets.forEach(asset => {
    // Category filter
    if (categoryFilter !== "All" && asset.category !== categoryFilter) return;

    asset.history.forEach(entry => {
      const year = new Date(entry.timestamp).getFullYear().toString();
      
      // Year filter
      if (yearFilter !== "All" && year !== yearFilter) return;

      globalEntries.push({
        ...entry,
        assetId: asset.id,
        assetName: asset.name,
        assetCategory: asset.category
      });
    });
  });

  // Search filter
  if (searchQuery) {
    globalEntries = globalEntries.filter(entry => {
      const desc = entry.descKey ? t(entry.descKey, entry.params || {}).toLowerCase() : (entry.description || "").toLowerCase();
      return entry.assetId.toLowerCase().includes(searchQuery) || 
             entry.assetName.toLowerCase().includes(searchQuery) ||
             desc.includes(searchQuery);
    });
  }

  // Sort by timestamp
  globalEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Cap at 100 entries for performance
  const displayEntries = globalEntries.slice(0, 100);

  renderHistoryTimeline(displayEntries, "global-history-timeline", true);
}

// Dynamically populate year filter based on data
function populateYearFilter() {
  const yearSet = new Set();
  assets.forEach(asset => {
    asset.history.forEach(entry => {
      const year = new Date(entry.timestamp).getFullYear();
      if (year) yearSet.add(year);
    });
  });

  const filter = document.getElementById("global-history-year-filter");
  if (!filter) return;

  const currentVal = filter.value;
  filter.innerHTML = `<option value="All" data-i18n="all_years">${t("all_years")}</option>`;
  
  Array.from(yearSet).sort((a, b) => b - a).forEach(year => {
    const option = document.createElement("option");
    option.value = year.toString();
    option.textContent = year.toString();
    filter.appendChild(option);
  });

  filter.value = currentVal || "All";
}

// Generate QR Code dynamically
function generateQRTag(assetId) {
  const container = document.getElementById("asset-qr-code-container");
  container.innerHTML = "";
  
  try {
    new QRCode(container, {
      text: assetId,
      width: 160,
      height: 160,
      colorDark: "#0c111d",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });
  } catch (e) {
    console.error("QR Code generation failed", e);
    container.innerHTML = `<span style="color: var(--status-error);">Error</span>`;
  }
}

// Switch detail panel tabs
function switchDetailTab(tabId) {
  document.querySelectorAll(".detail-tab").forEach(tab => {
    tab.classList.toggle("active", tab.getAttribute("data-tab") === tabId);
  });

  document.querySelectorAll(".detail-pane").forEach(pane => {
    pane.classList.toggle("active", pane.id === `detail-pane-${tabId}`);
  });
}
// Setup Event Listeners
function setupEventListeners() {
  // Export Data
  on("export-data-btn", "click", () => {
    const dataStr = JSON.stringify(assets, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `asset_backup_${new Date().toISOString().split("T")[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("Backup downloaded successfully!", "success");
  });

  // Clear All Data
  on("clear-all-data-btn", "click", () => {
    if (confirm(t("confirm_clear_all"))) {
      assets = [];
      saveState();
      updateMetrics();
      renderAssetList();
      closeModal("global-history-modal");
      showToast(t("notif_saved"), "success");
    }
  });

  // Language Toggles
  const langToggle = document.getElementById("lang-toggle-btn");
  if (langToggle) {
    langToggle.addEventListener("click", () => {
      currentLanguage = currentLanguage === "en" ? "es" : "en";
      applyTranslations(currentLanguage);
    });
  }

  // Category tabs click
  on("category-tabs", "click", (e) => {
    if (e.target.classList.contains("tab-btn")) {
      document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
      e.target.classList.add("active");
      
      // Reset the "More Categories..." select box
      const moreSelect = document.getElementById("more-categories-select");
      if (moreSelect) moreSelect.value = "";
      
      activeCategory = e.target.getAttribute("data-category");
      renderAssetList(true);
    }
  });

  // More Categories dropdown selection
  on("more-categories-select", "change", (e) => {
    const selectedCategory = e.target.value;
    if (!selectedCategory) return; // Ignore placeholder option selection
    
    // Deselect all quick chips
    document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
    
    activeCategory = selectedCategory;
    renderAssetList(true);
  });

  // Status filters click
  on("status-filters", "click", (e) => {
    if (e.target.classList.contains("filter-chip")) {
      document.querySelectorAll(".filter-chip").forEach(btn => btn.classList.remove("active"));
      e.target.classList.add("active");
      activeStatus = e.target.getAttribute("data-status");
      renderAssetList(true);
    }
  });

  // Metric Card Clicks for Quick Filter
  onSelector(".metric-card.open-metric", "click", () => {
    const chip = document.querySelector('.filter-chip[data-status="Open"]');
    if (chip) chip.click();
  });
  onSelector(".metric-card.owned-metric", "click", () => {
    const chip = document.querySelector('.filter-chip[data-status="Owned"]');
    if (chip) chip.click();
  });
  onSelector(".metric-card.broken-metric", "click", () => {
    const chip = document.querySelector('.filter-chip[data-status="Not Working"]');
    if (chip) chip.click();
  });

  // Search input change
  on("asset-search-input", "input", (e) => {
    searchQuery = e.target.value;
    renderAssetList(true);
  });

  // Client-Side Pagination controls
  on("prev-page-btn", "click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderAssetList();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  on("next-page-btn", "click", () => {
    // Dynamically check total filtered assets to cap the next page action
    const filteredCount = assets.filter(asset => {
      let categoryMatch = (activeCategory === "All") || (activeCategory === asset.category);
      let statusMatch = (activeStatus === "All") || (activeStatus === asset.status);
      const terms = searchQuery.toLowerCase().trim().split(/\s+/).filter(t => t.length > 0);
      const searchMatch = terms.every(term => {
        return (asset.id || "").toLowerCase().includes(term) ||
               (asset.name || "").toLowerCase().includes(term) ||
               (asset.owner || "").toLowerCase().includes(term) ||
               (asset.category || "").toLowerCase().includes(term) ||
               (asset.condition || "").toLowerCase().includes(term);
      });
      return categoryMatch && statusMatch && searchMatch;
    }).length;

    const totalPages = Math.ceil(filteredCount / assetsPerPage);
    if (currentPage < totalPages) {
      currentPage++;
      renderAssetList();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  // Add Asset
  on("add-asset-btn", "click", () => {
    openModal("add-asset-modal");
  });

  on("add-asset-close-btn", "click", () => {
    closeModal("add-asset-modal");
  });

  // Sync Atlassian
  on("sync-atlassian-btn", "click", () => {
    syncWithAtlassian();
  });

  // Settings
  on("settings-btn", "click", () => {
    const assistant = document.getElementById("magic-setup-assistant");
    if (assistant) assistant.style.display = "none";
    openModal("settings-modal");
  });

  // Magic URL Sniffer (Unified Processor)
  function processMagicUrl(url) {
    if (!url || (!url.includes("atlassian.net") && !url.includes("api.atlassian.com"))) return; 
    
    // Helper to clean IDs
    const clean = (id) => id ? id.replace(/[^a-z0-9-]/gi, "").trim() : "";

    // Method B Bypass: If the pasted URL already contains raw UUID strings (e.g. copied from Developer Tools), extract them directly
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const allUUIDs = url.match(uuidPattern);
    
    if (allUUIDs && allUUIDs.length > 0) {
      let directCloudId = "";
      let directWorkspaceId = "";

      // 1. Try to find Cloud ID (following /ex/jira/)
      const cloudIdMatch = url.match(/\/ex\/jira\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (cloudIdMatch) {
        directCloudId = cloudIdMatch[1];
      }

      // 2. Try to find Workspace ID (following /workspace/ or /servicedesk/assets/ or /assets/)
      const workspaceIdMatch = url.match(/\/(?:workspace|servicedesk\/assets|assets)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (workspaceIdMatch) {
        directWorkspaceId = workspaceIdMatch[1];
      }

      // 3. Fallbacks ONLY if we matched multiple UUIDs in an unstructured string
      if (!directCloudId && !directWorkspaceId && allUUIDs.length >= 2) {
        directCloudId = allUUIDs[0];
        directWorkspaceId = allUUIDs[1];
      } else if (!directCloudId && !directWorkspaceId && allUUIDs.length === 1) {
        // If there's only 1 UUID and we don't have structural path matching, try to see where it fits
        if (url.includes("/ex/jira/")) {
          directCloudId = allUUIDs[0];
        } else if (url.includes("/workspace/") || url.includes("/servicedesk/assets/") || url.includes("/assets/")) {
          directWorkspaceId = allUUIDs[0];
        }
      }

      let updatedAny = false;
      if (directCloudId) {
        const cloudInput = document.getElementById("api-cloud-id");
        if (cloudInput) cloudInput.value = directCloudId;
        apiConfig.cloudId = directCloudId;
        updatedAny = true;
      }
      if (directWorkspaceId) {
        const workspaceInput = document.getElementById("api-workspace-id");
        if (workspaceInput) workspaceInput.value = directWorkspaceId;
        apiConfig.workspaceId = directWorkspaceId;
        updatedAny = true;
      }

      if (updatedAny) {
        saveState();
        showToast("Method B Direct UUIDs extracted & loaded automatically!", "success");
        return; // Direct extraction complete, bypass subdomain resolution
      }
    }

    // 1. Try to find Workspace ID (Object Schema ID) using multiple pattern fallbacks
    let workspaceId = "";
    
    // Pattern A: /object-schema/[ID]
    const schemaMatch = url.match(/\/object-schema\/([a-z0-9-]+)/i);
    // Pattern B: /objects/[ID] or /assets/[ID]
    const objectsMatch = url.match(/\/objects?\/([a-z0-9-]+)/i);
    // Pattern C: ?workspaceId=[ID] or &workspaceId=[ID]
    const queryMatch = url.match(/[?&]workspaceId=([a-z0-9-]+)/i);
    // Pattern D: /assets/([a-z0-9-]+) (simple folder match)
    const simpleMatch = url.match(/\/assets\/([a-z0-9-]+)/i);

    if (schemaMatch) {
      workspaceId = clean(schemaMatch[1]);
    } else if (objectsMatch) {
      workspaceId = clean(objectsMatch[1]);
    } else if (queryMatch) {
      workspaceId = clean(queryMatch[1]);
    } else if (simpleMatch) {
      const parsed = clean(simpleMatch[1]);
      // Avoid matching common folders as IDs
      if (!["object-schema", "objects", "object", "schema"].includes(parsed)) {
        workspaceId = parsed;
      }
    }

    // Write Workspace ID to input
    if (workspaceId) {
      const workspaceInput = document.getElementById("api-workspace-id");
      if (workspaceInput) workspaceInput.value = workspaceId;
      apiConfig.workspaceId = workspaceId;
    }

    // Extract optional typeId from URL query string if present
    const typeIdMatch = url.match(/[?&]typeId=(\d+)/i);
    if (typeIdMatch) {
      const extractedTypeId = parseInt(typeIdMatch[1]);
      if (extractedTypeId) {
        safeStorage.set("localStorage", "assetGuard_extracted_type_id", extractedTypeId);
        console.log("Extracted typeId from URL:", extractedTypeId);
      }
    }

    // 2. Try to find Cloud ID / Subdomain
    const domainMatch = url.match(/https?:\/\/([a-z0-9-]+)\.(atlassian\.net|jira\.com)/i);
    if (domainMatch) {
       const sub = domainMatch[1].toLowerCase();
       if (!["jira", "admin", "id", "assets"].includes(sub)) {
         safeStorage.set("localStorage", "assetGuard_subdomain", sub);
         const cloudInput = document.getElementById("api-cloud-id");
         if (cloudInput) cloudInput.value = clean(sub);
         apiConfig.cloudId = sub;
         // Render the customized Method B Assistant with direct URLs for their subdomain!
         const assistant = document.getElementById("magic-setup-assistant");
         if (assistant) {
           assistant.style.display = "block";
           assistant.innerHTML = `
             <div style="font-weight: bold; color: var(--accent-blue); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; font-size: 12px;">
               <i class="fa-solid fa-wand-magic-sparkles"></i> Magic Setup Assistant
             </div>
             <p style="margin: 0 0 10px 0; font-size: 11px; color: var(--text-muted); line-height: 1.4;">
               The background resolver is automatically communicating with Atlassian using your Email & API Token to fetch and configure your secure UUIDs...
             </p>
             <div id="magic-status-step" style="font-size: 11.5px; color: var(--text-primary); font-weight: 600; display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 8px;">
               <i class="fa-solid fa-spinner fa-spin" style="color: var(--accent-blue);"></i> Resolving secure Cloud UUID...
             </div>
           `;
         }
         
         // Background resolver to get the real long Cloud ID using our proxy fallback!
         showToast("Resolving Atlassian Cloud ID...", "info");
         resolveCloudId(sub)
           .then(resolvedCloud => {
             if (resolvedCloud) {
               const cloudInput = document.getElementById("api-cloud-id");
               if (cloudInput) cloudInput.value = resolvedCloud;
               apiConfig.cloudId = resolvedCloud;
               saveState();
               showToast("Cloud ID resolved successfully!", "success");
               
               const statusStep = document.getElementById("magic-status-step");
               if (statusStep) {
                 statusStep.innerHTML = `<i class="fa-solid fa-circle-check" style="color: var(--status-success);"></i> Cloud ID UUID Resolved!`;
               }

               // Attempt to resolve Workspace ID automatically too if credentials are input!
               const emailInput = document.getElementById("api-email") ? document.getElementById("api-email").value.trim() : "";
               const tokenInput = document.getElementById("api-token") ? document.getElementById("api-token").value.trim() : "";
               if (emailInput && tokenInput && workspaceId && !isValidUUID(workspaceId)) {
                 showToast("Resolving Workspace ID...", "info");
                 apiConfig.email = emailInput;
                 apiConfig.token = tokenInput;
                 
                 if (statusStep) {
                   statusStep.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="color: var(--accent-blue);"></i> Resolving secure Workspace UUID...`;
                 }
                 
                 resolveWorkspaceId(resolvedCloud, sub)
                   .then(resolvedWorkspace => {
                     if (resolvedWorkspace) {
                       const workspaceInput = document.getElementById("api-workspace-id");
                       if (workspaceInput) workspaceInput.value = resolvedWorkspace;
                       apiConfig.workspaceId = resolvedWorkspace;
                       saveState();
                       showToast("Workspace ID resolved automatically!", "success");
                       if (statusStep) {
                         statusStep.innerHTML = `<i class="fa-solid fa-circle-check" style="color: var(--status-success);"></i> Both UUIDs Resolved & Saved!`;
                       }
                     }
                   })
                   .catch(err => {
                     console.log("Background Workspace ID auto-resolve bypassed (likely CORS block):", err);
                   });
               }
             } else {
               console.warn("Could not resolve Cloud ID to a UUID. Subdomain set as fallback.");
               const emailInput = document.getElementById("api-email") ? document.getElementById("api-email").value.trim() : "";
               const tokenInput = document.getElementById("api-token") ? document.getElementById("api-token").value.trim() : "";
               
               let warningMsg = "CORS block or private sandbox. Please turn on 'Allow CORS' extension or use DevTools link!";
               let statusHtml = `<i class="fa-solid fa-triangle-exclamation" style="color: var(--status-warning);"></i> Run with 'Allow CORS' turned ON to resolve UUIDs!`;
               
               if (!emailInput || !tokenInput) {
                 warningMsg = "⚠️ Please enter your Atlassian Email & API Token FIRST so we can securely login to your private sandbox!";
                 statusHtml = `<i class="fa-solid fa-key" style="color: var(--status-warning);"></i> Please enter your Email & API Token first!`;
               }
               
               showToast(warningMsg, "warning");
               const statusStep = document.getElementById("magic-status-step");
               if (statusStep) {
                 statusStep.innerHTML = statusHtml;
               }
             }
           })
           .catch(err => {
             console.log("Background ID resolver exception:", err);
             showToast("Workspace ID loaded. Subdomain saved as fallback.", "info");
           });
       }
    }
    
    saveState();
  }

  // Bind the Magic Sniffer to both INPUT and PASTE events on the magic url box
  on("api-magic-url", "input", (e) => {
    processMagicUrl(e.target.value.trim());
  });
  on("api-magic-url", "paste", (e) => {
    // Let clipboard capture populate the input box first, then process
    setTimeout(() => {
      const magicInput = document.getElementById("api-magic-url");
      if (magicInput) {
        processMagicUrl(magicInput.value.trim());
      }
    }, 50);
  });

  // Secondary catch-all fallback: Global Paste Listener for Settings Modal
  on("settings-modal", "paste", (e) => {
    const url = (e.clipboardData || window.clipboardData).getData('text').trim();
    processMagicUrl(url);
  });

  on("people-directory-trigger-btn", "click", () => {
    openPeopleDirectory();
  });

  on("settings-help-btn", "click", () => {
    const helpSection = document.getElementById("settings-help-section");
    helpSection.style.display = helpSection.style.display === "none" ? "block" : "none";
  });

  on("close-help-btn", "click", () => {
    document.getElementById("settings-help-section").style.display = "none";
  });

  on("settings-close-btn", "click", () => {
    closeModal("settings-modal");
    document.getElementById("settings-help-section").style.display = "none"; // Reset for next time
    const assistant = document.getElementById("magic-setup-assistant");
    if (assistant) assistant.style.display = "none";
  });

  on("settings-form", "submit", (e) => {
    e.preventDefault();
    
    const cloudIdInputVal = document.getElementById("api-cloud-id").value.trim();
    if (cloudIdInputVal && !cloudIdInputVal.includes("-")) {
      safeStorage.set("localStorage", "assetGuard_subdomain", cloudIdInputVal);
    }

    apiConfig = {
      cloudId: cloudIdInputVal,
      workspaceId: document.getElementById("api-workspace-id").value.trim(),
      email: document.getElementById("api-email").value.trim(),
      token: document.getElementById("api-token").value.trim(),
      syncLimit: parseInt(document.getElementById("api-sync-limit").value) || 100
    };
    saveState();
    
    // Reset connection status upon saving new settings
    if (isOfflineMode) {
      updateConnectionUI("offline");
    } else if (!apiConfig.cloudId || !apiConfig.workspaceId || !apiConfig.email || !apiConfig.token) {
      safeStorage.set("localStorage", "assetGuard_last_sync_status", "unconfigured");
      updateConnectionUI("unconfigured");
    } else {
      safeStorage.set("localStorage", "assetGuard_last_sync_status", "ready");
      safeStorage.set("localStorage", "assetGuard_last_sync_error", "");
      updateConnectionUI("ready");
    }
    
    closeModal("settings-modal");
    showToast(t("notif_config_saved"), "success");
  });

  on("clear-config-btn", "click", () => {
    if (confirm(t("confirm_clear_all"))) { 
      apiConfig = { cloudId: "", workspaceId: "", email: "", token: "", syncLimit: 100 };
      saveState();
      safeStorage.set("localStorage", "assetGuard_last_sync_status", "unconfigured");
      safeStorage.set("localStorage", "assetGuard_last_sync_error", "");
      // Force UI update
      document.getElementById("api-cloud-id").value = "";
      document.getElementById("api-workspace-id").value = "";
      document.getElementById("api-email").value = "";
      document.getElementById("api-token").value = "";
      document.getElementById("api-sync-limit").value = "100";
      
      const assistant = document.getElementById("magic-setup-assistant");
      if (assistant) assistant.style.display = "none";

      updateConnectionUI("unconfigured");
      showToast(t("notif_config_cleared"), "info");
    }
  });

  // Global History
  on("global-history-btn", "click", () => {
    renderGlobalHistory();
    openModal("global-history-modal");
  });

  on("global-history-close-btn", "click", () => {
    closeModal("global-history-modal");
  });

  // Scan QR
  on("scan-qr-btn", "click", () => {
    openModal("scanner-modal");
    startCameraScanner();
  });

  on("scanner-close-btn", "click", () => {
    stopCameraScanner();
    closeModal("scanner-modal");
  });
  
  on("floating-help-btn", "click", () => {
    openModal("app-guide-modal");
  });

  on("guide-close-btn", "click", () => {
    closeModal("app-guide-modal");
  });

  on("guide-got-it-btn", "click", () => {
    closeModal("app-guide-modal");
  });

  on("global-history-trigger-btn", "click", () => {
    openModal("global-history-modal");
    populateYearFilter();
    renderGlobalHistory();
  });

  // Modal close buttons
  on("scanner-close-btn", "click", () => {
    closeModal("scanner-modal");
    stopCameraScanner();
  });

  on("details-close-btn", "click", () => {
    closeModal("details-modal");
  });

  on("people-directory-close-btn", "click", () => {
    closeModal("people-directory-modal");
  });
  
  on("user-profile-close-btn", "click", () => {
    closeModal("user-profile-modal");
  });

  // Click overlay to close
  window.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-overlay")) {
      closeModal(e.target.id);
      if (e.target.id === "scanner-modal") {
        stopCameraScanner();
      }
    }
  });

  // Detail Modal tab buttons click
  onSelector(".detail-tabs", "click", (e) => {
    if (e.target.classList.contains("detail-tab")) {
      switchDetailTab(e.target.getAttribute("data-tab"));
    }
  });

  // Enforce Form UI changes based on status
  on("edit-status", "change", (e) => {
    toggleEditStatusFields(e.target.value);
  });

  // People Search Filter
  on("people-search-input", "input", renderPeopleList);

  // Main Header Search Go Button Logic
  on("main-search-go-btn", "click", () => {
    const inputVal = document.getElementById("asset-search-input").value.trim();
    if (!inputVal) return;

    // Normalize input (e.g. M2379 -> smm2379)
    let normalizedId = inputVal.toLowerCase();
    if (normalizedId.startsWith("m") && normalizedId.length > 2) {
      normalizedId = "smm" + normalizedId.substring(1);
    }

    const existing = assets.find(a => a.id === normalizedId || a.serialNumber === normalizedId || a.id === inputVal);
    if (existing) {
      openDetailsModal(existing.id);
      document.getElementById("asset-search-input").value = ""; // Clean input on success
    } else {
      showToast(t("notif_not_found"), "error");
    }
  });
  
  // Theme Toggle Logic
  on("theme-toggle-btn", "click", () => {
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (document.body.getAttribute("data-theme") === "dark") {
      document.body.removeAttribute("data-theme");
      safeStorage.set("localStorage", "assetGuard_theme", "light");
      themeBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
    } else {
      document.body.setAttribute("data-theme", "dark");
      safeStorage.set("localStorage", "assetGuard_theme", "dark");
      themeBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
    }
  });

  // Global History Filters
  on("global-history-category-filter", "change", renderGlobalHistory);
  on("global-history-year-filter", "change", renderGlobalHistory);
  on("global-history-search", "input", renderGlobalHistory);

  // Submit edits form
  on("edit-asset-form", "submit", (e) => {
    e.preventDefault();
    const assetId = document.getElementById("edit-asset-id").value;
    const newStatus = document.getElementById("edit-status").value;
    const newOwner = document.getElementById("edit-owner").value.trim();
    const newLocation = document.getElementById("edit-location").value.trim();
    
    // Clear errors
    document.getElementById("error-edit-owner").classList.remove("active");
    document.getElementById("error-edit-issue").classList.remove("active");

    const asset = assets.find(a => a.id === assetId);
    if (!asset) return;

    // Apply strict validation rules
    if (newStatus === "Owned" && !newOwner) {
      document.getElementById("error-edit-owner").classList.add("active");
      showToast("Owner name is required", "error");
      return;
    }

    let finalCondition = "";
    if (newStatus === "Not Working") {
      const issue = document.getElementById("edit-condition-notworking").value.trim();
      if (!issue) {
        document.getElementById("error-edit-issue").classList.add("active");
        showToast("Issue report is required", "error");
        return;
      }
      finalCondition = issue;
    } else {
      finalCondition = document.getElementById("edit-condition-normal").value.trim() || "Healthy";
    }

    const timestamp = new Date().toISOString();

    // Check handover types
    if (asset.status === "Open" && newStatus === "Owned") {
      // Checkout
      asset.history.push({
        timestamp,
        typeKey: "history_type_checkout",
        descKey: "history_checked_out",
        params: { owner: newOwner, condition: finalCondition }
      });
    } else if (asset.status === "Owned" && (newStatus === "Open" || newStatus === "Not Working")) {
      // Check-in
      asset.history.push({
        timestamp,
        typeKey: "history_type_checkin",
        descKey: "history_checked_in",
        params: { owner: asset.owner, condition: finalCondition }
      });
    } else if (asset.status === "Owned" && newStatus === "Owned" && asset.owner !== newOwner) {
      // Transfer
      asset.history.push({
        timestamp,
        typeKey: "history_type_transfer",
        descKey: "history_transferred",
        params: { oldOwner: asset.owner, newOwner: newOwner, condition: finalCondition }
      });
    } else if (asset.status !== newStatus) {
      // Generic status change
      asset.history.push({
        timestamp,
        typeKey: "history_type_status",
        descKey: "history_status_change",
        params: { status: `status_${newStatus.toLowerCase().replace(" ", "_")}` }
      });
    }

    // Apply updates to state
    asset.status = newStatus;
    asset.owner = newStatus === "Open" ? "" : newOwner;
    asset.location = newLocation || asset.location;
    asset.condition = finalCondition;
    
    saveState();
    updateMetrics();
    renderAssetList();
    
    // Push updates to Atlassian Jira in the background
    pushUpdateToAtlassian(asset);
    
    closeModal("details-modal");
    showToast(t("notif_saved"), "success");
  });

  // Defensive helper to attach listeners
  function on(id, event, callback) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, callback);
  }

  // Defensive helper for selectors
  function onSelector(selector, event, callback) {
    const el = document.querySelector(selector);
    if (el) el.addEventListener(event, callback);
  }

  // Submit add new asset form
  on("add-asset-form", "submit", (e) => {
    e.preventDefault();
    const addId = document.getElementById("add-id").value.trim().toUpperCase();
    const addName = document.getElementById("add-name").value.trim();
    const addCategory = document.getElementById("add-category").value;
    const addSerial = document.getElementById("add-serial").value.trim();
    const addLocation = document.getElementById("add-location").value.trim();
    const addCondition = document.getElementById("add-condition").value.trim();
    const addAcqDate = document.getElementById("add-acquisition-date").value;
    
    const specCpu = document.getElementById("add-spec-cpu").value.trim();
    const specRam = document.getElementById("add-spec-ram").value.trim();
    const specStorage = document.getElementById("add-spec-storage").value.trim();
    const specOs = document.getElementById("add-spec-os").value.trim();

    // Check duplicate
    document.getElementById("error-add-id-exists").classList.remove("active");
    if (assets.some(a => a.id === addId)) {
      document.getElementById("error-add-id-exists").classList.add("active");
      showToast("ID already exists", "error");
      return;
    }
    
    // Future Date validation
    if (addAcqDate && new Date(addAcqDate) > new Date()) {
      showToast("Acquisition date cannot be in the future", "error");
      return;
    }

    // Assemble Specs object (consistent with seeds)
    const specs = {};
    if (specCpu) specs.cpu = specCpu;
    if (specRam) specs.ram = specRam;
    if (specStorage) specs.storage = specStorage;
    if (specOs) specs.os = specOs;

    // Assemble New Asset
    const newAsset = {
      id: addId,
      name: addName,
      category: addCategory,
      serialNumber: addSerial,
      status: "Open",
      owner: "",
      location: addLocation,
      condition: addCondition,
      acquisitionDate: addAcqDate,
      specs: specs,
      history: [
        {
          timestamp: new Date().toISOString(),
          typeKey: "history_type_created",
          descKey: "history_added",
          params: {}
        }
      ]
    };

    // Save and Render
    assets.push(newAsset);
    saveState();
    updateMetrics();
    renderAssetList();
    
    // Push new asset to Atlassian Jira in the background
    pushNewAssetToAtlassian(newAsset);
    
    // Reset Form & Close Modal
    document.getElementById("add-asset-form").reset();
    closeModal("add-asset-modal");
    showToast(t("notif_saved"), "success");
  });

  // Manual Scan Entry Logic
  on("manual-scan-btn", "click", () => {
    const manualInput = document.getElementById("manual-scan-input").value.trim();
    if (!manualInput) return;
    
    // Parse the input (supports raw ID, query params, or JSON strings)
    const parsed = parseScannedContent(manualInput);
    if (!parsed) return;
    
    // Normalize parsed ID for searching
    let normalizedId = (parsed.id || "").toLowerCase();
    if (normalizedId.startsWith("m") && normalizedId.length > 2) {
      normalizedId = "smm" + normalizedId.substring(1);
    }
    
    const existing = assets.find(a => {
      const assetIdLower = (a.id || "").toLowerCase();
      const assetSerialLower = (a.serialNumber || "").toLowerCase();
      return assetIdLower === normalizedId || 
             (parsed.serial && assetSerialLower === parsed.serial.toLowerCase()) ||
             (parsed.id && assetIdLower === parsed.id.toLowerCase());
    });
    
    // Close scanner first
    stopCameraScanner();
    closeModal("scanner-modal");
    document.getElementById("manual-scan-input").value = "";

    if (existing) {
      // If the laptop exists, open the details modal with the 'edit' (Actions) tab selected!
      showToast(t("notif_scan_success", { id: existing.id }), "success");
      openDetailsModal(existing.id, "edit");
    } else {
      // Open the Add screen for a new asset and automatically fill out all parsed fields
      showToast(t("notif_new_asset_scanned"), "info");
      openModal("add-asset-modal");
      prefillAddAssetForm(parsed);
    }
  });
}

// Start Camera Stream QR scan
function startCameraScanner() {
  if (isScannerStarting) return;
  isScannerStarting = true;
  shouldStopScanner = false;
  
  document.getElementById("scanner-output-status").textContent = "...";
  
  if (html5QrScanner) {
    try {
      const clearResult = html5QrScanner.clear();
      if (clearResult && typeof clearResult.catch === 'function') {
        clearResult.catch(e => console.log("Clear error", e));
      }
    } catch (e) {
      console.log("Clear error", e);
    }
  }

  html5QrScanner = new Html5Qrcode("qr-reader");
  const config = { fps: 15, qrbox: { width: 300, height: 300 } };

  html5QrScanner.start(
    { facingMode: "environment" }, 
    config,
    (decodedText) => {
      playBeep();
      stopCameraScanner();
      closeModal("scanner-modal");

      // Parse the decoded QR content (supports JSON, query params, or raw ID)
      const parsed = parseScannedContent(decodedText);
      if (!parsed) return;

      // Normalize scanned text ID (e.g. M2379 -> smm2379)
      let normalizedId = (parsed.id || "").toLowerCase();
      if (normalizedId.startsWith("m") && normalizedId.length > 2) {
        normalizedId = "smm" + normalizedId.substring(1);
      }

      const existing = assets.find(a => {
        const assetIdLower = (a.id || "").toLowerCase();
        const assetSerialLower = (a.serialNumber || "").toLowerCase();
        return assetIdLower === normalizedId || 
               (parsed.serial && assetSerialLower === parsed.serial.toLowerCase()) ||
               (parsed.id && assetIdLower === parsed.id.toLowerCase());
      });
      
      if (existing) {
        // Existing asset: open directly to the 'edit' actions tab
        showToast(t("notif_scan_success", { id: existing.id }), "success");
        openDetailsModal(existing.id, "edit");
      } else {
        // New asset found! Open the Add Asset Modal and pre-fill all available details
        showToast(t("notif_new_asset_scanned"), "info");
        openModal("add-asset-modal");
        prefillAddAssetForm(parsed);
      }
    },
    (errorMessage) => {
    }
  ).then(() => {
    isScannerStarting = false;
    if (shouldStopScanner) {
      stopCameraScanner();
    } else {
      document.getElementById("scanner-output-status").textContent = "";
    }
  }).catch(err => {
    isScannerStarting = false;
    console.error("Camera startup failure", err);
    document.getElementById("scanner-output-status").textContent = "Camera error: Camera not found or permission denied.";
    setTimeout(() => {
      closeModal("scanner-modal");
      isScannerStarting = false; // Reset flag so they can try again
    }, 3000); 
  });
}


// Stop Camera Stream
function stopCameraScanner() {
  if (isScannerStarting) {
    shouldStopScanner = true;
    return;
  }
  
  if (html5QrScanner) {
    try {
      html5QrScanner.stop().then(() => {
        if (html5QrScanner) {
          try {
            const clearResult = html5QrScanner.clear();
            if (clearResult && typeof clearResult.catch === 'function') {
              clearResult.catch(e => console.log("Clear error", e));
            }
          } catch (e) {
            console.log("Clear error", e);
          }
        }
      }).catch(err => console.error("Scanner stop fail", err));
    } catch (e) {
      console.log("Scanner already stopped or clear failed", e);
    }
  }
}

// General Modal open/close helpers
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add("active");
    if (modalId === "settings-modal") {
      const cloudIdInput = document.getElementById("api-cloud-id");
      cloudIdInput.value = apiConfig.cloudId || "";
      document.getElementById("api-workspace-id").value = apiConfig.workspaceId || "";
      document.getElementById("api-email").value = apiConfig.email || "";
      document.getElementById("api-token").value = apiConfig.token || "";
      document.getElementById("api-sync-limit").value = apiConfig.syncLimit || "100";

      // Populate Offline Mode toggle
      const offlineToggle = document.getElementById("offline-mode-toggle");
      if (offlineToggle) {
        offlineToggle.checked = isOfflineMode;
        offlineToggle.onchange = (e) => {
          isOfflineMode = e.target.checked;
          saveState();
          toggleOfflineUI(isOfflineMode);
        };
      }



      // Function to dynamically update the help links
      const updateHelpLinks = () => {
        let subdomain = cloudIdInput.value.trim() || "smm-sandbox";
        if (subdomain.includes("-")) {
          subdomain = "smm-sandbox"; // Fallback to their known subdomain if they entered a resolved UUID
        }
        
        const workspaceLink = document.getElementById("find-workspace-id-link");
        if (workspaceLink) {
          workspaceLink.href = `https://${subdomain}.atlassian.net/rest/servicedeskapi/assets/workspace`;
        }

        const cloudLink = document.getElementById("find-cloud-id-link");
        if (cloudLink) {
          cloudLink.href = `https://${subdomain}.atlassian.net/_edge/tenant_info`;
        }
      };
      
      // Initialize on modal open and watch for typing changes
      updateHelpLinks();
      cloudIdInput.oninput = updateHelpLinks;
      
      // Render/Fades elements as per current offline mode state
      toggleOfflineUI(isOfflineMode);
    }
  }
}
function closeModal(modalId) {
  document.getElementById(modalId).classList.remove("active");
}

// Theme Toggle & Connection Features Initial State Loader
document.addEventListener("DOMContentLoaded", () => {
  const themeBtn = document.getElementById("theme-toggle-btn");
  if (themeBtn) {
    const currentTheme = safeStorage.get("localStorage", "assetGuard_theme") || "light";
    if (currentTheme === "dark") {
      document.body.setAttribute("data-theme", "dark");
      themeBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
    } else {
      document.body.removeAttribute("data-theme");
      themeBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
    }
  }

  // Bind Telemetry diagnostics tracer trigger
  const runDiagnosticsBtn = document.getElementById("run-diagnostics-btn");
  if (runDiagnosticsBtn) {
    runDiagnosticsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      runConnectionTelemetry();
    });
  }

});

// Run connection diagnostic telemetry tracing
async function runConnectionTelemetry() {
  const panel = document.getElementById("diagnostics-panel");
  const output = document.getElementById("diagnostics-trace-output");
  const timeSpan = document.getElementById("diagnostics-time");
  
  if (!panel || !output) return;
  
  // Toggle active class on panel
  panel.classList.toggle("active");
  if (!panel.classList.contains("active")) return;
  
  timeSpan.textContent = new Date().toLocaleTimeString();
  output.innerHTML = "";
  
  const addLine = (type, text) => {
    const iconMap = {
      info: "fa-info-circle",
      success: "fa-circle-check",
      warning: "fa-triangle-exclamation",
      error: "fa-circle-xmark",
      spin: "fa-spinner fa-spin"
    };
    const line = document.createElement("div");
    line.className = `trace-line ${type}`;
    line.innerHTML = `<i class="fa-solid ${iconMap[type] || 'fa-terminal'}"></i> ${text}`;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  };
  
  addLine("info", "Starting Telemetry Connection diagnostics trace...");
  
  if (isOfflineMode) {
    addLine("warning", "Diagnostics halted: Active Offline Mode is currently enabled. Bypass connection checks.");
    return;
  }
  
  const email = (document.getElementById("api-email")?.value || "").trim() || apiConfig.email;
  const token = (document.getElementById("api-token")?.value || "").trim() || apiConfig.token;
  const cloudId = (document.getElementById("api-cloud-id")?.value || "").trim() || apiConfig.cloudId;
  const workspaceId = (document.getElementById("api-workspace-id")?.value || "").trim() || apiConfig.workspaceId;
  
  // Check Step 1: Config Fields check
  addLine("info", "Verifying Atlassian configurations parameters...");
  await new Promise(r => setTimeout(r, 400));
  
  if (!email || !token || !cloudId || !workspaceId) {
    addLine("error", "Failed: Missing critical Atlassian settings. Please fill out Cloud ID, Workspace ID, Email, and API Token fields.");
    return;
  }
  addLine("success", "Required Atlassian fields are populated.");
  
  // Check Step 2: UUID Format verification
  const isCloudUuid = cloudId.includes("-") && isValidUUID(cloudId);
  const isSubdomain = !cloudId.includes("-");
  
  if (!isCloudUuid && !isSubdomain) {
    addLine("warning", `Cloud ID format '${cloudId}' looks abnormal. UUID or simple subdomain expected.`);
  } else if (isCloudUuid) {
    addLine("success", `Cloud ID format is verified as a valid UUID.`);
  } else {
    addLine("info", `Cloud ID is a raw subdomain '${cloudId}'. Running auto-resolver to fetch UUID...`);
  }
  
  // Check Step 3: Direct Ping DNS / CORS Check
  const pingUrl = isSubdomain 
    ? `https://${cloudId}.atlassian.net/_edge/tenant_info`
    : `https://api.atlassian.com/ex/jira/${cloudId}/rest/servicedeskapi/assets/workspace`;
    
  addLine("spin", `Attempting direct secure CORS fetch to Atlassian Gateway at ${isSubdomain ? `${cloudId}.atlassian.net` : 'api.atlassian.com'}...`);
  await new Promise(r => setTimeout(r, 600));
  
  const auth = btoa(`${email}:${token}`);
  const headers = {
    "Authorization": `Basic ${auth}`,
    "Accept": "application/json"
  };
  
  let directSuccess = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(pingUrl, { headers, signal: controller.signal });
    clearTimeout(timeout);
    
    if (res.ok) {
      addLine("success", "Direct gateway ping succeeded! Your browser can connect directly to Atlassian with no CORS restrictions.");
      directSuccess = true;
    } else {
      addLine("warning", `Direct connection returned status ${res.status}: ${res.statusText}. Authentic credentials required.`);
    }
  } catch (err) {
    addLine("error", `Direct connection BLOCKED by browser security: ${err.message}. (CORS restriction standard on localhost/static)`);
  }
  
  if (!directSuccess) {
    // Check Step 4: Fallback Proxy diagnostics via allorigins
    const proxyPrefix = "https://api.allorigins.win/get?url=";
    addLine("info", "Smart CORS Auto-Proxy diagnostics: Testing backup route via public resolver allorigins.win...");
    await new Promise(r => setTimeout(r, 500));
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const fullProxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(pingUrl)}`;
      const res = await fetch(fullProxyUrl, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (res && res.ok) {
        const data = await res.json();
        if (data && data.contents) {
          addLine("success", "Public Proxy Fallback test SUCCEEDED! Cross-origin requests can bypass CORS via proxy.");
        } else {
          addLine("error", "Public Proxy returned empty contents block.");
        }
      } else {
        addLine("error", "Public Proxy gateway returned status code error.");
      }
    } catch (proxyErr) {
      addLine("error", `Public Proxy routing check failed: ${proxyErr.message}`);
    }
  }
  
  addLine("success", "Tracer diagnostics complete. Connection telemetry successfully analyzed.");
}
