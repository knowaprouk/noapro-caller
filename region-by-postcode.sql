-- ============================================================
-- NoaPro Caller — region by postcode
-- Rule: any postcode starting "LS" = Leeds, everything else = Kent.
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================
update public.leads
set region = case when area ilike 'LS%' then 'leeds' else 'kent' end;
