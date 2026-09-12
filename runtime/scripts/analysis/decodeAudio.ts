import { spawn } from "node:child_process";

/**
 * Decodes any audio file to mono float32 PCM using ffmpeg.
 *
 * The benchmark needs thousands of decodes, so this streams raw f32le on
 * stdout rather than writing intermediate files.
 */
export async function decodeMono(path: string, sampleRate: number): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-i", path,
        "-map", "0:a:0",
        "-ac", "1",
        "-ar", String(sampleRate),
        "-f", "f32le",
        "-"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited ${code} for ${path}: ${stderr.trim().slice(0, 400)}`));
    });
  });

  const bytes = Buffer.concat(chunks, totalBytes);
  // Buffer may not be 4-byte aligned for a Float32Array view, so copy.
  const samples = new Float32Array(Math.floor(bytes.length / 4));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readFloatLE(index * 4);
  }
  return samples;
}
