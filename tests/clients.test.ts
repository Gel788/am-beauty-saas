import { beforeAll, describe, expect, it } from "vitest";
import { adjustBalance, clientHistory, createClient, deleteClient, listClients, searchClients, updateClient } from "@/server/clients";
import { createAppointment } from "@/server/appointments";
import { at, createSalon, run, useDb, DAY } from "./helpers";

useDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
});

describe("clients", () => {
  it("CL-CREATE-01 blocks a duplicate phone and links the existing client", async () => {
    const created = await run(salon.admin, (ctx) =>
      createClient(ctx, { name: "Мария", phone: "8 900 200-00-01", email: "maria@example.com", tags: ["vip"] }),
    );
    expect(created.phones[0].phone).toBe("+79002000001");
    await expect(
      run(salon.admin, (ctx) => createClient(ctx, { name: "Другая", phone: "+79002000001" })),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { existingClientId: created.id } });
  });

  it("CL-CREATE-02 uses the same phone rule from a visit", async () => {
    await expect(
      run(salon.admin, (ctx) =>
        createAppointment(ctx, {
          branchId: salon.branchId,
          staffId: salon.staffA,
          startsAt: at("12:00", "2027-04-01"),
          services: [{ serviceId: salon.serviceId }],
          acknowledgeSoft: true,
          newClient: { name: "Ещё раз", phone: "+79002000001" },
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("CL-EDIT-01 checks version and phone uniqueness", async () => {
    const created = await run(salon.admin, (ctx) => createClient(ctx, { name: "Ольга К", phone: "+79002000002" }));
    const updated = await run(salon.admin, (ctx) =>
      updateClient(ctx, created.id, { version: created.version, name: "Ольга Ковалёва", phone: "+79002000003" }),
    );
    expect(updated.name).toBe("Ольга Ковалёва");
    expect(updated.phones[0].phone).toBe("+79002000003");
    await expect(
      run(salon.admin, (ctx) => updateClient(ctx, created.id, { version: created.version, name: "Старая версия" })),
    ).rejects.toMatchObject({ code: "STALE" });
    await expect(
      run(salon.admin, (ctx) => updateClient(ctx, updated.id, { version: updated.version, phone: "+79002000001" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("CL-SEARCH-01 finds by name and phone suffix, and ignores a one-letter query", async () => {
    await run(salon.admin, (ctx) => createClient(ctx, { name: "Елена Лебедева", phone: "+79003334455", email: "elena@example.com" }));
    expect(await run(salon.admin, (ctx) => searchClients(ctx, "е"))).toEqual([]);
    const byName = await run(salon.admin, (ctx) => searchClients(ctx, "Лебед"));
    expect(byName.map((client) => client.name)).toEqual(["Елена Лебедева"]);
    const byPhone = await run(salon.admin, (ctx) => searchClients(ctx, "3334455"));
    expect(byPhone.some((client) => client.name === "Елена Лебедева")).toBe(true);
  });

  it("allows the same name with different phones", async () => {
    await run(salon.admin, (ctx) => createClient(ctx, { name: "Анна", phone: "+79002000010" }));
    const second = await run(salon.admin, (ctx) => createClient(ctx, { name: "Анна", phone: "+79002000011" }));
    expect(second.name).toBe("Анна");
  });

  it("stores an international number in E.164", async () => {
    const created = await run(salon.admin, (ctx) => createClient(ctx, { name: "Hans", phone: "+49 151 23456789" }));
    expect(created.phones[0].phone).toBe("+4915123456789");
  });

  it("CL-DELETE-01 asks what to do with future visits", async () => {
    const client = await run(salon.admin, (ctx) => createClient(ctx, { name: "Удалить", phone: "+79002000020" }));
    const visit = await run(salon.admin, (ctx) =>
      createAppointment(ctx, {
        branchId: salon.branchId,
        staffId: salon.staffB,
        clientId: client.id,
        startsAt: at("15:00", "2027-04-02"),
        services: [{ serviceId: salon.serviceId }],
        acknowledgeSoft: true,
      }),
    );
    await expect(run(salon.admin, (ctx) => deleteClient(ctx, client.id))).rejects.toMatchObject({
      code: "VALIDATION",
      details: { futureCount: 1 },
    });
    const kept = await run(salon.admin, (ctx) => createClient(ctx, { name: "Оставить", phone: "+79002000021" }));
    await run(salon.admin, (ctx) =>
      createAppointment(ctx, {
        branchId: salon.branchId,
        staffId: salon.staffB,
        clientId: kept.id,
        startsAt: at("16:00", "2027-04-02"),
        services: [{ serviceId: salon.serviceId }],
        acknowledgeSoft: true,
      }),
    );
    await run(salon.admin, (ctx) => deleteClient(ctx, kept.id, "keep_future"));
    const result = await run(salon.admin, (ctx) => deleteClient(ctx, client.id, "cancel_future"));
    expect(result.cancelled).toBe(1);
    const history = await run(salon.admin, (ctx) => clientHistory(ctx, client.id));
    expect(history.visits.find((row) => row.id === visit.id)?.status).toBe("cancelled");
    const list = await run(salon.admin, (ctx) => listClients(ctx, "Удалить"));
    expect(list.find((row) => row.id === client.id)).toBeUndefined();
  });

  it("CL-HISTORY-01 returns visits and no-shows", async () => {
    const history = await run(salon.admin, (ctx) => clientHistory(ctx, salon.clientId, salon.branchId));
    expect(Array.isArray(history.visits)).toBe(true);
    expect(Array.isArray(history.payments)).toBe(true);
  });

  it("CL-BALANCE-01 lets the owner adjust debt with a reason", async () => {
    const client = await run(salon.owner, (ctx) => adjustBalance(ctx, salon.clientId, 50000, "ручная корректировка"));
    expect(client.balanceMinor).toBe(50000);
    await expect(run(salon.admin, (ctx) => adjustBalance(ctx, salon.clientId, 100, "нет"))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run(salon.accountant, (ctx) => adjustBalance(ctx, salon.clientId, -50000, ""))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const cleared = await run(salon.accountant, (ctx) => adjustBalance(ctx, salon.clientId, -50000, "списали"));
    expect(cleared.balanceMinor).toBe(0);
  });

  it("rejects an empty phone", async () => {
    await expect(run(salon.admin, (ctx) => createClient(ctx, { name: "Без телефона", phone: "  " }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  void DAY;
});
