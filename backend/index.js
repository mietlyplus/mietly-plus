require("dotenv").config({ quiet: true });
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Stripe = require("stripe");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { connectDatabase } = require("./db");
const { getDatabaseIsolation, isPreviewDeployment, productUploadFolder } = require("./lib/runtime-env");
const { previewMediaPublicId, shouldPurgePreviewMedia } = require("./lib/preview-media");
const User = require("./models/User");
const SignupOtp = require("./models/SignupOtp");
const Admin = require("./models/Admin");
const Category = require("./models/Category");
const Banner = require("./models/Banner");
const Product = require("./models/Product");
const Brand = require("./models/Brand");
const BlogPost = require("./models/BlogPost");
const SupportRequest = require("./models/SupportRequest");
const Order = require("./models/Order");
const ProductDraft = require("./models/ProductDraft");
const StripeWebhookEvent = require("./models/StripeWebhookEvent");
const { getProductRentalLimits, getOccasionDailyRate, getOccasionOptions, priceOrderItem, sumOrderTotals } = require("./lib/pricing");
const { planBilling } = require("./lib/billing");
const {
  RECURRING_EVENT_TYPES,
  activateRecurringOrder,
  ensureFixedTermSchedule,
  idOf,
  metadataOfEvent,
  nextBillingDateOfInvoice,
  recordFailedPayment,
  recordPaidInvoice,
  recordSubscriptionEnded,
  subscriptionIdOfEvent,
} = require("./lib/recurring-billing");

const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ storage: multer.memoryStorage() });
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const stripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const STRIPE_WEBHOOK_PATH = "/api/payments/stripe-webhook";
const VALID_FULFILLMENT_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled", "returned"];
const WEBSITE_CURRENCY = "eur";
const PRODUCT_IMAGE_PLACEHOLDER =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
      <rect width="1200" height="900" fill="#f4f4f5"/>
      <rect x="120" y="120" width="960" height="660" rx="44" fill="#ffffff" stroke="#d4d4d8" stroke-width="12"/>
      <path d="M330 615l140-160 125 115 170-220 220 265H330z" fill="#d4d4d8"/>
      <circle cx="470" cy="320" r="62" fill="#cbd5e1"/>
      <text x="600" y="740" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" fill="#52525b">
        Product image will be added later
      </text>
    </svg>
  `);
const hasCloudinaryConfig =
  Boolean(process.env.CLOUDINARY_CLOUD_NAME) &&
  Boolean(process.env.CLOUDINARY_API_KEY) &&
  Boolean(process.env.CLOUDINARY_API_SECRET);

const emailConfig = {
  host: String(process.env.SMTP_HOST || "").trim(),
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
  user: String(process.env.SMTP_USER || "").trim(),
  pass: String(process.env.SMTP_PASS || "").trim(),
  fromEmail: String(process.env.EMAIL_FROM || process.env.SMTP_USER || "").trim(),
  fromName: String(process.env.EMAIL_FROM_NAME || "Leihfluss").trim(),
};

const canSendEmail =
  Boolean(emailConfig.host) &&
  Number.isFinite(emailConfig.port) &&
  Boolean(emailConfig.user) &&
  Boolean(emailConfig.pass) &&
  Boolean(emailConfig.fromEmail);

const mailTransporter = canSendEmail
  ? nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      auth: {
        user: emailConfig.user,
        pass: emailConfig.pass,
      },
    })
  : null;

if (hasCloudinaryConfig) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

app.use(cors());

// Stripe signature verification needs the exact bytes Stripe signed, so the
// webhook route is excluded from JSON parsing and buffered raw instead.
app.use(STRIPE_WEBHOOK_PATH, express.raw({ type: "*/*", limit: "1mb" }));
app.use((req, res, next) => {
  if (req.path === STRIPE_WEBHOOK_PATH) return next();
  return express.json()(req, res, next);
});

let appInitPromise = null;

async function initializeApp() {
  if (!appInitPromise) {
    appInitPromise = connectDatabase().catch((error) => {
      appInitPromise = null;
      throw error;
    });
  }

  await appInitPromise;
}


// JWT signing/verification has no safe default. A missing secret must disable
// authentication entirely rather than fall back to a guessable value. The check
// is done per request (not at module load) so serverless cold starts and the
// unauthenticated storefront routes still initialize normally.
function isJwtSecretConfigured() {
  return Boolean(String(process.env.JWT_SECRET || "").trim());
}

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return secret;
}

function rejectWhenJwtSecretMissing(res) {
  if (isJwtSecretConfigured()) return false;
  console.error("JWT_SECRET is not configured. Authentication is disabled.");
  res.status(500).json({ message: "Authentication is not configured on the server." });
  return true;
}

function buildAdminToken(admin) {

  return jwt.sign(
    {
      sub: String(admin._id),
      email: admin.email,
      role: "admin",
      name: admin.name,
    },
    getJwtSecret(),
    { expiresIn: "7d" }
  );
}

function buildUserToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      role: "user",
      name: user.name,
    },
    getJwtSecret(),
    { expiresIn: "7d" }
  );
}

async function requireAdminAuth(req, res, next) {
  if (rejectWhenJwtSecretMissing(res)) return undefined;

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized." });
  }

  const token = authHeader.replace("Bearer ", "");
  let payload;
  try {
    payload = jwt.verify(token, getJwtSecret());
  } catch {
    return res.status(401).json({ message: "Invalid token." });
  }
  if (payload.role !== "admin") {
    return res.status(403).json({ message: "Forbidden." });
  }
  // A token only counts while its admin account still exists, so removing an
  // account revokes its sessions immediately instead of after seven days.
  try {
    const stillExists = await Admin.exists({ _id: payload.sub });
    if (!stillExists) return res.status(401).json({ message: "Invalid token." });
  } catch {
    return res.status(503).json({ message: "Could not verify admin session." });
  }
  req.admin = payload;
  return next();
}

function requireUserAuth(req, res, next) {
  if (rejectWhenJwtSecretMissing(res)) return undefined;

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized." });
  }

  const token = authHeader.replace("Bearer ", "");
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (payload.role !== "user") {
      return res.status(403).json({ message: "Forbidden." });
    }
    req.userAuth = payload;
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid token." });
  }
}

function requireCronAuth(req, res, next) {
  const configuredSecret = String(process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET || "").trim();
  if (!configuredSecret) {
    if (process.env.NODE_ENV === "production") {
      return res.status(500).json({ message: "Cron secret is not configured." });
    }
    return next();
  }

  const authorizationHeader = String(req.headers.authorization || "").trim();
  const bearerSecret = authorizationHeader.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length).trim()
    : "";
  const querySecret = String(req.query?.secret || "").trim();

  if (bearerSecret !== configuredSecret && querySecret !== configuredSecret) {
    return res.status(401).json({ message: "Unauthorized cron request." });
  }

  return next();
}

function isValidGermanPhone(phone) {
  return /^\+49\d{7,13}$/.test(phone);
}

function getFrontendBaseUrl() {
  return (
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  );
}

// In production a missing site URL would send customers back to localhost after
// paying. Checkout refuses to start instead of building those return URLs.
function isFrontendUrlConfigured() {
  const onProduction = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  if (!onProduction) return true;
  return Boolean(process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL);
}

function normalizeAddressInput(rawAddress) {
  const source = rawAddress && typeof rawAddress === "object" ? rawAddress : {};
  return {
    fullName: String(source.fullName || "").trim(),
    phone: String(source.phone || "").trim(),
    line1: String(source.line1 || "").trim(),
    line2: String(source.line2 || "").trim(),
    city: String(source.city || "").trim(),
    state: String(source.state || "").trim(),
    postalCode: String(source.postalCode || "").trim(),
    country: String(source.country || "").trim(),
  };
}

function buildOrderNumber() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const random = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${yyyy}${mm}${dd}-${random}`;
}

function prettyFulfillmentStatus(status) {
  const normalized = String(status || "").toLowerCase();
  switch (normalized) {
    case "pending":
      return "Pending";
    case "processing":
      return "Processing";
    case "shipped":
      return "Shipped";
    case "delivered":
      return "Delivered";
    case "cancelled":
      return "Cancelled";
    case "returned":
      return "Returned";
    default:
      return "Unknown";
  }
}

