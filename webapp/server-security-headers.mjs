// Keep this CSP aligned with webapp/src/lib/security.ts buildDocumentCsp().
const DOCUMENT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' ws: wss: http: https:",
  "worker-src 'self' blob:",
].join('; ');

export function buildServerDocumentCsp() {
  return DOCUMENT_CSP;
}

export function isHtmlContentType(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/html');
}

export function appendServerSecurityHeaders(
  headers,
  { contentType, isSecureTransport = false } = {}
) {
  if (!headers.has('Referrer-Policy')) {
    headers.set('Referrer-Policy', 'same-origin');
  }
  if (!headers.has('Permissions-Policy')) {
    headers.set(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()'
    );
  }
  if (!headers.has('X-Content-Type-Options')) {
    headers.set('X-Content-Type-Options', 'nosniff');
  }
  if (!headers.has('X-Frame-Options')) {
    headers.set('X-Frame-Options', 'DENY');
  }
  if (!headers.has('Cross-Origin-Opener-Policy')) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  }
  if (!headers.has('Cross-Origin-Resource-Policy')) {
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  }
  if (isHtmlContentType(contentType) && !headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', buildServerDocumentCsp());
  }
  if (isSecureTransport && !headers.has('Strict-Transport-Security')) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return headers;
}
