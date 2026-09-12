from __future__ import annotations

import hashlib
import unicodedata

from phrase2photon.now_playing.models import PreparedAudioAsset, TrackObservation


def normalize_name(value: str | None) -> str:
    if not value:
        return ""

    unicode_normalized = unicodedata.normalize("NFC", value)
    normalized = "".join(char if char.isalnum() else " " for char in unicode_normalized.casefold())
    return " ".join(normalized.split())


def audio_identity_slug(_observation: TrackObservation, asset: PreparedAudioAsset) -> str:
    duration_bucket = int(asset.measured_duration_seconds + 0.5)
    parts = [str(duration_bucket), asset.audio_sha256.casefold()]
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return digest[:16]
