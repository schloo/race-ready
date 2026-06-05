// ── Config ──
const SUPABASE_URL  = 'https://kmzbdoxfhrksimfgxhdb.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImttemJkb3hmaHJrc2ltZmd4aGRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MDI4MTgsImV4cCI6MjA5NjA3ODgxOH0.VodAh9hX35OT69GGPvn0aATC2gl2cu5mzDMjqbzh9LM';

// ── In-memory state ──
let plan  = null;   // { id, plan_name, race_date, num_weeks, vdot_paces }
let weeks = [];     // sorted descending by week_number (T-26 first)
let days  = {};     // { [week_id]: Day[7] } sorted by day_of_week

// Which week is expanded on desktop (week_number), null = none
let openWeekNumbers = new Set(); // multiple weeks can be open simultaneously

// Which week is shown on mobile (index into weeks array)
let mobileWeekIndex = 0;

// ────────────────────────────────────────────────
// Date helpers
// ────────────────────────────────────────────────

function parseDate(str) {
  // "YYYY-MM-DD" → local Date at midnight
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtDate(date, opts = {month:'short', day:'numeric'}) {
  return date.toLocaleDateString('en-US', opts);
}

function fmtDateShort(date) {
  return date.toLocaleDateString('en-US', {month:'short', day:'numeric'});
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

// Week start = race_date − week_number * 7 (always a Monday)
function weekStartDate(raceDate, weekNumber) {
  return addDays(parseDate(raceDate), -weekNumber * 7);
}

function weekDateRange(raceDate, weekNumber) {
  const start = weekStartDate(raceDate, weekNumber);
  const end   = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${fmtDate(start)} – ${end.getDate()}`;
  }
  return `${fmtDateShort(start)} – ${fmtDateShort(end)}`;
}

function isToday(date) {
  const t = new Date();
  return date.getFullYear() === t.getFullYear() &&
         date.getMonth()    === t.getMonth()    &&
         date.getDate()     === t.getDate();
}

// ────────────────────────────────────────────────
// Derived calculations
// ────────────────────────────────────────────────

const DAY_NAMES  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const PACE_KEYS  = ['easy','marathon','threshold','interval','repetition'];
const PACE_LABELS= ['Easy','Marathon','Threshold','Interval','Repetition'];
const PACE_CODES = ['E','M','T','I','R'];
const PACE_COLORS= ['#f0d840','#f0aa40','#f09070','#ee6060','#c090d8'];

const PHASE_DESCS = {
  'Foundation':        'Build aerobic base. Easy mileage, strides, light strength work.',
  'Initial Quality':   'Introduce quality workouts. T and I paces, volume building.',
  'Transition Quality':'Bridge base to race-specific work. Mix of T, M, and I.',
  'Final Quality':     'Race-specific sharpening. M pace emphasis, longer tempos.',
  'Taper':             'Reduce volume, maintain intensity. Freshen legs for race day.',
};

function dayTotal(day) {
  if (!day) return 0;
  return (day.easy_miles||0) + (day.marathon_miles||0) +
         (day.threshold_miles||0) + (day.interval_miles||0) +
         (day.repetition_miles||0);
}

function weekTotal(weekId) {
  const ds = days[weekId] || [];
  return ds.reduce((s, d) => s + dayTotal(d), 0);
}

// Build a flat date-keyed map of daily totals across all weeks for ACR
function buildDailyTotalsMap() {
  const map = {}; // "YYYY-MM-DD" → miles
  for (const wk of weeks) {
    const wStart = weekStartDate(plan.race_date, wk.week_number);
    const ds = days[wk.id] || [];
    for (const day of ds) {
      const date = addDays(wStart, day.day_of_week);
      map[isoDate(date)] = (map[isoDate(date)] || 0) + dayTotal(day);
    }
  }
  return map;
}

function computeChronicLoad(dateStr, dailyMap) {
  // 28-day trailing average weekly mileage ÷ 4
  const target = parseDate(dateStr);
  let chronic = 0;
  for (let i = 1; i <= 28; i++) {
    chronic += dailyMap[isoDate(addDays(target, -i))] || 0;
  }
  return chronic / 4; // average weekly miles
}

function computeRolling6(dateStr, dailyMap) {
  // Sum of 6 days preceding this day (not including today)
  const target = parseDate(dateStr);
  let sum = 0;
  for (let i = 1; i <= 6; i++) {
    sum += dailyMap[isoDate(addDays(target, -i))] || 0;
  }
  return sum;
}

function computeLoadMax(dateStr, dailyMap) {
  const chronic   = computeChronicLoad(dateStr, dailyMap);
  const rolling6  = computeRolling6(dateStr, dailyMap);
  return Math.max(0, (1.30 * chronic) - rolling6);
}

function computeLoadMin(dateStr, dailyMap) {
  const chronic   = computeChronicLoad(dateStr, dailyMap);
  const rolling6  = computeRolling6(dateStr, dailyMap);
  return Math.max(0, (0.80 * chronic) - rolling6);
}

// Keep computeACR for mobile display
function computeACR(dateStr, dailyMap) {
  const chronic = computeChronicLoad(dateStr, dailyMap);
  if (chronic === 0) return null;
  const target = parseDate(dateStr);
  let acute = 0;
  for (let i = 0; i < 7; i++) {
    acute += dailyMap[isoDate(addDays(target, -i))] || 0;
  }
  return (acute / chronic) * 100;
}

function acrClass(acr) {
  if (acr === null) return 'dim';
  if (acr < 50)  return 'purple';
  if (acr < 80)  return 'blue';
  if (acr < 130) return 'green';
  if (acr < 150) return 'orange';
  return 'red';
}

// WoW color
function wowClass(pct) {
  if (pct === null || pct === undefined) return 'neutral';
  if (pct > 20)  return 'red';
  if (pct > 10)  return 'orange';
  // decreases are not a problem — no alert color
  return 'neutral';
}

function wowLabel(pct, suffix='') {
  if (pct === null || pct === undefined) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${Math.round(pct)}%${suffix}`;
}

function vsTargetClass(diff) {
  if (diff === null) return 'neutral';
  return 'neutral';
}

function roundMi(n) {
  return Math.round(n * 10) / 10;
}

// ────────────────────────────────────────────────
// Pace chips
// ────────────────────────────────────────────────

function updatePaceChips() {
  if (!plan) return;
  const paces = plan.vdot_paces || {};
  for (const code of PACE_CODES) {
    const val = paces[code] || '—';
    const el = document.getElementById(`chip-${code}`);
    if (el) el.textContent = `${code} ${val}`;
    const mel = document.getElementById(`m-chip-${code}`);
    if (mel) mel.textContent = `${code} ${val}`;
    const pe = document.getElementById(`pe-${code}`);
    if (pe) pe.value = val;
    const mpe = document.getElementById(`m-pe-${code}`);
    if (mpe) mpe.value = val;
    // Goal pace inputs
    const gpe = document.getElementById(`pe-${code}-goal`);
    if (gpe) gpe.value = paces[`${code}_goal`] || '';
  }
}

// ────────────────────────────────────────────────
// Plan subtitle
// ────────────────────────────────────────────────

function updateSubtitle() {
  if (!plan) return;
  document.getElementById('plan-title-display').textContent = plan.plan_name;
  const raceDate = parseDate(plan.race_date);
  const today = new Date();
  const msPerDay = 86400000;
  const daysOut = Math.round((raceDate - today) / msPerDay);
  const weeksOut = Math.round(daysOut / 7);
  const raceStr = fmtDate(raceDate, {month:'short', day:'numeric', year:'numeric'});
  const sub = weeksOut > 0 ? `${raceStr} · ${weeksOut} weeks out`
            : weeksOut === 0 ? `${raceStr} · Race week!`
            : `${raceStr} · ${Math.abs(weeksOut)} weeks ago`;
  document.getElementById('plan-subtitle-text').textContent = sub;
}

// ────────────────────────────────────────────────
// Desktop rendering
// ────────────────────────────────────────────────

function renderDesktop() {
  const container = document.getElementById('main');
  container.innerHTML = '';

  // Callout banner
  const callout = document.createElement('div');
  callout.className = 'callout-box';
  callout.innerHTML = `The <b>Daniels 2Q</b> marathon training methodology is meant for busy runners: It prescribes two Quality workouts per week (Q1 + Q2) with easy miles filling the remaining volume — no junk miles. This planner helps you map out each week and tracks <b>total mileage</b>, <b>long run</b>, <b>ramp rate</b>, and <b>acute:chronic workload ratio</b> to flag whether your training load is appropriate or trending toward injury risk.`;
  container.appendChild(callout);

  // Toggle-all row
  const allOpen = weeks.every(w => openWeekNumbers.has(w.week_number));
  const toggleAll = document.createElement('div');
  toggleAll.className = 'toggle-all-row';
  toggleAll.innerHTML = `<span class="toggle-all-btn">${allOpen ? '− Collapse all' : '+ Expand all'}</span>`;
  toggleAll.querySelector('.toggle-all-btn').addEventListener('click', () => {
    if (allOpen) openWeekNumbers.clear();
    else weeks.forEach(w => openWeekNumbers.add(w.week_number));
    renderDesktop();
  });
  container.appendChild(toggleAll);

  const dailyMap = buildDailyTotalsMap();

  for (const wk of weeks) {
    if (openWeekNumbers.has(wk.week_number)) {
      container.appendChild(buildOpenWeekBlock(wk, dailyMap));
    } else {
      container.appendChild(buildCollapsedRow(wk, dailyMap));
    }
  }
}

function buildCollapsedRow(wk, dailyMap) {
  const row = document.createElement('div');
  const wStart = weekStartDate(plan.race_date, wk.week_number);
  const today = new Date();
  const isPast = addDays(wStart, 6) < today;

  row.className = 'week-row' + (isPast ? ' past' : '');

  const wDays = days[wk.id] || [];
  const totalMi = roundMi(weekTotal(wk.id));
  const miStr = totalMi > 0 ? `${totalMi} mi planned` : (wk.target_miles > 0 ? `${wk.target_miles} mi target` : '—');

  // WoW mileage + long run vs prior week
  const prevWk = weeks.find(w => w.week_number === wk.week_number + 1);
  let wowMiTag = '', wowLrTag = '';
  if (prevWk) {
    const prevDays = days[prevWk.id] || [];
    const prevTotal = prevDays.reduce((s, d) => s + dayTotal(d), 0);
    const thisLong  = Math.max(0, ...wDays.map(d => dayTotal(d)));
    const prevLong  = Math.max(0, ...prevDays.map(d => dayTotal(d)));
    if (prevTotal > 0) {
      const pct = Math.round(((totalMi - prevTotal) / prevTotal) * 100);
      const sign = pct >= 0 ? '+' : '';
      const cls  = wowClass(pct);
      wowMiTag = `<span class="wr-wow ${cls}">${sign}${pct}% weekly mi</span>`;
    }
    if (prevLong > 0) {
      const pct = Math.round(((thisLong - prevLong) / prevLong) * 100);
      const sign = pct >= 0 ? '+' : '';
      const cls  = wowClass(pct);
      wowLrTag = `<span class="wr-wow ${cls}">${sign}${pct}% LR</span>`;
    }
  }

  const locAbbrev = {'New York':'NYC','San Francisco':'SF','Travel':'Travel'}[wk.location] || wk.location;
  row.innerHTML = `
    <i class="ti ti-chevron-right wr-chev"></i>
    <span class="wr-num week-title">Week T-${wk.week_number}</span>
    <span class="wr-dates">${weekDateRange(plan.race_date, wk.week_number)}</span>
    <span class="wr-phase">${wk.phase} <span style="color:var(--text-tertiary);font-weight:400">·</span> ${locAbbrev}</span>
    <span class="wr-mi">${miStr}</span>
    <span class="wr-wow-group">${wowMiTag}${wowLrTag}</span>
  `;

  row.addEventListener('click', () => {
    openWeekNumbers.add(wk.week_number);
    renderDesktop();
    setTimeout(() => {
      const el = document.querySelector(`.week-block[data-week-id="${wk.id}"]`);
      if (el) el.scrollIntoView({behavior:'smooth', block:'nearest'});
    }, 0);
  });

  return row;
}

function weekTimeClass(wk) {
  const today  = new Date();
  const wStart = weekStartDate(plan.race_date, wk.week_number);
  const wEnd   = addDays(wStart, 6);
  if (wEnd < today)    return 'past';
  if (wStart > today)  return 'future';
  return 'current';
}

function buildOpenWeekBlock(wk, dailyMap) {
  const block = document.createElement('div');
  block.className = `week-block ${weekTimeClass(wk)}`;
  block.dataset.weekId = wk.id;

  const wStart = weekStartDate(plan.race_date, wk.week_number);
  const wDays  = days[wk.id] || [];


  // Header
  const hdr = document.createElement('div');
  hdr.className = 'wbh';
  const PHASES = ['Foundation','Initial Quality','Transition Quality','Final Quality','Taper'];
  hdr.innerHTML = `
    <i class="ti ti-chevron-down" style="font-size:11px;color:var(--text-tertiary);flex-shrink:0"></i>
    <span class="wbh-num week-title">Week T-${wk.week_number}</span>
    <span class="wbh-sep">·</span>
    <span class="wbh-dates">${weekDateRange(plan.race_date, wk.week_number)}</span>
    <select class="loc-select phase-select" data-week-id="${wk.id}" title="${escHtml(PHASE_DESCS[wk.phase]||'')}">
      ${PHASES.map(p => `<option value="${p}" ${wk.phase===p?'selected':''}>${p}</option>`).join('')}
    </select>
    <select class="loc-select" data-week-id="${wk.id}" title="Training location">
      <option value="New York"       ${wk.location==='New York'?'selected':''}>NYC</option>
      <option value="San Francisco"  ${wk.location==='San Francisco'?'selected':''}>SF</option>
      <option value="Travel"         ${wk.location==='Travel'?'selected':''}>✈ Travel</option>
    </select>
  `;
  hdr.querySelector('.ti-chevron-down').closest('.wbh').addEventListener('click', (e) => {
    if (e.target.tagName === 'SELECT') return;
    openWeekNumbers.delete(wk.week_number);
    renderDesktop();
  });
  hdr.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      if (sel.classList.contains('phase-select')) {
        wk.phase = e.target.value;
        sel.title = PHASE_DESCS[wk.phase] || '';
        renderDesktop(); // update collapsed rows too
      } else {
        wk.location = e.target.value;
      }
      saveWeekMeta(wk);
    });
  });
  block.appendChild(hdr);

  // Q row — 3 equal columns: Target | Q1 | Q2
  const qRow = document.createElement('div');
  qRow.className = 'q-row';

  const NAY_VAL = 'na';
  const q1Day = getQDay(wk.id, 'Q1');
  const q2Day = getQDay(wk.id, 'Q2');

  function daySelectHTML(q, currentDay) {
    const opts = [
      { label: '—',         val: ''        },
      { label: 'Monday',    val: '0'       },
      { label: 'Tuesday',   val: '1'       },
      { label: 'Wednesday', val: '2'       },
      { label: 'Thursday',  val: '3'       },
      { label: 'Friday',    val: '4'       },
      { label: 'Saturday',  val: '5'       },
      { label: 'Sunday',    val: '6'       },
      { label: 'N/A',       val: NAY_VAL   },
    ];
    return `<select class="q-day-select" data-week-id="${wk.id}" data-q="${q}">
      ${opts.map(({ label, val }) => {
        const sel = currentDay !== null && String(currentDay) === val ? 'selected'
                  : currentDay === null && val === '' ? 'selected' : '';
        return `<option value="${val}" ${sel}>${label}</option>`;
      }).join('')}
    </select>`;
  }

  qRow.innerHTML = `
    <div class="q-target-cell">
      <div class="q-target-hdr">Weekly Target</div>
      <div class="q-target-row">
        <input class="q-target-input" type="number" min="0" step="1"
          data-week-id="${wk.id}" value="${wk.target_miles > 0 ? wk.target_miles : ''}" placeholder="—">
        <span class="q-target-unit">miles</span>
      </div>
    </div>
    <div class="q-cell editable-cell">
      <div class="q-label-row"><span class="qlbl">Q1</span><span class="q-day-lbl">→</span>${daySelectHTML('Q1', q1Day)}</div>
      <textarea class="q-prescription" data-week-id="${wk.id}" data-field="q1_prescription"
        placeholder="Q1 workout prescription…">${escHtml(wk.q1_prescription||'')}</textarea>
    </div>
    <div class="q-cell editable-cell">
      <div class="q-label-row"><span class="qlbl">Q2</span><span class="q-day-lbl">→</span>${daySelectHTML('Q2', q2Day)}</div>
      <textarea class="q-prescription" data-week-id="${wk.id}" data-field="q2_prescription"
        placeholder="Q2 workout prescription…">${escHtml(wk.q2_prescription||'')}</textarea>
    </div>
  `;

  // Target miles — save on blur
  qRow.querySelector('.q-target-input').addEventListener('blur', (e) => {
    const val = parseFloat(e.target.value) || 0;
    wk.target_miles = val;
    saveWeekMeta(wk);
  });

  // Prescription textareas — auto-resize + save on blur
  qRow.querySelectorAll('.q-prescription').forEach(ta => {
    autoResizeTextarea(ta);
    ta.addEventListener('input', () => autoResizeTextarea(ta));
    ta.addEventListener('blur', () => {
      wk[ta.dataset.field] = ta.value;
      saveWeekMeta(wk);
    });
  });

  // Q day assignment — N/A just unassigns; prescription is never touched
  qRow.querySelectorAll('.q-day-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const q   = sel.dataset.q;
      const val = sel.value;
      const dayVal = (val === '' || val === NAY_VAL) ? null : parseInt(val);
      await assignQDay(wk.id, q, dayVal);
      rerenderOpenWeek();
    });
  });

  // Week body: [Q panel: target|Q1|Q2] | [grid] | [summary]
  const body = document.createElement('div');
  body.className = 'week-body';

  qRow.className = 'q-column';
  body.appendChild(qRow);

  // Grid + summary fill remaining width
  const gridRow = document.createElement('div');
  gridRow.className = 'week-grid-row';

  const gridPane = document.createElement('div');
  gridPane.className = 'grid-pane';
  gridPane.appendChild(buildCalGrid(wk, wStart, wDays, dailyMap));
  gridRow.appendChild(gridPane);
  gridRow.appendChild(buildSummaryPane(wk, wDays));

  body.appendChild(gridRow);
  block.appendChild(body);
  return block;
}