function addDuration(startDate, durationValue, durationUnit) {
  const parsed = new Date(startDate);
  if (Number.isNaN(parsed.getTime())) return null;
  const endDate = new Date(parsed);
  const value = Math.max(1, Number(durationValue) || 1);
  if (durationUnit === "month") {
    endDate.setMonth(endDate.getMonth() + value);
    return endDate;
  }
  if (durationUnit === "week") {
    endDate.setDate(endDate.getDate() + value * 7);
    return endDate;
  }
  endDate.setDate(endDate.getDate() + value);
  return endDate;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function getSoonestRentalEndDate(order) {
  const endDates = Array.isArray(order.items)
    ? order.items
        .map((item) => addDuration(item.startDate, item.durationValue, item.durationUnit))
        .filter((date) => date instanceof Date && !Number.isNaN(date.getTime()))
    : [];

  if (endDates.length === 0) return null;
  return endDates.sort((a, b) => a.getTime() - b.getTime())[0];
}

async function sendEmail({ to, subject, text, html }) {
  if (!mailTransporter || !to) return false;
  try {
    await mailTransporter.sendMail({
      from: `"${emailConfig.fromName}" <${emailConfig.fromEmail}>`,
      to,
      subject,
      text,
      html,
    });
    return true;
  } catch (error) {
    console.error("Email send failed:", error.message);
    return false;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function verifyGoogleIdToken(idToken) {
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!response.ok) {
    throw new Error("Invalid Google token.");
  }
  return response.json();
}

function renderEmailTemplate({ eyebrow, title, intro, bodyHtml, ctaText, ctaHref, footerNote }) {
  const safeEyebrow = escapeHtml(eyebrow);
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeCtaText = escapeHtml(ctaText || "");
  const safeCtaHref = escapeHtml(ctaHref || "");
  const safeFooterNote = escapeHtml(footerNote || "");
  const logoUrl = escapeHtml(
    String(process.env.EMAIL_LOGO_URL || `${getFrontendBaseUrl()}/logo.png`).trim()
  );

  return `
    <div style="margin:0;padding:24px;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
        <div style="padding:18px 24px 14px 24px;background:#ffffff;border-bottom:1px solid #eef2f7;text-align:center;">
          <img src="${logoUrl}" alt="Leihfluss" style="height:34px;width:auto;max-width:180px;display:inline-block;" />
        </div>
        <div style="padding:20px 24px;background:#f0fdf4;color:#111827;border-bottom:1px solid #dcfce7;">
          <p style="margin:0;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;color:#3f6212;">${safeEyebrow}</p>
          <h1 style="margin:8px 0 0 0;font-size:26px;line-height:1.2;color:#111827;">${safeTitle}</h1>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#374151;">${safeIntro}</p>
          ${bodyHtml}
          ${
            ctaText && ctaHref
              ? `<div style="margin-top:22px;">
                   <a href="${safeCtaHref}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;font-size:14px;">${safeCtaText}</a>
                 </div>`
              : ""
          }
        </div>
        <div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#fafafa;">
          <p style="margin:0;font-size:12px;color:#6b7280;">${safeFooterNote || "Thanks for choosing Leihfluss."}</p>
        </div>
      </div>
    </div>
  `;
}

async function sendOrderFulfillmentStatusEmail(order) {
  const statusLabel = prettyFulfillmentStatus(order.fulfillmentStatus);
  const orderUrl = `${getFrontendBaseUrl()}/profile`;
  const subject = `Order ${order.orderNumber} is now ${statusLabel}`;
  const text = [
    `Hi ${order.customer?.name || "Customer"},`,
    "",
    `Your order ${order.orderNumber} status changed to ${statusLabel}.`,
    `Track your order from your account: ${orderUrl}`,
    "",
    "Thank you,",
    "Leihfluss",
  ].join("\n");
  const html = renderEmailTemplate({
    eyebrow: "Order Update",
    title: `Order ${order.orderNumber}`,
    intro: `Hi ${order.customer?.name || "Customer"}, your order status has changed.`,
    bodyHtml: `
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0 0 6px 0;font-size:13px;color:#6b7280;">Current Status</p>
        <p style="margin:0;font-size:22px;font-weight:800;color:#111827;">${escapeHtml(statusLabel)}</p>
      </div>
    `,
    ctaText: "Track My Order",
    ctaHref: orderUrl,
    footerNote: "If you have any questions, reply to this email and our team will help you.",
  });
  return sendEmail({
    to: order.customer?.email || "",
    subject,
    text,
    html,
  });
}

async function sendRentalEndingReminderEmail(order, rentalEndDate) {
  if (!(rentalEndDate instanceof Date) || Number.isNaN(rentalEndDate.getTime())) return false;
  const orderUrl = `${getFrontendBaseUrl()}/profile`;
  const formattedDate = rentalEndDate.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
  const subject = `Rental period ending soon for order ${order.orderNumber}`;
  const text = [
    `Hi ${order.customer?.name || "Customer"},`,
    "",
    `Your rental period for order ${order.orderNumber} is ending on ${formattedDate}.`,
    `Please review your rental from your account: ${orderUrl}`,
    "",
    "Thank you,",
    "Leihfluss",
  ].join("\n");
  const html = renderEmailTemplate({
    eyebrow: "Rental Reminder",
    title: "Your Rental Is Ending Soon",
    intro: `Hi ${order.customer?.name || "Customer"}, this is a reminder about your rental timeline.`,
    bodyHtml: `
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px;">
        <p style="margin:0 0 6px 0;font-size:13px;color:#9a3412;">Order</p>
        <p style="margin:0 0 8px 0;font-size:20px;font-weight:800;color:#7c2d12;">${escapeHtml(order.orderNumber)}</p>
        <p style="margin:0;font-size:14px;color:#7c2d12;">Rental end date: <strong>${escapeHtml(formattedDate)}</strong></p>
      </div>
    `,
    ctaText: "Review My Rental",
    ctaHref: orderUrl,
    footerNote: "Please return or extend your rental before the end date to avoid interruptions.",
  });

  const userSent = await sendEmail({
    to: order.customer?.email || "",
    subject,
    text,
    html,
  });

  const adminRecipient = String(process.env.ADMIN_NOTIFICATION_EMAIL || "").trim();
  if (adminRecipient) {
    await sendEmail({
      to: adminRecipient,
      subject: `[Admin] ${subject}`,
      text: `${text}\n\nCustomer email: ${order.customer?.email || "-"}`,
      html: `${html}<p>Customer email: ${order.customer?.email || "-"}</p>`,
    });
  }

  return userSent;
}

function buildSixDigitOtp() {
  const value = crypto.randomInt(0, 1000000);
  return String(value).padStart(6, "0");
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

async function sendSignupOtpEmail(email, otp, name) {
  const subject = "Your Leihfluss verification code";
  const text = [
    `Hi ${name || "there"},`,
    "",
    `Your verification code is: ${otp}`,
    "This code expires in 10 minutes.",
    "",
    "If you did not request this, please ignore this email.",
    "Leihfluss",
  ].join("\n");
  const html = renderEmailTemplate({
    eyebrow: "Email Verification",
    title: "Verify Your Account",
    intro: `Hi ${name || "there"}, use the code below to complete your signup.`,
    bodyHtml: `
      <div style="margin:8px 0 4px 0;border:1px dashed #a3e635;background:#f7fee7;border-radius:14px;padding:18px;text-align:center;">
        <p style="margin:0 0 8px 0;font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:#4d7c0f;font-weight:700;">One-Time Password</p>
        <p style="margin:0;font-size:38px;letter-spacing:9px;font-weight:900;color:#365314;">${escapeHtml(otp)}</p>
      </div>
      <p style="margin:12px 0 0 0;font-size:13px;color:#6b7280;">This OTP expires in 10 minutes.</p>
    `,
    footerNote: "If you did not request this code, you can safely ignore this email.",
  });
  return sendEmail({ to: email, subject, text, html });
}

function formatCurrencyAmount(amount, currency = WEBSITE_CURRENCY) {
  const numericAmount = Number(amount) || 0;
  const normalizedCurrency = String(currency || WEBSITE_CURRENCY).toUpperCase();
  try {
    return new Intl.NumberFormat("en-DE", {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numericAmount);
  } catch {
    return `${normalizedCurrency} ${numericAmount.toFixed(2)}`;
  }
}

function buildOrderItemsEmailRows(order) {
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return `<p style="margin:0;font-size:14px;color:#374151;">No line items available.</p>`;
  }

  return order.items
    .map((item) => {
      const title = escapeHtml(item.title || "Item");
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const lineTotal = formatCurrencyAmount(item.lineTotal, order.currency || WEBSITE_CURRENCY);
      const durationLabel = escapeHtml(item.durationLabel || "");
      return `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;">
            <strong>${title}</strong>${durationLabel ? `<div style="margin-top:4px;color:#6b7280;font-size:12px;">${durationLabel}</div>` : ""}
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;text-align:center;">${quantity}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;text-align:right;">${escapeHtml(
            lineTotal
          )}</td>
        </tr>
      `;
    })
    .join("");
}

async function sendWelcomeEmail(user) {
  if (!user?.email) return false;
  const profileUrl = `${getFrontendBaseUrl()}/profile`;
  const name = user.name || "there";
  const subject = "Welcome to Leihfluss";
  const text = [
    `Hi ${name},`,
    "",
    "Welcome to Leihfluss. Your account is ready and you can start renting now.",
    `Manage your account here: ${profileUrl}`,
    "",
    "Thank you,",
    "Leihfluss",
  ].join("\n");

  const html = renderEmailTemplate({
    eyebrow: "Welcome",
    title: "Your Leihfluss account is ready",
    intro: `Hi ${name}, welcome to Leihfluss.`,
    bodyHtml: `
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0;font-size:14px;color:#374151;">You can now explore products and place your first rental order.</p>
      </div>
    `,
    ctaText: "Go To My Account",
    ctaHref: profileUrl,
    footerNote: "Need help? Reply to this email and our team will assist you.",
  });

  return sendEmail({
    to: user.email,
    subject,
    text,
    html,
  });
}

async function sendOrderCreatedEmail(order) {
  if (!order?.customer?.email) return false;
  const orderUrl = `${getFrontendBaseUrl()}/profile`;
  const currency = order.currency || WEBSITE_CURRENCY;
  const totalLabel = formatCurrencyAmount(order.total, currency);
  const subject = `Order placed successfully: ${order.orderNumber}`;
  const text = [
    `Hi ${order.customer?.name || "Customer"},`,
    "",
    `We received your order ${order.orderNumber}.`,
    `Order total: ${totalLabel}`,
    "Payment is pending until your checkout is completed.",
    `View your order: ${orderUrl}`,
    "",
    "Thank you,",
    "Leihfluss",
  ].join("\n");

  const html = renderEmailTemplate({
    eyebrow: "Order Received",
    title: `Order ${order.orderNumber} created`,
    intro: `Hi ${order.customer?.name || "Customer"}, we received your order and are waiting for payment confirmation.`,
    bodyHtml: `
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0 0 8px 0;font-size:13px;color:#6b7280;">Order Total</p>
        <p style="margin:0;font-size:24px;font-weight:800;color:#111827;">${escapeHtml(totalLabel)}</p>
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-collapse:collapse;">
        <thead>
          <tr>
            <th align="left" style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-transform:uppercase;">Item</th>
            <th align="center" style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-transform:uppercase;">Qty</th>
            <th align="right" style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-transform:uppercase;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${buildOrderItemsEmailRows(order)}
        </tbody>
      </table>
    `,
    ctaText: "View My Orders",
    ctaHref: orderUrl,
    footerNote: "This order will be processed after payment is confirmed.",
  });

  return sendEmail({
    to: order.customer.email,
    subject,
    text,
    html,
  });
}

async function sendOrderPaymentConfirmedEmail(order) {
  if (!order?.customer?.email) return false;
  const orderUrl = `${getFrontendBaseUrl()}/profile`;
  const currency = order.currency || WEBSITE_CURRENCY;
  const totalLabel = formatCurrencyAmount(order.total, currency);
  const subject = `Payment confirmed for order ${order.orderNumber}`;
  const text = [
    `Hi ${order.customer?.name || "Customer"},`,
    "",
    `Payment for order ${order.orderNumber} is confirmed.`,
    `Paid amount: ${totalLabel}`,
    `Track order updates here: ${orderUrl}`,
    "",
    "Thank you,",
    "Leihfluss",
  ].join("\n");

  const html = renderEmailTemplate({
    eyebrow: "Payment Confirmed",
    title: `Payment received for ${order.orderNumber}`,
    intro: `Hi ${order.customer?.name || "Customer"}, your payment is successful and your order is now in processing.`,
    bodyHtml: `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px;">
        <p style="margin:0 0 6px 0;font-size:13px;color:#166534;">Paid Amount</p>
        <p style="margin:0;font-size:24px;font-weight:800;color:#14532d;">${escapeHtml(totalLabel)}</p>
      </div>
    `,
    ctaText: "Track My Order",
    ctaHref: orderUrl,
    footerNote: "We will email you again when the order status changes.",
  });

  return sendEmail({
    to: order.customer.email,
    subject,
    text,
    html,
  });
}

function getSupportRequestRecipientEmail() {
  const recipient = String(
    process.env.SUPPORT_REQUEST_EMAIL || process.env.ADMIN_NOTIFICATION_EMAIL || "support@leihfluss.de"
  ).trim();
  return recipient || "support@leihfluss.de";
}

async function sendSupportRequestNotificationEmail(supportRequest) {
  const supportRecipient = getSupportRequestRecipientEmail();
  const submittedAt = new Date(supportRequest.createdAt || Date.now());
  const submittedAtLabel = Number.isNaN(submittedAt.getTime())
    ? new Date().toISOString()
    : submittedAt.toISOString();
  const safeMessageHtml = escapeHtml(supportRequest.message || "").replace(/\r?\n/g, "<br />");
  const subjectLine = `New support request from ${supportRequest.name || "Website visitor"}`;
  const requestPageUrl = supportRequest.pageUrl || "-";

  const adminText = [
    "A new support request has been submitted.",
    "",
    `Name: ${supportRequest.name || "-"}`,
    `Email: ${supportRequest.email || "-"}`,
    `Phone: ${supportRequest.phone || "-"}`,
    `Subject: ${supportRequest.subject || "-"}`,
    `Locale: ${supportRequest.locale || "en"}`,
    `Source: ${supportRequest.source || "website"}`,
    `Page URL: ${requestPageUrl}`,
    `Submitted At (UTC): ${submittedAtLabel}`,
    "",
    "Message:",
    supportRequest.message || "-",
  ].join("\n");

  const adminHtml = renderEmailTemplate({
    eyebrow: "Support Request",
    title: "New Contact Submission",
    intro: "A user has submitted a new support request from your website.",
    bodyHtml: `
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0 0 6px 0;font-size:13px;color:#6b7280;">From</p>
        <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${escapeHtml(supportRequest.name || "-")}</p>
        <p style="margin:6px 0 0 0;font-size:14px;color:#1f2937;">${escapeHtml(supportRequest.email || "-")}</p>
      </div>
      <div style="margin-top:12px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0 0 8px 0;font-size:13px;color:#6b7280;">Details</p>
        <p style="margin:0;font-size:14px;color:#111827;"><strong>Phone:</strong> ${escapeHtml(supportRequest.phone || "-")}</p>
        <p style="margin:6px 0 0 0;font-size:14px;color:#111827;"><strong>Subject:</strong> ${escapeHtml(supportRequest.subject || "-")}</p>
        <p style="margin:6px 0 0 0;font-size:14px;color:#111827;"><strong>Source:</strong> ${escapeHtml(supportRequest.source || "website")}</p>
        <p style="margin:6px 0 0 0;font-size:14px;color:#111827;"><strong>Locale:</strong> ${escapeHtml((supportRequest.locale || "en").toUpperCase())}</p>
        <p style="margin:6px 0 0 0;font-size:14px;color:#111827;"><strong>Page URL:</strong> ${escapeHtml(requestPageUrl)}</p>
        <p style="margin:6px 0 0 0;font-size:14px;color:#111827;"><strong>Submitted At (UTC):</strong> ${escapeHtml(submittedAtLabel)}</p>
      </div>
      <div style="margin-top:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0 0 8px 0;font-size:13px;color:#6b7280;">Message</p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#111827;">${safeMessageHtml || "-"}</p>
      </div>
    `,
    footerNote: "This is an automated support notification from Leihfluss.",
  });

  const adminSent = await sendEmail({
    to: supportRecipient,
    subject: subjectLine,
    text: adminText,
    html: adminHtml,
  });

  if (!supportRequest.email) {
    return { adminSent, customerAcknowledgementSent: false };
  }

  const customerText = [
    `Hi ${supportRequest.name || "there"},`,
    "",
    "Thanks for reaching out to Leihfluss support.",
    "We received your request and our team will reply as soon as possible.",
    "",
    "Summary:",
    `Subject: ${supportRequest.subject || "-"}`,
    `Message: ${supportRequest.message || "-"}`,
    "",
    "Best regards,",
    "Leihfluss Support",
  ].join("\n");

  const customerHtml = renderEmailTemplate({
    eyebrow: "Support Confirmation",
    title: "We Received Your Request",
    intro: `Hi ${supportRequest.name || "there"}, thanks for contacting Leihfluss support.`,
    bodyHtml: `
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0 0 6px 0;font-size:13px;color:#6b7280;">Subject</p>
        <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${escapeHtml(supportRequest.subject || "General inquiry")}</p>
      </div>
      <div style="margin-top:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:14px;">
        <p style="margin:0 0 8px 0;font-size:13px;color:#6b7280;">Your Message</p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#111827;">${safeMessageHtml || "-"}</p>
      </div>
    `,
    footerNote: "Our support team will get back to you shortly.",
  });

  const customerAcknowledgementSent = await sendEmail({
    to: supportRequest.email,
    subject: "We received your support request",
    text: customerText,
    html: customerHtml,
  });

  return { adminSent, customerAcknowledgementSent };
}

async function runRentalEndingReminderSweep() {
  const now = new Date();
  const target = new Date(now);
  target.setDate(now.getDate() + 1);
  target.setHours(0, 0, 0, 0);

  const targetDateKey = target.toISOString().slice(0, 10);
  const orders = await Order.find({
    paymentStatus: { $in: ["paid", "partially_paid"] },
    status: { $ne: "cancelled" },
    fulfillmentStatus: { $nin: ["cancelled", "returned"] },
  }).select(
    "_id orderNumber customer items paymentStatus status fulfillmentStatus rentalReminderSentForDates"
  );

  for (const order of orders) {
    const endDate = getSoonestRentalEndDate(order);
    if (!endDate) continue;
    const normalizedEnd = new Date(endDate);
    normalizedEnd.setHours(0, 0, 0, 0);
    const endDateKey = normalizedEnd.toISOString().slice(0, 10);
    if (endDateKey !== targetDateKey) continue;

    const alreadySent = Array.isArray(order.rentalReminderSentForDates)
      ? order.rentalReminderSentForDates.includes(targetDateKey)
      : false;
    if (alreadySent) continue;

    const sent = await sendRentalEndingReminderEmail(order, endDate);
    if (!sent) continue;

    order.rentalReminderSentForDates = Array.isArray(order.rentalReminderSentForDates)
      ? [...new Set([...order.rentalReminderSentForDates, targetDateKey])].slice(-20)
      : [targetDateKey];
    await order.save();
  }
}

function mapCategory(category) {
  const rawSeo = category?.seo || {};
  const rawContentHtml = rawSeo.contentHtml || {};
  return {
    id: String(category._id),
    name: category.name,
    slug: category.slug,
    image: category.image || null,
    parentId: category.parentId ? String(category.parentId) : null,
    seo: {
      metaTitle: String(rawSeo.metaTitle || ""),
      metaDescription: String(rawSeo.metaDescription || ""),
      metaKeywords: Array.isArray(rawSeo.metaKeywords)
        ? rawSeo.metaKeywords.map((keyword) => String(keyword || "").trim()).filter(Boolean)
        : [],
      canonicalUrl: String(rawSeo.canonicalUrl || ""),
      contentHtml: {
        en: String(rawContentHtml.en || ""),
        de: String(rawContentHtml.de || ""),
      },
    },
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

function normalizeCategorySeo(rawSeo) {
  const seo = rawSeo && typeof rawSeo === "object" ? rawSeo : {};
  const contentHtml = seo.contentHtml && typeof seo.contentHtml === "object" ? seo.contentHtml : {};
  const metaKeywordsInput = Array.isArray(seo.metaKeywords)
    ? seo.metaKeywords
    : String(seo.metaKeywords || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    metaTitle: String(seo.metaTitle || "").trim(),
    metaDescription: String(seo.metaDescription || "").trim(),
    metaKeywords: [...new Set(metaKeywordsInput.map((item) => String(item || "").trim()).filter(Boolean))],
    canonicalUrl: String(seo.canonicalUrl || "").trim(),
    contentHtml: {
      en: String(contentHtml.en || "").trim(),
      de: String(contentHtml.de || "").trim(),
    },
  };
}

function mapBanner(banner) {
  return {
    id: String(banner._id),
    title: banner.title,
    subtitle: banner.subtitle || "",
    description: banner.description || "",
    imageUrl: banner.imageUrl,
    buttonText: banner.buttonText || "",
    buttonLink: banner.buttonLink || "",
    position: banner.position,
    device: banner.device,
    sortOrder: banner.sortOrder || 0,
    validFrom: banner.validFrom,
    validUntil: banner.validUntil,
    isActive: banner.isActive,
    createdAt: banner.createdAt,
    updatedAt: banner.updatedAt,
  };
}

function mapBrand(brand) {
  return {
    id: String(brand._id),
    name: brand.name,
    slug: brand.slug,
    image: brand.image || null,
    isActive: Boolean(brand.isActive),
    createdAt: brand.createdAt,
    updatedAt: brand.updatedAt,
  };
}

function mapProduct(product) {
  const rawCategory = product.categoryId;
  const rawBrand = product.brandId;
  const category =
    rawCategory && typeof rawCategory === "object" && rawCategory._id
      ? {
          id: String(rawCategory._id),
          name: rawCategory.name,
          slug: rawCategory.slug,
        }
      : null;
  const brand =
    rawBrand && typeof rawBrand === "object" && rawBrand._id
      ? {
          id: String(rawBrand._id),
          name: rawBrand.name,
          slug: rawBrand.slug,
          image: rawBrand.image || null,
        }
      : null;
  const minDays = Math.max(1, Number(product.minimumRentalDays) || 7);
  const maxDays = Math.max(minDays, Number(product.maximumRentalDays) || 30);
  const fallbackMinWeeks = Math.max(1, Math.ceil(minDays / 7));
  const fallbackMaxWeeks = Math.max(fallbackMinWeeks, Math.ceil(maxDays / 7));
  const minWeeks = Math.max(1, Number(product.minimumRentalWeeks) || fallbackMinWeeks);
  const maxWeeks = Math.max(minWeeks, Number(product.maximumRentalWeeks) || fallbackMaxWeeks);

  return {
    id: String(product._id),
    title: product.title,
    titleI18n: {
      en: product.titleI18n?.en || product.title || "",
      de: product.titleI18n?.de || "",
    },
    slug: product.slug,
    description: product.description || "",
    descriptionI18n: {
      en: product.descriptionI18n?.en || product.description || "",
      de: product.descriptionI18n?.de || "",
    },
    shortDescription: product.shortDescription || "",
    shortDescriptionI18n: {
      en: product.shortDescriptionI18n?.en || product.shortDescription || "",
      de: product.shortDescriptionI18n?.de || "",
    },
    imageUrl: product.imageUrl || PRODUCT_IMAGE_PLACEHOLDER,
    galleryImages: product.galleryImages || [],
    sku: product.sku || "",
    tags: product.tags || [],
    brandId: brand ? brand.id : String(product.brandId || ""),
    brand: brand ? brand.name : product.brand || "",
    brandData: brand,
    categoryId: category ? category.id : product.categoryId ? String(product.categoryId) : "",
    category,
    monthlyPrice: product.monthlyPrice,
    buyerPrice: product.buyerPrice || 0,
    offerPrice: product.offerPrice || 0,
    monthlyBuyerPrice: product.monthlyBuyerPrice || 0,
    monthlyOfferPrice: product.monthlyOfferPrice || 0,
    stock: product.stock || 0,
    stockStatus: product.stockStatus || "in_stock",
    lowStockWarning: product.lowStockWarning || 0,
    maxRentalQuantity: product.maxRentalQuantity || 1,
    unit: product.unit || "piece",
    weightKg: product.weightKg || 0,
    minimumRentalMonths: product.minimumRentalMonths || 1,
    maximumRentalMonths: product.maximumRentalMonths || 24,
    minimumRentalWeeks: minWeeks,
    maximumRentalWeeks: maxWeeks,
    minimumRentalDays: minDays,
    maximumRentalDays: maxDays,
    rentalPeriodUnit: product.rentalPeriodUnit || "week",
    deliveryFee: product.deliveryFee || 0,
    deliveryLeadDays: Number.isInteger(product.deliveryLeadDays) ? product.deliveryLeadDays : 2,
    verificationRequired: product.verificationRequired !== false,
    depositEnabled: Boolean(product.depositEnabled),
    securityDeposit: product.securityDeposit || 0,
    replacementValue: product.replacementValue || 0,
    refundable: Boolean(product.refundable),
    specifications: product.specifications || [],
    seo: product.seo || {},
    rentalMode: product.rentalMode || "standard",
    occasionDailyRate: getOccasionDailyRate(product),
    // Derived (daily rate x 1..7 days) so the storefront shows what is charged.
    occasionPricing: getOccasionOptions(product),
    model: product.model || "",
    series: product.series || "",
    identifiers: { ean: product.identifiers?.ean || "", gtin: product.identifiers?.gtin || "", mpn: product.identifiers?.mpn || "" },
    includedItems: (product.includedItems || []).map((i) => ({ de: i.de || "", en: i.en || "", quantity: i.quantity || 1 })),
    imageAlts: (product.imageAlts || []).map((a) => ({ de: a.de || "", en: a.en || "" })),
    isMostPopular: Boolean(product.isMostPopular),
    isActive: Boolean(product.isActive),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

function normalizeLocalizedText(rawValue) {
  const value = rawValue && typeof rawValue === "object" ? rawValue : {};
  return {
    en: String(value.en || "").trim(),
    de: String(value.de || "").trim(),
  };
}

function normalizeBlogSeo(rawSeo) {
  const seo = rawSeo && typeof rawSeo === "object" ? rawSeo : {};
  const metaKeywordsInput = Array.isArray(seo.metaKeywords)
    ? seo.metaKeywords
    : String(seo.metaKeywords || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    metaTitle: String(seo.metaTitle || "").trim(),
    metaDescription: String(seo.metaDescription || "").trim(),
    metaKeywords: [...new Set(metaKeywordsInput.map((item) => String(item || "").trim()).filter(Boolean))],
    canonicalUrl: String(seo.canonicalUrl || "").trim(),
    ogTitle: String(seo.ogTitle || "").trim(),
    ogDescription: String(seo.ogDescription || "").trim(),
    ogImageUrl: String(seo.ogImageUrl || "").trim(),
  };
}

function mapBlogPost(post) {
  const rawCategory = post.categoryId;
  const category =
    rawCategory && typeof rawCategory === "object" && rawCategory._id
      ? {
          id: String(rawCategory._id),
          name: rawCategory.name,
          slug: rawCategory.slug,
        }
      : null;

  return {
    id: String(post._id),
    titleI18n: normalizeLocalizedText(post.titleI18n),
    excerptI18n: normalizeLocalizedText(post.excerptI18n),
    contentHtmlI18n: normalizeLocalizedText(post.contentHtmlI18n),
    categoryId: category ? category.id : String(post.categoryId || ""),
    category,
    slug: String(post.slug || ""),
    coverImageUrl: String(post.coverImageUrl || ""),
    tags: Array.isArray(post.tags) ? post.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [],
    readingTimeMinutes: Math.max(0, Number(post.readingTimeMinutes) || 0),
    seo: normalizeBlogSeo(post.seo),
    status: post.status === "published" ? "published" : "draft",
    publishedAt: post.publishedAt || null,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

function mapSupportRequest(request) {
  return {
    id: String(request._id),
    name: request.name,
    email: request.email,
    phone: request.phone || "",
    subject: request.subject || "",
    message: request.message,
    locale: request.locale || "en",
    source: request.source || "footer",
    pageUrl: request.pageUrl || "",
    status: request.status || "new",
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function mapOrder(order) {
  const rentalEndDate = getSoonestRentalEndDate(order);
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    userId: String(order.userId),
    customer: {
      name: order.customer?.name || "",
      email: order.customer?.email || "",
      phone: order.customer?.phone || "",
    },
    shippingAddress: {
      fullName: order.shippingAddress?.fullName || "",
      phone: order.shippingAddress?.phone || "",
      line1: order.shippingAddress?.line1 || "",
      line2: order.shippingAddress?.line2 || "",
      city: order.shippingAddress?.city || "",
      state: order.shippingAddress?.state || "",
      postalCode: order.shippingAddress?.postalCode || "",
      country: order.shippingAddress?.country || "",
    },
    items: Array.isArray(order.items)
      ? order.items.map((item) => ({
          productId: item.productId ? String(item.productId) : "",
          title: item.title,
          slug: item.slug || "",
          imageUrl: item.imageUrl || "",
          categoryName: item.categoryName || "",
          brandName: item.brandName || "",
          quantity: item.quantity || 1,
          unitPrice: item.unitPrice || 0,
          baseUnitPrice: item.baseUnitPrice || 0,
          durationValue: item.durationValue || 1,
          durationUnit: item.durationUnit || "week",
          startDate: item.startDate || "",
          depositEnabled: Boolean(item.depositEnabled),
          securityDeposit: item.securityDeposit || 0,
          deliveryFee: item.deliveryFee || 0,
          lineSubtotal: item.lineSubtotal || 0,
          lineDeposit: item.lineDeposit || 0,
          lineDelivery: item.lineDelivery || 0,
          lineTotal: item.lineTotal || 0,
          billingType: item.billingType || "one_time",
        }))
      : [],
    currency: WEBSITE_CURRENCY.toUpperCase(),
    subtotal: order.subtotal || 0,
    depositTotal: order.depositTotal || 0,
    deliveryTotal: order.deliveryTotal || 0,
    total: order.total || 0,
    status: order.status || "pending_payment",
    fulfillmentStatus: order.fulfillmentStatus || "pending",
    paymentStatus: order.paymentStatus || "unpaid",
    // One-time orders (all historical orders) have no recurring block.
    billingMode: order.billingMode || "one_time",
    recurring: order.recurring
      ? {
          interval: order.recurring.interval,
          billingCycles: order.recurring.billingCycles,
          successfulCycles: order.recurring.successfulCycles || 0,
          recurringAmount: order.recurring.recurringAmount || 0,
          totalRentalCommitment: order.recurring.totalRentalCommitment || 0,
          oneTimeCharges: order.recurring.oneTimeCharges || 0,
          dueToday: order.recurring.dueToday || 0,
          nextBillingDate: order.recurring.nextBillingDate ? new Date(order.recurring.nextBillingDate).toISOString() : "",
          status: order.recurring.status || "pending",
          lastPaymentAt: order.recurring.lastPaymentAt ? new Date(order.recurring.lastPaymentAt).toISOString() : "",
        }
      : null,
    stripeSubscriptionId: order.stripeSubscriptionId || "",
    stripeSubscriptionScheduleId: order.stripeSubscriptionScheduleId || "",
    stripeCheckoutSessionId: order.stripeCheckoutSessionId || "",
    stripePaymentIntentId: order.stripePaymentIntentId || "",
    rentalEndDate: rentalEndDate ? rentalEndDate.toISOString() : "",
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function buildCategoryTree(categories) {
  const nodes = new Map();
  const roots = [];

  categories.forEach((category) => {
    const mapped = { ...mapCategory(category), children: [] };
    nodes.set(mapped.id, mapped);
  });

  nodes.forEach((node) => {
    if (!node.parentId) {
      roots.push(node);
      return;
    }
    const parent = nodes.get(node.parentId);
    if (parent) {
      parent.children.push(node);
    }
  });

  return roots;
}

app.get("/health", (_, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

app.get("/api/internal/cron/rental-reminders", requireCronAuth, async (_, res) => {
  try {
    await runRentalEndingReminderSweep();
    return res.json({ ok: true, message: "Rental reminder sweep completed." });
  } catch (error) {
    console.error("Rental reminder sweep failed:", error.message);
    return res.status(500).json({ ok: false, message: "Rental reminder sweep failed." });
  }
});

app.get("/api/categories", async (req, res) => {
  const categories = await Category.find().sort({ createdAt: 1 });
  const tree = req.query.tree === "true";
  if (tree) {
    return res.json(buildCategoryTree(categories));
  }
  return res.json(categories.map(mapCategory));
});

app.get("/api/admin/categories", requireAdminAuth, async (req, res) => {
  const categories = await Category.find().sort({ createdAt: 1 });
  const tree = req.query.tree === "true";
  if (tree) {
    return res.json(buildCategoryTree(categories));
  }
  return res.json(categories.map(mapCategory));
});

app.get("/api/brands", async (_, res) => {
  const brands = await Brand.find({ isActive: true }).sort({ name: 1 });
  return res.json(brands.map(mapBrand));
});

app.get("/api/admin/brands", requireAdminAuth, async (_, res) => {
  const brands = await Brand.find().sort({ name: 1 });
  return res.json(brands.map(mapBrand));
});

app.post("/api/admin/brands", requireAdminAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const slug = String(req.body?.slug || "").trim().toLowerCase();
  const image = req.body?.image ? String(req.body.image).trim() : null;
  const isActive = req.body?.isActive !== false;

  if (!name || !slug) {
    return res.status(400).json({ message: "name and slug are required." });
  }

  const exists = await Brand.findOne({ slug }).select("_id").lean();
  if (exists) {
    return res.status(409).json({ message: "Brand slug already exists." });
  }

  const brand = await Brand.create({ name, slug, image, isActive: Boolean(isActive) });
  return res.status(201).json(mapBrand(brand));
});

app.put("/api/admin/brands/:id", requireAdminAuth, async (req, res) => {
  const brand = await Brand.findById(req.params.id);
  if (!brand) {
    return res.status(404).json({ message: "Brand not found." });
  }

  const name = String(req.body?.name || "").trim();
  const slug = String(req.body?.slug || "").trim().toLowerCase();
  const image = req.body?.image ? String(req.body.image).trim() : null;
  const isActive = req.body?.isActive !== false;

  if (!name || !slug) {
    return res.status(400).json({ message: "name and slug are required." });
  }

  const duplicate = await Brand.findOne({ slug, _id: { $ne: brand._id } }).select("_id").lean();
  if (duplicate) {
    return res.status(409).json({ message: "Brand slug already exists." });
  }

  brand.name = name;
  brand.slug = slug;
  brand.image = image;
  brand.isActive = Boolean(isActive);
  await brand.save();
  return res.json(mapBrand(brand));
});

app.delete("/api/admin/brands/:id", requireAdminAuth, async (req, res) => {
  const brand = await Brand.findById(req.params.id).lean();
  if (!brand) {
    return res.status(404).json({ message: "Brand not found." });
  }

  const linkedProducts = await Product.countDocuments({ brandId: brand._id });
  if (linkedProducts > 0) {
    return res.status(400).json({ message: "Cannot delete brand linked to products." });
  }

  await Brand.deleteOne({ _id: brand._id });
  return res.json({ message: "Brand deleted successfully." });
});

const adminLoginFailures = new Map();
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Per-instance throttle (serverless instances do not share memory), so it slows
// guessing rather than guaranteeing a global limit.
function adminLoginThrottleKey(req, identifier) {
  return `${req.ip || "unknown"}|${identifier}`;
}

function adminLoginBlocked(key) {
  const entry = adminLoginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > ADMIN_LOGIN_WINDOW_MS) {
    adminLoginFailures.delete(key);
    return false;
  }
  return entry.count >= ADMIN_LOGIN_MAX_FAILURES;
}

function recordAdminLoginFailure(key) {
  const entry = adminLoginFailures.get(key);
  if (!entry || Date.now() - entry.first > ADMIN_LOGIN_WINDOW_MS) {
    adminLoginFailures.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

app.post("/api/admin/auth/login", async (req, res) => {
  if (rejectWhenJwtSecretMissing(res)) return undefined;

  // Sign in with a username or an email address.
  const identifier = String(req.body?.identifier || req.body?.username || req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "").trim();
  if (!identifier || !password) {
    return res.status(400).json({ message: "username and password are required." });
  }

  const throttleKey = adminLoginThrottleKey(req, identifier);
  if (adminLoginBlocked(throttleKey)) {
    return res.status(429).json({ message: "Too many failed attempts. Try again in 15 minutes." });
  }

  const admin = await Admin.findOne(identifier.includes("@") ? { email: identifier } : { usernameKey: identifier });
  const isValid = admin ? await bcrypt.compare(password, admin.passwordHash) : false;
  if (!isValid) {
    recordAdminLoginFailure(throttleKey);
    return res.status(401).json({ message: "Invalid admin credentials." });
  }
  adminLoginFailures.delete(throttleKey);

  const token = buildAdminToken(admin);
  return res.json({
    message: "Admin login successful.",
    token,
    admin: {
      id: String(admin._id),
      name: admin.name,
      email: admin.email,
      username: admin.username || "",
    },
  });
});

app.get("/api/admin/auth/me", requireAdminAuth, (req, res) => {
  return res.json({
    admin: {
      id: req.admin.sub,
      email: req.admin.email,
      name: req.admin.name,
      role: req.admin.role,
    },
  });
});

app.post("/api/admin/auth/create", requireAdminAuth, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "").trim();
  const nameInput = String(req.body?.name || "").trim();

  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters." });
  }

  const existing = await Admin.findOne({ email }).select("_id").lean();
  if (existing) {
    return res.status(409).json({ message: "Admin already exists for this email." });
  }

  const derivedName = email.split("@")[0] || "Admin";
  const name = nameInput || derivedName;
  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await Admin.create({
    name,
    email,
    passwordHash,
  });

  return res.status(201).json({
    message: "Admin created successfully.",
    admin: {
      id: String(admin._id),
      name: admin.name,
      email: admin.email,
    },
  });
});

app.post("/api/uploads/category-image", requireAdminAuth, upload.single("image"), async (req, res) => {
  if (!hasCloudinaryConfig) {
    return res.status(500).json({
      message:
        "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.",
    });
  }

  if (!req.file) {
    return res.status(400).json({ message: "Image file is required." });
  }

  try {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "leihfluss/categories",
          resource_type: "image",
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      imageUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Image upload failed.",
      error: error.message,
    });
  }
});

app.post("/api/uploads/banner-image", requireAdminAuth, upload.single("image"), async (req, res) => {
  if (!hasCloudinaryConfig) {
    return res.status(500).json({
      message:
        "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.",
    });
  }

  if (!req.file) {
    return res.status(400).json({ message: "Image file is required." });
  }

  try {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "leihfluss/banners",
          resource_type: "image",
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      imageUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Banner image upload failed.",
      error: error.message,
    });
  }
});

app.post("/api/uploads/brand-image", requireAdminAuth, upload.single("image"), async (req, res) => {
  if (!hasCloudinaryConfig) {
    return res.status(500).json({
      message:
        "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.",
    });
  }

  if (!req.file) {
    return res.status(400).json({ message: "Image file is required." });
  }

  try {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "leihfluss/brands",
          resource_type: "image",
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      imageUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Brand image upload failed.",
      error: error.message,
    });
  }
});

app.post("/api/uploads/product-image", requireAdminAuth, upload.single("image"), async (req, res) => {
  if (!hasCloudinaryConfig) {
    return res.status(500).json({
      message:
        "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.",
    });
  }

  if (!req.file) {
    return res.status(400).json({ message: "Image file is required." });
  }

  try {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: productUploadFolder(),
          resource_type: "image",
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      imageUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Product image upload failed.",
      error: error.message,
    });
  }
});

app.post("/api/uploads/blog-image", requireAdminAuth, upload.single("image"), async (req, res) => {
  if (!hasCloudinaryConfig) {
    return res.status(500).json({
      message:
        "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.",
    });
  }

  if (!req.file) {
    return res.status(400).json({ message: "Image file is required." });
  }

  try {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "leihfluss/blogs",
          resource_type: "image",
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      imageUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Blog image upload failed.",
      error: error.message,
    });
  }
});

app.post("/api/categories", requireAdminAuth, async (req, res) => {
  const { name, slug, image = null, parentId = null, seo = {} } = req.body;
  if (!name?.en || !name?.de || !slug) {
    return res.status(400).json({
      message: "name.en, name.de, and slug are required.",
    });
  }

  const slugValue = String(slug).trim().toLowerCase();
  const exists = await Category.findOne({ slug: slugValue }).select("_id").lean();
  if (exists) {
    return res.status(409).json({ message: "Category slug already exists." });
  }

  if (parentId) {
    const parent = await Category.findById(parentId).select("_id").lean();
    if (!parent) {
      return res.status(400).json({ message: "parentId not found." });
    }
  }

  const newCategory = await Category.create({
    name: {
      en: String(name.en).trim(),
      de: String(name.de).trim(),
    },
    slug: slugValue,
    image: image ? String(image).trim() : null,
    parentId: parentId || null,
    seo: normalizeCategorySeo(seo),
  });

  return res.status(201).json(mapCategory(newCategory));
});

app.put("/api/categories/:id", requireAdminAuth, async (req, res) => {
  const categoryId = req.params.id;
  const { name, slug, image = null, parentId = null, seo = {} } = req.body;

  if (!name?.en || !name?.de || !slug) {
    return res.status(400).json({
      message: "name.en, name.de, and slug are required.",
    });
  }

  const category = await Category.findById(categoryId);
  if (!category) {
    return res.status(404).json({ message: "Category not found." });
  }

  const slugValue = String(slug).trim().toLowerCase();
  const duplicate = await Category.findOne({ slug: slugValue, _id: { $ne: categoryId } })
    .select("_id")
    .lean();
  if (duplicate) {
    return res.status(409).json({ message: "Category slug already exists." });
  }

  if (parentId && String(parentId) === String(categoryId)) {
    return res.status(400).json({ message: "Category cannot be set as its parent." });
  }

  if (parentId) {
    const parent = await Category.findById(parentId).select("_id").lean();
    if (!parent) {
      return res.status(400).json({ message: "parentId not found." });
    }
  }

  category.name = {
    en: String(name.en).trim(),
    de: String(name.de).trim(),
  };
  category.slug = slugValue;
  category.image = image ? String(image).trim() : null;
  category.parentId = parentId || null;
  category.seo = normalizeCategorySeo(seo);
  await category.save();

  return res.json(mapCategory(category));
});

app.delete("/api/categories/:id", requireAdminAuth, async (req, res) => {
  const categoryId = req.params.id;
  const cascade = req.query.cascade === "true";

  const categories = await Category.find().select("_id parentId").lean();
  const exists = categories.some((item) => String(item._id) === String(categoryId));
  if (!exists) {
    return res.status(404).json({ message: "Category not found." });
  }

  const directChildren = categories.filter(
    (item) => item.parentId && String(item.parentId) === String(categoryId)
  );
  if (directChildren.length > 0 && !cascade) {
    return res.status(400).json({
      message: "Category has subcategories. Use cascade=true to delete all children.",
    });
  }

  const idsToDelete = new Set([String(categoryId)]);
  let changed = true;
  while (changed) {
    changed = false;
    categories.forEach((item) => {
      if (item.parentId && idsToDelete.has(String(item.parentId)) && !idsToDelete.has(String(item._id))) {
        idsToDelete.add(String(item._id));
        changed = true;
      }
    });
  }

  await Category.deleteMany({ _id: { $in: [...idsToDelete] } });

  return res.json({
    message: "Category deleted successfully.",
    deletedCount: idsToDelete.size,
  });
});

app.get("/api/banners", async (req, res) => {
  const now = new Date();
  const device = String(req.query.device || "").trim().toLowerCase();
  const position = String(req.query.position || "home").trim().toLowerCase();

  const endOfLocalDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const query = {
    isActive: true,
    position,
    ...(device ? { device } : {}),
    $and: [
      { $or: [{ validFrom: null }, { validFrom: { $lte: endOfLocalDay } }] },
      { $or: [{ validUntil: null }, { validUntil: { $gte: now } }] },
    ],
  };

  const banners = await Banner.find(query).sort({ sortOrder: 1, createdAt: -1 });
  return res.json(banners.map(mapBanner));
});

app.get("/api/admin/banners", requireAdminAuth, async (req, res) => {
  const banners = await Banner.find().sort({ sortOrder: 1, createdAt: -1 });
  return res.json(banners.map(mapBanner));
});

app.post("/api/admin/banners", requireAdminAuth, async (req, res) => {
  const {
    title,
    subtitle = "",
    description = "",
    imageUrl,
    buttonText = "",
    buttonLink = "",
    position = "home",
    device,
    sortOrder = 0,
    validFrom = null,
    validUntil = null,
    isActive = true,
  } = req.body;

  if (!title || !imageUrl || !device) {
    return res.status(400).json({ message: "title, imageUrl and device are required." });
  }

  if (!["desktop", "mobile"].includes(String(device).toLowerCase())) {
    return res.status(400).json({ message: "device must be desktop or mobile." });
  }

  const banner = await Banner.create({
    title: String(title).trim(),
    subtitle: String(subtitle).trim(),
    description: String(description).trim(),
    imageUrl: String(imageUrl).trim(),
    buttonText: String(buttonText).trim(),
    buttonLink: String(buttonLink).trim(),
    position: String(position).trim().toLowerCase(),
    device: String(device).trim().toLowerCase(),
    sortOrder: Number(sortOrder) || 0,
    validFrom: validFrom ? new Date(validFrom + "T00:00:00") : null,
    validUntil: validUntil ? new Date(validUntil + "T00:00:00") : null,
    isActive: Boolean(isActive),
  });

  return res.status(201).json(mapBanner(banner));
});

app.put("/api/admin/banners/:id", requireAdminAuth, async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (!banner) {
    return res.status(404).json({ message: "Banner not found." });
  }

  const {
    title,
    subtitle = "",
    description = "",
    imageUrl,
    buttonText = "",
    buttonLink = "",
    position = "home",
    device,
    sortOrder = 0,
    validFrom = null,
    validUntil = null,
    isActive = true,
  } = req.body;

  if (!title || !imageUrl || !device) {
    return res.status(400).json({ message: "title, imageUrl and device are required." });
  }

  if (!["desktop", "mobile"].includes(String(device).toLowerCase())) {
    return res.status(400).json({ message: "device must be desktop or mobile." });
  }

  banner.title = String(title).trim();
  banner.subtitle = String(subtitle).trim();
  banner.description = String(description).trim();
  banner.imageUrl = String(imageUrl).trim();
  banner.buttonText = String(buttonText).trim();
  banner.buttonLink = String(buttonLink).trim();
  banner.position = String(position).trim().toLowerCase();
  banner.device = String(device).trim().toLowerCase();
  banner.sortOrder = Number(sortOrder) || 0;
  banner.validFrom = validFrom ? new Date(validFrom + "T00:00:00") : null;
  banner.validUntil = validUntil ? new Date(validUntil + "T00:00:00") : null;
  banner.isActive = Boolean(isActive);
  await banner.save();

  return res.json(mapBanner(banner));
});

