import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { AppError } from "@/domain/errors";
import { many, one, poolOne, withSession } from "./db";
import { isPlatformAdmin } from "./platform-admin";
import type { Actor, Ctx, PlatformActor, Role } from "./types";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function register(input: {
  email: string;
  password: string;
  name: string;
  salonName: string;
  branchName?: string;
  timezone?: string;
}) {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const salon = input.salonName.trim();
  if (!email.includes("@")) throw new AppError("VALIDATION", "Некорректный email");
  if (input.password.length < 6) throw new AppError("VALIDATION", "Пароль не короче 6 символов");
  if (!name || !salon) throw new AppError("VALIDATION", "Укажите имя и название салона");
  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(input.password, 8);
  await withSession({ tenantId, userId }, async (db) => {
    await db.query("INSERT INTO users (id, email, password_hash, name) VALUES ($1,$2,$3,$4)", [
      userId,
      email,
      passwordHash,
      name,
    ]);
    await db.query("INSERT INTO tenants (id, name) VALUES ($1,$2)", [tenantId, salon]);
    await db.query(
      "INSERT INTO branches (id, tenant_id, name, timezone) VALUES ($1,$2,$3,$4)",
      [branchId, tenantId, input.branchName?.trim() || "Основной филиал", input.timezone || "Europe/Moscow"],
    );
    await db.query(
      "INSERT INTO memberships (id, tenant_id, user_id, role, branch_id) VALUES ($1,$2,$3,'owner',NULL)",
      [crypto.randomUUID(), tenantId, userId],
    );
  });
  const token = await createSession(userId);
  const actor = await actorFromToken(token);
  return { token, actor: actor! };
}

export async function login(email_: string, password: string) {
  const user = await poolOne<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE email = $1",
    [email_.trim().toLowerCase()],
  );
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new AppError("VALIDATION", "Неверная почта или пароль");
  }
  const memberships = await withSession({ userId: user.id }, async (db) =>
    many(db, "SELECT id FROM memberships WHERE user_id = $1", [user.id]),
  );
  // PLAT-CABINET-05: the platform team signs in without a salon and lands in its own cabinet.
  const email = email_.trim().toLowerCase();
  const platform = isPlatformAdmin({ email });
  if (!memberships.length && !platform) throw new AppError("FORBIDDEN", "Нет доступа к салону");
  const token = await createSession(user.id);
  const actor = memberships.length ? await actorFromToken(token) : null;
  return { token, actor, platform };
}

/** The signed-in person if they are on the platform team (PLATFORM_ADMIN_EMAILS), salon or not. */
export async function platformUserFromToken(token: string | undefined | null): Promise<PlatformActor | null> {
  if (!token) return null;
  const user = await poolOne<{ id: string; name: string; email: string }>(
    "SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
    [sha256(token)],
  );
  if (!user || !isPlatformAdmin(user)) return null;
  return { userId: user.id, name: user.name, email: user.email };
}

export async function logout(token: string) {
  await poolOne("DELETE FROM sessions WHERE token_hash = $1 RETURNING id", [sha256(token)]);
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  await poolOne(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [crypto.randomUUID(), userId, sha256(token)],
  );
  return token;
}

export async function actorFromToken(token: string | undefined | null, tenantId?: string | null): Promise<Actor | null> {
  if (!token) return null;
  const session = await poolOne<{ user_id: string }>(
    "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
    [sha256(token)],
  );
  if (!session) return null;
  const user = await poolOne<{ id: string; name: string; email: string }>(
    "SELECT id, name, email FROM users WHERE id = $1",
    [session.user_id],
  );
  if (!user) return null;
  const memberships = await withSession({ userId: user.id }, async (db) =>
    many<{ tenant_id: string; role: Role; branch_id: string | null }>(
      db,
      "SELECT tenant_id, role, branch_id FROM memberships WHERE user_id = $1",
      [user.id],
    ),
  );
  const membership = memberships.find((item) => item.tenant_id === tenantId) ?? memberships[0];
  if (!membership) return null;
  const staff = await withSession({ tenantId: membership.tenant_id, userId: user.id }, async (db) =>
    one<{ id: string }>(db, "SELECT id FROM staff WHERE user_id = $1 LIMIT 1", [user.id]),
  );
  return {
    userId: user.id,
    tenantId: membership.tenant_id,
    role: membership.role,
    branchId: membership.branch_id,
    staffId: staff?.id ?? null,
    name: user.name,
    email: user.email,
  };
}

export async function asActor<T>(actor: Actor, fn: (ctx: Ctx) => Promise<T>, now = new Date()): Promise<T> {
  return withSession({ tenantId: actor.tenantId, userId: actor.userId }, (db) => fn({ db, actor, now }));
}

export async function setDensity(userId: string, density: "auto" | "comfortable" | "compact") {
  await poolOne(
    `INSERT INTO user_preferences (user_id, journal_density) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET journal_density = EXCLUDED.journal_density, updated_at = now()`,
    [userId, density],
  );
}

export async function getDensity(userId: string) {
  const row = await poolOne<{ journal_density: "auto" | "comfortable" | "compact" }>(
    "SELECT journal_density FROM user_preferences WHERE user_id = $1",
    [userId],
  );
  return row?.journal_density ?? "auto";
}