function buildCalGrid(wk, wStart, wDays, dailyMap) {
  const table = document.createElement('table');
  table.className = 'cal-grid';

  // colgroup
  table.innerHTML = `<colgroup>
    <col class="rl-col">
    <col class="day-col"><col class="day-col"><col class="day-col">
    <col class="day-col"><col class="day-col"><col class="day-col"><col class="day-col">
  </colgroup>`;

  // thead: day headers
  const thead = document.createElement('thead');

  // Pre-compute which day has Q1/Q2
  const q1DayInGrid = wDays.find(x => (x.tags||[]).includes('Q1'))?.day_of_week ?? -1;
  const q2DayInGrid = wDays.find(x => (x.tags||[]).includes('Q2'))?.day_of_week ?? -1;

  // Row 1: day names + dates; Q days get full Q-color header cell
  const hdrRow = document.createElement('tr');
  const rlTh = document.createElement('th');
  rlTh.className = 'rl';
  hdrRow.appendChild(rlTh);
  for (let d = 0; d < 7; d++) {
    const date = addDays(wStart, d);
    const isQ1 = d === q1DayInGrid;
    const isQ2 = d === q2DayInGrid;
    const th = document.createElement('th');
    if (isQ1 || isQ2) {
      th.style.background = 'var(--q-bg)';
      th.style.color = 'var(--q-text)';
    }
    th.innerHTML = `<div class="day-head-name">${DAY_NAMES[d]}</div>
      <div class="day-head-date" style="${isQ1||isQ2 ? 'color:var(--q-text);opacity:0.7' : ''}">${fmtDate(date, {month:'short', day:'numeric'})}</div>`;
    hdrRow.appendChild(th);
  }
  thead.appendChild(hdrRow);
  table.appendChild(thead);

  // tbody: pace rows + total + ACR
  const tbody = document.createElement('tbody');

  for (let pi = 0; pi < 5; pi++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="rl"><span class="pace-lbl ${PACE_CODES[pi]}">${PACE_LABELS[pi]}</span></td>`;
    for (let d = 0; d < 7; d++) {
      const dayData = wDays.find(x => x.day_of_week === d);
      const fieldKey = `${PACE_KEYS[pi]}_miles`;
      const val = dayData ? (dayData[fieldKey] || 0) : 0;
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.step = '0.5';
      inp.className = 'pace-input';
      inp.value = val || '';
      inp.placeholder = '—';
      inp.dataset.weekId = wk.id;
      inp.dataset.dayOfWeek = d;
      inp.dataset.field = fieldKey;
      inp.dataset.paceRow = pi;
      inp.dataset.paceDay = d;
      inp.addEventListener('change', onPaceInputChange);
      inp.addEventListener('blur', onPaceInputBlur);
      inp.addEventListener('keydown', onPaceInputKeydown);
      td.appendChild(inp);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Total row
  const totRow = document.createElement('tr');
  totRow.className = 'tot-row';
  totRow.innerHTML = `<td class="rl" style="background:#fff!important">Total</td>`;
  for (let d = 0; d < 7; d++) {
    const dayData = wDays.find(x => x.day_of_week === d);
    const tot = dayData ? roundMi(dayTotal(dayData)) : 0;
    totRow.innerHTML += `<td class="tot-val" data-week-id="${wk.id}" data-day="${d}" style="${tot ? '' : 'color:#ccc'}">${tot || 0}</td>`;
  }
  tbody.appendChild(totRow);

  // ACR Load Max row
  const loadMaxRow = document.createElement('tr');
  loadMaxRow.className = 'acr-row';
  const lmLabel = document.createElement('td');
  lmLabel.className = 'rl';
  lmLabel.innerHTML = `<span class="tip-text" data-tip="The maximum miles you can run today and stay in the healthy zone (≤130% of your 4-week avg load).">Safe Maximum</span>`;
  loadMaxRow.appendChild(lmLabel);

  for (let d = 0; d < 7; d++) {
    const td = document.createElement('td');
    td.dataset.loadMax = '1';
    td.dataset.weekId  = wk.id;
    td.dataset.day     = d;
    const dateStr = isoDate(addDays(wStart, d));
    const chronic = computeChronicLoad(dateStr, dailyMap);
    const lmax    = roundMi(computeLoadMax(dateStr, dailyMap));
    td.title = `Max safe miles today = ${lmax}. Your 4-week avg: ${roundMi(chronic)} mi/week.`;
    renderLoadMaxCell(td, lmax);
    loadMaxRow.appendChild(td);
  }
  tbody.appendChild(loadMaxRow);

  // ACR Load Overage row
  const loadOverRow = document.createElement('tr');
  loadOverRow.className = 'acr-row';
  const loLabel = document.createElement('td');
  loLabel.className = 'rl';
  loLabel.innerHTML = `<span class="tip-text" data-tip="How far today's miles are from the healthy zone. Blue = below minimum. Gray = in zone (value shows headroom to max). Red = over maximum.">Overage</span>`;
  loadOverRow.appendChild(loLabel);

  for (let d = 0; d < 7; d++) {
    const td = document.createElement('td');
    td.dataset.loadOver = '1';
    td.dataset.weekId   = wk.id;
    td.dataset.day      = d;
    const dateStr = isoDate(addDays(wStart, d));
    const dayData = wDays.find(x => x.day_of_week === d);
    const todayMi = dayData ? roundMi(dayTotal(dayData)) : 0;
    const lmax    = roundMi(computeLoadMax(dateStr, dailyMap));
    const lmin    = roundMi(computeLoadMin(dateStr, dailyMap));
    renderLoadOverCell(td, todayMi, lmax, lmin);
    loadOverRow.appendChild(td);
  }
  tbody.appendChild(loadOverRow);

  table.appendChild(tbody);
  return table;
}

function buildTagCell(weekId, dayOfWeek, tags) {
  const stack = document.createElement('div');
  stack.className = 'tag-stack';
  stack.dataset.weekId = weekId;
  stack.dataset.day = dayOfWeek;

  const group = document.createElement('div');
  group.className = 'tag-group';

  for (const t of tags) {
    group.appendChild(makeTagEl(t, weekId, dayOfWeek));
  }

  const plus = document.createElement('span');
  plus.className = 'tag plus';
  plus.textContent = '+';
  plus.addEventListener('click', (e) => {
    e.stopPropagation();
    openTagPopover(weekId, dayOfWeek, plus);
  });

  if (tags.length > 0) stack.appendChild(group);
  stack.appendChild(plus);
  return stack;
}

function makeTagEl(tagText, weekId, dayOfWeek) {
  const span = document.createElement('span');
  const isQ = tagText === 'Q1' || tagText === 'Q2';
  span.className = `tag ${isQ ? 'Q' : 'activity'}`;
  span.dataset.weekId = weekId;
  span.dataset.day = dayOfWeek;
  span.dataset.tag = tagText;

  const txt = document.createTextNode(tagText);
  const x = document.createElement('span');
  x.className = 'tag-x';
  x.textContent = '×';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTag(weekId, dayOfWeek, tagText);
  });
  span.appendChild(txt);
  span.appendChild(x);
  return span;
}

function buildSummaryPane(wk, wDays) {
  const pane = document.createElement('div');
  pane.className = 'summary-pane';
  pane.id = `summary-${wk.id}`;

  const total = wDays.reduce((s, d) => s + dayTotal(d), 0);

  // vs target
  const diff = wk.target_miles > 0 ? roundMi(total - wk.target_miles) : null;
  const diffCls = vsTargetClass(diff);
  const diffStr = diff === null ? '—' : (diff >= 0 ? `+${diff} mi` : `${diff} mi`);
  const diffLbl = diff === null
    ? `${roundMi(total)} mi planned`
    : `${roundMi(total)} of ${wk.target_miles} mi target`;

  // WoW miles
  const prevWk = weeks.find(w => w.week_number === wk.week_number + 1);
  let wowMiles = null, wowLong = null;
  if (prevWk) {
    const prevDays = days[prevWk.id] || [];
    const prevTotal = prevDays.reduce((s, d) => s + dayTotal(d), 0);
    if (prevTotal > 0) wowMiles = ((total - prevTotal) / prevTotal) * 100;

    const thisLong = Math.max(0, ...wDays.map(d => dayTotal(d)));
    const prevLong = Math.max(0, ...prevDays.map(d => dayTotal(d)));
    if (prevLong > 0) wowLong = ((thisLong - prevLong) / prevLong) * 100;
  }

  const wowMilesCls = wowClass(wowMiles);
  const wowLongCls  = wowClass(wowLong);

  pane.innerHTML = `
    <div class="sum-tile ${diffCls}">
      <div class="st-val ${diffCls}">${diffStr}</div>
      <div class="st-lbl ${diffCls}">${diffLbl}</div>
    </div>
    <div class="sum-tile ${wowMilesCls}">
      <div class="st-val ${wowMilesCls}">${wowLabel(wowMiles)}</div>
      <div class="st-lbl ${wowMilesCls}">Weekly Miles WoW</div>
    </div>
    <div class="sum-tile ${wowLongCls}">
      <div class="st-val ${wowLongCls}">${wowLabel(wowLong)}</div>
      <div class="st-lbl ${wowLongCls}">Long Run WoW</div>
    </div>
    ${buildMixBarHTML(wDays)}
  `;
  return pane;
}

function buildMixBarHTML(wDays) {
  const totals = [0, 0, 0, 0, 0]; // E M T I R
  for (const d of wDays) {
    totals[0] += d.easy_miles || 0;
    totals[1] += d.marathon_miles || 0;
    totals[2] += d.threshold_miles || 0;
    totals[3] += d.interval_miles || 0;
    totals[4] += d.repetition_miles || 0;
  }
  const sum = totals.reduce((a, b) => a + b, 0);
  const pcts = totals.map(v => sum > 0 ? Math.round(v / sum * 100) : 0);

  const barParts = PACE_CODES.map((c, i) =>
    `<div style="flex:${totals[i] || 0.001};background:${PACE_COLORS[i]};box-shadow:${i > 0 ? '-1px 0 0 #fff' : 'none'}"></div>`
  ).join('');

  const legend = PACE_CODES.map((c, i) =>
    `<span class="mix-legend-item"><span class="mix-dot" style="background:${PACE_COLORS[i]}"></span>${c} ${pcts[i]}%</span>`
  ).join('');

  return `
    <div class="mix-wrap">
      <div class="mix-label">Pace mix</div>
      <div class="mix-bar">${barParts}</div>
      <div class="mix-legend">${legend}</div>
    </div>
  `;
}

// ────────────────────────────────────────────────
// Q day assignment
// ────────────────────────────────────────────────

function getQDay(weekId, q) {
  const wDays = days[weekId] || [];
  const day = wDays.find(d => (d.tags || []).includes(q));
  return day ? day.day_of_week : null;
}

async function assignQDay(weekId, q, dayOfWeek) {
  const wDays = days[weekId] || [];
  // Remove q from any day that has it
  for (const day of wDays) {
    if ((day.tags || []).includes(q)) {
      day.tags = day.tags.filter(t => t !== q);
      await saveDayData(day);
    }
  }
  // Assign to new day (if one was selected)
  if (dayOfWeek !== null) {
    ensureDayExists(weekId, dayOfWeek);
    const day = days[weekId].find(d => d.day_of_week === dayOfWeek);
    if (!(day.tags || []).includes(q)) {
      day.tags = [...(day.tags || []), q];
      await saveDayData(day);
    }
  }
}

// ────────────────────────────────────────────────
// Input handlers
// ────────────────────────────────────────────────

// ── Load row cell renderers ──────────────────────────────
function renderLoadMaxCell(td, lmax) {
  if (lmax <= 0) {
    td.textContent = '0';
    td.style.color = 'var(--acr-orange-text)';
    td.style.fontWeight = '500';
  } else {
    td.textContent = lmax;
    td.style.color = 'var(--text-secondary)';
    td.style.fontWeight = '';
  }
}

function renderLoadOverCell(td, todayMi, lmax, lmin) {
  td.innerHTML = '';
  if (todayMi > lmax) {
    const over = roundMi(todayMi - lmax);
    const chip = document.createElement('span');
    chip.className = 'overage-chip red';
    chip.textContent = `+${over}`;
    chip.title = `You're ${over} miles over the recommended daily max. Reducing by ${over} miles would bring you back into the healthy training zone and reduce overuse injury risk.`;
    td.appendChild(chip);
  } else if (todayMi < lmin) {
    const deficit = roundMi(lmin - todayMi);
    const chip = document.createElement('span');
    chip.className = 'overage-chip blue';
    chip.textContent = `−${deficit}`;
    chip.title = `You're ${deficit} miles below the minimum recommended load for today. Running ${deficit} more miles would bring you to the low end of the healthy training zone. Extended time below 80% load risks detraining.`;
    td.appendChild(chip);
  } else {
    // In zone — show headroom to max in gray
    const headroom = roundMi(lmax - todayMi);
    td.style.color = '#bbb';
    td.style.fontWeight = '';
    td.textContent = headroom > 0 ? `−${headroom}` : '0';
  }
}

