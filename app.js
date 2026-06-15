// ============================================================
// NoaPro Caller — application logic
// Static front end talking directly to Supabase (Postgres + Auth
// + Realtime + Storage). No backend server required.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
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

  await loadActive();
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
const RENDER_CAP = 150;   // max lead rows drawn at once (keeps the page snappy)

// Apply the active filters (area, category, search) to a Supabase query — runs
// server-side so filters reach ALL leads, not just the ones currently on screen.
function queueFilter(q) {
  q = q.in("status", [...CALLABLE, "Calling"]);
  const area = (($("#fArea") || {}).value || "").trim();
  const cat  = (($("#fCat")  || {}).value || "").trim();
  const term = (($("#search")|| {}).value || "").trim().replace(/[,()%*]/g, " ").trim();
  if (area) q = q.ilike("area", `%${area}%`);
  if (cat)  q = q.ilike("category", `%${cat}%`);
  if (term) q = q.or(`business.ilike.%${term}%,phone.ilike.%${term}%`);
  return q;
}

// Restore my in-progress call from the DB (e.g. after a refresh mid-call).
async function loadActive() {
  const { data } = await sb.from("leads").select("*").eq("claimed_by", me.id).eq("status", "Calling").limit(1);
  active = (data && data[0]) || null;
}

function leadRow(l) {
  const overdue = l.callback_at && new Date(l.callback_at) <= new Date();
  const right = l.claimed_by
    ? `<span class="locked">🔒 ${esc(initials(profiles[l.claimed_by]))} calling</span>`
    : `<span class="${stClass(l.status)}">${esc(l.status)}</span><button class="claim" data-id="${l.id}">Claim</button><button class="del" data-del="${l.id}" title="Delete lead">🗑</button>`;
  return `<div class="lead">
      <div>
        <div class="nm">${esc(l.business)}</div>
        <div class="meta">${esc(l.category || "")}${l.area ? " · " + esc(l.area) : ""}${overdue ? ' · <b style="color:var(--amber)">callback due</b>' : ""}</div>
      </div>
      <div class="right">${right}</div>
    </div>`;
}

