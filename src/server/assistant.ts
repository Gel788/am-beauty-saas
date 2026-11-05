/**
 * VOICE-PRO-03: the third hand. «Ассистент, кто у Марины после обеда?», «перенеси Анну на пятницу»,
 * «отметь, что Ольга пришла». The model (any OpenAI-compatible provider, the salon's own key) reads
 * the salon through a few tools and answers in one or two spoken sentences. It never writes by itself:
 * a change comes back as an action the CRM shows and runs after a second, with Esc to stop it.
 */
import { AppError } from "@/domain/errors";
import { freeGaps, type PulseDay } from "@/domain/pulse";
import { addCalendarDays, localMinutes, todayInZone } from "@/domain/time";
import { getJournal } from "./appointments";
import { listClients } from "./clients";
import { dashboard } from "./dashboard";
import { integrationConfig } from "./integrations";
import { request } from "./providers/http";
import type { Ctx } from "./types";

const STATUS: Record<string, string> = {
  scheduled: "записан",
  confirmed: "подтвердил",
  arrived: "пришёл",
  in_progress: "в работе",
  completed: "завершён",
  no_show: "не пришёл",
  cancelled: "отменён",
};

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const rub = (minor: number) => `${Math.round(minor / 100).toLocaleString("ru-RU")} ₽`;

async function daySummary(ctx: Ctx, branchId: string, date: string, title: string) {
  const day = await getJournal(ctx, { branchId, date, showOff: true, showCancelled: false });
  const lines = [`${title} (${date}): записей ${day.stats.appointmentCount}, загрузка ${day.stats.loadPercent}%, ожидаемая выручка ${rub(day.stats.expectedRevenueMinor)}.`];
  for (const staff of day.staff) {
    const visits = day.appointments.filter((row) => row.staffId === staff.id).sort((a, b) => a.startMin - b.startMin);
    const works = staff.intervals.filter((row) => row.kind === "work");
    const shift = works.length ? works.map((row) => `${hhmm(row.startMin)}–${hhmm(row.endMin)}`).join(", ") : "выходной";
    const list = visits.map((row) => `[id ${row.id} v${row.version}] ${hhmm(row.startMin)} ${row.clientName ?? "без клиента"} (${row.services.map((line) => line.title).join(" + ")}, ${STATUS[row.status] ?? row.status}${row.debtMinor > 0 ? `, долг ${rub(row.debtMinor)}` : ""})`);
    lines.push(`- ${staff.name}, смена ${shift}, загрузка ${staff.loadPercent}%: ${list.length ? list.join("; ") : "записей нет"}`);
  }
  return lines.join("\n");
}

export async function assistantAvailable(ctx: Ctx) {
  return Boolean(await integrationConfig(ctx, "openai_voice"));
}

export type AssistantAction =
  | { kind: "command"; label: string; text: string }
  | { kind: "status"; label: string; appointmentId: string; version: number; status: string }
  | { kind: "open"; label: string; href: string };

type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