// Refresh Total, Load Max, Load Overage across ALL open weeks
// Called after any pace input changes, since ACR carries across weeks.
function refreshAllLoadRows() {
  const dailyMap = buildDailyTotalsMap();
  for (const weekNum of openWeekNumbers) {
    const wk = weeks.find(w => w.week_number === weekNum);
    if (!wk) continue;
    const block = document.querySelector(`.week-block[data-week-id="${wk.id}"]`);
    if (!block) continue;
    const wStart = weekStartDate(plan.race_date, wk.week_number);
    const wDays  = days[wk.id] || [];

    for (let d = 0; d < 7; d++) {
      const dayData = wDays.find(x => x.day_of_week === d);
      const dateStr = isoDate(addDays(wStart, d));
      const todayMi = dayData ? roundMi(dayTotal(dayData)) : 0;

      // Total cell
      const totCell = block.querySelector(`.tot-val[data-week-id="${wk.id}"][data-day="${d}"]`);
      if (totCell) {
        totCell.textContent = todayMi || 0;
        totCell.style.color = todayMi ? '' : '#ccc';
      }

      // Load Max cell
      const lmCell = block.querySelector(`[data-load-max][data-week-id="${wk.id}"][data-day="${d}"]`);
      if (lmCell) {
        const lmax = roundMi(computeLoadMax(dateStr, dailyMap));
        renderLoadMaxCell(lmCell, lmax);
      }

      // Load Overage cell
      const loCell = block.querySelector(`[data-load-over][data-week-id="${wk.id}"][data-day="${d}"]`);
      if (loCell) {
        const lmax = roundMi(computeLoadMax(dateStr, dailyMap));
        const lmin = roundMi(computeLoadMin(dateStr, dailyMap));
        renderLoadOverCell(loCell, todayMi, lmax, lmin);
      }
    }
  }
}

