import { env } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { telegramSummaryJobs } from "../../../../../db/schema";

type AgentPayload = {
  jobId?: string;
  responses?: unknown[];
  error?: string;
};

function authorized(request: Request) {
  const secret = (env as unknown as { WALLET_ATLAS_AGENT_SECRET?: string })
    .WALLET_ATLAS_AGENT_SECRET;
  return Boolean(
    secret &&
      request.headers.get("x-wallet-atlas-agent-secret") === secret,
  );
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Yetkisiz." }, { status: 401 });
  }

  const db = getDb();
  const [job] = await db
    .select()
    .from(telegramSummaryJobs)
    .where(eq(telegramSummaryJobs.status, "pending"))
    .orderBy(asc(telegramSummaryJobs.requestedAt))
    .limit(1);

  if (!job) return new Response(null, { status: 204 });

  const now = new Date().toISOString();
  const claimed = await db
    .update(telegramSummaryJobs)
    .set({ status: "processing", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(telegramSummaryJobs.id, job.id),
        eq(telegramSummaryJobs.status, "pending"),
      ),
    )
    .returning({ id: telegramSummaryJobs.id });

  if (claimed.length === 0) return new Response(null, { status: 204 });
  return Response.json({ jobId: job.id, requestedAt: job.requestedAt });
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Yetkisiz." }, { status: 401 });
  }

  const payload = (await request.json()) as AgentPayload;
  if (!payload.jobId) {
    return Response.json({ error: "Özet iş kimliği eksik." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const failed = Boolean(payload.error);
  const updated = await getDb()
    .update(telegramSummaryJobs)
    .set({
      status: failed ? "failed" : "completed",
      responsesJson: JSON.stringify(payload.responses ?? []),
      error: payload.error ?? null,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(telegramSummaryJobs.id, payload.jobId))
    .returning({ id: telegramSummaryJobs.id });

  if (updated.length === 0) {
    return Response.json({ error: "Özet işi bulunamadı." }, { status: 404 });
  }
  return Response.json({ ok: true });
}
