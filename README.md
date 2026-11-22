# FlameX

*Exploring combustion beyond Earth.*

FlameX turns NASA's microgravity combustion research into interactive, cited fire-safety intelligence for future crewed habitats: the ISS, Lunar Gateway, a Moon base and a Mars base. It was built for the NASA Space Apps Challenge.

The same NASA data powers three dashboards, one for each kind of user:

| Role | Workspace | The question it answers |
|---|---|---|
| Researcher | Research lab | "Where is NASA's evidence thin, and what should we test next?" |
| Engineer | Habitat safety | "Is my habitat safe, and what if we change the cabin air?" |
| Student | Learn | "Why does fire behave differently in space, and why does it matter on Earth?" |

## Try it now

**Live website: https://insafselma.github.io/flamex/**

Log in with one of the demo accounts (password `space123`):

| Account | Opens |
|---|---|
| `researcher@nasa.gov` | Research lab: full flame simulator, test-gap finder, material screening, complete data |
| `engineer@nasa.gov` | Habitat safety: fire controls, what-if scenarios, flammability map |
| `student@nasa.gov` | Learn: flame playground, fire basics, Earth benefits |

The website runs entirely in the browser on NASA's public data, so it needs no server:

- **24 NASA PSI combustion investigations**, with their objectives, approach, team and publications, downloaded from NASA's PSI archive.
- **1,982 test rows** read from NASA's 22 experimental tables. Every row can be opened back to the original table line.
- **A flame model fitted on 273 FLEX droplet tests** flown on the ISS. On held-out tests its error is half that of guessing the average, and its 90 % range contains the real result 95–97 % of the time.
- **Search answers** quote NASA's own sentences with clickable sources.

The full version, with AI-written answers and the FlameAtlas knowledge layer, runs with the backend (see *Getting started*).

---

## Why it matters

- **Fire behaves differently in space.** Without gravity, hot gas doesn't rise. Flames become slow, dim spheres, and smoke drifts instead of climbing to a detector.
- **New habitats breathe different air.** Planned Moon and Mars bases assume 34 % O₂ at 56.5 kPa, far from the sea-level air most tests used.
- **The evidence is locked away.** NASA's Physical Sciences Informatics (PSI) system holds 24 combustion investigations in reports, spreadsheets and 689 pages of handwritten test sheets. PSI has no partial-gravity data at all.

---

## Features

### Division of roles
The role is chosen once at sign-up, and login opens the right dashboard. Researchers and engineers can preview each other's view.

| Feature | Researcher | Engineer | Student |
|---|---|---|---|
| Flame simulator | Full model | Decision view | Playground |
| What-if scenarios | Yes | Yes | — |
| Flammability map | Yes | Yes | — |
| Test-gap finder | Yes | — | — |
| Material fire-risk analysis (CSV upload) | Yes | — | — |
| Knowledge-graph (Graph-RAG) answers | Yes | — | — |
| Fire-control pillars (prevention, detection, suppression) | — | Yes | — |
| Investigation library (explore, compare, 3D habitat globes, partial gravity) | Yes | Yes | — |
| Fire basics, Earth impact, ISS globe | — | — | Yes |
| Cited AI chat | Yes | Yes | Yes |

### Flame simulator
- **Inputs:** fuel, oxygen, pressure, CO₂, helium and droplet size.
- **Model:** a droplet-flame model trained on NASA's FLEX and CFI tests flown on the ISS.
- **Outputs:** fuel burned, extinction diameter and burning rate, each with a 90 % range.
- **Trust check:** the distance to the nearest real NASA test, extrapolation warnings, and links to the nearest test records.
- **Cost:** free and instant (no AI call).

### Flammability map
- An oxygen × pressure heatmap per fuel, with real NASA tests as dots and habitats as stars.
- Untested zones are hatched, because the colour can't be trusted there.
- Clicking a cell moves the simulator to that point.

### What-if scenarios
1. Start from a habitat's real cabin air.
2. Change something: move a slider (free), or type a sentence such as "Mars base raises oxygen to 30 %" (one AI call, about $0.01, then cached).
3. Compare fuel burned before → after for every fuel.
4. See how the supporting NASA studies re-rank.

### Researcher tools
- **Test-gap finder:** the untested conditions near a habitat where a new experiment would teach the model the most.
- **Material fire-risk analysis:** upload a CSV of materials (one per row, with an `id` column). Each material is matched to what NASA burned and checked against every cabin's oxygen. You get:
  - a risk level and confidence;
  - cited reasons;
  - the data that's missing;
  - contradiction flags;
  - an HTML report.

### Cited AI answers
- Retrieval-augmented generation over the PSI documents.
- Every answer cites `[S1]`-style sources that open the exact passage.
- A second fact-check pass removes unsupported sentences.
- Researchers can add the knowledge graph (Graph-RAG). On 10 test questions it raised the expected items named from 75 % to 100 % and correct citations from 8 to 10.

### For students
- A flame playground with one oxygen slider and plain-language results from the same NASA model.
- Illustrated fire basics.
- How space combustion research helps on Earth.
- A history timeline from Apollo 1 to today.

---

## Architecture

```
NASA PSI sources (reports, CSV tables, scanned test sheets, NTRS papers)
        │  extraction: parsers, LLM, Claude vision for handwritten sheets
        ▼
FlameAtlas knowledge layer
  • experiment table (every row keeps its source chunk id)
  • hybrid search index (dense + keyword + reranker)
  • knowledge graph (442 nodes, 678 edges)
  • droplet-flame prediction model
  • AHP + OWA ranking of investigations per habitat
        │  FastAPI (api.py)
        ▼
FlameX frontend (React + Vite): role-based dashboards
```