function onPaceInputChange(e) {
  const inp = e.target;
  const weekId = inp.dataset.weekId;
  const dayOfWeek = parseInt(inp.dataset.dayOfWeek);
  const field = inp.dataset.field;
  const val = parseFloat(inp.value) || 0;

  ensureDayExists(weekId, dayOfWeek);
  const day = days[weekId].find(d => d.day_of_week === dayOfWeek);
  day[field] = val;

  // Refresh totals + load rows for all open weeks (ACR carries cross-week)
  refreshAllLoadRows();

  // Update summary pane
  const sumPane = document.getElementById(`summary-${weekId}`);
  if (sumPane) {
    const wk = weeks.find(w => w.id === weekId);
    if (wk) {
      const newPane = buildSummaryPane(wk, days[weekId] || []);
      sumPane.replaceWith(newPane);
    }
  }
}

function onPaceInputBlur(e) {
  const inp = e.target;
  const weekId = inp.dataset.weekId;
  const dayOfWeek = parseInt(inp.dataset.dayOfWeek);
  ensureDayExists(weekId, dayOfWeek);
  const day = days[weekId].find(d => d.day_of_week === dayOfWeek);
  saveDayData(day);
}

function onPaceInputKeydown(e) {
  const dirs = { ArrowLeft:-1, ArrowRight:1 };
  const vertDirs = { ArrowUp:-1, ArrowDown:1 };
  if (!dirs[e.key] && !vertDirs[e.key]) return;

  e.preventDefault();
  const inp = e.target;
  const table = inp.closest('table');
  if (!table) return;

  const curRow = parseInt(inp.dataset.paceRow);
  const curDay = parseInt(inp.dataset.paceDay);

  let targetRow = curRow, targetDay = curDay;
  if (dirs[e.key])     targetDay = Math.max(0, Math.min(6, curDay + dirs[e.key]));
  if (vertDirs[e.key]) targetRow = Math.max(0, Math.min(4, curRow + vertDirs[e.key]));

  const next = table.querySelector(
    `input[data-pace-row="${targetRow}"][data-pace-day="${targetDay}"]`
  );
  if (next) next.focus();
}

function ensureDayExists(weekId, dayOfWeek) {
  if (!days[weekId]) days[weekId] = [];
  if (!days[weekId].find(d => d.day_of_week === dayOfWeek)) {
    days[weekId].push({
      id: null,
      week_id: weekId,
      day_of_week: dayOfWeek,
      easy_miles: 0, marathon_miles: 0,
      threshold_miles: 0, interval_miles: 0, repetition_miles: 0,
      tags: []
    });
    days[weekId].sort((a, b) => a.day_of_week - b.day_of_week);
  }
}

function rerenderOpenWeek() {
  const dailyMap = buildDailyTotalsMap();
  for (const weekNum of openWeekNumbers) {
    const wk = weeks.find(w => w.week_number === weekNum);
    if (wk) {
      const existing = document.querySelector(`.week-block[data-week-id="${wk.id}"]`);
      if (existing) {
        const newBlock = buildOpenWeekBlock(wk, dailyMap);
        existing.replaceWith(newBlock);
      }
    }
  }
}

// ────────────────────────────────────────────────
// Mobile rendering
// ────────────────────────────────────────────────

