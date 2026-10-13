// Fishbowl Recorder settings. The only thing to change after deploying the Apps Script web app.
window.FISHBOWL_CONFIG = {
  // Apps Script: Deploy → New deployment → Web app → copy the URL ending in /exec
  // Leave blank to preview the page locally (nothing uploads).
  backendUrl: 'https://script.google.com/macros/s/AKfycbyzPXQtaSrPqD-aCRrBRdohDUbKbqV5lH9ggJsGscxa2Bl2AJagDjphDMtZSx7TnzWS/exec',

  // Recording quality: 720p at about 1.5 Mbps. Roughly 12 MB per minute of answer.
  videoBitsPerSecond: 1500000,
  audioBitsPerSecond: 96000,
};
