import { pool } from "@/server/db";
import { NextRequest, NextResponse } from "next/server";
import { isAppError } from "@/domain/errors";
import { actorFromToken, asActor, getDensity, login, logout, register, setDensity } from "@/server/auth";
import {
  cancelAppointment,
  changeStatus,
  createAppointment,
  exportAppointmentsCsv,
  getAppointment,
  getJournal,
  hardDeleteAppointment,
  moveAppointment,
  previousClient,
  resizeAppointment,
  restoreAppointment,
  searchAppointments,
  updateAppointment,
} from "@/server/appointments";
import { adjustBalance, clientHistory, createClient, deleteClient, getClient, listClients, updateClient } from "@/server/clients";
import {
  addException,
  copyExceptionsToNextWeek,
  createCategory,
  createService,
  createStaff,
  deactivateService,
  deactivateStaff,
  deleteCategory,
  getWeekTemplate,
  listCatalog,
  listStaff,
  reorderServices,
  saveWeekTemplate,
  setServiceStaff,
  updateService,
  updateStaff,
} from "@/server/catalog";
import { createPayment, openShift } from "@/server/payments";
import {
  appointmentPayments,
  cancelClosing,
  closeShift,
  currentShift,
  listPayments,
  listShifts,
  refundPayment,
  shiftReport,
  startClosing,
  voidPayment,
} from "@/server/cash";
import { dashboard } from "@/server/dashboard";
import { dayReport } from "@/server/reports";
import { listMessages, runReminderJob } from "@/server/reminders";
import {
  addManualLine,
  approvePeriod,
  calculatePeriod,
  createPeriod,
  createRule,
  deleteRule,
  getPeriod,
  listPeriods,
  listRules,
  lockPeriod,
  payPeriod,
  removeManualLine,
  setPayrollExclusion,
  unapprovePeriod,
  updateRule,
} from "@/server/payroll";
import {
  createException,
  createScheduleRequest,
  decideScheduleRequest,
  deleteException,
  listExceptions,
  listScheduleRequests,
  readWeekTemplate,
} from "@/server/schedule";
import {
  adjustBonus,
  clientLoyalty,
  createPlan,
  createPromo,
  extendMembership,
  findCertificate,
  freezeMembership,
  getLoyaltySettings,
  listCertificates,
  listMemberships,
  listPlans,
  listPromos,
  removePromo,
  applyPromo,
  setPlanActive,
  setPromoActive,
  updateLoyaltySettings,
  voidCertificate,
} from "@/server/loyalty";
import {
  applyCount,
  cancelCount,
  createItem,
  deleteItem,
  getConsumables,
  getCount,
  listCounts,
  listItems,
  listMovements,
  receiveStock,
  setConsumables,
  setCounted,
  startCount,
  transferStock,
  updateItem,
  writeOffStock,
} from "@/server/inventory";
import {
  asOnline,
  cancelBooking,
  confirmBooking,
  createHold,
  getBooking,
  listSlots,
  publicCatalog,
  releaseHold,
  resolveBookingToken,
  resolvePublicBranch,
} from "@/server/booking";
import { listBranches, updateBranch, updateTenantSlug } from "@/server/settings";
import type { Actor } from "@/server/types";
import type { AppointmentStatus } from "@/domain/status";

export const dynamic = "force-dynamic";

function fail(error: unknown) {
  if (isAppError(error)) {
    const status = {
      FORBIDDEN: 403,
      VALIDATION: 400,
      CONFLICT_SLOT: 409,
      SHIFT_REQUIRED: 409,
      SHIFT_CLOSED: 409,
      NOT_FOUND: 404,
      STALE: 409,
      SOFT_CONFIRM: 409,
    }[error.code];
    return NextResponse.json({ error: { code: error.code, message: error.message, details: error.details ?? null } }, { status });
  }
  console.error(error);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Не получилось выполнить операцию" } }, { status: 500 });
}