async function loadQueue() {
  const { count } = await queueFilter(sb.from("leads").select("*", { count: "exact", head: true }));
  const { data, error } = await queueFilter(sb.from("leads").select("*"))
    .order("callback_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(RENDER_CAP);
  if (error) { toast(error.message); return; }

  const list = (data || []).filter(l => !(l.status === "Calling" && l.claimed_by === me.id));
  const total = count || 0;
  $("#queueCount").textContent = total;

  let html = list.length
    ? list.map(leadRow).join("")
    : `<div class="empty">No leads match these filters. Clear them, or import a list.</div>`;
  if (total > list.length)
    html += `<div class="empty">Showing ${list.length} of ${total}. Work through these — or use the Area / Category filters to narrow down.</div>`;
  $("#queueList").innerHTML = html;

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
    ${card("Calls today", calls.length, "", "", "calls-today")}
    ${card("Sign-ups today", signups, conv + "% conversion", "", "signups-today")}
    ${card("Callbacks due", callbacksDue ?? 0, "", "var(--amber)", "callbacks-due")}
    ${card("Leads remaining", remaining ?? 0, "", "var(--muted)", "leads-remaining")}`;

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
function card(k, v, d, color, action) {
  return `<div class="stat${action ? " clickable" : ""}"${action ? ` data-action="${action}"` : ""}><div class="k">${esc(k)}${action ? ' <span class="go">→</span>' : ""}</div><div class="v">${esc(v)}</div>${d?`<div class="d" style="color:${color||"var(--ok)"}">${esc(d)}</div>`:""}</div>`;
}

function goTab(p) { const b = document.querySelector(`#nav button[data-p="${p}"]`); if (b) b.click(); }

// Drill-down: list of today's calls (or just sign-ups), each row opens that lead.
async function openCallsModal(signedOnly) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  let q = sb.from("call_log").select("created_at,outcome,note,caller_id,lead_id,leads(business)")
    .gte("created_at", start.toISOString()).order("created_at", { ascending: false });
  if (signedOnly) q = q.eq("outcome", "Signed up");
  const { data, error } = await q;
  if (error) { toast(error.message); return; }
  const rows = data || [];
  $("#lmTitle").textContent = signedOnly ? `Sign-ups today (${rows.length})` : `Calls today (${rows.length})`;
  $("#lmBody").innerHTML = rows.length
    ? `<div class="hist" style="border-top:0;padding-top:0">` + rows.map(h =>
        `<div class="hevent" data-lead="${h.lead_id}" style="cursor:pointer"><div><div class="ho">${esc(h.leads?.business || "(lead)")}</div><div>${esc(h.outcome)}${h.note ? " · " + esc(h.note) : ""}</div></div><div class="ht" style="margin-left:auto">${esc(profiles[h.caller_id]?.full_name || "")} · ${new Date(h.created_at).toLocaleTimeString()}</div></div>`
      ).join("") + `</div>`
    : `<div class="empty">No calls logged today yet.</div>`;
  $("#leadModal").classList.remove("hidden");
  $$("#lmBody .hevent[data-lead]").forEach(el => el.addEventListener("click", () => { if (el.dataset.lead) openLeadDetail(el.dataset.lead); }));
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

// ---------------- ALL LEADS (full traceability) ----------------
let allSort = { col: "created_at", dir: "desc" };

function allFilter(q) {
  const term = (($("#aSearch") || {}).value || "").trim().replace(/[,()%*]/g, " ").trim();
  const st   = (($("#aStatus") || {}).value || "");
  const area = (($("#aArea")   || {}).value || "").trim();
  const cat  = (($("#aCat")    || {}).value || "").trim();
  if (st)   q = q.eq("status", st);
  if (area) q = q.ilike("area", `%${area}%`);
  if (cat)  q = q.ilike("category", `%${cat}%`);
  if (term) q = q.or(`business.ilike.%${term}%,phone.ilike.%${term}%`);
  return q;
}

async function loadAllLeads() {
  const { count } = await allFilter(sb.from("leads").select("*", { count: "exact", head: true }));
  const { data, error } = await allFilter(sb.from("leads").select("*"))
    .order(allSort.col, { ascending: allSort.dir === "asc", nullsFirst: false })
    .limit(200);
  if (error) { toast(error.message); return; }
  const rows = data || [], total = count || 0;
  $("#allCount").textContent = total > rows.length ? `${rows.length} of ${total}` : `${total} leads`;
  $("#allBody").innerHTML = rows.length ? rows.map(l => `
    <tr data-id="${l.id}">
      <td title="${esc(l.business)}">${esc(l.business)}</td>
      <td>${esc(l.category || "")}</td>
      <td>${esc(l.area || "")}</td>
      <td>${esc(l.phone || "")}</td>
      <td><span class="${stClass(l.status)}">${esc(l.status)}</span></td>
      <td>${l.last_called_at ? new Date(l.last_called_at).toLocaleDateString() : "—"}</td>
      <td>${l.callback_at ? new Date(l.callback_at).toLocaleString() : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">No leads match these filters.</td></tr>`;
  $$("#all .ltable th").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === allSort.col);
    th.classList.toggle("asc", th.dataset.sort === allSort.col && allSort.dir === "asc");
  });
  $$("#allBody tr[data-id]").forEach(tr => tr.addEventListener("click", () => openLeadDetail(tr.dataset.id)));
}

async function openLeadDetail(id) {
  const { data: la } = await sb.from("leads").select("*").eq("id", id).limit(1);
  const l = la && la[0]; if (!l) { toast("Lead not found."); return; }
  const { data: log } = await sb.from("call_log").select("*").eq("lead_id", id).order("created_at", { ascending: false });
  $("#lmTitle").textContent = l.business;
  $("#lmBody").innerHTML = `
    <div class="kv">
      <span class="k">Status</span><span><span class="${stClass(l.status)}">${esc(l.status)}</span></span>
      <span class="k">Phone</span><span>${esc(l.phone || "—")}</span>
      <span class="k">Category</span><span>${esc(l.category || "—")}</span>
      <span class="k">Area</span><span>${esc(l.area || "—")}</span>
      <span class="k">Claimed by</span><span>${esc(l.claimed_by ? (profiles[l.claimed_by]?.full_name || "—") : "—")}</span>
      <span class="k">Last called</span><span>${l.last_called_at ? new Date(l.last_called_at).toLocaleString() : "—"}</span>
      <span class="k">Callback</span><span>${l.callback_at ? new Date(l.callback_at).toLocaleString() : "—"}</span>
      <span class="k">Source</span><span>${esc(l.source_file || "—")}</span>
    </div>
    <label class="fl">Notes</label>
    <textarea id="lmNotes">${esc(l.notes || "")}</textarea>
    <div class="modal-actions">
      <button class="btn pri" id="lmSave">Save notes</button>
      <button class="btn ghost" id="lmRequeue">↩ Return to queue</button>
      <button class="btn ghost" id="lmDelete" style="color:var(--red);border-color:var(--red)">Delete</button>
    </div>
    <div class="hist">
      <h4>Call history (${(log || []).length})</h4>
      ${(log && log.length) ? log.map(h => `<div class="hevent"><div><div class="ho">${esc(h.outcome)}</div>${h.note ? `<div>${esc(h.note)}</div>` : ""}</div><div class="ht" style="margin-left:auto">${esc(profiles[h.caller_id]?.full_name || "")} · ${new Date(h.created_at).toLocaleString()}</div></div>`).join("") : `<div class="empty">No calls logged yet.</div>`}
    </div>`;
  $("#leadModal").classList.remove("hidden");
  $("#lmSave").addEventListener("click", async () => {
    const { error } = await sb.from("leads").update({ notes: $("#lmNotes").value }).eq("id", id);
    if (error) { toast(error.message); return; } toast("Notes saved.");
  });
  $("#lmRequeue").addEventListener("click", async () => {
    const { error } = await sb.from("leads").update({ status: "New", claimed_by: null, claimed_at: null }).eq("id", id);
    if (error) { toast(error.message); return; } toast("Returned to queue."); closeModal(); loadAllLeads(); loadQueue();
  });
  $("#lmDelete").addEventListener("click", async () => {
    if (!confirm("Delete this lead permanently? This also removes its call history.")) return;
    const { error } = await sb.from("leads").delete().eq("id", id);
    if (error) { toast(error.message); return; }
    if (active && active.id === id) { active = null; stopTimer(); }
    toast("Lead deleted."); closeModal(); loadAllLeads(); loadQueue();
  });
}
function closeModal() { $("#leadModal").classList.add("hidden"); $("#lmBody").innerHTML = ""; }

