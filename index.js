// index.js
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');

// Initialize Firebase Admin (Uses GOOGLE_APPLICATION_CREDENTIALS in env)
admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));

// Capture raw body for Cashfree webhook signature verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || 'YOUR_APP_ID';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'YOUR_SECRET_KEY';
const CASHFREE_API_URL = process.env.CASHFREE_API_URL || 'https://sandbox.cashfree.com/pg';

// ----------------------------------------------------------------------------
// MIDDLEWARE
// ----------------------------------------------------------------------------

const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
        }
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
    }
};

const requireAdmin = (req, res, next) => {
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
};

// ----------------------------------------------------------------------------
// AUTHENTICATION
// ----------------------------------------------------------------------------

app.post('/auth/signup', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const { username, email, referralCode } = req.body;

        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
            return res.status(200).json({ message: 'User already exists', user: userDoc.data() });
        }

        const newReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();

        const newUser = {
            uid,
            username,
            email,
            referralCode: newReferralCode,
            referredBy: referralCode || null,
            walletBalance: 0,
            xp: 0,
            matchesPlayed: 0,
            totalKills: 0,
            dailyStreak: 0,
            lastDailyReward: null,
            isVIP: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await userRef.set(newUser);
        res.status(201).json({ message: 'User created successfully', user: newUser });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ----------------------------------------------------------------------------
// MATCH JOIN
// ----------------------------------------------------------------------------

app.post('/match/join', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const { matchId, gameUids } = req.body;

        if (!matchId || !Array.isArray(gameUids) || gameUids.length === 0) {
            return res.status(400).json({ error: 'Invalid payload' });
        }

        const matchRef = db.collection('matches').doc(matchId);
        const userRef = db.collection('users').doc(uid);
        const teamsRef = matchRef.collection('teams');
        const userTeamRef = teamsRef.doc(uid);

        await db.runTransaction(async (t) => {
            const matchDoc = await t.get(matchRef);
            const userDoc = await t.get(userRef);

            if (!matchDoc.exists) throw new Error('Match not found');
            if (!userDoc.exists) throw new Error('User not found');

            const matchData = matchDoc.data();
            const userData = userDoc.data();

            if (matchData.status !== 'upcoming') throw new Error('Match is not upcoming');
            if (matchData.joinedCount >= matchData.maxPlayers) throw new Error('Match is full');
            if (userData.walletBalance < matchData.entryFee) throw new Error('Insufficient wallet balance');

            const existingTeamDoc = await t.get(userTeamRef);
            if (existingTeamDoc.exists) throw new Error('You have already joined this match');

            const allTeamsSnapshot = await t.get(teamsRef);
            const allTeams = allTeamsSnapshot.docs.map(doc => doc.data());
            
            for (const team of allTeams) {
                for (const gUid of gameUids) {
                    if (team.gameUids.includes(gUid)) {
                        throw new Error(`Duplicate entry: Game UID ${gUid} is already in another team`);
                    }
                }
            }

            t.update(userRef, { 
                walletBalance: admin.firestore.FieldValue.increment(-matchData.entryFee) 
            });
            
            t.update(matchRef, { 
                joinedCount: admin.firestore.FieldValue.increment(1) 
            });

            t.set(userTeamRef, {
                ownerUid: uid,
                ownerUsername: userData.username,
                gameUids,
                joinedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            const transactionRef = db.collection('transactions').doc();
            t.set(transactionRef, {
                userId: uid,
                type: 'DEBIT_ENTRY_FEE',
                amount: matchData.entryFee,
                status: 'SUCCESS',
                matchId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.status(200).json({ message: 'Successfully joined the match' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ----------------------------------------------------------------------------
// REWARDS
// ----------------------------------------------------------------------------

app.post('/rewards/daily', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const userRef = db.collection('users').doc(uid);

        const rewardAmount = 10; 
        const REWARD_COOLDOWN_MS = 24 * 60 * 60 * 1000; 

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error('User not found');
            
            const data = userDoc.data();
            const now = Date.now();
            const lastRewardTime = data.lastDailyReward ? data.lastDailyReward.toMillis() : 0;

            if (now - lastRewardTime < REWARD_COOLDOWN_MS) {
                throw new Error('Daily reward already claimed. Try again later.');
            }

            let newStreak = data.dailyStreak || 0;
            if (now - lastRewardTime > (REWARD_COOLDOWN_MS * 2)) {
                newStreak = 1; 
            } else {
                newStreak += 1; 
            }

            t.update(userRef, {
                walletBalance: admin.firestore.FieldValue.increment(rewardAmount),
                dailyStreak: newStreak,
                lastDailyReward: admin.firestore.FieldValue.serverTimestamp()
            });

            const transactionRef = db.collection('transactions').doc();
            t.set(transactionRef, {
                userId: uid,
                type: 'CREDIT_DAILY_REWARD',
                amount: rewardAmount,
                status: 'SUCCESS',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.status(200).json({ message: 'Daily reward claimed successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ----------------------------------------------------------------------------
// PAYMENT GATEWAY: CREATE ORDER
// ----------------------------------------------------------------------------

app.post('/wallet/createOrder', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const { amount } = req.body;

        if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

        const orderId = `ORDER_${uid}_${Date.now()}`;
        
        const cashfreePayload = {
            order_id: orderId,
            order_amount: amount,
            order_currency: 'INR',
            customer_details: {
                customer_id: uid,
                customer_email: userDoc.data().email || 'user@example.com',
                customer_phone: userDoc.data().phone || '9999999999'
            },
            order_meta: {
                return_url: `${process.env.FRONTEND_URL}/payment-status?order_id={order_id}`
            }
        };

        const response = await fetch(`${CASHFREE_API_URL}/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-client-id': CASHFREE_APP_ID,
                'x-client-secret': CASHFREE_SECRET_KEY,
                'x-api-version': '2023-08-01'
            },
            body: JSON.stringify(cashfreePayload)
        });

        const data = await response.json();
        
        if (!response.ok) throw new Error(data.message || 'Failed to create Cashfree order');

        const transactionRef = db.collection('transactions').doc(orderId);
        await transactionRef.set({
            userId: uid,
            type: 'ADD_FUNDS',
            amount: amount,
            status: 'PENDING',
            orderId: orderId,
            paymentSessionId: data.payment_session_id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ 
            orderId, 
            paymentSessionId: data.payment_session_id 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ----------------------------------------------------------------------------
// PAYMENT GATEWAY: WEBHOOK
// ----------------------------------------------------------------------------

app.post('/webhook/cashfree', async (req, res) => {
    try {
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];
        const rawBody = req.rawBody ? req.rawBody.toString() : '';

        const dataToSign = timestamp + rawBody;
        const expectedSignature = crypto
            .createHmac('sha256', CASHFREE_SECRET_KEY)
            .update(dataToSign)
            .digest('base64');

        if (signature !== expectedSignature) {
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        const payload = req.body;
        const { order_id, order_amount, tx_status } = payload.data.payment;

        const transactionRef = db.collection('transactions').doc(order_id);

        await db.runTransaction(async (t) => {
            const txDoc = await t.get(transactionRef);
            if (!txDoc.exists) return; 

            const txData = txDoc.data();
            if (txData.status !== 'PENDING') return; 

            if (tx_status === 'SUCCESS') {
                const userRef = db.collection('users').doc(txData.userId);
                t.update(userRef, {
                    walletBalance: admin.firestore.FieldValue.increment(order_amount)
                });
                t.update(transactionRef, { status: 'SUCCESS' });
            } else if (tx_status === 'FAILED') {
                t.update(transactionRef, { status: 'FAILED' });
            }
        });

        res.status(200).send('OK');
    } catch (error) {
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ----------------------------------------------------------------------------
// WITHDRAWAL
// ----------------------------------------------------------------------------

app.post('/wallet/withdraw', authenticate, async (req, res) => {
    try {
        const { uid } = req.user;
        const { amount, upiId } = req.body;

        if (!amount || amount <= 0 || !upiId) {
            return res.status(400).json({ error: 'Invalid withdrawal details' });
        }

        const userRef = db.collection('users').doc(uid);

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error('User not found');
            
            if (userDoc.data().walletBalance < amount) {
                throw new Error('Insufficient wallet balance');
            }

            t.update(userRef, {
                walletBalance: admin.firestore.FieldValue.increment(-amount)
            });

            const transactionRef = db.collection('transactions').doc();
            t.set(transactionRef, {
                userId: uid,
                type: 'WITHDRAWAL',
                amount: amount,
                upiId: upiId,
                status: 'PENDING',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.status(200).json({ message: 'Withdrawal request submitted successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ----------------------------------------------------------------------------
// ADMIN: DISTRIBUTE REWARDS
// ----------------------------------------------------------------------------

app.post('/admin/match/distribute', requireAdmin, async (req, res) => {
    try {
        const { matchId, gameUid, rank, kills } = req.body;

        if (!matchId || !gameUid || typeof rank !== 'number' || typeof kills !== 'number') {
            return res.status(400).json({ error: 'Invalid payload' });
        }

        const matchRef = db.collection('matches').doc(matchId);
        
        await db.runTransaction(async (t) => {
            const matchDoc = await t.get(matchRef);
            if (!matchDoc.exists) throw new Error('Match not found');

            const matchData = matchDoc.data();
            if (matchData.prizeDistributed) throw new Error('Prizes already distributed for this match');

            const teamsSnapshot = await t.get(matchRef.collection('teams'));
            let targetTeam = null;

            teamsSnapshot.forEach(doc => {
                const team = doc.data();
                if (team.gameUids && team.gameUids.includes(gameUid)) {
                    targetTeam = team;
                }
            });

            if (!targetTeam) throw new Error('Team containing this gameUid not found');

            const ownerUid = targetTeam.ownerUid;
            const rankPrize = matchData.rankPrizes ? (matchData.rankPrizes[rank.toString()] || 0) : 0;
            const killPrize = kills * (matchData.perKillRate || 0);
            const totalPrize = rankPrize + killPrize;
            const xpGained = (kills * 50) + (rank <= 3 ? 500 : 100); 

            const userRef = db.collection('users').doc(ownerUid);
            
            t.update(userRef, {
                walletBalance: admin.firestore.FieldValue.increment(totalPrize),
                xp: admin.firestore.FieldValue.increment(xpGained),
                matchesPlayed: admin.firestore.FieldValue.increment(1),
                totalKills: admin.firestore.FieldValue.increment(kills)
            });

            const transactionRef = db.collection('transactions').doc();
            t.set(transactionRef, {
                userId: ownerUid,
                type: 'CREDIT_PRIZE',
                amount: totalPrize,
                status: 'SUCCESS',
                matchId,
                rank,
                kills,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            t.update(matchRef, { prizeDistributed: true });
        });

        res.status(200).json({ message: 'Prize distributed successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ----------------------------------------------------------------------------
// SERVER INIT
// ----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Esports Tournament Backend running on port ${PORT}`);
});
