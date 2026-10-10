#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync, statSync } from "fs";
import { parse } from "yaml";
import QRCode from "qrcode";
import { extname, join, resolve, sep } from "path";
import { createHash } from "crypto";

const OUT = "dist";

// ── Read config ──────────────────────────────────────────────
if (!existsSync("config.yaml")) {
  console.error("config.yaml not found — copy config.example.yaml to start.");
  process.exit(1);
}

const config = parse(readFileSync("config.yaml", "utf-8")) || {};

for (const key of ["name", "url"]) {
  if (!config[key]) {
    console.error(`config.yaml is missing required key: ${key}`);
    process.exit(1);
  }
}

// ── Theme colors ─────────────────────────────────────────────
function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
}

// Blend two hex colors, used only when `mid` is left unset
function blendHex(a, b, t = 0.5) {
  const p = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return (
    "#" +
    [1, 3, 5]
      .map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

const theme = {
  dark: config.theme?.dark || "#1e1e22",
  light: config.theme?.light || "#1b4742",
  accent: config.theme?.accent || "#5b9eb8",
  pop: config.theme?.pop || "#b34d3a",
  page: config.theme?.page || "#131315",
  text: config.theme?.text || "#fbf9f6",
};
theme.mid = config.theme?.mid || blendHex(theme.dark, theme.light, 0.5);

const opts = {
  glint: config.options?.glint ?? false,
  waves: config.options?.waves ?? true,
  qr: config.options?.qr ?? true,
  saveContact: config.options?.saveContact ?? true,
  share: config.options?.share ?? true,
  pwa: config.options?.pwa ?? true,
  qrLabel: config.options?.qrLabel ?? "Scan to connect",
  saveLabel: config.options?.saveLabel ?? "Save Contact",
  shareLabel: config.options?.shareLabel ?? "Share",
};

const accentRgb = hexToRgb(theme.accent);
const popRgb = hexToRgb(theme.pop);
const textRgb = hexToRgb(theme.text);

// Embed the atmospheric backdrop so the card still works as one HTML file.
let backgroundSrc = null;
if (config.background) {
  const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const mime = mimeTypes[extname(config.background).toLowerCase()];
  if (!mime || !existsSync(config.background)) {
    console.error("background must point to an existing local PNG, JPEG or WebP image.");
    process.exit(1);
  }
  backgroundSrc = `data:${mime};base64,${readFileSync(config.background).toString("base64")}`;
}

// ── Process photo ────────────────────────────────────────────
// Reads intrinsic dimensions straight from the file header so the PWA
// manifest can declare an accurate icon size without an image library.
function imageSize(buf) {
  // PNG: IHDR width/height are big-endian uint32s at a fixed offset
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG: walk the marker segments looking for a Start Of Frame
  if (buf.length > 4 && buf.readUInt16BE(0) === 0xffd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

let photoSrc = null;      // what the <img> uses (data URI or remote URL)
let photoBase64 = null;   // for embedding in the vCard
let photoMimeType = "JPEG";
let photoFile = null;     // { name, data, size } for the PWA icon

if (config.photo) {
  if (config.photo.startsWith("http")) {
    photoSrc = config.photo;
  } else if (existsSync(config.photo)) {
    const data = readFileSync(config.photo);
    const ext = extname(config.photo).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext;
    photoMimeType = mime.toUpperCase();
    photoBase64 = data.toString("base64");
    photoSrc = `data:image/${mime};base64,${photoBase64}`;
    photoFile = { name: `icon.${ext}`, data, mime, size: imageSize(data) };
  } else {
    console.warn(`! photo not found: ${config.photo} — using initials`);
  }
}

const initials = config.name
  .split(/\s+/)
  .map((w) => w[0])
  .join("")
  .toUpperCase()
  .slice(0, 2);

// ── QR code (light modules for dark background) ──────────────
const qrSvg = await QRCode.toString(config.url, {
  type: "svg",
  margin: 0,
  color: { dark: "#ffffffdd", light: "#00000000" },
  errorCorrectionLevel: "M",
});

// ── vCard ────────────────────────────────────────────────────
function foldLine(line, maxLen = 75) {
  const folded = [];
  let current = "";
  let bytes = 0;
  // vCard limits physical lines to 75 octets, without splitting UTF-8 characters.
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxLen) {
      folded.push(current);
      current = " ";
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  folded.push(current);
  return folded.join("\r\n");
}

function escVCard(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function buildVCard() {
  const parts = config.name.split(/\s+/);
  const lastName = parts.length > 1 ? parts.slice(-1)[0] : parts[0];
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
  const name = config.vcardName || {};
  const structuredName = [
    name.family ?? lastName,
    name.given ?? firstName,
    name.additional ?? "",
    name.prefix ?? "",
    name.suffix ?? "",
  ].map(escVCard).join(";");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escVCard(config.name)}`,
    `N:${structuredName}`,
  ];
  if (config.title) lines.push(`TITLE:${escVCard(config.title)}`);
  if (config.organization) {
    const org = config.department
      ? `${escVCard(config.organization)};${escVCard(config.department)}`
      : escVCard(config.organization);
    lines.push(`ORG:${org}`);
  }
  if (config.email) lines.push(`EMAIL;TYPE=WORK:${escVCard(config.email)}`);
  if (config.phone) lines.push(`TEL;TYPE=WORK:${escVCard(config.phone)}`);
  // URI fields retain separators while encoding line breaks that would create properties.
  const uri = (value) => String(value).replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  if (config.website) lines.push(`URL:${uri(config.website)}`);
  if (config.url && config.url !== config.website)
    lines.push(`URL:${uri(config.url)}`);
  if (photoBase64)
    lines.push(`PHOTO;ENCODING=b;TYPE=${photoMimeType}:${photoBase64}`);
  lines.push("END:VCARD");
  return lines.map((line) => foldLine(line)).join("\r\n");
}

const vcard = buildVCard();
const vcardDataUri = `data:text/vcard;base64,${Buffer.from(vcard).toString("base64")}`;
const vcardFilename = config.name.replace(/\s+/g, "_") + ".vcf";

// ── Icons ────────────────────────────────────────────────────
const ICONS = {
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  github: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
  twitter: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  scholar: `<svg viewBox="0 0 384 512" fill="currentColor"><path d="M343.8 106.7V79.4l19.7-15.4H149.6L20.5 176.3h85.7c-.2 2.1-.2 4-.2 6.2 0 20.8 7.2 38.1 21.7 51.9 14.5 13.8 32.3 20.6 53.3 20.6 4.9 0 9.8-.4 14.4-1-2.9 6.5-4.4 12.5-4.4 18.1 0 9.9 4.5 20.4 13.5 31.6-39.2 2.7-68.1 9.7-86.4 21.2-10.5 6.5-19 14.7-25.4 24.5-6.4 9.9-9.6 20.5-9.6 32 0 9.6 2.1 18.3 6.2 26 4.2 7.7 9.6 14.1 16.3 19 6.7 5 14.5 9.1 23.2 12.5 8.7 3.3 17.4 5.7 26.1 7.1 8.6 1.3 17.2 2 25.7 2 13.5 0 27-1.7 40.5-5.2 13.6-3.5 26.3-8.6 38.2-15.5 11.9-6.8 21.5-16.1 28.9-27.7 7.4-11.7 11.1-24.8 11.1-39.3 0-11-2.2-21-6.8-30.1-4.5-9.1-9.9-16.5-16.5-22.3-6.5-5.8-13-11.2-19.5-16-6.5-4.8-12-9.8-16.5-14.8-4.5-5-6.7-10.1-6.7-15 0-4.9 1.7-9.7 5.2-14.3 3.5-4.6 7.7-9 12.6-13.3 4.9-4.2 9.9-9 14.8-14.1 4.9-5.1 9.1-11.8 12.6-20 3.5-8.2 5.2-17.4 5.2-27.8 0-13.5-2.5-24.5-7.5-33.3-.6-1-1.2-1.8-1.9-3l56.9-46.7v17.1c-7.4.9-6.6 5.3-6.6 10.6v128.7c0 6 4.9 10.8 10.8 10.8h4c6 0 10.8-4.8 10.8-10.8V117.3c0-5.3.8-9.7-6.6-10.6zm-107.4 222.5c1.1.7 3.7 2.8 7.7 6 4 3.2 6.8 5.7 8.3 7.4 1.4 1.7 3.6 4.2 6.4 7.5 2.8 3.4 4.7 6.3 5.7 8.7 1 2.5 2 5.5 3 8.9 1 3.4 1.5 7 1.5 10.6 0 17-6.6 29.7-19.7 37.9-13.1 8.2-28.8 12.3-46.9 12.3-9.2 0-18.2-1.1-27.1-3.2-8.8-2.1-17.3-5.3-25.4-9.6-8.1-4.3-14.6-10.2-19.5-17.8-4.9-7.6-7.4-16.4-7.4-26.2 0-10.3 2.8-19.3 8.4-26.9 5.6-7.6 12.9-13.4 22-17.3 9.1-3.9 18.2-6.7 27.6-8.4 9.3-1.7 18.8-2.6 28.4-2.6 4.5 0 7.9.3 10.4.7.5.2 3 2.1 7.7 5.6 4.7 3.5 7.6 5.6 8.8 6.4zm-3.4-100.6c-7.4 8.9-17.7 13.3-31 13.3-11.9 0-22.3-4.8-31.3-14.3-9-9.5-15.4-20.3-19.3-32.4-3.9-12.1-5.9-24-5.9-35.6 0-13.7 3.6-25.4 10.8-35 7.2-9.6 17.5-14.5 30.9-14.5 11.9 0 22.4 5 31.4 15.2 9.1 10.1 15.6 21.4 19.5 34 3.9 12.5 5.9 24.5 5.9 36 0 13.4-3.7 24.6-11.1 33.4z"/></svg>`,
  file: `<svg viewBox="0 0 512 512" fill="currentColor"><path d="M249.2 328.3c-9.8 15.4-19.2 30.4-40.2 45.1-11.3 7.9-37.2 23.3-74 23.3-70.3 0-127-51.1-127-140.9 0-78.5 53.3-140.5 128.5-140.5 30.4 0 57.5 10.5 77.4 26.3 18.4 14.7 27 29.3 34.6 42.5l-52.6 26.3c-3.8-8.6-8.3-17.6-19.9-27.4-12.8-10.2-25.5-13.2-36.5-13.2-42.8 0-65.4 39.8-65.4 84.1 0 58.2 29.7 87.1 65.4 87.1 34.6 0 48.5-24 57.5-39.4l52.2 26.7zM433.4 123.6H504L412 388.8h-67.6l-90.9-265.2h70.6l54.8 188.6z"/></svg>`,
  orcid: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM7.369 4.378c.525 0 .947.431.947.947s-.422.947-.947.947a.95.95 0 0 1-.947-.947c0-.525.422-.947.947-.947zm-.722 3.038h1.444v10.041H6.647V7.416zm3.562 0h3.9c3.712 0 5.344 2.653 5.344 5.025 0 2.578-2.016 5.025-5.325 5.025h-3.919V7.416zm1.444 1.303v7.444h2.297c3.272 0 4.022-2.484 4.022-3.722 0-1.397-.759-3.722-3.853-3.722h-2.466z"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`,
};

// ── Helpers ──────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPhotoHtml() {
  if (photoSrc) {
    return `      <div class="photo-wrap">
        <div class="photo-glow"></div>
        <img class="photo" src="${photoSrc}" alt="${escHtml(config.name)}" />
      </div>`;
  }
  return `      <div class="photo-wrap">
        <div class="photo-glow"></div>
        <div class="photo photo-initials">${initials}</div>
      </div>`;
}

function buildSubtitle() {
  const lines = [];
  if (config.title)
    lines.push(`<span class="sub-title">${escHtml(config.title)}</span>`);
  if (config.tagline)
    lines.push(`<span class="sub-tagline">${escHtml(config.tagline)}</span>`);
  const orgParts = [config.department, config.organization].filter(Boolean);
  if (orgParts.length)
    lines.push(`<span class="sub-org">${escHtml(orgParts.join(" · "))}</span>`);
  return lines.join("\n          ");
}

function buildContactInfo() {
  const entries = [];
  if (config.email)
    entries.push({
      href: `mailto:${config.email}`,
      icon: ICONS.mail,
      text: config.email,
    });
  if (config.phone)
    entries.push({
      // tel: URIs take digits and a leading +; strip the display formatting
      href: `tel:${String(config.phone).replace(/[^\d+]/g, "")}`,
      icon: ICONS.phone,
      text: config.phone,
    });
  if (config.website)
    entries.push({
      href: config.website,
      icon: ICONS.globe,
      text: config.websiteLabel || config.website.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      external: true,
    });

  if (!entries.length) return "";

  const rows = entries.map((e, i) => {
    const delay = (0.35 + i * 0.07).toFixed(2);
    const rel = e.external
      ? ' target="_blank" rel="noopener noreferrer"'
      : "";
    return `        <a href="${escHtml(e.href)}"${rel} class="contact-row" style="animation-delay:${delay}s">${e.icon}<span>${escHtml(e.text)}</span></a>`;
  });

  return `      <div class="contact-info">\n${rows.join("\n")}\n      </div>`;
}

function buildLinksHtml() {
  if (!config.links?.length) return "";
  return config.links
    .map((link, i) => {
      const icon = ICONS[link.icon] || ICONS.link;
      const delay = (0.55 + i * 0.07).toFixed(2);
      return `        <a href="${escHtml(link.url)}" target="_blank" rel="noopener noreferrer"
           class="link-btn" title="${escHtml(link.label)}" aria-label="${escHtml(link.label)}"
           style="animation-delay:${delay}s">${icon}</a>`;
    })
    .join("\n");
}

function buildQrSection() {
  if (!opts.qr && !opts.saveContact && !opts.share) return "";
  const parts = [];
  if (opts.qr) {
    parts.push(`        <div class="qr-container">${qrSvg}</div>`);
    if (opts.qrLabel)
      parts.push(`        <p class="qr-label">${escHtml(opts.qrLabel)}</p>`);
  }

  const actions = [];
  if (opts.saveContact) {
    actions.push(`          <a href="${vcardDataUri}" download="${escHtml(vcardFilename)}" class="action-btn save-btn">
            ${ICONS.download} ${escHtml(opts.saveLabel)}
          </a>`);
  }
  if (opts.share) {
    // Revealed by script only where navigator.share exists
    actions.push(`          <button type="button" class="action-btn share-btn" hidden>
            ${ICONS.share} ${escHtml(opts.shareLabel)}
          </button>`);
  }
  if (actions.length)
    parts.push(`        <div class="actions">\n${actions.join("\n")}\n        </div>`);

  return `      <div class="qr-section">\n${parts.join("\n")}\n      </div>`;
}

// ── Traveling wave generator ─────────────────────────────────
// Builds a diagonal wavy edge from (100, startY) to (0, endY).
// Shifting `phase` makes the crests travel along the diagonal,
// which is what the SMIL animation below interpolates through.
function wavePath(startY, endY, amp, phase, freq, segments = 4) {
  const yAt = (t) =>
    startY + (endY - startY) * t + amp * Math.sin(phase + t * freq * Math.PI);
  const f = (n) => n.toFixed(2);

  let d = `M100,${f(yAt(0))}`;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const x0 = 100 - 100 * t0;
    const x1 = 100 - 100 * t1;
    const dx = (x1 - x0) / 3;
    // Slope at each anchor, used to place control points tangentially
    const slope = (t) =>
      (endY - startY) / segments +
      amp * freq * Math.PI * Math.cos(phase + t * freq * Math.PI) / segments;
    d += ` C${f(x0 + dx)},${f(yAt(t0) + slope(t0) / 3)} ${f(x1 - dx)},${f(yAt(t1) - slope(t1) / 3)} ${f(x1)},${f(yAt(t1))}`;
  }
  return d;
}

// Closes the wave into the top-left region so it can be filled
const closeWave = (d) => `${d} L0,0 L100,0 Z`;

// Seamless loop: phase 0 → 2π lands back on the starting shape
const PHASE_STEPS = 8;
function waveFrames(cfg) {
  const frames = [];
  for (let i = 0; i <= PHASE_STEPS; i++) {
    const phase = (i / PHASE_STEPS) * Math.PI * 2;
    frames.push(closeWave(wavePath(cfg.start, cfg.end, cfg.amp, phase, cfg.freq)));
  }
  return frames;
}

// Different frequencies and periods so the two edges never lock in step
const ASH = { start: 6, end: 84, amp: 4.5, freq: 2.3, dur: "48s" };
const MID = { start: 18, end: 94, amp: 4.0, freq: 1.5, dur: "35s" };

// One flat-filled band per layer. No strokes, no shadows — the
// colour change alone is the boundary.
function waveLayer(cfg, fillColor, cls) {
  const frames = waveFrames(cfg);
  const anim = opts.waves
    ? `<animate attributeName="d" dur="${cfg.dur}" repeatCount="indefinite"
          calcMode="spline" keySplines="${Array(PHASE_STEPS).fill(".42 0 .58 1").join(";")}"
          values="${frames.join(";")}"/>`
    : "";
  return `    <svg class="wave-layer ${cls}" viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <path d="${frames[0]}" fill="${fillColor}">${anim}</path>
    </svg>`;
}

// Back band is the card background; mid and ash stack on top of it
const layersSvg = backgroundSrc ? "" : [
  waveLayer(MID, theme.mid, "layer-mid"),
  waveLayer(ASH, theme.dark, "layer-ash"),
].join("\n");

// ── Full HTML ────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${escHtml(config.name)}</title>
  <meta name="description" content="${escHtml([config.title, config.organization].filter(Boolean).join(" — "))}">
  <meta name="theme-color" content="${theme.page}">
  <meta property="og:title" content="${escHtml(config.name)}">
  <meta property="og:description" content="${escHtml([config.title, config.organization].filter(Boolean).join(" — "))}">
  <meta property="og:url" content="${escHtml(config.url)}">
  <meta property="og:type" content="profile">
${
  opts.pwa
    ? `  <link rel="manifest" href="manifest.webmanifest">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="${escHtml(config.name)}">
  <link rel="apple-touch-icon" href="${photoFile ? photoFile.name : "icon.svg"}">
  <link rel="icon" href="icon.svg" type="image/svg+xml">
`
    : ""
}
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --dark: ${theme.dark};
      --teal: ${theme.light};
      --mid: ${theme.mid};
      --accent: ${theme.accent};
      --accent-rgb: ${accentRgb};
      --pop: ${theme.pop};
      --pop-rgb: ${popRgb};
      --page: ${theme.page};
      --text: ${theme.text};
      --text-rgb: ${textRgb};
      --text-muted: rgba(${textRgb}, 0.82);
      --text-dim: rgba(${textRgb}, 0.6);
${backgroundSrc ? `      --atmosphere-image: url("${backgroundSrc}");
      --text-muted: rgba(${textRgb}, 0.9);
      --text-dim: rgba(${textRgb}, 0.8);
` : ""}
    }

    body {
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--page);
      background:
        radial-gradient(ellipse at 50% 35%, rgba(${accentRgb}, 0.03) 0%, transparent 55%),
        var(--page);
${backgroundSrc ? `      background-image: linear-gradient(160deg, rgba(10, 12, 18, 0.70), rgba(18, 18, 23, 0.64)), var(--atmosphere-image);
      background-size: cover;
      background-position: center;
` : ""}
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      padding: 1rem;
    }

    /* ── Card ──────────────────────────── */
    .card {
      position: relative;
      max-width: 400px;
      width: 100%;
      border-radius: 26px;
      overflow: hidden;
      background: var(--teal);
${backgroundSrc ? `      background-image: linear-gradient(180deg, rgba(14, 15, 20, 0.16) 0%, rgba(14, 15, 20, 0.68) 26%, rgba(14, 15, 20, 0.72) 56%, rgba(14, 15, 20, 0.64) 100%), var(--atmosphere-image);
      background-size: cover;
      background-position: center;
` : ""}
      box-shadow:
        0 1px 1px rgba(255, 255, 255, 0.09) inset,
        0 40px 80px -20px rgba(0, 0, 0, 0.7),
        0 18px 36px -12px rgba(0, 0, 0, 0.45),
        0 0 0 1px rgba(255, 255, 255, 0.07);
      animation: cardEntrance 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      opacity: 0;
    }

