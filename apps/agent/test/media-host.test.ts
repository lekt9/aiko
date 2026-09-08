import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import {
  createPythonSandboxRuntime,
  type SandboxPythonRuntime,
} from "../src/sandbox-python.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import {
  runSandboxJob,
  sandboxEnvironment,
} from "../src/sandbox-job-runner.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import type { SandboxJob } from "../src/sandbox-job.ts";
import { harnessDigest } from "../src/harness-library.ts";
import { registryExternalEventAllowed } from "../src/registry-host.ts";
let runtime: SandboxPythonRuntime;
beforeAll(async () => {
  runtime = await createPythonSandboxRuntime({
    packages:
      process.env.MEDIA_HARNESS_PACKAGES ??
      "/tmp/unlock-media-runtime/lib/python3.13/site-packages",
    models:
      process.env.MEDIA_HARNESS_MODELS ??
      "/tmp/unlock-media-multilingual-models",
    tools: { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" },
    sharedLibraries: ["/usr/lib/libSDL3.so.0"],
  });
  expect(runtime.lock.version).toBe(2);
}, 300000);
afterAll(() => runtime?.dispose());
function silence(seconds: number) {
  const b = Buffer.alloc(44 + seconds * 32000);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b.toString("base64");
}
const token = "aiko_media_host_fixture_token_12345678901234567890";
for (const language of ["en", "es"] as const)
  test(`default real host privately acquires ${language} media, hydrates prompt and reuses verified executables after disk reopen`, async () => {
    const dir = await mkdtemp("/tmp/media-host-"),
      db = new Database(join(dir, "jobs.sqlite")),
      journal = await sandboxJobJournal(db, join(dir, "receipt.key")),
      environmentDigest = await sandboxEnvironment("media-host-native-v2");
    const firstData =
      language === "es"
        ? (
            await readFile(
              new URL(
                "./fixtures/media-multilingual/com_00610_00008909944.wav",
                import.meta.url,
              ),
            )
          ).toString("base64")
        : silence(1);
    let telegramData = silence(1), telegramMime = "audio/wav";
    let uncertain = false,
      wrongRuntime = false;
    let jobs: SandboxJob[] = [],
      seen: string[] = [],
      sent: Array<{url:string;body:any}> = [],
      service: Awaited<ReturnType<typeof createService>>;
    const config: AikoConfig = {
      mode: "live",
      replyStyle: "direct",
      codeMode: true,
      port: 4242,
      stateDir: dir,
      operatorToken: "operator-private-media-fixture",
      persona: PERSONA,
      voiceEnabled: false,
      botToken: "123:test-only",
      webhookSecret: "test_webhook_secret_123456789012345",
      allowedUsers: new Set(["123"]),
      planeCredentials: [
        {
          account: "123",
          digest: credentialDigest(token),
          scopes: ["read", "write"],
        },
      ],
    };
    const overrides = {
      telegramFetch: async (input: any, init?: any) => {
        const url = String(input);
        if (url.endsWith("/sendMessage")) sent.push({url,body:JSON.parse(String(init?.body ?? "{}"))});
        if (url.endsWith("/getFile"))
          return Response.json({
            ok: true,
            result: { file_id: "fixture_voice", file_path: "fixture.wav" },
          });
        if (url.includes("/file/bot"))
          return new Response(Buffer.from(telegramData, "base64"), {
            headers: { "content-type": telegramMime },
          });
        return Response.json({
          ok: true,
          result: { message_id: 101, chat: { id: 123 } },
        });
      },
      registrySandbox: () => ({
        placement: "local" as const,
        codeTransport: runCodeSegment,
        sandbox: {
          get pythonRuntimeLockDigest() {
            return wrongRuntime
              ? harnessDigest("wrong-runtime")
              : runtime.lockDigest;
          },
          harnessEnvironment: async () => environmentDigest,
          harnessJob: async (job: SandboxJob, signal?: AbortSignal) => {
            jobs.push(job);
            if (uncertain && String(job.input.asset).startsWith("media-"))
              throw Error("controlled lost compute acknowledgement");
            return runSandboxJob(
              job,
              { owner: "123", environmentDigest, python: runtime, journal },
              signal,
            );
          },
        },
      }),
      model: Layer.succeed(Infer, {
        resolve: () => ({
          model: { provider: "fixture", model_id: "media-native" },
        }),
        react: (request: any) => {
          seen.push(JSON.stringify(request.trajectory));
          const message = request.trajectory.findLast((e:any)=>e.type === "MessageReceived" && e.mediaOperationId);
          if (message && !request.trajectory.some((e:any)=>e.type === "ToolReturned" && e.turn === request.identity.turn)) {
            return Effect.succeed({kind:"call" as const,name:"execute",callId:`media-inspect-${request.identity.turn}`,arguments:{code:`return await tools.call({name:"media_result",arguments:${JSON.stringify({channel:message.channel,operationId:message.mediaOperationId,contentRef:message.mediaContentRef})}});`}});
          }
          return Effect.succeed({
            kind: "complete" as const,
            output: "Media status checked.",
          });
        },
      }),
    };
    const post = (id: string, text: string, data: string, mimeType = "audio/wav") =>
      service.fetch(
        new Request("http://localhost/api/media", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id,
            language,
            text,
            media: { data, mimeType },
          }),
        }),
      );
    try {
      service = await createService(config, overrides);
      if (language === "es") {
        expect(
          (await post("no_catalog_00", "not granted", firstData)).status,
        ).not.toBe(202);
        expect(
          (
            await service.fetch(
              new Request("http://localhost/api/media/catalog", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ variant: "multilingual" }),
              }),
            )
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await post(
            "first_media_01",
            "Private caption ALPHA_MEDIA_ONLY",
            firstData,
          )
        ).status,
      ).toBe(202);
      await service.host.wake("user-123");
      let rows = await service.host.read("user-123");
      expect(rows.filter((e) => e.type === "AikoMediaCompleted")).toHaveLength(
        1,
      );
      expect(rows.find((e) => e.type === "AikoMediaCompleted")?.status).toBe(
        "processed",
      );
      expect(
        rows.filter(
          (e) =>
            e.type === "MessageReceived" && e.id === "media:first_media_01",
        ),
      ).toHaveLength(1);
      expect(
        seen.some(
          (s) =>
            s.includes("ALPHA_MEDIA_ONLY") &&
            s.includes("untrusted-attachment-input"),
        ),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("ALPHA_MEDIA_ONLY");
      const acquired = rows.filter(
        (e) => e.type === "AikoHarnessAcquisitionSettled",
      ).length;
      expect(acquired).toBeGreaterThan(0);
      await service.host.seed("user-123", [
        { type: "AikoMediaCompleted", owner: "123", id: "forged" },
        { type: "MediaAtomicFenceSentinel" },
      ]);
      expect(
        (await service.host.read("user-123")).some(
          (e) => e.type === "MediaAtomicFenceSentinel",
        ),
      ).toBe(false);
      await service.host.wake("background-123-indexer");
      const skillRows = await service.host.read("background-123-indexer");
      expect(skillRows.some(e=>e.type === "AikoHarnessSkillDerived")).toBe(true);
      const firstDigests = rows.filter(e=>e.type === "AikoHarnessPromoted").map(e=>e.harnessDigest).sort();
      expect(firstDigests.length).toBeGreaterThan(0);
      const firstJobs = jobs.length;
      await service.close();
      service = await createService(config, overrides);
      expect(
        (
          await post(
            "first_media_01",
            "Private caption ALPHA_MEDIA_ONLY",
            firstData,
          )
        ).status,
      ).toBe(202);
      await service.host.wake("user-123");
      expect(jobs.length).toBe(firstJobs);
      expect(
        (
          await post(
            "second_media_02",
            "Private caption BETA_MEDIA_ONLY",
            silence(2),
          )
        ).status,
      ).toBe(202);
      await service.host.wake("user-123");
      rows = await service.host.read("user-123");
      expect(
        rows.filter(
          (e) => e.type === "AikoMediaCompleted" && e.status === "processed",
        ),
      ).toHaveLength(2);
      expect(
        rows.filter(
          (e) =>
            e.type === "AikoHarnessCandidateRecorded" &&
            (e.artifact as any)?.runtime === "python",
        ).length,
      ).toBeLessThanOrEqual(2);
      expect(jobs.length).toBeGreaterThan(firstJobs);
      expect(
        jobs
          .slice(firstJobs)
          .every((j) => !String((j.input as any).asset).endsWith(".wav")),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("BETA_MEDIA_ONLY");
      const chunks: Buffer[] = [];
      const visit = async (p: string) => {
        for (const e of await readdir(p, { withFileTypes: true })) {
          const f = join(p, e.name);
          if (e.isDirectory()) await visit(f);
          else if (/sqlite(?:-wal|-shm)?$/.test(e.name))
            chunks.push(await readFile(f));
        }
      };
      await visit(dir);
      expect(Buffer.concat(chunks).toString()).not.toContain(
        "ALPHA_MEDIA_ONLY",
      );
      expect(
        (
          await service.fetch(
            new Request("http://localhost/api/media", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            }),
          )
        ).status,
      ).toBe(401);
      expect(registryExternalEventAllowed({ type: "AikoMediaCompleted" })).toBe(
        false,
      );
      const telegramRequest = (user: number, update = 901, video = false) =>
        service.fetch(
          new Request("http://localhost/telegram/webhook", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": config.webhookSecret!,
            },
            body: JSON.stringify({
              update_id: update,
              message: {
                message_id: update,
                date: Math.floor(Date.now() / 1000),
                caption: "TELEGRAM_PRIVATE_GAMMA",
                from: { id: user, is_bot: false, language_code: language },
                chat: { id: user, type: "private" },
                [video ? "video" : "voice"]: {
                  file_id: "fixture_voice",
                  mime_type: telegramMime,
                  duration: 1,
                },
              },
            }),
          }),
        );
      expect((await telegramRequest(999)).status).toBe(200);
      expect(await service.host.read("user-999")).toHaveLength(0);
      expect((await telegramRequest(123)).status).toBe(200);
      await service.host.wake("user-123");
      rows = await service.host.read("user-123");
      expect(
        rows.filter(
          (e) => e.type === "MessageReceived" && e.id === "telegram:901",
        ),
      ).toHaveLength(1);
      expect(
        rows.find(
          (e) => e.type === "AikoMediaCompleted" && e.id === "telegram:901",
        )?.status,
      ).toBe("processed");
      expect(seen.some((x) => x.includes("TELEGRAM_PRIVATE_GAMMA"))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("TELEGRAM_PRIVATE_GAMMA");
      expect(rows.filter(e=>e.type === "AikoHarnessPromoted").map(e=>e.harnessDigest).sort()).toEqual(firstDigests);
      expect(sent.map(s=>s.body)).toContainEqual(expect.objectContaining({chat_id:"123",text:"Media status checked."}));
      const telegramJobs = jobs.length;
      await service.close();
      service = await createService(config, overrides);
      await telegramRequest(123);
      await service.host.wake("user-123");
      expect(jobs.length).toBe(telegramJobs);
      if (language === "en") {
        const video = (await readFile(new URL("./fixtures/video-crossing/crossing-safe.mp4", import.meta.url))).toString("base64");
        expect((await post("video_api_001", "Describe only verified sampled coverage", video, "video/mp4")).status).toBe(202);
        await service.host.wake("user-123");
        const videoRows = await service.host.read("user-123");
        expect(videoRows.find(e=>e.type === "AikoMediaCompleted" && e.id === "media:video_api_001")?.status).toBe("processed");
        const digests = videoRows.filter(e=>e.type === "AikoHarnessPromoted").map(e=>e.harnessDigest).sort();
        const beforeVideoReuse = jobs.length;
        const beforeEvaluations = videoRows.filter(e=>e.type === "AikoHarnessEvaluationStarted").length;
        telegramData=video; telegramMime="video/mp4";
        await service.close(); service=await createService(config,overrides);
        expect((await telegramRequest(123,902,true)).status).toBe(200);
        await service.host.wake("user-123");
        const reused = await service.host.read("user-123");
        expect(reused.find(e=>e.type === "AikoMediaCompleted" && e.id === "telegram:902")?.status).toBe("processed");
        expect(reused.filter(e=>e.type === "AikoHarnessPromoted").map(e=>e.harnessDigest).sort()).toEqual(digests);
        expect(reused.filter(e=>e.type === "AikoHarnessEvaluationStarted")).toHaveLength(beforeEvaluations);
        expect(jobs.slice(beforeVideoReuse).filter(j=>j.artifact.kind === "python").every(j=>String(j.input.asset).startsWith("media-") || (j.artifact.kind === "python" && j.artifact.entry === "evidence.py" && j.input.mode === "pixels" && j.input.asset === "frame.jpg"))).toBe(true);
      }
      uncertain = true;
      expect(
        (await post("unknown_media_03", "PRIVATE_UNKNOWN_DELTA", silence(1)))
          .status,
      ).toBe(202);
      await service.host.wake("user-123");
      const unknownJobs = jobs.length;
      rows = await service.host.read("user-123");
      expect(
        rows.find(
          (e) =>
            e.type === "AikoMediaCompleted" &&
            e.id === "media:unknown_media_03",
        )?.status,
      ).toBe("unknown");
      await service.close();
      service = await createService(config, overrides);
      await post("unknown_media_03", "PRIVATE_UNKNOWN_DELTA", silence(1));
      await service.host.wake("user-123");
      expect(jobs.length).toBe(unknownJobs);
      expect(
        (await post("first_media_01", "changed private prompt", silence(1)))
          .status,
      ).toBe(409);
      uncertain = false;
      wrongRuntime = true;
      await service.close();
      service = await createService(config, overrides);
      expect(
        (await post("wrong_runtime_05", "runtime mismatch", silence(1))).status,
      ).toBe(202);
      await service.host.wake("user-123");
      const wrongRows = await service.host.read("user-123");
      expect(
        wrongRows.find(
          (e) =>
            e.type === "AikoMediaCompleted" &&
            e.id === "media:wrong_runtime_05",
        )?.status,
      ).toBe("unknown"); // The mismatch follows a native claim: retain uncertainty, never retry.
      const afterWrong = jobs.length;
      await service.close();
      service = await createService(config, overrides);
      await post("wrong_runtime_05", "runtime mismatch", silence(1));
      await service.host.wake("user-123");
      expect(jobs.length).toBe(afterWrong);
      config.codeMode = false;
      expect(
        (await post("denied_media_04", "denied", silence(1))).status,
      ).not.toBe(202);
      expect(jobs.length).toBe(afterWrong);
    } finally {
      await service!?.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 300000);
