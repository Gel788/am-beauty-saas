/** PLAT-SUPER-01: the platform team is the list of emails in PLATFORM_ADMIN_EMAILS. */
export function isPlatformAdmin(actor: { email: string }) {
  const list = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return list.includes(actor.email.toLowerCase());
}
