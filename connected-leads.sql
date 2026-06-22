-- ============================================================
-- NoaPro Caller — "Connected leads" view
-- One row per lead that has at least one logged call (i.e. contacted).
-- Powers the Connected Leads tab: who's been reached, by whom, when.
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================
create or replace view public.contacted_leads
with (security_invoker = true) as
select
  l.id,
  l.business,
  l.phone,
  l.email,
  l.category,
  l.area,
  l.source_file,
  l.status,
  count(cl.*)::int                                          as attempts,
  max(cl.created_at)                                        as last_contact,
  (array_agg(cl.caller_id order by cl.created_at desc))[1]  as last_caller_id,
  (array_agg(cl.outcome   order by cl.created_at desc))[1]  as last_outcome
from public.leads l
join public.call_log cl on cl.lead_id = l.id
group by l.id;

grant select on public.contacted_leads to authenticated;
