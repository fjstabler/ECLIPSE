import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config.js';

/**
 * Artwork is cached locally so the UI stays fast and keeps working if the
 * metadata provider is unreachable (or the key is later removed).
 */
export async function cacheImage(remoteUrl) {
  if (!remoteUrl) return null;
  if (!/^https?:/i.test(remoteUrl)) return remoteUrl; // already local

  const ext = path.extname(new URL(remoteUrl).pathname) || '.jpg';
  const hash = crypto.createHash('sha1').update(remoteUrl).digest('hex').slice(0, 20);
  const filename = `${hash}${ext}`;
  const dest = path.join(paths.artwork, filename);
  const publicPath = `/artwork/${filename}`;

  if (fs.existsSync(dest)) return publicPath;

  try {
    const res = await fetch(remoteUrl);
    if (!res.ok) return remoteUrl;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return publicPath;
  } catch {
    // Fall back to the remote URL — the browser may still be able to load it.
    return remoteUrl;
  }
}

const PALETTES = [
  ['#1a1035', '#4a1f6d'], ['#0b2027', '#1f6f78'], ['#2b0f1f', '#7a1f47'],
  ['#101a30', '#26507a'], ['#231303', '#7a4a12'], ['#0f2417', '#1f6b3d'],
  ['#1e1024', '#5d2a7a'], ['#241118', '#7a2626'], ['#0d1b2a', '#2a5a8a'],
];

/**
 * A poster for titles the metadata provider couldn't match. Deterministic, so
 * the same film always gets the same colours instead of flickering on rescan.
 */
export function placeholderPoster(title, year, kind = 'movie') {
  const hash = crypto.createHash('md5').update(`${title}${year || ''}`).digest();
  const [from, to] = PALETTES[hash[0] % PALETTES.length];
  const angle = 110 + (hash[1] % 60);

  const initials = title
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  const safeTitle = escapeXml(title.length > 42 ? `${title.slice(0, 40)}…` : title);
  const meta = escapeXml([year, kind === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · '));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 750" width="500" height="750">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle})">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
    <radialGradient id="v" cx="50%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.35"/>
    </radialGradient>
  </defs>
  <rect width="500" height="750" fill="url(#g)"/>
  <rect width="500" height="750" fill="url(#v)"/>
  <circle cx="250" cy="300" r="96" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="2"/>
  <text x="250" y="300" font-family="Georgia, serif" font-size="86" fill="#fff" fill-opacity="0.85"
        text-anchor="middle" dominant-baseline="central">${escapeXml(initials || '?')}</text>
  <text x="250" y="600" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600"
        fill="#fff" fill-opacity="0.92" text-anchor="middle">${safeTitle}</text>
  <text x="250" y="640" font-family="Helvetica, Arial, sans-serif" font-size="20"
        fill="#fff" fill-opacity="0.55" text-anchor="middle" letter-spacing="2">${meta}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export function placeholderBackdrop(title) {
  const hash = crypto.createHash('md5').update(title).digest();
  const [from, to] = PALETTES[hash[0] % PALETTES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs><linearGradient id="g" gradientTransform="rotate(${20 + (hash[1] % 40)})">
    <stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>
  </linearGradient></defs>
  <rect width="1280" height="720" fill="url(#g)"/>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );
}
