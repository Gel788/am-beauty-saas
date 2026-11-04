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

/** Someone on the platform team: a person, not tied to any salon. */
export type PlatformActor = Pick<Actor, "userId" | "name" | "email">;

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
  reminder_enabled: boolean;
  reminder_hours: number;
  quiet_start_min: number;
  quiet_end_min: number;
  accrue_on_complete_unpaid: boolean;
  consume_policy: "warn" | "block";
  allow_negative_stock: boolean;
  fiscal_enabled: boolean;
  fiscal_provider: string;
  fiscal_inn: string;
  fiscal_taxation: string;
  fiscal_vat: string;
  fiscal_place: string;
  acquiring_enabled: boolean;
  online_deposit_bps: number;
  online_deposit_minutes: number;
  acquiring_provider: string;
  acquiring_link_hours: number;
  external_receipts: boolean;
  booking_message_enabled: boolean;
  review_enabled: boolean;
  review_delay_hours: number;
  review_moderation: boolean;
  noshow_block_after: number;
  rebook_enabled: boolean;
  birthday_enabled: boolean;
  /** Present only when the query joins tenants. */
  tenant_slug?: string;
};
