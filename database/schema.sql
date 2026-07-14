-- database/schema.sql
-- Skema SQL untuk produksi (Vercel Postgres / Supabase / PlanetScale).
-- Saat ini store.js memakai file JSON; ganti implementasi store.js
-- mengacu tabel di bawah saat siap beralih ke database asli.

-- USERS
CREATE TABLE IF NOT EXISTS users (
  uid          TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  pi_address   TEXT,
  app_balance  NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PI PAYMENTS (Top Up — jalur resmi Pi Testnet)
CREATE TABLE IF NOT EXISTS pi_payments (
  payment_id   TEXT PRIMARY KEY,
  uid          TEXT NOT NULL REFERENCES users(uid),
  amount       NUMERIC(18,8) NOT NULL,
  memo         TEXT,
  txid         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | completed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- TRANSFI OFFRAMP ORDERS (Pi → IDR, dipicu setelah Top Up selesai)
CREATE TABLE IF NOT EXISTS transfi_orders (
  order_id          TEXT PRIMARY KEY,
  uid               TEXT NOT NULL REFERENCES users(uid),
  pi_payment_id     TEXT REFERENCES pi_payments(payment_id),
  deposit_amount    NUMERIC(18,8),
  deposit_currency  TEXT DEFAULT 'PI',
  withdraw_amount   NUMERIC(18,2),
  withdraw_currency TEXT DEFAULT 'IDR',
  status            TEXT NOT NULL DEFAULT 'initiated',
  error_message     TEXT,
  raw               JSONB,
  credited_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- MERCHANTS (Indomaret, Alfamart, merchant custom user)
CREATE TABLE IF NOT EXISTS merchants (
  merchant_id          TEXT PRIMARY KEY,
  scope                TEXT NOT NULL DEFAULT 'personal',  -- global | personal
  owner_uid            TEXT REFERENCES users(uid),
  name                 TEXT NOT NULL,
  category             TEXT DEFAULT 'Umum',
  payment_code         TEXT NOT NULL,   -- bank_transfer | virtual_account
  bank_name            TEXT NOT NULL,
  account_number       TEXT NOT NULL,
  account_holder_name  TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PAYOUTS (saldo Rupiah → rekening/VA merchant terdaftar)
CREATE TABLE IF NOT EXISTS payouts (
  payout_id    TEXT PRIMARY KEY,
  uid          TEXT NOT NULL REFERENCES users(uid),
  merchant_id  TEXT NOT NULL REFERENCES merchants(merchant_id),
  amount_idr   NUMERIC(18,2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | submitted | settled | failed
  transfi_ref  TEXT,
  error_message TEXT,
  raw          JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- WITHDRAWALS (saldo Rupiah → rekening bank pribadi user, dengan AML)
CREATE TABLE IF NOT EXISTS withdrawals (
  withdrawal_id        TEXT PRIMARY KEY,
  uid                  TEXT NOT NULL REFERENCES users(uid),
  amount_idr           NUMERIC(18,2) NOT NULL,
  bank_name            TEXT NOT NULL,
  account_number       TEXT NOT NULL,
  account_holder_name  TEXT NOT NULL,
  pi_account_name      TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  transfi_ref          TEXT,
  error_message        TEXT,
  raw                  JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- TRANSACTIONS (riwayat gabungan untuk tampilan history)
CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES users(uid),
  type        TEXT NOT NULL,   -- topup | merchant | withdraw | pi_completed
  name        TEXT,
  badge       TEXT,
  amount_pi   NUMERIC(18,8),
  amount_idr  NUMERIC(18,2),
  ref_id      TEXT,            -- payoutId / withdrawalId / orderId
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indeks untuk query umum
CREATE INDEX IF NOT EXISTS idx_pi_payments_uid       ON pi_payments(uid);
CREATE INDEX IF NOT EXISTS idx_transfi_orders_uid    ON transfi_orders(uid);
CREATE INDEX IF NOT EXISTS idx_transfi_orders_pi_pid ON transfi_orders(pi_payment_id);
CREATE INDEX IF NOT EXISTS idx_payouts_uid           ON payouts(uid);
CREATE INDEX IF NOT EXISTS idx_withdrawals_uid       ON withdrawals(uid);
CREATE INDEX IF NOT EXISTS idx_transactions_uid      ON transactions(uid);
