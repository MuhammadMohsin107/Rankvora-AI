// Stand-in for `iconv-lite`, which Express's body reader (body-parser → raw-body) imports.
//
// Why: iconv-lite's package.json maps its streaming module to `false` for the "browser" build, and
// Wrangler's bundler follows that map for Workers. The result is an empty module, and the Worker
// dies at start-up with "require_streams(...) is not a function". Workers has TextDecoder built
// in, which covers the charsets a JSON/raw body can sensibly carry.
export function encodingExists(encoding) {
  try {
    new TextDecoder(String(encoding));
    return true;
  } catch {
    return false;
  }
}

export function decode(buffer, encoding = 'utf-8') {
  return new TextDecoder(String(encoding)).decode(buffer);
}

export function getDecoder(encoding = 'utf-8') {
  const decoder = new TextDecoder(String(encoding));
  return {
    write: (chunk) => decoder.decode(chunk, { stream: true }),
    end: () => decoder.decode(),
  };
}

export default { encodingExists, decode, getDecoder };
