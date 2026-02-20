
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

/* =======================
   MIDDLEWARE
======================= */
app.use(bodyParser.json());
app.use(express.json());
app.use(cors({ origin: "*" })); // Accept all origins (testing)

app.get("/", (req, res) => {
  res.send("Merged Server Running Successfully");
});

/* =======================
   DATABASE (Railway PostgreSQL)
======================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("Connected to Railway PostgreSQL"))
  .catch(err => console.error("Database connection error:", err.stack));

/* =======================
   RECEIPT STORAGE (JSON)
======================= */
const receiptsFile = path.join(__dirname, "receipts.json");

function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}

function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

/* =======================
   PHONE FORMATTER (FORCE 254 FORMAT)
======================= */
function formatPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

/* =======================
   AUTH ENDPOINTS
======================= */

// Signup
app.post('/signup', async (req, res) => {
  const { username, phone, pin, referralCode } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    return res.status(400).json({ error: 'Invalid phone format' });
  }

  try {
    const checkUser = await pool.query(
      'SELECT * FROM users WHERE phone = $1 OR username = $2',
      [formattedPhone, username]
    );

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username or Phone already in use' });
    }

    await pool.query(
      'INSERT INTO users (username, phone, pin, balance, referral_code) VALUES ($1,$2,$3,0,$4)',
      [username, formattedPhone, pin, referralCode || null]
    );

    res.json({ success: true, message: 'Signup successful' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Signup server error' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { phone, pin } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    return res.status(400).json({ error: 'Invalid phone format' });
  }

  try {
    const user = await pool.query(
      'SELECT username, phone, balance FROM users WHERE phone=$1 AND pin=$2',
      [formattedPhone, pin]
    );

    if (user.rows.length > 0) {
      res.json({ success: true, user: user.rows[0] });
    } else {
      res.status(401).json({ error: 'Invalid phone or PIN' });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login server error' });
  }
});

// Refresh Balance
app.post('/refresh-balance', async (req, res) => {
  const { phone } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    return res.status(400).json({ error: 'Invalid phone format' });
  }

  try {
    const user = await pool.query(
      'SELECT balance FROM users WHERE phone=$1',
      [formattedPhone]
    );

    if (user.rows.length > 0) {
      res.json({ success: true, balance: user.rows[0].balance });
    } else {
      res.status(404).json({ error: 'User not found' });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Balance fetch error' });
  }
});

/* =======================
   STK PUSH PAYMENT
======================= */

app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone)
      return res.status(400).json({ error: "Invalid phone format" });

    if (!amount || amount < 1)
      return res.status(400).json({ error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Customer",
      callback_url: process.env.CALLBACK_URL,
      channel_id: "000569"
    };

    const resp = await axios.post(
      "https://swiftwallet.co.ke/pay-app-v2/payments.php",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.SWIFT_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (resp.data.success) {

      const receiptData = {
        reference,
        transaction_id: resp.data.transaction_id || null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        status: "pending",
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({ success: true, reference, receipt: receiptData });

    } else {
      res.status(400).json({ error: "Failed to initiate STK push" });
    }

   } catch (err) {
  console.error("STK ERROR:", err.response?.status, err.response?.data || err.message);
  res.status(500).json({ error: "Payment initiation error" });
}
});

/* =======================
   CALLBACK
======================= */
app.post("/callback", async (req, res) => {

  const data = req.body;
  const ref = data.external_reference;

  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};

  const status = data.status?.toLowerCase();
  const resultCode = data.result?.ResultCode;

  if ((status === "completed" && data.success === true) || resultCode === 0) {

    const formattedPhone = formatPhone(data.result?.Phone);

    receipts[ref] = {
      ...existingReceipt,
      transaction_id: data.transaction_id,
      transaction_code: data.result?.MpesaReceiptNumber,
      status: "processing",
      timestamp: new Date().toISOString()
    };

    // Update user balance
    if (formattedPhone && data.result?.Amount) {
      await pool.query(
        "UPDATE users SET balance = balance + $1 WHERE phone=$2",
        [data.result.Amount, formattedPhone]
      );
    }

  } else {

    receipts[ref] = {
      ...existingReceipt,
      status: "cancelled",
      timestamp: new Date().toISOString()
    };
  }

  writeReceipts(receipts);

  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

/* =======================
   RECEIPT FETCH
======================= */
app.get("/receipt/:reference", (req, res) => {

  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];

  if (!receipt)
    return res.status(404).json({ error: "Receipt not found" });

  res.json({ success: true, receipt });
});

/* =======================
   START SERVER
======================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
      
