// Gedeelde logica voor de dagelijkse takenmail van Biddly Billing.
// Leest uitsluitend uit Supabase (workspace_data) en schrijft nergens naar.

const TZ = 'Europe/Brussels';
export const APP_URL = process.env.APP_URL || 'https://app.biddly.be';
export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nwpjvnjtqmrohyykrhdh.supabase.co';
// De publishable key staat ook al publiek in index.html; enkel nodig voor de testmail.
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_K03VAdwJo2Gt5N00ACogHA_Y0U85wv6';

const KEYS = ['tasks', 'client_tasks', 'clients', 'companies', 'team_members', 'notify_prefs'];

export const DEFAULT_PREFS = {
  enabled: true, alwaysSend: false, hour: 7, mutedCompanies: [], includeTeam: false, includeClientTasks: true, lang: 'en',
};

const norm = e => String(e || '').trim().toLowerCase();
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Huidige datum, uur en weekdag in Brussel (zomer- en wintertijd correct).
export function brusselsNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(date).map(p => [p.type, p.value]),
  );
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10), weekday: parts.weekday };
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dayDiff(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}

// ── Supabase lezen ──
export async function fetchRows({ apikey, bearer, workspace }) {
  let q = `${SUPABASE_URL}/rest/v1/workspace_data?select=workspace_id,key,value&key=in.(${KEYS.join(',')})`;
  if (workspace) q += `&workspace_id=eq.${encodeURIComponent(workspace)}`;
  const res = await fetch(q, {
    headers: { apikey, Authorization: 'Bearer ' + bearer, 'Range-Unit': 'items', Range: '0-49999' },
  });
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

export function groupWorkspaces(rows) {
  const out = {};
  (rows || []).forEach(r => {
    const ws = out[r.workspace_id] = out[r.workspace_id] ||
      { id: r.workspace_id, tasks: [], clientTasks: [], clients: [], companies: [], team: [], prefs: {} };
    const v = r.value;
    if (r.key === 'tasks' && Array.isArray(v)) ws.tasks = v;
    else if (r.key === 'client_tasks' && Array.isArray(v)) ws.clientTasks = v;
    else if (r.key === 'clients' && Array.isArray(v)) ws.clients = v;
    else if (r.key === 'companies' && Array.isArray(v)) ws.companies = v;
    else if (r.key === 'team_members' && Array.isArray(v)) ws.team = v;
    else if (r.key === 'notify_prefs' && v && typeof v === 'object') {
      Object.keys(v).forEach(k => { ws.prefs[norm(k)] = v[k]; });
    }
  });
  return out;
}

// ── Wie krijgt een mail, en wat staat erin ──
function roleOf(email, ws, prefs) {
  const m = (ws.team || []).find(x => norm(x.email) === email);
  if (m) return m.role === 'staff' ? 'staff' : 'owner';
  return prefs && prefs.role === 'staff' ? 'staff' : 'owner';
}

export function recipientsFor(ws) {
  const set = new Set(Object.keys(ws.prefs || {}).map(norm));
  (ws.tasks || []).forEach(t => { if (t && t.assignee) set.add(norm(t.assignee)); });
  set.delete('');
  return [...set];
}

export function buildDigest(ws, email, today, prefsOverride) {
  email = norm(email);
  const p = Object.assign({}, DEFAULT_PREFS, (ws.prefs || {})[email] || {}, prefsOverride || {});
  const role = roleOf(email, ws, p);
  const muted = new Set(p.mutedCompanies || []);
  const weekEnd = addDays(today, 6);
  const items = [];
  const recurring = [];

  (ws.tasks || []).forEach(t => {
    // Overzicht van alle terugkerende taken van deze persoon, ook die ver in de toekomst liggen.
    if (t && !t.done && t.recur && t.recur !== 'none') {
      const a0 = norm(t.assignee);
      const mine0 = a0 === email || (!a0 && role === 'owner') || (role === 'owner' && p.includeTeam);
      if (mine0 && !(t.company && muted.has(t.company)) && !(t.due && t.due <= weekEnd)) {
        recurring.push({ title: t.title || '', due: t.due || '', company: t.company || '', recur: t.recur });
      }
    }

    if (!t || t.done || !t.due || t.due > weekEnd) return;
    const a = norm(t.assignee);
    const mine = a === email || (!a && role === 'owner') || (role === 'owner' && p.includeTeam);
    if (!mine) return;
    if (t.company && muted.has(t.company)) return;
    items.push({
      title: t.title || '', due: t.due, company: t.company || '',
      assignee: a && a !== email ? a : '', recur: t.recur || 'none', priority: t.priority || 'normal',
    });
  });

  if (role === 'owner' && p.includeClientTasks !== false) {
    (ws.clientTasks || []).forEach(t => {
      if (!t || t.done || !t.due || t.due > weekEnd) return;
      const c = (ws.clients || []).find(x => x.id === t.clientId);
      items.push({ title: t.text || '', due: t.due, company: '__clients__', client: c ? c.name : '', recur: 'none' });
    });
  }

  items.sort((a, b) => a.due.localeCompare(b.due));
  return {
    email, role, prefs: p, today,
    lang: ['fr', 'nl'].includes(p.lang) ? p.lang : 'en',
    late: items.filter(i => i.due < today),
    now: items.filter(i => i.due === today),
    week: items.filter(i => i.due > today),
    recurring: recurring.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'))),
  };
}

// Dagelijkse regel: enkel mailen als er iets te laat is of vandaag moet.
// Op maandag ook als er alleen iets in de komende week staat (weekoverzicht).
export function shouldSend(d, weekday) {
  if (d.prefs && d.prefs.alwaysSend) return true;   // gebruiker wil elke dag een mail
  return d.late.length > 0 || d.now.length > 0 || (weekday === 'Mon' && d.week.length > 0);
}

// ── Opmaak ──
const L = {
  en: {
    late: 'Late', today: 'Today', week: 'Next 7 days', dayLate: 'day late', daysLate: 'days late',
    none: 'No company', clients: 'Client follow-up', open: 'Open Biddly', hello: 'Good morning',
    intro: 'Here are your tasks.', allClear: 'Nothing is late or due this week. 👍',
    recurTitle: 'Recurring tasks', next: 'next', noDate: 'no date',
    recur: { daily: 'daily', weekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly' },
    subjCounts: (l, t) => `Biddly: ${[l && `${l} late`, t && `${t} today`].filter(Boolean).join(', ')}`,
    subjWeek: 'Biddly: your tasks this week', test: 'Test e-mail — this is what your daily reminder looks like.',
    footer: 'You receive this because e-mail reminders are on in Biddly (Tasks → E-mail reminders).',
    locale: 'en-GB',
  },
  fr: {
    late: 'En retard', today: "Aujourd'hui", week: '7 prochains jours', dayLate: 'jour de retard', daysLate: 'jours de retard',
    none: 'Sans société', clients: 'Suivi clients', open: 'Ouvrir Biddly', hello: 'Bonjour',
    intro: 'Voici vos tâches.', allClear: 'Rien en retard ni prévu cette semaine. 👍',
    recurTitle: 'Tâches récurrentes', next: 'prochaine', noDate: 'sans date',
    recur: { daily: 'quotidienne', weekly: 'hebdomadaire', monthly: 'mensuelle', quarterly: 'trimestrielle', yearly: 'annuelle' },
    subjCounts: (l, t) => `Biddly : ${[l && `${l} en retard`, t && `${t} aujourd'hui`].filter(Boolean).join(', ')}`,
    subjWeek: 'Biddly : vos tâches de la semaine', test: 'E-mail de test — voici à quoi ressemble votre rappel quotidien.',
    footer: 'Vous recevez ce message car les rappels par e-mail sont activés dans Biddly (Tâches → Rappels par e-mail).',
    locale: 'fr-BE',
  },
  nl: {
    late: 'Te laat', today: 'Vandaag', week: 'Komende 7 dagen', dayLate: 'dag te laat', daysLate: 'dagen te laat',
    none: 'Geen bedrijf', clients: 'Klantopvolging', open: 'Biddly openen', hello: 'Goedemorgen',
    intro: 'Dit zijn je taken.', allClear: 'Niets te laat en niets gepland deze week. 👍',
    recurTitle: 'Terugkerende taken', next: 'volgende', noDate: 'geen datum',
    recur: { daily: 'dagelijks', weekly: 'wekelijks', monthly: 'maandelijks', quarterly: 'per kwartaal', yearly: 'jaarlijks' },
    subjCounts: (l, t) => `Biddly: ${[l && `${l} te laat`, t && `${t} vandaag`].filter(Boolean).join(', ')}`,
    subjWeek: 'Biddly: je taken deze week', test: 'Testmail — zo ziet je dagelijkse herinnering eruit.',
    footer: 'Je ontvangt dit omdat e-mailmeldingen aan staan in Biddly (Taken → E-mailmeldingen).',
    locale: 'nl-BE',
  },
};

export function renderDigestEmail(d, companies, { test = false } = {}) {
  const t = L[d.lang] || L.en;
  const compName = id => id === '__clients__' ? t.clients
    : id ? ((companies || []).find(c => c.id === id) || {}).name || '—' : t.none;
  const compColor = id => ((companies || []).find(c => c.id === id) || {}).color || '#cbd5e1';

  const dueText = i => {
    if (i.due < d.today) { const n = dayDiff(d.today, i.due); return `${n} ${n === 1 ? t.dayLate : t.daysLate}`; }
    if (i.due === d.today) return t.today;
    const [y, m, dd] = i.due.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString(t.locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  const section = (title, list, accent) => {
    if (!list.length) return '';
    const groups = {};
    list.forEach(i => { (groups[i.company] = groups[i.company] || []).push(i); });
    const blocks = Object.keys(groups).sort((a, b) => {
      if (a === '__clients__') return 1; if (b === '__clients__') return -1;
      if (!a) return 1; if (!b) return -1;
      return compName(a).localeCompare(compName(b));
    }).map(cid => `
      <tr><td style="padding:12px 0 4px;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#94a3b8">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${compColor(cid)};margin-right:6px"></span>${esc(compName(cid))}
      </td></tr>
      ${groups[cid].map(i => `
      <tr><td style="padding:7px 0;border-top:1px solid #f1f5f9;font-size:14px;color:#0f172a">
        <strong>${esc(i.title)}</strong>
        ${i.client ? `<span style="color:#64748b"> · ${esc(i.client)}</span>` : ''}
        ${i.recur && i.recur !== 'none' ? `<span style="color:#7c3aed;font-size:12px"> ↻ ${esc(t.recur[i.recur] || i.recur)}</span>` : ''}
        ${i.assignee ? `<span style="color:#64748b;font-size:12px"> · ${esc(i.assignee)}</span>` : ''}
        <div style="font-size:12px;color:${accent};margin-top:2px">${esc(dueText(i))}</div>
      </td></tr>`).join('')}`).join('');
    return `
      <tr><td style="padding:22px 0 2px;font-size:15px;font-weight:800;color:${accent}">${esc(title)} (${list.length})</td></tr>
      ${blocks}`;
  };

  const longDate = iso => {
    if (!iso) return t.noDate;
    const [y, m, dd] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString(t.locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const rec = d.recurring || [];
  const recurHtml = rec.length ? `
      <tr><td style="padding:24px 0 4px;font-size:13px;font-weight:800;color:#7c3aed">↻ ${esc(t.recurTitle)} (${rec.length})</td></tr>
      ${rec.map(i => `
      <tr><td style="padding:6px 0;border-top:1px solid #f1f5f9;font-size:13px;color:#334155">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${compColor(i.company)};margin-right:6px"></span>${esc(i.title)}
        <span style="color:#7c3aed;font-size:12px"> · ${esc(t.recur[i.recur] || i.recur)}</span>
        <span style="color:#64748b;font-size:12px"> · ${esc(t.next)}: ${esc(longDate(i.due))}</span>
      </td></tr>`).join('')}` : '';

  const empty = !d.late.length && !d.now.length && !d.week.length;
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;border-top:4px solid #15803d;padding:26px 28px">
    ${test ? `<tr><td style="background:#eff6ff;color:#1d4ed8;font-size:12px;padding:8px 12px;border-radius:8px">${esc(t.test)}</td></tr>` : ''}
    <tr><td style="padding-top:${test ? 16 : 0}px;font-size:20px;font-weight:800;color:#0f172a">${esc(t.hello)},</td></tr>
    <tr><td style="font-size:14px;color:#475569;padding-top:4px">${esc(empty ? t.allClear : t.intro)}</td></tr>
    ${section(t.late, d.late, '#b91c1c')}
    ${section(t.today, d.now, '#b45309')}
    ${section(t.week, d.week, '#475569')}
    ${recurHtml}
    <tr><td style="padding-top:26px"><a href="${APP_URL}" style="display:inline-block;background:#15803d;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:8px">${esc(t.open)}</a></td></tr>
    <tr><td style="padding-top:22px;font-size:11px;color:#94a3b8;line-height:1.5">${esc(t.footer)}</td></tr>
  </table></td></tr></table></body></html>`;

  const textSection = (title, list) => list.length
    ? `\n${title}\n` + list.map(i => `- ${i.title}${i.client ? ' · ' + i.client : ''} [${compName(i.company)}] — ${dueText(i)}`).join('\n') + '\n'
    : '';
  const text = `${t.hello},\n\n${empty ? t.allClear : t.intro}\n` +
    textSection(t.late, d.late) + textSection(t.today, d.now) + textSection(t.week, d.week) +
    (rec.length ? `\n${t.recurTitle}\n` + rec.map(i => `- ${i.title} [${compName(i.company)}] — ${t.recur[i.recur] || i.recur}, ${t.next}: ${longDate(i.due)}`).join('\n') + '\n' : '') +
    `\n${t.open}: ${APP_URL}\n`;

  const subject = (test ? '[Test] ' : '') +
    ((d.late.length || d.now.length) ? t.subjCounts(d.late.length, d.now.length) : t.subjWeek);
  return { subject, html, text };
}

// ── Versturen via Resend ──
export async function sendResend({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set in Netlify');
  // Zelfde afzender als de bestaande send-email (EMAIL_FROM), tenzij REMINDER_FROM apart is gezet.
  const from = process.env.REMINDER_FROM || process.env.EMAIL_FROM || 'Biddly <no-reply@biddly.be>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (data.message || data.error || 'unknown error'));
  return data;
}
