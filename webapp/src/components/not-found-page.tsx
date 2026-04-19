import { Link } from '@tanstack/react-router';
import { Question } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function NotFoundPage() {
  return (
    <main
      className="flex min-h-[60vh] flex-col items-center justify-center p-6"
      role="main"
      aria-labelledby="not-found-title"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Question className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
          <CardTitle id="not-found-title">Page not found</CardTitle>
          <CardDescription>
            The URL does not match any route in this app.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center pb-6">
          <Button asChild>
            <Link to="/" search={{ modal: undefined }}>Back to inbox</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