**Backend:**
- Python with FastAPI and ChromaDB.
- MiniLM embeddings, TF-IDF and a reranker for search.
- Claude for answers, extraction and vision.

**Frontend:**
- React 18 and Vite.
- `d3-geo` and `topojson` for the globes.
- Hand-built SVG charts.
- A CSS design system with dark and light themes.

---

## Getting started

### Public version (no backend)
Run from `frontend/`:
```bash
npm install
npm run data:fetch     # download the NASA PSI records and test tables into nasa-data/ (already included)
npm run data:build     # convert them into public/demo/ (already included)
npm run build:demo     # static site in dist-demo/, deployable anywhere (GitHub Pages, Netlify…)
```
- `nasa-data/` holds the raw NASA downloads (466 KB, public data).
- `scripts/build-nasa-data.mjs` turns them into the site's data.
- `nasaModel.js` is the flame model.
- `demo.js` answers every dashboard request in the browser.

### Backend (FlameAtlas)
Run everything from the backend repo root.
```bash
pip install -r requirements.txt anthropic
# .env:  LLM_PROVIDER=anthropic   ANTHROPIC_API_KEY=...
python api.py          # http://localhost:8000, interactive docs at /docs
```
- The first start takes about 20 s while the search models load.
- Only new AI questions need the API key; everything else works offline.

### Frontend (FlameX)
```bash
cd frontend
npm install
cp .env.example .env
npm run dev            # http://localhost:5173
```
- **Backend on your machine:** keep `VITE_API_URL=http://localhost:8000`.
- **Backend on a teammate's machine through ngrok:** use the dev proxy, which avoids CORS and ngrok's warning page:
  ```
  BACKEND_PROXY_TARGET=https://<their-tunnel>.ngrok-free.dev
  VITE_API_URL=/backend
  ```
  Restart `npm run dev` after editing `.env`.

### Demo accounts
Password `space123`: `researcher@nasa.gov`, `engineer@nasa.gov`, `student@nasa.gov`.

### Test file
`frontend/samples/materials_test.csv` holds 14 materials for the researcher's material analysis. Its property values are approximate test data, not measurements.

---

## API overview

| Method | Route | What it returns | AI cost |
|---|---|---|---|
| GET | `/habitats` | the 4 habitats and their atmospheres | free |
| GET | `/investigations`, `/investigation/{id}`, `/compare?ids=` | investigation summaries and experiment rows | free |
| POST | `/rank` | investigations ranked for a habitat (AHP + OWA) | free |
| POST | `/ask` (optional `graph: true`) | cited answer | ~$0.015 new, free cached |
| GET | `/passage?id=` | the source text behind a citation | free |
| GET / POST | `/fuels`, `/predict` | droplet-flame prediction | free |
| GET | `/flammap/{habitat}` | oxygen × pressure flammability map | free |
| GET | `/gaps/{habitat}` | suggested next tests | free (explanation ~$0.005) |
| POST | `/whatif` | before/after scenario | free with values, ~$0.01 for text |
| GET | `/graph`, `/graph/facts` | knowledge graph | free |
| POST | `/materials/upload` · GET `/materials/report/{name}` | material fire-risk analysis and HTML report | ~$0.005 per new row |

---

## Repository layout

```
flame_detection/
└─ frontend/
   ├─ App.jsx, homepage.jsx, sections.jsx, roles.js   app shell, dashboards, role configuration
   ├─ loginpage.jsx, signuppage.jsx, chatpage.jsx      auth and cited chat
   ├─ simulator/          flame simulator, flammability map, what-if, test gaps, playground
   ├─ components/         library, materials analysis, fire controls, Earth impact, history…
   ├─ ui.jsx, styles/     shared components and design system
   ├─ api.js              every backend call (live backend, or demo.js for the public site)
   ├─ demo.js, nasaModel.js  public site: in-browser answers and the FLEX flame model
   ├─ nasa-data/          raw NASA PSI records and experimental tables
   ├─ scripts/            fetch-nasa.mjs (download) and build-nasa-data.mjs (convert)
   ├─ samples/            test CSV
   └─ README.md           detailed frontend documentation
```

The backend (FlameAtlas) lives in its own repository.

---

## Honest limits

- **Partial gravity:** PSI has no partial-gravity data, so Moon and Mars buoyancy is not modelled and the app says so in its warnings.
- **Model scope:** the prediction model covers droplet flames only.
- **Assumed atmospheres:** the Gateway, Moon and Mars atmospheres are NASA-considered candidates and are labelled as assumptions.
- **Demo accounts:** accounts are demo-only. Real sign-in and saved conversations need backend endpoints.
- **Public website:** the online version searches and quotes NASA's text instead of writing answers with AI, and screens materials with written-out rules (oxygen index, NASA-STD-6001 Test 1, matches to NASA-tested materials).
- **Decision aid:** the material screening supports decisions; it doesn't replace NASA-STD-6001 testing.

---

## Team
Selma Houari |
Guermoud feriel |
Haraoui kouceila |
Fezzaa Lamri Yaakoub |
Ouail Douaa |

Built for the NASA Space Apps Challenge with data from NASA's Physical Sciences Informatics (PSI) system and the NASA Technical Reports Server (NTRS).

