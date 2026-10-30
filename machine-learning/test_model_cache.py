import json
from pathlib import Path

import pytest

from immich_ml.model_cache import (
    MANIFEST_NAME,
    ModelCacheError,
    atomic_copy,
    sync_cache,
    verify_cache,
    write_manifest,
)


def make_seed(tmp_path: Path) -> Path:
    seed = tmp_path / "seed"
    (seed / "clip" / "model").mkdir(parents=True)
    (seed / "clip" / "model" / "model.onnx").write_bytes(b"valid model")
    (seed / "ocr").mkdir()
    (seed / "ocr" / "config.json").write_text("{}")
    write_manifest(seed)
    return seed


def test_syncs_empty_cache_and_verifies(tmp_path: Path) -> None:
    seed = make_seed(tmp_path)
    cache = tmp_path / "cache"

    copied, unchanged = sync_cache(seed, cache)

    assert (copied, unchanged) == (2, 0)
    assert verify_cache(seed, cache) == 2


def test_keeps_valid_and_extra_files(tmp_path: Path) -> None:
    seed = make_seed(tmp_path)
    cache = tmp_path / "cache"
    sync_cache(seed, cache)
    extra = cache / "other-model" / "runtime.cache"
    extra.parent.mkdir()
    extra.write_text("keep")

    copied, unchanged = sync_cache(seed, cache)

    assert (copied, unchanged) == (0, 2)
    assert extra.read_text() == "keep"


def test_repairs_corrupt_file(tmp_path: Path) -> None:
    seed = make_seed(tmp_path)
    cache = tmp_path / "cache"
    sync_cache(seed, cache)
    damaged = cache / "clip" / "model" / "model.onnx"
    damaged.write_bytes(b"damaged")

    copied, unchanged = sync_cache(seed, cache)

    assert (copied, unchanged) == (1, 1)
    assert damaged.read_bytes() == b"valid model"


def test_rejects_corrupt_seed(tmp_path: Path) -> None:
    seed = make_seed(tmp_path)
    (seed / "ocr" / "config.json").write_text('{"changed": true}')

    with pytest.raises(ModelCacheError, match="seed checksum mismatch"):
        sync_cache(seed, tmp_path / "cache")


def test_rejects_unsafe_manifest_path(tmp_path: Path) -> None:
    seed = make_seed(tmp_path)
    manifest = json.loads((seed / MANIFEST_NAME).read_text())
    manifest["files"][0]["path"] = "../escape"
    (seed / MANIFEST_NAME).write_text(json.dumps(manifest))

    with pytest.raises(ModelCacheError, match="Invalid model manifest entry"):
        sync_cache(seed, tmp_path / "cache")


def test_atomic_copy_does_not_replace_destination_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.write_text("new")
    destination.write_text("old")

    def fail_replace(source_path: Path, destination_path: Path) -> None:
        raise OSError("replace failed")

    monkeypatch.setattr("immich_ml.model_cache.os.replace", fail_replace)

    with pytest.raises(OSError, match="replace failed"):
        atomic_copy(source, destination)
    assert destination.read_text() == "old"
    assert not list(tmp_path.glob(".destination.*"))
