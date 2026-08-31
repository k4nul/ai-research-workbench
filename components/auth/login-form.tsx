"use client";

import { useState, type FormEvent } from "react";

import { authRequest } from "@/components/auth/auth-client";
import { MutationFeedback } from "@/components/features/mutation-ui";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await authRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password")
        })
      });
      window.location.replace(nextPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="page-stack" method="post" onSubmit={submit}>
      <noscript>
        <p className="ui-error">JavaScript is required to sign in.</p>
      </noscript>
      <label className="field">
        <span>Username</span>
        <input
          autoComplete="username"
          autoFocus
          className="ui-input"
          maxLength={64}
          name="username"
          required
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          autoComplete="current-password"
          className="ui-input"
          maxLength={1_024}
          name="password"
          required
          type="password"
        />
      </label>
      <button className="ui-button" disabled={pending} type="submit">
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <MutationFeedback
        message={error ? { tone: "error", text: error } : null}
      />
    </form>
  );
}
