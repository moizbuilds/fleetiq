/**
 * Shared Clerk "appearance" config — makes Clerk's hosted UI (sign-in page,
 * user menu, etc.) match FleetIQ's dark instrument-panel look instead of
 * Clerk's default light/blue theme.
 *
 * WHY this lives in one file: Clerk components are rendered in a few
 * places (ClerkProvider in app/layout.tsx wraps the whole app, and the
 * sign-in page renders <SignIn />). Passing `appearance` on ClerkProvider
 * cascades to every Clerk component automatically, so this object is
 * defined once and never redeclared — the naive alternative would be
 * copy-pasting the same theme object onto every individual Clerk
 * component, which drifts the moment the palette changes.
 *
 * The values below reference the CSS custom properties from
 * app/globals.css (var(--chassis), etc.) rather than hard-coded hex codes,
 * so this file and globals.css never fall out of sync.
 */
import type { ComponentProps } from "react";
import type { ClerkProvider } from "@clerk/nextjs";

// CONCEPT: rather than import a type named "Appearance" that may or may
// not exist under that name in this Clerk version, this derives the type
// straight from the prop ClerkProvider actually accepts
// (ComponentProps<typeof ClerkProvider>["appearance"]). If Clerk ever
// renames or restructures its exported types, this still type-checks
// correctly with zero changes here.
type ClerkAppearance = ComponentProps<typeof ClerkProvider>["appearance"];

export const clerkAppearance: ClerkAppearance = {
  variables: {
    colorBackground: "var(--chassis)",
    colorForeground: "var(--bone)",
    colorMutedForeground: "var(--steel)",
    colorPrimary: "var(--bone)",
    colorInput: "var(--panel)",
    colorInputForeground: "var(--bone)",
    colorDanger: "var(--red)",
    colorSuccess: "var(--green)",
    colorWarning: "var(--amber)",
    colorNeutral: "var(--steel)",
    colorBorder: "var(--seam)",
    fontFamily: "var(--font-archivo)",
    borderRadius: "0.375rem",
  },
  elements: {
    // Card and buttons pick up the flat "1px seam border, bone text" look
    // from globals.md rather than Clerk's default drop shadows/gradients.
    card: {
      backgroundColor: "var(--panel)",
      border: "1px solid var(--seam)",
      boxShadow: "none",
    },
    formButtonPrimary: {
      backgroundColor: "var(--panel-2)",
      border: "1px solid var(--seam)",
      color: "var(--bone)",
      boxShadow: "none",
      "&:hover": {
        backgroundColor: "var(--seam)",
      },
    },
    formFieldInput: {
      backgroundColor: "var(--panel)",
      border: "1px solid var(--seam)",
      color: "var(--bone)",
    },
    footerActionLink: {
      color: "var(--bone)",
    },
  },
};
