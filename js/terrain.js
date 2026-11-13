// Terrain elevation from AWS Open Data "Terrarium" tiles (includes USGS 3DEP in the US).
// Tiles are cached by the service worker / Cache Storage, so once fetched they work offline.
import { lonToX, latToY, tilesForBounds } from './geo.js';

export const DEM_Z = 12; // ~30 m/px at mid-latitudes
export const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const TILE_CACHE = 'fpv-tiles-v1';

const tiles = new Map();   // key -> Float32Array(256*256)
const pending = new Map(); // key -> Promise
const failed = new Set();

const key = (z, x, y) => `${z}/${x}/${y}`;

async function fetchTile(z, x, y) {
  const url = DEM_URL(z, x, y);
  let resp;
  try {
    const cache = 'caches' in self ? await caches.open(TILE_CACHE) : null;
    resp = cache ? await cache.match(url) : null;
    if (!resp) {
      resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(resp.status);
      if (cache) await cache.put(url, resp.clone());
    }
  } catch (e) { failed.add(key(z, x, y)); return null; }
  const bmp = await createImageBitmap(await resp.blob());
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, 256, 256).data;
  const elev = new Float32Array(256 * 256);
  for (let i = 0; i < elev.length; i++) elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  tiles.set(key(z, x, y), elev);
  return elev;
}

export function ensureTile(z, x, y) {
  const k = key(z, x, y);
  if (tiles.has(k)) return Promise.resolve(tiles.get(k));
  if (!pending.has(k)) pending.set(k, fetchTile(z, x, y).finally(() => pending.delete(k)));
  return pending.get(k);
}

export async function ensureBounds(s, w, n, e) {
  const list = tilesForBounds(s, w, n, e, DEM_Z);
  if (list.length > 400) throw new Error(`Area too large for terrain (${list.length} tiles).`);
  await Promise.all(list.map(t => ensureTile(t.z, t.x, t.y)));
  return { requested: list.length, missing: list.filter(t => !tiles.has(key(t.z, t.x, t.y))).length };
}

function px(tile, ix, iy) { return tile[Math.min(255, Math.max(0, iy)) * 256 + Math.min(255, Math.max(0, ix))]; }

// Synchronous bilinear sample; returns null if tile not loaded.
export function elevationAt(lat, lon) {
  const fx = lonToX(lon, DEM_Z), fy = latToY(lat, DEM_Z);
  const tx = Math.floor(fx), ty = Math.floor(fy);
  const t = tiles.get(key(DEM_Z, tx, ty));
  if (!t) return null;
  const x = (fx - tx) * 256 - 0.5, y = (fy - ty) * 256 - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), dx = x - x0, dy = y - y0;
  // Edge pixels clamp within tile (sub-pixel error at tile seams is negligible at 30 m).
  const v = px(t, x0, y0) * (1 - dx) * (1 - dy) + px(t, x0 + 1, y0) * dx * (1 - dy) + px(t, x0, y0 + 1) * (1 - dx) * dy + px(t, x0 + 1, y0 + 1) * dx * dy;
  return v;
}

export const terrainStats = () => ({ loaded: tiles.size, failed: failed.size });
