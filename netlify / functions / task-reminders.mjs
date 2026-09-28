// Dagelijkse takenmail — draait elk uur (om :05) en mailt elke gebruiker
// op het tijdstip dat hij zelf koos (Brusselse tijd, standaard 07:00).
// Leest alleen uit Supabase; schrijft niets weg.
import {
  brusselsNow, fetchRows, groupWorkspaces, recipientsFor, buildDigest,
  shouldSend, renderDigestEmail, sendResend,
} from '../lib/task-digest.mjs';

export default async () => {
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) {
    console.error('task-reminders: SUPABASE_SERVICE_ROLE_KEY is not set');
    return new Response('missing SUPABASE_SERVICE_ROLE_KEY', { status: 500 });
  }

  const now = brusselsNow();
  const summary = { at: now, sent: [], skipped: 0, errors: [] };

  let workspaces;
  try {
    workspaces = groupWorkspaces(await fetchRows({ apikey: service, bearer: service }));
  } catch (e) {
    console.error('task-reminders: read failed', e);
    return new Response(String(e.message || e), { status: 500 });
  }

  for (const ws of Object.values(workspaces)) {
    for (const email of recipientsFor(ws)) {
      const d = buildDigest(ws, email, now.today);
      if (d.prefs.enabled === false) { summary.skipped++; continue; }
      if (Number(d.prefs.hour || 7) !== now.hour) continue;
      if (!shouldSend(d, now.weekday)) { summary.skipped++; continue; }
      try {
        const mail = renderDigestEmail(d, ws.companies);
        await sendResend({ to: email, ...mail });
        summary.sent.push({ ws: ws.id, to: email, late: d.late.length, today: d.now.length, week: d.week.length });
      } catch (e) {
        console.error('task-reminders: send failed', email, e);
        summary.errors.push({ to: email, error: String(e.message || e) });
      }
    }
  }

  console.log('task-reminders', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '5 * * * *' };
