const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const fetch = require('node-fetch');
const cors = require('cors');

// ============ FIREBASE INIT ============
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ============ CASHFREE CONFIG ============
const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID;
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET;
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'sandbox';
const CASHFREE_API = CASHFREE_ENV === 'production' 
  ? 'https://api.cashfree.com/pg' 
  : 'https://sandbox.cashfree.com/pg';
const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET;

// ============ CONSTANTS ============
const DAILY_REWARD_AMOUNT = 10;
const XP_PER_KILL = 10;
const XP_PER_RANK = { 1: 100, 2: 75, 3: 50, 4: 30, 5: 25, 6: 20, 7: 15, 8: 10, 9: 5, 10: 2 };

// ============ EXPRESS SETUP ============
const app = express();
app.use(cors());
app.use(express.json());

// ============ AUTH MIDDLEWARE ============
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing auth token' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.userEmail = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token', error: e.message });
  }
}

// ============ CASHFREE HELPERS ============
async function getCashfreeToken() {
  const res = await fetch(`${CASHFREE_API}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': '2023-08-01',
      'x-client-id': CASHFREE_CLIENT_ID,
      'x-client-secret': CASHFREE_CLIENT_SECRET
    },
    body: JSON.stringify({ order_amount: 1, order_currency: 'INR' })
  });
  return res.headers.get('x-cf-signature') || '';
}

function verifyCashfreeWebhook(body, signature, timestamp) {
  if (!CASHFREE_WEBHOOK_SECRET) return true; // Skip in dev
  const payload = timestamp + JSON.stringify(body);
  const expected = crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET).update(payload).digest('base64');
  return expected === signature;
}

// ============ USER HELPERS ============
async function getUserRef(uid) {
  return db.collection('users').doc(uid);
}

async function getUserData(uid) {
  const doc = await getUserRef(uid).get();
  return doc.exists ? doc.data() : null;
}

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateTransactionId() {
  return `txn_${crypto.randomBytes(8).toString('hex')}`;
}

// ============ VALIDATION ============
function validateAmount(amount, min = 1) {
  const n = parseInt(amount);
  return !isNaN(n) && n >= min && n <= 100000 ? n : null;
}

function validateUpiId(upiId) {
  return /^[a-zA-Z0-9.\-_]{3,}@[a-zA-Z]{3,}$/.test(upiId) ? upiId : null;
}

// ============ ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ============ AUTH ============
app.post('/api/auth/signup', authMiddleware, async (req, res) => {
  try {
    const { uid } = req;
    const { username, email, referralCode } = req.body;
    
    if (!username || typeof username !== 'string' || username.length < 3) {
      return res.status(400).json({ message: 'Username required (min 3 chars)' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ message: 'Valid email required' });
    }

    const userRef = await getUserRef(uid);
    const existing = await userRef.get();
    
    if (existing.exists) {
      return res.status(409).json({ message: 'User already exists', user: existing.data() });
    }

    const userCode = generateReferralCode();
    let referredBy = null;

    // Handle referral
    if (referralCode && typeof referralCode === 'string') {
      const refSnapshot = await db.collection('users').where('referralCode', '==', referralCode.toUpperCase()).limit(1).get();
      if (!refSnapshot.empty) {
        referredBy = refSnapshot.docs[0].id;
        // Reward referrer
        await db.runTransaction(async (t) => {
          const refRef = db.collection('users').doc(referredBy);
          const refDoc = await t.get(refRef);
          if (refDoc.exists) {
            t.update(refRef, { 
              balance: (refDoc.data().balance || 0) + 5,
              referralCount: (refDoc.data().referralCount || 0) + 1
            });
            t.create(refRef.collection('transactions').doc(generateTransactionId()), {
              type: 'referral_bonus',
              amount: 5,
              description: `Referral bonus for ${username}`,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              balanceAfter: (refDoc.data().balance || 0) + 5
            });
          }
        });
      }
    }

    const userData = {
      uid,
      username,
      email,
      referralCode: userCode,
      referredBy: referredBy || null,
      balance: 0,
      lockedBalance: 0,
      matchesPlayed: 0,
      totalKills: 0,
      dailyStreak: 0,
      lastDailyReward: null,
      isVIP: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await userRef.set(userData);
    return res.status(201).json({ message: 'User created', user: { uid, username, email, referralCode: userCode } });
  } catch (e) {
    return res.status(500).json({ message: 'Signup failed', error: e.message });
  }
});

// ============ WALLET ============
app.post('/api/wallet/createOrder', authMiddleware, async (req, res) => {
  try {
    const { uid } = req;
    const amount = validateAmount(req.body.amount, 10);
    if (!amount) return res.status(400).json({ message: 'Invalid amount (min ₹10)' });

    const orderId = `order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const txnId = generateTransactionId();

    // Create Cashfree order
    const orderPayload = {
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: uid,
        customer_email: req.userEmail || `${uid}@user.com`,
        customer_phone: '9999999999'
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL || 'https://prixmi.vercel.app'}/payment/status?order_id=${orderId}`
      }
    };

    const cfRes = await fetch(`${CASHFREE_API}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': CASHFREE_CLIENT_ID,
        'x-client-secret': CASHFREE_CLIENT_SECRET
      },
      body: JSON.stringify(orderPayload)
    });

    const cfData = await cfRes.json();

    if (!cfRes.ok) {
      return res.status(400).json({ message: 'Order creation failed', error: cfData });
    }

    // Store transaction as PENDING
    await db.collection('transactions').doc(txnId).set({
      userId: uid,
      type: 'deposit',
      amount,
      status: 'PENDING',
      orderId,
      description: `Deposit ₹${amount}`,
      cashfreeOrderId: cfData.order_id,
      paymentSessionId: cfData.payment_session_id,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      payment_session_id: cfData.payment_session_id,
      order_id: cfData.order_id,
      amount
    });
  } catch (e) {
    return res.status(500).json({ message: 'Order creation failed', error: e.message });
  }
});

