/**
 * VOICE-PRO-02: the wake phrase. The salon names its assistant («Марина», «Ассистент»); the phrase must
 * start with that name, optionally after a greeting («Привет, Марина, кто свободен?»), so a booking
 * like «запиши к Марине» never wakes it.
 */
const GREETING = "(?:привет|эй|окей|ок|ok|слушай|алло|хей|здравствуй)";

function stem(name: string) {
  const clean = name.trim().toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я-]/g, "");
  if (!clean) return "ассистент";
  // «Марина» → «марин»: the vocative and recognizer variants differ only in the ending.
  return clean.length > 4 && /[аеиоуыэюяь]$/.test(clean) ? clean.slice(0, -1) : clean;
}

/** The words after the wake name, or null when the phrase does not start with it. */
export function matchWake(said: string, name: string): string | null {
  const text = said.toLowerCase().replace(/ё/g, "е").trim();
  const re = new RegExp(`^(?:${GREETING}[,!.]?\\s+)?${stem(name)}[а-я]*[,.!?]?(?:\\s+|$)(.*)$`, "i");
  const match = re.exec(text);
  if (!match) return null;
  // Return the rest in its original letters (names, «ё»), cut at the same length from the end.
  const rest = match[1].trim();
  return rest ? said.trim().slice(said.trim().length - rest.length).trim() : "";
}
