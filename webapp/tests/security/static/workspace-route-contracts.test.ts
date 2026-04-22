import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readRoute(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');
}

describe('workspace route contracts', () => {
  it('keeps approvals as a compatibility redirect into the inbox approvals tab', () => {
    const source = readRoute('src/routes/approvals.tsx');

    expect(source).toContain("to: '/$slug'");
    expect(source).toContain("buildWorkspaceSearch({ tab: 'approvals' })");
    expect(source).toContain("to: '/'");
  });

  it('keeps /$slug/manage as a compatibility redirect into agent management', () => {
    const source = readRoute('src/routes/$slug.manage.tsx');

    expect(source).toContain("to: '/agents'");
    expect(source).not.toContain("to: '/$slug'");
    expect(source).not.toContain("buildWorkspaceSearch({ tab: 'settings' })");
  });

  it('boots first-run browser sessions from the root route instead of bouncing to agents', () => {
    const source = readRoute('src/routes/index.tsx');

    expect(source).toContain('connection.reducers.upsertInboxFromOidcIdentity');
    expect(source).toContain('waitForBootstrapRows');
    expect(source).toContain('getOrCreatePendingBootstrapKeyPair');
    expect(source).toContain('clearPendingBootstrapKeyPair');
    expect(source).not.toContain("to: '/agents'");
  });

  it('guards agent-only routes behind root bootstrap', () => {
    const agentsSource = readRoute('src/routes/agents.tsx');
    const securitySource = readRoute('src/routes/security.tsx');

    expect(agentsSource).toContain("to: '/'");
    expect(agentsSource).not.toContain('Finish bootstrap first');
    expect(securitySource).toContain("to: '/'");
    expect(securitySource).not.toContain('Open Inbox');
  });

  it('keeps agent management scoped to the /agents route', () => {
    const source = readRoute('src/routes/agents.tsx');

    expect(source).toContain('My agents');
    expect(source).toContain('Register new agent');
  });

  it('links discovered agents to their dedicated details page', () => {
    const source = readRoute('src/routes/discover.tsx');

    expect(source).toContain('to="/discover/$slug"');
    expect(source).toContain('params={{ slug: actor.slug }}');
  });

  it('offers an encrypted-thread CTA from the discovered agent details page', () => {
    const source = readRoute('src/routes/discover_.$slug.tsx');

    expect(source).toContain('lookupMasumiNetworkAgent');
    expect(source).not.toContain('discoverMasumiNetworkAgents({');
    expect(source).toContain("to: '/$slug'");
    expect(source).toContain('buildWorkspaceSearch');
    expect(source).toContain('lookup: params.slug');
    expect(source).toContain("compose: 'direct'");
  });

  it('keeps inbox workspace focused on inbox-only sections after moving profile management', () => {
    const source = readRoute('src/routes/$slug.tsx');

    expect(source).toContain('value="inbox"');
    expect(source).toContain('value="approvals"');
    expect(source).not.toContain('value="settings"');
    expect(source).not.toContain('>Profile<');
  });
});