// ============ WEBHOOK (CRITICAL) ============
app.post('/api/webhook/cashfree', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'] || '';
    const timestamp = req.headers['x-webhook-timestamp'] || '';
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Verify webhook
    if (!verifyCashfreeWebhook(body, signature, timestamp)) {
      return res.status(403).json({ message: 'Invalid webhook signature' });
    }

    const { data } = body;
    if (!data || !data.order) {
      return res.status(400).json({ message: 'Invalid webhook data' });
    }

    const orderId = data.order.order_id;
    const orderAmount = parseFloat(data.order.order_amount);
    const paymentStatus = data.order.order_status;

    // Find our transaction
    const txnSnapshot = await db.collection('transactions').where('orderId', '==', orderId).limit(1).get();
    
    if (txnSnapshot.empty) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const txnDoc = txnSnapshot.docs[0];
    const txnData = txnDoc.data();

    // IDEMPOTENCY: If already processed, return success
    if (txnData.status !== 'PENDING') {
      return res.json({ message: 'Already processed' });
    }

    const userId = txnData.userId;
    const amount = txnData.amount;
    const userRef = db.collection('users').doc(userId);

    if (paymentStatus === 'PAID') {
      // Verify amount matches
      if (Math.abs(orderAmount - amount) > 1) {
        // Amount mismatch, mark as suspicious
        await txnDoc.ref.update({ status: 'SUSPICIOUS', webhookAmount: orderAmount });
        return res.status(400).json({ message: 'Amount mismatch' });
      }

      // CREDIT WALLET (only place)
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw new Error('User not found');

        const currentBalance = userDoc.data().balance || 0;
        const newBalance = currentBalance + amount;

        // Update transaction
        t.update(txnDoc.ref, {
          status: 'SUCCESS',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          webhookTimestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Update wallet
        t.update(userRef, {
          balance: newBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Log successful transaction
        const receiptId = generateTransactionId();
        t.create(userRef.collection('transactions').doc(receiptId), {
          type: 'deposit_success',
          amount,
          orderId,
          description: `Deposit ₹${amount}`,
          status: 'SUCCESS',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          balanceAfter: newBalance
        });
      });

      return res.json({ message: 'Payment credited successfully' });
    } else if (paymentStatus === 'FAILED') {
      await txnDoc.ref.update({
        status: 'FAILED',
        webhookTimestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ message: 'Payment marked as failed' });
    }

    return res.json({ message: 'Webhook processed' });
  } catch (e) {
    return res.status(500).json({ message: 'Webhook error', error: e.message });
  }
});