${
  opts.glint
    ? `    /* Moving specular sweep */
    .card::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 4;
      border-radius: inherit;
      background: linear-gradient(
        115deg,
        transparent 30%,
        rgba(255, 255, 255, 0.03) 44%,
        rgba(255, 255, 255, 0.07) 50%,
        rgba(255, 255, 255, 0.03) 56%,
        transparent 70%
      );
      background-size: 250% 100%;
      background-position: -50% 0;
      pointer-events: none;
      animation: shimmer 11s ease-in-out 2.5s infinite;
    }
`
    : ""
}
    /* Static glass sheen: bright top-left falloff + rim light */
    .card::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 4;
      border-radius: inherit;
      pointer-events: none;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.07) 0%, transparent 22%),
        radial-gradient(120% 80% at 12% -10%, rgba(255, 255, 255, 0.08) 0%, transparent 55%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(0, 0, 0, 0.35);
    }

    /* ── Wave layers ───────────────────── */
    .wave-layer {
      position: absolute;
      width: 108%;
      height: 108%;
      top: -4%;
      left: -4%;
      pointer-events: none;
    }

    .layer-mid { z-index: 1; }
    .layer-ash { z-index: 2; }

    /* ── Content ───────────────────────── */
    .content {
      position: relative;
      z-index: 3;
      padding: 2.5rem 2rem 2rem;
      text-align: center;
    }

    /* ── Photo ─────────────────────────── */
    .photo-wrap {
      position: relative;
      width: 156px;
      height: 156px;
      margin: 0 auto 1.4rem;
      animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.15s backwards;
    }

    .photo-glow {
      position: absolute;
      inset: -12px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(${accentRgb}, 0.16) 0%, transparent 70%);
      animation: pulse 5s ease-in-out infinite;
    }

    .photo {
      width: 156px;
      height: 156px;
      border-radius: 50%;
      object-fit: cover;
      position: relative;
      z-index: 1;
      border: 3px solid rgba(${accentRgb}, 0.34);
      box-shadow:
        0 10px 30px rgba(0, 0, 0, 0.5),
        0 3px 10px rgba(0, 0, 0, 0.35),
        0 0 0 1px rgba(255, 255, 255, 0.12),
        inset 0 2px 6px rgba(255, 255, 255, 0.14);
    }

    /* Glass highlight arc over the photo */
    .photo-wrap::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 2;
      border-radius: 50%;
      pointer-events: none;
      background: linear-gradient(150deg, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.05) 28%, transparent 52%);
    }

    .photo-initials {
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, rgba(${accentRgb}, 0.25), rgba(${accentRgb}, 0.08));
      color: var(--text);
      font-size: 3rem;
      font-weight: 600;
      letter-spacing: 0.05em;
    }

    /* ── Identity ──────────────────────── */
    .name {
      font-size: 2rem;
      font-weight: 650;
      color: var(--text);
      letter-spacing: -0.015em;
      margin-bottom: 0.45rem;
      animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.2s backwards;
    }

    .subtitle {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      margin-bottom: 1.5rem;
      animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.26s backwards;
    }

    .sub-title {
      font-size: 1.05rem;
      color: var(--text-muted);
    }

    .sub-tagline {
      font-size: 0.97rem;
      color: var(--accent);
      font-style: italic;
    }

    .sub-org {
      font-size: 0.92rem;
      color: var(--text-dim);
    }

    /* ── Contact info ──────────────────── */
    .contact-info {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      margin-bottom: 1.25rem;
    }

    .contact-row {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.4rem 0.75rem;
      border-radius: 10px;
      text-decoration: none;
      color: rgba(${textRgb}, 0.95);
      font-size: 1rem;
      transition: background 0.25s ease, color 0.25s ease;
      animation: fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) backwards;
    }

    .contact-row:hover {
      background: linear-gradient(155deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.03));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
      color: #fff;
    }

    .contact-row svg {
      width: 20px;
      height: 20px;
      color: var(--accent);
      flex-shrink: 0;
      opacity: 0.9;
    }

    /* ── Link buttons ──────────────────── */
    .links {
      display: flex;
      gap: 0.6rem;
      justify-content: center;
      flex-wrap: wrap;
    }

    .link-btn {
      width: 50px;
      height: 50px;
      border-radius: 15px;
      background: linear-gradient(155deg, rgba(255, 255, 255, 0.11), rgba(255, 255, 255, 0.03));
      border: 1px solid rgba(255, 255, 255, 0.11);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.72);
      text-decoration: none;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.22),
        0 4px 12px rgba(0, 0, 0, 0.28);
      transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      animation: fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) backwards;
    }

    .link-btn svg {
      width: 28px;
      height: 28px;
      flex-shrink: 0;
    }

    .link-btn:hover, .link-btn:active {
      background: linear-gradient(155deg, rgba(${accentRgb}, 0.28), rgba(${accentRgb}, 0.08));
      border-color: rgba(${accentRgb}, 0.4);
      color: #fff;
      transform: translateY(-3px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.28),
        inset 0 -1px 0 rgba(0, 0, 0, 0.2),
        0 10px 24px rgba(${accentRgb}, 0.22),
        0 4px 10px rgba(0, 0, 0, 0.3);
    }

    .link-btn:active {
      transform: translateY(-1px) scale(0.97);
    }

    /* ── QR ─────────────────────────────── */
    .qr-section {
      margin-top: 1.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid rgba(255, 255, 255, 0.04);
    }

    .qr-container {
      width: 140px;
      height: 140px;
      margin: 0 auto;
      padding: 13px;
      background: linear-gradient(155deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.025));