app.delete("/api/admin/banners/:id", requireAdminAuth, async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (!banner) {
    return res.status(404).json({ message: "Banner not found." });
  }

  await Banner.deleteOne({ _id: banner._id });
  return res.json({ message: "Banner deleted successfully." });
});

app.get("/api/blogs", async (_, res) => {
  const posts = await BlogPost.find({ status: "published" })
    .populate("categoryId", "name slug")
    .sort({ publishedAt: -1, createdAt: -1 });
  return res.json(posts.map(mapBlogPost));
});

app.get("/api/blogs/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!slug) {
    return res.status(400).json({ message: "Blog slug is required." });
  }

  const post = await BlogPost.findOne({ slug, status: "published" }).populate("categoryId", "name slug");
  if (!post) {
    return res.status(404).json({ message: "Blog post not found." });
  }

  return res.json(mapBlogPost(post));
});

app.get("/api/admin/blogs", requireAdminAuth, async (_, res) => {
  const posts = await BlogPost.find()
    .populate("categoryId", "name slug")
    .sort({ updatedAt: -1, createdAt: -1 });
  return res.json(posts.map(mapBlogPost));
});

app.post("/api/admin/blogs", requireAdminAuth, async (req, res) => {
  const titleI18n = normalizeLocalizedText(req.body?.titleI18n);
  const excerptI18n = normalizeLocalizedText(req.body?.excerptI18n);
  const contentHtmlI18n = normalizeLocalizedText(req.body?.contentHtmlI18n);
  const categoryId = String(req.body?.categoryId || "").trim();
  const slug = String(req.body?.slug || "").trim().toLowerCase();
  const coverImageUrl = String(req.body?.coverImageUrl || "").trim();
  const tags = Array.isArray(req.body?.tags)
    ? req.body.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  const readingTimeMinutes = Math.max(0, Number(req.body?.readingTimeMinutes) || 0);
  const seo = normalizeBlogSeo(req.body?.seo);
  const status = String(req.body?.status || "draft").trim().toLowerCase();

  if (!slug || !categoryId || !titleI18n.en || !contentHtmlI18n.en) {
    return res.status(400).json({ message: "categoryId, slug, titleI18n.en and contentHtmlI18n.en are required." });
  }

  if (!["draft", "published"].includes(status)) {
    return res.status(400).json({ message: "status must be draft or published." });
  }

  const existing = await BlogPost.findOne({ slug }).select("_id").lean();
  if (existing) {
    return res.status(409).json({ message: "Blog slug already exists." });
  }

  const category = await Category.findById(categoryId).select("_id").lean();
  if (!category) {
    return res.status(400).json({ message: "categoryId not found." });
  }

  const nextStatus = status === "published" ? "published" : "draft";
  const rawPublishedAt = req.body?.publishedAt ? new Date(req.body.publishedAt) : null;
  const publishedAt =
    nextStatus === "published"
      ? rawPublishedAt && !Number.isNaN(rawPublishedAt.getTime())
        ? rawPublishedAt
        : new Date()
      : null;

  const post = await BlogPost.create({
    titleI18n,
    excerptI18n,
    contentHtmlI18n,
    categoryId,
    slug,
    coverImageUrl,
    tags,
    readingTimeMinutes,
    seo,
    status: nextStatus,
    publishedAt,
  });

  const populated = await BlogPost.findById(post._id).populate("categoryId", "name slug");
  return res.status(201).json(mapBlogPost(populated));
});

app.put("/api/admin/blogs/:id", requireAdminAuth, async (req, res) => {
  const post = await BlogPost.findById(req.params.id);
  if (!post) {
    return res.status(404).json({ message: "Blog post not found." });
  }

  const titleI18n = normalizeLocalizedText(req.body?.titleI18n);
  const excerptI18n = normalizeLocalizedText(req.body?.excerptI18n);
  const contentHtmlI18n = normalizeLocalizedText(req.body?.contentHtmlI18n);
  const categoryId = String(req.body?.categoryId || "").trim();
  const slug = String(req.body?.slug || "").trim().toLowerCase();
  const coverImageUrl = String(req.body?.coverImageUrl || "").trim();
  const tags = Array.isArray(req.body?.tags)
    ? req.body.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
    : [];
  const readingTimeMinutes = Math.max(0, Number(req.body?.readingTimeMinutes) || 0);
  const seo = normalizeBlogSeo(req.body?.seo);
  const status = String(req.body?.status || "draft").trim().toLowerCase();

  if (!slug || !categoryId || !titleI18n.en || !contentHtmlI18n.en) {
    return res.status(400).json({ message: "categoryId, slug, titleI18n.en and contentHtmlI18n.en are required." });
  }

  if (!["draft", "published"].includes(status)) {
    return res.status(400).json({ message: "status must be draft or published." });
  }

  const duplicate = await BlogPost.findOne({ slug, _id: { $ne: post._id } }).select("_id").lean();
  if (duplicate) {
    return res.status(409).json({ message: "Blog slug already exists." });
  }

  const category = await Category.findById(categoryId).select("_id").lean();
  if (!category) {
    return res.status(400).json({ message: "categoryId not found." });
  }

  const nextStatus = status === "published" ? "published" : "draft";
  const rawPublishedAt = req.body?.publishedAt ? new Date(req.body.publishedAt) : null;
  const publishDateFromPayload = rawPublishedAt && !Number.isNaN(rawPublishedAt.getTime()) ? rawPublishedAt : null;
  const publishedAt =
    nextStatus === "published"
      ? publishDateFromPayload || post.publishedAt || new Date()
      : null;

  post.titleI18n = titleI18n;
  post.excerptI18n = excerptI18n;
  post.contentHtmlI18n = contentHtmlI18n;
  post.categoryId = categoryId;
  post.slug = slug;
  post.coverImageUrl = coverImageUrl;
  post.tags = tags;
  post.readingTimeMinutes = readingTimeMinutes;
  post.seo = seo;
  post.status = nextStatus;
  post.publishedAt = publishedAt;
  await post.save();

  const populated = await BlogPost.findById(post._id).populate("categoryId", "name slug");
  return res.json(mapBlogPost(populated));
});

app.delete("/api/admin/blogs/:id", requireAdminAuth, async (req, res) => {
  const post = await BlogPost.findById(req.params.id).lean();
  if (!post) {
    return res.status(404).json({ message: "Blog post not found." });
  }

  await BlogPost.deleteOne({ _id: post._id });
  return res.json({ message: "Blog post deleted successfully." });
});

app.get("/api/products/popular", async (_, res) => {
  const products = await Product.find({ isActive: true, isMostPopular: true })
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image")
    .sort({ createdAt: -1 })
    .limit(12);

  return res.json(products.map(mapProduct));
});

app.get("/api/products/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!slug) {
    return res.status(400).json({ message: "Product slug is required." });
  }

  const product = await Product.findOne({ slug, isActive: true })
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image");

  if (!product) {
    return res.status(404).json({ message: "Product not found." });
  }

  return res.json(mapProduct(product));
});

app.get("/api/products", async (_, res) => {
  const products = await Product.find({ isActive: true })
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image")
    .sort({ createdAt: -1 });

  return res.json(products.map(mapProduct));
});

app.get("/api/admin/products", requireAdminAuth, async (_, res) => {
  const products = await Product.find()
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image")
    .sort({ createdAt: -1 });
  return res.json(products.map(mapProduct));
});

app.post("/api/admin/products", requireAdminAuth, async (req, res) => {
  const {
    title,
    titleI18n = {},
    slug,
    description = "",
    descriptionI18n = {},
    shortDescription = "",
    shortDescriptionI18n = {},
    imageUrl,
    galleryImages = [],
    sku = "",
    tags = [],
    categoryId,
    brandId,
    monthlyPrice,
    buyerPrice = 0,
    offerPrice = 0,
    monthlyBuyerPrice = 0,
    monthlyOfferPrice = 0,
    weeklyAutoDiscount = 0,
    monthlyAutoDiscount = 0,
    stock = 0,
    stockStatus = "in_stock",
    lowStockWarning = 5,
    maxRentalQuantity = 1,
    unit = "piece",
    weightKg = 0,
    minimumRentalMonths = 1,
    maximumRentalMonths = 24,
    minimumRentalWeeks,
    maximumRentalWeeks,
    minimumRentalDays = 7,
    maximumRentalDays = 30,
    rentalPeriodUnit = "week",
    deliveryFee = 0,
    deliveryLeadDays: createLeadDays,
    verificationRequired = true,
    depositEnabled = false,
    securityDeposit = 0,
    replacementValue = 0,
    refundable = true,
    specifications = [],
    seo = {},
    isMostPopular = false,
    isActive = true,
  } = req.body;

  if (!(title || titleI18n?.en) || !slug || !categoryId || !brandId || monthlyPrice === undefined) {
    return res.status(400).json({
      message: "title (or titleI18n.en), slug, categoryId, brandId, monthlyPrice are required.",
    });
  }

  const minimumRentalMonthsValue = toPositiveNumber(minimumRentalMonths, 1);
  const maximumRentalMonthsValue = toPositiveNumber(maximumRentalMonths, 24);
  if (minimumRentalMonthsValue > maximumRentalMonthsValue) {
    return res.status(400).json({ message: "minimumRentalMonths cannot be greater than maximumRentalMonths." });
  }

  const minimumRentalDaysValue = toPositiveNumber(minimumRentalDays, 7);
  const maximumRentalDaysValue = toPositiveNumber(maximumRentalDays, 30);
  if (minimumRentalDaysValue > maximumRentalDaysValue) {
    return res.status(400).json({ message: "minimumRentalDays cannot be greater than maximumRentalDays." });
  }

  const minimumRentalWeeksValue = toPositiveNumber(minimumRentalWeeks, Math.ceil(minimumRentalDaysValue / 7));
  const maximumRentalWeeksValue = toPositiveNumber(maximumRentalWeeks, Math.ceil(maximumRentalDaysValue / 7));
  if (minimumRentalWeeksValue > maximumRentalWeeksValue) {
    return res.status(400).json({ message: "minimumRentalWeeks cannot be greater than maximumRentalWeeks." });
  }

  const category = await Category.findById(categoryId).select("_id").lean();
  if (!category) {
    return res.status(400).json({ message: "categoryId not found." });
  }
  const brandRecord = await Brand.findById(brandId).select("_id name").lean();
  if (!brandRecord) {
    return res.status(400).json({ message: "brandId not found." });
  }

  const slugValue = String(slug).trim().toLowerCase();
  const existing = await Product.findOne({ slug: slugValue }).select("_id").lean();
  if (existing) {
    return res.status(409).json({ message: "Product slug already exists." });
  }

  const product = await Product.create({
    title: String(title || titleI18n?.en || "").trim(),
    titleI18n: {
      en: String(titleI18n?.en || title || "").trim(),
      de: String(titleI18n?.de || "").trim(),
    },
    slug: slugValue,
    description: String(description).trim(),
    descriptionI18n: {
      en: String(descriptionI18n?.en || description || "").trim(),
      de: String(descriptionI18n?.de || "").trim(),
    },
    shortDescription: String(shortDescription).trim(),
    shortDescriptionI18n: {
      en: String(shortDescriptionI18n?.en || shortDescription || "").trim(),
      de: String(shortDescriptionI18n?.de || "").trim(),
    },
    imageUrl: String(imageUrl || "").trim() || PRODUCT_IMAGE_PLACEHOLDER,
    galleryImages: Array.isArray(galleryImages) ? galleryImages.filter(Boolean).map(String) : [],
    sku: String(sku).trim(),
    brand: brandRecord.name,
    brandId: brandRecord._id,
    tags: Array.isArray(tags) ? tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
    categoryId,
    monthlyPrice: Number(monthlyPrice),
    buyerPrice: Number(buyerPrice) || 0,
    offerPrice: Number(offerPrice) || 0,
    monthlyBuyerPrice: Number(monthlyBuyerPrice) || 0,
    monthlyOfferPrice: Number(monthlyOfferPrice) || 0,
    weeklyAutoDiscount: Number(weeklyAutoDiscount) || 0,
    monthlyAutoDiscount: Number(monthlyAutoDiscount) || 0,
    stock: Number(stock) || 0,
    stockStatus: String(stockStatus || "in_stock").trim(),
    lowStockWarning: Number(lowStockWarning) || 0,
    maxRentalQuantity: Number(maxRentalQuantity) || 1,
    unit: String(unit || "piece").trim(),
    weightKg: Number(weightKg) || 0,
    minimumRentalMonths: minimumRentalMonthsValue,
    maximumRentalMonths: maximumRentalMonthsValue,
    minimumRentalWeeks: minimumRentalWeeksValue,
    maximumRentalWeeks: maximumRentalWeeksValue,
    minimumRentalDays: minimumRentalDaysValue,
    maximumRentalDays: maximumRentalDaysValue,
    rentalPeriodUnit: ["day", "week", "month"].includes(String(rentalPeriodUnit))
      ? String(rentalPeriodUnit)
      : "week",
    deliveryFee: Math.max(0, Number(deliveryFee) || 0),
    ...(parseDeliveryLeadDays(createLeadDays) !== null ? { deliveryLeadDays: parseDeliveryLeadDays(createLeadDays) } : {}),
    
    verificationRequired: Boolean(verificationRequired),
    depositEnabled: Boolean(depositEnabled),
    securityDeposit: Boolean(depositEnabled) ? Number(securityDeposit) || 0 : 0,
    replacementValue: Number(replacementValue) || 0,
    refundable: Boolean(refundable),
    specifications: Array.isArray(specifications)
      ? specifications
          .map((spec) => ({
            key: String(spec?.key || "").trim(),
            value: String(spec?.value || "").trim(),
          }))
          .filter((spec) => spec.key && spec.value)
      : [],
    seo: {
      metaTitle: String(seo?.metaTitle || "").trim(),
      metaDescription: String(seo?.metaDescription || "").trim(),
      metaKeywords: Array.isArray(seo?.metaKeywords)
        ? seo.metaKeywords.map((keyword) => String(keyword).trim()).filter(Boolean)
        : [],
      canonicalUrl: String(seo?.canonicalUrl || "").trim(),
      ogTitle: String(seo?.ogTitle || "").trim(),
      ogDescription: String(seo?.ogDescription || "").trim(),
      ogImageUrl: String(seo?.ogImageUrl || "").trim(),
    },
    isMostPopular: Boolean(isMostPopular),
    isActive: Boolean(isActive),
  });

  const populated = await Product.findById(product._id)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image");
  return res.status(201).json(mapProduct(populated));
});

