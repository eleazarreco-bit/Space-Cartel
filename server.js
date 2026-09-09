/* =====================================================================
   Car Keys — shared backend server
   Serves the read-only dataset from memory, keeps all mutable state
   (locks, statuses, callbacks, PINs) in Postgres so any number of
   people, from any device, share one consistent daily assignment
   per store.
   ===================================================================== */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const DAILY_LIMIT = 20;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false })
});

/* ---------------------------------------------------------------
   Load dataset into memory once at boot
   --------------------------------------------------------------- */
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, "data", "car_keys_data.json");
console.log("Loading dataset from", DATA_PATH, "...");
const RAW = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
const D = RAW.dict;
const COLS = RAW.cols;
const STORE_META = RAW.storeMeta;
const N_ROWS = RAW.meta.rowCount;
console.log("Loaded", N_ROWS, "rows,", D.stores.length, "stores");

let STORE_ROWS = new Map();
let BAN_ROWS = new Map();
let DISTRICT_STORES = new Map();
(function buildIndices(){
  const t0 = Date.now();
  for(let i=0;i<N_ROWS;i++){
    const st = COLS.store[i];
    if(!STORE_ROWS.has(st)) STORE_ROWS.set(st, []);
    STORE_ROWS.get(st).push(i);
    const ban = COLS.ban[i];
    if(!BAN_ROWS.has(ban)) BAN_ROWS.set(ban, []);
    BAN_ROWS.get(ban).push(i);
  }
  for(let s=0;s<D.stores.length;s++){
    const dist = STORE_META.district[s];
    if(!DISTRICT_STORES.has(dist)) DISTRICT_STORES.set(dist, []);
    DISTRICT_STORES.get(dist).push(s);
  }
  console.log("Indices built in", Date.now()-t0, "ms —", STORE_ROWS.size, "stores,", BAN_ROWS.size, "unique BANs");
})();

