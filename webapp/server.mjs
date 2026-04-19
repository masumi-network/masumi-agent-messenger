import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  GENERATED_MASUMI_OIDC_AUDIENCES,
  GENERATED_MASUMI_OIDC_CLIENT_ID,
  GENERATED_MASUMI_OIDC_ISSUER,
  GENERATED_OIDC_CONFIG_SOURCE,
} from '../shared/generated-oidc-config.mjs';
import { resolveServerOidcRuntimeConfig } from './server-oidc-config.mjs';
import { appendServerSecurityHeaders } from './server-security-headers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientRoot = path.join(__dirname, 'dist', 'client');
const serverEntrypoint = path.join(__dirname, 'dist', 'server', 'server.js');
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

resolveServerOidcRuntimeConfig(process.env, {
  source: GENERATED_OIDC_CONFIG_SOURCE,
  issuer: GENERATED_MASUMI_OIDC_ISSUER,
  clientId: GENERATED_MASUMI_OIDC_CLIENT_ID,
  audiences: GENERATED_MASUMI_OIDC_AUDIENCES,
});

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const { default: app } = await import(serverEntrypoint);

function getOrigin(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost ?? req.headers.host;
  return `${proto ?? 'http'}://${host ?? 'localhost'}`;
}

function setResponseHeaders(res, headers, pathname, isSecureTransport) {
  const nextHeaders = new Headers(headers);
  appendServerSecurityHeaders(nextHeaders, {
    contentType: nextHeaders.get('content-type'),
    isSecureTransport,
  });

  const setCookies =
    typeof nextHeaders.getSetCookie === 'function' ? nextHeaders.getSetCookie() : [];
  for (const [key, value] of nextHeaders.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue;
    res.setHeader(key, value);
  }

  if (setCookies.length > 0) {
    res.setHeader('set-cookie', setCookies);
  }

  if (pathname.startsWith('/assets/') && !res.hasHeader('cache-control')) {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  }
}

function toWebRequest(req) {
  const init = {
    method: req.method ?? 'GET',
    headers: new Headers(),
  };

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        init.headers.append(key, item);
      }
      continue;
    }
    init.headers.set(key, value);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  return new Request(new URL(req.url ?? '/', getOrigin(req)), init);
}

function sendWebResponse(res, response, pathname, method, isSecureTransport) {
  res.statusCode = response.status;
  setResponseHeaders(res, response.headers, pathname, isSecureTransport);

  if (method === 'HEAD' || !response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

function resolveStaticPath(pathname) {
  if (pathname === '/' || pathname.length === 0) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = path.join(clientRoot, normalized);

  if (!candidate.startsWith(clientRoot)) {
    return null;
  }

  return candidate;
}

async function tryServeStaticAsset(req, res, pathname) {
  const candidate = resolveStaticPath(pathname);
  if (!candidate) return false;

  try {
    await access(candidate);
    const fileStats = await stat(candidate);
    if (!fileStats.isFile()) {
      return false;
    }

    const contentType = MIME_TYPES.get(path.extname(candidate)) ?? 'application/octet-stream';
    const headers = new Headers({
      'content-length': String(fileStats.size),
      'content-type': contentType,
    });
    if (pathname.startsWith('/assets/')) {
      headers.set('cache-control', 'public, max-age=31536000, immutable');
    }
    res.statusCode = 200;
    setResponseHeaders(
      res,
      headers,
      pathname,
      new URL(req.url ?? '/', getOrigin(req)).protocol === 'https:'
    );

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    createReadStream(candidate).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', getOrigin(req));
  const isSecureTransport = requestUrl.protocol === 'https:';

  try {
    if (await tryServeStaticAsset(req, res, requestUrl.pathname)) {
      return;
    }

    const response = await app.fetch(toWebRequest(req));
    sendWebResponse(
      res,
      response,
      requestUrl.pathname,
      req.method ?? 'GET',
      isSecureTransport
    );
  } catch (error) {
    console.error('Production server error', error);
    res.statusCode = 500;
    const headers = new Headers({
      'content-type': 'text/plain; charset=utf-8',
    });
    setResponseHeaders(res, headers, requestUrl.pathname, isSecureTransport);
    res.end('Internal Server Error');
  }
});

server.listen(port, host, () => {
  console.log(`Masumi Inbox listening on http://${host}:${port}`);
});
