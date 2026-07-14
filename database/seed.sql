-- database/seed.sql
-- Data awal merchant global (Indomaret, Alfamart, PLN).
-- CATATAN: nomor rekening/VA di bawah adalah placeholder demo —
-- ganti dengan data resmi hasil kerja sama sebelum go-live.

INSERT INTO merchants (merchant_id, scope, owner_uid, name, category, payment_code, bank_name, account_number, account_holder_name)
VALUES
  ('global_indomaret', 'global', NULL, 'Indomaret',        'Retail',   'virtual_account', 'BRI',     '777081234567890', 'PT Indomarco Prismatama'),
  ('global_alfamart',  'global', NULL, 'Alfamart',         'Retail',   'virtual_account', 'Permata', '888091234567890', 'PT Sumber Alfaria Trijaya'),
  ('global_pln',       'global', NULL, 'PLN (Token Listrik)', 'Utilitas','virtual_account','BNI',     '888888012345678', 'PT PLN (Persero)')
ON CONFLICT (merchant_id) DO NOTHING;
