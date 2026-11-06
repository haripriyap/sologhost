"""Synthetic receive-side subspace angle example for SG-RVA01.

Run: python angle_example.py
Requires: numpy, matplotlib. No customer data or private analyzer code.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def largest_left_subspace_angle_deg(h_ref, h_now, rank):
    """Largest principal angle between leading receive-side rank-r subspaces."""
    h_ref = np.asarray(h_ref, dtype=np.complex128)
    h_now = np.asarray(h_now, dtype=np.complex128)
    if h_ref.ndim != 2 or h_now.shape != h_ref.shape:
        raise ValueError("Expected matching 2D channel matrices")
    if not 1 <= rank <= min(h_ref.shape):
        raise ValueError("Invalid retained rank")
    u_ref = np.linalg.svd(h_ref, full_matrices=False)[0][:, :rank]
    u_now = np.linalg.svd(h_now, full_matrices=False)[0][:, :rank]
    overlap = np.linalg.svd(u_ref.conj().T @ u_now, compute_uv=False)
    angles = np.arccos(np.clip(overlap, 0.0, 1.0))
    return float(np.rad2deg(np.max(angles)))


def synthetic_trace(max_rotation_deg=45.0, n_snapshots=21):
    """Generate a 4x4 rank-2 channel with one rotating left singular vector."""
    if n_snapshots < 2:
        raise ValueError("Need at least two snapshots")
    e = np.eye(4, dtype=np.complex128)
    v = e[:, :2]
    channels = []
    for fraction in np.linspace(0.0, 1.0, n_snapshots):
        theta = np.deg2rad(max_rotation_deg * fraction)
        u = np.column_stack((np.cos(theta) * e[:, 0] + np.sin(theta) * e[:, 2], e[:, 1]))
        gains = np.diag([2.0 - 0.5 * fraction, 1.0 + 0.3 * fraction])
        channels.append(u @ gains @ v.conj().T)
    return np.stack(channels)


def main():
    channels = synthetic_trace()
    reference = channels[0]
    rank = 2
    u_ref = np.linalg.svd(reference, full_matrices=False)[0][:, :rank]
    angles = [largest_left_subspace_angle_deg(reference, h, rank) for h in channels]
    leakage = [
        float(np.linalg.norm(h - u_ref @ (u_ref.conj().T @ h)) ** 2 / np.linalg.norm(h) ** 2)
        for h in channels
    ]

    fig, axes = plt.subplots(2, 1, figsize=(8, 5), sharex=True, layout="constrained")
    x = np.arange(len(channels))
    axes[0].plot(x, angles, color="#126a9d", linewidth=2.5)
    axes[0].set(ylabel="Largest principal angle (°)", title="Synthetic channel vs retained reference")
    axes[1].plot(x, leakage, color="#ba542c", linewidth=2.5)
    axes[1].set(xlabel="Snapshot", ylabel="Energy outside retained subspace")
    for axis in axes:
        axis.grid(alpha=0.25)
    output = Path(__file__).with_name("synthetic_angle_and_leakage.png")
    fig.savefig(output, dpi=160)
    plt.close(fig)
    print(f"First/last angle: {angles[0]:.2f}° / {angles[-1]:.2f}°")
    print(f"First/last leakage: {leakage[0]:.4f} / {leakage[-1]:.4f}")
    print(f"Plot: {output}")


if __name__ == "__main__":
    main()
