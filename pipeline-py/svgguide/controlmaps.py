"""CPU control maps from a rasterised SVG (E1).

Four maps, all computed with numpy only (no OpenCV, no PIL): `canny` edges, `lineart`, a flat
`depth` from SVG layer order, and `region` masks from declared regions. OpenCV is used for the
canny stage when it happens to be installed, because it is the reference implementation and the
GPU spike compares against it; the numpy path is the one that always runs, so a box without cv2
still produces every map (and the tests exercise it).

Maps are written as 8-bit grayscale PNGs by :func:`write_gray_png`, a ~20-line writer over
`zlib`, so this package adds no image dependency either.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np

CONTROL_MAP_KINDS = ("canny", "lineart", "depth", "region")

try:  # pragma: no cover - depends on the box
    import cv2  # type: ignore

    HAVE_CV2 = True
except Exception:  # noqa: BLE001 - optional accelerator
    cv2 = None  # type: ignore
    HAVE_CV2 = False


def load_rgba(raw: bytes, width: int, height: int) -> np.ndarray:
    """The resvg shim's raw RGBA buffer as an (h, w, 4) uint8 array."""
    expected = width * height * 4
    if len(raw) < expected:
        raise ValueError(f"expected {expected} RGBA bytes for {width}x{height}, got {len(raw)}")
    return np.frombuffer(raw[:expected], dtype=np.uint8).reshape(height, width, 4)


def to_gray(rgba: np.ndarray) -> np.ndarray:
    """Rec. 709 luma in 0..1, composited over black using the alpha channel."""
    rgb = rgba[..., :3].astype(np.float32) / 255.0
    alpha = rgba[..., 3].astype(np.float32) / 255.0
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    return np.clip(luma * alpha, 0.0, 1.0)


def canny_edges(gray: np.ndarray, *, low: float = 0.05, high: float = 0.15, levels: int = 12) -> np.ndarray:
    """Edge map as a boolean array. OpenCV's Canny when available, else gradient + hysteresis.

    The luminance is quantised to `levels` steps first: an SVG raster is flat fills and gradients,
    and quantising turns a soft ramp into the crisp boundary the composition actually has, which is
    what makes this map usable as an img2img init or a control image (and what the edge-IoU metric
    in `eval/` compares against).
    """
    if HAVE_CV2:  # pragma: no cover - the numpy path is the tested one
        return cv2.Canny((gray * 255).astype(np.uint8), low * 255, high * 255) > 0
    if levels and levels > 1:
        gray = np.round(gray * levels) / levels
    blurred = _box_blur(gray, radius=1)
    gx = np.zeros_like(blurred)
    gy = np.zeros_like(blurred)
    gx[:, 1:-1] = (blurred[:, 2:] - blurred[:, :-2]) / 2.0
    gy[1:-1, :] = (blurred[2:, :] - blurred[:-2, :]) / 2.0
    magnitude = np.hypot(gx, gy)
    strong = magnitude >= high
    weak = magnitude >= low
    # hysteresis: keep weak edges connected to a strong one
    grown = strong.copy()
    for _ in range(3):
        grown = _dilate(grown) & weak | grown
    return grown


def lineart(gray: np.ndarray, *, threshold: float = 0.5, invert: bool = True) -> np.ndarray:
    """Flat line art: dark ink on a light ground (or the inverse) as a boolean array."""
    dark = gray < threshold
    return dark if invert else ~dark


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(character * 2 for character in text)
    if len(text) != 6:
        raise ValueError(f"{value!r} is not a hex colour")
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def _nearest_palette_index(rgba: np.ndarray, palette: list[str]) -> np.ndarray:
    rgb = rgba[..., :3].astype(np.int16)
    distances = np.stack(
        [np.abs(rgb - np.array(hex_to_rgb(colour), dtype=np.int16)).sum(axis=2) for colour in palette],
        axis=0,
    )
    return distances.argmin(axis=0)


def depth_from_layers(rgba: np.ndarray, palette: list[str], *, background_index: int = 0) -> np.ndarray:
    """A flat depth map in 0..1: later palette entries are nearer the camera (higher value).

    v0 contract: the SVG paints its layers with the declared palette, one flat colour per layer,
    which is what the agent-written SVGs in `workflows/svg-guided/samples/` do. Reading depth out
    of an arbitrary SVG's z-order is an M3 item - noted in the README as [unverified] for inputs
    this package did not author.
    """
    if len(palette) < 2:
        raise ValueError("a depth map needs at least two palette entries")
    indices = _nearest_palette_index(rgba, palette)
    order = np.array([index for index in range(len(palette))], dtype=np.float32)
    order = np.roll(order, -background_index)
    scaled = order[indices] / max(1, len(palette) - 1)
    return scaled.astype(np.float32)


def region_mask(rgba: np.ndarray, colour: str, *, tolerance: int = 24) -> np.ndarray:
    """Boolean mask of the pixels matching a declared region colour."""
    target = np.array(hex_to_rgb(colour), dtype=np.int16)
    difference = np.abs(rgba[..., :3].astype(np.int16) - target).sum(axis=2)
    return difference <= tolerance


def coverage(map_array: np.ndarray) -> float:
    """Fraction of the map that is "on" (non-zero), for the non-blank check in the prep tool."""
    array = np.asarray(map_array)
    if array.dtype == bool:
        return float(array.mean()) if array.size else 0.0
    return float((array > 0.02).mean()) if array.size else 0.0


def _box_blur(gray: np.ndarray, radius: int = 1) -> np.ndarray:
    padded = np.pad(gray, radius, mode="edge")
    total = np.zeros_like(gray)
    count = 0
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            total += padded[radius + dy : radius + dy + gray.shape[0], radius + dx : radius + dx + gray.shape[1]]
            count += 1
    return total / count


def _dilate(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def write_gray_png(array: np.ndarray, path: Path) -> Path:
    """Write an 8-bit grayscale PNG with zlib only (no image library).

    Booleans become 0/255; floats are expected in 0..1 and are scaled.
    """
    data = np.asarray(array)
    if data.dtype == bool:
        pixels = (data.astype(np.uint8)) * 255
    else:
        pixels = np.clip(data * 255.0, 0, 255).astype(np.uint8)
    height, width = pixels.shape[:2]
    raw = b"".join(b"\x00" + pixels[row].tobytes() for row in range(height))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    return path