// ---------------- TEAM CHAT ----------------
async function loadMessages() {
  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: true }).limit(300);
  if (error) {
    $("#chatLog").innerHTML = `<div class="empty">Chat isn't set up yet — run <b>messages-table.sql</b> in Supabase, then reload this page.</div>`;
    return;
  }
  $("#chatLog").innerHTML = (data && data.length) ? "" : `<div class="empty">No messages yet — say hello 👋</div>`;
  (data || []).forEach(appendMessage);
  scrollChat();
}
function appendMessage(m) {
  const log = $("#chatLog"); if (!log) return;
  const ph = log.querySelector(".empty"); if (ph) ph.remove();
  if (log.querySelector(`[data-mid="${m.id}"]`)) return;
  const div = document.createElement("div");
  div.className = "msg" + (m.author_id === me.id ? " mine" : "");
  div.dataset.mid = m.id;
  div.innerHTML = `<div class="who">${esc(profiles[m.author_id]?.full_name || "Someone")}</div><div class="bub">${esc(m.body)}</div><div class="ht">${new Date(m.created_at).toLocaleString()}</div>`;
  log.appendChild(div);
  scrollChat();
}
function scrollChat() { const l = $("#chatLog"); if (l) l.scrollTop = l.scrollHeight; }
async function sendMessage() {
  const inp = $("#chatInput"); const body = inp.value.trim(); if (!body) return;
  inp.value = "";
  const { error } = await sb.from("messages").insert({ author_id: me.id, body });
  if (error) { toast(error.message); inp.value = body; }
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

// ---------------- LEAD IMPORT (Excel .xlsx/.xls or CSV) ----------------
// Turns a table (array-of-rows) into lead objects. Finds the header row
// even if it's not first, and maps columns flexibly across naming styles.
function leadsFromTable(aoa, sourceFile) {
  const BSET = ["business","name","company","business name","trade name","company name"];
  let hi = -1, head = null;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const r = (aoa[i] || []).map(c => String(c == null ? "" : c).trim().toLowerCase());
    if (r.some(h => BSET.includes(h))) { hi = i; head = r; break; }
  }
  if (hi < 0) return [];                       // not a lead sheet (e.g. a dashboard)
  const colsFor = names => head.map((h, idx) => names.includes(h) ? idx : -1).filter(i => i >= 0);
  const bCols = colsFor(BSET);
  const pCols = colsFor(["phone","telephone","tel","number","phone number","mobile","contact number","tel no","phone no"]);
  const cCols = colsFor(["category","trade","type","trade category","sector","industry"]);
  const aCols = colsFor(["area","town","location","city","region","postcode","post code","county"]);
  const pick = (r, cols) => { for (const c of cols) { const v = String(r[c] == null ? "" : r[c]).trim(); if (v) return v; } return null; };
  const out = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const business = pick(r, bCols);
    if (!business) continue;
    out.push({ business, phone: pick(r, pCols), category: pick(r, cCols), area: pick(r, aCols), status: "New", source_file: sourceFile });
  }
  return out;
}

