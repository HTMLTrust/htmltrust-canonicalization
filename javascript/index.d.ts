/**
 * Options for normalizeText.
 */
export interface NormalizeOptions {
  /** Set true for content inside <pre> elements. Default: false. */
  preserveWhitespace?: boolean;
}

/**
 * Normalize text content for canonical signing.
 * Implements all 8 phases of the HTMLTrust canonicalization spec.
 *
 * @param text - Raw text content
 * @param options - Normalization options
 * @returns Normalized text
 */
export function normalizeText(text: string, options?: NormalizeOptions): string;