const TOOLS = [
  {
    type: "function",
    function: {
      name: "day",
      description: "Журнал салона на день: мастера, смены, записи с id и версией, статусы, долги.",
      parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"] },
    },
  },
  {
    type: "function",
    function: {
      name: "free_slots",
      description: "Свободные окна мастеров на день (минимум min минут).",
      parameters: { type: "object", properties: { date: { type: "string" }, min: { type: "number" } }, required: ["date"] },
    },
  },
  {
    type: "function",
    function: {
      name: "find_client",
      description: "Найти клиента по имени или телефону: визиты, последний визит, баланс, заметки.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_booking",
      description:
        "Предложить новую запись. phrase — команда для строки CRM строго в виде: «запиши <Имя клиента в винительном> к <Имя мастера в дательном> <DD.MM> в <HH:MM> <услуга>». CRM сама проверит окно и запишет после секунды на отмену.",
      parameters: { type: "object", properties: { phrase: { type: "string" }, label: { type: "string", description: "Коротко для кнопки" } }, required: ["phrase", "label"] },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_status",
      description: "Предложить сменить статус записи: confirmed (подтвердил), arrived (пришёл), in_progress, completed, no_show (не пришёл), cancelled (отмена). Нужны id и версия из day.",
      parameters: {
        type: "object",
        properties: { appointment_id: { type: "string" }, version: { type: "number" }, status: { type: "string" }, label: { type: "string" } },
        required: ["appointment_id", "version", "status", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_page",
      description: "Открыть раздел CRM: /journal?date=YYYY-MM-DD, /clients?open=<id>, /finance, /inventory, /payroll, /retention, /reports, /staff, /services.",
      parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" } }, required: ["href", "label"] },
    },
  },
];

const STATUSES = new Set(["confirmed", "arrived", "in_progress", "completed", "no_show", "cancelled", "scheduled"]);

async function runTool(ctx: Ctx, branchId: string, name: string, args: Record<string, unknown>, actions: AssistantAction[]) {
  const date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null;
  if (name === "day") return date ? daySummary(ctx, branchId, date, "День") : "Нужна дата YYYY-MM-DD";
  if (name === "free_slots") {
    if (!date) return "Нужна дата YYYY-MM-DD";
    const day = (await getJournal(ctx, { branchId, date, showOff: true, showCancelled: false })) as unknown as PulseDay & { branch: { timezone: string } };
    const today = todayInZone(day.branch.timezone, ctx.now);
    const notBefore = date === today ? localMinutes(ctx.now, day.branch.timezone) + 15 : 0;
    const min = Math.max(15, Math.min(240, Number(args.min) || 60));
    return day.staff
      .map((staff) => {
        const gaps = freeGaps(day, staff.id, notBefore, min);
        return `${staff.name}: ${gaps.length ? gaps.map((gap) => `${hhmm(gap.startMin)}–${hhmm(gap.endMin)}`).join(", ") : "нет окон"}`;
      })
      .join("\n");
  }
  if (name === "find_client") {
    const rows = (await listClients(ctx, String(args.query ?? "").slice(0, 60))).slice(0, 5);
    if (!rows.length) return "Не нашла такого клиента";
    return rows
      .map((row) => `[id ${row.id}] ${row.name}: визитов ${row.visitCount ?? 0}, последний ${row.lastVisitAt ? row.lastVisitAt.slice(0, 10) : "—"}, баланс ${rub(row.balanceMinor)}${row.notes ? `, заметка: ${row.notes.slice(0, 120)}` : ""}${row.tags.length ? `, метки: ${row.tags.join(", ")}` : ""}`)
      .join("\n");
  }
  const label = String(args.label ?? "").slice(0, 80) || "Сделать";
  if (name === "propose_booking") {
    const text = String(args.phrase ?? "").slice(0, 200);
    if (!/^запиши\s/i.test(text)) return "Фраза должна начинаться с «запиши»";
    actions.push({ kind: "command", label, text });
    return "Предложено. Скажи коротко, что записываешь.";
  }
  if (name === "propose_status") {
    const status = String(args.status ?? "");
    if (!STATUSES.has(status)) return "Неизвестный статус";
    actions.push({ kind: "status", label, appointmentId: String(args.appointment_id ?? ""), version: Number(args.version) || 0, status });
    return "Предложено. Скажи коротко, что делаешь.";
  }
  if (name === "open_page") {
    const href = String(args.href ?? "");
    if (!href.startsWith("/") || href.startsWith("//")) return "Только разделы CRM";
    actions.push({ kind: "open", label, href });
    return "Открою.";
  }
  return "Нет такого инструмента";
}

export async function askAssistant(ctx: Ctx, branchId: string, question: string, history: { role: "user" | "assistant"; content: string }[] = []) {
  const config = await integrationConfig(ctx, "openai_voice");
  if (!config?.apiKey) throw new AppError("NOT_FOUND", "Подключите ключ в Настройки → Интеграции → Голос CRM");
  const text = question.trim().slice(0, 500);
  if (!text) throw new AppError("VALIDATION", "Пустой вопрос");
  const stats = await dashboard(ctx, branchId);
  const today = stats.today;
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" }).format(new Date(`${today}T12:00:00Z`));
  const context = [
    `Салон: ${stats.branchName}. Сегодня ${today}, ${weekday}. Сейчас ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(ctx.now)}.`,
    `Месяц: выручка ${rub(stats.monthRevenueMinor)}, средний чек ${rub(stats.averageCheckMinor)}, вернулись повторно ${stats.repeatPercent}%, давно не были ${stats.dormantClients} клиентов. Сегодня оплачено ${rub(stats.todayPaidMinor)}.`,
    `Топ услуг месяца: ${stats.topServices.slice(0, 6).map((row) => `${row.title} (${row.visits})`).join(", ") || "нет данных"}.`,
    await daySummary(ctx, branchId, today, "Сегодня"),
  ].join("\n");
  const messages: Message[] = [
    {
      role: "system",
      content:
        "Ты — голосовой ассистент администратора салона красоты в CRM AM Beauty, его третья рука. Говори по-русски, тепло и очень коротко: 1–2 предложения, ответ произносится вслух. Время говори как «в четыре тридцать» не нужно, пиши 16:30. " +
        "Факты бери только из данных и инструментов; не выдумывай. Для любых изменений (запись, перенос = новая запись + отмена старой, отметить пришёл/не пришёл, отмена) вызывай propose_* — CRM покажет и выполнит сама. " +
        "Если нужно больше данных о другом дне — вызови day или free_slots. Если вопрос не про салон — вежливо скажи, что помогаешь только с работой салона.\n\nДанные:\n" +
        context,
    },
    ...history.slice(-6).map((row) => ({ role: row.role, content: row.content.slice(0, 600) })),
    { role: "user", content: text },
  ];
  const base = (config.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = config.model || "gpt-5-mini";
  // Newer models (gpt-5+, o-series) take max_completion_tokens and no temperature; older ones the opposite.
  // Names differ between providers, so a refusal of the parameters flips the style once.
  let reasoning = !/(?:^|\/)(?:gpt-4|gpt-3|llama|mistral|qwen|deepseek|claude|gemini)/i.test(model);
  const actions: AssistantAction[] = [];
  let flipped = false;
  for (let round = 0; round < 5; round += 1) {
    const { ok, status, data, raw } = await request<{ choices?: { message?: Message }[]; error?: { message?: string } }>(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOLS,
        tool_choice: round === 4 ? "none" : "auto",
        // Reasoning models (gpt-5, o-series) take no temperature and count thinking in the budget.
        ...(reasoning ? { max_completion_tokens: 4000 } : { temperature: 0.3, max_tokens: 500 }),
      }),
      timeoutMs: 40000,
    });
    const message = data?.choices?.[0]?.message;
    if (status === 400 && !flipped && /max_tokens|max_completion_tokens|temperature|unsupported/i.test(raw)) {
      flipped = true;
      reasoning = !reasoning;
      round -= 1;
      continue;
    }
    if (!ok || !message) {
      if (status === 403) throw new AppError("VALIDATION", "Провайдер не работает с IP этого сервера. Укажите адрес прокси в настройках");
      throw new AppError("VALIDATION", data?.error?.message ? `Ассистент: ${data.error.message}` : `Провайдер ответил ${status}`);
    }
    if (message.tool_calls?.length) {
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // a broken argument list reads as empty
        }
        const result = await runTool(ctx, branchId, call.function.name, args, actions).catch((error: unknown) => `Ошибка: ${error instanceof Error ? error.message : String(error)}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 6000) });
      }
      continue;
    }
    return { answer: (message.content ?? "").trim() || "Готово", actions: actions.slice(0, 3) };
  }
  return { answer: actions.length ? "Вот что предлагаю" : "Не получилось ответить, спросите иначе", actions: actions.slice(0, 3) };
}
