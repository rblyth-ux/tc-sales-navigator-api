/* Meta Marketing API helpers.
   Docs: https://developers.facebook.com/docs/marketing-api/insights
   Auth: long-lived system-user access token scoped to ads_read. */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export async function metaPing(env) {
  if (!env.META_ACCESS_TOKEN || !env.META_AD_ACCOUNT_ID) return false;
  try {
    const url = `${GRAPH_BASE}/${env.META_AD_ACCOUNT_ID}?fields=name&access_token=${env.META_ACCESS_TOKEN}`;
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

/** Ad-level spend + lead counts for a date range (YYYY-MM-DD). */
export async function fetchAdInsights(env, { since, until }) {
  const fields = ['ad_id', 'ad_name', 'campaign_name', 'adset_name', 'spend', 'actions'].join(',');
  const url = new URL(`${GRAPH_BASE}/${env.META_AD_ACCOUNT_ID}/insights`);
  url.searchParams.set('level', 'ad');
  url.searchParams.set('fields', fields);
  url.searchParams.set('time_range', JSON.stringify({ since, until }));
  url.searchParams.set('access_token', env.META_ACCESS_TOKEN);

  const results = [];
  let next = url.toString();
  while (next) {
    const res = await fetch(next);
    if (!res.ok) throw new Error(`Meta insights fetch failed: ${res.status}`);
    const data = await res.json();
    for (const row of data.data || []) {
      const leadAction = (row.actions || []).find((a) => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead');
      results.push({
        adId: row.ad_id,
        name: row.ad_name,
        campaign: row.campaign_name,
        adset: row.adset_name,
        spend: parseFloat(row.spend || '0'),
        leads: leadAction ? parseInt(leadAction.value, 10) : 0,
      });
    }
    next = data.paging && data.paging.next ? data.paging.next : null;
  }
  return results;
}

/** Ad thumbnail — separate call since insights doesn't return creative assets. */
export async function fetchAdThumbnail(env, adId) {
  try {
    const url = `${GRAPH_BASE}/${adId}?fields=creative{thumbnail_url}&access_token=${env.META_ACCESS_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.creative?.thumbnail_url || null;
  } catch {
    return null;
  }
}
