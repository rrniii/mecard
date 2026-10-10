# Ryan R. Neely III — mecard

Ryan's digital business card: **https://rrniii.github.io/mecard/**

Personalised fork of [mgrau/mecard](https://github.com/mgrau/mecard), with a polar-cloud backdrop, Ryan's chosen fieldwork portrait, Leeds/NCAS contact details, Google Scholar, ORCID and GitHub links. Edit `config.yaml` to update the card; a push to `main` rebuilds and publishes it.

The profile and contact details were checked against the [University of Leeds profile](https://environment.leeds.ac.uk/see/staff/1447/dr-ryan-neely-iii) and [NCAS profile](https://people.ncas.ac.uk/people/view/337) on 9 October 2026. Ryan provided and selected the portrait on 10 October 2026.

A digital business card. Edit one YAML file, get a single self-contained HTML page — show it on your phone, and anyone who scans the QR code gets the same card on theirs.

Photo, QR code, and contact file are all inlined, so the output is one HTML file with no external requests.

## Setup

```bash
git clone https://github.com/rrniii/mecard.git
cd mecard
npm ci
```

Edit `config.yaml`, add a square `photo.jpg` (~400×400px), then:

```bash
npm run dev     # build and serve at http://127.0.0.1:3000
npm run build   # write the card and PWA assets into dist/
npm test        # contact, cache and local-server regression checks
```

## Deploy to GitHub Pages

The included workflow builds and publishes on every push to `main` — you don't need to run npm locally after the first setup.

1. Push the repo to GitHub
2. **Settings → Pages → Source** → choose **GitHub Actions**
3. The card goes live at `https://<you>.github.io/<repo>`

Set `url:` in `config.yaml` to that address. The QR code encodes it, so if they don't match the code will point at the wrong place.

## Configuration

### Content

| Key | |
|---|---|
| `name` | Required |
| `title` | Role, e.g. "Assistant Professor" |
| `tagline` | Short line under the title, in the accent colour |
| `organization` | |
| `department` | Joined to `organization` with a `·` |
| `email` | Shown as text, tap to send |
| `phone` | Shown as text, tap to call |
| `website` | Shown as text, opens in a new tab |
| `websiteLabel` | Optional readable label for a long website URL |
| `vcardName` | Optional structured address-book name; see below |
| `photo` | Local path or URL. Omit to show initials instead |
| `background` | Optional local PNG, JPEG or WebP backdrop, embedded in the page; omitting it restores the diagonal bands |
| `url` | Required. Where the card is hosted — encoded into the QR code |

Any of `email`, `phone`, `website`, and `photo` can be left out.

For names with a suffix, supply the address-book fields explicitly:

```yaml
vcardName:
  family: Neely
  given: Ryan
  additional: R.
  prefix: Prof.
  suffix: III
```

The displayed name stays in `name`. The downloaded contact keeps `Neely` as the surname and `III` as the suffix.

### Links

Icon buttons, below the contact details:

```yaml
links:
  - label: Google Scholar
    url: https://scholar.google.com/citations?user=XXXXXXXX
    icon: scholar
  - label: CV
    url: https://example.edu/cv.pdf
    icon: file
```

Available icons:

`scholar` `orcid` `file` `github` `linkedin` `twitter` `globe` `mail` `phone` `link` `calendar` `youtube` `mastodon` `bluesky` `instagram`

An unknown name falls back to `link`.

### Theme

Three colour bands run diagonally across the card, top-left to bottom-right:

```yaml
theme:
  dark:   "#1e1e22"   # top band
  mid:    "#2a3330"   # middle band — omit to blend dark and light
  light:  "#1b4742"   # bottom band
  accent: "#5b9eb8"   # links, icons, tagline
  pop:    "#b34d3a"   # Save Contact button
  page:   "#131315"   # page behind the card
  text:   "#fbf9f6"   # foreground text
```

Muted text is derived from `text`, so changing that one value keeps the hierarchy consistent.

### Options

```yaml
options:
  glint: false              # light sweep across the card
  waves: true               # animate the band boundaries
  qr: true
  saveContact: true
  share: true               # Share button, where the device supports it
  pwa: true                 # installable, works offline
  qrLabel: Scan to connect
  saveLabel: Save Contact
  shareLabel: Share
```

All default to the values above. Animation is disabled automatically for visitors who set `prefers-reduced-motion`.

## Notes

The QR code encodes the card's URL rather than the contact data itself, so it stays sparse enough to scan quickly and you can change your details without the code going stale.

**Save Contact** downloads a vCard 3.0 `.vcf` with the photo embedded, which imports cleanly on iOS and Android.

**Share** uses the Web Share API to hand the card's URL to the system share sheet. The button stays hidden on platforms without it, so nothing appears broken on older desktop browsers.

**PWA**: with `pwa: true` the build also emits `manifest.webmanifest`, `sw.js`, and icons, so the card can be added to your home screen and opens full-screen and offline. Turn it off if you'd rather have `index.html` be the only output — the page itself is self-contained either way.

The build writes to `dist/`, which is gitignored; the workflow publishes that directory.

## License

MIT
