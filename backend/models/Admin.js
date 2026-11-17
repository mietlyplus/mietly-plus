const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    username: { type: String, trim: true },
    // Lower-cased copy used for sign-in lookups; sparse so existing admins
    // without a username are unaffected.
    usernameKey: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.Admin || mongoose.model("Admin", adminSchema);