// Rental terms the owner can change without re-importing anything: the day-based
// prices of an occasion product and the delivery lead time of any product.
app.patch("/api/admin/products/:id/rental-terms", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: "Product not found." });
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found." });

  if (req.body?.occasionDailyRate !== undefined || req.body?.occasionPricing !== undefined) {
    if (product.rentalMode !== "occasion") {
      return res.status(400).json({ message: "A daily price applies to occasion products only." });
    }
    const checked =
      req.body.occasionDailyRate !== undefined
        ? normalizeDailyRate(req.body.occasionDailyRate)
        : dailyRateFromLegacyOptions(req.body.occasionPricing);
    if (checked.errors.length) return res.status(400).json({ message: checked.errors[0], errors: checked.errors });
    product.occasionDailyRate = checked.rate;
    product.occasionPricing = [];
  }
  if (req.body?.deliveryLeadDays !== undefined) {
    const days = parseDeliveryLeadDays(req.body.deliveryLeadDays);
    if (days === null) return res.status(400).json({ message: "deliveryLeadDays must be a whole number from 0 to 30." });
    product.deliveryLeadDays = days;
  }
  await product.save();
  return res.json({
    rentalMode: product.rentalMode,
    occasionDailyRate: getOccasionDailyRate(product),
    occasionPricing: getOccasionOptions(product),
    deliveryLeadDays: product.deliveryLeadDays,
  });
});

app.put("/api/admin/products/:id", requireAdminAuth, async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ message: "Product not found." });
  }

  const {
    title,
    titleI18n = {},
    slug,
    description = "",
    descriptionI18n = {},
    shortDescription = "",
    shortDescriptionI18n = {},
    imageUrl,
    galleryImages = [],
    sku = "",
    tags = [],
    categoryId,
    brandId,
    monthlyPrice,
    buyerPrice = 0,
    offerPrice = 0,
    monthlyBuyerPrice = 0,
    monthlyOfferPrice = 0,
    weeklyAutoDiscount = 0,
    monthlyAutoDiscount = 0,
    stock = 0,
    stockStatus = "in_stock",
    lowStockWarning = 5,
    maxRentalQuantity = 1,
    unit = "piece",
    weightKg = 0,
    minimumRentalMonths = 1,
    maximumRentalMonths = 24,
    minimumRentalWeeks,
    maximumRentalWeeks,
    minimumRentalDays = 7,
    maximumRentalDays = 30,
    rentalPeriodUnit = "week",
    deliveryFee = 0,
    deliveryLeadDays,
    rentalMode,
    occasionDailyRate,
    verificationRequired = true,
    depositEnabled = false,
    securityDeposit = 0,
    replacementValue = 0,
    refundable = true,
    specifications = [],
    seo = {},
    isMostPopular = false,
    isActive = true,
  } = req.body;

  if (!(title || titleI18n?.en) || !slug || !imageUrl || !categoryId || !brandId || monthlyPrice === undefined) {
    return res.status(400).json({
      message: "title (or titleI18n.en), slug, imageUrl, categoryId, brandId, monthlyPrice are required.",
    });
  }

  // Rental mode, day prices and lead time are optional here: the standard editor
  // does not send them, and then they are left exactly as they are.
  const nextRentalMode = rentalMode === undefined ? product.rentalMode || "standard" : String(rentalMode);
  if (!["standard", "occasion"].includes(nextRentalMode)) {
    return res.status(400).json({ message: "rentalMode must be standard or occasion." });
  }
  let nextDailyRate = null;
  if (occasionDailyRate !== undefined) {
    const checked = normalizeDailyRate(occasionDailyRate);
    if (nextRentalMode === "occasion" && checked.errors.length) {
      return res.status(400).json({ message: checked.errors[0], errors: checked.errors });
    }
    nextDailyRate = nextRentalMode === "occasion" ? checked.rate : 0;
  }
  let nextLeadDays = null;
  if (deliveryLeadDays !== undefined) {
    nextLeadDays = parseDeliveryLeadDays(deliveryLeadDays);
    if (nextLeadDays === null) return res.status(400).json({ message: "deliveryLeadDays must be a whole number from 0 to 30." });
  }

  const minimumRentalMonthsValue = toPositiveNumber(minimumRentalMonths, 1);
  const maximumRentalMonthsValue = toPositiveNumber(maximumRentalMonths, 24);
  if (minimumRentalMonthsValue > maximumRentalMonthsValue) {
    return res.status(400).json({ message: "minimumRentalMonths cannot be greater than maximumRentalMonths." });
  }

  const minimumRentalDaysValue = toPositiveNumber(minimumRentalDays, 7);
  const maximumRentalDaysValue = toPositiveNumber(maximumRentalDays, 30);
  if (minimumRentalDaysValue > maximumRentalDaysValue) {
    return res.status(400).json({ message: "minimumRentalDays cannot be greater than maximumRentalDays." });
  }

  const minimumRentalWeeksValue = toPositiveNumber(minimumRentalWeeks, Math.ceil(minimumRentalDaysValue / 7));
  const maximumRentalWeeksValue = toPositiveNumber(maximumRentalWeeks, Math.ceil(maximumRentalDaysValue / 7));
  if (minimumRentalWeeksValue > maximumRentalWeeksValue) {
    return res.status(400).json({ message: "minimumRentalWeeks cannot be greater than maximumRentalWeeks." });
  }

  const category = await Category.findById(categoryId).select("_id").lean();
  if (!category) {
    return res.status(400).json({ message: "categoryId not found." });
  }
  const brandRecord = await Brand.findById(brandId).select("_id name").lean();
  if (!brandRecord) {
    return res.status(400).json({ message: "brandId not found." });
  }

  const slugValue = String(slug).trim().toLowerCase();
  const duplicate = await Product.findOne({ slug: slugValue, _id: { $ne: product._id } })
    .select("_id")
    .lean();
  if (duplicate) {
    return res.status(409).json({ message: "Product slug already exists." });
  }

  product.title = String(title || titleI18n?.en || "").trim();
  product.titleI18n = {
    en: String(titleI18n?.en || title || "").trim(),
    de: String(titleI18n?.de || "").trim(),
  };
  product.slug = slugValue;
  product.description = String(description).trim();
  product.descriptionI18n = {
    en: String(descriptionI18n?.en || description || "").trim(),
    de: String(descriptionI18n?.de || "").trim(),
  };
  product.shortDescription = String(shortDescription).trim();
  product.shortDescriptionI18n = {
    en: String(shortDescriptionI18n?.en || shortDescription || "").trim(),
    de: String(shortDescriptionI18n?.de || "").trim(),
  };
  product.imageUrl = String(imageUrl).trim();
  product.galleryImages = Array.isArray(galleryImages) ? galleryImages.filter(Boolean).map(String) : [];
  product.sku = String(sku).trim();
  product.brand = brandRecord.name;
  product.brandId = brandRecord._id;
  product.tags = Array.isArray(tags) ? tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  product.categoryId = categoryId;
  product.monthlyPrice = Number(monthlyPrice);
  product.buyerPrice = Number(buyerPrice) || 0;
  product.offerPrice = Number(offerPrice) || 0;
  product.monthlyBuyerPrice = Number(monthlyBuyerPrice) || 0;
  product.monthlyOfferPrice = Number(monthlyOfferPrice) || 0;
  product.weeklyAutoDiscount = Number(weeklyAutoDiscount) || 0;
  product.monthlyAutoDiscount = Number(monthlyAutoDiscount) || 0;
  product.stock = Number(stock) || 0;
  product.stockStatus = String(stockStatus || "in_stock").trim();
  product.lowStockWarning = Number(lowStockWarning) || 0;
  product.maxRentalQuantity = Number(maxRentalQuantity) || 1;
  product.unit = String(unit || "piece").trim();
  product.weightKg = Number(weightKg) || 0;
  product.minimumRentalMonths = minimumRentalMonthsValue;
  product.maximumRentalMonths = maximumRentalMonthsValue;
  product.minimumRentalWeeks = minimumRentalWeeksValue;
  product.maximumRentalWeeks = maximumRentalWeeksValue;
  product.minimumRentalDays = minimumRentalDaysValue;
  product.maximumRentalDays = maximumRentalDaysValue;
  product.rentalPeriodUnit = ["day", "week", "month"].includes(String(rentalPeriodUnit))
    ? String(rentalPeriodUnit)
    : "week";
  product.deliveryFee = Math.max(0, Number(deliveryFee) || 0);
  if (nextLeadDays !== null) product.deliveryLeadDays = nextLeadDays;
  product.rentalMode = nextRentalMode;
  if (nextDailyRate !== null) {
    product.occasionDailyRate = nextDailyRate;
    product.occasionPricing = [];
  }
  product.verificationRequired = Boolean(verificationRequired);
  product.depositEnabled = Boolean(depositEnabled);
  product.securityDeposit = Boolean(depositEnabled) ? Number(securityDeposit) || 0 : 0;
  product.replacementValue = Number(replacementValue) || 0;
  product.refundable = Boolean(refundable);
  // English wording of a specification survives an edit from a form that only
  // knows the main key/value: it is kept when the incoming row has none.
  const existingSpecs = new Map((product.specifications || []).map((spec) => [spec.key, spec]));
  product.specifications = Array.isArray(specifications)
    ? specifications
        .map((spec) => {
          const key = String(spec?.key || "").trim();
          const previous = existingSpecs.get(key);
          return {
            key,
            value: String(spec?.value || "").trim(),
            keyEn: String(spec?.keyEn ?? previous?.keyEn ?? "").trim(),
            valueEn: String(spec?.valueEn ?? previous?.valueEn ?? "").trim(),
          };
        })
        .filter((spec) => spec.key && spec.value)
    : [];
  product.seo = {
    metaTitle: String(seo?.metaTitle || "").trim(),
    metaDescription: String(seo?.metaDescription || "").trim(),
    metaKeywords: Array.isArray(seo?.metaKeywords)
      ? seo.metaKeywords.map((keyword) => String(keyword).trim()).filter(Boolean)
      : [],
    canonicalUrl: String(seo?.canonicalUrl || "").trim(),
    ogTitle: String(seo?.ogTitle || "").trim(),
    ogDescription: String(seo?.ogDescription || "").trim(),
    ogImageUrl: String(seo?.ogImageUrl || "").trim(),
  };
  product.isMostPopular = Boolean(isMostPopular);

  // An AI-origin listing must go live through the draft approval, which also
  // applies the fixture and source-imagery checks. Activating it from the
  // ordinary editor would bypass them, so that transition is refused here.
  // Manual and CSV products have no draft and are unaffected.
  const wasActive = product.isActive === true;
  const wantsActive = Boolean(isActive);
  if (nextRentalMode === "occasion" && wantsActive) {
    const effective = nextDailyRate ?? getOccasionDailyRate(product);
    if (!(effective > 0)) {
      return res.status(400).json({ message: "An occasion product needs a daily price greater than 0 to be active." });
    }
  }

  if (!wasActive && wantsActive) {
    const linkedDraft = await ProductDraft.findOne({ productId: product._id, status: { $ne: "discarded" } });
    if (linkedDraft) {
      const { blockers } = evaluatePublicationBlockers({
        product,
        draft: linkedDraft,
        placeholderImage: PRODUCT_IMAGE_PLACEHOLDER,
        confirmSourceImagery: linkedDraft.sourceImageryConfirmed,
      });

      if (blockers.length > 0) {
        return res.status(400).json({
          message: blockers[0],
          blockers,
          draftId: String(linkedDraft._id),
          hint: "Publish this listing from its draft review screen.",
        });
      }
    }
  }

  product.isActive = wantsActive;
  await product.save();

  const populated = await Product.findById(product._id)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image");
  return res.json(mapProduct(populated));
});

app.delete("/api/admin/products/:id", requireAdminAuth, async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ message: "Product not found." });
  }

  await Product.deleteOne({ _id: product._id });
  return res.json({ message: "Product deleted successfully." });
});


// Fetches an image so it can be handed to an image provider as a reference.
// Delegates to the hardened fetcher: every redirect hop is re-validated, the
// size cap is enforced while streaming, and one deadline covers the body read.
async function fetchImageAsBase64(url) {
  try {
    const { buffer, mimeType } = await fetchImageWithLimits(url);
    return { base64: buffer.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

// Mirrors the draft's image list onto the Product. The first image is the
// cover; the rest become the gallery, preserving the admin's chosen order.
//
// A PUBLISHED product is never touched here: its images are already live, so
// changes are parked on the draft's pendingRevision until the owner applies
// them. Returns the live product unchanged in that case.
async function syncDraftImagesToProduct(draft) {
  if (!draft.productId) return null;

  if (draft.status === "published") {
    draft.pendingRevision = draft.pendingRevision || {};
    draft.pendingRevision.imagesChanged = true;
    draft.pendingRevision.hasChanges = true;
    draft.pendingRevision.updatedAt = new Date();
    await draft.save();
    return Product.findById(draft.productId)
      .populate("categoryId", "name slug")
      .populate("brandId", "name slug image");
  }

  const product = await Product.findById(draft.productId);
  if (!product) return null;

  const urls = (draft.images || []).map((image) => image.url).filter(Boolean);
  product.imageUrl = urls[0] || PRODUCT_IMAGE_PLACEHOLDER;
  product.galleryImages = urls.slice(1);
  if (product.seo) product.seo.ogImageUrl = urls[0] || "";
  await product.save();

  return Product.findById(product._id)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image");
}

// ===========================================================================
// Product automation: create a listing from a product link.
//
// All three creation paths (manual, CSV/XLSX, product-link + AI) produce the
// same Product documents. A draft is simply a Product with isActive:false,
// which every public route already filters out. Publication is a separate,
// explicitly authorised action enforced here on the server.
// ===========================================================================

const {
  evaluatePublicationBlockers,
  summariseImageCompleteness,
} = require("./lib/publication-rules");
const { fetchImageWithLimits } = require("./lib/source/fetch-source");
const {
  assembleDraft,
  describeProviders,
  generateOneImage,
  MAX_IMAGES: MAX_DRAFT_IMAGES,
  hasUsableSource,
  planImages,
  planMissingImages,
  runExtraction,
  runTextGeneration,
} = require("./lib/ai/draft-service");

const CATEGORY_WARNING_CODES = new Set(["category_unresolved", "category_not_found", "no_matching_category", "category_uncertain"]);
const BRAND_WARNING_CODES = new Set(["brand_unresolved", "brand_not_found", "no_matching_brand", "brand_uncertain"]);

function mapDraft(draft, product) {
  const productDto = product ? mapProduct(product) : null;
  const usableSource = hasUsableSource({ facts: draft.provenance?.extractedFacts, adminDetails: draft.pastedDetails });

  // A draft whose wording was not built from any real source is never "ready",
  // whatever its stored status says (older drafts were saved that way).
  const status = draft.status === "ready" && !usableSource ? "needs_source" : draft.status;

  const categoryResolved = productDto ? Boolean(productDto.categoryId) : null;
  const brandResolved = productDto ? Boolean(productDto.brandId) : null;
  const hasImage = (draft.images || []).some((image) => image.url);

  let warnings = (draft.warnings || []).filter((warning) => {
    if (warning.code === "no_image_yet" && hasImage) return false;
    if (warning.code === "placeholder_taxonomy") return false; // legacy: substitution no longer exists
    if (categoryResolved && CATEGORY_WARNING_CODES.has(warning.code)) return false;
    if (brandResolved && BRAND_WARNING_CODES.has(warning.code)) return false;
    return true;
  });

  if (status === "needs_source" && !warnings.some((warning) => warning.code === "needs_source_information")) {
    warnings = [
      {
        code: "needs_source_information",
        field: "sourceUrl",
        message:
          "No verified product information was found, so nothing was written from it. Give a working source link, paste the product details, or add photos, then continue.",
      },
      ...warnings,
    ];
  }

  const completeness = summariseImageCompleteness(draft);

  return {
    id: String(draft._id),
    productId: draft.productId ? String(draft.productId) : null,
    sourceUrl: draft.sourceUrl,
    weeklyPrice: draft.weeklyPrice,
    monthlyPrice: draft.monthlyPrice,
    instruction: draft.instruction,
    pastedDetails: draft.pastedDetails || "",
    status,
    usableSource,
    needs: {
      source: status === "needs_source",
      taxonomy: productDto ? !categoryResolved || !brandResolved : false,
      images: completeness.missing > 0,
    },
    taxonomy: productDto
      ? { categoryResolved, brandResolved, confirmed: Boolean(draft.taxonomyConfirmed) }
      : null,
    steps: draft.steps,
    warnings,
    images: (draft.images || []).map((image) => ({
      id: String(image._id),
      url: image.url,
      origin: image.origin,
      role: image.role,
      prompt: image.prompt,
      providerId: image.providerId,
      isFixture: image.isFixture,
      status: image.status,
      error: image.error,
    })),
    providers: draft.providers,
    imageCompleteness: completeness,
    pendingRevision: {
      hasChanges: Boolean(draft.pendingRevision?.hasChanges),
      imagesChanged: Boolean(draft.pendingRevision?.imagesChanged),
      hasListing: Boolean(draft.pendingRevision?.listing),
      updatedAt: draft.pendingRevision?.updatedAt || null,
      // What approving would publish, so it can be reviewed before it goes live.
      proposed: draft.pendingRevision?.listing
        ? {
            titleDe: draft.pendingRevision.listing.titleI18n?.de || draft.pendingRevision.listing.title || "",
            titleEn: draft.pendingRevision.listing.titleI18n?.en || "",
            shortDescription: draft.pendingRevision.listing.shortDescription || "",
            description: draft.pendingRevision.listing.description || "",
            specifications: (draft.pendingRevision.listing.specifications || []).map((spec) => ({ key: spec.key, value: spec.value })),
            tags: draft.pendingRevision.listing.tags || [],
          }
        : null,
    },
    sourceImageryConfirmed: Boolean(draft.sourceImageryConfirmed),
    provenance: {
      retailerPrice: draft.provenance?.retailerPrice || null,
      extractionConfidence: draft.provenance?.extractionConfidence || "",
      usedStrategies: draft.provenance?.usedStrategies || [],
      finalUrl: draft.provenance?.finalUrl || "",
      sourceImages: draft.provenance?.sourceImages || [],
      extractedFacts: draft.provenance?.extractedFacts || null,
    },
    product: productDto,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

async function loadCatalogueForMatching() {
  const [categories, brands] = await Promise.all([
    Category.find().select("_id name slug parentId").lean(),
    Brand.find({ isActive: true }).select("_id name slug").lean(),
  ]);

  return {
    categories: categories.map((c) => ({
      id: String(c._id),
      nameEn: String(c.name?.en || ""),
      nameDe: String(c.name?.de || ""),
      slug: String(c.slug || ""),
      parentId: c.parentId ? String(c.parentId) : null,
    })),
    brands: brands.map((b) => ({ id: String(b._id), name: String(b.name || ""), slug: String(b.slug || "") })),
  };
}

async function uploadGeneratedImage(base64, mimeType) {
  if (!hasCloudinaryConfig) {
    throw new Error("Cloudinary is not configured.");
  }
  const buffer = Buffer.from(base64, "base64");
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: productUploadFolder(), resource_type: "image" },
      (error, uploaded) => (error ? reject(error) : resolve(uploaded))
    );
    stream.end(buffer);
  });
  return result.secure_url;
}

async function ensureUniqueSlug(candidate, excludeProductId) {
  let slug = candidate;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const query = { slug };
    if (excludeProductId) query._id = { $ne: excludeProductId };
    const clash = await Product.findOne(query).select("_id").lean();
    if (!clash) return slug;
    slug = `${candidate}-${attempt + 2}`;
  }
  return `${candidate}-${Date.now().toString(36)}`;
}

// How long a create/resume job may hold its lease before another request may
// take it over. Comfortably above the 60s function ceiling.
const DRAFT_JOB_LEASE_MS = 3 * 60 * 1000;
const IMAGE_GENERATION_LEASE_MS = 2 * 60 * 1000;

/**
 * Runs extraction -> listing text -> image plan -> Product creation for a draft
 * that does not yet have a product. Safe to call again after a failure or an
 * interrupted request: it reads everything it needs from the stored draft.
 */
const DRAFT_TEXT_FIELDS = [
  "title", "titleI18n", "description", "descriptionI18n",
  "shortDescription", "shortDescriptionI18n", "tags", "specifications", "seo", "sku",
];

// Carried over when a source that already extracted fine is reused, so its
// warnings are not lost.
const EXTRACTION_WARNING_PREFIXES = ["extraction_", "low_extraction", "missing_product_name", "fallback_", "sources_disagree"];

async function populatedProduct(productId) {
  if (!productId) return null;
  return Product.findById(productId).populate("categoryId", "name slug").populate("brandId", "name slug image");
}

/**
 * Appends only the image slots that are missing, never touching what is already
 * there (ready images, failed ones awaiting a deliberate retry, pending slots).
 * Free: no provider is called here. Returns what was planned, so the caller can
 * explain a shortfall.
 */
async function rebuildMissingImages(draft) {
  const planned = planMissingImages({
    existing: draft.images,
    sourceImages: draft.provenance?.sourceImages || [],
    briefs: draft.imageBriefs,
  });

  for (const entry of planned.additions) {
    draft.images.push({ url: "", origin: "ai", role: entry.role, prompt: entry.prompt, status: "pending" });
  }
  draft.steps.images.status = draft.images.some((image) => image.status === "pending")
    ? "pending"
    : draft.images.filter((image) => image.url).length >= MAX_DRAFT_IMAGES ? "done" : draft.steps.images.status;
  await draft.save();

  if (planned.additions.length > 0) await syncDraftImagesToProduct(draft);
  return planned;
}

/**
 * Runs extraction -> listing text -> product for a draft, using only what is
 * stored on the draft. Safe to call again after a failure, an interruption, or
 * when the owner supplies better source material.
 *
 * - `reextract: false` reuses the stored extraction instead of fetching again.
 * - Without real source material (a fetched page with a product name, or details
 *   the owner pasted) NO text is generated and nothing is spent: the draft waits
 *   in "needs_source". A link alone is never mined for facts.
 * - The owner's prices, photos and any category/brand they confirmed are kept.
 */
