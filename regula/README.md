# Regula Document Analyser

A web-based identity document verification app powered by the **Regula Document Reader SDK**. Users can upload or scan passports, national IDs, and driver's licenses via a browser — the document is processed by a self-hosted Regula backend running in Docker.

---

## Table of Contents

- [Project Structure](#project-structure)
- [How It Works — Complete Flow](#how-it-works--complete-flow)
- [Connection Architecture](#connection-architecture)
- [Component Breakdown](#component-breakdown)
- [Docker Setup & How Regula Connects](#docker-setup--how-regula-connects)
- [Nginx — The Proxy Layer](#nginx--the-proxy-layer)
- [ngrok — Public Tunnel](#ngrok--public-tunnel)
- [Frontend SDK Initialisation](#frontend-sdk-initialisation)
- [Modal Flow (main.js)](#modal-flow-mainjs)
- [Upload Flow — How a File Actually Gets Processed](#upload-flow--how-a-file-actually-gets-processed)
- [Mobile QR Delegate Flow — Step by Step](#mobile-qr-delegate-flow--step-by-step)
- [CSS Shadow DOM Control](#css-shadow-dom-control)
- [Credentials, Passwords & Delegate Configuration](#credentials-passwords--delegate-configuration)
- [How to Replicate This Project](#how-to-replicate-this-project)
- [Known Issues & Bugs](#known-issues--bugs)

---

## Project Structure

```
regula/
├── css/
│   ├── bootstrap.min.css          # Local Bootstrap fallback (unused — CDN used instead)
│   └── style.css                  # Custom styles + Regula shadow DOM ::part() overrides
├── images/                        # Empty — reserved for future assets
├── js/
│   ├── bootstrap.bundle.min.js    # Local Bootstrap JS fallback (unused — CDN used instead)
│   ├── jquery.slim.min.js         # Local jQuery fallback (unused — CDN used instead)
│   ├── main.js                    # Core app logic: modal lifecycle, readers, events
│   ├── popper.min.js              # Tooltip positioning (local fallback)
│   └── regula.iife.js             # Regula SDK bundle (local copy, unused — CDN used instead)
├── regula.license/                # Empty folder — regula.license file goes here, mounted into Docker
├── config.yml                     # Regula DocReader backend config (sessionApi + DB connection)
├── docker-compose.yml             # Spins up docreader + postgres containers
├── nginx.conf                     # Nginx reverse proxy: CORS, API proxy, static file serving
├── index.html                     # Main app entry point — SDK init, modal HTML, reader elements
├── main.iife.js                   # Duplicate Regula SDK at root level — unused, should be deleted
├── ngrok.exe                      # ngrok binary — should not be committed to git
├── ngrok.zip                      # ngrok archive — should not be committed to git
└── test.html                      # Standalone SDK smoke test — should not be in production
```

---

## How It Works — Complete Flow

```
User opens index.html in browser
         │
         │  Regula SDK loads, defineComponents() registers <document-reader>
         │  License set on all reader elements, RegulaDocumentSDK.initialize() called
         ▼
User clicks "Analyse Document" → Bootstrap modal opens
         │
         ├── Col 1 (Upload): drag-drop zone + "Upload a file" link shown
         │                   reader.delegateProcessing set to { serviceURL: BACKEND_URL }
         │
         └── Col 2 (Mobile): POST /api/v2/transaction/start called immediately
                              transactionId + tag set on mobileReader element
                              MutationObserver waits for shadow DOM mobile button → clicks it
                              SDK auto-renders QR code for phone to scan
         │
         │  User either:
         │  A) Drags/drops file or clicks "Upload a file" → processFile() runs
         │  B) Scans QR with phone → phone submits document via delegateURL
         ▼
Both paths send document data to BACKEND_URL → ngrok tunnel → Nginx → DocReader container
         │
         │  DocReader processes image: OCR, MRZ extraction, field parsing
         │  Result stored in Postgres (for mobile path) or returned directly (for upload path)
         ▼
document-reader custom event fires on the reader element
         │
         └── event.detail contains: MRZ data, document fields, photo, validity flags
```

---

## Connection Architecture

```
Browser / Phone
      │
      │  HTTPS  →  https://dingo-limit-hedging.ngrok-free.dev  (BACKEND_URL)
      ▼
┌──────────────────────────────────────┐
│  ngrok tunnel                        │
│  Public HTTPS → localhost:9090       │
│  Also sets ngrok-skip-browser-       │
│  warning header (handled in nginx)   │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│  Nginx  (port 9090)                  │
│                                      │
│  /api/*  → proxy_pass :8080          │
│    + proxy_set_header Host           │
│    + proxy_set_header X-Real-IP      │
│    + proxy_set_header                │
│        ngrok-skip-browser-warning    │
│    + proxy_hide_header               │
│        Access-Control-Allow-Origin   │
│    + add_header CORS headers         │
│    + OPTIONS → 204                   │
│                                      │
│  /*  → /usr/share/nginx/html         │
│        try_files (SPA routing)       │
└──────────────┬───────────────────────┘
               │  port 8080
               ▼
┌──────────────────────────────────────┐
│  Regula DocReader container          │
│  image: regulaforensics/docreader:7  │
│  container_name: docreader           │
│  port: 8080                          │
│  no restart policy                   │
│                                      │
│  Volumes mounted:                    │
│  ./regula.license →                  │
│    /app/extBin/unix/regula.license   │
│  ./config.yml → /app/config.yaml     │
│                                      │
│  Processes documents                 │
│  Scenario: MrzAndLocate              │
└──────────────┬───────────────────────┘
               │  internal Docker network: docreader-network
               │  hostname: db-postgres:5432
               ▼
┌──────────────────────────────────────┐
│  PostgreSQL container                │
│  image: postgres:latest              │
│  restart: always                     │
│  port: 5432                          │
│  volume: postgre-data (named)        │
│                                      │
│  POSTGRES_DB: regula_docreader_db    │
│  POSTGRES_USER: regula               │
│  POSTGRES_PASSWORD: Regulapasswd#1   │
│                                      │
│  Stores mobile transaction sessions  │
└──────────────────────────────────────┘
```

### Port map

| Component | Listens on | Reached via |
|---|---|---|
| ngrok | public HTTPS 443 | internet / phone |
| Nginx | localhost:9090 | ngrok tunnel |
| DocReader | localhost:8080 | Nginx proxy_pass + `host.docker.internal` |
| PostgreSQL | localhost:5432 | DocReader container via `db-postgres:5432` |

### Why each layer exists

| Layer | Why you cannot remove it |
|---|---|
| ngrok | Phone cannot reach localhost — needs a public HTTPS URL for QR delegate flow |
| Nginx | DocReader has no CORS headers — browser blocks direct calls; also serves static files |
| Docker network | Isolates DocReader + Postgres; lets them communicate by container name |
| config.yml sessionApi | Without `sessionApi.enabled: true`, `/api/v2/transaction/start` returns 404 and mobile QR fails |

---

## Component Breakdown

### index.html

Load order (important):
1. `<head>`: Bootstrap CSS from CDN
2. `<head>`: `style.css`
3. `<head>`: Regula SDK from CDN (`unpkg.com/@regulaforensics/vp-frontend-document-components@latest`)
4. `<head>`: Inline `<script>` — sets globals, inits SDK, calls `defineComponents()`
5. `<head>`: `qrcodejs` from CDN (loaded but never used — dead dependency)
6. `<body>`: jumbotron + modal HTML with 3 `<document-reader>` elements
7. End of `<body>`: jQuery, Popper, Bootstrap JS from CDN
8. End of `<body>`: `js/main.js`

The inline script in `<head>` runs before the DOM is ready, which is why `defineComponents()` uses `.then()` to set license attributes — the elements exist in HTML but the custom element definition is async.

Three `<document-reader>` elements declared in HTML:
- `#documentReader` — Col 1, upload mode, inside `#regula-container`
- `#mobileReader` — Col 2, mobile delegate mode, inside `#mobile-container`, attributes: `mobile-delegate`, `switch-to-mobile`, `show-mobile-button`
- `#qrReader` — Col 3, permanently hidden via `style="display:none !important;"`, never initialised in JS

SDK initialisation sequence in the inline script:
```
new Regula.DocumentReaderService({ serviceURL: BACKEND_URL })
    │
    ├── recognizerProcessParam = { processParam: { scenario: 'MrzAndLocate' }, delegateProcessing: { serviceURL, delegateURL } }
    ├── imageProcessParam      = { processParam: { scenario: 'MrzAndLocate' }, delegateProcessing: { serviceURL, delegateURL } }
    └── startParams            = { sessionApi: { serviceURL: BACKEND_URL } }

Regula.defineComponents()   ← registers <document-reader> custom element
    └── .then(() => {
            set license attribute on documentReader, mobileReader, qrReader
            RegulaDocumentSDK.initialize({ license: LICENSE_KEY })
        })
```

### css/style.css

Uses CSS `::part()` pseudo-element to pierce the shadow DOM of `<document-reader>` and control its internal UI:

| Selector | What it hides/controls |
|---|---|
| `::part(container-close-button)` | Regula's built-in X close button |
| `::part(controls-process-close-button)` | Close button during processing |
| `::part(container-header)` | Header bar inside the reader |
| `::part(menu-title)`, `::part(menu-subtitle)` | Title/subtitle on the menu screen |
| `::part(menu-container)` | Menu wrapper — removes background/shadow/padding |
| `::part(container)` | Outer container — removes border/shadow/background |

Per-column button visibility:

| Column | Container | Visible button | Hidden buttons |
|---|---|---|---|
| Col 1 | `#regula-container` | none (gallery button hidden too — triggered programmatically) | camera, mobile, gallery |
| Col 2 | `#mobile-container` | mobile button only | camera, gallery; also hides remote-scanner-title/subtitle |
| Col 3 | `#qr-container` | none | all buttons + title/subtitle (entire col hidden anyway) |

Note: Col 1's gallery button (`menu-from-gallery-button`) is hidden via CSS but still exists in the shadow DOM. `main.js` programmatically clicks it via `shadowRoot.querySelector('[part="menu-from-gallery-button"]')` when the user clicks "Upload a file". This is the only way to trigger the file picker from outside the Web Component.

### js/main.js

All code runs inside `DOMContentLoaded`. Reads `window.BACKEND_URL` and `window.LICENSE_KEY` from globals set by `index.html`.

Key functions:

| Function | Purpose |
|---|---|
| `processFile(file)` | Validates file type, shows preview in footer, sets `reader.image = file` to pass file directly to SDK |
| `onUploadLinkClick(e)` | Clicks the hidden gallery button inside shadow DOM to open file picker |
| `onFileInputChange()` | Defined but never attached to any element — dead code |
| `waitForShadowBtn(element, partName, callback)` | Uses MutationObserver to wait for a shadow DOM button to appear, then calls callback |
| `onDragOver / onDragLeave / onDrop` | Named drag handlers (named so they can be removed before re-adding to prevent stacking) |

### config.yml

```yaml
service:
  sessionApi:
    enabled: true        # REQUIRED for mobile QR transaction flow
  database:
    connectionString: "sqlite:////tmp/regula_docreader.db"   # WRONG — mismatches docker-compose Postgres
```

`sessionApi.enabled: true` is critical — without it the `/api/v2/transaction/start` endpoint does not exist and the entire mobile QR flow fails silently.

### docker-compose.yml

```yaml
docreader:
  container_name: docreader          # explicit name used when exec-ing into container
  image: regulaforensics/docreader:7 # pinned to version 7
  depends_on: db-postgres            # waits for postgres to start (not health-checked)
  # no restart policy — if it crashes it stays down

db-postgres:
  image: postgres:latest             # not pinned — will pull latest on first run
  restart: always                    # auto-restarts on crash or reboot
  volumes:
    - postgre-data:/var/lib/postgresql/data   # note: typo in volume name (postgre not postgres)
```

### nginx.conf

```nginx
server {
    listen 9090;

    location /api/ {
        proxy_pass http://host.docker.internal:8080/api/;
        proxy_set_header Host $host;                        # forwards original host header
        proxy_set_header X-Real-IP $remote_addr;            # forwards real client IP
        proxy_set_header ngrok-skip-browser-warning true;   # bypasses ngrok browser warning page

        proxy_hide_header Access-Control-Allow-Origin;      # removes DocReader's own CORS header
        add_header Access-Control-Allow-Origin * always;    # adds wildcard CORS
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;

        if ($request_method = OPTIONS) { return 204; }      # handles preflight
    }

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;                   # SPA routing fallback
    }
}
```

`host.docker.internal` — special DNS name provided by Docker Desktop (Mac/Windows). Resolves to the host machine IP from inside a container. This is how Nginx (running in Docker) reaches DocReader (also on the host at port 8080).

---

## Docker Setup & How Regula Connects

```
docker-compose up
```

Startup order:
1. `db-postgres` starts first (DocReader `depends_on` it)
2. `docreader` starts, mounts license file and config, connects to Postgres

Container-to-container communication:
- Both on `docreader-network` bridge
- DocReader reaches Postgres at `db-postgres:5432` — Docker resolves the container name as a hostname
- No IP addresses needed, no port exposure between containers needed

Volume mounts on DocReader:
```
./regula.license  →  /app/extBin/unix/regula.license   (license validation)
./config.yml      →  /app/config.yaml                  (service configuration)
```

### Current mismatch — config.yml vs docker-compose.yml

| File | Database configured |
|---|---|
| `config.yml` | SQLite at `/tmp/regula_docreader.db` |
| `docker-compose.yml` | PostgreSQL container `db-postgres` |

This means DocReader currently ignores Postgres entirely and uses a local SQLite file inside the container. Sessions are lost every time the container restarts. To fix:

```yaml
# config.yml — corrected
service:
  sessionApi:
    enabled: true
  database:
    connectionString: "postgresql://regula:Regulapasswd#1@db-postgres:5432/regula_docreader_db"
```

---

## Nginx — The Proxy Layer

Nginx is the single entry point for all traffic on port 9090. It does two jobs:

**Job 1 — API proxy:** Any request to `/api/*` is forwarded to DocReader at port 8080. Nginx adds CORS headers because DocReader does not include them by default, which would cause the browser to block all responses.

**Job 2 — Static file server:** All other requests serve files from `/usr/share/nginx/html` with SPA fallback (`try_files` returns `index.html` for unknown paths).

The `ngrok-skip-browser-warning: true` header is forwarded to DocReader. This is required because ngrok free tier shows an interstitial warning page for browser requests — this header bypasses it for API calls.

---

## ngrok — Public Tunnel

ngrok creates a public HTTPS URL that tunnels to your local port 9090 (Nginx).

```bash
ngrok http 9090
# Output: https://dingo-limit-hedging.ngrok-free.dev -> http://localhost:9090
```

This URL becomes `BACKEND_URL`. It must be updated in `index.html` every time ngrok restarts (free tier generates a new subdomain each time).

The mobile QR flow specifically requires ngrok because:
- The QR code contains `BACKEND_URL?tag={tag}`
- The user's phone scans this and opens it in a mobile browser
- The phone must be able to reach the backend over the internet — `localhost` is unreachable from a phone

---

## Frontend SDK Initialisation

```
<head> inline script runs (before DOM ready)
    │
    ├── window.BACKEND_URL = 'https://...'
    ├── window.LICENSE_KEY = 'AAEAADe...'
    │
    ├── new Regula.DocumentReaderService({ serviceURL: BACKEND_URL })
    │     Sets base URL for all SDK API calls
    │
    ├── RegulaDocumentSDK.recognizerProcessParam = {
    │     processParam: { scenario: 'MrzAndLocate' },
    │     delegateProcessing: { serviceURL, delegateURL: BACKEND_URL + '?tag={tag}' }
    │   }
    │
    ├── RegulaDocumentSDK.imageProcessParam = {
    │     processParam: { scenario: 'MrzAndLocate' },   ← same scenario for both
    │     delegateProcessing: { serviceURL, delegateURL }
    │   }
    │
    ├── RegulaDocumentSDK.startParams = {
    │     sessionApi: { serviceURL: BACKEND_URL }
    │   }
    │
    └── Regula.defineComponents()   ← async, registers <document-reader> Web Component
            └── .then(() => {
                    // DOM is ready by now
                    ['documentReader', 'mobileReader', 'qrReader'].forEach(id => {
                        el.setAttribute('license', LICENSE_KEY)
                        // qrReader also gets license even though Col 3 is hidden
                    })
                    RegulaDocumentSDK.initialize({ license: LICENSE_KEY })
                })
```

`MrzAndLocate` scenario — tells DocReader to locate the document in the image and extract MRZ (Machine Readable Zone) data. This is the processing mode applied to all document scans.

---

## Modal Flow (main.js)

### On modal open — `shown.bs.modal`

```
shown.bs.modal fires
    │
    ├── Col 1: documentReader
    │   ├── reader.settings = { copyright: false }
    │   │     Hides Regula copyright watermark
    │   │
    │   ├── reader.delegateProcessing = { serviceURL: BACKEND_URL }
    │   │     Tells reader where to send processed images
    │   │
    │   ├── uploadLink: removeEventListener then addEventListener (prevents stacking)
    │   │     Click → shadowRoot.querySelector('[part="menu-from-gallery-button"]').click()
    │   │     Opens native file picker via hidden shadow DOM button
    │   │
    │   ├── dragZone: remove + re-add dragover/dragleave/drop handlers
    │   │     drop → processFile(e.dataTransfer.files[0])
    │   │
    │   └── reader.addEventListener('document-reader', handler)
    │         ⚠ NOT deduplicated — stacks on every modal open
    │
    └── Col 2: mobileReader
        ├── mobileReader.settings = { copyright: false }
        │
        ├── mobileReader.delegateProcessing = {
        │     serviceURL: BACKEND_URL,
        │     delegateURL: BACKEND_URL + '?tag={tag}'
        │   }
        │
        ├── fetch(BACKEND_URL + '/api/v2/transaction/start', { method: 'POST', body: '{}' })
        │     └── .then(data => {
        │             mobileReader.transactionId = data.transactionId
        │             mobileReader.tag = data.tag
        │             waitForShadowBtn(mobileReader, 'menu-from-mobile-button', btn => btn.click())
        │         })
        │         waitForShadowBtn uses MutationObserver on shadow DOM
        │         When button appears → clicks it → SDK renders QR code automatically
        │
        └── mobileReader.addEventListener('document-reader', handler)
              ⚠ NOT deduplicated — stacks on every modal open
```

### On modal close — `hidden.bs.modal`

```
hidden.bs.modal fires
    │
    ├── Clear UI state
    │   ├── dragDropPreview.src = ''  ⚠ element does not exist in index.html — silent no-op
    │   ├── dragDropDefault.style.display = 'flex'
    │   ├── filePreviewFooter.style.display = 'none'
    │   └── footerPreviewImg.src = ''
    │
    ├── Reset Col 1 reader (destroy + recreate)
    │   ├── container.removeChild(reader)
    │   └── createElement('document-reader') with:
    │         id="documentReader", locale="en", close-button="false"
    │         start-screen="true", license=LICENSE_KEY
    │         delegateProcessing = { serviceURL: BACKEND_URL }
    │         style="display:block;width:100%;"
    │
    └── Reset Col 2 reader (destroy + recreate)
        ├── mobileContainer.removeChild(mobileReader)
        └── createElement('document-reader') with:
              id="mobileReader", locale="en", close-button="false"
              start-screen="true", mobile-delegate="true"
              switch-to-mobile="true", show-mobile-button="true"
              license=LICENSE_KEY
              delegateProcessing = { serviceURL, delegateURL: BACKEND_URL + '?tag={tag}' }
              style="display:block;width:100%;"

Col 3 (qrReader) — NOT reset, never was initialised, permanently hidden
```

Destroy + recreate is necessary because `<document-reader>` has no public reset API. Simply clearing properties leaves the component in an unknown internal state.

---

## Upload Flow — How a File Actually Gets Processed

```
User drags file onto dragDropZone  OR  clicks "Upload a file" link
    │
    ├── Drag path:  onDrop() → processFile(e.dataTransfer.files[0])
    └── Click path: onUploadLinkClick()
                        → shadowRoot.querySelector('[part="menu-from-gallery-button"]').click()
                        → native OS file picker opens
                        → user selects file
                        → SDK internally calls processFile equivalent

processFile(file):
    ├── Check file.type against allowed list
    │   ['image/png','image/jpeg','image/bmp','image/tiff','image/webp']
    │   ⚠ No file size check — tooltip says "Max 5MB" but code does not enforce it
    │
    ├── FileReader.readAsDataURL(file)
    │   → footerPreviewImg.src = dataURL   (shows thumbnail in footer)
    │   → footerPreviewName.textContent = file.name
    │   → filePreviewFooter.style.display = 'flex'
    │
    └── reader.image = file
          Sets the file directly as a property on the <document-reader> element
          SDK picks this up and sends it to DocReader via:
          POST BACKEND_URL/api/v2/process  (with imageProcessParam scenario: MrzAndLocate)
              │
              └── DocReader returns JSON result
                  → 'document-reader' custom event fires on reader element
                  → event.detail contains extracted fields
```

---

## Mobile QR Delegate Flow — Step by Step

```
1. Modal opens
       │
       └── fetch POST /api/v2/transaction/start
               └── DocReader creates a session in Postgres
                   Returns: { transactionId: "abc", tag: "xyz" }

2. mobileReader.transactionId = "abc"
   mobileReader.tag = "xyz"
   waitForShadowBtn → clicks menu-from-mobile-button in shadow DOM

3. SDK generates QR code containing:
   https://dingo-limit-hedging.ngrok-free.dev?tag=xyz

4. User's phone scans QR code
       │
       └── Phone browser opens: https://dingo-limit-hedging.ngrok-free.dev?tag=xyz
               │
               └── ngrok → Nginx → DocReader
                   DocReader serves a mobile capture page for tag=xyz

5. User captures document on phone camera
       │
       └── Phone submits image to DocReader
           DocReader processes image (MrzAndLocate scenario)
           Stores result in Postgres against tag=xyz / transactionId=abc

6. Desktop browser polls DocReader using transactionId=abc
       │
       └── DocReader returns result from Postgres
           'document-reader' event fires on mobileReader element
           event.detail contains extracted document data
```

---

## CSS Shadow DOM Control

The `<document-reader>` Web Component renders all its UI inside a shadow DOM. Normal CSS cannot reach inside it. The only way to style it from outside is via `::part()` pseudo-element on parts that the component explicitly exposes.

```css
/* Syntax */
element-name::part(part-name) { ... }

/* Example from style.css */
document-reader::part(container-close-button) { display: none !important; }
```

Parts used in this project:

| Part name | Location |
|---|---|
| `container-close-button` | X button on the reader container |
| `controls-process-close-button` | X button during active processing |
| `container-header` | Top header bar |
| `menu-title` | Title text on start menu |
| `menu-subtitle` | Subtitle text on start menu |
| `menu-container` | The menu wrapper div |
| `container` | Outermost container div |
| `menu-from-camera-button` | "Use camera" button |
| `menu-from-gallery-button` | "Upload from gallery" button |
| `menu-from-mobile-button` | "Use mobile" button |
| `remote-scanner-title` | Title on QR/mobile screen |
| `remote-scanner-subtitle` | Subtitle on QR/mobile screen |

Parts are also used in `main.js` via `shadowRoot.querySelector('[part="..."]')` to programmatically click buttons.


---

## Credentials, Passwords & Delegate Configuration

There are **5 credentials** in this project. Each lives in a different file and serves a different purpose. Getting any one of them wrong breaks a specific part of the flow.

---

### 1. Regula License Key (string — for frontend SDK)

**What it is:** Base64 encoded key from your Regula account. Unlocks the `<document-reader>` Web Component and the `RegulaDocumentSDK` in the browser.

**Where it lives:**
```html
<!-- index.html -->
window.LICENSE_KEY = 'AAEAADeBk3Ctwo4V...HQzlB';
```

**How it flows through the code:**
```
window.LICENSE_KEY
    │
    ├── Regula.defineComponents().then(() => {
    │       el.setAttribute('license', LICENSE_KEY)   ← set on documentReader, mobileReader, qrReader
    │       RegulaDocumentSDK.initialize({ license: LICENSE_KEY })
    │   })
    │
    └── main.js hidden.bs.modal reset:
            newReader.setAttribute('license', LICENSE_KEY)       ← Col 1 recreated element
            newMobileReader.setAttribute('license', LICENSE_KEY) ← Col 2 recreated element
```

**What breaks if wrong:** SDK shows a license error, `<document-reader>` renders but refuses to process any document.

---

### 2. regula.license file (for Docker container)

**What it is:** A binary license file downloaded from your Regula account portal. Different from the LICENSE_KEY string — this is for the backend DocReader container.

**Where it lives:** `./regula.license/` folder in project root (currently empty in this repo).

**How it connects to Docker:**
```yaml
# docker-compose.yml
volumes:
  - ./regula.license:/app/extBin/unix/regula.license
```
Mounted into the container at startup. DocReader reads this file before accepting any API requests.

**What breaks if missing/wrong:** Container starts but returns HTTP 403 on all `/api/` calls. The frontend SDK will show processing errors.

**Note:** The LICENSE_KEY string and the regula.license file both come from the same Regula account but are two separate things — one for the browser, one for the server.

---

### 3. Postgres Password (delegate session storage)

**What it is:** Password for the PostgreSQL database that stores mobile QR transaction sessions.

**Where it lives (hardcoded in two places — must match exactly):**

```yaml
# docker-compose.yml
environment:
  POSTGRES_DB: "regula_docreader_db"
  POSTGRES_USER: "regula"
  POSTGRES_PASSWORD: "Regulapasswd#1"
```

```yaml
# config.yml — connection string must use identical values
connectionString: "sqlite:////tmp/regula_docreader.db"
# ⚠ CURRENTLY WRONG — must be changed to:
connectionString: "postgresql://regula:Regulapasswd#1@db-postgres:5432/regula_docreader_db"
#                               ^^^^^^  ^^^^^^^^^^^^^  ^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^
#                               user    password       container    database name
#                                                      hostname
```

**How the hostname `db-postgres` works:**
Both containers are on the `docreader-network` Docker bridge. Docker automatically resolves container names as hostnames within the same network. So `db-postgres` resolves to the Postgres container's internal IP — no hardcoded IPs needed.

**What breaks if wrong:** DocReader cannot connect to DB. `/api/v2/transaction/start` fails. Mobile QR flow does not work. Upload flow still works (it does not need the DB).

**Correct approach — `.env` file:**
```
# .env  (add to .gitignore)
POSTGRES_PASSWORD=your-secure-password
```
```yaml
# docker-compose.yml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
```
```yaml
# config.yml
connectionString: "postgresql://regula:${POSTGRES_PASSWORD}@db-postgres:5432/regula_docreader_db"
```

---

### 4. BACKEND_URL (ngrok tunnel URL)

**What it is:** The public HTTPS URL ngrok generates. Every API call in the entire project goes through this URL.

**Where it lives:**
```html
<!-- index.html -->
window.BACKEND_URL = 'https://dingo-limit-hedging.ngrok-free.dev';
```

**Every place it is used:**

| File | Location | Value |
|---|---|---|
| `index.html` | `RegulaDocumentSDK` init | `serviceURL: BACKEND_URL` |
| `index.html` | `recognizerProcessParam` | `serviceURL` + `delegateURL: BACKEND_URL + '?tag={tag}'` |
| `index.html` | `imageProcessParam` | `serviceURL` + `delegateURL: BACKEND_URL + '?tag={tag}'` |
| `index.html` | `startParams` | `sessionApi: { serviceURL: BACKEND_URL }` |
| `main.js` | Col 1 `reader.delegateProcessing` | `{ serviceURL: BACKEND_URL }` |
| `main.js` | Col 2 `mobileReader.delegateProcessing` | `{ serviceURL, delegateURL: BACKEND_URL + '?tag={tag}' }` |
| `main.js` | transaction start fetch | `fetch(BACKEND_URL + '/api/v2/transaction/start')` |
| `main.js` | Col 1 reset (modal close) | `newReader.delegateProcessing = { serviceURL: BACKEND_URL }` |
| `main.js` | Col 2 reset (modal close) | `newMobileReader.delegateProcessing = { serviceURL, delegateURL }` |

**How `delegateURL` works — the QR code mechanism:**
```
delegateURL: BACKEND_URL + '?tag={tag}'
```
- `{tag}` is a literal placeholder string — the Regula SDK replaces it at runtime with the tag returned from `/api/v2/transaction/start`
- The resulting URL (e.g. `https://...ngrok.../...?tag=xyz`) is encoded into the QR code image
- Phone scans QR → opens that URL → DocReader serves a mobile capture page
- Phone submits document → DocReader stores result in Postgres under that tag
- Desktop polls DocReader with `transactionId` → retrieves result

**Why it breaks on ngrok restart:** Free tier generates a new random subdomain every restart. Must update `BACKEND_URL` in `index.html` manually each time. Paid ngrok plan gives a fixed subdomain.

---

### 5. ngrok Auth Token

**What it is:** Personal account token from ngrok.com. Required to start any tunnel.

**How to set it (one time only):**
```bash
ngrok config add-authtoken YOUR_NGROK_AUTH_TOKEN
# Stored at: ~/.config/ngrok/ngrok.yml  (Mac/Linux)
#            %HOMEPATH%\AppData\Local\ngrok\ngrok.yml  (Windows)
```
Never put this in project files or commit to git.

---

### Credentials Summary

| Credential | File | Used by | What breaks if wrong |
|---|---|---|---|
| `LICENSE_KEY` string | `index.html` | Frontend SDK + all reader elements | SDK refuses to process documents |
| `regula.license` file | Docker volume mount | DocReader container | All `/api/` calls return 403 |
| `POSTGRES_PASSWORD` | `docker-compose.yml` + `config.yml` (must match) | Postgres + DocReader | Mobile QR transaction flow fails |
| `BACKEND_URL` | `index.html` | All API calls + QR delegate URL | Everything fails — no backend connectivity |
| ngrok auth token | `~/.config/ngrok/ngrok.yml` | ngrok binary | Tunnel won't start |

---

### Safe `.env` for replication

```
# .env — never commit this file
BACKEND_URL=https://your-ngrok-url
LICENSE_KEY=your-regula-license-key-string
POSTGRES_PASSWORD=your-secure-password
NGROK_AUTHTOKEN=your-ngrok-auth-token
```

---

## How to Replicate This Project

### Step 1 — Get Regula credentials
- Sign up at [regulaforensics.com](https://regulaforensics.com)
- Download `regula.license` file → place in project root
- Copy your license key string → use as `LICENSE_KEY`

### Step 2 — Create project files

`docker-compose.yml`:
```yaml
version: "3.7"
services:
  docreader:
    container_name: docreader
    image: regulaforensics/docreader:7
    volumes:
      - ./regula.license:/app/extBin/unix/regula.license
      - ./config.yml:/app/config.yaml
    ports:
      - "8080:8080"
    depends_on:
      - db-postgres
    networks:
      - app-network

  db-postgres:
    image: postgres:15
    restart: always
    environment:
      POSTGRES_DB: regula_docreader_db
      POSTGRES_USER: regula
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - app-network

volumes:
  postgres-data:
networks:
  app-network:
    driver: bridge
```

`config.yml`:
```yaml
service:
  sessionApi:
    enabled: true
  database:
    connectionString: "postgresql://regula:${POSTGRES_PASSWORD}@db-postgres:5432/regula_docreader_db"
```

`nginx.conf`:
```nginx
server {
    listen 9090;
    location /api/ {
        proxy_pass http://host.docker.internal:8080/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header ngrok-skip-browser-warning true;
        proxy_hide_header Access-Control-Allow-Origin;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;
        if ($request_method = OPTIONS) { return 204; }
    }
    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
```

### Step 3 — Start Docker

```bash
docker-compose up -d
curl http://localhost:8080/api/v2/ping   # must return 200 OK
```

### Step 4 — Start Nginx

Run Nginx with your `nginx.conf`, serving your static files from port 9090.

### Step 5 — Start ngrok

```bash
ngrok config add-authtoken YOUR_NGROK_AUTH_TOKEN
ngrok http 9090
# Copy the https URL — this is your BACKEND_URL
```

### Step 6 — Build index.html

```html
<script src="https://unpkg.com/@regulaforensics/vp-frontend-document-components@latest/dist/main.iife.js"></script>
<script>
    window.BACKEND_URL = 'https://YOUR-NGROK-URL';
    window.LICENSE_KEY = 'YOUR_LICENSE_KEY_STRING';

    window.RegulaDocumentSDK = new Regula.DocumentReaderService({ serviceURL: window.BACKEND_URL });

    window.RegulaDocumentSDK.recognizerProcessParam = {
        processParam: { scenario: 'MrzAndLocate' },
        delegateProcessing: { serviceURL: window.BACKEND_URL, delegateURL: window.BACKEND_URL + '?tag={tag}' }
    };
    window.RegulaDocumentSDK.imageProcessParam = {
        processParam: { scenario: 'MrzAndLocate' },
        delegateProcessing: { serviceURL: window.BACKEND_URL, delegateURL: window.BACKEND_URL + '?tag={tag}' }
    };
    window.RegulaDocumentSDK.startParams = { sessionApi: { serviceURL: window.BACKEND_URL } };

    Regula.defineComponents().then(() => {
        document.getElementById('documentReader').setAttribute('license', window.LICENSE_KEY);
        document.getElementById('mobileReader').setAttribute('license', window.LICENSE_KEY);
        window.RegulaDocumentSDK.initialize({ license: window.LICENSE_KEY });
    });
</script>
```

### Step 7 — Add reader elements

```html
<!-- Upload reader -->
<div id="regula-container">
    <document-reader id="documentReader" locale="en" close-button="false" start-screen="true"
        style="display:block;width:100%;"></document-reader>
</div>

<!-- Mobile QR reader -->
<div id="mobile-container">
    <document-reader id="mobileReader" locale="en" close-button="false" start-screen="true"
        mobile-delegate="true" switch-to-mobile="true" show-mobile-button="true"
        style="display:block;width:100%;"></document-reader>
</div>
```

### Step 8 — Start mobile transaction and listen for results

```javascript
// On modal open — start transaction for mobile QR
fetch(BACKEND_URL + '/api/v2/transaction/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
})
.then(r => r.json())
.then(data => {
    const mobileReader = document.getElementById('mobileReader');
    mobileReader.transactionId = data.transactionId;
    mobileReader.tag = data.tag;
    // wait for shadow DOM button then click it
    const observer = new MutationObserver(() => {
        const btn = mobileReader.shadowRoot && mobileReader.shadowRoot.querySelector('[part="menu-from-mobile-button"]');
        if (btn) { btn.click(); observer.disconnect(); }
    });
    observer.observe(mobileReader, { childList: true, subtree: true });
});

// Listen for results on both readers
document.getElementById('documentReader').addEventListener('document-reader', (e) => {
    console.log('Upload result:', e.detail);
});
document.getElementById('mobileReader').addEventListener('document-reader', (e) => {
    console.log('Mobile result:', e.detail);
});
```

---

## Known Issues & Bugs

| Issue | Severity | Location | Fix |
|---|---|---|---|
| `LICENSE_KEY` hardcoded in HTML | Critical | `index.html` | Inject server-side or via build pipeline |
| `BACKEND_URL` hardcoded in HTML | High | `index.html` | Use environment variable injection |
| `POSTGRES_PASSWORD` hardcoded in docker-compose | High | `docker-compose.yml` | Use `.env` file, never commit |
| `config.yml` uses SQLite, docker-compose uses Postgres | High | `config.yml` | Change to Postgres connection string |
| `document-reader` event listener stacks on modal reopen | Medium | `main.js` | Remove listener before adding each time |
| No file size validation in `processFile()` | Medium | `main.js` | Add `if (file.size > 5*1024*1024) return alert('Max 5MB')` |
| `dragDropPreview` element referenced but does not exist in HTML | Medium | `main.js` hidden.bs.modal | Remove the dead reference or add the element |
| `onFileInputChange` function defined but never attached | Low | `main.js` | Remove dead code |
| `qrReader` gets license set even though Col 3 is permanently hidden | Low | `index.html` | Remove `qrReader` from the `forEach` loop |
| `qrcodejs` CDN loaded but never used | Low | `index.html` | Remove the script tag |
| `Access-Control-Allow-Origin *` in nginx | Medium | `nginx.conf` | Restrict to known origins in production |
| `postgres:latest` not pinned in docker-compose | Low | `docker-compose.yml` | Pin to specific version e.g. `postgres:15` |
| `docreader` container has no `restart` policy | Low | `docker-compose.yml` | Add `restart: unless-stopped` |
| Volume named `postgre-data` (typo — missing 's') | Low | `docker-compose.yml` | Rename to `postgres-data` |
| `test.html` in production with demo license key | Low | `test.html` | Exclude from production build/deploy |
| `ngrok.exe` and `ngrok.zip` committed to repo | Low | root | Add to `.gitignore`, install ngrok separately |
| `main.iife.js` at root is a duplicate of `js/regula.iife.js` | Low | root | Delete `main.iife.js` |
| CDN scripts have no SRI integrity hashes | Low | `index.html` | Add `integrity` + `crossorigin` attributes |
| Bootstrap CSS loaded from CDN but local copy exists unused in `css/` | Low | `index.html` | Pick one source — CDN or local, not both |
