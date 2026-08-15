/**
 * Browser MediaRecorder capture for voice dictation.
 * Host performs STT; this module only obtains a blob.
 */

export type CaptureHandle = {
  stop: () => Promise<Blob>;
  cancel: () => void;
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

/**
 * Start microphone capture. Resolves when recording has actually started.
 * `stop()` returns the recorded blob; `cancel()` aborts without waiting for data.
 */
export async function startVoiceCapture(): Promise<CaptureHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("mic_missing"), { code: "mic_missing" });
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      throw Object.assign(new Error("mic_denied"), { code: "mic_denied" });
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      throw Object.assign(new Error("mic_missing"), { code: "mic_missing" });
    }
    throw e;
  }

  const mime = pickMimeType();
  const recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime })
    : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  let settled = false;

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  const stopTracks = () => {
    for (const t of stream.getTracks()) t.stop();
  };

  const blobPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => {
      if (settled) return;
      settled = true;
      stopTracks();
      reject(new Error("recorder_error"));
    };
    recorder.onstop = () => {
      if (settled) return;
      settled = true;
      stopTracks();
      const type = recorder.mimeType || mime || "audio/webm";
      resolve(new Blob(chunks, { type }));
    };
  });

  recorder.start(250);

  return {
    stop: async () => {
      if (recorder.state === "inactive") {
        stopTracks();
        return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      }
      recorder.stop();
      return blobPromise;
    },
    cancel: () => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* ignore */
      }
      stopTracks();
      settled = true;
    },
  };
}

/** Blob → base64 (no data: prefix) for Host invoke. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function extensionForMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}
