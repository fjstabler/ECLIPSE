import os from 'node:os';
import fs from 'node:fs';
import { config, paths } from './config.js';
import { db } from './db.js';

/**
 * What the machine is doing. Enough for the admin page to answer "is the
 * server struggling, and is it about to run out of room", without pulling in
 * a monitoring dependency for numbers the platform already reports.
 */

let lastCpu = os.cpus();
let lastCpuAt = Date.now();

export function serverHealth() {
  return {
    uptime: Math.round(process.uptime()),
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    cpu: cpuUsage(),
    memory: memoryUsage(),
    storage: storageUsage(),
    database: databaseSize(),
    port: config.port,
  };
}

/**
 * CPU load as a percentage across all cores, measured between calls rather
 * than since boot — a server that was busy an hour ago is not busy now, and
 * the admin page is asking about now.
 */
function cpuUsage() {
  const cpus = os.cpus();
  const now = Date.now();

  let idleDelta = 0;
  let totalDelta = 0;
  for (const [i, cpu] of cpus.entries()) {
    const previous = lastCpu[i];
    if (!previous) continue;
    const idle = cpu.times.idle - previous.times.idle;
    const total = Object.keys(cpu.times).reduce((sum, k) => sum + (cpu.times[k] - previous.times[k]), 0);
    idleDelta += idle;
    totalDelta += total;
  }

  // Two calls in the same instant have nothing to compare; report the load
  // average instead of a meaningless 0%.
  let percent = null;
  if (totalDelta > 0 && now - lastCpuAt > 200) {
    percent = Math.round((1 - idleDelta / totalDelta) * 100);
    lastCpu = cpus;
    lastCpuAt = now;
  }

  return {
    cores: cpus.length,
    model: cpus[0]?.model?.trim() || 'Unknown',
    percent,
    loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
  };
}

function memoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    used,
    free,
    percent: total > 0 ? Math.round((used / total) * 100) : null,
    process: process.memoryUsage().rss,
  };
}

/**
 * Free space where ECLIPSE keeps its own data, plus each library root — the
 * useful question is "can the thing that writes still write", and on a NAS
 * those live on different volumes.
 */
function storageUsage() {
  const seen = new Set();
  const volumes = [];

  const add = (label, target) => {
    if (!target || seen.has(target)) return;
    seen.add(target);
    try {
      const stat = fs.statfsSync(target);
      const total = stat.blocks * stat.bsize;
      const free = stat.bavail * stat.bsize;
      volumes.push({
        label,
        path: target,
        total,
        free,
        used: total - free,
        percent: total > 0 ? Math.round(((total - free) / total) * 100) : null,
      });
    } catch {
      volumes.push({ label, path: target, error: 'unreadable' });
    }
  };

  add('ECLIPSE data', config.dataDir);
  add('Artwork', paths.artwork);
  for (const row of db.prepare('SELECT name, paths FROM libraries WHERE enabled = 1').all()) {
    try {
      for (const p of JSON.parse(row.paths || '[]')) add(row.name, p);
    } catch { /* a malformed row shouldn't take the whole panel down */ }
  }

  return volumes;
}

function databaseSize() {
  try {
    const { size } = fs.statSync(paths.db);
    return { size, path: paths.db };
  } catch {
    return { size: null, path: paths.db };
  }
}