async function completeDraftGeneration(draft, { reextract = true } = {}) {
  if (draft.status === "published") {
    throw new Error("A published listing cannot be regenerated; use a pending revision.");
  }

  const instruction = draft.instruction;
  const warnings = [];

  // --- extraction (never fatal) -----------------------------------------
  if (reextract) {
    draft.steps.extraction.status = "running";
    const extraction = await runExtraction(draft.sourceUrl);
    warnings.push(...extraction.warnings);
    draft.steps.extraction.status = extraction.ok ? "done" : "failed";
    draft.steps.extraction.error = extraction.error || "";
    draft.steps.extraction.completedAt = new Date();
    draft.provenance = {
      extractedFacts: extraction.result.facts,
      sourceImages: extraction.result.sourceImages,
      retailerPrice: extraction.result.retailerPrice || { amount: 0, currency: "" },
      extractionConfidence: extraction.result.confidence,
      usedStrategies: extraction.result.usedStrategies,
      finalUrl: extraction.result.finalUrl || draft.sourceUrl,
      sources: extraction.sources || [],
    };
  } else {
    warnings.push(
      ...(draft.warnings || []).filter((warning) => EXTRACTION_WARNING_PREFIXES.some((prefix) => warning.code.startsWith(prefix)))
    );
  }

  const facts = draft.provenance?.extractedFacts || {};
  const sourceImages = draft.provenance?.sourceImages || [];
  const adminDetails = draft.pastedDetails || "";

  // --- no real source: wait for the owner, spend nothing ------------------
  if (!hasUsableSource({ facts, adminDetails })) {
    draft.status = "needs_source";
    draft.steps.text.status = "pending";
    draft.steps.text.error = "";
    draft.jobLeaseAt = null;
    draft.warnings = warnings;
    await draft.save();
    return mapDraft(draft, await populatedProduct(draft.productId));
  }

  // --- listing text -------------------------------------------------------
  const { categories, brands } = await loadCatalogueForMatching();
  draft.steps.text.status = "running";
  const text = await runTextGeneration({
    facts,
    adminDetails,
    instruction,
    categories,
    brands,
    hasUserPhotos: (draft.images || []).some((image) => image.origin === "user" && image.url),
  });
  warnings.push(...text.warnings);

  if (!text.ok) {
    draft.steps.text.status = "failed";
    draft.steps.text.error = text.error;
    draft.status = "failed";
    draft.warnings = warnings;
    await draft.save();
    // The admin's inputs are preserved so nothing has to be re-entered.
    return { ...mapDraft(draft, null), recoverable: true };
  }

  draft.steps.text.status = "done";
  draft.steps.text.completedAt = new Date();
  draft.providers.text = { id: text.providerId, model: text.model, real: text.providerId !== "fixture" };
  draft.imageBriefs = text.listing.imageBriefs || [];

  const assembled = assembleDraft({
    listing: text.listing,
    weeklyPrice: draft.weeklyPrice,
    monthlyPrice: draft.monthlyPrice,
    categories,
    brands,
    images: draft.images.filter((image) => image.url),
    fallbackSeed: String(draft._id),
    categoryHint: facts.category,
  });
  warnings.push(...assembled.warnings);

  let product = draft.productId ? await Product.findById(draft.productId) : null;

  if (product) {
    // Same draft, better material: replace the wording, keep the owner's prices,
    // photos and confirmed choices.
    for (const field of DRAFT_TEXT_FIELDS) product[field] = assembled.payload[field];
    product.slug = await ensureUniqueSlug(assembled.slug, product._id);
    if (!draft.taxonomyConfirmed) {
      // Only suggestions so far, so a better source may replace them. Unmatched
      // stays unresolved rather than being filled with an unrelated value.
      product.categoryId = assembled.payload.categoryId || null;
      product.brandId = assembled.payload.brandId || null;
      product.brand = assembled.payload.brand || "";
    }
    await product.save();
  }

  // --- image slots: fill only what is missing -----------------------------
  const planned = planMissingImages({ existing: draft.images, sourceImages, briefs: draft.imageBriefs });
  for (const entry of planned.additions) {
    draft.images.push({ url: "", origin: "ai", role: entry.role, prompt: entry.prompt, status: "pending" });
  }
  draft.steps.images.status = draft.images.some((image) => image.status === "pending") ? "pending" : "skipped";

  // The retailer's photo is a REFERENCE, not a listing image. It becomes one only
  // as a last resort -- nothing to generate and nothing else to show.
  const hasListingImage = draft.images.some((image) => image.url);
  if (!hasListingImage && !draft.images.some((image) => image.status === "pending") && sourceImages.length > 0) {
    draft.images.unshift({ url: sourceImages[0], origin: "source", role: "source-reference", status: "ready" });
  }
  draft.images = draft.images.slice(0, MAX_DRAFT_IMAGES);

  if (!product) {
    const slug = await ensureUniqueSlug(assembled.slug);
    const payload = { ...assembled.payload, slug, imageUrl: draft.images.find((image) => image.url)?.url || "" };
    if (!payload.imageUrl) {
      warnings.push({ code: "no_image_yet", field: "images", message: "No image yet. Generate or upload one before publishing." });
      payload.imageUrl = PRODUCT_IMAGE_PLACEHOLDER;
    }
    // Category and brand stay null when nothing matched. The owner picks or
    // explicitly creates one; publication is blocked until then.
    product = await Product.create(payload);
    draft.productId = product._id;
  } else if (draft.images.some((image) => image.url)) {
    await syncDraftImagesToProduct(draft);
  }

  draft.status = "ready";
  draft.jobLeaseAt = null;
  draft.warnings = warnings;
  await draft.save();

  return mapDraft(draft, await populatedProduct(draft.productId));
}

// Draft creation writes products, drafts and media. A preview deployment that
// has not been given its own database would write them into the shared
// production database, so every mutating draft route is refused there.
function blockDraftWritesOnSharedPreviewDatabase(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  const isolation = getDatabaseIsolation();
  if (isolation.isolated) return next();

  console.error(`Draft write blocked: ${isolation.reason}`);
  return res.status(503).json({
    code: "PREVIEW_DATABASE_NOT_ISOLATED",
    message:
      "Draft creation is disabled on this preview because it is not connected to its own test database. " +
      "Nothing was written.",
  });
}

app.use("/api/admin/product-drafts", blockDraftWritesOnSharedPreviewDatabase);

app.get("/api/admin/product-drafts/providers", requireAdminAuth, (_, res) => {
  const isolation = getDatabaseIsolation();
  return res.json({
    ...describeProviders(),
    environment: {
      deployment: process.env.VERCEL_ENV || "local",
      preview: isPreviewDeployment(),
      databaseIsolated: isolation.isolated,
      // Only a preview's database name is shown; production's is not exposed.
      databaseName: isolation.preview ? isolation.dbName : "",
      uploadFolder: productUploadFolder(),
    },
  });
});

app.get("/api/admin/product-drafts", requireAdminAuth, async (_, res) => {
  const drafts = await ProductDraft.find({ status: { $ne: "discarded" } })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  return res.json(drafts.map((draft) => mapDraft(draft, null)));
});

app.get("/api/admin/product-drafts/:id", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });

  const product = draft.productId
    ? await Product.findById(draft.productId).populate("categoryId", "name slug").populate("brandId", "name slug image")
    : null;

  return res.json(mapDraft(draft, product));
});

// Step 1: extract + generate text + create the private Product.
// ---------------------------------------------------------------------------
// AI Product Queue: prepared product packages (JSON) -> private drafts.
// Nothing here publishes. Import creates an inactive Product plus a draft, which
// goes through the same review and explicit publication as every other draft.
// ---------------------------------------------------------------------------
const ProductPackage = require("./models/ProductPackage");
const { normalizeDailyRate, dailyRateFromLegacyOptions } = require("./lib/occasion-pricing");
const { parseDeliveryLeadDays, checkStartDate } = require("./lib/delivery-lead-time");
const { validateProductPackage, buildPackageProductPayload } = require("./lib/product-package");
const { buildSlug: buildPackageSlug, matchCategoryExact, matchBrandExact } = require("./lib/product-payload");

const PACKAGE_UPLOAD_LIMIT = 25;
const PACKAGE_IMPORT_BUDGET_MS = 40 * 1000;
const PACKAGE_DRAFT_IMAGE_CAP = 5;

function summarisePackage(doc) {
  return {
    id: String(doc._id),
    externalId: doc.externalId,
    title: doc.title,
    rentalMode: doc.rentalMode,
    status: doc.status,
    errors: doc.problems || [],
    warnings: doc.warnings || [],
    imageCount: (doc.payload?.images || []).length,
    importedDraftId: doc.importedDraftId ? String(doc.importedDraftId) : null,
    importedProductId: doc.importedProductId ? String(doc.importedProductId) : null,
    importedAt: doc.importedAt,
    updatedAt: doc.updatedAt,
  };
}

// Images hosted on our own Cloudinary account are kept as they are; any other
// https image is downloaded under the same SSRF and size limits as the link
// workflow and re-hosted, so a listing never depends on someone else's server.
async function hostPackageImage(image) {
  const url = image.url;
  if (/^https:\/\/res\.cloudinary\.com\//i.test(url)) return url;
  const fetched = await fetchImageAsBase64(url);
  if (!fetched) throw new Error(`Could not download ${url}`);
  return uploadGeneratedImage(fetched.base64, fetched.mimeType);
}

async function importPackage(doc, adminId) {
  const pkg = doc.payload;
  const extraWarnings = [];

  const hosted = [];
  // Primary first, then the stated order, then the order they were listed in.
  const orderedImages = [...pkg.images].sort(
    (a, b) =>
      Number(b.primary) - Number(a.primary) ||
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      (a.index ?? 0) - (b.index ?? 0)
  );
  for (const image of orderedImages) {
    if (hosted.length >= PACKAGE_DRAFT_IMAGE_CAP) {
      extraWarnings.push(`Only ${PACKAGE_DRAFT_IMAGE_CAP} images are imported per listing; the rest were left out.`);
      break;
    }
    if (!image.url) {
      extraWarnings.push(`An uploaded image (${image.file}) was not uploaded with the package and was skipped.`);
      continue;
    }
    try {
      hosted.push({ ...image, hostedUrl: await hostPackageImage(image) });
    } catch (error) {
      extraWarnings.push(`An image could not be imported and was skipped: ${error.message}`);
    }
  }

  const catalogue = await loadCatalogueForMatching();
  // Exact matches only (category by full path when given). Anything else stays
  // unresolved so the owner chooses; a package never creates a category or brand.
  const category = matchCategoryExact(pkg.identity.category.path?.length ? pkg.identity.category.path : pkg.identity.category.name, catalogue.categories);
  const brand = matchBrandExact(pkg.identity.brand, catalogue.brands);
  const categoryId = category.resolved ? category.categoryId : null;
  const brandId = brand.resolved ? brand.brandId : null;

  const slug = await ensureUniqueSlug(buildPackageSlug([pkg.identity.brand, pkg.identity.model || pkg.titles.de || pkg.titles.en], pkg.externalId));
  const payload = buildPackageProductPayload(pkg, {
    categoryId,
    brandId,
    brandName: brand.brandName,
    images: hosted.map((image) => ({ url: image.hostedUrl, altDe: image.altDe, altEn: image.altEn })),
    slug,
  });
  if (!payload.imageUrl) payload.imageUrl = PRODUCT_IMAGE_PLACEHOLDER;

  const draftWarnings = [
    ...pkg.warnings.map((message) => ({ code: "package_note", field: "", message })),
    ...extraWarnings.map((message) => ({ code: "package_import", field: "", message })),
    ...doc.warnings.map((message) => ({ code: "package_validation", field: "", message })),
  ];
  if (!categoryId) {
    draftWarnings.push({ code: "category_unresolved", field: "category", message: `Category "${pkg.identity.category.name || "(none given)"}" is unresolved (${category.reason}). Choose one before publishing.` });
  }
  if (!brandId) {
    draftWarnings.push({ code: "brand_unresolved", field: "brand", message: `Brand "${pkg.identity.brand || "(none given)"}" matched no existing brand exactly. Choose one before publishing.` });
  }

  const specText = pkg.specifications.map((s) => `${s.key}: ${s.value}`).join("\n");
  const sourceText = pkg.sources.map((s) => [s.type, s.label, s.url, s.note].filter(Boolean).join(" ")).join("\n");

  let product = null;
  let draft = null;
  try {
  product = await Product.create(payload);
  draft = await ProductDraft.create({
    productId: product._id,
    createdByAdminId: adminId,
    origin: "package",
    packageId: doc._id,
    sourceUrl: pkg.sources.find((s) => s.url)?.url || "",
    weeklyPrice: pkg.pricing.weekly || 0,
    monthlyPrice: pkg.pricing.monthly || 0,
    instruction: "",
    // The package itself is the verified source. This is what lets the
    // publication rules accept it; an empty package would not get here.
    pastedDetails: [`Prepared product package ${pkg.externalId}.`, specText, sourceText].filter(Boolean).join("\n").slice(0, 8000),
    taxonomyConfirmed: Boolean(categoryId && brandId),
    status: "ready",
    steps: {
      extraction: { status: "skipped" },
      text: { status: "done", completedAt: new Date() },
      images: { status: "skipped" },
    },
    images: hosted.map((image) => ({
      url: image.hostedUrl,
      origin: image.origin === "ai_generated" ? "ai" : "user",
      role: image.role || (image.origin === "licensed_asset" ? "licensed-asset" : image.origin === "ai_generated" ? "ai-generated" : "owner-photo"),
      provenanceNote: [image.origin, image.license, image.note].filter(Boolean).join(" | "),
      providerId: image.origin === "ai_generated" ? "chatgpt" : "",
      status: "ready",
    })),
    warnings: draftWarnings,
    providers: { text: { id: "chatgpt-package", model: "", real: true }, image: { id: "", model: "", real: true } },
    provenance: {
      extractedFacts: { productName: pkg.titles.de || pkg.titles.en, fromPackage: true },
      sourceImages: pkg.referenceImages.map((ref) => ref.url),
      usedStrategies: ["package"],
    },
  });

  doc.status = "imported";
  doc.importedProductId = product._id;
  doc.importedDraftId = draft._id;
  doc.importedAt = new Date();
  await doc.save();
  } catch (error) {
    // No orphan: whatever was created for this attempt is removed again, and the
    // package stays READY so it can be retried.
    if (draft) await ProductDraft.deleteOne({ _id: draft._id }).catch(() => {});
    if (product) await Product.deleteOne({ _id: product._id }).catch(() => {});
    throw error;
  }
  return { draftId: String(draft._id), productId: String(product._id) };
}

app.post("/api/admin/product-packages", requireAdminAuth, async (req, res) => {
  const incoming = Array.isArray(req.body?.packages) ? req.body.packages : req.body?.package ? [req.body.package] : [];
  if (incoming.length === 0) return res.status(400).json({ message: "Send one or more packages." });
  if (incoming.length > PACKAGE_UPLOAD_LIMIT) {
    return res.status(400).json({ message: `At most ${PACKAGE_UPLOAD_LIMIT} packages per upload.` });
  }

  const results = [];
  for (const raw of incoming) {
    const checked = validateProductPackage(raw);
    const externalId = checked.package?.externalId || "";
    if (!externalId) {
      results.push({ externalId: "", status: "invalid", errors: checked.errors, warnings: checked.warnings });
      continue;
    }
    const existing = await ProductPackage.findOne({ externalId });
    if (existing?.status === "imported") {
      results.push({
        externalId, status: "imported", id: String(existing._id),
        errors: ["This package was already imported. Edit the draft instead, or use a new externalId."], warnings: [],
      });
      continue;
    }
    const doc = existing || new ProductPackage({ externalId, createdByAdminId: req.admin.sub });
    doc.title = checked.package.titles.de || checked.package.titles.en;
    doc.rentalMode = checked.package.rentalMode;
    doc.status = checked.ok ? "ready" : "invalid";
    doc.problems = checked.errors;
    doc.warnings = checked.warnings;
    doc.payload = checked.package;
    await doc.save();
    results.push(summarisePackage(doc));
  }
  return res.status(201).json({ results });
});

app.get("/api/admin/product-packages", requireAdminAuth, async (_req, res) => {
  const docs = await ProductPackage.find().sort({ updatedAt: -1 }).limit(200);
  return res.json({ items: docs.map(summarisePackage) });
});

app.post("/api/admin/product-packages/import", requireAdminAuth, async (req, res) => {
  const allReady = req.body?.allReady === true;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)) : [];
  if (!allReady && ids.length === 0) return res.status(400).json({ message: "Select packages to import." });

  const docs = await ProductPackage.find(allReady ? { status: "ready" } : { _id: { $in: ids }, status: "ready" }).sort({ createdAt: 1 });
  const started = Date.now();
  const imported = [];
  const failed = [];
  let remaining = 0;

  for (const doc of docs) {
    // Stay under the function time limit; the client calls again for the rest.
    if (Date.now() - started > PACKAGE_IMPORT_BUDGET_MS) {
      remaining += 1;
      continue;
    }
    try {
      const result = await importPackage(doc, req.admin.sub);
      imported.push({ id: String(doc._id), externalId: doc.externalId, ...result });
    } catch (error) {
      console.error("Package import failed:", error.message);
      failed.push({ id: String(doc._id), externalId: doc.externalId, message: "Import failed. Nothing was published." });
    }
  }
  return res.json({ imported, failed, remaining });
});

app.delete("/api/admin/product-packages/:id", requireAdminAuth, async (req, res) => {
  const doc = await ProductPackage.findById(req.params.id);
  if (!doc) return res.status(404).json({ message: "Package not found." });
  if (doc.status === "imported") return res.status(409).json({ message: "An imported package stays as a record of its draft." });
  await ProductPackage.deleteOne({ _id: doc._id });
  return res.json({ message: "Package removed." });
});

app.post("/api/admin/product-drafts", requireAdminAuth, async (req, res) => {
  const sourceUrl = String(req.body?.sourceUrl || "").trim();
  const weeklyPrice = Number(req.body?.weeklyPrice);
  const monthlyPrice = Number(req.body?.monthlyPrice);
  const instruction = String(req.body?.instruction || "").trim().slice(0, 2000);
  const userImages = Array.isArray(req.body?.imageUrls)
    ? req.body.imageUrls.map((url) => String(url || "").trim()).filter(Boolean).slice(0, MAX_DRAFT_IMAGES)
    : [];
  const submissionKey = String(req.body?.submissionKey || "").trim().slice(0, 64);

  if (!sourceUrl && userImages.length === 0) {
    return res.status(400).json({ message: "Provide a product link or at least one photo." });
  }
  if (!Number.isFinite(weeklyPrice) || weeklyPrice <= 0) {
    return res.status(400).json({ message: "Weekly rental price is required." });
  }
  if (!Number.isFinite(monthlyPrice) || monthlyPrice <= 0) {
    return res.status(400).json({ message: "Monthly rental price is required." });
  }

  // Duplicate-submission guard: a double tap reuses the first draft.
  if (submissionKey) {
    const existing = await ProductDraft.findOne({ submissionKey, createdByAdminId: req.admin.sub });
    if (existing) {
      const product = existing.productId ? await Product.findById(existing.productId) : null;
      return res.status(200).json({ ...mapDraft(existing, product), deduplicated: true });
    }
  }

  const providers = describeProviders();
  const draft = await ProductDraft.create({
    createdByAdminId: req.admin.sub,
    sourceUrl,
    weeklyPrice,
    monthlyPrice,
    instruction,
    submissionKey,
    status: "generating",
    jobLeaseAt: new Date(),
    providers,
    images: userImages.map((url) => ({ url, origin: "user", role: "user-upload", status: "ready" })),
  });

  try {
    const completed = await completeDraftGeneration(draft);
    return res.status(201).json(completed);
  } catch (error) {
    console.error("Draft generation failed:", error.message);
    draft.status = "failed";
    draft.steps.text.status = "failed";
    draft.steps.text.error = error.message || "Generation failed.";
    await draft.save();
    // The owner's inputs are preserved; /resume finishes the job.
    return res.status(201).json({ ...mapDraft(draft, null), recoverable: true });
  }
});

// Step 2: generate (or regenerate) exactly one image.
app.post("/api/admin/product-drafts/:id/images/:imageId/generate", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });

  const image = draft.images.id(req.params.imageId);
  if (!image) return res.status(404).json({ message: "Image not found." });
  if (image.origin === "user") {
    return res.status(400).json({ message: "Your own uploads are never overwritten. Delete it first if you want a generated image." });
  }

  // Generation costs money, so a duplicate or retried request must not start a
  // second call for the same image while one is still in flight.
  const leaseAge = image.generationStartedAt ? Date.now() - new Date(image.generationStartedAt).getTime() : Infinity;
  if (image.status === "generating" && leaseAge < IMAGE_GENERATION_LEASE_MS) {
    return res.status(409).json({ message: "That image is already being generated. Try again shortly." });
  }

  image.status = "generating";
  image.generationStartedAt = new Date();
  await draft.save();

  // References: admin uploads first, then source imagery.
  const references = [];
  for (const candidate of draft.images.filter((entry) => entry.origin === "user" && entry.url).slice(0, 3)) {
    const fetched = await fetchImageAsBase64(candidate.url);
    if (fetched) references.push(fetched);
  }
  if (references.length === 0) {
    for (const url of (draft.provenance?.sourceImages || []).slice(0, 2)) {
      const fetched = await fetchImageAsBase64(url);
      if (fetched) references.push(fetched);
    }
  }

  const brief = {
    role: image.role || "image",
    prompt: String(req.body?.prompt || image.prompt || "Clean product image on a neutral background"),
    requiresReference: image.role !== "primary",
  };

  const generated = await generateOneImage({ brief, references });

  if (!generated.ok) {
    image.status = "failed";
    image.generationStartedAt = null;
    image.error = generated.warning?.message || "Image generation failed.";
    const already = draft.warnings.some((w) => w.code === generated.warning?.code && w.field === "images");
    if (generated.warning && !already) draft.warnings.push(generated.warning);
    await draft.save();
    // 200: the rest of the draft is intact and the admin can retry just this one.
    return res.status(200).json({ ...mapDraft(draft, null), imageError: generated.error, retryable: generated.retryable !== false });
  }

  // The image is already paid for, so retry storage before giving up rather
  // than discarding it and charging for a regeneration.
  let url = "";
  let storageError = null;
  for (let attempt = 0; attempt < 3 && !url; attempt += 1) {
    try {
      url = await uploadGeneratedImage(generated.image.base64, generated.image.mimeType);
    } catch (error) {
      storageError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  if (!url) {
    image.status = "failed";
    image.error = "Generated image could not be stored.";
    image.generationStartedAt = null;
    await draft.save();
    console.error("Generated image storage failed:", storageError?.message);
    return res.status(200).json({ ...mapDraft(draft, null), imageError: "STORAGE_FAILED", retryable: true });
  }

  image.url = url;
  image.status = "ready";
  image.generationStartedAt = null;
  image.error = "";
  image.prompt = brief.prompt;
  image.providerId = generated.providerId;
  image.model = generated.model;
  image.isFixture = Boolean(generated.isFixture);
  image.origin = generated.isFixture ? "fixture" : "ai";

  draft.steps.images.status = draft.images.some((i) => i.status === "pending") ? "pending" : "done";
  await draft.save();
  await syncDraftImagesToProduct(draft);

  return res.json(mapDraft(draft, null));
});

