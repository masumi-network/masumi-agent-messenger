/// <reference types="vite/client" />
import '../styles/globals.css';
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { QueryClient } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { buildDocumentCsp } from '@/lib/security';
import { buildSiteDefaultHead } from '@/lib/seo';

const THEME_BOOTSTRAP = `
(() => {
  try {
    const storageKey = 'masumi-agent-messenger:theme';
    const stored = window.localStorage.getItem(storageKey);
    const theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
      return;
    }
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = 'light';
  } catch (error) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  }
})();
`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          httpEquiv: 'Content-Security-Policy',
          content: buildDocumentCsp({ isDev: import.meta.env.DEV }),
        },
        {
          name: 'referrer',
          content: 'same-origin',
        },
        ...buildSiteDefaultHead().meta,
      ],
    }),
      component: RootComponent,
  }
);

function RootComponent() {
  return (
    <html
      lang="en"
      className="dark"
      style={{ colorScheme: 'dark' }}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_BOOTSTRAP,
          }}
        />
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background" suppressHydrationWarning>
        <TooltipProvider delayDuration={300}>
          <Outlet />
        </TooltipProvider>
        {import.meta.env.DEV ? (
          <>
            <ReactQueryDevtools
              initialIsOpen={false}
              buttonPosition="bottom-left"
            />
            <TanStackRouterDevtools position="bottom-right" />
          </>
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}
