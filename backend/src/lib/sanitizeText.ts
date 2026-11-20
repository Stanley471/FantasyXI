/**
 * Strips HTML tags from free-text user input before it is persisted, so a
 * league description can never carry executable markup into a page that
 * renders it (stored XSS; issue #493).
 *
 * `<script>`/`<style>` tags are removed together with their body — that
 * content is never meant to display as text. Every other tag (including
 * `<iframe>` and `<a>`) is stripped but its inner text is kept, e.g.
 * `<a href="...">click</a>` becomes `click`.
 *
 * The strip is applied repeatedly until the string stops changing, which
 * defeats nested-tag bypass tricks like `<scr<script>ipt>alert(1)</script>`
 * that a single regex pass would miss.
 */

const SCRIPT_OR_STYLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ANY_TAG = /<\/?[a-zA-Z!][^>]*>/g;

export function sanitizePlainText(input: string): string {
  if (typeof input !== "string") return input;

  let result = input;
  let previous: string;
  do {
    previous = result;
    result = result.replace(SCRIPT_OR_STYLE_BLOCK, "").replace(ANY_TAG, "");
  } while (result !== previous);

  return result;
}
