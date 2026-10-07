// Build-time plugin configuration. FLEX_APP_* vars are baked into the bundle
// at compile time; changing one requires a redeploy. Values default to the
// behaviour that was in place before configurability was introduced.

export type SendMode = 'open-chat' | 'same-agent' | 'any-agent';

function boolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function sendMode(raw: string | undefined, fallback: SendMode): SendMode {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'open-chat' || v === 'same-agent' || v === 'any-agent') return v;
  return fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const pluginConfig = {
  sideNavLabel: process.env.FLEX_APP_SIDE_NAV_LABEL || 'WhatsApp Outbound',
  enableTeamView: boolean(process.env.FLEX_APP_ENABLE_TEAM_VIEW, true),
  enablePark: boolean(process.env.FLEX_APP_ENABLE_PARK, true),
  defaultSendMode: sendMode(process.env.FLEX_APP_DEFAULT_SEND_MODE, 'open-chat'),
  // Mirror of the serverless WA_WINDOW_HOURS: used in the UI to decide
  // whether a row shows "Reopen" or "Reopen with template". Set this to the
  // same value as the serverless env to keep UI and policy in sync.
  waWindowHours: positiveInt(process.env.FLEX_APP_WA_WINDOW_HOURS, 24),
};
