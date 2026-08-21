exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'RESEND_API_KEY is not configured in the Netlify environment variables.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const { to, subject, html, text, replyTo, fromName, fromEmail, attachments } = body;

  if (!to) return json(400, { error: 'No recipient address supplied.' });
  if (!subject) return json(400, { error: 'No subject supplied.' });

  const sender = (fromEmail || process.env.DEFAULT_FROM_EMAIL || '').trim();
  if (!sender) {
    return json(400, { error: 'No sender address configured. Set it in Settings, or set DEFAULT_FROM_EMAIL.' });
  }

  const payload = {
    from: fromName ? `${fromName} <${sender}>` : sender,
    to: Array.isArray(to) ? to : [to],
    subject,
  };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;

  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments
      .filter(a => a && a.filename && a.content)
      .map(a => ({ filename: a.filename, content: a.content }));
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (e) {}

    if (!resp.ok) {
      const detail = (data && (data.message || data.error)) || raw.slice(0, 300) || 'Unknown error from Resend.';
      return json(resp.status, { error: `Resend: ${detail}` });
    }

    return json(200, { id: data.id || '', ok: true });
  } catch (err) {
    return json(502, { error: `Could not reach Resend: ${err.message}` });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