// ============ MATCH JOIN ============
app.post('/api/match/join', authMiddleware, async (req, res) => {
  try {
    const { uid } = req;
    const { matchId, gameUids } = req.body;

    if (!matchId || typeof matchId !== 'string') {
      return res.status(400).json({ message: 'matchId required' });
    }
    if (!Array.isArray(gameUids) || gameUids.length < 1 || gameUids.length > 4) {
      return res.status(400).json({ message: 'gameUids must be 1-4 players' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    const userRef = db.collection('users').doc(uid);
    const teamRef = matchRef.collection('teams').doc(uid);

    await db.runTransaction(async (t) => {
      // Check match
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error('Match not found');
      
      const match = matchDoc.data();
      if (match.status !== 'upcoming') throw new Error('Match not upcoming');
      if (match.joinedCount >= match.maxPlayers) throw new Error('Match full');

      // Check user balance
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      
      const balance = userDoc.data().balance || 0;
      if (balance < match.entryFee) throw new Error('Insufficient balance');

      // Check not already joined
      const existingTeam = await t.get(teamRef);
      if (existingTeam.exists) throw new Error('Already joined this match');

      // Check gameUids not used elsewhere in this match
      const allTeams = await t.get(matchRef.collection('teams'));
      const usedUids = new Set();
      allTeams.forEach(doc => {
        (doc.data().gameUids || []).forEach(gid => usedUids.add(gid));
      });

      for (const gid of gameUids) {
        if (usedUids.has(gid)) throw new Error(`gameUid ${gid} already in another team`);
      }

      // Deduct balance & join
      const newBalance = balance - match.entryFee;
      t.update(userRef, { balance: newBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      t.update(matchRef, { joinedCount: (match.joinedCount || 0) + 1 });

      t.create(teamRef, {
        ownerUid: uid,
        ownerUsername: userDoc.data().username || 'Player',
        gameUids,
        joinedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Transaction log
      const txnId = generateTransactionId();
      t.create(db.collection('transactions').doc(txnId), {
        userId: uid,
        type: 'entry_fee',
        amount: match.entryFee,
        matchId,
        description: `Joined match ${matchId}`,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: newBalance
      });
    });

    return res.json({ message: 'Joined match successfully' });
  } catch (e) {
    const msg = e.message || 'Join failed';
    const code = ['Match not found','Match not upcoming','Match full','Insufficient balance','Already joined'].includes(msg) ? 400 : 500;
    return res.status(code).json({ message: msg });
  }
});

// ============ DAILY REWARD ============
app.post('/api/rewards/daily', authMiddleware, async (req, res) => {
  try {
    const { uid } = req;
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');

      const user = userDoc.data();
      const now = Date.now();
      const lastReward = user.lastDailyReward ? user.lastDailyReward.toDate().getTime() : 0;
      const hoursSince = (now - lastReward) / (1000 * 60 * 60);

      if (hoursSince < 24) {
        throw new Error(`Wait ${Math.ceil(24 - hoursSince)} hours for next reward`);
      }

      const newStreak = hoursSince < 48 ? (user.dailyStreak || 0) + 1 : 1;
      const rewardAmount = DAILY_REWARD_AMOUNT + Math.floor(newStreak / 7) * 5; // Bonus for streak
      const newBalance = (user.balance || 0) + rewardAmount;

      t.update(userRef, {
        balance: newBalance,
        dailyStreak: newStreak,
        lastDailyReward: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const txnId = generateTransactionId();
      t.create(db.collection('transactions').doc(txnId), {
        userId: uid,
        type: 'daily_reward',
        amount: rewardAmount,
        description: `Daily reward (Day ${newStreak})`,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: newBalance
      });
    });

    return res.json({ message: 'Daily reward claimed', streak: true });
  } catch (e) {
    if (e.message.includes('Wait')) {
      return res.status(429).json({ message: e.message });
    }
    return res.status(500).json({ message: 'Reward failed', error: e.message });
  }
});

// ============ WITHDRAW ============
app.post('/api/wallet/withdraw', authMiddleware, async (req, res) => {
  try {
    const { uid } = req;
    const amount = validateAmount(req.body.amount, 50);
    const upiId = validateUpiId(req.body.upiId);

    if (!amount) return res.status(400).json({ message: 'Min ₹50 withdrawal' });
    if (!upiId) return res.status(400).json({ message: 'Valid UPI ID required' });

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');

      const balance = userDoc.data().balance || 0;
      if (balance < amount) throw new Error('Insufficient balance');

      const newBalance = balance - amount;
      t.update(userRef, {
        balance: newBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const txnId = generateTransactionId();
      t.create(db.collection('transactions').doc(txnId), {
        userId: uid,
        type: 'withdrawal',
        amount,
        upiId,
        status: 'PENDING',
        description: `Withdrawal ₹${amount} to ${upiId}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: newBalance
      });
    });

    return res.json({ message: 'Withdrawal request submitted for admin approval' });
  } catch (e) {
    const msg = e.message;
    const code = msg === 'Insufficient balance' ? 400 : 500;
    return res.status(code).json({ message: msg });
  }
});

// ============ ADMIN: DISTRIBUTE PRIZES ============
app.post('/api/admin/match/distribute', authMiddleware, async (req, res) => {
  try {
    const { uid } = req;
    const { matchId, gameUid, rank, kills } = req.body;

    // Check admin (simple: check if user has admin flag)
    const adminUser = await getUserData(uid);
    if (!adminUser || !adminUser.isAdmin) {
      return res.status(403).json({ message: 'Admin only' });
    }

    if (!matchId || !gameUid || !rank || typeof kills !== 'number') {
      return res.status(400).json({ message: 'matchId, gameUid, rank, kills required' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    const matchDoc = await matchRef.get();
    if (!matchDoc.exists) return res.status(404).json({ message: 'Match not found' });

    const match = matchDoc.data();
    if (match.prizeDistributed) return res.status(400).json({ message: 'Prize already distributed' });

    // Find team containing this gameUid
    const teamsSnap = await matchRef.collection('teams').get();
    let targetTeam = null;
    let ownerUid = null;

    teamsSnap.forEach(doc => {
      const team = doc.data();
      if (team.gameUids && team.gameUids.includes(gameUid)) {
        targetTeam = doc.data();
        ownerUid = team.ownerUid;
      }
    });

    if (!targetTeam || !ownerUid) return res.status(404).json({ message: 'Team not found for gameUid' });

    // Calculate prize
    const perKillRate = match.perKillRate || 5;
    const rankPrizes = match.rankPrizes || {};
    const rankPrize = rankPrizes[rank] || 0;
    const prizeAmount = (kills * perKillRate) + rankPrize;
    const xpAmount = (kills * XP_PER_KILL) + (XP_PER_RANK[rank] || 0);

    const ownerRef = db.collection('users').doc(ownerUid);

    await db.runTransaction(async (t) => {
      const ownerDoc = await t.get(ownerRef);
      if (!ownerDoc.exists) throw new Error('Owner not found');

      const balance = ownerDoc.data().balance || 0;
      const newBalance = balance + prizeAmount;
      const newKills = (ownerDoc.data().totalKills || 0) + kills;
      const newMatches = (ownerDoc.data().matchesPlayed || 0) + 1;

      t.update(ownerRef, {
        balance: newBalance,
        totalKills: newKills,
        matchesPlayed: newMatches,
        xp: (ownerDoc.data().xp || 0) + xpAmount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Prize transaction
      const txnId = generateTransactionId();
      t.create(db.collection('transactions').doc(txnId), {
        userId: ownerUid,
        type: 'prize',
        amount: prizeAmount,
        xp: xpAmount,
        matchId,
        rank,
        kills,
        description: `Prize for rank #${rank} in match ${matchId}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        balanceAfter: newBalance
      });

      // Mark team as paid
      t.update(matchRef.collection('teams').doc(ownerUid), {
        prizeDistributed: true,
        rank,
        kills,
        prizeAmount,
        xpAmount
      });
    });

    return res.json({ message: 'Prize distributed', prizeAmount, xpAmount, ownerUid });
  } catch (e) {
    return res.status(500).json({ message: 'Distribution failed', error: e.message });
  }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Prixmi Backend running on port ${PORT}`);
});

module.exports = app;