// Image management: add / delete / reorder / choose primary.
app.patch("/api/admin/product-drafts/:id/images", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });

  const action = String(req.body?.action || "").trim();

  if (action === "add") {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ message: "Image URL is required." });
    if (draft.images.length >= MAX_DRAFT_IMAGES) {
      // Make room by dropping a slot that was planned but never generated.
      const idx = draft.images.findIndex((image) => image.status === "pending" && !image.url);
      if (idx === -1) {
        return res.status(400).json({ message: `A listing holds at most ${MAX_DRAFT_IMAGES} images.` });
      }
      draft.images.splice(idx, 1);
    }
    draft.images.push({ url, origin: "user", role: "user-upload", status: "ready" });

    // The owner's own photo is a legitimate reference, so the missing views can now
    // be planned. Only slots are created here (free); generating them is a separate,
    // deliberate step.
    if (draft.productId) {
      const planned = planMissingImages({
        existing: draft.images,
        sourceImages: draft.provenance?.sourceImages || [],
        briefs: draft.imageBriefs,
      });
      for (const entry of planned.additions) {
        draft.images.push({ url: "", origin: "ai", role: entry.role, prompt: entry.prompt, status: "pending" });
      }
      if (planned.additions.length > 0) draft.steps.images.status = "pending";
    }
  } else if (action === "delete") {
    const imageId = String(req.body?.imageId || "");
    const image = draft.images.id(imageId);
    if (!image) return res.status(404).json({ message: "Image not found." });
    // Reassigning the array is the removal that reliably persists, matching
    // how the reorder branch below rewrites the list.
    draft.images = draft.images.filter((entry) => String(entry._id) !== imageId);
  } else if (action === "replace") {
    const image = draft.images.id(String(req.body?.imageId || ""));
    const url = String(req.body?.url || "").trim();
    if (!image) return res.status(404).json({ message: "Image not found." });
    if (!url) return res.status(400).json({ message: "Replacement URL is required." });
    image.url = url;
    image.origin = "user";
    image.role = "user-upload";
    image.status = "ready";
    image.error = "";
    image.isFixture = false;
  } else if (action === "reorder") {
    const order = Array.isArray(req.body?.imageIds) ? req.body.imageIds.map(String) : [];
    const byId = new Map(draft.images.map((image) => [String(image._id), image]));
    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    if (reordered.length !== draft.images.length) {
      return res.status(400).json({ message: "The new order must list every image exactly once." });
    }
    draft.images = reordered;
  } else if (action === "primary") {
    const id = String(req.body?.imageId || "");
    const index = draft.images.findIndex((image) => String(image._id) === id);
    if (index === -1) return res.status(404).json({ message: "Image not found." });
    const [picked] = draft.images.splice(index, 1);
    draft.images.unshift(picked);
  } else {
    return res.status(400).json({ message: "Unknown image action." });
  }

  await draft.save();
  const product = await syncDraftImagesToProduct(draft);
  return res.json(mapDraft(draft, product));
});

// Regenerate the listing text only, keeping images untouched.
app.post("/api/admin/product-drafts/:id/regenerate-text", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });
  if (!draft.productId) {
    // Initial generation never completed. Finish it instead of refusing, so the
    // URL, prices, instruction and uploaded photos are not re-entered.
    return res.status(409).json({
      message: "This draft has no product yet. Resume generation to finish it.",
      resumeRequired: true,
    });
  }

  if (req.body?.instruction !== undefined) {
    draft.instruction = String(req.body.instruction || "").trim().slice(0, 2000);
  }

  // Optionally re-read the source first, e.g. after the extractor improved. This
  // only refreshes the draft's own source record -- the live listing is untouched
  // until the resulting revision is applied -- and a failed re-read never replaces
  // source data that already worked.
  if (req.body?.reextract === true && draft.sourceUrl) {
    const extraction = await runExtraction(draft.sourceUrl);
    if (extraction.ok && String(extraction.result.facts?.name || "").trim()) {
      draft.provenance = {
        extractedFacts: extraction.result.facts,
        sourceImages: extraction.result.sourceImages,
        retailerPrice: extraction.result.retailerPrice || { amount: 0, currency: "" },
        extractionConfidence: extraction.result.confidence,
        usedStrategies: extraction.result.usedStrategies,
        finalUrl: extraction.result.finalUrl || draft.sourceUrl,
        sources: extraction.sources || [],
      };
      draft.steps.extraction.status = "done";
      draft.steps.extraction.error = "";
      draft.steps.extraction.completedAt = new Date();
    }
  }

  const { categories, brands } = await loadCatalogueForMatching();
  const text = await runTextGeneration({
    facts: draft.provenance?.extractedFacts || {},
    adminDetails: draft.pastedDetails,
    instruction: draft.instruction,
    categories,
    brands,
    hasUserPhotos: draft.images.some((image) => image.origin === "user"),
  });

  if (!text.ok) {
    draft.steps.text.status = "failed";
    draft.steps.text.error = text.error;
    await draft.save();
    return res.status(200).json({ ...mapDraft(draft, null), textError: text.error, retryable: text.retryable });
  }

  const assembled = assembleDraft({
    listing: text.listing,
    weeklyPrice: draft.weeklyPrice,
    monthlyPrice: draft.monthlyPrice,
    categories,
    brands,
    images: draft.images.filter((image) => image.url),
    fallbackSeed: String(draft._id),
    categoryHint: draft.provenance?.extractedFacts?.category,
  });

  const product = await Product.findById(draft.productId);
  if (!product) return res.status(404).json({ message: "Draft product not found." });

  // Text fields only: images, pricing and taxonomy the admin already fixed stay.
  const textFields = [
    "title", "titleI18n", "description", "descriptionI18n",
    "shortDescription", "shortDescriptionI18n", "tags", "specifications", "seo", "sku",
  ];

  if (draft.status === "published") {
    // Live listing: hold the new text as a revision. The storefront keeps
    // serving the approved version until the owner applies it.
    draft.pendingRevision = draft.pendingRevision || {};
    draft.pendingRevision.listing = Object.fromEntries(textFields.map((field) => [field, assembled.payload[field]]));
    draft.pendingRevision.hasChanges = true;
    draft.pendingRevision.updatedAt = new Date();
  } else {
    for (const field of textFields) product[field] = assembled.payload[field];
    await product.save();
  }

  draft.steps.text.status = "done";
  draft.steps.text.error = "";
  draft.providers.text = { id: text.providerId, model: text.model, real: text.providerId !== "fixture" };
  draft.warnings = [...assembled.warnings, ...text.warnings];
  await draft.save();

  const populated = await Product.findById(product._id)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image");
  return res.json(mapDraft(draft, populated));
});

// Continue an existing draft: finish an interrupted job, or supply better source
// material (an alternate link, pasted details, reference photos) and carry on.
//
// Nothing is started over. The owner's prices, instruction and photos stay, a
// source that already extracted fine is reused rather than fetched again, text is
// regenerated (one paid call) only when its inputs actually changed, and image
// slots are topped up without touching any that already exist.
app.post("/api/admin/product-drafts/:id/resume", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });
  if (draft.status === "discarded") return res.status(400).json({ message: "This draft was discarded." });
  if (draft.status === "published") {
    return res.status(409).json({
      message: "This listing is live. Changes to a live listing go through a pending revision; use Regenerate text.",
    });
  }

  const body = req.body || {};
  const newUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : null;
  const newDetails = typeof body.details === "string" ? body.details.trim().slice(0, 8000) : null;
  const newImageUrls = Array.isArray(body.imageUrls)
    ? [...new Set(body.imageUrls.map((url) => String(url || "").trim()).filter(Boolean))]
    : [];

  const urlChanged = newUrl !== null && newUrl !== draft.sourceUrl;
  const detailsChanged = newDetails !== null && newDetails !== draft.pastedDetails;
  const usable = hasUsableSource({ facts: draft.provenance?.extractedFacts, adminDetails: draft.pastedDetails });
  const textDone = draft.steps.text.status === "done" && Boolean(draft.productId);

  if (draft.productId && usable && !urlChanged && !detailsChanged && newImageUrls.length === 0) {
    return res.json({ ...mapDraft(draft, await populatedProduct(draft.productId)), alreadyComplete: true });
  }

  // A job still inside its lease belongs to another in-flight request.
  const leaseAge = draft.jobLeaseAt ? Date.now() - new Date(draft.jobLeaseAt).getTime() : Infinity;
  if (draft.status === "generating" && leaseAge < DRAFT_JOB_LEASE_MS) {
    return res.status(409).json({ message: "This draft is already being generated. Try again shortly." });
  }

  // Record the new material first, so it is kept whatever happens next.
  if (urlChanged) draft.sourceUrl = newUrl;
  if (detailsChanged) draft.pastedDetails = newDetails;
  if (newImageUrls.length > 0) {
    // Make room by dropping slots that were planned but never generated; ready
    // and failed images are left exactly as they are.
    const known = new Set(draft.images.map((image) => image.url).filter(Boolean));
    for (const url of newImageUrls) {
      if (known.has(url)) continue;
      if (draft.images.length >= MAX_DRAFT_IMAGES) {
        const idx = draft.images.findIndex((image) => image.status === "pending" && !image.url);
        if (idx === -1) break;
        draft.images.splice(idx, 1);
      }
      draft.images.push({ url, origin: "user", role: "user-upload", status: "ready" });
    }
  }

  draft.status = "generating";
  draft.jobLeaseAt = new Date();
  await draft.save();

  try {
    // Text only needs to run again if the wording's inputs changed or never ran.
    const textInputsChanged = urlChanged || detailsChanged || !textDone || !usable;
    if (!textInputsChanged) {
      draft.status = "ready";
      draft.jobLeaseAt = null;
      await draft.save();
      const planned = await rebuildMissingImages(draft);
      return res.json({ ...mapDraft(draft, await populatedProduct(draft.productId)), imageNote: planned.reason || undefined });
    }

    // A previous successful extraction of the same link is reused, not refetched.
    const reextract = urlChanged || draft.steps.extraction.status !== "done";
    return res.json(await completeDraftGeneration(draft, { reextract }));
  } catch (error) {
    console.error("Draft resume failed:", error.message);
    draft.status = "failed";
    draft.steps.text.status = "failed";
    draft.steps.text.error = error.message || "Generation failed.";
    draft.jobLeaseAt = null;
    await draft.save();
    return res.status(200).json({ ...mapDraft(draft, null), recoverable: true });
  }
});

// Choose the category and/or brand for a draft from what already exists. The
// choice is the owner's, so it is marked confirmed and a later regeneration will
// not overwrite it.
app.patch("/api/admin/product-drafts/:id/taxonomy", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });
  if (!draft.productId) return res.status(400).json({ message: "This draft has no product yet." });
  if (draft.status === "published") {
    return res.status(409).json({ message: "This listing is live. Change its category or brand in the full editor." });
  }

  const product = await Product.findById(draft.productId);
  if (!product) return res.status(404).json({ message: "Draft product not found." });

  const { categoryId, brandId } = req.body || {};
  if (categoryId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(String(categoryId)) || !(await Category.exists({ _id: categoryId }))) {
      return res.status(400).json({ message: "That category does not exist." });
    }
    product.categoryId = categoryId;
  }
  if (brandId !== undefined) {
    const brand = mongoose.Types.ObjectId.isValid(String(brandId)) ? await Brand.findById(brandId).select("name").lean() : null;
    if (!brand) return res.status(400).json({ message: "That brand does not exist." });
    product.brandId = brandId;
    product.brand = brand.name;
  }
  await product.save();

  draft.taxonomyConfirmed = true;
  await draft.save();
  return res.json(mapDraft(draft, await populatedProduct(draft.productId)));
});

// Top up missing image slots after reference photos were added. Free: it only
// plans slots; generation happens one image at a time, as before.
app.post("/api/admin/product-drafts/:id/rebuild-images", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });
  if (draft.status === "discarded") return res.status(400).json({ message: "This draft was discarded." });

  const planned = await rebuildMissingImages(draft);
  return res.json({
    ...mapDraft(draft, await populatedProduct(draft.productId)),
    imageNote: planned.reason || undefined,
    addedSlots: planned.additions.length,
  });
});

// Apply a pending revision to the live product. Separate from publication so a
// revision reaches the storefront only on an explicit approval.
app.post("/api/admin/product-drafts/:id/apply-revision", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({ message: "Applying a revision requires an explicit confirmation." });
  }

  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });
  if (!draft.pendingRevision?.hasChanges) {
    return res.status(400).json({ message: "There is no pending revision to apply." });
  }

  const product = await Product.findById(draft.productId);
  if (!product) return res.status(404).json({ message: "Product not found." });

  const { blockers } = evaluatePublicationBlockers({
    product,
    draft,
    placeholderImage: PRODUCT_IMAGE_PLACEHOLDER,
    confirmSourceImagery: req.body?.confirmSourceImagery === true || draft.sourceImageryConfirmed,
  });
  if (blockers.length > 0) {
    return res.status(400).json({ message: blockers[0], blockers });
  }

  if (draft.pendingRevision.listing) {
    for (const [field, value] of Object.entries(draft.pendingRevision.listing)) {
      product[field] = value;
    }
  }

  if (draft.pendingRevision.imagesChanged) {
    const urls = (draft.images || []).map((image) => image.url).filter(Boolean);
    if (urls.length === 0) {
      return res.status(400).json({ message: "A published product needs at least one image." });
    }
    product.imageUrl = urls[0];
    product.galleryImages = urls.slice(1);
    if (product.seo) product.seo.ogImageUrl = urls[0];
  }

  await product.save();

  draft.pendingRevision = { hasChanges: false, listing: null, images: [], imagesChanged: false, updatedAt: new Date() };
  await draft.save();

  const populated = await Product.findById(product._id)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image");
  return res.json({ message: "Revision applied to the live product.", draft: mapDraft(draft, populated) });
});

// Discard a pending revision, leaving the live product as it is.
app.post("/api/admin/product-drafts/:id/discard-revision", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });

  const product = await Product.findById(draft.productId);
  // Restore the draft's image list from what is actually live, keeping each
  // image's real origin. Relabelling a reused retailer photo as the owner's own
  // upload would silently disarm the source-imagery confirmation.
  if (product && draft.pendingRevision?.imagesChanged) {
    const originByUrl = new Map((draft.images || []).map((image) => [image.url, image]));
    const liveUrls = [product.imageUrl, ...(product.galleryImages || [])].filter(Boolean);
    draft.images = liveUrls.map((url) => {
      const previous = originByUrl.get(url);
      return {
        url,
        origin: previous?.origin || "source",
        role: previous?.role || "live",
        providerId: previous?.providerId || "",
        model: previous?.model || "",
        isFixture: Boolean(previous?.isFixture),
        status: "ready",
      };
    });
  }
  draft.pendingRevision = { hasChanges: false, listing: null, images: [], imagesChanged: false, updatedAt: new Date() };
  await draft.save();

  return res.json({ message: "Pending revision discarded.", draft: mapDraft(draft, product) });
});

// Publication. Enforced here, never by hiding a button.
app.post("/api/admin/product-drafts/:id/publish", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });
  if (!draft.productId) return res.status(400).json({ message: "This draft has no product to publish." });

  // The admin must restate intent; an AI step can never reach this branch.
  if (req.body?.confirm !== true) {
    return res.status(400).json({ message: "Publication requires an explicit confirmation." });
  }

  const product = await Product.findById(draft.productId);
  if (!product) return res.status(404).json({ message: "Draft product not found." });

  const confirmSourceImagery = req.body?.confirmSourceImagery === true;
  const { blockers, requiresSourceImageryConfirmation } = evaluatePublicationBlockers({
    product,
    draft,
    placeholderImage: PRODUCT_IMAGE_PLACEHOLDER,
    confirmSourceImagery,
  });

  if (blockers.length > 0) {
    return res.status(400).json({ message: blockers[0], blockers, requiresSourceImageryConfirmation });
  }

  if (confirmSourceImagery) draft.sourceImageryConfirmed = true;

  product.isActive = true;
  await product.save();

  draft.status = "published";
  draft.publishedAt = new Date();
  draft.publishedByAdminId = req.admin.sub;
  await draft.save();

  const populated = await Product.findById(product._id)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug image");
  return res.json({ message: "Product published.", draft: mapDraft(draft, populated) });
});

app.delete("/api/admin/product-drafts/:id", requireAdminAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Draft not found." });
  }
  const draft = await ProductDraft.findById(req.params.id);
  if (!draft) return res.status(404).json({ message: "Draft not found." });

  let productStillLive = false;
  if (draft.productId) {
    const product = await Product.findById(draft.productId).select("_id isActive").lean();
    // Never delete something already live through the draft route.
    if (product && product.isActive !== true) {
      await Product.deleteOne({ _id: draft.productId });
    } else if (product) {
      productStillLive = true;
    }
  }

  // On a preview only, also remove this draft's images from the dedicated
  // preview Cloudinary folder. previewMediaPublicId refuses anything outside
  // that folder, so an existing asset can never be deleted this way.
  let purgedMedia = 0;
  if (shouldPurgePreviewMedia({ isPreview: isPreviewDeployment(), hasCloudinary: hasCloudinaryConfig, productStillLive })) {
    const folder = productUploadFolder();
    for (const image of draft.images || []) {
      const publicId = previewMediaPublicId(image.url, folder);
      if (!publicId) continue;
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
        purgedMedia += 1;
      } catch (error) {
        console.error("Preview media cleanup failed:", error.message);
      }
    }
  }

  draft.status = "discarded";
  await draft.save();
  return res.json({ message: "Draft discarded.", purgedMedia });
});

app.post("/api/auth/check-email", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  const existingUser = await User.findOne({ email }).select("_id").lean();
  return res.json({ exists: !!existingUser });
});

app.post("/api/support-requests", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phone = String(req.body?.phone || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const message = String(req.body?.message || "").trim();
  const source = String(req.body?.source || "footer").trim();
  const pageUrl = String(req.body?.pageUrl || "").trim();
  const locale = String(req.body?.locale || "en").trim().toLowerCase();

  if (!name || !email || !message) {
    return res.status(400).json({ message: "name, email and message are required." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: "Please provide a valid email address." });
  }

  const supportRequest = await SupportRequest.create({
    name,
    email,
    phone,
    subject,
    message,
    locale: locale === "de" ? "de" : "en",
    source,
    pageUrl,
    status: "new",
  });

  const notificationResult = await sendSupportRequestNotificationEmail(supportRequest);
  if (!notificationResult.adminSent) {
    console.warn("Support request email notification failed for request:", String(supportRequest._id));
  }

  return res.status(201).json({
    message: "Support request submitted successfully.",
    request: mapSupportRequest(supportRequest),
  });
});

app.get("/api/admin/support-requests", requireAdminAuth, async (_, res) => {
  const requests = await SupportRequest.find().sort({ createdAt: -1 });
  return res.json(requests.map(mapSupportRequest));
});

app.patch("/api/admin/support-requests/:id/status", requireAdminAuth, async (req, res) => {
  const status = String(req.body?.status || "").trim();
  if (!["new", "in_progress", "resolved"].includes(status)) {
    return res.status(400).json({ message: "Invalid status." });
  }

  const supportRequest = await SupportRequest.findById(req.params.id);
  if (!supportRequest) {
    return res.status(404).json({ message: "Support request not found." });
  }

  supportRequest.status = status;
  await supportRequest.save();
  return res.json(mapSupportRequest(supportRequest));
});

app.get("/api/admin/orders", requireAdminAuth, async (_, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  return res.json(orders.map(mapOrder));
});

app.patch("/api/admin/orders/:id/fulfillment-status", requireAdminAuth, async (req, res) => {
  const fulfillmentStatus = String(req.body?.fulfillmentStatus || "")
    .trim()
    .toLowerCase();
  if (!VALID_FULFILLMENT_STATUSES.includes(fulfillmentStatus)) {
    return res.status(400).json({ message: "Invalid fulfillment status." });
  }

  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ message: "Order not found." });
  }

  order.fulfillmentStatus = fulfillmentStatus;
  await order.save();
  await sendOrderFulfillmentStatusEmail(order);

  return res.json({
    message: "Order fulfillment status updated.",
    order: mapOrder(order),
  });
});

app.post("/api/auth/signup/request-otp", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const password = String(req.body?.password || "").trim();
  const phone = req.body?.phone ? String(req.body.phone).trim() : null;

  if (!email || !name || !password) {
    return res.status(400).json({ message: "name, email and password are required." });
  }

  if (phone && !isValidGermanPhone(phone)) {
    return res.status(400).json({
      message: "Phone must be a valid Germany number in +49 format.",
    });
  }

  const existingUser = await User.findOne({ email }).select("_id").lean();
  if (existingUser) {
    return res.status(409).json({ message: "User already exists." });
  }

  if (!canSendEmail) {
    return res.status(500).json({ message: "Email service is not configured." });
  }

  const otp = buildSixDigitOtp();
  const otpHash = hashOtp(otp);
  const expiresInMinutes = Math.max(1, Number(process.env.SIGNUP_OTP_EXPIRES_MINUTES || 10));
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
  const passwordHash = await bcrypt.hash(password, 10);

  await SignupOtp.findOneAndUpdate(
    { email },
    {
      email,
      name,
      passwordHash,
      phone,
      otpHash,
      expiresAt,
      attempts: 0,
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );

  const sent = await sendSignupOtpEmail(email, otp, name);
  if (!sent) {
    return res.status(500).json({ message: "Could not send verification email. Please try again." });
  }

  return res.status(201).json({
    message: "Verification code sent to your email.",
    email,
    expiresInMinutes,
  });
});

app.post("/api/auth/signup/verify-otp", async (req, res) => {
  if (rejectWhenJwtSecretMissing(res)) return undefined;

  const email = String(req.body?.email || "").trim().toLowerCase();
  const otp = String(req.body?.otp || "").trim();

  if (!email || !otp) {
    return res.status(400).json({ message: "email and otp are required." });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: "OTP must be a 6-digit code." });
  }

  const pendingSignup = await SignupOtp.findOne({ email });
  if (!pendingSignup) {
    return res.status(404).json({ message: "No pending signup found for this email." });
  }

  if (pendingSignup.expiresAt.getTime() < Date.now()) {
    await SignupOtp.deleteOne({ _id: pendingSignup._id });
    return res.status(400).json({ message: "OTP expired. Please request a new code." });
  }

  const expectedHash = hashOtp(otp);
  if (expectedHash !== pendingSignup.otpHash) {
    pendingSignup.attempts = (pendingSignup.attempts || 0) + 1;
    if (pendingSignup.attempts >= 5) {
      await SignupOtp.deleteOne({ _id: pendingSignup._id });
      return res.status(400).json({ message: "Too many incorrect attempts. Request a new code." });
    }
    await pendingSignup.save();
    return res.status(400).json({ message: "Invalid OTP code." });
  }

  const existingUser = await User.findOne({ email }).select("_id").lean();
  if (existingUser) {
    await SignupOtp.deleteOne({ _id: pendingSignup._id });
    return res.status(409).json({ message: "User already exists." });
  }

  const user = await User.create({
    name: pendingSignup.name,
    email: pendingSignup.email,
    passwordHash: pendingSignup.passwordHash,
    phone: pendingSignup.phone || null,
  });

  await SignupOtp.deleteOne({ _id: pendingSignup._id });

  const token = buildUserToken(user);
  return res.status(201).json({
    message: "Signup successful.",
    token,
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: normalizeAddressInput(user.address),
      wishlistProductIds: [],
      identityVerified: Boolean(user.identityVerified),
    },
  });
});