async function importLeadFile(file) {
  let leads = [];
  const lname = file.name.toLowerCase();
  try {
    if (lname.endsWith(".csv")) {
      leads = leadsFromTable(parseCSV(await file.text()), file.name);
    } else {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      for (const sn of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: "" });
        leads = leads.concat(leadsFromTable(aoa, `${file.name} — ${sn}`));
      }
    }
  } catch (err) { toast("Couldn't read file: " + err.message); return; }

  // de-duplicate within this file (business + phone)
  const seen = new Set();
  leads = leads.filter(l => { const k = (l.business + "|" + (l.phone || "")).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!leads.length) { toast('No leads found — the file needs a "business" column.'); return; }

  // insert in chunks so large lists don't time out
  let n = 0;
  for (let i = 0; i < leads.length; i += 500) {
    const { error } = await sb.from("leads").insert(leads.slice(i, i + 500));
    if (error) { toast(`Imported ${n}; then stopped: ${error.message}`); loadQueue(); return; }
    n += Math.min(500, leads.length - i);
    toast(`Importing… ${n}/${leads.length}`);
  }
  toast(`Imported ${n} leads.`);
  try { await sb.storage.from("files").upload(file.name, file, { upsert: true }); } catch (_) {}
  loadQueue(); loadFiles();
}

$("#csvInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  toast("Reading " + file.name + "…");
  await importLeadFile(file);
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

// ---------------- SEARCH & FILTERS ----------------
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const reloadQueue = debounce(loadQueue, 300);
["#search", "#fArea", "#fCat"].forEach(sel => { const el = $(sel); if (el) el.addEventListener("input", reloadQueue); });
$("#fClear") && $("#fClear").addEventListener("click", () => {
  if ($("#fArea")) $("#fArea").value = "";
  if ($("#fCat")) $("#fCat").value = "";
  if ($("#search")) $("#search").value = "";
  loadQueue();
});

// All Leads: sortable headers + filters
$$("#all .ltable th").forEach(th => th.addEventListener("click", () => {
  const c = th.dataset.sort;
  if (allSort.col === c) allSort.dir = allSort.dir === "asc" ? "desc" : "asc";
  else allSort = { col: c, dir: "asc" };
  loadAllLeads();
}));
const reloadAll = debounce(loadAllLeads, 300);
["#aSearch", "#aArea", "#aCat"].forEach(s => { const e = $(s); if (e) e.addEventListener("input", reloadAll); });
$("#aStatus") && $("#aStatus").addEventListener("change", loadAllLeads);
$("#aClear") && $("#aClear").addEventListener("click", () => {
  ["#aSearch", "#aArea", "#aCat"].forEach(s => { if ($(s)) $(s).value = ""; });
  if ($("#aStatus")) $("#aStatus").value = "";
  loadAllLeads();
});

// Lead detail modal close
$("#lmClose") && $("#lmClose").addEventListener("click", closeModal);
$("#leadModal") && $("#leadModal").addEventListener("click", (e) => { if (e.target.id === "leadModal") closeModal(); });

// Team chat send
$("#chatSend") && $("#chatSend").addEventListener("click", sendMessage);
$("#chatInput") && $("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendMessage(); } });

// Dashboard stat cards → drill into the detail
$("#statCards") && $("#statCards").addEventListener("click", (e) => {
  const c = e.target.closest(".stat[data-action]"); if (!c) return;
  const a = c.dataset.action;
  if (a === "calls-today") openCallsModal(false);
  else if (a === "signups-today") openCallsModal(true);
  else if (a === "callbacks-due") { if ($("#aStatus")) $("#aStatus").value = "Callback"; goTab("all"); }
  else if (a === "leads-remaining") { goTab("queue"); }
});

// ---------------- NAV ----------------
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $$(".page").forEach(p => p.classList.remove("show"));
  $("#" + b.dataset.p).classList.add("show");
  if (b.dataset.p === "dash") loadDashboard();
  if (b.dataset.p === "files") loadFiles();
  if (b.dataset.p === "all") loadAllLeads();
  if (b.dataset.p === "chat") loadMessages();
});

// ---------------- REALTIME ----------------
let reloadTimer = null;
function subscribeRealtime() {
  sb.channel("leads-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        loadQueue();
        if ($("#dash").classList.contains("show")) loadDashboard();
        if ($("#all").classList.contains("show")) loadAllLeads();
      }, 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "call_log" }, () => {
      if ($("#dash").classList.contains("show")) loadDashboard();
    })
    .subscribe();

  // live team chat
  sb.channel("messages-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
      appendMessage(payload.new);
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
