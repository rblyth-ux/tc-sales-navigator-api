/* All numbers computed live from GHL + Meta on every request. No cache,
   no database -- simplest thing that works for one person checking a
   dashboard a few times a day. */

import { fetchAdInsights } from './meta.js';
import { fetchAppointmentsWithContacts } from './ghl.js';

const SHOWED_LIKE = ['show', 'sale', 'disqualified'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function getFunnelMetrics(cfg, rangeDays) {
  const now = Date.now();
  const startMs = now - rangeDays * 86400000;

  const [adRows, appts] = await Promise.all([
    fetchAdInsights(cfg, { since: isoDate(startMs), until: isoDate(now) }),
    fetchAppointmentsWithContacts(cfg, { startMs, endMs: now }),
  ]);

  const spend = adRows.reduce((s, a) => s + a.spend, 0);
  const leads = adRows.reduce((s, a) => s + a.leads, 0) || 1;
  const booked = appts.length || 1;
  const shows = appts.filter((a) => SHOWED_LIKE.includes(a.outcome)).length || 1;
  const sales = appts.filter((a) => a.outcome === 'sale').length;

  const dayTotals = {};
  for (const a of appts) {
    const dow = new Date(a.startTime).getDay();
    dayTotals[dow] = dayTotals[dow] || { booked: 0, shows: 0 };
    dayTotals[dow].booked++;
    if (SHOWED_LIKE.includes(a.outcome)) dayTotals[dow].shows++;
  }
  const dayRates = [1, 2, 3, 4, 5, 6, 0].map((d) => ({
    day: DAY_NAMES[d],
    rate: dayTotals[d] && dayTotals[d].booked ? dayTotals[d].shows / dayTotals[d].booked : 0,
  }));

  const reasonCounts = {};
  for (const a of appts) {
    if (a.outcome === 'no_show' || a.outcome === 'disqualified') {
      if (a.lossReason) reasonCounts[a.lossReason] = (reasonCounts[a.lossReason] || 0) + 1;
    }
  }
  const lossReasons = Object.entries(reasonCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  return {
    spend,
    leads: adRows.reduce((s, a) => s + a.leads, 0),
    booked: appts.length,
    shows: appts.filter((a) => SHOWED_LIKE.includes(a.outcome)).length,
    sales,
    costPerLead: spend / leads,
    costPerBookedCall: spend / booked,
    costPerShow: spend / shows,
    costPerSale: spend / (sales || 1),
    dayRates,
    lossReasons,
  };
}

export async function getAdMetrics(cfg, rangeDays) {
  const now = Date.now();
  const startMs = now - rangeDays * 86400000;

  const [adRows, appts] = await Promise.all([
    fetchAdInsights(cfg, { since: isoDate(startMs), until: isoDate(now) }),
    fetchAppointmentsWithContacts(cfg, { startMs, endMs: now }),
  ]);

  const byAd = {};
  for (const a of adRows) byAd[a.adId] = { ...a, booked: 0, shows: 0, sales: 0 };
  for (const appt of appts) {
    if (!appt.adId || !byAd[appt.adId]) continue;
    byAd[appt.adId].booked++;
    if (SHOWED_LIKE.includes(appt.outcome)) byAd[appt.adId].shows++;
    if (appt.outcome === 'sale') byAd[appt.adId].sales++;
  }

  return Object.values(byAd).map((a) => ({
    id: a.adId,
    name: a.name,
    campaign: a.campaign,
    spend: a.spend,
    leads: a.leads,
    booked: a.booked,
    shows: a.shows,
    sales: a.sales,
    costPerLead: a.leads ? a.spend / a.leads : 0,
    showRate: a.booked ? a.shows / a.booked : 0,
    closeRate: a.shows ? a.sales / a.shows : 0,
    costPerSale: a.sales ? a.spend / a.sales : 0,
  }));
}

export async function getAppointmentsSplit(cfg) {
  const now = Date.now();
  const [upcoming, recent] = await Promise.all([
    fetchAppointmentsWithContacts(cfg, { startMs: now, endMs: now + 14 * 86400000 }),
    fetchAppointmentsWithContacts(cfg, { startMs: now - 7 * 86400000, endMs: now }),
  ]);

  const shape = (a) => ({ id: a.id, contactId: a.contactId, startTime: a.startTime, adName: a.calendarName, contactName: a.contactName, outcome: a.outcome });

  return {
    upcoming: upcoming.filter((a) => !a.outcome).sort((a, b) => new Date(a.startTime) - new Date(b.startTime)).slice(0, 30).map(shape),
    recent: recent.filter((a) => a.outcome).sort((a, b) => new Date(b.startTime) - new Date(a.startTime)).slice(0, 20).map(shape),
  };
}
