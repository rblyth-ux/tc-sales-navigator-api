/* GoHighLevel API helpers (LeadConnector v2 REST API).
   Docs: https://highlevel.stoplight.io/docs/integrations
   Auth: private integration / API key as Bearer token, plus locationId.

   No local database -- every read hits GHL live. Outcomes set in this app
   are written back onto the contact as custom fields (source of truth stays
   in GHL), plus the native appointment status so GHL's own calendar UI
   reflects it too. */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

function ghlHeaders(env) {
     return {
            Authorization: `Bearer ${env.GHL_API_KEY}`,
            Version: GHL_VERSION,
            'Content-Type': 'application/json',
     };
}

function outcomeFieldKey(env) {
     return env.GHL_OUTCOME_FIELD_KEY || 'tcsn_outcome';
}
function lossReasonFieldKey(env) {
     return env.GHL_LOSS_REASON_FIELD_KEY || 'tcsn_loss_reason';
}
function adIdFieldKey(env) {
     return env.GHL_AD_ID_FIELD_KEY || 'ad_id';
}

export async function ghlPing(env) {
     if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) return false;
     try {
            const res = await fetch(`${GHL_BASE}/locations/${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
            return res.ok;
     } catch {
            return false;
     }
}

export async function listCalendars(env) {
     if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) return [];
     const url = new URL(`${GHL_BASE}/calendars/`);
     url.searchParams.set('locationId', env.GHL_LOCATION_ID);
     const res = await fetch(url, { headers: ghlHeaders(env) });
     if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`GHL calendars fetch failed: ${res.status} ${errText}`);
     }
     const data = await res.json();
     return (data.calendars || []).map((c) => ({ id: c.id, name: c.name }));
}

/** Pull calendar events in a window. GHL's v2 calendars/events endpoint wants
   *  startTime/endTime as ISO-8601 strings, plus exactly one of
      *  calendarId/groupId/userId. If GHL_CALENDAR_ID isn't set we fetch every
         *  calendar on the location and merge results, so no appointments get
            *  missed just because they're on a different calendar. */
  async function fetchEventsForCalendar(env, { startMs, endMs, calendarId, userId }) {
         const url = new URL(`${GHL_BASE}/calendars/events`);
         url.searchParams.set('locationId', env.GHL_LOCATION_ID);
         url.searchParams.set('startTime', new Date(startMs).toISOString());
         url.searchParams.set('endTime', new Date(endMs).toISOString());
         if (calendarId) url.searchParams.set('calendarId', calendarId);
         if (userId) url.searchParams.set('userId', userId);
         const res = await fetch(url, { headers: ghlHeaders(env) });
         if (!res.ok) {
                  const errText = await res.text().catch(() => '');
                  throw new Error(`GHL appointments fetch failed: ${res.status} ${errText}`);
         }
         const data = await res.json();
         return data.events || [];
  }

  async function fetchAppointments(env, { startMs, endMs }) {
         if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) return [];
         if (env.GHL_CALENDAR_ID || env.GHL_USER_ID) {
                  return fetchEventsForCalendar(env, { startMs, endMs, calendarId: env.GHL_CALENDAR_ID, userId: env.GHL_USER_ID });
         }
         const calendars = await listCalendars(env);
         if (!calendars.length) return [];
const results = [];
         for (const c of calendars) {
                  results.push(await fetchEventsForCalendar(env, { startMs, endMs, calendarId: c.id }));
         }
         const seen = new Set();
         const merged = [];
         for (const events of results) {
                  for (const evt of events) {
                             if (evt.id && seen.has(evt.id)) continue;
                             if (evt.id) seen.add(evt.id);
                             merged.push(evt);
                  }
         }
         return merged;
  }

function readCustomField(contact, key) {
     const f = (contact.customFields || []).find((cf) => cf.key === key || cf.id === key);
     return f ? f.value : null;
}

async function fetchContact(env, contactId) {
     const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders(env) });
     if (!res.ok) return null;
     const data = await res.json();
     const c = data.contact;
     if (!c) return null;
     return {
            id: c.id,
            name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || c.email || c.phone,
            phone: c.phone,
            email: c.email,
            adId: readCustomField(c, adIdFieldKey(env)),
            outcome: readCustomField(c, outcomeFieldKey(env)),
            lossReason: readCustomField(c, lossReasonFieldKey(env)),
     };
}

const APPT_STATUS_FALLBACK = { showed: 'show', noshow: 'no_show', cancelled: 'reschedule' };

/** Appointments in a window, each resolved with its contact (attribution +
 *  outcome). This is the one live call the whole dashboard is built on. */
export async function fetchAppointmentsWithContacts(env, { startMs, endMs }) {
     const events = await fetchAppointments(env, { startMs, endMs });
     const withContacts = await Promise.all(
            events.map(async (evt) => {
                     const contact = evt.contactId ? await fetchContact(env, evt.contactId) : null;
                     const outcome = contact?.outcome || APPT_STATUS_FALLBACK[evt.appointmentStatus] || null;
                     return {
                                id: evt.id,
                                contactId: evt.contactId,
                                startTime: evt.startTime,
                                calendarName: evt.calendarName || evt.title,
                                adId: contact?.adId || null,
                                contactName: contact?.name || 'Unknown',
                                outcome,
                                lossReason: contact?.lossReason || null,
                     };
            })
          );
     return withContacts;
}

/** Write a call outcome back onto the contact (source of truth) and the
 *  native appointment status (so GHL's own calendar reflects it too). */
export async function pushOutcomeToGhl(env, { appointmentId, contactId, outcome, reason }) {
     const statusMap = { show: 'showed', no_show: 'noshow', sale: 'showed', reschedule: 'cancelled', disqualified: 'showed' };

  await fetch(`${GHL_BASE}/calendars/events/appointments/${appointmentId}`, {
         method: 'PUT',
         headers: ghlHeaders(env),
         body: JSON.stringify({ appointmentStatus: statusMap[outcome] || 'confirmed' }),
  });

  if (contactId) {
         const customField = [{ key: outcomeFieldKey(env), field_value: outcome }];
         if (reason) customField.push({ key: lossReasonFieldKey(env), field_value: reason });
         await fetch(`${GHL_BASE}/contacts/${contactId}`, {
                  method: 'PUT',
                  headers: ghlHeaders(env),
                  body: JSON.stringify({ customFields: customField }),
         });

       await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
                method: 'POST',
                headers: ghlHeaders(env),
                body: JSON.stringify({ body: `TC Sales Navigator — outcome: ${outcome}${reason ? `. Reason: ${reason}` : ''}` }),
       });
  }
}
