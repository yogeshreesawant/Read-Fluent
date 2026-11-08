/**
 * READ FLUENT — CLIENT CONFIGURATION
 *
 * 🔒 High-Security Architecture (Backend Proxy Mode)
 * All Supabase Project URLs and API keys live strictly in server environment variables.
 * Zero credentials are ever exposed in this file, GitHub, or the client browser.
 */

/**
 * READ FLUENT — CLIENT CONFIGURATION
 *
 * 🔒 High-Security Architecture (Backend Proxy Mode)
 * All Supabase Project URLs and API keys live strictly in server environment variables.
 * Zero credentials are ever exposed in this file, GitHub, or the client browser.
 */

(function () {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const isRender = window.location.hostname.includes('onrender.com');

  window.READFLUENT_CONFIG = {
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    // On localhost or Render, use relative endpoints. On GitHub Pages, use the secure live Render backend proxy!
    BACKEND_API_BASE: (isLocal || isRender) ? '' : 'https://read-fluent.onrender.com'
  };
})();
