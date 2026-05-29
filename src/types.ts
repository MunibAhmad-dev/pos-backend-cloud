// ─── Shared TypeScript interfaces for the OsaTech POS Cloud Backend ───────────

export interface Instance {
  id: number;
  instance_id: string;        // mobile number (unique identifier)
  store_name: string;
  owner_name: string;
  owner_mobile: string;
  owner_email: string;
  store_address: string;
  business_name: string;
  api_key: string;            // UUID — sent as Bearer token by POS
  license_key: string;
  license_plan: 'none' | 'weekly' | 'monthly' | 'yearly' | 'lifetime' | 'custom';
  license_expiry: string | null;
  approval_status: 'pending' | 'approved' | 'blocked';
  block_reason: string;
  last_seen: string | null;
  app_version: string;
  total_sales: number;
  total_revenue: number;
  total_customers: number;
  total_products: number;
  device_fingerprint: string;
  license_revoked: number;     // 1 = revoked, POS should clear local license on next poll
  created_at: string;
  updated_at: string;
}

export interface AdminUser {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
}

export interface LicenseKey {
  id: number;
  license_key: string;
  instance_id: string | null;
  plan: string;
  duration_days: number;
  issued_at: string;
  expires_at: string | null;
  is_active: number;
  notes: string;
}

export interface SyncEvent {
  id: number;
  instance_id: string;
  entity_type: string;
  operation: string;
  payload: string;    // JSON string
  received_at: string;
}

export interface InstanceSale {
  id: number;
  instance_id: string;
  pos_sale_id: number;
  total: number;
  discount: number;
  payment_method: string;
  payment_status: string;
  status: string;
  items_count: number;
  items_summary: string;
  date_created: string | null;
  synced_at: string;
}

// ─── Request augmentations ───────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      admin?: { id: number; username: string; role: string };
      instance?: Instance;
    }
  }
}

export {};