function renderMobile() {
  if (!plan || weeks.length === 0) return;
  const wk = weeks[mobileWeekIndex];
  if (!wk) return;

  const wStart = weekStartDate(plan.race_date, wk.week_number);
  const wDays  = days[wk.id] || [];
  const dailyMap = buildDailyTotalsMap();

  // Nav
  document.getElementById('m-week-num').textContent   = `Week T-${wk.week_number}`;
  document.getElementById('m-week-dates').textContent = weekDateRange(plan.race_date, wk.week_number);
  document.getElementById('m-week-phase').textContent = `${wk.phase}${wk.target_miles > 0 ? ' · ' + wk.target_miles + ' mi target' : ''}`;

  // Summary stats
  const total    = wDays.reduce((s, d) => s + dayTotal(d), 0);
  const diff     = wk.target_miles > 0 ? roundMi(total - wk.target_miles) : null;
  const diffCls  = vsTargetClass(diff);
  const diffStr  = diff === null ? '—' : (diff >= 0 ? `+${diff} mi` : `${diff} mi`);
  const prevWk   = weeks.find(w => w.week_number === wk.week_number + 1);
  let wowMiles   = null, wowLong = null;
  if (prevWk) {
    const prevDays  = days[prevWk.id] || [];
    const prevTotal = prevDays.reduce((s, d) => s + dayTotal(d), 0);
    if (prevTotal > 0) wowMiles = ((total - prevTotal) / prevTotal) * 100;
    const thisLong  = Math.max(0, ...wDays.map(d => dayTotal(d)));
    const prevLong  = Math.max(0, ...prevDays.map(d => dayTotal(d)));
    if (prevLong > 0) wowLong = ((thisLong - prevLong) / prevLong) * 100;
  }

  const vsEl = document.getElementById('m-vs-target');
  vsEl.textContent = diffStr;
  vsEl.className = `m-stat-val ${diffCls}`;

  const wowEl = document.getElementById('m-wow-miles');
  wowEl.textContent = wowLabel(wowMiles);
  wowEl.className = `m-stat-val ${wowClass(wowMiles)}`;

  const longEl = document.getElementById('m-wow-long');
  longEl.textContent = wowLabel(wowLong);
  longEl.className = `m-stat-val ${wowClass(wowLong)}`;

  // Pace mix bar
  const totals = [0,0,0,0,0];
  for (const d of wDays) {
    totals[0] += d.easy_miles||0; totals[1] += d.marathon_miles||0;
    totals[2] += d.threshold_miles||0; totals[3] += d.interval_miles||0;
    totals[4] += d.repetition_miles||0;
  }
  const mixSum = totals.reduce((a,b)=>a+b,0);
  const pcts = totals.map(v => mixSum>0 ? Math.round(v/mixSum*100) : 0);
  document.getElementById('m-mix-bar').innerHTML =
    PACE_CODES.map((c,i) => `<div style="flex:${totals[i]||0.001};background:${PACE_COLORS[i]};box-shadow:${i>0?'-1px 0 0 #fff':'none'}"></div>`).join('');
  document.getElementById('m-mix-legend').innerHTML =
    PACE_CODES.map((c,i) => `<span class="m-mix-item"><span class="m-mix-dot" style="background:${PACE_COLORS[i]}"></span>${c} ${pcts[i]}%</span>`).join('');

  // Day rows
  const daysEl = document.getElementById('m-days');
  daysEl.innerHTML = '';
  for (let d = 0; d < 7; d++) {
    const date    = addDays(wStart, d);
    const dayData = wDays.find(x => x.day_of_week === d) || {
      easy_miles:0, marathon_miles:0, threshold_miles:0, interval_miles:0, repetition_miles:0, tags:[]
    };
    const tags    = dayData.tags || [];
    const hasMiles = dayTotal(dayData) > 0;

    const row = document.createElement('div');
    row.className = 'm-day-row' + (isToday(date) ? ' today' : '');

    // ACR
    let acrHTML = '';
    if (hasMiles) {
      const acr = computeACR(isoDate(date), dailyMap);
      if (acr !== null) {
        const cls = acrClass(acr);
        acrHTML = `<span class="m-day-acr ${cls}">ACR ${Math.round(acr)}%</span>`;
      }
    }

    // Q hint and tag chip (read-only — assigned via week Q row)
    const hasQ1 = tags.includes('Q1');
    const hasQ2 = tags.includes('Q2');
    const qHint = (hasQ1 && wk.q1_prescription) ? wk.q1_prescription.replace(/\n/g,' · ')
                : (hasQ2 && wk.q2_prescription) ? wk.q2_prescription.replace(/\n/g,' · ')
                : null;
    const qTag = hasQ1 ? 'Q1' : hasQ2 ? 'Q2' : null;

    // Build tag display (Q chip only, no controls)
    const tagsEl = document.createElement('div');
    tagsEl.className = 'm-day-tags';
    if (qTag) {
      const chip = document.createElement('span');
      chip.className = `m-dtag ${qTag === 'Q1' ? 'q1' : 'q2'}`;
      chip.textContent = qTag;
      tagsEl.appendChild(chip);
    }

    row.innerHTML = `
      <div class="m-day-header">
        <div class="m-day-left">
          <span class="m-day-name">${DAY_NAMES[d]}</span>
          <span class="m-day-date">${fmtDate(date,{month:'short',day:'numeric'})}</span>
        </div>
        ${acrHTML}
      </div>`;
    row.querySelector('.m-day-left').appendChild(tagsEl);
    if (qHint) {
      const hint = document.createElement('div');
      hint.className = 'm-q-hint';
      hint.textContent = qHint;
      row.appendChild(hint);
    }
    // Append pace table separately below
    const paceTbl = document.createElement('div');
    paceTbl.innerHTML = `<table class="m-pace-table">
        <thead><tr>
          <th class="E">E</th><th class="M">M</th><th class="T">T</th>
          <th class="I">I</th><th class="R">R</th><th class="tot">tot</th>
        </tr></thead>
        <tbody><tr>
          ${PACE_KEYS.map((k,i) => `<td><input type="number" min="0" step="0.5"
            class="m-pace-input ${PACE_CODES[i]}"
            data-week-id="${wk.id}" data-day="${d}" data-field="${k}_miles"
            value="${dayData[k+'_miles']||''}" placeholder="0"></td>`).join('')}
          <td><div class="m-tot-cell" data-m-tot-day="${d}">${roundMi(dayTotal(dayData)) || 0}</div></td>
        </tr></tbody>
      </table>
    `;

    row.appendChild(paceTbl.firstChild);

    // Wire inputs
    row.querySelectorAll('.m-pace-input').forEach(inp => {
      inp.addEventListener('change', onMobilePaceChange);
      inp.addEventListener('blur', onPaceInputBlur);
    });

    daysEl.appendChild(row);
  }
}

function onMobilePaceChange(e) {
  const inp = e.target;
  const weekId = inp.dataset.weekId;
  const dayOfWeek = parseInt(inp.dataset.day);
  const field = inp.dataset.field;
  const val = parseFloat(inp.value) || 0;

  ensureDayExists(weekId, dayOfWeek);
  const day = days[weekId].find(d => d.day_of_week === dayOfWeek);
  day[field] = val;

  const totEl = inp.closest('table')?.querySelector(`[data-m-tot-day="${dayOfWeek}"]`);
  if (totEl) totEl.textContent = roundMi(dayTotal(day)) || 0;

  // Refresh summary
  renderMobileSummary();
}

function renderMobileSummary() {
  // Re-run just the summary portion of renderMobile
  if (plan && weeks.length > 0) {
    const wk = weeks[mobileWeekIndex];
    const wDays = days[wk.id] || [];
    const total = wDays.reduce((s, d) => s + dayTotal(d), 0);
    const diff = wk.target_miles > 0 ? roundMi(total - wk.target_miles) : null;
    const diffCls = vsTargetClass(diff);
    const diffStr = diff === null ? '—' : (diff >= 0 ? `+${diff} mi` : `${diff} mi`);
    document.getElementById('m-vs-target').textContent = diffStr;
    document.getElementById('m-vs-target').className = `m-stat-val ${diffCls}`;
  }
}

// ────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function autoResizeTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// ────────────────────────────────────────────────
// Supabase stubs (wired in Step 5)
// ────────────────────────────────────────────────

// ────────────────────────────────────────────────
// Supabase API helpers
// ────────────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...opts.headers,
    },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbGet(path)         { return sbFetch(path, { method: 'GET' }); }
async function sbPost(path, body)  { return sbFetch(path, { method: 'POST',  body: JSON.stringify(body) }); }
async function sbPatch(path, body) { return sbFetch(path, { method: 'PATCH', body: JSON.stringify(body), prefer: 'return=minimal' }); }

// ────────────────────────────────────────────────
// Supabase load / save
// ────────────────────────────────────────────────

async function loadPlan() {
  const plans = await sbGet('/plans?select=*&limit=1&order=created_at.asc');
  if (plans && plans.length > 0) return plans[0];

  // First run — create a default plan
  const created = await sbPost('/plans', {
    plan_name: 'NYC Marathon 2026',
    race_date: '2026-11-01',
    num_weeks: 26,
    vdot_paces: { E:'10:12', M:'8:47', T:'8:20', I:'7:45', R:'7:15' },
  });
  return created[0];
}

async function loadWeeks(planId) {
  return sbGet(`/weeks?plan_id=eq.${planId}&select=*&order=week_number.desc`);
}

async function loadDays(planId) {
  // Join through weeks to get all days for the plan in one query
  return sbGet(`/days?select=*,weeks!inner(plan_id)&weeks.plan_id=eq.${planId}&order=day_of_week.asc`);
}

async function ensureWeeksExist(planId, numWeeks) {
  // Fetch existing week numbers
  const existing = await sbGet(`/weeks?plan_id=eq.${planId}&select=week_number`);
  const existingNums = new Set((existing || []).map(w => w.week_number));

  const phases = {
    26:1,25:1,24:1,23:1,22:1,21:1,20:1,19:1,
    18:2,17:2,16:2,15:2,
    14:3,13:3,12:3,11:3,
    10:4,9:4,8:4,7:4,6:4,5:4,4:4,
    3:5,2:5,1:5
  };
  const phaseNames = ['Foundation','Initial Quality','Transition Quality','Final Quality','Taper'];

  const toInsert = [];
  for (let n = numWeeks; n >= 1; n--) {
    if (!existingNums.has(n)) {
      const phaseIdx = (phases[n] || 1) - 1;
      toInsert.push({
        plan_id: planId,
        week_number: n,
        phase: phaseNames[phaseIdx],
        location: 'New York',
        target_miles: 0,
        q1_prescription: '',
        q2_prescription: '',
      });
    }
  }

  if (toInsert.length > 0) {
    await sbPost('/weeks', toInsert);
  }
}

async function saveWeekMeta(wk) {
  await sbPatch(
    `/weeks?id=eq.${wk.id}`,
    {
      phase: wk.phase,
      location: wk.location,
      target_miles: wk.target_miles,
      q1_prescription: wk.q1_prescription,
      q2_prescription: wk.q2_prescription,
    }
  );
}

async function savePlanMeta() {
  await sbPatch(`/plans?id=eq.${plan.id}`, {
    plan_name:  plan.plan_name,
    race_date:  plan.race_date,
    num_weeks:  plan.num_weeks,
    vdot_paces: plan.vdot_paces,
  });
}

async function saveDayData(day) {
  if (!day.id) {
    // New day — insert
    const result = await sbPost('/days', {
      week_id:          day.week_id,
      day_of_week:      day.day_of_week,
      easy_miles:       day.easy_miles       || 0,
      marathon_miles:   day.marathon_miles   || 0,
      threshold_miles:  day.threshold_miles  || 0,
      interval_miles:   day.interval_miles   || 0,
      repetition_miles: day.repetition_miles || 0,
      tags:             day.tags             || [],
    });
    if (result && result[0]) day.id = result[0].id;
  } else {
    await sbPatch(`/days?id=eq.${day.id}`, {
      easy_miles:       day.easy_miles       || 0,
      marathon_miles:   day.marathon_miles   || 0,
      threshold_miles:  day.threshold_miles  || 0,
      interval_miles:   day.interval_miles   || 0,
      repetition_miles: day.repetition_miles || 0,
      tags:             day.tags             || [],
    });
  }
}

// ────────────────────────────────────────────────
// Bootstrap from Supabase
// ────────────────────────────────────────────────
// One-time data migration from UL.xlsx
// ────────────────────────────────────────────────

