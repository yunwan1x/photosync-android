from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

MANIFEST_NAME = "photosync-model-manifest.json"
MANIFEST_VERSION = 1
DEFAULT_MODELS = {
    "clip": "ViT-B-32__openai",
    "facial-recognition": "buffalo_l",
    "ocr": "PP-OCRv5_mobile",
}


class ModelCacheError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if (
            path.is_file()
            and path.name != MANIFEST_NAME
            and ".cache" not in path.relative_to(root).parts
            and not path.is_symlink()
        ):
            yield path


def build_manifest(root: Path) -> dict[str, Any]:
    files = [
        {
            "path": path.relative_to(root).as_posix(),
            "size": path.stat().st_size,
            "sha256": sha256(path),
        }
        for path in model_files(root)
    ]
    if not files:
        raise ModelCacheError(f"No model files found in {root}")
    return {"version": MANIFEST_VERSION, "models": DEFAULT_MODELS, "files": files}


def write_manifest(root: Path) -> Path:
    manifest_path = root / MANIFEST_NAME
    manifest = build_manifest(root)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest_path


def read_manifest(seed_root: Path) -> dict[str, Any]:
    manifest_path = seed_root / MANIFEST_NAME
    try:
        manifest: dict[str, Any] = json.loads(manifest_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError) as error:
        raise ModelCacheError(f"Invalid or missing model manifest: {manifest_path}") from error
    if manifest.get("version") != MANIFEST_VERSION or manifest.get("models") != DEFAULT_MODELS:
        raise ModelCacheError(f"Unsupported model manifest: {manifest_path}")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ModelCacheError(f"Model manifest contains no files: {manifest_path}")
    return manifest


def validated_entries(seed_root: Path) -> list[dict[str, Any]]:
    manifest = read_manifest(seed_root)
    entries: list[dict[str, Any]] = []
    for raw_entry in manifest["files"]:
        if not isinstance(raw_entry, dict):
            raise ModelCacheError("Invalid model manifest entry")
        relative = Path(str(raw_entry.get("path", "")))
        expected_size = raw_entry.get("size")
        expected_sha256 = raw_entry.get("sha256")
        if (
            not relative.parts
            or relative.is_absolute()
            or ".." in relative.parts
            or not isinstance(expected_size, int)
            or not isinstance(expected_sha256, str)
        ):
            raise ModelCacheError(f"Invalid model manifest entry: {raw_entry}")
        source = seed_root / relative
        if source.is_symlink() or not source.is_file():
            raise ModelCacheError(f"Missing model seed file: {relative}")
        if source.stat().st_size != expected_size or sha256(source) != expected_sha256:
            raise ModelCacheError(f"Model seed checksum mismatch: {relative}")
        entries.append(raw_entry)
    return entries


def file_matches(path: Path, size: int, checksum: str) -> bool:
    return path.is_file() and not path.is_symlink() and path.stat().st_size == size and sha256(path) == checksum


def atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination.name}.",
            dir=destination.parent,
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            with source.open("rb") as source_file:
                shutil.copyfileobj(source_file, temporary, length=1024 * 1024)
            temporary.flush()
            os.fsync(temporary.fileno())
        shutil.copymode(source, temporary_path)
        os.replace(temporary_path, destination)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def sync_cache(seed_root: Path, cache_root: Path) -> tuple[int, int]:
    entries = validated_entries(seed_root)
    cache_root.mkdir(parents=True, exist_ok=True)
    if not os.access(cache_root, os.W_OK):
        raise ModelCacheError(f"Model cache is not writable: {cache_root}")

    copied = 0
    unchanged = 0
    for entry in entries:
        relative = Path(entry["path"])
        destination = cache_root / relative
        if file_matches(destination, entry["size"], entry["sha256"]):
            unchanged += 1
            continue
        atomic_copy(seed_root / relative, destination)
        if not file_matches(destination, entry["size"], entry["sha256"]):
            raise ModelCacheError(f"Copied model checksum mismatch: {relative}")
        copied += 1
    return copied, unchanged


