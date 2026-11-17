#!/usr/bin/env node

// Creates or updates an admin account.
//
// Credentials are never hardcoded. Supply them via environment variables or
// CLI flags, e.g.:
//   ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='...' npm run seed:admin
//   node scripts/create-admin.js --email ops@example.com --password '...'
//
// Without --update the script refuses to touch an existing admin, so it cannot
// silently reset a live account's password.

require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { connectDatabase } = require("../db");
const Admin = require("../models/Admin");

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.split("=", 2);
    const key = rawKey.replace(/^--/, "");
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
      continue;
    }
    args[key] = true;
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> [ADMIN_NAME=<name>] node scripts/create-admin.js",
    "  node scripts/create-admin.js --email <email> --password <password> [--name <name>] [--update]",
    "",
    "Flags:",
    "  --update   Allow overwriting the password of an existing admin.",
  ].join("\n");
}

async function run() {
  const args = parseArgs(process.argv);

  const email = String(args.email || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(args.password || process.env.ADMIN_PASSWORD || "");
  const name = String(args.name || process.env.ADMIN_NAME || "").trim();
  const allowUpdate = Boolean(args.update);

  if (!email || !password) {
    throw new Error(`Missing admin credentials.\n\n${usage()}`);
  }

  if (!EMAIL_PATTERN.test(email)) {
    throw new Error("ADMIN_EMAIL is not a valid email address.");
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  await connectDatabase();

  const resolvedName = name || email.split("@")[0] || "Admin";
  const existing = await Admin.findOne({ email }).select("_id email");

  if (existing && !allowUpdate) {
    throw new Error(
      `An admin already exists for ${email}. Re-run with --update to reset its password.`
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  if (existing) {
    await Admin.updateOne({ _id: existing._id }, { $set: { name: resolvedName, passwordHash } });
    console.log(`Admin password updated for ${email}.`);
    return;
  }

  await Admin.create({ name: resolvedName, email, passwordHash });
  console.log(`Admin created: ${email}`);
}

run()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`Admin script failed: ${error.message}`);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exit(1);
  });
