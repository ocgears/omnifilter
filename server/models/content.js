const mongoose = require('mongoose');

var contentSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  title: String,
  createdOn: String,
  tags: [String],
  location: String,
  tOption: String,
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Content', contentSchema);