const MIGRATION_DATA = {
  26:{ phase:'Foundation',    loc:'New York',    target:16,
       q1:'No Q sessions this week; Easy runs all week + add 6-8 ST on 2 days', q2:'',
       q1d:null, q2d:null,
       days:[[3.6,0,0,0,0],[0,0,0,0,0],[3,0,0,0,0],[0,0,0,0,0],[4.3,0,0,0,0],[0,0,0,0,0],[6.8,0,0,0,0]] },
  25:{ phase:'Foundation',    loc:'New York',    target:19,
       q1:'2 Easy / 2×1 Threshold w/1 min rests / 3×3 min Intervals w/2 min jg / 4×200 Reps w/200 jg / 1 Easy',
       q2:'L = lesser of 12 miles (19 km) & 90 min', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[2.6,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[4,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]] },
  24:{ phase:'Foundation',    loc:'New York',    target:21,
       q1:'2 Easy / 3×1 Threshold w/1 min rests / 8×200 Reps w/200 jg / 1 Easy',
       q2:'30 min Easy / 6 Marathon', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[4.2,0,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[3.5,0,0,0,0],[7.2,0,0,0,0],[0,0,0,0,0]] },
  23:{ phase:'Foundation',    loc:'New York',    target:19,
       q1:'No Q sessions this week; Easy runs all week + add 6-8 ST on 2 days', q2:'',
       q1d:null, q2d:null,
       days:[[0,0,0,0,0],[1,0,0,0,0],[5,0,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[8,0,0,0,0],[2,0,0,0,0]] },
  22:{ phase:'Foundation',    loc:'New York',    target:21,
       q1:'2 Easy / 3×1 Threshold w/1 min rests / 8×200 Reps w/200 jg / 1 Easy',
       q2:'2 Easy / 4×1 Threshold w/1 min rests / 2 Easy', q1d:1, q2d:3,
       days:[[0,0,0,0,0],[4,0,3,0,1],[0,0,0,0,0],[3.5,0,3,0,0],[0,0,0,0,0],[0,0,3,0,0],[4.5,0,0,0,0]] },
  21:{ phase:'Foundation',    loc:'New York',    target:24,
       q1:'2 Easy / 2×1 Threshold w/2 min rests / 3×1 km Intervals w/3 min jg / 6×200 Reps w/200 jg / 1 Easy',
       q2:'L = lesser of 13 miles (21 km) & 90 min', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[3,0,2,1,1],[3,0,0,0,0],[4,0,0,0,0],[0,0,0,0,0],[9.5,0,0,0,0],[0,0,0,0,0]] },
  20:{ phase:'Initial Quality', loc:'New York',  target:27,
       q1:'1 Easy / 5 Marathon / 1 Easy / 4 Marathon / 1 Easy',
       q2:'30 min Easy / 8 Marathon', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[3,5,0,0,0],[3,0,0,0,0],[3,0,0,0,0],[0,0,0,0,0],[3,7.5,0,0,0],[0,0,0,0,0]] },
  19:{ phase:'Initial Quality', loc:'New York',  target:30,
       q1:'No Q sessions this week; Easy runs all week + add 6-8 ST on 2 days', q2:'',
       q1d:null, q2d:null,
       days:[[0,0,0,0,0],[6,0,0,0,0],[4,2,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[4,3,0,0,0],[4,0,0,0,0]] },
  18:{ phase:'Initial Quality', loc:'New York',  target:33,
       q1:'2 Easy / 3×1 Threshold w/1 min rests / 8×200 Reps w/200 jg / 2 Easy',
       q2:'2 Easy / 4×1 Threshold w/1 min rests / 2 Easy', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[4,0,3,1,0],[6,0,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[6,0,2,0,0],[3,0,0,0,0]] },
  17:{ phase:'Initial Quality', loc:'New York',  target:27,
       q1:'2 Easy / 2 Threshold / 2 min rest / 8×200 Reps w/200 jg / 3×3 min Intervals w/3 min jg / 1 Easy',
       q2:'L = lesser of 14 miles (23 km) & 2 hr', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[5,0,2,1,1],[0,0,0,0,0],[4,0,0,0,0],[0,0,0,0,0],[11,0,0,0,0],[0,0,0,0,0]] },
  16:{ phase:'Initial Quality', loc:'New York',  target:30,
       q1:'2 Easy / 6 Marathon / 1 Easy / 4 Marathon / 1 Easy',
       q2:'3 Easy / 10 Marathon', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[3,7,0,0,0],[3,0,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[3,9,0,0,0],[0,0,0,0,0]] },
  15:{ phase:'Initial Quality', loc:'New York',  target:27,
       q1:'No Q sessions this week; Easy runs all week + add 6-8 ST on 2 days', q2:'',
       q1d:null, q2d:null,
       days:[[0,0,0,0,0],[5,0,0,0,0],[6,0,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[6,0,0,0,0],[5,0,0,0,0]] },
  14:{ phase:'Transition Quality', loc:'New York', target:33,
       q1:'2 Easy / 4×1 Threshold w/1 min rests / 8×200 Reps w/200 jg / 2 Easy / 2 Threshold / 2 min rest / 1 Threshold / 1 Easy',
       q2:'2 Easy / 2×1 Threshold w/1 min rests', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[5,0,7,0,1],[4,0,0,0,0],[7,0,0,0,0],[0,0,0,0,0],[4,0,4,0,0],[0,0,0,0,0]] },
  13:{ phase:'Transition Quality', loc:'New York', target:30,
       q1:'2 Easy / 2 Threshold / 2 min rest / 3×3 min Intervals w/2 min jg / 8×200 Reps w/200 jg / 1 Easy',
       q2:'L = lesser of 15 miles (24 km) & 2 hr', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[3,0,2,2,1],[4,0,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[13,0,0,0,0],[0,0,0,0,0]] },
  12:{ phase:'Transition Quality', loc:'New York', target:32,
       q1:'2 Easy / 6 Marathon / 1 Easy / 5 Marathon / 1 Easy',
       q2:'20 min Easy / 12 Marathon', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[4,10,0,0,0],[0,0,0,0,0],[4,0,0,0,0],[0,0,0,0,0],[2,12,0,0,0],[0,0,0,0,0]] },
  11:{ phase:'Transition Quality', loc:'New York', target:28,
       q1:'No Q sessions this week; Easy runs all week + add 6-8 ST on 2 days', q2:'',
       q1d:null, q2d:null,
       days:[[0,0,0,0,0],[7,0,0,0,0],[5,0,0,0,0],[5,0,0,0,0],[0,0,0,0,0],[7,0,0,0,0],[4,0,0,0,0]] },
  10:{ phase:'Transition Quality', loc:'New York', target:40,
       q1:'2 Easy / 4×1 Threshold w/1 min rests / 8×200 Reps w/200 jg / 2 Easy / 2 min rest / 1 Threshold / 1 Easy',
       q2:'2 Easy / 2×1 Threshold w/1 min rests / 2 Threshold', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[3,0,5,0,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[2,0,4,0,0],[0,0,0,0,0]] },
   9:{ phase:'Transition Quality', loc:'Travel',   target:36,
       q1:'2 Easy / 2 Threshold / 2 min rest / 2 Threshold / 2 min rest / 3×3 min Intervals w/2 min jg / 6×200 Reps w/200 jg / 1 Easy',
       q2:'L = lesser of 15 miles (24 km) & 130 min', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[3,0,4,2,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[15,0,0,0,0],[0,0,0,0,0]] },
   8:{ phase:'Transition Quality', loc:'New York', target:40,
       q1:'3 Easy / 6 Marathon / 1 Easy / 4 Marathon / 1 Easy',
       q2:'30 min Easy / 12 Marathon', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[5,10,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[3,12,0,0,0],[0,0,0,0,0]] },
   7:{ phase:'Transition Quality', loc:'New York', target:32,
       q1:'No Q sessions this week; Easy runs all week + add 6-8 ST on 2 days', q2:'',
       q1d:null, q2d:null,
       days:[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]] },
   6:{ phase:'Final Quality',    loc:'New York',   target:40,
       q1:'2 Easy / 4×1 Threshold w/1 min rests / 8×200 Reps w/200 jg / 2 Easy',
       q2:'30 min Easy / 3×2 Threshold w/2 min rests / 2 Easy', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[4,0,4,0,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[5,0,6,0,0],[0,0,0,0,0]] },
   5:{ phase:'Final Quality',    loc:'New York',   target:36,
       q1:'2 Easy / 2×1 Threshold w/1 min rests / 3×3 min Intervals w/2 min jg / 8×200 Reps w/200 jg / 1 Easy',
       q2:'L = lesser of 15 miles (24 km) & 130 min', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[3,0,2,1,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[15,0,0,0,0],[0,0,0,0,0]] },
   4:{ phase:'Final Quality',    loc:'New York',   target:36,
       q1:'3 Easy / 5 Marathon / 1 Easy / 5 Marathon / 1 Easy',
       q2:'20 min Easy / 12 Marathon', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[5,10,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[2,12,0,0,0],[0,0,0,0,0]] },
   3:{ phase:'Taper',            loc:'New York',   target:32,
       q1:'No Q sessions this week; Easy runs all week + add 6-8 ST on 2 days', q2:'',
       q1d:null, q2d:null,
       days:[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]] },
   2:{ phase:'Taper',            loc:'New York',   target:28,
       q1:'2 Easy / 4×1 Threshold w/1 min rests / 8×200 Reps w/200 jg / 2 Easy',
       q2:'60 min Easy / 3 Threshold / 2 min rest / 2 Threshold / 2 Easy', q1d:1, q2d:5,
       days:[[0,0,0,0,0],[4,0,4,0,1],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[8,0,5,0,0],[0,0,0,0,0]] },
   1:{ phase:'Taper',            loc:'New York',   target:20,
       q1:'7 days: 90 min Easy / 6 days: 60 min Easy / 5 days: 3×1 Threshold w/2 min rests / 4 days: 60 min Easy / 2 days: 30 min Easy / 1 day: 30 min Easy (tomorrow is the marathon race)',
       q2:'', q1d:1, q2d:null,
       days:[[3,0,0,0,0],[0,0,3,0,0],[0,0,0,0,0],[0,0,0,0,0],[2,0,0,0,0],[0,0,0,0,0],[0,26.2,0,0,0]] },
};

