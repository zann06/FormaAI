# User guide

FormaAI turns a DOCX template plus your source documents into a written report
that keeps your template's exact structure and formatting. This guide walks
through the whole flow once, then explains each part.

The guiding rule: **FormaAI writes only what your sources support.** When a
section has no evidence, it says so instead of inventing facts, dates, numbers or
names.

---

## 1. Sign up and add a provider key

Create an account, then go to **Settings → Providers**.

FormaAI has no built-in AI key — you bring your own. Choose a provider type:

| Type | Use it for | You need |
| --- | --- | --- |
| **OpenAI-compatible** | OpenAI, Azure OpenAI, OpenRouter, Groq, Together, vLLM, Ollama, most gateways | Base URL (usually ending in `/v1`), model name, API key |
| **Anthropic** | Claude models | Model name, API key |
| **Gemini** | Google models | Model name, API key |

Fill in a display name, the model, and your key, then press **Test connection**.
This makes one small real request with your key, so a wrong Base URL or model name
fails immediately instead of halfway through a report.

Your key is encrypted before it is stored and is never shown again — the list
shows only the last four characters. You can set one credential as the default, and
an optional fallback for when the default fails.

> Your key is yours alone. It is never used to serve another user's request, and
> no other user can see or use it.

---

## 2. Create a project

From the dashboard, choose **New project** and give it a title. Optionally set the
report type, language, tone, audience, target length, and any standing
instructions ("keep it under four pages", "write in the third person"). These
guide the drafting; they are not facts.

---

## 3. Upload your template (this defines the report)

In the workspace, upload a **DOCX template** in the left column.

The template is authoritative. FormaAI does **not** rebuild, restyle or flatten it.
The export is a copy of your own file with your content inserted, so fonts,
margins, headers, footers, logos, tables and page setup all survive.

FormaAI analyses the template for heading styles and shows what it found in the
middle **Outline** column:

- Real Word **heading styles** (Heading 1, Heading 2, …) are detected reliably.
- If your template only uses **manual bold text** as headings, nothing is detected
  and a warning appears — add sections yourself (see §4).

### Using placeholders (optional but recommended)

If your template contains placeholders such as `{{content_introduction}}` on their
own line, FormaAI replaces them exactly in place. This gives the most predictable
result. Without placeholders it inserts content after each heading, which also
works but is slightly less precise about spacing.

---

## 4. Shape the outline

In the **Outline** column you can, per section:

- **Include / exclude** a section — excluded sections are not drafted or exported;
- **Rename** a heading;
- **Reorder** sections;
- **Add a section manually** where the template has no heading style to detect;
- see how many sections are drafted so far (`3/6 drafted`).

Do this *before* generating so nothing is written for content you don't want.

---

## 5. Add source documents

In the left **Sources** column, upload the material the report must be based on:
PDF, DOCX or plain text.

These files are the **only** factual input. Text is extracted, split into passages,
and matched to sections.

---

## 6. Map evidence to sections

Press **Map evidence**. FormaAI retrieves the passages that best match each section
using deterministic text search first, with an optional AI refinement pass.

For every section you can see:

- **Requirements** — what this kind of section normally needs (dates, amounts,
  named participants, …);
- **Evidence** — the exact passages found, with their source document and location;
- **Gaps** — requirements nothing in your sources satisfies;
- **Conflicts** — places where two sources disagree (e.g. two different revenue
  figures). FormaAI surfaces these; it never picks one silently;
- **Coverage** — `strong`, `partial` or `none`.

Review this step. If a section shows no evidence, adding a source now produces a
far better report than fixing the section afterwards.

You can correct any mapping by hand — attach or detach passages, edit the gaps and
the content plan.

---

## 7. Generate

Press **Draft all sections** (or generate one section at a time from its editor).

Each section is written from its mapped evidence only. What to expect:

- Sections with evidence get a draft built on those passages.
- Sections with **no** evidence get an explicit marker:
  `[MISSING: no source material was mapped to this section…]`. This is deliberate.
  An obvious gap is better than a confident fabrication.
- Requirements still unsatisfied at generation time are listed as warnings in the
  section editor.

You can regenerate one section with extra instructions ("shorten to two
paragraphs", "lead with the revenue figure") without touching the others.

---

## 8. Edit and review

The right pane is a full editor for the selected section.

- Edit any wording freely — your edits are saved and are not overwritten by
  regenerating other sections.
- Set each section's status to track review:
  **Draft → Needs review → Validated → Final**.
- Review the **Requirements**, **Gaps**, **Conflicts** and **Placeholders to fill**
  notes above the text.
- Anything still unresolved is your call, not the AI's.

> Generating does not make the report correct. The evidence mapping and your review
> are what make it trustworthy. Read every number before you publish.

---

## 9. Export

In the right-hand **Export** panel:

- **Export editable DOCX** — always available. This is a copy of your template with
  the content inserted, still fully editable in Word.
- **Export PDF** — available when the server has a PDF converter configured. If it
  is not, the panel tells you to export DOCX instead.

Both run in the background; the file appears in the list when ready, with a
download link. Exports are kept for a limited retention window and each one takes a
version snapshot so you can tell exactly what was exported.

---

## 10. History and versions

**History** lists snapshots: automatic ones taken when you export, and manual
checkpoints you create. You can restore any of them. Restoring replaces the current
section content, so create a checkpoint first if you want to keep the current state.

---

## Settings

- **Providers** — add, test, edit or remove your AI credentials; choose default and
  fallback.
- **Usage** — requests, tokens and per-model breakdown for the last 30 days, plus
  your quota state. Usage is recorded per request so you can see what is costing you.
- **Account** — change your password, review active sessions and sign out other
  devices, or delete your account and its data.

---

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Test connection" fails | Check the Base URL (must be the full endpoint, e.g. `https://api.openai.com/v1`), the exact model name, and that the key is valid for that provider |
| No sections detected from my template | The template uses manual bold rather than heading styles. Add sections manually, or apply Heading styles in Word and re-upload |
| A section is empty or shows `[MISSING …]` | No source evidence was mapped to it. Add a relevant source and re-map, or write it yourself |
| Generated text ignores a detail | That detail isn't in the mapped evidence. Add the source, re-map, then regenerate |
| Two sources disagree | The section shows a conflict. Decide which is right, edit the text, and note it |
| PDF export isn't offered | The server has no PDF converter. Export DOCX and convert in Word/LibreOffice |
| "A section is already being generated" | One generation per project runs at a time. Wait for it to finish |
| `429` errors | You hit a rate limit or your daily quota. Wait, or check Usage |

---

## What FormaAI will not do

Being explicit, so expectations are clear:

- It will **not** invent facts, figures, dates, names or citations. Missing evidence
  becomes a visible marker.
- It will **not** change your template's formatting, styles or layout.
- It will **not** create new table rows; tables are filled through placeholders
  only.
- It does **not** support PDF as an editable *template* (DOCX only), and does not
  edit footnotes, tracked changes or SmartArt.
- It does **not** read XLSX, CSV or PPTX in this version.
- It does **not** silently resolve contradictions between sources.
