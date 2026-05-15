// Legacy shim - this file used to be the single-page app.
// The dashboard has been split into /index.html (overview) and /session.html.
// If this file is loaded directly, send the browser to the overview.
if (typeof window !== 'undefined') {
  window.location.replace('/');
}
