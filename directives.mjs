// Parsing of media directives that the agent can embed in its reply text.
//
// A directive must sit on its own line:
//   [[send-image: C:\abs\path.png]]
//   [[send-video: C:\abs\path.mp4]]
//   [[send-file:  C:\abs\path.zip]]
//
// The bridge strips directive lines from the reply, sends the remaining text as
// the chat message, and uploads/sends each referenced file as real media.

export const MEDIA_DIRECTIVE_RE = /^\s*\[\[send-(image|video|file):\s*(.+?)\s*\]\]\s*$/i;

export function extractMediaDirectives(text) {
  const media = [];
  const kept = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(MEDIA_DIRECTIVE_RE);
    if (m) media.push({ kind: m[1].toLowerCase(), path: m[2].trim() });
    else kept.push(line);
  }
  return { media, text: kept.join("\n").trim() };
}
