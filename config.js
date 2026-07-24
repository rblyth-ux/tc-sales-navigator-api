/* Settings-tab config, backed by a single Workers KV namespace.
   No database, no billing add-on -- just a JSON blob holding whatever
   Rob pasted into Settings, gated by a passphrase created on first save. */

const SECRET_KEYS = [
  'GHL_API_KEY',
  'GHL_LOCATION_ID',
  'META_ACCESS_TOKEN',
  'META_AD_ACCOUNT_ID',
  'GHL_AD_ID_FIELD_KEY',
  'GHL_LOSS_REASON_FIELD_KEY',
];

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getConfig(env) {
  const raw = await env.CONFIG_KV.get('config');
  return raw ? JSON.parse(raw) : {};
}

async function saveConfig(env, obj) {
  await env.CONFIG_KV.put('config', JSON.stringify(obj));
}

export async function resolveCredentials(env) {
  const cfg = await getConfig(env);
  const merged = { ...env };
  for (const key of SECRET_KEYS) {
    if (cfg[key]) merged[key] = cfg[key];
  }
  return merged;
}

function mask(v) {
  return v ? `****${String(v).slice(-4)}` : null;
}

export async function getConfigStatus(env) {
  const cfg = await getConfig(env);
  const val = (key) => cfg[key] || env[key] || null;
  return {
    passphraseSet: !!cfg.ADMIN_PASSPHRASE_HASH,
    fields: {
      GHL_API_KEY: mask(val('GHL_API_KEY')),
      GHL_LOCATION_ID: val('GHL_LOCATION_ID'),
      META_ACCESS_TOKEN: mask(val('META_ACCESS_TOKEN')),
      META_AD_ACCOUNT_ID: val('META_AD_ACCOUNT_ID'),
      GHL_AD_ID_FIELD_KEY: val('GHL_AD_ID_FIELD_KEY'),
      GHL_LOSS_REASON_FIELD_KEY: val('GHL_LOSS_REASON_FIELD_KEY'),
    },
  };
}

export async function applyConfigUpdate(env, { passphrase, values }) {
  const cfg = await getConfig(env);
  const existingHash = cfg.ADMIN_PASSPHRASE_HASH;

  if (existingHash) {
    if (!passphrase) return { ok: false, error: 'Passphrase required' };
    const hash = await sha256Hex(passphrase);
    if (hash !== existingHash) return { ok: false, error: 'Incorrect passphrase' };
  } else {
    if (!passphrase || passphrase.length < 6) {
      return { ok: false, error: 'Choose a passphrase of 6+ characters to protect these settings' };
    }
    cfg.ADMIN_PASSPHRASE_HASH = await sha256Hex(passphrase);
  }

  for (const key of SECRET_KEYS) {
    if (values && values[key]) cfg[key] = values[key];
  }
  await saveConfig(env, cfg);
  return { ok: true };
}
