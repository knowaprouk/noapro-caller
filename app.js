// ============================================================
// NoaPro Caller — application logic
// Static front end talking directly to Supabase (Postgres + Auth
// + Realtime + Storage). No backend server required.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, DAILY_CALL_TARGET, DAILY_SIGNUP_TARGET,
         WORKING_DAYS_PER_WEEK, WORKING_DAYS_PER_MONTH } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// statuses that still need calling (shown in the queue)
const CALLABLE = ["New", "No answer", "Voicemail left", "Callback"];
const OUTCOMES = [
  { label: "No answer",      cls: "" },
  { label: "Voicemail left", cls: "" },
  { label: "Callback",       cls: "" },
  { label: "Not interested", cls: "bad" },
  { label: "Wrong number",   cls: "" },
  { label: "Do not call",    cls: "bad" },
  { label: "Signed up",      cls: "win" },
];

let me = null;            // my profile
let profiles = {};        // id -> profile
let active = null;        // lead I've claimed
let online = new Set();   // user ids currently online
let timerInt = null, timerSec = 0;
let targetPeriod = "day"; // day | week | month (targets panel)

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const stClass = (s) => "st " + String(s).replace(/[^a-z]/gi, "");
const initials = (p) => p?.initials || "??";

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------------- AUTH ----------------
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginErr").textContent = "";
  $("#loginBtn").disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: $("#email").value.trim(),
    password: $("#password").value,
  });
  $("#loginBtn").disabled = false;
  if (error) { $("#loginErr").textContent = error.message; return; }
  boot();
});

$("#magicBtn").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  const note = $("#magicNote");
  note.className = "magic-note";
  if (!email) { $("#loginErr").textContent = "Enter your email first."; return; }
  $("#magicBtn").disabled = true;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] },
  });
  $("#magicBtn").disabled = false;
  if (error) { $("#loginErr").textContent = error.message; return; }
  $("#loginErr").textContent = "";
  note.classList.add("ok");
  note.textContent = "Check your email — click the link to sign in.";
});

$("#signout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

// ---------------- BOOT ----------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $("#loginView").classList.remove("hidden"); $("#appView").classList.add("hidden"); return; }

  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");

  await loadProfiles();
  me = profiles[session.user.id] || { id: session.user.id, full_name: "You", initials: "ME", color: "#0d7d6b" };

  await loadQueue();
  await loadDashboard();
  await loadFiles();

  subscribeRealtime();
  subscribePresence(session.user.id);
}

async function loadProfiles() {
  const { data } = await sb.from("profiles").select("*");
  profiles = {};
  (data || []).forEach(p => { profiles[p.id] = p; });
  renderTeam();
}

function renderTeam() {
  $("#teamList").innerHTML = Object.values(profiles).map(p => `
    <div class="member">
      <span class="ava" style="background:${esc(p.color)}">${esc(initials(p))}
        <span class="dot ${online.has(p.id) ? "on" : ""}"></span>
      </span>
      ${esc(p.full_name)}
    </div>`).join("") || `<div class="empty" style="padding:8px">No profiles yet.</div>`;
}

