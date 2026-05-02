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

// 1. CASHFREE ORDER CREATE
app.post('/api/create-order', async (req, res) => {
    try {
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

        res.json({ payment_session_id: cfRes.data.payment_session_id, order_id: orderId });
    } catch (e) { 
        console.error("Cashfree API Error:", e.response?.data || e.message);
        res.status(500).json({ error: "Failed to create Cashfree Order" }); 
    }
});

// 2. CASHFREE ORDER VERIFICATION & BALANCE UPDATE (Naya Logic)
app.post('/api/verify-order', async (req, res) => {
    try {
        const { order_id } = req.body;
        if (!order_id) return res.status(400).json({ error: "Missing order_id" });

        // Cashfree API se exact order status fetch karo
        const cfRes = await axios.get(`${CASHFREE_URL}/orders/${order_id}`, {
            headers: {
                'x-client-id': process.env.CASHFREE_APP_ID,
                'x-client-secret': process.env.CASHFREE_SECRET_KEY,
                'x-api-version': '2022-09-01'
            }
        });

        const orderData = cfRes.data;

        // Check karo agar payment sach me PAID hai
        if (orderData.order_status === 'PAID') {
            
            // Firebase me transaction dhoondho
            const txnsRef = db.collection('transactions');
            const snapshot = await txnsRef.where('orderId', '==', order_id).get();

            if (snapshot.empty) {
                return res.status(404).json({ error: "Transaction record not found" });
            }

            const txnDoc = snapshot.docs[0];
            const txnData = txnDoc.data();

            // DOUBLE DEPOSIT GUARD: Agar pehle hi success ho chuka hai toh wapas add mat karo
            if (txnData.status === 'SUCCESS') {
                return res.json({ success: true, message: "Already verified and added" });
            }

            // Safely Update Transaction & User Wallet Balance
            const userId = txnData.userId;
            const amount = txnData.amount;

            const batch = db.batch();
            
            // Transaction ko SUCCESS mark karo
            batch.update(txnDoc.ref, { status: 'SUCCESS' });
            
            // User ke balance me amount add karo (Admin SDK ke through)
            const userRef = db.collection('users').doc(userId);
            batch.update(userRef, { balance: admin.firestore.FieldValue.increment(amount) });

            await batch.commit();

            return res.json({ success: true, message: "Payment Verified & Wallet Updated!" });
        } else {
            return res.status(400).json({ success: false, message: "Payment not complete yet", status: orderData.order_status });
        }

    } catch (error) {
        console.error("Verification Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Verification Failed internally" });
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
