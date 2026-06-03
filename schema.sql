-- Marathon Training Planner — Supabase schema
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)

-- Plans table (one row per training plan)
create table if not exists plans (
  id            uuid primary key default gen_random_uuid(),
  plan_name     text not null default 'My Marathon Plan',
  race_date     date not null,
  num_weeks     integer not null default 26 check (num_weeks between 8 and 52),
  vdot_paces    jsonb not null default '{"E":"10:00","M":"9:00","T":"8:30","I":"8:00","R":"7:30"}'::jsonb,
  created_at    timestamptz default now()
);

-- Weeks table (one row per week per plan)
create table if not exists weeks (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null references plans(id) on delete cascade,
  week_number       integer not null,  -- T-N: 26 = T-26, 1 = T-1 (race week)
  phase             text not null default 'Foundation'
                      check (phase in ('Foundation','Initial Quality','Transition Quality','Final Quality','Taper')),
  location          text not null default 'New York'
                      check (location in ('New York','San Francisco','Travel')),
  target_miles      decimal(6,2) default 0,
  q1_prescription   text default '',
  q2_prescription   text default '',
  unique(plan_id, week_number)
);

-- Days table (one row per day, 7 per week)
create table if not exists days (
  id                uuid primary key default gen_random_uuid(),
  week_id           uuid not null references weeks(id) on delete cascade,
  day_of_week       integer not null check (day_of_week between 0 and 6),  -- 0=Mon, 6=Sun
  easy_miles        decimal(5,2) not null default 0,
  marathon_miles    decimal(5,2) not null default 0,
  threshold_miles   decimal(5,2) not null default 0,
  interval_miles    decimal(5,2) not null default 0,
  repetition_miles  decimal(5,2) not null default 0,
  tags              jsonb not null default '[]'::jsonb,
  unique(week_id, day_of_week)
);

-- Indexes for common query patterns
create index if not exists weeks_plan_id_idx on weeks(plan_id);
create index if not exists weeks_plan_week_idx on weeks(plan_id, week_number);
create index if not exists days_week_id_idx on days(week_id);

-- Enable Row Level Security (open policy for personal use — tighten if adding auth later)
alter table plans enable row level security;
alter table weeks enable row level security;
alter table days enable row level security;

create policy "Allow all for anon" on plans for all using (true) with check (true);
create policy "Allow all for anon" on weeks for all using (true) with check (true);
create policy "Allow all for anon" on days for all using (true) with check (true);
