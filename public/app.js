/* =====================================================================
   Car Keys — thin client
   All BAN/CTN data and business state lives on the server + shared
   Postgres database. This file only handles UI + API calls, so any
   number of people on any device see consistent, shared state.
   ===================================================================== */
(function(){
"use strict";

const DAILY_LIMIT = 20;
const $ = sel => document.querySelector(sel);

/* ---------------------------------------------------------------
   Tiny API helper
   --------------------------------------------------------------- */
async function api(method, url, body){
  const opts = { method, headers: {} };
  if(body !== undefined){
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if(!res.ok){
    let msg = "Request failed";
    try{ const j = await res.json(); msg = j.error || msg; }catch(e){}
    throw new Error(msg);
  }
  return res.json();
}

/* ---------------------------------------------------------------
   Local (device-only) convenience — NOT business data.
   Just remembers the last login so the same device doesn't retype
   every time. All real state lives server-side.
   --------------------------------------------------------------- */
function lsGet(key, fallback){ try{ const r = localStorage.getItem("ckc_"+key); return r?JSON.parse(r):fallback; }catch(e){ return fallback; } }
function lsSet(key, val){ try{ localStorage.setItem("ckc_"+key, JSON.stringify(val)); }catch(e){} }
function lsDel(key){ localStorage.removeItem("ckc_"+key); }

function todayStr(){
  const d = new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function tomorrowStr(){
  const d = new Date(); d.setDate(d.getDate()+1);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function fmtCTN(ctn){ const s=String(ctn).padStart(10,"0"); return s.slice(0,3)+"-"+s.slice(3,6)+"-"+s.slice(6); }
function maskCTN(ctn){ const s=String(ctn).padStart(10,"0"); return "XXX-XXX-"+s.slice(6); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

/* ---------------------------------------------------------------
   Meta (districts/stores), loaded once at page load
   --------------------------------------------------------------- */
let META = null; // {districts, stores, today}
let session = null; // {storeIdx, storeName, districtName, agentName}
let currentLock = null; // {banList, filters, firstAssignedTime}
let pollTimer = null;

const loginScreen = $("#loginScreen"), appScreen = $("#appScreen"), adminScreen = $("#adminScreen");
const loginDistrict = $("#loginDistrict"), loginStore = $("#loginStore"), loginAgent = $("#loginAgent"), loginPin = $("#loginPin");
const loginErr = $("#loginErr");

async function boot(){
  META = await api("GET", "/api/meta");
  initLoginForm();
  populateAdminSelectors();

  const saved = lsGet("session", null);
  if(saved){
    session = saved;
    loginDistrict.value = META.stores[session.storeIdx].districtIdx;
    loginDistrict.dispatchEvent(new Event("change"));
    loginStore.value = session.storeIdx;
    await enterApp();
  }
}

function initLoginForm(){
  const districts = META.districts.slice().sort((a,b)=>a.name.localeCompare(b.name));
  loginDistrict.innerHTML = '<option value="">Select district…</option>' +
    districts.map(d=>`<option value="${d.idx}">${escapeHtml(d.name)}</option>`).join("");
}
loginDistrict.addEventListener("change", ()=>{
  const distIdx = loginDistrict.value;
  if(distIdx===""){
    loginStore.innerHTML = '<option value="">Select district first…</option>';
    loginStore.disabled = true;
    return;
  }
  const stores = META.stores.filter(s=>String(s.districtIdx)===String(distIdx))
    .sort((a,b)=>a.name.localeCompare(b.name));
  loginStore.innerHTML = '<option value="">Select store…</option>' +
    stores.map(s=>`<option value="${s.idx}">${escapeHtml(s.name)}</option>`).join("");
  loginStore.disabled = false;
});

$("#eyeToggle").addEventListener("click", ()=>{
  loginPin.type = loginPin.type==="password" ? "text" : "password";
});
$("#loginBtn").addEventListener("click", doLogin);
[loginAgent, loginPin].forEach(el=>el.addEventListener("keydown", e=>{ if(e.key==="Enter") doLogin(); }));

async function doLogin(){
  loginErr.style.display="none";
  const distIdx = loginDistrict.value, storeIdx = loginStore.value, agentName = loginAgent.value.trim(), pin = loginPin.value;
  if(distIdx===""||storeIdx===""||!agentName){
    loginErr.textContent = "District, Store, and Agent Name are all required.";
    loginErr.style.display="block"; return;
  }
  let resp;
  try{
    resp = await api("POST", "/api/login", {storeIdx:Number(storeIdx), agentName, pin});
  }catch(e){
    loginErr.textContent = "Could not reach the server. Please try again."; loginErr.style.display="block"; return;
  }
  if(!resp.ok){
    loginErr.textContent = resp.error; loginErr.style.display="block"; return;
  }
  session = { storeIdx:Number(storeIdx), storeName:resp.storeName, districtName:resp.districtName, agentName };
  lsSet("session", session);
  await enterApp();
}

$("#logoutBtn").addEventListener("click", ()=>{
  session = null; lsDel("session");
  clearInterval(pollTimer);
  loginAgent.value=""; loginPin.value="";
  appScreen.style.display="none"; loginScreen.style.display="flex";
});

/* ---------------------------------------------------------------
   Enter app
   --------------------------------------------------------------- */
async function enterApp(){
  loginScreen.style.display="none"; appScreen.style.display="block";
  $("#hdrStore").textContent = session.storeName;
  $("#hdrMeta").textContent = session.districtName;
  $("#hdrAgent").textContent = "👤 " + session.agentName;

  await buildFilterUI(session.storeIdx);

  // Peek: does a lock already exist today? We find out by calling /api/assignment
  // with empty filters — the server returns the existing lock untouched if present,
  // and only computes+creates a new one if none exists yet.
  await pullAssignment(readFiltersFromUI(), /*isExplicitClick*/ false);
}

/* ---------------------------------------------------------------
   Filters UI
   --------------------------------------------------------------- */
function setFiltersEnabled(enabled){
  document.querySelectorAll("#filtersPanel input, #filtersPanel select").forEach(el=>{ el.disabled = !enabled; });
}
async function buildFilterUI(storeIdx){
  const { ratePlans, rrcs } = await api("GET", `/api/filters?storeIdx=${storeIdx}`);
  $("#fRatePlan").innerHTML = ratePlans.map(({name,count})=>
    `<label><input type="checkbox" value="${escapeHtml(name)}"> ${escapeHtml(name)} <span style="color:#9aa4af;">(${count})</span></label>`
  ).join("") || '<span style="color:#9aa4af;">No data</span>';
  $("#fRRC").innerHTML = rrcs.map(({val,count})=>
    `<label><input type="checkbox" value="${val}"> ${val} <span style="color:#9aa4af;">(${count})</span></label>`
  ).join("") || '<span style="color:#9aa4af;">No data</span>';
  const radioHTML = (name)=>`
    <label><input type="radio" name="${name}" value="any" checked> Any</label>
    <label><input type="radio" name="${name}" value="yes"> Yes</label>
    <label><input type="radio" name="${name}" value="no"> No</label>`;
  $("#fAutoPay").innerHTML = radioHTML("autopay");
  $("#fProtect").innerHTML = radioHTML("protect");
  $("#fILD").innerHTML = radioHTML("ild");
  $("#fUpgPlus").innerHTML = radioHTML("upgplus");
  $("#fCSP").innerHTML = radioHTML("csp");
  $("#fActFrom").value=""; $("#fActTo").value="";
}
$("#rrcSearch").addEventListener("input", ()=>{
  const q = $("#rrcSearch").value.trim().toLowerCase();
  $("#fRRC").querySelectorAll("label").forEach(lbl=>{ lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? "" : "none"; });
});
$("#fActFrom").addEventListener("change", ()=>{
  const from=$("#fActFrom").value, to=$("#fActTo");
  if(from){ to.min=from; if(to.value && to.value<from) to.value=from; }
});
function readFiltersFromUI(){
  return {
    ratePlans: [...document.querySelectorAll('#fRatePlan input:checked')].map(i=>i.value),
    rrcs: [...document.querySelectorAll('#fRRC input:checked')].map(i=>Number(i.value)),
    autopay: radioVal("autopay"), protect: radioVal("protect"), ild: radioVal("ild"),
    upgplus: radioVal("upgplus"), csp: radioVal("csp"),
    actFrom: $("#fActFrom").value, actTo: $("#fActTo").value
  };
}
function radioVal(name){ const el=document.querySelector(`input[name="${name}"]:checked`); return el?el.value:"any"; }
function applyFiltersToUI(f){
  if(!f) return;
  document.querySelectorAll('#fRatePlan input').forEach(i=>{ i.checked = (f.ratePlans||[]).includes(i.value); });
  document.querySelectorAll('#fRRC input').forEach(i=>{ i.checked = (f.rrcs||[]).includes(Number(i.value)); });
  const setRadio=(name,val)=>{ const el=document.querySelector(`input[name="${name}"][value="${val}"]`); if(el) el.checked=true; };
  setRadio("autopay", f.autopay||"any"); setRadio("protect", f.protect||"any"); setRadio("ild", f.ild||"any");
  setRadio("upgplus", f.upgplus||"any"); setRadio("csp", f.csp||"any");
  $("#fActFrom").value = f.actFrom||""; $("#fActTo").value = f.actTo||"";
}

/* ---------------------------------------------------------------
   Assignment (locked or fresh) + rendering
   --------------------------------------------------------------- */
$("#fetchBtn").addEventListener("click", ()=> pullAssignment(readFiltersFromUI(), true));

async function pullAssignment(filters, isExplicitClick){
  let resp;
  try{
    resp = await api("POST", "/api/assignment", { storeIdx: session.storeIdx, agentName: session.agentName, filters });
  }catch(e){
    toast("Could not reach the server."); return;
  }
  currentLock = resp;
  if(resp.locked){
    applyFiltersToUI(resp.filters);
    setFiltersEnabled(false);
    $("#lockedNote").style.display = "inline";
    $("#fetchBtn").textContent = "Refresh My BANs";
    $("#lockBanner").innerHTML = `<div class="banner locked">🔒 Welcome back — you're seeing the same ${resp.banList.length} BANs assigned today at ${new Date(resp.firstAssignedTime).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}. Filters are locked for the rest of today. This list is shared — if a teammate at this store is also logged in, their updates show up here too.</div>`;
  } else {
    setFiltersEnabled(false);
    $("#lockedNote").style.display = "inline";
    $("#fetchBtn").textContent = "Refresh My BANs";
    $("#lockBanner").innerHTML = `<div class="banner fresh">✅ Assigned at ${new Date(resp.firstAssignedTime).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})} — matched ${resp.totalMatched} BANs, showing your ${resp.banList.length}.</div>`;
  }
  await renderBanList(resp.banList, resp);
  startPolling();
}

function startPolling(){
  clearInterval(pollTimer);
  pollTimer = setInterval(async ()=>{
    if(!currentLock || !currentLock.banList || !currentLock.banList.length) return;
    await renderBanList(currentLock.banList, currentLock, /*silent*/ true);
  }, 20000);
}

async function renderBanList(banList, opts, silent){
  if(!silent){
    $("#resultsTitle").textContent = banList.length
      ? `Showing ${banList.length} BAN${banList.length!==1?"s":""}` + (opts.followUpCount ? ` (${opts.followUpCount} follow-up${opts.followUpCount!==1?"s":""})` : "")
      : "No BANs found";
    $("#fetchTime").textContent = opts.fetchMs!==undefined ? `fetched in ${(opts.fetchMs/1000).toFixed(2)} sec` : "";
  }
  if(!banList.length){
    $("#resultsArea").innerHTML = '<div class="emptyState">No BANs matched your filters for this store today. Try widening the filters.</div>';
    return;
  }
  const { cards } = await api("GET", `/api/ban-cards?storeIdx=${session.storeIdx}&bans=${banList.join(",")}`);
  const area = $("#resultsArea");
  area.innerHTML = cards.map(renderBanCard).join("");
  area.querySelectorAll("[data-action]").forEach(btn=>btn.addEventListener("click", onActionClick));
}

function renderBanCard(card){
  const tooltip = `
    <b>Rate Plan:</b> ${escapeHtml(card.ratePlans.join(", "))}<br>
    <b>Device(s):</b> ${escapeHtml(card.devices.slice(0,3).join(", "))}${card.devices.length>3?" …":""}<br>
    <b>CSP Opportunity:</b> ${card.anyCSP?"Yes":"No"}<br>
    <b>Protect:</b> ${card.protect?"Yes":"No"} &nbsp; <b>ILD:</b> ${card.ild?"Yes":"No"} &nbsp; <b>Upg Plus:</b> ${card.upg?"Yes":"No"}<br>
    <b>Sub-Rank:</b> ${card.subRankMin ?? "—"}<br>
    <b>Lines on BAN:</b> ${card.rows.length}
  `;
  const rowsHtml = card.rows.map(r=>renderCtnRow(r, card.ban)).join("");
  return `
  <div class="banCard" data-ban="${card.ban}">
    <div class="banHead">
      <div class="banInfo">
        <span class="banNum">BAN ${card.ban}</span>
        <span class="custName">${escapeHtml(card.customer)}</span>
        <span class="infoIcon">i<span class="tooltip">${tooltip}</span></span>
      </div>
    </div>
    <table class="ctnTable">
      <thead><tr>
        <th>CTN</th><th>Store</th><th>Activation</th><th>Last Activity</th>
        <th>Rate Plan</th><th>Flags</th><th>Status</th><th>Notes</th><th>Actions</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
}

function renderCtnRow(r, ban){
  const isCompleted = r.completedStatus === "Completed";
  const isNotCompleted = r.completedStatus === "Not Completed";
  const isCalled = r.called || isCompleted;
  const masked = !r.isMine || isCompleted;
  const ctnDisplay = masked ? maskCTN(r.ctn) : fmtCTN(r.ctn);

  const flagIcons = [
    ["AutoPay", r.flags&1], ["Protect", r.flags&2], ["ILD", r.flags&4],
    ["UpgPlus", r.flags&8], ["CSP", (r.flags&16)||(r.flags&32)]
  ].map(([label,on])=>`<span class="${on?"on":""}">${label}</span>`).join("");

  let statusHtml = isCompleted ? `<span class="statusPill completed">Completed</span>`
    : isNotCompleted ? `<span class="statusPill notcompleted">Not Completed</span>`
    : `<span class="statusPill pending">Pending</span>`;

  const noteBits = [];
  if(r.callBackDate) noteBits.push(`Callback: ${r.callBackDate}`);
  if(r.notes) noteBits.push(r.notes);
  const noteJoined = noteBits.join(" — ");
  const noteHtml = noteBits.length ? `<span class="noteText" title="${escapeHtml(noteJoined)}">${escapeHtml(noteJoined.slice(0,40))}${noteJoined.length>40?"…":""}</span>` : "";

  let actionsHtml;
  if(r.isMine){
    actionsHtml = `
      <div class="ctnActions">
        <button class="actBtn called ${isCalled?"done":""}" data-action="called" data-ctn="${r.ctn}" data-ban="${ban}" ${isCalled?"disabled":""}>${isCalled?"✓ Called":"Called"}</button>
        <button class="actBtn completed ${isCompleted?"done":""}" data-action="completed" data-ctn="${r.ctn}" data-ban="${ban}" ${isCompleted?"disabled":""}>${isCompleted?"✓ Completed":"Completed"}</button>
        <button class="actBtn notcompleted" data-action="notcompleted" data-ctn="${r.ctn}" data-ban="${ban}" ${isCompleted?"disabled":""}>Not Completed</button>
      </div>`;
  } else {
    actionsHtml = `<span style="color:#9aa4af;font-size:11.5px;">Other store — view only</span>`;
  }

  return `<tr data-ctn="${r.ctn}">
    <td>${ctnDisplay}</td>
    <td><span class="badgeStore ${r.isMine?"mine":"other"}">${r.isMine?"Your Store":escapeHtml(r.storeName)}</span></td>
    <td>${escapeHtml(r.actDate)}</td>
    <td>${escapeHtml(r.lastAct)}</td>
    <td>${escapeHtml(r.ratePlan)}</td>
    <td><div class="flagIcons">${flagIcons}</div></td>
    <td>${statusHtml}</td>
    <td>${noteHtml}</td>
    <td>${actionsHtml}</td>
  </tr>`;
}

/* ---------------------------------------------------------------
   Actions
   --------------------------------------------------------------- */
let ncTarget = null;
const ncOverlay = $("#ncOverlay"), ncDate = $("#ncDate"), ncNotes = $("#ncNotes"), ncErr = $("#ncErr");

async function onActionClick(e){
  const btn = e.currentTarget;
  const action = btn.dataset.action, ctn = Number(btn.dataset.ctn), ban = Number(btn.dataset.ban);
  if(action==="notcompleted"){
    ncTarget = {ban, ctn};
    ncDate.min = tomorrowStr(); ncDate.value=""; ncNotes.value=""; ncErr.style.display="none";
    ncOverlay.classList.add("show");
    return;
  }
  try{
    await api("POST", "/api/action", { storeIdx: session.storeIdx, agentName: session.agentName, ban, ctn, action });
    toast("Saved");
    await renderBanList(currentLock.banList, currentLock, true);
  }catch(err){
    toast(err.message || "Could not save.");
  }
}
$("#ncCancel").addEventListener("click", ()=> ncOverlay.classList.remove("show"));
$("#ncSave").addEventListener("click", async ()=>{
  const d = ncDate.value, notes = ncNotes.value.trim();
  if(!d || d<=todayStr()){ ncErr.textContent="Call-back date must be tomorrow or later."; ncErr.style.display="block"; return; }
  if(notes.length<3){ ncErr.textContent="Please enter at least 3 characters explaining why."; ncErr.style.display="block"; return; }
  try{
    await api("POST", "/api/action", {
      storeIdx: session.storeIdx, agentName: session.agentName,
      ban: ncTarget.ban, ctn: ncTarget.ctn, action:"notcompleted", callBackDate:d, notes
    });
    ncOverlay.classList.remove("show");
    toast("Saved");
    await renderBanList(currentLock.banList, currentLock, true);
  }catch(err){
    ncErr.textContent = err.message || "Could not save."; ncErr.style.display="block";
  }
});

/* ---------------------------------------------------------------
   Toast
   --------------------------------------------------------------- */
let toastTimer=null;
function toast(msg){
  const el=$("#toast"); el.textContent=msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"), 1800);
}

/* ---------------------------------------------------------------
   Admin
   --------------------------------------------------------------- */
function populateAdminSelectors(){
  const opts = META.stores.map(s=>`<option value="${s.idx}">${escapeHtml(s.name)}</option>`).join("");
  $("#adminStoreSelect").innerHTML = opts;
  $("#adminClearStoreSelect").innerHTML = opts;
}
async function showAdminStats(){
  const s = await api("GET", "/api/admin/stats");
  $("#adminStats").innerHTML = `
    <div class="stat"><b>${s.rowCount.toLocaleString()}</b><span>Source Rows</span></div>
    <div class="stat"><b>${s.banCount.toLocaleString()}</b><span>Unique BANs</span></div>
    <div class="stat"><b>${s.storeCount}</b><span>Stores</span></div>
    <div class="stat"><b>${s.completedFull}</b><span>BANs Fully Completed</span></div>
    <div class="stat"><b>${s.completedCtns}</b><span>CTNs Completed</span></div>
    <div class="stat"><b>${s.pending}</b><span>Pending Callbacks</span></div>
  `;
}
function openAdmin(){
  loginScreen.style.display="none"; appScreen.style.display="none"; adminScreen.style.display="block";
  showAdminStats();
}
$("#adminLink").addEventListener("click", e=>{ e.preventDefault(); openAdmin(); });
$("#adminBtn2").addEventListener("click", openAdmin);
$("#adminBack").addEventListener("click", ()=>{
  adminScreen.style.display="none";
  if(session){ appScreen.style.display="block"; } else { loginScreen.style.display="flex"; }
});
$("#adminSavePin").addEventListener("click", async ()=>{
  const storeIdx = Number($("#adminStoreSelect").value);
  const pin = $("#adminStorePin").value;
  await api("POST", "/api/admin/pin", {storeIdx, pin});
  $("#adminStorePin").value="";
  toast(pin ? "PIN saved" : "PIN removed");
});
$("#adminClearLock").addEventListener("click", async ()=>{
  const storeIdx = Number($("#adminClearStoreSelect").value);
  await api("POST", "/api/admin/clear-lock", {storeIdx});
  toast("Today's lock cleared");
});
$("#exportTrackingBtn").addEventListener("click", ()=> window.open("/api/admin/export/tracking", "_blank"));
$("#exportCompletedBtn").addEventListener("click", ()=> window.open("/api/admin/export/completed", "_blank"));
$("#exportPendingBtn").addEventListener("click", ()=> window.open("/api/admin/export/pending", "_blank"));
$("#resetAllBtn").addEventListener("click", ()=>{
  alert("Data now lives in the shared database, not this browser. To wipe it, run a DELETE against the Postgres tables (see README) — this button is intentionally disabled for the hosted version to prevent accidental data loss.");
});

boot();
})();
