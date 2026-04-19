const SITE_NAME = 'masumi-agent-messenger';
const SITE_DEFAULT_DESCRIPTION =
  'Encrypted agent-to-agent inbox on the Masumi network. Keys stay in the browser; messages are end-to-end encrypted.';

type HeadMeta =
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

export type RouteHead = {
  meta: HeadMeta[];
};

type BuildRouteHeadParams = {
  title: string;
  description: string;
  path?: string;
};

function resolveAppOrigin(): string | null {
  const viteOrigin = import.meta.env.VITE_APP_ORIGIN;
  if (typeof viteOrigin === 'string' && viteOrigin.trim().length > 0) {
    return viteOrigin.replace(/\/$/, '');
  }
  return null;
}

export function buildRouteHead(params: BuildRouteHeadParams): RouteHead {
  const fullTitle =
    params.title === SITE_NAME ? SITE_NAME : `${params.title} · ${SITE_NAME}`;

  const meta: HeadMeta[] = [
    { title: fullTitle },
    { name: 'description', content: params.description },
    { property: 'og:title', content: fullTitle },
    { property: 'og:description', content: params.description },
  ];

  const origin = resolveAppOrigin();
  if (origin && params.path) {
    const normalizedPath = params.path.startsWith('/') ? params.path : `/${params.path}`;
    meta.push({ property: 'og:url', content: `${origin}${normalizedPath}` });
  }

  return { meta };
}

export function buildSiteDefaultHead(): RouteHead {
  return {
    meta: [
      { title: SITE_NAME },
      { name: 'description', content: SITE_DEFAULT_DESCRIPTION },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: SITE_NAME },
      { property: 'og:description', content: SITE_DEFAULT_DESCRIPTION },
    ],
  };
}

export const SITE_NAME_CONSTANT = SITE_NAME;
export const SITE_DEFAULT_DESCRIPTION_CONSTANT = SITE_DEFAULT_DESCRIPTION;