// ---------------- QUEUE ----------------
async function loadQueue() {
  const { data, error } = await sb.from("leads")
    .select("*")
    .in("status", [...CALLABLE, "Calling"])
    .order("callback_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) { toast(error.message); return; }

  const leads = data || [];
  // restore my in-progress call if I refreshed mid-call
  active = leads.find(l => l.status === "Calling" && l.claimed_by === me.id) || active;

  const term = $("#search").value.trim().toLowerCase();
  const list = leads.filter(l => l.status !== "Calling" || l.claimed_by !== me.id)
                    .filter(l => !term || `${l.business} ${l.phone} ${l.area} ${l.category}`.toLowerCase().includes(term));

  const callable = list.filter(l => !l.claimed_by);
  $("#queueCount").textContent = callable.length;

  $("#queueList").innerHTML = list.length ? list.map(l => {
    const overdue = l.callback_at && new Date(l.callback_at) <= new Date();
    const right = l.claimed_by
      ? `<span class="locked">🔒 ${esc(initials(profiles[l.claimed_by]) )} calling</span>`
      : `<span class="${stClass(l.status)}">${esc(l.status)}</span><button class="claim" data-id="${l.id}">Claim</button><button class="del" data-del="${l.id}" title="Delete lead">🗑</button>`;
    return `<div class="lead">
      <div>
        <div class="nm">${esc(l.business)}</div>
        <div class="meta">${esc(l.category || "")}${l.area ? " · " + esc(l.area) : ""}${overdue ? ' · <b style="color:var(--amber)">callback due</b>' : ""}</div>
      </div>
      <div class="right">${right}</div>
    </div>`;
  }).join("") : `<div class="empty">No leads to call. Import a CSV or add a lead.</div>`;

  $$("#queueList .claim").forEach(b => b.addEventListener("click", () => claim(b.dataset.id)));
  $$("#queueList .del").forEach(b => b.addEventListener("click", () => deleteLead(b.dataset.del)));
  renderCall();
}

async function claim(id) {
  if (active) { toast("Finish your current call first."); return; }
  // atomic: only succeeds if still unclaimed
  const { data, error } = await sb.from("leads")
    .update({ claimed_by: me.id, claimed_at: new Date().toISOString(), status: "Calling" })
    .eq("id", id).is("claimed_by", null)
    .select();
  if (error) { toast(error.message); return; }
  if (!data || !data.length) { toast("That lead was just taken by someone else."); loadQueue(); return; }
  active = data[0];
  startTimer();
  renderCall();
  loadQueue();
}

function renderCall() {
  const c = $("#callCard");
  if (!active) {
    $("#callHeader").innerHTML = "Your active call";
    c.innerHTML = `<div class="noactive">No lead claimed. Pick one from the queue to start calling.</div>`;
    return;
  }
  $("#callHeader").innerHTML = `Your active call <span class="pill" style="margin-left:auto;color:var(--amber);background:var(--amber-bg)"><span class="blink" style="background:var(--amber)"></span> claimed by you</span>`;
  c.innerHTML = `
    <div class="call">
      <div class="biz">${esc(active.business)}</div>
      <div class="cat">${esc(active.category || "")}${active.area ? " · " + esc(active.area) : ""}</div>
      <div class="phone"><span style="font-size:18px">📱</span><span class="num">${esc(active.phone || "—")}</span><span class="timer" id="timer">00:00</span></div>
      ${active.notes ? `<div class="scriptbox"><b>Previous notes:</b> ${esc(active.notes)}</div>` : ""}
      <label class="fl">Call notes</label>
      <textarea id="callNote" placeholder="Spoke to owner, interested but wants to think about it…">${esc(active.notes || "")}</textarea>
      <label class="fl">Outcome</label>
      <div class="outcomes" id="ocBtns">
        ${OUTCOMES.map(o => `<button class="oc ${o.cls}" data-o="${esc(o.label)}">${o.label === "Signed up" ? "✓ " : ""}${o.label}</button>`).join("")}
      </div>
      <div class="cb-row" id="cbRow">
        <input type="datetime-local" class="dt" id="cbTime">
        <span>callback reminder — shows in everyone's queue when due</span>
      </div>
      <div class="savebar">
        <button class="btn ghost" id="releaseBtn">Release lead</button>
        <button class="btn ghost" id="delLeadBtn" style="color:var(--red);border-color:var(--red)">Delete lead</button>
      </div>
    </div>`;
  // wire outcome buttons
  $$("#ocBtns .oc").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.o === "Callback") { $("#cbRow").classList.add("show"); $("#cbTime").focus(); }
    else logOutcome(b.dataset.o);
  }));
  // callback confirm via Enter on datetime
  $("#cbTime").addEventListener("change", () => logOutcome("Callback"));
  $("#releaseBtn").addEventListener("click", releaseLead);
  $("#delLeadBtn").addEventListener("click", () => deleteLead(active && active.id));
  restoreTimerDisplay();
}

async function logOutcome(outcome) {
  if (!active) return;
  const note = ($("#callNote")?.value || "").trim();
  const cb = outcome === "Callback" ? ($("#cbTime")?.value || null) : null;
  if (outcome === "Callback" && !cb) { toast("Pick a callback time."); return; }

  const { error: e1 } = await sb.from("call_log").insert({
    lead_id: active.id, caller_id: me.id, outcome, note,
  });
  if (e1) { toast(e1.message); return; }

  const { error: e2 } = await sb.from("leads").update({
    status: outcome,
    claimed_by: null, claimed_at: null,
    last_called_at: new Date().toISOString(),
    callback_at: cb ? new Date(cb).toISOString() : null,
    notes: note || active.notes || null,
  }).eq("id", active.id);
  if (e2) { toast(e2.message); return; }

  toast(`Logged: ${outcome}`);
  active = null; stopTimer();
  await loadQueue(); await loadDashboard();
}