${backgroundSrc ? `      background: rgba(7, 24, 37, 0.96);
` : ""}
      border-radius: 19px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 -1px 0 rgba(0, 0, 0, 0.22),
        0 6px 18px rgba(0, 0, 0, 0.3);
      animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.7s backwards;
    }

    .qr-container svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .qr-label {
      font-size: 0.76rem;
      color: var(--text-dim);
      margin-top: 0.7rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      animation: fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.75s backwards;
    }

    /* ── Actions ───────────────────────── */
    .actions {
      display: flex;
      gap: 0.55rem;
      justify-content: center;
      flex-wrap: wrap;
      margin-top: 1.1rem;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.7rem 1.35rem;
      border-radius: 13px;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      font-size: 0.94rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      text-decoration: none;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.2),
        inset 0 -1px 0 rgba(0, 0, 0, 0.25),
        0 5px 16px rgba(0, 0, 0, 0.32);
      transition: all 0.3s ease;
      cursor: pointer;
      font-family: inherit;
      animation: fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.8s backwards;
    }

    .action-btn[hidden] { display: none; }
    .action-btn svg { width: 19px; height: 19px; }
    .action-btn:active { transform: scale(0.97); }

    .action-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
    }

    .save-btn {
      background: linear-gradient(155deg, rgba(${popRgb}, 0.34), rgba(${popRgb}, 0.14));
      border: 1px solid rgba(${popRgb}, 0.45);
      color: #fbeae5;
    }

    .save-btn:hover {
      background: linear-gradient(155deg, rgba(${popRgb}, 0.5), rgba(${popRgb}, 0.24));
      border-color: rgba(${popRgb}, 0.65);
      color: #fff;
      transform: translateY(-2px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.3),
        0 10px 26px rgba(${popRgb}, 0.3),
        0 4px 10px rgba(0, 0, 0, 0.3);
    }

    .share-btn {
      background: linear-gradient(155deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.035));
      border: 1px solid rgba(255, 255, 255, 0.13);
      color: rgba(${textRgb}, 0.92);
    }

    .share-btn:hover {
      background: linear-gradient(155deg, rgba(${accentRgb}, 0.3), rgba(${accentRgb}, 0.1));
      border-color: rgba(${accentRgb}, 0.45);
      color: #fff;
      transform: translateY(-2px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.3),
        0 10px 26px rgba(${accentRgb}, 0.22),
        0 4px 10px rgba(0, 0, 0, 0.3);
    }

    /* ── Animations ────────────────────── */
    @keyframes cardEntrance {
      from { opacity: 0; transform: translateY(28px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.5; transform: scale(1); }
      50%      { opacity: 0.85; transform: scale(1.05); }
    }

${
  opts.glint
    ? `    @keyframes shimmer {
      0%       { opacity: 0; background-position: -50% 0; }
      8%       { opacity: 1; }
      38%      { opacity: 1; background-position: 150% 0; }
      50%, 100% { opacity: 0; background-position: 150% 0; }
    }
`
    : ""
}
    /* ── Responsive ────────────────────── */
    @media (max-width: 420px) {
      .content { padding: 2rem 1.5rem 1.75rem; }
      .card { border-radius: 20px; }
      .name { font-size: 1.75rem; }
      .photo-wrap { width: 134px; height: 134px; }
      .photo { width: 134px; height: 134px; }
      .link-btn { width: 46px; height: 46px; border-radius: 13px; }
      .link-btn svg { width: 26px; height: 26px; }
      .qr-container { width: 125px; height: 125px; padding: 10px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <main class="card">
${layersSvg}

    <div class="content">
${buildPhotoHtml()}

      <h1 class="name">${escHtml(config.name)}</h1>
      <div class="subtitle">
        ${buildSubtitle()}
      </div>

${buildContactInfo()}

      <div class="links">
${buildLinksHtml()}
      </div>

${buildQrSection()}
    </div>
  </main>
  <script>
    // CSS can't stop SMIL, so honour reduced-motion for the wave animation here.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const svg of document.querySelectorAll('svg.wave-layer')) svg.pauseAnimations();
    }
${
  opts.share
    ? `
    // Only offer Share where the platform can actually handle it
    const shareBtn = document.querySelector('.share-btn');
    if (shareBtn && navigator.share) {
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', async () => {
        try {
          await navigator.share(${JSON.stringify({
            title: config.name,
            text: [config.title, config.organization].filter(Boolean).join(" — "),
            url: config.url,
          }).replace(/</g, "\\u003c")});
        } catch (err) {
          // A cancelled share rejects with AbortError; nothing to report
          if (err.name !== 'AbortError') console.error(err);
        }
      });
    }
`
    : ""
}${
  opts.pwa
    ? `
    if ('serviceWorker' in navigator) {
      addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
    }
`
    : ""
}  </script>
</body>
</html>`;

// ── PWA assets ───────────────────────────────────────────────
// A square SVG wrapping the photo (or the initials) sidesteps needing an
// image library to produce the several raster sizes a manifest usually wants.
function buildIconSvg() {
  const inner = photoSrc
    ? `<image href="${photoSrc}" x="0" y="0" width="512" height="512" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="256" y="256" text-anchor="middle" dominant-baseline="central"
        font-family="-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
        font-size="220" font-weight="600" fill="${theme.text}">${escHtml(initials)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${theme.dark}"/>
  ${inner}
</svg>`;
}

function buildManifest() {
  const icons = [
    { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ];
  // Declare the raster photo too, at its true size, for platforms that skip SVG
  if (photoFile?.size) {
    icons.push({
      src: photoFile.name,
      sizes: `${photoFile.size.w}x${photoFile.size.h}`,
      type: `image/${photoFile.mime}`,
      purpose: "any",
    });
  }
  return JSON.stringify(
    {
      name: config.name,
      short_name: config.name.split(/\s+/)[0],
      description: [config.title, config.organization].filter(Boolean).join(" — "),
      start_url: ".",
      scope: ".",
      display: "standalone",
      orientation: "portrait",
      background_color: theme.page,
      theme_color: theme.page,
      icons,
    },
    null,
    2
  );
}

// Cache-first: the card is a fixed snapshot, so a version stamp derived from
// the content is what retires the old cache after a rebuild.
function buildServiceWorker(assets, version) {
  const pathname = new URL(config.url).pathname.replace(/\/+$/, "") || "/";
  const scope = createHash("sha256").update(pathname).digest("hex").slice(0, 12);
  return `const CACHE_PREFIX = 'mecard-${scope}-';
const CACHE = CACHE_PREFIX + '${version}';
const ASSETS = ${JSON.stringify(assets)};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((hit) => hit || fetch(e.request).catch(() => cache.match('index.html')))
    )
  );
});
`;
}

// ── Write ────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const written = [];
function emit(name, data) {
  writeFileSync(join(OUT, name), data);
  written.push(name);
}

emit("index.html", html);

if (opts.pwa) {
  emit("icon.svg", buildIconSvg());
  if (photoFile) emit(photoFile.name, photoFile.data);
  emit("manifest.webmanifest", buildManifest());

  const assets = ["index.html", "manifest.webmanifest", "icon.svg"];
  if (photoFile) assets.push(photoFile.name);
  // Version the cache off the page content so a rebuild invalidates it
  const version = createHash("sha256").update(html).digest("hex").slice(0, 12);
  emit("sw.js", buildServiceWorker(assets, version));
}

console.log(`✓ Built ${OUT}/ for ${config.name}`);
console.log(`  Files: ${written.join(", ")}`);
console.log(`  QR encodes: ${config.url}`);
console.log(
  `  Waves: ${opts.waves ? "on" : "off"}  Glint: ${opts.glint ? "on" : "off"}` +
    `  Share: ${opts.share ? "on" : "off"}  PWA: ${opts.pwa ? "on" : "off"}`
);
if (opts.pwa && photoFile && !photoFile.size)
  console.warn("! could not read photo dimensions — raster icon omitted from manifest");

// ── Dev server ───────────────────────────────────────────────
if (process.argv.includes("--serve")) {
  const { createServer } = await import("http");
  const port = parseInt(process.env.PORT || "3000", 10);
  const root = realpathSync(OUT);

  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
  };

  const server = createServer((req, res) => {
    let name;
    try {
      name = decodeURIComponent(new URL(req.url, "http://localhost").pathname).slice(1);
      if (name.includes("\0")) throw new Error("Invalid path");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad request");
    }
    if (name === "") name = "index.html";
    let file;
    let body;
    try {
      file = realpathSync(resolve(root, name));
      // Real paths also prevent a symlink in dist/ from escaping the served directory.
      if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error("Not a served file");
      body = readFileSync(file);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(name).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
  server.listen(port, "127.0.0.1", () => console.log(`\n  → http://127.0.0.1:${server.address().port}\n`));
}
