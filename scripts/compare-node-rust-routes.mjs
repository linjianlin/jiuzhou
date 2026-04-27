#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readText = async (relativePath) => {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
};

const normalizePath = (value) => {
  const normalized = value
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+$/u, '');
  return normalized || '/';
};

const joinRoute = (prefix, routePath) => {
  if (routePath === '/') return normalizePath(prefix);
  return normalizePath(`${prefix}${routePath.startsWith('/') ? routePath : `/${routePath}`}`.replace(/\/+/g, '/'));
};

const routeKey = (route) => `${route.method} ${route.path}`;

const groupByApiPrefix = (routes) => {
  return routes.reduce((acc, route) => {
    const parts = route.path.split('/').filter(Boolean);
    const prefix = parts.length >= 2 ? `/${parts[0]}/${parts[1]}` : route.path;
    acc[prefix] = (acc[prefix] ?? 0) + 1;
    return acc;
  }, {});
};

const loadNodeRoutes = async () => {
  const registerRoutes = await readText('server/src/bootstrap/registerRoutes.ts');
  const importMap = new Map();
  for (const match of registerRoutes.matchAll(/import\s+(\w+)\s+from\s+['"]\.\.\/routes\/([^'"]+)\.js['"]/gu)) {
    importMap.set(match[1], `server/src/routes/${match[2]}.ts`);
  }

  const mounts = [];
  for (const match of registerRoutes.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/gu)) {
    const file = importMap.get(match[2]);
    if (file) {
      mounts.push({ prefix: match[1], symbol: match[2], file });
    }
  }

  const routes = [];
  for (const mount of mounts) {
    const source = await readText(mount.file);
    for (const match of source.matchAll(/router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gums)) {
      routes.push({
        method: match[1].toUpperCase(),
        path: joinRoute(mount.prefix, match[2]),
        file: mount.file,
      });
    }
  }
  return routes.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
};

const loadRustRoutes = async () => {
  const source = await readText('server-rs/src/http/mod.rs');
  const routes = [];
  for (const match of source.matchAll(/\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)\s*\(/gums)) {
    routes.push({
      method: match[2].toUpperCase(),
      path: normalizePath(match[1]),
      file: 'server-rs/src/http/mod.rs',
    });
  }
  return routes.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
};

const nodeRoutes = await loadNodeRoutes();
const rustRoutes = await loadRustRoutes();
const nodeKeys = new Set(nodeRoutes.map(routeKey));
const rustKeys = new Set(rustRoutes.map(routeKey));
const missingInRust = nodeRoutes.filter((route) => !rustKeys.has(routeKey(route)));
const extraInRust = rustRoutes.filter((route) => !nodeKeys.has(routeKey(route)));

console.log(JSON.stringify({
  totals: {
    node: nodeRoutes.length,
    rust: rustRoutes.length,
    missingInRust: missingInRust.length,
    extraInRust: extraInRust.length,
  },
  missingByPrefix: groupByApiPrefix(missingInRust),
  extraByPrefix: groupByApiPrefix(extraInRust),
  missingInRust: missingInRust.map((route) => `${routeKey(route)} <- ${route.file}`),
  extraInRust: extraInRust.map(routeKey),
}, null, 2));
