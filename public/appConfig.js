// This file is copied into the built plugin bundle by flex-plugin-scripts.
// Reads FLEX_APP_* env vars from .env at build time.
var url = new URL(window.location.href);

// eslint-disable-next-line no-unused-vars
var appConfig = {
  pluginService: {
    enabled: true,
    url: '/plugins'
  },
  sso: {
    accountSid: url.searchParams.get('accountSid') || ''
  },
  ytica: false,
  logLevel: 'info',
  showSupervisorDesktopView: true
};
