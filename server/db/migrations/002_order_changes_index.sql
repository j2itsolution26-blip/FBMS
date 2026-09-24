-- Supports the polling feed (/api/public/changes) used where live SSE isn't available.
CREATE INDEX IF NOT EXISTS idx_orders_updated ON orders(updated_at);
