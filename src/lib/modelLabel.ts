// Shorten a model id for display in the chat selector. The full id (often a
// GGUF metadata `general.name` or the on-disk filename) carries quantization
// + format suffixes that make the selector pill unreadably long — e.g.
// "Llama-3-8B-Instruct-Q4_K_M.gguf" or "Qwen2.5-7B-Instruct-Q4_K_M". We trim
// the trailing quant tag and .gguf extension so the base model name shows.
//
// IMPORTANT: this is a DISPLAY-only transform. The full id remains the value
// stored on the session and passed to start_local_model (which needs the full
// path/id to spawn the sidecar). Deriving the label deterministically from the
// id means every chat showing the same model id renders the same short label —
// so switching chats stays consistent.

// Standard llama.cpp quantization tags. Matched case-insensitively at the end
// of the name (after stripping any .gguf extension). Listed by length so the
// alternation tries longer tags first, but since we anchor with $ and match
// the full token, order doesn't affect correctness — it's only a readability
// aid. Kept explicit (rather than Q\d...) so unknown quant schemes are left
// untouched rather than over-trimmed.
const QUANT_TAGS = [
  "IQ4_XS", "IQ4_NL",
  "Q8_0", "Q6_K",
  "Q5_K_S", "Q5_K_M", "Q5_1", "Q5_0",
  "Q4_K_S", "Q4_K_M", "Q4_1", "Q4_0",
  "Q3_K_S", "Q3_K_M", "Q3_K_L",
  "Q2_K_S", "Q2_K",
  "F16", "F32", "BF16",
];
const quantAlt = QUANT_TAGS.join("|");

// A trailing quant tag, optionally preceded by a separator and/or a "GGUF"
// publisher marker ("-GGUF", " GGUF", "(GGUF)"), and the separators around it.
// Anchored to the end of the string.
const SUFFIX_RE = new RegExp(
  `[\\s\\-_.]*(?:gguf[\\s\\-_.]+)?(?:${quantAlt})[\\s\\-_.]*(?:\\(\\s*gguf\\s*\\)[\\s\\-_.]*)?$`,
  "i",
);

export function shortModelName(id: string): string {
  if (!id) return id;
  // Drop a leading directory path if the id is actually a file path (the
  // local-model id is the full path on disk, but the *displayed* id passed
  // here is the name/filename — be defensive either way).
  const base = id.includes("/") || id.includes("\\") ? id.split(/[\\/]/).pop() ?? id : id;
  // 1. Strip a trailing .gguf extension.
  const noExt = base.replace(/\.gguf$/i, "");
  // 2. Strip a trailing "GGUF" publisher marker in its common forms
  //    ("-GGUF", " GGUF", "(GGUF)") — some release names append it after the
  //    quant tag (e.g. "Phi-3-mini-4k-instruct-Q8_0-GGUF").
  const noMarker = noExt.replace(/[\s\-_.]*\(?\s*gguf\s*\)?[\s\-_.]*$/i, "");
  // 3. Strip a trailing quant tag (Q4_K_M, Q8_0, IQ4_XS, F16, …).
  const trimmed = noMarker.replace(SUFFIX_RE, "").trim();
  // 4. Fall back to the marker-stripped name if nothing matched (unknown quant
  //    scheme) so we never show a .gguf / -GGUF suffix.
  return trimmed.length > 0 ? trimmed : noMarker;
}
