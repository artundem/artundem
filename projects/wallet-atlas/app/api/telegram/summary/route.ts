import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { telegramSummaryJobs } from "../../../../db/schema";

type SummaryResponse = {
  chatId: string;
  title: string;
  text: string;
  receivedAt: string;
};

function serializeJob(job: typeof telegramSummaryJobs.$inferSelect) {
  let responses: SummaryResponse[] = [];
  try {
    responses = JSON.parse(job.responsesJson) as SummaryResponse[];
  } catch {
    responses = [];
  }
  return {
    jobId: job.id,
    status: job.status,
    command: "/summary@ray_blue_bot",
    responses,
    requestedAt: job.requestedAt,
    completedAt: job.completedAt,
    error: job.error,
  };
}

export async function POST() {
  try {
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      status: "pending" as const,
      requestedAt: now,
    };
    await getDb().insert(telegramSummaryJobs).values(job);
    return Response.json(
      {
        jobId: job.id,
        status: job.status,
        command: "/summary@ray_blue_bot",
        responses: [],
        requestedAt: now,
        completedAt: null,
        error: null,
      },
      { status: 202 },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Özet işi oluşturulamadı.",
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("id");
  if (!jobId) {
    return Response.json({ error: "Özet iş kimliği eksik." }, { status: 400 });
  }

  try {
    const [job] = await getDb()
      .select()
      .from(telegramSummaryJobs)
      .where(eq(telegramSummaryJobs.id, jobId))
      .limit(1);
    if (!job) {
      return Response.json({ error: "Özet işi bulunamadı." }, { status: 404 });
    }
    return Response.json(serializeJob(job));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Özet sonucu alınamadı.",
      },
      { status: 500 },
    );
  }
}
