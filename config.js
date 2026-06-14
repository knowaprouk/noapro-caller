// ============================================================
// NoaPro Caller — configuration
// Fill these two values in from your Supabase project:
//   Supabase Dashboard → Project Settings → API
//   - Project URL        → SUPABASE_URL
//   - anon / public key  → SUPABASE_ANON_KEY
// The anon key is SAFE to commit/expose in the browser — your data
// is protected by Row-Level Security, not by hiding this key.
// ============================================================
export const SUPABASE_URL = "https://zxvxgxrduyliwrnwuive.supabase.co";
// Supabase's newer "publishable" key — safe to expose in the browser, same role as the anon key.
export const SUPABASE_ANON_KEY = "sb_publishable_6oYl13un1oWXsMhquQIRGw_3MY5Zd0E";

// Callback is considered "overdue" once its time has passed.
export const OVERDUE_GRACE_MIN = 0;

// ---- Daily targets (per caller, per day) ----
// Shown as progress bars on the Dashboard. Tune to your team.
export const DAILY_CALL_TARGET   = 60;  // dials logged per caller per day
export const DAILY_SIGNUP_TARGET = 5;   // sign-ups per caller per day

// Used to scale the daily target up for the Week / Month views.
export const WORKING_DAYS_PER_WEEK  = 5;
export const WORKING_DAYS_PER_MONTH = 21;