async function releaseLead() {
  if (!active) return;
  await sb.from("leads").update({ claimed_by: null, claimed_at: null, status: active.status === "Calling" ? "New" : active.status })
    .eq("id", active.id);
  active = null; stopTimer();
  loadQueue();
}

async function deleteLead(id) {
  if (!id) return;
  if (!confirm("Delete this lead permanently? This also removes its call history.")) return;
  const { error } = await sb.from("leads").delete().eq("id", id);
  if (error) { toast(error.message); return; }
  if (active && active.id === id) { active = null; stopTimer(); }
  toast("Lead deleted.");
  loadQueue();
}

// ---- timer ----
function startTimer() { timerSec = 0; clearInterval(timerInt); timerInt = setInterval(tick, 1000); }
function restoreTimerDisplay() { if (active && !timerInt) { timerInt = setInterval(tick, 1000); } tick(); }
function stopTimer() { clearInterval(timerInt); timerInt = null; timerSec = 0; }
function tick() {
  timerSec++;
  const el = $("#timer"); if (!el) return;
  el.textContent = `${String(Math.floor(timerSec / 60)).padStart(2,"0")}:${String(timerSec % 60).padStart(2,"0")}`;
}

// ---------------- DASHBOARD ----------------
async function loadDashboard() {
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const iso = startOfDay.toISOString();

  const { data: todays } = await sb.from("call_log").select("outcome,caller_id").gte("created_at", iso);
  const calls = todays || [];
  const signups = calls.filter(c => c.outcome === "Signed up").length;

  const { count: callbacksDue } = await sb.from("leads").select("*", { count: "exact", head: true })
    .eq("status", "Callback").lte("callback_at", new Date().toISOString());
  const { count: remaining } = await sb.from("leads").select("*", { count: "exact", head: true })
    .in("status", CALLABLE).is("claimed_by", null);

  const conv = calls.length ? Math.round((signups / calls.length) * 1000) / 10 : 0;
  $("#statCards").innerHTML = `
    ${card("Calls today", calls.length, "")}
    ${card("Sign-ups today", signups, conv + "% conversion")}
    ${card("Callbacks due", callbacksDue ?? 0, "", "var(--amber)")}
    ${card("Leads remaining", remaining ?? 0, "", "var(--muted)")}`;

  // leaderboard (sign-ups by caller)
  const byCaller = {};
  calls.filter(c => c.outcome === "Signed up").forEach(c => byCaller[c.caller_id] = (byCaller[c.caller_id]||0)+1);
  const lbRows = Object.entries(byCaller).sort((a,b)=>b[1]-a[1]);
  const max = Math.max(1, ...lbRows.map(r=>r[1]));
  $("#leaderboard").innerHTML = lbRows.length ? lbRows.map(([id,n]) =>
    `<div class="lb"><span class="n">${esc(profiles[id]?.full_name || "?")}</span><span class="bar"><i style="width:${n/max*100}%"></i></span><span class="v">${n}</span></div>`
  ).join("") : `<div class="empty">No sign-ups yet today.</div>`;

  // outcome breakdown
  const byOut = {};
  calls.forEach(c => byOut[c.outcome] = (byOut[c.outcome]||0)+1);
  const outRows = Object.entries(byOut).sort((a,b)=>b[1]-a[1]);
  const omax = Math.max(1, ...outRows.map(r=>r[1]));
  $("#outcomes").innerHTML = outRows.length ? outRows.map(([o,n]) =>
    `<div class="lb"><span class="n">${esc(o)}</span><span class="bar"><i style="width:${n/omax*100}%"></i></span><span class="v">${n}</span></div>`
  ).join("") : `<div class="empty">No calls logged yet today.</div>`;

  // targets panel (day / week / month) is rendered separately
  await renderTargets();
}