function todayStr(){
  const d = new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function tomorrowStr(){
  const d = new Date(); d.setDate(d.getDate()+1);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}

/* ---------------------------------------------------------------
   Express app
   --------------------------------------------------------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function asyncH(fn){ return (req,res)=>fn(req,res).catch(err=>{ console.error(err); res.status(500).json({ok:false, error: "Server error"}); }); }

/* ---- Meta (districts/stores for the login screen) ---- */
app.get("/api/meta", (req,res)=>{
  const districts = [...DISTRICT_STORES.keys()].map(idx=>({idx, name: D.districts[idx]}))
    .sort((a,b)=>a.name.localeCompare(b.name));
  const stores = D.stores.map((name,idx)=>({idx, name, districtIdx: STORE_META.district[idx]}));
  res.json({districts, stores, today: todayStr()});
});

/* ---- Login ---- */
app.post("/api/login", asyncH(async (req,res)=>{
  const {storeIdx, agentName, pin} = req.body || {};
  if(storeIdx===undefined || !agentName || !String(agentName).trim()){
    return res.json({ok:false, error:"District, Store, and Agent Name are all required."});
  }
  const storeName = D.stores[storeIdx];
  if(!storeName) return res.json({ok:false, error:"Unknown store."});
  const { rows } = await pool.query("SELECT pin FROM store_pins WHERE store_name=$1", [storeName]);
  const requiredPin = rows[0] ? rows[0].pin : "";
  if(requiredPin && (pin||"") !== requiredPin){
    return res.json({ok:false, error:"Incorrect PIN for this store."});
  }
  res.json({ok:true, storeName, districtName: D.districts[STORE_META.district[storeIdx]]});
}));

/* ---- Filter option counts for a store ---- */
app.get("/api/filters", (req,res)=>{
  const storeIdx = Number(req.query.storeIdx);
  const rows = STORE_ROWS.get(storeIdx) || [];
  const rateCounts = new Map(), rrcCounts = new Map();
  for(const r of rows){
    const rp = D.ratePlans[COLS.ratePlan[r]];
    rateCounts.set(rp, (rateCounts.get(rp)||0)+1);
    const rrc = COLS.rrc[r];
    rrcCounts.set(rrc, (rrcCounts.get(rrc)||0)+1);
  }
  const ratePlans = [...rateCounts.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([name,count])=>({name,count}));
  const rrcs = [...rrcCounts.entries()].sort((a,b)=>a[0]-b[0]).map(([val,count])=>({val,count}));
  res.json({ratePlans, rrcs});
});

/* ---------------------------------------------------------------
   Filter predicate (mirrors the old client-side logic)
   --------------------------------------------------------------- */
function matchesFilters(rowIdx, f){
  if(f.ratePlans && f.ratePlans.length && !f.ratePlans.includes(D.ratePlans[COLS.ratePlan[rowIdx]])) return false;
  if(f.rrcs && f.rrcs.length && !f.rrcs.includes(COLS.rrc[rowIdx])) return false;
  const flags = COLS.flags[rowIdx];
  const chk = (bit, want)=>{
    if(!want || want==="any") return true;
    const on = !!(flags & bit);
    return want==="yes" ? on : !on;
  };
  if(!chk(1, f.autopay)) return false;
  if(!chk(2, f.protect)) return false;
  if(!chk(4, f.ild)) return false;
  if(!chk(8, f.upgplus)) return false;
  if(f.csp && f.csp!=="any"){
    const cspOn = !!(flags & 16) || !!(flags & 32);
    if(f.csp==="yes" && !cspOn) return false;
    if(f.csp==="no" && cspOn) return false;
  }
  if(f.actFrom || f.actTo){
    const d = D.actDates[COLS.actDate[rowIdx]];
    if(f.actFrom && d < f.actFrom) return false;
    if(f.actTo && d > f.actTo) return false;
  }
  return true;
}

async function getFullyCompletedSet(){
  const { rows } = await pool.query("SELECT ban FROM completed_full_bans");
  return new Set(rows.map(r=>Number(r.ban)));
}
async function getFollowUpBans(storeIdx){
  const today = todayStr();
  const { rows } = await pool.query(
    `SELECT ban, call_back_date FROM pending_callbacks
     WHERE store_idx=$1 AND call_back_date <= $2
     ORDER BY call_back_date ASC`, [storeIdx, today]
  );
  const seen = new Set(); const out = [];
  for(const r of rows){ const b = Number(r.ban); if(!seen.has(b)){ seen.add(b); out.push(b); } }
  return out;
}

function computeNewBans(storeIdx, filters, fullyCompleted){
  const rows = STORE_ROWS.get(storeIdx) || [];
  const banBestDate = new Map();
  for(const r of rows){
    const ban = COLS.ban[r];
    if(fullyCompleted.has(ban)) continue;
    if(!matchesFilters(r, filters)) continue;
    const d = D.actDates[COLS.actDate[r]];
    if(!banBestDate.has(ban) || d > banBestDate.get(ban)) banBestDate.set(ban, d);
  }
  const sorted = [...banBestDate.entries()].sort((a,b)=>b[1].localeCompare(a[1])).map(e=>e[0]);
  return { sorted, totalMatched: banBestDate.size };
}

/* ---- Get or create today's assignment (atomic) ---- */
app.post("/api/assignment", asyncH(async (req,res)=>{
  const { storeIdx, agentName, filters } = req.body || {};
  if(storeIdx===undefined || !D.stores[storeIdx]) return res.status(400).json({ok:false, error:"Invalid store."});
  const date = todayStr();

  const existing = await pool.query(
    "SELECT * FROM daily_locks WHERE store_idx=$1 AND lock_date=$2", [storeIdx, date]
  );
  if(existing.rows.length){
    const row = existing.rows[0];
    return res.json({
      ok:true, locked:true, banList: row.ban_list, filters: row.filters,
      firstAssignedTime: row.first_assigned, totalMatched: row.ban_list.length, followUpCount: 0
    });
  }

  const t0 = Date.now();
  const fullyCompleted = await getFullyCompletedSet();
  const followUp = await getFollowUpBans(storeIdx);
  const f = filters || {};
  const { sorted: newBans, totalMatched } = computeNewBans(storeIdx, f, fullyCompleted);

  const finalList = [];
  const seen = new Set();
  for(const b of [...followUp, ...newBans]){
    if(seen.has(b)) continue;
    seen.add(b); finalList.push(b);
    if(finalList.length>=DAILY_LIMIT) break;
  }
  const firstAssigned = new Date().toISOString();

  const inserted = await pool.query(
    `INSERT INTO daily_locks (store_idx, lock_date, ban_list, filters, first_assigned, agent_name)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (store_idx, lock_date) DO NOTHING
     RETURNING *`,
    [storeIdx, date, JSON.stringify(finalList), JSON.stringify(f), firstAssigned, agentName || ""]
  );

  let finalRow;
  if(inserted.rows.length){
    finalRow = inserted.rows[0];
  } else {
    // another request won the race — read what it wrote
    const again = await pool.query(
      "SELECT * FROM daily_locks WHERE store_idx=$1 AND lock_date=$2", [storeIdx, date]
    );
    finalRow = again.rows[0];
  }

  res.json({
    ok:true, locked: false, banList: finalRow.ban_list, filters: finalRow.filters,
    firstAssignedTime: finalRow.first_assigned, totalMatched, followUpCount: followUp.length,
    fetchMs: Date.now()-t0
  });
}));

/* ---- BAN card details (merged with live status from DB) ---- */
app.get("/api/ban-cards", asyncH(async (req,res)=>{
  const storeIdx = Number(req.query.storeIdx);
  const bans = String(req.query.bans||"").split(",").filter(Boolean).map(Number);
  if(!bans.length) return res.json({cards:[]});

  const { rows: statusRows } = await pool.query(
    `SELECT * FROM ctn_status WHERE ban = ANY($1::bigint[])`, [bans]
  );
  const statusMap = {};
  statusRows.forEach(s=>{ statusMap[s.ctn] = s; });

  const cards = bans.map(ban=>{
    const rowIdxs = (BAN_ROWS.get(ban)||[]).slice().sort((a,b)=>{
      const mineA = COLS.store[a]===storeIdx?0:1, mineB = COLS.store[b]===storeIdx?0:1;
      if(mineA!==mineB) return mineA-mineB;
      return COLS.ctn[a]-COLS.ctn[b];
    });
    let customer="NA"; const ratePlansSet=new Set(), devicesSet=new Set();
    let anyCSP=false, protect=false, ild=false, upg=false, subRankMin=null;
    const rowsOut = rowIdxs.map(r=>{
      const ctn = COLS.ctn[r];
      const c = D.customers[COLS.customer[r]];
      if(c && c!=="NA" && customer==="NA") customer = c;
      ratePlansSet.add(D.ratePlans[COLS.ratePlan[r]]);
      devicesSet.add(D.devices[COLS.device[r]]);
      const flags = COLS.flags[r];
      if(flags&16 || flags&32) anyCSP = true;
      if(flags&2) protect = true;
      if(flags&4) ild = true;
      if(flags&8) upg = true;
      const sr = COLS.subRank[r];
      if(subRankMin===null || sr<subRankMin) subRankMin = sr;

      const st = statusMap[ctn] || {};
      return {
        ctn, isMine: COLS.store[r]===storeIdx, storeName: D.stores[COLS.store[r]],
        actDate: D.actDates[COLS.actDate[r]], lastAct: D.lastActs[COLS.lastAct[r]],
        ratePlan: D.ratePlans[COLS.ratePlan[r]], flags,
        called: !!st.called, completedStatus: st.completed_status || "",
        callBackDate: st.call_back_date ? fmtDate(st.call_back_date) : "",
        notes: st.notes || ""
      };
    });
    return {
      ban, customer, ratePlans:[...ratePlansSet], devices:[...devicesSet],
      anyCSP, protect, ild, upg, subRankMin, rows: rowsOut
    };
  });

  res.json({cards});
}));

function fmtDate(d){
  if(typeof d === "string") return d.slice(0,10);
  const dt = new Date(d);
  return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
}

/* ---- Actions: called / completed / not completed ---- */
app.post("/api/action", asyncH(async (req,res)=>{
  const { storeIdx, agentName, ban, ctn, action, callBackDate, notes } = req.body || {};
  if(storeIdx===undefined || !ban || !ctn || !action) return res.status(400).json({ok:false, error:"Missing fields."});
  const storeName = D.stores[storeIdx];
  const date = todayStr();

  if(action==="called"){
    await upsertCtnStatus(ctn, ban, storeIdx, agentName, {called:true});
    await logTracking({date, storeName, ban, ctn, called:"Yes", completedStatus:"Pending", callBackDate:"", notes:"", agentName});
  } else if(action==="completed"){
    await upsertCtnStatus(ctn, ban, storeIdx, agentName, {called:true, completed_status:"Completed", call_back_date:null});
    await pool.query(
      "INSERT INTO completed_ctns_log (store_name, ban, ctn, completed_date, agent_name) VALUES ($1,$2,$3,$4,$5)",
      [storeName, ban, ctn, date, agentName]
    );
    await pool.query("DELETE FROM pending_callbacks WHERE store_idx=$1 AND ban=$2 AND ctn=$3", [storeIdx, ban, ctn]);
    await maybeMarkFullyCompleted(ban);
    await logTracking({date, storeName, ban, ctn, called:"Yes", completedStatus:"Completed", callBackDate:"", notes:"", agentName});
  } else if(action==="notcompleted"){
    if(!callBackDate || callBackDate <= date) return res.status(400).json({ok:false, error:"Call-back date must be tomorrow or later."});
    if(!notes || notes.trim().length<3) return res.status(400).json({ok:false, error:"Please enter at least 3 characters explaining why."});
    await upsertCtnStatus(ctn, ban, storeIdx, agentName, {called:true, completed_status:"Not Completed", call_back_date:callBackDate, notes});
    await pool.query(
      `INSERT INTO pending_callbacks (store_idx, ban, ctn, call_back_date, notes, agent_name, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (store_idx, ban, ctn) DO UPDATE SET call_back_date=$4, notes=$5, agent_name=$6, last_updated=now()`,
      [storeIdx, ban, ctn, callBackDate, notes, agentName]
    );
    await logTracking({date, storeName, ban, ctn, called:"Yes", completedStatus:"Not Completed", callBackDate, notes, agentName});
  } else {
    return res.status(400).json({ok:false, error:"Unknown action."});
  }

  const { rows } = await pool.query("SELECT * FROM ctn_status WHERE ctn=$1", [ctn]);
  res.json({ok:true, status: rows[0]});
}));

async function upsertCtnStatus(ctn, ban, storeIdx, agentName, patch){
  const cols = { called:false, completed_status:"", call_back_date:null, notes:null, ...patch };
  await pool.query(
    `INSERT INTO ctn_status (ctn, ban, store_idx, agent_name, called, completed_status, call_back_date, notes, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (ctn) DO UPDATE SET
       ban=$2, store_idx=$3, agent_name=$4,
       called = COALESCE($5, ctn_status.called),
       completed_status = CASE WHEN $6='' THEN ctn_status.completed_status ELSE $6 END,
       call_back_date = $7,
       notes = COALESCE($8, ctn_status.notes),
       last_updated = now()`,
    [ctn, ban, storeIdx, agentName, cols.called, cols.completed_status, cols.call_back_date, cols.notes]
  );
}
async function maybeMarkFullyCompleted(ban){
  const rowIdxs = BAN_ROWS.get(ban) || [];
  if(!rowIdxs.length) return;
  const ctns = rowIdxs.map(r=>COLS.ctn[r]);
  const { rows } = await pool.query(
    `SELECT ctn, completed_status FROM ctn_status WHERE ctn = ANY($1::bigint[])`, [ctns]
  );
  const doneMap = {};
  rows.forEach(r=>{ doneMap[r.ctn] = r.completed_status === "Completed"; });
  const allDone = ctns.every(c => doneMap[c]);
  if(allDone){
    await pool.query("INSERT INTO completed_full_bans (ban) VALUES ($1) ON CONFLICT DO NOTHING", [ban]);
  }
}
async function logTracking(e){
  await pool.query(
    `INSERT INTO daily_tracking
      (track_date, store_name, ban, ctn, called, completed_status, call_back_date, notes, login_date, agent_name, assigned_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1,$9,$1)`,
    [e.date, e.storeName, e.ban, e.ctn, e.called, e.completedStatus, e.callBackDate||null, e.notes||null, e.agentName]
  );
}

/* ---------------------------------------------------------------
   Admin
   --------------------------------------------------------------- */
app.get("/api/admin/stats", asyncH(async (req,res)=>{
  const q = async (sql, params)=> (await pool.query(sql, params)).rows[0].count;
  const completedFull = await q("SELECT COUNT(*)::int AS count FROM completed_full_bans");
  const completedCtns = await q("SELECT COUNT(*)::int AS count FROM ctn_status WHERE completed_status='Completed'");
  const pending = await q("SELECT COUNT(*)::int AS count FROM pending_callbacks");
  res.json({
    rowCount: N_ROWS, banCount: BAN_ROWS.size, storeCount: D.stores.length,
    completedFull: Number(completedFull), completedCtns: Number(completedCtns), pending: Number(pending)
  });
}));

app.post("/api/admin/pin", asyncH(async (req,res)=>{
  const { storeIdx, pin } = req.body || {};
  const storeName = D.stores[storeIdx];
  if(!storeName) return res.status(400).json({ok:false, error:"Unknown store."});
  if(pin){
    await pool.query(
      `INSERT INTO store_pins (store_name, pin) VALUES ($1,$2)
       ON CONFLICT (store_name) DO UPDATE SET pin=$2`, [storeName, pin]
    );
  } else {
    await pool.query("DELETE FROM store_pins WHERE store_name=$1", [storeName]);
  }
  res.json({ok:true});
}));

app.post("/api/admin/clear-lock", asyncH(async (req,res)=>{
  const { storeIdx } = req.body || {};
  await pool.query("DELETE FROM daily_locks WHERE store_idx=$1 AND lock_date=$2", [storeIdx, todayStr()]);
  res.json({ok:true});
}));

function csvRes(res, filename, headers, rows){
  const esc = v => `"${String(v??"").replace(/"/g,'""')}"`;
  const lines = [headers.join(",")].concat(rows.map(r=>headers.map(h=>esc(r[h])).join(",")));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
}
app.get("/api/admin/export/tracking", asyncH(async (req,res)=>{
  const { rows } = await pool.query("SELECT * FROM daily_tracking ORDER BY track_date, id");
  csvRes(res, "daily_tracking.csv",
    ["track_date","store_name","ban","ctn","called","completed_status","call_back_date","notes","login_date","agent_name","last_updated","assigned_date"],
    rows);
}));
app.get("/api/admin/export/completed", asyncH(async (req,res)=>{
  const { rows } = await pool.query("SELECT * FROM completed_ctns_log ORDER BY id");
  csvRes(res, "completed_ctns.csv", ["store_name","ban","ctn","completed_date","agent_name"], rows);
}));
app.get("/api/admin/export/pending", asyncH(async (req,res)=>{
  const { rows } = await pool.query("SELECT * FROM pending_callbacks ORDER BY call_back_date");
  csvRes(res, "pending_callbacks.csv", ["store_idx","ban","ctn","call_back_date","notes","agent_name","last_updated"], rows);
}));

app.get("/api/health", (req,res)=> res.json({ok:true, rows:N_ROWS}));

app.listen(PORT, ()=>{
  console.log(`Car Keys server listening on port ${PORT}`);
});