app.post("/api/auth/signup", async (req, res) => {
  return res.status(400).json({
    message: "Use /api/auth/signup/request-otp and /api/auth/signup/verify-otp for signup.",
  });
});

app.post("/api/auth/signin", async (req, res) => {
  if (rejectWhenJwtSecretMissing(res)) return undefined;

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "").trim();
  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required." });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(401).json({ message: "Invalid credentials." });
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    return res.status(401).json({ message: "Invalid credentials." });
  }

  const token = buildUserToken(user);
  return res.json({
    message: "Signin successful.",
    token,
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: normalizeAddressInput(user.address),
      wishlistProductIds: Array.isArray(user.wishlistProductIds)
        ? user.wishlistProductIds.map((id) => String(id))
        : [],
      identityVerified: Boolean(user.identityVerified),
    },
  });
});

app.post("/api/auth/google", async (req, res) => {
  if (rejectWhenJwtSecretMissing(res)) return undefined;

  const credential = String(req.body?.credential || req.body?.idToken || "").trim();
  if (!credential) {
    return res.status(400).json({ message: "Google credential is required." });
  }

  const configuredGoogleClientId = String(
    process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ""
  ).trim();
  if (!configuredGoogleClientId) {
    return res.status(500).json({ message: "Google Sign-In is not configured on the server." });
  }

  let tokenPayload;
  try {
    tokenPayload = await verifyGoogleIdToken(credential);
  } catch {
    return res.status(401).json({ message: "Invalid Google credential." });
  }

  const aud = String(tokenPayload?.aud || "").trim();
  const sub = String(tokenPayload?.sub || "").trim();
  const email = String(tokenPayload?.email || "").trim().toLowerCase();
  const emailVerified = String(tokenPayload?.email_verified || "").toLowerCase() === "true";
  const name = String(tokenPayload?.name || "").trim();

  if (!sub || !email || !emailVerified) {
    return res.status(401).json({ message: "Google account verification failed." });
  }

  if (aud !== configuredGoogleClientId) {
    return res.status(401).json({ message: "Google client ID mismatch." });
  }

  let user = await User.findOne({ email });
  if (!user) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
    user = await User.create({
      name: name || email.split("@")[0] || "Google User",
      email,
      passwordHash,
      phone: null,
    });
  } else if (!user.name && name) {
    user.name = name;
    await user.save();
  }

  const token = buildUserToken(user);
  return res.json({
    message: "Google signin successful.",
    token,
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: normalizeAddressInput(user.address),
      wishlistProductIds: Array.isArray(user.wishlistProductIds)
        ? user.wishlistProductIds.map((id) => String(id))
        : [],
      identityVerified: Boolean(user.identityVerified),
    },
  });
});

app.get("/api/auth/me", requireUserAuth, async (req, res) => {
  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  return res.json({
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: normalizeAddressInput(user.address),
      wishlistProductIds: Array.isArray(user.wishlistProductIds)
        ? user.wishlistProductIds.map((id) => String(id))
        : [],
      identityVerified: Boolean(user.identityVerified),
    },
  });
});

app.get("/api/wishlist", requireUserAuth, async (req, res) => {
  const user = await User.findById(req.userAuth.sub).populate({
    path: "wishlistProductIds",
    populate: [
      { path: "categoryId", select: "name slug" },
      { path: "brandId", select: "name slug image" },
    ],
  });

  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const products = (user.wishlistProductIds || []).filter(Boolean).map(mapProduct);
  return res.json({
    productIds: products.map((product) => product.id),
    products,
  });
});

app.post("/api/wishlist/:productId", requireUserAuth, async (req, res) => {
  const { productId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: "Invalid product id." });
  }

  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const product = await Product.findById(productId).select("_id isActive").lean();
  if (!product || !product.isActive) {
    return res.status(404).json({ message: "Product not found." });
  }

  const exists = (user.wishlistProductIds || []).some((id) => String(id) === String(product._id));
  if (!exists) {
    user.wishlistProductIds.push(product._id);
    await user.save();
  }

  return res.status(201).json({
    message: "Added to wishlist.",
    productIds: (user.wishlistProductIds || []).map((id) => String(id)),
  });
});

app.delete("/api/wishlist/:productId", requireUserAuth, async (req, res) => {
  const { productId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: "Invalid product id." });
  }

  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  user.wishlistProductIds = (user.wishlistProductIds || []).filter((id) => String(id) !== productId);
  await user.save();

  return res.json({
    message: "Removed from wishlist.",
    productIds: (user.wishlistProductIds || []).map((id) => String(id)),
  });
});

app.get("/api/payments/identity-status", requireUserAuth, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured." });
  }
  if (!isFrontendUrlConfigured()) {
    console.error("FRONTEND_URL is not configured; refusing to start checkout.");
    return res.status(500).json({ message: "Checkout is not configured yet." });
  }

  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  if (!user.identityVerified && user.stripeIdentitySessionId) {
    try {
      const verificationSession = await stripe.identity.verificationSessions.retrieve(
        user.stripeIdentitySessionId
      );
      if (verificationSession.status === "verified") {
        user.identityVerified = true;
        await user.save();
      }
    } catch {}
  }

  return res.json({
    verified: Boolean(user.identityVerified),
    verificationSessionId: user.stripeIdentitySessionId || "",
  });
});

app.post("/api/payments/identity-session", requireUserAuth, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured." });
  }

  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  if (user.identityVerified) {
    return res.json({ verified: true });
  }

  const frontendBaseUrl = getFrontendBaseUrl();
  const verificationSession = await stripe.identity.verificationSessions.create({
    type: "document",
    metadata: {
      userId: String(user._id),
      email: user.email,
    },
    return_url: `${frontendBaseUrl}/checkout?identity_return=1`,
  });

  user.stripeIdentitySessionId = verificationSession.id;
  await user.save();

  return res.status(201).json({
    verified: false,
    sessionId: verificationSession.id,
    url: verificationSession.url,
  });
});

function formatRentalPeriodLabel(durationValue, durationUnit) {
  const plural = durationValue === 1 ? "" : "s";
  return `${durationValue} ${durationUnit}${plural}`;
}

function isValidStartDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

// Fields required to price a line and to snapshot it onto the order.
const CHECKOUT_PRODUCT_FIELDS = [
  "title",
  "slug",
  "imageUrl",
  "brand",
  "isActive",
  "monthlyPrice",
  "buyerPrice",
  "offerPrice",
  "monthlyBuyerPrice",
  "monthlyOfferPrice",
  "rentalMode",
  "occasionDailyRate",
  "occasionPricing",
  "deliveryLeadDays",
  "minimumRentalMonths",
  "maximumRentalMonths",
  "minimumRentalWeeks",
  "maximumRentalWeeks",
  "minimumRentalDays",
  "maximumRentalDays",
  "maxRentalQuantity",
  "deliveryFee",
  "depositEnabled",
  "securityDeposit",
  "verificationRequired",
  "categoryId",
  "brandId",
].join(" ");

// Reads the non-chargeable intent out of a cart payload. Amount-bearing fields
// in the request are deliberately not looked at here or anywhere downstream.
function parseCartIntent(items, { requireStartDate }) {
  const requestedLines = [];
  const errors = [];

  items.forEach((item, index) => {
    const position = index + 1;
    const productId = String(item?.productId || "").trim();
    const lineId = String(item?.id || item?.lineId || "").trim() || `line-${position}`;

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      errors.push({
        lineId,
        productId,
        code: "INVALID_PRODUCT_REFERENCE",
        message: `Cart line ${position} is missing a valid product reference.`,
      });
      return;
    }

    const startDate = String(item?.startDate || "").trim();
    if (requireStartDate && !isValidStartDate(startDate)) {
      errors.push({
        lineId,
        productId,
        code: "INVALID_START_DATE",
        message: `Cart line ${position} needs a valid delivery date (YYYY-MM-DD).`,
      });
      return;
    }

    requestedLines.push({
      lineId,
      productId,
      startDate,
      periodUnit: item?.durationUnit ?? item?.periodUnit,
      durationValue: item?.durationValue,
      quantity: item?.quantity,
    });
  });

  return { requestedLines, errors };
}

async function loadCartProducts(requestedLines) {
  const productIds = [...new Set(requestedLines.map((line) => line.productId))];
  if (productIds.length === 0) return new Map();

  const products = await Product.find({ _id: { $in: productIds } })
    .select(CHECKOUT_PRODUCT_FIELDS)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug")
    .lean();

  return new Map(products.map((product) => [String(product._id), product]));
}

function buildProductSnapshot(product) {
  const rawCategory = product.categoryId;
  const rawBrand = product.brandId;
  return {
    productId: String(product._id),
    title: String(product.title || ""),
    slug: String(product.slug || ""),
    imageUrl: String(product.imageUrl || ""),
    categoryName:
      rawCategory && typeof rawCategory === "object" ? String(rawCategory.name?.en || "") : "",
    brandName:
      String(product.brand || "") ||
      (rawBrand && typeof rawBrand === "object" ? String(rawBrand.name || "") : ""),
  };
}

// Single pricing pass shared by the quote endpoint and checkout. `lines` is
// always one entry per requested line (valid or not) so a client can render the
// authoritative state of the whole cart; `pricedItems` holds only valid lines.
function priceCartLines(requestedLines, productById) {
  const lines = [];
  const pricedItems = [];
  const errors = [];

  for (const line of requestedLines) {
    const product = productById.get(line.productId) || null;
    const limits = getProductRentalLimits(product, line.periodUnit);
    const priced = priceOrderItem(product, {
      periodUnit: line.periodUnit,
      durationValue: line.durationValue,
      quantity: line.quantity,
    });

    if (!priced.ok) {
      const issue = {
        lineId: line.lineId,
        productId: line.productId,
        code: priced.error.code,
        message: priced.error.message,
      };
      errors.push(issue);
      lines.push({
        lineId: line.lineId,
        productId: line.productId,
        title: product ? String(product.title || "") : "",
        valid: false,
        limits,
        issue,
      });
      continue;
    }

    // The start date must respect this product's delivery lead time (same rule
    // for standard and occasion products; the storefront uses the same helper).
    const leadTimeMessage = line.startDate ? checkStartDate(product, line.startDate) : null;
    if (leadTimeMessage) {
      const issue = { lineId: line.lineId, productId: line.productId, code: "START_DATE_TOO_EARLY", message: leadTimeMessage };
      errors.push(issue);
      lines.push({ lineId: line.lineId, productId: line.productId, title: String(product.title || ""), valid: false, limits, issue });
      continue;
    }

    const snapshot = buildProductSnapshot(product);
    const pricedItem = { ...priced.item, ...snapshot, startDate: line.startDate };
    pricedItems.push(pricedItem);

    lines.push({
      lineId: line.lineId,
      ...snapshot,
      valid: true,
      limits,
      quantity: pricedItem.quantity,
      durationValue: pricedItem.durationValue,
      durationUnit: pricedItem.durationUnit,
      unitPrice: pricedItem.unitPrice,
      baseUnitPrice: pricedItem.baseUnitPrice,
      listUnitPrice: pricedItem.listUnitPrice,
      depositEnabled: pricedItem.depositEnabled,
      securityDeposit: pricedItem.securityDeposit,
      deliveryFee: pricedItem.deliveryFee,
      lineSubtotal: pricedItem.lineSubtotal,
      lineDeposit: pricedItem.lineDeposit,
      lineDelivery: pricedItem.lineDelivery,
      lineTotal: pricedItem.lineTotal,
      verificationRequired: pricedItem.verificationRequired,
      billingType: pricedItem.billingType,
      // What this line costs at checkout and per following period.
      lineDueToday: roundMoney(pricedItem.dueTodayRental + pricedItem.lineDeposit + pricedItem.lineDelivery),
      recurringPerPeriod: roundMoney(pricedItem.recurringPerUnit * pricedItem.quantity),
      remainingPayments: pricedItem.billingType === "recurring" ? pricedItem.durationValue - 1 : 0,
    });
  }

  return { lines, pricedItems, errors };
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// The billing shape the storefront shows and the checkout creates. Derived only
// from priced (server-side) items.
function describeCartBilling(pricedItems, totals) {
  const plan = planBilling(pricedItems);
  if (!plan.ok) return { plan, billing: null };
  return {
    plan,
    billing: {
      mode: plan.mode,
      interval: plan.interval,
      billingCycles: plan.cycles,
      dueToday: totals.dueToday,
      totalRental: totals.subtotal,
      oneTimeCharges: roundMoney(totals.depositTotal + totals.deliveryTotal),
      recurringAmount: plan.recurringAmount,
      // Payments after today, as runs of an equal amount.
      upcoming: plan.schedule.length
        ? [
            ...(plan.schedule[0].payments > 1 ? [{ payments: plan.schedule[0].payments - 1, amount: plan.schedule[0].amount }] : []),
            ...plan.schedule.slice(1),
          ]
        : [],
    },
  };
}

// Read-only pricing preview. The storefront calls this to show the same amounts
// the server will charge, and to clamp quantities/durations to the limits the
// server enforces. Public because it exposes nothing beyond catalogue data.
app.post("/api/payments/checkout-quote", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (items.length === 0) {
    return res.json({
      currency: WEBSITE_CURRENCY,
      lines: [],
      issues: [],
      totals: { subtotal: 0, depositTotal: 0, deliveryTotal: 0, total: 0, dueToday: 0 },
      billing: { mode: "one_time", interval: "", billingCycles: 1, dueToday: 0, totalRental: 0, oneTimeCharges: 0, recurringAmount: 0, upcoming: [] },
      requiresIdentityVerification: false,
      valid: true,
    });
  }

  if (items.length > 50) {
    return res.status(400).json({ message: "Too many cart items." });
  }

  const { requestedLines, errors: intentErrors } = parseCartIntent(items, { requireStartDate: false });
  const productById = await loadCartProducts(requestedLines);
  const { lines, pricedItems, errors } = priceCartLines(requestedLines, productById);
  const issues = [...intentErrors, ...errors];
  const totals = sumOrderTotals(pricedItems);
  const { plan, billing } = describeCartBilling(pricedItems, totals);
  if (!plan.ok) issues.push({ lineId: "", productId: "", code: plan.code, message: plan.message });

  return res.json({
    currency: WEBSITE_CURRENCY,
    lines,
    issues,
    totals,
    billing,
    requiresIdentityVerification: pricedItems.some((item) => item.verificationRequired),
    valid: issues.length === 0 && pricedItems.length === items.length,
  });
});

app.post("/api/payments/checkout-session", requireUserAuth, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured." });
  }

  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const shippingAddressRaw = req.body?.shippingAddress || {};
  if (items.length === 0) {
    return res.status(400).json({ message: "Cart items are required." });
  }

  if (items.length > 50) {
    return res.status(400).json({ message: "Too many cart items." });
  }

  const shippingAddress = {
    fullName: String(shippingAddressRaw.fullName || "").trim(),
    phone: String(shippingAddressRaw.phone || "").trim(),
    line1: String(shippingAddressRaw.line1 || "").trim(),
    line2: String(shippingAddressRaw.line2 || "").trim(),
    city: String(shippingAddressRaw.city || "").trim(),
    state: String(shippingAddressRaw.state || "").trim(),
    postalCode: String(shippingAddressRaw.postalCode || "").trim(),
    country: String(shippingAddressRaw.country || "").trim(),
  };

  if (
    !shippingAddress.fullName ||
    !shippingAddress.phone ||
    !shippingAddress.line1 ||
    !shippingAddress.city ||
    !shippingAddress.postalCode ||
    !shippingAddress.country
  ) {
    return res.status(400).json({ message: "Shipping address is required." });
  }

  // Only non-chargeable intent is read from the request. Every amount below is
  // derived from the persisted product, so a tampered client payload cannot
  // change what the customer is charged.
  const { requestedLines, errors: intentErrors } = parseCartIntent(items, { requireStartDate: true });
  const productById = await loadCartProducts(requestedLines);
  const { lines, pricedItems, errors } = priceCartLines(requestedLines, productById);
  const issues = [...intentErrors, ...errors];

  if (issues.length > 0) {
    // Same shape as the quote endpoint so the client can re-render the cart
    // against authoritative limits instead of just showing a flat error.
    return res.status(400).json({
      message: issues[0].message,
      issues,
      lines,
      currency: WEBSITE_CURRENCY,
    });
  }

  if (pricedItems.length === 0) {
    return res.status(400).json({ message: "No valid cart line items found." });
  }

  const requiresIdentityVerification = pricedItems.some((item) => item.verificationRequired);
  if (requiresIdentityVerification && !user.identityVerified) {
    return res.status(403).json({
      message: "Identity verification is required for one or more selected products.",
    });
  }

  const totals = sumOrderTotals(pricedItems);
  if (totals.total <= 0) {
    return res.status(400).json({ message: "Order total must be greater than zero." });
  }

  // Standard rentals longer than one period are billed per period for a fixed
  // term; everything else is a single payment. Decided here from priced items.
  const { plan } = describeCartBilling(pricedItems, totals);
  if (!plan.ok) {
    return res.status(400).json({
      message: plan.message,
      issues: [{ lineId: "", productId: "", code: plan.code, message: plan.message }],
      lines,
      currency: WEBSITE_CURRENCY,
    });
  }
  const isRecurring = plan.mode === "recurring";

  // Precondition, not a price. `expectedTotal` is the figure the customer just
  // approved; it is only ever compared against the server's own total and can
  // never raise, lower or otherwise influence what is charged. A mismatch means
  // the catalogue moved between the quote and this request, so the charge is
  // refused and a refreshed quote is returned for the customer to re-confirm.
  //
  // TODO(2026-11-30): make `expectedTotal` mandatory and reject a request
  // without it. See "Removing the expectedTotal compatibility path" in
  // CLAUDE.md for the conditions that must hold first.
  const expectedTotalRaw = req.body?.expectedTotal;
  const hasExpectedTotal =
    expectedTotalRaw !== undefined && expectedTotalRaw !== null && expectedTotalRaw !== "";

  if (!hasExpectedTotal) {
    // Surfaced so the removal decision below can be made on evidence: once this
    // stops appearing, no client is relying on the compatibility path.
    console.warn(
      "checkout-session called without expectedTotal (legacy client). See TODO(2026-11-30)."
    );
  }

  if (hasExpectedTotal) {
    const expectedTotal = Number(expectedTotalRaw);
    const expectedTotalIsUsable = Number.isFinite(expectedTotal) && expectedTotal >= 0;

    // Compared in integer cents. Both sides are the currency's smallest unit,
    // which is also what Stripe is charged, so a one-cent move is caught
    // exactly and no float epsilon can mask or invent a difference.
    const expectedCents = expectedTotalIsUsable ? Math.round(expectedTotal * 100) : null;
    const authoritativeCents = Math.round(totals.total * 100);

    // The amount due today must match too, when the client states it: it is the
    // figure a recurring-rental customer actually pays at checkout.
    const expectedDueRaw = req.body?.expectedDueToday;
    const dueMismatch =
      expectedDueRaw !== undefined &&
      expectedDueRaw !== null &&
      expectedDueRaw !== "" &&
      Math.round(Number(expectedDueRaw) * 100) !== Math.round(totals.dueToday * 100);

    if (expectedCents === null || expectedCents !== authoritativeCents || dueMismatch) {
      return res.status(409).json({
        code: "PRICE_CHANGED",
        message:
          "Pricing changed since you reviewed your cart. Please review the updated total and confirm again.",
        currency: WEBSITE_CURRENCY,
        lines,
        issues: [],
        totals,
        billing: describeCartBilling(pricedItems, totals).billing,
        requiresIdentityVerification: pricedItems.some((item) => item.verificationRequired),
        valid: true,
      });
    }
  }

  const toCents = (amount) => Math.round(amount * 100);
  const lineItems = [];
  pricedItems.forEach((item, index) => {
    const periodLabel = formatRentalPeriodLabel(item.durationValue, item.durationUnit);
    if (item.billingType === "recurring") {
      // The rental price recurs once per period for the fixed term...
      lineItems.push({
        quantity: item.quantity,
        price_data: {
          currency: WEBSITE_CURRENCY,
          unit_amount: toCents(item.recurringPerUnit),
          recurring: { interval: plan.interval, interval_count: 1 },
          product_data: {
            name: item.title,
            description: `Rental period: ${periodLabel}, billed every ${item.durationUnit}`,
            // Lets the webhook map the subscription item back to this order line.
            metadata: { leihflussLine: String(index) },
          },
        },
      });
      // ...while delivery and deposit are charged once, with the first payment.
      const oneTimePerUnit = roundMoney(item.securityDeposit + item.deliveryFee);
      if (oneTimePerUnit > 0) {
        lineItems.push({
          quantity: item.quantity,
          price_data: {
            currency: WEBSITE_CURRENCY,
            unit_amount: toCents(oneTimePerUnit),
            product_data: { name: `${item.title}: delivery and deposit (one-time)` },
          },
        });
      }
      return;
    }
    lineItems.push({
      quantity: item.quantity,
      price_data: {
        currency: WEBSITE_CURRENCY,
        unit_amount: toCents(item.perUnitChargeable),
        product_data: { name: item.title, description: `Rental period: ${periodLabel}` },
      },
    });
  });

  const orderNumber = buildOrderNumber();
  const order = await Order.create({
    orderNumber,
    userId: user._id,
    customer: {
      name: user.name,
      email: user.email,
      phone: user.phone || "",
    },
    shippingAddress,
    items: pricedItems.map((item) => ({
      productId: item.productId,
      title: item.title,
      slug: item.slug,
      imageUrl: item.imageUrl,
      categoryName: item.categoryName,
      brandName: item.brandName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      baseUnitPrice: item.baseUnitPrice,
      durationValue: item.durationValue,
      durationUnit: item.durationUnit,
      startDate: item.startDate,
      depositEnabled: item.depositEnabled,
      securityDeposit: item.securityDeposit,
      deliveryFee: item.deliveryFee,
      lineSubtotal: item.lineSubtotal,
      lineDeposit: item.lineDeposit,
      lineDelivery: item.lineDelivery,
      lineTotal: item.lineTotal,
      billingType: item.billingType,
    })),
    currency: WEBSITE_CURRENCY,
    subtotal: totals.subtotal,
    depositTotal: totals.depositTotal,
    deliveryTotal: totals.deliveryTotal,
    total: totals.total,
    status: "pending_payment",
    fulfillmentStatus: "pending",
    paymentStatus: "unpaid",
    billingMode: isRecurring ? "recurring" : "one_time",
    recurring: isRecurring
      ? {
          interval: plan.interval,
          billingCycles: plan.cycles,
          recurringAmount: plan.recurringAmount,
          totalRentalCommitment: totals.subtotal,
          oneTimeCharges: roundMoney(totals.depositTotal + totals.deliveryTotal),
          dueToday: totals.dueToday,
          status: "pending",
        }
      : undefined,
  });

  if (!user.stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name,
      phone: user.phone || undefined,
      metadata: {
        userId: String(user._id),
      },
    });
    user.stripeCustomerId = customer.id;
    await user.save();
  }

  const frontendBaseUrl = getFrontendBaseUrl();
  const orderMetadata = {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    userId: String(user._id),
  };
  const checkoutSession = await stripe.checkout.sessions.create({
    mode: isRecurring ? "subscription" : "payment",
    customer: user.stripeCustomerId,
    line_items: lineItems,
    metadata: orderMetadata,
    // Copied onto the subscription so recurring invoices can be matched to the order.
    ...(isRecurring ? { subscription_data: { metadata: orderMetadata } } : {}),
    success_url: `${frontendBaseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendBaseUrl}/checkout?canceled=1`,
  });

  order.stripeCheckoutSessionId = checkoutSession.id;
  await order.save();

  return res.status(201).json({
    id: checkoutSession.id,
    url: checkoutSession.url,
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    // Server-calculated amounts, so the client can reconcile what it displayed.
    currency: WEBSITE_CURRENCY,
    subtotal: totals.subtotal,
    depositTotal: totals.depositTotal,
    deliveryTotal: totals.deliveryTotal,
    total: totals.total,
    dueToday: totals.dueToday,
    billingMode: isRecurring ? "recurring" : "one_time",
  });
});

