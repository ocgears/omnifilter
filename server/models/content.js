const mongoose = require('mongoose');

var contentSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  tOption: String,
  tParams: mongoose.Schema.Types.Mixed,
  // For a stack of filters (server/lib/stack.js): each layer in order.
  tStack: [{
    _id: false,
    tOption: String,
    tParams: mongoose.Schema.Types.Mixed,
    amount: Number,
    blend: String
  }],
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Each user's photos, newest first: the gallery's query, and the count
// against the photo limit.
contentSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.model('Content', contentSchema);
