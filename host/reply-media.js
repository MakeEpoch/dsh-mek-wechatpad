import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only explicit attachment syntax is actionable; prose paths and code are not. */
export function extractReplyMedia(text, cwd) {
  const files = new Set();
  const local = (raw) => {
    let path = raw.trim().replace(/^<|>$/g, '').replace(/^[`"']|[`"']$/g, '');
    if (/^file:\/\//i.test(path)) {
      try { path = fileURLToPath(path); } catch { return null; }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('#')) return null;
    try { path = decodeURIComponent(path); } catch { return null; }
    if (!path || /[\x00-\x1f]/.test(path)) return null;
    if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
    if (!path.startsWith('/') && !cwd) return null;
    return resolve(cwd || '/', path);
  };
  const add = (whole, raw) => {
    const path = local(raw);
    if (!path) return whole;
    files.add(path);
    return '';
  };
  // Preserve examples/code literally. An attachment must be outside a code span.
  const cleaned = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((part, i) => {
    if (i % 2) return part;
    return part.replace(/<\s*(wximg|wxvoice|wxvideo|wxfile)\s*>([^<>]+)<\s*\/\s*\1\s*>|!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)|^\s*MEDIA:\s*(.+?)\s*$/gim,
      (whole, _tag, tagPath, markdownPath, mediaPath) => add(whole, tagPath ?? markdownPath ?? mediaPath));
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, paths: [...files] };
}
