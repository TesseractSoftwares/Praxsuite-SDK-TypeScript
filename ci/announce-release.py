"""Builds the release card the pipeline posts to PraxSpace.

Derived from CHANGELOG.md, never hand-written: a feed somebody maintains by hand drifts from the
changelog within a release or two and then quietly lies about what shipped.

A card is something you SCAN, so only the headline of each bullet survives - the paragraph under it
belongs in the changelog the card links to. Everything is read from the environment so the pipeline
step needs no heredoc, which is what broke a YAML block scalar in a sibling pipeline.
"""

import json
import os
import re
import sys

try:
    raw = open(os.environ["NOTES_FILE"], encoding="utf-8").read()
except OSError:
    raw = ""

# Whether the release breaks callers is decided on the WHOLE section, before any truncation.
# Deciding it afterwards would hide exactly the releases people most need warning about.
is_breaking = bool(re.search(r"\bbreaking\b", raw, re.I))


def flush(buffer, out):
    """Folds one bullet's wrapped lines back together and keeps its first sentence."""
    text = " ".join(buffer).strip()
    if not text:
        return
    text = re.sub(r"[*`]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    # A full stop followed by a capital ends a sentence; a decimal point or a version number does
    # not, which is why the lookahead is there.
    match = re.search(r"\.\s+(?=[A-Z])", text)
    if match:
        text = text[:match.start()]
    text = text.rstrip(" .")
    if len(text) > 170:
        text = text[:167].rsplit(" ", 1)[0] + "..."
    if text:
        out.append("- " + text)


lines = []
pending = []
for line in raw.splitlines():
    stripped = line.strip()
    if stripped.startswith("### "):
        flush(pending, lines)
        pending = []
        lines.append("")
        lines.append(stripped[4:].strip() + ":")
    elif stripped.startswith("- "):
        flush(pending, lines)
        pending = [stripped[2:]]
    elif pending and stripped and line.startswith((" ", "\t")) and not stripped.startswith("```"):
        # A continuation line of the bullet above. Cutting at the source newline instead would end
        # most bullets mid-sentence, which makes the summary harder to read than the changelog.
        pending.append(stripped)
    elif not stripped:
        flush(pending, lines)
        pending = []
flush(pending, lines)

summary = "\n".join(lines).strip()
summary = re.sub(r"\n{3,}", "\n\n", summary)

if len(summary) > 900:
    summary = summary[:900].rsplit("\n", 1)[0] + "\n\n(el resto, en el changelog)"

package = os.environ["PACKAGE"]
version = os.environ["VERSION"]
install = os.environ.get("INSTALL", "").strip()
source_key = os.environ["SOURCE_KEY"]

title = "{} {}".format(package, version)
if is_breaking:
    title += "  - cambio incompatible"

body_parts = [part for part in (install, summary) if part]

card = {
    "sourceKey": source_key,
    "type": "release",
    "title": title,
    "body": "\n\n".join(body_parts),
    "author": "Praxsuite",
    "ref": "v" + version,
    "url": os.environ.get("RELEASE_URL", ""),
    # Dedupe key. A re-run of the same pipeline must not post the card twice, and the ingest
    # endpoint drops anything whose External Id it has already seen.
    "externalId": "release-{}-{}".format(source_key.lower(), version),
}

sys.stdout.write(json.dumps(card, ensure_ascii=False))