def verify_cache(seed_root: Path, cache_root: Path) -> int:
    entries = validated_entries(seed_root)
    for entry in entries:
        relative = Path(entry["path"])
        if not file_matches(cache_root / relative, entry["size"], entry["sha256"]):
            raise ModelCacheError(f"Model cache checksum mismatch: {relative}")
    return len(entries)


def model_components(cache_root: Path) -> list[Any]:
    os.environ["MACHINE_LEARNING_CACHE_FOLDER"] = cache_root.as_posix()

    from immich_ml.models.clip.textual import OpenClipTextualEncoder
    from immich_ml.models.clip.visual import OpenClipVisualEncoder
    from immich_ml.models.facial_recognition.detection import FaceDetector
    from immich_ml.models.facial_recognition.recognition import FaceRecognizer
    from immich_ml.models.ocr.detection import TextDetector
    from immich_ml.models.ocr.recognition import TextRecognizer

    return [
        OpenClipTextualEncoder(DEFAULT_MODELS["clip"], cache_dir=cache_root / "clip" / DEFAULT_MODELS["clip"]),
        OpenClipVisualEncoder(DEFAULT_MODELS["clip"], cache_dir=cache_root / "clip" / DEFAULT_MODELS["clip"]),
        FaceDetector(
            DEFAULT_MODELS["facial-recognition"],
            cache_dir=cache_root / "facial-recognition" / DEFAULT_MODELS["facial-recognition"],
        ),
        FaceRecognizer(
            DEFAULT_MODELS["facial-recognition"],
            cache_dir=cache_root / "facial-recognition" / DEFAULT_MODELS["facial-recognition"],
        ),
        TextDetector(DEFAULT_MODELS["ocr"], cache_dir=cache_root / "ocr" / DEFAULT_MODELS["ocr"]),
        TextRecognizer(DEFAULT_MODELS["ocr"], cache_dir=cache_root / "ocr" / DEFAULT_MODELS["ocr"]),
    ]


def download_and_validate_models(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for model in model_components(root):
        model.download()
        model.load()
        del model
        gc.collect()
    shutil.rmtree(root / ".cache", ignore_errors=True)
    for cache_metadata in root.rglob(".cache"):
        shutil.rmtree(cache_metadata, ignore_errors=True)


def load_models(root: Path) -> None:
    for model in model_components(root):
        model.load()
        del model
        gc.collect()


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare and verify the PhotoSync offline machine-learning cache")
    subparsers = parser.add_subparsers(dest="command", required=True)

    download_parser = subparsers.add_parser("download")
    download_parser.add_argument("--root", type=Path, required=True)

    manifest_parser = subparsers.add_parser("manifest")
    manifest_parser.add_argument("--root", type=Path, required=True)

    sync_parser = subparsers.add_parser("sync")
    sync_parser.add_argument("--seed-root", type=Path, required=True)
    sync_parser.add_argument("--cache-root", type=Path, required=True)

    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--seed-root", type=Path, required=True)
    verify_parser.add_argument("--cache-root", type=Path, required=True)
    verify_parser.add_argument("--load", action="store_true")

    args = parser.parse_args()
    if args.command == "download":
        download_and_validate_models(args.root)
    elif args.command == "manifest":
        manifest_path = write_manifest(args.root)
        print(f"Wrote model manifest: {manifest_path}")
    elif args.command == "sync":
        copied, unchanged = sync_cache(args.seed_root, args.cache_root)
        print(f"Offline model cache ready: copied={copied}, unchanged={unchanged}")
    elif args.command == "verify":
        count = verify_cache(args.seed_root, args.cache_root)
        if args.load:
            load_models(args.cache_root)
        print(f"Offline model cache verified: files={count}, load={args.load}")


if __name__ == "__main__":
    main()
