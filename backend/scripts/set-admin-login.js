#!/usr/bin/env node

// Creates or updates an admin that signs in with a username and password.
// The password is typed into a hidden prompt: it is never a command-line
// argument, so it stays out of shell history, process lists and chat.
//
//   node scripts/set-admin-login.js --username Saad-ahmed-25 --email you@example.com
//   node scripts/set-admin-login.js --remove-email old-admin@example.com   (asks to confirm)
//
// It reads MONGODB_URI from the environment, so run it deliberately against the
// database you mean to change.

require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const readline = require("readline");
const { connectDatabase } = require("../db");
const Admin = require("../models/Admin");

const MIN_PASSWORD_LENGTH = 12;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,40}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? String(process.argv[index + 1] || "").trim() : "";
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function run() {
  if (!process.stdin.isTTY) throw new Error("Run this in an interactive terminal so the password can be typed privately.");
  await connectDatabase();
  const host = mongoose.connection.host;
  console.log(`Database host: ${host}`);

  const removeEmail = arg("remove-email").toLowerCase();
  if (removeEmail) {
    const target = await Admin.findOne({ email: removeEmail }).select("_id email");
    if (!target) throw new Error("No admin with that email.");
    if ((await Admin.countDocuments()) < 2) throw new Error("Refusing to remove the only admin.");
    const answer = await ask(`Permanently remove admin ${removeEmail} from ${host}? Type the email to confirm: `);
    if (answer.trim().toLowerCase() !== removeEmail) throw new Error("Not confirmed. Nothing removed.");
    await Admin.deleteOne({ _id: target._id });
    console.log("Admin removed. Its sessions stop working immediately.");
    return;
  }

  const username = arg("username");
  const email = arg("email").toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new Error("--username must be 3-40 letters, digits, dot, dash or underscore.");
  if (!EMAIL_PATTERN.test(email)) throw new Error("--email must be a valid address (kept as a contact and recovery address).");

  const password = await ask("New password: ", { hidden: true });
  const again = await ask("Repeat password: ", { hidden: true });
  if (password !== again) throw new Error("Passwords do not match.");
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);

  const usernameKey = username.toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);
  const existing = (await Admin.findOne({ usernameKey })) || (await Admin.findOne({ email }));
  if (existing) {
    const confirmed = await ask(`Update the existing admin (${existing.email}) on ${host}? Type yes: `);
    if (confirmed.trim().toLowerCase() !== "yes") throw new Error("Not confirmed. Nothing changed.");
    await Admin.updateOne({ _id: existing._id }, { $set: { username, usernameKey, passwordHash } });
    console.log("Admin updated.");
  } else {
    await Admin.create({ name: username, username, usernameKey, email, passwordHash });
    console.log("Admin created.");
  }
}

run()
  .then(() => mongoose.disconnect().then(() => process.exit(0)))
  .catch(async (error) => {
    console.error(error.message);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
