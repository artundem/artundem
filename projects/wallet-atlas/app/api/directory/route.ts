import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  directoryDeletions,
  directoryPeople,
  directoryWallets,
} from "../../../db/schema";

type Action =
  | "add_person"
  | "rename_person"
  | "delete_person"
  | "add_wallet"
  | "update_wallet_classification"
  | "delete_wallet"
  | "save_person_note";

type Payload = {
  action?: Action;
  personName?: string;
  oldPersonName?: string;
  chain?: "solana" | "evm";
  category?: "trade" | "funding";
  label?: string;
  address?: string;
  note?: string;
  wallets?: {
    chain: "solana" | "evm";
    category: "trade" | "funding";
    label: string;
    address: string;
    note?: string;
  }[];
};

function clean(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Beklenmeyen hata";
  if (message.includes("no such table")) {
    return "Cüzdan dizini veritabanı henüz hazır değil.";
  }
  return message;
}

export async function GET() {
  try {
    const db = getDb();
    const [people, wallets, deletions] = await Promise.all([
      db.select().from(directoryPeople).orderBy(asc(directoryPeople.name)),
      db.select().from(directoryWallets).orderBy(asc(directoryWallets.createdAt)),
      db
        .select()
        .from(directoryDeletions)
        .orderBy(asc(directoryDeletions.createdAt)),
    ]);

    return Response.json({
      people,
      wallets,
      deletions,
    });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Payload;
    const personName = clean(payload.personName, 80);
    const oldPersonName = clean(payload.oldPersonName, 80);
    const address = clean(payload.address, 140);
    const label = clean(payload.label, 80);
    const note = clean(payload.note, 2000);
    const db = getDb();

    if (payload.action === "add_person") {
      if (!personName) {
        return Response.json({ error: "İsim gerekli." }, { status: 400 });
      }

      await db
        .delete(directoryDeletions)
        .where(
          and(
            eq(directoryDeletions.entityType, "person"),
            eq(directoryDeletions.entityKey, personName),
          ),
        );
      await db
        .insert(directoryPeople)
        .values({ id: crypto.randomUUID(), name: personName })
        .onConflictDoNothing();

      return Response.json({ ok: true });
    }

    if (payload.action === "rename_person") {
      if (!oldPersonName || !personName) {
        return Response.json(
          { error: "Eski ve yeni isim gerekli." },
          { status: 400 },
        );
      }
      if (oldPersonName === personName) {
        return Response.json({ ok: true });
      }

      const existingPerson = await db
        .select({ name: directoryPeople.name })
        .from(directoryPeople)
        .where(eq(directoryPeople.name, personName))
        .limit(1);
      if (existingPerson.length > 0) {
        return Response.json(
          { error: "Bu isim dizinde zaten bulunuyor." },
          { status: 409 },
        );
      }

      const oldPerson = await db
        .select({ note: directoryPeople.note })
        .from(directoryPeople)
        .where(eq(directoryPeople.name, oldPersonName))
        .limit(1);

      await db
        .delete(directoryDeletions)
        .where(
          and(
            eq(directoryDeletions.entityType, "person"),
            eq(directoryDeletions.entityKey, personName),
          ),
        );
      await db.insert(directoryPeople).values({
        id: crypto.randomUUID(),
        name: personName,
        note: oldPerson[0]?.note ?? note,
      });
      await db
        .update(directoryWallets)
        .set({ personName })
        .where(eq(directoryWallets.personName, oldPersonName));

      for (const wallet of payload.wallets ?? []) {
        const walletAddress = clean(wallet.address, 140);
        const walletLabel = clean(wallet.label, 80);
        if (!walletAddress || !walletLabel) continue;
        await db
          .insert(directoryWallets)
          .values({
            id: crypto.randomUUID(),
            personName,
            chain: wallet.chain,
            category: wallet.category,
            label: walletLabel,
            address: walletAddress,
            note: clean(wallet.note, 1000),
          })
          .onConflictDoUpdate({
            target: directoryWallets.address,
            set: { personName },
          });
      }

      await db
        .delete(directoryPeople)
        .where(eq(directoryPeople.name, oldPersonName));
      await db
        .insert(directoryDeletions)
        .values({
          id: crypto.randomUUID(),
          entityType: "person",
          entityKey: oldPersonName,
        })
        .onConflictDoNothing();

      return Response.json({ ok: true });
    }

    if (payload.action === "delete_person") {
      if (!personName) {
        return Response.json({ error: "İsim gerekli." }, { status: 400 });
      }

      await db
        .delete(directoryWallets)
        .where(eq(directoryWallets.personName, personName));
      await db
        .delete(directoryPeople)
        .where(eq(directoryPeople.name, personName));
      await db
        .insert(directoryDeletions)
        .values({
          id: crypto.randomUUID(),
          entityType: "person",
          entityKey: personName,
        })
        .onConflictDoNothing();

      return Response.json({ ok: true });
    }

    if (payload.action === "save_person_note") {
      if (!personName) {
        return Response.json({ error: "İsim gerekli." }, { status: 400 });
      }

      await db
        .insert(directoryPeople)
        .values({ id: crypto.randomUUID(), name: personName, note })
        .onConflictDoUpdate({
          target: directoryPeople.name,
          set: { note },
        });

      return Response.json({ ok: true });
    }

    if (payload.action === "add_wallet") {
      if (!personName || !address || !label) {
        return Response.json(
          { error: "İsim, cüzdan etiketi ve adres gerekli." },
          { status: 400 },
        );
      }
      if (payload.chain !== "solana" && payload.chain !== "evm") {
        return Response.json({ error: "Geçerli bir ağ seç." }, { status: 400 });
      }
      if (payload.category !== "trade" && payload.category !== "funding") {
        return Response.json(
          { error: "Cüzdan türü trade veya funding olmalı." },
          { status: 400 },
        );
      }

      await db
        .delete(directoryDeletions)
        .where(
          and(
            eq(directoryDeletions.entityType, "person"),
            eq(directoryDeletions.entityKey, personName),
          ),
        );
      await db
        .delete(directoryDeletions)
        .where(
          and(
            eq(directoryDeletions.entityType, "wallet"),
            eq(directoryDeletions.entityKey, address),
          ),
        );
      await db
        .insert(directoryPeople)
        .values({ id: crypto.randomUUID(), name: personName })
        .onConflictDoNothing();
      await db.insert(directoryWallets).values({
        id: crypto.randomUUID(),
        personName,
        chain: payload.chain,
        category: payload.category,
        label,
        address,
        note,
      });

      return Response.json({ ok: true });
    }

    if (payload.action === "delete_wallet") {
      if (!address) {
        return Response.json({ error: "Cüzdan adresi gerekli." }, { status: 400 });
      }

      await db
        .delete(directoryWallets)
        .where(eq(directoryWallets.address, address));
      await db
        .insert(directoryDeletions)
        .values({
          id: crypto.randomUUID(),
          entityType: "wallet",
          entityKey: address,
        })
        .onConflictDoNothing();

      return Response.json({ ok: true });
    }

    if (payload.action === "update_wallet_classification") {
      if (!address || !label) {
        return Response.json(
          { error: "Cüzdan adresi ve etiketi gerekli." },
          { status: 400 },
        );
      }
      if (payload.category !== "trade" && payload.category !== "funding") {
        return Response.json(
          { error: "Cüzdan türü trade veya funding olmalı." },
          { status: 400 },
        );
      }

      await db
        .update(directoryWallets)
        .set({
          category: payload.category,
          label,
        })
        .where(eq(directoryWallets.address, address));

      return Response.json({ ok: true });
    }

    return Response.json({ error: "Geçersiz işlem." }, { status: 400 });
  } catch (error) {
    const message = errorMessage(error);
    const status = message.includes("UNIQUE") ? 409 : 500;
    return Response.json(
      {
        error:
          status === 409
            ? "Bu cüzdan adresi dizinde zaten bulunuyor."
            : message,
      },
      { status },
    );
  }
}
