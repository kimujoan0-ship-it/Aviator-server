require('dotenv').config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE CONNECTION
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ Connected to Railway PostgreSQL"))
  .catch(err => console.error("❌ DB Connection error", err.stack));

/* =========================
   RECEIPTS (JSON - OPTION A)
========================= */

const receiptsFile = path.join(__dirname, "receipts.json");

function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}

function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

/* =========================
   AUTH ROUTES
========================= */

app.get('/', (req, res) => {
  res.send('Unified Server Running');
});

app.post('/signup', async (req, res) => {
  const { username, phone, pin, referralCode } = req.body;
  try {
    const checkUser = await pool.query(
      'SELECT * FROM users WHERE phone = $1 OR username = $2',
      [phone, username]
    );

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username or Phone number already in use' });
    }

    await pool.query(
      'INSERT INTO users (username, phone, pin, balance, referral_code) VALUES ($1, $2, $3, 0, $4)',
      [username, phone, pin, referralCode || null]
    );

    res.json({ success: true, message: 'Signup successful' });

  } catch (err) {
    res.status(500).json({ error: 'Server error during signup' });
  }
});

app.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
  try {
    const user = await pool.query(
      'SELECT username, phone, balance FROM users WHERE phone = $1 AND pin = $2',
      [phone, pin]
    );

    if (user.rows.length > 0) {
      res.json({ success: true, user: user.rows[0] });
    } else {
      res.status(401).json({ error: 'Invalid phone or PIN' });
    }

  } catch (err) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

app.post('/refresh-balance', async (req, res) => {
  const { phone } = req.body;
  try {
    const user = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [phone]
    );

    if (user.rows.length > 0) {
      res.json({ success: true, balance: user.rows[0].balance });
    } else {
      res.status(404).json({ error: 'User not found' });
    }

  } catch (err) {
    res.status(500).json({ error: 'Server error fetching balance' });
  }
});

/* =========================
   BETTING & CASH OUT
========================= */

app.post('/bet', async (req, res) => {
  const { phone, amount } = req.body;
  try {
    const user = await pool.query('SELECT balance FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    let currentBalance = parseFloat(user.rows[0].balance);
    let betAmount = parseFloat(amount);
    
    if (currentBalance < betAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await pool.query('UPDATE users SET balance = balance - $1 WHERE phone = $2', [betAmount, phone]);
    await pool.query('INSERT INTO bets (phone, amount, status) VALUES ($1, $2, $3)', [phone, betAmount, 'placed']);
    
    res.json({ success: true, balance: currentBalance - betAmount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error placing bet' });
  }
});

app.post('/cashout', async (req, res) => {
  const { phone, amount, multiplier } = req.body;
  try {
    let winAmount = parseFloat(amount);
    let mult = parseFloat(multiplier);
    
    await pool.query('UPDATE users SET balance = balance + $1 WHERE phone = $2', [winAmount, phone]);
    await pool.query('INSERT INTO bets (phone, amount, multiplier, status) VALUES ($1, $2, $3, $4)', [phone, winAmount, mult, 'cashed_out']);
    
    const user = await pool.query('SELECT balance FROM users WHERE phone = $1', [phone]);
    res.json({ success: true, balance: parseFloat(user.rows[0].balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error cashing out' });
  }
});

/* =========================
   ADMIN DASHBOARD
========================= */

app.get('/admin/stats', async (req, res) => {
  const password = req.headers['authorization'];
  if (password !== '3462Abel@#') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const totalBalance = await pool.query('SELECT SUM(balance) FROM users');
    const totalBets = await pool.query('SELECT COUNT(*) FROM bets');
    
    res.json({ 
      success: true, 
      users: parseInt(totalUsers.rows[0].count),
      balance: parseFloat(totalBalance.rows[0].sum || 0),
      bets: parseInt(totalBets.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching stats' });
  }
});

/* =========================
   STK PAYMENT ROUTES
========================= */

app.post("/pay", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });

    if (!amount || amount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Customer",
      callback_url: process.env.BASE_URL + "/callback",
      channel_id: "000603"
    };

    const resp = await axios.post(
      "https://swiftwallet.co.ke/v3/stk-initiate/",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.SWIFTWALLET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (resp.data.success) {
      const receiptData = {
        reference,
        amount: Math.round(amount),
        phone: formattedPhone,
        status: "pending",
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({ success: true, reference });

    } else {
      res.status(400).json({
        success: false,
        error: resp.data.error || "Failed to initiate payment"
      });
    }

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || "Server error"
    });
  }
});

app.post("/callback", async (req, res) => {
  const data = req.body;
  const ref = data.external_reference;

  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};
  const resultCode = data.result?.ResultCode;

  if (resultCode === 0) {

    receipts[ref] = {
      ...existingReceipt,
      status: "success",
      transaction_code: data.result?.MpesaReceiptNumber || null,
      amount: data.result?.Amount || existingReceipt.amount,
      phone: data.result?.Phone || existingReceipt.phone,
      timestamp: new Date().toISOString()
    };

    writeReceipts(receipts);

    // ✅ DIRECT DATABASE UPDATE (NO HTTP CALL)
    try {
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE phone = $2',
        [receipts[ref].amount, receipts[ref].phone]
      );
      console.log("✅ Balance updated in PostgreSQL");
    } catch (err) {
      console.error("❌ DB update failed:", err.message);
    }

  } else {
    receipts[ref] = {
      ...existingReceipt,
      status: "failed",
      timestamp: new Date().toISOString()
    };
    writeReceipts(receipts);
  }

  res.json({ ResultCode: 0, ResultDesc: "Callback received" });
});

/* =========================
   RECEIPT ROUTES
========================= */

app.get("/receipt/:reference", (req, res) => {
  const { reference } = req.params;
  const receipts = readReceipts();
  const receipt = receipts[reference];

  if (!receipt) {
    return res.status(404).json({ success: false, error: "Receipt not found" });
  }

  res.json({ success: true, receipt });
});

app.get("/receipt/:reference/pdf", (req, res) => {
  const { reference } = req.params;
  const receipts = readReceipts();
  const receipt = receipts[reference];

  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found" });
  }

  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${reference}.pdf`);
  doc.pipe(res);

  doc.fontSize(18).text("Payment Receipt", { align: "center" });
  doc.moveDown();
  doc.text(`Reference: ${receipt.reference}`);
  doc.text(`Phone: ${receipt.phone}`);
  doc.text(`Amount: KES ${receipt.amount}`);
  doc.text(`Status: ${receipt.status}`);
  doc.text(`Transaction Code: ${receipt.transaction_code || "N/A"}`);
  doc.text(`Date: ${receipt.timestamp}`);

  doc.end();
});

app.listen(PORT, () => {
  console.log(`🚀 Unified Server running on port ${PORT}`);
});
