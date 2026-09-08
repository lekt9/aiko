import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MediaFixture,
  MediaHarnessConfig,
} from "../../src/harness-media.ts";

export async function mediaCommand(
  argv: string[],
  input?: Uint8Array,
  timeoutMs = 30000,
) {
  const child = Bun.spawn(argv, {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
    },
  });
  if (input) {
    child.stdin!.write(input);
    child.stdin!.end();
  }
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0)
      throw Error(`Fixture process failed (${code}): ${stderr.slice(-1600)}`);
    return new Uint8Array(stdout);
  } finally {
    clearTimeout(timer);
  }
}
export async function createMediaFixtures() {
  const directory = await mkdtemp(join(tmpdir(), "pinned-media-fixture-"));
  const ffmpeg = (...args: string[]) =>
    mediaCommand([
      "/usr/bin/ffmpeg",
      "-nostdin",
      "-v",
      "error",
      "-threads",
      "1",
      ...args,
      "-y",
    ]);
  const phrases = {
    "speech.wav": "The quick brown fox jumps over the lazy dog.",
    "held-out.wav": "Please bring the blue book to the kitchen tomorrow.",
  };
  for (const [name, phrase] of Object.entries(phrases))
    await mediaCommand([
      "/usr/bin/espeak-ng",
      "-v",
      "en-us",
      "-s",
      "135",
      "-w",
      join(directory, name),
      phrase,
    ]);
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x120:r=10:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x120:r=10:d=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "mpeg4",
    join(directory, "video.mp4"),
  );
  await ffmpeg(
    "-i",
    join(directory, "video.mp4"),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    join(directory, "audiovisual.mp4"),
  );
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "3",
    "-c:a",
    "pcm_s16le",
    join(directory, "silence.wav"),
  );
  await writeFile(join(directory, "malformed.bin"), "not a media container");
  const duration = async (name: string) =>
    Number(
      JSON.parse(
        new TextDecoder().decode(
          await mediaCommand([
            "/usr/bin/ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            join(directory, name),
          ]),
        ),
      ).format.duration,
    );
  const audioStream = {
    index: 0,
    kind: "audio",
    codec: "pcm_s16le",
    sample_rate: 16000,
    channels: 1,
  };
  const videoStream = {
    index: 0,
    kind: "video",
    codec: "mpeg4",
    width: 160,
    height: 120,
  };
  const fixtures: MediaFixture[] = [
    {
      id: "probe-av",
      split: "development",
      capability: "media.probe",
      input: { asset: "audiovisual.mp4" },
      expected: {
        status: "ok",
        durationSeconds: 2,
        streams: [
          videoStream,
          {
            index: 1,
            kind: "audio",
            codec: "aac",
            sample_rate: 44100,
            channels: 1,
          },
        ],
      },
    },
    {
      id: "probe-video",
      split: "held-out",
      capability: "media.probe",
      input: { asset: "video.mp4" },
      expected: { status: "ok", durationSeconds: 2, streams: [videoStream] },
    },
    {
      id: "probe-silence",
      split: "held-out",
      capability: "media.probe",
      input: { asset: "silence.wav" },
      expected: { status: "ok", durationSeconds: 3, streams: [audioStream] },
    },
    {
      id: "probe-malformed",
      split: "held-out",
      capability: "media.probe",
      input: { asset: "malformed.bin" },
      expected: { status: "invalid_media" },
    },
    {
      id: "frames-colors",
      split: "development",
      capability: "media.frames",
      input: { asset: "video.mp4", timestamps: [0.05, 1.05] },
      expected: {
        status: "ok",
        durationSeconds: 2,
        frames: [
          {
            atSeconds: 0.1,
            toleranceSeconds: 0.001,
            width: 320,
            height: 240,
            solidRgb: [253, 0, 0],
            colorTolerance: 8,
          },
          {
            atSeconds: 1.1,
            toleranceSeconds: 0.001,
            width: 320,
            height: 240,
            solidRgb: [0, 0, 254],
            colorTolerance: 8,
          },
        ],
      },
    },
    {
      id: "frames-av",
      split: "held-out",
      capability: "media.frames",
      input: { asset: "audiovisual.mp4", timestamps: [0, 1.5] },
      expected: {
        status: "ok",
        durationSeconds: 2,
        frames: [
          {
            atSeconds: 0,
            toleranceSeconds: 0.001,
            width: 320,
            height: 240,
            solidRgb: [253, 0, 0],
            colorTolerance: 8,
          },
          {
            atSeconds: 1.5,
            toleranceSeconds: 0.001,
            width: 320,
            height: 240,
            solidRgb: [0, 0, 254],
            colorTolerance: 8,
          },
        ],
      },
    },
    {
      id: "frames-no-video",
      split: "held-out",
      capability: "media.frames",
      input: { asset: "silence.wav", timestamps: [0] },
      expected: { status: "no_video", durationSeconds: 3 },
    },
    {
      id: "speech",
      split: "development",
      capability: "media.transcribe",
      input: { asset: "speech.wav", language: "en" },
      expected: {
        status: "transcribed",
        durationSeconds: await duration("speech.wav"),
        transcript: phrases["speech.wav"],
        maxWordErrorRate: 0.35,
      },
    },
    {
      id: "held-out-speech",
      split: "held-out",
      capability: "media.transcribe",
      input: { asset: "held-out.wav", language: "en" },
      expected: {
        status: "transcribed",
        durationSeconds: await duration("held-out.wav"),
        transcript: phrases["held-out.wav"],
        maxWordErrorRate: 0.35,
      },
    },
    {
      id: "silence",
      split: "held-out",
      capability: "media.transcribe",
      input: { asset: "silence.wav", language: "en" },
      expected: { status: "no_speech", durationSeconds: 3 },
    },
    {
      id: "no-audio",
      split: "held-out",
      capability: "media.transcribe",
      input: { asset: "video.mp4" },
      expected: { status: "no_audio", durationSeconds: 2 },
    },
  ];
  const decodeFrame: MediaHarnessConfig["decodeFrame"] = async (
    data,
    signal,
  ) => {
    signal.throwIfAborted();
    const bytes = Buffer.from(data, "base64");
    const frame = join(directory, `check-${crypto.randomUUID()}.jpg`);
    await writeFile(frame, bytes);
    try {
      const info = JSON.parse(
        new TextDecoder().decode(
          await mediaCommand([
            "/usr/bin/ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            frame,
          ]),
        ),
      ).streams[0];
      if (info.width > 320 || info.height > 320)
        throw Error("Frame check budget");
      const pixels = await mediaCommand([
        "/usr/bin/ffmpeg",
        "-v",
        "error",
        "-threads",
        "1",
        "-i",
        frame,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-threads",
        "1",
        "pipe:1",
      ]);
      const minRgb: [number, number, number] = [255, 255, 255],
        maxRgb: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < pixels.length; i++) {
        minRgb[i % 3] = Math.min(minRgb[i % 3]!, pixels[i]!);
        maxRgb[i % 3] = Math.max(maxRgb[i % 3]!, pixels[i]!);
      }
      return {
        width: info.width,
        height: info.height,
        pixelDigest:
          `sha256:${createHash("sha256").update(pixels).digest("hex")}` as `sha256:${string}`,
        minRgb,
        maxRgb,
      };
    } finally {
      await rm(frame, { force: true });
    }
  };
  return {
    directory,
    fixtures,
    decodeFrame,
    bytes: (name: string) => readFile(join(directory, name)),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