// ---- targets, per caller, for the selected period ----
async function renderTargets() {
  const now = new Date();
  let start, mult, label;
  if (targetPeriod === "week") {
    start = new Date(now);
    const dow = (start.getDay() + 6) % 7;        // Monday = 0
    start.setDate(start.getDate() - dow); start.setHours(0,0,0,0);
    mult = WORKING_DAYS_PER_WEEK; label = "this week";
  } else if (targetPeriod === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    mult = WORKING_DAYS_PER_MONTH; label = "this month";
  } else {
    start = new Date(now); start.setHours(0,0,0,0);
    mult = 1; label = "today";
  }

  const { data } = await sb.from("call_log").select("outcome,caller_id").gte("created_at", start.toISOString());
  const rows = data || [];
  const callsBy = {}, signBy = {};
  rows.forEach(c => {
    callsBy[c.caller_id] = (callsBy[c.caller_id] || 0) + 1;
    if (c.outcome === "Signed up") signBy[c.caller_id] = (signBy[c.caller_id] || 0) + 1;
  });

  const callTgt = DAILY_CALL_TARGET * mult, signTgt = DAILY_SIGNUP_TARGET * mult;
  const callers = Object.values(profiles);
  $("#targetPill").textContent = `team ${rows.length}/${callers.length * callTgt} calls ${label}`;
  const bar = (n, t) => { const pct = Math.min(100, Math.round(n / t * 100)); const hit = n >= t ? "hit" : ""; return `<span class="bar"><i class="${hit}" style="width:${pct}%"></i></span><span class="num">${n}/${t}${n>=t?" ✓":""}</span>`; };
  $("#targets").innerHTML = callers.length ? callers.map(p => {
    const c = callsBy[p.id] || 0, s = signBy[p.id] || 0;
    return `<div class="tg ${p.id===me.id?"mine":""}">
      <span class="who"><span class="ava" style="background:${esc(p.color)};width:24px;height:24px;font-size:10px">${esc(initials(p))}</span>${esc(p.full_name)}</span>
      <span class="grp"><span class="lbl">Calls</span>${bar(c, callTgt)}</span>
      <span class="grp"><span class="lbl">Sign-ups</span>${bar(s, signTgt)}</span>
    </div>`;
  }).join("") : `<div class="empty">No callers yet.</div>`;
}

// ---------------- EXPORT RESULTS ----------------
$("#exportBtn").addEventListener("click", async () => {
  const { data, error } = await sb.from("leads")
    .select("business,phone,category,area,status,last_called_at,callback_at,notes")
    .order("status", { ascending: true });
  if (error) { toast(error.message); return; }
  const cols = ["business","phone","category","area","status","last_called_at","callback_at","notes"];
  const q = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; };
  const csv = [cols.join(",")].concat((data||[]).map(r => cols.map(c => q(r[c])).join(","))).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `noapro-results-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${(data||[]).length} leads.`);
});

// ---------------- EXPORT CALL LOG ----------------
// Every dial: when, who, which business, outcome, note.
$("#exportLogBtn").addEventListener("click", async () => {
  const { data, error } = await sb.from("call_log")
    .select("created_at,outcome,note,caller_id,leads(business,phone,area)")
    .order("created_at", { ascending: false });
  if (error) { toast(error.message); return; }
  const q = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; };
  const head = ["timestamp","caller","business","phone","area","outcome","note"];
  const lines = (data || []).map(r => [
    new Date(r.created_at).toISOString(),
    profiles[r.caller_id]?.full_name || "",
    r.leads?.business || "",
    r.leads?.phone || "",
    r.leads?.area || "",
    r.outcome,
    r.note || "",
  ].map(q).join(","));
  const csv = [head.join(",")].concat(lines).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `noapro-call-log-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${(data||[]).length} call-log rows.`);
});

