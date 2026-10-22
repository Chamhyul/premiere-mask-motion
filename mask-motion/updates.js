"use strict";
const CURRENT_VERSION = "1.0.0";
const REPOSITORY = "Chamhyul/premiere-mask-tracker";
const RELEASES_URL = "https://github.com/" + REPOSITORY + "/releases";
const API_URL = "https://api.github.com/repos/" + REPOSITORY + "/releases?per_page=100";
const CHECK_INTERVAL = 60 * 60 * 1000;
function version(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z.-]+)?$/i.exec(String(value));
  if (!match) return null;
  const pre = match[4] ? match[4].split(".") : [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) return null;
  const numbers = match.slice(1, 4).map(Number);
  return numbers.every(Number.isSafeInteger) ? { numbers, pre } : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]; if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return x.length === y.length ? x > y ? 1 : -1 : x.length > y.length ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
function findUpdate(releases, current = CURRENT_VERSION) {
  const installed = version(current); if (!installed || !Array.isArray(releases)) return null;
  let best = null;
  for (const release of releases) {
    if (!release || release.draft || typeof release.tag_name !== "string") continue;
    const candidate = version(release.tag_name);
    if (!candidate || (!installed.pre.length && (release.prerelease || candidate.pre.length))) continue;
    if (compare(candidate, installed) <= 0 || (best && compare(candidate, best.parsed) <= 0)) continue;
    // Construct a trusted destination; never launch a URL supplied by an API response.
    best = { version: release.tag_name.replace(/^v/i, ""), url: RELEASES_URL + "/tag/" + encodeURIComponent(release.tag_name), parsed: candidate };
  }
  return best ? { version: best.version, url: best.url } : null;
}
function createChecker(fetcher, { current = CURRENT_VERSION, now = Date.now, timeoutMs = 8000 } = {}) {
  let lastAttempt = null, pending = null, latest = null;
  return {
    check() {
      if (pending) return pending;
      if (lastAttempt !== null && now() - lastAttempt < CHECK_INTERVAL) return Promise.resolve(latest);
      lastAttempt = now();
      pending = (async () => {
        let timer;
        try {
          const request = (async () => {
            const response = await fetcher(API_URL, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
            if (!response.ok) throw Error("Release check failed");
            const data = await response.json(); if (!Array.isArray(data)) throw Error("Invalid releases");
            return findUpdate(data, current);
          })();
          latest = await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Release check timed out")), timeoutMs); })]);
        } catch (_) { /* Offline and rate limits must never interrupt editing. */ }
        finally { clearTimeout(timer); pending = null; }
        return latest;
      })();
      return pending;
    }
  };
}
module.exports = { CURRENT_VERSION, CHECK_INTERVAL, API_URL, RELEASES_URL, version, compare, findUpdate, createChecker };
