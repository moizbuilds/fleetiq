/**
 * Sign-in page — the one route middleware.ts leaves public.
 *
 * Renders Clerk's hosted <SignIn /> form. It already picks up FleetIQ's
 * dark theme (chassis/panel/seam/bone tokens) because `appearance` is set
 * once on <ClerkProvider> in app/layout.tsx and cascades down — passing a
 * second appearance object here would just be the same values redeclared
 * in two places, waiting to drift.
 *
 * CONCEPT: the folder name `[[...sign-in]]` is a Next.js "optional catch-all
 * route" — the doubled brackets mean it matches both `/sign-in` and any
 * sub-path like `/sign-in/factor-one`, which Clerk's multi-step sign-in
 * flow (password, then verification code, etc.) needs internally.
 */
import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <SignIn />
    </div>
  );
}
