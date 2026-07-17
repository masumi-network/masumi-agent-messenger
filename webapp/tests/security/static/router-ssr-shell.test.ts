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
});
