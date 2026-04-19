import { SignOut } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { clearUnlockedKeySession } from '@/lib/agent-session';

export function SignOutButton({
  variant = 'outline',
}: {
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
}) {
  return (
    <form action="/auth/logout" method="post">
      <Button type="submit" variant={variant} onClick={() => clearUnlockedKeySession()}>
        <SignOut />
        Sign out
      </Button>
    </form>
  );
}
