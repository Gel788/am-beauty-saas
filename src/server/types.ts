import type { PoolClient } from "pg";

export type Role = "super" | "owner" | "admin" | "master" | "accountant" | "client";

export type Actor = {
  userId: string;
  tenantId: string;
  role: Role;
  branchId: string | null;
  staffId: string | null;
  name: string;
  email: string;
};

export type Ctx = {
  db: PoolClient;
  actor: Actor;
  now: Date;
  /** Set only by the public booking handler: the actor is the salon's online channel, not a user. */
  channel?: "online";
};

export type BranchRow = {
  id: string;
  tenant_id: string;
  name: string;
  address: string;
  timezone: string;
  currency: string;
  require_open_shift: boolean;
  owner_can_bypass_shift: boolean;
  master_sees_all_columns: boolean;
  master_can_create_own: boolean;
  master_can_drag_own: boolean;
  master_can_cancel_own_future: boolean;
  master_can_take_payment: boolean;
  arrival_window_hours: number;
  no_show_grace_min: number;
  grid_step_min: number;
  grid_label_min: number;
  require_payment_on_complete: boolean;
  shift_variance_threshold_minor: number;
  slug: string;
  online_enabled: boolean;
  online_step_min: number;
  online_min_notice_min: number;
  online_max_advance_days: number;
  online_hold_min: number;
  online_cancel_hours: number;
  online_max_active_per_phone: number;
  online_accent: string;
  online_logo_url: string | null;
  /** Present only when the query joins tenants. */
  tenant_slug?: string;
};
