/**
 * Appends `value` to the list kept under `key`, creating the list on first use, and returns the list.
 *
 * It exists because the tidy-looking alternative, `map.set(key, [...(map.get(key) ?? []), value])`, copies
 * the whole list on every call: grouping N items under a few keys then costs N-squared element copies.
 * On a catalogue of ten thousand products that single line was minutes of CPU, long enough for a
 * Cloudflare Worker to be cut off in the middle of an analysis. Pushing is constant time.
 */
export function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): V[] {
  let list = map.get(key);
  if (list === undefined) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
  return list;
}
