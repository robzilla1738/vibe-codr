import { generateText, type LanguageModel } from "ai";
import type { VisionRelayConfig } from "@vibe/config";
import type { Logger } from "@vibe/shared";
import type { ImageAttachment } from "./mentions.ts";

/**
 * Vision relay: when the active (primary) model does NOT accept image input,
 * attached images are captioned by a SEPARATE vision-capable relay model and
 * the resulting text descriptions are injected into the user's prompt in place
 * of the raw image bytes.
 *
 * This is the industry-standard "vision relay" / "image captioning relay"
 * pattern used by multi-model routers (LiteLLM, OpenRouter, LangChain
 * multi-modal chains): a text-only model gains "eyes" by delegating vision to a
 * model that supports it, then consuming the caption as text context. The
 * primary model never sees the raw image — it sees a rich, structured text
 * description produced by the relay.
 *
 * The relay is opt-in (`vision.relay.enabled: true` + `vision.relay.relayModel:
 * "<provider>/<model>"`). When disabled or when the primary model DOES support
 * images, images pass through unchanged. When enabled but the relay call fails
 * (provider down, timeout, missing key), the relay degrades gracefully: a short
 * placeholder note replaces the image so the primary model at least knows an
 * image was attached and what its filename was — never a silent drop.
 */

/** One image's caption (or a graceful-degradation placeholder on failure). */
export interface CaptionResult {
  /** The original attachment path (for the injected context block header). */
  path: string;
  /** The caption text, or a degradation note when the relay call failed. */
  caption: string;
  /** True when the relay call failed and `caption` is a placeholder. */
  degraded: boolean;
}

/** The outcome of a relay pass: captions for every image + whether ANY ran. */
export interface RelayResult {
  /** One CaptionResult per input image, in order. */
  captions: CaptionResult[];
  /** True when every image was successfully captioned (none degraded). */
  allSucceeded: boolean;
}

/**
 * The prompt sent to the relay vision model. Structured for the primary model's
 * consumption: visual description, text content (OCR), layout, and relevant
 * details — concise but thorough, since the primary model relies entirely on
 * this text to "see" the image. Capped at `maxCaptionChars` by the caller.
 */
function captionPrompt(maxChars: number): string {
  return (
    "You are a vision relay for a coding agent. Describe this image so a text-only " +
    "model can act on it as if it saw the image directly. Be thorough but concise " +
    `(target ≤ ${maxChars} chars). Structure your response as:\n` +
    "1. **Visual description**: What the image shows — UI layout, diagrams, screenshots, photos, code snippets rendered as images, etc.\n" +
    "2. **Text content**: Any visible text, labels, code, error messages, or console output (transcribe verbatim when legible).\n" +
    "3. **Layout & structure**: Spatial relationships, component positions, color coding, arrows/annotations.\n" +
    "4. **Key details**: Anything a developer would need to act on this image — error codes, file names, button labels, diffs, stack traces.\n\n" +
    "If the image is a screenshot of a terminal/IDE/browser, transcribe the visible text faithfully. " +
    "If it's a diagram or chart, describe the structure and data. If it's a photo of a whiteboard or hand-drawn sketch, describe the content legibly. " +
    "Do NOT add commentary, suggestions, or analysis beyond what's visible — just describe what's there."
  );
}

/** The graceful-degradation note when a relay call fails. */
function degradationNote(img: ImageAttachment, error: string): string {
  return (
    `[vision relay could not caption this image: ${error}. ` +
    `File: ${img.path} (${img.mediaType}). ` +
    "The primary model will not see the image contents.]"
  );
}

/**
 * Caption a single image via the relay vision model. Returns a CaptionResult —
 * either the model's text description or a degradation note on any failure.
 * Never throws: all errors are caught and turned into a degraded caption.
 */
