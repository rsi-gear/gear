"""Download hash-verified public IFEval sources and English tokenizer tables."""

import argparse
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path


def download(url, expected=None):
    with urllib.request.urlopen(url, timeout=90) as response:
        data = response.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024:
        raise ValueError("public artifact exceeds size bound")
    if expected and hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("public artifact checksum mismatch: " + url)
    return data


def prepare(output, nltk_data):
    here = Path(__file__).resolve().parent
    source = json.loads((here / "ifeval-source.json").read_text())
    output = Path(output).resolve()
    package = output / "instruction_following_eval"
    package.mkdir(parents=True, exist_ok=True)
    (package / "__init__.py").write_text("")
    base = (
        "https://raw.githubusercontent.com/google-research/google-research/"
        + source["commit"]
    )
    for name, checksum in source["files"].items():
        destination = package / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(
            download(base + "/instruction_following_eval/" + name, checksum)
        )
    (output / "LICENSE.google-research").write_bytes(download(base + "/LICENSE"))
    (output / "manifest.json").write_text(json.dumps(source, indent=2))

    punkt = json.loads((here / "punkt-source.json").read_text())
    archive = download(punkt["source"], punkt["archive_sha256"])
    english = Path(nltk_data).resolve() / "tokenizers/punkt_tab/english"
    english.mkdir(parents=True, exist_ok=True)
    # Extract only the four declared plain-text tables; never extract arbitrary paths.
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        for name, checksum in punkt["files"].items():
            if name not in {
                "collocations.tab",
                "sent_starters.txt",
                "abbrev_types.txt",
                "ortho_context.tab",
            }:
                raise ValueError("unexpected tokenizer table")
            with zipped.open("punkt_tab/english/" + name) as file:
                content = file.read(2 * 1024 * 1024 + 1)
            if hashlib.sha256(content).hexdigest() != checksum:
                raise ValueError("tokenizer table checksum mismatch")
            (english / name).write_bytes(content)
    (english / "source.json").write_text(json.dumps(punkt, indent=2))
    print(
        json.dumps(
            {
                "ifeval_root": str(output),
                "nltk_data": str(Path(nltk_data).resolve()),
                "commit": source["commit"],
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--nltk-data", default=str(Path(sys.prefix) / "nltk_data"))
    args = parser.parse_args()
    prepare(args.output, args.nltk_data)