// Single place where an order transitions to paid. Safe to call repeatedly:
// the paymentStatus guard makes a redelivered webhook or a page refresh a no-op.
async function applyPaidCheckoutSession(order, checkoutSession) {
  // The first payment of a recurring rental is NOT the whole rental: the order
  // becomes active and "partially_paid" until every booked period is paid.
  if (order.billingMode === "recurring" && order.recurring) {
    return applyPaidRecurringCheckout(order, checkoutSession);
  }

  if (order.paymentStatus === "paid") {
    return { changed: false, order };
  }

  order.status = "paid";
  order.fulfillmentStatus = order.fulfillmentStatus === "pending" ? "processing" : order.fulfillmentStatus;
  order.paymentStatus = "paid";
  order.stripePaymentIntentId = String(checkoutSession?.payment_intent || order.stripePaymentIntentId || "");
  order.paymentConfirmedAt = new Date();
  await order.save();

  return { changed: true, order };
}

async function applyPaidRecurringCheckout(order, checkoutSession) {
  let changed = false;
  const subscriptionId = idOf(checkoutSession?.subscription);
  if (subscriptionId && order.stripeSubscriptionId !== subscriptionId) {
    order.stripeSubscriptionId = subscriptionId;
    changed = true;
  }
  if (activateRecurringOrder(order)) changed = true;
  // The checkout's own invoice is the first paid period. Counted by id, so the
  // matching invoice.paid event later is a no-op.
  if (recordPaidInvoice(order, idOf(checkoutSession?.invoice))) changed = true;

  if (changed) await order.save();
  return { changed, order };
}

async function markCheckoutSessionUnpaid(order) {
  if (order.paymentStatus === "paid" || order.paymentStatus === "partially_paid") {
    return { changed: false, order };
  }
  if (order.status === "pending_payment") {
    return { changed: false, order };
  }

  order.status = "pending_payment";
  order.fulfillmentStatus = "pending";
  order.paymentStatus = "unpaid";
  await order.save();
  return { changed: true, order };
}

function extractCheckoutSessionId(stripeEvent) {
  const object = stripeEvent?.data?.object || {};
  return String(object.id || "").trim();
}

// An event whose order cannot be resolved within this window is assumed to be
// racing order creation, and is left unclaimed so Stripe retries. Past it, the
// session is treated as genuinely foreign and acknowledged so retries stop.
const UNRESOLVED_EVENT_GRACE_MS = 15 * 60 * 1000;

/**
 * Locates the Order a Stripe event belongs to.
 *
 * Primary match is the stored checkout session id. That id is persisted just
 * after the session is created, so a fast webhook can arrive before the write
 * lands; `metadata.orderId` (set by us when creating the session) closes that
 * window. Metadata is verified against the order before it is trusted to route
 * a payment, and a contradiction is reported rather than guessed at.
 */
async function resolveOrderForStripeEvent(stripeEvent) {
  const session = stripeEvent?.data?.object || {};
  const sessionId = String(session.id || "").trim();
  const metadata = session.metadata || {};
  const metadataOrderId = String(metadata.orderId || "").trim();
  const metadataOrderNumber = String(metadata.orderNumber || "").trim();
  const metadataUserId = String(metadata.userId || "").trim();

  if (sessionId) {
    const bySession = await Order.findOne({ stripeCheckoutSessionId: sessionId });
    if (bySession) return { order: bySession, matchedBy: "sessionId", mismatch: null };
  }

  if (!mongoose.Types.ObjectId.isValid(metadataOrderId)) {
    return { order: null, matchedBy: null, mismatch: null };
  }

  const byMetadata = await Order.findById(metadataOrderId);
  if (!byMetadata) return { order: null, matchedBy: null, mismatch: null };

  if (metadataOrderNumber && byMetadata.orderNumber !== metadataOrderNumber) {
    return { order: null, matchedBy: null, mismatch: "orderNumber" };
  }

  if (metadataUserId && String(byMetadata.userId) !== metadataUserId) {
    return { order: null, matchedBy: null, mismatch: "userId" };
  }

  const storedSessionId = String(byMetadata.stripeCheckoutSessionId || "").trim();
  if (storedSessionId && sessionId && storedSessionId !== sessionId) {
    // The order already belongs to a different checkout session; never move it.
    return { order: null, matchedBy: null, mismatch: "sessionId" };
  }

  if (!storedSessionId && sessionId) {
    byMetadata.stripeCheckoutSessionId = sessionId;
    await byMetadata.save();
  }

  return { order: byMetadata, matchedBy: "metadata", mismatch: null };
}

/**
 * Locates the Order an invoice / subscription event belongs to.
 *
 * Primary match is the subscription id stored on the order. The first invoice
 * can arrive before that id is stored, so the metadata copied onto the
 * subscription (and, as a last resort, the subscription fetched from Stripe) is
 * used, and verified against the order before it is trusted.
 */
async function resolveOrderForSubscriptionEvent(stripeEvent, stripeClient = stripe) {
  const subscriptionId = subscriptionIdOfEvent(stripeEvent);
  if (!subscriptionId) return { order: null, matchedBy: null, mismatch: null };

  const bySubscription = await Order.findOne({ stripeSubscriptionId: subscriptionId });
  if (bySubscription) return { order: bySubscription, matchedBy: "subscriptionId", mismatch: null };

  let metadata = metadataOfEvent(stripeEvent);
  if (!mongoose.Types.ObjectId.isValid(String(metadata.orderId || "")) && stripeClient) {
    const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
    metadata = subscription?.metadata || {};
  }

  const metadataOrderId = String(metadata.orderId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(metadataOrderId)) return { order: null, matchedBy: null, mismatch: null };

  const byMetadata = await Order.findById(metadataOrderId);
  if (!byMetadata) return { order: null, matchedBy: null, mismatch: null };

  if (metadata.orderNumber && byMetadata.orderNumber !== String(metadata.orderNumber)) {
    return { order: null, matchedBy: null, mismatch: "orderNumber" };
  }
  if (metadata.userId && String(byMetadata.userId) !== String(metadata.userId)) {
    return { order: null, matchedBy: null, mismatch: "userId" };
  }
  if (byMetadata.billingMode !== "recurring" || !byMetadata.recurring) {
    return { order: null, matchedBy: null, mismatch: "billingMode" };
  }
  const stored = String(byMetadata.stripeSubscriptionId || "").trim();
  if (stored && stored !== subscriptionId) return { order: null, matchedBy: null, mismatch: "subscriptionId" };

  if (!stored) {
    byMetadata.stripeSubscriptionId = subscriptionId;
    await byMetadata.save();
  }
  return { order: byMetadata, matchedBy: "metadata", mismatch: null };
}

/**
 * Applies a recurring-billing event to its order. Idempotent: counting is keyed
 * by invoice id and every transition is a guarded no-op when repeated.
 */
async function processRecurringEvent(stripeEvent, order, stripeClient = stripe) {
  const object = stripeEvent.data.object || {};
  const subscriptionId = subscriptionIdOfEvent(stripeEvent);
  let changed = false;

  if (stripeEvent.type === "invoice.paid") {
    if (activateRecurringOrder(order)) changed = true;
    if (subscriptionId && order.stripeSubscriptionId !== subscriptionId) {
      order.stripeSubscriptionId = subscriptionId;
      changed = true;
    }
    const paidAt = Number(object.status_transitions?.paid_at) > 0 ? new Date(object.status_transitions.paid_at * 1000) : new Date();
    if (recordPaidInvoice(order, idOf(object), { paidAt, nextBillingDate: nextBillingDateOfInvoice(object) })) changed = true;
    if (changed) await order.save();
    // The subscription must end by itself after the booked term. Done here as
    // well as on checkout completion so either event is enough.
    if (stripeClient && subscriptionId) await ensureFixedTermSchedule({ stripe: stripeClient, order, subscriptionId });
    return;
  }

  if (stripeEvent.type === "invoice.payment_failed") {
    const failedAt = Number(stripeEvent.created) > 0 ? new Date(stripeEvent.created * 1000) : new Date();
    if (recordFailedPayment(order, failedAt)) await order.save();
    return;
  }

  if (stripeEvent.type === "customer.subscription.deleted") {
    if (recordSubscriptionEnded(order)) await order.save();
  }
}

// A handler cannot outlive the 60s function limit, so a claim older than this
// belongs to a worker that died. Taking it over is safe because every state
// change the handler performs is idempotent.
const STRIPE_EVENT_LEASE_MS = 2 * 60 * 1000;

/**
 * Takes the processing lease for an event.
 *
 * Returns `claimed` when this worker should process it, `duplicate` when it has
 * already completed, and `in_progress` when another worker holds a live lease
 * (answered with a retry so the two never process concurrently).
 *
 * A claim left behind by a crashed worker is taken over once its lease expires,
 * so an interrupted event is finished by a retry instead of being permanently
 * skipped.
 */
async function claimStripeEvent(stripeEvent, orderId) {
  try {
    await StripeWebhookEvent.create({
      eventId: stripeEvent.id,
      type: stripeEvent.type,
      orderId: orderId || null,
      status: "processing",
      claimedAt: new Date(),
    });
    return { outcome: "claimed" };
  } catch (error) {
    if (!error || error.code !== 11000) throw error;
  }

  const existing = await StripeWebhookEvent.findOne({ eventId: stripeEvent.id });
  if (!existing) {
    // Deleted between the failed insert and this read; let Stripe retry.
    return { outcome: "in_progress" };
  }

  if (existing.status === "completed") {
    return { outcome: "duplicate" };
  }

  const staleBefore = new Date(Date.now() - STRIPE_EVENT_LEASE_MS);
  const takenOver = await StripeWebhookEvent.findOneAndUpdate(
    {
      eventId: stripeEvent.id,
      status: "processing",
      claimedAt: { $lte: staleBefore },
    },
    { $set: { claimedAt: new Date(), orderId: orderId || existing.orderId || null } },
    { returnDocument: "after" }
  );

  if (takenOver) {
    console.warn(
      `Stripe webhook ${stripeEvent.id} had an abandoned claim; taking it over and reprocessing.`
    );
    return { outcome: "claimed", recovered: true };
  }

  return { outcome: "in_progress" };
}

async function completeStripeEvent(stripeEvent, orderId) {
  await StripeWebhookEvent.updateOne(
    { eventId: stripeEvent.id },
    { $set: { status: "completed", processedAt: new Date(), orderId: orderId || null } }
  );
}

function isStripeEventWithinGrace(stripeEvent) {
  const createdSeconds = Number(stripeEvent?.created);
  if (!Number.isFinite(createdSeconds) || createdSeconds <= 0) return true;
  return Date.now() - createdSeconds * 1000 < UNRESOLVED_EVENT_GRACE_MS;
}

// Stripe needs the exact signed bytes. Express gives us a Buffer via
// express.raw; some serverless runtimes parse the body first, so fall back to
// whatever raw representation is available and fail closed if there is none.
function getStripeRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");
  return null;
}

app.post(STRIPE_WEBHOOK_PATH, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured." });
  }

  if (!stripeWebhookSecret) {
    console.error("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured.");
    return res.status(500).json({ message: "Stripe webhook secret is not configured." });
  }

  const signature = req.headers["stripe-signature"];
  const rawBody = getStripeRawBody(req);

  if (!signature || !rawBody) {
    console.error("Stripe webhook rejected: missing signature or raw request body.");
    return res.status(400).json({ message: "Invalid Stripe webhook request." });
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error.message);
    return res.status(400).json({ message: "Invalid Stripe webhook signature." });
  }

  const relevantTypes = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
    ...RECURRING_EVENT_TYPES,
  ];

  if (!relevantTypes.includes(stripeEvent.type)) {
    return res.json({ received: true, ignored: true });
  }

  const isRecurringEvent = RECURRING_EVENT_TYPES.includes(stripeEvent.type);
  // An invoice that does not belong to a subscription (e.g. a manual one) is none of our business.
  const sessionId = isRecurringEvent ? subscriptionIdOfEvent(stripeEvent) : extractCheckoutSessionId(stripeEvent);
  if (!sessionId) {
    return res.json({ received: true, ignored: true });
  }

  // Resolve the order BEFORE claiming the event. Claiming first would burn the
  // idempotency key on a delivery that raced order creation, and the 200 would
  // stop Stripe retrying a payment we never recorded.
  let resolution;
  try {
    resolution = isRecurringEvent
      ? await resolveOrderForSubscriptionEvent(stripeEvent)
      : await resolveOrderForStripeEvent(stripeEvent);
  } catch (error) {
    console.error("Stripe webhook order lookup failed:", error.message);
    return res.status(500).json({ message: "Could not resolve order for Stripe event." });
  }

  const { order, mismatch } = resolution;

  if (!order) {
    if (!mismatch && isStripeEventWithinGrace(stripeEvent)) {
      // Leave the event unclaimed so Stripe retries once the order write lands.
      console.warn(
        `Stripe webhook ${stripeEvent.type} could not resolve an order for session ${sessionId} yet; asking Stripe to retry.`
      );
      return res.status(409).json({
        received: false,
        matched: false,
        message: "Order is not resolvable yet. Please retry.",
      });
    }

    if (mismatch) {
      console.error(
        `Stripe webhook ${stripeEvent.type} metadata contradicts the referenced order (${mismatch}) for session ${sessionId}.`
      );
    } else {
      console.error(
        `Stripe webhook ${stripeEvent.type} had no matching order for session ${sessionId} after the grace window.`
      );
    }

    // Acknowledge so Stripe stops retrying an event we can never match. Record
    // it as completed: there is no work left to recover.
    await StripeWebhookEvent.create({
      eventId: stripeEvent.id,
      type: stripeEvent.type,
      status: "completed",
      processedAt: new Date(),
    }).catch((error) => {
      if (!error || error.code !== 11000) throw error;
    });

    return res.json({ received: true, matched: false });
  }

  // Claim the processing lease now that the order is known. A completed claim
  // is a true duplicate; a live one belongs to another worker; a stale one was
  // abandoned by a crashed worker and is taken over.
  let claim;
  try {
    claim = await claimStripeEvent(stripeEvent, order._id);
  } catch (error) {
    console.error("Stripe webhook bookkeeping failed:", error.message);
    return res.status(500).json({ message: "Could not record Stripe webhook event." });
  }

  if (claim.outcome === "duplicate") {
    return res.json({ received: true, duplicate: true });
  }

  if (claim.outcome === "in_progress") {
    // Another worker holds a live lease. Ask Stripe to retry rather than
    // processing the same event twice in parallel.
    return res.status(409).json({
      received: false,
      message: "Event is already being processed. Please retry.",
    });
  }

  try {
    const sessionObject = stripeEvent.data.object || {};

    if (isRecurringEvent) {
      await processRecurringEvent(stripeEvent, order);
    } else if (
      stripeEvent.type === "checkout.session.completed" ||
      stripeEvent.type === "checkout.session.async_payment_succeeded"
    ) {
      if (sessionObject.payment_status === "paid") {
        await applyPaidCheckoutSession(order, sessionObject);
        if (order.billingMode === "recurring" && order.recurring && idOf(sessionObject.subscription)) {
          await ensureFixedTermSchedule({ stripe, order, subscriptionId: idOf(sessionObject.subscription) });
        }
      }
    } else if (stripeEvent.type === "checkout.session.async_payment_failed") {
      await markCheckoutSessionUnpaid(order);
    } else if (stripeEvent.type === "checkout.session.expired" && !["paid", "partially_paid"].includes(order.paymentStatus)) {
      order.status = "cancelled";
      order.fulfillmentStatus = "cancelled";
      await order.save();
    }

    // Only now is the claim terminal. A crash before this point leaves the
    // lease to expire so a retry can finish the work.
    await completeStripeEvent(stripeEvent, order._id);

    return res.json({ received: true, recovered: Boolean(claim.recovered) });
  } catch (error) {
    // Release the claim so Stripe's retry can reprocess immediately rather than
    // waiting out the lease.
    await StripeWebhookEvent.deleteOne({ eventId: stripeEvent.id, status: "processing" }).catch(() => {});
    console.error("Stripe webhook processing failed:", error.message);
    return res.status(500).json({ message: "Stripe webhook processing failed." });
  }
});

// Advisory only. The webhook is the source of truth for payment state; this
// endpoint lets the success page reflect status promptly (and covers the window
// before a webhook lands) without being the only path that can mark an order paid.
app.post("/api/payments/checkout-confirm", requireUserAuth, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ message: "Stripe is not configured." });
  }

  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ message: "sessionId is required." });
  }

  const user = await User.findById(req.userAuth.sub).select("_id").lean();
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const order = await Order.findOne({
    stripeCheckoutSessionId: sessionId,
    userId: user._id,
  });

  if (!order) {
    return res.status(404).json({ message: "Order not found for this checkout session." });
  }

  if (order.paymentStatus === "paid" || order.paymentStatus === "partially_paid") {
    // Already applied (by the webhook or an earlier confirm). A recurring order
    // must still end up with its fixed-term schedule; this is a no-op once attached.
    if (order.billingMode === "recurring" && order.recurring && order.stripeSubscriptionId) {
      await ensureFixedTermSchedule({ stripe, order, subscriptionId: order.stripeSubscriptionId });
    }
    return res.json({
      message: "Order payment confirmed.",
      order: mapOrder(order),
    });
  }

  const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

  if (checkoutSession.payment_status !== "paid") {
    await markCheckoutSessionUnpaid(order);
    return res.status(409).json({ message: "Payment is not completed yet." });
  }

  await applyPaidCheckoutSession(order, checkoutSession);

  // Same guarantee as the webhook: a recurring rental never runs without the
  // schedule that cancels it after the booked term. One-time orders skip this.
  if (order.billingMode === "recurring" && order.recurring) {
    const subscriptionId = idOf(checkoutSession.subscription) || order.stripeSubscriptionId;
    if (subscriptionId) await ensureFixedTermSchedule({ stripe, order, subscriptionId });
  }

  return res.json({
    message: "Order payment confirmed.",
    order: mapOrder(order),
  });
});

app.put("/api/auth/profile", requireUserAuth, async (req, res) => {
  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const name = req.body?.name ? String(req.body.name).trim() : user.name;
  const phone = req.body?.phone !== undefined ? String(req.body.phone || "").trim() : user.phone;
  const address =
    req.body?.address !== undefined ? normalizeAddressInput(req.body.address) : normalizeAddressInput(user.address);

  if (!name) {
    return res.status(400).json({ message: "Name is required." });
  }

  if (phone && !isValidGermanPhone(phone)) {
    return res.status(400).json({
      message: "Phone must be a valid Germany number in +49 format.",
    });
  }

  user.name = name;
  user.phone = phone || null;
  user.address = address;
  await user.save();

  return res.json({
    message: "Profile updated successfully.",
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: normalizeAddressInput(user.address),
    },
  });
});

app.put("/api/auth/change-password", requireUserAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "").trim();
  const newPassword = String(req.body?.newPassword || "").trim();

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "currentPassword and newPassword are required." });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: "New password must be at least 6 characters." });
  }

  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const validPassword = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!validPassword) {
    return res.status(401).json({ message: "Current password is incorrect." });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();

  return res.json({ message: "Password changed successfully." });
});

app.delete("/api/auth/account", requireUserAuth, async (req, res) => {
  const password = String(req.body?.password || "").trim();
  if (!password) {
    return res.status(400).json({ message: "Password is required to delete account." });
  }

  const user = await User.findById(req.userAuth.sub);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    return res.status(401).json({ message: "Password is incorrect." });
  }

  await User.deleteOne({ _id: user._id });
  return res.json({ message: "Account deleted successfully." });
});

async function startServer() {
  await initializeApp();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!canSendEmail) {
      console.warn("SMTP is not fully configured. Email notifications are disabled.");
    }

    if (!isJwtSecretConfigured()) {
      console.error("JWT_SECRET is not configured. Signin, signup and all admin routes will return 500.");
    }

    if (stripe && !stripeWebhookSecret) {
      console.warn(
        "STRIPE_WEBHOOK_SECRET is not configured. Stripe webhooks will be rejected and orders will only be confirmed by the success page."
      );
    }

    const reminderIntervalMs = Math.max(10, Number(process.env.RENTAL_REMINDER_INTERVAL_MINUTES || 60)) * 60 * 1000;
    const runSweep = async () => {
      try {
        await runRentalEndingReminderSweep();
      } catch (error) {
        console.error("Rental reminder sweep failed:", error.message);
      }
    };

    runSweep();
    setInterval(runSweep, reminderIntervalMs);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  });
}

module.exports = app;
module.exports.default = app;
module.exports.app = app;
module.exports.initializeApp = initializeApp;
module.exports.runRentalEndingReminderSweep = runRentalEndingReminderSweep;
module.exports.applyPaidCheckoutSession = applyPaidCheckoutSession;
module.exports.markCheckoutSessionUnpaid = markCheckoutSessionUnpaid;
module.exports.resolveOrderForStripeEvent = resolveOrderForStripeEvent;
module.exports.stripe = stripe;
module.exports.claimStripeEvent = claimStripeEvent;
module.exports.processRecurringEvent = processRecurringEvent;
module.exports.resolveOrderForSubscriptionEvent = resolveOrderForSubscriptionEvent;
module.exports.completeStripeEvent = completeStripeEvent;
module.exports.STRIPE_EVENT_LEASE_MS = STRIPE_EVENT_LEASE_MS;