async function runMigration() {
  console.log('Running plan migration from UL.xlsx...');

  // Update plan paces to match spreadsheet
  plan.vdot_paces = { E:'11:15', M:'10:00', T:'9:00', I:'8:15', R:'7:15' };
  await savePlanMeta();
  updatePaceChips();

  // Load all weeks to get their IDs
  const wkList = await loadWeeks(plan.id);
  const wkMap = {};
  for (const wk of wkList) wkMap[wk.week_number] = wk;

  for (const [numStr, data] of Object.entries(MIGRATION_DATA)) {
    const num = parseInt(numStr);
    const wk = wkMap[num];
    if (!wk) { console.warn(`Week ${num} not found`); continue; }

    // Update week metadata
    wk.phase            = data.phase;
    wk.location         = data.loc;
    wk.target_miles     = data.target;
    wk.q1_prescription  = data.q1.replace(/ \/ /g, '\n');
    wk.q2_prescription  = data.q2.replace(/ \/ /g, '\n');
    await saveWeekMeta(wk);

    // Build day records with Q tag assignment
    const dayRecords = data.days.map((paces, d) => ({
      week_id:          wk.id,
      day_of_week:      d,
      easy_miles:       paces[0],
      marathon_miles:   paces[1],
      threshold_miles:  paces[2],
      interval_miles:   paces[3],
      repetition_miles: paces[4],
      tags: (d === data.q1d ? ['Q1'] : d === data.q2d ? ['Q2'] : []),
    }));

    // Delete existing days for this week, then insert fresh
    await sbFetch(`/days?week_id=eq.${wk.id}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
    await sbFetch(`/days`, {
      method: 'POST',
      body: JSON.stringify(dayRecords),
      prefer: 'return=minimal',
    });

    // Update in-memory state
    weeks[weeks.findIndex(w => w.id === wk.id)] = wk;
    days[wk.id] = dayRecords.map(d => ({...d, id: days[wk.id]?.find(x=>x.day_of_week===d.day_of_week)?.id || null}));
  }

  localStorage.setItem('migV2', '1');
  console.log('Migration complete.');
  renderDesktop();
  renderMobile();
}

// ────────────────────────────────────────────────

async function initFromSupabase() {
  plan = await loadPlan();
  await ensureWeeksExist(plan.id, plan.num_weeks);

  const rawWeeks = await loadWeeks(plan.id);
  weeks = rawWeeks || [];

  // Initialize empty days arrays
  days = {};
  for (const wk of weeks) days[wk.id] = [];

  // Load all days for this plan
  const rawDays = await sbGet(
    `/days?week_id=in.(${weeks.map(w => w.id).join(',')})&select=*&order=day_of_week.asc`
  );
  for (const day of (rawDays || [])) {
    if (!days[day.week_id]) days[day.week_id] = [];
    days[day.week_id].push(day);
  }
}

// ────────────────────────────────────────────────
// Popover / sheet wiring
// ────────────────────────────────────────────────

function openPopover(name) {
  document.getElementById(`${name}-backdrop`).classList.add('open');
}
function closePopover(name) {
  document.getElementById(`${name}-backdrop`).classList.remove('open');
}

function openSheet(name) {
  document.getElementById(`m-${name}-backdrop`).classList.add('open');
}
function closeSheet(name) {
  document.getElementById(`m-${name}-backdrop`).classList.remove('open');
}

// ────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await initFromSupabase();
  } catch (e) {
    console.error('Failed to load from Supabase:', e);
    document.getElementById('loading-screen').innerHTML =
      `<span style="color:#A32D2D">⚠ Could not connect to database. Check console for details.</span>`;
    return;
  }

  document.getElementById('loading-screen').style.display = 'none';

  // Seed goal paces if not yet set
  if (!plan.vdot_paces.E_goal) {
    plan.vdot_paces.E_goal = '10:30';
    plan.vdot_paces.M_goal = '8:45';
    plan.vdot_paces.T_goal = '8:20';
    plan.vdot_paces.I_goal = '7:45';
    plan.vdot_paces.R_goal = '7:00';
    await savePlanMeta();
  }

  updateSubtitle();
  updatePaceChips();

  // Default: past weeks collapsed, current + future weeks expanded
  const today = new Date();
  let currentWkIndex = 0;
  for (let i = 0; i < weeks.length; i++) {
    const wk = weeks[i];
    const wStart = weekStartDate(plan.race_date, wk.week_number);
    const wEnd   = addDays(wStart, 6);
    if (wEnd >= today) {
      openWeekNumbers.add(wk.week_number); // current or future: open
    }
    if (today >= wStart && today <= wEnd) currentWkIndex = i;
  }
  // If no current week found (e.g. before plan start), open all
  if (openWeekNumbers.size === 0) weeks.forEach(w => openWeekNumbers.add(w.week_number));
  mobileWeekIndex = currentWkIndex;

  renderDesktop();
  renderMobile();

  // Mobile week nav
  document.getElementById('m-prev-week').addEventListener('click', () => {
    if (mobileWeekIndex > 0) { mobileWeekIndex--; renderMobile(); }
  });
  document.getElementById('m-next-week').addEventListener('click', () => {
    if (mobileWeekIndex < weeks.length - 1) { mobileWeekIndex++; renderMobile(); }
  });

  // Mobile swipe
  let touchStartX = 0;
  document.getElementById('m-days').addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].clientX;
  }, {passive:true});
  document.getElementById('m-days').addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) {
      if (dx < 0 && mobileWeekIndex < weeks.length - 1) { mobileWeekIndex++; renderMobile(); }
      if (dx > 0 && mobileWeekIndex > 0) { mobileWeekIndex--; renderMobile(); }
    }
  }, {passive:true});

  // Popovers open
  document.getElementById('open-plan-settings').addEventListener('click', () => {
    if (window.innerWidth <= 640) { syncSheetFromPlan(); openSheet('plan-settings'); }
    else { syncPopoverFromPlan(); openPopover('plan-settings'); }
  });
  document.getElementById('open-ramp').addEventListener('click', () => {
    if (window.innerWidth <= 640) { openSheet('ramp'); }
    else { syncRampDropdown(); openPopover('ramp'); }
  });
  document.getElementById('open-pace-editor').addEventListener('click', () => openPopover('pace-editor'));
  document.getElementById('pace-chip-group').addEventListener('click', (e) => {
    if (!e.target.classList.contains('pace-edit-btn') && !e.target.closest('.pace-edit-btn')) return;
    openPopover('pace-editor');
  });
  document.getElementById('open-api-key').addEventListener('click', () => {
    document.getElementById('apikey-input').value = localStorage.getItem('anthropic_api_key') || '';
    openPopover('apikey');
  });

  // Mobile opens
  document.getElementById('mobile-pace-strip').addEventListener('click', () => openSheet('pace-editor'));
  document.getElementById('plan-subtitle-text').closest('.plan-subtitle')
    ?.querySelector('.edit-icon')?.addEventListener('click', () => {
      if (window.innerWidth <= 640) { syncSheetFromPlan(); openSheet('plan-settings'); }
      else { syncPopoverFromPlan(); openPopover('plan-settings'); }
    });

  // Popover closes
  document.querySelectorAll('.popover-close').forEach(btn => {
    btn.addEventListener('click', () => closePopover(btn.dataset.close));
  });
  document.querySelectorAll('.popover-backdrop').forEach(bd => {
    bd.addEventListener('click', (e) => {
      if (e.target === bd) closePopover(bd.id.replace('-backdrop',''));
    });
  });

  // Sheet closes
  document.querySelectorAll('.sheet-close').forEach(btn => {
    btn.addEventListener('click', () => closeSheet(btn.dataset.closeSheet));
  });
  document.querySelectorAll('.sheet-backdrop').forEach(bd => {
    bd.addEventListener('click', (e) => {
      if (e.target === bd) {
        const name = bd.id.replace('m-','').replace('-backdrop','');
        closeSheet(name);
      }
    });
  });

  // Plan settings save (desktop)
  document.getElementById('ps-save').addEventListener('click', savePlanSettings);
  // Plan settings live-update derived fields
  ['ps-race-date','ps-num-weeks'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updatePlanSettingsDerived);
  });

  // Plan settings save (mobile)
  document.getElementById('m-ps-save').addEventListener('click', async () => {
    plan.plan_name = document.getElementById('m-ps-name').value;
    plan.race_date = document.getElementById('m-ps-race-date').value;
    plan.num_weeks = parseInt(document.getElementById('m-ps-num-weeks').value) || plan.num_weeks;
    await savePlanMeta();
    await ensureWeeksExist(plan.id, plan.num_weeks);
    const rawWeeks = await loadWeeks(plan.id);
    weeks = rawWeeks || [];
    for (const wk of weeks) if (!days[wk.id]) days[wk.id] = [];
    updateSubtitle();
    renderDesktop();
    renderMobile();
    closeSheet('plan-settings');
  });
  ['m-ps-race-date','m-ps-num-weeks'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      const rd = document.getElementById('m-ps-race-date').value;
      const nw = parseInt(document.getElementById('m-ps-num-weeks').value) || 0;
      if (rd && nw) {
        const start = addDays(parseDate(rd), -nw * 7);
        document.getElementById('m-ps-start-date').textContent = fmtDateShort(start);
        document.getElementById('m-ps-race-day').textContent   = fmtDateShort(parseDate(rd));
        document.getElementById('m-ps-week-range').textContent = `T-${nw}→T-1`;
      }
    });
  });

  // Pace editor save (desktop)
  document.getElementById('pe-save').addEventListener('click', async () => {
    for (const code of PACE_CODES) {
      plan.vdot_paces[code] = document.getElementById(`pe-${code}`).value;
      const goal = document.getElementById(`pe-${code}-goal`)?.value?.trim();
      if (goal) plan.vdot_paces[`${code}_goal`] = goal;
      else delete plan.vdot_paces[`${code}_goal`];
    }
    await savePlanMeta();
    updatePaceChips();
    closePopover('pace-editor');
  });

  // Pace editor save (mobile)
  document.getElementById('m-pe-save').addEventListener('click', async () => {
    for (const code of PACE_CODES) {
      plan.vdot_paces[code] = document.getElementById(`m-pe-${code}`).value;
    }
    await savePlanMeta();
    updatePaceChips();
    closeSheet('pace-editor');
  });

  // API key save/clear
  document.getElementById('apikey-save').addEventListener('click', () => {
    localStorage.setItem('anthropic_api_key', document.getElementById('apikey-input').value.trim());
    closePopover('apikey');
  });
  document.getElementById('apikey-clear').addEventListener('click', () => {
    localStorage.removeItem('anthropic_api_key');
    document.getElementById('apikey-input').value = '';
  });

  // Ramp apply-from dropdown — sync desktop↔mobile
  document.getElementById('m-ramp-apply-from').addEventListener('change', () => {
    document.getElementById('ramp-apply-from').value =
      document.getElementById('m-ramp-apply-from').value;
  });
  document.getElementById('ramp-apply-from').addEventListener('change', () => {
    document.getElementById('m-ramp-apply-from').value =
      document.getElementById('ramp-apply-from').value;
  });

  // Sync ramp dropdown when mobile sheet opens
  document.getElementById('open-ramp').addEventListener('click', () => {
    syncRampDropdown();
  }, true); // capture phase so it runs before the existing handler

  // Ramp generate buttons
  document.getElementById('ramp-generate').addEventListener('click', () => generateRamp('ramp'));
  document.getElementById('m-ramp-generate').addEventListener('click', () => generateRamp('m-ramp'));
});

// ────────────────────────────────────────────────
// Mileage ramp — Anthropic API
// ────────────────────────────────────────────────

async function generateRamp(prefix) {
  const startMi   = parseFloat(document.getElementById(`${prefix === 'ramp' ? '' : 'm-'}ramp-start-mi`.replace('--','-')).value);
  const peakMi    = parseFloat(document.getElementById(`${prefix === 'ramp' ? '' : 'm-'}ramp-peak-mi`.replace('--','-')).value);
  const desc      = document.getElementById(`${prefix === 'ramp' ? '' : 'm-'}ramp-description`.replace('--','-')).value.trim();
  const applyFrom = parseInt(document.getElementById(`${prefix === 'ramp' ? '' : 'm-'}ramp-apply-from`.replace('--','-')).value);

  // Resolve element IDs cleanly
  const idStart = prefix === 'ramp' ? 'ramp-start-mi'   : 'm-ramp-start-mi';
  const idPeak  = prefix === 'ramp' ? 'ramp-peak-mi'    : 'm-ramp-peak-mi';
  const idDesc  = prefix === 'ramp' ? 'ramp-description': 'm-ramp-description';
  const idFrom  = prefix === 'ramp' ? 'ramp-apply-from' : 'm-ramp-apply-from';
  const idErr   = prefix === 'ramp' ? 'ramp-error'      : 'm-ramp-error';
  const idBtn   = prefix === 'ramp' ? 'ramp-generate'   : 'm-ramp-generate';

  const startMiles = parseFloat(document.getElementById(idStart).value);
  const peakMiles  = parseFloat(document.getElementById(idPeak).value);
  const description= document.getElementById(idDesc).value.trim();
  const fromWeek   = parseInt(document.getElementById(idFrom).value);
  const errEl      = document.getElementById(idErr);
  const btnEl      = document.getElementById(idBtn);

  // Validate inputs
  errEl.classList.remove('visible');
  if (!startMiles || !peakMiles || !description || !fromWeek) {
    showRampError(errEl, 'Please fill in all fields before generating.');
    return;
  }

  const apiKey = localStorage.getItem('anthropic_api_key');
  if (!apiKey) {
    showRampError(errEl, 'No API key found. Click the key icon in the topbar to add your Anthropic API key.');
    return;
  }

  // The weeks we'll generate for: fromWeek down to 1
  const targetWeeks = weeks.filter(w => w.week_number <= fromWeek).map(w => w.week_number);
  const count = targetWeeks.length;

  btnEl.disabled = true;
  btnEl.innerHTML = '<i class="ti ti-loader" style="font-size:12px;animation:spin 0.7s linear infinite"></i> Generating…';

  const systemPrompt = `You are a marathon training planner. Given a mileage ramp description, generate weekly mileage targets.
Race is in ${count} weeks from the starting week.
Starting mileage: ${startMiles} miles/week.
Peak mileage: ${peakMiles} miles/week.
Ramp description: ${description}
Return ONLY a valid JSON array with no preamble, no markdown, no explanation:
[{"week_number": ${fromWeek}, "target_miles": ${startMiles}}, ...]
Week numbers count DOWN to 1 (race week). Generate ${count} entries from week ${fromWeek} down to week 1.`;

  let rawText = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: systemPrompt }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    rawText = data?.content?.[0]?.text || '';
  } catch (e) {
    showRampError(errEl, `Failed to reach Anthropic API: ${e.message}`);
    resetRampBtn(btnEl);
    return;
  }

  // Parse JSON — strip any accidental markdown fences
  let parsed;
  try {
    const cleaned = rawText.replace(/^```json?\s*/i, '').replace(/```\s*$/,'').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    showRampError(errEl,
      `Claude returned a response that couldn't be parsed as JSON. ` +
      `Try again or simplify your ramp description.\n\nRaw response: ${rawText.substring(0, 200)}`
    );
    resetRampBtn(btnEl);
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    showRampError(errEl, 'Claude returned an unexpected format. Expected a JSON array of {week_number, target_miles}.');
    resetRampBtn(btnEl);
    return;
  }

  // Apply targets to weeks and save
  try {
    for (const entry of parsed) {
      const wk = weeks.find(w => w.week_number === entry.week_number);
      if (wk && entry.target_miles != null) {
        wk.target_miles = parseFloat(entry.target_miles) || 0;
        await saveWeekMeta(wk);
      }
    }
  } catch (e) {
    showRampError(errEl, `Generated targets but failed to save to database: ${e.message}`);
    resetRampBtn(btnEl);
    return;
  }

  // Re-render
  renderDesktop();
  renderMobile();
  resetRampBtn(btnEl);

  if (prefix === 'ramp') closePopover('ramp');
  else closeSheet('ramp');
}

