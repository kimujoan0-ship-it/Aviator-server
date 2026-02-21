require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
 app.get('/', (req, res) => {
  res.send('Server is running');
}); 

// Railway PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test DB Connection
pool.connect()
  .then(() => console.log('Connected to Railway PostgreSQL'))
  .catch(err => console.error('Connection error', err.stack));

// Signup Endpoint
app.post('/signup', async (req, res) => {
  const { username, phone, pin, referralCode } = req.body;
  try {
    const checkUser = await pool.query('SELECT * FROM users WHERE phone = $1 OR username = $2', [phone, username]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username or Phone number already in use' });
    }
    
    await pool.query('INSERT INTO users (username, phone, pin, balance, referral_code) VALUES ($1, $2, $3, 0, $4)', [username, phone, pin, referralCode || null]);
    res.json({ success: true, message: 'Signup successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// Login Endpoint
app.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
  try {
    const user = await pool.query('SELECT username, phone, balance FROM users WHERE phone = $1 AND pin = $2', [phone, pin]);
    if (user.rows.length > 0) {
      res.json({ success: true, user: user.rows[0] });
    } else {
      res.status(401).json({ error: 'Invalid phone or PIN' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Forgot Password
app.post('/forgot-password', async (req, res) => {
  const { username } = req.body;
  try {
    const user = await pool.query('SELECT pin FROM users WHERE username = $1', [username]);
    if (user.rows.length > 0) {
      res.json({ success: true, pin: user.rows[0].pin });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Refresh Balance Endpoint
app.post('/refresh-balance', async (req, res) => {
    const { phone } = req.body;
    try {
        const user = await pool.query('SELECT balance FROM users WHERE phone = $1', [phone]);
        if (user.rows.length > 0) {
            res.json({ success: true, balance: user.rows[0].balance });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error fetching balance' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
       
