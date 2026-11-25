# Browser IO measurements

Status: current
Owner: src/tools/browser/

Embedding a website does not by itself make a page read or click faster. The external Playwright backend already keeps its CDP connection warm. The desktop's embedded backend has a different startup/transport path; the measurements below concern the existing external Chrome backend and the shared observation changes, rather than establishing an embedding speedup.

## Reproduce

Run `node --import tsx scripts/benchmark-browser.mjs [label]` from the repository root with a locally installed Chromium-family browser. The [benchmark](../../../../scripts/benchmark-browser.mjs) uses a loopback HTTP fixture, three disposable agent-owned profiles, headless Chrome and no accounts. It removes its profiles and closes its browser processes on exit. The fixture has 80 named regions, 1,601 controls and a full ARIA view of 234,614 characters. All browser/network work is local; there is no model inference.

Cold startup has three samples. Warm readiness has 20 samples; reads and actions have 12 samples after a warm-up. Times include the tool/backend work, without an inference or remote-site/network delay. The script also measures the previous whole-tree-then-filter region algorithm on the same run, so the region comparison remains reproducible after this change. A scoped region observation exposes only that subtree's refs; the script refreshes whole-page refs before clicking the page-level toggle, and uses the new refs returned after each action.

## Recorded comparison

Measured on 2026-11-24 in a Linux arm64 container, Node 26.13.1, Google Chrome 156.0.8078.47. These are single before/after runs, not a controlled browser or machine comparison. The fixture, profile lifetime and sample counts were the same.

| Operation | Before median (ms) | After median (ms) | Before / after p95 (ms) |
| --- | ---: | ---: | ---: |
| Cold `ensureReady` | 283.31 | 316.24 | 438.88 / 483.17 |
| Warm `ensureReady` | <0.01 | <0.01 | 0.01 / 0.01 |
| Full page read | 96.97 | 98.33 | 104.40 / 114.09 |
| Interactive page read | 97.47 | 104.54 | 128.12 / 121.47 |
| Region read | 89.58 | 15.05 | 99.76 / 21.17 |
| Locator click only | 49.77 | 53.13 | 60.71 / 66.80 |
| Click tool, including its returned observation | 54.63 | 174.03 | 101.21 / 256.19 |

The justified extraction improvement is the region read: it asks Playwright for the selected locator's subtree instead of reading all 80 regions and filtering the result. The same 2,721-character region view took about 83% less time (5.95× faster) on this fixture. Whole-page frame URL checks and secret-field masking remain in place. Region observations do not overwrite the whole-page history used by `diff`.

A subsequent verification run measured the old whole-tree algorithm and the new scoped algorithm within the same process: medians were 44.15 ms and 9.56 ms respectively (p95 46.90 / 12.72 ms), a 78% reduction (4.62×). Whole-page reads in that run were also faster at 48.60 ms. This variation reinforces that the supported claim is reduced region traversal cost, rather than a fixed latency promise.

Full/interactive reads and locator clicks have no demonstrated speedup. Interactive output is smaller (24,247 characters versus the 234,614-character full fixture), but still traverses the full page, so filtering alone does not improve extraction time. Cold startup varied by 33 ms, while the already-warm readiness path remained effectively free.

The click tool now returns fresh interactive feedback instead of only a success line. On this fixture that added about 119 ms and returned 8,250 characters including metadata and truncation guidance. The feedback body is bounded to ~8k characters, or a smaller context-window budget, for both cloud and local models. An agent can continue from the resulting refs without requesting a separate read solely to observe the action, but the benchmark does not measure inference time or establish an end-to-end task speedup. There remains one inference per runtime step, and observations continue through `details.worldSnapshot` into the mutable world section rather than the stable prompt prefix.

The fixture does not represent remote network latency, asynchronous applications, real account sign-in, anti-automation behavior or every page shape. Automatic observations are immediate best-effort reads, not a network-idle guarantee; a later asynchronous update can require another read. Desktop GUI behavior and embedded transport latency require separate integration checks.
