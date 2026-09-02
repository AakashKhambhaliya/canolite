/**
 * Audio mixing shared by both video renderers.
 *
 * The legacy Chromium pipeline extracts each layer's audio to a separate file
 * and feeds those files as extra ffmpeg inputs; the fast path references the
 * (separately opened, trimmed) source inputs directly. Either way the mixing
 * math is identical: delay each track to its startAt, scale by its volume,
 * then amix — so it lives here once.
 */
export interface AudioMixEntry {
  /** ffmpeg input index carrying this layer's (already trimmed) audio. */
  inputIndex: number;
  startAtSec: number;
  volume: number;
}

export interface AudioMixPlan {
  /** Filter fragments like "[3:a]adelay=1500|1500,volume=0.8[a0]". */
  filters: string[];
  /** "[aout]" — map this when filters is non-empty. */
  outputLabel: string;
}

export function buildAudioMixFilters(
  entries: AudioMixEntry[],
  opts: { padToSec?: number } = {}
): AudioMixPlan {
  if (entries.length === 0) return { filters: [], outputLabel: "[aout]" };

  const filters: string[] = [];
  entries.forEach((entry, idx) => {
    const delayMs = Math.max(0, Math.round(entry.startAtSec * 1000));
    const volume = Math.max(0, entry.volume || 1);
    filters.push(`[${entry.inputIndex}:a]adelay=${delayMs}|${delayMs},volume=${volume}[a${idx}]`);
  });
  // padToSec (fast path): extend the mix with silence until the output
  // duration, so every stream ends exactly there (the output is bounded by
  // -t, not -shortest — see filtergraph.ts: `-shortest` + adelay→amix makes
  // ffmpeg 7 drop the video stream entirely).
  const pad = opts.padToSec !== undefined ? `,apad=whole_dur=${opts.padToSec}` : "";
  filters.push(
    `${entries.map((_, idx) => `[a${idx}]`).join("")}amix=inputs=${entries.length}:dropout_transition=0${pad}[aout]`
  );
  return { filters, outputLabel: "[aout]" };
}

/**
 * An ffmpeg layer wants audio exactly when the design says so and the volume
 * is audible — mirrors the audio-extraction condition in decode.ts.
 */
export function layerWantsAudio(layer: { hasAudio: boolean; muted: boolean; volume: number }): boolean {
  return layer.hasAudio && !layer.muted && layer.volume > 0;
}
