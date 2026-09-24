// Customer-facing "Now Serving" board. Public: shows order numbers only.
import { api, $, pad, liveEvents, startClock } from './core.js';

let lastReady = new Set();
let audio;
function chime() {
  try {
    audio ||= new AudioContext();
    [660, 880].forEach((f, i) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0.2, audio.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + i * 0.25 + 0.5);
      o.connect(g).connect(audio.destination); o.start(audio.currentTime + i * 0.25); o.stop(audio.currentTime + i * 0.25 + 0.5);
    });
  } catch { /* audio blocked until user gesture */ }
}

async function load() {
  try {
    const b = await api('GET', '/api/public/board');
    $('#prep').innerHTML = b.preparing.map((n) => `<span>${pad(n)}</span>`).join('');
    const fresh = b.ready.filter((n) => !lastReady.has(n));
    $('#ready').innerHTML = b.ready.map((n) => `<span class="${fresh.includes(n) ? 'new' : ''}">${pad(n)}</span>`).join('');
    if (fresh.length && lastReady.size) chime();
    lastReady = new Set(b.ready);
  } catch { /* keep last state on screen */ }
}

startClock($('#clock'));
api('GET', '/api/public/config').then((c) => { $('#store').textContent = c.store_name; }).catch(() => {});
load();
setInterval(load, 15000);
liveEvents(() => load());
document.addEventListener('click', () => { audio ||= new AudioContext(); });
