// Testmail vanuit de app (Taken → E-mailmeldingen → Nu een testmail sturen).
// Stuurt alleen naar het e-mailadres van de ingelogde gebruiker zelf en leest
// met diens eigen sessie, dus Supabase-RLS bepaalt wat zichtbaar is.
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, brusselsNow, fetchRows, groupWorkspaces,
  buildDigest, renderDigestEmail, sendResend,
} from '../lib/task-digest.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Not signed in' }, 401);

  // Wie is dit? Rechtstreeks bij Supabase nagaan, niet vertrouwen op wat de browser zegt.
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
  });
  if (!who.ok) return json({ error: 'Session expired — sign in again' }, 401);
  const user = await who.json();
  const email = String(user.email || '').toLowerCase();
  if (!email) return json({ error: 'No e-mail on this account' }, 400);

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const workspace = body.workspace;
  if (!workspace) return json({ error: 'Missing workspace' }, 400);

  try {
    const rows = await fetchRows({ apikey: SUPABASE_ANON_KEY, bearer: token, workspace });
    const ws = groupWorkspaces(rows)[workspace] ||
      { id: workspace, tasks: [], clientTasks: [], clients: [], companies: [], team: [], prefs: {} };
    // De voorkeuren uit het venster gebruiken, ook als ze nog niet gesynct zijn.
    const prefs = body.prefs && typeof body.prefs === 'object' ? body.prefs : undefined;
    const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || '') ? body.today : brusselsNow().today;
    const d = buildDigest(ws, email, today, prefs);
    const mail = renderDigestEmail(d, ws.companies, { test: true });
    const sent = await sendResend({ to: email, ...mail });
    return json({ ok: true, to: email, id: sent.id, late: d.late.length, today: d.now.length, week: d.week.length });
  } catch (e) {
    console.error('task-digest-test', e);
    return json({ error: String(e.message || e) }, 500);
  }
};
