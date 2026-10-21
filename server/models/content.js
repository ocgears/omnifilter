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
  // The photo (lib/image_codec.js toStored): its bytes and their type
  // (image/jpeg, ...), its size, and a small copy for the gallery, as a WebP
  // data URL. GET /content/:id sends the photo itself.
  image: Buffer,
  mime: String,
  width: Number,
  height: Number,
  thumb: String,
  // Photos kept before there were thumbnails: the photo as a data URL, which
  // GET /getAll moves to the fields above.
  content: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  // Set while its owner shares it: the photo's public address is
  // /p/<shareId> (routes/share_routes.js). Random, so it can't be guessed.
  shareId: String,
  sharedAt: Date
}, {
  // Replies describe a photo; the photo itself only comes from /content/:id.
  toJSON: {
    transform: (doc, ret) => {
      delete ret.image;
      delete ret.content;
      return ret;
    }
  }
});

contentSchema.pre('validate', function() {
  if (!this.image && !this.content) this.invalidate('image', 'A photo is required');
});

// Each user's photos, newest first: the gallery's query, and the count
// against the photo limit.
contentSchema.index({ user_id: 1, createdAt: -1 });
// Shared photos, by their public address.
contentSchema.index({ shareId: 1 }, { unique: true, partialFilterExpression: { shareId: { $type: 'string' } } });

module.exports = mongoose.model('Content', contentSchema);
