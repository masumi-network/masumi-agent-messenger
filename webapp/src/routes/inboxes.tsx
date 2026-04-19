import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/inboxes')({
  beforeLoad: () => {
    throw redirect({
      to: '/agents',
    });
  },
  component: () => null,
});
