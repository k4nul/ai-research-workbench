"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { authRequest } from "@/components/auth/auth-client";
import { MutationFeedback } from "@/components/features/mutation-ui";
import { EmptyState, StatusBadge } from "@/components/ui";

type OperatorSession = {
  id: string;
  current: boolean;
  clientLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

type SessionPayload = {
  operator: { displayName: string; username: string };
  sessions: OperatorSession[];
};

export function SessionManager() {
  const [data, setData] = useState<SessionPayload | null>(null);
  const [pending, setPending] = useState(true);
  const [message, setMessage] = useState<
    { tone: "success" | "error"; text: string } | null
  >(null);

  const load = useCallback(async () => {
    setPending(true);
    try {
      setData((await authRequest("/api/auth/sessions", { method: "GET" })) as SessionPayload);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Sessions could not be loaded."
      });
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void authRequest("/api/auth/sessions", { method: "GET" })
      .then((payload) => {
        if (active) setData(payload as SessionPayload);
      })
      .catch((error: unknown) => {
        if (active) {
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : "Sessions could not be loaded."
          });
        }
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function revoke(session: OperatorSession) {
    setMessage(null);
    try {
      await authRequest(
        `/api/auth/sessions/${encodeURIComponent(session.id)}`,
        { method: "DELETE" },
        true
      );
      if (session.current) {
        window.location.replace("/login");
        return;
      }
      setMessage({ tone: "success", text: "Session revoked." });
      await load();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Session revocation failed."
      });
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== String(form.get("confirmPassword") ?? "")) {
      setMessage({ tone: "error", text: "New password confirmation does not match." });
      return;
    }
    try {
      await authRequest(
        "/api/auth/password",
        {
          method: "PATCH",
          body: JSON.stringify({
            currentPassword: form.get("currentPassword"),
            newPassword
          })
        },
        true
      );
      formElement.reset();
      setMessage({
        tone: "success",
        text: "Password changed. All previous sessions were revoked."
      });
      await load();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Password change failed."
      });
    }
  }

  async function logout() {
    setMessage(null);
    try {
      await authRequest("/api/auth/logout", { method: "POST" }, true);
      window.location.replace("/login");
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Logout failed."
      });
    }
  }

  return (
    <div className="page-stack">
      <MutationFeedback message={message} />
      <section className="section-card">
        <div className="section-heading">
          <div>
            <h2>Active sessions</h2>
            <p>
              {data
                ? `${data.operator.displayName} (${data.operator.username})`
                : "Authenticated operator sessions"}
            </p>
          </div>
          <button className="ui-button ui-button--secondary" onClick={logout} type="button">
            Sign out
          </button>
        </div>
        {pending ? <p aria-live="polite">Loading sessions…</p> : null}
        {!pending && data?.sessions.length === 0 ? (
          <EmptyState compact description="No active sessions were found." title="No sessions" />
        ) : null}
        <div className="page-stack">
          {data?.sessions.map((session) => (
            <article className="section-card" key={session.id}>
              <div className="section-heading">
                <div>
                  <h3>{session.clientLabel ?? "Unknown client"}</h3>
                  <p>
                    Last active {new Date(session.lastSeenAt).toLocaleString()} · expires{" "}
                    {new Date(session.expiresAt).toLocaleString()}
                  </p>
                </div>
                {session.current ? <StatusBadge status="CURRENT" tone="success" /> : null}
              </div>
              <button
                className="ui-button ui-button--danger"
                onClick={() => void revoke(session)}
                type="button"
              >
                {session.current ? "Revoke and sign out" : "Revoke session"}
              </button>
            </article>
          ))}
        </div>
      </section>
      <section className="section-card">
        <div className="section-heading">
          <div>
            <h2>Change password</h2>
            <p>A successful change revokes every previous operator session.</p>
          </div>
        </div>
        <form className="page-stack" onSubmit={changePassword}>
          <label className="field">
            <span>Current password</span>
            <input autoComplete="current-password" className="ui-input" name="currentPassword" required type="password" />
          </label>
          <label className="field">
            <span>New password</span>
            <input autoComplete="new-password" className="ui-input" minLength={12} name="newPassword" required type="password" />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input autoComplete="new-password" className="ui-input" minLength={12} name="confirmPassword" required type="password" />
          </label>
          <button className="ui-button" type="submit">Change password</button>
        </form>
      </section>
    </div>
  );
}
