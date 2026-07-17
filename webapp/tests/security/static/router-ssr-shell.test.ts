import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthSessionProvider } from '@/lib/auth-session';
import { AuthenticatedSpacetimeShell } from '@/router';

describe('router SSR shell', () => {
  it('preserves the document while the browser auth session is loading', () => {
    const markup = renderToStaticMarkup(
      createElement(
        AuthSessionProvider,
        null,
        createElement(
          AuthenticatedSpacetimeShell,
          null,
          createElement('html', { 'data-shell-marker': 'present' })
        )
      )
    );

    expect(markup).toContain('data-shell-marker="present"');
  });

  it('does not report expected WebSocket teardown during page exit', () => {
    const routerSource = readFileSync(
      new URL('../../../src/router.tsx', import.meta.url),
      'utf8'
    );

    expect(routerSource).toContain(
      "window.addEventListener('pagehide', handlePageHide)"
    );
    expect(routerSource).toContain('if (!isPageExiting)');
    expect(routerSource).not.toContain(
      "console.log('Disconnected from SpacetimeDB')"
    );
  });
});