function showRampError(el, msg) {
  el.textContent = msg;
  el.classList.add('visible');
}

function resetRampBtn(btn) {
  btn.disabled = false;
  btn.innerHTML = '<i class="ti ti-wand" style="font-size:12px"></i> Generate weekly targets ↗';
}

function syncPopoverFromPlan() {
  if (!plan) return;
  document.getElementById('ps-name').value      = plan.plan_name;
  document.getElementById('ps-race-date').value = plan.race_date;
  document.getElementById('ps-num-weeks').value = plan.num_weeks;
  updatePlanSettingsDerived();
}

function syncSheetFromPlan() {
  if (!plan) return;
  document.getElementById('m-ps-name').value      = plan.plan_name;
  document.getElementById('m-ps-race-date').value = plan.race_date;
  document.getElementById('m-ps-num-weeks').value = plan.num_weeks;
  // Populate derived fields
  const start = addDays(parseDate(plan.race_date), -plan.num_weeks * 7);
  document.getElementById('m-ps-start-date').textContent = fmtDateShort(start);
  document.getElementById('m-ps-race-day').textContent   = fmtDateShort(parseDate(plan.race_date));
  document.getElementById('m-ps-week-range').textContent = `T-${plan.num_weeks}→T-1`;
}

function updatePlanSettingsDerived() {
  const rd = document.getElementById('ps-race-date').value;
  const nw = parseInt(document.getElementById('ps-num-weeks').value) || 0;
  if (rd && nw) {
    const start = addDays(parseDate(rd), -nw * 7);
    document.getElementById('ps-start-date').textContent = fmtDate(start, {month:'short', day:'numeric', year:'numeric'});
    document.getElementById('ps-race-day').textContent   = fmtDate(parseDate(rd), {month:'short', day:'numeric', year:'numeric'});
    document.getElementById('ps-week-range').textContent = `T-${nw} → T-1`;
  }
}

async function savePlanSettings() {
  plan.plan_name = document.getElementById('ps-name').value;
  plan.race_date = document.getElementById('ps-race-date').value;
  plan.num_weeks = parseInt(document.getElementById('ps-num-weeks').value) || plan.num_weeks;
  await savePlanMeta();
  await ensureWeeksExist(plan.id, plan.num_weeks);
  const rawWeeks = await loadWeeks(plan.id);
  weeks = rawWeeks || [];
  for (const wk of weeks) if (!days[wk.id]) days[wk.id] = [];
  updateSubtitle();
  renderDesktop();
  renderMobile();
  closePopover('plan-settings');
}

function syncRampDropdown() {
  const sel  = document.getElementById('ramp-apply-from');
  const msel = document.getElementById('m-ramp-apply-from');
  sel.innerHTML  = '';
  msel.innerHTML = '';
  const firstOpen = [...openWeekNumbers][0] ?? null;
  for (const wk of weeks) {
    const label = `Week T-${wk.week_number}${openWeekNumbers.has(wk.week_number) ? ' (open)' : ''}`;
    sel.add(new Option(label, wk.week_number));
    msel.add(new Option(label, wk.week_number));
  }
  if (firstOpen) {
    sel.value  = firstOpen;
    msel.value = firstOpen;
  }
}