async function captionOne(
  model: LanguageModel,
  img: ImageAttachment,
  config: VisionRelayConfig,
  signal: AbortSignal,
  log?: Logger,
): Promise<CaptionResult> {
  const maxChars = config.maxCaptionChars;
  try {
    const { text } = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: captionPrompt(maxChars) },
            {
              type: "file",
              data: { type: "data", data: img.data },
              mediaType: img.mediaType as
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp",
            },
          ],
        },
      ],
      abortSignal: AbortSignal.any([
        signal,
        AbortSignal.timeout(config.timeoutMs),
      ]),
      maxRetries: 1,
    });
    const caption = text.trim();
    if (!caption) {
      const note = degradationNote(img, "the relay model returned an empty response");
      return { path: img.path, caption: note, degraded: true };
    }
    // Cap the caption so a verbose vision model can't flood the primary's context.
    const capped =
      caption.length > maxChars
        ? `${caption.slice(0, maxChars)}…\n…(caption truncated at ${maxChars} chars)`
        : caption;
    return { path: img.path, caption: capped, degraded: false };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    log?.debug(`vision relay caption failed for ${img.path}: ${msg}`);
    return {
      path: img.path,
      caption: degradationNote(img, msg),
      degraded: true,
    };
  }
}

/**
 * Caption all images in parallel via the relay model. Returns one CaptionResult
 * per image, in the same order. The primary model's prompt is then augmented
 * with these captions (see {@link captionsToContextBlock}) and the raw image
 * bytes are NOT passed to the primary model.
 *
 * `resolveRelayModel` is injected so this module stays pure w.r.t. the provider
 * registry (and testable without a real provider). It should resolve and return
 * a `LanguageModel`, or throw — the caller wraps the throw into a degradation
 * note for every image.
 */
export async function captionImages(
  images: ImageAttachment[],
  config: VisionRelayConfig,
  resolveRelayModel: () => Promise<LanguageModel>,
  signal: AbortSignal,
  log?: Logger,
): Promise<RelayResult> {
  // Resolve the relay model once; if it fails, every image degrades.
  let model: LanguageModel;
  try {
    model = await resolveRelayModel();
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    log?.debug(`vision relay model resolution failed: ${msg}`);
    return {
      captions: images.map((img) => ({
        path: img.path,
        caption: degradationNote(img, `relay model unavailable: ${msg}`),
        degraded: true,
      })),
      allSucceeded: false,
    };
  }

  // Caption all images in parallel — independent provider calls.
  const captions = await Promise.all(
    images.map((img) => captionOne(model, img, config, signal, log)),
  );
  return {
    captions,
    allSucceeded: captions.every((c) => !c.degraded),
  };
}

/**
 * Render caption results as a context block appended to the user's prompt text.
 * Each image becomes a fenced block with the filename and the relay's
 * description. The primary model sees this text instead of the raw image.
 */
export function captionsToContextBlock(captions: CaptionResult[]): string {
  const blocks = captions.map((c) => {
    const header = c.degraded
      ? `--- image: ${c.path} (relay degraded) ---`
      : `--- image: ${c.path} (vision relay description) ---`;
    return `${header}\n${c.caption}`;
  });
  return blocks.join("\n\n");
}

/**
 * Whether the vision relay should run for this turn. True when:
 *   - `vision.relay.enabled` is true,
 *   - a `relayModel` is configured,
 *   - images were attached, and
 *   - the primary model does NOT support image input (`supportsImages` is false).
 *
 * When `supportsImages` is `undefined` (catalog not loaded / model unknown), the
 * relay does NOT run — we give the primary model the benefit of the doubt and
 * pass images through directly (the existing behavior). This avoids an
 * unnecessary relay call for a model that might actually support vision, and
 * matches the existing `#supportsImages` usage in the engine (which only warns
 * when `ok === false`).
 */
export function shouldRelay(
  config: VisionRelayConfig,
  hasImages: boolean,
  primarySupportsImages: boolean | undefined,
): boolean {
  if (!config.enabled || !config.relayModel || !hasImages) return false;
  // Only relay when we KNOW the primary model can't handle images.
  return primarySupportsImages === false;
}
