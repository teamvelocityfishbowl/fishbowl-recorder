// Fishbowl Recorder settings. The only thing to change after deploying the Apps Script web app.
window.FISHBOWL_CONFIG = {
  // Apps Script: Deploy → New deployment → Web app → copy the URL ending in /exec
  // Leave blank to preview the page locally (nothing uploads).
  backendUrl: '',

  // Recording quality: 720p at about 2 Mbps. Roughly 15 MB per minute.
  videoBitsPerSecond: 2000000,
  audioBitsPerSecond: 128000,
};
