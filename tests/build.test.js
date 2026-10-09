import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import vm from "node:vm";

const build = fileURLToPath(new URL("../build.js", import.meta.url));

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mecard-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // JSON is valid YAML; fixtures do not use or alter the personal config.
  writeFileSync(join(directory, "config.yaml"), JSON.stringify({
    name: "Ada Lovelace",
    url: "https://example.github.io/card/",
    ...config,
  }));
  const result = spawnSync(process.execPath, [build], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    directory,
    html: readFileSync(join(directory, "dist/index.html"), "utf8"),
  };
}

function contact(html) {
  const data = html.match(/href="data:text\/vcard;base64,([A-Za-z0-9+/=]+)"/);
  assert.ok(data, "Save Contact contains an embedded vCard");
  return Buffer.from(data[1], "base64").toString("utf8");
}

test("structured contact name preserves surname, middle initial and suffix", (t) => {
  const { html } = fixture(t, {
    name: "Ryan R. Neely III",
    vcardName: { family: "Neely", given: "Ryan", additional: "R.", suffix: "III" },
  });
  assert.ok(contact(html).includes("\r\nN:Neely;Ryan;R.;;III\r\n"));
  assert.ok(contact(html).includes("\r\nFN:Ryan R. Neely III\r\n"));

  const fallback = fixture(t);
  assert.ok(contact(fallback.html).includes("\r\nN:Lovelace;Ada;;;\r\n"));
});

test("contact text escapes delimiters and folds Unicode by UTF-8 octets", (t) => {
  const title = "Atmosphere 🌦️ " .repeat(12);
  const { html } = fixture(t, {
    name: "Renée Example",
    title,
    organization: "Research, Centre; North\\South\nSecond line",
    department: "Clouds; Ice",
  });
  const vcard = contact(html);
  for (const line of vcard.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, "each physical line fits 75 octets");
    assert.ok(!line.includes("\uFFFD"), "folding retains complete Unicode characters");
  }
  const unfolded = vcard.replace(/\r\n[ \t]/g, "");
  assert.ok(unfolded.includes(`\r\nTITLE:${title}\r\n`));
  assert.ok(unfolded.includes("\r\nORG:Research\\, Centre\\; North\\\\South\\nSecond line;Clouds\\; Ice\r\n"));
  assert.ok(unfolded.includes("\r\nFN:Renée Example\r\n"));
});

test("website label changes display while preserving the contact URI", (t) => {
  const website = "https://example.edu/research/people/a-long-profile-address";
  const { html } = fixture(t, { website, websiteLabel: "University profile" });
  assert.match(html, /<span>University profile<\/span>/);
  assert.ok(html.includes(`href="${website}"`));
  assert.ok(contact(html).replace(/\r\n[ \t]/g, "").includes(`\r\nURL:${website}\r\n`));
});

test("Share JSON cannot terminate its script and retains the original text", async (t) => {
  const name = "Example </script><script>alert('fixture')</script>";
  const { html } = fixture(t, { name, options: { pwa: false } });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.ok(!scripts[0][1].includes("</script>"));
  let click;
  let shared;
  const button = { hidden: true, addEventListener: (_event, callback) => { click = callback; } };
  vm.runInNewContext(scripts[0][1], {
    matchMedia: () => ({ matches: false }),
    document: { querySelector: () => button },
    navigator: { share: async (value) => { shared = value; } },
    console,
  });
  assert.equal(button.hidden, false);
  await click();
  assert.equal(shared.title, name);
  assert.equal(shared.url, "https://example.github.io/card/");
});

test("PWA activation deletes only older caches for this card path", async (t) => {
  const first = fixture(t, { url: "https://example.github.io/card/" });
  const second = fixture(t, { url: "https://example.github.io/another-card/" });
  const workers = [first, second].map(({ directory }) => readFileSync(join(directory, "dist/sw.js"), "utf8"));
  const events = {};
  const removed = [];
  let keys;
  const runWorker = (source, listeners = {}) => vm.runInNewContext(source + "\n({ CACHE, CACHE_PREFIX });", {
    self: {
      addEventListener: (event, callback) => { listeners[event] = callback; },
      clients: { claim: async () => {} },
    },
    caches: { keys: async () => keys, delete: async (key) => { removed.push(key); } },
  });
  const card = runWorker(workers[0], events);
  const other = runWorker(workers[1]);
  assert.notEqual(card.CACHE_PREFIX, other.CACHE_PREFIX);
  keys = [card.CACHE, card.CACHE_PREFIX + "older", other.CACHE, "other-app-cache", "mecard-legacy"];
  let activation;
  events.activate({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(removed, [card.CACHE_PREFIX + "older"]);

  const disabled = fixture(t, { options: { pwa: false } });
  assert.deepEqual(readdirSync(join(disabled.directory, "dist")), ["index.html"]);
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (data) => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("dev server rejects malformed paths, traversal, symlinks and directories", async (t) => {
  const { directory } = fixture(t);
  const server = spawn(process.execPath, [build, "--serve"], {
    cwd: directory,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await exited;
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Dev server did not start")), 10000);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Dev server exited: ${code}`)); });
    server.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  mkdirSync(join(directory, "dist-other"));
  writeFileSync(join(directory, "dist-other/secret.txt"), "private fixture");
  symlinkSync(join(directory, "dist-other/secret.txt"), join(directory, "dist/leak.txt"));
  mkdirSync(join(directory, "dist/nested"));

  assert.equal((await get(port, "/")).status, 200);
  assert.equal((await get(port, "/%E0%A4%A")).status, 400);
  assert.equal((await get(port, "/%00")).status, 400);
  assert.equal((await get(port, "/%2e%2e%2fdist-other%2fsecret.txt")).status, 404);
  assert.equal((await get(port, "/leak.txt")).status, 404);
  assert.equal((await get(port, "/nested")).status, 404);
  assert.equal((await get(port, "/missing")).status, 404);
  assert.equal((await get(port, "/")).status, 200, "rejected requests leave the server running");
});