// ---------------- TARGETS PERIOD TOGGLE ----------------
$("#tgSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  targetPeriod = b.dataset.period;
  [...$("#tgSeg").children].forEach(x => x.classList.toggle("active", x === b));
  renderTargets();
});
function card(k, v, d, color) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${d?`<div class="d" style="color:${color||"var(--ok)"}">${esc(d)}</div>`:""}</div>`;
}

// ---------------- FILES ----------------
async function loadFiles() {
  const { data, error } = await sb.storage.from("files").list("", { sortBy: { column: "created_at", order: "desc" } });
  if (error) { $("#fileList").innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  const files = (data || []).filter(f => f.id);
  $("#fileList").innerHTML = files.length ? files.map(f => {
    const ext = (f.name.split(".").pop() || "").toUpperCase().slice(0,4);
    return `<div class="file" data-name="${esc(f.name)}"><span class="fic">${esc(ext)}</span><div><div class="nm">${esc(f.name)}</div><div class="mt">${new Date(f.created_at).toLocaleDateString()}</div></div><button class="fdel" data-fdel="${esc(f.name)}" title="Delete file">🗑</button></div>`;
  }).join("") : `<div class="empty">No files yet. Upload a script or lead list.</div>`;
  $$("#fileList .file").forEach(el => el.addEventListener("click", () => downloadFile(el.dataset.name)));
  $$("#fileList .fdel").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); deleteFile(b.dataset.fdel); }));
}

async function deleteFile(name) {
  if (!confirm(`Delete "${name}" permanently?`)) return;
  const { error } = await sb.storage.from("files").remove([name]);
  if (error) { toast(error.message); return; }
  toast("File deleted.");
  loadFiles();
}

async function downloadFile(name) {
  const { data, error } = await sb.storage.from("files").createSignedUrl(name, 60);
  if (error) { toast(error.message); return; }
  window.open(data.signedUrl, "_blank");
}

$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const { error } = await sb.storage.from("files").upload(file.name, file, { upsert: true });
  if (error) { toast(error.message); return; }
  toast("Uploaded " + file.name); loadFiles();
});

// ---------------- CSV IMPORT ----------------
$("#csvInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) { toast("No rows found in CSV."); return; }
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (names) => head.findIndex(h => names.includes(h));
  const iB = col(["business","name","company","business name"]);
  const iP = col(["phone","telephone","tel","number","phone number"]);
  const iC = col(["category","trade","type"]);
  const iA = col(["area","town","location","city"]);
  if (iB < 0) { toast('CSV needs a "business" column.'); return; }

  const leads = rows.slice(1).filter(r => r[iB]?.trim()).map(r => ({
    business: r[iB].trim(),
    phone:    iP>=0 ? (r[iP]||"").trim() : null,
    category: iC>=0 ? (r[iC]||"").trim() : null,
    area:     iA>=0 ? (r[iA]||"").trim() : null,
    status: "New",
    source_file: file.name,
  }));
  const { error } = await sb.from("leads").insert(leads);
  if (error) { toast(error.message); return; }
  toast(`Imported ${leads.length} leads.`);
  // keep a copy of the file too
  await sb.storage.from("files").upload(file.name, file, { upsert: true });
  loadQueue(); loadFiles();
  e.target.value = "";
});

// minimal CSV parser (handles quoted fields & commas)
function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

// ---------------- ADD LEAD ----------------
$("#addLeadBtn").addEventListener("click", async () => {
  const business = prompt("Business name?"); if (!business) return;
  const phone = prompt("Phone number?") || null;
  const category = prompt("Category / trade?") || null;
  const area = prompt("Area / town?") || null;
  const { error } = await sb.from("leads").insert({ business, phone, category, area, status: "New" });
  if (error) { toast(error.message); return; }
  toast("Lead added."); loadQueue();
});

// ---------------- SEARCH ----------------
$("#search").addEventListener("input", () => loadQueue());

// ---------------- NAV ----------------
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $$(".page").forEach(p => p.classList.remove("show"));
  $("#" + b.dataset.p).classList.add("show");
  if (b.dataset.p === "dash") loadDashboard();
  if (b.dataset.p === "files") loadFiles();
});

// ---------------- REALTIME ----------------
let reloadTimer = null;
function subscribeRealtime() {
  sb.channel("leads-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { loadQueue(); if ($("#dash").classList.contains("show")) loadDashboard(); }, 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "call_log" }, () => {
      if ($("#dash").classList.contains("show")) loadDashboard();
    })
    .subscribe();
}

// presence: who's online right now
function subscribePresence(uid) {
  const ch = sb.channel("online", { config: { presence: { key: uid } } });
  ch.on("presence", { event: "sync" }, () => {
    online = new Set(Object.keys(ch.presenceState()));
    renderTeam();
  });
  ch.subscribe(async (status) => {
    if (status === "SUBSCRIBED") await ch.track({ at: Date.now() });
  });
}

// ---------------- START ----------------
sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") location.reload(); });
boot();
