"use client";

import { FormEvent, useEffect, useState } from "react";
import { createAdminAccount } from "@/lib/api";

export default function AddAdminPage() {
  const [adminToken, setAdminToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("admin_token") || "";
    setAdminToken(token);
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminToken) {
      setError("Admin token not found. Please log in again.");
      return;
    }

    setLoading(true);
    setMessage("");
    setError("");
    try {
      const payload = await createAdminAccount(adminToken, {
        email: email.trim(),
        password: password.trim(),
        name: name.trim() || undefined,
      });
      setMessage(`Admin created: ${payload.admin.email}`);
      setEmail("");
      setPassword("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create admin.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-[28px] border border-[rgba(73,153,173,0.22)] bg-white shadow-[0_24px_60px_-38px_rgba(73,153,173,0.7)]">
      <div className="bg-[linear-gradient(140deg,rgba(73,153,173,0.18),rgba(73,153,173,0.06))] px-6 py-6">
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[rgb(47,118,135)]">Admin Access</p>
        <h2 className="mt-2 text-2xl font-black tracking-tight text-zinc-900">Add Admin</h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-700">
          Create a new admin directly by entering email and password. The user will be able to log in immediately as an admin.
        </p>
      </div>

      <form onSubmit={onSubmit} className="grid gap-4 p-6 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-zinc-700">Admin Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className="w-full rounded-lg border border-zinc-300 px-3 py-2"
            placeholder="admin@example.com"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-zinc-700">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2"
            placeholder="At least 6 characters"
          />
        </label>

        <label className="block md:col-span-2">
          <span className="mb-1 block text-sm font-medium text-zinc-700">Name (Optional)</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2"
            placeholder="If empty, name is derived from email"
          />
        </label>

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={loading}
            className="rounded-xl bg-[rgb(47,118,135)] px-5 py-2 font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Creating..." : "Add Admin"}
          </button>
        </div>
      </form>

      {message ? <p className="px-6 pb-4 text-sm font-medium text-emerald-700">{message}</p> : null}
      {error ? <p className="px-6 pb-4 text-sm font-medium text-red-600">{error}</p> : null}
    </section>
  );
}
