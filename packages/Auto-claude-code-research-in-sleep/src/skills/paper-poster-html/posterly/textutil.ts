export function asciiSafe(s: unknown): string {
  const str = String(s);
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7e) {
      out += str[i];
    } else if (code <= 0xff) {
      out += "\\x" + code.toString(16).padStart(2, "0");
    } else {
      out += "\\u" + code.toString(16).padStart(4, "0");
    }
  }
  return out;
}
