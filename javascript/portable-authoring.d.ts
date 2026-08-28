export interface PortableAuthoringLocation {
  startOffset: number;
  endOffset: number | null;
  startLine: number;
  startColumn: number;
  endLine: number | null;
  endColumn: number | null;
  innerStartOffset: number;
  innerEndOffset: number | null;
  hasEndTag: boolean;
}

export interface PortableAuthoringDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  hint: string;
  region: number | null;
  context: Record<string, unknown>;
}

export interface PortableAuthoringRegion {
  index: number;
  status: "pass" | "fail";
  location: PortableAuthoringLocation | null;
  baseURL?: string;
  canonicalText?: string;
  canonicalClaims?: string;
  claims?: Record<string, string>;
  diagnostics: PortableAuthoringDiagnostic[];
}

export interface PortableAuthoringResult {
  profile: "htmltrust-portable-authoring-v1";
  ok: boolean;
  documentURL: string | null;
  baseURL: string | null;
  diagnostics: PortableAuthoringDiagnostic[];
  regions: PortableAuthoringRegion[];
}

/** Preflight every signed-section in a complete HTML document. */
export function preflightPortableDocument(
  html: string,
  options: { documentURL: string },
): PortableAuthoringResult;

/** Wrap a well-formed fragment without changing its v1 canonical output. */
export function wrapSignedSection(
  html: string,
  options?: { baseUrl?: string },
): string;
