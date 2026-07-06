"use client";

import { useState } from "react";
import { authClient } from "@/auth/auth-client";

export function SignInButton() {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signIn.social({
          provider: "discord",
          callbackURL: "/",
          errorCallbackURL: "/login?error=forbidden",
        });
      }}
      className="rounded-md bg-[#5865F2] px-6 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {pending ? "Redirecting…" : "Sign in with Discord"}
    </button>
  );
}
