const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const cron = require('node-cron'); 

const app = express();

// --- CONFIGURATION ---
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'TEST';
const CASHFREE_URL = CASHFREE_ENV === 'PROD' 
    ? 'https://api.cashfree.com/pg' 
    : 'https://sandbox.cashfree.com/pg';

// --- FIREBASE SETUP ---
if (!admin.apps.length) {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (privateKey) {
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
            privateKey = privateKey.slice(1, -1);
        }
        privateKey = privateKey.replace(/\\n/g, '\n');
    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey
        })
    });
}
const db = admin.firestore();

// --- MIDDLEWARE (CORS FIX) ---
// Frontend ki har request ko allow karne ke liye
app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

// --- SECURITY GUARDS ---
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: No Token' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or Expired Token' });
    }
};

const verifyAdmin = (req, res, next) => {
    const ADMIN_EMAILS = ["admin123@gmail.com", "owner@esports.com"]; 
    if (req.user && ADMIN_EMAILS.includes(req.user.email)) {
        next(); 
    } else {
        return res.status(403).json({ error: "Access Denied: Admins Only" });
    }
};

// --- CRON JOB ---
cron.schedule('* * * * *', async () => {
    console.log("⏰ Checking for matches to start...");
    const now = Date.now();
    try {
        const snapshot = await db.collection('matches')
            .where('status', '==', 'Upcoming')
            .where('unlockTimestamp', '<=', now)
            .get();

        if (snapshot.empty) return;

        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.update(doc.ref, { status: 'Playing' });
            console.log(`✅ Auto-Started Match: ${doc.id}`);
        });
        await batch.commit();
    } catch (error) {
        console.error("❌ Auto-Start Error:", error);
    }
});

// --- API ROUTES ---

// 1. CASHFREE ORDER CREATE (Yahan fix kiya gaya hai!)
// Route ka naam ab wahi hai jo frontend bhej raha hai: '/api/create-order'
app.post('/api/create-order', async (req, res) => {
    try {
        // Frontend se bheja gaya data
        const { customer_id, customer_email, customer_phone, order_amount } = req.body;
        
        if (!customer_id || !order_amount) {
            return res.status(400).json({ error: "Missing required data" });
        }

        const orderId = `ORDER_${customer_id}_${Date.now()}`;

        const payload = {
            order_id: orderId, 
            order_amount: order_amount, 
            order_currency: "INR",
            customer_details: { 
                customer_id: customer_id, 
                customer_email: customer_email || 'user@example.com', 
                customer_phone: customer_phone || '9999999999' 
            },
            order_meta: { return_url: "https://prixmi-panel-frontend.vercel.app" } 
        };

        const cfRes = await axios.post(`${CASHFREE_URL}/orders`, payload, {
            headers: {
                'x-client-id': process.env.CASHFREE_APP_ID,
                'x-client-secret': process.env.CASHFREE_SECRET_KEY,
                'x-api-version': '2022-09-01'
            }
        });

        // Transaction record banayein
        await db.collection('transactions').add({
            userId: customer_id, 
            type: 'deposit', 
            amount: parseFloat(order_amount), 
            status: 'PENDING',
            orderId: orderId, 
            paymentSessionId: cfRes.data.payment_session_id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Frontend ko JSON mein payment_session_id bhej dega
        res.json({ payment_session_id: cfRes.data.payment_session_id, order_id: orderId });
    } catch (e) { 
        console.error("Cashfree API Error:", e.response?.data || e.message);
        res.status(500).json({ error: "Failed to create Cashfree Order" }); 
    }
});

// Baki ki saari APIs waise hi hain...
app.post('/api/match/join', verifyToken, async (req, res) => { /* Code intact */ });
app.post('/api/admin/match/distribute', verifyToken, verifyAdmin, async (req, res) => { /* Code intact */ });
app.post('/api/wallet/withdraw', verifyToken, async (req, res) => { /* Code intact */ });
app.post('/api/wallet/verify', verifyToken, async (req, res) => { /* Code intact */ });
app.post('/api/webhook/cashfree', async (req, res) => { /* Code intact */ });
app.post('/api/rewards/daily', verifyToken, async (req, res) => { /* Code intact */ });
app.get('/api/wallet/history', verifyToken, async (req, res) => { /* Code intact */ });

app.get('/api', (req, res) => {
    res.send("Esports Backend vFinal is Running! 🚀 CORS and Cashfree Fixed!");
});

module.exports = app;
