// ═══════════════════════════════════════════════════════════════
// AUREX — api/history.js
// Vercel Serverless Function → MongoDB Atlas (M0 Free Cluster)
// GET  /api/history?limit=20   → fetch recent chat history
// POST /api/history            → save a user/ai message pair
// ═══════════════════════════════════════════════════════════════

const { MongoClient } = require('mongodb');

// ── MongoDB connection (cached between warm invocations) ────────
let cachedClient = null;
let cachedDb = null;

async function connectDB() {
  if (cachedClient && cachedDb) return cachedDb;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set in environment variables.');

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });

  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'aurex');
  cachedClient = client;
  cachedDb = db;
  return db;
}

// ── CORS ────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Handler ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = await connectDB();
    const col = db.collection('messages');

    // ── GET: Fetch recent history ─────────────────────────────
    if (req.method === 'GET') {
      const limit = Math.min(parseInt(req.query?.limit || '20'), 50);

      const docs = await col
        .find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      // Return oldest-first so the chat renders in order
      const history = docs.reverse().map(d => ({
        user: d.user,
        ai:   d.ai,
        ts:   d.createdAt,
      }));

      return res.status(200).json({ history, count: history.length });
    }

    // ── POST: Save a message pair ─────────────────────────────
    if (req.method === 'POST') {
      const { user, ai } = req.body || {};

      if (!user || !ai) {
        return res.status(400).json({ error: 'Both user and ai fields are required.' });
      }

      const doc = {
        user: String(user).slice(0, 4000),
        ai:   String(ai).slice(0, 8000),
        createdAt: new Date(),
      };

      const result = await col.insertOne(doc);

      // Keep only the last 500 messages (free tier housekeeping)
      const total = await col.countDocuments();
      if (total > 500) {
        const oldest = await col
          .find({})
          .sort({ createdAt: 1 })
          .limit(total - 500)
          .toArray();
        const ids = oldest.map(d => d._id);
        if (ids.length > 0) await col.deleteMany({ _id: { $in: ids } });
      }

      return res.status(201).json({ success: true, id: result.insertedId });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('History API error:', err);

    // Graceful fallback — don't break the frontend if DB is down
    if (req.method === 'GET') {
      return res.status(200).json({ history: [], count: 0, warning: 'DB unavailable' });
    }
    return res.status(500).json({ error: 'Database error: ' + err.message });
  }
};
