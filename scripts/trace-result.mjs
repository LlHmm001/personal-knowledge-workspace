/**
 * Decide whether an import-tracer result may be believed at all.
 *
 * A trace is evidence only when the process that produced it succeeded and its result has the
 * shape the self-containedness check depends on. This lives in its own module so the decision can
 * be tested without spawning a tracer or importing the checker's command-line entry point.
 *
 * Every one of these is a refusal, not a warning:
 *
 *   - the tracer exited non-zero: it could not run, or it found a violation itself;
 *   - stdout is empty, `null`, `false`, an array or any other non-object;
 *   - `loaded` is missing or not a finite number;
 *   - `outside` is missing, is not an array, or holds anything but strings;
 *   - `importError` is present and is not text;
 *   - `ok` is not exactly true, or `outside` is non-empty — the violation the check exists to find.
 *
 * Returns a message describing the refusal, or null when the result is usable.
 */
export function assertTraceResult({ exitCode, stdout, stderr = '' }) {
  if (exitCode !== 0) {
    return `the import tracer exited ${exitCode}: ${String(stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`
  }
  let parsed = null
  try { parsed = JSON.parse(String(stdout).trim()) } catch (error) {
    return `the import tracer produced no parseable result: ${error.message}`
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `the import tracer result is not an object: ${JSON.stringify(parsed)}`
  }
  if (typeof parsed.loaded !== 'number' || !Number.isFinite(parsed.loaded)) {
    return `the import tracer result has no numeric loaded count: ${JSON.stringify(parsed.loaded)}`
  }
  if (!Array.isArray(parsed.outside) || parsed.outside.some(file => typeof file !== 'string')) {
    return `the import tracer result has no list of outside files: ${JSON.stringify(parsed.outside)}`
  }
  if (parsed.importError !== null && parsed.importError !== undefined && typeof parsed.importError !== 'string') {
    return `the import tracer reported a non-textual import error: ${JSON.stringify(parsed.importError)}`
  }
  if (parsed.outside.length > 0) {
    return `the import tracer reported ${parsed.outside.length} file(s) loaded from outside the profile: ${parsed.outside.slice(0, 3).join(', ')}`
  }
  if (parsed.ok !== true) {
    return `the import tracer did not report ok:true (got ${JSON.stringify(parsed.ok)})`
  }
  return null
}