function cookie(response: NextResponse, token: string) {
  response.cookies.set("ab_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}

async function readJson(request: NextRequest) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function handle(request: NextRequest, parts: string[]) {
  const method = request.method;
  const key = `${method} ${parts.join("/")}`;
  const url = request.nextUrl;

  if (key === "POST auth/login") {
    const body = await readJson(request);
    const result = await login(String(body.email ?? ""), String(body.password ?? ""));
    return cookie(NextResponse.json({ actor: result.actor }), result.token);
  }
  if (key === "POST auth/register") {
    const body = await readJson(request);
    const result = await register({
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      name: String(body.name ?? ""),
      salonName: String(body.salonName ?? ""),
      branchName: body.branchName ? String(body.branchName) : undefined,
      timezone: body.timezone ? String(body.timezone) : undefined,
    });
    return cookie(NextResponse.json({ actor: result.actor }), result.token);
  }
  if (key === "POST auth/logout") {
    const token = request.cookies.get("ab_session")?.value;
    if (token) await logout(token);
    const response = NextResponse.json({ ok: true });
    response.cookies.set("ab_session", "", { httpOnly: true, path: "/", maxAge: 0 });
    return response;
  }

  if (parts[0] === "public") return handlePublic(request, parts.slice(1));
  if (key === "GET health") {
    // Liveness + database reachability for the container healthcheck and uptime monitors.
    try {
      await pool.query("SELECT 1");
      return NextResponse.json({ ok: true, db: "up", time: new Date().toISOString() });
    } catch {
      return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
    }
  }
  if (key === "POST jobs/reminders") {
    // Called by cron; without JOBS_TOKEN configured the endpoint stays closed.
    const expected = process.env.JOBS_TOKEN;
    if (!expected || request.headers.get("x-jobs-token") !== expected) {
      return NextResponse.json({ error: { code: "FORBIDDEN", message: "Недостаточно прав" } }, { status: 403 });
    }
    return NextResponse.json(await runReminderJob());
  }

  const actor = await actorFromToken(request.cookies.get("ab_session")?.value);
  if (!actor) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Нужно войти" } }, { status: 401 });
  }

  if (key === "GET auth/me") {
    const branches = await asActor(actor, (ctx) => listBranches(ctx));
    const density = await getDensity(actor.userId);
    return NextResponse.json({ actor, branches, density });
  }
  if (key === "PUT preferences") {
    const body = await readJson(request);
    const density = String(body.density ?? "auto") as "auto" | "comfortable" | "compact";
    await setDensity(actor.userId, density);
    return NextResponse.json({ density });
  }

  const run = <T>(fn: (ctx: Parameters<Parameters<typeof asActor<T>>[1]>[0]) => Promise<T>) => asActor(actor, fn);

  if (key === "GET branches") return NextResponse.json(await run((ctx) => listBranches(ctx)));
  if (key === "PATCH tenant") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => updateTenantSlug(ctx, String(body.slug ?? ""))));
  }
  if (method === "PATCH" && parts[0] === "branches" && parts[1]) {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => updateBranch(ctx, parts[1], body)));
  }
  if (key === "GET dashboard") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => dashboard(ctx, branchId)));
  }
  if (key === "GET messages") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => listMessages(ctx, branchId)));
  }
  if (key === "GET reports/day") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => dayReport(ctx, branchId, url.searchParams.get("date") ?? "")));
  }
  if (parts[0] === "loyalty") {
    const [, kind, id, action] = parts;
    if (kind === "settings" && method === "GET") return NextResponse.json(await run((ctx) => getLoyaltySettings(ctx)));
    if (kind === "settings" && method === "PATCH") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => updateLoyaltySettings(ctx, body as never)));
    }
    if (kind === "certificates" && !id && method === "GET") {
      const code = url.searchParams.get("code");
      if (code) return NextResponse.json(await run((ctx) => findCertificate(ctx, code)));
      return NextResponse.json(await run((ctx) => listCertificates(ctx, { q: url.searchParams.get("q") ?? undefined })));
    }
    if (kind === "certificates" && id && action === "void" && method === "POST") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => voidCertificate(ctx, id, { reason: body.reason as string | undefined })));
    }
    if (kind === "plans" && !id && method === "GET") return NextResponse.json(await run((ctx) => listPlans(ctx)));
    if (kind === "plans" && !id && method === "POST") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => createPlan(ctx, body as never)));
    }
    if (kind === "plans" && id && method === "PATCH") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => setPlanActive(ctx, id, Boolean(body.active))));
    }
    if (kind === "memberships" && !id && method === "GET") return NextResponse.json(await run((ctx) => listMemberships(ctx)));
    if (kind === "memberships" && id && method === "POST") {
      const body = await readJson(request);
      if (action === "freeze") return NextResponse.json(await run((ctx) => freezeMembership(ctx, id, body as never)));
      if (action === "extend") return NextResponse.json(await run((ctx) => extendMembership(ctx, id, { days: Number(body.days), reason: body.reason as string | undefined })));
    }
    if (kind === "promos" && !id && method === "GET") return NextResponse.json(await run((ctx) => listPromos(ctx)));
    if (kind === "promos" && !id && method === "POST") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => createPromo(ctx, body as never)));
    }
    if (kind === "promos" && id && method === "PATCH") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => setPromoActive(ctx, id, Boolean(body.active))));
    }
  }
  if (parts[0] === "clients" && parts[1] && parts[2] === "loyalty" && method === "GET") {
    return NextResponse.json(await run((ctx) => clientLoyalty(ctx, parts[1], { appointmentId: url.searchParams.get("appointmentId") || undefined })));
  }
  if (parts[0] === "clients" && parts[1] && parts[2] === "bonus" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => adjustBonus(ctx, parts[1], { delta: Number(body.delta), reason: body.reason as string | undefined })));
  }
  if (parts[0] === "appointments" && parts[1] && parts[2] === "promo") {
    if (method === "POST") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => applyPromo(ctx, parts[1], String(body.code ?? ""))));
    }
    if (method === "DELETE") return NextResponse.json(await run((ctx) => removePromo(ctx, parts[1])));
  }
  if (parts[0] === "inventory") {
    const [, kind, id, action] = parts;
    const branchFrom = (value: unknown) => resolveBranch(actor, (value as string) || url.searchParams.get("branchId"));
    if (kind === "items" && !id && method === "GET") {
      const branchId = await branchFrom(null);
      return NextResponse.json(await run((ctx) => listItems(ctx, branchId, { includeArchived: url.searchParams.get("archived") === "1" })));
    }
    if (kind === "items" && !id && method === "POST") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => createItem(ctx, body as never)));
    }
    if (kind === "items" && id && method === "PATCH") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => updateItem(ctx, id, body as never)));
    }
    if (kind === "items" && id && method === "DELETE") return NextResponse.json(await run((ctx) => deleteItem(ctx, id)));
    if (kind === "movements" && method === "GET") {
      const branchId = await branchFrom(null);
      return NextResponse.json(
        await run((ctx) =>
          listMovements(ctx, branchId, { itemId: url.searchParams.get("itemId") || undefined, type: url.searchParams.get("type") || undefined }),
        ),
      );
    }
    if (method === "POST" && (kind === "receipt" || kind === "write-off")) {
      const body = await readJson(request);
      const branchId = await branchFrom(body.branchId);
      if (kind === "receipt") return NextResponse.json(await run((ctx) => receiveStock(ctx, { ...body, branchId } as never)));
      return NextResponse.json(await run((ctx) => writeOffStock(ctx, { ...body, branchId } as never)));
    }
    if (kind === "transfer" && method === "POST") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => transferStock(ctx, body as never)));
    }
    if (kind === "consumables" && id && method === "GET") return NextResponse.json(await run((ctx) => getConsumables(ctx, id)));
    if (kind === "consumables" && id && method === "PUT") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => setConsumables(ctx, id, (body.lines as never) ?? [])));
    }
    if (kind === "counts" && !id && method === "GET") {
      const branchId = await branchFrom(null);
      return NextResponse.json(await run((ctx) => listCounts(ctx, branchId)));
    }
    if (kind === "counts" && !id && method === "POST") {
      const body = await readJson(request);
      const branchId = await branchFrom(body.branchId);
      return NextResponse.json(await run((ctx) => startCount(ctx, { branchId, note: body.note as string | undefined })));
    }
    if (kind === "counts" && id && !action && method === "GET") return NextResponse.json(await run((ctx) => getCount(ctx, id)));
    if (kind === "counts" && id && action === "lines" && method === "PUT") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => setCounted(ctx, id, (body.lines as never) ?? [])));
    }
    if (kind === "counts" && id && action === "apply" && method === "POST") return NextResponse.json(await run((ctx) => applyCount(ctx, id)));
    if (kind === "counts" && id && action === "cancel" && method === "POST") return NextResponse.json(await run((ctx) => cancelCount(ctx, id)));
  }
  if (parts[0] === "payroll") {
    const [, kind, id, action, sub] = parts;
    if (kind === "rules" && !id && method === "GET") return NextResponse.json(await run((ctx) => listRules(ctx)));
    if (kind === "rules" && !id && method === "POST") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => createRule(ctx, body as never)));
    }
    if (kind === "rules" && id && method === "PATCH") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => updateRule(ctx, id, body as never)));
    }
    if (kind === "rules" && id && method === "DELETE") return NextResponse.json(await run((ctx) => deleteRule(ctx, id)));
    if (kind === "periods" && !id && method === "GET") {
      const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
      return NextResponse.json(await run((ctx) => listPeriods(ctx, branchId)));
    }
    if (kind === "periods" && !id && method === "POST") {
      const body = await readJson(request);
      const branchId = await resolveBranch(actor, (body.branchId as string) ?? null);
      return NextResponse.json(
        await run((ctx) => createPeriod(ctx, { branchId, startsOn: String(body.startsOn ?? ""), endsOn: String(body.endsOn ?? "") })),
      );
    }
    if (kind === "periods" && id && !action && method === "GET") return NextResponse.json(await run((ctx) => getPeriod(ctx, id)));
    if (kind === "periods" && id && method === "POST") {
      const body = await readJson(request);
      if (action === "calculate") return NextResponse.json(await run((ctx) => calculatePeriod(ctx, id)));
      if (action === "approve") return NextResponse.json(await run((ctx) => approvePeriod(ctx, id)));
      if (action === "unapprove") return NextResponse.json(await run((ctx) => unapprovePeriod(ctx, id)));
      if (action === "lock") return NextResponse.json(await run((ctx) => lockPeriod(ctx, id)));
      if (action === "pay") return NextResponse.json(await run((ctx) => payPeriod(ctx, id, body as never)));
      if (action === "lines") return NextResponse.json(await run((ctx) => addManualLine(ctx, id, body as never)));
    }
    if (kind === "periods" && id && action === "lines" && sub && method === "DELETE") {
      return NextResponse.json(await run((ctx) => removeManualLine(ctx, id, sub)));
    }
  }
  if (parts[0] === "appointments" && parts[2] === "payroll-exclusion" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(
      await run((ctx) => setPayrollExclusion(ctx, parts[1], { exclude: Boolean(body.exclude), reason: body.reason as string | undefined })),
    );
  }
  if (key === "GET journal") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    const staffIds = url.searchParams.get("staffIds")?.split(",").filter(Boolean);
    return NextResponse.json(
      await run((ctx) =>
        getJournal(ctx, {
          branchId,
          date: url.searchParams.get("date") || new Date().toISOString().slice(0, 10),
          staffIds,
          showOff: url.searchParams.get("showOff") === "1",
          showCancelled: url.searchParams.get("showCancelled") === "1",
        }),
      ),
    );
  }
  if (key === "GET search") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => searchAppointments(ctx, branchId, url.searchParams.get("q") ?? "")));
  }
  if (key === "GET export") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    const csv = await run((ctx) =>
      exportAppointmentsCsv(ctx, {
        branchId,
        date: url.searchParams.get("date") || new Date().toISOString().slice(0, 10),
        staffId: url.searchParams.get("staffId") || undefined,
        status: url.searchParams.get("status") || undefined,
      }),
    );
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8" } });
  }
  if (key === "GET prev-client") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(
      await run((ctx) => previousClient(ctx, branchId, url.searchParams.get("staffId") || "", url.searchParams.get("date") || "")),
    );
  }
  if (key === "POST appointments") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => createAppointment(ctx, body as never)));
  }
  if (parts[0] === "appointments" && parts[1] && !parts[2] && method === "GET") {
    return NextResponse.json(await run((ctx) => getAppointment(ctx, parts[1])));
  }
  if (parts[0] === "appointments" && parts[1] && !parts[2] && method === "PATCH") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => updateAppointment(ctx, parts[1], body as never)));
  }
  if (parts[0] === "appointments" && parts[1] && !parts[2] && method === "DELETE") {
    await run((ctx) => hardDeleteAppointment(ctx, parts[1]));
    return NextResponse.json({ ok: true });
  }
  if (parts[0] === "appointments" && parts[2] === "cancel" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => cancelAppointment(ctx, parts[1], body as never)));
  }
  if (parts[0] === "appointments" && parts[2] === "restore" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => restoreAppointment(ctx, parts[1], Number(body.version))));
  }
  if (parts[0] === "appointments" && parts[2] === "move" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => moveAppointment(ctx, parts[1], body as never)));
  }
  if (parts[0] === "appointments" && parts[2] === "resize" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => resizeAppointment(ctx, parts[1], body as never)));
  }
  if (parts[0] === "appointments" && parts[2] === "status" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(
      await run((ctx) => changeStatus(ctx, parts[1], String(body.status) as AppointmentStatus, { version: Number(body.version), acknowledgeSoft: Boolean(body.acknowledgeSoft) })),
    );
  }

  if (key === "GET clients") return NextResponse.json(await run((ctx) => listClients(ctx, url.searchParams.get("q") ?? "")));
  if (key === "POST clients") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => createClient(ctx, body as never)));
  }
  if (parts[0] === "clients" && parts[1] && !parts[2] && method === "GET") {
    return NextResponse.json(await run((ctx) => getClient(ctx, parts[1])));
  }
  if (parts[0] === "clients" && parts[1] && !parts[2] && method === "PATCH") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => updateClient(ctx, parts[1], body as never)));
  }
  if (parts[0] === "clients" && parts[2] === "delete" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => deleteClient(ctx, parts[1], body.decision as never)));
  }
  if (parts[0] === "clients" && parts[2] === "history" && method === "GET") {
    return NextResponse.json(await run((ctx) => clientHistory(ctx, parts[1], url.searchParams.get("branchId") || undefined)));
  }
  if (parts[0] === "clients" && parts[2] === "balance" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => adjustBalance(ctx, parts[1], Number(body.amountMinor), String(body.reason ?? ""))));
  }

  if (key === "GET catalog") return NextResponse.json(await run((ctx) => listCatalog(ctx)));
  if (key === "POST categories") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => createCategory(ctx, String(body.title ?? ""))));
  }
  if (parts[0] === "categories" && parts[1] && method === "DELETE") {
    await run((ctx) => deleteCategory(ctx, parts[1]));
    return NextResponse.json({ ok: true });
  }
  if (key === "POST services") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => createService(ctx, body as never)));
  }
  if (key === "POST services/reorder") {
    const body = await readJson(request);
    await run((ctx) => reorderServices(ctx, (body.ids as string[]) ?? []));
    return NextResponse.json({ ok: true });
  }
  if (parts[0] === "services" && parts[1] && parts[2] === "deactivate" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => deactivateService(ctx, parts[1], Boolean(body.hard))));
  }
  if (parts[0] === "services" && parts[1] && parts[2] === "staff" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => setServiceStaff(ctx, parts[1], (body.staffIds as string[]) ?? [], Boolean(body.acknowledgeSoft))));
  }
  if (parts[0] === "services" && parts[1] && !parts[2] && method === "PATCH") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => updateService(ctx, parts[1], body as never)));
  }

  if (key === "GET staff") return NextResponse.json(await run((ctx) => listStaff(ctx)));
  if (key === "POST staff") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => createStaff(ctx, body as never)));
  }
  if (parts[0] === "staff" && parts[1] && !parts[2] && method === "PATCH") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => updateStaff(ctx, parts[1], body as never)));
  }
  if (parts[0] === "staff" && parts[2] === "deactivate" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(
      await run((ctx) => deactivateStaff(ctx, parts[1], body.decision as never, body.reassignToStaffId as string | undefined)),
    );
  }
  if (parts[0] === "staff" && parts[2] === "schedule" && method === "GET") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => readWeekTemplate(ctx, parts[1], branchId)));
  }
  if (parts[0] === "staff" && parts[2] === "exceptions" && method === "GET") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => listExceptions(ctx, parts[1], branchId, url.searchParams.get("from") ?? "")));
  }
  if (parts[0] === "schedule-exceptions" && parts[1] && method === "DELETE") {
    return NextResponse.json(await run((ctx) => deleteException(ctx, parts[1])));
  }
  if (key === "GET schedule-requests") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => listScheduleRequests(ctx, branchId, { status: url.searchParams.get("status") || undefined })));
  }
  if (key === "POST schedule-requests") {
    const body = await readJson(request);
    const branchId = await resolveBranch(actor, (body.branchId as string) ?? null);
    return NextResponse.json(await run((ctx) => createScheduleRequest(ctx, { ...body, branchId } as never)));
  }
  if (parts[0] === "schedule-requests" && parts[1] && parts[2] === "decide" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(
      await run((ctx) => decideScheduleRequest(ctx, parts[1], { approve: Boolean(body.approve), note: body.note as string | undefined, acknowledgeSoft: Boolean(body.acknowledgeSoft) })),
    );
  }
  if (parts[0] === "staff" && parts[2] === "schedule" && method === "PUT") {
    const body = await readJson(request);
    const branchId = await resolveBranch(actor, String(body.branchId ?? ""));
    return NextResponse.json(await run((ctx) => saveWeekTemplate(ctx, { staffId: parts[1], branchId, intervals: body.intervals as never })));
  }
  if (parts[0] === "staff" && parts[2] === "exceptions" && method === "POST") {
    const body = await readJson(request);
    const branchId = await resolveBranch(actor, (body.branchId as string) ?? null);
    return NextResponse.json(await run((ctx) => createException(ctx, parts[1], branchId, body as never, Boolean(body.acknowledgeSoft))));
  }
  if (parts[0] === "staff" && parts[2] === "copy-week" && method === "POST") {
    const body = await readJson(request);
    const branchId = await resolveBranch(actor, String(body.branchId ?? ""));
    return NextResponse.json(await run((ctx) => copyExceptionsToNextWeek(ctx, parts[1], branchId, String(body.date ?? ""))));
  }

  if (key === "POST shifts/open") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => openShift(ctx, body as never)));
  }
  if (key === "GET shifts/current") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => currentShift(ctx, branchId)));
  }
  if (key === "GET shifts") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(await run((ctx) => listShifts(ctx, branchId, Number(url.searchParams.get("limit") || 30))));
  }
  if (parts[0] === "shifts" && parts[1] && parts[1] !== "open" && parts[1] !== "current") {
    const shiftId = parts[1];
    if (method === "GET" && parts[2] === "report") return NextResponse.json(await run((ctx) => shiftReport(ctx, shiftId)));
    if (method === "POST" && parts[2] === "start-closing") return NextResponse.json(await run((ctx) => startClosing(ctx, shiftId)));
    if (method === "POST" && parts[2] === "cancel-closing") return NextResponse.json(await run((ctx) => cancelClosing(ctx, shiftId)));
    if (method === "POST" && parts[2] === "close") {
      const body = await readJson(request);
      return NextResponse.json(await run((ctx) => closeShift(ctx, shiftId, body as never)));
    }
  }
  if (key === "GET payments") {
    const branchId = await resolveBranch(actor, url.searchParams.get("branchId"));
    return NextResponse.json(
      await run((ctx) =>
        listPayments(ctx, branchId, {
          date: url.searchParams.get("date") || undefined,
          shiftId: url.searchParams.get("shiftId") || undefined,
        }),
      ),
    );
  }
  if (parts[0] === "payments" && parts[1] && parts[2] === "refund" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => refundPayment(ctx, parts[1], body as never)));
  }
  if (parts[0] === "payments" && parts[1] && parts[2] === "void" && method === "POST") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => voidPayment(ctx, parts[1], body as never)));
  }
  if (parts[0] === "appointments" && parts[1] && parts[2] === "payments" && method === "GET") {
    return NextResponse.json(await run((ctx) => appointmentPayments(ctx, parts[1])));
  }
  if (key === "POST payments") {
    const body = await readJson(request);
    return NextResponse.json(await run((ctx) => createPayment(ctx, body as never)));
  }

  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Не найдено" } }, { status: 404 });
}

function clientIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

/** Online booking (OB-*): no session; the slug or the cancel token picks the tenant. */
async function handlePublic(request: NextRequest, parts: string[]) {
  const method = request.method;
  const url = request.nextUrl;
  if (parts[0] === "booking" && parts[1]) {
    const { tenantId, appointmentId } = await resolveBookingToken(parts[1]);
    if (method === "GET" && !parts[2]) return NextResponse.json(await asOnline(tenantId, (ctx) => getBooking(ctx, appointmentId)));
    if (method === "POST" && parts[2] === "cancel") {
      const body = await readJson(request);
      return NextResponse.json(
        await asOnline(tenantId, (ctx) => cancelBooking(ctx, appointmentId, { reason: body.reason ? String(body.reason) : undefined })),
      );
    }
  }
  if (parts[0] === "b" && parts[1] && parts[2]) {
    const { tenantId, branchId } = await resolvePublicBranch(parts[1], parts[2]);
    const action = parts.slice(3).join("/");
    if (method === "GET" && action === "catalog") return NextResponse.json(await asOnline(tenantId, (ctx) => publicCatalog(ctx, branchId)));
    if (method === "GET" && action === "slots") {
      return NextResponse.json(
        await asOnline(tenantId, (ctx) =>
          listSlots(ctx, branchId, {
            serviceId: url.searchParams.get("serviceId") ?? "",
            staffId: url.searchParams.get("staffId") || null,
            from: url.searchParams.get("from") ?? undefined,
            days: url.searchParams.get("days") ? Number(url.searchParams.get("days")) : undefined,
          }),
        ),
      );
    }
    if (method === "POST" && action === "holds") {
      const body = await readJson(request);
      return NextResponse.json(
        await asOnline(tenantId, (ctx) =>
          createHold(ctx, branchId, {
            serviceId: String(body.serviceId ?? ""),
            staffId: body.staffId ? String(body.staffId) : null,
            startsAt: String(body.startsAt ?? ""),
            ip: clientIp(request),
          }),
        ),
      );
    }
    if (method === "DELETE" && parts[3] === "holds" && parts[4]) {
      return NextResponse.json(await asOnline(tenantId, (ctx) => releaseHold(ctx, branchId, parts[4])));
    }
    if (method === "POST" && action === "bookings") {
      const body = await readJson(request);
      return NextResponse.json(
        await asOnline(tenantId, (ctx) =>
          confirmBooking(ctx, branchId, {
            holdId: String(body.holdId ?? ""),
            name: String(body.name ?? ""),
            phone: String(body.phone ?? ""),
            comment: body.comment ? String(body.comment) : undefined,
            idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : undefined,
            promoCode: body.promoCode ? String(body.promoCode) : undefined,
          }),
        ),
      );
    }
  }
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Не найдено" } }, { status: 404 });
}

async function resolveBranch(actor: Actor, requested: string | null) {
  if (requested) return requested;
  if (actor.branchId) return actor.branchId;
  const branches = await asActor(actor, (ctx) => listBranches(ctx));
  if (!branches[0]) throw new Error("Нет филиала");
  return branches[0].id;
}

async function dispatch(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    return await handle(request, path);
  } catch (error) {
    return fail(error);
  }
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
