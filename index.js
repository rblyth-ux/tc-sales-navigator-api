/* TC Sales Navigator -- Cloudflare Worker API.
   No database, no cron, no backups -- every read pulls live from GHL and
   Meta; the only thing persisted here is whatever Rob pastes into Settings
   (in a KV namespace), gated by a passphrase set on first save. */

import { ghlPing, pushOutcomeToGhl , listCalendars, fetchEventsForCalendar } from './ghl.js';
import { metaPing } from './meta.js';
import { getFunnelMetrics, getAdMetrics, getAppointmentsSplit } from './metrics.js';
import { resolveCredentials, getConfigStatus, applyConfigUpdate } from './config.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...(init.headers || {}) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/status' && request.method === 'GET') {
        const cfg = await resolveCredentials(env);
        const [ghl, meta] = await Promise.all([ghlPing(cfg), metaPing(cfg)]);
        return json({ ghl, ghlCalendar: ghl, meta });
      }

               if (path === '/api/debug/calendars' && request.method === 'GET') {
                            const cfg = await resolveCredentials(env);
                            return json({ calendars: await listCalendars(cfg) });
               }

               if (path === '/api/debug/events' && request.method === 'GET') {
                            const cfg = await resolveCredentials(env);
                            const days = Number(url.searchParams.get('days') || 90);
                            const calendarId = url.searchParams.get('calendarId') || cfg.GHL_CALENDAR_ID || '';
                            const now = Date.now();
                            const events = await fetchEventsForCalendar(cfg, { startMs: now - days * 86400000, endMs: now + days * 86400000, calendarId });
                            return json({ calendarId, count: events.length, events });
               }

      if (path === '/api/config' && request.method === 'GET') {
        return json(await getConfigStatus(env));
      }

      if (path === '/api/config' && request.method === 'POST') {
        const body = await request.json();
        const result = await applyConfigUpdate(env, body);
        return json(result, { status: result.ok ? 200 : 400 });
      }

      if (path === '/api/metrics' && request.method === 'GET') {
        const cfg = await resolveCredentials(env);
        const range = Number(url.searchParams.get('range') || 30);
        return json(await getFunnelMetrics(cfg, range));
      }

      if (path === '/api/metrics/ads' && request.method === 'GET') {
        const cfg = await resolveCredentials(env);
        const range = Number(url.searchParams.get('range') || 30);
        return json({ ads: await getAdMetrics(cfg, range) });
      }

      if (path === '/api/appointments' && request.method === 'GET') {
        const cfg = await resolveCredentials(env);
        return json(await getAppointmentsSplit(cfg));
      }

      if (path === '/api/outcome' && request.method === 'POST') {
        const body = await request.json();
        if (!body.appointmentId || !body.outcome) return json({ error: 'appointmentId and outcome required' }, { status: 400 });
        const cfg = await resolveCredentials(env);
        await pushOutcomeToGhl(cfg, {
          appointmentId: body.appointmentId,
          contactId: body.contactId,
          outcome: body.outcome,
          reason: body.reason,
        });
        return json({ ok: true });
      }

      return json({ error: 'not found' }, { status: 404 });
    } catch (err) {
      return json({ error: String(err) }, { status: 500 });
    }
  },
};
